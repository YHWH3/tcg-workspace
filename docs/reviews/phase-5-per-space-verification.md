# Phase 5 per-space reconciliation — implementation and evidence

Status: protocol-3 client/server integration implemented; **Phase 5 remains PARTIAL**.
Permissions remain disabled by default. No merge, deployment, production migration,
Phase 6 work or real-user permission activation is included in this round.

## Scope and preservation

The takeover started on `phase5/per-space-feeds` at `b4d9b8c`, with nine uncommitted
files from the paused implementation session. The reviewed server changes were
preserved in `8f4ba99` (migration 0019 and its regression tests). The two draft
client helpers were completed and integrated rather than discarded. The certified
`4d8e15a` foundation and every preceding commit remain in history.

The normative contract is [phase-5-per-space-feeds.md](../architecture/phase-5-per-space-feeds.md).
Migrations 0012–0019 retain their registered hashes; migration 0020 is additive.
It corrects overlapping eviction triggers under the actual record UPSERT.

## Implemented integration

- `feedState.ts` persists a versioned, account-bound manifest and feed state.
  Cursors, in-progress scans and cache changes commit together. Stale sibling-tab
  responses fail a version comparison rather than rolling access backward.
- `accessCache.ts` installs manifest diffs, evicts removed home/peer audiences from
  both live and staged rows, quarantines unauthorized outbox/drafts/upload bytes,
  and stages incoming pages without publishing partial spaces. Completed joins
  activate as one atomic group. A legacy cache stays gated until its atomic upgrade.
- `pendingWork.ts` retains permitted offline creations and dependent children,
  rebases allowed edits and protects commenter ownership rules. Refused work stays
  in non-rendered quarantine with metadata-only review. Export policy stays pending.
- `feedPull.ts` handles inline manifest changes, retained-event floors, database
  restore, page retries and crashes using committed progress. It uses at most 20
  active joining scans and explicitly names deferred joins; ordinary backfill creates
  no D1 snapshot rows. Completed scans continue receiving updates while others finish.
- `reconcileAccess.ts`, the sync engine and media guards speak the shared protocol-3
  constant. Protocol 1 remains available while activation is off. Protocol downgrade
  after scoped activation is refused. Metadata pushes require complete dispositions
  and an access etag; an access change stops further chunks until reauthorization.
- Ordinary unchanged polling does not unmount editors or broadcast access changes.
  Known access changes, eviction/recovery and errors retain the presentation barrier.
  The final manifest is checked before reopening it.

## Confirmed corrections during integration

| ID | Reproduction | Correction and proof |
|---|---|---|
| FD-22 | A relation gained/changed its peer and remained in an old home reader's cache. | Preserved migration 0019; reference-client property tests now require explicit facts, with no dangling-link sweep masking omissions. |
| FD-23 | The real `applyChanges` UPSERT retargeted a relation and invoked overlapping triggers. `OR IGNORE` did not prevent `UNIQUE constraint failed: space_events.space_id, space_events.seq`. | Migration 0020 uses explicit existence predicates. `phase5-moves-d1` reinstalls the old triggers in disposable D1, proves rollback/failure, applies 0020 and proves successful retry and exact facts. The real client/HTTP/D1 test also covers the corrected path. |
| FD-24 | More than 20 joining spaces with retained histories repeatedly returned `rebackfill_required`. | Deferred incomplete joins are excluded from settled scans/floor checks until scanned. Actual client/D1 red evidence: `.artifacts/phase5/deferred-joins-red.json`; matching green coverage plus invalid/unknown deferred-ID tests. |
| FD-25 | A scan base from a pre-restore database exceeded current high water while its page cursor did not; server returned 200. | Treat the scan base as another restore boundary; return `cursor_ahead` and discard/rebuild the affected staging group. Red: `scan-base-restore-red.json`; same actual-D1 assertion retained. |
| FD-26 | An exhausted response claimed a shared cursor below high water and was accepted. | Reject before mutation unless an exhausted page reaches high water. Red: `feed-completeness-red.json`; the same cache assertion is mandatory. |

The FD-23 behavior agrees with SQLite's documented [outer-statement trigger conflict policy](https://www.sqlite.org/lang_createtrigger.html).
All red/green fixtures are local and disposable; no real user's records were modified.

## Executed checkpoints and final acceptance

Checkpoint artifacts are under `.artifacts/phase5/` (ignored, not committed):

- `takeover-server.json`: six actual-D1 suites, **125 PASS** before client integration.
- `client-final-green.json`: seven client/server/resource suites, **98 PASS**.
- `browser-v3-first/results.json`: **33 PASS**, 11 journeys per engine, Chromium
  153.0.8010.12 / Firefox 155.0 / WebKit 26.6, with real built Worker, migrations,
  IndexedDB, main/thumbnail bytes, offline restart, multi-tab revocation, account
  replacement, sessions, cross-space relation eviction/regrant and interrupted backfill.
  This was an intermediate dirty-source run; it is not a final-commit certificate.
- The intermediate full unit run recorded **1,038 PASS / 1 FAIL**. Its sole failure
  was the >20 retained-space restart case loaded before FD-24 was corrected. The
  original failing evidence remains in `unit-after-client.json`; later green targeted
  evidence does not relabel that run.
- `node --test scripts/certification/core.test.mjs`: **33 PASS**. Standalone TypeScript
  and production build passed; existing bundle-size and mixed dynamic-import warnings
  remain visible.

