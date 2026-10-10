// scripts/_repro-archived-view.mjs — Agent F scratch (owned)
// Repro: does an archived record actually render in the database view UI,
// or is 'Archived frost note' text surfacing somewhere else?
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const BASE = 'http://localhost:8788';
const PASS = 'password123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const killTree = () => { for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL'); } catch {} } try { execSync("lsof -ti:8788 | xargs -r kill -9", { stdio: 'ignore' }); } catch {} };
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
  { id: 'r_db_obs', collection: 'boards', ts: NOW, patch: { name: 'Obs', kind: 'records', recordNoun: 'Obs', columns: [{ id: 'logged', name: 'Logged', color: '#222' }], fields: [], order: 'a2', createdAt: NOW } },
  { id: 'r_vis', collection: 'tasks', ts: NOW, patch: { boardId: 'r_db_obs', title: 'VISIBLE RECORD', status: 'logged', order: 'a1', createdAt: NOW } },
  { id: 'r_arch', collection: 'tasks', ts: NOW, patch: { boardId: 'r_db_obs', title: 'ARCHIVED RECORD', status: 'logged', archived: true, order: 'a2', createdAt: NOW } },
  { id: 'r_db_hid', collection: 'boards', ts: NOW, patch: { name: 'RETIRED DB', kind: 'records', columns: [{ id: 'open', name: 'O', color: '#222' }], fields: [], archived: true, order: 'a9', createdAt: NOW } },
] } });

const browser = await chromium.launch();
for (const [label, vp] of [['desktop', { width: 1440, height: 900 }], ['compact', { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport: vp, ...(vp.width < 500 ? { hasTouch: true, isMobile: true } : {}) });
  const page = await ctx.newPage();
  await page.addInitScript(([tok, u]) => {
    localStorage.setItem('ws_token', tok);
    localStorage.setItem('ws_user', JSON.stringify(u));
    localStorage.setItem('ws_uid', u.id);
  }, [admin.token, admin.user]);
  await page.goto(`${BASE}/boards/r_db_obs`, { waitUntil: 'domcontentloaded' });
  await sleep(6000); // let pull + render settle
  const hits = await page.locator('text=ARCHIVED RECORD').all();
  const vis = await page.locator('text=VISIBLE RECORD').count();
  console.log(`${label}: 'ARCHIVED RECORD' occurrences=${hits.length}  'VISIBLE RECORD'=${vis}`);
  for (const h of hits.slice(0, 5)) {
    const parent = await h.evaluate((el) => {
      let n = el; const chain = [];
      for (let i = 0; i < 6 && n; i++) { chain.push(`${n.tagName}.${String(n.className).slice(0, 60)}`); n = n.parentElement; }
      return chain.join(' < ');
    }).catch(() => '?');
    console.log(`   hit: ${parent}`);
  }
  await page.screenshot({ path: `/tmp/repro-arch-${label}.png` });
  // boards index: is the archived board listed?
  await page.goto(`${BASE}/boards`, { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  console.log(`${label}: boards index 'RETIRED DB' occurrences=${await page.locator('text=RETIRED DB').count()}`);
  await ctx.close();
}
await browser.close();
killTree();
console.log('done');
