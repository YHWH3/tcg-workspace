// Phase 3 report screenshots — install pack if needed, shoot dashboard/archive/field
// at desktop/tablet/compact. Usage: node scripts/_p3-shots.mjs (server on :8788, admin user exists)
import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE = 'http://localhost:8788';
const OUT = '/tmp/p3-shots';
fs.mkdirSync(OUT, { recursive: true });
const PASS = 'password123';
const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: PASS }) })).json();
const browser = await chromium.launch();
const mk = async (vp, extra = {}) => { const ctx = await browser.newContext({ viewport: vp, ...extra }); const p = await ctx.newPage(); await p.addInitScript(([t, u]) => { localStorage.setItem('ws_token', t); localStorage.setItem('ws_user', JSON.stringify(u)); localStorage.setItem('ws_uid', u.id); }, [login.token, login.user]); return { ctx, p }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const poll = async (fn, t = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if (await fn()) return true; await sleep(400); } return false; };

// ensure pack installed (gallery install via UI — same path as the e2e)
const { ctx, p } = await mk({ width: 1440, height: 900 });
await p.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
await p.locator('text=Template gallery').first().waitFor({ timeout: 15000 });
const installed = await p.locator('li:has-text("TCG Operating Pack"):has-text("Installed")').count();
if (!installed) {
  const row = p.locator('li:has-text("TCG Operating Pack")').first();
  await row.locator('button:has-text("Add to workspace")').first().dispatchEvent('click');
  const btn = p.locator('[role="dialog"] button:has-text("Install")').first();
  await poll(() => btn.isEnabled().catch(() => false), 30000);
  await btn.dispatchEvent('click');
  await poll(() => p.url().includes('/pages/'), 90000);
}
await sleep(1500);

const shots = [
  ['leadership-desktop.png', { width: 1440, height: 900 }, '/'],
  ['leadership-tablet.png', { width: 820, height: 1180 }, '/'],
  ['leadership-compact.png', { width: 390, height: 844 }, '/'],
  ['capture-compact.png', { width: 390, height: 844, hasTouch: true, isMobile: true }, '/capture'],
];
for (const [file, vp, route] of shots) {
  const { ctx: c2, p: pg } = await mk(vp);
  await pg.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  // open the pack home (first pages-tree entry) on the dashboard shots
  if (route === '/') {
    const home = pg.locator('text=Home').first();
    if (await home.count()) { await home.dispatchEvent('click').catch(() => {}); await sleep(1500); }
  }
  await pg.screenshot({ path: `${OUT}/${file}` });
  await c2.close();
}
// archived section on tablet: archive the first sidebar page then screenshot sidebar
{
  const { ctx: c3, p: pg } = await mk({ width: 820, height: 1180 });
  await pg.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await sleep(2000);
  await pg.screenshot({ path: `${OUT}/archive-sidebar-tablet.png` });
  await c3.close();
}
await browser.close();
await ctx.close();
console.log('shots in', OUT);
