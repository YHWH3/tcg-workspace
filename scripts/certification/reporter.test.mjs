import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const reporter = new URL('../certification-report.mjs', import.meta.url).href;
const invoke = (body, planned = ['one']) => {
  const directory = mkdtempSync(join(tmpdir(), 'tcg-reporter-test-')), report = join(directory, 'result.json');
  try {
    const source = `import {createCertificationReporter} from ${JSON.stringify(reporter)}; const reporter=createCertificationReporter('selftest',${JSON.stringify(planned)}); ${body}`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, CERT_RESULT_PATH: report, CERT_SOURCE_SHA: 'test-source' }, encoding: 'utf8', timeout: 10000 });
    return { ...child, report: JSON.parse(readFileSync(report, 'utf8')) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
};

test('successful reporter requires every explicit assertion and completion', () => {
  const { status, report } = invoke("reporter.record('chromium','compact','one','PASS'); reporter.finish();");
  assert.equal(status, 0); assert.equal(report.status, 'PASS'); assert.equal(report.allMandatoryAssertionsExecuted, true);
  assert.equal(report.sourceSha, 'test-source'); assert.deepEqual(report.completedTests, ['one']); assert.equal(report.summary.pass, 1);
});
test('false assertion is a failing process with engine, viewport and error', () => {
  const { status, report } = invoke("reporter.record('webkit','tablet','one','FAIL'); reporter.finish();");
  assert.notEqual(status, 0); assert.equal(report.results[0].engine, 'webkit'); assert.equal(report.results[0].viewport, 'tablet'); assert.match(report.results[0].error.message, /Assertion failed/);
});
test('thrown error before first assertion cannot pass', () => {
  const { status, report } = invoke("throw new Error('exact thrown suite');");
  assert.notEqual(status, 0); assert.equal(report.allMandatoryAssertionsExecuted, false); assert.ok(report.results.some(r => r.error?.message === 'exact thrown suite'));
});
test('early exit after some assertions cannot pass', () => {
  const { status, report } = invoke("reporter.record('firefox','desktop','one','PASS'); process.exit(0);", ['one', 'two']);
  assert.notEqual(status, 0); assert.equal(report.status, 'FAIL'); assert.equal(report.allMandatoryAssertionsExecuted, false); assert.ok(report.results.some(r => r.test === 'two' && r.status === 'FAIL'));
});
test('empty report is failure even if finish is called', () => {
  const { status, report } = invoke('reporter.finish();', []);
  assert.notEqual(status, 0); assert.equal(report.allMandatoryAssertionsExecuted, false); assert.ok(report.results.some(r => r.test === 'nonempty assertion report'));
});
test('missing mandatory named assertion fails after finish', () => {
  const { status, report } = invoke("reporter.record('none','none','one','PASS'); reporter.finish();", ['one', 'two']);
  assert.notEqual(status, 0); assert.equal(report.allMandatoryAssertionsExecuted, false); assert.equal(report.summary.fail, 1);
});
test('mandatory NOT RUN blocks passing but external device gates are recorded separately', () => {
  const missing = invoke("reporter.record('chromium','compact','one','NOT RUN'); reporter.finish();");
  assert.notEqual(missing.status, 0); assert.equal(missing.report.summary.notRun, 1); assert.equal(missing.report.allMandatoryAssertionsExecuted, false);
  const external = invoke("reporter.record('none','none','one','PASS'); reporter.record('manual','device','physical iOS','NOT RUN','No physical device',{external:true}); reporter.finish();");
  assert.equal(external.status, 0); assert.equal(external.report.summary.notRun, 1); assert.equal(external.report.summary.blocking, 0);
});
test('invalid legacy status is never treated as PASS', () => {
  const { status, report } = invoke("reporter.record('chromium','desktop','one','FAIL (launch failed)'); reporter.finish();");
  assert.notEqual(status, 0); assert.equal(report.results[0].status, 'FAIL'); assert.match(report.results[0].error.message, /launch failed/);
});
test('a suite checkpoint cannot complete with zero assertions', () => {
  const { status, report } = invoke("await reporter.run('one','chromium','desktop',async()=>{}); reporter.finish();");
  assert.notEqual(status, 0); assert.ok(report.results.some(r => r.error?.message === 'Suite completed without assertions'));
});
test('unhandled rejection produces structured error and a nonzero exit', () => {
  const { status, report } = invoke("Promise.reject(new Error('rejected suite')); await new Promise(resolve=>setTimeout(resolve,100));");
  assert.notEqual(status, 0); assert.ok(report.results.some(r => r.test === 'unhandledRejection' && r.error.message === 'rejected suite'));
});
test('interrupted runner preserves incomplete evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tcg-reporter-signal-')), path = join(directory, 'result.json');
  try {
    const source = `import {createCertificationReporter} from ${JSON.stringify(reporter)}; createCertificationReporter('signal',['one']); console.log('ready'); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, CERT_RESULT_PATH: path }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise(resolve => child.stdout.once('data', resolve));
    child.kill('SIGTERM'); const [code] = await new Promise(resolve => child.once('exit', (...values) => resolve(values)));
    const report = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(code, 143); assert.equal(report.status, 'FAIL'); assert.equal(report.allMandatoryAssertionsExecuted, false); assert.ok(report.results.some(r => r.test === 'SIGTERM'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
