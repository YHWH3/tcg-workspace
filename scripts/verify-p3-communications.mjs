#!/usr/bin/env node
// Deterministic local P3 + P2 hardening verification script with concise JSON summary output.
// Runs targeted Vitest suites, typecheck, pack validation, and certification selftests.
// Usage: node scripts/verify-p3-communications.mjs [--json-out <path>] [--with-build]
import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const withBuild = args.includes('--with-build');
const jsonOutIdx = args.indexOf('--json-out');
const jsonOutPath = jsonOutIdx >= 0 && args[jsonOutIdx + 1] ? resolve(args[jsonOutIdx + 1]) : null;

const TARGETED_VITEST_FILES = [
  'tests/crm-p2-hardening-d1.test.ts',
  'tests/crm-p2-merge.test.ts',
  'tests/crm-p2-merge-d1.test.ts',
  'tests/crm-p2-merge-client.test.ts',
  'tests/crm-p3-channels.test.ts',
  'tests/crm-p3-zoho-d1.test.ts',
  'tests/crm-p3-meta-d1.test.ts',
  'tests/crm-p3-channels-client.test.ts',
  'tests/crm-p1-identity-d1.test.ts',
  'tests/crm-p1-conversations-d1.test.ts',
  'tests/crm-p1-programmes-d1.test.ts',
  'tests/crm-p1-pipelines-patrons-d1.test.ts',
  'tests/crm-isolation.test.ts',
  'tests/crm-routes.test.ts',
];

const steps = [
  { id: 'typecheck', cmd: 'npm', args: ['run', 'typecheck'] },
  ...(withBuild ? [{ id: 'build', cmd: 'npm', args: ['run', 'build'] }] : []),
  {
    id: 'vitest-p2-p3',
    cmd: resolve(root, 'node_modules/.bin/vitest'),
    args: ['run', ...TARGETED_VITEST_FILES],
  },
  { id: 'tcg-pack', cmd: process.execPath, args: ['scripts/_validate-tcg-pack.mjs'] },
  {
    id: 'certification-selftests',
    cmd: process.execPath,
    args: [
      '--test',
      'scripts/certification/release-rehearsal.test.mjs',
      'scripts/certification/release-preflight.test.mjs',
      'scripts/certification/core.test.mjs',
      'scripts/access/selftest.mjs',
    ],
  },
];

const startedAt = new Date().toISOString();
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

const results = [];
let allOk = true;

for (const step of steps) {
  const t0 = Date.now();
  const proc = spawnSync(step.cmd, step.args, {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
  const durationMs = Date.now() - t0;
  const ok = proc.status === 0;
  if (!ok) allOk = false;
  const combined = `${proc.stdout ?? ''}\n${proc.stderr ?? ''}`.trim();
  const tailLines = combined.split(/\r?\n/).filter(Boolean).slice(-6);
  results.push({
    id: step.id,
    ok,
    exitCode: proc.status ?? 1,
    durationMs,
    summaryTail: tailLines,
  });
  if (!ok) {
    process.stderr.write(`\n[verify-p3] FAILED step "${step.id}" (exit ${proc.status}):\n${combined}\n`);
  }
}

const report = {
  schema: 'tcg-crm.verify-p3.v1',
  startedAt,
  finishedAt: new Date().toISOString(),
  branch,
  sha,
  ok: allOk,
  simulatedTransportOnly: true,
  realProviderVerified: false,
  steps: results,
};

const json = JSON.stringify(report, null, 2);
if (jsonOutPath) {
  mkdirSync(dirname(jsonOutPath), { recursive: true });
  writeFileSync(jsonOutPath, json + '\n');
}
process.stdout.write(json + '\n');
process.exitCode = allOk ? 0 : 1;
