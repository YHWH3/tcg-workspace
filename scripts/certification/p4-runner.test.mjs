import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requiredProjects } from '../ux-lab/catalog.mjs';
import {
  SI01_ALLOWLIST,
  evaluateIsolatedSi01Retry,
  evaluateVitestA24,
  snapshotBaselineProvenance,
  validateMatrixSummary,
  verifyPreservedBaselinesUnchanged,
} from './p4-runner-lib.mjs';

const ROOT = '/repo';
const EXPECTED_FILES = [
  'tests/phase4-events-d1.test.ts',
  'tests/phase8-commitments-d1.test.ts',
  'tests/phase8-form-operations-d1.test.ts',
  'tests/phase11-backup-d1.test.ts',
];

function makePassingReport(files = EXPECTED_FILES) {
  return {
    success: true,
    numTotalTestSuites: files.length,
    numFailedTestSuites: 0,
    numTotalTests: files.length,
    numPassedTests: files.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: files.map((f) => ({
      name: `${ROOT}/${f}`,
      status: 'passed',
      assertionResults: [{ title: `passes ${f}`, fullName: `suite passes ${f}`, status: 'passed', failureMessages: [] }],
    })),
  };
}

test('SI-01 allowlist matches the exact 3 documented files and signatures', () => {
  assert.equal(SI01_ALLOWLIST.length, 3);
  assert.deepEqual(
    SI01_ALLOWLIST.map((r) => r.file),
    [
      'tests/phase4-events-d1.test.ts',
      'tests/phase8-commitments-d1.test.ts',
      'tests/phase8-form-operations-d1.test.ts',
    ],
  );
});

test('evaluateVitestA24 accepts clean full pass with all expected files', () => {
  const res = evaluateVitestA24(makePassingReport(), EXPECTED_FILES, ROOT);
  assert.equal(res.ok, true);
  assert.deepEqual(res.needsIsolatedRetry, []);
  assert.deepEqual(res.reasons, []);
});

test('evaluateVitestA24 allows isolated retry ONLY for the exact 3 documented SI-01 (file, test, signature) tuples', () => {
  const report = makePassingReport();
  report.success = false;
  report.numFailedTestSuites = 3;
  report.numFailedTests = 3;
  report.numPassedTests = 1;
  report.testResults[0] = {
    name: `${ROOT}/tests/phase4-events-d1.test.ts`,
    status: 'failed',
    assertionResults: [
      {
        title: 'Cron recovers durable events after interruption and a failed sweep, then dedupes subsequent sweeps',
        fullName: 'phase4 events Cron recovers durable events after interruption and a failed sweep, then dedupes subsequent sweeps',
        status: 'failed',
        failureMessages: ['Error: beforeEach hook timed out in 30000ms'],
      },
    ],
  };
  report.testResults[1] = {
    name: `${ROOT}/tests/phase8-commitments-d1.test.ts`,
    status: 'failed',
    assertionResults: [
      {
        title: 'keeps private action metadata out while retaining available decisions',
        fullName: 'commitments keeps private action metadata out while retaining available decisions',
        status: 'failed',
        failureMessages: ['Error: read ECONNRESET'],
      },
    ],
  };
  report.testResults[2] = {
    name: `${ROOT}/tests/phase8-form-operations-d1.test.ts`,
    status: 'failed',
    assertionResults: [
      {
        title: 'fences disablement and session revocation during a read',
        fullName: 'form operations fences disablement and session revocation during a read',
        status: 'failed',
        failureMessages: ['Error: Test timed out in 30000ms.'],
      },
    ],
  };

  const res = evaluateVitestA24(report, EXPECTED_FILES, ROOT);
  assert.equal(res.ok, false);
  assert.deepEqual(res.reasons, []);
  assert.deepEqual(res.needsIsolatedRetry, [
    'tests/phase4-events-d1.test.ts',
    'tests/phase8-commitments-d1.test.ts',
    'tests/phase8-form-operations-d1.test.ts',
  ]);
});

