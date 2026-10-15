# Phase 5 implementation ledger

Status: **PARTIAL — implementation and certification in progress**.
Baseline: `977475f0cac54bf05f0e5e513785c4933e0e9d73`.
Branch: `grok/phase-5-search-permissions` in the original Desktop checkout.
No merge, deployment or production resource changes.

## Completed design and foundation work

- P5-0 design/threat-model review committed as `b6db4a8`. See
  [implementation contract](../architecture/phase-5-implementation.md). This is
  a technical source review, not independent acceptance or production clearance.
- Shared workspace/space capability matrix, explicit denies and downgrades,
  guest grant ceilings, own-comment rules, move/export restrictions.
- Pure ownership graph planner using actual Phase 4 fields, server-owned root
  scope, both relation endpoints, cycle/depth checks and public-upload isolation.
- Additive migration 0012: Core backfill, new role/disabled columns without
  rebuilding users, space memberships, global access generation and audit table.
  Existing 0001–0011 migration files remain unchanged. The new migration hash is
  registered in the existing certification manifest.
- Request-local authority loader, atomic generation fence, bounded recursive D1
  ownership loader and authorized record read service. Graph reads contain no
  titles/body/claim hashes. Content fetch follows authorization and checks record
  revisions and permission freshness again.
- Audited space creation/membership services: default-private/export-disabled,
  owner preservation, privilege ceilings, atomic audit, concurrent duplicate
  request handling, lost-response recovery and reauthorized replay.

Space administration services are **not yet exposed by application routes**. The
shared write kernel now invokes authorization when activation is enabled; this
includes the authenticated sync push route. Migration
`access_state.enabled` remains **0**; guest creation and permission-aware sync
are not enabled. This intermediate state preserves the existing Core workspace
while all enforcement paths and the client protocol are built. It is not a
completed permissions feature and must not be activated prematurely.

## Executed evidence

`tests/access.test.ts`, `tests/recordScope.test.ts`,
`tests/phase5-access-d1.test.ts`, `tests/phase5-runtime-d1.test.ts`:
**80 PASS, 0 FAIL, 0 skipped**, four files. TypeScript and whitespace checks pass.
These are foundation checks, not a full Phase 5 certification.

The populated-D1 upgrade test first failed with
`Cannot add a REFERENCES column with non-NULL default value`. The corrected
additive migration uses reference validation triggers without rebuilding records;
the same seven-user upgrade regression now passes. It verifies passwords/salts,
sessions, JSON, HLC timestamps/revision, outbox lease and accepted form receipt.

Real D1 tests cover role isolation, explicit denies/regrant, disabled/deleted
identities, membership/session/move epoch changes, transaction rollback on stale
authority, concurrent owner removal, idempotent requests, lost acknowledgements,
true parent ownership, hidden relation endpoints, malformed/cyclic ancestry,
pending public uploads and graph/content revision races. They do not yet prove
complete enforcement through existing HTTP/MCP read routes or client storage
reconciliation.

## P5-2 shared write enforcement (in progress)

`worker/mutationAccess.ts` resolves the existing and proposed ownership graphs,
checks actor capabilities and protected fields before approval checks/conflict
hydration, and writes the authoritative inherited `records.space_id`. Client
child scope claims cannot grant access. Root scope changes require the pending
explicit durable move workflow. Commenters can create/edit their own comments;
they cannot rewrite authors/targets or ordinary records. Automation configuration
requires destination edit and template read rights. Source labels, changesets and
execution checkpoints never confer privileges.

Each write transaction fences both the access generation and graph revisions,
including absence of newly proposed parents. A later membership, parent or
relation change aborts that batch. Earlier committed batches keep exact journals,
outbox and execution checkpoints and return a retryable partial result. Conflict
replies independently recheck current visibility before returning record data.

Initial real-D1 red run: **11 failures / 1 pass** against the unfixed kernel.
`tests/phase5-writes-d1.test.ts` now exercises the real kernel/HTTP sync route,
denied actors, disabled identities, protected fields, graph inheritance,
revocation and parent/reference races, lost responses and 150-row interrupted
execution/regrant. The permission flag remains off outside disposable tests:
read routes, protocol 2 and clients are still outstanding.

### P5-SEC-01 — Proposed board approval gate bypass

