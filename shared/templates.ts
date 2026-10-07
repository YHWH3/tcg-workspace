/* Pure template-instantiation planner. Turns a snapshot of records + options
 * into the list of record patches that create the copy — the client applies
 * them through mutate(), the worker through applyChanges(). One source. */

import { cmpOrder, orderBetween } from './order';
import type { FieldDef } from './fields';

export interface RecSnapshot {
  pages: Record<string, Record<string, unknown>>;
  blocks: Record<string, Record<string, unknown>>;
  boards: Record<string, Record<string, unknown>>;
  tasks: Record<string, Record<string, unknown>>;
}

export interface TemplateOpts {
  templateId: string;
  title?: string;
  parentId?: string | null;
  /** {{name}} substitutions for titles, block text and board names. */
  variables?: Record<string, string>;
  actorId?: string | null;
}

export interface PlannedWrite {
  collection: 'pages' | 'blocks' | 'boards' | 'tasks' | 'moodboards' | 'mooditems';
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

const PAGE_TOKEN_RE = /@\[page:([^\]]+)\]/g;

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
        isTemplate: false,
        createdBy: opts.actorId ?? null,
        createdAt: deps.now,
      },
    });
  }

  // --- boards + tasks referenced by copied `tasks` blocks ---
  const boardMap = new Map<string, string>();
  const planBoard = (srcBoardId: string): string => {
    const known = boardMap.get(srcBoardId);
    if (known) return known;
    const src = snap.boards[srcBoardId];
    const newId = deps.id();
    boardMap.set(srcBoardId, newId);
    const order = String(deps.now); // moodboards/boards use timestamp-ish order strings; keep consistent ordering
    const patch: Record<string, unknown> = {
      name: substituteVars(src?.name ?? 'Board', vars),
      icon: src?.icon ?? '🗂️',
      columns: Array.isArray(src?.columns) ? src.columns.map((c) => ({ ...(c as object) })) : undefined,
      fields: Array.isArray(src?.fields) ? (src.fields as FieldDef[]).map((f) => ({ ...f, options: Array.isArray(f.options) ? f.options.map((o) => ({ ...o })) : undefined })) : undefined,
      order,
      createdBy: opts.actorId ?? null,
      createdAt: deps.now,
    };
    writes.push({ collection: 'boards', id: newId, patch });
    if (!src) return newId;
    // Copy non-deleted tasks on that board.
    const tasks = Object.entries(snap.tasks)
      .filter(([, t]) => !t.deleted && String(t.boardId ?? 'board-default') === srcBoardId)
      .sort((a, b) => cmpOrder(a[1].order, b[1].order));
    for (const [, t] of tasks) {
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(t)) if (k.startsWith('p_')) props[k] = v;
      writes.push({
        collection: 'tasks',
        id: deps.id(),
        patch: {
          title: substituteVars(t.title, vars),
          description: substituteVars(t.description, vars),
          boardId: newId,
          status: t.status ?? null,
          priority: t.priority ?? 'none',
          order: t.order ?? null,
          createdBy: opts.actorId ?? null,
          createdAt: deps.now,
          ...props,
        },
      });
    }
    return newId;
  };

  // --- blocks ---
  const blockEntries = Object.entries(snap.blocks).filter(([, b]) => !b.deleted && pageMap.has(String(b.pageId ?? '')));
  for (const [, b] of blockEntries) {
    const newPageId = pageMap.get(String(b.pageId))!;
    let text = substituteVars(b.text, vars);
    // Page mentions inside the template re-point at the copied pages.
    text = text.replace(PAGE_TOKEN_RE, (m, pid: string) => (pageMap.has(pid) ? `@[page:${pageMap.get(pid)}]` : m));
    const patch: Record<string, unknown> = {
      pageId: newPageId,
      order: b.order ?? null,
      type: b.type ?? 'p',
      text,
      ...(b.checked !== undefined ? { checked: b.checked } : {}),
      ...(b.fileId ? { fileId: b.fileId } : {}),
      ...(b.caption ? { caption: substituteVars(b.caption, vars) } : {}),
      ...(b.width !== undefined ? { width: b.width } : {}),
    };
    if (b.type === 'tasks' && typeof b.boardId === 'string' && b.boardId) {
      patch.boardId = planBoard(b.boardId);
    }
    writes.push({ collection: 'blocks', id: deps.id(), patch });
  }

  return { writes, rootPageId: pageMap.get(opts.templateId)! };
}
