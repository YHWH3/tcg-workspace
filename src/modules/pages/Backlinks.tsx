import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router';
import { Link2 } from 'lucide-react';
import { db } from '../../core/db';
import { renderPlain } from '../../core/mentions';
import { authStore } from '../../core/auth';
import { resolveUser, useUsers } from '../../core/users';

interface Backlink {
  pageId: string;
  icon: string;
  title: string;
  snippet: string;
}

/** "Linked from" — other pages whose blocks contain @[page:THIS]. */
export function Backlinks({ pageId }: { pageId: string }) {
  const users = useUsers();
  const me = authStore.get().user;
  const links = useLiveQuery(async () => {
    const token = `@[page:${pageId}]`;
    const [blocks, pages] = await Promise.all([db.blocks.toArray(), db.pages.toArray()]);
    const pageMap = new Map(pages.map((p) => [p.id, p]));
    const resolve = (kind: string, id: string): string => {
      if (kind === 'page') return String(pageMap.get(id)?.title ?? 'Untitled');
      const u = resolveUser(id, users, me);
      return u?.name ?? 'Someone';
    };
    const out: Backlink[] = [];
    for (const b of blocks) {
      const bText = String(b.text ?? '');
      if (b.deleted || !bText || b.pageId === pageId || !bText.includes(token)) continue;
      const page = pageMap.get(String(b.pageId));
      if (!page || page.deleted) continue;
      // One-line snippet around the first mention, rendered with names.
      const plain = renderPlain(bText, resolve);
      const idx = plain.indexOf(String(pageMap.get(pageId)?.title ?? ''));
      const snippet = plain.slice(Math.max(0, idx - 30), idx + 60).trim() || plain.slice(0, 80);
      out.push({ pageId: String(b.pageId), icon: String(page.icon ?? ''), title: String(page.title ?? 'Untitled'), snippet });
    }
    return out;
  }, [pageId, users.length]);

  if (!links || links.length === 0) return null;
  return (
    <div className="mt-8 border-t border-neutral-100 pt-4 dark:border-neutral-800/60" data-testid="backlinks">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-400">
        <Link2 size={12} /> Linked from
      </p>
      <div className="space-y-1">
        {links.map((l) => (
          <Link key={`${l.pageId}`} to={`/pages/${l.pageId}`} className="block rounded-lg px-2 py-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800">
            <span className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
              {l.icon} {l.title}
            </span>
            <span className="mt-0.5 block truncate text-xs text-neutral-400">…{l.snippet}…</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
