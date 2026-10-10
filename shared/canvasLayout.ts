/* Board auto-layout (Phase 2 §2, §5 `layout_moodboard`): shared by the MCP
 * tool and the client "tidy" action so both produce identical geometry.
 * Fully deterministic — same items in, same positions out. Connectors carry
 * no geometry and are never positioned (they derive from endpoints). */

import { itemBounds, type MoodItem, type Rect } from './mooditems';

export type CanvasLayoutAlgorithm = 'grid' | 'flow-lr' | 'by-frame' | 'by-stage';

export interface CanvasLayoutOpts {
  /** Gap between items in px (all algorithms). Default 24. */
  gap?: number;
  /** Row wrap width for 'grid' / inner width cap for 'by-frame'. Default 1600. */
  wrapWidth?: number;
  /** Inner padding inside frames for 'by-frame'. Default 24. */
  framePad?: number;
  /** 'by-stage': ordered stage/column ids, left to right. */
  lanes?: readonly string[];
  /** 'by-stage': stage id a card item belongs under (resolved from its record). */
  laneOf?: (item: MoodItem) => string | null | undefined;
}

const DEFAULT_GAP = 24;
const DEFAULT_WRAP = 1600;
const DEFAULT_PAD = 24;

const byZThenId = (a: MoodItem, b: MoodItem): number =>
  (a.z ?? 0) - (b.z ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function positionable(items: readonly MoodItem[]): MoodItem[] {
  return items.filter((it) => !it.deleted && it.type !== 'connector' && typeof it.id === 'string');
}

function grid(items: readonly MoodItem[], gap: number, wrap: number): Map<string, Rect> {
  const out = new Map<string, Rect>();
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const it of [...items].sort(byZThenId)) {
    const b = itemBounds(it);
    if (x > 0 && x + b.w > wrap) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    out.set(it.id, { x, y, w: b.w, h: b.h });
    x += b.w + gap;
    rowH = Math.max(rowH, b.h);
  }
  return out;
}

/** Longest-path ranks over the connector DAG (from → to). Null on a cycle. */
function flowRanks(items: readonly MoodItem[], connectors: readonly MoodItem[]): Map<string, number> | null {
  const ids = new Set(items.map((it) => it.id));
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const it of items) {
    preds.set(it.id, []);
    succs.set(it.id, []);
    indeg.set(it.id, 0);
  }
  for (const c of connectors) {
    if (!c.from || !c.to || c.from === c.to || !ids.has(c.from) || !ids.has(c.to)) continue;
    succs.get(c.from)!.push(c.to);
    preds.get(c.to)!.push(c.from);
    indeg.set(c.to, indeg.get(c.to)! + 1);
  }
  const ranks = new Map<string, number>();
  const queue = [...items].sort(byZThenId).map((i) => i.id).filter((id) => indeg.get(id) === 0);
  let processed = 0;
  while (queue.length) {
    queue.sort();
    const id = queue.shift()!;
    processed++;
    let rank = 0;
    for (const p of preds.get(id)!.sort()) rank = Math.max(rank, (ranks.get(p) ?? -1) + 1);
    ranks.set(id, rank);
    for (const s of succs.get(id)!.sort()) {
      indeg.set(s, indeg.get(s)! - 1);
      if (indeg.get(s) === 0) queue.push(s);
    }
  }
  if (processed < items.length) return null;
  return ranks;
}

/**
 * Compute a full-board layout. Returns id → {x,y,w,h} for every non-connector
 * item. 'flow-lr' falls back to 'grid' when the connector graph has a cycle;
 * 'by-stage' falls back to 'grid' without lanes/laneOf.
 */
