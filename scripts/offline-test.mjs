// Offline behaviour test against the production build (wrangler dev :8788).
// Usage: node scripts/offline-test.mjs [base]
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:8788';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

// login
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.getByPlaceholder('ada').fill('admin');
await page.locator('input[type=password]').first().fill('password123');
await page.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click();
await page.waitForSelector('text=Synced', { timeout: 15000 });
console.log('logged in + synced');

// wait for service worker to be active
await page.waitForFunction(() => navigator.serviceWorker?.controller !== undefined || navigator.serviceWorker === undefined, { timeout: 10000 });
await page.evaluate(() => navigator.serviceWorker?.ready);
await sleep(1500);
const swState = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg?.active?.state ?? 'none';
});
console.log('service worker:', swState);

// go offline, create a task
await ctx.setOffline(true);
await sleep(400);
await page.goto(`${BASE}/tasks`).catch(() => {}); // navigation under SW should still work
await page.waitForSelector('text=Tasks', { timeout: 10000 });
const offlineBadge = await page.locator('text=Offline').count();
await page.locator('header').getByRole('button', { name: 'New task' }).click();
await page.locator('textarea[placeholder="Task title"]').fill('Offline task');
await page.locator('aside button[aria-label="Close"], button[aria-label="Close"]').first().click();
await sleep(600);
console.log('created task offline; offline indicator visible:', offlineBadge > 0 ? 'YES' : 'NO');

// reload while offline — must still work (SW precache) and show the task
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('text=Tasks', { timeout: 10000 });
await sleep(1200);
const visible = await page.locator('text=Offline task').count();
console.log('offline task survives reload:', visible > 0 ? 'PASS' : 'FAIL');

// back online → should sync to D1
await ctx.setOffline(false);
await sleep(4000);
const token = await page.evaluate(() => localStorage.getItem('ws_token'));
const res = await page.evaluate(async (tok) => {
  const r = await fetch('/api/sync/pull?since=0', { headers: { Authorization: `Bearer ${tok}` } });
  return r.json();
}, token);
const found = (res.records ?? []).some((r) => r.collection === 'tasks' && r.data?.title === 'Offline task');
console.log('offline task reached server after reconnect:', found ? 'PASS' : 'FAIL');

await page.screenshot({ path: '/tmp/notion-shots/26-offline-reload.png' });
await browser.close();
process.exit(visible > 0 && found ? 0 : 1);