Reproduction: one atomic write placed a task in `done` before inserting its board
with a `done` approval gate. Persisted-only preflight/transaction checks saw no
board yet and committed both records. The regression failed with `changed=2`
instead of `0`. `applyChanges` now merges proposed board configurations using
the actual LWW timestamps and passes them into `guardStageWrites`. The same
regression passes with permission activation **0 and 1**; neither record commits.
No functional approval assertion was removed.

### P5-REL-01 — Mixed rejection count omitted stale revisions

A non-atomic call with one hidden record, one stale expected revision and one
valid edit returned only one rejected item count. The new regression reproduced
`rejected=1` instead of `2`. The kernel now includes stale conflicts in the count
and preserves both earlier ACL rejections and later batch conflicts. The valid
edit still commits. Red evidence: `.artifacts/phase5-writes/conflict-red.json`.

Fault-injection adapters for existing atomic/event tests now intercept actual
record-write batches rather than treating the new read-only authority snapshot
as a write. The original rollback/lost-response/race assertions remain intact.
After this adapter correction, the combined security/event/write suites passed
**81/81**, including all 26 new write assertions. TypeScript passes. The complete
unit run before the final adapter correction had **773 PASS / 1 FAIL**; the one
failure was that shifted approval fault-injection point, now passing in the
81-case rerun. A fresh complete run remains required. Evidence is preserved in
`.artifacts/phase5-writes/green-final.json` and `unit-results.json`. These are
uncommitted-source observations, not certification of any later SHA.

The FTS5 runtime probe executes prefix MATCH, ranking, snippets and SQL access
filtering. It does not implement the production search index or prove ranking
independence from a hidden corpus.

Current disposable 1000-record workload: read 500 authorized records using
3 binding calls / 7 SQL statements / 6011 rows read / 0 written; approximately
32 ms in local Miniflare. Fixture setup excluded. This is not deployed-region
latency or billing evidence. Machine measurements are generated under the test
artifact directory, with source SHA populated when the certification caller
supplies CERT_SOURCE_SHA.

Artifacts (ignored): `.artifacts/phase5-foundation/targeted-results.json` and
`.artifacts/phase5-foundation/performance/phase5-access.json`. Intermediate
uncommitted-source checks do not certify a later commit.

## P5-2 incremental sync and manifest checkpoint

`worker/syncAccess.ts` and the existing sync router implement the activated
protocol-2 incremental contract. `/api/access` returns only currently authorized
space names/roles. Old sync protocols receive 426 after activation; stale
generations receive 409. Push rechecks the protocol generation inside its actual
planning snapshot. Candidate pulls select bounded IDs/sequences through the
space index, then validate authoritative ancestry/relations before fetching
content. Empty pages still advance and perform a final authority fence.

Red run against the legacy router: **8 FAIL / 1 PASS**. The expanded suite now
passes **15/15**, including malformed cursors, visible/invisible pages, legacy
compatibility, manifest isolation and revocation during graph/content reads.
An additional empty-page race reproduced an unhandled SQLite fence rollback;
it now returns the explicit reset response. No reset/error is reported as a
successful empty page.

### P5-SEC-02 — Visibility changes did not invalidate cached descendants

Ancestor deletion/restoration and endpoint reassignment previously left access
generation unchanged. A cached child/link could therefore outlive the access
change even when new pulls correctly filtered it. Both regressions failed
before migration 0013. Transactional visibility/activation triggers now advance
generation; ordinary title updates do not. These triggers remain inactive for
legacy record updates while permission activation is off. No record payload is
rewritten and no purge capability is enabled.

Expanded actual-D1 foundation/write/sync run: **71/71 PASS** before adding the
workload case. The complete sync workload suite then passed **15/15**. Artifacts:
`.artifacts/phase5-writes/protocol-targeted.json`, `sync-workload.json`,
`sync-red.json`, `sync-race-red.json`, `visibility-red.json`.

Local mixed-space 1000-record workload: **501 authorized results, 11 pages,
7 D1 binding calls per page, 14 statements in batches per page, 0 rows written**.
Observed page times approximately **31–43 ms**. Batch rows read range 57–1485;
the additional direct indexed space-ID discovery is included in binding calls
but excluded from that row metric, as the machine artifact explicitly labels.
Fixture setup is excluded. These are local Miniflare measurements, not deployed
latency or production billing. Machine evidence is generated at
`performance/phase5-sync.json` under `CERT_ARTIFACT_DIR`.

