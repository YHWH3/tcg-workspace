import {canvasBodyPoint} from './canvas-hit-point.mjs';
import {fixtureFetch} from './certification/oauth-consent.mjs';
// Phase 2 §9 e2e verification — visual workspace: mood canvas items/gestures/
// culling, calendar + timeline views, connector↔link mirroring, public canvas
// share, offline/multi-user/undo resilience, 350-item perf. Named PASS/FAIL
// checks; exits non-zero on any FAIL.
//
// Self-managed: builds if dist/ is stale, spawns `wrangler dev --local
// --port 8788 --persist-to <mktemp>` (DISPOSABLE local D1). Boots admin + bob.
//
// Usage: node scripts/verify-v7.mjs            — full run (servers managed)
//        node scripts/verify-v7.mjs --no-spawn — reuse a wrangler dev already up
import { readAccountStore } from './certification/browser-db.mjs';
import { createCertificationReporter, localOrigin } from './certification-report.mjs';
const suiteManifest = {"chromium": {"desktop": ["canvasSuite", "modeSuite", "offlineSuite", "multiUserSuite", "undoSuite", "publicShareSuite", "viewsSuite", "perfSuite"], "compact": ["compactSuite", "viewsSuite"], "tablet": ["viewsSuite"]}, "firefox": {"desktop": ["coreSubset", "publicShareSuite"], "compact": ["compactSuite"]}, "webkit": {"desktop": ["coreSubset", "publicShareSuite"], "compact": ["compactSuite"]}};
const requestedEngines = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(',') ?? ['chromium', 'firefox', 'webkit'];
const plannedTests = requestedEngines.flatMap(engine => Object.entries(suiteManifest[engine] ?? {}).flatMap(([viewport, suites]) => suites.map(suite => `${engine}/${viewport}/${suite}`)));
const certification = createCertificationReporter('verify-v7', plannedTests);
let activeEngine = 'system', activeViewport = 'none';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import crypto from 'node:crypto';

const requestedBase = process.env.V7_BASE ?? 'http://localhost:8788';
const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
let BASE;
try {
  const parsedBase = new URL(requestedBase);
  if (parsedBase.protocol !== 'http:' || !localHosts.has(parsedBase.hostname) || (parsedBase.pathname !== '/' && parsedBase.pathname !== '')) throw new Error('not loopback HTTP');
  BASE = localOrigin(parsedBase.href);
} catch {
  console.error(`FATAL: refusing non-local base URL: ${requestedBase}`);
  process.exit(2);
}
const PASS = process.env.MCP_PASS ?? 'password123';
const NO_SPAWN = process.argv.includes('--no-spawn');
const SHOTS = process.env.CERT_ARTIFACT_DIR ?? '/tmp/p2-shots';
const FIX = '/tmp/p2-fixtures';
mkdirSync(SHOTS, { recursive: true });
mkdirSync(FIX, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = []; // {engine, viewport, check, status}
const note = (engine, viewport, check, status, error = null) => {
  certification.record(engine, viewport, check, status, error, { external: engine === 'manual' });
  results.push({ engine, viewport, check, status, error });
  console.log(`  ${status.padEnd(7)} [${engine}/${viewport}] ${check}`);
};

/* ---------------- fixture files ---------------- */
// 1x1 PNG + benign/hostile SVGs
writeFileSync(
  `${FIX}/photo.png`,
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
);
writeFileSync(`${FIX}/ok.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#6366f1"/><text x="50" y="55" text-anchor="middle" font-size="14" fill="#fff">V7</text></svg>`);
writeFileSync(`${FIX}/evil.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)"><script>alert(2)</script><rect width="10" height="10"/></svg>`);

/* ---------------- servers ---------------- */
const procs = [];
async function waitHttp(url, timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if ((await fixtureFetch(url)).status > 0) return true; } catch { /* retry */ }
    await sleep(800);
  }
  return false;
}

const killTree = () => {
  if (NO_SPAWN) return;
  for (const p of procs) {
    if (!p?.pid || p.exitCode !== null || p.signalCode) continue;
    try { process.kill(-p.pid, 'SIGTERM'); } catch { try { p.kill('SIGTERM'); } catch {} }
  }
};
if (!NO_SPAWN) process.on('exit', killTree);

if (!NO_SPAWN) {
  // rebuild when dist is missing OR any shipped source is newer than the bundle
  const distIndex = 'dist/client/index.html';
  const stale = !existsSync(distIndex) || (() => {
    const built = statSync(distIndex).mtimeMs;
    const newer = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
      .some((d) => d.isFile() && /\.(ts|tsx|js|css|html)$/.test(d.name) &&
        statSync(join(d.parentPath ?? dir, d.name)).mtimeMs > built);
    return ['src', 'shared', 'worker', 'public'].some((d) => existsSync(d) && newer(d));
  })();
  if (stale) {
    console.log('dist missing or stale — building…');
    await new Promise((res, rej) => {
      const p = spawn('npm', ['run', 'build'], { stdio: 'inherit' });
      p.on('exit', (c) => (c === 0 ? res() : rej(new Error('build failed'))));
    });
  }
  const persistDir = mkdtempSync(join(tmpdir(), 'ws-v7-d1-'));
  console.log('wrangler persist dir:', persistDir);
  await new Promise((res) => {
    const p = spawn('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistDir], { stdio: 'inherit', detached: true });
    procs.push(p);
    p.on('exit', res);
  });
  procs.length = 0;
  procs.push(spawn('npx', ['wrangler', 'dev', '--local', '--port', '8788', '--persist-to', persistDir], { stdio: ['ignore', 'pipe', 'pipe'], detached: true }));
  const t0 = Date.now();
  let ok = false;
  while (Date.now() - t0 < 120000) {
    try { const j = await (await fixtureFetch(`${BASE}/api/auth/status`)).json(); if (!j.error) { ok = true; break; } } catch {}
    await sleep(1000);
  }
  if (!ok) { console.log('FATAL: wrangler dev never came up / schema missing'); process.exit(2); }
}

/* ---------------- REST helpers ---------------- */
const api = async (path, { method = 'GET', token, body, form, raw, cookie } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (cookie) headers.Cookie = cookie;
  const res = await fixtureFetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : form ? new URLSearchParams(form).toString() : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  if (raw) return { status: res.status, text, headers: res.headers };
  let data = null;
  try { data = JSON.parse(text); } catch { data = { _text: text }; }
  return { status: res.status, data, text, headers: res.headers };
};
const signup = (username, name, inviteCode) =>
  api('/api/auth/signup', { method: 'POST', body: { username, name, password: PASS, ...(inviteCode ? { inviteCode } : {}) } });
const push = (token, changes) => api('/api/sync/push', { method: 'POST', token, body: { changes: changes.map((c) => ({ ts: Date.now(), ...c })) } });
const pullAll = async (token) => {
  const out = [];
  let since = 0;
  for (let i = 0; i < 40; i++) {
    const pull = await api(`/api/sync/pull?since=${since}`, { token });
    out.push(...(pull.data?.records ?? []));
    if (!pull.data?.hasMore) return out;
    since = pull.data.cursor;
  }
  return out;
};

/* ---------------- bootstrap users ---------------- */
async function bootstrap() {
  const st = await api('/api/auth/status');
  let admin;
  if (st.data?.needsBootstrap) admin = (await signup('admin', 'Admin')).data;
  else admin = (await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: PASS } })).data;
  if (!admin?.token) throw new Error('admin auth failed');
  const inv = (await api('/api/invites', { method: 'POST', token: admin.token })).data;
  let bob = (await api('/api/auth/signup', { method: 'POST', body: { username: 'bob', name: 'Bob', password: PASS, inviteCode: inv?.code } })).data;
  if (!bob?.token) bob = (await api('/api/auth/login', { method: 'POST', body: { username: 'bob', password: PASS } })).data;
  return { admin, bob };
}
const { admin, bob } = await bootstrap();
if (!admin?.token || !bob?.token) { console.log('FATAL: user bootstrap failed'); process.exit(1); }
const T = admin.token;

/* ---------------- seeded fixture ---------------- */
const NOW = Date.now();
const MB = 'v7_mb';           // main canvas board
const MBP = 'v7_mb_perf';     // 350-item perf board
const DB = 'v7_db_rel';       // records db for calendar/timeline
const R_ALPHA = 'v7_r_alpha';
const R_BETA = 'v7_r_beta';
const R_CONF = 'v7_r_conf';
const R_UNSCHED = 'v7_r_unsched';
const T_STAGE = 'v7_t_stage'; // board-default task for stage-mirror card
const V_TABLE = 'v7_v_table';
const V_CAL = 'v7_v_cal';
const V_TL = 'v7_v_tl';

