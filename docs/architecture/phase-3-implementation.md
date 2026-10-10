# Phase 3 — implementation design

Implementation-ready contract for `phase-3-tcg-pack.md` against the merged Phase 0–2 code.
Branch `codex/phase-3-tcg-operating-pack`, start `95ff408`.

Rule that shapes everything below: **the TCG pack is data, not code.** All product
features (archive, dashboard blocks, field mode, conversion, installer) are generic;
Programs/Projects/Experiments/… exist only inside `templates/tcg-pack.json`.

---

## 1. Data model (additive, no SQL migration)

Records are schemaless JSON in `records.data`; all additions are fields.

| Field | On | Shape |
|---|---|---|
| `archived` | `pages`, `boards`, `tasks` | `true` when archived; `false`/absent = active. Distinct from `deleted`. Never cascades. |
| `templateDbKey` | `boards` | stable dedupe key per database (`'people'`, `'projects'`, …) stamped at install. Combined with existing `templateKey` (bundle key). |
| `captureTargets` | `boards` | `[{kind:'observation'|'expense'|'task'|'note', databaseId}]` — per-database field-capture routing. |
| `fieldActions` | `boards` | `('observation'|'expense'|'task'|'note'|'photo'|'voice'|'text')[]` — which capture kinds this database offers as context. Absent → defaults (all base kinds + any kind present in `captureTargets`). |
| `convertedFrom` | `tasks` | record id this record was converted from (dedupe marker). |
| Block config fields | `blocks` | see §3. |

`ViewConfig.includeArchived?: boolean` added to `shared/views.ts`.

## 2. Archive semantics

- `applyView` drops `r.archived === true` unless `config.includeArchived === true` — one
  rule shared by client views and MCP `query_records` (new `includeArchived` passthrough arg).
- Sidebar tree and board/database pickers hide `archived === true` rows; ⌘K search keeps
  them and badges them "Archived".
- `archive_item`/`unarchive_item` MCP tools: `{id, collection?: 'page'|'database'|'record'}`
  auto-resolves the collection, CAS patch `{archived: true|false}` through `reg()` →
  expectedRev, requestId, dryRun, changeset + undo all inherited. Already-archived →
  `{archived: true, changed: false}` (200, no write); missing → 404-ish `err()`.
- Client: menu "Archive"/"Unarchive" on page + database + record; archived pages/records
  show an "Archived" banner with Unarchive button. `mutate()` patch same field — offline
  archive/restore syncs like any write.

## 3. Dashboard blocks (new `blocks` types)

Registered via `registerBlockType` from the boards module (`blocks/dashboard.tsx`).
`tasks` block stays untouched (backward-compatible embedded board).

| `type` | Config fields on block | Renders |
|---|---|---|
| `view` | `databaseId`, `viewId?`, `inline?: ViewConfig`, `limit?`, `heading?` | any view renderer (board/table/list/gallery/calendar/timeline) |
| `metric` | `databaseId`, `filters?: Filter[]`, `agg: 'count'|'sum'|'avg'`, `fieldKey?`, `label`, `format?: 'number'|'currency'` | big number → click opens drill-down sheet of exact source records |
| `calendar` | `sources: [{databaseId, dateKey, filters?, color}]` | unified multi-db calendar; agenda layout in compact container |
| `activity` | `scope: 'all'|'mine'|{pageTreeId}`, `limit` | activity rows (actor, action, target, "via <client>" attribution) |
| `mywork` | — | current user's open records grouped overdue/today/upcoming |

Container-adaptive: a `useContainerWidth(ref)` hook (core/ui or new `core/container.ts`)
drives compact presentation below ~560px — metrics wrap to one column, calendar switches
to agenda, embedded views use their existing compact branches. All blocks get a
"Configure" popover via the block menu; empty/loading/sync-error/missing-source states
are explicit and readable at 320px.

### `shared/views.ts` additions

```ts
export function aggregate(
  records: readonly ViewRecord[],
  spec: { filters?: Filter[]; agg: 'count'|'sum'|'avg'; fieldKey?: FieldKey },
  ctx?: ViewCtx,
): { value: number | null; count: number; numericCount: number; ids: string[] }
```

- `ids` = filtered row ids → drill-down set (metric totals always match `query_records`
  for the same filters since both evaluate `applyView`).
