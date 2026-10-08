import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { Search, Settings, LogOut, Moon, Sun, Monitor, CloudOff, RefreshCw, Check, AlertTriangle, PanelLeft, Plus, Camera, X } from 'lucide-react';
import { toastStore } from './files';
import { modules } from '../modules';
import type { AppModule } from '../modules/types';
import { authStore, signOut } from './auth';
import { APP_NAME } from './config';
import { InstallButton } from './install';
import { CommandPalette, paletteStore } from './search';
import { sendHere } from './live';
import { PresenceDots } from './presence';
import { countLocalPending, flushAndCountPending, onlineStore, syncNow, syncStore } from './sync/engine';
import { createStore, useStore } from './store';
import { setTheme, themeStore } from './theme';
import { Avatar, Button, Dialog, Menu, Popover, Sheet } from './ui';
import { cn } from './utils';

export { useIsMobile } from './mobile';
import { useIsMobile } from './mobile';

function SyncIndicator() {
  const { status, pending, pendingMedia } = useStore(syncStore);
  const online = useStore(onlineStore);
  const total = pending + pendingMedia;

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
      <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-neutral-400">
        <RefreshCw size={13} className="animate-spin" />
        <span>Syncing…</span>
      </div>
    );
  }
  if (total > 0) {
    return (
      <button
        onClick={() => void syncNow()}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-amber-600 transition-colors hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/30"
        title="Unsynced changes — click to sync now"
      >
        <RefreshCw size={13} />
        <span>{total} unsynced</span>
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-neutral-400">
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
              <p className="truncate text-xs text-neutral-400">
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
        cn('flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[10px] transition-colors', isActive ? 'text-neutral-900 dark:text-white' : 'text-neutral-400')
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
  if (!err) return null;
  return (
    <div
      role="alert"
      className="fixed inset-x-4 bottom-24 z-[71] mx-auto flex max-w-md items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 shadow-lg dark:border-red-900/60 dark:bg-red-950/90 dark:text-red-200 sm:inset-x-auto sm:bottom-6 sm:right-6 sm:ml-auto"
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">Needs attention</p>
        <p className="mt-0.5 break-words">{err.text}</p>
        <button
          className="mt-1.5 font-medium underline decoration-red-300 underline-offset-2 hover:decoration-red-500"
          onClick={() => void syncNow()}
        >
          Retry sync
        </button>
      </div>
      <button aria-label="Dismiss" className="shrink-0 rounded-md p-0.5 hover:bg-red-100 dark:hover:bg-red-900/50" onClick={() => durableErrorStore.set(null)}>
        <X size={13} />
      </button>
    </div>
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
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-neutral-200/80 px-2.5 py-1.5 text-sm text-neutral-400 transition-colors hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800/50"
        >
          <Search size={15} />
          <span className="flex-1 text-left">Search</span>
          <kbd className="text-[10px] text-neutral-300 dark:text-neutral-600">⌘K</kbd>
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

  const tabItems = modules.filter((m) => m.navItem).map((m) => m.navItem!);

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
          </header>
        )}

        <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <Outlet />
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
                cn('flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[10px]', isActive ? 'text-neutral-900 dark:text-white' : 'text-neutral-400')
              }
            >
              <Settings size={20} strokeWidth={1.8} />
              Settings
            </NavLink>
          </nav>
        )}
      </div>

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
