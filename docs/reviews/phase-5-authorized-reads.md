# Phase 5 — authorized reads across the remaining server surfaces

Status: implementation continued on `phase5/per-space-feeds`; the historical certification sections below identify earlier tested source. Current behavior and final certification discipline are recorded in the [progress ledger](phase-5-progress.md#current-completion-candidate-2026-10-19). Permissions
remain **disabled** by default; every behavior below applies only while
`access_state.enabled = 1`, which was set only inside disposable test fixtures. This is
one Phase 5 checkpoint, not Phase 5 completion.

## Mechanism (one kernel, no second authorization system)

`worker/readAccess.ts` adds a request-scoped **read gate**. It reuses the existing
kernel unchanged — the ownership graph (`loadScopeGraph`), the pure scope resolver
(`shared/recordScope.ts`, inherited scope and *both* relation endpoints), and the
principal's current memberships (`loadAccessContext` → `effectiveSpaceRole`). It only
removes rows; it grants nothing.

- **Order:** content is read first and authority is decided after it, against the row's
  revision. A row survives only if, after its bytes were read, the principal could read
  every space its scope resolves through *and* the graph still shows the revision that
  was read. A revocation before the decision removes the row; a concurrent move or
  re-parenting changes the revision and removes it (fail closed). A row written earlier
  in the same request is re-decided at its new revision.
- **Deny ≡ missing:** callers see unauthorized and nonexistent ids identically.
- **Scope:** gates are built per request (`withReadGate`) and memoize decisions only for
  that request. `records.space_id` is used only as a SQL prefilter (whole-collection
  reads, MCP search); the graph decides every returned row.
- **Service reads** that never reach a caller use `serviceEnv(env)` explicitly
  (dependency-cycle detection must see every edge). Automations, form processing,
  reminders and the event pipeline keep their service authority unchanged.
- **Legacy:** with permissions disabled the gate keeps every row; all Phase 0–4 tests
  pass unchanged.

`worker/shareAccess.ts` is the public-capability authority (same graph + capability
SQL). `worker/historyAccess.ts` filters historical copies.

## Read-surface inventory

| Surface | Reads | Authorization while enabled |
|---|---|---|
| MCP read tools (`fetch`, `get_page`, `get_board`, `get_task`, `get_record`, `query_records`, `get_moodboard`, `list_comments`, `list_templates`, `recent_activity`, `workspace_overview`) | `records.ts` helpers (`getRec`, `getRecs`, `listBy`, `listCollection`, `listLinksByKind`, `listLinksTouching`, `listDefaultBoardTasks`), `pageClosure`, `tasksByBlockIds`, `loadTemplateSnapshot` | `createWorkspaceServer` builds the gated environment; every helper filters through it |
| MCP lookup caches (`fillCaches`: page/record titles for mentions and name→id) | targeted `loadTitleKeys` / `loadTitleIds` / `prefetchMarkdown` | gated; guest identity lookup is self-only; titles of unreadable records never enter caches |
| MCP `search` | shared FTS/dirty-queue service, seven content types | readable-space SQL and current graph gate, query/identity-bound cursors; own-document ranking |
| Backlinks (`get_page`) | raw `instr` scan of blocks | gate on the scanned rows |
| Mentions in bodies (`blocksToMarkdown`, `renderMentionText`) | gated caches | unreadable page → `[[page]]`, record → raw token, user names unchanged |
| Relations / related / dependencies (output) | `listLinksByKind`, `listLinksTouching` | gate: a link is readable only if both endpoints' spaces are |
| Dependency-cycle checks (`connect_items`, `add_dependency`) | `listLinksByKind('blocks')` | **service read** (integrity); only yes/no reaches the caller |
| Write-tool preflight conflicts (`write()`), `casUpdate` | `getRecs`, `getRec` | gated: a conflict on an unreadable row carries no `current` data |
| Delete/restore impact previews | `pageClosure`, `listBy`, backlink count | gated; the backlink **count** counts only readable mentions |
| Templates (`create_from_template`) | `loadTemplateSnapshot` | gated (user); automation action keeps service authority |
| Change sets (REST `GET /api/changes[/:id]`, MCP `list_changes`, `get_change`, `undo_change` preview) | `changesets`, `changeset_items` before/after | items of unreadable (or vanished) records withheld; summary → "Restricted change"; undo preview shows only readable patches; undo writes re-authorized in `applyChanges` |
| MCP idempotent replay (`mcp_requests.result`) | stored result | re-filtered: if any record it names is now unreadable, only `{replayed, restricted, changesetId}` |
| Notifications (`GET /api/notifications`) | stored title/body/items | shown only if the recipient can read the target now; otherwise a neutral "Restricted item" row (order kept) |
| Approvals (REST + MCP list/decide/request) | target title, notes | participant without read on the target: title "Restricted item", notes null; requesting an approval on an unreadable target ≡ missing target |
| Member form routes (`/api/forms`) | form config, tokens, database/relation targets | gated reads (unreadable ≡ missing); publish tokens listed/minted/revoked by editors only |
| Automations (`/api/automations/:id/runs|validate`) | run history, validation | require read on the automation |
| File delete (`DELETE /api/files/:id`) | metadata | unauthorized ≡ missing (enabled) |
| Share tokens (`/api/shares`, MCP `publish_page`, `share_moodboard`) | tokens, targets | listed/minted/revoked only by an **admin** of the root's space (design review §3); mint is fenced by the capability SQL in the same batch; token pinned to the root's space (`shares.space_id`, migration 0021) |
| Public page share (`/api/public/:token[...]`) | page tree, blocks, mentions, embedded databases, files | token serves only while its root still resolves to the pinned space; embedded databases and files outside it omitted; out-of-tree page mentions labelled "Restricted item" **in every mode** |
| Public canvas (`/api/public/canvas/:token[...]`) | items, card refs, files | same pin; cards naming records outside the space show no title/stage |
| Public forms (`/api/public/forms/:token`) | configured fields only | unchanged: the token capability exposes only the form's configured fields; submissions write as the `form` service principal with existing fences |
| Live presence (`/api/live`) | other users' routes | sockets authorized while enabled are marked scoped: their routes are never stored or shared and they receive no routes (pokes still flow); runtime-tested in `phase5-live-d1` |
| Sync feed, file bytes, file usage | — | already authorized (per-space feeds, `authorizeFile`, `readableFileUsage`) |
| Background: reminders, event→notification routing, automations, forms processing, retention | service | service authority for processing; `notify()` enforces current recipient/target access inside the delivery transaction, including caller checkpoints; reads remain separately gated |

## Confirmed defects and corrections

Each was reproduced by `tests/phase5-reads-d1.test.ts` against the unchanged `cedba69`
worker code (red log: `.artifacts/phase5-reads/red-baseline-cedba69.log`: 16 of the 19
tests that existed then fail; the 3 that pass check legacy behavior or the new gate module
alone; the binding-budget test was added afterwards). The public-title test also runs with
permissions disabled and reproduces that leak in legacy mode. All 20 pass after the
correction.

1. **Public share discloses titles outside its tree (all modes).** A mention of any page
   in a shared page's body was labelled with that page's title, even when the page was
   outside the shared tree (and, under spaces, in a private space). Now "Restricted item".
2. **Every MCP read was unfiltered** (search, fetch, overview, bodies, backlinks,
   relations, comments, closures, template snapshots, conflict `current` values,
   history): a member without access to a space read its content.
3. **Delete preview counted hidden mentions** (backlink count across private spaces).
4. **Idempotent replay** returned a stored result after the caller lost access.
5. **Notifications and approvals** showed titles, bodies and notes of records the
   recipient cannot read; requesting an approval distinguished unreadable from missing.
6. **Change history**: a workspace admin without membership read before/after values and
   summaries of private-space changes.
7. **Share tokens**: any member could list every token (a capability), mint a token for
   any id (distinguishing existing ids) and revoke any share.
8. **Public tokens were not pinned**: a token kept serving after its root moved space,
   and embedded databases / canvas cards / files of other spaces were served through it.
9. **Member form routes** returned config and publish tokens of unreadable forms and let
   any member revoke any token.

## Regression evidence

- `tests/phase5-reads-d1.test.ts` (actual disposable D1, multiuser: owner/space admin,
  member, workspace admin without membership, guest, explicit deny; readable/private
  spaces; revocation; relation endpoints; historical copies; public capabilities;
  revocation injected between content read and decision; stale revision; binding-call
  budget). It runs in the certification `unit` and `d1` stages (pattern
  `phase[45]-*-d1`).
- Cost evidence: `phase5-reads-cost.json` (written to the certification artifact
  directory): at 1,820 records, `search` 6, `workspace_overview` 17, `get_page` 24
  binding calls (budget 45).

## Certification (complete `npm run certify:phase4`)

- **Run 3 — PASS, 27/27 mandatory gates, exit 0** (2026-10-17 12:10:26Z–12:38:49Z).
  Tested commit `cedba69395dc6ba5fa0d1761b3fab14db5d30c50` **plus the uncommitted
  working-tree changes listed in the report**, source fingerprint
  `5a147d1b0ed2115ea63ddb1521236e858d946745ba35184bf60907008fa294f0`. Unit 1,063 PASS
  (includes the 20 new tests); D1 461 PASS (includes all 20 of `phase5-reads-d1`);
  MCP base/multiuser/phase1–4, smoke, v4/v6/v7/v8/v9 and the 33 Phase 5 sync journeys
  (Chromium/Firefox/WebKit) PASS; `npm audit` gate PASS. Artifact:
  `.artifacts/certification/cedba69395dc6ba5fa0d1761b3fab14db5d30c50-2026-10-17T12-10-26-208Z-complete/`.
- Run 1 — FAIL (`typecheck` only: the new test's router helper typing); fixed.
- Run 2 — FAIL (`security` only: `npm audit` could not reach the advisory endpoint,
  `ECONNRESET`; no code finding); rerun unchanged as run 3.
- This results section was written after run 3; it is the only change outside the tested
  fingerprint. The earlier `cedba69` PASS certifies the per-space sync checkpoint only, not
  this read work. Manual/physical-device gates remain NOT RUN.

## Follow-up: MCP read cost and live presence runtime (after `6d68268`)

**MCP read cost (previously the first blocker below; now resolved for the targeted reads).**
At `6d68268` the request-scoped title caches read whole collections (pages, records,
boards) and several tools read whole collections or whole link kinds, so every read was
gated row by row: the actual-D1 scale test exhausts the 45-call budget
(`D1BudgetExhausted` inside the gate; red log
`.artifacts/phase5-reads/red-scale-6d68268.log`). Corrections, all through the same gate:

- `fillCaches` now loads only the (seat-capped) people directory. Page and record titles
  are loaded on demand for exactly the keys a call needs: `loadTitleKeys` (one batched
  query for `[[Title]]` keys: live pages, and live records outside deleted databases; a
  readable-space prefilter; SQLite's ASCII `lower()` is matched with a GLOB pattern and the
  exact Unicode comparison is done in JS; the gate on the matches only) and `loadTitleIds`
  (titles of the ids named by `@[page:]`/`@[rec:]` tokens). Before parsing markdown, a
  first pass with recording resolvers collects its keys (`prefetchMarkdown`); parsing
  stays pure and synchronous. Page-first resolution, ambiguity warnings and explicit
  `rec:` ids behave as before; a page the caller cannot read is simply not a candidate, so
  `[[Name]]` resolves to a readable record of that name instead of revealing the page.
- Backlinks are scanned newest first in windows of 100 (at most 500 rows) and gated per
  window until 20 readable hits; `get_record` reads parent/children by index and links
  touching the record; `query_records` reads relation/dependency links for its database's
  rows only; `fetch` of a board counts columns in SQL (a board's tasks inherit its scope);
  templates, `list_templates`, root-page lookups, bundled-template markers, mood items and
  recent activity use targeted reads; template copies read only the last 20 siblings by
  order; `workspace_overview` counts mood items in SQL for readable boards.
- `tests/phase5-reads-scale-d1.test.ts` (permissions enabled, two workspace sizes: 600 and
  4,800 records per bulk collection plus links, items and activity) asserts every probe
  stays below 40 binding calls and that targeted reads cost the same at both sizes.
  Measured (`phase5-reads-scale.json`, 600 → 4,800): `get_page` 22 → 22, `fetch` page
  15 → 15, `get_record` 21 → 21, board `fetch` 5 → 5, `list_templates` 4 → 4,
  `recent_activity` 5 → 5, mention-resolving `create_page` 21 → 21,
  `create_from_template` 13 → 13; `search` 4 → 5, `query_records` 14 → 20 (one database's
  rows), `workspace_overview` 13 → 19 (it lists every readable page; whole-collection reads
  stay capped at 5,000 rows).

**Live presence runtime coverage.** `tests/phase5-live-d1.test.ts` bundles the real
`worker/index.ts` with esbuild and runs it with the real `LiveRoom` Durable Object and D1
in Miniflare: legacy presence unchanged while disabled; while enabled a scoped socket
neither records/shares nor receives routes, while who-is-online still flows; a socket
opened before activation never sees a scoped user's route and scoped users never see its
route; unauthenticated and revoked sessions cannot connect. Red evidence against `cedba69`
(before scoping): 2 of 4 fail (`.artifacts/phase5-reads/red-live-cedba69.log`).

**Certification of this follow-up (run 4) — PASS, 27/27 mandatory gates, exit 0**
(2026-10-17 13:58:19Z–14:28:58Z). Tested commit `6d68268ec5e0ac5df3b9bc7e5660575d874c5a9f`
plus the uncommitted follow-up changes (`worker/mcp.ts`, `worker/records.ts`,
`worker/templateSnapshot.ts`, the two new tests, `AGENTS.md`, this review), source
fingerprint `a848435aa9d8a9a3947c3462a27cf41354532c56581dcc61c17f2428e5d5af2e`. Unit 1,068
PASS; D1 466 PASS (including `phase5-reads-d1` 20/20, `phase5-reads-scale-d1` 1/1,
`phase5-live-d1` 4/4); all MCP, smoke, v4/v6/v7/v8/v9 and the 33 Phase 5 sync journeys
PASS. Artifact:
`.artifacts/certification/6d68268ec5e0ac5df3b9bc7e5660575d874c5a9f-2026-10-17T13-58-19-826Z-complete/`.
This paragraph was written after run 4 and is outside its fingerprint. Earlier runs 1–3
remain as recorded above.

## Follow-up 2: permission-aware search index and bounded listings (after `ad58053`)

Implements the search pipeline of [phase-5-implementation.md §9](../architecture/phase-5-implementation.md)
and design review §6, and removes the remaining broad-read blockers.

**Index (migration 0022, server-only tables, never collections).** `search_documents`
(authoritative: one document per page, record, database and mood board; page/record bodies
aggregate live block text, ≤ 8,000 characters, mention tokens stripped; record descriptions
included), `search_fts` (FTS5, `unicode61 remove_diacritics 2`, rowid-aligned with
`search_documents`, reconstructible and never part of a backup workflow) and `search_dirty`
(one key per document). Triggers on `records` mark a document dirty in the same statement as
any write of its row or one of its blocks, including a block moving between pages, explicit
space moves, soft deletes and restores, from every write path. Migration 0022 marks every
existing document dirty.

**Processor (`worker/search.ts`).** `processSearchDirty` rebuilds ≤ 50 dirty documents
from current records with one read batch and one write batch. It removes a dirty key only if
its token (the newest `seq`) is unchanged, so a write during the rebuild keeps the key. It
runs after each outbox event (best effort) and as a cron phase (`processSearchBacklog`).
`POST /api/admin/reindex-search?after=` re-enqueues documents in keyset pages to rebuild a
lost or corrupted index.

**Query (`searchRecords`, shared by MCP `search` and the new `GET /api/search`).**
- Input tokens are letters and digits only, ANDed, and prefix-matched from 2 characters. No
  MATCH syntax or SQL is accepted.
- Readable spaces are filtered in SQL, then the request's read gate checks every candidate.
- Rank uses only the document's own content: a title hit sorts before a body-only hit, then
  newer revisions first. There is no bm25, so hidden documents cannot reorder visible ones
  (tested).
- The ordering is total and the opaque cursor is the last scanned position, bound to the
  query, so pages stay complete and stable when the gate drops candidates.
- Snippets come only from indexed documents that are already authorized.
- Dirty documents are matched on their current content, never served from the index. A dirty
  backlog of more than 200 documents in readable spaces returns `indexPending: true`.
- No totals, raw ranks or timings are returned.

MCP `search` keeps its result shape (`id: "page:<id>"`, title, url, rev, where rev is the
record's own revision). It adds `type`, `databaseId`, `cursor` and `limit` (≤ 50) inputs and
`hasMore`, `nextCursor` and `indexPending` outputs. Matching changed from case-insensitive
substring to word-prefix.

**Listings.**
- `workspace_overview` returns at most `limit` (default 200, max 500) pages, boards and mood
  boards per list. Pages and boards are in tree order (order key, then id), and views are
  returned for the listed boards. Each list has its own `…NextCursor`; calling with
  `section` and `cursor` continues that list. Mood-item counts are SQL aggregates.
- `query_records` without sorts pages any database size in id order. Filters are applied
  window by window after the gate; the cursor is the last scanned id (a previous plain-id
  cursor still means "after this record"), and `hasMore` is explicit.
- `query_records` with sorts accepts databases of up to 5,000 records. A larger database
  gets an explicit error rather than a truncated result.
- `scanCollection` (`worker/records.ts`) is the shared gated keyset scanner.

**Evidence.**
- `tests/phase5-search-d1.test.ts` (9 tests, actual D1) covers:
  - corpora of 1,500 readable and 900 private pages paged completely, with no duplicates,
    nothing private and a stable order;
  - filters by type and database, duplicate titles, body-only matches and snippets;
  - ranking that does not change when 400 hidden matching documents are added;
  - forged and foreign cursors, and query syntax treated as literals;
  - edits of the title and body, soft delete, restore and a space move, each checked before
    and after indexing;
  - an interrupted rebuild that keeps its dirty keys, a reported backlog of more than 200,
    and a full rebuild after losing both index tables;
  - grant, revocation, and a revocation landing between the FTS candidate query and the gate;
  - overview paging of 1,300 readable pages in tree order, with 700 private pages excluded;
  - `query_records` paging a 5,200-record database completely under a filter, the explicit
    sort bound, and revocation mid-pagination;
  - measured cost.
- Measured on 3,000 pages, 3,000 blocks and 3,000 records, two-thirds readable
  (`phase5-search-cost.json`):

  | Operation | Binding calls | Rows read | Rows written |
  |---|---:|---:|---:|
  | Search (title / body / rare term) | 6 | 6,736 / 14,331 / 6,044 | 0 |
  | Overview, first page | 10 | 7,443 | 0 |
  | Overview, 500-page continuation | 4 | 8,015 | 0 |
  | `query_records`, 200 rows | 9 | 9,630 | 0 |
  | Index rebuild, 50 documents | 3 | 6,457 | 250 |
  | Ordinary page edit, including the dirty-key upsert | 4 | 31 | 14 |

  Search rows read scale with the number of documents matching the query terms in any space
  (FTS doclists), not with binding calls.

**Certification of follow-up 2 (run 5) — PASS, 27/27 mandatory gates, exit 0**
(2026-10-18 06:37:41Z–07:11:23Z). Tested commit `ad58053a5b01196207c0f56916d2beb137e64671`
plus the uncommitted follow-up-2 changes, source fingerprint
`700ac97a308ab99446520c51c821359a28a1025da68fcbf90ca25e4ccc7e4436`. Unit 1,077 PASS;
D1 475 PASS (including `phase5-search-d1` 9/9); every MCP, smoke, v4/v6/v7/v8/v9 and the
33 Phase 5 sync journeys PASS; migrations gate 22/22. Artifact:
`.artifacts/certification/ad58053a5b01196207c0f56916d2beb137e64671-2026-10-18T06-37-41-351Z-complete/`.
This paragraph was written after run 5 and is outside its fingerprint.

## Current continuation status and activation boundaries

Search now covers comments, file names/link metadata and mood text; the palette uses
server search plus the authorized local cache. Notifications check delivery and current
read authority, hide inaccessible badges and retain neutral historical rows. Guest
identity listings are self-only. People-containing spaces are guest-restricted in the
canonical kernel. Invitations, memberships, space settings/switching/moves, sessions,
contextual history/field restore, archive browsing and usage/cache controls are implemented.
See [the current runtime contract](../architecture/phase-5-implementation.md#current-runtime-contract-2026-10-19).

Measured limits remain explicit: global FTS doclists scale with matches; sorted
`query_records` errors above 5,000 records. Retention/purge and quarantine export are
not silently enabled. Broader directory sharing requires reviewed policy; it has no
implicit guest exception. Share minting stays space-admin-only; existing embedding,
approval and CSP behavior are preserved, not newly approved policies.

Production permissions remain **OFF**. Independent review, activation approval and the
external device/accessibility/security release checklist remain gates. Final automation
must certify the clean committed source, not any historical run described above.
