import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { AlertTriangle, CheckCircle2, Database, RefreshCw, Users } from 'lucide-react';
import { crmProjectionKey } from '../../../../shared/crm/projection';
import type { DuplicateCandidateDto } from '../../../../shared/crm/identity';
import type { CrmStatus } from '../../../../shared/crm/contracts';
import { hasCrmCapability } from '../../../core/crmStatus';
import { useStore } from '../../../core/store';
import { onlineStore } from '../../../core/sync/engine';
import { AdaptiveDialog } from '../../../core/ui';
import { useDbRecords, type FieldKey } from '../../../core/records';
import type { CrmProjectionColumn } from '../components/CrmGrid';
import { CrmGrid } from '../components/CrmGrid';
import { RecordPanel } from '../components/RecordPanel';
import { useCrmDatabases } from '../hooks/useCrmDatabases';
import {
  describeCommandError,
  dismissDuplicateCandidate,
  fetchDuplicates,
  runEndpointBackfill,
  type BackfillEndpointsOutput,
} from '../api';

const PEOPLE_PROJECTION_COLS: CrmProjectionColumn[] = [
  { key: crmProjectionKey('primary_email'), label: 'Primary email (verified)', format: 'text' },
  { key: crmProjectionKey('primary_phone'), label: 'Primary phone (verified)', format: 'text' },
  { key: crmProjectionKey('consent_summary'), label: 'Consent summary', format: 'text' },
];

