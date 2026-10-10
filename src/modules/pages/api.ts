import { useLiveQuery } from 'dexie-react-hooks';
import { authStore } from '../../core/auth';
import { logActivity } from '../../core/activity';
import { db, type LocalRow } from '../../core/db';
import { mutate, syncNow, syncStore } from '../../core/sync/engine';
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

/** Deep-copy a template page tree (blocks + embedded boards/tasks) via the shared planner.
 *  Bundled-pack installs additionally pass `reuseBoards`/`preserveTemplates`/`packInstall`
 *  (gallery + install_template); plain page-template instantiation leaves them off. */
export async function instantiateTemplate(
  templateId: string,
  opts: {
    title?: string;
    parentId?: string | null;
    variables?: Record<string, string>;
    templateKey?: string;
    snapshot?: RecSnapshot;
    reuseBoards?: Record<string, string>;
    preserveTemplates?: boolean;
    packInstall?: boolean;
    stableIds?: boolean;
  } = {},
): Promise<{ rootPageId: string; applied: number; kept: number } | null> {
  if (opts.stableIds) {
    // Bundled-pack installs reconcile against synced rows only — an existing
    // row (even tombstoned) is never overwritten, so user edits and
    // archived/deleted state survive Reinstall. Pull first so the local view
    // is authoritative: without one successful sync we cannot distinguish a
    // genuinely missing row from one whose server-side edits we have not
    // seen, so we refuse rather than write bundled defaults over unseen data.
    await syncNow();
    // syncNow() returns early when a sync is already running — wait for it
    // to settle rather than reading a mid-flight 'syncing' status.
    for (let i = 0; i < 50 && syncStore.get().status === 'syncing'; i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    // 'rejected' still completed the pull — local rows are authoritative for
    // reconciliation; offline/error/idle means we cannot verify.
    const st = syncStore.get().status;
    if (st !== 'synced' && st !== 'rejected') {
      throw new Error('Install needs one successful sync to reconcile existing rows — reconnect and try again');
    }
  }
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
  const plan = planTemplateInstantiation(
    snap,
    {
      templateId,
      title: opts.title,
      parentId: opts.parentId ?? null,
      variables: opts.variables,
      actorId: me?.id,
      templateKey: opts.templateKey,
      reuseBoards: opts.reuseBoards,
      preserveTemplates: opts.preserveTemplates,
      packInstall: opts.packInstall,
      stableIds: opts.stableIds,
    },
    { id: uuid, now: Date.now() },
  );
  if (!plan) return null;
  // Reconcile against the authenticated user's LOCAL synced collections —
  // `snap` above is the template's own record set, not workspace state.
  const present = new Map<string, Set<string>>();
  if (opts.stableIds) {
    const colls = [...new Set(plan.writes.map((w) => w.collection))];
    await Promise.all(colls.map(async (c) => {
      const rows = (await db.table(c).toArray()) as LocalRow[];
      present.set(c, new Set(rows.map((r) => r.id)));
    }));
  }
  let applied = 0;
  let kept = 0;
  for (const w of plan.writes) {
    if (opts.stableIds && present.get(w.collection)?.has(w.id)) {
      kept++;
      continue;
    }
    await mutate(w.collection, w.id, w.patch);
    applied++;
  }
  logActivity('created', 'page', plan.rootPageId, opts.title ?? 'From template');
  return { rootPageId: plan.rootPageId, applied, kept };
}
