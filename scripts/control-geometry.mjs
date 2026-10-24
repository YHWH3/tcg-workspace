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
    const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || el.tagName;
    const issues = content + 1 < line ? [{axis:'block',label,height:rect.height,content,line,padding:[css.paddingTop,css.paddingBottom],font:css.fontSize}] : [];
    // This toolbar's default caption is fixed product copy and must fit. Free
    // text and arbitrary user-defined options may intentionally use overflow.
    if (el.tagName === 'SELECT' && label === 'Group by' && el.value === '') {
      const probe = document.createElement('span');
      Object.assign(probe.style,{position:'fixed',visibility:'hidden',whiteSpace:'pre',fontFamily:css.fontFamily,fontSize:css.fontSize,fontWeight:css.fontWeight,fontStyle:css.fontStyle,letterSpacing:css.letterSpacing,fontFeatureSettings:css.fontFeatureSettings,fontVariationSettings:css.fontVariationSettings});
      probe.textContent = el.selectedOptions[0]?.label ?? '';
      document.body.append(probe);const textWidth = probe.getBoundingClientRect().width;probe.remove();
      const contentWidth = el.clientWidth - number(css.paddingLeft) - number(css.paddingRight);
      if (contentWidth + 1 < textWidth) issues.push({axis:'inline',label,contentWidth,textWidth,text:el.selectedOptions[0]?.label});
    }
    return issues;
  }));
  assert.deepEqual(clipped, [], `${surface}: clipped control labels ${JSON.stringify(clipped)}`);
}
