#!/usr/bin/env node
/**
 * Deterministic P4 Operations Comprehensive Certification Runner
 *
 * Designed to run unattended in a local terminal without burning AI model quota.
 * Records exact git commit SHA & source fingerprint, enforces A-24 test accounting,
 * preserves accepted Workspace & CRM baselines, runs P3/P4 visual references separately,
 * and writes a concise machine-readable JSON report to `.artifacts/p4-certification/report.json`.
 *
 * Usage:
 *   node scripts/verify-p4-operations.mjs                  # Full certification (default UX_CONCURRENCY=2)
 *   node scripts/verify-p4-operations.mjs --serial         # Full certification with serial UX matrix (UX_CONCURRENCY=1)
 *   node scripts/verify-p4-operations.mjs --concurrency=3  # Custom bounded UX concurrency (1..4)
 *   node scripts/verify-p4-operations.mjs --quick          # Fast core verification (no full 245-file / 18-project matrices)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fingerprint, freePort } from './certification/core.mjs';
import { resolveConcurrency } from './ux-lab/project-isolation.mjs';
import { startFixture } from './phase4-fixture.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUT_DIR = join(ROOT, '.artifacts/p4-certification');
const args = process.argv.slice(2);
const quick = args.includes('--quick');
const concurrency = resolveConcurrency(args, process.env);
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// Documented SI-01 pre-existing parallel-contention signatures eligible for isolated A-24 retry ONLY
const DOCUMENTED_SI01_FILES = new Set([
  'tests/phase11-backup-d1.test.ts',
  'tests/phase12-audit-d1.test.ts',
  'tests/phase13-ops-d1.test.ts',
]);

mkdirSync(OUT_DIR, { recursive: true });

const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const startFingerprint = fingerprint(ROOT);
const startedAt = new Date().toISOString();

const steps = [];

function runStep(id, label, cmd, cmdArgs, extraEnv = {}) {
  const t0 = Date.now();
  console.log(`\n=== [${id}] ${label} ===`);
  const res = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
  });
  const durationMs = Date.now() - t0;
  const exitCode = res.status ?? 1;
  const ok = exitCode === 0;
  steps.push({ id, label, ok, exitCode, durationMs });
  console.log(`--- [${id}] ${ok ? 'PASS' : 'FAIL'} (${(durationMs / 1000).toFixed(1)}s) ---`);
  return ok;
}

async function runDisposableMigrationCheck() {
  const id = 'migrations_disposable_d1';
  const label = 'Apply all 49 immutable migrations to fresh disposable D1';
  const t0 = Date.now();
  console.log(`\n=== [${id}] ${label} ===`);
  const dir = join(OUT_DIR, 'disposable-migrations-check');
  rmSync(dir, { recursive: true, force: true });
  let owned;
  try {
    owned = await startFixture({
      port: await freePort(),
      build: false,
      artifactDirectory: dir,
      vars: { CRM_ENABLED: 'true', WORKSPACE_ENV: 'local-test' },
    });
    const out = await owned.sql(
      "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name IN ('crm_editions','crm_bookings','crm_allocations','crm_participants','crm_attendance','crm_screenings','crm_payment_requests','crm_ledger_entries','crm_refund_policies','crm_refund_requests','crm_membership_schemes','crm_memberships');",
    );
    const cnt = Number(out?.[0]?.results?.[0]?.cnt ?? 0);
    const ok = cnt === 12;
    const durationMs = Date.now() - t0;
    steps.push({ id, label, ok, exitCode: ok ? 0 : 1, durationMs });
    console.log(`--- [${id}] ${ok ? 'PASS' : 'FAIL'} (${(durationMs / 1000).toFixed(1)}s) ---`);
    return ok;
  } catch (err) {
    const durationMs = Date.now() - t0;
    steps.push({ id, label, ok: false, exitCode: 1, durationMs, error: String(err) });
    console.error(err);
    return false;
  } finally {
    await owned?.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

function runVitestWithA24() {
  const id = 'vitest_full_a24';
  const label = 'Full Vitest suite with A-24 isolated SI-01 accounting';
  const t0 = Date.now();
  console.log(`\n=== [${id}] ${label} ===`);
  const jsonReport = join(OUT_DIR, 'vitest-full.json');
  rmSync(jsonReport, { force: true });

  const res = spawnSync(
    join(ROOT, 'node_modules/.bin/vitest'),
    ['run', '--reporter=default', '--reporter=json', `--outputFile=${jsonReport}`],
    { cwd: ROOT, stdio: 'inherit' },
  );

  let parsed = null;
  if (existsSync(jsonReport)) {
    try {
      parsed = JSON.parse(readFileSync(jsonReport, 'utf8'));
    } catch {
      parsed = null;
    }
  }

  if ((res.status ?? 1) === 0 && parsed?.success) {
    const durationMs = Date.now() - t0;
    steps.push({
      id,
      label,
      ok: true,
      exitCode: 0,
      durationMs,
      details: {
        totalFiles: parsed.numTotalTestSuites,
        passedTests: parsed.numPassedTests,
        failedTests: parsed.numFailedTests,
        si01Retried: [],
      },
    });
    console.log(`--- [${id}] PASS (${(durationMs / 1000).toFixed(1)}s) ---`);
    return true;
  }

  // Inspect failures strictly under A-24: ONLY documented SI-01 files may retry sequentially
  const failedFiles = (parsed?.testResults ?? [])
    .filter((tr) => tr.status === 'failed')
    .map((tr) => tr.name.replace(`${ROOT}/`, ''));

  const nonSi01Failures = failedFiles.filter((f) => !DOCUMENTED_SI01_FILES.has(f));
  const si01Failures = failedFiles.filter((f) => DOCUMENTED_SI01_FILES.has(f));

  if (!failedFiles.length || nonSi01Failures.length > 0) {
    const durationMs = Date.now() - t0;
    steps.push({
      id,
      label,
      ok: false,
      exitCode: res.status ?? 1,
      durationMs,
      details: { failedFiles, nonSi01Failures, si01Retried: [] },
    });
    console.log(`--- [${id}] FAIL (non-SI-01 failures: ${nonSi01Failures.join(', ') || 'unknown'}) ---`);
    return false;
  }

  const si01Results = [];
  let allSi01Passed = true;
  for (const file of si01Failures) {
    console.log(`\n[A-24] Isolated retry of documented SI-01 file: ${file}`);
    const retry = spawnSync(join(ROOT, 'node_modules/.bin/vitest'), ['run', file], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    const passed = (retry.status ?? 1) === 0;
    si01Results.push({ file, passedIsolated: passed });
    if (!passed) allSi01Passed = false;
  }

  const durationMs = Date.now() - t0;
  steps.push({
    id,
    label,
    ok: allSi01Passed,
    exitCode: allSi01Passed ? 0 : 1,
    durationMs,
    details: { initialFailedFiles: failedFiles, si01Retried: si01Results },
  });
  console.log(`--- [${id}] ${allSi01Passed ? 'PASS (via A-24 SI-01 isolated verification)' : 'FAIL'} ---`);
  return allSi01Passed;
}

async function main() {
  console.log(`TCG CRM P4 Certification Runner (${quick ? 'QUICK' : 'FULL'} mode, UX_CONCURRENCY=${concurrency})`);
  console.log(`Branch: ${branch} | Commit: ${sha} | Fingerprint: ${startFingerprint}`);

  let allOk = true;
  allOk = runStep('typecheck', 'TypeScript typecheck', npmCmd, ['run', 'typecheck']) && allOk;
  allOk = runStep('build', 'Production build (client + worker + SW)', npmCmd, ['run', 'build']) && allOk;
  allOk = (await runDisposableMigrationCheck()) && allOk;
  allOk =
    runStep('cert_selftests', 'Certification & access selftests', process.execPath, [
      '--test',
      'scripts/certification/core.test.mjs',
      'scripts/certification/ux-project-isolation.test.mjs',
      'scripts/certification/release-preflight.test.mjs',
      'scripts/certification/release-rehearsal.test.mjs',
      'scripts/certification/test-files.test.mjs',
      'scripts/access/selftest.mjs',
    ]) && allOk;
  allOk = runStep('release_preflight', 'Release preflight & migration hashes', npmCmd, ['run', 'release:preflight']) && allOk;
  allOk = runStep('tcg_pack', 'Validate TCG bundled operating pack', process.execPath, ['scripts/_validate-tcg-pack.mjs']) && allOk;

  if (quick) {
    allOk =
      runStep(
        'vitest_p4_focused',
        'Focused P3 hardening + P4 Operations + Merge/Isolation Vitest suites',
        join(ROOT, 'node_modules/.bin/vitest'),
        [
          'run',
          'tests/crm-p3-hardening-d1.test.ts',
          'tests/crm-p4-operations.test.ts',
          'tests/crm-p4-bookings-d1.test.ts',
          'tests/crm-p4-money-d1.test.ts',
          'tests/crm-p4-memberships-merge-d1.test.ts',
          'tests/crm-p4-client.test.ts',
          'tests/crm-p2-merge-d1.test.ts',
          'tests/crm-isolation.test.ts',
          'tests/crm-routes.test.ts',
        ],
      ) && allOk;
  } else {
    allOk = runVitestWithA24() && allOk;
    allOk = runStep('demo_studio', 'Studio Workspace demo check', npmCmd, ['run', 'demo:studio', '--', '--check']) && allOk;
    allOk = runStep('demo_crm', 'Expanded Commons CRM demo check (P1–P4)', npmCmd, ['run', 'demo:crm', '--', '--check']) && allOk;

    // 1. Complete Workspace CRM-off 18-project matrix against preserved accepted baselines
    allOk =
      runStep(
        'ux_workspace_18',
        `Workspace CRM-off 18-project UX matrix (UX_CONCURRENCY=${concurrency})`,
        npmCmd,
        ['run', 'qa:ux', '--', '--skip-build', `--concurrency=${concurrency}`],
        { UX_CONCURRENCY: String(concurrency) },
      ) && allOk;

    // 2. Complete CRM P3/P4 18-project UX matrix with separate visual references
    const p4BaselinesExist = existsSync(join(ROOT, '.artifacts/ux-lab/crm-p4-baselines/provenance.json'));
    allOk =
      runStep(
        'ux_crm_p4_18',
        `CRM P3/P4 18-project UX matrix (${p4BaselinesExist ? 'verify' : 'record separate references'}, UX_CONCURRENCY=${concurrency})`,
        npmCmd,
        [
          'run',
          'qa:ux',
          '--',
          '--crm-p4',
          '--skip-build',
          `--concurrency=${concurrency}`,
          ...(p4BaselinesExist ? [] : ['--record']),
        ],
        { UX_CONCURRENCY: String(concurrency) },
      ) && allOk;

    // 3. Complete CRM S0/P1/P2 18-project UX matrix against preserved crm-baselines
    allOk =
      runStep(
        'ux_crm_core_18',
        `CRM Core S0/P1/P2 18-project UX matrix (UX_CONCURRENCY=${concurrency})`,
        npmCmd,
        ['run', 'qa:ux', '--', '--crm', '--skip-build', `--concurrency=${concurrency}`],
        { UX_CONCURRENCY: String(concurrency) },
      ) && allOk;
  }

  const endFingerprint = fingerprint(ROOT);
  const sourceUnchanged = endFingerprint === startFingerprint;
  if (!sourceUnchanged) {
    allOk = false;
    steps.push({
      id: 'source_fingerprint',
      label: 'Tracked source unchanged during run',
      ok: false,
      exitCode: 1,
      durationMs: 0,
      error: `Source fingerprint drifted: ${startFingerprint} -> ${endFingerprint}`,
    });
  }

  const report = {
    mode: quick ? 'quick' : 'full_certification',
    branch,
    commit: sha,
    sourceFingerprint: startFingerprint,
    sourceUnchanged,
    uxConcurrency: concurrency,
    startedAt,
    finishedAt: new Date().toISOString(),
    passed: allOk,
    steps,
  };

  const reportPath = join(OUT_DIR, 'report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log('\n============================================================');
  console.log(`P4 Verification Report (${report.mode}): ${report.passed ? 'PASSED' : 'FAILED'}`);
  console.log(`Commit: ${sha} | Fingerprint unchanged: ${sourceUnchanged}`);
  console.log(`JSON Report: ${reportPath}`);
  for (const st of steps) {
    console.log(`  - [${st.ok ? 'PASS' : 'FAIL'}] ${st.id}: ${st.label} (${(st.durationMs / 1000).toFixed(1)}s)`);
  }
  console.log('============================================================\n');

  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
