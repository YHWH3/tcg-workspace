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


## Mandatory-run duplication found at the Phase8 boundary

At clean11c909c the unit gate timed out at1,200seconds without a complete
report. It scheduled all194test files; the following dedicated D1 gate then
scheduled75of those files again. The planned inventory was269file executions
for194unique files. This duplicates the same selected actual-D1 assertions,
not complementary browser or permission coverage. The original FAIL is retained.

The runner now discovers tests recursively and partitions that inventory into
the existing75-file D1 selection and its119-file complement. A harness check
proves disjointness, exact union and the continued inclusion of all cost
producers and legacy Website tests. Both exact selection lists are sealed with
their gate reports. The34mandatory gates and all assertions remain. Cost and
plan evidence is validated from its one D1 execution; deliberate extended
stress repeats remain. No per-test timeout, D1 binding budget or freshness rule
is weakened. This removes75duplicate file executions; no unmeasured timing
saving or passing final certificate is claimed.

The same run found a stale production-copy rehearsal assertion expecting32
pending migrations from a three-migration input. The rehearsal itself passed
and applied the correct33pending migrations. The regression now asserts their
exact registered names instead of an obsolete count. Baseline failure retained.


The first disjoint unit run completed in318seconds and found two stale
three-metric inventory assertions after the command-center fourth metric was
added. This was a gap in the initial affected-test selection: pack metric edits
need shared views/date tests as well as the new page's tests. Those regressions
now assert exact authored identities and actual old/new range equivalence;
production Home remains untouched. The original1146PASS/2FAIL is retained.