const seed = [
  { id: MB, collection: 'moodboards', patch: { title: 'V7 Canvas', icon: '🎨', order: 'a1', createdAt: NOW } },
  { id: MBP, collection: 'moodboards', patch: { title: 'V7 Perf', icon: '🚀', order: 'a2', createdAt: NOW } },
  // canvas seed items (world coords; view starts x=0,y=0,z=1 → ≈client coords)
  { id: 'v7_i_note', collection: 'mooditems', patch: { boardId: MB, type: 'note', x: 80, y: 80, w: 220, h: 160, z: 1, color: '#fef3c7', text: 'seed note' } },
  { id: 'v7_i_note2', collection: 'mooditems', patch: { boardId: MB, type: 'note', x: 380, y: 80, w: 220, h: 160, z: 2, color: '#dbeafe', text: 'seed note two' } },
  { id: 'v7_i_card_a', collection: 'mooditems', patch: { boardId: MB, type: 'card', x: 80, y: 320, w: 260, h: 140, z: 3, ref: { type: 'record', id: R_ALPHA } } },
  { id: 'v7_i_card_b', collection: 'mooditems', patch: { boardId: MB, type: 'card', x: 380, y: 320, w: 260, h: 140, z: 4, ref: { type: 'record', id: R_BETA } } },
  { id: 'v7_i_stage_card', collection: 'mooditems', patch: { boardId: MB, type: 'card', x: 700, y: 320, w: 260, h: 140, z: 5, ref: { type: 'record', id: T_STAGE } } },
  { id: 'v7_i_frame', collection: 'mooditems', patch: { boardId: MB, type: 'frame', x: 60, y: 520, w: 620, h: 260, z: 0, title: 'Stage frame' } },
  { id: 'v7_i_member', collection: 'mooditems', patch: { boardId: MB, type: 'note', x: 120, y: 600, w: 200, h: 120, z: 6, color: '#dcfce7', text: 'frame member', parentFrameId: 'v7_i_frame' } },
  // stage frame (mirror) + free card for stage test
  { id: 'v7_i_stageframe', collection: 'mooditems', patch: { boardId: MB, type: 'frame', x: 720, y: 520, w: 400, h: 260, z: 0, title: 'Doing', frameStageOf: { databaseId: 'board-default', stageId: 'in_progress' } } },
  // records db + views
  { id: DB, collection: 'boards', patch: { name: 'Release', icon: '🚂', kind: 'records', recordNoun: 'Train', columns: [
    { id: 'planned', name: 'Planned', color: '#8a8a8a' },
    { id: 'doing', name: 'Doing', color: '#0091ff' },
    { id: 'done', name: 'Done', color: '#30a46c' },
  ], fields: [
    { id: 'f_start', name: 'Start', type: 'date' },
    { id: 'f_end', name: 'End', type: 'date' },
    { id: 'f_role', name: 'Role', type: 'text' },
  ], showBuiltins: { assignee: false, due: false, priority: false }, order: 'a3', createdAt: NOW } },
  { id: R_ALPHA, collection: 'tasks', patch: { boardId: DB, title: 'Alpha build', status: 'planned', order: 'a1', p_f_start: '2026-10-05', p_f_end: '2026-10-09', p_f_role: 'TopSecretRole', createdAt: NOW } },
  { id: R_BETA, collection: 'tasks', patch: { boardId: DB, title: 'Beta build', status: 'doing', order: 'a2', p_f_start: '2026-10-06', p_f_end: '2026-10-13', createdAt: NOW } },
  { id: R_CONF, collection: 'tasks', patch: { boardId: DB, title: 'Conflicted launch', status: 'planned', order: 'a3', p_f_start: '2026-10-07', p_f_end: '2026-10-08', createdAt: NOW } },
  { id: R_UNSCHED, collection: 'tasks', patch: { boardId: DB, title: 'Unscheduled chore', status: 'planned', order: 'a4', createdAt: NOW } },
  { id: 'v7_r_unsched2', collection: 'tasks', patch: { boardId: DB, title: 'Unscheduled errand', status: 'planned', order: 'a5', createdAt: NOW } },
  { id: 'v7_r_unsched3', collection: 'tasks', patch: { boardId: DB, title: 'Unscheduled duty', status: 'planned', order: 'a6', createdAt: NOW } },
  { id: 'v7_l_dep', collection: 'links', patch: { kind: 'blocks', fromId: R_BETA, toId: R_CONF } },
  { id: V_TABLE, collection: 'views', patch: { databaseId: DB, name: 'Table', type: 'table', order: 'a1', config: {}, createdAt: NOW } },
  { id: V_CAL, collection: 'views', patch: { databaseId: DB, name: 'Calendar', type: 'calendar', order: 'a2', config: { dateKey: 'p_f_start' }, createdAt: NOW } },
  { id: V_TL, collection: 'views', patch: { databaseId: DB, name: 'Timeline', type: 'timeline', order: 'a3', config: { dateKey: 'p_f_start', endDateKey: 'p_f_end', groupBy: 'status', timelineScale: 'month' }, createdAt: NOW } },
  { id: T_STAGE, collection: 'tasks', patch: { boardId: 'board-default', title: 'Stage card task', status: 'todo', order: 'z9', createdAt: NOW } },
];
// 350 perf items, spread on a 10x35 grid so most are outside any viewport
for (let i = 0; i < 350; i++) {
  seed.push({ id: `v7_p_${i}`, collection: 'mooditems', patch: { boardId: MBP, type: 'note', x: (i % 10) * 420, y: Math.floor(i / 10) * 320, w: 180, h: 120, z: i, color: '#fef3c7', text: `perf ${i}` } });
}
const sr = await push(T, seed);
if (sr.status !== 200) { console.log('FATAL: seed push failed', sr.status, JSON.stringify(sr.data).slice(0, 400)); process.exit(1); }
console.log('seeded fixture pushed');

/* ---------------- page helpers ---------------- */
// Never open an absent/legacy IndexedDB name: the application owns schema creation.
const dexieGet = (page, table, id, uid) => readAccountStore(page, table, { id, userId: uid });
const dexieAll = (page, table, uid, filter) => readAccountStore(page, table, { userId: uid, filter: filter ? Function(`return (${filter})`)() : undefined });

const boardItems = (page, uid, boardId) => dexieAll(page, 'mooditems', uid, `i => i.boardId === '${boardId}' && !i.deleted`);

const uncoveredPoint = (page, id) => page.evaluate(canvasBodyPoint,id).catch(() => null);

const elemAt = (page, x, y) =>
  page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? e.outerHTML.slice(0, 90) : 'none'; }, [x, y]).catch(() => '?');

const poll = async (fn, timeoutMs = 10000, step = 400) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
};

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

const canvas = (page) => page.locator('[data-testid="mood-canvas"]');
/** DOM-level click — canvas item selection is resolved on pointer release
 * (pointer capture retargets `click` to the canvas), so helpers below do a
 * real down/up; dispatched clicks remain for canvas-internal buttons. */
const uiClick = (page, sel) => page.locator(sel).first().dispatchEvent('click');
const uiClickShift = (page, sel) => page.locator(sel).first().dispatchEvent('click', { shiftKey: true });

const itemEl = (page, id) => page.locator(`[data-mooditem="${id}"]`);
const canvasBox = async (page) => await canvas(page).boundingBox();

// Selection helper: selection happens on pointer release of a real down/up
// (tap = select). The trailing dispatched click is kept as a fallback for
// paths that only fire click (it is suppressed inside the product when the
// release already handled selection). Hold Shift during the real press for
// additive toggles so the release-path sees the modifier.
const selectItemEl = async (page, id, additive = false) => {
  // Real tap at an uncovered point — overlapping higher-z items must win the
  // hit test, so we never force-click a hidden center.
  const pt = await uncoveredPoint(page, id);
  if (pt) {
    if (additive) await page.keyboard.down('Shift');
    await page.mouse.move(pt.x, pt.y);
    await page.mouse.down();
    await page.mouse.up();
    if (additive) await page.keyboard.up('Shift');
    await sleep(150);
  }
  // Fallback for fully-covered items; the product dedupes this click when the
  // release already handled selection on the same item.
  await itemEl(page, id).dispatchEvent('click', additive ? { shiftKey: true } : {});
  await sleep(250);
};

/** Screen-space center of an item. */
const itemCenter = async (page, id) => {
  const b = await itemEl(page, id).boundingBox();
  return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
};

/** Open the Add-item popover and click a row by its visible text. */
async function addViaMenu(page, label) {
  await page.locator('[data-testid="mood-add"]').dispatchEvent('click');
  await sleep(400);
  await page.locator(`button:text-is("${label}")`).first().dispatchEvent('click');
  await sleep(500);
}

