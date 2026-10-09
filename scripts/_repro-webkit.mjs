import { webkit } from 'playwright';
const BASE = 'http://localhost:8788';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await webkit.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
page.on('console', (m) => console.log('[pg]', m.type(), m.text().slice(0, 140)));
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.goto(BASE + '/login');
await page.fill('input[name="username"], input[autocomplete="username"], input[type="text"]', 'admin');
await page.fill('input[type="password"]', 'password123');
await page.click('button[type="submit"]');
await sleep(2500);
await page.goto(`${BASE}/moodboards/v7_mb`);
await sleep(3500);
await page.evaluate(() => {
  window.__log = [];
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'gotpointercapture', 'click']) {
    document.addEventListener(t, (e) => {
      if (t === 'pointermove' && window.__log.filter((l) => l.startsWith('pointermove')).length > 4) return;
      const it = e.target.closest?.('[data-mooditem]');
      window.__log.push(`${t} ptr=${e.pointerId} type=${e.pointerType} item=${it?.getAttribute('data-mooditem') ?? '-'} tgt=${e.target.tagName}.${String(e.target.className).slice(0, 25)}`);
    }, true);
  }
  window.__capErr = [];
  const oc = Element.prototype.setPointerCapture;
  Element.prototype.setPointerCapture = function (id) { try { return oc.call(this, id); } catch (e) { window.__capErr.push(String(e)); throw e; } };
});
console.log('coarse:', await page.evaluate(() => matchMedia('(pointer:coarse)').matches));
console.log('mode title:', await page.locator('[data-testid="mode-toggle"]').getAttribute('title'));
const b = await page.locator('[data-mooditem="v7_i_note2"]').boundingBox();
console.log('note2 box:', JSON.stringify(b));
const pre = await page.evaluate(() => { const el = document.querySelector('[data-mooditem="v7_i_note2"]'); return el?.style?.transform || el?.getBoundingClientRect().x; });
console.log('pre transform:', pre);
await page.mouse.move(b.x + 20, b.y + 20);
await page.mouse.down();
await page.mouse.move(b.x + 90, b.y + 50, { steps: 5 });
await page.mouse.up();
await sleep(600);
console.log((await page.evaluate(() => window.__log)).join('\n'));
console.log('capErr:', JSON.stringify(await page.evaluate(() => window.__capErr)));
const b2 = await page.locator('[data-mooditem="v7_i_note2"]').boundingBox();
console.log('note2 box after:', JSON.stringify(b2));
const post = await page.evaluate(async () => {
  const names = (await indexedDB.databases?.() ?? []).map((d) => d.name).filter(Boolean);
  for (const n of names) {
    const d = await new Promise((res) => { const r = indexedDB.open(n); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
    if (!d || ![...d.objectStoreNames].includes('mooditems')) continue;
    const t = await new Promise((res) => { const g = d.transaction('mooditems').objectStore('mooditems').get('v7_i_note2'); g.onsuccess = () => res(g.result); });
    return { db: n, x: t?.x, y: t?.y };
  }
  return { names };
});
console.log('post geom:', JSON.stringify(post));
await browser.close();
