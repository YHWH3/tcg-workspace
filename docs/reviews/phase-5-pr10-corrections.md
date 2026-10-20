# PR #10 independent-review corrections — P5-R01–R03

Reviewed baseline: `fcfc5e0b48e883cf1eb14995e6b8e078f179bc05`.
Branch: `phase5/per-space-feeds`. No merge, deployment, activation or Phase 6 work.
Final committed-source acceptance is the generated `npm run certify:phase5` artifact,
not the earlier baseline or a dirty development run. This document is committed
before certification; the PR and generated report identify the final exact SHA.

## P5-R01 — CONFIRMED, corrected

`visibleSummaries()` authorized a truncated unordered 10,000-item response. With
10,000 public items in changeset `a` and the private item in changeset `z`, REST
listing emitted the private summary. Actual-D1 tests reproduce the boundary at
10,001 and 15,000 items; 9,999/10,000 retain negative controls. The built baseline
Worker also disclosed the marker through real REST/OAuth-MCP.

The query now reads an ordered **501-row sentinel**. At most 500 journal items
can authorize summaries for one response window. A sentinel, missing journal,
missing/denied record or scope/binding-budget failure yields `Restricted change`;
incomplete coverage additionally reports `visibilityIncomplete:true`. No title,
summary or approximate space-only decision authorizes an incomplete set. Ordinary
complete journals still use canonical ancestry and current membership. Large
journals remain available through existing item filtering/undo, but their summary
may deliberately be neutral. Detail routes check the summary independently rather
than relying on the number of omitted detail rows.

Tests: `tests/phase5-review-d1.test.ts` (9,999/10,000/10,001/15,000, multiple journals,
REST pagination, MCP listing/detail, mixed large detail, 500/501, missing journal).
The final mandatory OAuth/MCP runner includes the 10,001-item regression.
Resource evidence: `review-summary-cost.json`, required in both unit and dedicated
D1 stages. It reports actual binding calls/statements/rows and duration. Early
local measurement: six bindings/nine statements/523 rows read/zero writes for a
15,000-item fail-closed window plus an ordinary readable summary. Final measurements
are in `performance.json`; these are Miniflare metadata, not production costs.

## P5-R02 — CONFIRMED, corrected

The gate memoized permission decisions by record ID; unchanged record revisions
outlived membership removal. Deterministic actual-D1 tests reproduce viewer/guest
revocation, workspace downgrade, deletion/disablement, ancestor movement/deletion,
and relation-peer revocation. A read-preserving editor-to-viewer downgrade remains
readable. A custom real Worker HTTP request authorizes, pauses on a database barrier,
then resumes after another HTTP request commits revocation. Bundling the exact
reviewed gate makes that test fail with confidential bytes; the corrected gate passes.
No cross-request promise-resolution primitive or probabilistic timing controls the race.

Only ownership graphs are cached now. Every decision loads current memberships,
principal and activation state. The same D1 authority batch verifies every cached
ancestor revision. A changed graph is reloaded once; a second race fails closed.
There is no global generation/snapshot mechanism and no Protocol 3 change.

A related serialization seam was reproduced: `get_page` retained its early title
while a later block read observed revocation. Registered MCP tools now validate
the explicitly observed read set once more before returning. Arbitrary response
strings are never used as record dependencies. If a fresh mutation already committed,
serialization removes all content but preserves truthful completed/partial status and
the caller's own server-verified changeset audit reference. That identifier grants no
read or undo permission; completed replays still follow the stricter R03 policy below.
Existing exact-lookup scale tests
still require flat binding costs and stay below the 45-call invocation budget.

An authenticated GET could also outlive its own session: a deterministic REST
regression returned 200 after deleting the session in the handler. `requireAuth`
now checks current session/user validity after successful buffered GET/HEAD handling
and returns 401 on revocation/expiry/disablement. Writes retain their existing
transactional capability/session fences. This is one additional binding per successful
session-authenticated read, accounted for in the full regression matrix.

**Race boundary:** the final authority batch is the linearization point. A revocation
committed before it denies output; a revocation committed after the last decision
or after bytes have been committed cannot recall an already authorized response.
Previously downloaded bytes likewise cannot be erased remotely. OAuth validates its
grant at request ingress; this change does not claim mid-stream token invalidation
of an already committed response. Current membership/disabled status is rechecked
at final tool validation for every observed record.