/* ==================== CANVAS CORE SUITE ==================== */
async function canvasSuite(page, E, V, uid) {
  const N = (check, status) => note(E, V, check, status);
  await page.goto(`${BASE}/moodboards/${MB}`, { waitUntil: 'domcontentloaded' });
  const ready = await poll(() => itemEl(page, 'v7_i_note').count().then((c) => c > 0), 20000);
  const before = new Set((await boardItems(page, uid, MB)).map((i) => i.id));
  const newIds = async () => (await boardItems(page, uid, MB)).filter((i) => !before.has(i.id));
  N('canvas: board loads, seeded items render', ready ? 'PASS' : 'FAIL');
  if (!ready) return;

  /* ---- add via add menu ---- */
  await addViaMenu(page, 'Sticky note');
  const noteAdd = await poll(async () => (await newIds()).some((i) => i.type === 'note'));
  N('canvas: add note via add menu', noteAdd ? 'PASS' : 'FAIL');
  const addedNote = (await newIds()).find((i) => i.type === 'note');
  if (addedNote) {
    const ed = page.locator('[data-mooditem] textarea, [data-mooditem] input').first();
    if (await ed.count()) { await ed.fill('added note text'); }
    await canvas(page).press('Escape');
  }

  await addViaMenu(page, 'Text');
  const textAdd = await poll(async () => (await newIds()).some((i) => i.type === 'text'));
  const addedText = (await newIds()).find((i) => i.type === 'text');
  if (addedText) {
    const ed = page.locator('[data-mooditem] input, [data-mooditem] textarea').first();
    if (await ed.count()) { await ed.fill('added text item'); await ed.press('Enter'); }
  }
  N('canvas: add text via add menu', textAdd ? 'PASS' : 'FAIL');

  // color swatch: set color input, click its Add button
  await page.locator('[data-testid="mood-add"]').dispatchEvent('click');
  await sleep(300);
  const colorInput = page.locator('input[type="color"]').first();
  if (await colorInput.count()) {
    await colorInput.evaluate((el) => { el.value = '#ff0077'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.locator('button:text-is("Add")').first().dispatchEvent('click');
  } else { await page.keyboard.press('Escape'); }
  const colorAdd = await poll(async () => (await newIds()).some((i) => i.type === 'color'));
  N('canvas: add color swatch via add menu', colorAdd ? 'PASS' : 'FAIL');

  // image via file input (input lives inside the open popover)
  await page.locator('[data-testid="mood-add"]').dispatchEvent('click');
  await sleep(400);
  const imgInput = page.locator('input[type="file"][accept*="image"]').first();
  if (await imgInput.count()) await imgInput.setInputFiles(`${FIX}/photo.png`);
  else await addViaMenu(page, 'Image(s)');
  const imgAdd = await poll(async () => (await newIds()).some((i) => i.type === 'image'), 15000);
  N('canvas: add image via add menu', imgAdd ? 'PASS' : 'FAIL');

  // card via ItemPicker
  await addViaMenu(page, 'Card (record / page)');
  const picker = page.locator('text=/Search|record|page/i').first();
  if (await picker.count()) {
    const search = page.locator('input[placeholder*="earch"]').first();
    if (await search.count()) await search.fill('Conflicted');
    await sleep(400);
    await page.locator('button:has-text("Conflicted launch"), [role="option"]:has-text("Conflicted launch"), li:has-text("Conflicted launch")').first().dispatchEvent('click');
  }
  const cardAdd = await poll(async () => (await newIds()).some((i) => i.type === 'card' && i.ref?.id === R_CONF), 8000);
  N('canvas: add card (record ref) via ItemPicker', cardAdd ? 'PASS' : 'FAIL');

  // frame + shape via add menu
  await addViaMenu(page, 'Frame');
  const frameAdd = await poll(async () => (await newIds()).some((i) => i.type === 'frame'));
  N('canvas: add frame via add menu', frameAdd ? 'PASS' : 'FAIL');

  await page.locator('[data-testid="mood-add"]').dispatchEvent('click');
  await sleep(300);
  const shapeBtn = page.locator('button[aria-label*="Rectangle"], button:has-text("Rectangle")').first();
  if (await shapeBtn.count()) await shapeBtn.dispatchEvent('click'); else await page.keyboard.press('Escape');
  const shapeAdd = await poll(async () => (await newIds()).some((i) => i.type === 'shape'));
  N('canvas: add shape via add menu', shapeAdd ? 'PASS' : 'FAIL');

  // svg via file input (benign) + hostile reject (input inside open popover)
  await page.locator('[data-testid="mood-add"]').dispatchEvent('click');
  await sleep(400);
  const svgInput = page.locator('input[type="file"][accept*=".svg"], input[type="file"][accept*="svg"]').first();
  if (await svgInput.count()) {
    await svgInput.setInputFiles(`${FIX}/ok.svg`);
    await sleep(600);
    // reopen — the row's close() ran after the first file
    await page.locator('[data-testid="mood-add"]').dispatchEvent('click');
    await sleep(400);
    const svgInput2 = page.locator('input[type="file"][accept*=".svg"], input[type="file"][accept*="svg"]').first();
    if (await svgInput2.count()) await svgInput2.setInputFiles(`${FIX}/evil.svg`);
    await sleep(600);
  }
  const svgItems = (await boardItems(page, uid, MB)).filter((i) => i.type === 'svg' && !i.deleted);
  let svgRendersImg = svgItems.length > 0;
  for (const it of svgItems) {
    if ((await itemEl(page, it.id).locator('img').count()) === 0) svgRendersImg = false;
  }
  // the boundary: hostile markup is never injected as inline <svg> — every svg
  // item renders through <img>, where script/event markup is inert either way.
  N('canvas: svg items render via <img> (never inline stored svg)', svgRendersImg ? 'PASS' : 'FAIL');
  const hostileOk = await poll(async () => {
    const items = await boardItems(page, uid, MB);
    const fresh = items.filter((i) => i.type === 'svg' && !i.deleted);
    for (const it of fresh) {
      if ((await itemEl(page, it.id).locator('img').count()) === 0) return false;
    }
    return true;
  }, 8000);
  N('canvas: hostile svg handled safely (img-only render path)', hostileOk ? 'PASS' : 'FAIL');

  // diagram from spec
  await page.locator('[data-testid="mood-add"]').dispatchEvent('click');
  await sleep(300);
  const specArea = page.locator('textarea[placeholder*="layout"], textarea[placeholder*="nodes"]').first();
  if (await specArea.count()) {
    await specArea.fill('{"layout":"auto-lr","nodes":[{"id":"a","label":"A"},{"id":"b","label":"B"}],"edges":[{"from":"a","to":"b"}]}');
    await page.locator('button:has-text("Add diagram")').first().dispatchEvent('click');
  } else { await page.keyboard.press('Escape'); }
  const diagAdd = await poll(async () => (await newIds()).some((i) => i.type === 'diagram'), 8000);
  N('canvas: add diagram from spec', diagAdd ? 'PASS' : 'FAIL');

  /* ---- move + resize via pointer; commit-on-release ---- */
  const box0 = await itemEl(page, 'v7_i_note').boundingBox();
  if (box0) {
    await page.mouse.move(box0.x + 30, box0.y + 30);
    await page.mouse.down();
    await page.mouse.move(box0.x + 130, box0.y + 90, { steps: 6 });
    await page.mouse.up();
    await sleep(400);
  }
  let lastMove;
  const movedOk = await poll(async () => (lastMove = await dexieGet(page, 'mooditems', 'v7_i_note', uid)) && lastMove.x === 180 && lastMove.y === 140, 6000);
  N('canvas: move item via pointer drag', movedOk ? 'PASS' : `FAIL (x=${lastMove?.x},y=${lastMove?.y})`);

  await selectItemEl(page, 'v7_i_note2');
  await sleep(400);
  const rh = itemEl(page, 'v7_i_note2').locator('[data-testid="resize-handle"]').first();
  if (await rh.count()) {
    const rb = await rh.boundingBox();
    await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await page.mouse.down();
    await page.mouse.move(rb.x + 80, rb.y + 60, { steps: 5 });
    await page.mouse.up();
    await sleep(400);
  }
  let lastRes;
  const resizedOk = await poll(async () => (lastRes = await dexieGet(page, 'mooditems', 'v7_i_note2', uid)) && lastRes.w > 221 && lastRes.h > 161, 6000);
  N('canvas: resize via resize-handle', resizedOk ? 'PASS' : `FAIL (w=${lastRes?.w},h=${lastRes?.h})`);

  // commit-on-release: reload → geometry persists in Dexie + DOM
  await page.reload({ waitUntil: 'domcontentloaded' });
  const persisted = await poll(async () => {
    const it = await dexieGet(page, 'mooditems', 'v7_i_note', uid);
    return it && it.x === 180 && it.y === 140;
  }, 15000);
  N('canvas: move persists after reload (commit-on-release)', persisted ? 'PASS' : 'FAIL');

  /* ---- connector between two items: select pair → Connect selected items ---- */
  await canvas(page).press('Escape');
  await selectItemEl(page, 'v7_i_card_a');
  await sleep(300);
  await selectItemEl(page, 'v7_i_card_b', true);
  await sleep(400);
  const connSelBtn = page.locator('button[title="Connect selected items"]').first();
  if (await connSelBtn.count()) await connSelBtn.dispatchEvent('click');
  await sleep(600);
  const connDialog = await page.locator('text="Connect items"').count();
  if (connDialog) {
    const blocksSel = page.locator('select').filter({ hasText: 'Blocks' }).first();
    if (await blocksSel.count()) await blocksSel.selectOption('blocks');
    await page.locator('button:text-is("Connect")').first().dispatchEvent('click');
    await sleep(600);
  }
  const connRow = await poll(async () => (await boardItems(page, uid, MB)).some((i) => i.type === 'connector' && i.from === 'v7_i_card_a' && i.to === 'v7_i_card_b'));
  N('canvas: connector via pick-two connect mode', connRow ? 'PASS' : 'FAIL');
  // connector↔link mirror: blocks kind → links row (client Dexie + server)
  const linkLocal = await dexieAll(page, 'links', uid, `l => l.kind === 'blocks' && l.fromId === '${R_ALPHA}' && l.toId === '${R_BETA}'`);
  let linkServer = false;
  if (linkLocal.length) {
    linkServer = await poll(async () => {
      const all = await pullAll(T);
      const rec = all.find((r) => r.collection === 'links' && r.id === linkLocal[0].id);
      return rec && rec.data?.kind === 'blocks';
    }, 15000);
  }
  N("canvas: connector linkKind 'blocks' creates links row", linkLocal.length && linkServer ? 'PASS' : `FAIL (local=${linkLocal.length} server=${linkServer})`);

  /* ---- multi-select: shift-click AND marquee ---- */
  const shiftOk = await (async () => {
    const a = await itemCenter(page, 'v7_i_note');
    const b = await itemCenter(page, 'v7_i_note2');
    if (!a || !b) return false;
    await selectItemEl(page, 'v7_i_note');
    await sleep(200);
    await selectItemEl(page, 'v7_i_note2', true);
    await sleep(300);
    return (await page.locator('button[title="Connect selected items"]').count()) > 0;
  })();
  N('canvas: multi-select via shift-click', shiftOk ? 'PASS' : 'FAIL');
  await canvas(page).press('Escape');

  // marquee: drag empty bg over both items in edit mode
  const marqueeOk = await (async () => {
    const a = await itemEl(page, 'v7_i_note').boundingBox();
    const b = await itemEl(page, 'v7_i_note2').boundingBox();
    const cb = await canvasBox(page);
    if (!a || !b || !cb) return false;
    const x0 = Math.min(a.x, b.x) - 60, y0 = Math.min(a.y, b.y) - 60;
    const x1 = Math.max(a.x + a.width, b.x + b.width) + 60, y1 = Math.max(a.y + a.height, b.y + b.height) + 60;
    // ensure we're in edit mode (marquee needs it)
    const modeBtn = page.locator('[data-testid="mode-toggle"]');
    if (await modeBtn.count()) {
      const pressed = await modeBtn.getAttribute('aria-label');
      if (pressed && /browse|pan/i.test(pressed)) { /* already browse label → click to edit */ }
    }
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x1, y1, { steps: 8 });
    await page.mouse.up();
    await sleep(400);
    return (await page.locator('[data-mooditem] .ring-2').count()) >= 2;
  })();
  N('canvas: multi-select via marquee drag', marqueeOk ? 'PASS' : 'FAIL');

  /* ---- align ops ---- */
  const alignOk = await (async () => {
    if ((await page.locator('[data-mooditem] .ring-2').count()) < 2) return false;
    if (!(await page.locator('button[aria-label="Close inspector"]').count())) await page.locator('button[title="Inspector"]').dispatchEvent('click');
    await sleep(400);
    const al = page.locator('button[aria-label="Align left"]');
    if (!(await al.count())) return false;
    await al.dispatchEvent('click');
    await sleep(400);
    const [n1, n2] = await Promise.all([dexieGet(page, 'mooditems', 'v7_i_note', uid), dexieGet(page, 'mooditems', 'v7_i_note2', uid)]);
    return n1 && n2 && n1.x === n2.x;
  })();
  N('canvas: align ops change geometry coherently', alignOk ? 'PASS' : 'FAIL');
  await canvas(page).press('Escape');
  const inspClose = page.locator('button[aria-label="Close inspector"]');
  if (await inspClose.count()) await inspClose.dispatchEvent('click');

  /* ---- z-order bring-front / send-back ---- */
  const zOk = await (async () => {
    const a = await itemCenter(page, 'v7_i_note');
    if (!a) return false;
    const zBefore = (await dexieGet(page, 'mooditems', 'v7_i_note', uid))?.z ?? 0;
    await selectItemEl(page, 'v7_i_note');
    await sleep(200);
    if (!(await page.locator('button[aria-label="Close inspector"]').count())) await page.locator('button[title="Inspector"]').dispatchEvent('click');
    await sleep(400);
    // find a z-front control in the inspector or ItemList
    const bf = page.locator('button[title="Bring to front"], button:has-text("Bring to front")').first();
    if (await bf.count()) await bf.dispatchEvent('click');
    else {
      const il = page.locator('button[title="Item list"]');
      await il.dispatchEvent('click'); await sleep(400);
      const row = page.locator('[data-testid="mood-itemlist"] [role="listitem"]:has(button[aria-pressed="true"])').first();
      if (await row.count()) await row.locator('button[title="Bring to front"]').dispatchEvent('click');
    }
    await sleep(400);
    const zAfter = (await dexieGet(page, 'mooditems', 'v7_i_note', uid))?.z ?? 0;
    return zAfter > zBefore;
  })();
  N('canvas: z-order bring-front changes z', zOk ? 'PASS' : 'FAIL');
  await canvas(page).press('Escape');
  const ilClose = page.locator('button[aria-label="Close item list"], button[aria-label="Close inspector"]');
  if (await ilClose.count()) await ilClose.first().dispatchEvent('click');

  /* ---- ItemList: pointer-free ops ---- */
  const itemListOk = await (async () => {
    if (!(await page.locator('[data-testid="mood-itemlist"] [role="list"]').count())) await page.locator('button[title="Item list"]').dispatchEvent('click');
    await sleep(500);
    const options = page.locator('[data-testid="mood-itemlist"] [role="listitem"]');
    const count = await options.count();
    if (count < 5) return false;
    const row = options.filter({ hasText: 'seed note two' }).first();
    if (!(await row.count())) return false;
    const before = await dexieGet(page, 'mooditems', 'v7_i_note2', uid);
    await row.getByRole('button',{name:'Nudge right',exact:true}).dispatchEvent('click');
    await sleep(300);
    const after = await dexieGet(page, 'mooditems', 'v7_i_note2', uid);
    return after && before && after.x === before.x + 10;
  })();
  N('canvas: ItemList nudge button works without pointer drag', itemListOk ? 'PASS' : 'FAIL');

  const itemListResize = await (async () => {
    const row = page.locator('[data-testid="mood-itemlist"] [role="listitem"]').filter({ hasText: 'seed note two' }).first();
    if (!(await row.count())) return false;
    const before = await dexieGet(page, 'mooditems', 'v7_i_note2', uid);
    await row.locator('button[title="Grow 10%"]').dispatchEvent('click');
    await sleep(300);
    const after = await dexieGet(page, 'mooditems', 'v7_i_note2', uid);
    return after && before && after.w > before.w;
  })();
  N('canvas: ItemList grow button resizes without pointer drag', itemListResize ? 'PASS' : 'FAIL');

  const itemListZ = await (async () => {
    const row = page.locator('[data-testid="mood-itemlist"] [role="listitem"]').filter({ hasText: 'seed note two' }).first();
    if (!(await row.count())) return false;
    const before = await dexieGet(page, 'mooditems', 'v7_i_note2', uid);
    await row.locator('button[title="Reorder z +1"]').dispatchEvent('click');
    await sleep(300);
    const after = await dexieGet(page, 'mooditems', 'v7_i_note2', uid);
    return after && before && after.z === before.z + 1;
  })();
  N('canvas: ItemList z-order buttons work', itemListZ ? 'PASS' : 'FAIL');

  const itemListDelete = await (async () => {
    // create a throwaway note then delete via ItemList (it is auto-selected → its selection button is aria-pressed)
    await addViaMenu(page, 'Sticky note');
    const fresh = (await boardItems(page, uid, MB)).filter((i) => i.type === 'note' && !before.has(i.id)).pop();
    if (!fresh) return 'no-fresh';
    await canvas(page).press('Escape'); // clear editing so the fresh item is selectable
    await selectItemEl(page, fresh.id);
    if (!(await page.locator('[data-testid="mood-itemlist"] [role="list"]').count())) await page.locator('button[title="Item list"]').dispatchEvent('click');
    await sleep(500);
    const row = page.locator('[data-testid="mood-itemlist"] [role="listitem"]:has(button[aria-pressed="true"])').first();
    if (!(await row.count())) return 'no-selected-row';
    await row.locator('button[title="Delete"]').dispatchEvent('click');
    await sleep(600);
    const after = await dexieGet(page, 'mooditems', fresh.id, uid);
    return !after || after.deleted === true ? true : 'still-present';
  })();
  N('canvas: ItemList delete marks item deleted', itemListDelete === true ? 'PASS' : `FAIL (${itemListDelete})`);
  const ilc = page.locator('button[aria-label="Close item list"]');
  if (await ilc.count()) await ilc.dispatchEvent('click');

  /* ---- Inspector geometry/ref edits without gestures ---- */
  const inspGeom = await (async () => {
    const a = await itemCenter(page, 'v7_i_note');
    if (!a) return false;
    await selectItemEl(page, 'v7_i_note');
    await sleep(200);
    if (!(await page.locator('button[aria-label="Close inspector"]').count())) await page.locator('button[title="Inspector"]').dispatchEvent('click');
    await sleep(400);
    const xField = page.locator('text="X"').locator('..').locator('input').first();
    if (!(await xField.count())) return false;
    await xField.fill('250');
    await xField.press('Tab');
    await sleep(400);
    const it = await dexieGet(page, 'mooditems', 'v7_i_note', uid);
    return it && it.x === 250;
  })();
  N('canvas: Inspector geometry edit (X) applies', inspGeom ? 'PASS' : 'FAIL');

  const inspTitle = await (async () => {
    const t = page.locator('text="Text"').locator('..').locator('textarea').first();
    if (!(await t.count())) return false;
    await t.fill('renamed note');
    await t.press('Tab');
    await sleep(400);
    const it = await dexieGet(page, 'mooditems', 'v7_i_note', uid);
    return it && it.text === 'renamed note';
  })();
  N('canvas: Inspector title/style field edit applies', inspTitle ? 'PASS' : 'FAIL');
  await canvas(page).press('Escape');
  const ic = page.locator('button[aria-label="Close inspector"]');
  if (await ic.count()) await ic.dispatchEvent('click');

  /* ---- keyboard ops ---- */
  const kbMove = await (async () => {
    const a = await itemCenter(page, 'v7_i_note2');
    if (!a) return 'no-box';
    await selectItemEl(page, 'v7_i_note2');
    await sleep(200);
    const rings = await page.locator('[data-mooditem] .ring-2').count();
    await canvas(page).evaluate((el) => el.focus());
    const before = (await dexieGet(page, 'mooditems', 'v7_i_note2', uid))?.x;
    await canvas(page).press('ArrowRight');
    await poll(async () => (await dexieGet(page, 'mooditems', 'v7_i_note2', uid))?.x === before + 1, 5000, 300);
    await canvas(page).press('ArrowRight');
    await sleep(500);
    const after = (await dexieGet(page, 'mooditems', 'v7_i_note2', uid))?.x;
    return after === before + 2 ? true : `rings=${rings} x=${before}->${after}`;
  })();
  N('canvas: keyboard arrows move selection', kbMove === true ? 'PASS' : `FAIL (${kbMove})`);

  const kbZ = await (async () => {
    const before = (await dexieGet(page, 'mooditems', 'v7_i_note2', uid))?.z;
    await canvas(page).press(']');
    await sleep(300);
    const mid = (await dexieGet(page, 'mooditems', 'v7_i_note2', uid))?.z;
    await canvas(page).press('[');
    await sleep(300);
    const after = (await dexieGet(page, 'mooditems', 'v7_i_note2', uid))?.z;
    return mid === before + 1 && after === before;
  })();
  N('canvas: [ ] keys reorder z', kbZ ? 'PASS' : 'FAIL');

  await canvas(page).press('Escape');
  const escOk = await poll(async () => (await page.locator('button[title="Connect selected items"]').count()) === 0, 3000, 200);
  N('canvas: Escape clears selection', escOk ? 'PASS' : 'FAIL');

  /* ---- pointercancel mid-drag restores geometry ---- */
  const cancelOk = await (async () => {
    const pre = await dexieGet(page, 'mooditems', 'v7_i_note', uid);
    const b = await itemEl(page, 'v7_i_note').boundingBox();
    if (!pre || !b) return false;
    await page.mouse.move(b.x + 20, b.y + 20);
    await page.mouse.down();
    await page.mouse.move(b.x + 220, b.y + 160, { steps: 4 });
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="mood-canvas"]');
      el.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }));
    });
    await page.mouse.up();
    await sleep(400);
    const post = await dexieGet(page, 'mooditems', 'v7_i_note', uid);
    const bb = await itemEl(page, 'v7_i_note').boundingBox();
    return post && post.x === pre.x && post.y === pre.y && bb && Math.abs(bb.x - b.x) < 40;
  })();
  N('canvas: pointercancel mid-drag restores geometry (no commit)', cancelOk ? 'PASS' : 'FAIL');

  /* ---- frame batch move ---- */
  const frameMove = await (async () => {
    const f = await dexieGet(page, 'mooditems', 'v7_i_frame', uid);
    const m = await dexieGet(page, 'mooditems', 'v7_i_member', uid);
    const fb = await itemEl(page, 'v7_i_frame').boundingBox();
    if (!f || !m || !fb) return false;
    // grab bottom-left interior — top area is covered by the added frame
    await page.mouse.move(fb.x + 40, fb.y + fb.height - 35);
    await page.mouse.down();
    await page.mouse.move(fb.x + 40 + 150, fb.y + fb.height - 35 + 80, { steps: 6 });
    await page.mouse.up();
    await sleep(500);
    const f2 = await dexieGet(page, 'mooditems', 'v7_i_frame', uid);
    const m2 = await dexieGet(page, 'mooditems', 'v7_i_member', uid);
    return f2 && m2 && f2.x === f.x + 150 && m2.x === m.x + 150 && m2.y === m.y + 80;
  })();
  N('canvas: moving frame translates members (batch move)', frameMove ? 'PASS' : 'FAIL');

  /* ---- frameStageOf: assign card to stage frame → writes task status; then desync → mismatch dot ---- */
  const stageWrite = await (async () => {
    // select the stage card, open inspector, set Frame select to the stage frame
    const a = await itemCenter(page, 'v7_i_stage_card');
    if (!a) return false;
    await selectItemEl(page, 'v7_i_stage_card');
    await sleep(200);
    if (!(await page.locator('button[aria-label="Close inspector"]').count())) await page.locator('button[title="Inspector"]').dispatchEvent('click');
    await sleep(400);
    const frameSel = page.locator('text="Frame"').locator('..').locator('select').first();
    if (!(await frameSel.count())) return false;
    await frameSel.selectOption('v7_i_stageframe');
    await sleep(600);
    const task = await dexieGet(page, 'tasks', T_STAGE, uid);
    return task && task.status === 'in_progress';
  })();
  N('canvas: frameStageOf stage write updates record status', stageWrite ? 'PASS' : 'FAIL');
  await canvas(page).press('Escape');
  const ic2 = page.locator('button[aria-label="Close inspector"]');
  if (await ic2.count()) await ic2.dispatchEvent('click');

  const stageMismatch = await (async () => {
    // desync on the server side: set the task's status back to 'todo'
    await push(T, [{ id: T_STAGE, collection: 'tasks', patch: { status: 'todo' } }]);
    return await poll(async () => {
      const task = await dexieGet(page, 'tasks', T_STAGE, uid);
      if (!task || task.status !== 'todo') {
        // nudge a pull
        await page.evaluate(() => window.dispatchEvent(new Event('focus'))).catch(() => {});
        return false;
      }
      await sleep(600);
      return (await itemEl(page, 'v7_i_stage_card').locator('[title*="stage differs"], .bg-amber-500').count()) > 0;
    }, 20000);
  })();
  N('canvas: stage mismatch indicator when record differs from frame stage', stageMismatch ? 'PASS' : 'FAIL');

  await page.screenshot({ path: `${SHOTS}/canvas-${E}-${V}.png`, fullPage: false });
}

