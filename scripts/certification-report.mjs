import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const localOrigin = (value) => {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname) || !['', '/'].includes(url.pathname) || url.username || url.password || url.search || url.hash) throw new Error('Certification requires a loopback HTTP origin');
  return url.origin;
};
export const redactCertification = text => String(text).replace(/(\"(?:access_token|refresh_token|token|password|client_secret|inviteCode|handle)\"\s*:\s*\")[^\"]*/gi, '$1[REDACTED]').replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer [REDACTED]').replace(/([?&](?:code|token|access_token|refresh_token|client_secret)=)[^&\s\"']+/gi, '$1[REDACTED]');
const details = error => error == null ? null : { message: redactCertification(error?.message ?? error), ...(error?.stack ? { stack: redactCertification(error.stack) } : {}) };
const safe = value => String(value).replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 120);

/** Explicit suite completion markers prevent a partial console transcript from certifying a run. */
export function createCertificationReporter(runner, plannedTests = []) {
  const startedAt = new Date().toISOString(), results = [], completed = new Set(), browserVersions = {}, artifacts = [];
  let finished = false, written = false;
  const ownedBrowsers = new Set();
  const metadata = {};
  const record = (engine, viewport, test, status, error = null, options = {}) => {
    const normalized = status === 'PASS' ? 'PASS' : status === 'NOT RUN' ? 'NOT RUN' : 'FAIL';
    const blocking = options.external !== true && normalized !== 'PASS';
    const row = { suiteId: runner, engine, viewport, test, status: normalized, error: details(error ?? (normalized === 'FAIL' ? `Assertion failed (${status})` : normalized === 'NOT RUN' ? 'Mandatory check not executed' : null)), blocking, ...options };
    results.push(row);
    for (const key of [test, `${engine}/${test}`, `${engine}/${viewport}/${test}`]) if (plannedTests.includes(key)) completed.add(key);
    return row;
  };
  const finalize = () => {
    if (written) return;
    written = true;
    if (!finished) record('system', 'none', 'runner completion', 'FAIL', 'Runner terminated before its completion checkpoint');
    if (!results.some(r => r.engine !== 'system' && r.status !== 'NOT RUN')) record('system', 'none', 'nonempty assertion report', 'FAIL', 'No assertions executed');
    for (const test of plannedTests) if (!completed.has(test)) record('system', 'none', test, 'FAIL', 'Mandatory suite checkpoint did not execute');
    const summary = { pass: results.filter(r => r.status === 'PASS').length, fail: results.filter(r => r.status === 'FAIL').length, notRun: results.filter(r => r.status === 'NOT RUN').length, blocking: results.filter(r => r.blocking).length, total: results.length };
    const report = { ...metadata, schemaVersion: 1, runner, sourceSha: process.env.CERT_SOURCE_SHA ?? null, fixtureId: process.env.CERT_FIXTURE_ID ?? null, startedAt, endedAt: new Date().toISOString(), plannedTests, completedTests: [...completed], allMandatoryAssertionsExecuted: finished && results.some(r => r.engine !== 'system' && r.status !== 'NOT RUN') && plannedTests.every(t => completed.has(t)) && !results.some(r => (r.status === 'NOT RUN' && r.blocking) || (r.engine === 'system' && r.status === 'FAIL')), summary, status: summary.blocking ? 'FAIL' : 'PASS', results, browserVersions, artifacts };
    if (summary.blocking) process.exitCode = 1;
    if (process.env.CERT_RESULT_PATH) {
      try { mkdirSync(dirname(process.env.CERT_RESULT_PATH), { recursive: true }); writeFileSync(process.env.CERT_RESULT_PATH, JSON.stringify(report, null, 2) + '\n'); }
      catch (error) { console.error(`Certification report write failed: ${error.message}`); process.exitCode = 2; }
    }
    return report;
  };
  process.on('exit', finalize);
  const abort = async (name, error, code) => {
    record('system', 'none', name, 'FAIL', error);
    await Promise.allSettled([...ownedBrowsers].flatMap(browser => browser.contexts().map(context => context.close())));
    await Promise.allSettled([...ownedBrowsers].map(browser => browser.close()));
    finalize(); process.exit(code);
  };
  for (const name of ['uncaughtException', 'unhandledRejection']) process.on(name, error => { void abort(name, error, 2); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void abort(signal, new Error('Runner interrupted'), signal === 'SIGINT' ? 130 : 143); });
  const finish = () => { finished = true; return finalize(); };
  const trackBrowser = (browser, engine) => { ownedBrowsers.add(browser); return captureBrowserArtifacts(browser, engine, { results, browserVersions, artifacts }); };
  const run = async (key, engine, viewport, fn) => {
    const before = results.length;
    try { const value = await fn(); if (results.length === before) record(engine, viewport, key, 'FAIL', 'Suite completed without assertions'); completed.add(key); return value; }
    catch (error) { record(engine, viewport, key, 'FAIL', error); console.error(`FAIL [${engine}/${viewport}] ${key}: ${error.message}`); return undefined; }
  };
  return { record, results, completed, browserVersions, artifacts, run, trackBrowser, finish, finalize, complete: key => completed.add(key), setMetadata: (key, value) => { metadata[key] = value; } };
}

export async function captureBrowserArtifacts(browser, engine, { results, browserVersions = {}, artifacts = [] }) {
    browserVersions[engine] = browser.version();
    const contexts = new Set();
    const original = browser.newContext.bind(browser);
    browser.newContext = async (...args) => {
      const context = await original(...args); contexts.add(context);
      if (process.env.CERT_ARTIFACT_DIR) await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      const close = context.close.bind(context);
      context.close = async (...closeArgs) => {
        if (process.env.CERT_ARTIFACT_DIR) {
          const failures = results.filter(r => r.status === 'FAIL' && (r.engine === engine || r.engine === 'system'));
          const stem = `${safe(engine)}-${contexts.size}-${Date.now()}`;
          if (failures.length) {
            for (const [index, page] of context.pages().entries()) { const path = join(process.env.CERT_ARTIFACT_DIR, `${stem}-${index}.png`); try { await page.screenshot({ path, fullPage: true, timeout: 5000 }); artifacts.push(path); } catch {} }
            const path = join(process.env.CERT_ARTIFACT_DIR, `${stem}-trace.zip`); try { await context.tracing.stop({ path }); artifacts.push(path); } catch {}
          } else await context.tracing.stop().catch(() => {});
        }
        return close(...closeArgs);
      };
      return context;
    };
    return browser;
}