- `sum`/`avg` coerce `Number(v)`; non-finite/null/'' skipped (`numericCount` = used count);
  `avg` = `null` when `numericCount === 0`.
- `count` ignores `fieldKey`; `value` = `count`.

## 4. Shared engine changes (`shared/`)

### `shared/bundled.ts` (new — moved + extended author format)

`toBundled(key, AuthorTemplate)` moves here (pure, importable by worker) with extensions:

```ts
interface AuthorDb {
  id: string; key?: string;              // key → templateDbKey + reuse
  name: string; icon?: string; kind?: string; recordNoun?: string;
  showBuiltins?: Record<string, boolean>; columns?: {id,name,color?}[];
  fields?: FieldDef[];                    // relation.target = authored db id (remapped)
  captureTargets?: {kind, databaseId}[];  // databaseId = authored id or literal
  fieldActions?: string[];
  defaultViewId?: string;
  views?: {id,name,type?,config?,order?}[];
  records?: {id, title, status?, props?: Record<`p_${string}`, unknown>, body?: string[]}[];
}
interface AuthorBlock {                    // object form in page blocks
  type: 'text'|'h1'|'h2'|'h3'|'bulleted'|'todo'|'divider'|'callout'|'tasks'
      |'view'|'metric'|'calendar'|'activity'|'mywork'|'embed';
  text?: string; checked?: boolean; url?: string;
  databaseId?: string; viewId?: string; limit?: number; heading?: string;
  filters?: Filter[]; agg?: string; fieldKey?: string; label?: string; format?: string;
  sources?: {databaseId,dateKey,filters?,color}[]; scope?: unknown;
}
interface AuthorPage { id; title; icon?; parentId?; template?: boolean; order?: string; blocks?: (string|AuthorBlock)[] }
interface AuthorTemplate { name; description; icon; databases: AuthorDb[]; pages: AuthorPage[]; links?: {from,to,kind?,fieldId?}[] }
```

`databaseId`/relation `target`/`sources[].databaseId`/`captureTargets[].databaseId`
values are **authored db ids** — snapshot identity, remapped by the planner.
`links.from/to` are authored page/record ids. String lines still work (`Embed: db_x`).

### `shared/templates.ts` planner extensions

```ts
interface TemplateOpts {
  …existing…
  reuseBoards?: Record<string, string>;   // authored/src board id → EXISTING live board id
  preserveTemplates?: boolean;            // bundled install keeps isTemplate:true pages
  packInstall?: boolean;                  // bundled install copies the WHOLE authored set
                                          // (all pages/boards/records/views/links), not just
                                          // the templateId subtree — tcg-pack pages are
                                          // top-level siblings, so subtree-only installs
                                          // would yield a single page and no databases
}
```

