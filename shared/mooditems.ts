/* Mood-item model + pure geometry helpers (Phase 2 §1.1, §3): shared by the
 * client canvas, worker MCP tools and tests. Records are schemaless JSON —
 * every read is defensive and `normalizeItem` fills per-type defaults.
 * Connectors carry no geometry: x/y/w/h are ignored and bounds derive from
 * their endpoints at render time. */

import type { DiagramSpec } from './diagramLayout';

export type MoodItemType =
  | 'image' | 'note' | 'text' | 'color'            // Phase 0/1
  | 'card' | 'frame' | 'shape' | 'svg' | 'diagram' | 'connector'; // Phase 2

export type ItemRef = { type: 'record' | 'page'; id: string };

export interface MoodItem {
  id: string;
  boardId?: string;
  type: MoodItemType;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  z?: number;
  deleted?: boolean;
  // image / svg
  fileId?: string;
  // note / text / color / shape
  text?: string;
  color?: string;
  // card (legacy `taskId` reads as ref {type:'record'})
  ref?: ItemRef;
  taskId?: string;
  // frame
  title?: string;
  frameStageOf?: { databaseId: string; stageId: string } | null;
  // shape
  shape?: 'rect' | 'ellipse' | 'diamond' | 'pill';
  fill?: string;
  stroke?: string;
  // diagram
  spec?: DiagramSpec;
  // connector
  from?: string;
  to?: string;
  label?: string;
  style?: 'solid' | 'dashed';
  arrow?: 'end' | 'both' | 'none';
  linkKind?: 'blocks' | 'related' | null;
  linkId?: string | null;
  /** False when the connector adopted a `links` row that already existed —
   * deleting/restoring it must not touch the shared row. Legacy rows have no
   * flag: they are treated as owners (see `connectorRetiresLink`). */
  linkOwned?: boolean;
  // membership (computed on drop, stored)
  parentFrameId?: string | null;
  [key: string]: unknown;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type AlignOp = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom';
export type DistributeOp = 'distribute-h' | 'distribute-v';
export type GeometryOp = AlignOp | DistributeOp;

/** Per-type default sizes when a row lacks w/h. */
export const DEFAULT_ITEM_SIZE: Record<MoodItemType, { w: number; h: number }> = {
  image: { w: 320, h: 240 },
  note: { w: 200, h: 160 },
  text: { w: 240, h: 80 },
  color: { w: 120, h: 120 },
  card: { w: 260, h: 140 },
  frame: { w: 480, h: 320 },
  shape: { w: 180, h: 120 },
  svg: { w: 240, h: 240 },
  diagram: { w: 480, h: 320 },
  connector: { w: 0, h: 0 },
};

const MOOD_ITEM_TYPES = new Set<string>([
  'image', 'note', 'text', 'color', 'card', 'frame', 'shape', 'svg', 'diagram', 'connector',
]);

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Card target: explicit `ref` wins; legacy `taskId` degrades to a record ref. */
export function cardRef(item: Pick<MoodItem, 'ref' | 'taskId'>): ItemRef | null {
  const r = item.ref;
  if (r && (r.type === 'record' || r.type === 'page') && typeof r.id === 'string' && r.id) {
    return { type: r.type, id: r.id };
  }
  if (typeof item.taskId === 'string' && item.taskId) return { type: 'record', id: item.taskId };
  return null;
}

/** Stored geometry with per-type defaults applied. */
export function itemBounds(item: MoodItem): Rect {
  const d = DEFAULT_ITEM_SIZE[item.type] ?? { w: 160, h: 120 };
  return {
    x: num(item.x, 0),
    y: num(item.y, 0),
    w: Math.max(0, num(item.w, d.w)),
    h: Math.max(0, num(item.h, d.h)),
  };
}

/** Strict area overlap — edge-touching alone does not count. */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

const byZThenId = (a: MoodItem, b: MoodItem): number =>
  num(a.z, 0) - num(b.z, 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Live, geometric items (connectors carry no bounds) whose rect overlaps `rect`. */
export function itemsInRect(items: readonly MoodItem[], rect: Rect): MoodItem[] {
  return items.filter(
    (it) => !it.deleted && it.type !== 'connector' && rectsIntersect(itemBounds(it), rect),
  );
}

/** Marquee selection: ids of items touched by the dragged rect, ordered z then id. */
export function marqueeSelect(items: readonly MoodItem[], rect: Rect): string[] {
  return itemsInRect(items, rect).sort(byZThenId).map((it) => it.id);
}

/**
 * Per-id geometry patches for an align or distribute op over `selectedIds`.
 * Align anchors to the selection's bounding box; distribute keeps the two
 * extreme items pinned and spaces the centers of the rest evenly.
 */
export function alignOps(
  selectedIds: Iterable<string>,
  op: GeometryOp,
  items: readonly MoodItem[],
): Map<string, { x?: number; y?: number }> {
  const out = new Map<string, { x?: number; y?: number }>();
  const wanted = new Set(selectedIds);
  const sel = items.filter((it) => wanted.has(it.id) && !it.deleted && it.type !== 'connector');
  if (sel.length < 2) return out;
  const b = new Map(sel.map((it) => [it.id, itemBounds(it)] as const));
  const minX = Math.min(...sel.map((it) => b.get(it.id)!.x));
  const minY = Math.min(...sel.map((it) => b.get(it.id)!.y));
  const maxX = Math.max(...sel.map((it) => b.get(it.id)!.x + b.get(it.id)!.w));
  const maxY = Math.max(...sel.map((it) => b.get(it.id)!.y + b.get(it.id)!.h));
  switch (op) {
    case 'left':
      for (const it of sel) out.set(it.id, { x: minX });
      break;
    case 'right':
      for (const it of sel) out.set(it.id, { x: maxX - b.get(it.id)!.w });
      break;
    case 'centerX': {
      const c = (minX + maxX) / 2;
      for (const it of sel) out.set(it.id, { x: c - b.get(it.id)!.w / 2 });
      break;
    }
    case 'top':
      for (const it of sel) out.set(it.id, { y: minY });
      break;
    case 'bottom':
      for (const it of sel) out.set(it.id, { y: maxY - b.get(it.id)!.h });
      break;
    case 'centerY': {
      const c = (minY + maxY) / 2;
      for (const it of sel) out.set(it.id, { y: c - b.get(it.id)!.h / 2 });
      break;
    }
    case 'distribute-h':
    case 'distribute-v': {
      const horizontal = op === 'distribute-h';
      if (sel.length < 3) break; // two extremes are already the distribution
      const center = (it: MoodItem) => {
        const r = b.get(it.id)!;
        return horizontal ? r.x + r.w / 2 : r.y + r.h / 2;
      };
      const ordered = [...sel].sort((a, z) => center(a) - center(z) || (a.id < z.id ? -1 : 1));
      const first = ordered[0];
      const last = ordered[ordered.length - 1];
      const span = center(last) - center(first);
      const step = span / (ordered.length - 1);
      ordered.forEach((it, i) => {
        if (i === 0 || i === ordered.length - 1) return;
        const r = b.get(it.id)!;
        const c = center(first) + step * i;
        out.set(it.id, horizontal ? { x: c - r.w / 2 } : { y: c - r.h / 2 });
      });
      break;
    }
  }
  return out;
}

/**
 * Frame membership from geometry: every non-frame, non-connector item belongs
 * to the frame whose rect has the largest positive overlap with it (ties go to
 * the lower id). Frames never nest inside frames. Returns id → frameId|null
 * for every membership-eligible item.
 */
export function frameMembership(items: readonly MoodItem[]): Map<string, string | null> {
  const frames = items
    .filter((it) => !it.deleted && it.type === 'frame')
    .sort(byZThenId)
    .map((f) => ({ id: f.id, rect: itemBounds(f) }));
  const out = new Map<string, string | null>();
  for (const it of items) {
    if (it.deleted || it.type === 'frame' || it.type === 'connector') continue;
    const r = itemBounds(it);
    let best: string | null = null;
    let bestArea = 0;
    let bestFrameArea = Infinity;
    for (const f of frames) {
      const area = overlapArea(r, f.rect);
      if (area <= 0) continue;
      const frameArea = f.rect.w * f.rect.h;
      // Largest overlap wins; ties go to the more specific (smaller) frame, then lower id.
      if (area > bestArea || (area === bestArea && (frameArea < bestFrameArea || (frameArea === bestFrameArea && best !== null && f.id < best)))) {
        best = f.id;
        bestArea = area;
        bestFrameArea = frameArea;
      }
    }
    out.set(it.id, best);
  }
  return out;
}

export interface Anchor {
  x: number;
  y: number;
  side: 'left' | 'right' | 'top' | 'bottom';
}

/** Edge-midpoint anchor points: endpoints attach to the sides facing each other. */
export function connectorAnchors(fromItem: MoodItem, toItem: MoodItem): { from: Anchor; to: Anchor } {
  const a = itemBounds(fromItem);
  const b = itemBounds(toItem);
  const acx = a.x + a.w / 2;
  const acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2;
  const bcy = b.y + b.h / 2;
  const dx = bcx - acx;
  const dy = bcy - acy;
  const fromSide: Anchor['side'] =
    Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : dy >= 0 ? 'bottom' : 'top';
  const toSide: Anchor['side'] =
    fromSide === 'right' ? 'left' : fromSide === 'left' ? 'right' : fromSide === 'bottom' ? 'top' : 'bottom';
  const mid = (r: Rect, side: Anchor['side']): { x: number; y: number } =>
    side === 'left'
      ? { x: r.x, y: r.y + r.h / 2 }
      : side === 'right'
        ? { x: r.x + r.w, y: r.y + r.h / 2 }
        : side === 'top'
          ? { x: r.x + r.w / 2, y: r.y }
          : { x: r.x + r.w / 2, y: r.y + r.h };
  return {
    from: { ...mid(a, fromSide), side: fromSide },
    to: { ...mid(b, toSide), side: toSide },
  };
}

/**
 * Canonical item shape: id + valid type, numeric x/y/z, per-type default w/h,
 * connector geometry zeroed (it is derived from endpoints), type defaults for
 * shape/connector subfields. Unknown types coerce to 'note'.
 */
export function normalizeItem(item: Partial<MoodItem> & { id: string }): MoodItem {
  const type = (typeof item.type === 'string' && MOOD_ITEM_TYPES.has(item.type)
    ? item.type
    : 'note') as MoodItemType;
  const d = DEFAULT_ITEM_SIZE[type];
  const out: MoodItem = {
    ...item,
    type,
    x: num(item.x, 0),
    y: num(item.y, 0),
    z: num(item.z, 0),
    w: Math.max(0, num(item.w, d.w)),
    h: Math.max(0, num(item.h, d.h)),
  };
  if (type === 'connector') {
    out.x = 0;
    out.y = 0;
    out.w = 0;
    out.h = 0;
    if (out.style !== 'solid' && out.style !== 'dashed') out.style = 'solid';
    if (out.arrow !== 'end' && out.arrow !== 'both' && out.arrow !== 'none') out.arrow = 'end';
  }
  if (type === 'shape' && out.shape !== 'ellipse' && out.shape !== 'diamond' && out.shape !== 'pill') {
    out.shape = 'rect';
  }
  return out;
}

/**
 * Whether deleting/restoring `connector` should also retire/restore its
 * mirrored `links` row. True only when the connector owns the row
 * (`linkOwned !== false`) AND no *other* live connector on the board
 * references the same linkId — a link a user created first, or one shared
 * by a second connector, must survive.
 */
export function connectorRetiresLink(connector: Pick<MoodItem, 'linkId' | 'linkOwned'>, otherConnectors: readonly Pick<MoodItem, 'id' | 'linkId' | 'deleted'>[], connectorId: string): boolean {
  if (!connector.linkId) return false;
  if (connector.linkOwned === false) return false;
  return !otherConnectors.some((c) => c.id !== connectorId && !c.deleted && c.linkId === connector.linkId);
}

/**
 * Render set for a viewport: items intersecting `worldRect` expanded by
 * `marginFactor` (1.5 = 50% bleed all round), every id in `keepIds`
 * (selected/editing items are never culled), and connectors with at least one
 * kept endpoint. Input order is preserved; deleted rows are dropped.
 */
export function cullItems(
  items: readonly MoodItem[],
  worldRect: Rect,
  marginFactor = 1.5,
  keepIds?: ReadonlySet<string>,
): MoodItem[] {
  const f = Math.max(1, marginFactor);
  const region: Rect = {
    x: worldRect.x - (worldRect.w * (f - 1)) / 2,
    y: worldRect.y - (worldRect.h * (f - 1)) / 2,
    w: worldRect.w * f,
    h: worldRect.h * f,
  };
  const keep = new Set<string>();
  for (const it of items) {
    if (it.deleted || it.type === 'connector') continue;
    if (keepIds?.has(it.id) || rectsIntersect(itemBounds(it), region)) keep.add(it.id);
  }
  for (const it of items) {
    if (it.deleted || it.type !== 'connector') continue;
    if (
      keepIds?.has(it.id) ||
      (typeof it.from === 'string' && keep.has(it.from)) ||
      (typeof it.to === 'string' && keep.has(it.to))
    ) {
      keep.add(it.id);
    }
  }
  return items.filter((it) => keep.has(it.id));
}
