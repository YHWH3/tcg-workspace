# Local certification and safe resume

The canonical command is `npm run certify:ai`. It runs the current mandatory
manifest against disposable local fixtures. No production deployment, remote
migration, paid inference or genuine human approval is established by this
certificate. Physical-device and assistive-technology gates remain separate.

Commit source first and leave the checkout unchanged until the command ends:

```sh
npm run certify:ai -- --keep-awake
```

On macOS this starts `caffeinate -dims -w <orchestrator pid>` and stops it at
exit. No system power setting changes. Closing the lid or explicit sleep can
still suspend the Mac. Every five seconds a monotonic heartbeat checks elapsed
time; a gap over 90 seconds records `hostPauses` and cancels the current gate as
**INTERRUPTED**. The remaining gates are NOT RUN. The resulting decision is
PARTIAL and `summary.json` has `resumable: true`; an interrupted run never passes.

To continue using verified completed gates, supply the exact earlier directory:

```sh
npm run certify:ai -- --keep-awake --resume /absolute/checkout/.artifacts/certification/<previous-directory>
```

The command creates a new certificate directory. It never edits or deletes the
earlier directory. Each gate is independently eligible only with a complete
fresh PASS, matching committed SHA and source fingerprint, clean starting and
current trees, identical flags/permission contract, exact Node/Playwright/engine
versions, age at most 24 hours, and completion before the first recorded pause.
Every recorded artifact must still match its SHA-256. Failed, interrupted,
missing, ambiguous or previously reused gate results rerun. Changing source
invalidates reuse, even for a documentation change. Explicit `--ai`, `--phase6`,
`--quick` and `--extended` flags must match; `--keep-awake` is not a test mode.

Prerequisites, dependencies, lockfile, security audit, source integrity,
performance evidence and browsers always run fresh. Performance evidence is
recomputed from verified copied unit/D1 metrics. Every newly run integration
gate uses its own disposable fixture. A reused build restores its verified
build snapshot; any existing local `dist` is retained inside the new ignored
certificate directory before restoration.

PASS gates seal their log, process registry and known gate artifact trees in
`summary.json` and `test-results.json` when complete, after fixture cleanup.
The build also seals its generated `dist` snapshot. Fixture state outside the
certificate directory is disposable runtime state, not reusable evidence.
Historical certificates without these sealed manifests rerun all gates.
Copied artifacts preserve their original source identity and timestamps.

The report heading says **Resumed certificate (N gates reused from <dir>)**.
Its per-gate Reused column and `summary.json.resumed` name the original results
and hashes. `minutesSaved` sums original durations of reused gates; it is time
avoided, not a timing comparison between different hosts. Report resumed status
and exact tested SHA in PROGRESS.md and any PR description. A resumed PASS still
requires every current mandatory gate to pass, freshly or by verified reuse.
Quick mode can never establish complete local certification.

## Tooling verification

```sh
node --test scripts/certification/*.test.mjs
```

The pause test hook is opt-in, labels the simulated pause in `summary.json`,
and does not simulate application results. On a clean local branch run:

```sh
CERT_TEST_HOOKS=1 CERT_TIMEOUT_MS=2400000 npm run certify:ai -- --keep-awake --test-pause-after=d1
npm run certify:ai -- --keep-awake --resume <directory-from-the-first-command>
```

The first command intentionally exits nonzero with PARTIAL after completing
real unit and D1 gates. The next gate is INTERRUPTED before execution. The
second command verifies and reuses unit/D1, runs the remaining mandatory gates,
and records minutes saved. Keep both original reports. Never represent the
simulated pause as an observed host sleep, or fixture approvals as human review.