**Still incomplete at this checkpoint:** client gating/atomic cache
replacement/eviction/quarantine/regrant, WS/session revocation and the remaining
REST/MCP/file/public/background read surfaces. Activation remains **0**. The
new incremental endpoint alone is not a complete permissions implementation.

## P5-2 durable snapshot checkpoint

Migration 0014 and `worker/syncSnapshot.ts` implement fixed-cutoff, account/epoch
bound snapshots through the existing authenticated sync router. Continuations
are HMAC signed with a per-session secret kept only in D1. Creation is atomic,
duplicate/concurrent starts recover by request identity, and a lost committed
response does not create a second copy. Pages recheck current graph visibility
and snapshot validity; old payloads remain frozen while newer text revisions are
picked up after the cutoff. Revocation and regrant cannot revive an old session.

Bounds: 15-minute session lifetime; 2 active copies/account; 20,000 candidates /
16 MiB payload/copy; 32 MiB aggregate payload. Overflow rolls back, without a
partial header/items or a truncated success. Expired ephemeral data is pruned on
creation and can be cancelled by its authenticated owner. Periodic maintenance
cleanup and client-side snapshot staging/activation are still outstanding.

Snapshot red run: **8 FAIL / 15 PASS** (all newly added snapshot cases failed
against the router without snapshot support). Cancellation/expiry during paging
then exposed **2 additional failures**: a successful empty page could be returned
after the session disappeared. Transactional snapshot validity fences corrected
both. The 20,001-record test verifies a 413 and zero committed snapshot rows,
while all source records remain intact. Snapshot/session/manifest/cursor suite:
**31 PASS**. Combined with write and foundation tests: **89/89 PASS**, TypeScript
and whitespace checks pass. Evidence: `.artifacts/phase5-writes/snapshot-red.json`,
`snapshot-invalidation-red.json`, `snapshot-targeted.json`.

### P5-REL-02 — Preserve cascading tombstone/restore semantics

The activated authority planner initially denied a descendant tombstone because
its ancestor was deleted in the same atomic call; parent+child deletion returned
zero changes. The deterministic regression failed first. Authorization now
allows only existing-record `deleted`/`deletedVia` bookkeeping with the same
space capabilities and graph/epoch fences. Parent+child delete/restore passes,
and an attempt to edit a hidden descendant body remains denied. This is not a
general grant to read or edit content under deleted parents.

## Verified committed quick checkpoint

`npm run certify:phase4:quick` on
`252787617f8fda6175e3fe7a394ee16d6634cbe7`: **13/13 applicable gates PASS**, exit 0;
**789 unit / 184 Phase 4 actual-D1 / 58 harness assertions PASS**, 13 migrations,
TypeScript/build, dependency/lockfile, raw security audit and resource evidence.
Source fingerprint:
`45b2321cb7579c0a04d19dc5ca05dcc603ef1bab7146ff6104f5a371189bc787`.
Artifacts: `.artifacts/certification/252787617f8fda6175e3fe7a394ee16d6634cbe7-2026-10-15T10-16-50-593Z-quick/`.
The source was unchanged throughout the run. This quick checkpoint predates the
snapshot changes and does not certify them, browser/MCP integration or completed
Phase 5. PR #7 remains draft. No merge or deployment.

## P5-2 atomic client cache layer (not yet wired into the engine)

Dexie version 7 adds snapshot staging and an account-bound access quarantine.
`src/core/sync/accessCache.ts` validates exact page/session identity, durable
continuations, manifest roles and the complete staged ownership graph before
activation. One IndexedDB transaction replaces canonical rows, rebases authorized
pending work and installs cursor/manifest. Refused outbox/drafts/pending bytes
move to quarantine; revoked cached blobs/thumbnails and old directory rows leave
normal stores. Quarantine is not part of record search, ordinary draft loaders,
outbox uploading or the existing backup serializer. Export/recovery remains
disabled pending owner policy. The old account's store is never written using
another account identity.

Eight Dexie/fake-IndexedDB tests pass: staging/reopen/cursor replay; atomic
replacement; revoked records/drafts/media; viewer downgrade; authorized edits and
new creations; account/generation/malformed page refusal; own-comment behavior;
and rollback of all records/outbox/quarantine/metadata on an injected activation
crash followed by reopening/retry. These are simulated storage tests, not real
Chromium/Firefox/WebKit or physical-device evidence.

