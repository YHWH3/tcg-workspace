// Phase B verification: presence+instant sync, moodboards, comments, public links.
// Run against the BUILT app (wrangler dev :8788) so the DO + SW are live.
// Usage: node scripts/verify-v4.mjs [base]
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';

const BASE = process.argv[2] ?? 'http://localhost:8788';
const OUT = '/tmp/notion-shots/v4';
const FIXTURES = '/tmp/ws-fixtures';
await mkdir(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond) => {
  console.log(cond ? `  PASS ${name}` : `  FAIL ${name}`);
  if (!cond) failures++;
};

// ---------- REST helpers ----------
const api = async (path, { method = 'GET', token, body, raw } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const t = await res.text();
  try {
    return { status: res.status, data: JSON.parse(t) };
  } catch {
    return { status: res.status, data: t };
  }
};
const login = async (username) => (await api('/api/auth/login', { method: 'POST', body: { username, password: 'password123' } })).data;
const push = (token, changes) => api('/api/sync/push', { method: 'POST', token, body: { changes: changes.map((c) => ({ ts: Date.now(), ...c })) } });
const uploadFile = async (token, id, path, mime) => {
  const buf = await readFile(path);
  const r1 = await fetch(`${BASE}/api/files/${id}/chunks/0`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: buf });
  const r2 = await api(`/api/files/${id}/complete`, { method: 'POST', token, body: { mime, size: buf.length, chunks: 1 } });
  return r1.status === 200 && r2.status === 200;
};

const admin = await login('admin');
const bob = await login('bob');
if (!admin.token || !bob.token) {
  console.log('FATAL: logins failed — run smoke.sh first');
  process.exit(1);
}

const browser = await chromium.launch();
const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true });
const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const pageA = await ctxA.newPage();
const pageB = await ctxB.newPage();
for (const [pg, u] of [
  [pageA, admin],
  [pageB, bob],
]) {
  await pg.addInitScript(([t, user]) => {
    localStorage.setItem('ws_token', t);
    localStorage.setItem('ws_user', JSON.stringify(user));
    localStorage.setItem('ws_uid', user.id);
  }, [u.token, u.user]);
  pg.on('pageerror', (e) => console.log('[pageerror]', e.message));
}
let sawChanged = false;
pageB.on('console', (m) => {
  if (m.text().includes('[live] changed')) sawChanged = true;
});

// ---------- 1. presence + instant sync ----------
console.log('== presence + instant sync');
// Fresh page A + B both open
const pageId = `pv4_${Date.now()}`;
await push(admin.token, [{ id: pageId, collection: 'pages', patch: { title: 'Presence test', icon: '👀', order: 'z9' } }]);
await pageA.goto(`${BASE}/pages/${pageId}`, { waitUntil: 'domcontentloaded' });
await sleep(2500);
await pageB.goto(`${BASE}/pages/${pageId}`, { waitUntil: 'domcontentloaded' });
const t0 = Date.now();
await pageA.waitForSelector('span[title*="is here"]', { timeout: 8000 }).catch(() => {});
check("B's presence avatar on A's page <8s", (await pageA.locator('span[title*="is here"]').count()) > 0);
console.log(`  avatar latency ~${Date.now() - t0}ms`);
await pageA.screenshot({ path: `${OUT}/presence-avatars.png` });
await pageB.screenshot({ path: `${OUT}/presence-avatars-b.png` });

// B creates the first block (so both have an editor row), then A edits it.
await pageB.locator('[data-placeholder-block]').click().catch(() => {});
await sleep(500);
await pageB.keyboard.type('from-bob', { delay: 15 });
await pageB.locator('body').click({ position: { x: 20, y: 20 } });
await sleep(1500);
const changedBefore = sawChanged;
await pageA.locator('[data-block]').first().click();
await sleep(300);
await pageA.keyboard.press('End');
await pageA.keyboard.type(' +edit', { delay: 20 });
await pageA.locator('body').click({ position: { x: 20, y: 20 } });
const t1 = Date.now();
let seen = false;
for (let i = 0; i < 20; i++) {
  await sleep(500);
  const txt = await pageB.locator('[data-block]').first().innerText().catch(() => '');
  if (txt.includes('+edit')) {
    seen = true;
    break;
  }
}
check(`B sees A's edit via instant sync (~${Date.now() - t1}ms)`, seen);
check("the 'changed' poke reached B's client", sawChanged && changedBefore !== undefined);

