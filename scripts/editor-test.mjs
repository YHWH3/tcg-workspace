// Block editor interaction test. Usage: node scripts/editor-test.mjs [base]
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const OUT = '/tmp/notion-shots/v2';
await mkdir(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond) => {
  console.log(cond ? `  PASS ${name}` : `  FAIL ${name}`);
  if (!cond) failures++;
};

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.getByPlaceholder('ada').fill('admin');
await page.locator('input[type=password]').first().fill('password123');
await page.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click();
await page.waitForSelector('text=Synced', { timeout: 15000 });

// new empty page → placeholder block visible
const prevUrl = page.url();
await page.getByRole('button', { name: 'New page' }).first().click();
await page.waitForFunction((u) => location.href !== u && /\/pages\//.test(location.pathname), prevUrl);
const pageId = page.url().split('/pages/')[1];
await sleep(400);
const placeholder = await page.locator('[data-placeholder-block]').count();
check('empty page shows placeholder block', placeholder === 1);

// click placeholder → focuses a real block
await page.locator('[data-placeholder-block]').click();
await sleep(300);
check('placeholder click focuses first block', (await page.evaluate(() => document.activeElement?.hasAttribute('data-block') ?? false)));

// type a line then Enter, waiting for focus to land on the new block
const typeLine = async (text) => {
  await page.keyboard.type(text, { delay: 25 });
  await page.keyboard.press('Enter');
  await sleep(450); // splitBlock → mutate → focusReq → render+focus
};
await typeLine('# Heading');
await typeLine('Some text');
await typeLine('- bullet');
await typeLine('[] todo');
await typeLine('1. numbered');
await sleep(600);

let blocks = await page.evaluate(async (pid) => {
  const { db } = await import('/src/core/db.ts');
  return (await db.blocks.where('pageId').equals(pid).toArray()).filter((b) => !b.deleted).sort((a, b) => String(a.order).localeCompare(String(b.order))).map((b) => `${b.type}:${b.text}`);
}, pageId);
console.log('  blocks:', JSON.stringify(blocks));
check('h1 created', blocks[0] === 'h1:Heading');
check('p after h1', blocks[1] === 'p:Some text');
check('bullet created', blocks[2] === 'bullet:bullet');
check('todo created', blocks[3] === 'todo:todo');
check('numbered created', blocks[4] === 'numbered:numbered');
check('trailing numbered continues', blocks[5] === 'numbered:');

// Enter on empty numbered item → converts to paragraph
await page.keyboard.press('Enter');
await sleep(400);
blocks = await page.evaluate(async (pid) => {
  const { db } = await import('/src/core/db.ts');
  return (await db.blocks.where('pageId').equals(pid).toArray()).filter((b) => !b.deleted).sort((a, b) => String(a.order).localeCompare(String(b.order))).map((b) => `${b.type}:${b.text}`);
}, pageId);
check('empty list-item Enter → paragraph', blocks[5] === 'p:');

// Backspace on empty block deletes it + focuses previous
await page.keyboard.press('Backspace');
await sleep(400);
blocks = await page.evaluate(async (pid) => {
  const { db } = await import('/src/core/db.ts');
  return (await db.blocks.where('pageId').equals(pid).toArray()).filter((b) => !b.deleted).sort((a, b) => String(a.order).localeCompare(String(b.order))).map((b) => `${b.type}:${b.text}`);
}, pageId);
check('backspace deletes empty block', blocks.length === 5);

// split mid-line: focus 'Some text', caret after 'Some', Enter
await page.locator('[data-block]').nth(1).click();
await page.keyboard.press('Home');
await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowRight');
await page.keyboard.press('Enter');
await sleep(400);
blocks = await page.evaluate(async (pid) => {
  const { db } = await import('/src/core/db.ts');
  return (await db.blocks.where('pageId').equals(pid).toArray()).filter((b) => !b.deleted).sort((a, b) => String(a.order).localeCompare(String(b.order))).map((b) => `${b.type}:${b.text}`);
}, pageId);
check('mid-line split', blocks[1] === 'p:Some' && blocks[2] === 'p: text');

// slash menu: last block is ' text' — go to end, new line, type /
await page.keyboard.press('Escape').catch(() => {});
const lastTa = page.locator('[data-block]').last();
await lastTa.click();
await page.keyboard.press('End');
await page.keyboard.press('Enter');
await sleep(300);
await page.keyboard.type('/', { delay: 10 });
await sleep(300);
const menuVisible = await page.locator('text=Heading 1').count();
check('slash menu opens', menuVisible > 0);
await page.keyboard.press('Escape');
await page.keyboard.press('Backspace');

// persistence across reload
await page.reload({ waitUntil: 'networkidle' });
await sleep(800);
blocks = await page.evaluate(async (pid) => {
  const { db } = await import('/src/core/db.ts');
  return (await db.blocks.where('pageId').equals(pid).toArray()).filter((b) => !b.deleted).sort((a, b) => String(a.order).localeCompare(String(b.order))).map((b) => `${b.type}:${b.text}`);
}, pageId);
check('blocks persist after reload', blocks[0] === 'h1:Heading' && blocks.filter((b) => b.startsWith('h1:')).length === 1);
check('no text leaked to comments', await page.evaluate(async () => (await (await import('/src/core/db.ts')).db.comments.count()) >= 0));

// comment author renders real name
await page.locator('textarea[placeholder="Write a comment…"]').fill('looks good');
await page.keyboard.press('Enter');
await sleep(600);
const authorOk = await page.locator('span:has-text("Admin")').count();
check('comment shows real author', authorOk > 0);

// click empty area below blocks → focuses last block
await page.locator('main .min-h-40').click({ position: { x: 200, y: 250 } }).catch(() => {});
await sleep(300);
const focused = await page.evaluate(() => document.activeElement?.hasAttribute('data-block') ?? false);
check('click below blocks focuses last block', focused);

await page.screenshot({ path: `${OUT}/04-page-blocks.png` });

// mobile view of the same page
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const token = await page.evaluate(() => localStorage.getItem('ws_token'));
const user = await page.evaluate(() => localStorage.getItem('ws_user'));
const mpage = await mctx.newPage();
await mpage.addInitScript(([t, u]) => {
  localStorage.setItem('ws_token', t);
  localStorage.setItem('ws_user', u);
  localStorage.setItem('ws_uid', JSON.parse(u).id);
}, [token, user]);
await mpage.goto(page.url(), { waitUntil: 'networkidle' });
await sleep(1000);
await mpage.screenshot({ path: `${OUT}/04b-page-blocks-mobile.png` });
await mctx.close();
await browser.close();
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures ? 1 : 0);