The independent-comment test first failed in both cache and server planners:
an unrelated denied title edit on an existing canonical parent blocked an
otherwise authorized own-comment edit. Dependency rejection now propagates only
when the child depends on a rejected new parent or changed ownership/deletion
shape. Existing parent identity/scope still undergoes the normal revision fence.
The same regression now passes on the real-D1 kernel and client storage.

Latest targeted run: **67/67 PASS** (28 write, 31 sync/snapshot and 8 cache),
TypeScript and whitespace pass. Evidence:
`.artifacts/phase5-writes/cache-integration-green.json`, with red evidence in
`independent-comment-red.json` and `cache-expanded.json`.

**Not integrated yet:** engine access-first ordering, UI startup/reconnect gate,
runtime creation-intent capture, multi-tab locks, object URL/late download
invalidation and quarantine status/discard UI. Permissions remain disabled; this
module is not yet a delivered end-user revocation workflow.

## P5-2 access-first coordinator (engine/UI wiring outstanding)

`src/core/sync/reconcileAccess.ts` checks the access manifest before snapshot
work, persists the start request identity before HTTP, resumes committed pages
after reload, revalidates access after staging, and only then activates the cache.
It checks the active account around every awaited request, rejects protocol
downgrades, and cancels obsolete account-owned snapshots before replacement.
Network/expiry/reset/malformed responses remain failures; none can become a
successful empty cache. Failed startup/page requests retain either resumable
staging or a clean retry intent without replacing live records.

Seven coordinator tests and eight cache tests pass (**15/15**), including lost
start response, second-page interruption/reopen, final-manifest race, account
replacement, expired continuation and stale-copy cancellation. The request
adapter is simulated in these tests; built-Worker and browser integration must
still prove the engine invokes this coordinator in the required order.

Complete unit check on committed `310a7fa`: **815/815 PASS**, 67 files, approximately
258 seconds; production build also passes. Source remained unchanged throughout
the run. Logs/results:
`.artifacts/phase5-cache-checkpoint/unit-results.json`,
`.artifacts/phase5-cache-checkpoint-unit.log`,
`.artifacts/phase5-cache-checkpoint-build.log`.
The coordinator was added afterward and has targeted evidence at
`.artifacts/phase5-cache-checkpoint/coordinator-results.json`; the 815 count does
not certify the later coordinator source. No full Phase 5 PASS is claimed.

## P5-2 engine, media and recovery UI integration

The real sync engine now checks `/api/access` and reconciles snapshots before
push, incremental pull, directory loading or pending uploads. Protocol-2 writes
include the validated generation; pull validates every page, scope, cursor and
completion marker and persists empty-page progress. Refused work remains held,
not acknowledged or retried indefinitely. Private React routes, search and media
unmount while startup/reconnect authorization is unresolved. Storage events
lock stale tabs; account replacement never clears replacement credentials.
Protocol-2 presence is temporarily stopped pending server-side scoped live
integration; this is an outstanding requirement, not a finished live workflow.

Dexie v8 adds metadata-only held-work review, bounded to ten operations per page.
The upgrade preserves existing v7 payloads and binary bytes. Local discard has
an explicit confirmation and account-bound atomic checks. Quarantine counts are
included in sync and account-switch pending-work status. Mobile pages show the
held-work warning directly. No revoked title, body or binary is rendered in the
review; recovery/export remains disabled pending owner policy.

Media uploads check account/session/access epoch around awaited operations,
including immediately before completion. Late or cancelled downloads cannot
repopulate evicted storage. These guards supplement, and do not replace, the
still-required server file authorization.

### Confirmed corrections in this integration

- **P5-REL-03:** `PageView` treated a missing IndexedDB row as loading forever.
  Revocation produced a blank route. Distinguishing initial `undefined` from a
  resolved missing `null` restores the existing Page not found state. Chromium
  first failed the restart/two-tab assertions; the same assertions then passed.
- **P5-REL-04:** incomplete successful-HTTP push dispositions could acknowledge
  pending work. Four malformed-response cases failed before correction. The
  adapter now requires internally consistent counts and known submitted IDs,
  and commits ACK/refusal disposition atomically. A null response already failed
  safely and is retained as additional coverage.
