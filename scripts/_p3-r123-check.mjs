// P3-R1/R2/R3 deterministic verification — partial install resume, reinstall
// dedupe, Alice→Bob context scoping, byte-durable capture draft.
// Server: wrangler dev --local :8788, fresh D1 with admin+bob; /tmp/p3-plan.json holds the plan.
import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE = 'http://localhost:8788';
const PASS = 'password123';
const plan = JSON.parse(fs.readFileSync('/tmp/p3-plan.json', 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const poll = async (fn, t = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if (await fn()) return true; await sleep(400); } return false; };
const login = async (u) => await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: PASS }) })).json();
const pullRaw = async (token) => await (await fetch(`${BASE}/api/sync/pull?since=0`, { headers: { authorization: `Bearer ${token}` } })).json();
const pull = async (t) => { const d = await pullRaw(t); return d.records ?? d.changes ?? []; };
const admin = await login('admin');
const bob = await login('bob');
const liveIds = (recs) => new Set(recs.filter((r) => !(r.data || {}).deleted).map((r) => r.id));

const browser = await chromium.launch();
// ONE shared browser PROFILE: admin logs out, bob logs in — proves account scoping (R3).
const shared = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await shared.newPage();


const uiLogin = async (cred) => {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(([t, u]) => {
    localStorage.clear();
    localStorage.setItem('ws_token', t); localStorage.setItem('ws_user', JSON.stringify(u)); localStorage.setItem('ws_uid', u.id);
  }, [cred.token, cred.user]);
};
const R = [];
const note = (name, ok, extra = '') => { R.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); console.log(R[R.length - 1]); };

/* ---------- R1a: resume after interruption at the page boundary ---------- */
// 65 rows of the plan were pushed pre-test (pages + links/blocks regions), no marker.
await uiLogin(admin);
await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
await page.locator('text=Template gallery').first().waitFor({ timeout: 20000 });
// gallery should NOT report Installed (marker absent)
const preInstalled = await page.locator('li:has-text("TCG Operating Pack"):has-text("Installed")').count();
note('R1: partial install is not reported as installed', preInstalled === 0);
const row = page.locator('li:has-text("TCG Operating Pack")').first();
await row.locator('button:has-text("Add to workspace")').first().dispatchEvent('click');
const installBtn = page.locator('[role="dialog"] button:has-text("Install")').first();
await poll(() => installBtn.isEnabled().catch(() => false), 30000);
await installBtn.dispatchEvent('click');
await poll(() => page.url().includes('/pages/'), 120000);
await sleep(2500);
// pull all: every planned id live exactly once, exactly one stamped page = root
let recs = await pull(admin.token);
let ids = liveIds(recs);
const missing = plan.writes.filter((w) => !ids.has(w.id));
const stamped = recs.filter((r) => r.collection === 'pages' && (r.data || {}).templateKey === 'tcg-pack' && !(r.data || {}).deleted);
note('R1: resume wrote every planned row (408)', missing.length === 0, `missing=${missing.length}`);
note('R1: exactly one stamped root page', stamped.length === 1 && stamped[0]?.id === plan.rootPageId, `stamped=${stamped.length}`);
// counts per collection
const cnt = {}; for (const r of recs) if (!(r.data || {}).deleted) cnt[r.collection] = (cnt[r.collection] || 0) + 1;
const want = { pages: 35, boards: 17, views: 52, links: 1 };
const countsOk = Object.entries(want).every(([c, n]) => (cnt[c] || 0) >= n);
note('R1: live counts match plan', countsOk, JSON.stringify({ pages: cnt.pages, boards: cnt.boards, views: cnt.views, links: cnt.links }));

