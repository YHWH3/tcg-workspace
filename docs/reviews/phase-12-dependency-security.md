# Phase 12 dependency security checkpoint

Checked 18 November 2026. **Decision: HOLD.** Earlier passing certificates
remain historical evidence for their own source and date.

## Blocking advisory

[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) was
reviewed and updated on 17 November 2026. It affects `picomatch <=4.0.7` and
lists no patched version. `npm view picomatch dist-tags` reports latest
`4.0.7`. A registry request for `4.0.8` returned 404.

The audit reports 14 high package entries propagated from this single ReDoS
advisory through Vite/Vitest, Rollup plugins and Agents' Babel plugin dependency.
Package entries are not distinct vulnerabilities. The current classifier
rejects all high and critical entries without exceptions. A reachability
assessment cannot turn this result into PASS under that policy.

## Compatible fixes applied

- `hono` moved from `4.13.13` to `4.13.19`, with an exact dependency pin.
- `@hono/node-server` moved from `2.1.3` to `2.1.6`, with an exact transitive override.
- Only these two package resolutions changed in the lockfile.
- `npm ls --all`, typechecking and the production build exit 0.
- All 150 certification harness checks pass.
- On committed source `c6c4c9e`, focused MCP checks pass 94/94 and canvas MCP checks pass 113/113. Both use disposable fixtures and validated complete reports.

The updated audit exits 1 and reports 14 high, two moderate and zero critical
package entries, 16 entries in total. The remaining moderate roots are
[glob](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) and
[minimatch](https://github.com/advisories/GHSA-g3hv-75wg-m249).

Exact sources, artifact hashes and counts are recorded in
[the HOLD evidence](../roadmap/evidence/P12-certification-hold.json).
No patched package version, advisory exception, forced downgrade or hidden
replacement was introduced.

## Testing cost and continuation

Source `1689393` passed 1,195 unit and 976 actual-D1 checks. The actual resume
verified five reused gates, including unit results, saving about 6.19 minutes.
The old EEXIST resume failure is fixed. After a known security failure, the
remaining run was stopped. Its partial MCP Phase 2 output remains retained.

The security gate previously followed the long unit and D1 gates. It now runs
immediately after dependency and lockfile validation. A failed assessment ends
the run while retaining its raw audit and every mandatory gate.

A clean committed-source run on `c6c4c9e` proved the early stop. Prerequisites,
dependency and lockfile gates passed, security failed, and all 30 remaining
gates stayed NOT RUN. No unit or D1 result file was created. The security check
took 1.3 seconds. No required assertion or gate was removed.

When a genuine patched dependency is available, verify its published version
and compatible dependency graph, update exact pins, run the cheap audit first,
then certify a clean committed source. Passing tests on `1689393` cannot certify
the updated dependency tree. Phase 13 remains unstarted under README section 4.
Its source inspection and implementation notes are saved in
[the Phase 13 preflight](../roadmap/13-polish-preflight.md).

## 19 November clearance

GitHub withdrew GHSA-fc5q-39xc-vjpf on18 November2026 at15:38:56 UTC.
The fresh audit reports zero vulnerabilities. The complete resumed certificate
on`fb3a0bd` passes all34 mandatory gates. Source identity, security output
hashes and reused evidence are indexed in
[the accepted certificate](../roadmap/evidence/P12-certification.json).
The earlier HOLD assessment above records the advisory state at that time.
