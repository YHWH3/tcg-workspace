import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { requiredProjects } from '../ux-lab/catalog.mjs';

/**
 * Exact documented SI-01 pre-existing parallel-contention failure allowlist.
 * Source of truth: docs/crm/12-OPEN-DECISIONS.md (SI-01) and docs/crm/00-README.md.
 *
 * Only these exact (file, testName, failureSignature) tuples may qualify for
 * an isolated sequential A-24 verification retry. Any other test, file, signature,
 * skip, or incomplete count fails closed immediately.
 */
export const SI01_ALLOWLIST = Object.freeze([
  Object.freeze({
    id: 'SI-01-phase4-events',
    file: 'tests/phase4-events-d1.test.ts',
    testName: 'Cron recovers durable events after interruption and a failed sweep, then dedupes subsequent sweeps',
    signatureRe: /(?:beforeEach|hook).*timed out in 30,?000\s*ms/i,
    allowSuiteLevelHookMatch: true,
  }),
  Object.freeze({
    id: 'SI-01-phase8-commitments',
    file: 'tests/phase8-commitments-d1.test.ts',
    testName: 'keeps private action metadata out while retaining available decisions',
    signatureRe: /read ECONNRESET/i,
    allowSuiteLevelHookMatch: false,
  }),
  Object.freeze({
    id: 'SI-01-phase8-form-operations',
    file: 'tests/phase8-form-operations-d1.test.ts',
    testName: 'fences disablement and session revocation during a read',
    signatureRe: /test timed out in 30,?000\s*ms/i,
    allowSuiteLevelHookMatch: false,
  }),
]);

export const PRESERVED_BASELINE_DIRS = Object.freeze([
  '.artifacts/ux-lab/baselines',
  '.artifacts/ux-lab/baselines-compact-a11y-fix',
  '.artifacts/ux-lab/baselines-tablet-a11y-fix',
  '.artifacts/ux-lab/crm-baselines',
]);

export const CRM_P4_BASELINE_DIR = '.artifacts/ux-lab/crm-p4-baselines';

export function discoverVitestFiles(root) {
  const testsDir = join(root, 'tests');
  if (!existsSync(testsDir)) return [];
  const out = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /\.test\.[cm]?[jt]sx?$/.test(entry.name)) {
        out.push(relative(root, full).split(sep).join('/'));
      }
    }
  }
  walk(testsDir);
  return out.sort();
}

function normalizeRelFile(name, root) {
  if (!name || typeof name !== 'string') return '';
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/$/, '');
  const normalizedName = name.replace(/\\/g, '/');
  if (normalizedName.startsWith(`${normalizedRoot}/`)) {
    return normalizedName.slice(normalizedRoot.length + 1);
  }
  return normalizedName.replace(/^\.\//, '');
}

function matchesSi01Assertion(relFile, assertion) {
  const title = String(assertion?.title ?? '');
  const fullName = String(assertion?.fullName ?? '');
  const failureText = Array.isArray(assertion?.failureMessages)
    ? assertion.failureMessages.join('\n')
    : String(assertion?.failureMessages ?? '');

  for (const rule of SI01_ALLOWLIST) {
    if (rule.file !== relFile) continue;
    const nameMatches = title === rule.testName || fullName === rule.testName || fullName.endsWith(` ${rule.testName}`);
    if (!nameMatches) continue;
    if (!rule.signatureRe.test(failureText)) continue;
    return rule;
  }
  return null;
}

/**
 * Strictly evaluate a full Vitest JSON report under A-24 and SI-01 rules.
 * Rejects malformed reports, missing test files, skipped/pending/todo tests,
 * zero-test runs, suite crashes, or any failure outside the exact 3 SI-01 signatures.
 */
