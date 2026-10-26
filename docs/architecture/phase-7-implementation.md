# Phase 7 implementation

Status: in progress on `sol/p7-foundations`. This document describes the current
implementation and its remaining work; it is not a release certificate.

The branch starts at certified R1 source `0888525`. Its exact evidence is indexed
in [the roadmap](../roadmap/evidence/R1-0888525.json). The initial Android device
transport interruption remains recorded alongside the two successful fresh runs.
Do not describe an unconfirmed interruption cause as a fixed application defect.

## Current implementation

- **7.0:** `scripts/certification/test-files.mjs` selects Phase 4–13, audit and
  assistant D1 tests for the existing dedicated database gate. The orchestrator
  imports that selector; two discovery self-tests pass. The earlier gate and
  resource evidence remain required.
- **7.1:** implemented; narrowly verified. Shared inclusive `within` evaluation, strict date-bound
  validation, createdAt calendar comparisons (numeric sorts remain unchanged),
  MCP schemas/tool errors and a shared native/relative date editor are implemented.
  Compact filters use the existing scrollable sheet. Focused 120 tests
  and actual-D1 MCP 12 tests pass; 36 browser cases pass across all 18 projects,
  with no skips or flaky cases. Typecheck/build pass. Keyboard creation, touch
  presets, invalid-input preservation, reload, axe and bottom-action reachability
  are checked. Compact dark screenshot reviewed. Earlier failing native-keyboard
  harness probes remain retained; this is not the final Phase 7 certificate.
- **7.2:** implemented; focused verification passes. Server-only migration 0035,
  canonical-admin settings with version/session commit fences, request-scoped
  server dates, shared money formatting and account-bound client cache. Local
  midnight/visibility/live changes refresh date-sensitive views. UTC provider
  usage quotas and audit/export timestamps remain intentional.
  The final 54-case browser matrix passes across all 18 projects: populated
  settings, field editor/creation, defaults and explicit USD, keyboard/touch,
  recovery, whole-page axe and geometry. Screenshot review corrected a squeezed
  new-field name input; compact field controls stack with touch targets.
  All failures remain retained. The full development test run ended 1591 PASS /
  1 FAIL because its wall-clock-based eight-retry fixture crossed into Monday.
  It now uses a fixed UTC midweek date and separately tests the week boundary;
  affected digest and reproduced cache-edge regressions pass 22/22. This does
  not relabel that failed full run or replace final Phase 7 certification.
- **7.3:** implemented with focused verification; phase certification pending.
  Disabling is session/canonical-role/target-state fenced and revokes sessions,
  modern connections, pending OAuth consents and sponsored Website ingest grants
  atomically. Provider grant cleanup is bounded and must succeed before restore.
  Active-seat capacity is enforced atomically for signup, guest redemption and
  restoration; bootstrap still requires zero total accounts. History remains.
  Canonical role changes and removals use current enabled-admin protections.
  The authenticated directory refresh now runs in both sync protocols, retaining
  account/token/access-epoch fences and the guest self-only server policy.
  Disabled people remain on existing assignments and cannot be selected anew.
  The 18-project browser matrix passes including explicit restoration failure
  and retry, keyboard confirmation, another tab signing out, whole-page axe and
  geometry. Compact light and tablet dark confirmation screenshots reviewed.
  The focused 51-check run passes. Earlier failures remain retained; the new
  live-sweep test must wait for the same initial presence message the app sends
  before testing closure. Original production socket code passes unchanged.
- **7.4:** implemented with focused verification; phase certification pending.
  Pack version 2 adds stable item provenance and the seven currency formats.
  Legacy authored IDs and deterministic installed IDs are preserved by a golden
  fixture. The additive planner preserves team labels, filters, stages, records,
  deleted items and existing field formats. It holds ambiguous matches.
  Client previews list every operation; guarded mutations persist with the local
  outbox, are rechecked on the server and on rebase, and never grant authority.
  All additions must be acknowledged before the version marker is sent. Partial
  failure retains changes for explicit sync recovery and a fresh preview.
  MCP upgrade uses the existing significant-write frozen preview, authenticated
  approval fixture, revision fences and resumable execution. It is not a new tool
  or an approval bypass. Targeted read-gated inventory refuses excessive results.
  Final upgrade browser coverage passes 18/18 projects, including reload,
  preservation, keyboard/touch, full-page axe and geometry. Focused checks pass
  105/105 in 13 files; a subsequent cache/permission interplay run passes 56/56
  in eight files (overlap). Compact light and tablet dark previews were inspected.
  See [the checkpoint](../roadmap/evidence/P7-pack-checkpoint.json).

