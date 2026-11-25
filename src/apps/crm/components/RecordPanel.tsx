import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  AlertTriangle,
  Check,
  ExternalLink,
  History,
  Link2,
  Lock,
  Mail,
  Phone,
  Plus,
  RefreshCw,
  ShieldCheck,
  Star,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import {
  CRM_CONSENT_CHANNELS,
  CRM_CONSENT_SCOPES,
  CRM_ENDPOINT_KINDS,
  type CrmConsentChannel,
  type CrmConsentDto,
  type CrmConsentScope,
  type CrmEndpointDto,
  type CrmEndpointKind,
  type PersonDetailResponse,
} from '../../../../shared/crm/identity';
import { isCrmProjectionKey } from '../../../../shared/crm/projection';
import { fieldsOf } from '../../../../shared/fields';
import { link, unlinkEnds, useLinks } from '../../../core/links';
import { useLayoutMode } from '../../../core/mobile';
import { recordNoun, recordTitle, stagesOf } from '../../../core/records';
import { useStore } from '../../../core/store';
import { mutate, onlineStore } from '../../../core/sync/engine';
import { Sheet } from '../../../core/ui';
import { cn } from '../../../core/utils';
import { FieldRow } from '../../../modules/boards/FieldValue';
import { columnIdFor, type BoardRow, type TaskRow } from '../../../modules/boards/api';
import {
  addPersonEndpoint,
  CrmTransportError,
  describeCommandError,
  fetchPersonDetail,
  recordPersonConsent,
  retirePersonEndpoint,
  setPrimaryPersonEndpoint,
} from '../api';
import { useCrmDatabases } from '../hooks/useCrmDatabases';
import { StatusPill } from './StatusPill';

export type PanelTabId = 'overview' | 'endpoints' | 'affiliations' | 'timeline' | string;

export interface RecordPanelExtraTab {
  id: string;
  label: string;
  render: () => React.ReactNode;
}

export interface RecordPanelProps {
  board: BoardRow;
  record: TaskRow;
  onClose: () => void;
  entityKind?: 'person' | 'organisation' | 'application' | 'activity' | 'opportunity';
  extraTabs?: RecordPanelExtraTab[];
  initialTab?: PanelTabId;
  headerActions?: React.ReactNode;
  renderTimeline?: (recordId: string) => React.ReactNode;
}

function EndpointIcon({ kind }: { kind: CrmEndpointKind }) {
  if (kind === 'email') return <Mail size={14} aria-hidden="true" />;
  if (kind === 'phone' || kind === 'whatsapp') return <Phone size={14} aria-hidden="true" />;
  return <Link2 size={14} aria-hidden="true" />;
}

