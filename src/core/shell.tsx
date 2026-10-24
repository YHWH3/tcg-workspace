import {SpaceSwitcher} from './SpaceHome';
import { useEffect, useState } from 'react';
import { matchPath, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router';
import { Search, Settings, LogOut, Moon, Sun, Monitor, CloudOff, RefreshCw, Check, AlertTriangle, PanelLeft, Plus, Camera, X, Sparkles } from 'lucide-react';
import { toastStore } from './files';
import { modules } from '../modules';
import type { AppModule } from '../modules/types';
import { authStore, resolveAccountSwitch, signOut } from './auth';
import { accountSwitchStore } from './accountSwitch';
import { legacyRecoveryStore, resolveLegacyRecovery } from './legacyMigration';
import { APP_NAME } from './config';
import { InstallButton } from './install';
import { CommandPalette, paletteStore } from './search';
import { AssistantDock } from './assistant/AssistantPanel';
import { assistantStore, toggleAssistant } from './assistant/store';
import { sendHere } from './live';
import { PresenceDots } from './presence';
import { BoardOrDb } from './views/DatabasePage';
import { countLocalPending, flushAndCountPending, onlineStore, retryRejected, serializeRejected, syncNow, syncStore } from './sync/engine';
import { createStore, useStore } from './store';
import { setTheme, themeStore } from './theme';
import { Avatar, Button, Dialog, Menu, Popover, Sheet } from './ui';
import { cn } from './utils';

export { useIsMobile } from './mobile';
import { useIsMobile } from './mobile';
import { QuarantineReview } from './QuarantineReview';

function SyncIndicator({ heldOnly = false }: { heldOnly?: boolean }) {
  const { status, pending, pendingMedia, rejected, quarantined } = useStore(syncStore);
  const [review, setReview] = useState(false);
  const online = useStore(onlineStore);
  const total = pending + pendingMedia;

  // Server-rejected writes are unsynced work — never show 'Synced' (S3).
  if (quarantined > 0) return <><button className="flex min-h-11 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-amber-700 dark:text-amber-300" onClick={() => setReview(true)}><AlertTriangle size={13} aria-hidden="true" /><span>{quarantined} held · review</span></button>{review && <QuarantineReview onClose={() => setReview(false)} />}</>;
  if (heldOnly) return null;
  if (rejected > 0) {
    return (
      <button
        onClick={() => void retryRejected()}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-red-500 transition-colors hover:bg-red-50 dark:hover:bg-red-950/40"
        title="Changes rejected by the server, kept locally — click to retry"
      >
        <AlertTriangle size={13} />
        <span>{rejected} rejected · retry</span>
      </button>
    );
  }
  if (status === 'error') {
    return (
      <button
        onClick={() => void syncNow()}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-red-500 transition-colors hover:bg-red-50 dark:hover:bg-red-950/40"
        title="Sync failed — click to retry"
      >
        <AlertTriangle size={13} />
        <span>Sync error · retry</span>
      </button>
    );
  }
  if (!online) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-amber-500">
        <CloudOff size={13} />
        <span>Offline{total > 0 ? ` · ${total} pending` : ''}</span>
      </div>
    );
  }
  if (status === 'syncing') {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-neutral-500 dark:text-neutral-400">
        <RefreshCw size={13} className="animate-spin" />
        <span>Syncing…</span>
      </div>
    );
  }
  if (total > 0) {
    return (
      <button
        onClick={() => void syncNow()}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-amber-700 transition-colors hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/30"
        title="Unsynced changes — click to sync now"
      >
        <RefreshCw size={13} />
        <span>{total} unsynced</span>
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-neutral-500 dark:text-neutral-400">
      <Check size={13} />
      <span>Synced</span>
    </div>
  );
}