// ---------- 2. moodboard ----------
console.log('== moodboard');
await pageA.goto(`${BASE}/moodboards`, { waitUntil: 'domcontentloaded' });
await pageA.getByRole('button', { name: 'New board' }).last().click();
await pageA.waitForURL(/\/moodboards\//);
const mbId = pageA.url().split('/moodboards/')[1];
await sleep(600);

// add note via Add item menu
await pageA.locator('button[title="Add item"]').click();
await pageA.locator('button:has-text("Sticky note")').first().click();
await sleep(500);
await pageA.keyboard.type('weave textures', { delay: 15 });
await pageA.locator('body').click({ position: { x: 30, y: 30 } });
await sleep(400);
check('note item added', (await pageA.locator('[data-mooditem]').count()) === 1);

// add color swatch via Add item menu
await pageA.locator('button[title="Add item"]').click();
await sleep(300);
await pageA.locator('input[type="color"]').evaluate((el) => {
  el.value = '#12a594';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await pageA.getByRole('button', { name: 'Add', exact: true }).click();
await sleep(400);
check('color item added', (await pageA.locator('[data-mooditem]').count()) === 2);

// add image via Add item menu file input (inside the open popover)
await pageA.locator('button[title="Add item"]').click();
await pageA.locator('input[type="file"][accept="image/*"]').setInputFiles(`${FIXTURES}/photo.png`);
await sleep(1200);
check('image item added', (await pageA.locator('[data-mooditem]').count()) === 3);
// ctxA advertises a coarse pointer (hasTouch) → the canvas opens in browse
// mode; a real touch user taps Edit for drag/resize gestures.
await pageA.locator('button[title*="click to edit"]').click();
await sleep(200);
await pageA.screenshot({ path: `${OUT}/moodboard-desktop.png`, fullPage: false });

// drag the image: pointer on item → move → drop; position commits on drop.
const img = pageA.locator('[data-mooditem]:has(img)').first();
const box0 = await img.boundingBox();
await pageA.mouse.move(box0.x + box0.width / 2, box0.y + box0.height / 2);
await pageA.mouse.down();
await pageA.mouse.move(box0.x + box0.width / 2 + 160, box0.y + box0.height / 2 + 120, { steps: 8 });
await pageA.mouse.up();
await sleep(500);
const box1 = await img.boundingBox();
check('drag moves item', Math.abs(box1.x - box0.x) > 100 && Math.abs(box1.y - box0.y) > 80);

// select + resize via corner handle
await img.click();
await sleep(300);
const handle = pageA.locator('[data-testid="resize-handle"]');
await handle.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
const hb = await handle.boundingBox();
if (hb) {
  await pageA.mouse.move(hb.x + 3, hb.y + 3);
  await pageA.mouse.down();
  await pageA.mouse.move(hb.x + 60, hb.y + 40, { steps: 5 });
  await pageA.mouse.up();
  await sleep(400);
}
const box2 = await img.boundingBox();
check('resize grows item', box2.width > box1.width + 30);

// pan the canvas by dragging empty space — back in browse mode (edit-mode
// background drags are marquee-select instead)
await pageA.locator('button[title*="click to browse"]').click();
await sleep(200);
const world0 = await pageA.locator('[data-mooditem]').first().boundingBox();
await pageA.mouse.move(1300, 800);
await pageA.mouse.down();
await pageA.mouse.move(1000, 500, { steps: 6 });
await pageA.mouse.up();
await sleep(300);
const world1 = await pageA.locator('[data-mooditem]').first().boundingBox();
check('pan moves canvas', Math.abs(world1.x - world0.x) > 100);

// zoom via ctrl+wheel
await pageA.mouse.move(720, 400);
await pageA.keyboard.down('Control');
await pageA.mouse.wheel(0, -400);
await pageA.keyboard.up('Control');
await sleep(300);
const world2 = await pageA.locator('[data-mooditem]').first().boundingBox();
check('ctrl+wheel zooms', Math.abs(world2.width - world1.width) > 4);

// two-finger pinch via CDP touch events — verify world scale changes
const cdp = await ctxA.newCDPSession(pageA);
const worldScale = () =>
  pageA.evaluate(() => {
    const el = [...document.querySelectorAll('[data-testid="mood-canvas"] > div')].find((d) => d.style.transform.includes('scale('));
    const m = /scale\(([\d.]+)\)/.exec(el?.style.transform ?? '');
    return m ? Number(m[1]) : 0;
  });
const z0 = await worldScale();
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 250, y: 850 }, { x: 350, y: 850 }] });
await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 180, y: 850 }, { x: 420, y: 850 }] });
await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 120, y: 850 }, { x: 480, y: 850 }] });
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(400);
const z1 = await worldScale();
check('two-finger pinch zooms', Math.abs(z1 - z0) > 0.05);

// reload → everything persists
await pageA.reload({ waitUntil: 'domcontentloaded' });
await pageA.locator('[data-mooditem]').first().waitFor({ timeout: 20_000 });
check('items persist after reload', (await pageA.locator('[data-mooditem]').count()) >= 3);