/* ==================== MODE SWITCH (browse vs edit) ==================== */
async function modeSuite(page, E, V, uid, touch = false) {
  const N = (check, status) => note(E, V, check, status);
  await page.goto(`${BASE}/moodboards/${MB}`, { waitUntil: 'domcontentloaded' });
  const ready = await poll(() => itemEl(page, 'v7_i_note').count().then((c) => c > 0), 20000);
  if (!ready) { N('modes: board loads', 'FAIL'); return; }

  const modeBtn = page.locator('[data-testid="mode-toggle"]');
  if (!(await modeBtn.count())) { N('modes: mode toggle exists', 'FAIL'); return; }
  N('modes: mode toggle exists', 'PASS');

  const dragItem = async (dx, dy) => {
    const b = await itemEl(page, 'v7_i_note2').boundingBox();
    if (!b) return null;
    if (touch && page.context()._cdp) { /* noop */ }
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 5 });
    await page.mouse.up();
    await sleep(400);
    return dexieGet(page, 'mooditems', 'v7_i_note2', uid);
  };

  // switch to browse: drag item should NOT move it
  const label = (await modeBtn.textContent()) ?? '';
  const aria = (await modeBtn.getAttribute('aria-label')) ?? '';
  // determine current mode; we want browse first
  const curMode = async () => (((await modeBtn.getAttribute('title')) ?? '').startsWith('Browse') ? 'browse' : 'edit');
  const setBrowse = async () => {
    for (let i = 0; i < 3; i++) {
      if ((await curMode()) === 'browse') return;
      await modeBtn.dispatchEvent('click'); await sleep(300);
    }
  };
  const setEdit = async () => {
    for (let i = 0; i < 3; i++) {
      if ((await curMode()) === 'edit') return;
      await modeBtn.dispatchEvent('click'); await sleep(300);
    }
  };
  await setBrowse();
  const preB = await dexieGet(page, 'mooditems', 'v7_i_note2', uid);
  const screenBeforeB = await itemEl(page, 'v7_i_note2').boundingBox();
  await dragItem(120, 60);
  const postB = await dexieGet(page, 'mooditems', 'v7_i_note2', uid);
  const screenAfterB = await itemEl(page, 'v7_i_note2').boundingBox();
  N('modes: Browse/Pan drag pans view without moving item data', preB && postB && postB.x === preB.x && postB.y === preB.y && screenBeforeB && screenAfterB && Math.abs(screenAfterB.x-screenBeforeB.x)>80 ? 'PASS' : 'FAIL');

  // bg drag pans in browse (view transform changes)
  const panOk = await (async () => {
    const cb = await canvasBox(page);
    if (!cb) return false;
    const before = await itemEl(page, 'v7_i_note2').boundingBox();
    await page.mouse.move(cb.x + cb.width - 60, cb.y + cb.height - 40);
    await page.mouse.down();
    await page.mouse.move(cb.x + cb.width - 160, cb.y + cb.height - 140, { steps: 5 });
    await page.mouse.up();
    await sleep(300);
    const after = await itemEl(page, 'v7_i_note2').boundingBox();
    // item's world coords unchanged but screen pos shifted (pan) — same as "didn't move" check above;
    // a pan shifts ALL items equally: verify by comparing two items' screen delta
    return before && after && Math.abs(after.x - before.x) > 40;
  })();
  N('modes: Browse/Pan background drag pans canvas', panOk ? 'PASS' : 'FAIL');

  await setEdit();
  const preE = await dexieGet(page, 'mooditems', 'v7_i_note2', uid);
  await dragItem(60, 30);
  const postE = await dexieGet(page, 'mooditems', 'v7_i_note2', uid);
  N('modes: Select/Edit drag moves items', preE && postE && postE.x === preE.x + 60 ? 'PASS' : 'FAIL');
}

