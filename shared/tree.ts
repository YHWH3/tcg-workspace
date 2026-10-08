/* Record/page hierarchy helpers — max depth 3, cycle-safe reparenting. */

export const MAX_DEPTH = 3;

/** Would setting childId's parent to newParentId create a cycle? (newParentId is childId or one of its descendants) */
export function wouldCreateCycle(parentOf: Map<string, string | null>, childId: string, newParentId: string | null): boolean {
  if (!newParentId) return false;
  if (newParentId === childId) return true;
  let cur: string | null | undefined = newParentId;
  let guard = 0;
  while (cur && guard++ < 10_000) {
    if (cur === childId) return true;
    cur = parentOf.get(cur) ?? null;
  }
  return false;
}

export function descendants(parentOf: Map<string, string | null>, id: string): string[] {
  const out: string[] = [];
  const kids = new Map<string, string[]>();
  for (const [k, p] of parentOf) {
    if (!p) continue;
    const l = kids.get(p);
    if (l) l.push(k);
    else kids.set(p, [k]);
  }
  const stack = [...(kids.get(id) ?? [])];
  while (stack.length) {
    const k = stack.pop()!;
    out.push(k);
    stack.push(...(kids.get(k) ?? []));
  }
  return out;
}

/** Depth of `id` in the tree rooted at ancestors (root record = depth 1). */
export function depthOf(parentOf: Map<string, string | null>, id: string): number {
  let d = 1;
  let cur: string | null | undefined = parentOf.get(id) ?? null;
  let guard = 0;
  while (cur && guard++ < 10_000) {
    d++;
    cur = parentOf.get(cur) ?? null;
  }
  return d;
}

/** Depth of the deepest descendant subtree under `id` (id itself = 0). */
export function subtreeHeight(parentOf: Map<string, string | null>, id: string): number {
  const kids = new Map<string, string[]>();
  for (const [k, p] of parentOf) {
    if (!p) continue;
    const l = kids.get(p);
    if (l) l.push(k);
    else kids.set(p, [k]);
  }
  const h = (x: string, guard: number): number => (guard > 10_000 ? 0 : 1 + Math.max(0, ...(kids.get(x) ?? []).map((k) => h(k, guard + 1))));
  return h(id, 0) - 1;
}
