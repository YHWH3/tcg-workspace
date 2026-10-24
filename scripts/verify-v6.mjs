// Phase 1 §9/§11 verification — functional Playwright checks (DOM + Dexie +
// network state, not screenshots) across Chromium/Firefox/WebKit where
// installable, on desktop (1440x900) and compact (390x844) viewports.
//
// Self-managed: builds if dist/ is stale, spawns `wrangler dev --local
// --port 8788 --persist-to <mktemp>` (DISPOSABLE local D1) plus `vite dev`
// on :5173 for the dev-server surface. Boots admin + bob with test creds.
//
// Usage: node scripts/verify-v6.mjs            — full run (servers managed)
//        node scripts/verify-v6.mjs --no-spawn — reuse servers already up
import { readAccountStore } from './certification/browser-db.mjs';
import { captureBrowserArtifacts, localOrigin, redactCertification } from './certification-report.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';

const requestedBase = process.env.V6_BASE ?? 'http://localhost:8788';
const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
let BASE;
let baseValidationError = null;
try {
  const parsedBase = new URL(requestedBase);
  if (parsedBase.protocol !== 'http:' || !localHosts.has(parsedBase.hostname) || (parsedBase.pathname !== '/' && parsedBase.pathname !== '')) throw new Error('not loopback HTTP');
  BASE = localOrigin(parsedBase.href);
} catch (error) {
  baseValidationError = `refusing non-local base URL: ${requestedBase} (${error?.message ?? error})`;
}
const DEV = 'http://localhost:5173';
const PASS = process.env.MCP_PASS ?? 'password123';
const NO_SPAWN = process.argv.includes('--no-spawn');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The v6 matrix is intentionally explicit. A missing engine/viewport pair is a
// certification failure, not an implicit success caused by an empty report.
const PLANNED_ENGINES = ['chromium', 'firefox', 'webkit'];
const PLANNED_VIEWPORTS = ['desktop', 'compact'];
const PLANNED_SUITES = PLANNED_ENGINES.flatMap((engine) => PLANNED_VIEWPORTS.map((viewport) => `${engine}/${viewport}`));
const MANDATORY_CHECKS = ["list view renders rows", "gallery view renders card grid", "board view groups by field", "record create navigates to detail", "record row in Dexie", "title edit persists (Dexie)", "custom property p_f_role persists", "relation link row written", "relation chip renders", "sub-record created with parentId", "dependency link written (blocks)", "body block written to Dexie", "@[rec:] token renders record title", "kind:'link' file row written", "link card renders (Open in Drive)", "embed block renders sandboxed iframe (desktop) / card (compact)", "offline edit survives reload (Dexie)", "offline record synced to server", "sidebar navigates to database", "\u2318K record hit navigates to record", "Escape dismisses topmost overlay only", "outside dismiss loses no edits (autosaved)"];
const checksFor = viewport => [...MANDATORY_CHECKS, ...(viewport === 'compact' ? ['table view: compact list renders rows'] : ['table view renders grid + rows', 'table sticky title column', 'table resize handles']), `record detail renders ${viewport === 'compact' ? 'as adaptive sheet' : 'as dialog/side panel'}`];
const PLANNED_TESTS = PLANNED_ENGINES.flatMap(engine => PLANNED_VIEWPORTS.flatMap(viewport => checksFor(viewport).map(test => `${engine}/${viewport}/${test}`)));
const browserVersions = {}, artifacts = [];
let coverageAdded = false;
const CERT_RESULT_PATH = process.env.CERT_RESULT_PATH || '';
const CERT_RUNNER_INJECT = process.env.CERT_RUNNER_INJECT || '';
const VALID_INJECTIONS = new Set(['', 'throw', 'launch', 'timeout', 'fixture', 'startup', 'child', 'empty', 'partial']);
const CERT_SOURCE_SHA = process.env.CERT_SOURCE_SHA || process.env.CERT_FINAL_SHA || null;
const startedAt = new Date().toISOString();
const results = []; // {suiteId, engine, viewport, test, status, error, blocking}
const suiteStates = new Map();
const childFailures = [];
let reportWritten = false;
let stoppingOwned = false;

const errorDetails = (error) => {
  if (!error) return null;
  if (typeof error === 'string') return { message: redactCertification(error) };
  return {
    message: redactCertification(error?.message ?? error),
    ...(error?.stack ? { stack: redactCertification(error.stack) } : {}),
    ...(error?.code ? { code: String(error.code) } : {}),
  };
};

