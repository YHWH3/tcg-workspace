# Phase 1 — Databases, views and linking

Goal: turn boards into general-purpose **databases** (any kind of record, not only tasks), add **views**, give every record a **page body**, and connect everything with **relations, sub-tasks, dependencies and backlinks**. Add **Google Drive links** for large media. Provide a **People & Organizations** starter as a template, not code.

Depends on Phase 0 (revisions, change sets, CAS ops, targeted reads). Every new MCP write tool follows Phase 0 conventions: `requestId`, `expectedRev` where applicable, `dryRun` for bulk/destructive, change sets, `warnings`.

---

## 1. Naming (UI vs code)

| UI term | Code / storage | Note |
|---|---|---|
| Database | `boards` collection, `BoardRow` | keep collection + type names to avoid migration |
| Record (task in task DBs) | `tasks` collection, `TaskRow` | |
| Stage | `board.columns[]` / `task.status` | |
| Field / property | `board.fields[]` / `task['p_'+fieldId]` | |
| View | new `views` collection | |
| Link | new `links` collection | |

UI copy: a database of kind `tasks` keeps saying "Tasks / Board"; kind `records` says "Records" (or the database's own `recordNoun`, e.g. "Person").

---

## 2. Data model changes

### 2.1 `boards` (database) — new optional fields

```ts
interface BoardRow {
  // existing: name, icon, columns, fields, order, createdBy, createdAt, deleted
  kind?: 'tasks' | 'records';      // missing → 'tasks'
  recordNoun?: string;             // e.g. 'Person', 'Project' (UI label), default 'Task'/'Record'
  description?: string;
  showBuiltins?: { assignee?: boolean; due?: boolean; priority?: boolean }; // default: all true for tasks, all false for records
  defaultViewId?: string | null;   // workspace default view; a per-user localStorage override wins (§4.1)
  templateKey?: string;            // set when instantiated from a bundled template (e.g. 'starter-people') — installers reuse rather than duplicate (Phase 3)
}
```

- `columns` may be **empty** for `kind:'records'` → stages hidden, board view unavailable, default view = table. For `kind:'tasks'` keep ≥1 column (existing rule).
- "Done" semantics (last column) unchanged and only meaningful when columns exist.

### 2.2 `tasks` (record) — new optional fields

```ts
interface TaskRow {
  // existing …
  parentId?: string | null;        // sub-task / sub-record parent (same database only)
  deletedVia?: string | null;      // set when soft-deleted because its parent was deleted
}
```

Note: `tasks.pageId` already exists (created as `null`, unused). Leave it untouched — the record body is `blocks`, not `tasks.pageId`; older clients may still write it.

### 2.3 `blocks` — owner type

```ts
interface BlockRow {
  pageId: string;                  // owner id (page id OR record id)
  parentType?: 'page' | 'record';  // missing → 'page'
  // new block type 'embed': { url: string; provider: 'gdrive' | 'link'; title?: string }
}
```

A record's body = blocks with `pageId = record.id, parentType = 'record'`. IDs are UUIDs so page/record ids don't collide. Public-share code must ignore `parentType:'record'` blocks (records are not shared in Phase 1).

### 2.4 New collection `views`

```ts
interface ViewRow {
  id: string;
  databaseId: string;              // boards.id
  name: string;
  type: 'board' | 'table' | 'list' | 'gallery';   // calendar/timeline added in Phase 2
  order: string;                   // fractional key among the database's views
  config: ViewConfig;              // single LWW field (one person edits a view at a time)
  createdBy?: string; createdAt?: number; deleted?: boolean;
}
interface ViewConfig {
  filters?: Filter[];              // AND-combined
  sorts?: { key: FieldKey; dir: 'asc' | 'desc' }[];
  groupBy?: FieldKey | null;       // board view: 'status' (default) or a select/person field
  visible?: FieldKey[];            // table/list/gallery columns & card props, in order
  cover?: 'cover' | `p_${string}` | null;   // gallery/board card image source
  showSubrecords?: boolean;        // default false on board/gallery, true (nested) on table
  mine?: boolean;                  // shortcut filter: assignee = current user
}
type FieldKey = 'title' | 'status' | 'assigneeId' | 'dueDate' | 'priority' | 'createdAt' | 'createdBy' | `p_${string}` | `rel_${string}`;
interface Filter { key: FieldKey; op: 'is' | 'is_not' | 'contains' | 'not_contains' | 'empty' | 'not_empty' | 'before' | 'after' | 'on_or_before' | 'on_or_after' | 'checked' | 'unchecked' | 'me'; value?: unknown }
```

If a database has no views, the client renders an implicit default (board for tasks, table for records). Creating the first explicit view persists it.

### 2.5 New collection `links`

```ts
interface LinkRow {
  id: string;                      // deterministic, see §3.4
  fromType: 'record' | 'page' | 'mooditem' | 'block';
  fromId: string;
  toType: 'record' | 'page' | 'mooditem' | 'file';
  toId: string;
  kind: 'relation' | 'blocks' | 'related';
  fieldId?: string | null;         // for kind 'relation': the field on the FROM record's database
  createdBy?: string; createdAt?: number;
  deleted?: boolean;               // unlink = deleted:true (re-link flips back)
}
```

- `relation`: value of a relation field. Direction: from the record that owns `fieldId`.
- `blocks`: dependency — `from` must finish before `to` (from blocks to).
- `related`: free "see also" link between any two items (no field).

Links are the **only** store of relation values and dependencies — never duplicated onto records. This keeps concurrent add/remove merge-safe.

### 2.6 New field type `relation`

Add to `FieldType` in `shared/fields.ts`:

```ts
interface FieldDef {
  // existing …
  type: … | 'relation';
  relation?: {
    target: string;                // databaseId, or 'pages' for any page
    pairedFieldId?: string | null; // two-way: the reverse field on the target database
    single?: boolean;              // UI: at most one linked item (not enforced in storage)
  };
}
```

- Forward values of field F on record R = live links `{kind:'relation', fieldId:F.id, fromId:R.id}` → `toId`s.
- Reverse values shown in paired field P on target record T = live links `{kind:'relation', fieldId: P.relation.pairedFieldId (= F.id), toId:T.id}` → `fromId`s.
- Creating a two-way relation field creates F on DB A and P on DB B in one operation, each pointing at the other (`F.relation.pairedFieldId = P.id`, `P.relation.pairedFieldId = F.id`). P is "reverse": links are always stored with `fieldId = F.id` (the side that was created first, marked `relation.primary: true`). Adding a link from B's side via P writes `{fromId: A-record, toId: B-record, fieldId: F.id}` (normalise to primary direction).
- `coerceFieldValue` for `relation` returns `undefined` (never stored as `p_` key). `formatFieldValue` receives resolved titles from caller.
- Deleting a relation field: set the field deleted from fields array; links remain (ignored); deleting the paired side removes `pairedFieldId` from the other.

### 2.7 `files` — link kind

```ts
interface FileRow { kind?: 'image' | 'video' | 'audio' | 'pdf' | 'file' | 'link'; url?: string; provider?: 'gdrive' | 'link'; }
```

`kind:'link'` records have no bytes: the upload pipeline (`uploadPendingBlobs`, `src/core/files.ts`) must skip them; `useFileUrl` returns `url`; public share serves them as links only.

### 2.8 Collections + local DB

- `shared/collections.ts`: add `'views', 'links'`.
- `src/core/db.ts`: Dexie `version(4)`:
  - `views: 'id, databaseId, order'`
  - `links: 'id, fromId, toId, kind, fieldId'`
  - `tasks: 'id, status, assigneeId, boardId, parentId, order, createdAt'`
  - `blocks: 'id, pageId, order'` (unchanged)
- Migration `0005_links_index.sql`: expression indexes `records(collection, json_extract(data,'$.fromId'))`, `…'$.toId'`, `…'$.databaseId'`.

---

## 3. Shared pure modules (all unit-tested)

### 3.1 `shared/views.ts`
- `evalFilter(record, filter, ctx)` and `applyView(records, config, ctx) → { rows, groups? }`. `ctx` provides `meId`, `today`, `fieldsById`, `relationTitles(recordId, fieldId) → string[]`, `columnsById`.
- Sorting: stable; `title` uses locale compare; dates ISO compare; select by option order; nulls last.
- Used by client views **and** MCP `query_records`.

### 3.2 `shared/tree.ts`
- `wouldCreateCycle(parentOf: Map<id, parentId|null>, childId, newParentId): boolean`
- `descendants(parentOf, id): string[]`
- `depthOf(...)`; max depth **3** (record → sub → sub-sub). Reject deeper.

### 3.3 `shared/deps.ts`
- `wouldCreateDependencyCycle(edges: [from,to][], from, to): boolean` (DFS).
- `isBlocked(recordId, edges, isDone: (id) => boolean): boolean` — any live incoming `blocks` edge whose `from` record is not done.

### 3.4 `shared/linkid.ts`
- `linkId(kind, fieldId|'' , fromId, toId): string` = `'lk_' + fnv1a64hex(kind|fieldId|fromId|toId) + fnv1a64hex(reverse string)` (two 16-hex halves → 35 chars ≤ 64). Pure sync hash so client and worker produce identical ids. Normalise relation direction (§2.6) **before** hashing. Unit-test determinism and collision sanity over 100k random pairs.

### 3.5 Extend `shared/templates.ts`
- Copy `kind, recordNoun, showBuiltins, description` on boards.
- Copy `views` of copied databases (remap `databaseId`, field keys `p_<old>` stay valid because field ids are copied unchanged).
- Copy `links` whose both ends are inside the copied set (records/pages), remapping ids; relation fields between two copied databases remap `relation.target` and `pairedFieldId`; relation fields pointing outside keep their target.
- Copy record `parentId` (remapped) and record body blocks (`parentType:'record'`).
- Remap `@[rec:ID]` mention tokens alongside the existing `@[page:ID]` remap (`PAGE_TOKEN_RE` → generalise to `MENTION_TOKEN_RE` covering `page|rec`; `user` tokens stay unmapped).
- Snapshot type gains `views`, `links`.

### 3.6 Extend mentions
- Token `@[rec:ID]` in `src/core/mentions.ts` `TOKEN_RE`, `shared/markdown.ts` `TOKEN_RE`, `worker/public.ts` `MENTION_RE` and `src/public/PublicView.tsx` `MENTION_RE` (public renders record mentions as plain text).
- `resolveMentions` resolves record titles; chips navigate to `/boards/:boardId/tasks/:id`.
- Markdown `[[Title]]` resolution order: pages, then records; ambiguous → leave literal + warning (Phase 0 rule).

---

## 4. Client UI

### 4.1 Database page (`src/modules/boards/BoardPage.tsx` → becomes the database shell)
- Header: icon, name, **view tabs** (horizontal, scrollable on mobile; "+ View" at end), presence, menu (Fields, Stages, Database settings: kind/recordNoun/builtins, Delete).
- View switch persists per user in `localStorage ws_view_<dbId>`; the board's `defaultViewId` field is only the workspace fallback for a user with no local choice.
- View toolbar (compact, collapsible): Filter, Sort, Group (board), Properties (visible), "Mine" toggle. Filters edited in a popover writing `views.config` via `mutate`.
- Routes unchanged: `/boards/:boardId`, `/boards/:boardId/tasks/:taskId`. Add `/boards/:boardId/views/:viewId`.

### 4.2 Views
| View | Component | Notes |
|---|---|---|
| Board | existing `Board.tsx` | groupBy status (default) or select/person field; drag between groups writes that field; sub-records hidden unless `showSubrecords`; card shows sub-progress "2/5" and blocked badge |
| Table | new `TableView.tsx` | sticky title column; cells use existing `FieldValue` editors + relation picker; header click = sort; add row at bottom; row expand → record detail; nested sub-records with disclosure; >300 rows → windowed rendering; mobile → renders as `ListView` |
| List | existing list mode, extracted to `ListView.tsx` | compact rows + chips |
| Gallery | new `GalleryView.tsx` | grid of cover cards (`cover` from config), title + up to 3 props |

### 4.3 Record detail (`TaskDetail.tsx`)
Order: title → stage/built-ins (only those enabled by `showBuiltins`) → fields (incl. relation pickers) → **Sub-records** (checklist rows with add/reorder/complete; each opens its own detail) → **Dependencies** ("Blocked by" / "Blocking" lists with add/remove) → **Body** (embedded `BlockEditor` with `parentType:'record'`) → attachments → **Linked** panel (§4.5) → comments slot.

### 4.4 Relation picker
Popover search over target database (or pages), multi or single, create-new-inline ("+ Create '<query>'" creates a record in target DB). Chips navigate.

### 4.5 Linked panel (`src/core/LinkedPanel.tsx`, used by pages (pageFooter slot) and record detail)
Groups: each relation field (forward + reverse), "Related", "Blocks / Blocked by", "Mentioned in" (blocks containing `@[page:id]` / `@[rec:id]`). Collapsed by default when empty. "+ Link" adds a `related` link to any page/record via search.

### 4.6 Command palette (`src/core/search.tsx`)
Include records (title) with database name as subtitle; route to record detail.

### 4.7 Embed block + Drive links
- Paste a URL on an empty line → if Drive/Docs pattern, convert to `embed` block (provider `gdrive`); else offer "Embed link" / "Keep as text".
- Patterns (`shared/drive.ts`, pure, tested):
  - `drive.google.com/file/d/<id>/…` → preview `https://drive.google.com/file/d/<id>/preview`
  - `docs.google.com/(document|spreadsheets|presentation)/d/<id>/…` → `https://docs.google.com/<type>/d/<id>/preview`
  - `drive.google.com/drive/folders/<id>` → `https://drive.google.com/embeddedfolderview?id=<id>#grid`
  - anything else → `provider:'link'` card (title = hostname + path, no fetch).
- Render `<iframe src=preview sandbox="allow-scripts allow-same-origin allow-popups" loading="lazy" referrerpolicy="no-referrer">` with an "Open in Drive" link; on mobile show a tappable card instead of iframe.
- Attach-as-link from task detail / capture: "Add Drive link" → `files` record `kind:'link'`.
- Note shown once: "People need access to the file in Drive to see the preview."

---

## 5. Client write helpers (`src/modules/boards/api.ts` + new `src/core/links.ts`)

```ts
createRecord(databaseId, { title?, status?, parentId?, extra? }): Promise<string>
setParent(recordId, parentId | null): Promise<void>        // validates cycle + depth; same database only
link(from: Ref, to: Ref, kind, fieldId?): Promise<string>   // deterministic id; upsert deleted:false
unlink(linkId): Promise<void>                               // deleted:true
addDependency(blockerId, blockedId): Promise<void>          // cycle check
deleteRecord(id): Promise<void>  // soft-deletes descendants with deletedVia=id
restoreRecord(id): Promise<void> // restores descendants where deletedVia=id
moveRecordToDatabase(id, dbId)   // moves descendants too; relation links whose field isn't on the target DB are kept but hidden (report count — same rule as §8)
createView(dbId, type, name?) / updateView(id, config) / deleteView(id)
createRelationField(dbId, { name, target, twoWay, reverseName? })
```

All go through `mutate()`.

---

## 6. MCP tools (new + changed)

All follow Phase 0 conventions. Reads return `rev`.

| Tool | Input (abridged) | Output |
|---|---|---|
| `create_database` | `{name, icon?, kind, recordNoun?, stages?: string[]\|{name,color}[], fields?: FieldInput[], views?: ViewInput[], parentPageId?}` | ids, URL; if `parentPageId`, appends a `tasks` block embedding it |
| `create_board` | alias → `create_database` kind `tasks` | |
| `add_field` (Phase 0) | + `type:'relation', relation:{target (db id/name or 'pages'), twoWay?, reverseName?, single?}` | |
| `add_view` / `update_view` / `remove_view` | `{databaseId, name, type, filters?, sorts?, groupBy?, visible?, cover?}` filters use field **names** resolved server-side | view id + URL |
| `query_records` | `{databaseId, filters?, sorts?, limit≤200, cursor?, include?: ('fields'\|'relations'\|'subrecords'\|'deps')[]}` | rows with named field values, `rev`; uses `shared/views.ts` |
| `get_record` | `{recordId}` | fields by name, stage, relations (titles + ids), parent, children, deps, body markdown, backlinks, comments count, `rev`, URL |
| `create_records` | `{databaseId, records:[{title, stage?, parent? (id\|title), fields?, relations?: {fieldName: (id\|title)[]}, blockedBy?: (id\|title)[], body?: markdown, assignee?, due?, priority?, coverImageUrl?}], dedupe?}` ≤100 | created ids, skipped, warnings. Title references resolve within the same call first (so a batch can create a parent and its children), then existing records |
| `create_tasks` | alias → `create_records` | |
| `update_records` | `{updates:[{recordId, expectedRev?, title?, stage?, fields?, addRelations?, removeRelations?, parent?: id\|null, …}]}` | |
| `update_tasks` | alias → `update_records` | |
| `edit_record_body` | same shape as `edit_page` with `recordId` | |
| `link_items` / `unlink_items` | `{from:{type,id}, to:{type,id}, kind:'related'\|'blocks'\|'relation', field?}` | link id |
| `set_parent` | `{recordId, parentId\|null}` | errors on cycle/depth/cross-database |
| `add_dependency` / `remove_dependency` | `{blocker, blocked}` (ids or titles + databaseId) | errors on cycle |
| `get_page` / `fetch` | add `linked` (relations/related/mentions) | |
| `workspace_overview` | databases with `kind`, `recordNoun`, stages, fields (incl. relation targets), views (names) | |
| `delete_item` | types gain `record` (alias task), `view`, `link`; record delete cascades to sub-records (`deletedVia`), dry-run impact lists them | |

Markdown body support: `markdownToBlocks` emits `embed` for a line that is only a Drive/Docs URL.

Server-side validation mirrors the client (`shared/tree.ts`, `shared/deps.ts`, relation target checks). Relation values referencing records in the wrong database → warning + skipped.

---

## 7. Starter template: People & Organizations

Shipped as data, not code: `templates/starter-people.json` — an exported template snapshot (pages, blocks, boards, views, links) applied through the existing template planner. Settings → "Template gallery" (new small section) lists bundled JSON templates and "Add to workspace" instantiates them (client `instantiateTemplate` with the bundled snapshot instead of a workspace page).

Contents:
- **People** (`kind:'records'`, noun "Person", no stages): fields — Roles (`multi_select`: Volunteer, Member, Collaborator, Artist, Researcher, Farmer, Craftsperson, Filmmaker, Facilitator, Partner contact, Funder contact, Space owner), Skills (`multi_select`), Location (text), Phone (text), Email (`url`), Team account (`person`), Status (`select`: Active, Occasional, Past), Notes in body. Views: All (table), Volunteers (filter Roles contains Volunteer), Gallery.
- **Organizations** (`kind:'records'`, noun "Organization"): Type (select: University, School, NGO, Foundation, Company, Government, Community, Space), Website, Location, Relationship owner (person), Status. Relation **People ↔ Organizations** two-way ("Organization" / "People").
- A "People & Organizations" page embedding both.

`scripts/export-template.mjs` (dev tool): exports a workspace template page tree to JSON for future bundled templates.

---

## 8. Edge cases (must be handled and tested)

| Case | Rule |
|---|---|
| Sub-record parent in another database | rejected (UI hides; MCP error) |
| Cycle / depth > 3 | rejected |
| Parent deleted | descendants soft-deleted with `deletedVia`; restore parent restores them; deleting a child alone does not affect parent |
| Parent moved to another database | descendants move with it; relation links whose field isn't on the target DB are kept but hidden (report count) |
| Dependency cycle | rejected |
| Blocker deleted | link ignored (blocked badge clears) |
| Relation target database deleted | field shows "missing database"; links kept |
| Two people link the same pair concurrently | deterministic id → one link |
| Link + unlink concurrently | LWW on `deleted` field |
| Record body block owner deleted | blocks hidden with record; restored with it |
| Drive file not shared | iframe shows Google's access screen; "Open in Drive" fallback |
| Kind `records` with empty stages | board view disabled; stage filter hidden; MCP `stage` input ignored with warning |
| Old boards (no `kind`, no views) | behave exactly as before |
| Public share of a page with a `tasks` block whose records have sub-records | show top-level only (unchanged public payload) |

---

## 9. Tests

Unit: `views.test.ts` (each op, sorts, nulls, `me`, relation contains), `tree.test.ts`, `deps.test.ts`, `linkid.test.ts`, `drive.test.ts`, `templates.test.ts` (views/links/relations/sub-records/body remap), `markdown.test.ts` (`@[rec:]`, embed lines), `fields.test.ts` (relation never coerced).

E2E `scripts/verify-v6.mjs` (Playwright + MCP SDK, `wrangler dev :8788`):
1. MCP `create_database` People (records) + Organizations with two-way relation; `create_records` with relations by title; UI shows chips both sides within ~3 s.
2. Table view: inline edit text/select/relation; sort; filter; mobile renders list.
3. Gallery with covers.
4. Sub-tasks: create via UI and MCP; progress on card; cycle/depth rejected; delete parent → children hidden → restore.
5. Dependencies: add via MCP; blocked badge; completing blocker clears it; cycle rejected.
6. Record body: edit in UI, `edit_record_body` via MCP, `@[rec:]` mention + Linked panel "Mentioned in".
7. Drive link block renders iframe (desktop) / card (mobile); `kind:'link'` attachment never uploads.
8. Starter template installs; instantiated twice → independent copies with remapped relations.
9. Old board created before Phase 1 renders identically (screenshot diff against pre-phase baseline).
10. Two concurrent users add/remove same link → consistent final state.

Regression baseline (README §7) + `verify-mcp-multiuser.mjs` from Phase 0.

## 10. Rollout
- Migration `0005` remote before deploy.
- Dexie v4 upgrade is additive (no data rewrite).
- Update AGENTS.md: databases/views/links/relations/sub-records/embed sections; "Add a view type"; "Add a bundled template".

## 11. Acceptance criteria
- Any database can hold non-task records with their own fields, views and page bodies.
- Relations, sub-records, dependencies and related links work in the app and via MCP, are visible from both sides, and are merge-safe under concurrent edits.
- Table, list, gallery and board views with filter/sort/group work on desktop; mobile is usable.
- Drive links embed and never consume D1 storage.
- People & Organizations installable from the template gallery; nothing TCG-specific hardcoded.
- All prior behaviour and tests intact.
