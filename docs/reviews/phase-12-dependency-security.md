# Phase12 dependency security checkpoint

Checked18 November2026. Decision HOLD. This is a current audit update; earlier
passing certificates remain historical evidence for their own source and date.

## Blocking advisory

[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) was
reviewed/updated17 November2026. It affects picomatch<=4.0.7 and lists no
patched version. npm view picomatch dist-tags reports latest4.0.7. A request
for4.0.8 returned404. No package version was invented or installed.

The audit reports14 high package entries propagated from this single ReDoS
advisory, including Vite/Vitest, glob consumers, Rollup plugins and Agents'
Babel plugin dependency. Package entries are not distinct vulnerabilities.
The current classifier rejects all high/critical entries without exceptions.
No reachability argument can turn this result into PASS under that policy.

## Compatible fixes applied

- hono4.13.13 to4.13.19, exact dependency pin.
- @hono/node-server2.1.3 to2.1.6, exact transitive override.
- Only these two package resolutions changed in the lockfile.
- npm ls --all exits0. Typecheck/build and150 harness checks pass.

The raw audit after these updates exits1 and reports14 high,2 moderate,
0 critical,16 total package entries. Remaining moderate roots are
[glob](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) and
[minimatch](https://github.com/advisories/GHSA-g3hv-75wg-m249).
Raw local reports are in .artifacts/tooling/security-after.json and
dependency-tree-after.json. A machine-readable checkpoint will record hashes
and committed-source early-stop evidence in the roadmap evidence directory.

## Testing cost and continuation

The18 November1689393 run passed1195 unit and976 actual-D1 checks, but the
security gate previously followed those long gates. The runner now checks
security after dependency/lockfile validation. A failed assessment ends the
run, retaining the raw audit and marking all later mandatory gates NOT RUN.
No required check or assertion has been removed.

The actual resumed run verified five reused gates, including the unit result.
The old EEXIST defect is fixed. The stopped run's MCP Phase2 partial output
is preserved and must not be called complete passing evidence.

When a genuine patched dependency becomes available, verify its published
version and compatible dependency graph, update exact pins, run the cheap
audit first, then certify a clean committed source. The current source differs
from1689393, so its passing long gates are historical and cannot certify this
updated dependency tree. Phase13 remains unstarted under README section4.
The read-only implementation notes are saved locally in
.artifacts/tooling/phase13-inspection.md.