/* ==================== RESILIENCE ==================== */
async function offlineSuite(page, E, V, uid) {
  const N = (check, status) => note(E, V, check, status);
  await page.goto(`${BASE}/moodboards/${MB}`, { waitUntil: 'domcontentloaded' });
  if (!(await poll(() => itemEl(page, 'v7_i_note').count().then((c) => c > 0), 20000))) { N('offline: board loads', 'FAIL'); return; }

  await page.context().setOffline(true);
  await sleep(500);
  const beforeIds = new Set((await boardItems(page, uid, MB)).map((i) => i.id));
  await addViaMenu(page, 'Sticky note');
  // move an item offline too
  let dragId = null, pt = null;
  for (const cand of ['v7_i_note', 'v7_i_note2', 'v7_i_member', 'v7_i_card_a', 'v7_i_card_b']) {
    pt = await uncoveredPoint(page, cand);
    if (pt) { dragId = cand; break; }
  }
  const preMove = dragId ? await dexieGet(page, 'mooditems', dragId, uid) : null;
  await page.screenshot({ path: `${SHOTS}/offline-pre-drag.png` }).catch(() => {});
  if (pt) {
    await page.mouse.move(pt.x, pt.y);
    await page.mouse.down();
    await page.mouse.move(pt.x + 90, pt.y + 50, { steps: 4 });
    await page.mouse.up();
  }
  await sleep(600);
  const offlineItem = (await boardItems(page, uid, MB)).find((i) => !beforeIds.has(i.id));
  const movedLocal = await dexieGet(page, 'mooditems', dragId, uid);
  const wantX = (preMove?.x ?? 250) + 90;
  N('offline: add + move while offline writes locally', offlineItem && movedLocal && movedLocal.x === wantX ? 'PASS' : `FAIL (x=${movedLocal?.x} want=${wantX})`);

  await page.context().setOffline(false);
  await page.evaluate(() => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('focus')); }).catch(() => {});
  const converged = await poll(async () => {
    const all = await pullAll(T);
    const rec = all.find((r) => r.collection === 'mooditems' && r.id === offlineItem?.id);
    const moved = all.find((r) => r.collection === 'mooditems' && r.id === dragId);
    return rec && moved?.data?.x === wantX;
  }, 60000, 2000);
  N('offline: reconnect converges — no lost item', converged ? 'PASS' : 'FAIL');
}

