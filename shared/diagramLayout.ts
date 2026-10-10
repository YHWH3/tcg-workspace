/* Structured-diagram spec validation + deterministic layered layout
 * (Phase 2 §1.1 DiagramSpec): longest-path rank assignment, barycenter
 * ordering within ranks (one down sweep + one up sweep), fixed spacing.
 * Pure — shared by the client renderer and MCP add_diagram/update_diagram. */

export interface DiagramRef {
  type: 'record' | 'page';
  id: string;
}

export interface DiagramNode {
  id: string;
  label: string;
  shape?: 'rect' | 'ellipse' | 'diamond' | 'pill';
  color?: string;
  x?: number;
  y?: number;
  ref?: DiagramRef;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  style?: 'solid' | 'dashed';
}

export interface DiagramSpec {
  layout: 'auto-lr' | 'auto-tb' | 'manual';
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export interface PositionedNode extends DiagramNode {
  x: number;
  y: number;
}

export interface LayoutResult {
  nodes: PositionedNode[];
  edges: DiagramEdge[];
}

export type ValidateResult = { ok: true; spec: DiagramSpec } | { ok: false; reasons: string[] };

export const DIAGRAM_NODE_W = 180;
export const DIAGRAM_NODE_H = 64;
export const DIAGRAM_H_GAP = 80;
export const DIAGRAM_V_GAP = 48;
export const DIAGRAM_MAX_NODES = 200;
export const DIAGRAM_MAX_EDGES = 400;

const NODE_SHAPES = new Set(['rect', 'ellipse', 'diamond', 'pill']);
const EDGE_STYLES = new Set(['solid', 'dashed']);
const LAYOUTS = new Set(['auto-lr', 'auto-tb', 'manual']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validate + normalize a DiagramSpec. Collects every problem in `reasons`. */
export function validateDiagramSpec(spec: unknown): ValidateResult {
  const reasons: string[] = [];
  if (!isObj(spec)) return { ok: false, reasons: ['spec-not-object'] };
  const layout = spec.layout;
  if (!LAYOUTS.has(layout as string)) reasons.push('bad-layout');
  const rawNodes = spec.nodes;
  const rawEdges = spec.edges;
  if (!Array.isArray(rawNodes)) reasons.push('nodes-not-array');
  if (!Array.isArray(rawEdges)) reasons.push('edges-not-array');
  if (reasons.length) return { ok: false, reasons };
  const nodesIn = rawNodes as unknown[];
  const edgesIn = rawEdges as unknown[];
  if (nodesIn.length > DIAGRAM_MAX_NODES) reasons.push(`exceeds-${DIAGRAM_MAX_NODES}-nodes`);
  if (edgesIn.length > DIAGRAM_MAX_EDGES) reasons.push(`exceeds-${DIAGRAM_MAX_EDGES}-edges`);

  const nodes: DiagramNode[] = [];
  const ids = new Set<string>();
  nodesIn.forEach((n, i) => {
    if (!isObj(n)) {
      reasons.push(`node-${i}-not-object`);
      return;
    }
    if (typeof n.id !== 'string' || !n.id) {
      reasons.push(`node-${i}-bad-id`);
      return;
    }
    if (ids.has(n.id)) {
      reasons.push(`node-${n.id}-duplicate-id`);
      return;
    }
    ids.add(n.id);
    if (n.label !== undefined && typeof n.label !== 'string') reasons.push(`node-${n.id}-bad-label`);
    if (n.shape !== undefined && !NODE_SHAPES.has(n.shape as string)) reasons.push(`node-${n.id}-bad-shape`);
    if (n.color !== undefined && typeof n.color !== 'string') reasons.push(`node-${n.id}-bad-color`);
    if (n.x !== undefined && !isNum(n.x)) reasons.push(`node-${n.id}-bad-x`);
    if (n.y !== undefined && !isNum(n.y)) reasons.push(`node-${n.id}-bad-y`);
    if (n.ref !== undefined) {
      const r = n.ref;
      if (!isObj(r) || (r.type !== 'record' && r.type !== 'page') || typeof r.id !== 'string' || !r.id) {
        reasons.push(`node-${n.id}-bad-ref`);
      }
    }
    const node: DiagramNode = { id: n.id, label: typeof n.label === 'string' ? n.label : '' };
    if (NODE_SHAPES.has(n.shape as string)) node.shape = n.shape as DiagramNode['shape'];
    if (typeof n.color === 'string') node.color = n.color;
    if (isNum(n.x)) node.x = n.x;
    if (isNum(n.y)) node.y = n.y;
    if (isObj(n.ref) && (n.ref.type === 'record' || n.ref.type === 'page') && typeof n.ref.id === 'string' && n.ref.id) {
      node.ref = { type: n.ref.type, id: n.ref.id };
    }
    nodes.push(node);
  });

  const edges: DiagramEdge[] = [];
  edgesIn.forEach((e, i) => {
    if (!isObj(e) || typeof e.from !== 'string' || typeof e.to !== 'string' || !e.from || !e.to) {
      reasons.push(`edge-${i}-bad-endpoints`);
      return;
    }
    if (!ids.has(e.from) || !ids.has(e.to)) {
      reasons.push(`edge-${i}-dangling-${e.from}->${e.to}`);
      return;
    }
    if (e.label !== undefined && typeof e.label !== 'string') reasons.push(`edge-${i}-bad-label`);
    if (e.style !== undefined && !EDGE_STYLES.has(e.style as string)) reasons.push(`edge-${i}-bad-style`);
    const edge: DiagramEdge = { from: e.from, to: e.to };
    if (typeof e.label === 'string') edge.label = e.label;
    if (EDGE_STYLES.has(e.style as string)) edge.style = e.style as DiagramEdge['style'];
    edges.push(edge);
  });

  if (reasons.length) return { ok: false, reasons };
  return { ok: true, spec: { layout: layout as DiagramSpec['layout'], nodes, edges } };
}

/** Directed acyclic check + longest-path ranks. Deterministic: ties break by sorted id. */
function dagRanks(nodeIds: string[], edges: DiagramEdge[]): Map<string, number> | null {
  const ids = [...nodeIds].sort();
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const id of ids) {
    preds.set(id, []);
    succs.set(id, []);
    indeg.set(id, 0);
  }
  for (const e of edges) {
    if (e.from === e.to) continue; // self-loops can't be layered — ignored for ranking
    if (!ids.includes(e.from) || !ids.includes(e.to)) continue;
    succs.get(e.from)!.push(e.to);
    preds.get(e.to)!.push(e.from);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  for (const id of ids) {
    succs.get(id)!.sort();
    preds.get(id)!.sort();
  }
  const ranks = new Map<string, number>();
  const queue = ids.filter((id) => indeg.get(id) === 0);
  let processed = 0;
  while (queue.length) {
    queue.sort();
    const id = queue.shift()!;
    processed++;
    let rank = 0;
    for (const p of preds.get(id)!) rank = Math.max(rank, (ranks.get(p) ?? -1) + 1);
    ranks.set(id, rank);
    for (const s of succs.get(id)!) {
      indeg.set(s, indeg.get(s)! - 1);
      if (indeg.get(s) === 0) queue.push(s);
    }
  }
  if (processed < ids.length) return null; // cycle
  return ranks;
}

/**
 * Position every node. 'manual' keeps given x/y (default 0). 'auto-lr'/'auto-tb'
 * layer by longest-path rank and order within a rank by neighbor barycenters —
 * one downward sweep then one upward sweep; ties always break by sorted id.
 * Cycles in edges are tolerated: offending back-edges are ignored for ranking.
 */
export function layoutDiagram(spec: DiagramSpec): LayoutResult {
  const edges = spec.edges;
  if (spec.layout === 'manual') {
    return {
      nodes: spec.nodes.map((n) => ({ ...n, x: n.x ?? 0, y: n.y ?? 0 })),
      edges,
    };
  }
  const nodeIds = spec.nodes.map((n) => n.id);
  // Drop edges that would create cycles: keep the DAG subset found by DFS in id order.
  const dagEdges = acyclicSubset(nodeIds, edges);
  const ranks = dagRanks(nodeIds, dagEdges) ?? new Map(nodeIds.map((id) => [id, 0]));

  // Group by rank; initial order within each rank is sorted id.
  const maxRank = Math.max(0, ...ranks.values());
  const layers: string[][] = Array.from({ length: maxRank + 1 }, () => []);
  for (const id of nodeIds) layers[ranks.get(id) ?? 0].push(id);
  for (const layer of layers) layer.sort();

  const horizontal = spec.layout === 'auto-lr';
  // Barycenter ordering: sweep down (predecessors) then up (successors).
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const id of nodeIds) {
    preds.set(id, []);
    succs.set(id, []);
  }
  for (const e of dagEdges) {
    if (e.from === e.to) continue;
    succs.get(e.from)!.push(e.to);
    preds.get(e.to)!.push(e.from);
  }
  const posIn = (layer: string[]) => new Map(layer.map((id, i) => [id, i] as const));
  const reorder = (layerIdx: number, neighborsOf: (id: string) => string[], neighborPos: Map<string, number>) => {
    const layer = layers[layerIdx];
    const cur = posIn(layer);
    const scored = layer.map((id) => {
      const ns = neighborsOf(id).filter((n) => neighborPos.has(n));
      const score = ns.length ? ns.reduce((a, n) => a + neighborPos.get(n)!, 0) / ns.length : cur.get(id)!;
      return { id, score, i: cur.get(id)! };
    });
    scored.sort((a, b) => a.score - b.score || a.i - b.i || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    layers[layerIdx] = scored.map((s) => s.id);
  };
  // down sweep: order each layer by predecessor barycenters
  for (let r = 1; r < layers.length; r++) reorder(r, (id) => preds.get(id)!, posIn(layers[r - 1]));
  // up sweep: order each layer by successor barycenters
  for (let r = layers.length - 2; r >= 0; r--) reorder(r, (id) => succs.get(id)!, posIn(layers[r + 1]));

  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const nodes: PositionedNode[] = [];
  layers.forEach((layer, rank) => {
    layer.forEach((id, i) => {
      const n = byId.get(id)!;
      const x = horizontal ? rank * (DIAGRAM_NODE_W + DIAGRAM_H_GAP) : i * (DIAGRAM_NODE_W + DIAGRAM_H_GAP);
      const y = horizontal ? i * (DIAGRAM_NODE_H + DIAGRAM_V_GAP) : rank * (DIAGRAM_NODE_H + DIAGRAM_V_GAP);
      nodes.push({ ...n, x, y });
    });
  });
  return { nodes, edges };
}

/** Deterministic feedback-edge removal: DFS in sorted-id order over sorted
 * adjacency; an edge to a gray (on-stack) node is a back edge — dropping every
 * back edge breaks all cycles. Parallel edges share a from→to key and drop
 * together. */
function acyclicSubset(nodeIds: string[], edges: DiagramEdge[]): DiagramEdge[] {
  const idSet = new Set(nodeIds);
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.from === e.to || !idSet.has(e.from) || !idSet.has(e.to)) continue;
    const list = adj.get(e.from) ?? [];
    if (list.length === 0) adj.set(e.from, list);
    if (!list.includes(e.to)) list.push(e.to);
  }
  for (const list of adj.values()) list.sort();
  const color = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
  const dropped = new Set<string>();
  const visit = (start: string): void => {
    color.set(start, 1);
    const stack: { id: string; next: number }[] = [{ id: start, next: 0 }];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const outs = adj.get(top.id) ?? [];
      if (top.next >= outs.length) {
        color.set(top.id, 2);
        stack.pop();
        continue;
      }
      const to = outs[top.next++];
      const c = color.get(to);
      if (c === 1) {
        dropped.add(`${top.id}→${to}`);
      } else if (c !== 2) {
        color.set(to, 1);
        stack.push({ id: to, next: 0 });
      }
    }
  };
  for (const id of [...idSet].sort()) if (!color.get(id)) visit(id);
  return edges.filter((e) => e.from === e.to || !dropped.has(`${e.from}→${e.to}`));
}
