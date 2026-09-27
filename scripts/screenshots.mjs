// Visual + offline verification. Usage: node scripts/screenshots.mjs [base]
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const OUT = '/tmp/notion-shots';
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- desktop ---------- */
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await shot(page, '01-auth-login');

// switch to join tab for a shot
await page.getByRole('button', { name: 'Join with invite' }).click();
await sleep(300);
await shot(page, '02-auth-join');
await page.locator('div').getByRole('button', { name: 'Sign in', exact: true }).first().click();

// login as admin (created by smoke.sh)
await page.getByPlaceholder('ada').fill('admin');
await page.locator('input[type=password]').first().fill('password123');
await page.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click();
await page.waitForSelector('text=Synced', { timeout: 10000 }).catch(() => {});
await sleep(1500);
await shot(page, '03-home');

// create a page + blocks
await page.getByRole('button', { name: 'New page' }).first().click();
await page.waitForURL(/\/pages\//, { timeout: 5000 });
await page.locator('textarea[placeholder="Untitled"]').fill('Launch plan');
await page.keyboard.press('Enter');
await sleep(400);

// click "Add a block" then type some blocks
const addBlock = page.getByRole('button', { name: 'Add a block' });
if (await addBlock.isVisible().catch(() => false)) await addBlock.click();
const blockTa = page.locator('main textarea').last();
await blockTa.fill('# Launch plan');
// markdown shortcut: type '# ' converts to h1 — emulate by typing chars
await blockTa.fill('');
await blockTa.pressSequentially('# ', { delay: 20 });
await blockTa.pressSequentially('Launch plan', { delay: 10 });
await page.keyboard.press('Enter');
await sleep(300);
const ta2 = page.locator('main textarea').last();
await ta2.pressSequentially('A checklist for the big day.', { delay: 5 });
await page.keyboard.press('Enter');
const ta3 = page.locator('main textarea').last();
await ta3.pressSequentially('- First item', { delay: 5 });
await page.keyboard.press('Enter');
const ta4 = page.locator('main textarea').last();
await ta4.pressSequentially('[] Todo item', { delay: 5 });
await sleep(600);
await shot(page, '04-page-blocks');

// tasks board
await page.goto(`${BASE}/tasks`, { waitUntil: 'networkidle' });
await sleep(400);
for (const title of ['Write launch post', 'Book venue', 'Send invites']) {
  await page.locator('header').getByRole('button', { name: 'New task' }).click();
  await page.waitForURL(/\/tasks\/.+/, { timeout: 5000 });
  await page.locator('textarea[placeholder="Task title"]').fill(title);
  await page.locator('aside button[aria-label="Close"]').click();
  await sleep(400);
}
await shot(page, '05-board');

// move one to in progress via list view? open detail and set fields
await page.goto(`${BASE}/tasks`, { waitUntil: 'networkidle' });
await page.locator('text=Write launch post').first().click();
await page.waitForURL(/\/tasks\/.+/, { timeout: 5000 });
await sleep(400);
// set assignee (first user) & due date & status
const selects = page.locator('aside select');
await selects.nth(0).selectOption('in_progress');
await selects.nth(1).selectOption('high');
await selects.nth(2).selectOption({ index: 1 });
await page.locator('aside input[type=date]').fill('2026-10-01');
// comment
await page.locator('textarea[placeholder="Write a comment…"]').fill('Draft ready for review');
await page.keyboard.press('Enter');
await sleep(700);
await shot(page, '06-task-detail');
await page.keyboard.press('Escape');
await sleep(300);
await shot(page, '07-board-filled');

// list view
await page.getByRole('button', { name: 'list' }).click();
await sleep(400);
await shot(page, '08-list');

// activity
await page.goto(`${BASE}/activity`, { waitUntil: 'networkidle' });
await sleep(500);
await shot(page, '09-activity');
await page.getByRole('button', { name: 'All activity' }).click();
await sleep(300);
await shot(page, '10-activity-all');

// settings
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
await sleep(500);
await shot(page, '11-settings');

// command palette
await page.goto(BASE, { waitUntil: 'networkidle' });
await sleep(400);
await page.keyboard.press('Meta+k');
await sleep(400);
await shot(page, '12-palette');
await page.keyboard.press('Escape');

// dark mode
await page.emulateMedia({ colorScheme: 'dark' });
await page.evaluate(() => localStorage.setItem('ws_theme', 'dark'));
await page.reload({ waitUntil: 'networkidle' });
await sleep(600);
await shot(page, '13-dark-home');
await page.goto(`${BASE}/tasks`, { waitUntil: 'networkidle' });
await sleep(400);
await shot(page, '14-dark-board');
await page.emulateMedia({ colorScheme: 'light' });
await page.evaluate(() => localStorage.setItem('ws_theme', 'system'));

const token = await page.evaluate(() => localStorage.getItem('ws_token'));
const user = await page.evaluate(() => localStorage.getItem('ws_user'));
await ctx.close();

/* ---------- mobile ---------- */
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const mpage = await mctx.newPage();
await mpage.addInitScript(
  ([t, u]) => {
    if (t) {
      localStorage.setItem('ws_token', t);
      localStorage.setItem('ws_user', u);
      localStorage.setItem('ws_uid', JSON.parse(u).id);
    }
  },
  [token, user],
);
await mpage.goto(BASE, { waitUntil: 'networkidle' });
await sleep(1200);
await shot(mpage, '20-mobile-home');

await mpage.goto(`${BASE}/tasks`, { waitUntil: 'networkidle' });
await sleep(600);
await shot(mpage, '21-mobile-board');

await mpage.locator('text=Write launch post').first().click();
await sleep(500);
await shot(mpage, '22-mobile-task-sheet');
await mpage.keyboard.press('Escape');
await sleep(300);

await mpage.goto(`${BASE}/activity`, { waitUntil: 'networkidle' });
await sleep(500);
await shot(mpage, '23-mobile-activity');

// sidebar sheet
await mpage.goto(BASE, { waitUntil: 'networkidle' });
await mpage.getByRole('button', { name: 'Menu', exact: true }).click();
await sleep(400);
await shot(mpage, '24-mobile-sheet');
await mpage.keyboard.press('Escape');

/* ---------- offline test ---------- */
console.log('--- offline test');
await mpage.goto(`${BASE}/tasks`, { waitUntil: 'networkidle' });
await sleep(500);
await mctx.setOffline(true);
await sleep(300);
await mpage.getByRole('button', { name: 'New task' }).click();
await mpage.locator('textarea[placeholder="Task title"]').fill('Offline task');
await mpage.keyboard.press('Escape');
await sleep(400);
await mpage.reload({ waitUntil: 'domcontentloaded' });
await sleep(1200);
const offlineVisible = await mpage.locator('text=Offline task').count();
console.log('offline task visible after reload:', offlineVisible > 0 ? 'YES' : 'NO');
await shot(mpage, '25-offline-task');
await mctx.setOffline(false);
await sleep(2500); // allow push debounce + sync
// verify on server via pull API
const res = await mpage.evaluate(async (tok) => {
  const r = await fetch('/api/sync/pull?since=0', { headers: { Authorization: `Bearer ${tok}` } });
  return r.json();
}, token);
const found = (res.records ?? []).some((r) => r.collection === 'tasks' && r.data?.title === 'Offline task');
console.log('offline task reached server:', found ? 'YES' : 'NO');

await mctx.close();
await browser.close();
console.log('done →', OUT);