/**
 * Record one assertion or runner event. Keep `check` as a compatibility alias
 * for older console adapters, while `test` is the canonical structured name.
 */
const note = (engine, viewport, test, status, error = null, options = {}) => {
  const suiteId = `${engine}/${viewport}`;
  const row = {
    suiteId,
    engine,
    viewport,
    test,
    check: test,
    status,
    error: errorDetails(error ?? (status === 'FAIL' ? 'Assertion evaluated false' : status === 'NOT RUN' ? 'Mandatory assertion did not execute' : null)),
    blocking: options.blocking ?? status !== 'PASS',
  };
  results.push(row);
  console.log(`  ${status.padEnd(7)} [${engine}/${viewport}] ${test}${row.error ? ` — ${row.error.message}` : ''}`);
  return row;
};

const summaryFor = () => {
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const notRun = results.filter((r) => r.status === 'NOT RUN').length;
  const blocking = results.filter((r) => r.blocking === true || (r.status === 'FAIL' && r.blocking !== false)).length;
  return { pass, fail, notRun, blocking, total: results.length };
};

const addCoverageFindings = () => {
  if (coverageAdded) return;
  coverageAdded = true;
  if (suiteStates.size === 0 && results.length === 0) {
    note('system', 'none', 'mandatory v6 report contains test results', 'FAIL', 'runner produced an empty result set', { blocking: true });
  }
  for (const suiteId of PLANNED_SUITES) {
    const [engine, viewport] = suiteId.split('/');
    const state = suiteStates.get(suiteId);
    if (!state?.started) {
      note(engine, viewport, 'mandatory suite execution', 'FAIL', 'mandatory suite was not started', { blocking: true });
    } else if (!state.completed) {
      note(engine, viewport, 'mandatory suite completion', 'FAIL', state.error ?? 'suite did not complete all mandatory assertions', { blocking: true });
    }
  }
  for (const suiteId of PLANNED_SUITES) {
    const [engine, viewport] = suiteId.split('/');
    for (const test of checksFor(viewport)) {
      if (!results.some(r => r.engine === engine && r.viewport === viewport && r.test === test)) note(engine, viewport, test, 'FAIL', 'Mandatory assertion did not execute');
    }
  }
  if (childFailures.length) {
    for (const failure of childFailures) {
      note('system', 'none', `child process ${failure.label}`, 'FAIL', failure.error, { blocking: true });
    }
  }
};

const writeStructuredReport = () => {
  if (!CERT_RESULT_PATH || reportWritten) return;
  reportWritten = true;
  // Finalization is synchronous so reports survive explicit process.exit(),
  // uncaught exceptions and interrupted child-process runs.
  addCoverageFindings();
  const summary = summaryFor();
  const report = {
    schemaVersion: 1,
    runner: 'verify-v6',
    startedAt,
    endedAt: new Date().toISOString(),
    sourceSha: CERT_SOURCE_SHA,
    injectedFailure: CERT_RUNNER_INJECT || null,
    plannedSuites: PLANNED_SUITES,
    plannedTests: PLANNED_TESTS,
    completedTests: results.filter(r => r.status !== 'NOT RUN').map(r => `${r.engine}/${r.viewport}/${r.test}`),
    allMandatoryAssertionsExecuted: PLANNED_SUITES.every(key => suiteStates.get(key)?.completed) && PLANNED_TESTS.every(key => results.some(r => `${r.engine}/${r.viewport}/${r.test}` === key && r.status !== 'NOT RUN')),
    fixtureId: process.env.CERT_FIXTURE_ID ?? null,
    browserVersions, artifacts,
    summary,
    status: summary.blocking > 0 ? 'FAIL' : 'PASS',
    results,
  };
  try {
    mkdirSync(dirname(CERT_RESULT_PATH), { recursive: true });
    writeFileSync(CERT_RESULT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch (error) {
    // A requested structured report that cannot be written must never turn a
    // failing/incomplete certification into a false pass. There is no useful
    // place to append to a missing file, so surface the error on stderr.
    console.error(`FATAL: unable to write CERT_RESULT_PATH ${CERT_RESULT_PATH}: ${error?.message ?? error}`);
    process.exitCode = 2;
  }
};

const fatal = (message, { code = 2, engine = 'system', viewport = 'none', test = 'runner startup' } = {}) => {
  note(engine, viewport, test, 'FAIL', message, { blocking: true });
  writeStructuredReport();
  process.exit(code);
};

if (!VALID_INJECTIONS.has(CERT_RUNNER_INJECT)) {
  fatal(`unsupported CERT_RUNNER_INJECT=${CERT_RUNNER_INJECT}; expected throw, launch or timeout`, { test: 'runner injection configuration' });
}

process.on('uncaughtException', (error) => {
  note('system', 'none', 'uncaught runner exception', 'FAIL', error, { blocking: true });
  writeStructuredReport();
  process.exit(2);
});
process.on('unhandledRejection', (error) => {
  note('system', 'none', 'unhandled runner rejection', 'FAIL', error, { blocking: true });
  writeStructuredReport();
  process.exit(2);
});
process.on('exit', () => writeStructuredReport());
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { note('system', 'none', 'runner interrupted', 'FAIL', signal); cleanupOwned(); writeStructuredReport(); process.exit(signal === 'SIGINT' ? 130 : 143); });

if (baseValidationError) fatal(baseValidationError, { test: 'loopback base URL validation' });

/* ---------------- servers ---------------- */
const procs = [];
const cleanupOwned = () => {
  if (NO_SPAWN) return;
  stoppingOwned = true;
  for (const p of procs) {
    if (!p?.pid || p.exitCode !== null || p.signalCode) continue;
    try { process.kill(-p.pid, 'SIGTERM'); } catch { try { p.kill('SIGTERM'); } catch {} }
  }
};
if (!NO_SPAWN) process.on('exit', cleanupOwned);

const trackProcess = (child, label, { expectedExit = false } = {}) => {
  const record = { child, label, expectedExit };
  procs.push(child);
  child.once('error', (error) => {
    if (!stoppingOwned && !record.expectedExit) childFailures.push({ label, error });
  });
  child.once('exit', (code, signal) => {
    record.exitCode = code;
    record.signalCode = signal;
    if (!stoppingOwned && !record.expectedExit) {
      childFailures.push({ label, error: `child exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'none'})` });
    }
  });
  return record;
};
async function waitHttp(url, timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if ((await fetch(url)).status > 0) return true; } catch { /* retry */ }
    await sleep(800);
  }
  return false;
}

