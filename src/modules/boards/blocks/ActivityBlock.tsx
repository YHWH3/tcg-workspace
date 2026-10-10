/**
 * `activity` dashboard block (§3): the Dexie `activity` collection scoped
 * 'all' | 'mine' | {pageTreeId} (descendants through the pages tree), rendered
 * as the Activity feed's row language — actor avatar, "<name> <verb>
 * <target>", target link, relative time, `meta.via` → "via <client>" — then
 * sliced by `limit`.
 */
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Activity as ActivityIcon } from 'lucide-react';
import { authStore } from '../../../core/auth';
import { db, type LocalRow } from '../../../core/db';
import { useStore } from '../../../core/store';
import { Avatar, Field, Select } from '../../../core/ui';
import { relTime } from '../../../core/utils';
import { resolveUser, useUsers } from '../../../core/users';
import { usePages } from '../../pages/api';
import { registerBlockType, type MediaBlockProps } from '../../pages/blocks/registry';
import { BlockNotice, DashBlock, HeadingField, LimitField, num, saveBlockCfg, str } from './shared';

interface ActivityRowLite {
  id: string;
  actorId?: string;
  verb?: string;
  targetType?: string;
  targetId?: string;
  targetTitle?: string;
  meta?: { via?: string; pageId?: string } | null;
  createdAt?: number;
}

/** All descendant page ids of rootId (inclusive), following parentId links. */
function pageSubtree(pages: { id: string; parentId?: unknown }[], rootId: string): Set<string> {
  const kids = new Map<string, string[]>();
  for (const p of pages) {
    const pid = typeof p.parentId === 'string' ? p.parentId : null;
    if (!pid) continue;
    kids.set(pid, [...(kids.get(pid) ?? []), p.id]);
  }
  const out = new Set<string>([rootId]);
  const queue = [...(kids.get(rootId) ?? [])];
  while (queue.length) {
    const id = queue.shift()!;
    if (out.has(id)) continue;
    out.add(id);
    queue.push(...(kids.get(id) ?? []));
  }
  return out;
}

function targetHref(row: ActivityRowLite, boardIdOf: (taskId: string) => string | undefined): string | null {
  if (row.targetType === 'page' && row.targetId) return `/pages/${row.targetId}`;
  if (row.targetType === 'board' && row.targetId) return `/boards/${row.targetId}`;
  if (row.targetType === 'task' && row.targetId) {
    const b = boardIdOf(row.targetId);
    return b ? `/boards/${b}/tasks/${row.targetId}` : null;
  }
  return null;
}

function ActivityBlockInner({ block }: { block: LocalRow }) {
  const me = useStore(authStore).user;
  const users = useUsers();
  const pages = usePages();
  const navigate = useNavigate();
  const rows = useLiveQuery(() => db.activity.toArray(), []) as ActivityRowLite[] | undefined;
  const tasks = useLiveQuery(() => db.tasks.toArray(), []) as LocalRow[] | undefined;

  const scope = block.scope;
  const scopeId = typeof scope === 'string' ? scope : scope && typeof scope === 'object' ? 'page' : 'all';
  const pageTreeId = scope && typeof scope === 'object' ? str((scope as Record<string, unknown>).pageTreeId) : undefined;

  const tree = useMemo(() => (scopeId === 'page' && pageTreeId ? pageSubtree(pages, pageTreeId) : null), [scopeId, pageTreeId, pages]);
  const boardOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tasks ?? []) m.set(t.id, typeof t.boardId === 'string' && t.boardId ? t.boardId : 'board-default');
    return m;
  }, [tasks]);

  if (rows === undefined) return <BlockNotice tone="loading">Loading…</BlockNotice>;

  let list = rows.filter((r) => r.verb);
  if (scopeId === 'mine' && me) list = list.filter((r) => r.actorId === me.id);
  else if (tree) list = list.filter((r) => (r.targetType === 'page' && r.targetId ? tree.has(r.targetId) : false) || (r.meta?.pageId ? tree.has(r.meta.pageId) : false));
  list = [...list].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const limit = num(block.limit) ?? 10;
  list = list.slice(0, limit);

  if (list.length === 0) return <BlockNotice>No activity yet.</BlockNotice>;

  return (
    <ul className="space-y-1">
      {list.map((r) => {
        const actor = resolveUser(r.actorId ?? null, users, me);
        const href = targetHref(r, (id) => boardOf.get(id));
        return (
          <li key={r.id} className="flex items-start gap-2 text-xs">
            <Avatar name={actor?.name ?? '?'} color={actor?.color} size={18} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1 leading-snug">
              <span className="font-medium">{actor?.name ?? 'Someone'}</span>{' '}
              <span className="text-neutral-500 dark:text-neutral-400">{String(r.verb ?? 'changed')}</span>{' '}
              {href ? (
                <a href={href} className="font-medium hover:underline" onClick={(e) => { e.preventDefault(); navigate(href); }}>
                  {String(r.targetTitle ?? 'Untitled')}
                </a>
              ) : (
                <span className="font-medium">{String(r.targetTitle ?? 'Untitled')}</span>
              )}
              {r.meta?.via && <span className="text-neutral-400"> · via {String(r.meta.via)}</span>}
              <span className="block text-[10px] text-neutral-400">{r.createdAt ? relTime(r.createdAt) : ''}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function ActivityBlock({ block }: MediaBlockProps) {
  const pages = usePages();
  const scope = block.scope;
  const scopeId = typeof scope === 'string' ? scope : scope && typeof scope === 'object' ? 'page' : 'all';
  const pageTreeId = scope && typeof scope === 'object' ? str((scope as Record<string, unknown>).pageTreeId) : '';
  const livePages = pages.filter((p) => !p.deleted);
  const setScope = (v: string) => saveBlockCfg(block, { scope: v === 'page' ? { pageTreeId: livePages[0]?.id ?? null } : v });
  return (
    <DashBlock
      block={block}
      icon={ActivityIcon}
      label="Activity"
      config={
        <>
          <HeadingField value={str(block.heading)} onChange={(v) => saveBlockCfg(block, { heading: v ?? null })} />
          <Field label="Scope">
            <Select value={scopeId} onChange={(e) => setScope(e.target.value)} aria-label="Activity scope">
              <option value="all">All activity</option>
              <option value="mine">Mine only</option>
              <option value="page">Page tree…</option>
            </Select>
          </Field>
          {scopeId === 'page' && (
            <Field label="Page">
              <Select value={pageTreeId} onChange={(e) => saveBlockCfg(block, { scope: { pageTreeId: e.target.value || null } })} aria-label="Page tree root">
                <option value="">Pick a page…</option>
                {livePages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {String(p.icon ?? '')} {String(p.title ?? '') || 'Untitled'}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <LimitField value={num(block.limit)} onChange={(n) => saveBlockCfg(block, { limit: n ?? null })} />
        </>
      }
    >
      {() => <ActivityBlockInner block={block} />}
    </DashBlock>
  );
}

registerBlockType('activity', 'Activity', ActivityBlock);
export default ActivityBlock;