test('evaluateVitestA24 rejects wrong file, wrong test name, wrong signature, skipped tests, and incomplete counts', () => {
  // 1. Non-SI-01 file (previously misconfigured phase11-backup-d1)
  const wrongFile = makePassingReport();
  wrongFile.success = false;
  wrongFile.numFailedTests = 1;
  wrongFile.testResults[3] = {
    name: `${ROOT}/tests/phase11-backup-d1.test.ts`,
    status: 'failed',
    assertionResults: [{ title: 'backup test', fullName: 'backup test', status: 'failed', failureMessages: ['Error: read ECONNRESET'] }],
  };
  const r1 = evaluateVitestA24(wrongFile, EXPECTED_FILES, ROOT);
  assert.equal(r1.ok, false);
  assert.deepEqual(r1.needsIsolatedRetry, []);
  assert.ok(r1.reasons.some((r) => r.startsWith('non_si01_failure:tests/phase11-backup-d1.test.ts')));

  // 2. Right file, wrong test name
  const wrongTest = makePassingReport();
  wrongTest.success = false;
  wrongTest.numFailedTests = 1;
  wrongTest.testResults[1] = {
    name: `${ROOT}/tests/phase8-commitments-d1.test.ts`,
    status: 'failed',
    assertionResults: [{ title: 'some other commitment test', fullName: 'some other commitment test', status: 'failed', failureMessages: ['Error: read ECONNRESET'] }],
  };
  const r2 = evaluateVitestA24(wrongTest, EXPECTED_FILES, ROOT);
  assert.equal(r2.ok, false);
  assert.deepEqual(r2.needsIsolatedRetry, []);
  assert.ok(r2.reasons.some((r) => r.includes('non_si01_failure:tests/phase8-commitments-d1.test.ts')));

  // 3. Right file & test name, wrong failure signature (real assertion failure, NOT ECONNRESET!)
  const wrongSig = makePassingReport();
  wrongSig.success = false;
  wrongSig.numFailedTests = 1;
  wrongSig.testResults[1] = {
    name: `${ROOT}/tests/phase8-commitments-d1.test.ts`,
    status: 'failed',
    assertionResults: [
      {
        title: 'keeps private action metadata out while retaining available decisions',
        fullName: 'keeps private action metadata out while retaining available decisions',
        status: 'failed',
        failureMessages: ['AssertionError: expected 403 to be 200'],
      },
    ],
  };
  const r3 = evaluateVitestA24(wrongSig, EXPECTED_FILES, ROOT);
  assert.equal(r3.ok, false);
  assert.deepEqual(r3.needsIsolatedRetry, []);
  assert.ok(r3.reasons.some((r) => r.includes('AssertionError')));

  // 4. Skipped/pending test even when success=true
  const skipped = makePassingReport();
  skipped.numPendingTests = 1;
  skipped.testResults[0].assertionResults.push({ title: 'skipped one', fullName: 'skipped one', status: 'pending', failureMessages: [] });
  const r4 = evaluateVitestA24(skipped, EXPECTED_FILES, ROOT);
  assert.equal(r4.ok, false);
  assert.ok(r4.reasons.some((r) => r.startsWith('vitest_pending_tests:')));

  // 5. Missing file (incomplete test count)
  const incomplete = makePassingReport(EXPECTED_FILES.slice(0, 3));
  const r5 = evaluateVitestA24(incomplete, EXPECTED_FILES, ROOT);
  assert.equal(r5.ok, false);
  assert.ok(r5.reasons.some((r) => r.startsWith('incomplete_test_file_coverage:')));
});

test('evaluateIsolatedSi01Retry rejects skipped or zero-pass retries and accepts clean passes', () => {
  const file = 'tests/phase8-commitments-d1.test.ts';
  const passReport = makePassingReport([file]);
  assert.equal(evaluateIsolatedSi01Retry(file, passReport, ROOT).ok, true);

  const skippedRetry = makePassingReport([file]);
  skippedRetry.numPendingTests = 1;
  assert.equal(evaluateIsolatedSi01Retry(file, skippedRetry, ROOT).ok, false);

  const zeroRetry = makePassingReport([file]);
  zeroRetry.numPassedTests = 0;
  assert.equal(evaluateIsolatedSi01Retry(file, zeroRetry, ROOT).ok, false);
});

