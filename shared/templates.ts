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
import { linkId } from './linkid';

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
  /** Stamped on every copied row so installers can recognise bundled-template copies. */
  templateKey?: string;
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

<<<<<<< HEAD
/** Mention tokens that can point into the copied set: pages and records. Users stay literal. */
const MENTION_TOKEN_RE = /@\[(page|rec):([^\]]+)\]/g;
||||||| parent of bdd1edc (feat(phase1): bundled starter template + §3.5 planner extension)
const PAGE_TOKEN_RE = /@\[page:([^\]]+)\]/g;
=======
const PAGE_TOKEN_RE = /@\[page:([^\]]+)\]/g;
const REC_TOKEN_RE = /@\[rec:([^\]]+)\]/g;
>>>>>>> bdd1edc (feat(phase1): bundled starter template + §3.5 planner extension)

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

const remapMentions = (text: unknown, vars: Record<string, string>, pageMap: Map<string, string>, taskMap: Map<string, string>): string =>
  substituteVars(text, vars)
    .replace(PAGE_TOKEN_RE, (m, pid: string) => (pageMap.has(pid) ? `@[page:${pageMap.get(pid)}]` : m))
    .replace(REC_TOKEN_RE, (m, rid: string) => (taskMap.has(rid) ? `@[rec:${taskMap.get(rid)}]` : m));