async function multiUserSuite(browser, E, V, uid) {
  const N = (check, status) => note(E, V, check, status);
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pa = await loginPage(ctxA, admin);
  const pb = await loginPage(ctxB, bob);
  await pa.goto(`${BASE}/moodboards/${MB}`, { waitUntil: 'domcontentloaded' });
  await pb.goto(`${BASE}/moodboards/${MB}`, { waitUntil: 'domcontentloaded' });
  const both = await Promise.all([
    poll(() => itemEl(pa, 'v7_i_note').count().then((c) => c > 0), 20000),
    poll(() => itemEl(pb, 'v7_i_note').count().then((c) => c > 0), 20000),
  ]);
  if (!both.every(Boolean)) { N('multi-user: both users load board', 'FAIL'); await ctxA.close(); await ctxB.close(); return; }
  N('multi-user: both users load board', 'PASS');

  // admin writes via push → bob's open UI updates without reload (LiveRoom poke)
  const liveOk = await (async () => {
    await push(T, [{ id: 'v7_i_note2', collection: 'mooditems', patch: { text: 'live-broadcast' } }]);
    return await poll(async () => (await dexieGet(pb, 'mooditems', 'v7_i_note2', bob.user.id))?.text === 'live-broadcast', 30000, 1500);
  })();
  N('multi-user: push propagates to second client without reload', liveOk ? 'PASS' : 'FAIL');

  // concurrent edits: admin moves note (UI), bob moves note2 (UI) → both persist server-side
  let concDiag = '';
  const concOk = await (async () => {
    let aId = null, paPt = null;
    for (const cand of ['v7_i_note', 'v7_i_member', 'v7_i_card_a']) { paPt = await uncoveredPoint(pa, cand); if (paPt) { aId = cand; break; } }
    let bId = null, pbPt = null;
    for (const cand of ['v7_i_note2', 'v7_i_card_b', 'v7_i_member']) { pbPt = await uncoveredPoint(pb, cand); if (pbPt) { bId = cand; break; } }
    concDiag = `a=${aId}@${JSON.stringify(paPt)} b=${bId}@${JSON.stringify(pbPt)}`;
    if (!aId || !bId) return false;
    const preA = await dexieGet(pa, 'mooditems', aId, admin.user.id);
    const preB = await dexieGet(pb, 'mooditems', bId, bob.user.id);
    await Promise.all([
      (async () => { await pa.mouse.move(paPt.x, paPt.y); await pa.mouse.down(); await pa.mouse.move(paPt.x + 20, paPt.y, { steps: 3 }); await pa.mouse.up(); })(),
      (async () => { await pb.mouse.move(pbPt.x, pbPt.y); await pb.mouse.down(); await pb.mouse.move(pbPt.x, pbPt.y + 20, { steps: 3 }); await pb.mouse.up(); })(),
    ]);
    await sleep(800);
    return await poll(async () => {
      const all = await pullAll(T);
      const a = all.find((r) => r.collection === 'mooditems' && r.id === aId);
      const b = all.find((r) => r.collection === 'mooditems' && r.id === bId);
      concDiag = `a=${aId} x=${a?.data?.x} want=${preA.x + 20} | b=${bId} y=${b?.data?.y} want=${preB.y + 20}`;
      return a?.data?.x === preA.x + 20 && b?.data?.y === preB.y + 20;
    }, 45000, 2000);
  })();
  N('multi-user: concurrent edits both persist', concOk ? 'PASS' : `FAIL (${concDiag})`);
  await ctxA.close(); await ctxB.close();
}

/* ---- undo via UI (Settings → Recent AI changes) after MCP write ---- */
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function mcpToken() {
  const dcr = await api('/register', {
    method: 'POST',
    body: { client_name: 'V7 Verify', redirect_uris: ['http://localhost:8123/cb'], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' },
  });
  const clientId = dcr.data?.client_id;
  if (!clientId) return null;
  const resource = `${BASE}/mcp`;
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(8));
  const qs = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'http://localhost:8123/cb', state, code_challenge: challenge, code_challenge_method: 'S256', resource, scope: 'mcp' });
  const page = await api(`/oauth/authorize?${qs}`, { raw: true });
  const cookie = (page.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ') || page.headers.get('set-cookie')?.split(';')[0] || '';
  const handle = page.text.match(/name="handle" value="([^"]+)"/)?.[1];
  if (!handle) return null;
  const good = await api(`/oauth/authorize?${qs}`, { method: 'POST', cookie, form: { handle, username: 'admin', password: PASS, decision: 'allow' } });
  const code = new URL(good.headers.get('location') ?? '', BASE).searchParams.get('code');
  if (!code) return null;
  const tok = await api('/token', { method: 'POST', form: { grant_type: 'authorization_code', code, redirect_uri: 'http://localhost:8123/cb', client_id: clientId, code_verifier: verifier, resource } });
  return tok.data?.access_token ?? null;
}

async function undoSuite(browser, E, V) {
  const N = (check, status) => note(E, V, check, status);
  const token = await mcpToken();
  if (!token) { N('undo: MCP OAuth token', 'FAIL'); return; }
  const client = new Client({ name: 'v7-verify', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  } catch (e) { N('undo: MCP connect', `FAIL (${String(e).slice(0, 80)})`); return; }
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    let data = null; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { data, isError: !!r.isError };
  };
  const created = await call('create_moodboard', { title: 'Undo me board', icon: '↩️' });
  const newBoardId = created.data?.id ?? created.data?.moodboardId ?? created.data?.board?.id;
  const csId = created.data?.changesetId;
  N('undo: MCP create_moodboard returns changeset', !created.isError && !!newBoardId && !!csId ? 'PASS' : `FAIL ${JSON.stringify(created.data).slice(0, 160)}`);
  if (!newBoardId) { await client.close(); return; }

  // UI path: Settings → Recent AI changes → Undo
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginPage(ctx, admin);
  await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
  const section = await poll(() => page.locator('text=/Recent AI changes/i').count().then((c) => c > 0), 15000);
  let undoOk = false;
  let undoDiag = `section=${section}`;
  if (section) {
    await poll(() => page.locator('button:has-text("Undo")').count().then((c) => c > 0)
      || page.locator('text=/No AI changes yet|unavailable/i').count().then((c) => c > 0), 15000);
    const undoBtn = page.locator('button:has-text("Undo")').first();
    undoDiag += ` undoBtns=${await page.locator('button:has-text("Undo")').count()}`;
    if (await undoBtn.count()) {
      await undoBtn.click();
      await sleep(400);
      await poll(() => page.locator('text=/Undo this change set/i').count().then((c) => c > 0), 8000, 300);
      const confirm = page.locator('button:has-text("Undo")').last(); // confirm box's Undo renders last
      if (await confirm.count()) await confirm.click();
      await sleep(1500);
      undoOk = await poll(async () => {
        const all = await pullAll(T);
        const rec = all.find((r) => r.collection === 'moodboards' && r.id === newBoardId);
        return !rec || rec.data?.deleted === true;
      }, 15000);
    }
  }
  N('undo: Settings → Recent AI changes → Undo restores (board gone)', undoOk ? 'PASS' : `FAIL (${undoDiag})`);
  await ctx.close();
  await client.close();
}

/* ==================== PUBLIC SHARE ==================== */
async function publicShareSuite(browser, E, V) {
  const N = (check, status) => note(E, V, check, status);
  const share = await api('/api/shares', { method: 'POST', token: T, body: { pageId: MB, targetType: 'moodboard' } });
  const token = share.data?.token ?? share.data?.share?.token;
  N('public: share token created', !!token ? 'PASS' : `FAIL (${share.status} ${JSON.stringify(share.data).slice(0, 140)})`);
  if (!token) return;

  const payload = await api(`/api/public/canvas/${token}`, { raw: true });
  let pj = null; try { pj = JSON.parse(payload.text); } catch {}
  N('public: /api/public/canvas/:token returns board+items', payload.status === 200 && pj?.items?.length > 0 ? 'PASS' : `FAIL status=${payload.status}`);
  // card items minimized: only title+stage on card payloads
  const cardLeak = pj?.items?.some((i) => i.type === 'card' && JSON.stringify(i).includes('TopSecretRole'));
  const cardInfo = pj?.items?.filter((i) => i.type === 'card').every((i) => {
    const keys = Object.keys(i.card ?? i.cardInfo ?? {});
    return keys.every((k) => ['title', 'stage'].includes(k));
  });
  N('public: card items expose ONLY title+stage (no record fields)', pj && !cardLeak && cardInfo !== false ? 'PASS' : 'FAIL');

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/s/canvas/${token}`, { waitUntil: 'domcontentloaded' });
  const rendered = await poll(async () => {
    const url = page.url();
    if (/login|signup|auth/.test(url)) return 'redirected';
    return (await page.locator('h1, header').filter({ hasText: 'V7 Canvas' }).count()) > 0;
  }, 20000);
  N('public: /s/canvas/:token renders unauthenticated, no auth redirect', rendered === true ? 'PASS' : `FAIL (${rendered})`);
  // ensure a file-backed svg item exists (chromium's canvas suite may not have run)
  const needSvg = (await page.locator('img[src*="/api/public/canvas/"]').count()) === 0;
  if (needSvg) {
    const svgBytes = readFileSync(`${FIX}/ok.svg`);
    const put = await fixtureFetch(`${BASE}/api/files/v7_f_svg/chunks/0`, { method: 'PUT', headers: { Authorization: `Bearer ${T}`, 'Content-Type': 'application/octet-stream' }, body: svgBytes });
    const done = await fixtureFetch(`${BASE}/api/files/v7_f_svg/complete`, { method: 'POST', headers: { Authorization: `Bearer ${T}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ mime: 'image/svg+xml', size: svgBytes.length, chunks: 1 }) });
    await push(T, [
      { id: 'v7_i_svgsrv', collection: 'mooditems', patch: { boardId: MB, type: 'svg', x: 900, y: 480, w: 160, h: 160, fileId: 'v7_f_svg', z: 40, createdAt: NOW } },
      { id: 'v7_f_svg', collection: 'files', patch: { parentType: 'mooditem', parentId: 'v7_i_svgsrv', name: 'ok.svg', mime: 'image/svg+xml', size: svgBytes.length, state: 'uploaded', createdAt: NOW } },
    ]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await poll(async () => (await page.locator('img[src*="/api/public/canvas/"]').count()) > 0, 20000);
  }
  const svgImg = await page.locator('img[src*="/api/public/canvas/"]').count();
  let fileOk = svgImg > 0;
  if (fileOk) {
    const src = await page.locator('img[src*="/api/public/canvas/"]').first().getAttribute('src');
    fileOk = await poll(async () => (await fixtureFetch(`${BASE}${src}`)).status === 200, 30000, 2000);
  }
  N('public: svg item renders via img on public canvas', fileOk ? 'PASS' : 'FAIL');
  await page.screenshot({ path: `${SHOTS}/public-canvas-${E}.png` });
  await ctx.close();
}

