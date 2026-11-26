import { useCallback, useEffect, useId, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { AlertTriangle, CheckCircle2, Database, GitMerge, RefreshCw, Users } from 'lucide-react';
import { CRM_PROJECTION, crmProjectionKey } from '../../../../shared/crm/projection';
import type { DuplicateCandidateDto } from '../../../../shared/crm/identity';
import type { CrmStatus } from '../../../../shared/crm/contracts';
import { authStore } from '../../../core/auth';
import { hasCrmCapability } from '../../../core/crmStatus';
import { useStore } from '../../../core/store';
import { onlineStore } from '../../../core/sync/engine';
import { AdaptiveDialog } from '../../../core/ui';
import { recordTitle, useDbRecords, type FieldKey } from '../../../core/records';
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
import { MergeCompareDialog } from './MergeCompareDialog';
import { MergeHistoryTab } from './MergeHistoryTab';

// Preserves transient confirmation banners across fail-closed access revalidation remounts for the same user.
let pendingPeopleBanner: { userId: string; text: string } | null = null;

const PEOPLE_PROJECTION_COLS: CrmProjectionColumn[] = [
  { key: crmProjectionKey('primary_email'), label: 'Primary email (verified)', format: 'text' },
  { key: crmProjectionKey('primary_phone'), label: 'Primary phone (verified)', format: 'text' },
  { key: crmProjectionKey('consent_summary'), label: 'Consent summary', format: 'text' },
];

export function PeopleView({ status }: { status: CrmStatus }) {
  const { personId } = useParams();
  const navigate = useNavigate();
  const isOffline = !useStore(onlineStore);
  const user = useStore(authStore).user;
  const canConfigure = hasCrmCapability(status, 'crm.configure');
  const canMerge = hasCrmCapability(status, 'crm.merge');
  const isAdminOrOwner =
    status.owner ||
    user?.workspaceRole === 'owner' ||
    user?.workspaceRole === 'admin' ||
    (!user?.workspaceRole && user?.role === 'admin');
  const canUnmerge = canMerge && isAdminOrOwner;

  const { peopleDb, needsPackInstall, installingPack, installError, installCrmPack } = useCrmDatabases();
  const allRecords = useDbRecords(peopleDb?.id).filter((r) => !r.parentId);
  const records = allRecords.filter((r) => r.archived !== true && !r[CRM_PROJECTION.mergedInto]);
  const selectedRecord = personId ? allRecords.find((r) => r.id === personId) : undefined;
  const isSelectedMerged = Boolean(
    selectedRecord && (selectedRecord.archived === true || selectedRecord[CRM_PROJECTION.mergedInto]),
  );

  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  const subTab: 'directory' | 'duplicates' | 'merges' =
    rawTab === 'duplicates'
      ? 'duplicates'
      : rawTab === 'merges' && canMerge
        ? 'merges'
        : 'directory';
  const setSubTab = useCallback(
    (next: 'directory' | 'duplicates' | 'merges') => {
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next === 'directory') p.delete('tab');
          else p.set('tab', next);
          return p;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

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

  // S10 Merge dialog & manual pair picker
  const [mergePair, setMergePair] = useState<{ survivorId: string; loserId: string } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickSurvivorId, setPickSurvivorId] = useState('');
  const [pickLoserId, setPickLoserId] = useState('');
  const [mergeBanner, setMergeBanner] = useState<string | null>(() =>
    pendingPeopleBanner && pendingPeopleBanner.userId === user?.id ? pendingPeopleBanner.text : null,
  );
  const updateMergeBanner = useCallback(
    (text: string | null) => {
      pendingPeopleBanner = text && user?.id ? { userId: user.id, text } : null;
      setMergeBanner(text);
    },
    [user?.id],
  );
  const pickSurvivorLabelId = useId();
  const pickLoserLabelId = useId();

  useEffect(() => {
    if (!user?.id || (pendingPeopleBanner && pendingPeopleBanner.userId !== user.id)) {
      pendingPeopleBanner = null;
      setMergeBanner(null);
    }
  }, [user?.id]);

  useEffect(() => {
    if (!canMerge && rawTab === 'merges') {
      setSubTab('directory');
    }
  }, [canMerge, rawTab, setSubTab]);

  const openManualPicker = (preferredSurvivorId?: string) => {
    if (records.length < 2) return;
    const survivor =
      preferredSurvivorId && records.some((r) => r.id === preferredSurvivorId)
        ? preferredSurvivorId
        : records[0]!.id;
    const loser = records.find((r) => r.id !== survivor)?.id ?? '';
    setPickSurvivorId(survivor);
    setPickLoserId(loser);
    setPickerOpen(true);
  };

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
    <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
      <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-5 sm:px-6">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold leading-tight">People</h1>
            <p className="mt-0.5 text-xs text-[var(--crm-text-muted)]">
              One canonical record per person · verified endpoints and consent stay authoritative on the server.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div role="tablist" aria-label="People sections" className="flex flex-wrap gap-1 rounded-lg border border-[var(--crm-border)] bg-[var(--crm-surface)] p-1">
              <button
                type="button"
                role="tab"
                aria-selected={subTab === 'directory'}
                onClick={() => setSubTab('directory')}
                className={
                  subTab === 'directory'
                    ? 'min-h-11 rounded-md bg-[var(--crm-primary)] px-3 py-1.5 text-xs font-semibold text-[var(--crm-primary-contrast)]'
                    : 'min-h-11 rounded-md px-3 py-1.5 text-xs font-medium text-[var(--crm-text-muted)]'
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
                    ? 'min-h-11 rounded-md bg-[var(--crm-primary)] px-3 py-1.5 text-xs font-semibold text-[var(--crm-primary-contrast)]'
                    : 'min-h-11 rounded-md px-3 py-1.5 text-xs font-medium text-[var(--crm-text-muted)]'
                }
              >
                Duplicates review
              </button>
              {canMerge && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={subTab === 'merges'}
                  onClick={() => setSubTab('merges')}
                  className={
                    subTab === 'merges'
                      ? 'min-h-11 rounded-md bg-[var(--crm-primary)] px-3 py-1.5 text-xs font-semibold text-[var(--crm-primary-contrast)]'
                      : 'min-h-11 rounded-md px-3 py-1.5 text-xs font-medium text-[var(--crm-text-muted)]'
                  }
                >
                  Merge history
                </button>
              )}
            </div>

            {canMerge && records.length >= 2 && (
              <button
                type="button"
                disabled={isOffline}
                onClick={() => openManualPicker()}
                className="crm-btn-secondary !min-h-11 !text-xs"
              >
                <GitMerge size={14} aria-hidden="true" />
                <span>Merge people…</span>
              </button>
            )}

            {canConfigure && (
              <button
                type="button"
                onClick={() => {
                  setBackfillReport(null);
                  setBackfillError(null);
                  setBackfillOpen(true);
                }}
                className="crm-btn-secondary !min-h-11 !text-xs"
              >
                <RefreshCw size={14} aria-hidden="true" />
                <span>Endpoint backfill…</span>
              </button>
            )}
          </div>
        </header>

        {mergeBanner && (
          <div
            role="status"
            className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3.5 py-2.5 text-xs"
            style={{
              backgroundColor: 'var(--crm-ok-bg)',
              color: 'var(--crm-ok-text)',
              borderColor: 'var(--crm-ok-border)',
            }}
          >
            <span className="font-medium">{mergeBanner}</span>
            <button type="button" onClick={() => updateMergeBanner(null)} className="min-h-11 px-2 underline">
              Dismiss
            </button>
          </div>
        )}

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
        ) : subTab === 'merges' && canMerge ? (
          <MergeHistoryTab
            canUnmerge={canUnmerge}
            onOpenPerson={(id) => navigate(`/crm/people/${id}`)}
            onUnmerged={(msg) => updateMergeBanner(msg)}
          />
        ) : (
          <section className="space-y-4">
            <div className="crm-panel flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="space-y-1 text-xs">
                <p className="font-semibold">Duplicate candidate review queue</p>
                <p className="text-[var(--crm-text-muted)]">
                  Dismiss false positives or compare &amp; merge duplicate contacts into a single canonical record.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Duplicate state"
                  className="crm-select !min-h-11 !w-auto !text-xs"
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
                  className="crm-btn-secondary !min-h-11 !text-xs"
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
                          className="min-h-11 inline-flex items-center font-semibold text-[var(--crm-primary)] hover:underline"
                        >
                          {d.personATitle ?? d.personAId}
                        </button>
                        <span className="text-[var(--crm-text-muted)]">vs</span>
                        <button
                          type="button"
                          onClick={() => navigate(`/crm/people/${d.personBId}`)}
                          className="min-h-11 inline-flex items-center font-semibold text-[var(--crm-primary)] hover:underline"
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
                      <div className="flex flex-wrap items-center gap-2">
                        {canMerge && (
                          <button
                            type="button"
                            disabled={isOffline || busyDupId === d.id}
                            onClick={() => setMergePair({ survivorId: d.personAId, loserId: d.personBId })}
                            className="crm-btn-primary !min-h-11 !text-xs"
                          >
                            <GitMerge size={13} aria-hidden="true" />
                            <span>Compare &amp; merge…</span>
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={isOffline || busyDupId === d.id}
                          onClick={() => void handleDismiss(d)}
                          className="crm-btn-secondary !min-h-11 !text-xs"
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
          headerActions={
            canMerge && !isSelectedMerged && records.length >= 2 ? (
              <button
                type="button"
                disabled={isOffline}
                onClick={() => openManualPicker(selectedRecord.id)}
                title="Merge with another person"
                className="crm-btn-secondary !min-h-11 !px-2.5 !py-1 !text-xs"
              >
                <GitMerge size={13} aria-hidden="true" />
                <span className="max-sm:sr-only">Merge…</span>
              </button>
            ) : undefined
          }
          onClose={() => navigate('/crm/people')}
        />
      )}

      {pickerOpen && (
        <AdaptiveDialog title="Choose two people to compare & merge" onClose={() => setPickerOpen(false)}>
          <div data-app="crm" className="space-y-4 text-xs">
            <p className="text-[var(--crm-text-muted)]">
              Select the canonical record to keep and the duplicate record to archive into it.
            </p>
            <div className="space-y-3">
              <div>
                <label htmlFor={pickSurvivorLabelId} className="mb-1 block font-semibold">
                  Keep (canonical person)
                </label>
                <select
                  id={pickSurvivorLabelId}
                  className="crm-select !min-h-11 !text-xs"
                  value={pickSurvivorId}
                  onChange={(e) => {
                    const nextS = e.target.value;
                    setPickSurvivorId(nextS);
                    if (nextS === pickLoserId) {
                      const alt = records.find((r) => r.id !== nextS)?.id ?? '';
                      setPickLoserId(alt);
                    }
                  }}
                >
                  {records.map((r) => (
                    <option key={r.id} value={r.id}>
                      {recordTitle(r)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={pickLoserLabelId} className="mb-1 block font-semibold">
                  Archive (merge into survivor)
                </label>
                <select
                  id={pickLoserLabelId}
                  className="crm-select !min-h-11 !text-xs"
                  value={pickLoserId}
                  onChange={(e) => setPickLoserId(e.target.value)}
                >
                  {records
                    .filter((r) => r.id !== pickSurvivorId)
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {recordTitle(r)}
                      </option>
                    ))}
                </select>
              </div>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setPickerOpen(false)}
                className="crm-btn-secondary !min-h-11 !text-xs"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!pickSurvivorId || !pickLoserId || pickSurvivorId === pickLoserId || isOffline}
                onClick={() => {
                  setPickerOpen(false);
                  setMergePair({ survivorId: pickSurvivorId, loserId: pickLoserId });
                }}
                className="crm-btn-primary !min-h-11 !text-xs"
              >
                <GitMerge size={14} aria-hidden="true" />
                <span>Compare &amp; merge…</span>
              </button>
            </div>
          </div>
        </AdaptiveDialog>
      )}

      {mergePair && (
        <MergeCompareDialog
          initialSurvivorId={mergePair.survivorId}
          initialLoserId={mergePair.loserId}
          onClose={() => setMergePair(null)}
          onMerged={(_res, survivorTitle, loserTitle) => {
            setMergePair(null);
            updateMergeBanner(`Merged ${loserTitle} into ${survivorTitle}.`);
            if (subTab === 'duplicates') void loadDuplicates();
          }}
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
