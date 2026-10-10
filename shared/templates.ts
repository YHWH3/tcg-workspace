/* Pure template-instantiation planner. Turns a snapshot of records + options
 * into the list of record patches that create the copy — the client applies
 * them through mutate(), the worker through applyChanges(). One source.
 *
 * Phase 1 §3.5: copies board kind/recordNoun/showBuiltins/description, views of
 * copied databases, links whose both ends are inside the copied set, record
 * parentId + record body blocks, and remaps @[page:]/@[rec:] mention tokens. */

import { cmpOrder, orderBetween } from './order';
import { linkId } from './linkid';
import type { FieldDef } from './fields';

export interface RecSnapshot {
  pages: Record<string, Record<string, unknown>>;
  blocks: Record<string, Record<string, unknown>>;
  boards: Record<string, Record<string, unknown>>;
  tasks: Record<string, Record<string, unknown>>;
  views?: Record<string, Record<string, unknown>>;
  links?: Record<string, Record<string, unknown>>;
}

export interface TemplateOpts {
  templateId: string;
  title?: string;
  parentId?: string | null;
  /** {{name}} substitutions for titles, block text and board names. */
  variables?: Record<string, string>;
  actorId?: string | null;
  /** Stamped on copied rows when instantiated from a bundled template (e.g. 'starter-people'). */
  templateKey?: string;
  /**
   * Phase 3 — snapshot/authored board id → EXISTING live board id. Reused
   * boards join `boardMap` upfront: no board/record/view writes for them, but
   * every reference (relation targets, block `databaseId`, `captureTargets`,
   * views' `databaseId`) remaps to the live id. Reused boards' records are
   * NOT copied.
   */
  reuseBoards?: Record<string, string>;
  /** Bundled installs pass true: pages authored `template:true` keep `isTemplate:true`. */
  preserveTemplates?: boolean;
}

export interface PlannedWrite {
  collection: 'pages' | 'blocks' | 'boards' | 'tasks' | 'moodboards' | 'mooditems' | 'views' | 'links';
  id: string;
  patch: Record<string, unknown>;
}

export interface TemplatePlan {
  writes: PlannedWrite[];
  /** Id of the new root page. */
  rootPageId: string;
}

export function substituteVars(text: unknown, vars: Record<string, string>): string {
  const s = String(text ?? '');
  return s.replace(/\{\{\s*([A-Za-z0-9_ -]+?)\s*\}\}/g, (m, name: string) => vars[name] ?? m);
}

/** Mention tokens that can point into the copied set: pages and records. Users stay literal. */
const MENTION_TOKEN_RE = /@\[(page|rec):([^\]]+)\]/g;

/** Collect the template page + all descendants (BFS). */
function subtreeIds(pages: RecSnapshot['pages'], rootId: string): string[] {
  const out: string[] = [];
  const queue = [rootId];
  const seen = new Set<string>([rootId]);
  while (queue.length) {
    const id = queue.shift()!;
    if (!pages[id] || pages[id].deleted) continue;
    out.push(id);
    for (const [pid, p] of Object.entries(pages)) {
      if (!seen.has(pid) && String(p.parentId ?? '') === id) {
        seen.add(pid);
        queue.push(pid);
      }
    }
  }
  return out;
}

/**
 * Plan a deep copy of the template page subtree. Blocks under `tasks` type
 * spawn a copied board (with its non-deleted tasks) instead of pointing at the
 * original. Returns null when the template id doesn't resolve to a live page.
 */
