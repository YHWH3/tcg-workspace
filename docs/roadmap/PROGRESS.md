# Next phases progress

Execution started 2026-10-25. This release branch is `sol/r1-date-window`, based
on plan-only commit `6d02933` (application unchanged from `528b889`). Original
integration branches and existing PRs remain unchanged.

| Item | Status | Source / commit | Evidence | Notes |
|---|---|---|---|---|
| Plan base | done | 6d02933 | BASE-EVIDENCE.json; Git docs-only diff | Roadmap saved and historical acceptance corrected. |
| R0 historical base | verified | 528b889e6351a2955ca2c893725a89da088336c6 | BASE-EVIDENCE.json | Complete resumed 34/34 and five Safari simulator profiles / 25 journeys. Earlier failures retained. |
| D1 release target | owner selected | This chat, 2026-10-25 | Explicit owner reply | Certify R1's corrected head. |
| R1 N01 / N13 | implemented in this commit; certification pending | Containing commit | .artifacts/roadmap-r1/baseline-N01.json; focused-freeze.json | Baseline 3 failures reproduced. Final focused 114/114 PASS, exit 0; actual-D1 permission modes, sorted/paged MCP/metric parity and validation. No migration. UTC/device timezone difference remains N02. |
| R1 UI / N14 | implemented in this commit; final matrix pending | Containing commit | .artifacts/roadmap-r1/browser-probe-2.log; browser-probe-3.log | Retained populated-editor contrast failure, then 2-project PASS. Visual review found shortened selectors; date controls now stack and have caption-width checks. Exploratory 18-project run invalidated by tracked source changes; final frozen-source run required. |
| R2 copy rehearsal | implemented in this commit | Containing commit | scripts/prod-copy-rehearsal.mjs; audit-prod-copy-rehearsal-d1.test.ts; parser self-tests | Synthetic 0001–0003 export passes 31 pending migrations, preservation, bounded real backfills and closed-copy restore. Wrong ledger HOLD before any migration. Four parser/path self-tests PASS. No owner production export available. |
| R2 runbook / N15 | prepared | Containing commit | RELEASE-RUNBOOK.md | Owner-only merge/staging/backup/migrate/deploy/reconnect. D1 cannot verify KV grants. Export with FTS has provider limitations. |
| R0 final candidate | pending full run | Containing commit | New .artifacts/certification/<SHA>-<timestamp>-complete | Run canonical npm run certify:ai, then native Safari and full 576-case UX matrix serially. No historical result counts as current. |
| R3 production | owner-only; not executed | — | RELEASE-RUNBOOK.md | No merge, remote command, staging resource, deployment or external side effect. |
| Phase 7 | not started | — | 07-foundations.md | Requires R1 verification and draft PR; D2/D3 needed for locale/disable. |
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
