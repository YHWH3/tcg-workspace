# Local Phase 0–4 certification

From the Desktop checkout, run:

```sh
npm run certify:phase4
```

The command owns installation checks, browser binaries, static checks, the full
unit and actual-D1 suites, build, migrated disposable Workers, fixture users,
OAuth/MCP integration, smoke and v4/v6/v7/v8/v9 browser journeys. It requires no
prestarted server or personal database. Internet is needed for initial npm and
Playwright downloads and current npm advisory analysis; application tests use
loopback Workers without remote AI bindings.

`npm run certify:phase4:quick` runs prerequisites, dependency/lock integrity,
whitespace, migration checks, certification selftests, TypeScript, complete unit
suite, build, actual-D1 regression and advisory analysis. Use after a small
change. Quick results never establish full certification.

`npm run certify:phase4:full` runs the complete matrix plus two additional
actual-D1 stress/reliability repetitions. Use before substantial reliability
changes or an unattended extended run. No hook or launchd schedule is enabled.

`CERT_TIMEOUT_MS=1800000 npm run certify:phase4` adjusts the per-suite limit.
Startup/SQL have separate bounded limits in the disposable fixture utility.
Independent later suites continue after an assertion failure. A failed build
marks dependent integrations NOT RUN; they never silently reuse old output.
Vitest uses one worker because the actual-D1 files each start Workerd;
this limits competing fixture RPCs while preserving the complete test matrix.
v9 supplies explicit successive Cron event times to Wrangler's scheduled test
endpoint. Phase rotation uses the event's scheduled time; lease, retry and
deadline clocks remain current. The report records those simulated times and
tests two concurrent invocations with the same scheduled timestamp.

Each invocation creates `.artifacts/certification/<starting-SHA>-<UTC-time>-<mode>/`.
The ignored folder holds JSON and Markdown summaries, exact commands and exit
codes, OS/Node/browser versions, full suite logs, structured assertions,
screenshots/traces on failures, migration hashes/SQLite schema, vulnerability
output and local D1 metrics. Raw databases remain isolated in OS temporary
folders with generated all-zero local binding IDs. No personal `.wrangler/state`
is used. `fixture.json` records provenance for each database; incompatible
suites always receive fresh state. The base MCP deleted-user check receives only
that fixture's exact config/state paths.
Every stage has an explicit `fixtureId`: generated Worker provenance, a
SHA/stage-scoped identifier for isolated in-process Miniflare suites, or
`not-applicable` for stages that use no application database.

Processes get dedicated groups. Cleanup sends signals only to groups created
by this invocation. Port probes reject collisions without adopting or stopping
an existing server. Local URLs reject remote hosts and embedded credentials.
No deployment, merge, cloud resource creation or Git operation is part of the
certification command.

The historical run on `4611193` exited FAIL; it is retained in the remediation
ledger. Subsequent corrections address dialog Escape/focus restoration, the
collapsed Related group and deterministic WebKit public-form fault injection.
The authoritative result for any run is its generated `summary.json` and
`report.md`, with the exact tested SHA and source fingerprint. Do not reuse an
earlier result to certify a newer SHA.

A successful exit requires every applicable mandatory stage and assertion.
Suite throws, failed launch, timeout, signals, nonzero exit, empty JSON,
malformed/truncated reports, missing assertions and mandatory NOT RUN prevent a
PASS. The smoke adapter validates its ordered assertion manifest and terminal
counts, not the text `ALL PASS`. Vitest JSON must contain all expected test
files and test counts. Browser/MCP JSON must complete explicit manifests.
The harness selftests deliberately exercise these failures, including the C16
complete-runner crash regression.

The mandatory `performance-evidence` gate checks both complete unit and targeted
D1 metric artifacts. It requires the 1,000-record fixture, query plans and every
named workload; missing files fail certification. Measurements include binding
calls, SQL statements, rows read/written, cursor reads/writes and candidate scans.
C14/C15 calls are exercised with the production 45-call budget. Browser timing
records are also required in complete mode. These are local measurements, not
Cloudflare billing or deployed latency evidence.

The report records both the commit and a SHA-256 source fingerprint. Changes
during a run invalidate certification. Checkpoints preserve evidence, but are
not reused to certify a different source. A final acceptance run must execute
the entire applicable local matrix again after all source changes are committed.

Physical iPhone/iPad Safari, physical Android, native browser zoom and manual
assistive technology remain separate production release gates. Chromium,
Firefox, WebKit and 320px reflow evidence does not imply physical-device or
screen-reader acceptance. No manual browser coordination is required for the
automated journeys.

The integrity remediation adds migration 0011, three actual-D1 integrity/undo
families, IndexedDB archive tests and the shared block mapper regression. They
are automatically discovered by the existing unit/D1 gates. The MCP Phase 4
manifest now includes generic database archive/restore, 101-item undo, guarded
501-block edit/replay, record mentions and embed persistence. v9 adds offline
attachment deletion with persistent-profile browser restart, offline database
archive/restore and rendered embed links in each engine. No additional command
or server is required. Large guarded MCP edits require a stable `requestId`;
a retry resumes the frozen operation and its original changeset. Conflicted
large undo reports a partial state and inverse journal rather than implying all
records were restored. The remediation ledger records each P4-INT reproduction.

On macOS the orchestrator holds a temporary `caffeinate -i` idle-sleep assertion
for its own lifetime and records it in `environment.json`. It stops only the
assertion it created; it never changes system power settings. Explicit lid
closure can still suspend the Mac and invalidate a run. Such timeouts/RPC
failures remain FAIL and require a new complete invocation after wake.
