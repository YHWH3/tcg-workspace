# Phase 5 — design review and implementation-ready amendments

Status: **review + design**. Nothing in this document enables permissions,
changes a migration that has shipped, or modifies PR #7. It reviews the Phase 5
foundation in draft [PR #7](https://github.com/YHWH3/tcg-workspace/pull/7)
(`grok/phase-5-search-permissions`, including its three commits that exist only
in the local clone: `4224d76`, `e45cbae`, `f65183a`) against the implemented
Phase 0–4 system and the verified defects in
[cross-phase-audit.md](../reviews/cross-phase-audit.md), and writes down the
protocol and schema changes recommended before activation.

Inputs read: `docs/architecture/phase-5-scale-permissions.md` (the proposal),
`phase-5-implementation.md` and `docs/reviews/phase-5-progress.md` (the draft's
contract and ledger), the draft's `shared/access.ts`, `shared/recordScope.ts`,
`worker/{access,recordAccess,mutationAccess,syncAccess,syncSnapshot,spaces}.ts`,
migrations `0012`–`0015`, and the client reconciliation modules.

## 1. What the draft gets right (keep)

These are the parts that were hard and are correct; the amendments below leave
them intact.

1. **Authority is resolved from D1 on every request, never from OAuth props or
   client role claims.** (`loadAccessContext`.) The existing MCP handler already
   hard-codes `userRole:'member'` and ignores `props`, which is the safe
   direction.
2. **Deny precedes default access; workspace administration is not content
   access; guests never receive default access and cannot be space admin/owner**
   (`effectiveSpaceRole`). Exhausted by pure tests.
3. **Child scope is derived server-side from the ownership graph, never from a
   client-supplied `spaceId`** (`shared/recordScope.ts`), with both endpoints of
   a link required, cycle/depth failing closed, and protected fields
   (`uploadClaimHash`, `space_id`, `_*`) rejected.
4. **The authorization decision is fenced inside the same D1 batch as the
   record CAS, journal, outbox and checkpoint** (`writeAuthorityFences`). A
   check-then-write at the HTTP edge is not enough, and this is the right
   pattern — it is the same poison-pill-SELECT idiom Phase 4 already uses.
5. **Client cache is account-bound, staged and atomically activated; revoked
   pending work is quarantined, not retried and not exported**
   (`accessCache.ts`, `reconcileAccess.ts`).
6. **The proposal's finite eviction feed was correctly rejected as the only
   mechanism** (a bounded feed cannot prove completeness after a stale cursor).
7. **Activation is a migration-controlled flag, default off, with old protocol
   rejected after activation (`426`).**

## 2. Findings against the draft

Severity is for the activated system at the scale the owner asked for
("hundreds of records, collaborators and guest accounts").

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| **P5-A** | **High** | **One global `access_state.generation` is bumped by high-frequency, mostly irrelevant events, and every bump forces every client through a full snapshot.** Triggers bump it on: every session deletion (`p5_session_delete` — each logout, each expiry cleanup in `userByToken`, each password change), every soft-delete/restore/re-parent/board move of any record (`p5_record_visibility`, once enabled), every membership/role/user change, every record scope change. A client holding a stale generation gets `409 access_reset_required` on pull **and push** and must reconcile. | `migrations/0012…0013`; `validateSyncProtocol`; `writeAuthorityFences` compares `a.generation=?`. |
| **P5-B** | **High** | **Snapshots are materialized as D1 rows, which the free plan cannot absorb.** `createSyncSnapshot` copies up to 20,000 `records` rows (data + field_ts) into `sync_snapshot_items`, then deletes them at expiry. Rows written are counted per row: a 5,000-record workspace is ≥5,000 row writes per snapshot plus the same number of delete operations at expiry (D1 meters deletes with writes — confirm against the current pricing page), against a 100,000 rows/day allowance (enforced since 2026-09-01). With P5-A the snapshot rate is driven by *any* user's logout or delete, so N active users × events/day exhausts the daily write quota and puts the whole workspace into read-only failure. Above 20,000 readable records `snapshot_too_large (413)` makes reconciliation impossible. | `worker/syncSnapshot.ts`; D1 pricing/limits cited in `phase-4-codex-remediation.md`. |
| **P5-C** | Medium | **Session deletion invalidates in-flight writes of unrelated users** (consequence of P5-A: the write fence is a generation equality, not "this user's capability on this space"). | `accessFence`. |
| **P5-D** | **High** | **File and public-share serving still emit the uploader's MIME string** (`Content-Type: meta.mime`); the draft changes only the cache header. Under spaces, XP-01 becomes guest → member/admin script execution. `worker/public.ts` and `publicAccess.ts` are untouched (their enforcement rows are still "pending"). | PR #7 `worker/files.ts` diff; audit XP-01. |
| **P5-E** | Medium | **`worker/live.ts` socket revalidation is listed as pending**; presence paths (`/pages/<id>`) are broadcast workspace-wide. Implemented in PR #8 (XP-11) for sessions; per-space presence filtering is still required. | draft §8 last paragraph. |
| **P5-F** | Medium | **The approval-gate extension (`proposedBoards`) and PR #8's gate pre-check change the same function signature** and the draft's `applyChanges` prologue replaces PR #8's single shared read. They must be reconciled, not merged textually (§7). | `git merge-tree` conflicts. |
| **P5-G** | Medium | **Denormalized content stores are not all in the enforcement inventory**: `event_outbox.payload` (full record snapshots), `notifications.title/body/url`, `changeset_items`/`undo_items` before/after, `automation_runs.payload` (record data), `form_submissions.payload`, `mcp_requests.result`, `approvals.note`. The inventory table lists notifications and changesets but not outbox/automation/form/idempotency payloads or how *already written* rows are treated after revocation. | `migrations/0004,0007,0008,0011`; draft §6. |
| **P5-H** | Medium | **Automations execute as the triggering actor but with the author's destination.** Under spaces an editor of space A can author an automation whose `create_record` targets space B and whose templates interpolate `{{record.title}}` from A: a confused-deputy channel and an information flow A→B. The draft checks destination edit rights for the *saving* user (`configurationReferences`) but the run's identity is `ctx.userId` (the event actor). | `worker/automations.ts` `applyChanges(env, ctx.userId, …)`; draft `mutationAccess.configurationReferences`. |
| **P5-I** | Low–Med | **`/api/files/usage` is scoped by readability but quota is shared** — a guest can observe quota pressure caused by others only through error codes; acceptable, but the quota attribution (who may fill the workspace) is undefined for guests. | draft `readableFileUsage`. |
| **P5-J** | Low | **FTS ranking**: the design states the leakage concern but proposes bm25 over a global FTS table; hidden-corpus term statistics influence visible rank. | draft §9. |

P5-A/B are the reason a redesign of the *reconciliation layer* (not of the
authorization kernel) is recommended below.

## 3. Threat model (summary of what must hold)

Assets: titles, bodies, comments, history, bytes, relation structure, presence
paths, search snippets, notification metadata, counts and quota signals.
Adversaries: (a) member without access to a space; (b) revoked member/guest
with a stale cache and cursor; (c) guest who can edit one space; (d) anonymous
holder of a share or form token; (e) a stale tab/session or a second account on
the same browser; (f) a prompt-injected AI client acting as a legitimate user.
Out of scope (state it to users): an authorized reader copying content;
disconnected devices (cached data survives until reconnect); screenshots and
exports already made; XSS on the app origin (but XP-01 makes this a gate, not
an assumption).

Information-leak/stale-authority checklist, each with its owner in the design:

| Channel | Leak/stale scenario | Control |
|---|---|---|
| `/api/sync/pull` | rows of unreadable spaces; rows whose *link endpoint* is unreadable | SQL prefilter by readable space + per-candidate ancestry/endpoint resolution (kept from draft) |
| eviction | cursor older than retained history; regrant after eviction | per-space event floor ⇒ per-space re-backfill (§4.3) |
| push | write after revocation; write into a space moved mid-batch | capability fence in the same batch (§4.4) |
| files | bytes by guessed id; thumbnail of a hidden file; cached HTTP response | `authorizeFile` (draft) + `no-store` + serving policy (XP-01) |
| search | snippet of hidden content; rank side channel; counts | FTS filter by space *before* ranking; app-level score, not global bm25 (§6) |
| live | presence path of another space; pokes after revocation | per-space rooms or filtered broadcast; session-bound sockets (XP-11) |
| notifications | title/excerpt of a record the user lost | read-time `canRead(target)` filter + purge on revoke (§5) |
| MCP/AI | `search`/`get_*` on unfiltered `recs()`; replayed idempotent result after revocation; prompt injection | one `ReadAccess` seam for all reads; reauthorize replay; Phase 6 §3 |
| public | share tree crossing spaces; embedded database listing; form writing outside configured output | token pins `space_id`; share creation requires space admin; redact cross-space embeds |
| undo/history | undo writes into a space the user left | undo re-authorizes every inverse write at execution (the draft's `applyChanges` already does for non-system actors) |

## 4. Recommended reconciliation protocol ("per-space feeds")

The authorization kernel stays. The change is **how a client learns that its
readable set changed, and how writes are fenced**. Goals: no write
amplification proportional to record count; a revocation event costs O(rows the
client holds in that space) *locally* and O(1) on the server; unrelated events
(logouts, someone else's membership, a record deleted in a space you can read)
never reset anyone.

### 4.1 Model

- `access_state` (global generation) is **removed from the sync/write contract**.
  Keep a table for *structural* migrations only.
- A client's **manifest** is the set `{spaceId, role, spaceEpoch}` returned by
  `GET /api/access`. `spaceEpoch` is a per-space integer that changes only when
  that space's *own* access-relevant settings change (default access, deleted,
  export policy) — one `UPDATE spaces SET epoch=epoch+1`, not a global trigger.
  `accessEtag = hash(sorted manifest)` is returned on every pull/push response
  (the server already loads the user's spaces for each request).
- Membership changes need no counter: the manifest *is* the user's current
  memberships. Session creation/deletion, record deletes and moves of readable
  records never touch the manifest.

### 4.2 Pull (steady state)

`GET /api/sync/pull?since=<seq>&etag=<clientEtag>`:

1. Load the user's readable spaces (1 batch, already needed).
2. If `etag` differs → `409 manifest_changed` with the new manifest inline
   (client reconciles per §4.3, then retries).
3. Select candidates `records WHERE space_id IN (readable) AND seq > ?` plus
   `space_events WHERE space_id IN (readable) AND seq > ?` (§4.3), merged by
   `seq`, `LIMIT 500`, then apply the draft's ancestry/endpoint resolution to
   the record candidates (unchanged).
4. Cursor advances to the last returned `seq`, or to the high-water mark seen
   inside the same read batch when nothing is returned (the draft's rule).

`idx_records_space_seq (space_id, seq)` already exists in migration 0012.

### 4.3 Space events (the eviction feed, made per-space and bounded)

```sql
CREATE TABLE space_events (
  seq        INTEGER PRIMARY KEY,         -- same counter domain as records.seq
  space_id   TEXT NOT NULL,
  record_id  TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK(kind IN ('evict')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_space_events_space ON space_events(space_id, seq);
ALTER TABLE spaces ADD COLUMN events_floor INTEGER NOT NULL DEFAULT 0;
```

- A record leaving space S (explicit move batch, or an ownership change that
  re-roots it) writes one `evict` row for S **in the same batch** as the
  `space_id` rewrite. Rows are 24-byte facts, not content.
- Retention: delete events older than 30 days and raise `spaces.events_floor`
  to the highest deleted `seq` in the same statement.
- A client whose per-space cursor is below `events_floor` for a space cannot
  prove completeness for that space only → it re-backfills **that space** from
  cursor 0 (§4.5) and drops local rows of that space not returned. Other spaces
  are untouched.

### 4.4 Client reconciliation on a manifest diff

| Diff | Server cost | Client action |
|---|---|---|
| space removed / role reduced to none | none | delete local rows, blobs, object URLs, search entries with `_spaceId = S`; quarantine pending outbox/uploads for S (draft logic) |
| role changed (editor → viewer) | none | update capabilities; pending edits for S → rejected-readonly quarantine |
| space added (new membership, regrant) | one keyset backfill of S (§4.5) | stage, then activate; also re-pull `links` whose other endpoint is in S (cross-space links become visible only now) |
| `spaceEpoch` changed | none beyond manifest | re-evaluate local gating; if default access changed for non-members, the manifest already reflects it |
| `etag` same | — | nothing |

Replacing the draft's atomic *whole-cache* swap with an atomic *per-space* swap
keeps its crash-safety property (stage → verify → activate in one Dexie
transaction) at a fraction of the size.

### 4.5 Backfill without materialization

`GET /api/sync/space/:id?after=<seq>&limit=500` is a stateless keyset page over
`(space_id, seq)` bounded by a `cutoff` the first call returns (`MAX(seq)`).
Records changed after `cutoff` also arrive through the steady-state feed and
are idempotent under LWW; every page re-checks that the caller can still read
the space (capability fence, §4.6). **No row is copied or written.** A
5,000-record space costs 5,000 *reads* (within the 5 M/day read allowance) and
zero writes.

### 4.6 Write fence by capability, not by generation

Replace `accessFence(generation=?)` with a fence that re-evaluates *this
caller's capability for each space the batch touches*, in SQL, inside the batch:

```sql
SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM json_each(?1) need               -- [{"s":"space-a","min":3}, …]
  WHERE (SELECT CASE
     WHEN u.disabled_at IS NOT NULL THEN 0
     WHEN m.user_id IS NOT NULL AND m.access='allow'
          AND NOT (COALESCE(u.workspace_role,u.role)='guest' AND m.role IN ('owner','admin'))
       THEN CASE m.role WHEN 'viewer' THEN 1 WHEN 'commenter' THEN 2 WHEN 'editor' THEN 3
                        WHEN 'admin' THEN 4 WHEN 'owner' THEN 5 ELSE 0 END
     WHEN m.user_id IS NOT NULL THEN 0
     WHEN COALESCE(u.workspace_role,u.role)<>'guest' AND s.default_access='members' THEN 3
     ELSE 0 END
   FROM users u JOIN spaces s ON s.id=json_extract(need.value,'$.s') AND s.deleted_at IS NULL
   LEFT JOIN space_members m ON m.space_id=s.id AND m.user_id=u.id
   WHERE u.id=?2) < json_extract(need.value,'$.min')
) THEN 1 ELSE json_extract('{','$') END
```

It fails exactly when *this user's* effective role on a touched space dropped
below what the plan required — not when anyone's anything changed. The pure
`effectiveSpaceRole` and this SQL are one specification written twice, so a test
must enumerate every (workspace role × membership × default access × deleted ×
disabled) combination through both and require identical results (the draft
already exhausts the pure side).

Parent/reference revisions stay fenced exactly as the draft does
(`writeAuthorityFences`'s second statement). That part is already per-record.

### 4.7 What this removes

- `p5_session_delete`, `p5_record_visibility`, `p5_record_delete_visibility`,
  `p5_record_scope`, `p5_member_*`, `p5_user_*`, `p5_space_*` generation triggers
  (migration 0012/0013 are unshipped, so this is an edit of the draft, not a
  new migration on a deployed schema).
- `sync_snapshots`, `sync_snapshot_items` (migration 0014).
- The 20,000-record / 16 MiB snapshot ceilings and the `snapshot_capacity` /
  `snapshot_too_large` failure modes.
- The `409 access_reset_required` storm: a stale client is told *what changed*
  (manifest diff) rather than to throw everything away.

### 4.8 Budget comparison (illustrative; local counts, not billing)

Workspace of 10 members/guests, 5,000 readable records, 40 logouts + 30
soft-deletes per day.

| Design | Snapshots/day | Rows written/day by reconciliation | Notes |
|---|---:|---:|---|
| Draft (global generation) | up to 10 users × 70 events = 700 (upper bound: every online client reconciles on every event) | 700 × 5,000 × 2 (create + prune) = **7,000,000** | exceeds the 100,000/day allowance ~70×; even 1/50th of that is over budget |
| Draft, only membership/role events (best case) | ~10 | ~100,000 | the entire daily allowance |
| Per-space feeds (§4) | 0 | `space_events`: ≈ moves only (<100) | backfill reads 5,000/space/regrant |

The first row is the number the design review exists to surface: it is not a
tuning issue, it is the architecture.

## 5. Stores that denormalize content (R-04 / P5-G)

Every server-only store below holds text derived from synced records and is
outside sync eviction. Required handling is **read-time filtering plus bounded
purge**, never "hope retention catches it":

| Store | Content | Handling |
|---|---|---|
| `notifications` | title, body excerpt, url | `GET /api/notifications` joins target readability (graph) and renders "Restricted item" without title/body; revocation job purges unread rows for the lost space |
| `event_outbox.payload` | full record snapshot | processed rows are already deleted after 30 days; shorten to 24 h; never exposed by an API (verify) |
| `changeset_items`, `undo_items` | before/after of changed fields | `GET /api/changes/:id` and undo require *current* read/edit on each record (draft's kernel covers undo writes; the read side needs the filter) |
| `automation_runs.payload` | trigger record data | run history API returns status/error only (already); payload purged on terminal state |
| `form_submissions.payload`, `.receipt` | public visitor's answers | already 30-day retention; never exposed to guests |
| `mcp_requests.result` | prior tool output | replay must re-authorize and re-filter, or return `replayed` with a reference only |
| `approvals.note`, `.decided_note` | free text | visible only to requester/approver *who can still read the target* |
| `activity` (synced) | `targetTitle` | inherits target space (draft); targetless legacy → Core only |

## 6. Search

- FTS5 is available (draft probe `phase5-runtime-d1`). Keep authoritative
  `search_documents` outside the virtual table; FTS reconstructible.
- **One document per page/record**, aggregating bounded body text (the draft's
  rule). Do not index per block: FTS index maintenance multiplies rows written
  per edit, and the free-plan write quota is the binding constraint.
- Query: `FTS MATCH ? AND space_id IN (<readable>)` **then** an application-level
  score (title hit, recency) — do not expose raw `bm25` or global statistics.
- Index maintenance through the Phase 4 outbox (`maintainSearch` alongside
  `maintainDateIndex`), using the same *many records per binding call* batching
  (audit XP-14): one binding call per 50 documents.
- MCP `search` and the ⌘K palette call the same service; the existing
  scan-everything `search` tool (five collections per call) is removed.

## 7. Reconciling PR #7 with PR #8

Conflicts reported by `git merge-tree --write-tree` between
`audit/cross-phase-remediation` and `origin/grok/phase-5-search-permissions`:
`worker/sync.ts`, `worker/approvals.ts`, `worker/files.ts`, `worker/auth.ts`,
`worker/oauth.ts`, `src/core/files.ts`. (`worker/mcp.ts`, `worker/index.ts`,
`tests/approvals.test.ts`, `tests/sync-atomic.test.ts` auto-merge.) Resolution:

1. **`applyChanges` prologue.** Keep the draft's `readWriteSnapshot` (rows and
   `access_state` in one batch). From PR #8 keep: client timestamp clamp and
   healing (`healTimestamps`), the `record_too_large` check, and the shared
   read feeding restamp/pre-check/planning. The draft's `existing` map is that
   shared read; pass it to the gate pre-check.
2. **`guardStageWrites`.** Make the fourth parameter an options object:
   `{ existing?: Map<id,{data,field_ts,updated_at}>, proposedBoards?: Map<id,boardData>, now? }`.
   `proposedBoards` (draft) overrides board lookups; `existing` (PR #8) supplies
   stored task rows for the fold. Both semantics are needed.
3. **`worker/files.ts` / `worker/public.ts`.** Apply PR #8's `servedFile()` /
   `servedFileHeaders()` inside the draft's `authorizeFile` flow; keep the
   draft's `Cache-Control: private, no-store`. Re-sanitization happens after the
   authorization check, on the already-read bytes.
4. **`worker/auth.ts` / `worker/oauth.ts`.** Keep both: the draft's
   `disabled_at IS NULL` predicate and PR #8's throttle/grant revocation.
   Disabling an account must also call `revokeAllGrants`.
5. **`src/core/files.ts`.** Keep `renderableBlob()` at every object-URL site and
   the draft's cache eviction on reconciliation.
6. The three unpushed local commits on `grok/phase-5-search-permissions` were
   left untouched; whoever owns them should push or discard them before PR #7 is
   rebased.

## 8. Additional requirements implied by the audit

1. Every targeted loader introduced for scale (`listLinksByKind`,
   `listLinksTouching`, `pageClosure`, `loadTemplateSnapshot`, `listBy`) is a
   read path: each must take the caller's `ReadAccess` and filter by space
   (SQL prefilter + graph check), or be marked service-only.
2. The served-file policy applies **per space and per share**: a public token
   serves only files referenced inside its tree *and* in the same space as the
   shared root.
3. `deletedVia` restore must be space-aware: restore revives only rows still in
   the caller's editable spaces and never resurrects a row that was moved out
   after deletion.
4. Account disablement and role downgrade call `revokeAllGrants`, close live
   sockets (sweep, XP-11) and record an `access_audit` row; password change
   already does the first two.
5. Quota attribution for guests: unfinished-upload bytes count toward the
   shared quota (XP-12); define a per-guest ceiling before invitations ship.

## 9. Implementation order (each step independently shippable and testable)

| # | Step | Gate |
|---|---|---|
| 1 | Merge PR #8 (defect fixes) into `main`; rebase PR #7 | `npm run certify:phase4` green |
| 2 | Edit unshipped 0012/0013: drop generation triggers; add `space_events`, `spaces.epoch/events_floor`; delete 0014 | migration upgrade tests on populated D1 |
| 3 | SQL capability fence + SQL/TS parity enumeration | exhaustive parity test |
| 4 | `GET /api/access` manifest + etag on pull/push; per-space backfill; client per-space activation | two-engine browser journeys: revoke online/offline, regrant after stale cursor, move out |
| 5 | Read enforcement seam for MCP/files/public/notifications/changes | adversarial matrix: every read route × {viewer, guest, revoked, stranger} |
| 6 | Search service + indexer | 1,000-record authorized-search cost test; hidden-term rank test |
| 7 | Spaces/invites/sessions UI | 320 px, keyboard, VoiceOver/TalkBack manual gates (NOT RUN until done) |
| 8 | History + restore; usage endpoint | revision-safe restore under concurrent edit |
| 9 | Activation (reviewed migration, never a client API) | full certification + owner sign-off on export/quarantine policy |

## 10. Test requirements (beyond the draft's)

- Parity: TS `effectiveSpaceRole` ≡ SQL fence over the full combination space.
- Counters: assertion on rows written for logout, soft-delete, move, membership
  change, regrant; none may scale with record count except the explicit move.
- Stale cursor: client at `seq` older than `events_floor` re-backfills only the
  affected space and ends byte-identical to a fresh client.
- Regrant: eviction events written before the regrant must not hide re-delivered
  rows (backfill ignores events; steady state only applies events with
  `seq > backfillCutoff`).
- Cross-space link appears after regrant of the second space and disappears on
  revocation without a full reset.
- Confused deputy: automation authored in space A targeting B is rejected at
  save and at run when the *author* lost edit on B.
- Replay: an idempotent MCP result is re-filtered after revocation.
- Public: token pinned to a space stops serving after the root is moved.
