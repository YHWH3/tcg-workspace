#!/usr/bin/env node
/**
 * Deterministic P4 Operations Comprehensive Certification Runner
 *
 * Designed to run unattended in a local terminal without burning AI model quota.
 * Records exact git commit SHA & source fingerprint, enforces strict A-24 test
 * accounting against the exact documented 3-test SI-01 allowlist, preserves all
 * accepted Workspace & CRM baselines (verified via SHA-256 tree snapshots),
 * enforces record-then-independent-verify for new P3/P4 visual references, validates
 * exact 18-project matrix coverage, and writes a machine-readable JSON report to
 * `.artifacts/p4-certification/report.json`.
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
import {
  CRM_P4_BASELINE_DIR,
  discoverVitestFiles,
  evaluateIsolatedSi01Retry,
  evaluateVitestA24,
  snapshotBaselineProvenance,
  validateMatrixSummary,
  verifyPreservedBaselinesUnchanged,
} from './certification/p4-runner-lib.mjs';
import { resolveConcurrency } from './ux-lab/project-isolation.mjs';
import { startFixture } from './phase4-fixture.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUT_DIR = join(ROOT, '.artifacts/p4-certification');
const args = process.argv.slice(2);
const quick = args.includes('--quick');
const concurrency = resolveConcurrency(args, process.env);
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

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
  const label = 'Apply all 50 immutable migrations to fresh disposable D1';
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
      "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name IN ('crm_editions','crm_bookings','crm_allocations','crm_participants','crm_attendance','crm_screenings','crm_payment_requests','crm_ledger_entries','crm_refund_policies','crm_refund_requests','crm_membership_schemes','crm_memberships','crm_membership_periods');",
    );
    const cnt = Number(out?.[0]?.results?.[0]?.cnt ?? 0);
    const ok = cnt === 13;
    const durationMs = Date.now() - t0;
    steps.push({ id, label, ok, exitCode: ok ? 0 : 1, durationMs, details: { p4TablesFound: cnt, expected: 13 } });
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
  const label = 'Full Vitest suite with strict A-24 / SI-01 accounting';
  const t0 = Date.now();
  console.log(`\n=== [${id}] ${label} ===`);
  const jsonReport = join(OUT_DIR, 'vitest-full.json');
  rmSync(jsonReport, { force: true });

  const expectedTestFiles = discoverVitestFiles(ROOT);
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

  const evaluation = evaluateVitestA24(parsed, expectedTestFiles, ROOT);

  if (evaluation.ok && (res.status ?? 1) === 0) {
    const durationMs = Date.now() - t0;
    steps.push({
      id,
      label,
      ok: true,
      exitCode: 0,
      durationMs,
      details: {
        expectedFiles: expectedTestFiles.length,
        totalFiles: parsed.numTotalTestSuites,
        passedTests: parsed.numPassedTests,
        failedTests: parsed.numFailedTests,
        pendingTests: parsed.numPendingTests,
        si01Retried: [],
      },
    });
    console.log(`--- [${id}] PASS (${(durationMs / 1000).toFixed(1)}s) ---`);
    return true;
  }

  if (evaluation.reasons.length > 0 || evaluation.needsIsolatedRetry.length === 0) {
    const durationMs = Date.now() - t0;
    steps.push({
      id,
      label,
      ok: false,
      exitCode: res.status ?? 1,
      durationMs,
      details: {
        expectedFiles: expectedTestFiles.length,
        reasons: evaluation.reasons.length ? evaluation.reasons : ['vitest_nonzero_exit_without_si01_match'],
        matchedSi01: evaluation.matchedSi01,
        si01Retried: [],
      },
    });
    console.log(`--- [${id}] FAIL (${evaluation.reasons.join('; ') || 'non-SI-01 failure'}) ---`);
    return false;
  }

  const si01Results = [];
  let allSi01Passed = true;
  for (const file of evaluation.needsIsolatedRetry) {
    console.log(`\n[A-24] Isolated retry of documented SI-01 file: ${file}`);
    const retryJson = join(OUT_DIR, `vitest-si01-${file.replace(/[^a-z0-9]/gi, '_')}.json`);
    rmSync(retryJson, { force: true });
    const retry = spawnSync(
      join(ROOT, 'node_modules/.bin/vitest'),
      ['run', file, '--reporter=default', '--reporter=json', `--outputFile=${retryJson}`],
      { cwd: ROOT, stdio: 'inherit' },
    );
    let retryParsed = null;
    if (existsSync(retryJson)) {
      try {
        retryParsed = JSON.parse(readFileSync(retryJson, 'utf8'));
      } catch {
        retryParsed = null;
      }
    }
    const retryEval = evaluateIsolatedSi01Retry(file, retryParsed, ROOT);
    const passed = (retry.status ?? 1) === 0 && retryEval.ok;
    si01Results.push({ file, passedIsolated: passed, reasons: retryEval.reasons });
    if (!passed) allSi01Passed = false;
  }

  const durationMs = Date.now() - t0;
  steps.push({
    id,
    label,
    ok: allSi01Passed,
    exitCode: allSi01Passed ? 0 : 1,
    durationMs,
    details: {
      expectedFiles: expectedTestFiles.length,
      matchedSi01: evaluation.matchedSi01,
      si01Retried: si01Results,
    },
  });
  console.log(`--- [${id}] ${allSi01Passed ? 'PASS (via strict A-24 SI-01 isolated verification)' : 'FAIL'} ---`);
  return allSi01Passed;
}

function runValidatedMatrixStep({ id, label, kind, uxArgs, outputSubdir }) {
  const t0 = Date.now();
  console.log(`\n=== [${id}] ${label} ===`);
  const uxOutput = join(OUT_DIR, outputSubdir);
  rmSync(uxOutput, { recursive: true, force: true });
  mkdirSync(uxOutput, { recursive: true });

  const res = spawnSync(npmCmd, ['run', 'qa:ux', '--', ...uxArgs], {
    cwd: ROOT,
    env: { ...process.env, UX_CONCURRENCY: String(concurrency), UX_OUTPUT: uxOutput },
    stdio: 'inherit',
  });

  const summaryPath = join(uxOutput, 'summary.json');
  let summary = null;
  if (existsSync(summaryPath)) {
    try {
      summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    } catch {
      summary = null;
    }
  }

  const validation = validateMatrixSummary(kind, summary, {
    expectedSha: sha,
    expectedFingerprint: startFingerprint,
  });

  const durationMs = Date.now() - t0;
  const ok = (res.status ?? 1) === 0 && validation.ok;
  steps.push({
    id,
    label,
    ok,
    exitCode: ok ? 0 : res.status || 1,
    durationMs,
    details: {
      kind,
      summaryPath,
      baselineReview: summary?.baselineReview ?? null,
      stats: validation.stats ?? null,
      reasons: validation.reasons,
    },
  });
  console.log(
    `--- [${id}] ${ok ? 'PASS' : 'FAIL'} (${(durationMs / 1000).toFixed(1)}s)${
      validation.reasons.length ? ` | ${validation.reasons.join('; ')}` : ''
    } ---`,
  );
  return ok;
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
      'scripts/certification/p4-runner.test.mjs',
      'scripts/access/selftest.mjs',
    ]) && allOk;
  allOk = runStep('release_preflight', 'Release preflight & migration hashes', npmCmd, ['run', 'release:preflight']) && allOk;
  allOk = runStep('tcg_pack', 'Validate TCG bundled operating pack', process.execPath, ['scripts/_validate-tcg-pack.mjs']) && allOk;

  if (quick) {
    allOk =
      runStep(
        'vitest_p4_focused',
        'Focused P3/P4 hardening, Operations & Merge/Isolation Vitest suites',
        join(ROOT, 'node_modules/.bin/vitest'),
        [
          'run',
          'tests/crm-p3-hardening-d1.test.ts',
          'tests/crm-p4-operations.test.ts',
          'tests/crm-p4-bookings-d1.test.ts',
          'tests/crm-p4-money-d1.test.ts',
          'tests/crm-p4-memberships-merge-d1.test.ts',
          'tests/crm-p4-hardening-d1.test.ts',
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

    // Snapshot preserved baseline directories BEFORE running any UX matrix.
    // If crm-p4-baselines already exists, preserve it too (never silently overwrite existing baselines).
    const p4BaselinesExistedBefore = existsSync(join(ROOT, CRM_P4_BASELINE_DIR, 'provenance.json'));
    const extraPreserved = p4BaselinesExistedBefore ? [CRM_P4_BASELINE_DIR] : [];
    const baselinesBefore = snapshotBaselineProvenance(ROOT, extraPreserved);

    // 1. Complete Workspace CRM-off 18-project matrix against preserved accepted baselines
    allOk =
      runValidatedMatrixStep({
        id: 'ux_workspace_18',
        label: `Workspace CRM-off 18-project UX matrix (UX_CONCURRENCY=${concurrency})`,
        kind: 'workspace',
        uxArgs: ['--skip-build', `--concurrency=${concurrency}`],
        outputSubdir: 'ux-workspace-18',
      }) && allOk;

    // 2. CRM P3/P4 18-project UX matrix:
    //    If separate P3/P4 references do not yet exist, record them first, THEN ALWAYS
    //    run an independent non-record verification pass against them.
    if (!p4BaselinesExistedBefore) {
      allOk =
        runValidatedMatrixStep({
          id: 'ux_crm_p4_record_18',
          label: `CRM P3/P4 18-project UX matrix — record separate unreviewed references (UX_CONCURRENCY=${concurrency})`,
          kind: 'crm_p4_record',
          uxArgs: ['--crm-p4', '--skip-build', `--concurrency=${concurrency}`, '--record'],
          outputSubdir: 'ux-crm-p4-record-18',
        }) && allOk;
    }

    allOk =
      runValidatedMatrixStep({
        id: 'ux_crm_p4_verify_18',
        label: `CRM P3/P4 18-project UX matrix — independent non-record verification (UX_CONCURRENCY=${concurrency})`,
        kind: 'crm_p4_verify',
        uxArgs: ['--crm-p4', '--skip-build', `--concurrency=${concurrency}`],
        outputSubdir: 'ux-crm-p4-verify-18',
      }) && allOk;

    // 3. Complete CRM S0/P1/P2 18-project UX matrix against preserved crm-baselines
    allOk =
      runValidatedMatrixStep({
        id: 'ux_crm_core_18',
        label: `CRM Core S0/P1/P2 18-project UX matrix (UX_CONCURRENCY=${concurrency})`,
        kind: 'crm_core',
        uxArgs: ['--crm', '--skip-build', `--concurrency=${concurrency}`],
        outputSubdir: 'ux-crm-core-18',
      }) && allOk;

    // Verify all preserved baselines & provenance files are byte-for-byte unchanged
    const baselinesAfter = snapshotBaselineProvenance(ROOT, extraPreserved);
    const baselineCheck = verifyPreservedBaselinesUnchanged(baselinesBefore, baselinesAfter);
    steps.push({
      id: 'preserved_baselines_integrity',
      label: 'Verify preserved Workspace & CRM baselines and provenance unchanged',
      ok: baselineCheck.ok,
      exitCode: baselineCheck.ok ? 0 : 1,
      durationMs: 0,
      details: {
        preservedDirs: Object.keys(baselinesBefore),
        p4ReferencesCreatedThisRun: !p4BaselinesExistedBefore,
        diffs: baselineCheck.diffs,
      },
    });
    if (!baselineCheck.ok) {
      allOk = false;
      console.error(`--- [preserved_baselines_integrity] FAIL: ${baselineCheck.diffs.join('; ')} ---`);
    } else {
      console.log('--- [preserved_baselines_integrity] PASS ---');
    }
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
    baselineReview: 'GENERATED_REFERENCE_NOT_HUMAN_ACCEPTANCE',
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
  console.log(`Baseline status: ${report.baselineReview}`);
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
