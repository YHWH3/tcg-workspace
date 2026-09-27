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
