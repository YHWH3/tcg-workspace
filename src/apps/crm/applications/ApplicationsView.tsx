import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowRight,
  Check,
  Database,
  ExternalLink,
  FileText,
  Globe,
  Lock,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  APPLICATION_CONVERT_TARGETS,
  CRM_PROGRAMME_BY_SLUG,
  programmeForWebsiteForm,
  type ApplicationConvertTarget,
} from '../../../../shared/crm/programmes';
import { CRM_PROJECTION } from '../../../../shared/crm/projection';
import type { CrmStatus } from '../../../../shared/crm/contracts';
import { cmpOrder } from '../../../../shared/order';
import { WI_FIELD } from '../../../../shared/websiteInbox';
import { authStore } from '../../../core/auth';
import { db, type LocalRow } from '../../../core/db';
import { recordTitle } from '../../../core/records';
import { useStore } from '../../../core/store';
import { onlineStore, syncNow } from '../../../core/sync/engine';
import { AdaptiveDialog } from '../../../core/ui';
import { approvalsApi, type Approval } from '../../../modules/approvals/api';
import { useUsers } from '../../../core/users';
import {
  convertApplication,
  createApplicationFromSubmission,
  describeCommandError,
  fetchProgrammes,
  generateCrmRequestId,
} from '../api';
import { CrmGrid, type CrmProjectionColumn } from '../components/CrmGrid';
import { RecordPanel } from '../components/RecordPanel';
import { useCrmDatabases } from '../hooks/useCrmDatabases';

const APP_PROJECTION_COLS: CrmProjectionColumn[] = [
  { key: CRM_PROJECTION.programmeSlug, label: 'Programme', format: 'text' },
  { key: CRM_PROJECTION.sourceSubmissionId, label: 'Source submission', format: 'text' },
  { key: CRM_PROJECTION.convertedKind, label: 'Converted kind', format: 'text' },
];

function VisitorsWordsTab({ submissionId }: { submissionId: string | null }) {
  const { tasks, websiteInboxDb } = useCrmDatabases();
  const submission = submissionId ? tasks.find((t) => !t.deleted && t.id === submissionId) : undefined;
  const blocks = useLiveQuery(
    () => (submissionId ? db.blocks.where('pageId').equals(submissionId).toArray() : Promise.resolve([] as LocalRow[])),
    [submissionId],
    [] as LocalRow[],
  );

  if (!submissionId) {
    return (
      <p className="rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-4 text-xs text-[var(--crm-text-muted)]">
        This application was not created from a Website inbox submission.
      </p>
    );
  }
  if (!submission) {
    return (
      <p className="rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-4 text-xs text-[var(--crm-text-muted)]">
        Source submission {submissionId} is not synced locally or is restricted.
      </p>
    );
  }

  const orderedBlocks = [...blocks].filter((b) => !b.deleted).sort((a, b) => cmpOrder(String(a.order ?? ''), String(b.order ?? '')));
  const family = submission[`p_${WI_FIELD.family}`];
  const email = submission[`p_${WI_FIELD.email}`];
  const received = submission[`p_${WI_FIELD.received}`];

  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] px-3 py-2">
        <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--crm-text)]">
          <Lock size={13} aria-hidden="true" />
          <span>Immutable sender submission (read-only)</span>
        </span>
        {websiteInboxDb && (
          <Link
            to={`/boards/${websiteInboxDb.id}/tasks/${submission.id}`}
            className="inline-flex items-center gap-1 font-medium text-[var(--crm-primary)] hover:underline"
          >
            <ExternalLink size={12} aria-hidden="true" />
            <span>Open submission</span>
          </Link>
        )}
      </div>

      <dl className="space-y-1.5 rounded-lg border border-[var(--crm-border)] p-3">
        <div className="flex justify-between gap-2">
          <dt className="text-[var(--crm-text-muted)]">Title</dt>
          <dd className="font-semibold text-right">{recordTitle(submission)}</dd>
        </div>
        {family !== undefined && (
          <div className="flex justify-between gap-2">
            <dt className="text-[var(--crm-text-muted)]">Form family</dt>
            <dd className="font-medium">{String(family)}</dd>
          </div>
        )}
        {email !== undefined && (
          <div className="flex justify-between gap-2">
            <dt className="text-[var(--crm-text-muted)]">Submitted email</dt>
            <dd className="font-mono">{String(email)}</dd>
          </div>
        )}
        {received !== undefined && (
          <div className="flex justify-between gap-2">
            <dt className="text-[var(--crm-text-muted)]">Received</dt>
            <dd>{String(received)}</dd>
          </div>
        )}
      </dl>

      <div className="space-y-1.5 rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-3">
        <p className="font-semibold text-[var(--crm-text-muted)]">Visitor answers</p>
        {orderedBlocks.length === 0 ? (
          <p className="text-[var(--crm-text-muted)]">No free-text answer blocks recorded on this submission.</p>
        ) : (
          orderedBlocks.map((b) => (
            <p key={b.id} className="whitespace-pre-wrap leading-relaxed text-[var(--crm-text)]">
              {String(b.text ?? '')}
            </p>
          ))
        )}
      </div>
    </div>
  );
}