## Pack matching and recovery rules

Exact deterministic installed IDs take precedence, surviving renames and moves.
Next come database keys and unique item keys or structural matches within the
known installation. A deleted or archived reserved ID stays reserved. Descendants
of unavailable parents are skipped; ambiguity prevents applying or marking the
version complete. Arbitrarily imported, renamed content with neither provenance
nor a verifiable installed identity is not guessed to belong to the pack.

Client inventory loads exact authored IDs and targeted page bodies/database views;
server inventory additionally follows the installed root subtree. Each bounded
inventory refuses overflow rather than silently certifying a partial plan. Client
plans over 450 additions require the reviewed MCP route. These limits protect the
existing sync and D1 budgets. Added views, pages and blocks are appended without
changing existing order values. No record answers, assignments or links are edited.

A guarded write has an absent-record or field-baseline precondition. Ordinary
session, permission, approval and CAS checks remain mandatory. Lost acknowledgements
accept only an exact immutable mutation replay; changed source is retained as an
item-wise rejection. A stale/rejected optimistic upgrade must not paint over newer
server fields during permission reconciliation or ordinary pull rebase.

## Decisions and constraints

The owner selected Asia/Kolkata and INR. The migration retains UTC until an
administrator configures a workspace; acceptance changes only disposable fixtures.
Disabled accounts retain their history and free an active place. Restoration
must atomically require capacity under seven active accounts, including guests.
Bootstrap still requires zero total users.

Keep the canonical permission kernels, Protocol 3 feeds, session/capability
fences, local `mutate()` and server `applyChanges()` paths. Server-only settings
must not enter synced collections. Cache server configuration only within its
request or scheduled phase. No paid provider calls or remote activation.

Date controls and their automation equivalent share one implementation. Verify
compact, tablet and desktop, keyboard/touch, light/dark, and Chromium/Firefox/
WebKit with the existing full-shell accessibility and control-geometry checks.
Each delivered workflow needs its own populated and recovery states. Physical
devices and human assistive technology remain separately named acceptance gates.

At phase end, commit source before a fresh full `npm run certify:ai`; preserve
failed attempts and bind all reports to the actual tested head. R1 evidence
cannot certify later Phase 7 changes.


## First full Phase 7 verification attempt

At clean `120d52879700204993b20ea600bfb210ec509498`, full UX completed
648/648 PASS (18 projects, zero failed/skipped/flaky, exit 0). The canonical
certificate remains FAIL/incomplete: unit 1641 PASS / 2 FAIL, dedicated D1
731 PASS / 1 FAIL (overlap); later mandatory workflows did not complete.
The process termination cause is unconfirmed and is not described as a fixed
application or sleep defect.

Two existing tests needed compatibility updates: stable templateItemKey metadata
is intentionally an authored key, while actual references still must remap; and
the directory race interceptor must match the added disabled-status column.
Explicit dangling-reference controls and the original concurrent downgrade/access
refusal assertions remain. Focused verification passes 36/36. These changes affect
only tests/documentation, with no runtime or browser-harness change from the full
UX source. A fresh canonical certificate and native harness runs remain required.


The second clean canonical attempt, at `79cc6e5`, completed all gates and
returned FAIL: 32/34 mandatory gates passed. Unit 1644/1644, dedicated D1
732/732 (overlap), security, release UI 21/21 and assistant 27/27 passed.
N17 corrects the canvas test's drag hit-point selection: nested comment buttons,
editors and resize handles cannot initiate body drags; covered items stay refused.
Three-engine negative controls reproduce the old helper failure and pass after
correction. Actual full v7 passes 114/114 with original movement assertions.
N18 corrects the rehearsal's missed 34-to-35 migration count; manifest/count
self-testing and the actual 12-checkpoint upgrade/restore rehearsal pass.
These are harness changes, not product gesture changes. A fresh clean certificate
and native harnesses remain required before Phase 7 acceptance.