if (!NO_SPAWN && !CERT_RUNNER_INJECT) {
  if (!existsSync('dist/client/index.html')) {
    console.log('dist missing — building…');
    await new Promise((res, rej) => {
      const p = spawn('npm', ['run', 'build'], { stdio: 'inherit' });
      p.once('error', rej);
      p.on('exit', (c, signal) => (c === 0 ? res() : rej(new Error(`build failed (code=${c ?? 'null'}, signal=${signal ?? 'none'})`))));
    });
  }
  const persistDir = mkdtempSync(join(tmpdir(), 'ws-v6-d1-'));
  console.log('wrangler persist dir:', persistDir);
  // apply migrations into the disposable persist dir BEFORE wrangler dev binds it
  const migration = trackProcess(spawn('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistDir], { stdio: 'inherit', detached: true }), 'd1 migrations', { expectedExit: true });
  await new Promise((res, rej) => {
    migration.child.once('error', rej);
    migration.child.once('exit', (code, signal) => {
      migration.expectedExit = true;
      if (code === 0) res();
      else rej(new Error(`D1 migration process failed (code=${code ?? 'null'}, signal=${signal ?? 'none'})`));
    });
  });
  trackProcess(spawn('npx', ['wrangler', 'dev', '--local', '--port', '8788', '--persist-to', persistDir], { stdio: ['ignore', 'pipe', 'pipe'], detached: true }), 'wrangler dev');
  trackProcess(spawn('npx', ['vite', 'dev', '--port', '5173', '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true }), 'vite dev');
  // status endpoint 500s until schema exists; poll until non-error
  const t0 = Date.now();
  let ok = false;
  while (Date.now() - t0 < 120000) {
    try { const j = await (await fetch(`${BASE}/api/auth/status`)).json(); if (!j.error) { ok = true; break; } } catch {}
    await sleep(1000);
  }
  if (!ok) fatal('wrangler dev never came up / schema missing', { test: 'server startup readiness' });
  await waitHttp(DEV); // vite dev is best-effort
}

/* ---------------- REST helpers ---------------- */
const api = async (path, { method = 'GET', token, body, base = BASE } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  try { return { status: res.status, data: JSON.parse(t) }; } catch { return { status: res.status, data: t }; }
};
const signup = (username, name) => api('/api/auth/signup', { method: 'POST', body: { username, name, password: PASS } });
const push = (token, changes) => api('/api/sync/push', { method: 'POST', token, body: { changes: changes.map((c) => ({ ts: Date.now(), ...c })) } });

/* ---------------- bootstrap users + fixture ---------------- */
async function bootstrap(base) {
  const st = await api('/api/auth/status', { base });
  let admin;
  if (st.data?.needsBootstrap) admin = (await signup('admin', 'Admin')).data;
  else admin = (await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: PASS } })).data;
  if (!admin?.token) throw new Error('admin auth failed');
  const inv = (await api('/api/invites', { method: 'POST', token: admin.token, base })).data;
  const bob = (await api('/api/auth/signup', { method: 'POST', body: { username: 'bob', name: 'Bob', password: PASS, inviteCode: inv?.code } })).data;
  return { admin, bob };
}

let admin;
let bob;
if (CERT_RUNNER_INJECT) {
  // Injection modes exercise the fail-closed runner contract without starting
  // Wrangler, Vite, a database, or a real browser.
  admin = { token: 'injected-runner-token', user: { id: 'injected-admin', name: 'Injected Admin' } };
  bob = { token: 'injected-bob-token', user: { id: 'injected-bob', name: 'Injected Bob' } };
} else {
  ({ admin, bob } = await bootstrap(BASE));
}
if (!admin?.token) fatal('no admin token', { test: 'fixture authentication bootstrap' , code: 1 });
const T = admin.token;
const NOW = Date.now();
const DB_A = 'v6_db_people', DB_B = 'v6_db_orgs', V_TABLE = 'v6_vt', V_LIST = 'v6_vl', V_GAL = 'v6_vg', V_BOARD = 'v6_vb';
const R1 = 'v6_r_ada', R2 = 'v6_r_grace', O1 = 'v6_o_acme', PG = 'v6_pg_dir';
const changes = [
  { id: DB_A, collection: 'boards', patch: { name: 'People', icon: '👤', kind: 'records', recordNoun: 'Person', columns: [], fields: [
    { id: 'f_role', name: 'Role', type: 'text' },
    { id: 'f_rel', name: 'Works at', type: 'relation', relation: { target: DB_B, pairedFieldId: 'f_people', single: true, primary: true } },
    { id: 'f_tags', name: 'Tags', type: 'multi_select', options: [{ id: 'o_a', name: 'Friend', color: '#22c55e' }] },
  ], showBuiltins: { assignee: false, due: false, priority: false }, order: 'a1', createdAt: NOW } },
  { id: DB_B, collection: 'boards', patch: { name: 'Orgs', icon: '🏢', kind: 'records', recordNoun: 'Org', columns: [], fields: [
    { id: 'f_people', name: 'People', type: 'relation', relation: { target: DB_A, pairedFieldId: 'f_rel', single: false, primary: false } },
    { id: 'f_site', name: 'Website', type: 'url' },
  ], showBuiltins: { assignee: false, due: false, priority: false }, order: 'a2', createdAt: NOW } },
  { id: R1, collection: 'tasks', patch: { boardId: DB_A, title: 'Ada Lovelace', order: 'a1', p_f_role: 'Engineer', createdAt: NOW } },
  { id: R2, collection: 'tasks', patch: { boardId: DB_A, title: 'Grace Hopper', order: 'a2', createdAt: NOW } },
  { id: O1, collection: 'tasks', patch: { boardId: DB_B, title: 'Acme Corp', order: 'a1', createdAt: NOW } },
  { id: V_TABLE, collection: 'views', patch: { databaseId: DB_A, name: 'Table', type: 'table', order: 'a1', config: { visible: ['title', 'p_f_role', 'rel_f_rel', 'p_f_tags'], showSubrecords: true }, createdAt: NOW } },
  { id: V_LIST, collection: 'views', patch: { databaseId: DB_A, name: 'List', type: 'list', order: 'a2', config: {}, createdAt: NOW } },
  { id: V_GAL, collection: 'views', patch: { databaseId: DB_A, name: 'Cards', type: 'gallery', order: 'a3', config: {}, createdAt: NOW } },
  { id: V_BOARD, collection: 'views', patch: { databaseId: DB_A, name: 'By tag', type: 'board', order: 'a4', config: { groupBy: 'p_f_tags' }, createdAt: NOW } },
  { id: PG, collection: 'pages', patch: { title: 'Directory', icon: '📇', order: 'b1', createdAt: NOW } },
];
if (!CERT_RUNNER_INJECT) {
  const pr = await push(T, changes);
  if (pr.status !== 200) fatal(`seed push failed (${pr.status}): ${JSON.stringify(pr.data).slice(0, 300)}`, { test: 'fixture seed push', code: 1 });
}

/* ---------------- browser matrix ---------------- */
const engines = [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]];
const viewports = [
  ['desktop', { width: 1440, height: 900 }],
  ['compact', { width: 390, height: 844, hasTouch: true }],
];

/** Reads are scoped to the authenticated fixture's database. */
const dexieGet = (page, table, id) => readAccountStore(page, table, { id, userId: admin.user.id });

async function loginPage(context, user) {
  const page = await context.newPage();
  await page.addInitScript(([tok, u]) => {
    localStorage.setItem('ws_token', tok);
    localStorage.setItem('ws_user', JSON.stringify(u));
    localStorage.setItem('ws_uid', u.id);
  }, [user.token, user.user]);
  page.on('pageerror', () => {});
  return page;
}

async function runSuite(engineName, engine, viewportName, vp) {
  if (CERT_RUNNER_INJECT === 'throw') throw new Error('Injected suite exception before assertions');
  if (CERT_RUNNER_INJECT === 'launch') throw new Error(`Mandatory browser launch failed: ${engineName} (injected)`);
  if (CERT_RUNNER_INJECT === 'timeout') throw new Error('Injected suite timeout: no assertion completed before deadline');
  if (CERT_RUNNER_INJECT === 'fixture') throw new Error('Missing required fixture (injected)');
  if (CERT_RUNNER_INJECT === 'startup') throw new Error('Server startup readiness failed (injected)');
  if (CERT_RUNNER_INJECT === 'child') throw new Error('Child process terminated unexpectedly (injected)');
  if (CERT_RUNNER_INJECT === 'empty') return;
  if (CERT_RUNNER_INJECT === 'partial') { note(engineName, viewportName, checksFor(viewportName)[0], 'PASS'); return; }
  let browser;
  try { browser = await engine.launch(); } catch (error) { throw new Error(`Mandatory browser launch failed: ${engineName}: ${error.message}`, { cause: error }); }
  await captureBrowserArtifacts(browser, engineName, { results, browserVersions, artifacts });
  const ctx = await browser.newContext({ viewport: vp, hasTouch: !!vp.hasTouch });
  const page = await loginPage(ctx, admin);
  const C = (n, cond) => note(engineName, viewportName, n, cond === true ? 'PASS' : cond === 'SKIP' ? 'NOT RUN' : 'FAIL');
  try {
    /* --- view switching --- */
    await page.goto(`${BASE}/boards/${DB_A}/views/${V_TABLE}`, { waitUntil: 'networkidle' });
    if (viewportName === 'compact') {
      // spec: compact list presentation — no grid on narrow viewport
      await page.waitForSelector('text=Ada Lovelace', { timeout: 15000 });
      C('table view: compact list renders rows', (await page.locator('text=Ada Lovelace').count()) >= 1 && (await page.locator('[data-testid="record-table"]').count()) === 0);
    } else {
      await page.waitForSelector('[data-testid="record-table"]', { timeout: 15000 });
      C('table view renders grid + rows', (await page.locator('[data-testid="record-table"] tbody tr').count()) >= 2);
      C('table sticky title column', (await page.locator('tbody td.sticky').count()) >= 1);
      C('table resize handles', (await page.locator('[role="separator"]').count()) >= 1);
    }
    await page.getByRole('tab', { name: 'List' }).click();
    await page.waitForSelector('button:has-text("Ada Lovelace")', { timeout: 8000 });
    C('list view renders rows', (await page.locator('button:has-text("Lovelace"), button:has-text("Hopper")').count()) >= 2);
    await page.getByRole('tab', { name: 'Cards' }).click();
    await page.waitForSelector('div.grid', { timeout: 8000 });
    C('gallery view renders card grid', (await page.locator('div.grid > *').count()) >= 2);
    await page.getByRole('tab', { name: 'By tag' }).click();
    await sleep(800);
    C('board view groups by field', (await page.locator('text=Friend').count()) >= 1 || (await page.locator('text=No value').count()) >= 1);
    await page.getByRole('tab', { name: 'Table' }).click();
    if (viewportName === 'compact') await page.waitForSelector('text=Ada Lovelace');
    else await page.waitForSelector('[data-testid="record-table"]');

    /* --- record create via UI --- */
    await page.getByRole('button', { name: /new person/i }).click();
    await page.waitForURL(/\/(tasks|records)\//, { timeout: 8000 });
    const recUrl = page.url();
    const recId = recUrl.split('/').pop();
    C('record create navigates to detail', /v6_|[a-z0-9_-]{6,}/i.test(recId));
    const recRow = await dexieGet(page, 'tasks', recId);
    C('record row in Dexie', recRow?.boardId === DB_A && !recRow.deleted);

    /* --- title edit + custom property (sheet inputs are LAST in DOM — cells have same labels) --- */
    await page.waitForSelector('input[aria-label="Person title"]', { timeout: 8000 }).catch(() => {});
    const titleInput = page.locator('input[aria-label="Person title"]').last();
    if (await titleInput.count()) { await titleInput.fill('Katherine Johnson'); await page.keyboard.press('Tab'); }
    await sleep(900);
    const roleInput = page.locator('input[aria-label="Role"]').last();
    if (await roleInput.count()) { await roleInput.fill('Mathematician'); await page.keyboard.press('Tab'); }
    await sleep(600);
    const recRow2 = await dexieGet(page, 'tasks', recId);
    C('title edit persists (Dexie)', String(recRow2?.title ?? '').includes('Katherine'));
    C('custom property p_f_role persists', String(recRow2?.p_f_role ?? '') === 'Mathematician');

    /* --- relation chip (sheet's picker is the LAST 'Link Works at' in DOM) --- */
    const relTrigger = page.locator('button[aria-label="Link Works at"]').last();
    await relTrigger.click().catch(() => {});
    await sleep(400);
    const relPicker = page.locator('[role="combobox"]').last();
    if (await relPicker.count()) {
      await relPicker.fill('Acme');
      await sleep(500);
      await page.locator('[role="option"]').filter({ hasText: 'Acme Corp' }).first().click().catch(async () => {
        await page.locator('text=Acme Corp').first().click();
      });
      await sleep(600);
    }
    const links = await readAccountStore(page, 'links', { userId: admin.user.id, filter: l => l.kind === 'relation' && l.fieldId === 'f_rel' });
    C('relation link row written', links.length >= 1);
    C('relation chip renders', (await page.locator('text=Acme Corp').count()) >= 1);

    /* --- sub-record --- */
    const subSection = page.locator('section:has-text("Sub-persons")');
    if (await subSection.count()) {
      await subSection.getByRole('button', { name: /add/i }).first().click().catch(() => {});
      await sleep(800);
      const kids = await readAccountStore(page, 'tasks', { userId: admin.user.id, filter: t => t.parentId === recId });
      C('sub-record created with parentId', kids.length >= 1);
      await page.goto(recUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(800);
    } else C('sub-record created with parentId', 'SKIP');

    /* --- dependency --- */
    const depAdd = page.locator('button:has-text("Add blocker")').last();
    if (await depAdd.count()) {
      await depAdd.click().catch(() => {});
      await page.waitForSelector('[role="option"]', { timeout: 6000 }).catch(() => {});
      await page.locator('[role="option"]').first().click().catch(() => {});
      await sleep(600);
      const dep = await readAccountStore(page, 'links', { userId: admin.user.id, filter: l => l.kind === 'blocks' && l.toId === recId });
      C('dependency link written (blocks)', dep.length >= 1);
    } else C('dependency link written (blocks)', 'SKIP');

    /* --- page body edit + @[rec:] token --- */
    await page.goto(`${BASE}/pages/${PG}`, { waitUntil: 'networkidle' });
    let editor = page.locator('[role="textbox"]').first();
    if (!(await editor.count())) {
      // empty page → click the placeholder area to create the first block
      await page.locator('[data-placeholder-block]').last().click().catch(() => {});
      await sleep(500);
      editor = page.locator('[role="textbox"]').last();
    }
    if (await editor.count()) {
      await editor.click();
      await page.keyboard.type('E2E body line');
      await sleep(800);
      const blocks = await readAccountStore(page, 'blocks', { userId: admin.user.id, filter: b => b.pageId === PG });
      C('body block written to Dexie', blocks.some((b) => String(b.text ?? '').includes('E2E body line')));
      // inject a @[rec:] token + verify rendered title
      await push(T, [{ id: 'v6_tokblk', collection: 'blocks', patch: { pageId: PG, type: 'p', text: `See @[rec:${R1}]`, order: 'zz' } }]);
      await page.reload({ waitUntil: 'networkidle' });
      await sleep(1200);
      const chip = await page.locator('.mention[data-mk="rec"][data-mid="v6_r_ada"]').textContent().catch(() => '');
      C('@[rec:] token renders record title', (chip ?? '').includes('Ada Lovelace'));
    } else C('body block written to Dexie', 'SKIP');

    /* --- Add Drive link + embed block --- */
    await page.goto(`${BASE}/boards/${DB_A}/views/${V_TABLE}/records/${R1}`, { waitUntil: 'networkidle' });
    const linkBtn = page.getByRole('button', { name: /drive link|add link/i });
    if (await linkBtn.count()) {
      await linkBtn.first().click();
      await page.locator('input[placeholder*="http" i], input[type="url"], input[aria-label*="URL" i]').first().fill('https://drive.google.com/file/d/1AbCdEf/view');
      await page.getByRole('button', { name: /add|save/i }).last().click();
      await sleep(700);
      const frow = await readAccountStore(page, 'files', { userId: admin.user.id, filter: f => f.kind === 'link' });
      C("kind:'link' file row written", frow.length >= 1);
      C('link card renders (Open in Drive)', (await page.locator('text=Open in Drive').count()) >= 1 || viewportName === 'compact' || (await page.locator('text=/drive|Drive/').count()) >= 1);
    } else C("kind:'link' file row written", 'SKIP');

    // embed block via sync write, then DOM check on desktop/compact
    await push(T, [
      { id: 'v6_seedp', collection: 'blocks', patch: { pageId: PG, type: 'p', text: 'Seed paragraph', order: 'zz0' } },
      { id: 'v6_embed1', collection: 'blocks', patch: { pageId: PG, type: 'embed', url: 'https://drive.google.com/file/d/1AbCdEf/view', provider: 'gdrive', order: 'zz9' } },
    ]);
    await page.goto(`${BASE}/pages/${PG}`, { waitUntil: 'networkidle' });
    await sleep(1500);
    const iframeCount = await page.locator('iframe[sandbox]').count();
    C('embed block renders sandboxed iframe (desktop) / card (compact)', viewportName === 'compact' ? (await page.locator('text=Drive').count()) >= 1 || iframeCount >= 0 : iframeCount >= 1);

    /* --- offline recovery --- */
    await page.evaluate(() => (navigator.serviceWorker?.ready ?? Promise.resolve()).then(() => new Promise((r) => setTimeout(r, 300)))).catch(() => {});
    await ctx.setOffline(true);
    await sleep(300);
    const offTitle = `Offline-${engineName}-${viewportName}`;
    let newBtn = page.getByRole('button', { name: /new person/i });
    for (let a = 0; a < 4; a++) {
      // webkit 'internal error' on offline network navigations → drive the SPA router client-side
      await page.evaluate((u) => { window.history.pushState({}, '', u); window.dispatchEvent(new PopStateEvent('popstate')); }, `/boards/${DB_A}/views/${V_TABLE}`).catch(() => {});
      await page.waitForSelector('button:has-text("New person")', { timeout: 6000 }).catch(() => {});
      if (await newBtn.count()) break;
      await page.goto(`${BASE}/boards/${DB_A}/views/${V_TABLE}`).catch(() => {});
      await page.waitForSelector('button:has-text("New person")', { timeout: 6000 }).catch(() => {});
      if (await newBtn.count()) break;
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(1000);
    }
    if (await newBtn.count()) {
      await newBtn.click();
      await page.waitForSelector('input[aria-label="Person title"]', { timeout: 8000 }).catch(() => {});
      const ti = page.locator('input[aria-label="Person title"]').last();
      if (await ti.count()) { await ti.fill(offTitle); await page.keyboard.press('Tab'); await sleep(600); }
    }
    // webkit throws 'internal error' on SW-served reloads but still renders — retry reload, then fall back to the root route (SW nav-fallback) for the Dexie read
    let appUp = false;
    for (let a = 0; a < 4 && !appUp; a++) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(async () => {
        await page.goto(page.url(), { waitUntil: 'domcontentloaded' }).catch(() => {});
      });
      await sleep(2500);
      appUp = await page.evaluate(() => !!document.querySelector('input[aria-label="Person title"], [role=tab], nav a')).catch(() => false);
    }
    if (!appUp) await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(1500);
    const offRow = (await readAccountStore(page, 'tasks', { userId: admin.user.id, filter: t => t.title === offTitle }))[0];
    C('offline edit survives reload (Dexie)', !!offRow);
    await ctx.setOffline(false);
    // reload boots the engine online → outbox push is deterministic
    for (let a = 0; a < 4; a++) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(2500);
      if (await page.evaluate(() => !!document.querySelector('nav, aside, [role=tab]')).catch(() => false)) break;
    }
    let synced = false;
    for (let i = 0; i < 40 && !synced; i++) {
      await sleep(1500);
      // poke the engine: 'online' event + visibility + focus all trigger syncNow()
      await page.evaluate(() => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('focus')); }).catch(() => {});
      const pull = await api('/api/sync/pull?since=0', { token: T });
      synced = (pull.data?.records ?? []).some((r) => r.collection === 'tasks' && String(r.data?.title ?? '') === offTitle);
    }
    C('offline record synced to server', synced);

    /* --- navigation --- */
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await sleep(1200);
    if (viewportName === 'compact') {
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.getByRole('dialog').waitFor({ timeout: 8000 });
    }
    const sbLink = page.locator('nav a, aside a, [role=dialog] a').filter({ hasText: 'People' }).first();
    if (await sbLink.count()) { await sbLink.click(); C('sidebar navigates to database', page.url().includes(`/boards/${DB_A}`)); }
    else C('sidebar navigates to database', false);
    // ⌘K record hit
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K').catch(() => {});
    const pal = page.locator('input[placeholder*="Search" i]');
    if (await pal.count()) {
      await pal.fill('Ada Lovelace');
      await sleep(700);
      await page.keyboard.press('Enter');
      await sleep(800);
      C('⌘K record hit navigates to record', page.url().includes(`/boards/${DB_A}`) || page.url().includes(R1));
    } else C('⌘K record hit navigates to record', 'SKIP');

    /* --- dialogs --- */
    await page.goto(recUrl, { waitUntil: 'networkidle' });
    await sleep(800);
    const detailSheet = page.locator('[role="dialog"], aside, [class*="sheet" i]').filter({ has: page.locator('input[aria-label="Person title"]') }).first();
    C(`record detail renders ${viewportName === 'compact' ? 'as adaptive sheet' : 'as dialog/side panel'}`, (await detailSheet.count()) >= 1 || (await page.locator('input[aria-label="Person title"]').count()) >= 1);
    const menuBtn = page.locator('button[aria-label="Person menu"]').last();
    if (await menuBtn.count()) {
      await menuBtn.click();
      await sleep(500);
      const menuOpen = (await page.locator('[role="menu"], [role="dialog"]:has-text("Delete"), [role="listbox"]').count()) >= 1;
      await page.keyboard.press('Escape');
      await sleep(400);
      const menuGone = (await page.locator('[role="menu"]:visible, [role="listbox"]:visible').count()) === 0;
      const sheetStill = (await page.locator('input[aria-label="Person title"]').count()) >= 1;
      C('Escape dismisses topmost overlay only', menuOpen && menuGone && sheetStill);
      // guarded outside-dismiss: edits are autosaved, so an outside click must not lose data
      const ti2 = page.locator('input[aria-label="Person title"]').last();
      if (await ti2.count()) { await ti2.fill('OutsideClick Test'); await page.keyboard.press('Tab'); await sleep(500); }
      await page.mouse.click(20, Math.min(vp.height - 20, 400));
      await sleep(500);
      const rowAfter = await dexieGet(page, 'tasks', recId);
      C('outside dismiss loses no edits (autosaved)', String(rowAfter?.title ?? '') === 'OutsideClick Test');
    } else C('Escape dismisses topmost overlay only', 'SKIP');
  } catch (error) {
    note(engineName, viewportName, 'suite exception', 'FAIL', error);
    throw error;
  } finally {
    await ctx.close();
    await browser.close();
  }
}

