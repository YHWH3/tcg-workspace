import { useLiveQuery } from 'dexie-react-hooks';
import { db, type LocalRow } from '../../core/db';
import { addFile } from '../../core/files';
import { mutate } from '../../core/sync/engine';
import { uuid } from '../../core/utils';
import { link, linkId, unlink } from '../../core/links';
import { sanitizeSvg } from '../../../shared/svgSanitize';
import { validateDiagramSpec } from '../../../shared/diagramLayout';
import {
  cardRef,
  connectorLinkPlan,
  itemBounds,
  normalizeItem,
  type ItemRef,
  type MoodItem as SharedMoodItem,
  type MoodItemType,
} from '../../../shared/mooditems';

export type { ItemRef, MoodItemType };
export type MoodItem = LocalRow & SharedMoodItem;

export const NOTE_COLORS = ['#fef3c7', '#fce7f3', '#dbeafe', '#dcfce7', '#ede9fe'];

export function useMoodboards(): LocalRow[] {
  return (useLiveQuery(() => db.moodboards.filter((b) => !b.deleted).sortBy('order'), [], []) ?? []) as LocalRow[];
}

export function useMoodItems(boardId: string | undefined): MoodItem[] {
  return (
    useLiveQuery(
      () =>
        boardId
          ? (db.mooditems
              .where('boardId')
              .equals(boardId)
              .filter((i) => !i.deleted)
              .toArray() as unknown as Promise<MoodItem[]>)
          : Promise.resolve([] as MoodItem[]),
      [boardId],
      [],
    ) ?? []
  ) as MoodItem[];
}

export async function createMoodboard(title = 'Untitled board'): Promise<string> {
  const id = uuid();
  const user = (await import('../../core/auth')).authStore.get().user;
  await mutate('moodboards', id, {
    title,
    icon: '🎨',
    order: String(Date.now()),
    createdBy: user?.id,
    createdAt: Date.now(),
  });
  return id;
}

export async function addMoodItem(boardId: string, patch: Partial<MoodItem>): Promise<string> {
  const id = uuid();
  const items = await db.mooditems.where('boardId').equals(boardId).toArray();
  const z = Math.max(0, ...items.map((i) => Number(i.z ?? 0))) + 1;
  await mutate('mooditems', id, normalizeItem({ id, boardId, z, ...patch }));
  return id;
}

/* ---------- Phase 2 item writers ---------- */

export async function addCard(boardId: string, ref: ItemRef, geom: { x: number; y: number; w?: number; h?: number }): Promise<string> {
  return addMoodItem(boardId, { type: 'card', ref, x: geom.x, y: geom.y, w: geom.w ?? 260, h: geom.h ?? 140 });
}

export async function addFrame(
  boardId: string,
  opts: { x: number; y: number; w?: number; h?: number; title?: string; frameStageOf?: { databaseId: string; stageId: string } | null; memberIds?: string[] },
): Promise<string> {
  const id = await addMoodItem(boardId, {
    type: 'frame',
    x: opts.x,
    y: opts.y,
    w: opts.w ?? 480,
    h: opts.h ?? 320,
    title: opts.title ?? 'Frame',
    frameStageOf: opts.frameStageOf ?? null,
    z: 0, // frames sit behind items
  });
  if (opts.memberIds?.length) {
    for (const mid of opts.memberIds) await mutate('mooditems', mid, { parentFrameId: id });
  }
  return id;
}

export async function addShape(
  boardId: string,
  shape: NonNullable<MoodItem['shape']>,
  geom: { x: number; y: number; w?: number; h?: number },
  style?: { fill?: string; stroke?: string; text?: string },
): Promise<string> {
  return addMoodItem(boardId, {
    type: 'shape',
    shape,
    x: geom.x,
    y: geom.y,
    w: geom.w ?? (shape === 'pill' ? 220 : 180),
    h: geom.h ?? 120,
    fill: style?.fill ?? '#e0e7ff',
    stroke: style?.stroke ?? '#6366f1',
    text: style?.text ?? '',
  });
}

/** Sanitize client-side (the worker re-sanitizes — belt & braces) then store as a file + item. */
export async function addSvg(boardId: string, input: Blob | File, name: string, geom: { x: number; y: number }): Promise<{ id?: string; error?: string }> {
  const text = await input.text();
  const res = sanitizeSvg(text);
  if (!res.ok) return { error: `SVG rejected: ${res.reasons.join(', ')}` };
  const id = await addMoodItem(boardId, { type: 'svg', x: geom.x, y: geom.y, w: 240, h: 240 });
  const fileId = await addFile(new Blob([res.svg], { type: 'image/svg+xml' }), { parentType: 'mooditem', parentId: id, name: name || 'image.svg' });
  await mutate('mooditems', id, { fileId });
  return { id };
}