export function evaluateVitestA24(report, expectedTestFiles, root) {
  const reasons = [];
  const matchedSi01 = [];

  if (!report || typeof report !== 'object' || !Array.isArray(report.testResults)) {
    return { ok: false, needsIsolatedRetry: [], reasons: ['vitest_json_missing_or_malformed'], matchedSi01 };
  }

  if (!Array.isArray(expectedTestFiles) || expectedTestFiles.length === 0) {
    return { ok: false, needsIsolatedRetry: [], reasons: ['expected_test_files_empty'], matchedSi01 };
  }

  if (Number(report.numTotalTests ?? 0) <= 0) {
    reasons.push('vitest_zero_total_tests');
  }
  if (Number(report.numPendingTests ?? 0) > 0) {
    reasons.push(`vitest_pending_tests:${report.numPendingTests}`);
  }
  if (Number(report.numTodoTests ?? 0) > 0) {
    reasons.push(`vitest_todo_tests:${report.numTodoTests}`);
  }

  const seenFiles = new Set();
  for (const tr of report.testResults) {
    const relFile = normalizeRelFile(tr?.name, root);
    seenFiles.add(relFile);

    const assertions = Array.isArray(tr?.assertionResults) ? tr.assertionResults : [];
    const failedAssertions = assertions.filter((a) => a?.status === 'failed');
    const skippedAssertions = assertions.filter((a) => ['pending', 'skipped', 'todo'].includes(a?.status));

    if (skippedAssertions.length > 0) {
      reasons.push(`skipped_assertions:${relFile}:${skippedAssertions.length}`);
    }

    if (assertions.length === 0 && tr?.status !== 'failed') {
      reasons.push(`empty_test_file:${relFile}`);
    }

    for (const a of failedAssertions) {
      const matched = matchesSi01Assertion(relFile, a);
      if (matched) {
        matchedSi01.push({
          id: matched.id,
          file: relFile,
          testName: a.title || a.fullName,
        });
      } else {
        const snippet = String((a.failureMessages ?? [])[0] ?? '').split('\n')[0].slice(0, 140);
        reasons.push(`non_si01_failure:${relFile}:${a.title || a.fullName || 'unknown'}:${snippet}`);
      }
    }

    if (tr?.status === 'failed' && failedAssertions.length === 0) {
      const suiteMsg = String(tr?.message ?? '');
      const hookRule = SI01_ALLOWLIST.find(
        (r) => r.file === relFile && r.allowSuiteLevelHookMatch && r.signatureRe.test(suiteMsg),
      );
      if (hookRule) {
        matchedSi01.push({
          id: hookRule.id,
          file: relFile,
          testName: hookRule.testName,
          suiteLevelHook: true,
        });
      } else {
        reasons.push(`suite_crash_or_unclassified_failure:${relFile}:${suiteMsg.split('\n')[0].slice(0, 140)}`);
      }
    }
  }

  const missingFiles = expectedTestFiles.filter((f) => !seenFiles.has(f));
  if (missingFiles.length > 0) {
    reasons.push(`incomplete_test_file_coverage:missing_${missingFiles.length}:${missingFiles.slice(0, 5).join(',')}`);
  }

  if (reasons.length > 0) {
    return { ok: false, needsIsolatedRetry: [], reasons, matchedSi01 };
  }

  if (matchedSi01.length > 0) {
    const needsIsolatedRetry = [...new Set(matchedSi01.map((m) => m.file))];
    return { ok: false, needsIsolatedRetry, reasons: [], matchedSi01 };
  }

  if (
    report.success !== true ||
    Number(report.numFailedTests ?? 0) > 0 ||
    Number(report.numFailedTestSuites ?? 0) > 0
  ) {
    return {
      ok: false,
      needsIsolatedRetry: [],
      reasons: ['vitest_reported_failure_without_si01_match'],
      matchedSi01: [],
    };
  }

  return { ok: true, needsIsolatedRetry: [], reasons: [], matchedSi01: [] };
}

/**
 * Strictly validate an isolated retry report for one documented SI-01 file.
 */
