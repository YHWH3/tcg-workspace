import { describe, it, expect } from 'vitest';
import { checkExpectations } from '../worker/sync';

const row = (seq: number) => ({ id: 'x', collection: 'tasks', seq, data: '{"title":"T"}', updated_by: 'u1', updated_at: 123 });

describe('checkExpectations', () => {
  it('passes when seq matches', () => {
    expect(checkExpectations(new Map([['x', row(5)]]), new Map([['x', 5]]))).toEqual([]);
  });
  it('conflicts on stale rev with current content', () => {
    const c = checkExpectations(new Map([['x', row(7)]]), new Map([['x', 5]]));
    expect(c).toHaveLength(1);
    expect(c[0].expectedRev).toBe(5);
    expect(c[0].currentRev).toBe(7);
    expect(c[0].current).toEqual({ title: 'T' });
    expect(c[0].updatedBy).toBe('u1');
  });
  it('conflicts when the row is gone', () => {
    const c = checkExpectations(new Map(), new Map([['x', 5]]));
    expect(c[0].currentRev).toBeNull();
  });
});
