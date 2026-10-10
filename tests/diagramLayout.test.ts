import { describe, expect, it } from 'vitest';
import {
  layoutDiagram,
  validateDiagramSpec,
  DIAGRAM_H_GAP,
  DIAGRAM_NODE_H,
  DIAGRAM_NODE_W,
  DIAGRAM_V_GAP,
  type DiagramSpec,
} from '../shared/diagramLayout';

const spec = (partial: Partial<DiagramSpec>): DiagramSpec => ({
  layout: 'auto-lr',
  nodes: [],
  edges: [],
  ...partial,
});
const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id, ...extra });

/** Deterministic RNG (mulberry32). */
const rng = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe('validateDiagramSpec', () => {
  it('accepts a minimal spec', () => {
    const r = validateDiagramSpec(spec({ nodes: [node('a')], edges: [] }));
    expect(r.ok).toBe(true);
  });

  it('rejects non-objects and bad layout', () => {
    expect(validateDiagramSpec(null).ok).toBe(false);
    expect(validateDiagramSpec('x').ok).toBe(false);
    const r = validateDiagramSpec(spec({ layout: 'sideways' as never, nodes: [node('a')] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain('bad-layout');
  });

  it('enforces node/edge limits', () => {
    const many = spec({
      nodes: Array.from({ length: 201 }, (_, i) => node(`n${i}`)),
      edges: [],
    });
    const r = validateDiagramSpec(many);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.some((x) => x.includes('200-nodes'))).toBe(true);

    const nodes = Array.from({ length: 30 }, (_, i) => node(`n${i}`));
    const edges = Array.from({ length: 401 }, (_, i) => ({ from: 'n0', to: `n${(i % 29) + 1}` }));
    const r2 = validateDiagramSpec(spec({ nodes, edges }));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reasons.some((x) => x.includes('400-edges'))).toBe(true);
  });

  it('rejects duplicate ids and dangling edge endpoints', () => {
    const dup = validateDiagramSpec(spec({ nodes: [node('a'), node('a')], edges: [] }));
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reasons.some((x) => x.includes('duplicate-id'))).toBe(true);

    const dangle = validateDiagramSpec(spec({ nodes: [node('a')], edges: [{ from: 'a', to: 'ghost' }] }));
    expect(dangle.ok).toBe(false);
    if (!dangle.ok) expect(dangle.reasons.some((x) => x.includes('dangling'))).toBe(true);
  });

  it('accepts optional node ref/shape/color and edge label/style', () => {
    const r = validateDiagramSpec(
      spec({
        nodes: [
          node('a', { ref: { type: 'record', id: 'r1' }, shape: 'pill', color: '#fff' }),
          node('b'),
        ],
        edges: [{ from: 'a', to: 'b', label: 'then', style: 'dashed' }],
      }),
    );
    expect(r.ok).toBe(true);
  });
});