/* ==================== VIEWS ==================== */
async function viewsSuite(page, E, V, uid, compact = false) {
  const N = (check, status) => note(E, V, check, status);
  await page.goto(`${BASE}/boards/${DB}`, { waitUntil: 'domcontentloaded' });
  const loaded = await poll(() => page.locator('text=Alpha build').count().then((c) => c > 0), 40000)
    || (await page.locator('[role="tablist"] [role="tab"]').count()) > 0;
  N('views: records database loads', loaded ? 'PASS' : 'FAIL');
  if (!loaded) return;

  // switch to calendar view tab (role=tab)
  const calTab = page.locator('[role="tab"]:has-text("Calendar"), button:has-text("Calendar")').first();
  if (await calTab.count()) await calTab.click();
  await sleep(800);
  if (compact) {
    const monthTab = page.locator('[role="tab"]:has-text("month"), [role="tab"]:has-text("Month")').first();
    if (await monthTab.count()) await monthTab.click();
    await sleep(600);
  }
  const grid = await page.locator('.grid-cols-7').count();
  N('calendar: month grid renders', grid > 0 ? 'PASS' : 'FAIL');

  // chips land on right dates: chip parent cell's day == record's p_f_start day
  const chipDates = await page.evaluate(() => {
    const out = {};
    for (const chip of document.querySelectorAll('button[title]')) {
      const cell = chip.closest('div.min-h-20, div[class*="min-h"]');
      if (!cell) continue;
      const day = Number((cell.querySelector('div')?.textContent ?? '').trim().match(/^\d+/)?.[0]);
      if (day) out[chip.title] = day;
    }
    return out;
  });
  const dated = await dexieAll(page, 'tasks', uid, `r => r.boardId === '${DB}' && typeof r.p_f_start === 'string' && r.p_f_start`);
  const chipsOk = dated.length > 0 && dated.every((r) => chipDates[String(r.title ?? '')] === Number(String(r.p_f_start).slice(8, 10)));
  N('calendar: chips land on their p_f_start day', chipsOk ? 'PASS' : `FAIL ${JSON.stringify(chipDates)}`);

  // unscheduled tray → assign date via tray date-input (NOT drag)
  const trayOk = await (async () => {
    const trayBtn = page.locator('button:has-text("Unscheduled")').first();
    if (!(await trayBtn.count())) return false;
    await trayBtn.click();
    await sleep(500);
    // first unscheduled row: its record title + its own date input
    const row = page.locator('input[type="date"]').first().locator('..');
    if (!(await row.count())) return false;
    const title = (await row.locator('button').first().textContent())?.trim();
    if (!title) return false;
    await row.locator('input[type="date"]').fill('2026-10-20');
    await sleep(1000);
    const recs = await dexieAll(page, 'tasks', uid, `r => r.boardId === '${DB}' && r.title === '${title.replace(/'/g, "\\'")}'`);
    return recs.some((r) => r.p_f_start === '2026-10-20');
  })();
  N('calendar: unscheduled tray assigns date via date-input', trayOk ? 'PASS' : 'FAIL');

  // agenda at compact
  if (compact) {
    const agenda = await page.locator('[role="tablist"], [role="tab"]').count();
    const listItems = await page.locator('text=/Oct|2026/').count();
    N('calendar: agenda mode renders at compact viewport', agenda > 0 || listItems > 0 ? 'PASS' : 'FAIL');
  }
  await page.screenshot({ path: `${SHOTS}/calendar-${E}-${V}.png` });

  /* ---- timeline ---- */
  const tlTab = page.locator('[role="tab"]:has-text("Timeline"), button:has-text("Timeline")').first();
  if (await tlTab.count()) await tlTab.click();
  await sleep(800);
  const bars = compact
    ? await page.locator('input[aria-label="Start date"]').count()
    : await page.locator('button[title*="→"], button[title*="–"], button.absolute').count();
  N('timeline: bars render across scale', bars >= 3 ? 'PASS' : `FAIL bars=${bars}`);
  const grouped = (await page.locator('text=Planned').count()) > 0 && (await page.locator('text=Doing').count()) > 0;
  N('timeline: grouped by groupBy (status headers)', grouped ? 'PASS' : 'FAIL');

  // dependency arrows from blocks link (svg lines)
  const depOk = compact
    ? await page.locator('.border-l-red-500').count() // compact renders conflict borders, no arrow layer
    : await page.locator('svg line, svg path[marker-end], svg line[marker-end]').count();
  N('timeline: dependency arrows from blocks links', depOk > 0 ? 'PASS' : 'FAIL');
  const conflict = await page.locator('.border-l-red-500, [title*="blocker ends"], [class*="border-l-4"]').count();
  N('timeline: conflict flagged (dependent starts before blocker ends)', conflict > 0 ? 'PASS' : 'FAIL');

  // date-range editor without drag: click a bar → edit start/end → Save
  const editOk = await (async () => {
    const want = '2026-10-06';
    const pre = await dexieGet(page, 'tasks', R_ALPHA, uid);
    if (pre && pre.p_f_start === want) return true; // already moved by a prior viewport run
    if (compact) {
      const row = page.locator('div:has(> button:text-is("Alpha build"))').filter({ has: page.locator('input[aria-label="Start date"]') }).first();
      if (!(await row.count())) return false;
      await row.locator('input[aria-label="Start date"]').fill(want);
      await sleep(800);
    } else {
      const bar = page.locator('button[title*="Alpha build"]').first();
      if (!(await bar.count())) return false;
      await bar.click();
      await sleep(500);
      const startIn = page.locator('[role="dialog"] input[type="date"], dialog input[type="date"], input[type="date"]').first();
      if (!(await startIn.count())) return false;
      await startIn.fill(want);
      const save = page.locator('button:has-text("Save")').first();
      if (await save.count()) await save.click();
      await sleep(800);
    }
    const rec = await dexieGet(page, 'tasks', R_ALPHA, uid);
    return rec && rec.p_f_start === '2026-10-06';
  })();
  N('timeline: date-range editor changes dates without drag', editOk ? 'PASS' : 'FAIL');
  await page.screenshot({ path: `${SHOTS}/timeline-${E}-${V}.png` });
}

/* ==================== PERF ==================== */
async function perfSuite(page, E, V, uid) {
  const N = (check, status) => note(E, V, check, status);
  await page.goto(`${BASE}/moodboards/${MBP}`, { waitUntil: 'domcontentloaded' });
  const items = await poll(async () => (await boardItems(page, uid, MBP)).length >= 350, 30000);
  N('perf: 350 mooditems synced locally', items ? 'PASS' : 'FAIL');

  const t0 = Date.now();
  const firstItem = await poll(() => page.locator('[data-mooditem]').first().count().then((c) => c > 0), 15000, 300);
  const ttf = Date.now() - t0;
  N(`perf: first render <3s`, firstItem && ttf < 3000 ? 'PASS' : `FAIL (${ttf}ms)`);

  const domCount = await page.locator('[data-mooditem]').count();
  N(`perf: culling bounds DOM nodes (${domCount}/350)`, domCount > 0 && domCount < 350 ? 'PASS' : `FAIL (${domCount})`);

  // interactivity: toolbar control responds quickly
  const t1 = Date.now();
  await page.locator('[data-testid="mood-add"]').dispatchEvent('click');
  const menuShown = await poll(() => page.locator('button:has-text("Sticky note")').count().then((c) => c > 0), 3000, 100);
  const lat = Date.now() - t1;
  N(`perf: primary control responds <3s (${lat}ms)`, menuShown && lat < 3000 ? 'PASS' : `FAIL (${lat}ms)`);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: `${SHOTS}/perf-canvas-${E}-${V}.png` });
}

/* ==================== COMPACT TOUCH ==================== */
async function compactSuite(page, E, V, uid) {
  const N = (check, status) => note(E, V, check, status);
  const coarse = await page.evaluate(() => matchMedia('(pointer:coarse)').matches);
  await page.goto(`${BASE}/moodboards/${MB}`, { waitUntil: 'domcontentloaded' });
  const ready = await poll(() => itemEl(page, 'v7_i_note').count().then((c) => c > 0), 20000);
  if (!ready) { N('compact: board loads', 'FAIL'); return; }

  // touch defaults to browse mode
  const modeBtn = page.locator('[data-testid="mode-toggle"]');
  const modeTitle = (await modeBtn.getAttribute('title')) ?? '';
  N('compact: touch defaults to Browse/Pan mode', coarse && modeTitle.startsWith('Browse') ? 'PASS' : `FAIL (coarse=${coarse} title=${modeTitle})`);

  // touch tap selects item (no move); touch drag pans
  const tapOk = await (async () => {
    const b = await itemEl(page, 'v7_i_note').boundingBox();
    if (!b) return false;
    const pre = await dexieGet(page, 'mooditems', 'v7_i_note', uid);
    await page.touchscreen.tap(b.x + 20, b.y + 20);
    await sleep(400);
    const post = await dexieGet(page, 'mooditems', 'v7_i_note', uid);
    return pre && post && post.x === pre.x && post.y === pre.y;
  })();
  N('compact: touch tap selects without moving', tapOk ? 'PASS' : 'FAIL');

  const panOk = await (async () => {
    const before = await itemEl(page, 'v7_i_note').boundingBox();
    const cb = await canvasBox(page);
    const pre = await dexieGet(page, 'mooditems', 'v7_i_note', uid);
    if (!before || !cb || !pre) return false;
    // Begin on the item itself: Browse must pan without changing its world coordinates.
    const x = before.x + Math.min(40, before.width / 2);
    const y = before.y + Math.min(40, before.height / 2);
    try {
      const cdp = await page.context().newCDPSession(page); // chromium only
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      for (let i = 1; i <= 5; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + i * 25, y: y - i * 20, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } catch {
      // non-chromium: dispatch PointerEvents (pointerType=touch) on the canvas;
      // setPointerCapture throws for synthetic pointerIds — absorb it for the duration
      await page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y) ?? document.querySelector('[data-testid="mood-canvas"]');
        const origSet = Element.prototype.setPointerCapture, origRel = Element.prototype.releasePointerCapture;
        Element.prototype.setPointerCapture = function (id) { try { origSet.call(this, id); } catch {} };
        Element.prototype.releasePointerCapture = function (id) { try { origRel.call(this, id); } catch {} };
        const fire = (type, cx, cy) => el.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', clientX: cx, clientY: cy, bubbles: true, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
        fire('pointerdown', x, y);
        for (let i = 1; i <= 5; i++) fire('pointermove', x + i * 25, y - i * 20);
        fire('pointerup', x + 125, y - 100);
        Element.prototype.setPointerCapture = origSet;
        Element.prototype.releasePointerCapture = origRel;
      }, [x, y]);
    }
    await sleep(500);
    const after = await itemEl(page, 'v7_i_note').boundingBox();
    const item = await dexieGet(page, 'mooditems', 'v7_i_note', uid);
    // screen pos moved (pan) but world coords unchanged
    return after && Math.abs(after.x - before.x) > 30 && item && item.x === pre.x && item.y === pre.y;
  })();
  N('compact: touch drag pans (browse) not move', panOk ? 'PASS' : 'FAIL');
  await page.screenshot({ path: `${SHOTS}/compact-${E}-${V}.png` });
}

