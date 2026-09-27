type RGB = [number, number, number];

function range(b: RGB[]): number {
  let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
  for (const [r, g, bl] of b) {
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
    if (g < gMin) gMin = g;
    if (g > gMax) gMax = g;
    if (bl < bMin) bMin = bl;
    if (bl > bMax) bMax = bl;
  }
  return Math.max(rMax - rMin, gMax - gMin, bMax - bMin);
}

function widest(b: RGB[]): number {
  let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
  for (const [r, g, bl] of b) {
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
    if (g < gMin) gMin = g;
    if (g > gMax) gMax = g;
    if (bl < bMin) bMin = bl;
    if (bl > bMax) bMax = bl;
  }
  const rs = rMax - rMin, gs = gMax - gMin, bs = bMax - bMin;
  return rs >= gs && rs >= bs ? 0 : gs >= bs ? 1 : 2;
}

function avg(b: RGB[]): RGB {
  let r = 0, g = 0, bl = 0;
  for (const p of b) {
    r += p[0];
    g += p[1];
    bl += p[2];
  }
  const n = b.length || 1;
  return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
}

function hex([r, g, b]: RGB): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Deterministic median-cut palette. Same pixels in → same colors out.
 * Returns `count` hex colors.
 */
export function paletteFromPixels(pixels: ArrayLike<number>, count = 5): string[] {
  const px: RGB[] = [];
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    px.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
  }
  if (px.length === 0) return [];
  let buckets: RGB[][] = [px];
  while (buckets.length < count) {
    let bi = -1;
    let best = -1;
    buckets.forEach((b, i) => {
      if (b.length <= 1) return;
      const r = range(b);
      if (r > best) {
        best = r;
        bi = i;
      }
    });
    if (bi < 0) break;
    const b = buckets.splice(bi, 1)[0];
    const ch = widest(b);
    // Stable, deterministic ordering: channel, then r/g/b.
    b.sort((a, c) => a[ch] - c[ch] || a[0] - c[0] || a[1] - c[1] || a[2] - c[2]);
    const mid = Math.floor(b.length / 2);
    buckets.push(b.slice(0, mid), b.slice(mid));
  }
  return buckets.map((b) => hex(avg(b)));
}