describe('layoutDiagram — auto', () => {
  it('chains left→right by longest-path rank', () => {
    const { nodes } = layoutDiagram(
      spec({
        nodes: [node('a'), node('b'), node('c')],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
        ],
      }),
    );
    const at = (id: string) => nodes.find((n) => n.id === id)!;
    const pitch = DIAGRAM_NODE_W + DIAGRAM_H_GAP;
    expect(at('a').x).toBe(0);
    expect(at('b').x).toBe(pitch);
    expect(at('c').x).toBe(pitch * 2);
    expect(at('a').y).toBe(0);
  });

  it('longest path wins over shortest for diamonds', () => {
    // a→d direct AND a→b→c→d: d must sit at rank 3, not 1.
    const { nodes } = layoutDiagram(
      spec({
        nodes: [node('a'), node('b'), node('c'), node('d')],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
          { from: 'c', to: 'd' },
          { from: 'a', to: 'd' },
        ],
      }),
    );
    const at = (id: string) => nodes.find((n) => n.id === id)!;
    const pitch = DIAGRAM_NODE_W + DIAGRAM_H_GAP;
    expect(at('d').x).toBe(pitch * 3);
    expect(at('b').x).toBe(pitch);
    expect(at('c').x).toBe(pitch * 2);
  });

  it('auto-tb puts ranks on the y axis', () => {
    const { nodes } = layoutDiagram(
      spec({ layout: 'auto-tb', nodes: [node('a'), node('b')], edges: [{ from: 'a', to: 'b' }] }),
    );
    const at = (id: string) => nodes.find((n) => n.id === id)!;
    expect(at('b').y).toBe(DIAGRAM_NODE_H + DIAGRAM_V_GAP);
    expect(at('a').y).toBe(0);
  });

  it('is deterministic regardless of input node/edge order', () => {
    const base = spec({
      nodes: [node('a'), node('b'), node('c'), node('d'), node('e')],
      edges: [
        { from: 'a', to: 'c' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'd' },
        { from: 'c', to: 'e' },
      ],
    });
    const shuffled = spec({
      nodes: [...base.nodes].reverse(),
      edges: [...base.edges].reverse(),
    });
    // Positions must be identical regardless of input order (edges echo the spec's order).
    expect(layoutDiagram(shuffled).nodes).toEqual(layoutDiagram(base).nodes);
    expect(layoutDiagram(base)).toEqual(layoutDiagram(base));
  });

  it('barycenter ordering minimizes crossings for a simple fork', () => {
    // s→x, s→y; plus t→x: the layer containing x,y should order x next to t's
    // column… assert determinism + that both land at rank 1 with distinct y.
    const { nodes } = layoutDiagram(
      spec({
        nodes: [node('s'), node('t'), node('x'), node('y')],
        edges: [
          { from: 's', to: 'x' },
          { from: 's', to: 'y' },
          { from: 't', to: 'x' },
        ],
      }),
    );
    const at = (id: string) => nodes.find((n) => n.id === id)!;
    const pitch = DIAGRAM_NODE_W + DIAGRAM_H_GAP;
    expect(at('x').x).toBe(pitch);
    expect(at('y').x).toBe(pitch);
    expect(at('x').y).not.toBe(at('y').y);
  });

  it('tolerates cycles by ignoring back edges', () => {
    const { nodes } = layoutDiagram(
      spec({
        nodes: [node('a'), node('b'), node('c')],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
          { from: 'c', to: 'a' }, // back edge
        ],
      }),
    );
    expect(nodes).toHaveLength(3);
    const at = (id: string) => nodes.find((n) => n.id === id)!;
    const pitch = DIAGRAM_NODE_W + DIAGRAM_H_GAP;
    expect(at('a').x).toBe(0);
    expect(at('b').x).toBe(pitch);
    expect(at('c').x).toBe(pitch * 2);
  });

  it('never overlaps nodes in random DAGs up to 50 nodes', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const rand = rng(seed);
      const n = 5 + Math.floor(rand() * 46);
      const perm = Array.from({ length: n }, (_, i) => `n${i}`).sort(() => rand() - 0.5);
      const nodes = perm.map((id) => node(id));
      const edges: { from: string; to: string }[] = [];
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (rand() < 0.08) edges.push({ from: perm[i], to: perm[j] });
        }
      }
      const { nodes: placed } = layoutDiagram(spec({ nodes, edges }));
      const seen = new Set<string>();
      for (const p of placed) {
        const k = `${p.x},${p.y}`;
        expect(seen.has(k), `seed ${seed} overlap at ${k}`).toBe(false);
        seen.add(k);
      }
    }
  });
});

describe('layoutDiagram — manual', () => {
  it('keeps given x/y, defaults missing to 0', () => {
    const { nodes } = layoutDiagram(
      spec({ layout: 'manual', nodes: [node('a', { x: 40, y: 90 }), node('b')], edges: [] }),
    );
    const at = (id: string) => nodes.find((n) => n.id === id)!;
    expect(at('a')).toMatchObject({ x: 40, y: 90 });
    expect(at('b')).toMatchObject({ x: 0, y: 0 });
  });
});
