import { describe, expect, it } from 'vitest';
import { exportableMoodItems, moodboardSvg } from '../shared/moodboardExport';
import { sanitizeSvg } from '../shared/svgSanitize';
import type { MoodItem } from '../shared/mooditems';

const note: MoodItem = { id: 'note', type: 'note', x: -200, y: -100, w: 200, h: 160, text: '<script> & café 👩🏽‍💻' };
const image: MoodItem = { id: 'image', type: 'image', fileId: 'file', x: 50, y: 50, w: 180, h: 100 };
const png = 'data:image/png;base64,iVBORw0KGgo=';
const render = (items: MoodItem[], images = new Map<string, string>()) => moodboardSvg({ title: 'Canvas & notes', items, images });

describe('moodboard exports', () => {
  it('uses stored negative geometry, escapes user text and omits deleted items', () => {
    const result = render([note, { ...image, deleted: true }]);
    expect(result.svg).toContain('viewBox="-224 -124 248 208"');
    expect(result.svg).toContain('&lt;script&gt; &amp;');
    expect(result.svg).not.toContain('<script>');
    expect(result.svg).not.toContain('<image');
    expect(result.missing).toBe(0);
    expect(result.width).toBe(248);
  });

  it('embeds raster bytes and labels missing attachments without external references', () => {
    const result = render([image, { ...image, id: 'missing', fileId: 'absent', y: 200 }], new Map([['file', png]]));
    expect(result.missing).toBe(1);
    expect(result.svg).toContain('href="' + png + '"');
    expect(result.svg).toContain('Image unavailable');
    expect(result.svg).not.toContain('/api/');
  });

  it('includes selected items and their connecting edges, omitting dangling endpoints', () => {
    const edge: MoodItem = { id: 'edge', type: 'connector', from: 'note', to: 'image', label: 'Connect', arrow: 'both' };
    const items = [note, image, edge];
    expect(exportableMoodItems(items, new Set(['note'])).map(item => item.id)).toEqual(['note']);
    const selection = exportableMoodItems(items, new Set(['note', 'image']));
    expect(selection).toHaveLength(3);
    expect(render(selection).svg).toContain('<line');
    expect(render([note, edge]).svg).not.toContain('<line');
  });

  it('bounds output dimensions and refuses oversized item inventories', () => {
    const result = render([{ ...note, w: 100_000, h: 50_000 }]);
    expect(result.width).toBe(4096);
    expect(result.height).toBeLessThanOrEqual(4096);
    expect(() => render(Array.from({ length: 601 }, (_, i) => ({ ...note, id: 'n' + i })))).toThrow('600');
    expect(() => render([])).toThrow('at least one');
  });

  it('allows raster data only under the export sanitizer option and retains the default serving policy', () => {
    const source = `<svg><image href="${png}" onload="alert(1)" width="10"/><image href="https://untrusted.invalid/a"/><image href="data:image/svg+xml;base64,PHN2Zz4="/><script>alert(1)</script></svg>`;
    const output = sanitizeSvg(source, { moodboardExport: true });
    expect(output.ok).toBe(true);
    if (!output.ok) throw new Error('Export sanitizer failed');
    expect(output.svg.match(/<image/g)).toHaveLength(1);
    expect(output.svg).not.toContain('onload');
    expect(output.svg).not.toContain('untrusted');
    expect(output.svg).not.toContain('script');
    const ordinary = sanitizeSvg(source);
    expect(ordinary.ok && ordinary.svg).not.toContain('<image');
  });
});
