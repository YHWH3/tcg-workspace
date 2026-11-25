import { Link } from 'react-router';
import { ArrowRight, Lock, ShieldCheck, Users } from 'lucide-react';
import { CRM_CAPABILITY_LABELS } from '../../../shared/crm/capabilities';
import type { CrmStatus } from '../../../shared/crm/contracts';
import { authStore } from '../../core/auth';
import { canManageCrmAccess } from '../../core/crmStatus';
import { useStore } from '../../core/store';

export function CrmHome({ status }: { status: CrmStatus }) {
  const user = useStore(authStore).user;
  const canManage = canManageCrmAccess(status);
  const firstName = user?.name?.trim().split(/\s+/)[0] || 'there';

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
      </header>

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
