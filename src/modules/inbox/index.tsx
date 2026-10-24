import {accessClientStore} from '../../core/accessClient';
import {useStore} from '../../core/store';
// Phase 4 — Inbox module (Workstream B). Notifications are server-only rows
// read through /api/notifications — never synced records — so this module owns
// no Dexie collection and shows an honest "needs connection" state offline.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { BellOff, Check, CheckCheck, ChevronDown, Inbox as InboxIcon, WifiOff } from 'lucide-react';
import { api, ApiError,getToken } from '../../core/api';
import { authStore } from '../../core/auth';
import { Avatar, Button, EmptyState, Select } from '../../core/ui';
import { resolveUser, useUsers } from '../../core/users';
import { cn, relTime } from '../../core/utils';
import type { AppModule } from '../types';
import { AskAiMenu } from '../../core/assistant/AskAiMenu';

/* ---------- Types (mirrors worker rows + users.prefs) ---------- */

export type NotifKind =
  | 'mention'
  | 'assigned'
  | 'comment_on_mine'
  | 'due_soon'
  | 'overdue'
  | 'approval_requested'
  | 'approval_decided'
  | 'form_submission'
  | 'automation';

const NOTIF_KINDS: NotifKind[] = [
  'mention',
  'assigned',
  'comment_on_mine',
  'due_soon',
  'overdue',
  'approval_requested',
  'approval_decided',
  'form_submission',
  'automation',
];

const KIND_LABELS: Record<NotifKind, string> = {
  mention: 'Mentions',
  assigned: 'Assignments',
  comment_on_mine: 'Comments on your records',
  due_soon: 'Due soon reminders',
  overdue: 'Overdue reminders',
  approval_requested: 'Approval requests',
  approval_decided: 'Approval decisions',
  form_submission: 'Form submissions',
  automation: 'Automation notices',
};

export interface UserPrefs {
  notifications?: Partial<Record<NotifKind, 'inbox' | 'off'>>;
  quietDigest?: boolean;
}

interface GroupItem {
  actorId?: string;
  at: number;
  summary: string;
}

interface NotificationItem {
  id: string;
  kind: NotifKind;
  actorId: string | null;
  targetType: string | null;
  targetId: string | null;
  title: string;
  body: string | null;
  url: string | null;
  groupKey: string | null;
  groupCount: number;
  items: GroupItem[];
  restricted?:boolean;
  readAt: number | null;
  createdAt: number;
}

async function fetchNotifications(cursor?:string){return api<{notifications:NotificationItem[];nextCursor:string|null}>(`/api/notifications?limit=60${cursor?'&cursor='+encodeURIComponent(cursor):''}`);}

export async function fetchUnreadBadge(): Promise<number> {
  const uid=authStore.get().user?.id,token=getToken(),epoch=accessClientStore.get().epoch;
  const res = await api<{ unread: number }>('/api/notifications/badge');
  if(authStore.get().user?.id!==uid||getToken()!==token||accessClientStore.get().epoch!==epoch)throw new Error('notification_access_changed');
  return res.unread ?? 0;
}

export async function fetchPrefs(): Promise<UserPrefs> {
  const res = await api<{ prefs?: UserPrefs }>('/api/me');
  return res.prefs ?? {};
}

export async function savePrefs(patch: UserPrefs): Promise<UserPrefs> {
  const res = await api<{ prefs?: UserPrefs }>('/api/me', { method: 'PATCH', body: { prefs: patch } });
  return res.prefs ?? {};
}

/* ---------- Nav badge ---------- */

const BADGE_POLL_MS = 30_000;