export function evaluateIsolatedSi01Retry(file, report, root) {
  const reasons = [];
  if (!report || typeof report !== 'object' || !Array.isArray(report.testResults)) {
    return { ok: false, reasons: ['isolated_retry_json_missing_or_malformed'] };
  }
  if (report.success !== true) reasons.push('isolated_retry_not_success');
  if (Number(report.numFailedTests ?? 0) > 0) reasons.push(`isolated_retry_failed_tests:${report.numFailedTests}`);
  if (Number(report.numFailedTestSuites ?? 0) > 0) reasons.push(`isolated_retry_failed_suites:${report.numFailedTestSuites}`);
  if (Number(report.numPendingTests ?? 0) > 0) reasons.push(`isolated_retry_pending_tests:${report.numPendingTests}`);
  if (Number(report.numTodoTests ?? 0) > 0) reasons.push(`isolated_retry_todo_tests:${report.numTodoTests}`);
  if (Number(report.numPassedTests ?? 0) <= 0) reasons.push('isolated_retry_zero_passed_tests');

  const tr = report.testResults.find((entry) => normalizeRelFile(entry?.name, root) === file);
  if (!tr) {
    reasons.push(`isolated_retry_missing_file:${file}`);
  } else {
    const assertions = Array.isArray(tr.assertionResults) ? tr.assertionResults : [];
    if (assertions.length === 0) reasons.push(`isolated_retry_empty_assertions:${file}`);
    const nonPassed = assertions.filter((a) => a?.status !== 'passed');
    if (nonPassed.length > 0) reasons.push(`isolated_retry_non_passed_assertions:${nonPassed.length}`);
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Validate a UX matrix summary.json against exact project, coverage, provenance, and mode gates.
 *
 * kind:
 * - 'workspace': CRM-off 18-project matrix (requires summary.coverage.complete === true & recordMode === false)
 * - 'crm_core':  CRM S0/P1/P2 18-project matrix (requires recordMode === false & >= 6 expected rows/project)
 * - 'crm_p4_record': CRM P3/P4 baseline capture (requires recordMode === true & >= 2 expected rows/project)
 * - 'crm_p4_verify': Independent CRM P3/P4 verification (requires recordMode === false & >= 2 expected rows/project)
 */
export function validateMatrixSummary(kind, summary, opts) {
  const reasons = [];
  const projects = opts?.requiredProjects ?? requiredProjects;
  const expectedSha = opts?.expectedSha;
  const expectedFingerprint = opts?.expectedFingerprint;

  if (!summary || typeof summary !== 'object') {
    return { ok: false, reasons: ['matrix_summary_missing_or_malformed'] };
  }

  if (summary.exitCode !== 0) reasons.push(`matrix_nonzero_exit:${summary.exitCode}`);
  if (summary.sourceUnchanged !== true) reasons.push('matrix_source_changed');
  if (summary.projectsComplete !== true) reasons.push('matrix_projects_incomplete');

  if (expectedSha && summary.source?.sha !== expectedSha) {
    reasons.push(`matrix_sha_mismatch:${summary.source?.sha ?? 'missing'}`);
  }
  if (expectedFingerprint && summary.source?.fingerprint !== expectedFingerprint) {
    reasons.push(`matrix_fingerprint_mismatch:${summary.source?.fingerprint ?? 'missing'}`);
  }

  if (summary.baselineReview !== 'GENERATED_REFERENCE_NOT_HUMAN_ACCEPTANCE') {
    reasons.push(`unexpected_baseline_review_claim:${String(summary.baselineReview ?? 'missing')}`);
  }

  const expectRecord = kind === 'crm_p4_record';
  if (Boolean(summary.recordMode) !== expectRecord) {
    reasons.push(`matrix_record_mode_mismatch:expected_${expectRecord}_got_${Boolean(summary.recordMode)}`);
  }

  if (kind === 'workspace' && (summary.crmMode === true || summary.crmP4Mode === true)) {
    reasons.push('workspace_matrix_ran_in_crm_mode');
  }
  if (kind === 'crm_core' && (summary.crmMode !== true || summary.crmP4Mode === true)) {
    reasons.push('crm_core_matrix_mode_mismatch');
  }
  if ((kind === 'crm_p4_record' || kind === 'crm_p4_verify') && (summary.crmMode !== true || summary.crmP4Mode !== true)) {
    reasons.push('crm_p4_matrix_mode_mismatch');
  }

  const stats = summary.stats ?? {};
  if (Number(stats.unexpected ?? 0) > 0) reasons.push(`matrix_unexpected_failures:${stats.unexpected}`);
  if (Number(stats.skipped ?? 0) > 0) reasons.push(`matrix_skipped_tests:${stats.skipped}`);
  if (Number(stats.flaky ?? 0) > 0) reasons.push(`matrix_flaky_tests:${stats.flaky}`);
  if (Number(stats.expected ?? 0) <= 0) reasons.push('matrix_zero_expected_tests');

  const rows = Array.isArray(summary.rows) ? summary.rows : [];
  if (rows.length === 0) reasons.push('matrix_empty_rows');

  const nonExpected = rows.filter((r) => r?.status !== 'expected');
  if (nonExpected.length > 0) reasons.push(`matrix_non_expected_rows:${nonExpected.length}`);

  const perProjectCounts = new Map();
  for (const r of rows) {
    const p = String(r?.project ?? '');
    perProjectCounts.set(p, (perProjectCounts.get(p) ?? 0) + 1);
  }

  const minPerProject =
    kind === 'workspace'
      ? Math.max(1, Math.floor(Number(summary.coverage?.required ?? 0) / Math.max(1, projects.length)))
      : kind === 'crm_core'
        ? 6
        : 2;

  for (const proj of projects) {
    const cnt = perProjectCounts.get(proj) ?? 0;
    if (cnt < minPerProject) {
      reasons.push(`project_insufficient_coverage:${proj}:${cnt}<${minPerProject}`);
    }
  }

  if (kind === 'workspace') {
    const cov = summary.coverage;
    if (!cov || cov.complete !== true) {
      reasons.push(
        `workspace_coverage_incomplete:missing=${cov?.missing?.length ?? 'unknown'},failed=${cov?.failed?.length ?? 'unknown'}`,
      );
    }
    if (Number(cov?.required ?? 0) <= 0) {
      reasons.push('workspace_coverage_required_zero');
    }
  }

  const expectedMinTotal = projects.length * minPerProject;
  if (Number(stats.expected ?? 0) < expectedMinTotal) {
    reasons.push(`matrix_total_expected_below_floor:${stats.expected}<${expectedMinTotal}`);
  }

  return {
    ok: reasons.length === 0,
    reasons,
    stats: {
      projectsCovered: projects.filter((p) => (perProjectCounts.get(p) ?? 0) >= minPerProject).length,
      totalProjects: projects.length,
      rows: rows.length,
      expected: Number(stats.expected ?? 0),
      recordMode: Boolean(summary.recordMode),
    },
  };
}

function hashDirectoryTree(absDir) {
  if (!existsSync(absDir)) return { exists: false, files: {} };
  const files = {};
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const rel = relative(absDir, full).split(sep).join('/');
        const digest = createHash('sha256').update(readFileSync(full)).digest('hex');
        files[rel] = { sha256: digest, bytes: statSync(full).size };
      }
    }
  }
  walk(absDir);
  return { exists: true, files };
}

