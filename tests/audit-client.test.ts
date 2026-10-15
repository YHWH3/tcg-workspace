// Cross-phase audit regressions — client-side defences that must hold even
// when the server (or a stale local cache) hands back something it should not.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderableBlob } from '../src/core/renderable';
import { MAX_FUTURE_SKEW_MS } from '../shared/clock';

describe('renderableBlob (blob: URLs inherit the app origin)', () => {
  it('turns stored documents into opaque downloads', async () => {
    for (const type of ['text/html', 'application/xhtml+xml', 'text/xml', 'application/javascript', '']) {
      const out = await renderableBlob(new Blob(['<script>alert(1)</script>'], { type }));
      expect(out.type, type).toBe('application/octet-stream');
    }
  });

  it('keeps inline-safe media untouched', async () => {
    for (const type of ['image/png', 'image/jpeg', 'application/pdf', 'video/mp4', 'audio/webm']) {
      const blob = new Blob([new Uint8Array([1, 2, 3])], { type });
      expect(await renderableBlob(blob)).toBe(blob);
    }
  });

  it('re-sanitizes SVG cached before the server enforced sanitization', async () => {
    const dirty = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1" onclick="x()"/></svg>'], { type: 'image/svg+xml' });
    const out = await renderableBlob(dirty);
    expect(out.type).toBe('image/svg+xml');
    expect(await out.text()).not.toMatch(/<script|onclick/i);
    const broken = await renderableBlob(new Blob(['<html>not svg'], { type: 'image/svg+xml' }));
    expect(broken.type).toBe('application/octet-stream');
  });
});

describe('client HLC refuses untrusted timestamps', () => {
  const storage = (initial: Record<string, string> = {}) => {
    const data = { ...initial };
    return { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; }, data };
  };
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  it('observe ignores a far-future or non-finite timestamp; next keeps advancing', async () => {
    vi.stubGlobal('localStorage', storage());
    vi.resetModules();
    const { hlc } = await import('../src/core/hlc');
    const base = hlc.next();
    hlc.observe(1e300);
    hlc.observe(Number.MAX_VALUE);
    hlc.observe(Date.now() + MAX_FUTURE_SKEW_MS + 60_000);
    hlc.observe(Number.NaN);
    const after = hlc.next();
    expect(after).toBeGreaterThan(base);
    expect(after).toBeLessThan(Date.now() + MAX_FUTURE_SKEW_MS + 1000);
    // A modestly-ahead peer is still honoured.
    const ahead = Date.now() + 5_000;
    hlc.observe(ahead);
    expect(hlc.next()).toBeGreaterThan(ahead);
  });

  it('a persisted poisoned clock is discarded on load instead of pinning every write to the future', async () => {
    vi.stubGlobal('localStorage', storage({ ws_hlc: '1e300' }));
    vi.resetModules();
    const { hlc } = await import('../src/core/hlc');
    const ts = hlc.next();
    expect(ts).toBeLessThan(Date.now() + 1000);
    expect(hlc.next()).toBeGreaterThan(ts);
  });
});