function InboxBadge() {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void fetchUnreadBadge()
        .then((n) => alive && setUnread(n))
        .catch(() => {});
    };
    refresh();
    const t = setInterval(refresh, BADGE_POLL_MS);
    const onFocus = () => refresh();
    const onVis = () => document.visibilityState === 'visible' && refresh();
    // Other Inbox pages/components bump the badge through this event — the
    // live-socket 'changed' poke is integrator wiring (live.ts), so polling +
    // focus + this local event keep the count honest meanwhile.
    const onLocal = (e: Event) => alive && setUnread((e as CustomEvent<number>).detail ?? 0);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('ws-inbox-unread', onLocal);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('ws-inbox-unread', onLocal);
    };
  }, []);
  if (!unread) return null;
  return (
    <span
      aria-label={`${unread} unread notifications`}
      className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-neutral-900 px-1 text-[10px] font-semibold text-white dark:bg-white dark:text-neutral-900"
    >
      {unread > 99 ? '99+' : unread}
    </span>
  );
}

function bumpBadge(): void {
  void fetchUnreadBadge()
    .then((n) => window.dispatchEvent(new CustomEvent('ws-inbox-unread', { detail: n })))
    .catch(() => {});
}

/* ---------- Row ---------- */

function NotifRow({
  n,
  onOpen,
  onMarkRead,
}: {
  n: NotificationItem;
  onOpen: (n: NotificationItem) => void;
  onMarkRead: (n: NotificationItem) => void;
}) {
  const users = useUsers();
  const me = authStore.get().user;
  const [open, setOpen] = useState(false);
  const actor = resolveUser(n.actorId, users, me);
  const grouped = (n.groupCount ?? 1) > 1;
  // Inbox AI actions apply to the record a notification points at (never restricted copies).
  const aiRecord = !n.restricted && n.targetId && (n.targetType === 'task' || n.targetType === 'record') ? n.targetId : null;
  return (
    <li className={cn('border-b border-neutral-100 last:border-0 dark:border-neutral-800', !n.readAt && 'bg-neutral-50/60 dark:bg-neutral-900/40')}>
      <div
        className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-900"
      >
        <Avatar name={actor?.name ?? '·'} color={actor?.color} size={26} className="mt-0.5" />
        <div className="min-w-0 flex-1 text-sm">
          <button type="button" onClick={() => onOpen(n)} className="block min-h-6 w-full rounded text-left focus-visible:outline-2 focus-visible:outline-offset-2">
            <span className={cn('block text-neutral-800 dark:text-neutral-200', !n.readAt && 'font-medium')}>{n.title}</span>
            {n.body && <span className="mt-0.5 block truncate text-xs text-neutral-600 dark:text-neutral-400">{n.body}</span>}
          </button>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-neutral-600 dark:text-neutral-400">
            <span>{relTime(n.createdAt)}</span>
            {grouped && (
              <button
                type="button"
                className="inline-flex items-center gap-0.5 rounded-full bg-neutral-200/70 px-1.5 py-0.5 font-medium text-neutral-600 hover:bg-neutral-300/70 dark:bg-neutral-700/60 dark:text-neutral-300 dark:hover:bg-neutral-700"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen((v) => !v);
                }}
                aria-expanded={open}
              >
                <ChevronDown size={11} className={cn('transition-transform', open && 'rotate-180')} />×{n.groupCount}
              </button>
            )}
          </div>
          {open && grouped && (
            <ul className="mt-2 space-y-1 rounded-lg bg-white p-2 text-xs text-neutral-500 shadow-sm ring-1 ring-neutral-200/70 dark:bg-neutral-950 dark:text-neutral-400 dark:ring-neutral-800">
              {n.items.map((it, i) => (
                <li key={i} className="flex gap-2">
                  <span className="shrink-0 text-neutral-400">{relTime(it.at)}</span>
                  <span className="min-w-0 truncate">{it.summary}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {!n.readAt && !n.restricted && (
          <button
            type="button"
            aria-label="Mark as read"
            title="Mark as read"
            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-200/70 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            onClick={(e) => {
              e.stopPropagation();
              onMarkRead(n);
            }}
          >
            <Check size={14} />
          </button>
        )}
        {!n.readAt && <span role="img" className="mt-2 h-2 w-2 shrink-0 rounded-full bg-blue-500" aria-label="unread" />}
      </div>
      {aiRecord && (
        <div className="flex justify-end px-3 pb-2">
          <AskAiMenu modules={['inbox']} refs={{ record: { kind: 'record', id: aiRecord } }} label="Ask AI about this item" compact={false} className="text-xs" />
        </div>
      )}
    </li>
  );
}

/* ---------- Notification prefs (mountable in Settings by integrator) ---------- */

export function NotificationPrefs() {
  const [prefs, setPrefs] = useState<UserPrefs | null>(null);
  const [offline, setOffline] = useState(false);
  const [saving, setSaving] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetchPrefs()
      .then((p) => {
        setPrefs(p);
        setOffline(false);
      })
      .catch(() => setOffline(true));
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  const update = useCallback((next: UserPrefs) => {
    setPrefs(next);
    setSaving(true);
    void savePrefs(next)
      .then(() => {
        setOffline(false);
        setSaved(true);
        if (savedTimer.current) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaved(false), 1500);
      })
      .catch(() => setOffline(true))
      .finally(() => setSaving(false));
  }, []);

  if (offline) {
    return (
      <p className="flex items-center gap-2 text-xs text-neutral-400">
        <WifiOff size={13} /> Notification preferences need a connection.
      </p>
    );
  }
  if (!prefs) return <p className="text-xs text-neutral-400">Loading…</p>;

  return (
    <div className="space-y-3">
      {NOTIF_KINDS.map((kind) => (
        <div key={kind} className="flex items-center justify-between gap-3">
          <label htmlFor={`pref-${kind}`} className="text-sm text-neutral-700 dark:text-neutral-300">
            {KIND_LABELS[kind]}
          </label>
          <Select
            id={`pref-${kind}`}
            className="w-28"
            value={prefs.notifications?.[kind] ?? 'inbox'}
            disabled={saving}
            onChange={(e) =>
              update({ ...prefs, notifications: { ...(prefs.notifications ?? {}), [kind]: e.target.value as 'inbox' | 'off' } })
            }
          >
            <option value="inbox">Inbox</option>
            <option value="off">Off</option>
          </Select>
        </div>
      ))}
      <label className="flex items-center justify-between gap-3 pt-1">
        <span className="text-sm text-neutral-700 dark:text-neutral-300">
          Quiet digest
          <span className="block text-xs text-neutral-400">Only mentions, assignments and approvals count on the badge</span>
        </span>
        <input
          type="checkbox"
          className="h-4 w-4 accent-neutral-900 dark:accent-white"
          checked={!!prefs.quietDigest}
          disabled={saving}
          onChange={(e) => update({ ...prefs, quietDigest: e.target.checked })}
        />
      </label>
      {saved && <p className="text-xs text-green-600 dark:text-green-400">Saved</p>}
    </div>
  );
}

/* ---------- Page ---------- */

function InboxPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [error, setError] = useState<'offline' | 'error' | null>(null);
  const [showPrefs, setShowPrefs] = useState(false);

  const access=useStore(accessClientStore),auth=useStore(authStore),token=getToken();
  const key=JSON.stringify([auth.user?.id,token,access.epoch,access.status]);
  const [owner,setOwner]=useState(''),[nextCursor,setNext]=useState<string|null>(null),[busy,setBusy]=useState(false);
  const serial=useRef(0),alive=useRef(true);
  const current=()=>alive.current&&authStore.get().user?.id===auth.user?.id&&getToken()===token&&accessClientStore.get().epoch===access.epoch;
  const refresh = useCallback((cursor?:string) => {
    const request=++serial.current;setBusy(true);
    void fetchNotifications(cursor).then(reply=>{if(!current()||request!==serial.current)return;setItems(old=>cursor?[...(old??[]),...reply.notifications]:reply.notifications);setOwner(key);setNext(reply.nextCursor);setError(null);bumpBadge();})
      .catch(e=>{if(current())setError(e instanceof ApiError&&e.status===0?'offline':'error');})
      .finally(()=>{if(current()&&request===serial.current)setBusy(false);});
  },[key]);
  useEffect(()=>{alive.current=true;refresh();return()=>{alive.current=false;serial.current++;};},[refresh]);
  const markRead = (n:NotificationItem)=>{if(n.restricted)return;void api(`/api/notifications/${encodeURIComponent(n.id)}/read`,{method:'POST'}).then(()=>{if(current()){setItems(old=>(old??[]).map(x=>x.id===n.id?{...x,readAt:Date.now()}:x));bumpBadge();}}).catch(()=>{if(current())setError('error');});};
  const markAll=()=>{void api('/api/notifications/read-all',{method:'POST'}).then(()=>{if(current())refresh();}).catch(()=>{if(current())setError('error');});};

  const open = useCallback(
    (n: NotificationItem) => {
      if(n.restricted)return;
      if (!n.readAt) markRead(n);
      if (n.url) navigate(n.url);
    },
    [markRead, navigate],
  );

  const shown=owner===key?items:null;
  const unread = (shown ?? []).filter((n) => !n.readAt&&!n.restricted);
  const read = (shown ?? []).filter((n) => n.readAt||n.restricted);

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto px-5 py-8">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="flex-1 text-xl font-semibold tracking-tight">Inbox</h1>
        {unread.length > 0 && (
          <Button variant="ghost" size="sm" onClick={markAll}>
            <CheckCheck size={14} /> Mark all read
          </Button>
        )}
      </div>

      {error === 'offline' && <EmptyState icon={WifiOff} title="You're offline" body="Notifications live on the server — reconnect to load your Inbox." action={<Button onClick={()=>refresh()}>Retry</Button>} />}
      {error === 'error' && <EmptyState icon={BellOff} title="Couldn't load notifications" body="Something went wrong fetching your Inbox." action={<Button onClick={()=>refresh()}>Retry</Button>} />}

      {!error && shown === null && <p className="text-sm text-neutral-400">Loading…</p>}

      {!error && shown !== null && shown.length === 0 && <EmptyState icon={InboxIcon} title="All caught up" body="Mentions, assignments, comments and reminders will show up here." />}

      {!error && unread.length > 0 && (
        <>
          <h2 className="mb-2 text-xs font-semibold tracking-wide text-neutral-500 uppercase dark:text-neutral-400">New</h2>
          <ul className="mb-6 overflow-hidden rounded-xl border border-neutral-200/70 dark:border-neutral-800">
            {unread.map((n) => (
              <NotifRow key={n.id} n={n} onOpen={open} onMarkRead={markRead} />
            ))}
          </ul>
        </>
      )}

      {!error && read.length > 0 && (
        <>
          <h2 className="mb-2 text-xs font-semibold tracking-wide text-neutral-500 uppercase dark:text-neutral-400">Earlier</h2>
          <ul className="mb-6 overflow-hidden rounded-xl border border-neutral-200/70 opacity-80 dark:border-neutral-800">
            {read.map((n) => (
              <NotifRow key={n.id} n={n} onOpen={open} onMarkRead={markRead} />
            ))}
          </ul>
        </>
      )}

      {!error&&owner===key&&nextCursor&&<Button disabled={busy} onClick={()=>refresh(nextCursor)}>Load older notifications</Button>}
      {!error && shown !== null && (
        <section className="rounded-2xl border border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-neutral-900/50">
          <button
            type="button"
            className="flex w-full items-center justify-between px-5 py-3 text-left text-xs font-semibold tracking-wide text-neutral-500 uppercase dark:text-neutral-400"
            onClick={() => setShowPrefs((v) => !v)}
            aria-expanded={showPrefs}
          >
            Notification preferences
            <ChevronDown size={14} className={cn('transition-transform', showPrefs && 'rotate-180')} />
          </button>
          {showPrefs && (
            <div className="border-t border-neutral-100 p-5 dark:border-neutral-800">
              <NotificationPrefs />
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export const inboxModule: AppModule = {
  id: 'inbox',
  label: 'Inbox',
  icon: InboxIcon,
  navItem: { path: '/inbox', label: 'Inbox', icon: InboxIcon },
  navBadge: InboxBadge,
  routes: [{ path: 'inbox', element: <InboxPage /> }],
  collections: [],
};

export default inboxModule;
