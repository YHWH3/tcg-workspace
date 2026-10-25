# Phase 9 — Everyday conveniences

Branch `sol/p9-everyday` stacked on `sol/p8-desks`. Items 9.1–9.5 do not
depend on Phase 8, so they may be built first if the owner prefers; keep the
stack order to avoid migration-number collisions.

**Implementation order:** 9.0 → 9.1 → 9.5 → 9.2 → 9.3 → 9.4 → 9.6 → 9.7.

---

## 9.0 Engine helper `mutateMany` (prerequisite for 9.2, 9.4, 9.5 and 8.3 bulk)

- In `src/core/sync/engine.ts`, add
  `mutateMany(collection, items: {id, patch}[])`. It runs ONE Dexie transaction
  covering records, outbox and field timestamps, then triggers one push.
- Reuse `mutate()` internals; `mutate()` semantics are unchanged (it may call
  `mutateMany` with one item).
- Cap 500 items per call; callers chunk larger work.
- **Tests:**
  - Unit with fake-indexeddb: atomicity (a failure mid-batch writes nothing),
    field timestamps per field, outbox entries, and identical results to N
    `mutate()` calls.
  - Push chunking still holds at 500 (`PUSH_CHUNK`, `engine.ts:35`).

---

## 9.1 CSV export

**Goal:** hand a table to partners in Excel or Google Sheets.

- Pure serializer `shared/csv.ts`: `toCsv(rows: string[][]): string`, RFC 4180
  quoting, CRLF line endings, UTF-8 with a BOM (for Excel).
- **Formula-injection guard:** prefix a cell that starts with `=`, `+`, `-`,
  `@`, tab or CR with `'`.
- `exportView(board, viewConfig, records, ctx)` in `src/core/records.ts`:
  - applies the view (`applyView`), so the exported rows equal the visible rows;
  - uses the view's visible columns in order, plus an `id` column (optional,
    default on);
  - **Values:** text as is; numbers raw (no grouping separators); currency
    fields get an extra `<Field> currency` column with the ISO code (7.2);
    dates `yyyy-mm-dd`; select = option name; multi-select = names joined by
    `; `; person = display name; relation = titles joined by `; `;
    checkbox = `TRUE`/`FALSE`.
- **UI:**
  - The database view menu gets "Export CSV…".
  - A dialog shows the row and column counts and the note "Exports the records
    synced to this device that you can see".
  - Download via `Blob` + `a.download` (reuse the `shell.tsx:241` pattern).
  - Filename `<database>-<view>-<yyyy-mm-dd>.csv`.
  - **Mobile:** use the Web Share API with a file when available, otherwise
    download.
- **Website inbox:** the same export, but answers come from typed fields only.
  It excludes `wi_token` and payment ids unless the admin ticks "Include
  payment references" (privacy).
- **No server endpoint and no MCP tool** (MCP already has `query_records`).
- **Tests:**
  - Unit: quoting, injection guard, every field type, BOM.
  - Browser: export on three engines and open the file (parse back).

---

## 9.2 CSV import

**Goal:** bring rosters, budgets and lists in safely, with a preview and an undo.

- **Parser** `shared/csv.ts` `parseCsv(text, {delimiter?})`:
  - detects `,` `;` or tab;
  - handles quotes and newlines in quotes;
  - strips the BOM;
  - limits 5 MB and 5,000 rows, with clear errors.
  - No new dependency.