function ApplicationApprovalTab({
  applicationId,
  programmeSlug,
}: {
  applicationId: string;
  programmeSlug: string | null;
}) {
  const me = useStore(authStore).user;
  const users = useUsers();
  const isOffline = !useStore(onlineStore);

  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approverId, setApproverId] = useState('');
  const [note, setNote] = useState('');
  const [gateNote, setGateNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadApprovals = useCallback(async () => {
    if (isOffline) return;
    setLoading(true);
    setError(null);
    try {
      const [res, progRes] = await Promise.all([
        approvalsApi.list(applicationId),
        programmeSlug ? fetchProgrammes().catch(() => null) : Promise.resolve(null),
      ]);
      setApprovals(res.approvals);
      const prof = progRes?.programmes.find((p) => p.slug === programmeSlug)?.profile;
      setGateNote(
        prof?.reviewGate?.requiresApproval
          ? `Programme gate: stage "${prof.reviewGate.stageId}" requires Workspace approval.`
          : null,
      );
    } catch (err) {
      setError(describeCommandError(err));
    } finally {
      setLoading(false);
    }
  }, [applicationId, isOffline, programmeSlug]);

  useEffect(() => {
    void loadApprovals();
  }, [loadApprovals]);

  const handleRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!approverId || isOffline || busy) return;
    setBusy(true);
    setError(null);
    try {
      await approvalsApi.request({
        targetType: 'record',
        targetId: applicationId,
        approverId,
        stageId: 'accepted',
        note: note.trim() || undefined,
      });
      setNote('');
      await loadApprovals();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approval request failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleDecide = async (ap: Approval, decision: 'approved' | 'rejected') => {
    if (isOffline || busy) return;
    setBusy(true);
    setError(null);
    try {
      await approvalsApi.decide(ap.id, decision, undefined, ap.rev);
      await loadApprovals();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not decide approval.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 text-xs">
      <div className="flex items-center gap-2 font-semibold text-[var(--crm-text)]">
        <ShieldCheck size={14} aria-hidden="true" />
        <span>Workspace approval gate</span>
      </div>
      {gateNote && (
        <p className="rounded-lg border border-[var(--crm-warn-border)] bg-[var(--crm-warn-bg)] px-3 py-2 text-[var(--crm-warn-text)]">
          {gateNote}
        </p>
      )}
      {error && (
        <p role="alert" className="text-[var(--crm-err-text)]">
          {error}
        </p>
      )}
      {loading ? (
        <p className="text-[var(--crm-text-muted)]">Loading approvals…</p>
      ) : approvals.length === 0 ? (
        <p className="rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-3 text-[var(--crm-text-muted)]">
          No approval requests on this application yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {approvals.map((ap) => {
            const approver = users.find((u) => u.id === ap.approverId)?.name ?? ap.approverId;
            const canDecide = ap.status === 'pending' && ap.approverId === me?.id;
            return (
              <li key={ap.id} className="rounded-lg border border-[var(--crm-border)] p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold capitalize">{ap.status}</span>
                  <span className="text-[var(--crm-text-muted)]">Approver: {approver}</span>
                </div>
                {ap.note && <p className="text-[var(--crm-text-muted)]">{ap.note}</p>}
                {canDecide && (
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busy || isOffline}
                      onClick={() => void handleDecide(ap, 'approved')}
                      className="crm-btn-primary !min-h-9 !px-3 !py-1 !text-xs"
                    >
                      <Check size={13} aria-hidden="true" />
                      <span>Approve</span>
                    </button>
                    <button
                      type="button"
                      disabled={busy || isOffline}
                      onClick={() => void handleDecide(ap, 'rejected')}
                      className="crm-btn-danger !min-h-9 !px-3 !py-1 !text-xs"
                    >
                      <X size={13} aria-hidden="true" />
                      <span>Reject</span>
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <form onSubmit={(e) => void handleRequest(e)} className="space-y-2 rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-3">
        <p className="font-semibold">Request Workspace approval</p>
        <select
          aria-label="Select approver"
          className="crm-select !min-h-10 !text-xs"
          value={approverId}
          onChange={(e) => setApproverId(e.target.value)}
        >
          <option value="">Choose approver…</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
        <input
          type="text"
          aria-label="Approval note"
          placeholder="Optional review note…"
          className="crm-input !min-h-10 !text-xs"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button type="submit" disabled={!approverId || busy || isOffline} className="crm-btn-secondary !min-h-10 !text-xs">
          Request approval
        </button>
      </form>
    </div>
  );
}

export function ApplicationsView({ status }: { status: CrmStatus }) {
  const { applicationId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const isOffline = !useStore(onlineStore);
  const {
    applicationsDb,
    websiteInboxDb,
    projectsDb,
    opportunitiesDb,
    eventsDb,
    tasks,
    needsPackInstall,
    installingPack,
    installError,
    installCrmPack,
  } = useCrmDatabases();

  const [subTab, setSubTab] = useState<'applications' | 'enquiries'>('applications');
  const [busySubId, setBusySubId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [convertOpen, setConvertOpen] = useState(false);
  const [convertKind, setConvertKind] = useState<ApplicationConvertTarget>('project');
  const [convertTitle, setConvertTitle] = useState('');
  const [convertBusy, setConvertBusy] = useState(false);

  const programmeFilter = searchParams.get('programme') ?? '';
  const allApps = useMemo(
    () =>
      tasks.filter(
        (t) =>
          !t.deleted &&
          applicationsDb &&
          t.boardId === applicationsDb.id &&
          !t.parentId &&
          (!programmeFilter || t[CRM_PROJECTION.programmeSlug] === programmeFilter),
      ),
    [tasks, applicationsDb, programmeFilter],
  );

  const enquiries = useMemo(
    () => tasks.filter((t) => !t.deleted && websiteInboxDb && t.boardId === websiteInboxDb.id && !t.parentId),
    [tasks, websiteInboxDb],
  );

  const appBySubmissionId = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of tasks) {
      if (a.deleted || !applicationsDb || a.boardId !== applicationsDb.id) continue;
      const src = a[CRM_PROJECTION.sourceSubmissionId];
      if (typeof src === 'string' && src) map.set(src, a.id);
    }
    return map;
  }, [tasks, applicationsDb]);

  const selectedRecord = applicationId ? tasks.find((t) => !t.deleted && t.id === applicationId) : undefined;

  const handleCreateFromSubmission = async (subId: string, inferredSlug?: string) => {
    if (isOffline || busySubId) return;
    setBusySubId(subId);
    setActionError(null);
    try {
      const outcome = await createApplicationFromSubmission(
        {
          submissionId: subId,
          ...(inferredSlug ? { programmeSlug: inferredSlug } : {}),
          ...(applicationsDb ? { applicationsBoardId: applicationsDb.id } : {}),
        },
        { requestId: generateCrmRequestId() },
      );
      if (outcome.ok) {
        await syncNow();
        setSubTab('applications');
        navigate(`/crm/applications/${outcome.result.applicationId}`);
      } else {
        setActionError(describeCommandError(outcome));
      }
    } catch (err) {
      setActionError(describeCommandError(err));
    } finally {
      setBusySubId(null);
    }
  };

  const targetBoardForKind = (kind: ApplicationConvertTarget) =>
    kind === 'project' ? projectsDb : kind === 'opportunity' ? opportunitiesDb : eventsDb;

  const handleConvert = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRecord || isOffline || convertBusy) return;
    const destBoard = targetBoardForKind(convertKind);
    if (!destBoard) {
      setActionError(`Install TCG Operating Pack first to create ${convertKind}s.`);
      return;
    }
    setConvertBusy(true);
    setActionError(null);
    try {
      const outcome = await convertApplication(
        {
          applicationId: selectedRecord.id,
          targetKind: convertKind,
          targetBoardId: destBoard.id,
          ...(convertTitle.trim() ? { title: convertTitle.trim() } : {}),
        },
        { requestId: generateCrmRequestId() },
      );
      if (outcome.ok) {
        await syncNow();
        setConvertOpen(false);
        setConvertTitle('');
      } else {
        setActionError(describeCommandError(outcome));
      }
    } catch (err) {
      setActionError(describeCommandError(err));
    } finally {
      setConvertBusy(false);
    }
  };

  if (!applicationsDb && subTab === 'applications' && enquiries.length === 0) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8 sm:px-6">
        <section className="crm-panel space-y-3 p-6">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--crm-primary-soft)] text-[var(--crm-primary)]">
            <Database size={20} aria-hidden="true" />
          </div>
          <h1 className="text-lg font-semibold">Applications database not installed yet</h1>
          <p className="text-sm text-[var(--crm-text-muted)]">
            Install the TCG Operating Pack to activate Applications, People, Organisations, Programmes, and Pipelines inside this workspace.
          </p>
          {installError && <p role="alert" className="text-xs text-[var(--crm-err-text)]">{installError}</p>}
          {needsPackInstall && (status.owner || status.capabilities.some((c) => c.capability === 'crm.configure')) && (
            <button type="button" onClick={() => void installCrmPack()} disabled={installingPack} className="crm-btn-primary">
              {installingPack ? 'Installing TCG pack…' : 'Install TCG pack'}
            </button>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-hidden px-3 py-4 sm:px-6 sm:py-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-[var(--crm-text-muted)]">Intake</p>
            <h1 className="mt-0.5 text-xl font-semibold leading-tight">Applications & website enquiries</h1>
          </div>

          <div role="tablist" aria-label="Applications sections" className="flex items-center gap-1 rounded-lg border border-[var(--crm-border)] bg-[var(--crm-surface)] p-1">
            <button
              type="button"
              role="tab"
              aria-selected={subTab === 'applications'}
              onClick={() => setSubTab('applications')}
              className={`min-h-10 rounded-md px-3 py-1.5 text-xs font-semibold ${
                subTab === 'applications'
                  ? 'bg-[var(--crm-primary)] text-[var(--crm-primary-contrast)]'
                  : 'text-[var(--crm-text-muted)] hover:bg-[var(--crm-surface-2)]'
              }`}
            >
              Applications ({allApps.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={subTab === 'enquiries'}
              onClick={() => setSubTab('enquiries')}
              className={`min-h-10 rounded-md px-3 py-1.5 text-xs font-semibold ${
                subTab === 'enquiries'
                  ? 'bg-[var(--crm-primary)] text-[var(--crm-primary-contrast)]'
                  : 'text-[var(--crm-text-muted)] hover:bg-[var(--crm-surface-2)]'
              }`}
            >
              Website enquiries ({enquiries.length})
            </button>
          </div>
        </header>

        {programmeFilter && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--crm-border)] bg-[var(--crm-surface)] px-3 py-2 text-xs">
            <span>
              Filtered to programme: <strong>{CRM_PROGRAMME_BY_SLUG.get(programmeFilter)?.name ?? programmeFilter}</strong>
            </span>
            <button
              type="button"
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.delete('programme');
                setSearchParams(next, { replace: true });
              }}
              className="crm-btn-secondary !min-h-8 !px-2.5 !py-1 !text-xs"
            >
              Clear filter
            </button>
          </div>
        )}

        {actionError && (
          <div role="alert" className="rounded-lg border px-3 py-2 text-xs" style={{ backgroundColor: 'var(--crm-err-bg)', color: 'var(--crm-err-text)', borderColor: 'var(--crm-err-border)' }}>
            {actionError}
          </div>
        )}

        {subTab === 'applications' ? (
          applicationsDb ? (
            <CrmGrid
              board={applicationsDb}
              records={allApps}
              projectionColumns={APP_PROJECTION_COLS}
              selectedRecordId={selectedRecord?.id ?? null}
              onSelectRecord={(id) => navigate(`/crm/applications/${id}`)}
              defaultGroupBy="status"
              emptyTitle="No applications yet"
              emptyBody="Create an application directly from the Website enquiries tab or add one inline."
            />
          ) : (
            <p className="text-xs text-[var(--crm-text-muted)]">Applications board unavailable.</p>
          )
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto space-y-2.5">
            {enquiries.length === 0 ? (
              <div className="crm-panel p-6 text-center text-sm text-[var(--crm-text-muted)]">
                No website inbox submissions yet.
              </div>
            ) : (
              enquiries.map((sub) => {
                const family = String(sub[`p_${WI_FIELD.family}`] ?? '');
                const email = String(sub[`p_${WI_FIELD.email}`] ?? '');
                const inferred = programmeForWebsiteForm(family);
                const existingAppId = appBySubmissionId.get(sub.id);
                return (
                  <article key={sub.id} className="crm-panel flex flex-wrap items-center justify-between gap-3 p-4">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Globe size={14} aria-hidden="true" className="text-[var(--crm-primary)]" />
                        <h2 className="text-sm font-semibold">{recordTitle(sub)}</h2>
                        {inferred && (
                          <span className="rounded-full bg-[var(--crm-surface-2)] px-2 py-0.5 text-[11px] font-medium">
                            {inferred.name}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-[var(--crm-text-muted)]">
                        {email ? `Email: ${email}` : 'No email'}{family ? ` · Form: ${family}` : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {existingAppId ? (
                        <button
                          type="button"
                          onClick={() => {
                            setSubTab('applications');
                            navigate(`/crm/applications/${existingAppId}`);
                          }}
                          className="crm-btn-secondary !min-h-11 !text-xs"
                        >
                          <FileText size={14} aria-hidden="true" />
                          <span>View application</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={isOffline || busySubId === sub.id}
                          onClick={() => void handleCreateFromSubmission(sub.id, inferred?.slug)}
                          className="crm-btn-primary !min-h-11 !text-xs"
                        >
                          <ArrowRight size={14} aria-hidden="true" />
                          <span>{busySubId === sub.id ? 'Creating…' : 'Create application'}</span>
                        </button>
                      )}
                      {websiteInboxDb && (
                        <Link
                          to={`/boards/${websiteInboxDb.id}/tasks/${sub.id}`}
                          className="crm-btn-secondary !min-h-11 !text-xs"
                        >
                          <ExternalLink size={14} aria-hidden="true" />
                          <span>Open in Workspace</span>
                        </Link>
                      )}
                    </div>
                  </article>
                );
              })
            )}
          </div>
        )}
      </div>

      {selectedRecord && applicationsDb && (
        <RecordPanel
          board={applicationsDb}
          record={selectedRecord}
          entityKind="application"
          onClose={() => navigate('/crm/applications')}
          headerActions={
            <button
              type="button"
              disabled={isOffline || Boolean(selectedRecord[CRM_PROJECTION.convertedRecordId])}
              onClick={() => {
                setConvertTitle(recordTitle(selectedRecord));
                setConvertOpen(true);
              }}
              className="crm-btn-primary !min-h-9 !px-3 !py-1 !text-xs"
            >
              <ArrowRight size={13} aria-hidden="true" />
              <span>
                {selectedRecord[CRM_PROJECTION.convertedRecordId] ? 'Converted' : 'Convert'}
              </span>
            </button>
          }
          extraTabs={[
            {
              id: 'visitors_words',
              label: "Visitor's words",
              render: () => (
                <VisitorsWordsTab
                  submissionId={
                    typeof selectedRecord[CRM_PROJECTION.sourceSubmissionId] === 'string'
                      ? String(selectedRecord[CRM_PROJECTION.sourceSubmissionId])
                      : null
                  }
                />
              ),
            },
            {
              id: 'approval',
              label: 'Approval',
              render: () => (
                <ApplicationApprovalTab
                  applicationId={selectedRecord.id}
                  programmeSlug={
                    typeof selectedRecord[CRM_PROJECTION.programmeSlug] === 'string'
                      ? String(selectedRecord[CRM_PROJECTION.programmeSlug])
                      : null
                  }
                />
              ),
            },
          ]}
        />
      )}

      {convertOpen && selectedRecord && (
        <AdaptiveDialog
          title={`Convert ${recordTitle(selectedRecord)}`}
          onClose={() => {
            if (!convertBusy) setConvertOpen(false);
          }}
          guard={() => !convertBusy}
        >
          <form onSubmit={(e) => void handleConvert(e)} data-app="crm" className="space-y-4 text-sm text-[var(--crm-text)]">
            <p className="text-xs text-[var(--crm-text-muted)]">
              Create a linked Workspace Project, Opportunity, or Event and mark this application converted.
            </p>
            <div>
              <label htmlFor="crm-convert-kind" className="mb-1 block text-xs font-medium text-[var(--crm-text-muted)]">
                Convert to
              </label>
              <select
                id="crm-convert-kind"
                className="crm-select"
                value={convertKind}
                onChange={(e) => setConvertKind(e.target.value as ApplicationConvertTarget)}
              >
                {APPLICATION_CONVERT_TARGETS.map((k) => (
                  <option key={k} value={k}>
                    {k[0].toUpperCase() + k.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="crm-convert-title" className="mb-1 block text-xs font-medium text-[var(--crm-text-muted)]">
                New record title
              </label>
              <input
                id="crm-convert-title"
                type="text"
                className="crm-input"
                value={convertTitle}
                onChange={(e) => setConvertTitle(e.target.value)}
                required
              />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setConvertOpen(false)} className="crm-btn-secondary" disabled={convertBusy}>
                Cancel
              </button>
              <button type="submit" disabled={convertBusy || isOffline || !targetBoardForKind(convertKind)} className="crm-btn-primary">
                {convertBusy ? 'Converting…' : 'Convert application'}
              </button>
            </div>
          </form>
        </AdaptiveDialog>
      )}
    </div>
  );
}