export function planTemplateInstantiation(
  snap: RecSnapshot,
  opts: TemplateOpts,
  deps: { id: () => string; now: number },
): TemplatePlan | null {
  const template = snap.pages[opts.templateId];
  if (!template || template.deleted) return null;
  const vars = opts.variables ?? {};
  const writes: PlannedWrite[] = [];

  // --- pages ---
  const pageIds = subtreeIds(snap.pages, opts.templateId);
  const pageMap = new Map<string, string>(); // old → new
  for (const oldId of pageIds) pageMap.set(oldId, deps.id());

  // Order for the new root: after existing siblings under the same parent.
  const parentId = opts.parentId ?? null;
  const sibOrders = Object.values(snap.pages)
    .filter((p) => !p.deleted && (p.parentId ?? null) === parentId && p.id !== undefined)
    .map((p) => String(p.order ?? ''));
  const lastOrder = sibOrders.length ? [...sibOrders].sort(cmpOrder)[sibOrders.length - 1] : null;
  const rootOrder = orderBetween(lastOrder || null, null);

  for (const oldId of pageIds) {
    const src = snap.pages[oldId];
    const isRoot = oldId === opts.templateId;
    writes.push({
      collection: 'pages',
      id: pageMap.get(oldId)!,
      patch: {
        title: isRoot ? (opts.title ?? (substituteVars(src.title, vars) || 'Untitled')) : substituteVars(src.title, vars),
        icon: src.icon ?? '📄',
        parentId: isRoot ? parentId : (pageMap.get(String(src.parentId)) ?? null),
        order: isRoot ? rootOrder : (src.order ?? null),
        isTemplate: opts.preserveTemplates ? src.isTemplate === true : false,
        createdBy: opts.actorId ?? null,
        createdAt: deps.now,
        ...(opts.templateKey ? { templateKey: opts.templateKey } : {}),
      },
    });
  }

  // --- boards + records ---
  // Blocks owned by a copied page, or by a copied record (record body blocks
  // have pageId = record id + parentType 'record').
  const boardMap = new Map<string, string>();
  const taskMap = new Map<string, string>();
  const srcBoardIds: string[] = [];

  // Reused boards resolve to their live ids immediately — the fixpoint skips
  // them (already in boardMap) so no board/record/view writes are planned.
  const reusedBoardIds = new Set<string>();
  for (const [srcId, liveId] of Object.entries(opts.reuseBoards ?? {})) {
    if (typeof liveId === 'string' && liveId) {
      boardMap.set(srcId, liveId);
      reusedBoardIds.add(srcId);
    }
  }
  const ownedByCopiedSet = (b: Record<string, unknown>): boolean =>
    !b.deleted && (pageMap.has(String(b.pageId ?? '')) || taskMap.has(String(b.pageId ?? '')));

  // Fixpoint: a `tasks` block (boardId) or a dashboard block (databaseId /
  // sources[].databaseId) in a copied page/record pulls in its database; each
  // copied database's records pull in their own body blocks, which may embed
  // further databases. All board ids are allocated before ANY board patch is
  // written so relation targets between copied databases remap.
  const DASHBOARD_BLOCK_TYPES = new Set(['view', 'metric', 'calendar', 'activity', 'mywork']);
  const boardRefsOf = (b: Record<string, unknown>): string[] => {
    const out: string[] = [];
    if (b.type === 'tasks' && typeof b.boardId === 'string' && b.boardId) out.push(b.boardId);
    if (DASHBOARD_BLOCK_TYPES.has(String(b.type))) {
      if (typeof b.databaseId === 'string' && b.databaseId) out.push(b.databaseId);
      if (Array.isArray(b.sources)) {
        for (const s of b.sources) {
          const dbId = (s as { databaseId?: unknown })?.databaseId;
          if (typeof dbId === 'string' && dbId) out.push(dbId);
        }
      }
    }
    return out;
  };
  let grew = true;
  while (grew) {
    grew = false;
    for (const [, b] of Object.entries(snap.blocks)) {
      if (!ownedByCopiedSet(b)) continue;
      for (const refId of boardRefsOf(b)) {
        if (boardMap.has(refId)) continue;
        boardMap.set(refId, deps.id());
        srcBoardIds.push(refId);
        grew = true;
        for (const [tid, t] of Object.entries(snap.tasks)) {
          if (!t.deleted && String(t.boardId ?? 'board-default') === refId && !taskMap.has(tid)) {
            taskMap.set(tid, deps.id());
          }
        }
      }
    }
  }

  // viewMap allocated before ANY writes: `view` blocks' `viewId` and copied
  // boards' `defaultViewId` remap through it. Views on reused boards are not
  // written (their src view ids simply never enter the map).
  const viewMap = new Map<string, string>();
  for (const [vid, v] of Object.entries(snap.views ?? {})) {
    if (v.deleted) continue;
    const srcDb = String(v.databaseId ?? '');
    if (!boardMap.has(srcDb) || reusedBoardIds.has(srcDb)) continue;
    viewMap.set(vid, deps.id());
  }

  const remapField = (f: FieldDef): FieldDef => ({
    ...f,
    options: Array.isArray(f.options) ? f.options.map((o) => ({ ...o })) : undefined,
    // Relation targets pointing at another copied database get remapped;
    // pairedFieldId stays — field ids are copied unchanged.
    relation: f.relation ? { ...f.relation, target: boardMap.get(f.relation.target) ?? f.relation.target } : undefined,
  });

  for (const srcBoardId of srcBoardIds) {
    const src = snap.boards[srcBoardId];
    const newId = boardMap.get(srcBoardId)!;
    const order = String(deps.now); // moodboards/boards use timestamp-ish order strings; keep consistent ordering
    const patch: Record<string, unknown> = {
      name: substituteVars(src?.name ?? 'Board', vars),
      icon: src?.icon ?? '🗂️',
      columns: Array.isArray(src?.columns) ? src.columns.map((c) => ({ ...(c as object) })) : undefined,
      fields: Array.isArray(src?.fields) ? (src.fields as FieldDef[]).map(remapField) : undefined,
      order,
      createdBy: opts.actorId ?? null,
      createdAt: deps.now,
    };
    for (const k of ['kind', 'recordNoun', 'showBuiltins', 'templateKey', 'fieldActions'] as const) {
      if (src?.[k] !== undefined) patch[k] = typeof src[k] === 'object' && src[k] !== null ? JSON.parse(JSON.stringify(src[k])) : src[k];
    }
    if (opts.templateKey) patch.templateKey = opts.templateKey;
    // Snapshot `key` → `templateDbKey` on the live board (install dedupe key).
    if (src?.key !== undefined) patch.templateDbKey = src.key;
    if (src?.defaultViewId !== undefined) patch.defaultViewId = viewMap.get(String(src.defaultViewId)) ?? src.defaultViewId;
    // captureTargets pass through with authored db ids remapped to live ids.
    if (Array.isArray(src?.captureTargets)) {
      patch.captureTargets = src.captureTargets.map((c) => {
        const t = { ...(c as Record<string, unknown>) };
        if (t.databaseId !== undefined) t.databaseId = boardMap.get(String(t.databaseId)) ?? t.databaseId;
        return t;
      });
    }
    if (src?.description !== undefined) patch.description = substituteVars(src.description, vars);
    writes.push({ collection: 'boards', id: newId, patch });

    // Copy non-deleted records on that board (parentId remapped via taskMap).
    const tasks = Object.entries(snap.tasks)
      .filter(([tid, t]) => taskMap.has(tid) && String(t.boardId ?? 'board-default') === srcBoardId)
      .sort((a, b) => cmpOrder(a[1].order, b[1].order));
    for (const [tid, t] of tasks) {
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(t)) if (k.startsWith('p_')) props[k] = v;
      writes.push({
        collection: 'tasks',
        id: taskMap.get(tid)!,
        patch: {
          title: substituteVars(t.title, vars),
          description: substituteVars(t.description, vars),
          boardId: newId,
          status: t.status ?? null,
          priority: t.priority ?? 'none',
          parentId: t.parentId != null ? (taskMap.get(String(t.parentId)) ?? null) : null,
          order: t.order ?? null,
          createdBy: opts.actorId ?? null,
          createdAt: deps.now,
          ...props,
        },
      });
    }
  }

  // --- views of copied databases (field keys p_<id> stay valid: ids unchanged) ---
  // Reused boards' views are not written (no view writes for reused boards).
  for (const [vid, v] of Object.entries(snap.views ?? {})) {
    if (v.deleted) continue;
    const srcDb = String(v.databaseId ?? '');
    const newDbId = boardMap.get(srcDb);
    if (!newDbId || reusedBoardIds.has(srcDb)) continue;
    writes.push({
      collection: 'views',
      id: viewMap.get(vid) ?? deps.id(),
      patch: {
        databaseId: newDbId,
        name: substituteVars(v.name ?? 'View', vars),
        type: v.type ?? 'table',
        order: v.order ?? null,
        config: v.config !== undefined ? (JSON.parse(JSON.stringify(v.config)) as unknown) : undefined,
        createdBy: opts.actorId ?? null,
        createdAt: deps.now,
      },
    });
  }

  // --- links whose BOTH ends are inside the copied set ---
  const remapRef = (id: unknown): string | null => pageMap.get(String(id ?? '')) ?? taskMap.get(String(id ?? '')) ?? null;
  for (const [, l] of Object.entries(snap.links ?? {})) {
    if (l.deleted) continue;
    const fromId = remapRef(l.fromId);
    const toId = remapRef(l.toId);
    if (!fromId || !toId) continue;
    const kind = String(l.kind ?? 'related');
    const fieldId = typeof l.fieldId === 'string' ? l.fieldId : null;
    writes.push({
      collection: 'links',
      id: linkId(kind, fieldId, fromId, toId),
      patch: {
        ...(l.fromType !== undefined ? { fromType: l.fromType } : {}),
        fromId,
        ...(l.toType !== undefined ? { toType: l.toType } : {}),
        toId,
        kind,
        fieldId,
        createdBy: opts.actorId ?? null,
        createdAt: deps.now,
      },
    });
  }

  // --- blocks (page bodies AND copied-record bodies) ---
  for (const [, b] of Object.entries(snap.blocks).filter(([, blk]) => ownedByCopiedSet(blk))) {
    const newOwnerId = pageMap.get(String(b.pageId)) ?? taskMap.get(String(b.pageId))!;
    let text = substituteVars(b.text, vars);
    // Page/record mentions inside the template re-point at the copies.
    text = text.replace(MENTION_TOKEN_RE, (m, kind: string, tid: string) => {
      const mapped = kind === 'page' ? pageMap.get(tid) : taskMap.get(tid);
      return mapped ? `@[${kind}:${mapped}]` : m;
    });
    const patch: Record<string, unknown> = {
      pageId: newOwnerId,
      order: b.order ?? null,
      type: b.type ?? 'p',
      text,
      ...(b.checked !== undefined ? { checked: b.checked } : {}),
      ...(b.parentType !== undefined ? { parentType: b.parentType } : {}),
      ...(b.fileId ? { fileId: b.fileId } : {}),
      ...(b.caption ? { caption: substituteVars(b.caption, vars) } : {}),
      ...(b.width !== undefined ? { width: b.width } : {}),
      ...(b.type === 'embed' && b.url ? { url: b.url, provider: b.provider ?? 'link' } : {}),
    };
    if (b.type === 'tasks' && typeof b.boardId === 'string' && b.boardId) {
      patch.boardId = boardMap.get(b.boardId) ?? b.boardId;
    }
    // Dashboard block whitelist (Phase 3 §3): config fields copy through,
    // authored databaseId/viewId/sources[].databaseId remap to live ids.
    if (DASHBOARD_BLOCK_TYPES.has(String(b.type))) {
      for (const k of ['limit', 'agg', 'fieldKey', 'format', 'scope', 'url', 'inline', 'filters'] as const) {
        if (b[k] !== undefined) patch[k] = typeof b[k] === 'object' && b[k] !== null ? JSON.parse(JSON.stringify(b[k])) : b[k];
      }
      if (b.heading !== undefined) patch.heading = substituteVars(b.heading, vars);
      if (b.label !== undefined) patch.label = substituteVars(b.label, vars);
      if (b.databaseId !== undefined) patch.databaseId = boardMap.get(String(b.databaseId)) ?? b.databaseId;
      if (b.viewId !== undefined) patch.viewId = viewMap.get(String(b.viewId)) ?? b.viewId;
      if (Array.isArray(b.sources)) {
        patch.sources = (b.sources as Record<string, unknown>[]).map((s) => {
          const t = { ...s };
          if (t.databaseId !== undefined) t.databaseId = boardMap.get(String(t.databaseId)) ?? t.databaseId;
          return t;
        });
      }
    }
    writes.push({ collection: 'blocks', id: deps.id(), patch });
  }

  return { writes, rootPageId: pageMap.get(opts.templateId)! };
}
