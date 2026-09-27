// v3 verification: boards/media/capture. Runs against `wrangler dev` :8788
// (production build + service worker + shared local D1).
// Requires: admin/password123 + bob/password123 users (created by smoke.sh).
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = 'http://localhost:8788';
const OUT = '/tmp/notion-shots/v3';
const FIX = '/tmp/ws-fixtures';
await mkdir(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, detail) => {
  console.log(cond ? `  PASS ${name}` : `  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};
const mark = (s) => console.log(`  … ${s}`);

/* ---------- helpers ---------- */

async function login(page, user) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.getByPlaceholder('ada').fill(user);
  await page.locator('input[type=password]').first().fill('password123');
  await page.locator('form').getByRole('button', { name: /sign in/i }).click();
  // Shell: desktop sidebar or mobile top bar.
  await page.waitForSelector('text=Synced', { timeout: 30000 }).catch(() =>
    page.waitForSelector('[aria-label="Menu"]', { timeout: 15000 }),
  );
  await sleep(1200); // let the first pull + board seeds settle
}

const idb = (page, store, key) =>
  page.evaluate(
    ([s, k]) =>
      new Promise((res, rej) => {
        const r = indexedDB.open('workspace');
        r.onerror = () => rej(r.error);
        r.onsuccess = () => {
          const d = r.result;
          const q = d.transaction(s).objectStore(s).get(k);
          q.onsuccess = () => res(q.result ?? null);
          q.onerror = () => rej(q.error);
        };
      }),
    [store, key],
  );

const idbAll = (page, store) =>
  page.evaluate(
    (s) =>
      new Promise((res, rej) => {
        const r = indexedDB.open('workspace');
        r.onerror = () => rej(r.error);
        r.onsuccess = () => {
          const d = r.result;
          const q = d.transaction(s).objectStore(s).getAll();
          q.onsuccess = () => res(q.result ?? []);
          q.onerror = () => rej(q.error);
        };
      }),
    store,
  );

async function poll(fn, { timeout = 30000, interval = 700 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) return null;
    await sleep(interval);
  }
}

async function taskIdByTitle(page, title) {
  const card = page.locator(`[data-task-card]:has-text("${title}")`).first();
  if (await card.count()) return card.getAttribute('data-task-card');
  const row = (await idbAll(page, 'tasks')).find((t) => t.title === title && !t.deleted);
  return row?.id ?? null;
}

async function mouseDrag(page, from, to) {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + 12);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(a.x + ((b.x + b.width / 2 - a.x) * i) / 8, a.y + ((b.y + 20 - a.y) * i) / 8);
    await sleep(40);
  }
  await sleep(150);
  await page.mouse.up();
}

async function touchDrag(ctx, page, from, to) {
  await from.scrollIntoViewIfNeeded();
  // Scroll-snap makes the strip jump a whole column at a time, which bounces a
  // simulated drop between columns; disable it for the duration of the drag.
  await page.evaluate(() => {
    const strip = document.querySelector('.snap-x');
    if (strip) strip.style.scrollSnapType = 'none';
  });
  const a = await from.boundingBox();
  const cdp = await ctx.newCDPSession(page);
  const sx = a.x + a.width / 2;
  const sy = a.y + 10;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const vp = page.viewportSize() ?? { width: 390, height: 844 };
  const move = (x, y) => cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy, id: 1 }] });
  await sleep(350); // > 200ms long-press threshold
  // Past the sensor's tolerance so the drag activates.
  await move(sx + 16, sy);
  await sleep(120);
  // Drop at a point inside the target that is also ≥85px from both screen
  // edges — outside dnd-kit's ~20% auto-scroll band — so the strip stops
  // scrolling and the release can't overshoot into the next column. While no
  // such point exists (target fully off-screen), dwell at the edge to
  // auto-scroll it into view.
  const SAFE = 85;
  for (let i = 0; i < 30; i++) {
    const b = await to.boundingBox().catch(() => null);
    if (!b) break;
    const cy = clamp(b.y + Math.min(60, b.height / 3), 8, vp.height - 8);
    const px = Math.max(b.x + 16, SAFE);
    if (px <= Math.min(b.x + b.width - 8, vp.width - SAFE)) {
      await move(px, cy);
      await sleep(220); // settle, then confirm the pointer is still inside
      const b2 = await to.boundingBox().catch(() => null);
      if (b2 && b2.x <= px && px <= b2.x + b2.width) break;
    } else {
      const dir = b.x + b.width / 2 > vp.width / 2 ? 1 : -1;
      await move(dir > 0 ? vp.width - 8 : 8, cy);
      await sleep(160);
    }
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/* ---------- run ---------- */

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${FIX}/voice.wav`,
  ],
});