function ThemeRow() {
  const theme = useStore(themeStore);
  const opts = [
    { v: 'light' as const, icon: Sun },
    { v: 'system' as const, icon: Monitor },
    { v: 'dark' as const, icon: Moon },
  ];
  return (
    <div className="flex items-center justify-between px-2.5 py-1.5">
      <span className="text-sm text-neutral-700 dark:text-neutral-300">Theme</span>
      <div className="flex rounded-lg bg-neutral-100 p-0.5 dark:bg-neutral-800">
        {opts.map((o) => (
          <button
            key={o.v}
            onClick={(e) => {
              e.stopPropagation();
              setTheme(o.v);
            }}
            className={cn(
              'rounded-md p-1.5 transition-colors',
              theme === o.v ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white' : 'text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300',
            )}
            aria-label={o.v}
          >
            <o.icon size={14} />
          </button>
        ))}
      </div>
    </div>
  );
}

function UserMenu() {
  const user = useStore(authStore).user;
  const navigate = useNavigate();
  const [confirmOut, setConfirmOut] = useState<{ records: number; media: number; drafts: number } | null>(null);

  const trySignOut = async () => {
    // Best-effort flush first, then count everything still local: unsent
    // writes, pending/failed uploads and unsent draft envelopes (§7/§11).
    await flushAndCountPending();
    const pending = await countLocalPending();
    if (pending.records + pending.media + pending.drafts > 0) setConfirmOut(pending);
    else void signOut();
  };

  if (!user) return null;
  const total = confirmOut ? confirmOut.records + confirmOut.media + confirmOut.drafts : 0;
  const parts = confirmOut
    ? [
        confirmOut.records ? `${confirmOut.records} unsynced change${confirmOut.records === 1 ? '' : 's'}` : '',
        confirmOut.media ? `${confirmOut.media} upload${confirmOut.media === 1 ? '' : 's'} pending or failed` : '',
        confirmOut.drafts ? `${confirmOut.drafts} unsent draft${confirmOut.drafts === 1 ? '' : 's'}` : '',
      ].filter(Boolean)
    : [];
  return (
    <>
      <Popover
        align="left"
        adaptive
        label="Account"
        trigger={
          <span className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800">
            <Avatar name={user.name} color={user.color} size={24} />
            <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">{user.name}</span>
          </span>
        }
        className="bottom-full left-0 mb-1 mt-0 w-56"
      >
        {(close) => (
          <div>
            <div className="border-b border-neutral-100 px-3 py-2.5 dark:border-neutral-800">
              <p className="truncate text-sm font-medium">{user.name}</p>
              <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                @{user.username} · {user.role}
              </p>
            </div>
            <ThemeRow />
            <Menu
              close={close}
              items={[
                { label: 'Settings', icon: Settings, onClick: () => navigate('/settings') },
                'divider',
                { label: 'Sign out', icon: LogOut, onClick: () => void trySignOut() },
              ]}
            />
          </div>
        )}
      </Popover>
      {confirmOut && (
        <Dialog title="Unsynced changes" onClose={() => setConfirmOut(null)}>
          <p className="text-sm text-neutral-600 dark:text-neutral-300">
            You have {total} local item{total === 1 ? '' : 's'} not yet confirmed by the server
            {parts.length ? ` (${parts.join(', ')})` : ''}. They'll sync next time you sign in here, but will be lost if someone else signs in on
            this device.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setConfirmOut(null)}>
              Stay signed in
            </Button>
            <Button variant="danger" size="sm" onClick={() => void signOut()}>
              Sign out anyway
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}

function TabLink({ item }: { item: NonNullable<AppModule['navItem']> }) {
  return (
    <NavLink
      to={item.path}
      end={item.path === '/'}
      className={({ isActive }) =>
        cn('flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[10px] transition-colors', isActive ? 'text-neutral-900 dark:text-white' : 'text-neutral-500 dark:text-neutral-400')
      }
    >
      <item.icon size={20} strokeWidth={1.8} />
      {item.label}
    </NavLink>
  );
}

/* Durable error surface (platform §6/§7): failures a transient toast would
 * drop (failed saves, quota errors) also land here — role=alert, visible
 * until dismissed or resolved, with an explicit retry. */
export const durableErrorStore = createStore<{ text: string; at: number } | null>(null);

export function reportError(text: string): void {
  durableErrorStore.set({ text, at: Date.now() });
}

function DurableError() {
  const err = useStore(durableErrorStore);
  const rejected = useStore(syncStore).rejected;
  const downloadRejected = async () => {
    const payload = await serializeRejected();
    const file = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = `workspace-rejected-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  if (!err && !rejected) return null;
  return (
    <div
      role="alert"
      className="fixed inset-x-4 bottom-24 z-[71] mx-auto flex max-w-md items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 shadow-lg dark:border-red-900/60 dark:bg-red-950/90 dark:text-red-200 sm:inset-x-auto sm:bottom-6 sm:right-6 sm:ml-auto"
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">Needs attention</p>
        {err && <p className="mt-0.5 break-words">{err.text}</p>}
        {rejected > 0 && (
          <p className="mt-0.5 break-words">
            {rejected} change{rejected === 1 ? '' : 's'} rejected by the server and kept locally — nothing was lost.
          </p>
        )}
        <span className="mt-1.5 flex gap-3">
          <button
            className="font-medium underline decoration-red-300 underline-offset-2 hover:decoration-red-500"
            onClick={() => (rejected ? void retryRejected() : void syncNow())}
          >
            {rejected ? 'Retry rejected' : 'Retry sync'}
          </button>
          {rejected > 0 && (
            <button className="font-medium underline decoration-red-300 underline-offset-2 hover:decoration-red-500" onClick={() => void downloadRejected()}>
              Export JSON
            </button>
          )}
        </span>
      </div>
      <button aria-label="Dismiss" className="shrink-0 rounded-md p-0.5 hover:bg-red-100 dark:hover:bg-red-900/50" onClick={() => durableErrorStore.set(null)}>
        <X size={13} />
      </button>
    </div>
  );
}

/* Blocking account-switch surface (§12.3, reviews B4/R1/R2/R3): renders above
 * login and shell alike — the previous account's unsynced data can't be
 * signed away without an explicit choice. Escape/outside-click and the X all
 * mean the safe option (cancel), never a silent wipe. The backup path is
 * two-step when the download can't be verified: the file must be confirmed
 * saved before the switch proceeds. */
export function AccountSwitchGate() {
  const d = useStore(accountSwitchStore);
  const [busy, setBusy] = useState<null | 'cancel' | 'keep' | 'keep-confirmed' | 'destroy'>(null);
  if (!d) return null;
  const { records, rejected, media, drafts } = d.pending;
  const parts = [
    records ? `${records} unsynced change${records === 1 ? '' : 's'}${rejected ? ` (${rejected} rejected by the server, kept locally)` : ''}` : '',
    media ? `${media} upload${media === 1 ? '' : 's'} pending or failed` : '',
    drafts ? `${drafts} unsent draft${drafts === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  const choose = (c: 'cancel' | 'keep' | 'keep-confirmed' | 'destroy') => {
    setBusy(c);
    void resolveAccountSwitch(c).catch(() => setBusy(null));
  };
  const backupDone = d.backup === 'verified' || d.backup === 'downloaded-unconfirmed';
  return (
    <Dialog title={`Sign in as ${d.newUser.name}?`} onClose={() => choose('cancel')} guard={() => busy === null}>
      <p className="text-sm text-neutral-600 dark:text-neutral-300">
        This device has {parts.join(', ')} belonging to the previous account that the server never confirmed.
      </p>
      {d.backup === 'downloaded-unconfirmed' && (
        <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          A backup file was downloaded — check your Downloads folder and confirm it saved, then finish switching.
        </p>
      )}
      <div className="mt-4 flex flex-col gap-2">
        {backupDone ? (
          <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => choose('keep-confirmed')}>
            {busy === 'keep-confirmed' ? 'Switching…' : 'Backup saved — switch now'}
          </Button>
        ) : (
          <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => choose('keep')}>
            {busy === 'keep' ? 'Exporting backup…' : 'Back up everything, then switch'}
          </Button>
        )}
        <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => choose('destroy')}>
          {busy === 'destroy' ? 'Deleting…' : `Discard ${records + media + drafts} item${records + media + drafts === 1 ? '' : 's'} and switch anyway`}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => choose('cancel')}>
          {busy === 'cancel' ? 'Cancelling…' : 'Cancel — keep my data'}
        </Button>
      </div>
    </Dialog>
  );
}

