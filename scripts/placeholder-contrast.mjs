import assert from 'node:assert/strict';

// Native placeholder paint is not reliably included in axe's text samples.
// Measure its actual pseudo-element color/opacity against the composed surface.
export async function assertPlaceholderContrast(page, surface, selector = 'input[placeholder], textarea[placeholder]') {
  const failures = await page.locator(selector).evaluateAll(elements => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Placeholder contrast requires a canvas color resolver');
    const color = value => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b, alpha / 255];
    };
    const over = (top, bottom) => {
      const alpha = top[3] + bottom[3] * (1 - top[3]);
      return alpha ? [0, 1, 2].map(i => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / alpha).concat(alpha) : [0, 0, 0, 0];
    };
    const luminance = rgb => {
      const channels = rgb.slice(0, 3).map(c => c / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
    };
    return elements.flatMap(element => {
      if (!element.matches(':placeholder-shown') || element.matches(':disabled') || !element.checkVisibility()) return [];
      const placeholder = getComputedStyle(element, '::placeholder');
      let foreground = color(placeholder.color), background = [0, 0, 0, 0];
      foreground[3] *= Number(placeholder.opacity);
      const label = element.getAttribute('aria-label') || element.placeholder;
      for (let parent = element; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (background[3] < 1 && style.backgroundImage !== 'none') return [{ label, issue: 'image background requires a separate contrast measurement' }];
        const layer = color(style.backgroundColor);
        foreground = over(foreground, layer); background = over(background, layer);
        foreground[3] *= Number(style.opacity); background[3] *= Number(style.opacity);
      }
      if (background[3] < .999) return [{ label, issue: 'background did not resolve to an opaque surface' }];
      const a = luminance(foreground), b = luminance(background);
      const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      const fontSize = Number.parseFloat(placeholder.fontSize), weight = Number.parseInt(placeholder.fontWeight, 10);
      const minimum = fontSize >= 24 || (fontSize >= 18.6667 && weight >= 700) ? 3 : 4.5;
      return ratio + .001 < minimum ? [{ label, ratio, minimum, foreground: foreground.slice(0, 3), background: background.slice(0, 3) }] : [];
    });
  });
  assert.deepEqual(failures, [], `${surface}: placeholder contrast ${JSON.stringify(failures)}`);
}