export function RecordPanel({
  board,
  record,
  onClose,
  entityKind = 'person',
  extraTabs = [],
  initialTab = 'overview',
  headerActions,
  renderTimeline,
}: RecordPanelProps) {
  const layout = useLayoutMode();
  const isOffline = !useStore(onlineStore);
  const { peopleDb, orgsDb, affiliationsDb, tasks, links } = useCrmDatabases();
  const linksAll = useLinks();
  const fields = fieldsOf(board);
  const cols = stagesOf(board);
  const noun = recordNoun(board);
  const currentCol = cols.length ? cols.find((c) => c.id === columnIdFor(record, board)) : undefined;

  const [tab, setTab] = useState<PanelTabId>(initialTab);
  const [titleDraft, setTitleDraft] = useState(String(record.title ?? ''));
  useEffect(() => {
    setTitleDraft(String(record.title ?? ''));
  }, [record.id, record.title]);

  // S1 Person Endpoints & Consents state
  const [detail, setDetail] = useState<PersonDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const [epKind, setEpKind] = useState<CrmEndpointKind>('email');
  const [epValue, setEpValue] = useState('');
  const [epPrimary, setEpPrimary] = useState(true);

  const [cChannel, setCChannel] = useState<CrmConsentChannel>('email');
  const [cScope, setCScope] = useState<CrmConsentScope>('transactional');
  const [cStatus, setCStatus] = useState<'granted' | 'withdrawn'>('granted');
  const [cSource, setCSource] = useState('manual');
  const [cEvidence, setCEvidence] = useState('');

  // S1 Affiliations quick-link state
  const [affPeerId, setAffPeerId] = useState('');
  const [affRole, setAffRole] = useState('');

  const loadDetail = useCallback(async () => {
    if (entityKind !== 'person') return;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const res = await fetchPersonDetail(record.id);
      setDetail(res);
    } catch (err) {
      setDetailError(err instanceof CrmTransportError ? err.userMessage : 'Could not load endpoints and consent.');
    } finally {
      setDetailLoading(false);
    }
  }, [entityKind, record.id]);

  useEffect(() => {
    setDetail(null);
    if (entityKind === 'person') {
      void loadDetail();
    }
  }, [entityKind, record.id, loadDetail]);

  const projectionEntries = Object.entries(record)
    .filter(([k, v]) => isCrmProjectionKey(k) && v !== undefined && v !== null && v !== '')
    .sort((a, b) => a[0].localeCompare(b[0]));

  const commitTitle = () => {
    const trimmed = titleDraft.trim();
    if (trimmed !== String(record.title ?? '')) {
      void mutate('tasks', record.id, { title: trimmed || 'Untitled' });
    }
  };

  const handleAddEndpoint = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isOffline || actionBusy || !epValue.trim()) return;
    setActionBusy(true);
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await addPersonEndpoint(
        {
          personId: record.id,
          kind: epKind,
          value: epValue.trim(),
          source: 'manual',
          makePrimary: epPrimary,
        },
        detail ? { expected: { [record.id]: detail.rev } } : undefined,
      );
      if (res.ok) {
        setEpValue('');
        setActionNotice(res.result.already ? 'Endpoint already recorded on this person.' : 'Added endpoint.');
        await loadDetail();
      } else {
        setActionError(describeCommandError(res));
        if (res.error === 'stale') await loadDetail();
      }
    } catch (err) {
      setActionError(describeCommandError(err));
    } finally {
      setActionBusy(false);
    }
  };

  const handleSetPrimary = async (ep: CrmEndpointDto) => {
    if (isOffline || actionBusy || ep.isPrimary || ep.retiredAt !== null) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const res = await setPrimaryPersonEndpoint(
        { endpointId: ep.id },
        detail ? { expected: { [record.id]: detail.rev } } : undefined,
      );
      if (res.ok) {
        setActionNotice(`Set ${ep.valueRaw} as primary ${ep.kind}.`);
        await loadDetail();
      } else {
        setActionError(describeCommandError(res));
      }
    } catch (err) {
      setActionError(describeCommandError(err));
    } finally {
      setActionBusy(false);
    }
  };

  const handleRetire = async (ep: CrmEndpointDto) => {
    if (isOffline || actionBusy || ep.retiredAt !== null) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const res = await retirePersonEndpoint(
        { endpointId: ep.id },
        detail ? { expected: { [record.id]: detail.rev } } : undefined,
      );
      if (res.ok) {
        setActionNotice(`Retired ${ep.valueRaw}.`);
        await loadDetail();
      } else {
        setActionError(describeCommandError(res));
      }
    } catch (err) {
      setActionError(describeCommandError(err));
    } finally {
      setActionBusy(false);
    }
  };

  const handleRecordConsent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isOffline || actionBusy || !cSource.trim()) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const res = await recordPersonConsent(
        {
          personId: record.id,
          channel: cChannel,
          scope: cScope,
          status: cStatus,
          source: cSource.trim(),
          ...(cEvidence.trim() ? { evidenceRef: cEvidence.trim() } : {}),
        },
        detail ? { expected: { [record.id]: detail.rev } } : undefined,
      );
      if (res.ok) {
        setCEvidence('');
        setActionNotice(`Recorded ${cChannel} (${cScope}): ${cStatus}.`);
        await loadDetail();
      } else {
        setActionError(describeCommandError(res));
      }
    } catch (err) {
      setActionError(describeCommandError(err));
    } finally {
      setActionBusy(false);
    }
  };

  // Affiliations resolution (legacy Works at + Affiliations records if present)
  const peerOptions = entityKind === 'person'
    ? tasks.filter((t) => !t.deleted && orgsDb && t.boardId === orgsDb.id)
    : tasks.filter((t) => !t.deleted && peopleDb && t.boardId === peopleDb.id);

  const directWorksIds = useMemo(() => {
    const fWorks = fields.find((f) => f.id === 'f_works' || f.id === 'f_people');
    if (!fWorks || fWorks.type !== 'relation') return [];
    const primary = fWorks.relation?.primary === true;
    return linksAll
      .filter((l) => !l.deleted && l.kind === 'relation' && l.fieldId === fWorks.id && (primary ? l.fromId === record.id : l.toId === record.id))
      .map((l) => String(primary ? l.toId : l.fromId));
  }, [fields, linksAll, record.id]);

  const addQuickAffiliation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!affPeerId) return;
    if (affificationsAvailable()) {
      // Create an affiliation record when db_affiliations is installed
      const affId = crypto.randomUUID();
      const affBoardId = affiliationsDb!.id;
      const personId = entityKind === 'person' ? record.id : affPeerId;
      const orgId = entityKind === 'person' ? affPeerId : record.id;
      const pName = recordTitle(tasks.find((t) => t.id === personId));
      const oName = recordTitle(tasks.find((t) => t.id === orgId));
      await mutate('tasks', affId, {
        boardId: affBoardId,
        title: `${pName} — ${oName}`,
        status: 'active',
        p_f_role: affRole.trim() || null,
        createdAt: Date.now(),
      });
      await link({ type: 'record', id: affId }, { type: 'record', id: personId }, 'relation', 'f_person');
      await link({ type: 'record', id: affId }, { type: 'record', id: orgId }, 'relation', 'f_org');
    } else if (entityKind === 'person') {
      await link({ type: 'record', id: record.id }, { type: 'record', id: affPeerId }, 'relation', 'f_works');
    }
    setAffPeerId('');
    setAffRole('');
    setActionNotice('Linked affiliation.');
  };

  function affificationsAvailable() {
    return Boolean(affiliationsDb && peopleDb && orgsDb);
  }

  const tabs: { id: PanelTabId; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    ...extraTabs.map((t) => ({ id: t.id, label: t.label })),
    ...(entityKind === 'person' ? [{ id: 'endpoints', label: 'Endpoints & Consent' }] : []),
    ...(entityKind === 'person' || entityKind === 'organisation' ? [{ id: 'affiliations', label: 'Affiliations' }] : []),
    { id: 'timeline', label: 'Timeline' },
  ];

  const activeExtra = extraTabs.find((t) => t.id === tab);

  const content = (
    <div className="flex h-full min-h-0 flex-col bg-[var(--crm-surface)] text-[var(--crm-text)]">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-[var(--crm-border)] px-4 py-3.5">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--crm-text-muted)]">
            <span>{noun}</span>
            {currentCol && <StatusPill label={currentCol.name} color={currentCol.color} />}
          </div>
          <input
            type="text"
            aria-label={`${noun} name`}
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            className="w-full min-w-0 rounded border border-transparent bg-transparent px-1 py-0.5 text-lg font-semibold leading-snug focus:border-[var(--crm-border)] focus:bg-[var(--crm-bg)] focus:outline-none"
          />
          {entityKind === 'person' && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--crm-text-muted)]">
              {typeof record._crm_primary_email === 'string' && record._crm_primary_email && (
                <span className="inline-flex items-center gap-1">
                  <Mail size={12} aria-hidden="true" />
                  <span>{record._crm_primary_email}</span>
                </span>
              )}
              {typeof record._crm_primary_phone === 'string' && record._crm_primary_phone && (
                <span className="inline-flex items-center gap-1">
                  <Phone size={12} aria-hidden="true" />
                  <span>{record._crm_primary_phone}</span>
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {headerActions}
          <Link
            to={`/boards/${board.id}/tasks/${record.id}`}
            className="crm-btn-secondary !min-h-10 !px-2.5 !py-1 !text-xs"
            title="Open full record in Workspace"
          >
            <ExternalLink size={13} aria-hidden="true" />
            <span className="max-sm:sr-only">Workspace</span>
          </Link>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close record panel"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-[var(--crm-text-muted)] hover:bg-[var(--crm-surface-2)] hover:text-[var(--crm-text)]"
          >
            <X size={17} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Stage switcher bar when stages exist */}
      {cols.length > 0 && (
        <div className="flex items-center justify-between gap-2 border-b border-[var(--crm-border)] bg-[var(--crm-bg)] px-4 py-2 text-xs">
          <label htmlFor={`panel-stage-${record.id}`} className="font-medium text-[var(--crm-text-muted)]">
            Stage
          </label>
          <select
            id={`panel-stage-${record.id}`}
            aria-label="Stage"
            className="crm-select !min-h-9 !w-auto !py-1 !text-xs"
            value={columnIdFor(record, board)}
            onChange={(e) => void mutate('tasks', record.id, { status: e.target.value })}
          >
            {cols.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Segmented tabs */}
      <div
        role="tablist"
        aria-label="Record sections"
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--crm-border)] px-3 py-2"
      >
        {tabs.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.id)}
              className={cn(
                'inline-flex min-h-10 shrink-0 items-center rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
                active
                  ? 'bg-[var(--crm-primary)] text-[var(--crm-primary-contrast)]'
                  : 'text-[var(--crm-text-muted)] hover:bg-[var(--crm-surface-2)] hover:text-[var(--crm-text)]',
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-4">
        {actionError && (
          <div
            role="alert"
            className="rounded-lg border px-3 py-2 text-xs"
            style={{
              backgroundColor: 'var(--crm-err-bg)',
              color: 'var(--crm-err-text)',
              borderColor: 'var(--crm-err-border)',
            }}
          >
            {actionError}
          </div>
        )}
        {actionNotice && (
          <div
            role="status"
            className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs"
            style={{
              backgroundColor: 'var(--crm-ok-bg)',
              color: 'var(--crm-ok-text)',
              borderColor: 'var(--crm-ok-border)',
            }}
          >
            <span>{actionNotice}</span>
            <button type="button" onClick={() => setActionNotice(null)} className="underline">
              Dismiss
            </button>
          </div>
        )}

        {activeExtra ? (
          activeExtra.render()
        ) : tab === 'overview' ? (
          <div className="space-y-4">
            {projectionEntries.length > 0 && (
              <section className="rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-3 space-y-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--crm-text-muted)]">
                  <Lock size={12} aria-hidden="true" />
                  <span>CRM projections (server-owned)</span>
                </div>
                <dl className="grid grid-cols-1 gap-1.5 text-xs sm:grid-cols-2">
                  {projectionEntries.map(([k, v]) => (
                    <div key={k} className="flex flex-col">
                      <dt className="text-[11px] text-[var(--crm-text-muted)]">{k.replace(/^_crm_/, '').replace(/_/g, ' ')}</dt>
                      <dd className="font-medium break-words">
                        {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            <section className="space-y-2.5">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--crm-text-muted)]">
                Fields
              </h3>
              <p className="text-[11px] text-[var(--crm-text-muted)]">
                Relationship fields sync to all signed-in accounts. Record health, screening or payment evidence in protected sections.
              </p>
              <div className="grid grid-cols-[120px_1fr] items-center gap-x-3 gap-y-2.5 text-sm">
                {fields.map((f) => (
                  <FieldRow key={f.id} field={f} task={record} />
                ))}
              </div>
            </section>
          </div>
        ) : tab === 'endpoints' && entityKind === 'person' ? (
          <div className="space-y-5">
            {detailLoading && !detail ? (
              <div className="space-y-2" aria-busy="true">
                <div className="crm-skeleton h-10 w-full" />
                <div className="crm-skeleton h-20 w-full" />
              </div>
            ) : detailError ? (
              <div className="space-y-2 rounded-lg border border-[var(--crm-border)] p-3 text-xs">
                <p>{detailError}</p>
                <button type="button" onClick={() => void loadDetail()} className="crm-btn-secondary !min-h-9 !text-xs">
                  <RefreshCw size={13} aria-hidden="true" />
                  <span>Retry</span>
                </button>
              </div>
            ) : (
              <>
                {detail && detail.duplicateCandidates.length > 0 && (
                  <div
                    role="status"
                    className="rounded-lg border p-3 text-xs"
                    style={{
                      backgroundColor: 'var(--crm-warn-bg)',
                      color: 'var(--crm-warn-text)',
                      borderColor: 'var(--crm-warn-border)',
                    }}
                  >
                    <p className="font-semibold">Possible duplicate flagged ({detail.duplicateCandidates.length})</p>
                    {detail.duplicateCandidates.map((d) => (
                      <p key={d.id} className="mt-1">
                        {d.reason} — review under People → Duplicates.
                      </p>
                    ))}
                  </div>
                )}

                <section className="space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--crm-text-muted)]">
                    Contact endpoints
                  </h3>
                  <ul className="space-y-2">
                    {(detail?.endpoints ?? []).map((ep) => {
                      const retired = ep.retiredAt !== null;
                      return (
                        <li
                          key={ep.id}
                          className={cn(
                            'flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--crm-border)] p-2.5 text-xs',
                            retired && 'opacity-60',
                          )}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <EndpointIcon kind={ep.kind} />
                              <span className="font-semibold break-all">{ep.valueRaw}</span>
                              {ep.isPrimary && !retired && (
                                <span
                                  className="inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                                  style={{ backgroundColor: 'var(--crm-primary-soft)', color: 'var(--crm-primary)' }}
                                >
                                  <Star size={10} aria-hidden="true" />
                                  Primary
                                </span>
                              )}
                              {retired && (
                                <span className="rounded-full border border-[var(--crm-border)] px-2 py-0.5 text-[10px]">
                                  Retired
                                </span>
                              )}
                            </div>
                            <p className="mt-0.5 text-[11px] text-[var(--crm-text-muted)]">
                              {ep.kind} · normalized: {ep.valueNorm} · source: {ep.source}
                            </p>
                          </div>

                          {!retired && (
                            <div className="flex items-center gap-1.5">
                              {!ep.isPrimary && (
                                <button
                                  type="button"
                                  disabled={isOffline || actionBusy}
                                  onClick={() => void handleSetPrimary(ep)}
                                  className="crm-btn-secondary !min-h-9 !px-2.5 !py-1 !text-xs"
                                >
                                  Set primary
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={isOffline || actionBusy}
                                onClick={() => void handleRetire(ep)}
                                aria-label={`Retire ${ep.valueRaw}`}
                                className="crm-btn-danger !min-h-9 !px-2.5 !py-1 !text-xs"
                              >
                                <Trash2 size={13} aria-hidden="true" />
                                <span>Retire</span>
                              </button>
                            </div>
                          )}
                        </li>
                      );
                    })}
                    {(detail?.endpoints.length ?? 0) === 0 && (
                      <li className="text-xs text-[var(--crm-text-muted)]">No endpoints registered yet.</li>
                    )}
                  </ul>

                  <form onSubmit={(e) => void handleAddEndpoint(e)} className="space-y-2 rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-3">
                    <p className="text-xs font-semibold">Add endpoint</p>
                    <div className="grid gap-2 sm:grid-cols-[120px_1fr]">
                      <select
                        aria-label="Endpoint kind"
                        className="crm-select !min-h-10 !text-xs"
                        value={epKind}
                        onChange={(e) => setEpKind(e.target.value as CrmEndpointKind)}
                      >
                        {CRM_ENDPOINT_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {k}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        aria-label="Endpoint value"
                        className="crm-input !min-h-10 !text-xs"
                        placeholder={epKind === 'email' ? 'name@example.org' : epKind === 'whatsapp' || epKind === 'phone' ? '+91 98xxxxxx12' : '@handle'}
                        value={epValue}
                        onChange={(e) => setEpValue(e.target.value)}
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label className="inline-flex items-center gap-1.5 text-xs">
                        <input type="checkbox" checked={epPrimary} onChange={(e) => setEpPrimary(e.target.checked)} />
                        <span>Make primary for {epKind}</span>
                      </label>
                      <button
                        type="submit"
                        disabled={isOffline || actionBusy || !epValue.trim()}
                        className="crm-btn-primary !min-h-10 !px-3 !text-xs"
                      >
                        <Plus size={14} aria-hidden="true" />
                        <span>Add endpoint</span>
                      </button>
                    </div>
                  </form>
                </section>

                <section className="space-y-3 border-t border-[var(--crm-border)] pt-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--crm-text-muted)]">
                    Consent ledger (append-only)
                  </h3>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(detail?.latestConsents ?? []).map((c: CrmConsentDto) => (
                      <div key={c.id} className="rounded-lg border border-[var(--crm-border)] p-2.5 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold">
                            {c.channel} · {c.scope}
                          </span>
                          <span
                            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                            style={{
                              backgroundColor: c.status === 'granted' ? 'var(--crm-ok-bg)' : 'var(--crm-err-bg)',
                              color: c.status === 'granted' ? 'var(--crm-ok-text)' : 'var(--crm-err-text)',
                            }}
                          >
                            {c.status === 'granted' ? <Check size={11} aria-hidden="true" /> : <AlertTriangle size={11} aria-hidden="true" />}
                            <span>{c.status}</span>
                          </span>
                        </div>
                        <p className="mt-1 text-[11px] text-[var(--crm-text-muted)]">
                          Source: {c.source}{c.evidenceRef ? ` · ${c.evidenceRef}` : ''}
                        </p>
                      </div>
                    ))}
                  </div>

                  <form onSubmit={(e) => void handleRecordConsent(e)} className="space-y-2 rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-3">
                    <p className="text-xs font-semibold flex items-center gap-1.5">
                      <ShieldCheck size={14} aria-hidden="true" />
                      <span>Record consent change</span>
                    </p>
                    <div className="grid gap-2 sm:grid-cols-3">
                      <select
                        aria-label="Consent channel"
                        className="crm-select !min-h-10 !text-xs"
                        value={cChannel}
                        onChange={(e) => setCChannel(e.target.value as CrmConsentChannel)}
                      >
                        {CRM_CONSENT_CHANNELS.map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                      <select
                        aria-label="Consent scope"
                        className="crm-select !min-h-10 !text-xs"
                        value={cScope}
                        onChange={(e) => setCScope(e.target.value as CrmConsentScope)}
                      >
                        {CRM_CONSENT_SCOPES.map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                      <select
                        aria-label="Consent status"
                        className="crm-select !min-h-10 !text-xs"
                        value={cStatus}
                        onChange={(e) => setCStatus(e.target.value as 'granted' | 'withdrawn')}
                      >
                        <option value="granted">granted</option>
                        <option value="withdrawn">withdrawn</option>
                      </select>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <input
                        type="text"
                        aria-label="Consent source"
                        placeholder="Source (e.g. website_form, whatsapp_optout)"
                        className="crm-input !min-h-10 !text-xs"
                        value={cSource}
                        onChange={(e) => setCSource(e.target.value)}
                      />
                      <input
                        type="text"
                        aria-label="Consent evidence reference"
                        placeholder="Evidence ref (optional)"
                        className="crm-input !min-h-10 !text-xs"
                        value={cEvidence}
                        onChange={(e) => setCEvidence(e.target.value)}
                      />
                    </div>
                    <div className="flex justify-end">
                      <button
                        type="submit"
                        disabled={isOffline || actionBusy || !cSource.trim()}
                        className="crm-btn-primary !min-h-10 !px-3 !text-xs"
                      >
                        Record consent
                      </button>
                    </div>
                  </form>
                </section>
              </>
            )}
          </div>
        ) : tab === 'affiliations' ? (
          <div className="space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--crm-text-muted)] flex items-center gap-1.5">
              <Users size={13} aria-hidden="true" />
              <span>{entityKind === 'person' ? 'Organisations' : 'Affiliated people'}</span>
            </h3>
            <ul className="space-y-2">
              {directWorksIds.map((pid) => {
                const peer = tasks.find((t) => t.id === pid);
                return (
                  <li key={pid} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--crm-border)] p-2.5 text-xs">
                    <span className="font-semibold">{recordTitle(peer)}</span>
                    {entityKind === 'person' && (
                      <button
                        type="button"
                        onClick={() => void unlinkEnds(record.id, pid, 'relation', 'f_works')}
                        className="crm-btn-secondary !min-h-8 !px-2 !py-1 !text-xs"
                      >
                        Remove
                      </button>
                    )}
                  </li>
                );
              })}
              {links
                .filter(
                  (l) =>
                    !l.deleted &&
                    l.kind === 'relation' &&
                    ((entityKind === 'person' && l.fieldId === 'f_person' && l.toId === record.id) ||
                      (entityKind === 'organisation' && l.fieldId === 'f_org' && l.toId === record.id)),
                )
                .map((affLink) => {
                  const affRec = tasks.find((t) => t.id === affLink.fromId);
                  if (!affRec || affRec.deleted) return null;
                  return (
                    <li key={affRec.id} className="rounded-lg border border-[var(--crm-border)] p-2.5 text-xs">
                      <p className="font-semibold">{recordTitle(affRec)}</p>
                      {typeof affRec.p_f_role === 'string' && affRec.p_f_role && (
                        <p className="text-[var(--crm-text-muted)]">Role: {affRec.p_f_role}</p>
                      )}
                    </li>
                  );
                })}
            </ul>

            <form onSubmit={(e) => void addQuickAffiliation(e)} className="space-y-2 rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-3">
              <p className="text-xs font-semibold">Link {entityKind === 'person' ? 'organisation' : 'person'}</p>
              <select
                aria-label={entityKind === 'person' ? 'Select organisation' : 'Select person'}
                className="crm-select !min-h-10 !text-xs"
                value={affPeerId}
                onChange={(e) => setAffPeerId(e.target.value)}
              >
                <option value="">Choose…</option>
                {peerOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {recordTitle(p)}
                  </option>
                ))}
              </select>
              {affificationsAvailable() && (
                <input
                  type="text"
                  aria-label="Affiliation role"
                  placeholder="Role (e.g. Coordinator, Founder)"
                  className="crm-input !min-h-10 !text-xs"
                  value={affRole}
                  onChange={(e) => setAffRole(e.target.value)}
                />
              )}
              <button type="submit" disabled={!affPeerId} className="crm-btn-secondary !min-h-10 !text-xs">
                <Plus size={14} aria-hidden="true" />
                <span>Add affiliation</span>
              </button>
            </form>
          </div>
        ) : (
          renderTimeline ? (
            renderTimeline(record.id)
          ) : (
            <div className="space-y-2 rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-4 text-xs text-[var(--crm-text-muted)]">
              <div className="flex items-center gap-2 font-semibold text-[var(--crm-text)]">
                <History size={14} aria-hidden="true" />
                <span>Relationship timeline</span>
              </div>
              <p>
                Created {record.createdAt ? new Date(Number(record.createdAt)).toLocaleDateString() : 'recently'}.
                Unified cross-channel timeline activates in full once Programmes, Enquiries, Activities and Conversations connect.
              </p>
            </div>
          )
        )}
      </div>
    </div>
  );

  if (layout === 'expanded') {
    return (
      <aside
        aria-label={`${noun} details`}
        className="w-[440px] shrink-0 border-l border-[var(--crm-border)] bg-[var(--crm-surface)]"
      >
        {content}
      </aside>
    );
  }

  return (
    <Sheet onClose={onClose} label={`${noun}: ${recordTitle(record)}`}>
      {content}
    </Sheet>
  );
}
