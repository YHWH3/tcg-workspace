# Verification scope audit, 2026-11-03

The owner asked why execution was taking so long and whether tests were being
overdone. Read-only timing/selection analysis found excessive repeated scope.

## Evidence

| Run | Observed scope | Observed execution |
|---|---|---|
| Meetings final affected browser selection at acef300 | 486 cases, 18 projects | 1,731,358ms = 28.9 minutes of reported browser execution, excluding fixture setup |
| Forms initial committed-source focused run at f8ad32b | 577 tests / 56 files, plus 5 harness checks, typecheck and pack | Focused Vitest: 204.21 seconds; all checks PASS |
| Forms planned broad browser selection | 630 cases: 72 Forms, 558 other workflows | Stopped after visual N50; 35 reported PASS; original exit130 retained |
| Corrected Forms diagnostic | 12 cases across Chromium compact/light, Firefox tablet/dark, WebKit desktop/light | 37.0 seconds reported browser execution, plus fixture setup; all PASS |

Sources are the ignored source-bound reports in `.artifacts/phase8/`:
`meetings-actions-final-browser/summary.json`,
`forms-operations-final-focused-source.json`,
`forms-operations-final-focused.log`, `forms-operations-final-browser/summary.json`
and `forms-count-captions-corrected/summary.json`. Raw reports remain local.

The initial Forms change touched the canonical read gate, so authorization and
shared-read regression testing was justified. The N50 correction changes only
Forms count presentation plus its browser assertions and documentation. Repeating
577 tests, the 630-case browser selection and every preserved integration suite
for that presentation change is excessive. A fresh blanket source fingerprint
is not evidence that every earlier test's behavior changed.

A separate cause was late screenshot review: axe and page-root geometry passed,
but enlarged table captions still overlapped. Broad repeated runs do not replace
checking the rendered feature early. The new caption-range assertion reproduces
this exact defect. Two original new-harness failures (wrong title locator and a
request-release race) also consumed diagnostic time; they remain retained.

## Execution adjustment

1. During development, run tests for changed behavior and a small three-engine
   diagnostic. Inspect rendered captures before expanding the matrix.
2. At feature readiness, run the changed feature across the required engine,
   viewport and theme matrix. For the current correction this is **72 Forms
   cases**, not 630. Run typecheck/build because component/CSS output changes.
3. Keep the passing577-test result at its actual f8ad32b source. Verify unchanged
   server/shared/auth/migration/test inputs before retaining it. Do not claim577
   freshly executed tests at the later presentation commit.
4. Run additional shared regressions when a changed dependency or observed
   failure justifies them. Do not copy the previous feature's growing selection
   into every new fix. A shared authorization/schema/sync change warrants more
   coverage than a local count layout change.
5. At the Phase8 boundary, run the current mandatory certification manifest and
   full required feature matrix on the final integrated source. Preserve security,
   permissions, migrations, approval, sync, recovery and required device gates.
   This audit does not remove or downgrade any mandatory release gate.
6. Keep mandatory checks serial on this host. Earlier runtime contention and
   fixture-isolation evidence justify that constraint. Separate disposable
   fixtures preserve real account limits; do not raise limits to shorten tests.

No failure becomes PASS through this adjustment. Original failures, interruption,
source identities and missing engineering/physical/human evidence remain visible.
Full Phase8 certification is incomplete. This is an incremental test selection,
not a new release certificate or owner acceptance.
