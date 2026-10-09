import { describe, expect, it } from 'vitest';
import { layoutBoard } from '../shared/canvasLayout';
import type { MoodItem } from '../shared/mooditems';

const item = (id: string, data: Partial<MoodItem> = {}): MoodItem => ({
  id,
  type: 'note',
  x: 0,
  y: 0,
  w: 100,
  h: 50,
  z: 0,
  ...data,
});

describe('layoutBoard — grid', () => {
  it('packs rows left→right, wraps at width, sorted by z then id', () => {
    const items = [
      item('z2', { z: 2 }),
      item('z1b', { z: 1 }),
      item('z1a', { z: 1 }),
    ];
    const out = layoutBoard(items, 'grid', { gap: 24, wrapWidth: 1600 });
    expect(out.get('z1a')).toEqual({ x: 0, y: 0, w: 100, h: 50 });
    expect(out.get('z1b')).toEqual({ x: 124, y: 0, w: 100, h: 50 });
    expect(out.get('z2')).toEqual({ x: 248, y: 0, w: 100, h: 50 });
  });

  it('wraps to a new row at the wrap width', () => {
    const items = [item('a'), item('b'), item('c')];
    const out = layoutBoard(items, 'grid', { gap: 24, wrapWidth: 250 });
    expect(out.get('a')!.x).toBe(0);
    expect(out.get('b')!.x).toBe(124); // 124+100=224 ≤ 250 fits
    expect(out.get('c')).toMatchObject({ x: 0, y: 74 }); // wrapped: rowH 50 + gap 24
  });

  it('skips connectors and deleted items', () => {
    const items = [
      item('a'),
      item('conn', { type: 'connector', from: 'a', to: 'b' }),
      item('b'),
      item('gone', { deleted: true }),
    ];
    const out = layoutBoard(items, 'grid');
    expect([...out.keys()].sort()).toEqual(['a', 'b']);
  });
});

describe('layoutBoard — flow-lr', () => {
  it('layers connected items left→right by connector edges', () => {
    const items = [
      item('a'),
      item('b'),
      item('c'),
      item('k1', { type: 'connector', from: 'a', to: 'b' }),
      item('k2', { type: 'connector', from: 'b', to: 'c' }),
    ];
    const out = layoutBoard(items, 'flow-lr', { gap: 24 });
    const pitch = 100 + 24; // maxW + gap
    expect(out.get('a')!.x).toBe(0);
    expect(out.get('b')!.x).toBe(pitch);
    expect(out.get('c')!.x).toBe(pitch * 2);
  });

  it('disconnected items share rank 0 and never overlap', () => {
    const items = [
      item('lonely'),
      item('a'),
      item('b'),
      item('k', { type: 'connector', from: 'a', to: 'b' }),
    ];
    const out = layoutBoard(items, 'flow-lr', { gap: 24 });
    const ys = new Set<number>();
    for (const id of ['lonely', 'a']) {
      const p = out.get(id)!;
      expect(p.x).toBe(0);
      expect(ys.has(p.y)).toBe(false);
      ys.add(p.y);
    }
    expect(out.get('b')!.x).toBe(124);
  });

  it('falls back to grid on connector cycles', () => {
    const items = [
      item('a'),
      item('b'),
      item('k1', { type: 'connector', from: 'a', to: 'b' }),
      item('k2', { type: 'connector', from: 'b', to: 'a' }),
    ];
    expect(layoutBoard(items, 'flow-lr')).toEqual(layoutBoard(items, 'grid'));
  });
});