The final committed-source acceptance result is generated by `npm run certify:phase4`
in `.artifacts/certification/<SHA>-<timestamp>-complete/`. Its `summary.json`,
`commands.json`, `test-results.json`, raw audit, browser versions and performance
metrics are authoritative for that run's exact SHA/fingerprint. Earlier counts above
must not certify a later source. Complete mode now requires **27 gates**, including
`phase5-sync`; every new actual-D1 regression runs in unit and dedicated D1 stages.

## Local resource evidence

The first completed-source run at `37362f9` recorded **25/27 gates PASS**, with
1,043 unit tests, 441 dedicated D1 tests and all browser suites passing. Its two
failed gates remain in the artifact: npm audit reset its connection, and base MCP
failed during project creation with a remote image. Both passed isolated reruns
using IPv4-first Node DNS resolution (audit: zero vulnerabilities; base MCP: 94
checks). The certification harness now records that preference and propagates it
to its owned Node children, including npm and the Miniflare network bridge. It
preserves TLS verification, IPv6 fallback and existing Node options. A child-process
regression was red before the helper existed and green afterward. No application
assertion or production network configuration was changed. The subsequent complete
run on the committed correction remains required; isolated reruns do not certify it.

The next complete run at `22176fd` passed audit and project creation but base MCP
lost a loopback HTTP connection after 92 successful checks, before its last two
session-expiry assertions. The incomplete result remains FAIL and the run was
stopped before spending time on later browser gates. Base MCP now retries one
GET/HEAD transport exception; POSTs and HTTP error responses are never retried.
Repeated failure remains blocking and reports the method, path and safe transport
cause code without URL query values. Four red/green harness regressions cover the
real 401 response, write/error non-retry, repeated failure and local-only targets.
All OAuth/session assertions are unchanged. The final complete rerun is required.

The `a19fdee` run's diagnostic exposed another `ECONNRESET` on the POST security
probe immediately after a synchronous Wrangler D1 command. The final fixture
adapter now requests `Connection: close` so these probes never reuse an idle
socket, and all six verifier CLI calls yield the Node event loop through async
`execFile`. POST retries remain prohibited. The fresh-connection regression was
red before this correction. The failed run remains preserved, including all
unexecuted mandatory assertions; it is not classified as a successful suite.
Two consecutive fresh base-MCP fixtures then passed all 94 checks under the
certification `runCommand` supervisor (not the standalone fixture launcher).
These targeted dirty-source runs do not replace final committed certification.

`phase5-cost-d1.test.ts` exercises 500- and 1,000-record fixtures, counting all
observed result metadata, individual statements and batched statements. The measured
operations exclude fixture setup. Feed numbers are for `pullFeed`; they do not include
HTTP authentication/session bookkeeping. Index writes are included in D1 metadata.

Initial 1,000-record local measurement (not production billing or latency):

| Operation | Binding calls | SQL statements | Rows read | Rows written | Duration |
|---|---:|---:|---:|---:|---:|
| Another user's logout, through auth route | 2 | 2 | 3 | 1 | 6.63 ms |
| First 500-row backfill page | 4 | 13 | 6,045 | 0 | 44.11 ms |
| Second backfill page | 4 | 13 | 6,042 | 0 | 36.28 ms |
| Ordinary soft delete | 4 | 9 | 31 | 12 | 20.64 ms |

The same tests assert bounded logout/delete work at both sizes, stable unrelated-user
manifest etags, no generation changes and absence of materialized snapshot tables.
Final certification writes fresh `performance/phase5-feed-cost-{500,1000}.json` with
the tested SHA; use those files for final-run measurements.

## Test migration and remaining work

The protocol-2 snapshot API/cache tests were replaced because the API and server-side
snapshot tables were retired. Their obligations remain: account binding, stale-tab
rejection, durable staging/resume, atomic rollback, malformed/incomplete evidence
rejection, no unauthorized publication, offline creation/rebase, commenter rules,
role downgrade, quarantine, thumbnail ownership and cache invalidation. The v7→v8
IndexedDB migration regression is preserved.

This round does not complete read enforcement for MCP/public/background/history
surfaces (since addressed in [phase-5-authorized-reads.md](phase-5-authorized-reads.md)), the search/index pipeline, guest invitation and space-management UI, or
history/restore. These remain blockers to real permission activation and Phase 5
acceptance. Scoped live presence also remains pending; permission-aware clients keep
presence disabled. No security claim follows from merely including a dependency.

Physical iPhone/iPad Safari, physical Android, manual assistive technology and native
400% zoom remain **NOT RUN**. Emulated WebKit and automated reflow do not replace them.
Owner decisions on embedding, approval separation of duties, CSP rollout, guest quotas,
export/quarantine retention and activation remain pending. Production release is HOLD.

## Integrated continuation (2026-10-19)

Protocol 3 is retained unchanged as the reconciliation foundation. Search, notification
delivery/privacy, guest management, directory restrictions, field history/restore and
usage/cache controls are integrated through the same kernel and version fences. See
[progress ledger](phase-5-progress.md#current-completion-candidate-2026-10-19). The new
`phase5-workflows` gate runs ordinary browser tabs against disposable built Workers in
Chromium/Firefox/WebKit with permissions ENABLED. Existing `phase5-sync` restart,
quarantine, multiuser/session and account-switch journeys remain mandatory. The full
command requires a clean committed source and preserves all historical regression gates.
Final counts/SHA/fingerprints are generated by certification, not inferred from earlier
dirty runs. No push, merge, deployment, permission activation or Phase 6 work is authorized.
