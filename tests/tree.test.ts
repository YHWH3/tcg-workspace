import { describe, expect, it } from 'vitest';
import { checkReparent, descendants, depthOf, MAX_DEPTH, subtreeHeight, wouldCreateCycle, wouldExceedDepth } from '../shared/tree';

const map = (entries: [string, string | null][]): Map<string, string | null> => new Map(entries);

describe('tree depth', () => {
  // chains: root → a → b (depth 3 = max); x → y (depth 2); loose (depth 1)
  const parentOf = map([
    ['root', null],
    ['a', 'root'],
    ['b', 'a'],
    ['x', null],
    ['y', 'x'],
    ['loose', null],
  ]);

  it('depthOf: root=1, child=2, grandchild=3', () => {
    expect(depthOf(parentOf, 'root')).toBe(1);
    expect(depthOf(parentOf, 'a')).toBe(2);
    expect(depthOf(parentOf, 'b')).toBe(3);
    expect(MAX_DEPTH).toBe(3);
  });

  it('subtreeHeight counts the longest chain below the node', () => {
    expect(subtreeHeight(parentOf, 'b')).toBe(1);
    expect(subtreeHeight(parentOf, 'a')).toBe(2);
    expect(subtreeHeight(parentOf, 'root')).toBe(3);
    expect(subtreeHeight(parentOf, 'loose')).toBe(1);
  });

  it('refuses nesting deeper than 3', () => {
    // b is at depth 3 already — nothing can go under it.
    expect(wouldExceedDepth(parentOf, 'loose', 'b')).toBe(true);
    expect(checkReparent(parentOf, 'loose', 'b')).toBe('depth');
    // a's subtree is height 2; putting it under y (depth 2) → 4 — refused.
    expect(wouldExceedDepth(parentOf, 'a', 'y')).toBe(true);
    expect(checkReparent(parentOf, 'a', 'y')).toBe('depth');
    // a moved to top level keeps height 2 → ok.
    expect(checkReparent(parentOf, 'a', null)).toBe('ok');
    // leaf under a (depth 2) lands at depth 3 → ok.
    expect(checkReparent(parentOf, 'loose', 'a')).toBe('ok');
    // y (height 1) under root (depth 1) → 2 → ok.
    expect(checkReparent(parentOf, 'y', 'root')).toBe('ok');
  });
});

describe('tree cycles', () => {
  const parentOf = map([
    ['root', null],
    ['a', 'root'],
    ['b', 'a'],
    ['c', 'b'],
  ]);

  it('cannot move a node under itself', () => {
    expect(checkReparent(parentOf, 'a', 'a')).toBe('self');
    expect(wouldCreateCycle(parentOf, 'a', 'a')).toBe(true);
  });

  it('cannot move a node under its own descendant', () => {
    expect(wouldCreateCycle(parentOf, 'a', 'c')).toBe(true);
    expect(wouldCreateCycle(parentOf, 'root', 'b')).toBe(true);
    expect(checkReparent(parentOf, 'root', 'c')).toBe('cycle');
    expect(checkReparent(parentOf, 'a', 'c')).toBe('cycle');
  });

  it('allows sideways moves and detaching to root', () => {
    expect(checkReparent(parentOf, 'b', 'root')).toBe('ok'); // b (height 2) under root (depth 1) → 3
    expect(checkReparent(parentOf, 'a', null)).toBe('ok');
    expect(wouldCreateCycle(parentOf, 'b', 'a')).toBe(false); // already its parent
  });

  it('wouldCreateCycle walks up through the new parent only', () => {
    const p = map([
      ['x', 'y'],
      ['y', null],
      ['z', null],
    ]);
    expect(wouldCreateCycle(p, 'x', 'z')).toBe(false); // unrelated subtree
    expect(wouldCreateCycle(p, 'y', 'x')).toBe(true); // x is already a child of y
  });
});

describe('descendants', () => {
  it('collects the whole subtree BFS-style, cycle-safe', () => {
    const parentOf = map([
      ['r', null],
      ['a', 'r'],
      ['b', 'r'],
      ['a1', 'a'],
      ['a2', 'a'],
      ['a1x', 'a1'],
      ['other', null],
    ]);
    expect(descendants(parentOf, 'r').sort()).toEqual(['a', 'a1', 'a1x', 'a2', 'b']);
    expect(descendants(parentOf, 'a')).toEqual(['a1', 'a2', 'a1x']);
    expect(descendants(parentOf, 'other')).toEqual([]);
  });

  it('survives malformed cyclic input', () => {
    const parentOf = map([
      ['a', 'b'],
      ['b', 'a'],
      ['c', 'a'],
    ]);
    expect(descendants(parentOf, 'a').sort()).toEqual(['b', 'c']);
    expect(depthOf(parentOf, 'a')).toBe(2); // terminates despite the cycle
  });
});
