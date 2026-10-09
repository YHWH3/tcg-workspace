import { chromium } from 'playwright';
const BASE = 'http://localhost:8788';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto(BASE + '/login');
await page.fill('input[name="username"], input[autocomplete="username"], input[type="text"]', 'admin');
await page.fill('input[type="password"]', 'password123');
await page.click('button[type="submit"]');
await sleep(2500);
await page.goto(BASE + '/moodboards/v7_mb');
await sleep(3000);
// log click events around the trigger
await page.evaluate(() => {
  window.__log = [];
  const b = document.querySelector('[data-testid="mood-add"]');
  for (const t of ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'click', 'focusin']) {
    document.addEventListener(t, (e) => window.__log.push(`${t} tgt=${e.target.tagName}.${String(e.target.className).slice(0, 30)} exp=${b.parentElement?.getAttribute('aria-expanded')}`), true);
  }
});
await page.locator('[data-testid="mood-add"]').click();
await sleep(400);
console.log((await page.evaluate(() => window.__log)).join('\n'));
console.log('aria-expanded now:', await page.evaluate(() => document.querySelector('[data-testid="mood-add"]').parentElement?.getAttribute('aria-expanded')));
// try dispatchEvent('click') directly on the span
await page.evaluate(() => { document.querySelector('[data-testid="mood-add"]').parentElement.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
await sleep(300);
console.log('after span.click dispatch:', await page.evaluate(() => document.querySelector('[data-testid="mood-add"]').parentElement?.getAttribute('aria-expanded')));
await browser.close();
