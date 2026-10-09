import { chromium } from 'playwright';
const BASE = 'http://localhost:8788';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(BASE + '/login');
await page.fill('input[name="username"], input[autocomplete="username"], input[type="text"]', 'admin');
await page.fill('input[type="password"]', 'password123');
await page.click('button[type="submit"]');
await sleep(2500);
await page.goto(`${BASE}/moodboards/v7_mb`);
await sleep(3500);
const pt = await page.evaluate(() => {
  const el = document.querySelector('[data-mooditem="v7_i_stage_card"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  for (const [fx, fy] of [[0.5,0.5],[0.1,0.1],[0.9,0.1],[0.1,0.9],[0.9,0.9],[0.5,0.1],[0.1,0.5],[0.9,0.5],[0.5,0.9]]) {
    const x = r.x + r.width * fx, y = r.y + r.height * fy;
    const t = document.elementFromPoint(x, y);
    if (t && (t === el || el.contains(t))) return { x, y };
  }
  return null;
});
console.log('pt:', JSON.stringify(pt));
if (pt) { await page.mouse.move(pt.x, pt.y); await page.mouse.down(); await page.mouse.up(); await sleep(300); }
await page.locator('[data-mooditem="v7_i_stage_card"]').dispatchEvent('click'); await sleep(300);
if (!(await page.locator('button[aria-label="Close inspector"]').count())) await page.locator('button[title="Inspector"]').dispatchEvent('click');
await sleep(700);
const insp = await page.evaluate(() => {
  const ins = [...document.querySelectorAll('div,aside,section')].find(d => /Inspector/.test(d.textContent||'') && d.querySelector('select,input'));
  return (ins?.textContent || document.body.textContent.slice(0, 200)).slice(0, 500);
});
console.log('inspector area:', JSON.stringify(insp));
const matches = await page.evaluate(() => [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && e.textContent?.trim() === 'Frame').map(e => e.tagName + '|' + String(e.className).slice(0,50)));
console.log('exact "Frame" leaves:', JSON.stringify(matches));
const selects = await page.evaluate(() => [...document.querySelectorAll('select')].map(s => ({ opts: [...s.options].map(o=>o.textContent).slice(0,6), near: s.closest('div')?.textContent?.slice(0,80) })));
console.log('selects:', JSON.stringify(selects));
const frameSel = page.locator('text="Frame"').locator('..').locator('select').first();
console.log('frameSel count:', await frameSel.count());
await browser.close();
