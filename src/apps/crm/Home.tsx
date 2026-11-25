import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ArrowRight, CalendarPlus, Clock, Lock, RefreshCw, ShieldCheck, Users } from 'lucide-react';
import { CRM_CAPABILITY_LABELS } from '../../../shared/crm/capabilities';
import type { CrmStatus } from '../../../shared/crm/contracts';
import type { HomeSummaryResponse } from '../../../shared/crm/programmes';
import { authStore } from '../../core/auth';
import { canManageCrmAccess } from '../../core/crmStatus';
import { useStore } from '../../core/store';
import { onlineStore } from '../../core/sync/engine';
import { AdaptiveDialog } from '../../core/ui';
import { fetchCrmHome } from './api';
import { QuickActivityComposer } from './components/QuickActivityComposer';

export function CrmHome({ status }: { status: CrmStatus }) {
  const user = useStore(authStore).user;
  const isOffline = !useStore(onlineStore);
  const canManage = canManageCrmAccess(status);
  const firstName = user?.name?.trim().split(/\s+/)[0] || 'there';

  const [home, setHome] = useState<HomeSummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);

  const loadHome = useCallback(async () => {
    if (isOffline) return;
    setLoading(true);
    try {
      const res = await fetchCrmHome();
      setHome(res);
    } catch {
      /* fallback cleanly to base summary */
    } finally {
      setLoading(false);
    }
  }, [isOffline]);

  useEffect(() => {
    void loadHome();
  }, [loadHome]);

  const hasWork = Boolean(
    home && (home.today.length > 0 || home.thisWeek.length > 0 || home.recently.length > 0),
  );

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[28px] font-semibold tracking-tight leading-[1.2]">
            Welcome, {firstName}
          </h1>
          <p className="mt-1.5 text-sm text-[var(--crm-text-muted)]">
            TCG CRM workspace ·{' '}
            {status.owner
              ? 'Owner access (all 13 capabilities)'
              : `${status.capabilities.length} active capabilit${status.capabilities.length === 1 ? 'y' : 'ies'}`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setComposerOpen(true)} className="crm-btn-secondary !min-h-10 !text-xs">
            <CalendarPlus size={14} aria-hidden="true" />
            <span>Log activity</span>
          </button>
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold"
            style={{
              backgroundColor: 'var(--crm-status-river)',
              color: 'var(--crm-status-fg)',
            }}
          >
            <ShieldCheck size={14} aria-hidden="true" />
            <span>{status.owner ? 'Owner' : 'CRM access active'}</span>
          </span>
        </div>
      </header>

      {isOffline && (
        <p role="status" className="rounded-lg border border-[var(--crm-warn-border)] bg-[var(--crm-warn-bg)] px-3 py-2 text-xs text-[var(--crm-warn-text)]">
          Offline: local databases stay browsable, while live approvals and server My Work counters update when reconnected.
        </p>
      )}

      {hasWork && home ? (
        <section aria-labelledby="crm-my-work-title" className="crm-panel p-5 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--crm-border)] pb-3">
            <h2 id="crm-my-work-title" className="text-base font-semibold flex items-center gap-2">
              <Clock size={16} aria-hidden="true" />
              <span>My work</span>
            </h2>
            <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--crm-text-muted)] crm-tabular">
              <span>{home.counts.pendingApprovals} approvals</span>
              <span>·</span>
              <span>{home.counts.ageingApplications} ageing apps</span>
              <span>·</span>
              <span>{home.counts.dueFollowUps} due follow-ups</span>
              <button
                type="button"
                disabled={loading || isOffline}
                onClick={() => void loadHome()}
                aria-label="Refresh My work"
                className="inline-flex min-h-8 min-w-8 items-center justify-center rounded hover:bg-[var(--crm-surface-2)]"
              >
                <RefreshCw size={13} aria-hidden="true" className={loading ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>

          {home.partial && (
            <p className="text-[11px] text-[var(--crm-text-muted)]">
              Partial view: capped recent records scanned. Visit individual databases for complete lists.
            </p>
          )}

          {home.today.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--crm-text-muted)]">Today</h3>
              <ul className="space-y-1.5">
                {home.today.slice(0, 8).map((item) => (
                  <li key={item.id}>
                    <Link
                      to={item.route}
                      className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] px-3 py-2 text-xs hover:bg-[var(--crm-surface-2)]"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{item.title}</p>
                        <p className="truncate text-[var(--crm-text-muted)]">{item.subtitle}</p>
                      </div>
                      <ArrowRight size={14} aria-hidden="true" className="shrink-0 text-[var(--crm-text-muted)]" />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {home.thisWeek.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--crm-text-muted)]">This week</h3>
              <ul className="space-y-1.5">
                {home.thisWeek.slice(0, 6).map((item) => (
                  <li key={item.id}>
                    <Link
                      to={item.route}
                      className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] px-3 py-2 text-xs hover:bg-[var(--crm-surface-2)]"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{item.title}</p>
                        <p className="truncate text-[var(--crm-text-muted)]">{item.subtitle}</p>
                      </div>
                      <ArrowRight size={14} aria-hidden="true" className="shrink-0 text-[var(--crm-text-muted)]" />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {home.recently.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--crm-text-muted)]">Recently updated</h3>
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {home.recently.slice(0, 6).map((item) => (
                  <li key={item.id}>
                    <Link
                      to={item.route}
                      className="flex min-h-11 items-center justify-between gap-2 rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] px-3 py-2 text-xs hover:bg-[var(--crm-surface-2)]"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{item.title}</p>
                        <p className="truncate text-[var(--crm-text-muted)]">{item.subtitle}</p>
                      </div>
                      <ArrowRight size={13} aria-hidden="true" className="shrink-0 text-[var(--crm-text-muted)]" />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      ) : (
        <section
          aria-labelledby="crm-home-empty-title"
          className="crm-panel p-6 sm:p-7"
        >
          <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 max-w-xl">
              <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--crm-primary-soft)] text-[var(--crm-primary)]">
                <Users size={20} aria-hidden="true" />
              </div>
              <h2 id="crm-home-empty-title" className="text-base font-semibold">
                No CRM records here yet
              </h2>
              <p className="mt-1.5 text-sm text-[var(--crm-text-muted)]">
                {canManage
                  ? 'CRM access rails are active. Manage workspace accounts, CRM capabilities, and audit history before adding programmes and people.'
                  : 'Your CRM access is active. People, conversations, bookings, and programme pipelines will appear here as they are enabled.'}
              </p>
            </div>

            <div className="flex shrink-0 flex-wrap gap-2">
              {canManage ? (
                <Link to="/crm/settings/access" className="crm-btn-primary">
                  <span>Manage accounts and capabilities</span>
                  <ArrowRight size={15} aria-hidden="true" />
                </Link>
              ) : (
                <Link to="/" className="crm-btn-secondary">
                  <span>Open Workspace</span>
                  <ArrowRight size={15} aria-hidden="true" />
                </Link>
              )}
            </div>
          </div>
        </section>
      )}

      {composerOpen && (
        <AdaptiveDialog title="Log CRM activity" onClose={() => setComposerOpen(false)}>
          <div data-app="crm">
            <QuickActivityComposer
              onCreated={() => {
                setComposerOpen(false);
                void loadHome();
              }}
              onCancel={() => setComposerOpen(false)}
            />
          </div>
        </AdaptiveDialog>
      )}

      <section aria-labelledby="crm-capabilities-summary" className="crm-panel p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--crm-border)] pb-3">
          <h2 id="crm-capabilities-summary" className="text-base font-semibold">
            Your CRM access
          </h2>
          <span className="crm-tabular text-xs font-medium text-[var(--crm-text-muted)]">
            {status.capabilities.length} of 13 enabled
          </span>
        </div>

        <ul className="mt-4 grid gap-2.5 sm:grid-cols-2">
          {status.capabilities.map((grant) => {
            const meta = CRM_CAPABILITY_LABELS[grant.capability];
            return (
              <li
                key={`${grant.capability}:${grant.scope}`}
                className="flex flex-col gap-1 rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] px-3.5 py-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">{meta.label}</span>
                  <span className="rounded-full border border-[var(--crm-border)] bg-[var(--crm-surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--crm-text-muted)]">
                    {grant.scope === '*' ? 'All' : grant.scope}
                  </span>
                  {meta.sensitive && (
                    <span
                      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
                      style={{
                        backgroundColor: 'var(--crm-warn-bg)',
                        color: 'var(--crm-warn-text)',
                      }}
                    >
                      <Lock size={11} aria-hidden="true" />
                      <span>Sensitive</span>
                    </span>
                  )}
                </div>
                <p className="text-xs text-[var(--crm-text-muted)]">{meta.description}</p>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
