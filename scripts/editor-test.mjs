// Block editor interaction test (contentEditable + mentions). Usage: node scripts/editor-test.mjs [base]
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const OUT = '/tmp/notion-shots/v4';
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

const dumpBlocks = async (pid) =>
  page.evaluate(async (id) => {
    const { db } = await import('/src/core/db.ts');
    return (await db.blocks.where('pageId').equals(id).toArray())
      .filter((b) => !b.deleted)
      .sort((a, b) => String(a.order).localeCompare(String(b.order)))
      .map((b) => `${b.type}:${b.text}`);
  }, pid);

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

let blocks = await dumpBlocks(pageId);
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
blocks = await dumpBlocks(pageId);
check('empty list-item Enter → paragraph', blocks[5] === 'p:');

// Backspace on empty block deletes it + focuses previous
await page.keyboard.press('Backspace');
await sleep(400);
blocks = await dumpBlocks(pageId);
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
blocks = await dumpBlocks(pageId);
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
await sleep(300);

// ---------- B2: mentions ----------
// On the current (empty) block, type @ to open the picker.
await page.locator('[data-block]').last().click();
await page.keyboard.type('@', { delay: 40 });
await sleep(400);
check('mention picker opens', (await page.locator('[data-mention-menu]').count()) === 1);
await page.keyboard.type('Target page', { delay: 20 });
await sleep(350);
await page.screenshot({ path: `${OUT}/mention-picker.png` });
// Last option = create the page.
await page.locator('[data-mention-menu] button').last().click();
await sleep(800);
blocks = await dumpBlocks(pageId);
const lastText = blocks[blocks.length - 1] ?? '';
const mentionId = (lastText.match(/@\[page:([^\]]+)\]/) ?? [])[1];
check('mention token stored', !!mentionId);
check('chip label shows created title', (await page.locator('.mention').first().innerText().catch(() => '')).includes('Target page'));

// Backspace deletes the whole chip (space first, then chip).
await page.keyboard.press('End');
await page.keyboard.press('Backspace');
await sleep(250);
await page.keyboard.press('Backspace');
await sleep(450);
blocks = await dumpBlocks(pageId);
check('backspace deletes chip token', !(blocks[blocks.length - 1] ?? '').includes('@[page:'));

// Re-insert the same mention via the picker (existing page hit).
await page.keyboard.type('@', { delay: 40 });
await sleep(350);
await page.keyboard.type('Target', { delay: 20 });
await sleep(350);
await page.locator('[data-mention-menu] button').first().click();
await sleep(600);
blocks = await dumpBlocks(pageId);
check('mention re-inserted', (blocks[blocks.length - 1] ?? '').includes(`@[page:${mentionId}]`));

// Click the chip → navigates to the target page.
await page.locator('.mention').first().click();
await sleep(800);
check('chip click navigates to page', page.url().includes(`/pages/${mentionId}`));

// Backlink section on the target lists the source page.
check('backlink listed on target', (await page.locator('[data-testid="backlinks"] a').count()) > 0);
await page.screenshot({ path: `${OUT}/backlinks.png` });

// Rename the target → the chip label on the source page follows.
await page.locator('textarea[placeholder="Untitled"]').fill('Renamed target');
await page.locator('textarea[placeholder="Untitled"]').blur();
await sleep(700);
await page.goBack({ waitUntil: 'networkidle' });
await sleep(800);
check('chip label follows rename', (await page.locator('.mention').first().innerText().catch(() => '')).includes('Renamed target'));

// Placeholder rule: with >1 blocks, at most one visible 'Type /' hint.
const hints = await page.locator('text=Type \'/\' for commands').count();
check('at most one visible slash placeholder', hints <= 1);

// persistence across reload
await page.reload({ waitUntil: 'networkidle' });
await sleep(800);
blocks = await dumpBlocks(pageId);
check('blocks persist after reload', blocks[0] === 'h1:Heading' && blocks.filter((b) => b.startsWith('h1:')).length === 1);
check('mention persists after reload', (blocks[blocks.length - 1] ?? '').includes(`@[page:${mentionId}]`));

// page-footer comment thread: real author name
await page.locator('input[placeholder="Add a comment…"]').fill('looks good');
await page.getByRole('button', { name: 'Post', exact: true }).click();
await sleep(600);
const authorOk = await page.locator('span:has-text("Admin")').count();
check('comment shows real author', authorOk > 0);

// click empty area below blocks → focuses last block
await page.locator('main .min-h-40').click({ position: { x: 200, y: 250 } }).catch(() => {});
await sleep(300);
const focused = await page.evaluate(() => document.activeElement?.hasAttribute('data-block') ?? false);
check('click below blocks focuses last block', focused);

await page.screenshot({ path: `${OUT}/04-page-blocks.png` });

// mobile view of the same page + mention picker on mobile emulation
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
await sleep(1200);
check('mobile renders mention chip', (await mpage.locator('.mention').count()) > 0);
await mpage.screenshot({ path: `${OUT}/04b-page-blocks-mobile.png` });
await mctx.close();
await browser.close();
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures ? 1 : 0);