export function layoutBoard(
  items: readonly MoodItem[],
  algorithm: CanvasLayoutAlgorithm,
  opts: CanvasLayoutOpts = {},
): Map<string, Rect> {
  const gap = opts.gap ?? DEFAULT_GAP;
  const wrap = opts.wrapWidth ?? DEFAULT_WRAP;
  const place = positionable(items);

  switch (algorithm) {
    case 'grid':
      return grid(place, gap, wrap);

    case 'flow-lr': {
      const connectors = items.filter((it) => !it.deleted && it.type === 'connector');
      const ranks = flowRanks(place, connectors);
      if (!ranks) return grid(place, gap, wrap); // cycles → plain grid
      const maxW = Math.max(1, ...place.map((it) => itemBounds(it).w));
      const maxH = Math.max(1, ...place.map((it) => itemBounds(it).h));
      const layers = new Map<number, MoodItem[]>();
      for (const it of place) {
        const r = ranks.get(it.id) ?? 0;
        const list = layers.get(r) ?? [];
        list.push(it);
        layers.set(r, list);
      }
      const out = new Map<string, Rect>();
      for (const [rank, layer] of layers) {
        layer.sort(byZThenId);
        layer.forEach((it, i) => {
          const b = itemBounds(it);
          out.set(it.id, { x: rank * (maxW + gap), y: i * (maxH + gap), w: b.w, h: b.h });
        });
      }
      return out;
    }

    case 'by-frame': {
      const pad = opts.framePad ?? DEFAULT_PAD;
      const out = new Map<string, Rect>();
      const frames = place.filter((it) => it.type === 'frame').sort(byZThenId);
      const frameIds = new Set(frames.map((f) => f.id));
      const members = new Map<string, MoodItem[]>();
      for (const it of place) {
        if (it.type === 'frame') {
          out.set(it.id, itemBounds(it));
          continue;
        }
        const fid = typeof it.parentFrameId === 'string' ? it.parentFrameId : null;
        if (fid && frameIds.has(fid)) {
          const list = members.get(fid) ?? [];
          list.push(it);
          members.set(fid, list);
        } else {
          out.set(it.id, itemBounds(it)); // ungrouped items stay put
        }
      }
      for (const f of frames) {
        const fb = itemBounds(f);
        const list = members.get(f.id) ?? [];
        // Reading order: top→bottom, left→right, id as the final tie-break.
        list.sort((a, b2) => {
          const ab = itemBounds(a);
          const bb = itemBounds(b2);
          return ab.y - bb.y || ab.x - bb.x || (a.id < b2.id ? -1 : a.id > b2.id ? 1 : 0);
        });
        const x0 = fb.x + pad;
        const maxX = fb.x + fb.w - pad;
        let x = x0;
        let y = fb.y + pad;
        let rowH = 0;
        for (const m of list) {
          const b = itemBounds(m);
          if (x > x0 && x + b.w > maxX) {
            x = x0;
            y += rowH + gap;
            rowH = 0;
          }
          out.set(m.id, { x, y, w: b.w, h: b.h });
          x += b.w + gap;
          rowH = Math.max(rowH, b.h);
        }
      }
      return out;
    }

    case 'by-stage': {
      const lanes = opts.lanes ?? [];
      const laneOf = opts.laneOf;
      if (!lanes.length || !laneOf) return grid(place, gap, wrap);
      const laneIdx = new Map(lanes.map((id, i) => [id, i] as const));
      const unknown = lanes.length; // items without a matching stage land in a trailing lane
      const groups = new Map<number, MoodItem[]>();
      for (const it of place) {
        const lane = laneOf(it);
        const idx = lane != null ? (laneIdx.get(lane) ?? unknown) : unknown;
        const list = groups.get(idx) ?? [];
        list.push(it);
        groups.set(idx, list);
      }
      const maxW = Math.max(1, ...place.map((it) => itemBounds(it).w));
      const out = new Map<string, Rect>();
      for (const [idx, group] of groups) {
        group.sort(byZThenId);
        let y = 0;
        for (const it of group) {
          const b = itemBounds(it);
          out.set(it.id, { x: idx * (maxW + gap), y, w: b.w, h: b.h });
          y += b.h + gap;
        }
      }
      return out;
    }
  }
}