// extract palette on the image item
await img.click();
await sleep(400);
await pageA.locator('button[title="Extract palette"]').click();
await sleep(1200);
const swatches = await pageA.locator('[data-mooditem]').count();
check('extract palette adds 5 swatches', swatches >= 8);
await pageA.screenshot({ path: `${OUT}/moodboard-palette.png` });

// make task from the image item
await img.click();
await sleep(300);
await pageA.locator('button[title="Make task"]').click();
await sleep(400);
await pageA.locator('.w-56 button', { hasText: 'Tasks' }).first().click();
await sleep(900);
check('linked-task badge on item', (await pageA.locator('text=Task').count()) > 0);
// the task should carry the image as cover — verify via sync pull (poll: outbox flush is async; paginate past 500)
const pullAll = async () => {
  const out = [];
  let since = 0;
  for (;;) {
    const pull = await api(`/api/sync/pull?since=${since}`, { token: admin.token });
    out.push(...pull.data.records);
    if (!pull.data.hasMore) return out;
    since = pull.data.cursor;
  }
};
let made = null;
for (let i = 0; i < 24 && !made; i++) {
  await sleep(1000);
  made = (await pullAll()).filter((r) => r.collection === 'tasks').find((t) => t.data.coverFileId);
}
check('created task has coverFileId', !!made);

// ---------- 3. comments ----------
console.log('== comments');
await pageA.goto(`${BASE}/pages/${pageId}`, { waitUntil: 'domcontentloaded' });
await sleep(800);
// desktop: hover block → comment badge → popover thread
await pageA.locator('[data-block]').first().hover();
await sleep(400);
await pageA.locator('button[aria-label*="Comment"]').first().click();
await sleep(500);
await pageA.locator('.h-80 input[placeholder="Add a comment…"]').fill('thread on a block');
await pageA.locator('.h-80').getByRole('button', { name: 'Post', exact: true }).click();
await sleep(600);
check('block comment posted', (await pageA.locator('text=thread on a block').count()) > 0);
await pageA.screenshot({ path: `${OUT}/comment-block-popover.png` });
await pageA.keyboard.press('Escape');
await pageA.locator('body').click({ position: { x: 30, y: 30 } });
await sleep(400);
check('comment count badge on block', (await pageA.locator('button[aria-label="Comments (1)"]').count()) >= 1);

// mobile: block … menu → Comments → bottom sheet
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const mpage = await mctx.newPage();
await mpage.addInitScript(([t, u]) => {
  localStorage.setItem('ws_token', t);
  localStorage.setItem('ws_user', JSON.stringify(u));
  localStorage.setItem('ws_uid', u.id);
}, [admin.token, admin.user]);
await mpage.goto(`${BASE}/pages/${pageId}`, { waitUntil: 'domcontentloaded' });
await sleep(1000);
await mpage.locator('button[aria-label="Block options"]').first().click();
await sleep(400);
await mpage.locator('[role="dialog"]').getByRole('button', { name: 'Comments' }).click();
await sleep(600);
await mpage.locator('input[placeholder="Add a comment…"]').last().fill('mobile reply');
await mpage.getByRole('button', { name: 'Post', exact: true }).last().click();
await sleep(700);
check('mobile sheet comment posted', (await mpage.locator('text=mobile reply').count()) > 0);
await mpage.screenshot({ path: `${OUT}/comment-block-mobile-sheet.png` });

// ---------- 4. public share ----------
console.log('== public share');
// Build a shared page tree via push: root + sub-page + blocks (image/pdf/tasks/mentions)
const root = `pub_root_${Date.now()}`;
const sub = `pub_sub_${Date.now()}`;
const imgId = `pubimg_${Date.now()}`;
const pdfId = `pubpdf_${Date.now()}`;
const stray = `pubstray_${Date.now()}`;
check('upload public fixtures', (await uploadFile(admin.token, imgId, `${FIXTURES}/photo.png`, 'image/png')) && (await uploadFile(admin.token, pdfId, `${FIXTURES}/doc.pdf`, 'application/pdf')) && (await uploadFile(admin.token, stray, `${FIXTURES}/photo.png`, 'image/png')));
await push(admin.token, [
  { id: root, collection: 'pages', patch: { title: 'Shared root', icon: '🌐', order: 'zA' } },
  { id: sub, collection: 'pages', patch: { title: 'Shared child', icon: '📄', parentId: root, order: 'zB' } },
  { id: 'pbb1', collection: 'blocks', patch: { pageId: root, type: 'h1', text: 'Public page', order: 'a0' } },
  { id: 'pbb2', collection: 'blocks', patch: { pageId: root, type: 'image', fileId: imgId, caption: 'Field photo', order: 'a1' } },
  { id: 'pbb3', collection: 'blocks', patch: { pageId: root, type: 'file', fileId: pdfId, caption: 'Spec.pdf', order: 'a2' } },
  { id: 'pbb4', collection: 'blocks', patch: { pageId: root, type: 'tasks', boardId: 'board-default', order: 'a3' } },
  { id: 'pbb5', collection: 'blocks', patch: { pageId: root, type: 'p', text: 'Mention @[user:' + admin.user.id + '] and @[page:' + sub + ']', order: 'a4' } },
  { id: 'pbc1', collection: 'blocks', patch: { pageId: sub, type: 'p', text: 'child content', order: 'a0' } },
  { id: 'ptask', collection: 'tasks', patch: { title: 'Shown task', boardId: 'board-default', status: 'todo', coverFileId: imgId, order: 'a0' } },
]);
// create a share through the UI (popover screenshot) — via a page we open
const shareUiId = `shareui_${Date.now()}`;
await push(admin.token, [{ id: shareUiId, collection: 'pages', patch: { title: 'Share UI', order: 'zC' } }]);
await pageA.goto(`${BASE}/pages/${shareUiId}`, { waitUntil: 'domcontentloaded' });
await sleep(800);
await pageA.locator('button[aria-label="Share"]').click();
await sleep(500);
await pageA.screenshot({ path: `${OUT}/share-popover.png` });
await pageA.locator('button[role="switch"]').click();
await sleep(800);
const linkText = await pageA.locator('input[readonly]').inputValue().catch(() => '');
check('share link generated', linkText.includes('/s/'));
await pageA.keyboard.press('Escape');