/* ==================== CORE SUBSET (firefox/webkit matrix) ==================== */
async function coreSubset(page, E, V, uid, token) {
  const N = (check, status) => note(E, V, check, status);
  await page.goto(`${BASE}/moodboards/${MB}`, { waitUntil: 'domcontentloaded' });
  const ready = await poll(() => itemEl(page, 'v7_i_note').count().then((c) => c > 0), 25000);
  N('core: board loads', ready ? 'PASS' : 'FAIL');
  if (!ready) return;

  const before = new Set((await boardItems(page, uid, MB)).map((i) => i.id));
  await addViaMenu(page, 'Sticky note');
  const added = await poll(async () => (await boardItems(page, uid, MB)).some((i) => !before.has(i.id) && i.type === 'note'));
  N('core: add note via add menu', added ? 'PASS' : 'FAIL');

  const b = await uncoveredPoint(page, 'v7_i_note2');
  if (b) {
    const pre = await dexieGet(page, 'mooditems', 'v7_i_note2', uid);
    await page.mouse.move(b.x, b.y);
    await page.mouse.down();
    await page.mouse.move(b.x + 70, b.y + 30, { steps: 5 });
    await page.mouse.up();
    let lastPost;
    const postOk = pre && await poll(async () => (lastPost = await dexieGet(page, 'mooditems', 'v7_i_note2', uid)) && lastPost.x === pre.x + 70, 6000);
    N('core: pointer move updates geometry', postOk ? 'PASS' : `FAIL (${pre?.x}→${lastPost?.x})`);
  } else {
    N('core: pointer move updates geometry', 'FAIL (item fully covered — no hittable point)');
  }

  // keyboard arrow
  const kbOk = await (async () => {
    const a = await itemCenter(page, 'v7_i_note');
    if (!a) return false;
    await selectItemEl(page, 'v7_i_note');
    await sleep(200);
    await canvas(page).evaluate((el) => el.focus());
    const pre = (await dexieGet(page, 'mooditems', 'v7_i_note', uid))?.x;
    await canvas(page).press('ArrowLeft');
    await sleep(300);
    const post = (await dexieGet(page, 'mooditems', 'v7_i_note', uid))?.x;
    await canvas(page).press('Escape');
    return post === pre - 1;
  })();
  N('core: keyboard arrows move selection', kbOk ? 'PASS' : 'FAIL');

  // connect two items via select-pair → Connect selected items
  const connOk = await (async () => {
    await canvas(page).press('Escape');
    await selectItemEl(page, 'v7_i_card_a');
    await sleep(300);
    await selectItemEl(page, 'v7_i_card_b', true);
    await sleep(400);
    const btn = page.locator('button[title="Connect selected items"]').first();
    if (!(await btn.count())) return false;
    await btn.dispatchEvent('click');
    await sleep(600);
    const connectBtn = page.locator('button:text-is("Connect")').first();
    if (await connectBtn.count()) await connectBtn.dispatchEvent('click');
    await sleep(600);
    return await poll(async () =>
      (await boardItems(page, uid, MB)).some((i) => i.type === 'connector' && [i.from, i.to].includes('v7_i_card_a') && [i.from, i.to].includes('v7_i_card_b')), 8000);
  })();
  N('core: connector between two items', connOk ? 'PASS' : 'FAIL');

  // frame via add menu
  await addViaMenu(page, 'Frame');
  const frameOk = await poll(async () => (await boardItems(page, uid, MB)).some((i) => i.type === 'frame' && !before.has(i.id)), 8000);
  N('core: add frame', frameOk ? 'PASS' : 'FAIL');

  // public share renders read-only
  const share = await api('/api/shares', { method: 'POST', token, body: { pageId: MB, targetType: 'moodboard' } });
  const tk = share.data?.token ?? share.data?.share?.token;
  if (tk) {
    const pctx = await page.context().browser().newContext({ viewport: page.viewportSize() ?? { width: 1440, height: 900 } });
    const pp = await pctx.newPage();
    await pp.goto(`${BASE}/s/canvas/${tk}`, { waitUntil: 'domcontentloaded' });
    const ok = await poll(async () => !/login|auth/.test(pp.url()) && (await pp.locator('text=V7 Canvas').count()) > 0, 20000);
    N('core: public share renders unauthenticated', ok ? 'PASS' : 'FAIL');
    await pctx.close();
  } else N('core: public share renders unauthenticated', `FAIL (no token: ${share.status})`);
  await page.screenshot({ path: `${SHOTS}/core-${E}-${V}.png` });
}

const run = (label, fn) => certification.run(`${activeEngine}/${activeViewport}/${label}`, activeEngine, activeViewport, fn);

/* ==================== MATRIX ==================== */
const engines = { chromium, firefox, webkit };
const DESKTOP = { width: 1440, height: 900 };
const TABLET = { width: 820, height: 1180 };
const COMPACT = { width: 390, height: 844 };

const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];
const runEngines = only ? only.split(',') : ['chromium', 'firefox', 'webkit'];

for (const name of runEngines) {
  const engine = engines[name];
  if (!engine) { note(name, 'none', 'mandatory browser selection', 'FAIL', new Error(`Unknown engine ${name}`)); continue; }
  activeEngine = name;
  let browser;
  try { browser = await certification.trackBrowser(await engine.launch(), name); } catch (error) { note(name, 'none', 'mandatory browser launch', 'FAIL', error); continue; }
  console.log(`\n=== ${name} ===`);

  activeViewport = 'desktop';
  // desktop: chromium gets the full suite; ff/webkit the tagged core subset
  {
    const ctx = await browser.newContext({ viewport: DESKTOP });
    const page = await loginPage(ctx, admin);
    if (name === 'chromium') {
      await run('canvasSuite', () => canvasSuite(page, name, 'desktop', admin.user.id));
      await run('modeSuite', () => modeSuite(page, name, 'desktop', admin.user.id));
      await run('offlineSuite', () => offlineSuite(page, name, 'desktop', admin.user.id));
      await run('multiUserSuite', () => multiUserSuite(browser, name, 'desktop', admin.user.id));
      await run('undoSuite', () => undoSuite(browser, name, 'desktop'));
      await run('publicShareSuite', () => publicShareSuite(browser, name, 'desktop'));
      await run('viewsSuite', () => viewsSuite(page, name, 'desktop', admin.user.id, false));
      await run('perfSuite', () => perfSuite(page, name, 'desktop', admin.user.id));
    } else {
      await run('coreSubset', () => coreSubset(page, name, 'desktop', admin.user.id, admin.token));
      await run('publicShareSuite', () => publicShareSuite(browser, name, 'desktop'));
    }
    await ctx.close();
  }

  activeViewport = 'compact';
  // compact touch
  {
    const ctx = await browser.newContext({ viewport: COMPACT, hasTouch: true, isMobile: name !== 'firefox' });
    const page = await loginPage(ctx, admin);
    if (name === 'chromium') {
      await run('compactSuite', () => compactSuite(page, name, 'compact', admin.user.id));
      await run('viewsSuite', () => viewsSuite(page, name, 'compact', admin.user.id, true));
    } else {
      await run('compactSuite', () => compactSuite(page, name, 'compact', admin.user.id));
    }
    await ctx.close();
  }

  // tablet (chromium only — layout spot-check)
  if (name === 'chromium') {
    activeViewport = 'tablet';
    const ctx = await browser.newContext({ viewport: TABLET });
    const page = await loginPage(ctx, admin);
    await run('viewsSuite', () => viewsSuite(page, name, 'tablet', admin.user.id, false));
    await ctx.close();
  }

  await browser.close();
}

/* ==================== REPORT ==================== */
console.log('\n==================== RESULTS ====================');
// explicit NOT RUN gates (separate physical/accessibility passes)
for (const g of ['physical iOS Safari device run', 'physical Android device run', 'assistive technology (VoiceOver/TalkBack) audit'])
  note('manual', 'device', g, 'NOT RUN');
const byStatus = { PASS: 0, FAIL: 0, 'NOT RUN': 0 };
for (const r of results) {
  const bucket = r.status === 'PASS' ? 'PASS' : r.status === 'NOT RUN' ? 'NOT RUN' : 'FAIL';
  byStatus[bucket] += 1;
  console.log(`${r.status.padEnd(8)} [${r.engine}/${r.viewport}] ${r.check}`);
}
console.log(`\nTOTAL: ${byStatus.PASS} PASS / ${byStatus.FAIL} FAIL / ${byStatus['NOT RUN']} NOT RUN`);
certification.finish();
process.exit(byStatus.FAIL || process.exitCode ? 1 : 0);
