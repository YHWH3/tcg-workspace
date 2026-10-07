# Phase 0 — Safe AI editing

Goal: several people can use Claude / ChatGPT / Gemini against the same workspace at the same time without acting as each other, silently overwriting each other, duplicating work on retries, or making changes that can't be reviewed and undone.

No UI redesign. No change to the client sync protocol. All changes are server-side plus one small Settings/Activity UI.

---

## 1. Scope

| # | Item | Files |
|---|---|---|
| 0.1 | Per-request MCP identity (security fix) | `worker/mcp.ts` |
| 0.2 | Record revisions on reads | `worker/mcp.ts`, new `worker/records.ts` |
| 0.3 | Conflict-checked writes (`expectedRev`) | `worker/sync.ts`, `worker/mcp.ts` |
| 0.4 | Server compare-and-swap ops for config arrays (columns/fields) | `worker/records.ts`, `worker/mcp.ts` |
| 0.5 | Idempotent writes (`requestId`) | migration `0004`, new `worker/idempotency.ts` |
| 0.6 | Change sets + undo | migration `0004`, new `worker/changesets.ts`, `shared/undo.ts`, client UI |
| 0.7 | Dry-run previews + delete impact | `worker/mcp.ts`, new `shared/impact.ts` |
| 0.8 | Targeted reads + indexes | migration `0004`, `worker/records.ts` |
| 0.9 | Ambiguity-safe name resolution | `worker/mcp.ts`, `shared/markdown.ts` |
| 0.10 | Known MCP defects | `worker/mcp.ts` |
| 0.11 | Tests | `tests/*.test.ts`, `scripts/verify-mcp-multiuser.mjs` |

Out of scope: client-side conflict UI, permissions, notifications.

---

## 2. 0.1 Per-request MCP identity (security fix — do first, ship alone if needed)

**Defect**: `worker/mcp.ts` caches `handler` at module level (`let handler … if (!handler) handler = createMcpHandler((mcpCtx) => createWorkspaceServer(ctxFor(env, ctx, mcpCtx, props)), …)`). The factory closure captures the **first** request's `env`, `ctx` (ExecutionContext) and `props` (userId/clientName). The Agents SDK calls the factory per request, but our closure always supplies the first caller's identity. A second user's tool calls in the same isolate are executed and attributed as the first user, and `waitUntil` targets a finished request's context.

**Fix** (follow the documented pattern: build the handler per request):

```ts
export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx.props ?? {}) as { userId?: string; clientName?: string };
    if (!props.userId) return unauthorized();
    const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(props.userId).first();
    if (!user) return unauthorized();
    return createMcpHandler(
      (mcpCtx: McpRequestContext) => createWorkspaceServer(ctxFor(env, ctx, mcpCtx, props)),
      { route: '/mcp' },
    )(request, env, ctx);
  },
};
```

- Delete the module-level `handler` variable. No module-level mutable state anywhere in `worker/` (add a comment rule to AGENTS.md).
- `unauthorized()` helper returns 401 + `WWW-Authenticate: Bearer error="invalid_token"` (existing response shape).

**Test** (`scripts/verify-mcp-multiuser.mjs`, §12): two OAuth users A and B, interleave 20 alternating `create_page` calls in one `wrangler dev` isolate; assert every created page's `createdBy` and every activity `actorId` matches the caller.

---

## 3. 0.2 Revisions on reads

`records.seq` is a global monotonic counter bumped on every write of a row; it is the row's **rev**.

- New `worker/records.ts` with typed read helpers returning `{ id, collection, data, field_ts, rev }`:
  - `getRec(env, collection, id)`
  - `getRecs(env, collection, ids[])` (chunks of 100)
  - `listBy(env, collection, field, value, { includeDeleted? })` — uses the indexed expressions from §9
  - `listCollection(env, collection)` — only for small collections (boards, moodboards, pages tree)
