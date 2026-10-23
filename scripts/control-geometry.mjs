import assert from 'node:assert/strict';

// Axe cannot detect a glyph clipped inside a fixed-height form control.
// Measure the rendered content box, not just the presence of its label.
export async function assertControlGeometry(page, surface) {
  const clipped = await page.locator('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]):not([type=file]), select').evaluateAll(elements => elements.flatMap(el => {
    const rect = el.getBoundingClientRect();
    if (!el.checkVisibility() || rect.width === 0 || rect.height === 0 || rect.right <= 0 || rect.left >= innerWidth || rect.bottom <= 0 || rect.top >= innerHeight) return [];
    const css = getComputedStyle(el);
    const number = value => Number.parseFloat(value) || 0;
    const line = css.lineHeight === 'normal' ? number(css.fontSize) * 1.2 : number(css.lineHeight);
    const content = el.clientHeight - number(css.paddingTop) - number(css.paddingBottom);
    return content + 1 < line ? [{label: el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || el.tagName, height:rect.height, content, line, padding:[css.paddingTop,css.paddingBottom], font:css.fontSize}] : [];
  }));
  assert.deepEqual(clipped, [], `${surface}: clipped control labels ${JSON.stringify(clipped)}`);
}
