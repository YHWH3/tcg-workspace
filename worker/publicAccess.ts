/**
 * Pure access-control helpers for public share links. Unit-tested; the D1
 * layer in public.ts just feeds these rows read via json_extract.
 */
export interface PubPage {
  id: string;
  parentId?: string | null;
  deleted?: boolean | number;
}

export interface PubBlock {
  id: string;
  pageId: string;
  type?: string;
  fileId?: string | null;
  boardId?: string | null;
  deleted?: boolean | number;
}

export interface PubFileMeta {
  id: string;
  thumbId?: string | null;
}

/** Ids of all non-deleted pages in the tree rooted at `rootId` (root included). */
export function descendantIds(pages: PubPage[], rootId: string): Set<string> {
  const byParent = new Map<string, string[]>();
  const alive = new Set(pages.filter((p) => !p.deleted).map((p) => p.id));
  for (const p of pages) {
    if (!p.parentId) continue;
    const list = byParent.get(p.parentId) ?? [];
    list.push(p.id);
    byParent.set(p.parentId, list);
  }
  const out = new Set<string>();
  const walk = (id: string) => {
    if (!alive.has(id) || out.has(id)) return;
    out.add(id);
    for (const child of byParent.get(id) ?? []) walk(child);
  };
  walk(rootId);
  return out;
}

/** A public page is visible iff it's inside the shared tree. */
export function canServePage(pageId: string, tree: Set<string>): boolean {
  return tree.has(pageId);
}

/**
 * File ids the tree may serve:
 *  - `fileId` referenced by a block on a page inside the tree, and
 *  - covers of tasks shown by `tasks` blocks inside the tree.
 */
export function allowedFileIds(
  blocks: PubBlock[],
  tree: Set<string>,
  taskCovers: Array<string | null | undefined>,
): Set<string> {
  const allowed = new Set<string>();
  for (const b of blocks) {
    if (b.deleted || !tree.has(b.pageId)) continue;
    if (b.fileId) allowed.add(b.fileId);
  }
  for (const c of taskCovers) {
    if (c) allowed.add(c);
  }
  return allowed;
}

/** Expand an allowed set to also include each file's thumbnail. */
export function expandThumbs(allowed: Set<string>, files: PubFileMeta[]): Set<string> {
  const out = new Set(allowed);
  for (const f of files) {
    if (f.thumbId && allowed.has(f.id)) out.add(f.thumbId);
  }
  return out;
}

/** May `fileId` be served? Only if the file (or its thumb) is in the allowed set. */
export function canServeFile(fileId: string, allowed: Set<string>, files: PubFileMeta[]): boolean {
  if (allowed.has(fileId)) return true;
  // A thumbnail of an allowed file is servable.
  return files.some((f) => f.thumbId === fileId && allowed.has(f.id));
}

/* ---------- Public moodboard (canvas) shares (Phase 2 §6) ---------- */

export interface PubMoodItem {
  id: string;
  boardId?: string;
  type?: string;
  fileId?: string | null;
  deleted?: boolean | number;
}

export interface PubCanvasCard {
  title: string | null;
  stage: string | null;
}

/** A moodboard share token may only serve the board it was minted for. */
export function canServeBoardShare(share: { target_type?: string | null; page_id: string }, boardId: string): boolean {
  return share.target_type === 'moodboard' && share.page_id === boardId;
}

/**
 * Files reachable through a canvas share: the `fileId`s of live items on that
 * board only (image items — svg carries its bytes inline), plus their thumbs.
 * A file linked from another board or a deleted item is rejected.
 */
export function allowedCanvasFiles(items: PubMoodItem[], boardId: string, files: PubFileMeta[]): Set<string> {
  const allowed = new Set<string>();
  for (const it of items) {
    if (it.deleted) continue;
    if (it.boardId !== boardId) continue;
    if (typeof it.fileId === 'string' && it.fileId) allowed.add(it.fileId);
  }
  return expandThumbs(allowed, files);
}

const CANVAS_COMMON = ['id', 'type', 'x', 'y', 'w', 'h', 'z', 'parentFrameId'] as const;
const CANVAS_PER_TYPE: Record<string, readonly string[]> = {
  image: ['fileId'],
  note: ['text'],
  text: ['text'],
  color: ['color', 'text'],
  shape: ['shape', 'fill', 'stroke', 'text'],
  frame: ['title', 'frameStageOf'],
  svg: ['svg', 'fileId'],
  diagram: ['spec'],
  connector: ['from', 'to', 'label', 'style', 'arrow', 'linkKind'],
  card: ['ref'],
};

/**
 * Whitelist projection of a mooditem onto its public payload. Card items
 * reduce to `{ref, card:{title,stage}}` — never the record body, custom
 * fields, or links. Everything else keeps only its render fields.
 */
export function publicCanvasItem(
  item: Record<string, unknown>,
  card?: PubCanvasCard | null,
): Record<string, unknown> {
  const type = typeof item.type === 'string' ? item.type : 'note';
  const out: Record<string, unknown> = {};
  for (const k of CANVAS_COMMON) if (item[k] !== undefined) out[k] = item[k];
  for (const k of CANVAS_PER_TYPE[type] ?? []) if (item[k] !== undefined) out[k] = item[k];
  if (type === 'card') {
    const ref = item.ref;
    out.ref = ref && typeof ref === 'object'
      ? { type: (ref as { type?: unknown }).type ?? 'record', id: (ref as { id?: unknown }).id ?? null }
      : { type: 'record', id: item.taskId ?? null };
    out.card = { title: card?.title ?? null, stage: card?.stage ?? null };
  }
  return out;
}