- **Wizard** (`src/core/views/ImportCsv.tsx`, opened from the database view menu
  "Import CSV…"):
  1. **File.** Pick a file; show the delimiter guess and the first 20 rows.
  2. **Map.** Each column maps to an existing field, "Create new field (type)",
     the title, or Skip. Auto-match by header name, case- and space-insensitive.
  3. **Options.**
     - **Date format:** an explicit choice of `yyyy-mm-dd`, `dd/mm/yyyy` or
       `mm/dd/yyyy`, defaulting to `dd/mm/yyyy` when the workspace timezone is
       Asia/* (7.2). Never guess silently; ambiguous values (e.g. 03/04/2026)
       follow the chosen format, and invalid ones are errors.
     - Select options: add unknown options automatically, or treat them as
       errors.
     - Person: match by display name or username, else an error.
     - Relation: match by target title in the relation's database; an exact
       single match is required, else an error listing the candidates.
     - **Update existing:** pick a key column (title or a text field). Matching
       rows are updated with only the mapped fields; others are created.
       Duplicate keys in the file are an error.
  4. **Preview.** Counts of create, update, skip and error; a table of errors
     with row number and reason; downloadable `errors.csv`.
  5. **Import.** Writes via `mutateMany` (9.0) in chunks of 200, with a
     progress bar.
- **Coercion:** `coerceFieldValue` from `shared/fields.ts`, the same as MCP
  writes.
- **Undo journal.**
  - Before writing, store in Dexie `meta` under `import:<id>`: the created ids
    and the previous values of every updated field.
  - "Undo import" (a toast for 60 s, plus Settings → Local data → Recent
    imports) soft-deletes the created records and restores the previous values
    via `mutateMany`.
  - Journals older than 7 days are pruned.
- **Server behaviour:** writes arrive through the normal push (chunked at 500,
  `src/core/sync/engine.ts:35`). Item-wise rejections (approval gates,
  permissions, size) surface in the existing rejected-items UI. After sync, the
  import summary shows how many the server accepted.
- **Large imports by AI** stay on MCP `create_records` / `update_records`, which
  are already preview-gated above 25 writes.
- **Tests:**
  - Unit: parser edge cases (quotes, CRLF in cells, BOM, semicolons), date
    formats, matching rules, journal correctness.
  - D1: an import of 1,000 rows pushes within the binding budget per push
    request.
  - Browser: the full wizard by keyboard and touch on three engines, undo
    included.

---

## 9.3 Page export (Markdown and PDF)

- **Markdown:**
  - "Export → Markdown" on the page menu uses `blocksToMarkdown` from
    `shared/markdown.ts`.
  - Mentions render as names (`resolveMentions`).
  - Embedded databases (`tasks` / `view` blocks) render as a Markdown table of
    the view rows (cap 200, with "…N more").
  - Files and images render as `![caption](<filename>)` with a footnote listing
    attachments.
  - An option "Include sub-pages" exports one file per page, joined into a
    single `.md` with heading separators. No zip in v1.
- **PDF:**
  - "Print / Save as PDF" calls `window.print()`.
  - Add a print stylesheet (`@media print` in the global CSS): hide shell,
    sidebar, toolbars and comment badges; expand toggles; avoid breaks inside
    blocks; show link URLs after link text; apply a light theme regardless of
    dark mode.
  - The public share page (`src/public/PublicView.tsx`) gets the same print
    styles.
- **Records:** the record page gets the same export. Its properties become a
  table at the top.
- **Tests:** unit Markdown snapshots for every block type; a browser print
  emulation (`page.emulateMedia({media:'print'})`) screenshot on three engines.

---

## 9.4 Resolved comments (N12, security-sensitive)

**Current rule** (`worker/mutationAccess.ts:162-183`):
- an update must come from the author or a space admin (`canEditComment`);
- an update may touch only `body` and `deleted`.

So a resolve flag requires an authorizer change.

### Design

- **Additive comment fields:** `resolvedAt: number|null` and
  `resolvedBy: string|null`.
- **Authorizer change** (one place, `mutationAccess.ts`). For an update that
  touches ONLY `resolvedAt` and/or `resolvedBy`:
  - the required capability is `canComment` on the comment's target, not
    `canEditComment`;
  - the patch must set `resolvedBy === userId` with `resolvedAt` a number
    (resolve), or both null (reopen);
  - any other field in the same patch falls back to the existing rule.
  - Add `resolvedAt` / `resolvedBy` to the allowed update fields only under this
    branch.
- **Server timestamp:** clamp `resolvedAt` with the existing timestamp bounds
  (`shared/clock.ts`).
- **Thread semantics:** comments are flat per target (`targetType`,
  `targetId`).
  - "Resolve thread" marks all currently unresolved comments on that target in
    one `mutateMany`.
  - A new comment after that is unresolved and reopens the thread visually.
  - The badge (`useCommentCount`, `src/modules/comments/index.tsx:30`) counts
    only unresolved comments.
  - A "Show resolved (N)" toggle sits in the thread.
- **Activity:** log a `resolved` verb with matching `verbText` in
  `src/modules/activity/index.tsx`. Notify the thread's participants: a new
  `NotifKind` `comment_resolved`, default `'inbox'`, which can be turned off in
  prefs.
- **MCP:** leave `add_comment` unchanged. Add write tool `resolve_comments`
  `{targetId, reopen?: boolean}` via `reg()`, classified
  `W('resolve_comments','comments')`. It is not significant.
- **Tests:**
  - D1 in `tests/phase9-comments-d1.test.ts`, with permissions enabled and
    disabled, for each role (owner, admin, editor, commenter, viewer, guest):
    - a commenter can resolve another's comment;
    - a viewer cannot;
    - resolve plus body change by a non-author is rejected (`protected_field`);
    - `resolvedBy` spoofing is rejected;
    - reopen works.
  - Extend the Phase 5 capability matrix test.
  - Browser on three engines.

---

## 9.5 Bulk edit

- **Writes** use `mutateMany` (9.0).
- **Selection** in table and list views:
  - a checkbox column, shift-click range and select-all-filtered (with a count
    and a cap of 500);
  - keyboard: Space toggles the row, Shift+Arrow extends;
  - touch: long-press enters selection mode.
- **Action bar:** Set stage, Set field (any non-relation field, using the same
  editors as cells), Assign, Set due date, Archive, Delete (soft) and Clear
  selection.
- **Gates:** a stage change into an approval-gated stage is not applied
  client-side for gated rows. The action reports "N need approval" and offers
  "Request approval" through the existing approval flow.
- **Undo:** a client journal like 9.2 (`bulk:<id>` in `meta`) with the previous
  values. An "Undo" toast for 60 s plus "Recent bulk edits" under Settings →
  Local data. Undo writes the previous values through `mutateMany`.
  Server-side `record_history` also keeps every change (restore remains
  available per record).
- **Website desk** (8.3) and the attention queue reuse the selection and action
  bar.
- **Tests:**
  - Unit: journal and inverse.
  - Browser: select 50 rows, set stage, undo; keyboard-only; touch long-press on
    the Android emulator.
  - D1: a 500-record push stays within budget (exists; assert again).

---

## 9.6 Search date and scope filters

**Current:** the API already accepts `type`, `space`, `database` and `mode`
(`worker/searchApi.ts:21-25`). Only dates are new.

- **Migration:** `ALTER TABLE search_documents ADD COLUMN updated_at INTEGER;`
  plus `CREATE INDEX idx_search_documents_updated ON search_documents(updated_at);`.
  - The search processor (`worker/search.ts`, `processSearchBacklog`) writes
    `updated_at` from `records.updated_at` when rebuilding a document.
  - Existing documents get it through the admin `reindex-search` endpoint
    (`worker/admin.ts:166`), documented as a release step.
  - Until reindexed, a NULL `updated_at` doc does not match date-filtered
    queries, and the response carries `indexPending:true`. **Verify** that the
    existing flag name matches.
- **API:** `updatedFrom` and `updatedTo` (yyyy-mm-dd, relative values allowed,
  resolved with the workspace today) and `createdFrom` / `createdTo` if
  `records.created_at` exists (verify; otherwise updated only).
- **Local (device) search:** the same filters over Dexie rows.
- **UI:** ⌘K palette filter chips: Type, Space, Database, Updated (Any, 7 days,
  30 days, Custom). The chips are keyboard reachable, and the current filter is
  announced.
- **MCP:** `search` accepts the same parameters. Update its schema and the
  server instructions.
- **Tests:** D1 search with dates under the read gate; keyset cursor with
  filters; browser palette on three engines.

---

## 9.7 Share links: expiry, rotation, visibility

- **Migration:** `ALTER TABLE shares ADD COLUMN expires_at INTEGER;` and
  `ALTER TABLE shares ADD COLUMN rotated_at INTEGER;`.
- **Enforcement in exactly one place:** `activeShare` (`worker/public.ts:42`).
  All five public routes already call it (lines 135, 145, 241, 312, 357).
  - Add `AND (expires_at IS NULL OR expires_at > ?)` to `shareFor`.
  - An expired link is indistinguishable from an unknown one (404, same body).
- **API** (`worker/shares.ts`):
  - `POST /api/shares` accepts `expiresInDays ∈ {null, 7, 30, 90}` (owner
    decision D10).
  - `POST /api/shares/:pageId/rotate` issues a new token in place (the
    `page_id` uniqueness stays), sets `rotated_at`, and makes the old token 404
    immediately.
  - The authority check is the existing `shareAuthority`.
- **UI:** the Share popover (`src/modules/pages/Share.tsx`) and the moodboard
  share get an expiry select, an "Expires on <date>" note, a "Replace link"
  button with a confirmation, and Copy. Settings shows a list of my active
  shares with their expiry.
- **MCP:** `publish_page` and `share_moodboard` (human-only H tools) accept
  `expiresInDays`.
- **Passwords:** out of scope here (Phase 13.4).
- **Tests:**
  - D1: expiry boundary, rotation, all five public routes refuse an expired or
    rotated token, and the space-pin rule is still enforced.
  - Browser: popover flows on three engines.
