# Local UX lab

This adds visual comparisons, rendered geometry checks, whole-page accessibility checks and repeatable generated interaction sequences to the existing workflow suites. It does not replace the release certificate or establish exhaustive feature/device coverage.

## Run it

Use the lockfile dependencies (`npm ci`) and installed Playwright engines. From this checkout:

```sh
# Capture reference images explicitly; this is not design approval.
npm run qa:ux -- --record --grep='visual reference'

# Run the full matrix against those references.
npm run qa:ux

# Narrow investigation; the coverage report marks other cells NOT RUN.
npm run qa:ux -- --project=webkit-compact-dark

# More generated scenarios, with a repeatable seed.
UX_SEED=20261024 UX_RUNS=10 npm run qa:ux -- --grep='seeded interaction'
```

The command builds the app, creates a fresh disposable D1 fixture on a free loopback HTTPS port, seeds synthetic records, runs tests, and stops only its own Worker. Its seven-day self-signed certificate lives in ignored `.artifacts/ux-lab/tls/`; the key is mode 0600. Generated certificates renew automatically when less than a day remains; supplied certificate files are never overwritten. Renewal restarts the owned Node process to load the new CA. Node trusts it only in the command's child process. Browser TLS exceptions are confined to disposable test contexts/processes; Chromium's launch-scoped exception avoids an observed local stylesheet transport failure. No device/system trust is changed. External browser requests are blocked. No public tunnel, cloud resource, paid inference or production data is used. Permissions are enabled only in the disposable fixture.

Outputs are under `.artifacts/ux-lab/<timestamp>/`:

- `coverage.html`: named feature/state × browser/size/theme coverage, including NOT RUN cells;
- `html/index.html`: Playwright report with screenshots, accessibility findings and failure traces;
- `summary.json`: source SHA/fingerprint, exact engine builds, selection, exits, missing cells and random-sequence replay details;
- `fixture/`: owned process, migration and local Worker evidence.

Reports/traces are local-only and may contain disposable session credentials. Do not publish raw traces, fixture-session files or their embedded resources. Publish a sanitized result summary instead.

## What is tested

The explicit matrix is Chromium/Firefox/WebKit × 390/820/1440px × light/dark: 18 projects. The catalog covers 21 named rendered states: home/page, database index, six record views, task detail and unavailable task, moodboard/form/automation empty states, approvals, Activity, Inbox, Settings, AI library with inference off, Website dashboard and Website inbox.

The current required plan has 55 cases × 18 projects = 990 cases; `requiredCases` in `scripts/ux-lab/catalog.mjs` is authoritative. Historical phase counts below keep their original source. Additional cases open filter/sort/property controls, add and remove a filter/sort, test empty-search/focus recovery, inject an approval-network failure and recover, exercise every avatar colour, scroll to the table's rightmost fields, and enlarge text to 200%. Text enlargement is a CSS simulation, not native browser zoom. Compact layouts have touch capability configured; this is not physical-device evidence.

Fast-check generates bounded sequences of stage changes, Unicode/long title edits, offline edits, reloads, breakpoint changes, theme changes and keyboard search. It compares title/stage with a small model and verifies server persistence before reload. Every generated case resets its starting viewport/theme/connectivity; failures retain seed, shrink path, command sequence and a replay command. The default is three generated sequences per project, each with 6–14 commands. This is bounded exploration, not all possible sequences.

The task-draft regression checks that focus alone writes nothing, updates a focused unedited field when synchronized source changes, preserves both text fields through offline edits and a responsive remount, verifies that all wrapped lines are visible, and confirms server persistence and reload.

The negative control deliberately recreates the old clipped-select CSS in a disposable page, requires the geometry detector to reject it, then removes it and requires a pass. The production stylesheet is never modified by that test.

Whole-page axe scans include the shell and open overlays. No rule, failed node or shell region is excluded to manufacture a pass. A stylesheet failure is a failed render and is identified before accessibility assertions.

## References and acceptance

Visual references stay in `.artifacts/ux-lab/baselines/`, with capture provenance. They are deliberately local to this OS/browser/font environment. `--record` is explicit; ordinary runs never update a reference to hide a difference. Missing images or differences fail the ordinary run. A generated reference is not a reviewed design. The report retains that distinction even after a matching comparison passes. Fresh machines need their own reference capture and review; the current local images must not silently become Linux CI references.

Use the existing `npm run certify:ai`, Website UI gate and native review alongside this lab. A partial `--project`/`--grep` run cannot count as full-matrix acceptance. Failures, missing mandatory workflows and unavailable internal evidence remain engineering HOLD. Physical hardware, native keyboards/media/OS popups, manual assistive technology and genuine human approval remain separately named gates. Other editor/canvas/public-form/account/AI states are not certified by merely visiting their parent module's route.

Before changing the catalog, update `requiredCases` with the exact test names. Coverage uses an explicit plan, so a missing case cannot quietly disappear from the report.