export async function addDiagram(boardId: string, spec: unknown, geom: { x: number; y: number; w?: number; h?: number }): Promise<{ id?: string; error?: string }> {
  const v = validateDiagramSpec(spec);
  if (!v.ok) return { error: `Invalid diagram: ${v.reasons.join(', ')}` };
  const id = await addMoodItem(boardId, { type: 'diagram', spec: v.spec, x: geom.x, y: geom.y, w: geom.w ?? 480, h: geom.h ?? 320 });
  return { id };
}

/**
 * Connector between two items. When `linkKind` is set and both endpoints are
 * record-cards, the mirrored `links` row is written in the same batch.
 */
export async function addConnector(
  boardId: string,
  opts: { from: string; to: string; label?: string; style?: 'solid' | 'dashed'; arrow?: 'end' | 'both' | 'none'; linkKind?: 'blocks' | 'related' | null },
): Promise<string> {
  const items = (await db.mooditems.where('boardId').equals(boardId).toArray()) as MoodItem[];
  const from = items.find((i) => i.id === opts.from);
  const to = items.find((i) => i.id === opts.to);
  const linkKind = opts.linkKind ?? null;
  let mirrorId: string | null = null;
  let owned = false;
  const fromRef = from ? cardRef(from) : null;
  const toRef = to ? cardRef(to) : null;
  if (linkKind && fromRef?.type === 'record' && toRef?.type === 'record') {
    const lid = linkId(linkKind, '', fromRef.id, toRef.id);
    const existing = await db.collection('links').get(lid);
    owned = !existing || existing.deleted === true;
    mirrorId = await link({ type: 'record', id: fromRef.id }, { type: 'record', id: toRef.id }, linkKind, null);
  }
  try {
    return await addMoodItem(boardId, {
      type: 'connector',
      from: opts.from,
      to: opts.to,
      label: opts.label ?? '',
      style: opts.style ?? 'solid',
      arrow: opts.arrow ?? 'end',
      linkKind: mirrorId ? linkKind : null,
      linkId: mirrorId,
      linkOwned: mirrorId ? owned : undefined,
    });
  } catch (err) {
    // Item write failed after the mirror went in — retire only a row this
    // connector would own, never a pre-existing one.
    if (mirrorId && owned) await unlink(mirrorId).catch(() => {});
    throw err;
  }
}

/** Soft-delete an item; connector mirror lifecycle follows `connectorLinkPlan` (global referrers). */
export async function removeItem(item: MoodItem): Promise<void> {
  const all = (await db.mooditems.where('boardId').equals(String(item.boardId)).toArray()) as MoodItem[];
  if (item.type === 'connector' && item.linkId) {
    // links rows are global — account for connectors on EVERY board, tombstoned included.
    const onLink = (await db.mooditems
      .filter((c) => c.type === 'connector' && c.linkId === item.linkId)
      .toArray()) as MoodItem[];
    const plan = connectorLinkPlan(item, onLink, item.id);
    if (plan.retireLink) await unlink(String(item.linkId));
    if (plan.transferTo) await mutate('mooditems', plan.transferTo, { linkOwned: true });
  }
  // Detach members when a frame goes away (they keep their geometry).
  if (item.type === 'frame') {
    for (const m of all) if (m.parentFrameId === item.id) await mutate('mooditems', m.id, { parentFrameId: null });
  }
  // Dangling connectors whose endpoint is deleted are removed too.
  if (item.type !== 'connector') {
    for (const c of all) {
      if (c.type === 'connector' && !c.deleted && (c.from === item.id || c.to === item.id)) await removeItem(c);
    }
  }
  await mutate('mooditems', item.id, { deleted: true });
}

export async function duplicateItem(boardId: string, item: MoodItem): Promise<string> {
  const patch: Partial<MoodItem> = { ...item, x: Number(item.x ?? 0) + 24, y: Number(item.y ?? 0) + 24 };
  delete patch.id;
  delete patch._ts;
  delete patch.deleted;
  if (item.type === 'connector') {
    delete patch.linkId;
    delete patch.linkKind; // mirrored link is unique per endpoint pair — don't clone it
    delete patch.linkOwned;
  }
  return addMoodItem(boardId, patch);
}

export { cardRef, itemBounds, normalizeItem };
