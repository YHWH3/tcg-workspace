import { describe, expect, it } from 'vitest';
import { paletteFromPixels } from '../src/modules/moodboards/palette';

function rgba(r: number, g: number, b: number): number[] {
  return [r, g, b, 255];
}

describe('paletteFromPixels', () => {
  it('is deterministic for the same pixels', () => {
    const px = [...rgba(200, 30, 30), ...rgba(30, 200, 30), ...rgba(30, 30, 200), ...rgba(200, 200, 30), ...rgba(30, 200, 200)];
    const a = paletteFromPixels(px);
    const b = paletteFromPixels(px);
    expect(a).toEqual(b);
    expect(a.length).toBe(5);
  });

  it('extracts the dominant color from a solid image', () => {
    const px = Array.from({ length: 64 }).flatMap(() => rgba(18, 52, 86));
    const [first] = paletteFromPixels(px);
    expect(first).toBe('#123456');
  });

  it('returns distinct buckets for a two-color image', () => {
    const px = [...Array.from({ length: 50 }).flatMap(() => rgba(255, 0, 0)), ...Array.from({ length: 50 }).flatMap(() => rgba(0, 0, 255))];
    const pal = paletteFromPixels(px);
    expect(pal).toContain('#ff0000');
    expect(pal).toContain('#0000ff');
  });

  it('skips transparent pixels and handles empty input', () => {
    expect(paletteFromPixels([])).toEqual([]);
    const px = [10, 20, 30, 0, 200, 100, 50, 255];
    expect(paletteFromPixels(px)).toEqual(['#c86432']);
  });
});