Task draft recovery checks settle the in-flight foreground reads after switching offline, click the actual editor, and assert focus and each entered value immediately before crossing the responsive boundary. This distinguishes a received edit from a fill attempted while the control was remounting. Persistence, reconnect and reload assertions remain mandatory, without automatic test retries. Diagnostic sync recovery uses the protocol minimum of eight rows.

Accessibility tags are shared with the Website/release UI gates in `scripts/accessibility-tags.mjs`: all A and AA levels through WCAG 2.2. The negative-control case must catch both clipped controls and an intentionally mismatched visible/accessibility label, then pass on the restored page. This protects against a tag selection that silently omits a level-A rule.

Geometry checks also measure the fixed “No grouping” caption's rendered text width against the selector content box. This is scoped to that fixed caption, not a claim that every arbitrary user value fits every bounded field. The negative-control case narrows the selector, requires detection, restores it and runs the full-page audit.

Native Android setup uses one public widget driver, with real positive/negative lookup probes and prompt-disappearance checks. The pinned 1.63 Java bridge's exact missing-widget lookup response is handled explicitly; generic errors and transport failures are not absence. See QA-TOOLS.md for the upstream source and retained diagnostics. Record-view state readiness includes the rendered toolbar before geometry/accessibility scanning.

R1 adds a relative-date case for the filter overlay and a populated, disabled automation. It verifies date syntax hints and accessible descriptions, bounded filter results, focus recovery, geometry and whole-page axe in every project. The earlier 558-case evidence remains tied to its older source.

Release UI hard-navigation readiness is separate from this lab. The runner
tracks foreground `/api/` requests and waits for completion and a short quiet
window before document teardown. A stalled read fails within 20 seconds. Each
engine tests deliberate premature navigation, successful read completion before
navigation, and visibility of an injected uncaught JavaScript error. Negative
controls use separate pages so deliberately cancelled requests cannot pollute
the positive tracker. No error filtering is added. The release UI runner now
contains 21 checks: 18 viewport journeys and three engine controls.

Phase 7 adds structured relative/absolute date controls and inclusive ranges.
The range workflow creates a view through keyboard controls, checks persisted
bounds, invalid offset refusal, reload recovery and touch presets, then reaches
the bottom action in the compact filter sheet. Native select text search is
used for keyboard acceptance on macOS headless engines; every selection is
asserted. The named date workflow replaces R1’s free-text hint interaction.

The locale case edits Workspace settings through the authenticated UI, checks invalid input, verifies its account-specific offline cache and opens a populated INR metric. Fixture settings are restored after each project. These actions affect only the disposable local workspace.

Phase 7 locale coverage also opens the populated field editor, refuses an invalid
currency override, stores and clears an explicit override, measures the empty
new-name placeholder and creates a Number field through keyboard/touch controls.
Dashboard comment actions use normal flow so they cannot cover Configure actions.
The test reads the rendered metric total for drill-down, retaining its native
visible-text accessible name. Normal hard navigation/reload waits for API reads.
The bounded WebKit handled-read recovery list includes the new settings GET only
when an actual authenticated 200 response has valid timezone/currency/week/version;
self-tests require offline, invalid, unauthorized and failed responses to refuse.
Real window errors/rejections, unmatched diagnostics and all axe nodes still fail.


Phase 7 account coverage disables and restores a member, checks another tab's
reauthentication, retained assignments, recovery from a simulated restore outage,
keyboard confirmation and full-shell accessibility. The operating-pack workflow
starts from a synthetic pre-key/version-1 install, preserves renamed fields/views,
a changed filter and a deleted block, previews all additions, applies currency
formats and a missing view, then reloads and verifies an empty second plan.
Each project resets only stable pack IDs inside the provenance-verified owned
local fixture. Private fixture-session metadata never goes into published evidence.
The 648-cell complete plan is required; these targeted matrices alone are partial.


The separate v7 canvas runner uses `scripts/canvas-hit-point.mjs` to choose an
exposed body point. It rejects nested interactive controls, editors, resize
handles and fully covered items. Three-engine static overlap controls reproduce
the old comment-button selection before verifying the correction. Actual movement,
persistence and hit-test semantics remain mandatory; no product events are bypassed
to make the geometry assertion pass. This change does not alter the UX lab matrix.

Phase8 Project cockpit checks follow signals across databases, guarded offline
owner/date edits, concurrent-edit refusal, configuration server acknowledgement,
empty/error/source-change recovery and default/customized record bodies. At200%
CSS text they measure the full dashboard heading and project title, then reach
both Refresh and the owner/date action. Root document overflow alone cannot catch
a title spilling inside a clipped ancestor. The fresh-edit reliability case holds
a real pending edit, checks for false unknown-age attention, then verifies server
receipt and queue removal. Full phase acceptance still requires the complete
current plan; the focused90/378 selections keep their separate source identities.