// ===== PART A: mobile offline capture → online sync → second user sees it =====
console.log('== Part A: offline capture + cross-user sync');
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const mp = await mctx.newPage();
mp.on('pageerror', (e) => console.log('[mobile pageerror]', e.message));
await login(mp, 'bob');
mark('bob logged in');
const swControlled = await poll(async () => (await mp.evaluate(() => !!navigator.serviceWorker?.controller)) || (await mp.reload().then(() => false)), { timeout: 15000, interval: 1500 });
mark(`sw controlled: ${!!swControlled}`);
await sleep(500);

await mp.goto(`${BASE}/capture`);
await mp.waitForSelector('text=Quick capture', { timeout: 15000 });
mark('capture sheet open');
// photo via the "Take photo" input (capture attr → camera on real devices)
await mp.locator('input[capture="environment"]').setInputFiles(`${FIX}/photo.png`);
await sleep(400);
mark('photo attached');
// voice memo via fake mic
await mp.getByRole('button', { name: /record voice memo/i }).click();
await mp.waitForSelector('[aria-label="Stop recording"]', { timeout: 10000 });
await sleep(2500); // capture a couple of seconds of the wav
await mp.getByRole('button', { name: 'Stop recording' }).click();
await mp.waitForSelector('text=/Voice memo ·/', { timeout: 10000 });
mark('voice memo captured');
await mp.locator('textarea[placeholder*="caption" i]').fill('Field photo from Ramesh\nsamples for the listing');
await mp.screenshot({ path: `${OUT}/10-capture-sheet-mobile.png` });

