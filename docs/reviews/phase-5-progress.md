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

## Required work still outstanding

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

## Required work still outstanding

| Workstream | Remaining implementation and acceptance |
|---|---|
| P5-1 foundation | Fresh-signup ownership, remaining protected configuration references, ownership transfer, audited role/space updates, API integration |
| P5-2 sync/access | Remaining REST/MCP/file/public/background/history enforcement; complete protected field validation; durable move jobs; snapshot maintenance; client staging/gating/eviction/quarantine/regrant; WS/session revocation |
| P5-3 search | Authoritative dirty/index pipeline, permission-safe ranking/pagination, APIs/MCP, local/online mobile palette, workload/security tests |
| P5-4 guests/sessions | Bounded invites and seven-seat atomic acceptance; sessions and disabled accounts; space/member management UI; multi-tab/browser integration |
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