describe('layoutBoard — by-frame', () => {
  it('packs members inside their frame in reading order', () => {
    const frame = item('f', { type: 'frame', x: 100, y: 100, w: 400, h: 300 });
    const m1 = item('m1', { x: 999, y: 999, parentFrameId: 'f' });
    const m2 = item('m2', { x: 5, y: 5, parentFrameId: 'f' });
    const outsider = item('o', { x: 700, y: 700 });
    const out = layoutBoard([frame, m1, m2, outsider], 'by-frame', { gap: 24, framePad: 24 });
    // Frame keeps its bounds; members pack inside at x=124, next at 124+100+24
    expect(out.get('f')).toEqual({ x: 100, y: 100, w: 400, h: 300 });
    const p1 = out.get('m2')!; // reading order: m2 sorts before m1? positions (5,5) vs (999,999) → m2 first
    expect(p1).toEqual({ x: 124, y: 124, w: 100, h: 50 });
    expect(out.get('m1')).toEqual({ x: 248, y: 124, w: 100, h: 50 });
    expect(out.get('o')).toEqual({ x: 700, y: 700, w: 100, h: 50 }); // unchanged
  });

  it('wraps members inside the frame width', () => {
    const frame = item('f', { type: 'frame', x: 0, y: 0, w: 180, h: 300 });
    const items = [frame, item('a', { parentFrameId: 'f' }), item('b', { parentFrameId: 'f' }), item('c', { parentFrameId: 'f' })];
    const out = layoutBoard(items, 'by-frame', { gap: 10, framePad: 10 });
    expect(out.get('a')).toMatchObject({ x: 10, y: 10 });
    // inner width = 180-20=160; second item at 10+110=120 + w100 → wraps (120+100>170)
    expect(out.get('b')).toMatchObject({ x: 10, y: 70 });
    expect(out.get('c')).toMatchObject({ x: 10, y: 130 });
  });
});

describe('layoutBoard — by-stage', () => {
  const laneOf = (it: MoodItem) => (it.status as string | undefined) ?? null;
  it('places items under their status lane, unknown lane last', () => {
    const items = [
      item('todo1', { status: 's-todo' }),
      item('done1', { status: 's-done' }),
      item('todo2', { status: 's-todo' }),
      item('mystery', {}),
      item('gone-lane', { status: 's-removed' }),
    ];
    const out = layoutBoard(items, 'by-stage', {
      lanes: ['s-todo', 's-doing', 's-done'],
      laneOf,
      gap: 24,
    });
    const laneW = 100 + 24;
    expect(out.get('todo1')).toMatchObject({ x: 0, y: 0 });
    expect(out.get('todo2')).toMatchObject({ x: 0, y: 74 });
    expect(out.get('done1')).toMatchObject({ x: laneW * 2, y: 0 });
    // unknown + missing lanes land in the trailing lane (index 3)
    expect(out.get('mystery')).toMatchObject({ x: laneW * 3 });
    expect(out.get('gone-lane')).toMatchObject({ x: laneW * 3 });
  });

  it('falls back to grid without lanes or laneOf', () => {
    const items = [item('a'), item('b')];
    expect(layoutBoard(items, 'by-stage')).toEqual(layoutBoard(items, 'grid'));
    expect(layoutBoard(items, 'by-stage', { lanes: ['x'] })).toEqual(layoutBoard(items, 'grid'));
  });
});

describe('determinism', () => {
  it('every algorithm is stable across runs and input order', () => {
    const items = [
      item('a', { z: 2 }),
      item('b', { z: 1 }),
      item('c', { z: 3 }),
      item('k', { type: 'connector', from: 'a', to: 'b' }),
      item('f', { type: 'frame', z: 0, w: 400, h: 300 }),
      item('m', { z: 4, parentFrameId: 'f' }),
    ];
    for (const algo of ['grid', 'flow-lr', 'by-frame', 'by-stage'] as const) {
      const opts = algo === 'by-stage' ? { lanes: ['s'], laneOf: () => 's' } : {};
      const first = layoutBoard(items, algo, opts);
      const reversed = layoutBoard([...items].reverse(), algo, opts);
      expect(reversed).toEqual(first);
      expect(layoutBoard(items, algo, opts)).toEqual(first);
    }
  });
});
