import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  CalendarCheck2,
  ChevronLeft,
  ChevronRight,
  CloudOff,
  Compass,
  FileCheck2,
  Home,
  Lock,
  Monitor,
  Moon,
  MoreHorizontal,
  RefreshCw,
  Settings,
  Sun,
  Users,
} from 'lucide-react';
import { AppSwitcher } from '../../core/AppSwitcher';
import { authStore } from '../../core/auth';
import { canManageCrmAccess, refreshCrmStatus, useCrmStatus } from '../../core/crmStatus';
import { sendHere } from '../../core/live';
import { useLayoutMode } from '../../core/mobile';
import { useStore } from '../../core/store';
import { onlineStore } from '../../core/sync/engine';
import { useTheme, type Theme } from '../../core/theme';
import { Avatar, Sheet } from '../../core/ui';
import { cn } from '../../core/utils';
import { CrmRoutes } from './routes';
import './crm.css';

function CrmThemeControls({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useTheme();
  const opts: { value: Theme; label: string; icon: typeof Sun }[] = [
    { value: 'light', label: 'Light theme', icon: Sun },
    { value: 'system', label: 'System theme', icon: Monitor },
    { value: 'dark', label: 'Dark theme', icon: Moon },
  ];

  if (compact) {
    const next: Theme = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
    const current = opts.find((o) => o.value === theme) ?? opts[1];
    const Icon = current.icon;
    return (
      <button
        type="button"
        onClick={() => setTheme(next)}
        aria-label={`Theme: ${theme}. Switch to ${next}`}
        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-[var(--crm-border)] bg-[var(--crm-surface)] text-[var(--crm-text)] hover:bg-[var(--crm-surface-2)]"
      >
        <Icon size={17} aria-hidden="true" />
      </button>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2 px-1">
      <span className="text-xs font-medium text-[var(--crm-text-muted)]">Theme</span>
      <div
        role="group"
        aria-label="Theme"
        className="flex rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-0.5"
      >
        {opts.map((opt) => {
          const Icon = opt.icon;
          const active = theme === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => setTheme(opt.value)}
              aria-label={opt.label}
              aria-pressed={active}
              className={cn(
                'inline-flex min-h-8 min-w-8 items-center justify-center rounded-md transition-colors',
                active
                  ? 'bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-xs'
                  : 'text-[var(--crm-text-muted)] hover:text-[var(--crm-text)]',
              )}
            >
              <Icon size={14} aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CrmStateView({
  icon,
  title,
  body,
  action,
  busy = false,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
  busy?: boolean;
}) {
  return (
    <main
      id="crm-main"
      aria-busy={busy}
      className="flex flex-1 items-center justify-center px-4 py-10"
    >
      <section className="crm-panel w-full max-w-md p-6">
        <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--crm-surface-2)] text-[var(--crm-text)]">
          {icon}
        </div>
        <h1 className="text-lg font-semibold leading-tight">{title}</h1>
        <p role="status" className="mt-2 text-sm text-[var(--crm-text-muted)]">
          {body}
        </p>
        {action && <div className="mt-5 flex flex-wrap gap-2">{action}</div>}
      </section>
    </main>
  );
}

export default function CrmShell() {
  const crm = useCrmStatus();
  const user = useStore(authStore).user;
  const online = useStore(onlineStore);
  const layout = useLayoutMode();
  const { pathname } = useLocation();
  const [railCollapsed, setRailCollapsed] = useState(false);

  // Presence path privacy (SC-9): never broadcast /crm/* paths over LiveRoom while
  // Workspace permissions may be off.
  useEffect(() => {
    sendHere('/');
  }, [pathname]);

  const effectiveCollapsed = layout === 'medium' ? !railCollapsed : railCollapsed;
  const isOffline = !online || crm.offline;

  // Loading skeleton (never leave the user staring at a blank shell).
  if ((crm.status === 'idle' || crm.status === 'loading') && !crm.data) {
    return (
      <div data-app="crm" className="vv-fit flex min-h-0 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-[var(--crm-border)] bg-[var(--crm-surface)] px-4">
          <div className="crm-skeleton h-6 w-28" />
          <div className="crm-skeleton h-8 w-8 rounded-full" />
        </header>
        <main id="crm-main" aria-busy="true" className="mx-auto w-full max-w-4xl flex-1 p-6">
          <p role="status" className="sr-only">
            Checking CRM access…
          </p>
          <div className="crm-skeleton h-8 w-52" />
          <div className="crm-skeleton mt-3 h-4 w-72" />
          <div className="crm-skeleton mt-6 h-40 w-full rounded-xl" />
        </main>
      </div>
    );
  }

  if (crm.status === 'offline' && !crm.data) {
    return (
      <div data-app="crm" className="vv-fit flex min-h-0 flex-col">
        <CrmStateView
          icon={<CloudOff size={20} aria-hidden="true" />}
          title="You're offline"
          body="Reconnect to verify your CRM access before opening CRM pages."
          action={
            <>
              <button
                type="button"
                className="crm-btn-primary"
                onClick={() => void refreshCrmStatus({ force: true })}
              >
                <RefreshCw size={15} aria-hidden="true" />
                <span>Retry</span>
              </button>
              <Link to="/" className="crm-btn-secondary">
                <ArrowLeft size={15} aria-hidden="true" />
                <span>Return to Workspace</span>
              </Link>
            </>
          }
        />
      </div>
    );
  }

  if (crm.status === 'error' && !crm.data) {
    return (
      <div data-app="crm" className="vv-fit flex min-h-0 flex-col">
        <CrmStateView
          icon={<AlertTriangle size={20} aria-hidden="true" />}
          title="Couldn't check CRM access"
          body={crm.error ?? 'The server did not return your CRM access status. Retry when connected.'}
          action={
            <>
              <button
                type="button"
                className="crm-btn-primary"
                onClick={() => void refreshCrmStatus({ force: true })}
              >
                <RefreshCw size={15} aria-hidden="true" />
                <span>Retry</span>
              </button>
              <Link to="/" className="crm-btn-secondary">
                <ArrowLeft size={15} aria-hidden="true" />
                <span>Return to Workspace</span>
              </Link>
            </>
          }
        />
      </div>
    );
  }

  if (!crm.data || !crm.data.enabled || !crm.data.access) {
    const disabledApp = crm.data && !crm.data.enabled;
    return (
      <div data-app="crm" className="vv-fit flex min-h-0 flex-col">
        <CrmStateView
          icon={<Lock size={20} aria-hidden="true" />}
          title="You don't have access to this"
          body={
            disabledApp
              ? 'The CRM is not enabled on this workspace. You can continue using Workspace.'
              : 'Ask the workspace owner (or an admin with Manage capabilities) to grant you Open the CRM.'
          }
          action={
            <>
              <Link to="/" className="crm-btn-primary">
                <ArrowLeft size={15} aria-hidden="true" />
                <span>Return to Workspace</span>
              </Link>
              <button
                type="button"
                className="crm-btn-secondary"
                onClick={() => void refreshCrmStatus({ force: true })}
              >
                <RefreshCw size={15} aria-hidden="true" />
                <span>Check again</span>
              </button>
            </>
          }
        />
      </div>
    );
  }

  const status = crm.data;
  const canManage = canManageCrmAccess(status);
  const canConfigureAny = status.owner || status.capabilities.some((c) => c.capability === 'crm.configure');
  const [moreOpen, setMoreOpen] = useState(false);

  const navItems = [
    { to: '/crm', label: 'Home', icon: Home, end: true },
    { to: '/crm/people', label: 'People', icon: Users, end: false },
    { to: '/crm/organisations', label: 'Organisations', icon: Building2, end: false },
    { to: '/crm/programmes', label: 'Programmes', icon: Compass, end: false },
    { to: '/crm/applications', label: 'Applications', icon: FileCheck2, end: false },
    { to: '/crm/activities', label: 'Activities', icon: CalendarCheck2, end: false },
    ...(canManage
      ? [{ to: '/crm/settings/access', label: 'Settings', icon: Settings, end: false }]
      : canConfigureAny
        ? [{ to: '/crm/settings/programmes', label: 'Settings', icon: Settings, end: false }]
        : []),
  ];

  const compactNavItems = [
    { to: '/crm', label: 'Home', icon: Home, end: true },
    { to: '/crm/people', label: 'People', icon: Users, end: false },
    { to: '/crm/activities', label: 'Tasks', icon: CalendarCheck2, end: false },
    ...(canManage
      ? [{ to: '/crm/settings/access', label: 'Settings', icon: Settings, end: false }]
      : canConfigureAny
        ? [{ to: '/crm/settings/programmes', label: 'Settings', icon: Settings, end: false }]
        : []),
  ];

  const routeLabel = pathname.startsWith('/crm/settings/automations')
    ? 'Automation recipes'
    : pathname.startsWith('/crm/settings/programmes')
      ? 'Programme profiles'
      : pathname.startsWith('/crm/settings')
        ? 'Accounts & capabilities'
        : pathname.startsWith('/crm/people')
          ? 'People'
          : pathname.startsWith('/crm/organisations')
            ? 'Organisations'
            : pathname.startsWith('/crm/programmes')
              ? 'Programmes'
              : pathname.startsWith('/crm/applications')
                ? 'Applications'
                : pathname.startsWith('/crm/activities')
                  ? 'Activities'
                  : 'Home';
  const showSideRail = layout !== 'compact';
  const compactRail = layout === 'medium' ? effectiveCollapsed : railCollapsed;

  return (
    <div data-app="crm" className="vv-fit px-safe flex min-h-0 flex-col">
      <a href="#crm-main" className="crm-skip-link">
        Skip to content
      </a>

      <div className="flex min-h-0 flex-1">
        {showSideRail && (
          <aside
            aria-label="CRM sidebar"
            className={cn(
              'flex shrink-0 flex-col border-r border-[var(--crm-border)] bg-[var(--crm-surface)] transition-[width] duration-150',
              compactRail ? 'w-[60px]' : 'w-[232px]',
            )}
          >
            <div
              className={cn(
                'flex h-14 items-center border-b border-[var(--crm-border)] px-2',
                compactRail ? 'justify-center' : 'justify-between px-3',
              )}
            >
              <AppSwitcher current="crm" compact={compactRail} />
              {!compactRail && (
                <button
                  type="button"
                  onClick={() => setRailCollapsed((v) => !v)}
                  aria-label="Collapse sidebar"
                  aria-expanded={!compactRail}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-[var(--crm-text-muted)] hover:bg-[var(--crm-surface-2)] hover:text-[var(--crm-text)]"
                >
                  <ChevronLeft size={16} aria-hidden="true" />
                </button>
              )}
            </div>

            {compactRail && (
              <div className="flex justify-center pt-2">
                <button
                  type="button"
                  onClick={() => setRailCollapsed((v) => !v)}
                  aria-label="Expand sidebar"
                  aria-expanded={!compactRail}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-[var(--crm-text-muted)] hover:bg-[var(--crm-surface-2)] hover:text-[var(--crm-text)]"
                >
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              </div>
            )}

            <nav aria-label="CRM navigation" className="flex flex-1 flex-col gap-1 p-2">
              {navItems.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      cn(
                        'relative flex min-h-11 items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                        compactRail && 'justify-center px-0',
                        isActive
                          ? 'bg-[var(--crm-primary-soft)] text-[var(--crm-primary)] font-semibold'
                          : 'text-[var(--crm-text-muted)] hover:bg-[var(--crm-surface-2)] hover:text-[var(--crm-text)]',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && !compactRail && (
                          <span
                            aria-hidden="true"
                            className="absolute left-0 top-2 bottom-2 w-1 rounded-r bg-[var(--crm-primary)]"
                          />
                        )}
                        <Icon size={17} aria-hidden="true" className="shrink-0" />
                        <span className={compactRail ? 'sr-only' : 'truncate'}>{item.label}</span>
                      </>
                    )}
                  </NavLink>
                );
              })}
            </nav>

            <div className="border-t border-[var(--crm-border)] p-2.5">
              {compactRail ? (
                <div className="flex justify-center">
                  <CrmThemeControls compact />
                </div>
              ) : (
                <CrmThemeControls />
              )}
            </div>
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          {layout === 'compact' ? (
            <header className="pt-safe flex min-h-13 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--crm-border)] bg-[var(--crm-surface)] px-3 py-1">
              <AppSwitcher current="crm" className="min-w-0" />
              <div className="flex shrink-0 items-center gap-2">
                <CrmThemeControls compact />
                {user && <Avatar name={user.name} color={user.color} size={28} />}
              </div>
            </header>
          ) : (
            <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-[var(--crm-border)] bg-[var(--crm-surface)] px-6">
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <span className="font-medium text-[var(--crm-text-muted)]">CRM</span>
                <span aria-hidden="true" className="text-[var(--crm-text-muted)]">
                  /
                </span>
                <span className="truncate font-semibold">{routeLabel}</span>
              </div>

              <div className="flex shrink-0 items-center gap-3">
                {isOffline && (
                  <span
                    className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium"
                    style={{
                      backgroundColor: 'var(--crm-warn-bg)',
                      color: 'var(--crm-warn-text)',
                      borderColor: 'var(--crm-warn-border)',
                    }}
                  >
                    <CloudOff size={13} aria-hidden="true" />
                    <span>Offline</span>
                  </span>
                )}
                {user && (
                  <div className="flex items-center gap-2">
                    <Avatar name={user.name} color={user.color} size={28} />
                    <span className="max-w-36 truncate text-xs font-medium text-[var(--crm-text-muted)]">
                      {user.name}
                    </span>
                  </div>
                )}
              </div>
            </header>
          )}

          {isOffline && (
            <div
              role="status"
              className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs font-medium"
              style={{
                backgroundColor: 'var(--crm-warn-bg)',
                color: 'var(--crm-warn-text)',
                borderColor: 'var(--crm-warn-border)',
              }}
            >
              <CloudOff size={14} aria-hidden="true" />
              <span>
                Offline: edits will sync; bookings, payments and messages will wait. Capability changes need a connection.
              </span>
            </div>
          )}

          <main id="crm-main" className="min-h-0 flex-1 overflow-y-auto">
            <CrmRoutes status={status} />
          </main>

          {layout === 'compact' && (
            <nav
              aria-label="CRM navigation"
              className="pb-safe flex shrink-0 items-stretch border-t border-[var(--crm-border)] bg-[var(--crm-surface)]"
            >
              {compactNavItems.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      cn(
                        'flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[11px] font-medium transition-colors',
                        isActive
                          ? 'text-[var(--crm-primary)] font-semibold'
                          : 'text-[var(--crm-text-muted)]',
                      )
                    }
                  >
                    <Icon size={18} aria-hidden="true" />
                    <span className="truncate max-w-full">{item.label}</span>
                  </NavLink>
                );
              })}
              <button
                type="button"
                aria-label="More CRM sections"
                onClick={() => setMoreOpen(true)}
                className="flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[11px] font-medium text-[var(--crm-text-muted)]"
              >
                <MoreHorizontal size={18} aria-hidden="true" />
                <span className="truncate max-w-full">More</span>
              </button>
            </nav>
          )}
          {moreOpen && (
            <Sheet side="bottom" onClose={() => setMoreOpen(false)} label="More CRM sections">
              <div data-app="crm" className="space-y-1 p-4 bg-[var(--crm-surface)] text-[var(--crm-text)]">
                {navItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      onClick={() => setMoreOpen(false)}
                      className="flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium hover:bg-[var(--crm-surface-2)]"
                    >
                      <Icon size={17} aria-hidden="true" />
                      <span>{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </Sheet>
          )}
        </div>
      </div>
    </div>
  );
}
