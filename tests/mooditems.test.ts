import { describe, expect, it } from 'vitest';
import {
  alignOps,
  cardRef,
  connectorAnchors,
  cullItems,
  frameMembership,
  itemBounds,
  itemsInRect,
  marqueeSelect,
  normalizeItem,
  rectsIntersect,
  type MoodItem,
} from '../shared/mooditems';

const item = (id: string, data: Partial<MoodItem> = {}): MoodItem => ({
  id,
  type: 'note',
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  z: 0,
  ...data,
});

describe('cardRef', () => {
  it('prefers explicit ref', () => {
    expect(cardRef(item('a', { ref: { type: 'page', id: 'p1' }, taskId: 'r9' }))).toEqual({
      type: 'page',
      id: 'p1',
    });
  });
  it('falls back to legacy taskId → record ref', () => {
    expect(cardRef(item('a', { taskId: 'r9' }))).toEqual({ type: 'record', id: 'r9' });
  });
  it('rejects malformed refs and empties', () => {
    expect(cardRef(item('a'))).toBeNull();
    expect(cardRef(item('a', { ref: { type: 'user' as never, id: 'u' } }))).toBeNull();
    expect(cardRef(item('a', { ref: { type: 'record', id: '' } }))).toBeNull();
  });
});

describe('itemBounds / rectsIntersect / itemsInRect / marqueeSelect', () => {
  it('applies per-type defaults when w/h missing', () => {
    const note = itemBounds({ id: 'n', type: 'note' });
    expect(note).toEqual({ x: 0, y: 0, w: 200, h: 160 });
    const card = itemBounds({ id: 'c', type: 'card' });
    expect(card.w).toBe(260);
    expect(card.h).toBe(140);
  });

  it('intersection is strict overlap, not edge-touch', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    expect(rectsIntersect(a, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
    expect(rectsIntersect(a, { x: 10, y: 0, w: 10, h: 10 })).toBe(false); // touching edge only
    expect(rectsIntersect(a, { x: -10, y: -10, w: 10, h: 10 })).toBe(false);
  });

  it('itemsInRect returns overlapping non-connector live items', () => {
    const items = [
      item('in', { x: 5, y: 5 }),
      item('edge-out', { x: 100, y: 0 }), // touches rect edge at x=100? rect w=100 → boundary, strict: no
      item('out', { x: 500 }),
      item('del', { x: 5, deleted: true }),
      item('conn', { type: 'connector', from: 'in', to: 'edge-out' }),
    ];
    const rect = { x: 0, y: 0, w: 100, h: 100 };
    expect(itemsInRect(items, rect).map((i) => i.id)).toEqual(['in']);
    expect(marqueeSelect(items, rect)).toEqual(['in']);
  });

  it('marqueeSelect orders by z then id', () => {
    const items = [
      item('z5', { x: 10, y: 10, z: 5 }),
      item('z1b', { x: 20, y: 20, z: 1 }),
      item('z1a', { x: 30, y: 30, z: 1 }),
    ];
    expect(marqueeSelect(items, { x: 0, y: 0, w: 500, h: 500 })).toEqual(['z1a', 'z1b', 'z5']);
  });
});

describe('alignOps', () => {
  const trio = [
    item('a', { x: 0, y: 0, w: 100, h: 50 }),
    item('b', { x: 200, y: 40, w: 50, h: 50 }),
    item('c', { x: 60, y: 120, w: 80, h: 100 }),
  ];

  it('align left/right/top/bottom', () => {
    const left = alignOps(['a', 'b', 'c'], 'left', trio);
    expect(left.get('a')).toEqual({ x: 0 });
    expect(left.get('b')).toEqual({ x: 0 });
    expect(left.get('c')).toEqual({ x: 0 });

    const right = alignOps(['a', 'b', 'c'], 'right', trio);
    // bounding right edge = 200+50 = 250
    expect(right.get('a')).toEqual({ x: 150 });
    expect(right.get('b')).toEqual({ x: 200 });
    expect(right.get('c')).toEqual({ x: 170 });

    const top = alignOps(['a', 'b', 'c'], 'top', trio);
    expect(top.get('b')).toEqual({ y: 0 });
    expect(top.get('c')).toEqual({ y: 0 });

    const bottom = alignOps(['a', 'b', 'c'], 'bottom', trio);
    // bottom edge = 120+100 = 220
    expect(bottom.get('a')).toEqual({ y: 170 });
    expect(bottom.get('c')).toEqual({ y: 120 });
  });

  it('centerX / centerY center on the bounding box', () => {
    const cx = alignOps(['a', 'b', 'c'], 'centerX', trio);
    // bounds: minX 0, maxX 250 → center 125
    expect(cx.get('a')).toEqual({ x: 75 });   // 125 - 100/2
    expect(cx.get('b')).toEqual({ x: 100 });  // 125 - 50/2
    const cy = alignOps(['a', 'b', 'c'], 'centerY', trio);
    // minY 0, maxY 220 → center 110
    expect(cy.get('a')).toEqual({ y: 85 });   // 110 - 50/2
    expect(cy.get('c')).toEqual({ y: 60 });   // 110 - 100/2
  });

  it('distribute-h spaces centers evenly, extremes pinned', () => {
    const out = alignOps(['a', 'b', 'c'], 'distribute-h', trio);
    // centers: a=50, b=225, c=100 → ordered a,c,b; span 175; step 87.5
    expect(out.get('a')).toBeUndefined();
    expect(out.get('b')).toBeUndefined();
    expect(out.get('c')).toEqual({ x: 137.5 - 40 }); // center 137.5 - w/2
  });

  it('distribute-v likewise on y', () => {
    const out = alignOps(['a', 'b', 'c'], 'distribute-v', trio);
    // centers: a=25, b=65, c=170 → ordered a,b,c; span 145; step 72.5
    expect(out.get('b')).toEqual({ y: 25 + 72.5 - 25 });
  });

  it('needs ≥2 items and skips connectors', () => {
    expect(alignOps(['a'], 'left', trio).size).toBe(0);
    const withConn = [...trio, item('k', { type: 'connector', from: 'a', to: 'b' })];
    expect(alignOps(['a', 'k'], 'left', withConn).size).toBe(0);
  });
});

describe('frameMembership', () => {
  it('assigns by largest overlap; frames never nest; connectors ignored', () => {
    const items = [
      item('big', { type: 'frame', x: 0, y: 0, w: 400, h: 400 }),
      item('small', { type: 'frame', x: 50, y: 50, w: 200, h: 200 }),
      item('inside-small', { x: 60, y: 60, w: 50, h: 50 }),   // fully in small
      item('straddle', { x: 150, y: 150, w: 300, h: 100 }),   // overlaps both, more in big
      item('outside', { x: 1000, y: 1000 }),
      item('conn', { type: 'connector', from: 'inside-small', to: 'outside' }),
    ];
    const m = frameMembership(items);
    expect(m.get('inside-small')).toBe('small');
    expect(m.get('straddle')).toBe('big'); // 100*100 in small vs 250*100 in big
    expect(m.get('outside')).toBeNull();
    expect(m.has('big')).toBe(false);   // frames can't be members
    expect(m.has('conn')).toBe(false);  // connectors have no geometry
  });
});

describe('connectorAnchors', () => {
  it('picks facing edge midpoints horizontally', () => {
    const a = item('a', { x: 0, y: 0, w: 100, h: 100 });
    const b = item('b', { x: 300, y: 0, w: 100, h: 100 });
    const { from, to } = connectorAnchors(a, b);
    expect(from).toEqual({ x: 100, y: 50, side: 'right' });
    expect(to).toEqual({ x: 300, y: 50, side: 'left' });
  });
  it('and vertically when dy dominates', () => {
    const a = item('a', { x: 0, y: 0, w: 100, h: 100 });
    const b = item('b', { x: 10, y: 400, w: 100, h: 100 });
    const { from, to } = connectorAnchors(a, b);
    expect(from.side).toBe('bottom');
    expect(to.side).toBe('top');
    expect(from).toMatchObject({ x: 50, y: 100 });
    expect(to).toMatchObject({ x: 60, y: 400 });
  });
  it('reverses for left/up targets', () => {
    const a = item('a', { x: 500, y: 500, w: 100, h: 100 });
    const b = item('b', { x: 0, y: 500, w: 100, h: 100 });
    const { from, to } = connectorAnchors(a, b);
    expect(from.side).toBe('left');
    expect(to.side).toBe('right');
  });
});

describe('normalizeItem', () => {
  it('fills numeric + per-type defaults', () => {
    const n = normalizeItem({ id: 'x', type: 'card' });
    expect(n).toMatchObject({ x: 0, y: 0, z: 0, w: 260, h: 140 });
  });
  it('zeroes connector geometry and defaults style/arrow', () => {
    const n = normalizeItem({ id: 'x', type: 'connector', x: 50, w: 99, from: 'a', to: 'b' });
    expect(n).toMatchObject({ x: 0, y: 0, w: 0, h: 0, style: 'solid', arrow: 'end' });
  });
  it('coerces unknown types to note and bad shapes to rect', () => {
    expect(normalizeItem({ id: 'x', type: 'bogus' as never }).type).toBe('note');
    expect(normalizeItem({ id: 'x', type: 'shape' }).shape).toBe('rect');
    expect(normalizeItem({ id: 'x', type: 'shape', shape: 'pill' }).shape).toBe('pill');
  });
});

describe('cullItems', () => {
  const items = [
    item('near', { x: 0, y: 0 }),
    item('far', { x: 5000, y: 5000 }),
    item('edge', { x: 120, y: 0 }),   // inside 1.5x margin: region x ∈ [-25,125]
    item('conn-visible', { type: 'connector', from: 'near', to: 'far' }),
    item('conn-hidden', { type: 'connector', from: 'far', to: 'far2' }),
    item('far2', { x: 9000, y: 9000 }),
    item('selected-far', { x: 8000, y: 8000 }),
  ];
  const view = { x: 0, y: 0, w: 100, h: 100 };

  it('keeps viewport + margin, drops the rest', () => {
    const out = cullItems(items, view, 1.5).map((i) => i.id);
    expect(out).toContain('near');
    expect(out).toContain('edge');
    expect(out).toContain('conn-visible'); // 'near' endpoint is kept
    expect(out).not.toContain('far');
    expect(out).not.toContain('far2');
    expect(out).not.toContain('conn-hidden'); // no kept endpoint
    expect(out).not.toContain('selected-far');
  });

  it('preserves selected/editing ids and their connectors', () => {
    const out = cullItems(items, view, 1.5, new Set(['selected-far'])).map((i) => i.id);
    expect(out).toContain('selected-far');
  });

  it('margin factor widens the kept region', () => {
    const tight = cullItems(items, view, 1).map((i) => i.id);
    expect(tight).not.toContain('edge'); // x=149 beyond w=100
    const wide = cullItems(items, view, 2).map((i) => i.id);
    expect(wide).toContain('edge');
  });
});
