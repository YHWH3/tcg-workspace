import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { fixtureEnvironment } from './phase4-fixture.mjs';
import { fingerprint } from './certification/core.mjs';
import { inventory } from './access-inventory.mjs';
import { applyPending, newReport, rows, withDump, writeReport } from './access/dump.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [input, quota = '450', ...extra] = process.argv.slice(2);
const quotaMiB = Number(quota);
if (!input || extra.length || !Number.isSafeInteger(quotaMiB) || quotaMiB < 1 || quotaMiB > 1024 * 1024) {
  console.error('Usage: node scripts/access-rehearsal.mjs /private/dump.sql [quotaMiB]');
  process.exit(2);
}
const folder = newReport('rehearsal');
const report = {
  status: 'HOLD', source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  fingerprint: fingerprint(root), checks: [],
};
let stage = 'local_dump_import';
try {
  const { outputFiles } = await build({
    entryPoints: [join(root, 'scripts/access/rehearsal-worker.ts')],
    bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false,
  });
  await withDump(input, async ({ db, dispatch, inputSha256, applied, pending }) => {
    report.inputSha256 = inputSha256;
    report.inputMigrations = applied.length;
    report.appliedMigrations = pending.map(({ name }) => name);
    const before = await inventory(db, quotaMiB);
    assert.deepEqual(before.blockers, []);
    report.checks.push({ name: 'Inventory and permission-off baseline', status: 'PASS' });
    stage = 'migration_and_activation';
    await applyPending(db, pending);
    const after = await inventory(db, quotaMiB);
    assert.deepEqual(after.blockers, []);
    assert.deepEqual(after.accounts, before.accounts);
    assert.deepEqual(after.recordsBySpace, before.recordsBySpace);
    await db.prepare('UPDATE access_state SET enabled=1 WHERE id=1 AND enabled=0').run();
    const response = await dispatch('/manifest-rehearsal');
    assert.equal(response.status, 200);
    const counts = await response.json();
    assert.ok(counts.activeAccounts > 0 && counts.joinedSpaces > 0);
    assert.equal((await rows(db, 'SELECT enabled FROM access_state WHERE id=1'))[0].enabled, 1);
    report.checks.push({ name: 'Migrated copy activation, existing account manifests and bounded backfill', status: 'PASS', ...counts });
  }, outputFiles[0].text);
  stage = 'browser_journeys';
  // The existing browser harness bootstraps its own synthetic accounts on new
  // D1s. It never receives the imported SQL or anybody's credentials.
  const browserArtifacts = join(folder, 'browser');
  mkdirSync(browserArtifacts, { mode: 0o700 });
  const resultPath = join(browserArtifacts, 'result.json');
  const args = ['scripts/verify-phase5-sync.mjs'];
  report.browserCommand = ['node', ...args];
  const exit = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root, env: { ...fixtureEnvironment(), CERT_ARTIFACT_DIR: browserArtifacts, CERT_RESULT_PATH: resultPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk =>
      writeFileSync(join(browserArtifacts, 'runner.log'), chunk, { flag: 'a', mode: 0o600 }));
    const interrupt = () => child.kill('SIGTERM');
    process.once('SIGTERM', interrupt);
    process.once('SIGINT', interrupt);
    child.on('error', reject);
    child.on('close', code => {
      process.removeListener('SIGTERM', interrupt);
      process.removeListener('SIGINT', interrupt);
      resolve(code);
    });
  });
  assert.equal(exit, 0);
  const browser = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(browser.status, 'PASS');
  assert.equal(browser.allMandatoryAssertionsExecuted, true);
  assert.equal(browser.summary.pass, 33);
  report.checks.push({ name: 'Offline queue, two profiles, tab and restart fences, quarantine, revoke/regrant, peers, bytes and delayed responses', status: 'PASS', browser: browser.summary });
  stage = 'source_stability';
  assert.equal(fingerprint(root), report.fingerprint);
  report.status = 'PASS';
} catch {
  report.failure = stage;
  console.error('HOLD: ' + stage);
} finally {
  writeReport(folder, 'rehearsal.json', report);
}
console.log(report.status, folder);
process.exitCode = report.status === 'PASS' ? 0 : 1;