/**
 * Snapshot SHA-256 digests of all preserved accepted baseline directories before running matrices.
 * If P4 baselines already exist before the run, include them so they cannot be silently overwritten.
 */
export function snapshotBaselineProvenance(root, extraPreservedDirs = []) {
  const dirs = [...PRESERVED_BASELINE_DIRS, ...extraPreservedDirs];
  const snapshot = {};
  for (const relDir of dirs) {
    snapshot[relDir] = hashDirectoryTree(join(root, relDir));
  }
  return snapshot;
}

/**
 * Verify that no preserved baseline directory had any file added, modified, or removed.
 */
export function verifyPreservedBaselinesUnchanged(before, after) {
  const diffs = [];
  for (const [relDir, beforeTree] of Object.entries(before)) {
    const afterTree = after[relDir] ?? { exists: false, files: {} };
    if (beforeTree.exists !== afterTree.exists) {
      diffs.push(`baseline_dir_existence_changed:${relDir}:${beforeTree.exists}->${afterTree.exists}`);
      continue;
    }
    if (!beforeTree.exists) continue;
    const beforeKeys = Object.keys(beforeTree.files);
    const afterKeys = Object.keys(afterTree.files);
    for (const k of beforeKeys) {
      if (!(k in afterTree.files)) {
        diffs.push(`baseline_file_removed:${relDir}/${k}`);
      } else if (beforeTree.files[k].sha256 !== afterTree.files[k].sha256) {
        diffs.push(`baseline_file_modified:${relDir}/${k}`);
      }
    }
    for (const k of afterKeys) {
      if (!(k in beforeTree.files)) {
        diffs.push(`baseline_file_added:${relDir}/${k}`);
      }
    }
  }
  return { ok: diffs.length === 0, diffs };
}
