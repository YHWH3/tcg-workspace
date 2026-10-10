import { describe, expect, it } from 'vitest';
import { fnv1a64hex, linkId } from '../shared/linkid';

describe('fnv1a64hex', () => {
  it('is deterministic and 16 hex chars', () => {
    const a = fnv1a64hex('relation|f1|rec-a|rec-b');
    expect(a).toBe(fnv1a64hex('relation|f1|rec-a|rec-b'));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('matches the known FNV-1a 64 offset basis for empty input', () => {
    expect(fnv1a64hex('')).toBe('cbf29ce484222325');
  });
});

describe('linkId', () => {
  it('produces a 35-char id: lk_ + two 16-hex halves', () => {
    const id = linkId('relation', 'f1', 'rec-a', 'rec-b');
    expect(id).toHaveLength(35);
    expect(id).toMatch(/^lk_[0-9a-f]{32}$/);
  });

  it('is deterministic — same (kind, fieldId, fromId, toId) → same id', () => {
    expect(linkId('blocks', null, 'a', 'b')).toBe(linkId('blocks', null, 'a', 'b'));
    expect(linkId('related', '', 'x', 'y')).toBe(linkId('related', '', 'x', 'y'));
    expect(linkId('relation', 'f9', 'p', 'q')).toBe(linkId('relation', 'f9', 'p', 'q'));
  });

  it('treats null and empty fieldId the same', () => {
    expect(linkId('related', null, 'a', 'b')).toBe(linkId('related', '', 'a', 'b'));
    expect(linkId('related', undefined, 'a', 'b')).toBe(linkId('related', '', 'a', 'b'));
  });

  it('differs when any part differs (direction, kind, field)', () => {
    const base = linkId('relation', 'f1', 'a', 'b');
    expect(linkId('relation', 'f1', 'b', 'a')).not.toBe(base);
    expect(linkId('relation', 'f2', 'a', 'b')).not.toBe(base);
    expect(linkId('blocks', 'f1', 'a', 'b')).not.toBe(base);
    expect(linkId('blocks', null, 'a', 'b')).not.toBe(linkId('related', null, 'a', 'b'));
  });

  it('has no collisions over 100k random pairs', () => {
    const ids = new Set<string>();
    const kinds = ['relation', 'blocks', 'related'];
    let x = 12345;
    // xorshift32 — decent low bits (an LCG's low bits cycle and skew the sample).
    const next = () => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return (x >>>= 0);
    };
    for (let n = 0; n < 100_000; n++) {
      const kind = kinds[next() % 3];
      const fid = next() % 2 ? `f${next() % 500}` : '';
      ids.add(linkId(kind, fid, `r${next() % 100000}`, `r${next() % 100000}`));
    }
    // 64+64-bit hash over random tuples should be collision-free in practice.
    expect(ids.size).toBeGreaterThan(99_900);
  });
});
