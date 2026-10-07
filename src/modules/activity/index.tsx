import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Activity as ActivityIcon, Inbox } from 'lucide-react';
import { authStore } from '../../core/auth';
import { db, type LocalRow } from '../../core/db';
import { Avatar, Dot, EmptyState } from '../../core/ui';
import { resolveUser, useUsers } from '../../core/users';
import { cn, relTime } from '../../core/utils';
import type { AppModule } from '../types';

export interface ActivityRow extends LocalRow {
  actorId?: string;
  verb?: string;
  targetType?: string;
  targetId?: string;
  targetTitle?: string;
  meta?: { assigneeId?: string | null; userId?: string; pageId?: string; boardId?: string; via?: string } | null;
  createdAt?: number;
}

const SEEN_KEY = 'ws_activity_seen';

function useActivity(): ActivityRow[] {
  return (useLiveQuery(() => db.activity.toArray(), [], []) ?? []) as ActivityRow[];
}

function ActivityBadge() {
  const activity = useActivity();
  const [seen, setSeen] = useState(() => Number(localStorage.getItem(SEEN_KEY) ?? 0));
  useEffect(() => {
    const fn = () => setSeen(Number(localStorage.getItem(SEEN_KEY) ?? 0));
    window.addEventListener('focus', fn);
    const t = setInterval(fn, 5000);
    return () => {
      window.removeEventListener('focus', fn);
      clearInterval(t);
    };
  }, []);
  const latest = Math.max(0, ...activity.map((a) => Number(a.createdAt ?? 0)));
  const me = authStore.get().user?.id;
  const hasUnread = activity.some((a) => Number(a.createdAt ?? 0) > seen && a.actorId !== me);
  return latest > seen && hasUnread ? <Dot /> : null;
}

function verbText(a: ActivityRow): string {
  switch (a.verb) {
    case 'created':
      return `created ${a.targetType === 'page' ? 'page' : 'task'}`;
    case 'renamed':
      return 'renamed page';
    case 'deleted':
      return `deleted ${a.targetType}`;
    case 'completed':
      return 'completed task';
    case 'moved':
      return 'moved task';
    case 'assigned':
      return 'assigned task';
    case 'commented':
      return 'commented on';
    case 'mentioned':
      return 'mentioned you in';
    case 'captured':
      return 'captured';
    default:
      return String(a.verb ?? 'updated');
  }
}

function ActivityPage() {
  const [tab, setTab] = useState<'you' | 'all'>('you');
  const activity = useActivity();
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], []) ?? [];
  const users = useUsers();
  const meUser = authStore.get().user;
  const me = meUser?.id;

  useEffect(() => {
    localStorage.setItem(SEEN_KEY, String(Date.now()));
  }, []);

  const myTaskIds = useMemo(() => new Set(tasks.filter((t) => t.assigneeId === me && !t.deleted).map((t) => t.id)), [tasks, me]);

  const forYou = activity
    .filter(
      (a) =>
        (a.targetType === 'task' && (a.meta?.assigneeId === me || myTaskIds.has(String(a.targetId)))) ||
        (a.verb === 'mentioned' && a.meta?.userId === me),
    )
    .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
  const all = [...activity].sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
  const list = tab === 'you' ? forYou : all;

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto px-5 py-8">
      <h1 className="mb-4 text-xl font-semibold tracking-tight">Activity</h1>
      <div className="mb-4 flex rounded-lg bg-neutral-100 p-0.5 text-xs dark:bg-neutral-800 self-start w-fit">
        {(
          [
            ['you', 'For you'],
            ['all', 'All activity'],
          ] as const
        ).map(([v, label]) => (
          <button key={v} onClick={() => setTab(v)} className={cn('rounded-md px-3 py-1.5 font-medium transition-colors', tab === v ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-950 dark:text-white' : 'text-neutral-500')}>
            {label}
          </button>
        ))}
      </div>
      {list.length === 0 ? (
        <EmptyState icon={Inbox} title={tab === 'you' ? 'Nothing for you yet' : 'No activity yet'} body="Activity like assignments and comments will show up here." />
      ) : (
        <ul className="overflow-hidden rounded-xl border border-neutral-200/70 dark:border-neutral-800">
          {list.slice(0, 200).map((a) => {
            const actor = resolveUser(a.actorId ?? null, users, meUser);
            const href =
              a.targetType === 'task'
                ? `/tasks/${a.targetId}`
                : a.targetType === 'page'
                  ? `/pages/${a.targetId}`
                  : a.targetType === 'block' && a.meta?.pageId
                    ? `/pages/${a.meta.pageId}`
                    : a.targetType === 'mooditem' && a.meta?.boardId
                      ? `/moodboards/${a.meta.boardId}`
                      : a.targetType === 'moodboard'
                        ? `/moodboards/${a.targetId}`
                        : null;
            return (
              <li key={a.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-800">
                <Link to={href ?? '#'} className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-900">
                  <Avatar name={actor?.name ?? '?'} color={actor?.color} size={26} className="mt-0.5" />
                  <div className="min-w-0 flex-1 text-sm">
                    <span className="font-medium">{actor?.name ?? 'Someone'}</span>{' '}
                    <span className="text-neutral-500 dark:text-neutral-400">{verbText(a)}</span>{' '}
                    <span className="font-medium">{String(a.targetTitle ?? '') || 'Untitled'}</span>
                    {!!a.meta?.via && <span className="text-neutral-400"> · via {String(a.meta.via)}</span>}
                    {a.verb === 'assigned' && a.meta?.assigneeId && (
                      <span className="text-neutral-500 dark:text-neutral-400"> → {resolveUser(a.meta.assigneeId, users, meUser)?.name ?? 'someone'}</span>
                    )}
                  </div>
                  <span className="shrink-0 pt-0.5 text-[11px] text-neutral-400">{relTime(Number(a.createdAt ?? 0))}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export const activityModule: AppModule = {
  id: 'activity',
  label: 'Activity',
  icon: ActivityIcon,
  navItem: { path: '/activity', label: 'Activity', icon: ActivityIcon },
  navBadge: ActivityBadge,
  routes: [{ path: 'activity', element: <ActivityPage /> }],
  collections: ['activity'],
};