The required undo compatibility check exposed a related, reproduced cascade seam:
a delete's activity entry was rejected because its target was being deleted in the
same plan, and inverse revision guards rejected tombstoned descendants. The authorizer
now permits only same-plan delete bookkeeping with the original readable target,
and expected-revision checks allow tombstone-only restoration under current space
capabilities. Null restoration of an originally absent `deleted` field is supported.
Inverse planning reads server state internally so hidden descendants retain their
actual CAS revisions; every inverse still passes the canonical write authorizer.
Tests cover successful cascade delete/undo, revocation before undo and a forged
activity entry for an already hidden target. No hidden-body edit is authorized.

## P5-R03 — CONFIRMED, corrected

String extraction is not a dependency manifest. Actual-D1 retained results with
opaque text, nested objects/arrays, URLs, summaries and 5,001 candidate strings
replay private text after revocation against the reviewed implementation.

With permissions enabled **every completed replay is metadata-only**, even when
access still exists or is regranted. It returns `replayed:true`, `restricted:true`,
`resultRedacted:true`; no stored content is copied or scanned. An optional
`changesetId` comes from the server's own user/request/tool journal and is included
only when its complete current affected-record set is authorized under R01.
Missing/oversized/inaccessible journals omit that reference. Clients can use fresh
authorized read tools to retrieve current content. Disabled-mode replay contracts
remain unchanged. Argument hashing, completed request identity, durable jobs,
partial recovery and undo implementation are unchanged: redaction never reruns a
completed mutation. The existing long-operation regressions remain mandatory.

The real OAuth/Streamable HTTP gate now verifies opaque objects, nested arrays,
URLs and >5,000 candidates with a one-changeset execution count. Actual-D1 tests
also cover deletion, movement, regrant and mismatched arguments. Existing history
restore/undo/replay, file permissions, scoped share, search, notifications, Protocol 3
browser/quarantine and guest tests remain in the complete matrix.

## Certification-discovered compatibility correction

The first clean-HEAD correction run on `6dca86a` passed 1,136 unit tests and
529 dedicated D1 tests, then failed Phase 2 MCP. The moodboard tool resolved
cards individually; fresh authority checks exposed D1 budget exhaustion at the
larger canvas. A diagnostic disposable OAuth runner captured the actual error.
A new 100-card regression failed with `D1BudgetExhausted` in BOTH permission modes.
Exact card and database references are now loaded in authorized batches, retaining
collection checks, hidden-reference redaction and final serialization validation.
The same tests pass under 30 bindings. `review-moodboard-cost-*.json` measurements
are mandatory in unit/D1 performance evidence. This is a targeted compatibility
correction; no permission or budget assertion was relaxed.

That initial run was stopped after the confirmed failure to correct it. Its report
preserves the Phase 2 failure, interrupted v6 and NOT RUN later stages; it is not
acceptance evidence. The new committed source requires a complete fresh run.

## Executed development evidence

All logs are ignored local artifacts under `.artifacts/phase5-review/`:

- `red.log`: 17 failures / 2 passes against reviewed source before correction.
- `serialization-red.log`: deterministic early-title serialization leak.
- `session-red.log`: authenticated read returned 200 after session revocation.
- `worker-red-actual.log`: exact reviewed gate leaked `CONFIDENTIAL_WORKER` from a
  real Worker request after a concurrent revocation transaction.
- `wire-red.log`: baseline built Worker leaked the large-journal summary through
  real OAuth/MCP/REST. Unexecuted later checks are reported as failures, not passes.
- `wire-green.log`: 15/15 enabled built-Worker OAuth/MCP checks passed.
- `focused-green.log`, `final-targeted.log`, `compatibility.log`: scoped correction
  and surrounding regressions. Counts in intermediate logs are historical; final
  certification JSON is the mandatory acceptance evidence.

New `phase5-review*-d1.test.ts` files match the existing mandatory unit/D1 discovery.
The existing `phase5-mcp` gate expands from 13 to 15 assertions. Gate count stays 29;
no legacy checks are removed. No dependency, production configuration or SQL migration
change is needed. Physical devices/manual assistive technology/native 400% zoom remain
NOT RUN external production gates. PR #10 stays draft for independent verification.