- Every MCP read tool includes `rev` on every returned item: pages, blocks, tasks, boards, mood items, comments. Example `get_page` block: `{ id, type, text, rev }`. `get_board`: board `rev` + each task `rev`.
- `fetch`/`search` results include `rev` in `metadata`.

---

## 4. 0.3 Conflict-checked writes

### 4.1 Which operations need `expectedRev`

| Operation | Needs `expectedRev` | Why |
|---|---|---|
| Replace block text (`edit_page.replaceBlocks`) | **Required** per block | whole-text replacement destroys concurrent edits |
| Delete block / page / task / board / mood item (`delete_item`, `edit_page.deleteBlockIds`) | **Required** | destructive |
| Rename page/board, change task title/description | Optional (recommended) | single field; LWW acceptable if omitted |
| Task stage/assignee/due/priority/field values (`update_tasks`) | Optional | per-field merge already safe |
| Append markdown, add comment, create anything, add options, add link (Phase 1) | **Never** | append-only, cannot clobber |
| Board columns / fields | Not accepted — use CAS ops (§5) | server merges against latest |

When an optional `expectedRev` is omitted, the write proceeds with LWW and the tool result includes `"unchecked": ["<id>", …]` so the model knows.

Tool descriptions must say: *"Pass the `rev` you read. If the item changed since, you'll get a conflict with the current content — re-read, merge, and retry or ask the user."*

### 4.2 Mechanism

Extend `applyChanges` (`worker/sync.ts`) options:

```ts
export interface ApplyOptions {
  serverTs?: boolean;
  /** id → rev the caller read. Mismatch ⇒ conflict, nothing written for that id. */
  expect?: Map<string, number>;
  /** all-or-nothing: if any expectation fails, write nothing (default true when expect is set). */
  atomic?: boolean;
}
export interface ApplyResult {
  rejected: number;
  changed: number;
  conflict?: boolean;           // CAS retry exhaustion (existing)
  conflicts?: ConflictInfo[];   // expectedRev mismatches
  applied: AppliedChange[];     // for change sets (§7)
}
export interface ConflictInfo { id: string; collection: string; expectedRev: number; currentRev: number | null; current: Record<string, unknown> | null; updatedBy: string | null; updatedAt: number | null }
export interface AppliedChange { id: string; collection: string; created: boolean; fields: string[]; before: Record<string, unknown>; after: Record<string, unknown>; fieldTs: Record<string, number>; rev: number }
// fieldTs[f] = the timestamp actually written for field f (with serverTs,
// consecutive ops on the same record tick forward, so per-field ts is required
// for undo — a single item-level ts would be wrong).
```

