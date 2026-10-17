# Phase 5 — authorized reads across the remaining server surfaces

Status: implemented on `phase5/per-space-feeds` on top of `cedba69` (not committed at
the time of writing; see "Certification" for the exact tested source). Permissions
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
| MCP lookup caches (`fillCaches`: page/record titles for mentions and name→id) | `listCollection` | gated + readable-space SQL prefilter; titles of unreadable pages/records never enter the caches |
| MCP `search` | raw scan of five collections | readable-space prefilter, then the gate on every matching row (including body-only page matches) |
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
| Live presence (`/api/live`) | other users' routes | sockets authorized while enabled are marked scoped: their routes are never stored or shared and they receive no routes (pokes still flow) |
| Sync feed, file bytes, file usage | — | already authorized (per-space feeds, `authorizeFile`, `readableFileUsage`) |
| Background: reminders, event→notification routing, automations, forms processing, retention | service | unchanged service authority; their record-derived *output* is user-visible only through the filtered notification/approval/history reads above. `readersOf()` is available for delivery-time recipient checks |

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

## Remaining activation blockers (not done here)

- **Read cost at scale.** Gate decisions cost one graph call per 500 rows; MCP lookup
  caches read whole collections (≤ 5,000 rows each). Workspaces beyond a few thousand
  readable pages+records per collection can exhaust the 45-call budget on MCP reads while
  enabled. Needs a scoped title index or cached manifest before activation.
- **People directory** (`/api/users`, MCP user lookup) still lists every workspace user to
  guests — an owner policy decision.
- **Delivery-time filtering and purge** of notifications for non-readers (read-time
  redaction is in place; stored copies remain server-side until retention).
- **Server search/index pipeline**, guest/space UI, history/restore UI and space-aware
  `deletedVia` restore (design review §8.3) are not part of this change.
- **Live presence** scoping is covered by code review only (Durable Object runtime not in
  the unit fixture).
- Owner decisions remain pending: share minting by space admins only (implemented per the
  design review; confirm), embedding, approval separation of duties, CSP rollout, guest
  quotas, export/quarantine retention, activation procedure.
