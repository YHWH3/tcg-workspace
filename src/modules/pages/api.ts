import { useLiveQuery } from 'dexie-react-hooks';
import { authStore } from '../../core/auth';
import { logActivity } from '../../core/activity';
import { db, type LocalRow } from '../../core/db';
import { mutate } from '../../core/sync/engine';
import { cmpOrder, orderBetween, uuid } from '../../core/utils';
import { planTemplateInstantiation, type RecSnapshot } from '../../../shared/templates';

export interface PageRow extends LocalRow {
  title?: string;
  icon?: string;
  parentId?: string | null;
  order?: string;
  isTemplate?: boolean;
  deleted?: boolean;
}

export function usePages(): PageRow[] {
  return (useLiveQuery(() => db.pages.orderBy('order').toArray(), [], []) ?? []) as PageRow[];
}

export function visiblePages(pages: PageRow[]): PageRow[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const deletedAncestor = (p: PageRow): boolean => {
    let cur: PageRow | undefined = p;
    const seen = new Set<string>();
    while (cur) {
      if (seen.has(cur.id)) return true;
      seen.add(cur.id);
      if (cur.deleted) return true;
      cur = cur.parentId ? byId.get(String(cur.parentId)) : undefined;
    }
    return false;
  };
  return pages.filter((p) => !deletedAncestor(p));
}

export async function createPage(parentId: string | null = null): Promise<string> {
  const all = await db.pages.toArray();
  const live = all.filter((p) => (p.parentId ?? null) === parentId && !p.deleted).sort((a, b) => cmpOrder(a.order, b.order));
  const order = orderBetween(live.length ? String(live[live.length - 1].order ?? '') || null : null, null);
  const id = uuid();
  const me = authStore.get().user;
  await mutate('pages', id, {
    title: '',
    icon: '📄',
    parentId,
    order,
    createdBy: me?.id ?? null,
    createdAt: Date.now(),
  });
  logActivity('created', 'page', id, 'Untitled');
  return id;
}

export async function movePage(id: string, parentId: string | null): Promise<void> {
  const all = await db.pages.toArray();
  if (id === parentId) return;
  // block cycles: refuse when parentId is the page itself or one of its descendants
  let cur: string | null = parentId;
  while (cur) {
    if (cur === id) return;
    cur = (all.find((p) => p.id === cur)?.parentId as string | null | undefined) ?? null;
  }
  const live = all.filter((p) => ((p.parentId as string | null | undefined) ?? null) === parentId && !p.deleted && p.id !== id).sort((a, b) => cmpOrder(a.order, b.order));
  const order = orderBetween(live.length ? String(live[live.length - 1].order ?? '') || null : null, null);
  await mutate('pages', id, { parentId, order });
  const pg = all.find((p) => p.id === id);
  logActivity('moved', 'page', id, String(pg?.title ?? 'Untitled'), { parentId });
}

export async function deletePage(id: string): Promise<void> {
  const page = await db.pages.get(id);
  await mutate('pages', id, { deleted: true });
  logActivity('deleted', 'page', id, String(page?.title ?? 'Untitled'));
}

export async function renamePage(id: string, title: string): Promise<void> {
  const page = await db.pages.get(id);
  await mutate('pages', id, { title });
  if (page && String(page.title ?? '') !== title) logActivity('renamed', 'page', id, title || 'Untitled');
}

/* ---------- templates ---------- */

/** Deep-copy a template page tree (blocks + embedded boards/tasks) via the shared planner. */
export async function instantiateTemplate(templateId: string, opts: { title?: string; parentId?: string | null; variables?: Record<string, string>; templateKey?: string; snapshot?: RecSnapshot } = {}): Promise<string | null> {
  const snap = opts.snapshot ?? await (async () => {
    const [pages, blocks, boards, tasks, views, links] = await Promise.all([db.pages.toArray(), db.blocks.toArray(), db.boards.toArray(), db.tasks.toArray(), db.views.toArray(), db.links.toArray()]);
    return {
      pages: Object.fromEntries(pages.map((r) => [r.id, r])),
      blocks: Object.fromEntries(blocks.map((r) => [r.id, r])),
      boards: Object.fromEntries(boards.map((r) => [r.id, r])),
      tasks: Object.fromEntries(tasks.map((r) => [r.id, r])),
      views: Object.fromEntries(views.map((r) => [r.id, r])),
      links: Object.fromEntries(links.map((r) => [r.id, r])),
    };
  })();
  const me = authStore.get().user;
  const plan = planTemplateInstantiation(snap, { templateId, title: opts.title, parentId: opts.parentId ?? null, variables: opts.variables, actorId: me?.id, templateKey: opts.templateKey }, { id: uuid, now: Date.now() });
  if (!plan) return null;
  for (const w of plan.writes) await mutate(w.collection, w.id, w.patch);
  logActivity('created', 'page', plan.rootPageId, opts.title ?? 'From template');
  return plan.rootPageId;
}
