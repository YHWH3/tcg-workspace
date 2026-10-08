/* Dependency graph helpers over `links` rows of kind 'blocks' (Phase 1 §3.3):
 * an edge [from, to] means `from` must finish before `to` (from BLOCKS to).
 * Edges are plain [fromId, toId] pairs so the module works on live `links`
 * rows (map l => [l.fromId, l.toId]) on client and worker alike. */

export type DepEdge = readonly [from: string, to: string];

/** Live edges only — `links` rows carry a soft-delete flag; filter before use. */
export function edgesOf(links: Iterable<{ fromId?: unknown; toId?: unknown; kind?: unknown; deleted?: unknown }>): DepEdge[] {
  const out: DepEdge[] = [];
  for (const l of links) {
    if (l.deleted || l.kind !== 'blocks') continue;
    if (typeof l.fromId === 'string' && typeof l.toId === 'string' && l.fromId && l.toId) out.push([l.fromId, l.toId]);
  }
  return out;
}

/**
 * Adding the edge `from → to` is refused when `to` can already reach `from`
 * through existing edges — DFS, cycle-safe.
 */
export function wouldCreateDependencyCycle(edges: Iterable<DepEdge>, from: string, to: string): boolean {
  if (from === to) return true;
  const adj = new Map<string, string[]>();
  for (const [f, t] of edges) {
    const list = adj.get(f) ?? [];
    list.push(t);
    adj.set(f, list);
  }
  const seen = new Set<string>([to]);
  const stack = [to];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === from) return true;
    for (const next of adj.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

/**
 * Is `recordId` blocked? True while any incoming `blocks` edge comes from a
 * record that is not done (`isDone` decides what "done" means — last stage for
 * task databases, caller-defined elsewhere).
 */
export function isBlocked(recordId: string, edges: Iterable<DepEdge>, isDone: (id: string) => boolean): boolean {
  for (const [f, t] of edges) {
    if (t === recordId && !isDone(f)) return true;
  }
  return false;
}

/** Records `recordId` depends on — ids of live incoming blockers (its "Blocked by" list). */
export function dependenciesOf(recordId: string, edges: Iterable<DepEdge>): string[] {
  const out = new Set<string>();
  for (const [f, t] of edges) if (t === recordId) out.add(f);
  return [...out];
}

/** Records that depend on `recordId` — ids it blocks (its "Blocking" list). */
export function dependentsOf(recordId: string, edges: Iterable<DepEdge>): string[] {
  const out = new Set<string>();
  for (const [f, t] of edges) if (f === recordId) out.add(t);
  return [...out];
}
