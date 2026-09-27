// v2 verification + screenshots: tasks header, task detail w/ real author,
// sync indicator, offline sign-out confirm dialog, assignee/activity names.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = 'http://localhost:5173';
const OUT = '/tmp/notion-shots/v2';
await mkdir(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond) => {
  console.log(cond ? `  PASS ${name}` : `  FAIL ${name}`);
  if (!cond) failures++;
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.getByPlaceholder('ada').fill('admin');
await page.locator('input[type=password]').first().fill('password123');
await page.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click();
await page.waitForSelector('text=Synced', { timeout: 20000 });
check('sync indicator shows Synced after login', await page.locator('text=Synced').count() > 0);

// users cache populated after post-login sync
const userCount = await page.evaluate(async () => (await (await import('/src/core/db.ts')).db.users.count()));
check('users cache populated', userCount === 7);

// --- Tasks: create a task assigned to another user, check assignee name ---
await page.goto(`${BASE}/tasks`, { waitUntil: 'networkidle' });
await sleep(500);
await page.screenshot({ path: `${OUT}/05-tasks-header-desktop.png` });
// new task via button
await page.getByRole('button', { name: /new task/i }).first().click();
await sleep(400);
const titleInput = page.locator('input[placeholder*="title" i], textarea[placeholder*="title" i]').first();
await titleInput.fill('Launch checklist');
await page.keyboard.press('Enter').catch(() => {});
await sleep(700);

// open first task card → detail
await page.locator('text=Launch checklist').first().click();
await sleep(600);
// assign to 'bob' via assignee control if present
const assignSel = page.locator('select').last();
if (await assignSel.count()) {
  const opts = await assignSel.locator('option').allTextContents();
  console.log('  assignee options:', JSON.stringify(opts));
  const bobIdx = opts.findIndex((o) => /bob/i.test(o));
  if (bobIdx > 0) await assignSel.selectOption({ index: bobIdx });
}
await sleep(400);
// add a comment
const cb = page.locator('textarea[placeholder*="comment" i]').first();
if (await cb.count()) {
  await cb.fill('on it');
  await page.keyboard.press('Enter');
  await sleep(600);
}
await page.screenshot({ path: `${OUT}/06-task-detail-comment.png` });
const commentAuthor = await page.locator('text=Admin').count();
check('task detail comment shows real author', commentAuthor > 0);
const someone = await page.locator('text=Someone').count();
check('no "Someone" fallback on screen', someone === 0);
await page.screenshot({ path: `${OUT}/06-task-detail-comment.png` });

// board header screenshot after closing detail
await page.keyboard.press('Escape');
await sleep(400);
await page.screenshot({ path: `${OUT}/05-tasks-header-desktop.png` });

// check assignee name renders on board card or in detail reopened
await page.locator('text=Launch checklist').first().click();
await sleep(500);
const bobVisible = await page.evaluate(() => document.body.innerText.includes('bob') || document.body.innerText.includes('Bob'));
check('assignee name resolves (bob)', bobVisible);
await page.keyboard.press('Escape');

// --- Activity actor names ---
await page.goto(`${BASE}/activity`, { waitUntil: 'networkidle' });
await sleep(800);
const actText = await page.evaluate(() => document.body.innerText);
check('activity shows actor name not Someone', !/Someone/.test(actText));
console.log('  activity sample:', JSON.stringify(actText.split('\n').filter((l) => l.trim()).slice(0, 8)));

// --- sidebar sync indicator screenshot ---
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await sleep(600);
const ind = page.locator('aside, nav').first();
await page.screenshot({ path: `${OUT}/07-sync-indicator.png`, clip: { x: 0, y: 780, width: 280, height: 120 } }).catch(async () => {
  await page.screenshot({ path: `${OUT}/07-sync-indicator.png` });
});

// --- mobile tasks header ---
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const mpage = await mctx.newPage();
await mpage.goto(`${BASE}/tasks`, { waitUntil: 'networkidle' });
await mpage.getByPlaceholder('ada').fill('admin');
await mpage.locator('input[type=password]').first().fill('password123');
await mpage.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click();
await mpage.waitForSelector('text=Synced', { timeout: 20000 }).catch(() => {});
await mpage.goto(`${BASE}/tasks`, { waitUntil: 'networkidle' });
await sleep(800);
await mpage.screenshot({ path: `${OUT}/08-tasks-header-mobile.png` });
await mctx.close();

// --- offline sign-out confirm dialog ---
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await sleep(800);
await ctx.setOffline(true);
await sleep(400);
// create an unsynced change directly through the local write API
await page.evaluate(async () => {
  const { mutate } = await import('/src/core/sync/engine.ts');
  await mutate('pages', `offline-${Date.now()}`, { title: 'offline draft', order: 'zz' });
});
await sleep(300);
const pend = await page.evaluate(async () => (await (await import('/src/core/db.ts')).db.outbox.count()));
check('outbox has pending while offline', pend > 0);
check('offline indicator shows pending count', await page.locator(`text=/Offline · ${pend} pending/`).count() > 0);
// open user menu → sign out
await page.locator('aside').getByText('Admin').last().click();
await sleep(400);
const soBtn = page.getByText('Sign out').first();
if (await soBtn.count()) {
  await soBtn.click();
  await sleep(700);
  const dlg = await page.locator('text=unsynced change').count();
  check('sign-out confirm dialog appears', dlg > 0);
  const msgOk = await page.locator('text=/will be lost if someone else signs in/').count();
  check('dialog has required wording', msgOk > 0);
  await page.screenshot({ path: `${OUT}/09-signout-confirm.png` });
  const stay = await page.getByRole('button', { name: /stay signed in/i }).count();
  check('stay-signed-in option present', stay > 0);
  await page.getByRole('button', { name: /stay signed in/i }).click().catch(() => {});
} else {
  check('sign-out menu reachable', false);
}
await ctx.setOffline(false);
await sleep(1200);
check('returns to Synced after reconnect', await page.locator('text=Synced').count() > 0);

await browser.close();
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures ? 1 : 0);