function makeMatrixSummary(kind, perProjectRows) {
  const rows = requiredProjects.flatMap((project) =>
    Array.from({ length: perProjectRows }, (_, i) => ({
      surface: `${kind}-case-${i}`,
      project,
      status: 'expected',
    })),
  );
  return {
    source: { sha: 'abc123', fingerprint: 'fp123' },
    exitCode: 0,
    sourceUnchanged: true,
    projectsComplete: true,
    recordMode: kind === 'crm_p4_record',
    crmMode: kind !== 'workspace',
    crmP4Mode: kind === 'crm_p4_record' || kind === 'crm_p4_verify',
    baselineReview: 'GENERATED_REFERENCE_NOT_HUMAN_ACCEPTANCE',
    stats: { expected: rows.length, skipped: 0, unexpected: 0, flaky: 0 },
    rows,
    ...(kind === 'workspace'
      ? { coverage: { required: rows.length, executed: rows.length, missing: [], failed: [], complete: true } }
      : {}),
  };
}

test('validateMatrixSummary enforces record-then-verify separation and exact 18-project coverage', () => {
  const opts = { expectedSha: 'abc123', expectedFingerprint: 'fp123' };

  assert.equal(validateMatrixSummary('workspace', makeMatrixSummary('workspace', 10), opts).ok, true);
  assert.equal(validateMatrixSummary('crm_core', makeMatrixSummary('crm_core', 6), opts).ok, true);
  assert.equal(validateMatrixSummary('crm_p4_record', makeMatrixSummary('crm_p4_record', 2), opts).ok, true);
  assert.equal(validateMatrixSummary('crm_p4_verify', makeMatrixSummary('crm_p4_verify', 2), opts).ok, true);

  // Reject recordMode=true when verifying P4 baselines!
  const recordPassedAsVerify = makeMatrixSummary('crm_p4_record', 2);
  const badVerify = validateMatrixSummary('crm_p4_verify', recordPassedAsVerify, opts);
  assert.equal(badVerify.ok, false);
  assert.ok(badVerify.reasons.some((r) => r.includes('matrix_record_mode_mismatch')));

  // Reject missing coverage in CRM core (<6 per project)
  const shortCore = makeMatrixSummary('crm_core', 5);
  const badCore = validateMatrixSummary('crm_core', shortCore, opts);
  assert.equal(badCore.ok, false);
  assert.ok(badCore.reasons.some((r) => r.includes('project_insufficient_coverage')));

  // Reject incomplete workspace coverage
  const badWs = makeMatrixSummary('workspace', 10);
  badWs.coverage.complete = false;
  badWs.coverage.missing = ['home/webkit-compact-dark'];
  assert.equal(validateMatrixSummary('workspace', badWs, opts).ok, false);

  // Reject skipped tests
  const skippedSummary = makeMatrixSummary('crm_p4_verify', 2);
  skippedSummary.stats.skipped = 1;
  assert.equal(validateMatrixSummary('crm_p4_verify', skippedSummary, opts).ok, false);
});

test('snapshotBaselineProvenance and verifyPreservedBaselinesUnchanged detect baseline tampering', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p4-baselines-test-'));
  try {
    const b1 = join(dir, '.artifacts/ux-lab/baselines');
    mkdirSync(b1, { recursive: true });
    writeFileSync(join(b1, 'provenance.json'), JSON.stringify({ review: 'ACCEPTED', sha: 'orig' }));
    writeFileSync(join(b1, 'home.png'), 'png-bytes-1');

    const before = snapshotBaselineProvenance(dir);
    const sameAfter = snapshotBaselineProvenance(dir);
    assert.equal(verifyPreservedBaselinesUnchanged(before, sameAfter).ok, true);

    // Tamper with a preserved baseline file
    writeFileSync(join(b1, 'home.png'), 'png-bytes-tampered');
    const tamperedAfter = snapshotBaselineProvenance(dir);
    const check = verifyPreservedBaselinesUnchanged(before, tamperedAfter);
    assert.equal(check.ok, false);
    assert.ok(check.diffs.some((d) => d.includes('baseline_file_modified:.artifacts/ux-lab/baselines/home.png')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
