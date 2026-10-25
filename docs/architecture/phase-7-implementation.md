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
- **7.1–7.4:** not yet implemented. Follow
  [the ordered feature specification](../roadmap/07-foundations.md).

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