- **P5-SEC-03:** a delayed snapshot or manifest in one tab could replace or
  activate an older generation after another tab discovered/installed a newer
  generation. Three deterministic tests failed first. Metadata transaction
  fences now reject the rollback, preserving the newer reconciliation marker.
- **P5-SEC-04:** a late HTTP 401 from account A could invoke session logout after
  account B replaced local credentials. The engine regression failed first;
  it now locks the stale tab without logging out B.
- **P5-REL-05:** the mobile held-work notice was confined to the closed sidebar.
  Its focused browser review check failed. The notice is now reachable directly
  from the mobile page; cancellation retains work and confirmed discard changes
  only disposable local held payloads, with source D1 unchanged.

Executed evidence (local, not completed Phase 5 certification):

- Full unit run on the first integrated worktree: **841/841 PASS**, 70 files,
  exit 0; `current-unit-results.json`. This predates the extra generation fences
  and migration tests and must not certify the final integration commit.
- Latest targeted cache/coordinator/engine/media/upgrade tests: **42/42 PASS**;
  `cache-upgrade-green.json`. Red evidence: `push-session-red.json`,
  `generation-red.json`, `generation-coordinator-red.json`.
- Built-Worker browser journeys: **24/24 PASS**, eight per engine. Chromium
  153.0.8010.12, Firefox 155.0, WebKit 26.6; exact source fingerprint
  `eab2f7c822be7d05abc707a3e911b7f649a45b848503118a7c45e74ed7c430fb`.
  `.artifacts/phase5-sync-browser-green2/results.json` includes engine versions,
  complete mandatory markers, and the dirty source state at `820707d`.
  These results predate the extra generation fences; a fresh committed rerun
  remains necessary. Responsive widths: 320/390/768/1024/1440.
- Raw npm audit: **0 vulnerabilities**, exit 0;
  `.artifacts/phase5-cache-checkpoint/client-security-audit.json`.
- TypeScript and whitespace pass. All fixtures were disposable/local; permission
  activation occurred only in their D1 state. No deployment or production change.

All other referenced JSON/log files above are under
`.artifacts/phase5-cache-checkpoint/`. Artifacts remain ignored by Git.

## Committed client integration checkpoint — `da80992`

`da80992dfc36b52ce4bcbef46cbb47b00f92fd46` was committed and pushed to draft
PR #7. Clean source fingerprint:
`a8e5aa5a31368c141c0c8bc6b3e6e911669be07170d270c73c6517f1b820a34d`.

- `npm run certify:phase4:quick`: **13/13 gates PASS**, exit 0, 849 unit tests,
  184 Phase 4 actual-D1 tests, 58 harness assertions, 14 migrations,
  TypeScript/build/lockfile/security/resource/source-integrity gates.
  `.artifacts/certification/da80992dfc36b52ce4bcbef46cbb47b00f92fd46-2026-10-15T11-12-09-483Z-quick/`.
- `node scripts/verify-phase5-sync.mjs`: **24/24 PASS**, eight journeys per
  Chromium/Firefox/WebKit, exit 0, clean committed SHA and fingerprint match.
  `.artifacts/phase5-sync-da80992/results.json`.
- Filtered sync workload: 1,000 fixture records, 501 authorized results in 11
  pages; at most 7 D1 binding calls/page, 1,485 batch rows read/page, zero writes;
  maximum local page duration 56.48 ms. Batch row metadata excludes the additional
  indexed space-discovery read; binding counts include it. Local measurements,
  not production latency/billing evidence.

This is a quick regression checkpoint plus a focused browser gate. It is not
complete Phase 5 certification, nor a rerun of all legacy MCP/browser gates.
The additional signup work below is newer source and requires its own checks.

## Fresh signup ownership and atomic admission

**P5-SEC-05:** simultaneous initial signup could create multiple legacy admins,
without canonical workspace/Core ownership. The old count-before-password-hash
check did not fence admission. **P5-REL-06:** account creation, invite use and
session persistence were separate writes; session failure stranded an account,
and two requests for the last seat could both fail after compensating deletion.

Six actual-D1 tests failed against the unchanged implementation. Signup now uses
one guarded D1 batch: capacity/invite or empty-workspace predicate, user insert,
bootstrap Core owner membership/creator/audit, invite redemption and session.
A failing statement rolls the whole operation back; error diagnosis is read-only.
Existing response roles remain admin/member for backward compatibility; canonical
workspace roles are owner/member. Permissions stay off. No migration rewrites
existing users or sessions.

