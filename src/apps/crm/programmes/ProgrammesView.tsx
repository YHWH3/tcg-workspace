import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowRight, Compass, ExternalLink, RefreshCw, SlidersHorizontal, X } from 'lucide-react';
import {
  CRM_PROGRAMMES,
  CRM_WORK_AREAS,
  type ProgrammeSummaryDto,
} from '../../../../shared/crm/programmes';
import type { CrmStatus } from '../../../../shared/crm/contracts';
import { useLayoutMode } from '../../../core/mobile';
import { useStore } from '../../../core/store';
import { onlineStore } from '../../../core/sync/engine';
import { Sheet } from '../../../core/ui';
import { describeCommandError, fetchProgrammes } from '../api';
import { useCrmDatabases } from '../hooks/useCrmDatabases';

export function ProgrammesView({ status }: { status: CrmStatus }) {
  const { slug } = useParams();
  const navigate = useNavigate();
  const layout = useLayoutMode();
  const isOffline = !useStore(onlineStore);
  const { programsDb } = useCrmDatabases();

  const [programmes, setProgrammes] = useState<ProgrammeSummaryDto[]>(() =>
    CRM_PROGRAMMES.map((p) => ({
      slug: p.slug,
      name: p.name,
      area: p.area,
      recordId: null,
      rev: 0,
      updatedAt: null,
      updatedBy: null,
      canConfigure: status.owner,
      profile: p.defaultProfile,
      counts: { applications: 0, opportunities: 0, events: 0, people: 0 },
    })),
  );
  const [loading, setLoading] = useState(false);
  const [partial, setPartial] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProgrammes = useCallback(async () => {
    if (isOffline) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchProgrammes();
      setProgrammes(res.programmes);
      setPartial(res.partial);
    } catch (err) {
      setError(describeCommandError(err));
    } finally {
      setLoading(false);
    }
  }, [isOffline]);

  useEffect(() => {
    void loadProgrammes();
  }, [loadProgrammes]);

  const byArea = useMemo(() => {
    return CRM_WORK_AREAS.map((area) => ({
      ...area,
      items: programmes.filter((p) => p.area === area.id),
    }));
  }, [programmes]);

  const selected = slug ? programmes.find((p) => p.slug === slug) ?? null : null;

  const detailContent = selected ? (
    <div className="flex h-full min-h-0 flex-col bg-[var(--crm-surface)] text-[var(--crm-text)]">
      <div className="flex items-start justify-between gap-3 border-b border-[var(--crm-border)] px-4 py-3.5">
        <div className="min-w-0">
          <p className="text-xs font-medium text-[var(--crm-text-muted)]">
            {CRM_WORK_AREAS.find((a) => a.id === selected.area)?.label ?? selected.area}
          </p>
          <h2 className="mt-0.5 text-lg font-semibold leading-tight">{selected.name}</h2>
        </div>
        <button
          type="button"
          onClick={() => navigate('/crm/programmes')}
          aria-label="Close programme details"
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-[var(--crm-text-muted)] hover:bg-[var(--crm-surface-2)] hover:text-[var(--crm-text)]"
        >
          <X size={17} aria-hidden="true" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-xs">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-3">
            <span className="text-[var(--crm-text-muted)]">Applications</span>
            <p className="crm-tabular mt-1 text-lg font-semibold">{selected.counts.applications}</p>
          </div>
          <div className="rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-3">
            <span className="text-[var(--crm-text-muted)]">Opportunities</span>
            <p className="crm-tabular mt-1 text-lg font-semibold">{selected.counts.opportunities}</p>
          </div>
          <div className="rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-3">
            <span className="text-[var(--crm-text-muted)]">Events</span>
            <p className="crm-tabular mt-1 text-lg font-semibold">{selected.counts.events}</p>
          </div>
          <div className="rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-3">
            <span className="text-[var(--crm-text-muted)]">Linked people</span>
            <p className="crm-tabular mt-1 text-lg font-semibold">{selected.counts.people}</p>
          </div>
        </div>

        <section className="space-y-2 rounded-lg border border-[var(--crm-border)] p-3.5">
          <h3 className="font-semibold">Configured policies</h3>
          <p className="text-[var(--crm-text-muted)]">
            Policies default to Not configured until set explicitly by the owner or a scoped programme admin.
          </p>
          <dl className="space-y-1.5 pt-1">
            <div className="flex justify-between gap-2">
              <dt className="text-[var(--crm-text-muted)]">Response target</dt>
              <dd className="font-medium">
                {selected.profile.responseTargetDays !== null
                  ? `${selected.profile.responseTargetDays} days`
                  : 'Not configured'}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-[var(--crm-text-muted)]">Fee policy</dt>
              <dd className="font-medium">{selected.profile.policies.feeSummary ?? 'Not configured'}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-[var(--crm-text-muted)]">Eligibility</dt>
              <dd className="font-medium">{selected.profile.policies.eligibilityCriteria ?? 'Not configured'}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-[var(--crm-text-muted)]">Duration</dt>
              <dd className="font-medium">{selected.profile.policies.durationSummary ?? 'Not configured'}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-[var(--crm-text-muted)]">Benefits</dt>
              <dd className="font-medium">{selected.profile.policies.benefitsSummary ?? 'Not configured'}</dd>
            </div>
          </dl>
        </section>

        <div className="flex flex-wrap gap-2">
          <Link to={`/crm/applications?programme=${encodeURIComponent(selected.slug)}`} className="crm-btn-primary">
            <span>View applications</span>
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
          {selected.canConfigure && (
            <Link to={`/crm/settings/programmes?slug=${encodeURIComponent(selected.slug)}`} className="crm-btn-secondary">
              <SlidersHorizontal size={14} aria-hidden="true" />
              <span>Edit profile</span>
            </Link>
          )}
          {selected.recordId && programsDb && (
            <Link to={`/boards/${programsDb.id}/tasks/${selected.recordId}`} className="crm-btn-secondary">
              <ExternalLink size={14} aria-hidden="true" />
              <span>Open in Workspace</span>
            </Link>
          )}
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      <div className="min-w-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6 sm:py-6 space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-medium text-[var(--crm-text-muted)]">
              <Compass size={14} aria-hidden="true" />
              <span>Programme registry</span>
            </div>
            <h1 className="mt-0.5 text-xl font-semibold leading-tight">Programmes (14)</h1>
            <p className="mt-1 text-xs text-[var(--crm-text-muted)]">
              Organized across TCG’s five work areas. Unconfigured fees, eligibility, and SLA targets stay neutral until set.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(status.owner || status.capabilities.some((c) => c.capability === 'crm.configure')) && (
              <Link to="/crm/settings/programmes" className="crm-btn-secondary !text-xs">
                <SlidersHorizontal size={14} aria-hidden="true" />
                <span>Configure profiles</span>
              </Link>
            )}
            <button
              type="button"
              disabled={loading || isOffline}
              onClick={() => void loadProgrammes()}
              className="crm-btn-secondary !text-xs"
            >
              <RefreshCw size={14} aria-hidden="true" className={loading ? 'animate-spin' : ''} />
              <span>Refresh</span>
            </button>
          </div>
        </header>

        {partial && (
          <p role="status" className="rounded-lg border border-[var(--crm-border)] bg-[var(--crm-surface)] px-3 py-2 text-xs text-[var(--crm-text-muted)]">
            Live counts are capped at recent records; totals may exclude older archived entries.
          </p>
        )}
        {error && (
          <div role="alert" className="rounded-lg border px-3 py-2 text-xs" style={{ backgroundColor: 'var(--crm-err-bg)', color: 'var(--crm-err-text)', borderColor: 'var(--crm-err-border)' }}>
            {error}
          </div>
        )}

        <div className="space-y-6">
          {byArea.map((group) => (
            <section key={group.id} aria-labelledby={`area-${group.id}`} className="space-y-3">
              <div>
                <h2 id={`area-${group.id}`} className="text-sm font-semibold text-[var(--crm-text)]">
                  {group.label}
                </h2>
                <p className="text-xs text-[var(--crm-text-muted)]">{group.description}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {group.items.map((prog) => {
                  const active = selected?.slug === prog.slug;
                  return (
                    <button
                      key={prog.slug}
                      type="button"
                      onClick={() => navigate(`/crm/programmes/${prog.slug}`)}
                      className={`crm-panel flex min-h-11 flex-col items-start gap-2 p-4 text-left transition-colors ${
                        active ? 'ring-2 ring-[var(--crm-primary)]' : 'hover:bg-[var(--crm-surface-2)]'
                      }`}
                    >
                      <div className="flex w-full items-start justify-between gap-2">
                        <span className="text-sm font-semibold">{prog.name}</span>
                        <span className="rounded-full bg-[var(--crm-surface-2)] px-2 py-0.5 text-[11px] font-medium text-[var(--crm-text-muted)]">
                          {prog.rev > 0 ? 'Configured' : 'Default'}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-2 text-xs text-[var(--crm-text-muted)] crm-tabular">
                        <span>{prog.counts.applications} apps</span>
                        <span>·</span>
                        <span>{prog.counts.opportunities} opps</span>
                        <span>·</span>
                        <span>{prog.counts.events} events</span>
                      </div>
                      <p className="text-[11px] text-[var(--crm-text-muted)]">
                        Response target:{' '}
                        {prog.profile.responseTargetDays !== null
                          ? `${prog.profile.responseTargetDays}d`
                          : 'Not configured'}
                      </p>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>

      {detailContent && layout === 'expanded' && (
        <aside aria-label="Programme details" className="w-[400px] shrink-0 border-l border-[var(--crm-border)] bg-[var(--crm-surface)]">
          {detailContent}
        </aside>
      )}
      {detailContent && layout !== 'expanded' && (
        <Sheet onClose={() => navigate('/crm/programmes')} label={selected!.name}>
          {detailContent}
        </Sheet>
      )}
    </div>
  );
}