/* ---------- R1d: Reinstall preserves user edits + tombstones ---------- */
// Server-side edits (as from another device) on installed rows, plus one
// tombstoned pack board. Reinstall must skip every present row — no bundled
// defaults may overwrite these values, and the tombstone must not resurrect.
// First wait for the install's outbox to fully drain — otherwise a still-
// pending install write legitimately wins LWW over our (earlier-ts) edit and
// the assertion measures flush ordering, not reinstall semantics.
const outboxDrained = await poll(async () => page.evaluate(async () => {
  const dbs = await indexedDB.databases();
  const name = dbs.map((d) => d.name).find((n) => n && n.startsWith('workspace-'));
  if (!name) return false;
  const idb = await new Promise((res, rej) => { const q = indexedDB.open(name); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const n = await new Promise((res, rej) => { const q = idb.transaction('outbox', 'readonly').objectStore('outbox').count(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  return n === 0;
}), 120000);
note('R1d: install outbox drained before edits', outboxDrained);
const ePage = plan.writes.find((w) => w.collection === 'pages' && w.id !== plan.rootPageId);
const eBlock = plan.writes.find((w) => w.collection === 'blocks');
const eView = plan.writes.find((w) => w.collection === 'views');
const delBoard = plan.writes.find((w) => w.collection === 'boards');
// +10min, not +5s: smoke's concurrency seeds write ts=NOW+100000, which drifts
// the browser hlc ~+100s — install mints then land after a barely-future edit
// ts and the edit would legitimately lose LWW (a test artifact, not a bug).
const ets = Date.now() + 600000;
await fetch(`${BASE}/api/sync/push`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` },
  body: JSON.stringify({ changes: [
    { collection: 'pages', id: ePage.id, patch: { title: 'USER EDIT TITLE' }, ts: ets },
    { collection: 'blocks', id: eBlock.id, patch: { text: 'USER EDIT BLOCK' }, ts: ets },
    { collection: 'views', id: eView.id, patch: { name: 'USER EDIT VIEW' }, ts: ets },
    { collection: 'boards', id: delBoard.id, patch: { deleted: true }, ts: ets },
  ] }),
}).then((r) => r.json());


await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
await page.locator('text=Template gallery').first().waitFor({ timeout: 20000 });
const reRow = page.locator('li:has-text("TCG Operating Pack")').first();
await reRow.locator('button:has-text("Reinstall")').first().dispatchEvent('click');
const reBtn = page.locator('[role="dialog"] button:has-text("Reinstall")').first();
await poll(() => reBtn.isEnabled().catch(() => false), 30000);
await reBtn.dispatchEvent('click');
await poll(() => page.url().includes('/pages/'), 120000);
await sleep(2500);
const recs2 = await pull(admin.token);
const planIds = new Set(plan.writes.map((w) => w.id));
const livePages = recs2.filter((r) => planIds.has(r.id) && r.collection === 'pages' && !(r.data || {}).deleted);
note('R1: reinstall dedupes — still 35 live pack pages', livePages.length === 35, `pages=${livePages.length}`);
const stamped2 = livePages.filter((r) => (r.data || {}).templateKey === 'tcg-pack');
note('R1: still exactly one stamped root', stamped2.length === 1 && stamped2[0].id === plan.rootPageId);
// R1d: edited values, tombstone and live counts after browser Reinstall
const byId = Object.fromEntries(recs2.map((r) => [`${r.collection}:${r.id}`, r]));
note('R1d: edited page title preserved', byId[`pages:${ePage.id}`]?.data?.title === 'USER EDIT TITLE', String(byId[`pages:${ePage.id}`]?.data?.title));
note('R1d: edited block text preserved', byId[`blocks:${eBlock.id}`]?.data?.text === 'USER EDIT BLOCK');
note('R1d: edited view config preserved', byId[`views:${eView.id}`]?.data?.name === 'USER EDIT VIEW');
note('R1d: tombstoned board not resurrected', byId[`boards:${delBoard.id}`]?.data?.deleted === true);
const cnt2 = {};
for (const r of recs2) if (planIds.has(r.id) && !(r.data || {}).deleted) cnt2[r.collection] = (cnt2[r.collection] || 0) + 1;
note('R1d: plan live counts complete', cnt2.pages === 35 && cnt2.views === 52 && cnt2.links === 1 && cnt2.tasks === 1 && cnt2.blocks === 302 && cnt2.boards === 16, JSON.stringify(cnt2));

/* ---------- R3: Alice → Bob on ONE browser profile ---------- */
// Simulate a real logout that does NOT sweep storage: inject Alice's scoped
// prefs AND leftover unscoped legacy keys AFTER the switch, then Bob opens
// /capture on the same profile.
await uiLogin(bob);
await page.evaluate(([uid]) => {
  localStorage.setItem(`ws_field_ctx:${uid}`, JSON.stringify({ id: 'somewhere', kind: 'record', title: 'Alice Secret Site' }));
  localStorage.setItem(`ws_capture_board:${uid}`, 'some-board');
  // pre-fix legacy globals — the sweep must remove these on read/write
  localStorage.setItem('ws_field_ctx', JSON.stringify({ id: 'somewhere', kind: 'record', title: 'Alice Secret Site' }));
  localStorage.setItem('ws_capture_board', 'legacy-board');
}, [admin.user.id]);
await page.goto(`${BASE}/capture`, { waitUntil: 'domcontentloaded' });
await sleep(2500);
const aliceCtx = await page.locator('text=Alice Secret Site').count();
const leaks = await page.evaluate(() => ({
  unscopedCtx: localStorage.getItem('ws_field_ctx'),
  unscopedBoard: localStorage.getItem('ws_capture_board'),
}));
note('R3: Bob sees none of Alice\'s context', aliceCtx === 0);
note('R3: legacy unscoped keys are swept', leaks.unscopedCtx === null && leaks.unscopedBoard === null, JSON.stringify(leaks));

/* ---------- R2: byte-durable draft + single record on save ---------- */
await page.goto(`${BASE}/capture`, { waitUntil: 'domcontentloaded' });
await sleep(1200);
// select the Photo kind (Caption textarea + photo inputs live under it)
await page.locator('[role="group"][aria-label="Capture kind"] button:has-text("Photo")').first().dispatchEvent('click');
await sleep(300);
// attach a photo via the hidden file input + a caption
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAANSURBVBhXY/z//z8DAwMDA/8f+//8fwAAAAASUVORK5CYII=', 'base64');
await page.locator('input[type=file][accept*="image"]').first().setInputFiles({ name: 'field.jpg', mimeType: 'image/jpeg', buffer: png });
await page.locator('textarea[aria-label="Caption"]').fill('byte-durable draft');
await sleep(900); // draft debounce
await page.reload({ waitUntil: 'domcontentloaded' });
await sleep(2000);
const thumb = await page.locator('img[src^="blob:"]').count();
const cap = await page.locator('textarea[aria-label="Caption"]').inputValue().catch(() => '');
note('R2: photo bytes + caption survive reload', thumb >= 1 && cap.includes('byte-durable'), `thumb=${thumb}`);
// save → exactly one record with the files row parented to it
const before = (await pull(bob.token)).filter((r) => r.collection === 'tasks' && !(r.data || {}).deleted).length;
const saveBtn = page.locator('button:has-text("Save to")').first();
await saveBtn.dispatchEvent('click');
await poll(async () => {
  const rs = await pull(bob.token);
  return rs.filter((r) => r.collection === 'tasks' && !(r.data || {}).deleted).length === before + 1;
}, 30000);
await sleep(1500);
const recs3 = await pull(bob.token);
const newTasks = recs3.filter((r) => r.collection === 'tasks' && !(r.data || {}).deleted && JSON.stringify(r.data).includes('byte-durable'));
const files = recs3.filter((r) => r.collection === 'files' && !(r.data || {}).deleted && newTasks.length && r.data.parentId === newTasks[0].id);
note('R2: one record + its file row after save', newTasks.length === 1 && files.length >= 1, `tasks=${newTasks.length} files=${files.length}`);

console.log('\n=== RESULT ===');
console.log(R.join('\n'));
const fails = R.filter((x) => x.startsWith('FAIL'));
console.log(`\n${R.length - fails.length} PASS / ${fails.length} FAIL`);
await browser.close();
process.exit(fails.length ? 1 : 0);
