/* Page/record hierarchy helpers (Phase 1 §3.2): sub-records nest via
 * `parentId` inside ONE database. Max depth 3: record → sub → sub-sub.
 * All helpers take `parentOf` (id → parentId | null | undefined) so they run
 * identically on the client (Dexie snapshot) and the worker (D1 rows). */

export const MAX_DEPTH = 3;

function childIndex(parentOf: ReadonlyMap<string, string | null | undefined>): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const [child, parent] of parentOf) {
    if (parent == null) continue;
    const list = children.get(parent) ?? [];
    list.push(child);
    children.set(parent, list);
  }
  return children;
}

/** Depth of a node: root = 1, its child = 2, grandchild = 3. Tolerates cycles. */
export function depthOf(parentOf: ReadonlyMap<string, string | null | undefined>, id: string): number {
  let depth = 0;
  let cur: string | null | undefined = id;
  const seen = new Set<string>();
  while (cur != null && !seen.has(cur)) {
    seen.add(cur);
    depth++;
    cur = parentOf.get(cur);
  }
  return depth;
}

/** All descendant ids of `id` (BFS, cycle-safe). Does not include `id` itself. */
export function descendants(parentOf: ReadonlyMap<string, string | null | undefined>, id: string): string[] {
  const children = childIndex(parentOf);
  const out: string[] = [];
  const seen = new Set<string>([id]);
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const c of children.get(cur) ?? []) {
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c);
      queue.push(c);
    }
  }
  return out;
}

/** Height of the subtree rooted at `id`: leaf = 1, parent of leaf = 2, … */
export function subtreeHeight(parentOf: ReadonlyMap<string, string | null | undefined>, id: string): number {
  const base = depthOf(parentOf, id);
  let max = base;
  for (const d of descendants(parentOf, id)) {
    const dd = depthOf(parentOf, d);
    if (dd > max) max = dd;
  }
  return max - base + 1;
}

/**
 * Would making `childId` a child of `newParentId` create a cycle? True when
 * newParentId IS childId or already sits inside childId's subtree (i.e. the
 * ancestor chain above newParentId passes through childId).
 */
export function wouldCreateCycle(
  parentOf: ReadonlyMap<string, string | null | undefined>,
  childId: string,
  newParentId: string | null | undefined,
): boolean {
  if (newParentId == null) return false;
  let cur: string | null | undefined = newParentId;
  const seen = new Set<string>();
  while (cur != null) {
    if (cur === childId) return true;
    if (seen.has(cur)) return false; // pre-existing malformed cycle elsewhere — bail, not ours to judge
    seen.add(cur);
    cur = parentOf.get(cur);
  }
  return false;
}

/** Would the move push the subtree below `maxDepth` (default MAX_DEPTH = 3)? */
export function wouldExceedDepth(
  parentOf: ReadonlyMap<string, string | null | undefined>,
  childId: string,
  newParentId: string | null | undefined,
  maxDepth: number = MAX_DEPTH,
): boolean {
  const parentDepth = newParentId == null ? 0 : depthOf(parentOf, newParentId);
  return parentDepth + subtreeHeight(parentOf, childId) > maxDepth;
}

export type ReparentCheck = 'ok' | 'cycle' | 'depth' | 'self';

/**
 * Full reparent validation: `childId` under `newParentId` (null = root).
 * Returns 'ok' or the reason to refuse — a node can never move under itself or
 * a descendant, and the result may not exceed MAX_DEPTH levels.
 */
export function checkReparent(
  parentOf: ReadonlyMap<string, string | null | undefined>,
  childId: string,
  newParentId: string | null | undefined,
  maxDepth: number = MAX_DEPTH,
): ReparentCheck {
  if (newParentId === childId) return 'self';
  if (wouldCreateCycle(parentOf, childId, newParentId)) return 'cycle';
  if (wouldExceedDepth(parentOf, childId, newParentId, maxDepth)) return 'depth';
  return 'ok';
}