/* Legacy-store recovery (S1/T1): pre-uid 'workspace' data whose owner can't
 * be exclusively proven — copy needs an explicit choice, and stores holding
 * other users' data additionally need the informed-confirm step. The export
 * covers only unsynced changes & uploads (T3); 'leave' keeps the store. */
export function LegacyRecoveryGate() {
  const r = useStore(legacyRecoveryStore);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmImport, setConfirmImport] = useState(false);
  if (!r) return null;
  const { records, outbox, drafts, blobs } = r.counts;
  const parts = [
    records ? `${records} record${records === 1 ? '' : 's'}` : '',
    outbox ? `${outbox} unsynced change${outbox === 1 ? '' : 's'}` : '',
    drafts ? `${drafts} draft${drafts === 1 ? '' : 's'}` : '',
    blobs ? `${blobs} upload${blobs === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  // Copying foreign/mixed stores imports other users' data — that path is
  // only reachable through an explicit informed second step (T1).
  const tainted = r.foreign || r.mixed;
  const choose = (c: 'copy' | 'export' | 'leave', allowForeign = false) => {
    setBusy(c);
    void resolveLegacyRecovery(c, r, { allowForeign }).catch(() => setBusy(null));
  };
  return (
    <Dialog title="Recover data from a previous version?" onClose={() => choose('leave')} guard={() => busy === null}>
      <p className="text-sm text-neutral-600 dark:text-neutral-300">
        This device holds {parts.join(', ')} stored by an older version of the app
        {r.foreign
          ? ' — but it appears to belong to a different account.'
          : r.mixed
            ? ' — and it contains data belonging to more than one account.'
            : ' — the owning account could not be confirmed.'}
      </p>
      <div className="mt-4 flex flex-col gap-2">
        {!tainted && (
          <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => choose('copy')}>
            {busy === 'copy' ? 'Copying…' : 'Copy it into this account'}
          </Button>
        )}
        {tainted && !confirmImport && (
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirmImport(true)}>
            Import anyway…
          </Button>
        )}
        {tainted && confirmImport && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/50 dark:bg-amber-950/30">
            <p className="text-xs text-amber-700 dark:text-amber-400">
              This store holds data belonging to {r.mixed ? 'your account and other users' : 'a different account'}.
              Copying will import all of it — including other users' drafts, records and uploads — into your account.
            </p>
            <div className="mt-2 flex gap-2">
              <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => choose('copy', true)}>
                {busy === 'copy' ? 'Copying…' : 'Import it anyway'}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirmImport(false)}>
                Back
              </Button>
            </div>
          </div>
        )}
        <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => choose('export')}>
          {busy === 'export' ? 'Exporting…' : 'Export unsynced changes & uploads'}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => choose('leave')}>
          {busy === 'leave' ? 'Closing…' : 'Keep it on this device'}
        </Button>
      </div>
    </Dialog>
  );
}

function Toaster() {
  const { items } = useStore(toastStore);
  // Mirror the newest error into the durable surface so it can't expire
  // away before the user sees it.
  useEffect(() => {
    const last = items.filter((t) => t.tone === 'error').at(-1);
    if (last) durableErrorStore.set({ text: last.text, at: Date.now() });
  }, [items]);
  if (items.length === 0) return null;
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-[70] flex flex-col items-center gap-1.5 px-4 sm:bottom-6">
      {items.map((t) => (
        <div
          key={t.id}
          role={t.tone === 'error' ? 'alert' : 'status'}
          className={cn('anim-slide-up rounded-full px-4 py-2 text-xs font-medium shadow-lg', t.tone === 'error' ? 'bg-red-600 text-white' : 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900')}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-0.5 px-2">
      <SpaceSwitcher/>
      {modules
        .filter((m) => m.navItem)
        .map((m) => {
          const nav = m.navItem!;
          const Badge = m.navBadge;
          return (
            <NavLink
              key={m.id}
              to={nav.path}
              end={nav.path === '/'}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'relative flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
                  isActive
                    ? 'bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-white'
                    : 'text-neutral-600 hover:bg-neutral-100/70 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800/60 dark:hover:text-neutral-100',
                )
              }
            >
              <nav.icon size={16} strokeWidth={1.8} />
              <span className="flex-1">{nav.label}</span>
              <PresenceDots match={(p) => (nav.path === '/' ? p === '/' : p === nav.path || p.startsWith(`${nav.path}/`))} />
              {Badge && <Badge />}
            </NavLink>
          );
        })}
    </nav>
  );
}

function AssistantToggle() {
  const mode = useStore(assistantStore).mode;
  const location = useLocation();
  const onChat = !!matchPath('/ai/chat/*', location.pathname);
  return (
    <div className="px-2 pb-2">
      <button
        type="button"
        data-testid="assistant-toggle"
        aria-expanded={mode === 'panel'}
        aria-keyshortcuts="Control+J Meta+J"
        onClick={() => (onChat ? document.querySelector<HTMLElement>('[data-testid="assistant-input"]')?.focus() : toggleAssistant())}
        className="flex min-h-10 w-full items-center gap-2.5 rounded-lg border border-neutral-200/80 px-2.5 py-1.5 text-sm text-neutral-600 transition-colors hover:bg-neutral-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800/50"
      >
        <Sparkles size={15} className="text-violet-500" aria-hidden="true" />
        <span className="flex-1 text-left">Ask AI</span>
        <kbd className="text-[10px] text-neutral-500 dark:text-neutral-400">⌘J</kbd>
      </button>
    </div>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-4 pb-1 pt-4">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-neutral-900 text-[11px] font-bold text-white dark:bg-white dark:text-neutral-900">
          {APP_NAME[0]}
        </div>
        <span className="text-sm font-semibold tracking-tight">{APP_NAME}</span>
      </div>
      <div className="flex gap-1.5 px-2 py-2">
        <button
          onClick={() => {
            onNavigate?.();
            paletteStore.set(true);
          }}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-neutral-200/80 px-2.5 py-1.5 text-sm text-neutral-500 dark:text-neutral-400 transition-colors hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800/50"
        >
          <Search size={15} />
          <span className="flex-1 text-left">Search</span>
          <kbd className="text-[10px] text-neutral-500 dark:text-neutral-400">⌘K</kbd>
        </button>
        <NavLink
          to="/capture"
          onClick={onNavigate}
          title="Quick capture (C)"
          className="flex items-center justify-center rounded-lg border border-neutral-200/80 px-2.5 text-neutral-500 transition-colors hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800/50"
        >
          <Camera size={15} />
        </NavLink>
      </div>
      {/* Global assistant entry (the compact header has its own toggle). */}
      {!onNavigate && <AssistantToggle />}
      <NavItems onNavigate={onNavigate} />
      <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
        {modules.map((m) => m.sidebarSection && <m.sidebarSection key={m.id} />)}
      </div>
      <div className="border-t border-neutral-100 p-2 dark:border-neutral-800">
        <InstallButton />
        <div className="flex items-center justify-between">
          <UserMenu />
        </div>
        <SyncIndicator />
      </div>
    </div>
  );
}

export function Shell() {
  const mobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);
  const location = useLocation();

  // Report our route to the presence socket on every navigation.
  useEffect(() => sendHere(location.pathname), [location.pathname]);

  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        paletteStore.set(true);
        return;
      }
      // Ctrl/Cmd+J toggles the assistant (on the full-screen route it focuses the composer).
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        if (matchPath('/ai/chat/*', window.location.pathname)) document.querySelector<HTMLElement>('[data-testid="assistant-input"]')?.focus();
        else toggleAssistant();
        return;
      }
      // C → quick capture, when not typing in a field.
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement | null)?.isContentEditable;
      if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'c') {
        navigate('/capture');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  const tabItems = modules.filter((m) => m.navItem && m.navItem.tab !== false).map((m) => m.navItem!);

  return (
    <div className="vv-fit px-safe flex">
      {/* Desktop sidebar */}
      {!mobile && (
        <aside className="w-60 shrink-0 border-r border-neutral-200/70 bg-neutral-50/60 dark:border-neutral-800/70 dark:bg-neutral-900/40">
          <SidebarContent />
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        {mobile && (
          <header className="pt-safe flex h-13 shrink-0 items-center gap-2 border-b border-neutral-200/70 px-3 dark:border-neutral-800/70" style={{ height: 'calc(3.25rem + env(safe-area-inset-top))' }}>
            <button onClick={() => setSheetOpen(true)} className="flex h-11 w-11 items-center justify-center rounded-lg text-neutral-500" aria-label="Menu">
              <PanelLeft size={20} strokeWidth={1.8} />
            </button>
            <span className="flex-1 text-sm font-semibold tracking-tight">{APP_NAME}</span>
            <button onClick={() => paletteStore.set(true)} className="flex h-11 w-11 items-center justify-center rounded-lg text-neutral-500" aria-label="Search">
              <Search size={19} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              data-testid="assistant-toggle"
              onClick={() => toggleAssistant()}
              className="flex h-11 w-11 items-center justify-center rounded-lg text-violet-600 dark:text-violet-400"
              aria-label="Ask AI"
            >
              <Sparkles size={19} strokeWidth={1.8} />
            </button>
          </header>
        )}
        {mobile && <SyncIndicator heldOnly />}

        <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {matchPath('boards/:boardId/*', location.pathname) || matchPath('boards/:boardId', location.pathname) ? (
            <Routes>
              <Route path="boards/:boardId" element={<BoardOrDb />} />
              <Route path="boards/:boardId/tasks/:taskId" element={<BoardOrDb />} />
              <Route path="boards/:boardId/views/:viewId" element={<BoardOrDb />} />
              <Route path="boards/:boardId/views/:viewId/records/:recordId" element={<BoardOrDb />} />
              <Route path="boards/*" element={<BoardOrDb />} />
            </Routes>
          ) : (
            <Outlet />
          )}
        </main>

        {/* Mobile bottom tabs with a prominent center capture button */}
        {mobile && (
          <nav className="pb-safe flex shrink-0 items-stretch border-t border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-neutral-950">
            {tabItems.slice(0, Math.ceil(tabItems.length / 2)).map((item) => (
              <TabLink key={item.path} item={item} />
            ))}
            <NavLink to="/capture" aria-label="Quick capture" className="flex min-h-11 flex-1 items-center justify-center">
              <span className="-mt-5 flex h-12 w-12 items-center justify-center rounded-full bg-neutral-900 text-white shadow-lg ring-4 ring-white active:scale-95 dark:bg-white dark:text-neutral-900 dark:ring-neutral-950">
                <Plus size={22} strokeWidth={2.2} />
              </span>
            </NavLink>
            {tabItems.slice(Math.ceil(tabItems.length / 2)).map((item) => (
              <TabLink key={item.path} item={item} />
            ))}
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                cn('flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[10px]', isActive ? 'text-neutral-900 dark:text-white' : 'text-neutral-500 dark:text-neutral-400')
              }
            >
              <Settings size={20} strokeWidth={1.8} />
              Settings
            </NavLink>
          </nav>
        )}
      </div>

      <AssistantDock />

      {sheetOpen && (
        <Sheet onClose={() => setSheetOpen(false)} side="left">
          <SidebarContent onNavigate={() => setSheetOpen(false)} />
        </Sheet>
      )}

      <Toaster />
      <DurableError />
      <CommandPalette />
    </div>
  );
}
