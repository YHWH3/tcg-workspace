// scripts/_repro-webkit-capture.mjs — Agent F scratch (owned)
// Repro: why does /capture save() die mid-way on WebKit (record lands, but
// no files row, no related link, no 'Saved offline' indicator)?
// Drives the same capture flow in webkit and chromium, dumping console+pageerrors.
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webkit, chromium } from 'playwright';

const BASE = 'http://localhost:8788';
const PASS = 'password123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FIX = mkdtempSync(join(tmpdir(), 'v8repro-'));
writeFileSync(`${FIX}/photo.png`, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

const procs = [];
const killTree = () => {
  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }
  try { execSync("lsof -ti:8788 | xargs -r kill -9", { stdio: 'ignore' }); } catch {}
};
try { execSync("lsof -ti:8788 | xargs -r kill -9", { stdio: 'ignore' }); } catch {}
await sleep(300);
const persistDir = mkdtempSync(join(tmpdir(), 'ws-repro-d1-'));
await new Promise((res) => { const p = spawn('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistDir], { stdio: 'inherit', detached: true }); procs.push(p); p.on('exit', res); });
procs.length = 0;
procs.push(spawn('npx', ['wrangler', 'dev', '--local', '--port', '8788', '--persist-to', persistDir], { stdio: ['ignore', 'pipe', 'pipe'], detached: true }));
process.on('exit', killTree);
const t0 = Date.now();
for (;;) {
  try { const j = await (await fetch(`${BASE}/api/auth/status`)).json(); if (!j.error) break; } catch {}
  if (Date.now() - t0 > 120000) { console.log('server never up'); process.exit(2); }
  await sleep(1000);
}
const api = async (path, { method = 'GET', token, body } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  return { status: res.status, data: await res.json().catch(() => null) };
};
let admin = (await api('/api/auth/signup', { method: 'POST', body: { username: 'admin', name: 'A', password: PASS } })).data;
if (!admin?.token) admin = (await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: PASS } })).data;
const T = admin.token;
const NOW = Date.now();
await api('/api/sync/push', { method: 'POST', token: T, body: { changes: [
  { id: 'r_db_places', collection: 'boards', ts: NOW, patch: { name: 'Sites', kind: 'records', recordNoun: 'Site', columns: [{ id: 'active', name: 'A', color: '#222' }], fields: [], captureTargets: [{ kind: 'observation', databaseId: 'r_db_obs' }], order: 'a1', createdAt: NOW } },
  { id: 'r_db_obs', collection: 'boards', ts: NOW, patch: { name: 'Obs', kind: 'records', recordNoun: 'Obs', columns: [{ id: 'logged', name: 'L', color: '#222' }], fields: [{ id: 'f_meas', name: 'M', type: 'number' }, { id: 'f_unit', name: 'U', type: 'text' }], order: 'a2', createdAt: NOW } },
  { id: 'r_place_1', collection: 'tasks', ts: NOW, patch: { boardId: 'r_db_places', title: 'Rain Gauge Site', status: 'active', order: 'a1', createdAt: NOW } },
] } });
const pullAll = async () => {
  const out = []; let since = 0;
  for (let i = 0; i < 60; i++) {
    const p = await api(`/api/sync/pull?since=${since}`, { token: T });
    out.push(...(p.data?.records ?? []));
    if (!p.data?.hasMore) return out;
    since = p.data.cursor;
  }
  return out;
};

for (const [name, engine] of [['webkit', webkit], ['chromium', chromium]]) {
  console.log(`\n===== ${name} =====`);
  const browser = await engine.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) console.log(`  [console.${m.type()}]`, m.text().slice(0, 300)); });
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 400)));
  await page.addInitScript(([tok, u]) => {
    localStorage.setItem('ws_token', tok);
    localStorage.setItem('ws_user', JSON.stringify(u));
    localStorage.setItem('ws_uid', u.id);
  }, [admin.token, admin.user]);
  const uniq = `repro-${name}`;
  await page.goto(`${BASE}/capture`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  await page.locator('button:has-text("Add context")').first().dispatchEvent('click');
  const pick = page.locator('[role="dialog"] input').first();
  await pick.fill('Rain Gauge');
  await sleep(600);
  await page.locator('text=Rain Gauge Site').first().dispatchEvent('click').catch(() => {});
  await sleep(400);
  await page.locator('button:has-text("Observation")').first().dispatchEvent('click');
  await sleep(400);
  const dest = await page.locator('select[aria-label="Destination database"]').inputValue().catch(() => '');
  console.log('  dest select:', dest);
  await page.locator('input[inputmode="decimal"]').first().fill('12.5').catch(() => {});
  await page.locator('textarea').first().fill(`note ${uniq}`).catch(() => {});
  const fileInputs = await page.locator('input[type="file"]').count();
  console.log('  file inputs:', fileInputs);
  if (fileInputs >= 2) await page.locator('input[type="file"]').nth(1).setInputFiles(`${FIX}/photo.png`).catch((e) => console.log('  setInputFiles err', e.message));
  await ctx.setOffline(true);
  await sleep(400);
  const online = await page.evaluate(() => navigator.onLine);
  console.log('  navigator.onLine after setOffline(true):', online);
  const t1 = Date.now();
  await page.locator('button:has-text("Save to")').first().dispatchEvent('click');
  const saved = await (async () => { const tt = Date.now(); while (Date.now() - tt < 16000) { if (await page.locator('text=Saved offline').count() > 0) return true; await sleep(500); } return false; })();
  console.log(`  'Saved offline' shown: ${saved} (${Date.now() - t1}ms)`);
  await ctx.setOffline(false);
  await sleep(6000);
  const rows = await pullAll();
  const rec = rows.find((r) => r.collection === 'tasks' && r.data?.boardId === 'r_db_obs' && JSON.stringify(r.data).includes(uniq));
  console.log('  record server-side:', rec ? rec.id : 'MISSING');
  if (rec) {
    const rel = rows.find((r) => r.collection === 'links' && r.data?.fromId === rec.id && r.data?.toId === 'r_place_1');
    const fil = rows.find((r) => r.collection === 'files' && r.data?.parentId === rec.id);
    console.log('  related link:', rel ? 'YES' : 'NO', '| files row:', fil ? 'YES' : 'NO');
  }
  await browser.close();
}
killTree();
console.log('\ndone');
