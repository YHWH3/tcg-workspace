/* Pure delete-impact planner for dryRun + delete_item (Phase 0 §8).
 * Given the rows a real delete would touch, return counts + warnings. */

export interface ImpactRow {
  id: string;
  collection: string;
  data: Record<string, unknown>;
}

export interface ImpactResult {
  summary: string;
  counts: Record<string, number>;
  warnings: string[];
  /** ids that would be soft-deleted, per collection. */
  ids: Record<string, string[]>;
}

function isLive(r: ImpactRow): boolean {
  return r.data.deleted !== true;
}

/**
 * `snap` is the small slice of records a delete touches — workers gather it
 * via targeted reads, tests pass it directly.
 */
export function planDeleteImpact(
  snap: { pages: ImpactRow[]; blocks: ImpactRow[]; tasks: ImpactRow[]; comments: ImpactRow[]; files: ImpactRow[]; mooditems: ImpactRow[]; shares: number; backlinks: number },
  type: 'page' | 'board' | 'task' | 'comment' | 'file' | 'moodboard' | 'mooditem' | 'record',
  id: string,
): ImpactResult {
  const warnings: string[] = [];
  const counts: Record<string, number> = {};
  const ids: Record<string, string[]> = {};

  if (type === 'page' || type === 'record') {
    // Descendants: pages/records whose parentId chain lands under `id`.
    const byParent = new Map<string, ImpactRow[]>();
    for (const p of snap.pages) {
      const pid = p.data.parentId as string | undefined;
      if (!pid) continue;
      const list = byParent.get(pid) ?? [];
      list.push(p);
      byParent.set(pid, list);
    }
    const descendants: ImpactRow[] = [];
    const queue = [id];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const child of byParent.get(cur) ?? []) {
        if (isLive(child)) {
          descendants.push(child);
          queue.push(child.id);
        }
      }
    }
    const allPages = [...snap.pages.filter((p) => p.id === id), ...descendants];
    const pageIds = new Set(allPages.map((p) => p.id));
    const blocks = snap.blocks.filter((b) => isLive(b) && pageIds.has(b.data.pageId as string));
    // tasks embedded in tasks-blocks on deleted pages are deleted too
    const taskBlockIds = new Set(blocks.filter((b) => b.data.type === 'tasks').map((b) => b.id));
    const embeddedTasks = snap.tasks.filter((t) => isLive(t) && taskBlockIds.has(t.data.blockId as string));
    const files = snap.files.filter((f) => isLive(f) && pageIds.has(f.data.parentId as string));

    counts.pages = descendants.length + (type === 'page' ? 1 : 0);
    counts.records = type === 'record' ? 1 + descendants.length : 0;
    counts.blocks = blocks.length;
    counts.tasks = embeddedTasks.length;
    counts.files = files.length;
    counts.shares = snap.shares;
    counts.backlinks = snap.backlinks;
    ids.pages = allPages.map((p) => p.id);
    ids.blocks = blocks.map((b) => b.id);
    ids.tasks = embeddedTasks.map((t) => t.id);
    ids.files = files.map((f) => f.id);
    if (descendants.length) warnings.push(`${descendants.length} nested ${type === 'page' ? 'page(s)' : 'record(s)'} will also be deleted`);
    if (snap.shares) warnings.push(`${snap.shares} public share link(s) will stop working`);
    if (snap.backlinks) warnings.push(`${snap.backlinks} backlink(s) will dangle`);
    // Boards embedded on the page are NOT deleted (blocks only).
    const boardBlocks = blocks.filter((b) => b.data.type === 'tasks' && b.data.boardId);
    if (boardBlocks.length) warnings.push('Embedded boards are removed from the page but the boards themselves are kept');
    return { summary: `Delete ${type} ${id}: ${counts.pages + counts.records} page/record(s), ${counts.blocks} block(s), ${counts.tasks} task(s), ${counts.files} file(s)`, counts, warnings, ids };
  }

  if (type === 'board') {
    const live = snap.tasks.filter((t) => isLive(t));
    counts.tasks = live.length;
    ids.tasks = live.map((t) => t.id);
    if (live.length) warnings.push(`${live.length} live task(s) — they move to the default board unless taskAction:'delete'`);
    return { summary: `Delete board ${id}: ${live.length} live task(s) affected`, counts, warnings, ids };
  }

  if (type === 'task') {
    const items = snap.mooditems.filter((m) => isLive(m) && m.data.taskId === id);
    const comments = snap.comments.filter((cm) => isLive(cm) && cm.data.targetId === id);
    const files = snap.files.filter((f) => isLive(f) && f.data.parentId === id);
    counts.mooditems = items.length;
    counts.comments = comments.length;
    counts.files = files.length;
    ids.mooditems = items.map((m) => m.id);
    ids.comments = comments.map((cm) => cm.id);
    ids.files = files.map((f) => f.id);
    if (items.length) warnings.push(`${items.length} mood-board item(s) reference this task`);
    return { summary: `Delete task ${id}: ${comments.length} comment(s), ${files.length} attachment(s), ${items.length} mood item ref(s)`, counts, warnings, ids };
  }

  if (type === 'file') {
    // Migration 0011 reclaims attachment bytes in the same transaction as the
    // tombstone: restore/undo can bring the record back but never the bytes.
    warnings.push('Attachment bytes are permanently reclaimed; restore_item/undo_change cannot bring them back');
  }
  return { summary: `Delete ${type} ${id}`, counts, warnings, ids };
}
