import { describe, expect, it } from 'vitest';
import { dependenciesOf, dependentsOf, edgesOf, isBlocked, wouldCreateDependencyCycle, type DepEdge } from '../shared/deps';

// edges: [blocker, blocked] — blocker must finish before blocked.
const chain: DepEdge[] = [
  ['a', 'b'],
  ['b', 'c'],
  ['d', 'c'],
];

describe('wouldCreateDependencyCycle', () => {
  it('rejects a direct self-loop', () => {
    expect(wouldCreateDependencyCycle([], 'a', 'a')).toBe(true);
  });

  it('rejects direct and transitive cycles (A→B fails when B can reach A)', () => {
    expect(wouldCreateDependencyCycle([['a', 'b']], 'b', 'a')).toBe(true);
    // chain a→b→c : adding c→a closes a 3-cycle.
    expect(wouldCreateDependencyCycle(chain, 'c', 'a')).toBe(true);
    // adding c→b closes a 2-cycle through the existing b→c.
    expect(wouldCreateDependencyCycle(chain, 'c', 'b')).toBe(true);
  });

  it('allows edges that do not close a loop', () => {
    expect(wouldCreateDependencyCycle(chain, 'a', 'd')).toBe(false); // a→d: d can't reach a
    expect(wouldCreateDependencyCycle(chain, 'x', 'a')).toBe(false); // new node upstream
    expect(wouldCreateDependencyCycle(chain, 'c', 'x')).toBe(false); // new node downstream
    expect(wouldCreateDependencyCycle([], 'a', 'b')).toBe(false);
  });

  it('handles diamonds and disconnected components', () => {
    const diamond: DepEdge[] = [
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'd'],
      ['c', 'd'],
    ];
    expect(wouldCreateDependencyCycle(diamond, 'd', 'a')).toBe(true);
    expect(wouldCreateDependencyCycle(diamond, 'd', 'b')).toBe(true);
    expect(wouldCreateDependencyCycle(diamond, 'x', 'y')).toBe(false);
  });
});

describe('isBlocked / dependencies / dependents', () => {
  const done = new Set(['b']);
  const isDone = (id: string) => done.has(id);

  it('isBlocked: any live incoming edge from an unfinished blocker', () => {
    expect(isBlocked('c', chain, isDone)).toBe(true); // 'd' not done
    expect(isBlocked('b', chain, isDone)).toBe(true); // 'a' not done
    expect(isBlocked('a', chain, isDone)).toBe(false);
    done.add('d');
    expect(isBlocked('c', chain, isDone)).toBe(false); // both blockers done
  });

  it('dependenciesOf lists blockers; dependentsOf lists what it blocks', () => {
    expect(dependenciesOf('c', chain).sort()).toEqual(['b', 'd']);
    expect(dependenciesOf('a', chain)).toEqual([]);
    expect(dependentsOf('a', chain)).toEqual(['b']);
    expect(dependentsOf('b', chain)).toEqual(['c']);
    expect(dependentsOf('c', chain)).toEqual([]);
  });
});

describe('edgesOf', () => {
  it('keeps only live blocks-kind links', () => {
    const links = [
      { fromId: 'a', toId: 'b', kind: 'blocks' },
      { fromId: 'b', toId: 'c', kind: 'blocks', deleted: true },
      { fromId: 'a', toId: 'c', kind: 'relation', fieldId: 'f1' },
      { fromId: 'x', toId: 'y', kind: 'related' },
      { fromId: '', toId: 'z', kind: 'blocks' },
    ];
    expect(edgesOf(links)).toEqual([['a', 'b']]);
  });
});
