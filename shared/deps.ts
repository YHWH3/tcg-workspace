/* Dependency graph helpers on `blocks`-kind links: edge [from,to] means "from must finish before to" (from blocks to). */

export function wouldCreateDependencyCycle(edges: [string, string][], from: string, to: string): boolean {
  // Adding from→to is a cycle iff `to` can already reach `from`.
  const next = new Map<string, string[]>();
  for (const [f, t] of edges) {
    const l = next.get(f);
    if (l) l.push(t);
    else next.set(f, [t]);
  }
  const stack = [to];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === from) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(next.get(cur) ?? []));
  }
  return false;
}

/** Any live incoming `blocks` edge whose blocker isn't done → record is blocked. */
export function isBlocked(recordId: string, edges: [string, string][], isDone: (id: string) => boolean): boolean {
  return edges.some(([f, t]) => t === recordId && !isDone(f));
}