Algorithm (only when `expect` is set):
1. `readRows` all ids (already done; add `updated_by`, `updated_at` to the SELECT). For each `id` in `expect`: if row missing or `row.seq !== expected` → push `ConflictInfo` (include `current` data, `updated_by`, `updated_at`).
2. If conflicts and `atomic !== false` → return `{ conflicts, applied: [], changed: 0 }` without writing.
3. Otherwise plan as today, but for expected ids set `plan.baseSeq = expected` (not the row's seq) and **exclude them from the re-merge retry loop**: if their CAS update affects 0 rows, record a conflict instead of re-merging.
4. **Correctness invariant:** every write is already guarded by `WHERE records.seq = ?` per statement, so a stale `expectedRev` can never overwrite — even if a batch isn't atomic or the precheck raced. The precheck exists only to fail fast and to return `current` content. For `atomic !== false`, all expected-id writes go in **one** `db.batch()` (D1 batches are atomic per docs — verify, README §8); therefore a tool call may carry at most one batch's worth of expected ids (cap 100; non-expected creates may exceed it in later chunks).

`updated_by` / `updated_at` already exist on `records`; return them.

MCP conflict tool result (with `isError: true`):

```json
{ "error": "conflict",
  "message": "1 item changed since you read it. Re-read and merge, then retry.",
  "conflicts": [{ "type": "block", "id": "…", "expectedRev": 812, "currentRev": 815,
                  "current": { "text": "…" }, "changedBy": "Ramesh", "changedAt": 1790000000000 }] }
```

The push route (`/api/sync/push`) never passes `expect` — client behaviour unchanged.

### 4.3 Offline client after an AI edit (documented limitation)

A phone that edited offline pushes later with older HLC timestamps; server-stamped AI edits (`serverTs`) are newer, so for the same field the AI edit wins even though the human typed later in wall-clock time. Accept for now; the change set (§7) shows both and undo restores. Do not change client timestamps.

---

## 5. 0.4 Compare-and-swap ops for config arrays

`boards.columns` and `boards.fields` are single LWW fields. Replace the array-editing in `update_board` with granular ops applied server-side with read-modify-write + CAS retry:

```ts
// worker/records.ts
export async function casUpdate(env, collection, id, mutateFn: (data) => Record<string, unknown> | null, opts): Promise<ApplyResult>
// reads row, computes patch from latest data, applyChanges with expect = {id: row.seq}; on conflict re-read and retry up to 5 times.
```

New/changed MCP tools (keep `update_board` for name/icon only; deprecate its `columns/addFields/updateFields/removeFields` but keep accepting them by routing through these ops):

| Tool | Input | Notes |
|---|---|---|
| `add_stage` | `{boardId, name, color?, afterStage?}` | idempotent by name (case-insensitive): returns existing |
| `update_stage` | `{boardId, stage (id\|name), name?, color?, moveTo?: index}` | |
| `remove_stage` | `{boardId, stage, moveTasksTo (id\|name)?, dryRun?}` | default target = first remaining stage; tasks moved in same change set; refuses to remove the last stage |
| `add_field` | `{boardId, name, type, options?, showOnCard?}` | idempotent by name: returns existing if same type, error if different type |
| `update_field` | `{boardId, field, name?, showOnCard?, addOptions?, renameOptions?: [{from,to}], removeOptions?}` | options ops are additive by default; never rewrite option ids |
| `remove_field` | `{boardId, field, dryRun?}` | values (`p_<id>` keys) are left in place (existing convention) |

Fix existing bug while here: `update_field` must not regenerate option ids positionally (current code maps by index).

---

## 6. 0.5 Idempotent writes

Every MCP **write** tool accepts optional `requestId: string` (1–64 chars, `[A-Za-z0-9_-]`). Tool descriptions: *"Generate a unique requestId per intended action and reuse it if you retry."*

Migration `migrations/0004_safe_ai.sql`:

```sql
CREATE TABLE IF NOT EXISTS mcp_requests (
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','done','failed')),
  result TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_mcp_requests_created ON mcp_requests(created_at);
```

`worker/idempotency.ts`:

```ts
export async function withIdempotency<T>(env, userId, tool, requestId: string | undefined, args: unknown, run: () => Promise<ToolResult>): Promise<ToolResult>
```

1. No `requestId` → `run()`.
2. `argsHash = sha256(stableJson(args without requestId))` (`stableJson` = sorted keys; put in `shared/stablejson.ts`, unit-tested).
3. `INSERT … VALUES (…, 'running', NULL, now) ON CONFLICT DO NOTHING`; check `meta.changes`.
4. If not inserted: load row. `args_hash` differs → error `requestId reused with different arguments`. `done` → return stored `result` (parsed) with `"replayed": true`. `running` and `< 120 s` old → error `still running, retry shortly`. `running` older or `failed` → take over (`UPDATE … SET status='running' WHERE user_id=? AND request_id=? AND status=old AND created_at=old`); if the UPDATE affects 0 rows another retry won the takeover → treat as `running` and return "still running".
5. After `run()`: store `status='done', result=JSON`. Results are small; if >100 KB store a summary that **always keeps every created id** (`{truncated:true, ids:[…], summary}`). On thrown error: `status='failed'`.
6. Opportunistic cleanup on each insert: `DELETE FROM mcp_requests WHERE created_at < now - 7 days LIMIT 100` (wrap in try).

**Natural-key dedupe** (for models that don't send requestIds):
- `find_or_create_page({title, parentId?, icon?, markdown?})` — exact case-insensitive title match among live siblings → returns existing (`created:false`).
- `create_tasks` gains `dedupe?: 'none' | 'title'` (default `'title'` when called by MCP): skip tasks whose case-insensitive title already exists live on that board; result lists `skipped`.
- `add_stage` / `add_field` idempotent by name (above).

---

## 7. 0.6 Change sets + undo

Every server-side write (MCP now; automations/forms in Phase 4) is grouped into one **change set** per tool call.

Migration `0004` (same file):

```sql
CREATE TABLE IF NOT EXISTS changesets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,            -- 'mcp' | 'automation' | 'form' | 'undo'
  client_name TEXT,                -- e.g. 'Claude'
  tool TEXT NOT NULL,
  summary TEXT NOT NULL,           -- human sentence, ≤200 chars
  request_id TEXT,
  undoes TEXT,                     -- changeset id this one reverted
  undone_by TEXT,                  -- changeset id that reverted this one
  item_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changesets_created ON changesets(created_at);
CREATE INDEX IF NOT EXISTS idx_changesets_user ON changesets(user_id, created_at);

CREATE TABLE IF NOT EXISTS changeset_items (
  changeset_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  collection TEXT NOT NULL,
  record_id TEXT NOT NULL,
  created INTEGER NOT NULL,        -- 1 if the record did not exist before
  before TEXT NOT NULL,            -- JSON of touched fields' previous values ({} if created)
  after TEXT NOT NULL,             -- JSON of touched fields' new values
  field_ts TEXT NOT NULL,          -- JSON {field: ts actually written} (serverTs; per-field, see §4)
  PRIMARY KEY (changeset_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_changeset_items_record ON changeset_items(record_id);
```

### 7.1 Recording

- `applyChanges` returns `applied: AppliedChange[]` (touched fields only, before/after, ts, new rev). Computed from the plan merge (fields whose value/ts changed).
- `worker/changesets.ts`:
  - `beginChangeset(ctx, tool)` → in-memory collector. `summary` is derived at commit time from the op counts the tool reports (e.g. "Created 1 page + 12 tasks in 'Grant X'"); tools pass a template like `summarize('create_project', ops)` — keep it mechanical, ≤200 chars.
  - MCP `write()` (in `worker/mcp.ts`) appends each `applyChanges` result's `applied` (with `fieldTs`) to the collector.
  - `commitChangeset(env, collector)` inserts the header + items via `db.batch` (chunks of 100). Called once per tool handler; skips the insert entirely when the collector is empty.
- Activity records written by MCP get `meta.changesetId`.
- Activity rows themselves are excluded from change set items (they are logs, not content) — undo does not delete activity; it adds an `undone` activity entry.
- Every MCP write tool returns `changesetId` in its result.

### 7.2 Undo semantics (pure planner `shared/undo.ts`, unit-tested)

```ts
export function planUndo(items: ChangesetItem[], current: Map<string, { data, field_ts }>): { patches: { collection, id, patch }[]; skipped: { id, field, reason }[] }
```

For each item, for each field in `after`:
- If `current.field_ts[field] === item.field_ts[field]` (nobody changed it since) → restore `before[field]` (or, if `item.created`, set `deleted: true` once for the record).
- Otherwise → `skipped` with reason `changed since by someone else`.
- Fields absent in `before` for a non-created record → restore to `null`.

Apply via `applyChanges(..., {serverTs:true})` inside a new change set with `source='undo'`, `undoes=<id>`; then `UPDATE changesets SET undone_by=? WHERE id=?`. Undoing twice → error `already undone`. Undo of an undo = redo (allowed, same planner).

Files imported by the undone change set: their `files` records get `deleted: true`; bytes stay (purge is Phase 5).

### 7.3 Surfaces

- MCP tools: `list_changes({mine?: boolean, limit?: ≤50, before?: cursor})` → `[{id, tool, summary, client, user, createdAt, itemCount, undone}]`; `get_change({id})` → items with before/after (truncate long text to 500 chars); `undo_change({changesetId, dryRun?})` → `{restored, skipped}`.
- HTTP (session auth, for the app): `GET /api/changes?mine=1&before=…`, `GET /api/changes/:id`, `POST /api/changes/:id/undo`. Members may undo their own change sets; admins any.
- Client UI: in Activity, entries with `meta.changesetId` show a subtle "Undo" action (confirm dialog listing skipped fields). Settings → AI connectors gets "Recent AI changes" (last 20, link to Activity filter `via:any`). Add Activity filter chip "AI changes".

---

## 8. 0.7 Dry-run previews + delete impact

Tools accepting `dryRun?: boolean`: `create_project`, `create_tasks`, `update_tasks`, `create_from_template`, `delete_item`, `remove_stage`, `remove_field`, `edit_page` (when `deleteBlockIds` or `replaceBlocks`), `undo_change`.

Dry run executes all planning (validation, resolution, op building) and returns without calling `applyChanges` or importing remote files:

```json
{ "dryRun": true, "summary": "Would create 1 page, 4 sub-pages, 1 board, 37 tasks", 
  "counts": { "pages": 5, "blocks": 22, "boards": 1, "tasks": 37 },
  "warnings": ["assignee 'Ram' matched 2 people — left unassigned"],
  "impact": { … } }
```

`shared/impact.ts` (pure, unit-tested) computes delete impact from a snapshot:
- page → descendant pages, their blocks, embedded `tasks` blocks (boards are **not** deleted), public share links affected, inbound mentions/backlinks count.
- board → live tasks count and what happens to them.
- task → mood items linked via `taskId`, comments, attachments.

**Behaviour fixes bundled here:**
- MCP `delete_item` for a board currently only flags the board, orphaning tasks. Match the client (`deleteBoard` in `src/modules/boards/api.ts`): move live tasks to `board-default` first stage, in the same change set. Add `taskAction: 'move_to_default' | 'delete'` (default move).
- `restore_item` for a page restores the page only; descendants were never flagged so they reappear (correct). Document it.

Tool descriptions for destructive tools: *"Call with dryRun:true first and show the user the impact before deleting."*

---

## 9. 0.8 Targeted reads + indexes

Migration `0004` adds expression indexes (exact expressions must match queries in `worker/records.ts`):

```sql
CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);
CREATE INDEX IF NOT EXISTS idx_records_page   ON records(collection, json_extract(data, '$.pageId'));
CREATE INDEX IF NOT EXISTS idx_records_board  ON records(collection, json_extract(data, '$.boardId'));
CREATE INDEX IF NOT EXISTS idx_records_parent ON records(collection, json_extract(data, '$.parentId'));
CREATE INDEX IF NOT EXISTS idx_records_target ON records(collection, json_extract(data, '$.targetId'));
```

Verify with `EXPLAIN QUERY PLAN` in local D1 that `listBy` queries use them.

Replace in `worker/mcp.ts`:
- `recs(env,'blocks')` + filter by pageId → `listBy(env,'blocks','pageId',pageId)`.
- `recs(env,'tasks')` + filter by boardId → `listBy(env,'tasks','boardId',boardId)` (plus `boardId IS NULL` for `board-default`: add `listDefaultBoardTasks`).
- comments/files by target/parent → `listBy`.
- Backlinks: `SELECT … FROM records WHERE collection='blocks' AND instr(data, ?) > 0` with the token string (no index; acceptable until Phase 5 search).
- `search`: keep scanning but select only `id, collection, json_extract(data,'$.title'), json_extract(data,'$.text')`, cap 50 results; full fix in Phase 5.

---

## 10. 0.9 Ambiguity-safe name resolution

- `fillCaches` currently maps `pageIdByTitle` title→last id. Change to `title → id[]` and `userByKey key → id[]`.
- Resolution returns `{ id } | { ambiguous: candidates[] } | { missing }`.
- In `markdownToBlocks` resolvers: ambiguous/missing → leave the literal text (`[[Title]]` / `@name`) and collect a warning.
- In task inputs (`assignee`, person fields): ambiguous → leave unset, add warning `assignee 'Ram' matches Ramesh K, Ram S — pass username`. Missing → warning.
- Every write tool result includes `warnings: string[]` when non-empty.

---

## 11. 0.10 Known MCP defects to fix in this phase

1. Identity caching (§2).
2. `create_moodboard` logs activity with `targetType: 'mooditem'` for a mood board → use `'moodboard'`.
3. `update_tasks` with `coverImageUrl` doesn't catch `RemoteFileError` → return `err()` like `create_tasks`.
4. `update_board` option rewrite regenerates option ids by position → replaced by `update_field` (§5).
5. `delete_item` board orphaning (§8).
6. `fetch`/`get_page` read all blocks → `listBy` (§9).
7. `edit_page.replaceBlocks` only keeps the first parsed line silently → if markdown parses to >1 block, replace the first and insert the rest after it; report in result.

---

## 12. 0.11 Tests

Unit (vitest, `tests/`):
- `stablejson.test.ts` — key order independence, nested arrays.
- `undo.test.ts` — restore untouched fields; skip fields changed since; created → deleted; undo-of-undo; missing current record.
- `impact.test.ts` — page subtree counts, board task counts, task-linked mood items.
- `conflict.test.ts` — pure helper that evaluates expectations (`checkExpectations(rows, expect)`), extracted from `applyChanges`.
- Extend `fields.test.ts` for `update_field` option ops (ids preserved on rename).

E2E `scripts/verify-mcp-multiuser.mjs` (against `wrangler dev :8788`, users `admin` + `bob` from smoke):
1. Two OAuth grants (A, B). Interleaved writes → attribution correct (§2).
2. A reads page (rev r); B edits a block; A `replaceBlocks` with r → conflict result naming B; nothing written.
3. A `delete_item` without `expectedRev` → validation error; with stale rev → conflict.
4. Same `requestId` twice → one page, second result `replayed:true`; same id + different args → error.
5. `create_tasks` twice with same titles → second call skips all (`dedupe:title`).
6. A `create_project`; B edits one task's title; A `undo_change` → every created record is soft-deleted **except** that task, which is kept and reported in `skipped` (rule in `planUndo`: a created record is set `deleted:true` only if none of its fields changed since the change set; otherwise the whole record is skipped).
7. `dryRun` on `create_project` and `delete_item` → no rows written (compare `records` count before/after via `/api/sync/pull`).
8. `add_field` twice same name → one field; `update_field` rename option keeps option id; tasks keep their values.
9. Remove stage with tasks → tasks moved, one change set, undo restores stage + task statuses.
10. Activity "Undo" button works in UI (Playwright), skipped-fields dialog shows.

Regression: full baseline (README §7), including existing `verify-mcp.mjs` (update it for new required `expectedRev` on delete and `rev` fields).

---

## 13. Rollout

1. Ship 0.1 first if any other part slips (it is independent).
2. Apply migration `0004` remotely before deploying code (tables/indexes are additive).
3. Update `AGENTS.md` MCP section: revisions, conflicts, requestId, change sets, dry-run, "no module-level mutable state".
4. Update `README` connector section: tell users AI changes are undoable from Activity.

## 14. Acceptance criteria

- Two people using AI concurrently: every change attributed to the right person (proved by §12.1).
- No AI tool can overwrite text or delete an item the model hasn't seen the latest version of.
- Retried AI calls never duplicate.
- Every AI change appears as one undoable entry; undo never clobbers later human edits.
- Destructive/bulk tools support preview; delete impact is reported.
- Existing app behaviour, client sync protocol and all existing tests unchanged.
