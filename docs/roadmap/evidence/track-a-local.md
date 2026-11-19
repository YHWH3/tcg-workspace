# Track A local verification

**ENGINEERING GO / EXTERNAL BLOCKED.** Local tooling is ready for review.
Tested source `2c65e3394ad1f5cdb8d5f19ba84740ef7970f0a9`, tree `cce19dbf9e4c49f03524684794ca3d01d0dfd528`,
fingerprint `4b727804c9b76c267331cbf958ff2f29354a4a3fe14148ee4ea1d77d32527d20`.

| Check | Observed result |
|---|---|
| Local SQL inventory and rehearsal | Synthetic 0035 prefix accepted. Nine registered migrations applied to a disposable copy through 0044. The permission-off baseline, local activation, two account manifests and three account-to-space backfill scans passed. |
| Browser sync rehearsal | 33/33 passed, with 11 in each of Chromium 153.0.8010.12, Firefox 155.0 and WebKit 26.6. The browser journeys used new synthetic fixtures. |
| Restricted content | 13/13 checks passed on a real local Worker over HTTP and OAuth/MCP. A negative control with broader access correctly returned HOLD. |
| Inventory guards | Local backup contents survived inventory. The harness detected an orphan and refused an unregistered ledger and a URL input. |
| Simulated email | 1 targeted test passed. A fixture with readable titles enabled dropped the private title after revocation. |
| Typecheck and MCP helper regressions | `npm run typecheck` passed. Both MCP helper checks passed. |
| Dependency audit | `npm audit --audit-level=high --json` passed with zero reported vulnerabilities. |

An initial browser rehearsal completed the 33 journeys but returned HOLD because
the verifier source changed during the run. The final run started and ended
on the clean source above. Earlier fixture failures and the broader-access
negative control remain in local artifacts.

The imported SQL was used for the actual server manifest and backfill. Offline
restart, tab fencing, quarantine, revocation and regrant, peer relations, cached
file eviction and stale requests were exercised in the synthetic browser
fixtures. Physical devices, human assistive technology, hosted staging and a
current production restore are deferred. Live activation requires R3, the
Phase 7.3 merge and D11.

## Reproduction

```sh
npm ci
node --test scripts/access/selftest.mjs
node scripts/access-inventory.mjs /absolute/private/synthetic-0035.sql
node scripts/access-rehearsal.mjs /absolute/private/synthetic-0035.sql
node --test scripts/certification/mcp-client.test.mjs
npx vitest run tests/phase10-notification-email-d1.test.ts -t 'escapes readable titles and uses generic text after access revocation'
npm run typecheck
npm audit --audit-level=high --json
```

The self-test prints the local path of the generated synthetic SQL. The
following local reports are retained under the Track A worktree's ignored
artifacts directory. Share this summary with reviewers. Keep private reports,
SQL and browser traces local.

| Report | SHA-256 |
|---|---|
| `.artifacts/access-readiness/rehearsal-rMxAJa/rehearsal.json` | `87ad93abdb332ec7123c6ff105c1a45339a264396b9f8dba2378fb4a9def7797` |
| `.artifacts/access-readiness/rehearsal-rMxAJa/browser/result.json` | `b77b993db368ddd45ab873ebd9bfc761286bfa65590c757d8b665c41ec95be40` |
| `.artifacts/access-readiness/selftest-transport-WQOyna/restricted.json` | `8afc1d5ffa70a2123501c4350464d1d887e60e1c7af5261b6e47dfdd2110467d` |
| `.artifacts/access-readiness/selftest-transport-WQOyna/broadened.json` | `7c29a41efb38b0b9ed87934636b407050642a341448939253637b9a575c0e68d` |
| `.artifacts/access-readiness/npm-audit.json` | `995d66cafecad031e7047b4386b00a530393c69b3a52ec43fb83afcdaede8726` |