The same six tests pass; a seventh covers username conflict retaining an unused
invite. Coverage includes parallel first signup, same invite, last seat, failed
session insertion, interrupted atomic commit/retry, canonical ownership and
unchanged activation. Surrounding actual-D1 access/sync/write plus OAuth regression run: **100/100
PASS**, exit 0 (`signup-surrounding-green.json`). No results are borrowed from
`da80992` for this source.

Built Worker `scripts/smoke.sh` ran automatically on fresh disposable D1,
**44/44 PASS**, exit 0;
`.artifacts/phase5-signup-built/` retains logs, fixture provenance, source
fingerprint and SQL proof of the new Core owner/audit. No production resources
were accessed.

## Session controls and disabled principals — implementation checkpoint

Migration 0015 adds opaque session IDs and bounded device/last-seen metadata;
credential hashes and expiry remain intact. Session list is owner-only,
paginated at 50. Single/current/all-other session revocation uses an atomic
credential/disabled-state fence, SQL ownership restriction and access audit.
Foreign IDs and missing IDs both return 404. UI in Settings supports current
identification, refresh/pagination, two-step signout/cancel and retained-work
explanation. Current-device logout preserves local data. No tokens, hashes or
IP addresses are returned in the list.

Disabled accounts now fail password login, session authentication, OAuth consent
and MCP requests; installed OAuth grants cannot bypass current disabled state.
**P5-SEC-06:** four further client auth races were reproduced: late startup
success/401, signout and profile updates could overwrite/clear an account that
another tab had already replaced. The four tests failed first and now pass;
responses verify captured uid/token before touching local identity. The earlier
P5-SEC-04 sync catch guard is preserved.

Executed evidence on the session worktree (before its logical commit):

- Initial new session tests: 0 PASS / 6 FAIL, including missing endpoints/schema;
  `sessions-red.json`. Session+signup implementation run: 13/13 PASS.
- Final session/signup/client/OAuth/account-switch checks: **29/29 PASS**,
  including legacy-session migration preserving credential hashes and expiry;
  `sessions-final-targeted.json`.
- Session/auth/access/sync surrounding D1 run: **76/76 PASS**;
  `sessions-surrounding-green.json`. Includes revoked-caller race: target session
  and audit remain unchanged when the caller loses its credential before commit.
- Client auth/engine/media/account-switch: **33/33 PASS**;
  `auth-client-green.json`; red evidence in `auth-client-red.json`.
- Built Worker/browser: **27/27 PASS**, nine journeys in each engine, including
  cancel/remote signout/current signout and 320/768/1024 session-form reflow;
  `.artifacts/phase5-sessions-browser2/results.json`, fingerprint
  `1c3694ae7fda65f84983a96f03f730cb5bcc83fb65af1f4057cd46dc59391298`.
  The first run caught an ambiguous login selector (tab and submit both Sign in);
  the corrected assertion targets the form submit and preserves the same behavior.
- Built Worker base MCP: **94/94 PASS**, exit 0, complete mandatory markers,
  `.artifacts/phase5-sessions-mcp2/results.json`. Three mandatory disabled-user
  checks were added to the existing manifest. The first MCP run failed closed
  with a fetch transport error before those checks; its failure report remains
  in `phase5-sessions-mcp/`. A fresh isolated run passed without relaxing tests.

JSON/log paths without a directory above are in
`.artifacts/phase5-cache-checkpoint/`. These are integration checkpoints, not
complete Phase 5 certification. Server scoped live/session revalidation, guest
invitations, full role/admin protections and all remaining read surfaces are
still required before activation. Physical devices/manual AT remain NOT RUN.

## File capabilities and thumbnail reconciliation — implementation checkpoint

**P5-SEC-07:** the authenticated file routes had only workspace login checks.
Six actual-D1 regressions failed before the correction: guessed/hidden reads,
viewer upload/complete/delete/transcribe, stale denormalized scope, private usage
totals, and revocation before chunk persistence. `worker/fileAccess.ts` now uses
canonical ancestry and current space capabilities. Byte reads/writes include
epoch, principal, canonical revision and session guards in the same D1 batch.
Viewers may read authorized bytes; editable ownership is required for mutations
and transcription. Unauthorized IDs return 404. Responses use `private,no-store`.
The legacy Core-only contract remains available while activation is off.