/**
 * Plan a deep copy of the template page subtree. Blocks under `tasks` type
 * spawn a copied board (with its views, non-deleted tasks/records, and links
 * between copied endpoints) instead of pointing at the original.
 * Returns null when the template id doesn't resolve to a live page.
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
        isTemplate: false,
        createdBy: opts.actorId ?? null,
        createdAt: deps.now,
        ...(opts.templateKey ? { templateKey: opts.templateKey } : {}),
      },
    });
  }

<<<<<<< HEAD
  // --- boards + records ---
  // Blocks owned by a copied page, or by a copied record (record body blocks
  // have pageId = record id + parentType 'record').
||||||| parent of bdd1edc (feat(phase1): bundled starter template + §3.5 planner extension)
  // --- boards + tasks referenced by copied `tasks` blocks ---
=======
  // --- boards + tasks + views referenced by copied `tasks` blocks ---
>>>>>>> bdd1edc (feat(phase1): bundled starter template + §3.5 planner extension)
  const boardMap = new Map<string, string>();
<<<<<<< HEAD
  const taskMap = new Map<string, string>();
  const srcBoardIds: string[] = [];
  const ownedByCopiedSet = (b: Record<string, unknown>): boolean =>
    !b.deleted && (pageMap.has(String(b.pageId ?? '')) || taskMap.has(String(b.pageId ?? '')));

  // Fixpoint: a `tasks` block in a copied page/record pulls in its database;
  // each copied database's records pull in their own body blocks, which may
  // embed further databases. All board ids are allocated before ANY board
  // patch is written so relation targets between copied databases remap.
  let grew = true;
  while (grew) {
    grew = false;
    for (const [, b] of Object.entries(snap.blocks)) {
      if (!ownedByCopiedSet(b)) continue;
      if (b.type === 'tasks' && typeof b.boardId === 'string' && b.boardId && !boardMap.has(b.boardId)) {
        boardMap.set(b.boardId, deps.id());
        srcBoardIds.push(b.boardId);
        grew = true;
        for (const [tid, t] of Object.entries(snap.tasks)) {
          if (!t.deleted && String(t.boardId ?? 'board-default') === b.boardId && !taskMap.has(tid)) {
            taskMap.set(tid, deps.id());
          }
        }
      }
    }
  }

  const remapField = (f: FieldDef): FieldDef => ({
    ...f,
    options: Array.isArray(f.options) ? f.options.map((o) => ({ ...o })) : undefined,
    // Relation targets pointing at another copied database get remapped;
    // pairedFieldId stays — field ids are copied unchanged.
    relation: f.relation ? { ...f.relation, target: boardMap.get(f.relation.target) ?? f.relation.target } : undefined,
  });

  for (const srcBoardId of srcBoardIds) {
||||||| parent of bdd1edc (feat(phase1): bundled starter template + §3.5 planner extension)
  const planBoard = (srcBoardId: string): string => {
    const known = boardMap.get(srcBoardId);
    if (known) return known;
=======
  const viewMap = new Map<string, string>();
  const taskMap = new Map<string, string>();
  const boardWrites = new Map<string, PlannedWrite>(); // srcBoardId → write (patched again after viewMap fills)

  const planBoard = (srcBoardId: string): string => {
    const known = boardMap.get(srcBoardId);
    if (known) return known;
>>>>>>> bdd1edc (feat(phase1): bundled starter template + §3.5 planner extension)
    const src = snap.boards[srcBoardId];
    const newId = boardMap.get(srcBoardId)!;
    const order = String(deps.now); // moodboards/boards use timestamp-ish order strings; keep consistent ordering
    const patch: Record<string, unknown> = {
      name: substituteVars(src?.name ?? 'Board', vars),
      icon: src?.icon ?? '🗂️',
      kind: src?.kind,
      recordNoun: src?.recordNoun,
      description: src?.description !== undefined ? substituteVars(src.description, vars) : undefined,
      showBuiltins: src?.showBuiltins,
      columns: Array.isArray(src?.columns) ? src.columns.map((c) => ({ ...(c as object) })) : undefined,
<<<<<<< HEAD
      fields: Array.isArray(src?.fields) ? (src.fields as FieldDef[]).map(remapField) : undefined,
||||||| parent of bdd1edc (feat(phase1): bundled starter template + §3.5 planner extension)
      fields: Array.isArray(src?.fields) ? (src.fields as FieldDef[]).map((f) => ({ ...f, options: Array.isArray(f.options) ? f.options.map((o) => ({ ...o })) : undefined })) : undefined,
=======
      // Field ids are preserved so view configs, relation pairs and link rows stay valid.
      fields: Array.isArray(src?.fields) ? (src.fields as FieldDef[]).map((f) => ({ ...f, relation: f.relation ? { ...f.relation } : undefined, options: Array.isArray(f.options) ? f.options.map((o) => ({ ...o })) : undefined })) : undefined,
      defaultViewId: src?.defaultViewId ?? null,
>>>>>>> bdd1edc (feat(phase1): bundled starter template + §3.5 planner extension)
      order,
      createdBy: opts.actorId ?? null,
      createdAt: deps.now,
      ...(opts.templateKey ? { templateKey: opts.templateKey } : {}),
    };
<<<<<<< HEAD
    for (const k of ['kind', 'recordNoun', 'showBuiltins', 'templateKey'] as const) {
      if (src?.[k] !== undefined) patch[k] = src[k];
    }
    if (src?.description !== undefined) patch.description = substituteVars(src.description, vars);
    writes.push({ collection: 'boards', id: newId, patch });

    // Copy non-deleted records on that board (parentId remapped via taskMap).
||||||| parent of bdd1edc (feat(phase1): bundled starter template + §3.5 planner extension)
    writes.push({ collection: 'boards', id: newId, patch });
    if (!src) return newId;
    // Copy non-deleted tasks on that board.
=======
    const bw: PlannedWrite = { collection: 'boards', id: newId, patch };
    writes.push(bw);
    boardWrites.set(srcBoardId, bw);
    if (!src) return newId;

    // Copy non-deleted tasks on that board — two passes so parentId remaps inside the set.
>>>>>>> bdd1edc (feat(phase1): bundled starter template + §3.5 planner extension)
    const tasks = Object.entries(snap.tasks)
      .filter(([tid, t]) => taskMap.has(tid) && String(t.boardId ?? 'board-default') === srcBoardId)
      .sort((a, b) => cmpOrder(a[1].order, b[1].order));
<<<<<<< HEAD
    for (const [tid, t] of tasks) {
||||||| parent of bdd1edc (feat(phase1): bundled starter template + §3.5 planner extension)
    for (const [, t] of tasks) {
=======
    for (const [oldTid] of tasks) taskMap.set(oldTid, deps.id());
    for (const [oldTid, t] of tasks) {
>>>>>>> bdd1edc (feat(phase1): bundled starter template + §3.5 planner extension)
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(t)) if (k.startsWith('p_')) props[k] = v;
      const srcParent = String(t.parentId ?? '');
      writes.push({
        collection: 'tasks',
<<<<<<< HEAD
        id: taskMap.get(tid)!,
||||||| parent of bdd1edc (feat(phase1): bundled starter template + §3.5 planner extension)
        id: deps.id(),
=======
        id: taskMap.get(oldTid)!,
>>>>>>> bdd1edc (feat(phase1): bundled starter template + §3.5 planner extension)
        patch: {
          title: substituteVars(t.title, vars),
          description: remapMentions(t.description, vars, pageMap, taskMap),
          boardId: newId,
          status: t.status ?? null,
          priority: t.priority ?? 'none',
<<<<<<< HEAD
          parentId: t.parentId != null ? (taskMap.get(String(t.parentId)) ?? null) : null,
||||||| parent of bdd1edc (feat(phase1): bundled starter template + §3.5 planner extension)
=======
          parentId: taskMap.get(srcParent) ?? null,
>>>>>>> bdd1edc (feat(phase1): bundled starter template + §3.5 planner extension)
          order: t.order ?? null,
          createdBy: opts.actorId ?? null,
          createdAt: deps.now,
          ...props,
        },
      });
    }
<<<<<<< HEAD
  }
||||||| parent of bdd1edc (feat(phase1): bundled starter template + §3.5 planner extension)
    return newId;
  };
=======
    // Copy this board's views — field ids inside view configs stay valid.
    for (const [oldVid, v] of Object.entries(snap.views ?? {})) {
      if (v.deleted || String(v.databaseId ?? '') !== srcBoardId) continue;
      const newVid = deps.id();
      viewMap.set(oldVid, newVid);
      writes.push({
        collection: 'views',
        id: newVid,
        patch: {
          databaseId: newId,
          name: substituteVars(v.name ?? 'View', vars),
          type: v.type ?? 'table',
          config: v.config ? JSON.parse(JSON.stringify(v.config)) : {},
          order: v.order ?? null,
          createdBy: opts.actorId ?? null,
          createdAt: deps.now,
          ...(opts.templateKey ? { templateKey: opts.templateKey } : {}),
        },
      });
    }
    return newId;
  };
>>>>>>> bdd1edc (feat(phase1): bundled starter template + §3.5 planner extension)

<<<<<<< HEAD
  // --- views of copied databases (field keys p_<id> stay valid: ids unchanged) ---
  for (const [, v] of Object.entries(snap.views ?? {})) {
    if (v.deleted) continue;
    const newDbId = boardMap.get(String(v.databaseId ?? ''));
    if (!newDbId) continue;
    writes.push({
      collection: 'views',
      id: deps.id(),
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
||||||| parent of bdd1edc (feat(phase1): bundled starter template + §3.5 planner extension)
  // --- blocks ---
  const blockEntries = Object.entries(snap.blocks).filter(([, b]) => !b.deleted && pageMap.has(String(b.pageId ?? '')));
  for (const [, b] of blockEntries) {
    const newPageId = pageMap.get(String(b.pageId))!;
    let text = substituteVars(b.text, vars);
    // Page mentions inside the template re-point at the copied pages.
    text = text.replace(PAGE_TOKEN_RE, (m, pid: string) => (pageMap.has(pid) ? `@[page:${pageMap.get(pid)}]` : m));
=======
  // --- blocks ---
  const blockEntries = Object.entries(snap.blocks).filter(([, b]) => !b.deleted && pageMap.has(String(b.pageId ?? '')));
  // Plan every referenced board first so taskMap is complete before mention remapping.
  for (const [, b] of blockEntries) {
    if (b.type === 'tasks' && typeof b.boardId === 'string' && b.boardId) planBoard(b.boardId);
  }
  const blockMap = new Map<string, string>();
  for (const [oldBid] of blockEntries) blockMap.set(oldBid, deps.id());
  for (const [oldBid, b] of blockEntries) {
    const newPageId = pageMap.get(String(b.pageId))!;
    const text = remapMentions(b.text, vars, pageMap, taskMap);
>>>>>>> bdd1edc (feat(phase1): bundled starter template + §3.5 planner extension)
    const patch: Record<string, unknown> = {
      pageId: newOwnerId,
      order: b.order ?? null,
      type: b.type ?? 'p',
      text,
      ...(b.checked !== undefined ? { checked: b.checked } : {}),
      ...(b.parentType !== undefined ? { parentType: b.parentType } : {}),
      ...(b.fileId ? { fileId: b.fileId } : {}),
      ...(b.url ? { url: b.url } : {}),
      ...(b.caption ? { caption: substituteVars(b.caption, vars) } : {}),
      ...(b.width !== undefined ? { width: b.width } : {}),
      ...(b.type === 'embed' && b.url ? { url: b.url, provider: b.provider ?? 'link' } : {}),
    };
    if (b.type === 'tasks' && typeof b.boardId === 'string' && b.boardId) {
      patch.boardId = boardMap.get(b.boardId) ?? b.boardId;
    }
    writes.push({ collection: 'blocks', id: blockMap.get(oldBid)!, patch });
  }

  // --- remap passes on board writes (relation targets inside the template, defaultViewId) ---
  for (const [srcBoardId, bw] of boardWrites) {
    const src = snap.boards[srcBoardId];
    const fields = bw.patch.fields as FieldDef[] | undefined;
    if (fields) {
      for (const f of fields) {
        if (f.relation?.target && f.relation.target !== 'pages' && boardMap.has(f.relation.target)) {
          f.relation.target = boardMap.get(f.relation.target)!;
        }
      }
    }
    if (src?.defaultViewId) bw.patch.defaultViewId = viewMap.get(String(src.defaultViewId)) ?? null;
  }

  // --- links whose endpoints are all inside the copied sets ---
  const endpointMap = (type: unknown, id: unknown): string | null => {
    const t = String(type ?? '');
    const i = String(id ?? '');
    if (t === 'record' || t === 'task') return taskMap.get(i) ?? null;
    if (t === 'page') return pageMap.get(i) ?? null;
    if (t === 'board') return boardMap.get(i) ?? null;
    if (t === 'block') return blockMap.get(i) ?? null;
    return null; // file/mooditem/etc are not copied — drop the link
  };
  for (const [, l] of Object.entries(snap.links ?? {})) {
    if (l.deleted) continue;
    const newFrom = endpointMap(l.fromType, l.fromId);
    const newTo = endpointMap(l.toType, l.toId);
    if (!newFrom || !newTo) continue;
    const kind = String(l.kind ?? 'related');
    const fieldId = String(l.fieldId ?? '');
    writes.push({
      collection: 'links',
      id: linkId(kind, fieldId, newFrom, newTo),
      patch: {
        fromType: l.fromType,
        fromId: newFrom,
        toType: l.toType,
        toId: newTo,
        kind,
        fieldId: fieldId || null,
        deleted: false,
        createdBy: opts.actorId ?? null,
        createdAt: deps.now,
      },
    });
  }

  return { writes, rootPageId: pageMap.get(opts.templateId)! };
}