// Go fully offline, then save.
await mctx.setOffline(true);
const taskIdsBefore = new Set((await idbAll(mp, 'tasks')).map((t) => t.id));
await mp.getByRole('button', { name: /save to/i }).click();
await mp.waitForSelector('text=Saved offline', { timeout: 10000 });
mark('saved offline');
check('offline save shows "Saved offline"', true);
await mp.waitForURL(/boards\//, { timeout: 10000 });
await sleep(1200);
// card with big cover appears in Inbox
const inboxCard = mp.locator('[data-task-card]:has-text("Field photo from Ramesh")');
check('capture card visible in Inbox (offline)', (await inboxCard.count()) > 0);
const coverImg = inboxCard.locator('img').first();
check('cover image rendered offline', (await coverImg.count()) > 0 && (await coverImg.evaluate((el) => el.naturalWidth > 0)));

// offline reload → still there (SW serves shell, Dexie serves data)
await mp.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
await sleep(2500);
mark('reloaded offline');
check('card survives offline reload', (await mp.locator('[data-task-card]:has-text("Field photo")').count()) > 0);

// back online → blob uploads + transcription
await mctx.setOffline(false);
// Find the NEW task by id-set diff (prior runs leave same-titled tasks in sync).
const newTasks = (await idbAll(mp, 'tasks')).filter((t) => !taskIdsBefore.has(t.id) && !t.deleted);
const capTaskId = newTasks[0]?.id ?? (await taskIdByTitle(mp, 'Field photo from Ramesh'));
check('capture task exists in Dexie', !!capTaskId);
const blobUploaded = await poll(async () => {
  const blobs = await idbAll(mp, 'blobs');
  return blobs.length > 0 && blobs.every((b) => b.state === 'uploaded' || b.state === 'cached');
});
check('all blobs uploaded after reconnect', !!blobUploaded);
const transcriptDone = await poll(async () => {
  const files = await idbAll(mp, 'files');
  const audio = files.find((f) => f.kind === 'audio' && f.parentId === capTaskId);
  return audio?.transcriptState === 'done' ? audio : null;
}, { timeout: 200000 });
check('voice memo transcribed', !!transcriptDone && /weav|ramesh|film/i.test(transcriptDone?.transcript ?? ''));
if (transcriptDone) console.log('   transcript:', JSON.stringify(transcriptDone.transcript));
else console.log('   memo state:', JSON.stringify((await idbAll(mp, 'files')).filter((f) => f.kind === 'audio').map((f) => ({ p: String(f.parentId).slice(0, 6), ts: f.transcriptState }))));

// Second user (desktop) sees the card + image + transcript.
const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const dp = await dctx.newPage();
dp.on('pageerror', (e) => console.log('[desktop pageerror]', e.message));
await login(dp, 'admin');
await dp.goto(`${BASE}/boards/board-inbox`);
await sleep(1500);
const dCard = dp.locator(`[data-task-card="${capTaskId}"]`);
check('second user sees capture card', (await dCard.count()) > 0);
const dCoverOk = await poll(async () => {
  const img = dCard.locator('img').first();
  return (await img.count()) > 0 && (await img.evaluate((el) => el.naturalWidth > 0));
});
check('second user sees cover image', !!dCoverOk);
await dCard.first().click();
await sleep(1200);
// expand the transcript disclosure on the audio memo, then wait for it
const tgl = dp.getByRole('button', { name: /transcript/i }).first();
if (await tgl.count()) await tgl.click();
const sawTranscript = await poll(async () => (await dp.locator('text=/leaving close|weaving close|Ramesh/i').count()) > 0, { timeout: 60000 });
check('task detail shows audio + transcript', !!sawTranscript);
await dp.screenshot({ path: `${OUT}/11-task-detail-media.png` });
await dp.keyboard.press('Escape');

// ===== PART B: drag and drop =====
console.log('== Part B: drag and drop');
await dp.goto(`${BASE}/boards/board-default`);
await sleep(800);

// create three tasks via the quick-add inputs (names unique per run — prior
// runs' tasks persist in the shared local D1)
const RUN = `t${Date.now().toString(36).slice(-6)}`;
const [A, B2, G] = [`Alpha ${RUN}`, `Beta ${RUN}`, `Gamma ${RUN}`];
async function quickAdd(page, colName, title) {
  const col = page.locator('section', { has: page.locator('span', { hasText: colName }) }).first();
  const input = col.locator('input[placeholder*="title" i]');
  if (!(await input.isVisible().catch(() => false))) {
    await col.getByRole('button', { name: /add task/i }).click();
    await sleep(200);
  }
  await col.locator('input[placeholder*="title" i]').fill(title);
  await page.keyboard.press('Enter');
  await sleep(300);
  // Enter keeps the quick-add input open for continuous adds; close it so the
  // next call sees the button again.
  await page.keyboard.press('Escape');
  await sleep(200);
}
await quickAdd(dp, 'To do', A);
await quickAdd(dp, 'To do', B2);
await quickAdd(dp, 'In progress', G);
await sleep(600);

const alphaCard = dp.locator(`[data-task-card]:has-text("${A}")`);
const progCol = dp.locator('section', { hasText: 'In progress' }).first();
await mouseDrag(dp, alphaCard, progCol);
await sleep(800);
const alphaId = await taskIdByTitle(dp, A);
const alphaRow = await idb(dp, 'tasks', alphaId);
check('mouse drag → task moved to in_progress', alphaRow?.status === 'in_progress');

// reorder within column: drag Beta above the remaining card in To do
const betaCard = dp.locator(`[data-task-card]:has-text("${B2}")`);
const todoCol = dp.locator('section', { hasText: 'To do' }).first();
await mouseDrag(dp, betaCard, dp.locator(`[data-task-card]:has-text("${G}")`));
await sleep(800);
const betaRow = await idb(dp, 'tasks', await taskIdByTitle(dp, B2));
check('mouse drag Beta → Gamma column', betaRow?.status === 'in_progress');
// drop back on the column droppable
await mouseDrag(dp, dp.locator(`[data-task-card]:has-text("${B2}")`), todoCol.locator('div').last());
await sleep(800);
const betaRow2 = await idb(dp, 'tasks', await taskIdByTitle(dp, B2));
check('mouse drag back to todo', betaRow2?.status === 'todo', `got ${betaRow2?.status}`);

// ===== PART C: board CRUD =====
console.log('== Part C: board CRUD + column mgmt');
await dp.goto(`${BASE}/boards`);
await sleep(600);
await dp.screenshot({ path: `${OUT}/01-boards-grid.png` });
await dp.getByRole('button', { name: /new board/i }).last().click();
await dp.locator('input[placeholder*="board name" i]').fill('Course modules');
await dp.keyboard.press('Enter');
await dp.waitForURL(/boards\//, { timeout: 10000 });
await sleep(800);
const boardId = new URL(dp.url()).pathname.split('/')[2];
check('board created', !!boardId && boardId !== 'board-default');
const bRow = await idb(dp, 'boards', boardId);
check('board row in Dexie', bRow?.name === 'Course modules');

// rename first column → Idea (column header menu → Rename)
const firstCol = dp.locator('section').first();
await firstCol.getByRole('button', { name: 'Column menu' }).click();
await dp.getByRole('button', { name: 'Rename', exact: true }).click();
await dp.locator('section input').first().fill('Idea');
await dp.locator('section input').first().press('Enter');
await sleep(600);
let cols = (await idb(dp, 'boards', boardId))?.columns ?? [];
check('column renamed to Idea', cols[0]?.name === 'Idea');

// recolor first column via palette
await firstCol.getByRole('button', { name: 'Column menu' }).click();
await dp.locator('[aria-label="Color #e5484d"]').click();
await sleep(600);
cols = (await idb(dp, 'boards', boardId))?.columns ?? [];
check('column recolored', cols[0]?.color === '#e5484d');

// rename remaining columns to Filming / Live via API-free UI
const colNames = ['Filming', 'Live'];
for (let i = 1; i <= 2; i++) {
  const col = dp.locator('section').nth(i);
  await col.getByRole('button', { name: 'Column menu' }).click();
  await dp.getByRole('button', { name: 'Rename', exact: true }).click();
  const input = col.locator('input').first();
  await input.fill(colNames[i - 1]);
  await input.press('Enter');
  await sleep(500);
}
cols = (await idb(dp, 'boards', boardId))?.columns ?? [];
check('columns renamed Idea/Filming/Live', cols.map((c) => c.name).join(',') === 'Idea,Filming,Live');

// move the inbox capture task into Course modules via task detail Board select
await dp.goto(`${BASE}/boards/board-inbox`);
await sleep(800);
await dp.locator(`[data-task-card="${capTaskId}"]`).first().click();
await sleep(1000);
const boardSelect = dp.locator('aside select').first();
await boardSelect.selectOption({ value: boardId });
await sleep(800);
const movedRow = await idb(dp, 'tasks', capTaskId);
check('task moved to new board first column', movedRow?.boardId === boardId && movedRow?.status === cols[0]?.id);
await dp.keyboard.press('Escape');
await dp.goto(`${BASE}/boards/${boardId}`);
await sleep(1000);
check('moved task renders on Course modules board', (await dp.locator(`[data-task-card="${capTaskId}"]`).count()) > 0);
await dp.screenshot({ path: `${OUT}/02-board-media-cards-desktop.png` });

// mobile board view screenshot
await mp.goto(`${BASE}/boards/${boardId}`);
await sleep(1200);
await mp.screenshot({ path: `${OUT}/03-board-media-cards-mobile.png` });

// touch drag on mobile: move capture task Idea → Filming
const mCard = mp.locator(`[data-task-card="${capTaskId}"]`);
const mTarget = mp.locator('section', { hasText: 'Filming' }).first();
await touchDrag(mctx, mp, mCard, mTarget);
await sleep(900);
const touchRow = await idb(mp, 'tasks', capTaskId);
check('touch drag moves task to Filming', touchRow?.status === cols[1]?.id, `got ${touchRow?.status} want ${cols[1]?.id}`);

// ===== PART D: mixed-media page =====
console.log('== Part D: mixed-media page');
await dp.goto(BASE);
await sleep(800);
await dp.getByRole('button', { name: /new page/i }).first().click();
await dp.waitForURL(/pages\//, { timeout: 10000 });
await dp.locator('textarea[placeholder*="title" i], input[placeholder*="title" i]').first().fill('Launch media board');
const firstBlock = dp.locator('[data-block]').first();
if (await firstBlock.count()) await firstBlock.click();
else await dp.locator('[data-placeholder-block]').click();
await dp.keyboard.type('Notes for the shoot');
await dp.keyboard.press('Enter');
await sleep(500); // let the new block mount + take focus

// insert via slash menu: image (type filter text — menu only shows 8 items)
await dp.keyboard.type('/image');
await sleep(400);
await dp.getByRole('button', { name: 'Image' }).first().click();
await sleep(400);
await dp.locator('input[type=file][accept="image/*"]').last().setInputFiles(`${FIX}/photo.png`);
const imgOk = await poll(async () => (await dp.locator('figure img').count()) > 0, { timeout: 15000 });
check('image block rendered', !!imgOk);

// video + file blocks via slash menu
await dp.keyboard.press('Escape');
const clickBelow = async () => {
  const container = dp.locator('.min-h-40').last();
  const box = await container.boundingBox();
  await container.click({ position: { x: 100, y: box.height - 10 } });
};
await clickBelow();
await sleep(300);
await dp.keyboard.type('/video');
await sleep(400);
await dp.getByRole('button', { name: 'Video' }).first().click();
await sleep(400);
await dp.locator('input[type=file][accept="video/*"]').last().setInputFiles(`${FIX}/clip.mp4`);
const videoOk = await poll(async () => (await dp.locator('video').count()) > 0, { timeout: 15000 });
check('video block rendered', !!videoOk);

await clickBelow();
await sleep(300);
await dp.keyboard.type('/file');
await sleep(400);
await dp.getByRole('button', { name: 'File / PDF' }).first().click();
await sleep(400);
await dp.locator('input[type=file]').last().setInputFiles(`${FIX}/doc.pdf`);
const pdfOk = await poll(async () => (await dp.locator('iframe, :text("doc.pdf")').count()) > 0, { timeout: 15000 });
check('pdf block rendered', !!pdfOk);

// tasks block
await clickBelow();
await sleep(300);
await dp.keyboard.type('/task');
await sleep(400);
await dp.getByRole('button', { name: 'Task list' }).first().click();
await sleep(600);
const boardPick = dp.getByRole('button', { name: /Tasks$/ }).first();
if (await boardPick.count()) await boardPick.click();
await sleep(1000);
check('tasks block renders task list', (await dp.locator(`text=/No tasks yet|${A}|To do/`).count()) > 0);
await dp.screenshot({ path: `${OUT}/04-page-media-desktop.png`, fullPage: true });

// reload → everything persists
await dp.reload({ waitUntil: 'networkidle' });
await sleep(1500);
const persisted = await idbAll(dp, 'blocks');
const types = persisted.filter((b) => !b.deleted).map((b) => b.type);
check('media blocks persisted after reload', ['image', 'video', 'file', 'tasks'].every((t) => types.includes(t)));
check('page still renders image after reload', (await dp.locator('figure img').count()) > 0);

// offline check on the built app
await dctx.setOffline(true);
await dp.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
await sleep(2000);
check('page renders offline (SW)', (await dp.locator('figure img, video').count()) > 0);
await dp.screenshot({ path: `${OUT}/05-page-media-offline.png`, fullPage: true });
await dctx.setOffline(false);

// mobile rendering of the same mixed-media page
await mp.goto(dp.url());
await sleep(1800);
await mp.screenshot({ path: `${OUT}/04b-page-media-mobile.png`, fullPage: true });

// ===== PART E: storage bar + My tasks + extras =====
console.log('== Part E: settings / my tasks');
await dp.goto(`${BASE}/settings`);
await sleep(1500);
await dp.locator('text=Storage').first().scrollIntoViewIfNeeded();
check('storage bar visible', (await dp.locator('text=/of 450\\.0 MB|of 450 MB/').count()) > 0);
await dp.screenshot({ path: `${OUT}/06-settings-storage.png` });

await dp.goto(`${BASE}/tasks`);
await sleep(1000);
await dp.screenshot({ path: `${OUT}/07-my-tasks.png` });
check('my tasks page loads', (await dp.locator('text=/My tasks/i').count()) > 0);

// legacy /tasks/:id redirect
if (capTaskId) {
  await dp.goto(`${BASE}/tasks/${capTaskId}`);
  await sleep(1000);
  check('legacy /tasks/:id redirects to board route', /\/boards\//.test(dp.url()));
}

await browser.close();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