**P5-REL-07:** thumbnails have a pending blob named `<file-id>t` and a `thumbId`
on the canonical attachment, without a separate synced file row. Three tests
failed when the new gate/cache treated that legitimate thumbnail as missing.
`shared/fileOwnership.ts` identifies this existing contract. The server requires
the canonical main attachment and exact deterministic reference; client download
caching and pending-byte reconciliation preserve that relationship. This is not
an arbitrary-reference read grant.

**P5-SEC-08:** additional fault injection reproduced two races: creating a real
record at the thumbnail ID after authorization could disclose its bytes, and
revoking the uploader before auxiliary cleanup could still commit deletion
intent. Both tests initially returned 200 instead of 409. The transactional
fence now checks auxiliary-ID absence and protects cleanup as well. A real
record retains its own authority. A forged visible reference cannot grant
access. A third red test showed cached auxiliary bytes surviving snapshot
reconciliation on pointer alone; downloaded/uploaded auxiliary cache is now
discarded on snapshot activation and fetched through fresh server authority.
Pending locally created thumbnail bytes remain with their editable main file.

Executed before this logical commit:

- Initial route red evidence: `files-red.json`, six FAIL. Thumbnail integration
  red: `thumbnail-red.json`, three FAIL. Boundary red: `files-boundary-red.json`,
  two FAIL. Cache red: `thumb-cache-red.json`, one FAIL. These files are retained
  under `.artifacts/phase5-cache-checkpoint/`.
- Actual-D1 file/Phase 4 security/chunks plus client media/cache: **66/66 PASS**,
  exit 0, `.artifacts/phase5-files-targeted/results.json`. Covers successful
  canonical deletion, preserved existing session-revocation write fence,
  concurrent role changes, revocation during AI, lost-response chunk replay,
  session expiry, hidden IDs, thumbnails, atomic cache reconciliation and
  binary integrity. The main deletion revocation test already passed and is
  preservation evidence, not a new defect claim.
- 1,000-file local workload: **16 bindings, 27 statements in batches, 15,088
  batch rows read, 0 batch rows written, 144.17 ms**. Metrics artifact:
  `.artifacts/phase5-files-targeted/performance/phase5-files.json`. Direct auth,
  state and space-discovery row totals are excluded; their calls are included.
  This is local Miniflare evidence, not production billing or latency.
- Built Worker browser before final boundary/cache changes: **27/27 PASS**,
  `.artifacts/phase5-file-browser1/results.json`, with private main/thumbnail
  uploads, guessed-ID rejection, actual IndexedDB caching and revocation
  eviction across Chromium/Firefox/WebKit. Final committed-source rerun remains
  necessary and will be recorded separately.
- Runner syntax and whitespace checks passed. The first shell sequence failed
  to propagate TypeScript's nonzero exit status for two test-context stubs;
  `files-commit-typecheck.log` preserves those errors. The subsequent correction
  uses Hono's actual request-context type and standalone typecheck passes.
  Browser failure paths
  now abort dependent journeys for that engine and preserve session screenshots
  and traces before browser closure. Independent engines still execute.

Settings usage counts only readable canonical files and their owned thumbnails;
global upload enforcement still uses the workspace quota. A bounded scan that
exceeds its supported size returns an explicit failure rather than a partial
total. Shared-reference/template capability handling, public links/forms,
remote import, other server read surfaces and scoped live remain unfinished.
Activation stays off outside disposable fixtures. This is not full Phase 5
certification.

### P5-SEC-09 — Foreign thumbnail cleanup intent and identity collision

Four actual-D1 tests failed before the correction (`thumb-write-red.json`): a
file could name another canonical file as its thumbnail, including an exact
`<main>t` collision; a new record could take an active auxiliary identity; and
deleting malformed legacy metadata could enqueue another file's cleanup intent.
The central mutation authorization now validates the deterministic ownership
contract, rejects canonical collisions, reserves active auxiliary IDs and fences
both present and absent dependencies in the record/journal/outbox transaction.
Graph projections include the necessary thumbnail reference, never file bytes.
A concurrent-claim regression verifies rollback. Legacy malformed pointers can
be cleared by an authorized editor before deletion; they cannot poison another
file. These protections apply only under the still-disabled Phase 5 activation.

