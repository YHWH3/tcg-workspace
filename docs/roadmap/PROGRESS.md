# Next phases progress

Execution started 2026-10-25. Release branch `sol/r1-date-window` is certified at `0888525`; active development
is `sol/p7-foundations`, stacked on that exact head. The release branch is based
on plan-only commit `6d02933` (application unchanged from `528b889`). Original
integration branches and existing PRs remain unchanged.

| Item | Status | Source / commit | Evidence | Notes |
|---|---|---|---|---|
| Plan base | done | 6d02933 | BASE-EVIDENCE.json; Git docs-only diff | Roadmap saved and historical acceptance corrected. |
| R0 historical base | verified | 528b889e6351a2955ca2c893725a89da088336c6 | BASE-EVIDENCE.json | Complete resumed 34/34 and five Safari simulator profiles / 25 journeys. Earlier failures retained. |
| D1 release target | owner selected | This chat, 2026-10-25 | Explicit owner reply | Certify R1's corrected head. |
| R1 N01 / N13 | implemented at 984328c; certification pending | 984328cd80dd4bb6ae309e98cf603731163c2092 | .artifacts/roadmap-r1/baseline-N01.json; focused-freeze.json | Baseline 3 failures reproduced. Focused 114/114 PASS, exit 0; actual-D1 permission modes, sorted/paged MCP/metric parity and validation. No migration. UTC/device timezone difference remains N02. |
| R1 UI / N14 | implemented at 984328c; final matrix pending | 984328cd80dd4bb6ae309e98cf603731163c2092 | .artifacts/roadmap-r1/browser-probe-2.log; browser-probe-3.log | Retained populated-editor contrast failure, then 2-project PASS. Visual review found shortened selectors; date controls now stack and have caption-width checks. Exploratory 18-project run invalidated by tracked source changes; final frozen-source run required. |
| R2 copy rehearsal | implemented at 984328c | 984328cd80dd4bb6ae309e98cf603731163c2092 | scripts/prod-copy-rehearsal.mjs; audit-prod-copy-rehearsal-d1.test.ts; parser self-tests | Synthetic 0001–0003 export passes 31 pending migrations, preservation, bounded real backfills and closed-copy restore. Wrong ledger HOLD before any migration. Four parser/path self-tests PASS. No owner production export available. |
| R2 runbook / N15 | prepared | Containing commit | RELEASE-RUNBOOK.md | Owner-only merge/staging/backup/migrate/deploy/reconnect. D1 cannot verify KV grants. Export with FTS has provider limitations. |
| R0 attempt 1 | FAIL, preserved | 984328cd80dd4bb6ae309e98cf603731163c2092 | .artifacts/certification/984328cd80dd4bb6ae309e98cf603731163c2092-2026-10-25T10-08-17-645Z-complete | Fresh canonical command completed: 33/34 gates PASS; unit 1551/1551, dedicated D1 675/675 (overlap), 89 harness checks. Release UI 16 PASS / 2 FAIL, WebKit 768/1024 hard-navigation diagnostics. No host pause. Never relabel this run. |
| N16 release UI harness | fixed; fresh certificate pending | Containing commit | .artifacts/roadmap-r1/release-ui-isolated-controls/results.json | Explicit API request tracking before hard navigation, bounded wait; isolated premature-navigation and uncaught-JS controls. Targeted 21/21 PASS (3 controls + 18 width cases), exit 0; all original error/axe/geometry checks remain. Earlier failed probes retained. |
| R1 date control matrix | targeted PASS | Parent application plus containing harness change | .artifacts/ux-lab/2026-10-25T13-52-35.508Z/summary.json | 18/18, exit 0, no retries/skips/flaky. Three engines × compact/tablet/desktop × light/dark. Compact screenshots inspected; full date operator captions readable. Does not replace full matrix. |
| R0 / R1 final candidate | ENGINEERING GO / EXTERNAL BLOCKED | 088852563d3fd2955f2f778f7563ef830db4906c | evidence/R1-0888525.json; evidence/R1-0888525.md; draft PR #15 | Fresh canonical 34/34, exit 0; unit 1551/1551; D1 675/675 (overlap); UX 576/576; Safari 25/25; final unmodified Android 17/17. Exact hashes and source fingerprints indexed. All successful owned devices removed. No deploy or genuine human approval claimed. |
| Android transport observation | retained; not reproduced in two fresh runs | 088852563d3fd2955f2f778f7563ef830db4906c | evidence/R1-0888525.json retainedFailures | First Android run 12 PASS / 2 FAIL / incomplete after Playwright device closure. Fresh diagnostic and unmodified qualification each 17/17. Source/assertions unchanged; first cause unconfirmed, no application fix claimed. Failed report and image preserved. |
| R3 production | owner-only; not executed | — | RELEASE-RUNBOOK.md | No merge, remote command, staging resource, deployment or external side effect. |
| D2 locale | owner selected | Explicit chat reply, 2026-10-25 | 00-baseline.md; 07-foundations.md | Asia/Kolkata and INR. |
| D3 disabled account capacity | owner selected | Explicit chat reply, 2026-10-25 | 00-baseline.md; 07-foundations.md | Free the place while disabled; restore requires active capacity. Retain history; enforce signup/guest redemption/restore; bootstrap counts total users. |
| D4 / D5 / D6 | owner selected | Explicit chat reply, 2026-10-25 | 00-baseline.md | All admins triage unassigned Website items; 0–2 / 3–7 / 8+ days, first-reply target 3 days; proposed attention sources accepted. |
| 7.0 / N10 | implemented and narrowly verified | Containing commit | scripts/certification/test-files.test.mjs | Shared selector covers Phase 4–13, audit and assistant D1 names; two self-tests PASS, exit 0; runner syntax check PASS. Actual Phase 7 D1 files will be added in 7.2/7.3 and included in the final gate. |
| 7.1 | next | — | 07-foundations.md | Structured date controls, within range, created-date comparison and shared validation. |
| 7.2 / 7.3 / 7.4 | not started | — | 07-foundations.md | Locale/currency, disable/restore, additive pack upgrades, in order. D2/D3 resolved. |
| Phase 7 certificate / PR | not run / not open | — | Full canonical and cross-platform verification required at phase end | Do not cite R1 results as Phase 7 acceptance. |
| Phases 8–13 / A | not started | — | README.md dependency order | Keep owner gates and one stacked draft PR per phase. |

Each implementation commit updates this file. “Containing commit” is bound by
Git history: a commit cannot contain its own full SHA. Source remains frozen
during final verification. Raw credentials, SQL exports, fixture state, logs,
screenshots and traces remain ignored/local; publish sanitized result summaries
with exact tested source identity in the draft PR. Current runs are authoritative
only when their source fingerprint, exit and mandatory completion all agree.

External gates remain physical hardware, human screen readers/native zoom,
genuine human acceptance, owner production backup/staging/provider/legal and
release decisions. Automated approvals are labelled disposable fixtures.