export function PeopleView({ status }: { status: CrmStatus }) {
  const { personId } = useParams();
  const navigate = useNavigate();
  const isOffline = !useStore(onlineStore);
  const canConfigure = hasCrmCapability(status, 'crm.configure');
  const { peopleDb, needsPackInstall, installingPack, installError, installCrmPack } = useCrmDatabases();
  const records = useDbRecords(peopleDb?.id).filter((r) => !r.parentId);
  const selectedRecord = personId ? records.find((r) => r.id === personId) : undefined;

  const [subTab, setSubTab] = useState<'directory' | 'duplicates'>('directory');
  const [dupState, setDupState] = useState<'open' | 'dismissed'>('open');
  const [duplicates, setDuplicates] = useState<DuplicateCandidateDto[]>([]);
  const [dupLoading, setDupLoading] = useState(false);
  const [dupError, setDupError] = useState<string | null>(null);
  const [busyDupId, setBusyDupId] = useState<string | null>(null);

  // Backfill dry-run / apply modal
  const [backfillOpen, setBackfillOpen] = useState(false);
  const [backfillBusy, setBackfillBusy] = useState(false);
  const [backfillError, setBackfillError] = useState<string | null>(null);
  const [backfillReport, setBackfillReport] = useState<BackfillEndpointsOutput | null>(null);

  const loadDuplicates = useCallback(async () => {
    setDupLoading(true);
    setDupError(null);
    try {
      const res = await fetchDuplicates(dupState);
      setDuplicates(res.items);
    } catch {
      setDupError('Could not load duplicate candidates. Retry when connected.');
    } finally {
      setDupLoading(false);
    }
  }, [dupState]);

  useEffect(() => {
    if (subTab === 'duplicates') {
      void loadDuplicates();
    }
  }, [subTab, loadDuplicates]);

  const handleDismiss = async (cand: DuplicateCandidateDto) => {
    if (isOffline || busyDupId) return;
    setBusyDupId(cand.id);
    setDupError(null);
    try {
      const res = await dismissDuplicateCandidate({ candidateId: cand.id });
      if (res.ok) {
        await loadDuplicates();
      } else {
        setDupError(describeCommandError(res));
      }
    } catch (err) {
      setDupError(describeCommandError(err));
    } finally {
      setBusyDupId(null);
    }
  };

  const handleBackfill = async (dryRun: boolean) => {
    if (isOffline || backfillBusy) return;
    setBackfillBusy(true);
    setBackfillError(null);
    try {
      const res = await runEndpointBackfill({ dryRun, limit: 25 });
      if (res.ok) {
        setBackfillReport(res.result);
        if (!dryRun && res.result.candidatesCreated > 0 && subTab === 'duplicates') {
          void loadDuplicates();
        }
      } else {
        setBackfillError(describeCommandError(res));
      }
    } catch (err) {
      setBackfillError(describeCommandError(err));
    } finally {
      setBackfillBusy(false);
    }
  };

  if (!peopleDb) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8">
        <section className="crm-panel p-6 space-y-3">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--crm-primary-soft)] text-[var(--crm-primary)]">
            <Users size={20} aria-hidden="true" />
          </div>
          <h1 className="text-lg font-semibold">People database is not installed yet</h1>
          <p className="text-sm text-[var(--crm-text-muted)]">
            {needsPackInstall
              ? 'Initialise the TCG Pack databases (People, Organisations, Programmes, Applications, Activities, Opportunities) to start managing relationships.'
              : 'Install or select a People database to view contacts.'}
          </p>
          {installError && (
            <p role="alert" className="text-xs text-[var(--crm-err-text)]">
              {installError}
            </p>
          )}
          <div>
            <button
              type="button"
              disabled={installingPack || isOffline}
              onClick={() => void installCrmPack()}
              className="crm-btn-primary"
            >
              <Database size={15} aria-hidden="true" />
              <span>{installingPack ? 'Initialising…' : 'Initialise TCG CRM databases'}</span>
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold leading-tight">People</h1>
            <p className="mt-0.5 text-xs text-[var(--crm-text-muted)]">
              One canonical record per person · verified endpoints and consent stay authoritative on the server.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div role="tablist" aria-label="People sections" className="flex rounded-lg border border-[var(--crm-border)] bg-[var(--crm-surface)] p-0.5">
              <button
                type="button"
                role="tab"
                aria-selected={subTab === 'directory'}
                onClick={() => setSubTab('directory')}
                className={
                  subTab === 'directory'
                    ? 'min-h-10 rounded-md bg-[var(--crm-primary)] px-3 py-1.5 text-xs font-semibold text-[var(--crm-primary-contrast)]'
                    : 'min-h-10 rounded-md px-3 py-1.5 text-xs font-medium text-[var(--crm-text-muted)]'
                }
              >
                Directory ({records.length})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={subTab === 'duplicates'}
                onClick={() => setSubTab('duplicates')}
                className={
                  subTab === 'duplicates'
                    ? 'min-h-10 rounded-md bg-[var(--crm-primary)] px-3 py-1.5 text-xs font-semibold text-[var(--crm-primary-contrast)]'
                    : 'min-h-10 rounded-md px-3 py-1.5 text-xs font-medium text-[var(--crm-text-muted)]'
                }
              >
                Duplicates review
              </button>
            </div>

            {canConfigure && (
              <button
                type="button"
                onClick={() => {
                  setBackfillReport(null);
                  setBackfillError(null);
                  setBackfillOpen(true);
                }}
                className="crm-btn-secondary !text-xs"
              >
                <RefreshCw size={14} aria-hidden="true" />
                <span>Endpoint backfill…</span>
              </button>
            )}
          </div>
        </header>

        {subTab === 'directory' ? (
          <CrmGrid
            board={peopleDb}
            records={records}
            projectionColumns={PEOPLE_PROJECTION_COLS}
            selectedRecordId={selectedRecord?.id ?? null}
            onSelectRecord={(id) => navigate(`/crm/people/${id}`)}
            defaultGroupBy={'p_f_source' as FieldKey}
            emptyTitle="No people recorded yet"
            emptyBody="Add your first contact or import submissions from the Website inbox."
          />
        ) : (
          <section className="space-y-4">
            <div className="crm-panel flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="space-y-1 text-xs">
                <p className="font-semibold">Duplicate candidate review queue</p>
                <p className="text-[var(--crm-text-muted)]">
                  Dismiss false positives here. Merging duplicate records (`crm.merge` and reversible alias journal) ships in P2.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <select
                  aria-label="Duplicate state"
                  className="crm-select !min-h-10 !w-auto !text-xs"
                  value={dupState}
                  onChange={(e) => setDupState(e.target.value as 'open' | 'dismissed')}
                >
                  <option value="open">Open candidates</option>
                  <option value="dismissed">Dismissed</option>
                </select>
                <button
                  type="button"
                  disabled={dupLoading || isOffline}
                  onClick={() => void loadDuplicates()}
                  className="crm-btn-secondary !min-h-10 !text-xs"
                >
                  Refresh
                </button>
              </div>
            </div>

            {dupError && (
              <div role="alert" className="rounded-lg border p-3 text-xs" style={{ backgroundColor: 'var(--crm-err-bg)', color: 'var(--crm-err-text)', borderColor: 'var(--crm-err-border)' }}>
                {dupError}
              </div>
            )}

            {dupLoading ? (
              <div className="crm-panel space-y-2 p-4" aria-busy="true">
                <div className="crm-skeleton h-12 w-full" />
                <div className="crm-skeleton h-12 w-full" />
              </div>
            ) : duplicates.length === 0 ? (
              <div className="crm-panel p-6 text-center text-xs text-[var(--crm-text-muted)]">
                <CheckCircle2 size={22} aria-hidden="true" className="mx-auto mb-2 text-[var(--crm-status-leaf)]" />
                <p className="font-semibold text-[var(--crm-text)]">No {dupState} duplicate candidates</p>
                <p className="mt-1">Run Endpoint backfill when importing or migrating contacts to scan for collisions.</p>
              </div>
            ) : (
              <ul className="space-y-3">
                {duplicates.map((d) => (
                  <li key={d.id} className="crm-panel flex flex-wrap items-center justify-between gap-3 p-4 text-xs">
                    <div className="space-y-1 min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => navigate(`/crm/people/${d.personAId}`)}
                          className="font-semibold text-[var(--crm-primary)] hover:underline"
                        >
                          {d.personATitle ?? d.personAId}
                        </button>
                        <span className="text-[var(--crm-text-muted)]">vs</span>
                        <button
                          type="button"
                          onClick={() => navigate(`/crm/people/${d.personBId}`)}
                          className="font-semibold text-[var(--crm-primary)] hover:underline"
                        >
                          {d.personBTitle ?? d.personBId}
                        </button>
                        <span
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                          style={{
                            backgroundColor: d.confidence === 'high' ? 'var(--crm-warn-bg)' : 'var(--crm-surface-2)',
                            color: d.confidence === 'high' ? 'var(--crm-warn-text)' : 'var(--crm-text-muted)',
                          }}
                        >
                          <AlertTriangle size={11} aria-hidden="true" />
                          <span>{d.confidence}</span>
                        </span>
                      </div>
                      <p className="text-[var(--crm-text-muted)]">{d.reason}</p>
                    </div>

                    {d.state === 'open' && (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={isOffline || busyDupId === d.id}
                          onClick={() => void handleDismiss(d)}
                          className="crm-btn-secondary !min-h-10 !text-xs"
                        >
                          Dismiss
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>

      {selectedRecord && (
        <RecordPanel
          board={peopleDb}
          record={selectedRecord}
          entityKind="person"
          onClose={() => navigate('/crm/people')}
        />
      )}

      {backfillOpen && (
        <AdaptiveDialog title="Endpoint backfill and collision check" onClose={() => setBackfillOpen(false)}>
          <div className="space-y-4 text-sm">
            <p className="text-xs text-[var(--crm-text-muted)]">
              Reads up to 25 People records per pass, normalises Email &amp; Phone into server endpoints, reports collisions without overwriting, and queues any conflicts into Duplicate review.
            </p>
            {backfillError && (
              <p role="alert" className="text-xs text-[var(--crm-err-text)]">
                {backfillError}
              </p>
            )}
            {backfillReport && (
              <div className="rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-3 text-xs space-y-1.5">
                <p className="font-semibold">
                  {backfillReport.dryRun ? 'Dry-run preview (nothing written)' : 'Backfill batch applied'}
                </p>
                <p>Scanned: {backfillReport.scanned} · Would create: {backfillReport.wouldCreate} · Created: {backfillReport.created}</p>
                <p>Already present: {backfillReport.alreadyPresent} · Invalid format skipped: {backfillReport.skippedInvalid}</p>
                <p>Conflicts detected: {backfillReport.conflicts.length} · Duplicate candidates queued: {backfillReport.candidatesCreated}</p>
              </div>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={isOffline || backfillBusy}
                onClick={() => void handleBackfill(true)}
                className="crm-btn-secondary !text-xs"
              >
                Run dry-run
              </button>
              <button
                type="button"
                disabled={isOffline || backfillBusy}
                onClick={() => void handleBackfill(false)}
                className="crm-btn-primary !text-xs"
              >
                Apply backfill batch
              </button>
            </div>
          </div>
        </AdaptiveDialog>
      )}
    </div>
  );
}