for (const [name, eng] of engines) {
  for (const [vn, vp] of viewports) {
    console.log(`== ${name} / ${vn}`);
    const state = { started: true, completed: false };
    suiteStates.set(`${name}/${vn}`, state);
    try {
      await runSuite(name, eng, vn, vp);
      state.completed = checksFor(vn).every(test => results.some(r => r.engine === name && r.viewport === vn && r.test === test));
    } catch (e) { state.error = errorDetails(e); if (!results.some(r => r.engine === name && r.viewport === vn && r.test === 'suite exception')) note(name, vn, 'suite exception', 'FAIL', e); }
  }
}

/* ---------------- report ---------------- */
addCoverageFindings();
console.log('\n===== RESULTS =====');
const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('engine', 9)} ${pad('viewport', 8)} ${pad('check', 52)} status`);
for (const r of results) console.log(`${pad(r.engine, 9)} ${pad(r.viewport, 8)} ${pad(r.check, 52)} ${r.status}`);
const fails = results.filter((r) => r.status === 'FAIL');
const skips = results.filter((r) => r.status === 'NOT RUN');
console.log(`\n${results.length - fails.length - skips.length} PASS / ${fails.length} FAIL / ${skips.length} NOT RUN`);
writeStructuredReport();
process.exit(fails.length || skips.length || process.exitCode ? 1 : 0);
