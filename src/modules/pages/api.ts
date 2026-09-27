import { useLiveQuery } from 'dexie-react-hooks';
import { generateKeyBetween } from 'fractional-indexing';
import { authStore } from '../../core/auth';
import { logActivity } from '../../core/activity';
import { db, type LocalRow } from '../../core/db';
import { mutate } from '../../core/sync/engine';
import { cmpOrder, uuid } from '../../core/utils';

export interface PageRow extends LocalRow {
  title?: string;
  icon?: string;
  parentId?: string | null;
  order?: string;
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
  const order = generateKeyBetween(live.length ? String(live[live.length - 1].order ?? '') || null : null, null);
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
