import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { Search, Settings, LogOut, Moon, Sun, Monitor, CloudOff, RefreshCw, Check, AlertTriangle, PanelLeft } from 'lucide-react';
import { modules } from '../modules';
import { authStore, signOut } from './auth';
import { APP_NAME } from './config';
import { InstallButton } from './install';
import { CommandPalette, paletteStore } from './search';
import { flushAndCountPending, onlineStore, syncNow, syncStore } from './sync/engine';
import { useStore } from './store';
import { setTheme, themeStore } from './theme';
import { Avatar, Button, Dialog, Menu, Popover, Sheet } from './ui';
import { cn } from './utils';

export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const mq = matchMedia('(max-width: 767px)');
    const fn = () => setMobile(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  return mobile;
}

function SyncIndicator() {
  const { status, pending } = useStore(syncStore);
  const online = useStore(onlineStore);

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
        <span>Offline{pending > 0 ? ` · ${pending} pending` : ''}</span>
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
  if (pending > 0) {
    return (
      <button
        onClick={() => void syncNow()}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-amber-600 transition-colors hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/30"
        title="Unsynced changes — click to sync now"
      >
        <RefreshCw size={13} />
        <span>{pending} unsynced</span>
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
  const [confirmOut, setConfirmOut] = useState(0);

  const trySignOut = async () => {
    const pending = await flushAndCountPending();
    if (pending > 0) setConfirmOut(pending);
    else void signOut();
  };

  if (!user) return null;
  return (
    <>
      <Popover
        align="left"
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
      {confirmOut > 0 && (
        <Dialog title="Unsynced changes" onClose={() => setConfirmOut(0)}>
          <p className="text-sm text-neutral-600 dark:text-neutral-300">
            You have {confirmOut} unsynced change{confirmOut === 1 ? '' : 's'}. They'll sync next time you sign in here, but will be lost if someone
            else signs in on this device.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setConfirmOut(0)}>
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
      <div className="px-2 py-2">
        <button
          onClick={() => {
            onNavigate?.();
            paletteStore.set(true);
          }}
          className="flex w-full items-center gap-2.5 rounded-lg border border-neutral-200/80 px-2.5 py-1.5 text-sm text-neutral-400 transition-colors hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800/50"
        >
          <Search size={15} />
          <span className="flex-1 text-left">Search</span>
          <kbd className="text-[10px] text-neutral-300 dark:text-neutral-600">⌘K</kbd>
        </button>
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        paletteStore.set(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const tabItems = modules.filter((m) => m.navItem).map((m) => m.navItem!);

  return (
    <div className="flex h-full">
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

        {/* Mobile bottom tabs */}
        {mobile && (
          <nav className="pb-safe flex shrink-0 items-stretch border-t border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-neutral-950">
            {tabItems.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === '/'}
                className={({ isActive }) =>
                  cn(
                    'relative flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[10px] transition-colors',
                    isActive ? 'text-neutral-900 dark:text-white' : 'text-neutral-400',
                  )
                }
              >
                <item.icon size={20} strokeWidth={1.8} />
                {item.label}
              </NavLink>
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

      <CommandPalette />
    </div>
  );
}