A separate red test (`thumb-epoch-red.json`) confirmed that changing `thumbId`
did not invalidate cached auxiliary bytes. Additive migration 0016 now advances
the active access generation for such changes. Previous migration files remain
unchanged; 0015 and 0016 hashes are registered in the certification manifest.

Protocol 2 client/server deletion avoids creating an orphan synced thumbnail
tombstone when the canonical main file already drives durable binary cleanup.
Actual separate file rows still use canonical mutation authorization. Protocol
1's established deletion queue is preserved. Client tests execute both paths.

Surrounding actual-D1 write/file/review/integrity and client media/cache run:
**109/109 PASS**, exit 0, `thumb-ownership-green.json`. Standalone TypeScript
passes. The full unit run on intermediate commit `4224d76` recorded **887 PASS /
1 FAIL**, exit 1, in `.artifacts/phase5-files-committed/unit-results.json`.
The failure was C18's old `.run()`-only fault injector missing the new batch
write. It now injects before the actual D1 completion batch, asserts the race
executed and retains the required HTTP 409/incomplete-file checks.

Two intermediate tests stalled because broad fake timers froze IndexedDB's
`setImmediate` queue; only those owned Vitest processes were interrupted, exit
130. `thumb-harness-interrupted.json` records incomplete execution as FAIL.
Narrowing fake timers preserves the real IDB queue; media checks then pass.
All filenames in this subsection without a directory are under
`.artifacts/phase5-cache-checkpoint/`. A fresh committed-source quick run and
browser run are required next; none of these results constitute full Phase 5
certification or permission activation clearance.

Final review reproduced one further P5-SEC-09 ordering case: a proposed pointer
clear in a later batch could release an auxiliary identity before that clear
committed. A 102-operation actual-D1 test interrupted the second batch and
failed on the old implementation (`thumb-release-red.json`). Reservation now
uses current durable ownership before proposed state. The caller must commit a
pointer release before claiming the ID in a separate operation. The same test
and six related cases pass (`thumb-release-green.json`); TypeScript passes.

The intermediate clean commit `e45cbae43525698b2a44421196e48ebd6787b9ce` passed
the existing quick command: **13/13 gates, 896 unit, 184 Phase 4 D1, 58 harness,
16 migration hashes, build/typecheck and zero npm vulnerabilities**, exit 0.
Artifact: `.artifacts/certification/e45cbae43525698b2a44421196e48ebd6787b9ce-2026-10-15T12-24-18-442Z-quick/`.
Its newly started complete run was deliberately interrupted to implement the
ordering regression; its FAIL/incomplete/source-change evidence remains in the
`12-32-14-195Z-complete` sibling directory. It cannot certify the correction.
The complete command must run against the following committed source.

## Required work still outstanding

| Workstream | Remaining implementation and acceptance |
|---|---|
| P5-1 foundation | Remaining protected configuration references, ownership transfer, audited role/space updates, API integration |
| P5-2 sync/access | Remaining REST/MCP/file/public/background/history enforcement; complete protected field validation; durable move jobs; snapshot maintenance; remaining client role states and wider adversarial/cache coverage; scoped WS/session revocation |
| P5-3 search | Authoritative dirty/index pipeline, permission-safe ranking/pagination, APIs/MCP, local/online mobile palette, workload/security tests |
| P5-4 guests/sessions | Scoped guest invites; remaining session/live enforcement; space/member management UI and complete guest/role browser integration |
| P5-5 history/scale | Atomic history, revision-safe restore/API/UI, usage monitoring, bounded safe caches, retention policy controls |
| P5-6 certification | Extend existing orchestrator to certify:phase5; all new mandatory actual-D1/API/storage/browser/adversarial gates; complete old regression; raw audit; final committed SHA/fingerprint; final diff review; pushed stacked PR |

No Phase 5 full-certification PASS is claimed. The previous Phase 4 certificate
does not certify this branch. Physical-device Safari/Android, human assistive
technology and native 400% zoom remain external NOT RUN release gates.

Owner policy remains unresolved for private-space bulk export and retention/
recovery of revoked offline payloads. Those sensitive controls remain disabled;
independent implementation continues. Permanent purge remains disabled.

GitHub hostname resolution failed during fetch attempts on 2026-10-15; local
work and disposable tests continued. Fetch/remote verification must succeed
before normal push/stacked PR creation. No force push or alternate checkout.
