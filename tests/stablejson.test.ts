import { describe, it, expect } from 'vitest';
import { stableJson, argsHash } from '../shared/stablejson';

describe('stableJson', () => {
  it('sorts keys recursively', () => {
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
  it('same args in different order → same hash', async () => {
    const a = await argsHash({ title: 'X', requestId: 'r1', nested: { y: 1, x: 2 } });
    const b = await argsHash({ nested: { x: 2, y: 1 }, title: 'X', requestId: 'r2' });
    expect(a).toBe(b); // requestId excluded from the hash
  });
  it('different args → different hash', async () => {
    expect(await argsHash({ title: 'A' })).not.toBe(await argsHash({ title: 'B' }));
  });
});
