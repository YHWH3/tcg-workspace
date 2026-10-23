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

The command builds the app, creates a fresh disposable D1 fixture on a free loopback HTTPS port, seeds synthetic records, runs tests, and stops only its own Worker. Its seven-day self-signed certificate lives in ignored `.artifacts/ux-lab/tls/`; the key is mode 0600. Node trusts it only in the command's child process. Browser TLS exceptions are confined to disposable test contexts/processes; Chromium's launch-scoped exception avoids an observed local stylesheet transport failure. No device/system trust is changed. External browser requests are blocked. No public tunnel, cloud resource, paid inference or production data is used. Permissions are enabled only in the disposable fixture.

Outputs are under `.artifacts/ux-lab/<timestamp>/`:

- `coverage.html`: named feature/state × browser/size/theme coverage, including NOT RUN cells;
- `html/index.html`: Playwright report with screenshots, accessibility findings and failure traces;
- `summary.json`: source SHA/fingerprint, exact engine builds, selection, exits, missing cells and random-sequence replay details;
- `fixture/`: owned process, migration and local Worker evidence.

Reports/traces are local-only and may contain disposable session credentials. Do not publish raw traces, fixture-session files or their embedded resources. Publish a sanitized result summary instead.

## What is tested

The explicit matrix is Chromium/Firefox/WebKit × 390/820/1440px × light/dark: 18 projects. The catalog covers 20 named rendered states: home/page, database index, six record views, task detail, moodboard/form/automation empty states, approvals, Activity, Inbox, Settings, AI library with inference off, Website dashboard and Website inbox.

The complete plan has 30 cases × 18 projects = 540 cases. Additional cases open filter/sort/property controls, add and remove a filter/sort, test empty-search/focus recovery, inject an approval-network failure and recover, exercise every avatar colour, scroll to the table's rightmost fields, and enlarge text to 200%. Text enlargement is a CSS simulation, not native browser zoom. Compact layouts have touch capability configured; this is not physical-device evidence.

Fast-check generates bounded sequences of stage changes, Unicode/long title edits, offline edits, reloads, breakpoint changes, theme changes and keyboard search. It compares title/stage with a small model and verifies server persistence before reload. Every generated case resets its starting viewport/theme/connectivity; failures retain seed, shrink path, command sequence and a replay command. The default is three generated sequences per project, each with 6–14 commands. This is bounded exploration, not all possible sequences.

The task-draft regression checks that focus alone writes nothing, updates a focused unedited field when synchronized source changes, preserves both text fields through offline edits and a responsive remount, verifies that all wrapped lines are visible, and confirms server persistence and reload.

The negative control deliberately recreates the old clipped-select CSS in a disposable page, requires the geometry detector to reject it, then removes it and requires a pass. The production stylesheet is never modified by that test.

Whole-page axe scans include the shell and open overlays. No rule, failed node or shell region is excluded to manufacture a pass. A stylesheet failure is a failed render and is identified before accessibility assertions.

## References and acceptance

Visual references stay in `.artifacts/ux-lab/baselines/`, with capture provenance. They are deliberately local to this OS/browser/font environment. `--record` is explicit; ordinary runs never update a reference to hide a difference. Missing images or differences fail the ordinary run. A generated reference is not a reviewed design. The report retains that distinction even after a matching comparison passes. Fresh machines need their own reference capture and review; the current local images must not silently become Linux CI references.

Use the existing `npm run certify:ai`, Website UI gate and native review alongside this lab. A partial `--project`/`--grep` run cannot count as full-matrix acceptance. Failures, missing mandatory workflows and unavailable internal evidence remain engineering HOLD. Physical hardware, native keyboards/media/OS popups, manual assistive technology and genuine human approval remain separately named gates. Other editor/canvas/public-form/account/AI states are not certified by merely visiting their parent module's route.

Before changing the catalog, update `requiredCases` with the exact test names. Coverage uses an explicit plan, so a missing case cannot quietly disappear from the report.