- `reuseBoards` ids join `boardMap` upfront: no board/record/view writes for them, but
  every reference remaps to the live id (relation targets, block `databaseId`,
  `captureTargets`, views' `databaseId`).
- `viewMap` allocated before writes so `view` blocks' `viewId` remaps.
- Block copy whitelist extended: `databaseId`, `viewId`, `limit`, `heading`, `filters`,
  `agg`, `fieldKey`, `label`, `format`, `sources`, `scope`, `url` — with
  `databaseId`/`viewId`/`sources[].databaseId` remapped via `boardMap`/`viewMap`.
- Copied board patch also passes through `captureTargets`/`fieldActions` (target ids remapped).
- `preserveTemplates` → `isTemplate:true` survives on pages that authored `template:true`
  (bundled installs set this; user page-template instantiation leaves it false).
- Reused boards' relation `target` remap: `boardMap.get(target) ?? target` covers live ids.

### `shared/bundled.ts` helpers (both sides use them)

```ts
findReusableBoards(existing: {id, templateDbKey?, templateKey?, name?, deleted?}[], author: AuthorTemplate): Record<string,string>
```
- Match live board by `templateDbKey === db.key`; fallback for pre-key installs:
  `templateKey === 'starter-people'` && name equals authored name (people/organizations only).
- Re-run safety: pack databases carry `key` → second install reuses them too.

```ts
planInstallPreview(bundle, existingBoards): { databases: {create:string[], reuse:string[]}, pages:number, views:number, links:number, records:number, blocks:number }
```
- Drives gallery preview sheet + MCP dry-run result.

### `shared/conversion.ts` (new)

```ts
planConversion(
  { src: StoredRecord, srcBoard, destBoard, templateId?, linkKind='related',
    sourceStage?: string, title?: string },
  deps: {id, now},
): { ops: PlannedWrite[]; destId: string; warnings: string[] } | { error: string }
```

- dest record: new id, `boardId=destBoard`, `status` = `sourceStage`→dest default = first
  column; copies `title`/`description` and only `p_*` props whose field id exists in BOTH
  boards with the same `type` (warnings list dropped fields); `convertedFrom: srcId`.
- link op: `kind:linkKind`, `fieldId:null`, `fromId=destId`, `toId=srcId`.
- source stage op when `sourceStage` given: validates column id exists on srcBoard.
- Dedupe (worker-side, before planning): live dest-db record with
  `convertedFrom === srcId` → return existing `{destId, alreadyConverted:true}`.

### `shared/archive.ts` (new, small)

`isArchived(row)`, `archivePatch(archived: boolean)` → `{archived: true|false}`,
`ARCHIVED_LABEL = 'Archived'`.

## 5. Worker / MCP (Agent E)

- `worker/bundledTemplates.ts` (new): `import rawPack from '../templates/tcg-pack.json'`
  + `starter-people.json` → `toBundled` → `BUNDLED` map.
- `install_template({bundled: 'tcg-pack'|'starter-people', dryRun?, force?})`:
  resolve snapshot → `findReusableBoards` over live boards →
  `planTemplateInstantiation(snap, {templateId: root, templateKey: bundled, preserveTemplates: true, reuseBoards})`.
  dryRun → `planInstallPreview` result, no writes. Live root marker check: page with
  `templateKey === bundled` → `{alreadyInstalled: true}` unless `force`.
  Writes through `write()`; >500 ops → sequential `write()` calls inside ONE changeset,
  blocks last; interruption → re-run reuses databases (dedupe) and returns alreadyInstalled
  once the marker page lands — recovery is "run install_template again", never destructive.
- `archive_item` / `unarchive_item` per §2.
- `convert_record({recordId, toDatabaseId, templateId?, linkKind?, sourceStage?, title?, …})`
  via `planConversion` + `convertedFrom` dedupe; returns both record URLs + changesetId.
  `convert_idea_to_project({ideaId, templateId?})`: resolves Ideas db (templateDbKey `ideas`)
  → Projects db (templateDbKey `projects`), `sourceStage:'converted'`.
- `query_records`: `includeArchived?: boolean` arg + `archived` in row output.
- Prompts via `server.registerPrompt`: `weekly_operating_review`, `project_review`,
  `field_notes_to_log` — each instructs the client to pull real data (list_databases /
  query_records), name the source ids, never invent metrics, and route writes through the
  guarded tools. `field_notes_to_log` requires the client to confirm ambiguous
  context/units/targets instead of fabricating.

## 6. Client UI

### Dashboard blocks (Agent C)
`src/modules/boards/blocks/` — `ViewBlock`, `MetricBlock`, `CalendarBlock`,
`ActivityBlock`, `MyWorkBlock` + shared `BlockConfig` popover + `RecordListSheet`
drill-down (rows → record detail). Registration from `boards/index.tsx`.
Container hook `useContainerWidth`. Metric click → sheet of `ids` from `aggregate`.

### Template gallery (Agent C)
Settings → Templates: preview sheet (databases create/reuse, views, pages, links,
blocks counts + reuse warning), dry-run plan call, progress state while `mutate()`
writes land, installed/reinstall state from `templateKey` root page.
`instantiateTemplate` passes `reuseBoards` + `preserveTemplates`.

### Archive UI (Agent C)
Page/database/record menus + banner + view-config "Include archived" toggle
(`ViewConfig.includeArchived`) + sidebar "Archived" section; ⌘K badge.

### Field mode (Agent D — `src/modules/boards/Capture.tsx`)
- Context chip → `ContextPicker` sheet (search pages+records, keyboard-first).
  `localStorage.ws_field_ctx` = `{id, kind:'page'|'record', title, databaseId?}`.
- Kind chips from context db's `fieldActions`/`captureTargets`; destination line shows
  resolved database (captureTargets → else Inbox) before Save.
- Kind forms: observation (measurement/unit/text/photos), expense (amount/date/category),
  note (text), task (title+due). All fields labeled, mobile keyboards.
- Save: `mutate` record into resolved db + `links` `kind:'related'` `fromId=record,toId=ctx`
  + files via existing pipeline (photo/voice/Drive URL text field always available).
- Draft via `saveDraft`/`useDraft` (collection `'capture'`, id `'pending'`) — survives
  reload/orientation; deleted context/destination → keep draft, require explicit
  destination choice, never silently file to Inbox. Camera denial → file chooser +
  message; voice unsupported → text/file.
- Database settings gain "Capture targets" editor (kind → database selects).

## 7. `templates/tcg-pack.json` (Agent B)

Authored ids `db_<slug>`, `pg_<slug>`, `r_<slug>`; keys `key: '<slug>'` on every database.
17 databases per spec table (Programs, Projects, Tasks kind:'tasks', Experiments,
Field Log, Ideas, Decisions, Meetings, Events, Places, Opportunities, Media, Courses,
Transactions, Products, People, Organizations — People/Orgs `key:'people'|'organizations'`
matching starter-people for reuse). All spec'd stages → `columns`, fields → `fields`
(relation targets = authored ids, `pairedFieldId` set for two-way), `captureTargets`
on Places/Projects/Experiments (`observation→db_fieldlog`, `expense→db_transactions`,
`task`/`note`→`db_tasks`).
Dashboard pages (Home/Leadership, My Work, Programs, Project, Common Lab, Community,
Partnerships & Funding, Media, Operations/Finance) built from §3 blocks with exact
filters in JSON. Info-architecture pages incl. Places→Parambu Habitat child, Knowledge
tree, Archive page (view block with `includeArchived:true` inline config).
17 page templates (`template:true`) with `{{vars}}` placeholders; Project Review uses the
8 specified questions as h2/text blocks.
~2–3 example records only where required for links (Parambu Habitat place record).
`scripts/export-template.mjs` may bootstrap sections; final file is hand-maintained.

## 8. Tests (Agent F, with unit additions owned by each track)

- `tests/`: views aggregate/includeArchived; bundled author→snapshot (records, links,
  typed blocks, captureTargets remap); planner reuse/preserveTemplates/viewId remap;
  conversion planner (valid/invalid stage, field-name matching, dedupe); archive helpers.
- `scripts/verify-mcp-phase3.mjs`: fresh D1 — install (empty + after starter-people →
  reuse, dryRun, requestId replay, alreadyInstalled), archive/unarchive (incl. query_records
  includeArchived), convert_record + idea wrapper (both orders, retry, undo, invalid db),
  prompts/list+get, expectedRev conflict, auth isolation.
- `scripts/verify-v8.mjs`: Chromium/Firefox/WebKit × compact/tablet/desktop — journeys
  1–8 from the brief (install fresh, install-with-starter reuse, leadership dashboard
  metric=source rows, project review narrow layout, field offline capture→second device,
  conversion, archive, failure recovery) + ≥1000-record perf fixture with measured
  timings. Physical iOS/Android/AT = NOT RUN gates.
- Full Phase 0–2 suite keeps passing (smoke, multiuser, phase1, phase2, v4, v6, v7).

## 9. Ownership / sequence

| Track | Owns |
|---|---|
| Integrator (me) | this doc, `shared/types.ts` block docs, merges, gates, PR |
| A shared engine | `shared/views.ts`, `shared/bundled.ts`, `shared/conversion.ts`, `shared/archive.ts`, `shared/templates.ts`, `tests/views.test.ts`, `tests/templates.test.ts`, `tests/bundled.test.ts`, `tests/conversion.test.ts`, `tests/archive.test.ts` |
| B template data | `templates/tcg-pack.json`, `src/core/bundledTemplates.ts`, `worker/bundledTemplates.ts` |
| C dashboard UI | `src/modules/boards/blocks/**`, gallery UI in `src/core/settings.tsx`, archive UI, container hook |
| D field mode | `src/modules/boards/Capture.tsx`, `ContextPicker`, capture-targets editor |
| E worker/MCP | `worker/mcp.ts`, `worker/bundledTemplates.ts` (with B) |
| F verification | `scripts/verify-mcp-phase3.mjs`, `scripts/verify-v8.mjs`, perf fixture |

Sequence: A first (contracts), B in parallel (JSON data). C/D/E dispatch after A lands;
F after C/D/E. Same shared-branch convention as Phase 2: children pull --rebase, push
to `codex/phase-3-tcg-operating-pack`, file-ownership discipline.
