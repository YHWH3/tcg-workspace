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

The new services are **not yet exposed by application routes**. Migration
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
enforcement through existing HTTP/MCP routes or client storage reconciliation.

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

## Required work still outstanding

| Workstream | Remaining implementation and acceptance |
|---|---|
| P5-1 foundation | Fresh-signup ownership, complete inheritance/write integration, ownership transfer, audited role/space updates, API integration |
| P5-2 sync/access | Server enforcement on every REST/MCP/file/public/background/history path; protected field validation; durable move jobs; protocol 2 filtered pull/push; snapshots; client gating/eviction/quarantine/regrant; WS/session revocation |
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
