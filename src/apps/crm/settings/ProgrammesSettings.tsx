import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowLeft, CheckCircle2, Lock, RefreshCw, SlidersHorizontal } from 'lucide-react';
import type { ProgrammeProfileV1, ProgrammeSummaryDto } from '../../../../shared/crm/programmes';
import type { CrmStatus } from '../../../../shared/crm/contracts';
import { canManageCrmAccess } from '../../../core/crmStatus';
import { useStore } from '../../../core/store';
import { onlineStore } from '../../../core/sync/engine';
import {
  describeCommandError,
  fetchProgrammes,
  generateCrmRequestId,
  updateProgrammeProfile,
} from '../api';

export function ProgrammesSettings({ status }: { status: CrmStatus }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const isOffline = !useStore(onlineStore);
  const canManage = canManageCrmAccess(status);
  const canConfigureAny = status.owner || status.capabilities.some((c) => c.capability === 'crm.configure');

  const [programmes, setProgrammes] = useState<ProgrammeSummaryDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedSlug = searchParams.get('slug') ?? programmes[0]?.slug ?? 'common-lab';
  const current = programmes.find((p) => p.slug === selectedSlug) ?? programmes[0] ?? null;

  const [draft, setDraft] = useState<ProgrammeProfileV1 | null>(null);

  const loadAll = useCallback(async () => {
    if (isOffline) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchProgrammes();
      setProgrammes(res.programmes);
    } catch (err) {
      setError(describeCommandError(err));
    } finally {
      setLoading(false);
    }
  }, [isOffline]);

  useEffect(() => {
    if (canConfigureAny) void loadAll();
  }, [canConfigureAny, loadAll]);

  useEffect(() => {
    if (current) setDraft(structuredClone(current.profile));
  }, [current?.slug, current?.rev]);

  if (!canConfigureAny) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-10 sm:px-6">
        <section className="crm-panel p-6">
          <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--crm-surface-2)]">
            <Lock size={20} aria-hidden="true" />
          </div>
          <h1 className="text-lg font-semibold">You don't have access to this</h1>
          <p className="mt-2 text-sm text-[var(--crm-text-muted)]">
            Configure (`crm.configure`) permission is required to edit programme profiles.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link to="/crm" className="crm-btn-primary">
              <ArrowLeft size={15} aria-hidden="true" />
              <span>Back to CRM Home</span>
            </Link>
          </div>
        </section>
      </div>
    );
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!current || !draft || !current.canConfigure || isOffline || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await updateProgrammeProfile(
        {
          slug: current.slug,
          profile: draft,
          ...(current.rev > 0 ? { expectedRev: current.rev } : {}),
          ...(current.recordId ? { programmeRecordId: current.recordId } : {}),
        },
        { requestId: generateCrmRequestId() },
      );
      if (res.ok) {
        setNotice(`Saved configuration for ${current.name}.`);
        await loadAll();
      } else {
        setError(describeCommandError(res));
        if (res.error === 'stale') await loadAll();
      }
    } catch (err) {
      setError(describeCommandError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-3 py-5 sm:px-6 sm:py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-[var(--crm-text-muted)]">Settings</p>
          <h1 className="mt-0.5 text-xl font-semibold leading-tight">Programme profiles</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canManage && (
            <Link to="/crm/settings/access" className="crm-btn-secondary">
              Accounts & capabilities
            </Link>
          )}
          {(status.owner || status.capabilities.some((c) => c.capability === 'crm.configure' && c.scope === '*')) && (
            <Link to="/crm/settings/automations" className="crm-btn-secondary">
              Automations
            </Link>
          )}
          <button
            type="button"
            disabled={loading || isOffline}
            onClick={() => void loadAll()}
            className="crm-btn-secondary"
          >
            <RefreshCw size={15} aria-hidden="true" className={loading ? 'animate-spin' : ''} />
            <span>Refresh</span>
          </button>
        </div>
      </header>

      {error && (
        <div role="alert" className="rounded-lg border px-4 py-3 text-xs" style={{ backgroundColor: 'var(--crm-err-bg)', color: 'var(--crm-err-text)', borderColor: 'var(--crm-err-border)' }}>
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="flex items-center gap-2 rounded-lg border px-4 py-3 text-xs" style={{ backgroundColor: 'var(--crm-ok-bg)', color: 'var(--crm-ok-text)', borderColor: 'var(--crm-ok-border)' }}>
          <CheckCircle2 size={14} aria-hidden="true" />
          <span>{notice}</span>
        </div>
      )}

      <div className="crm-panel p-4 space-y-4">
        <div>
          <label htmlFor="crm-prog-select" className="mb-1 block text-xs font-medium text-[var(--crm-text-muted)]">
            Programme
          </label>
          <select
            id="crm-prog-select"
            className="crm-select max-w-md"
            value={current?.slug ?? ''}
            onChange={(e) => {
              const next = new URLSearchParams(searchParams);
              next.set('slug', e.target.value);
              setSearchParams(next, { replace: true });
            }}
          >
            {programmes.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name} {!p.canConfigure ? '(Read-only — outside scope)' : ''}
              </option>
            ))}
          </select>
        </div>

        {current && draft && (
          <form onSubmit={(e) => void handleSave(e)} className="space-y-4 text-xs">
            {!current.canConfigure && (
              <p className="rounded-lg border border-[var(--crm-warn-border)] bg-[var(--crm-warn-bg)] px-3 py-2 text-[var(--crm-warn-text)]">
                Your Configure capability is not scoped to {current.name}. Ask the owner or a full admin for `programme:{current.slug}`.
              </p>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="prog-resp-days" className="mb-1 block font-medium text-[var(--crm-text-muted)]">
                  Response target (days, optional)
                </label>
                <input
                  id="prog-resp-days"
                  type="number"
                  min={1}
                  max={180}
                  disabled={!current.canConfigure}
                  placeholder="Not configured"
                  className="crm-input"
                  value={draft.responseTargetDays ?? ''}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      responseTargetDays: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                />
              </div>

              <div>
                <label htmlFor="prog-hold-mins" className="mb-1 block font-medium text-[var(--crm-text-muted)]">
                  Booking hold duration (minutes, optional)
                </label>
                <input
                  id="prog-hold-mins"
                  type="number"
                  min={15}
                  max={43200}
                  disabled={!current.canConfigure}
                  placeholder="Not configured"
                  className="crm-input"
                  value={draft.bookingDefaults.holdMinutes ?? ''}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      bookingDefaults: {
                        ...draft.bookingDefaults,
                        holdMinutes: e.target.value ? Number(e.target.value) : null,
                      },
                    })
                  }
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="prog-fee" className="mb-1 block font-medium text-[var(--crm-text-muted)]">
                  Fee policy note (leave blank if unconfigured)
                </label>
                <input
                  id="prog-fee"
                  type="text"
                  maxLength={300}
                  disabled={!current.canConfigure}
                  placeholder="Not configured"
                  className="crm-input"
                  value={draft.policies.feeSummary ?? ''}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      policies: { ...draft.policies, feeSummary: e.target.value.trim() ? e.target.value : null },
                    })
                  }
                />
              </div>
              <div>
                <label htmlFor="prog-eligibility" className="mb-1 block font-medium text-[var(--crm-text-muted)]">
                  Eligibility criteria (leave blank if unconfigured)
                </label>
                <input
                  id="prog-eligibility"
                  type="text"
                  maxLength={500}
                  disabled={!current.canConfigure}
                  placeholder="Not configured"
                  className="crm-input"
                  value={draft.policies.eligibilityCriteria ?? ''}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      policies: {
                        ...draft.policies,
                        eligibilityCriteria: e.target.value.trim() ? e.target.value : null,
                      },
                    })
                  }
                />
              </div>
              <div>
                <label htmlFor="prog-duration" className="mb-1 block font-medium text-[var(--crm-text-muted)]">
                  Duration summary
                </label>
                <input
                  id="prog-duration"
                  type="text"
                  maxLength={300}
                  disabled={!current.canConfigure}
                  placeholder="Not configured"
                  className="crm-input"
                  value={draft.policies.durationSummary ?? ''}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      policies: {
                        ...draft.policies,
                        durationSummary: e.target.value.trim() ? e.target.value : null,
                      },
                    })
                  }
                />
              </div>
              <div>
                <label htmlFor="prog-benefits" className="mb-1 block font-medium text-[var(--crm-text-muted)]">
                  Benefits summary
                </label>
                <input
                  id="prog-benefits"
                  type="text"
                  maxLength={500}
                  disabled={!current.canConfigure}
                  placeholder="Not configured"
                  className="crm-input"
                  value={draft.policies.benefitsSummary ?? ''}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      policies: {
                        ...draft.policies,
                        benefitsSummary: e.target.value.trim() ? e.target.value : null,
                      },
                    })
                  }
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4 pt-1">
              <label className="flex min-h-11 items-center gap-2">
                <input
                  type="checkbox"
                  disabled={!current.canConfigure}
                  checked={draft.autoCreateApplications}
                  onChange={(e) => setDraft({ ...draft, autoCreateApplications: e.target.checked })}
                />
                <span>Auto-create application records from tagged submissions</span>
              </label>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="submit"
                disabled={!current.canConfigure || busy || isOffline}
                className="crm-btn-primary"
              >
                <SlidersHorizontal size={14} aria-hidden="true" />
                <span>{busy ? 'Saving…' : 'Save programme profile'}</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