const { data: shareData } = await api('/api/shares', { method: 'POST', token: admin.token, body: { pageId: root } });
const shareToken = shareData.token;
check('share token via API', !!shareToken);

// fresh unauthenticated context
const pctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const ppage = await pctx.newPage();
await ppage.goto(`${BASE}/s/${shareToken}`, { waitUntil: 'domcontentloaded' });
await sleep(1500);
check('public page renders heading', (await ppage.locator('text=Public page').count()) > 0);
check('public page renders image', (await ppage.locator(`img[src*="${imgId}"]`).count()) > 0);
check('public page renders pdf frame', (await ppage.locator('iframe').count()) > 0);
check('public page renders tasks block', (await ppage.locator('text=Shown task').count()) > 0);
check('public mention resolves to name', (await ppage.locator('text=Admin').count()) > 0);
check('public page has footer', (await ppage.locator('text=Shared from Workspace').count()) > 0);
check('public noindex set', (await ppage.locator('meta[name="robots"][content="noindex"]').count()) > 0);
await ppage.screenshot({ path: `${OUT}/public-page-desktop.png` });
// sub-page navigation
await ppage.locator(`a[href="/s/${shareToken}/${sub}"]`).click().catch(async () => {
  await ppage.goto(`${BASE}/s/${shareToken}/${sub}`, { waitUntil: 'domcontentloaded' });
});
await sleep(800);
check('public sub-page renders', (await ppage.locator('text=child content').count()) > 0);

// mobile public render
const mpctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const mpp = await mpctx.newPage();
await mpp.goto(`${BASE}/s/${shareToken}`, { waitUntil: 'domcontentloaded' });
await sleep(1200);
check('public page renders on mobile', (await mpp.locator('text=Public page').count()) > 0);
await mpp.screenshot({ path: `${OUT}/public-page-mobile.png` });

// access control
check('unreferenced file denied publicly', (await api(`/api/public/${shareToken}/files/${stray}`, { raw: true })).status === 404);
check('non-descendant page denied publicly', (await api(`/api/public/${shareToken}/pages/${pageId}`, { raw: true })).status === 404);

// revoke → inactive message
await api(`/api/shares/${root}`, { method: 'DELETE', token: admin.token });
await ppage.reload({ waitUntil: 'domcontentloaded' });
// Assert the requested server-confirmed inactive surface, not an unrelated
// global network-idle condition (PWA/background requests may remain active).
await ppage.getByText('no longer active',{exact:false}).first().waitFor({timeout:15000});
check('revoked link shows inactive message', (await ppage.locator('text=no longer active').count()) > 0);
await ppage.screenshot({ path: `${OUT}/public-inactive.png` });

// ---------- 5. fixed board header screenshots ----------
console.log('== screenshots');
await pageA.goto(`${BASE}/boards/board-default`, { waitUntil: 'domcontentloaded' });
await sleep(1000);
await pageA.screenshot({ path: `${OUT}/board-header-desktop.png` });
await mpage.goto(`${BASE}/boards/board-default`, { waitUntil: 'domcontentloaded' });
await sleep(1000);
await mpage.screenshot({ path: `${OUT}/board-header-mobile.png` });
await mpage.goto(`${BASE}/moodboards/${mbId}`, { waitUntil: 'domcontentloaded' });
await sleep(1200);
await mpage.screenshot({ path: `${OUT}/moodboard-mobile.png` });

await browser.close();
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures ? 1 : 0);
