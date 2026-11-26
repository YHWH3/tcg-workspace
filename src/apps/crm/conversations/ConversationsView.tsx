import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  Bot,
  CheckCircle2,
  Clock,
  Lock,
  MessageSquare,
  Plus,
  Radio,
  RefreshCw,
  Send,
  ShieldAlert,
  Sparkles,
  StickyNote,
  UserCheck,
} from 'lucide-react';
import { CRM_CHANNELS, type CrmChannel } from '../../../../shared/crm/capabilities';
import type { CrmStatus } from '../../../../shared/crm/contracts';
import {
  CONVERSATION_CHANNELS,
  CONVERSATION_FILTERS,
  CONVERSATION_STATES,
  type ConversationChannel,
  type ConversationDetailResponse,
  type ConversationFilter,
  type ConversationState,
  type ConversationsPageResponse,
  type CrmFactDto,
} from '../../../../shared/crm/conversations';
import { CRM_PROGRAMMES } from '../../../../shared/crm/programmes';
import { useLayoutMode } from '../../../core/mobile';
import { recordTitle } from '../../../core/records';
import { useStore } from '../../../core/store';
import { onlineStore } from '../../../core/sync/engine';
import { AdaptiveDialog, Sheet } from '../../../core/ui';
import { useUsers } from '../../../core/users';
import {
  addConversationNote,
  assignConversation,
  describeCommandError,
  fetchConversationDetail,
  fetchConversations,
  generateAiConversationDraft,
  generateCrmRequestId,
  linkConversationPerson,
  logManualConversation,
  resolveMessageReview,
  retryConversationMessage,
  saveConversationDraft,
  sendConversationMessage,
  setConversationState,
  simulateInboundConversation,
} from '../api';
import { useCrmDatabases } from '../hooks/useCrmDatabases';

export function ConversationsView(_props: { status: CrmStatus }) {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const layout = useLayoutMode();
  const isOffline = !useStore(onlineStore);
  const users = useUsers();
  const { peopleDb, tasks } = useCrmDatabases();
  const people = tasks.filter((t) => !t.deleted && peopleDb && t.boardId === peopleDb.id && !t.parentId);

  const [filter, setFilter] = useState<ConversationFilter>('all');
  const [channelFilter, setChannelFilter] = useState<string>('');
  const [listData, setListData] = useState<ConversationsPageResponse | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [detail, setDetail] = useState<ConversationDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Composer state
  const [composerMode, setComposerMode] = useState<'reply' | 'note'>('reply');
  const [draftText, setDraftText] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [editingDraftId, setEditingDraftId] = useState<string | undefined>(undefined);
  const [aiMetaPreview, setAiMetaPreview] = useState<{
    citedFactIds: string[];
    unconfirmedItems: string[];
    staleFactWarnings: string[];
  } | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);

  // Manual log & simulate inbound dialogs
  const [logOpen, setLogOpen] = useState(false);
  const [logChannel, setLogChannel] = useState<ConversationChannel>('call');
  const [logPersonId, setLogPersonId] = useState('');
  const [logSubject, setLogSubject] = useState('');
  const [logBody, setLogBody] = useState('');

  const [simOpen, setSimOpen] = useState(false);
  const [simChannel, setSimChannel] = useState<CrmChannel>('whatsapp');
  const [simFrom, setSimFrom] = useState('');
  const [simProg, setSimProg] = useState('');
  const [simBody, setSimBody] = useState('');

  const [linkPersonId, setLinkPersonId] = useState('');

  const loadList = useCallback(async () => {
    if (isOffline) return;
    setListLoading(true);
    try {
      const res = await fetchConversations({ filter, channel: channelFilter || undefined });
      setListData(res);
    } catch (err) {
      setError(describeCommandError(err));
    } finally {
      setListLoading(false);
    }
  }, [isOffline, filter, channelFilter]);

  const loadDetail = useCallback(async () => {
    if (!conversationId || isOffline) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    try {
      const res = await fetchConversationDetail(conversationId);
      setDetail(res);
      setLinkPersonId(res.conversation.personId ?? '');
      const lastDraft = [...res.messages].reverse().find((m) => m.status === 'draft');
      if (lastDraft) {
        setDraftText(lastDraft.bodyText);
        setEditingDraftId(lastDraft.id);
        setAiMetaPreview(lastDraft.aiMetadata);
      } else {
        setEditingDraftId(undefined);
        setAiMetaPreview(null);
      }
    } catch (err) {
      setError(describeCommandError(err));
    } finally {
      setDetailLoading(false);
    }
  }, [conversationId, isOffline]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const handleSendOrNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail || !draftText.trim() || busyAction || isOffline) return;
    setBusyAction(true);
    setError(null);
    setNotice(null);
    try {
      if (composerMode === 'note') {
        const res = await addConversationNote(
          { conversationId: detail.conversation.id, bodyText: draftText.trim() },
          { requestId: generateCrmRequestId() },
        );
        if (res.ok) {
          setDraftText('');
          setEditingDraftId(undefined);
          setAiMetaPreview(null);
          setNotice('Internal team note saved (never sent).');
          await Promise.all([loadDetail(), loadList()]);
        } else {
          setError(describeCommandError(res));
        }
      } else {
        const res = await sendConversationMessage(
          {
            conversationId: detail.conversation.id,
            messageId: editingDraftId,
            bodyText: draftText.trim(),
            ...(selectedTemplateId ? { templateId: selectedTemplateId } : {}),
            ...(detail.conversation.humanAgentEligible ? { useHumanAgentTag: true } : {}),
          },
          { requestId: generateCrmRequestId() },
        );
        if (res.ok) {
          setDraftText('');
          setSelectedTemplateId('');
          setEditingDraftId(undefined);
          setAiMetaPreview(null);
          setNotice(
            res.result.message.status === 'review_required'
              ? 'Provider outcome was ambiguous — moved to human review before any retry.'
              : res.result.message.status === 'queued'
                ? 'Queued for outbox delivery.'
                : `Sent (${res.result.receiptId}).`,
          );
          await Promise.all([loadDetail(), loadList()]);
        } else {
          setError(describeCommandError(res));
        }
      }
    } catch (err) {
      setError(describeCommandError(err));
    } finally {
      setBusyAction(false);
    }
  };

  const handleSaveDraft = async () => {
    if (!detail || !draftText.trim() || busyAction || isOffline) return;
    setBusyAction(true);
    setError(null);
    try {
      const res = await saveConversationDraft(
        { conversationId: detail.conversation.id, messageId: editingDraftId, bodyText: draftText.trim() },
        { requestId: generateCrmRequestId() },
      );
      if (res.ok) {
        setEditingDraftId(res.result.message.id);
        setNotice('Saved draft for review.');
        await loadDetail();
      } else {
        setError(describeCommandError(res));
      }
    } finally {
      setBusyAction(false);
    }
  };

  const handleGenerateAiDraft = async () => {
    if (!detail || busyAction || isOffline) return;
    setBusyAction(true);
    setError(null);
    setComposerMode('reply');
    try {
      const res = await generateAiConversationDraft(
        { conversationId: detail.conversation.id },
        { requestId: generateCrmRequestId() },
      );
      if (res.ok) {
        setDraftText(res.result.message.bodyText);
        setEditingDraftId(res.result.message.id);
        setAiMetaPreview({
          citedFactIds: res.result.citedFactIds,
          unconfirmedItems: res.result.unconfirmedItems,
          staleFactWarnings: res.result.staleFactWarnings,
        });
        setNotice(`Generated grounded draft citing ${res.result.citedFactIds.length} verified fact(s). Review before sending.`);
        await loadDetail();
      } else {
        setError(describeCommandError(res));
      }
    } finally {
      setBusyAction(false);
    }
  };

  const handleLogManual = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isOffline || busyAction || !logSubject.trim() || !logBody.trim()) return;
    setBusyAction(true);
    setError(null);
    try {
      const res = await logManualConversation(
        {
          channel: logChannel,
          personId: logPersonId || null,
          subject: logSubject.trim(),
          direction: 'inbound',
          bodyText: logBody.trim(),
        },
        { requestId: generateCrmRequestId() },
      );
      if (res.ok) {
        setLogOpen(false);
        setLogSubject('');
        setLogBody('');
        await loadList();
        navigate(`/crm/conversations/${res.result.conversation.id}`);
      } else {
        setError(describeCommandError(res));
      }
    } finally {
      setBusyAction(false);
    }
  };

  const handleSimulateInbound = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isOffline || busyAction || !simFrom.trim() || !simBody.trim()) return;
    setBusyAction(true);
    setError(null);
    try {
      const res = await simulateInboundConversation(
        {
          channel: simChannel,
          externalEventId: `sim_ev_${Date.now()}`,
          fromValue: simFrom.trim(),
          programmeSlug: simProg || null,
          bodyText: simBody.trim(),
        },
        { requestId: generateCrmRequestId() },
      );
      if (res.ok) {
        setSimOpen(false);
        setSimFrom('');
        setSimBody('');
        await loadList();
        navigate(`/crm/conversations/${res.result.conversationId}`);
      } else {
        setError(describeCommandError(res));
      }
    } finally {
      setBusyAction(false);
    }
  };

  const isCompact = layout === 'compact';
  const showListPane = !isCompact || !conversationId;
  const showThreadPane = !isCompact || Boolean(conversationId);

  const contextBody = detail ? (
    <div className="space-y-4 p-4 text-xs">
      <div className="space-y-2 rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-3">
        <p className="font-semibold">Person link</p>
        {detail.conversation.personName ? (
          <Link to={`/crm/people/${detail.conversation.personId}`} className="inline-flex items-center gap-1.5 font-semibold text-[var(--crm-primary)] hover:underline">
            <UserCheck size={13} aria-hidden="true" />
            <span>{detail.conversation.personName}</span>
          </Link>
        ) : (
          <p className="text-[var(--crm-warn-text)]">Unmatched sender — link to a canonical Person record below.</p>
        )}
        <div className="flex items-center gap-2 pt-1">
          <select
            aria-label="Link person"
            className="crm-select !min-h-9 !text-xs flex-1"
            value={linkPersonId}
            onChange={(e) => setLinkPersonId(e.target.value)}
          >
            <option value="">Choose person…</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {recordTitle(p)}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!linkPersonId || isOffline || busyAction}
            onClick={() =>
              void linkConversationPerson(
                { conversationId: detail.conversation.id, personId: linkPersonId, expectedRev: detail.conversation.rev },
                { requestId: generateCrmRequestId() },
              ).then(() => Promise.all([loadDetail(), loadList()]))
            }
            className="crm-btn-secondary !min-h-9 !px-2.5 !py-1 !text-xs"
          >
            Link
          </button>
        </div>
      </div>

      <div className="space-y-2 rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-3">
        <p className="font-semibold">Channel & consent status</p>
        <p>
          Consent: <strong className="capitalize">{detail.consentStatus}</strong>
        </p>
        <p>
          Messaging window:{' '}
          <strong className={detail.conversation.windowOpen ? 'text-[var(--crm-ok-text)]' : 'text-[var(--crm-err-text)]'}>
            {detail.conversation.windowOpen ? 'Open' : 'Closed (24h window expired)'}
          </strong>
        </p>
        {detail.personEndpoints.length > 0 && (
          <ul className="space-y-1 pt-1">
            {detail.personEndpoints.map((ep) => (
              <li key={ep.id} className="font-mono text-[11px] text-[var(--crm-text-muted)]">
                {ep.kind}: {ep.valueNorm}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2 rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="font-semibold">Verified facts ({detail.verifiedFacts.length})</p>
          <Link to="/crm/settings/facts" className="text-[var(--crm-primary)] hover:underline">
            Manage
          </Link>
        </div>
        {detail.staleFacts.length > 0 && (
          <p className="rounded border border-[var(--crm-warn-border)] bg-[var(--crm-warn-bg)] px-2 py-1.5 text-[11px] text-[var(--crm-warn-text)]">
            {detail.staleFacts.length} stale fact(s) excluded from AI drafts.
          </p>
        )}
        {detail.verifiedFacts.length === 0 ? (
          <p className="text-[var(--crm-text-muted)]">No verified facts for this scope yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {detail.verifiedFacts.slice(0, 5).map((f: CrmFactDto) => (
              <li key={f.id} className="rounded border border-[var(--crm-border)] bg-[var(--crm-surface)] p-2">
                <p className="font-semibold">{f.title}</p>
                <p className="mt-0.5 text-[var(--crm-text-muted)]">{f.statement}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      {showListPane && (
        <aside className="flex w-full shrink-0 flex-col border-r border-[var(--crm-border)] bg-[var(--crm-surface)] md:w-[310px]">
          <div className="space-y-2.5 border-b border-[var(--crm-border)] p-3">
            <div className="flex items-center justify-between gap-2">
              <h1 className="text-base font-semibold">Conversations</h1>
              <div className="flex items-center gap-1">
                {listData?.simulatedMode && (
                  <button
                    type="button"
                    onClick={() => setSimOpen(true)}
                    disabled={isOffline}
                    className="crm-btn-secondary !min-h-9 !px-2 !py-1 !text-xs"
                  >
                    Simulate
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setLogOpen(true)}
                  disabled={isOffline}
                  className="crm-btn-primary !min-h-9 !px-2.5 !py-1 !text-xs"
                >
                  <Plus size={13} aria-hidden="true" />
                  <span>Log</span>
                </button>
                <Link
                  to="/crm/settings/channels"
                  className="crm-btn-secondary !min-h-9 !px-2.5 !py-1 !text-xs"
                  title="Channel settings & delivery history"
                >
                  <Radio size={13} aria-hidden="true" />
                  <span>Channels</span>
                </Link>
              </div>
            </div>

            <div className="flex flex-wrap gap-1" role="tablist" aria-label="Conversation filters">
              {CONVERSATION_FILTERS.map((f) => {
                const count = listData?.counts[f];
                const active = filter === f;
                return (
                  <button
                    key={f}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setFilter(f)}
                    className={`min-h-8 rounded-md px-2.5 py-1 text-[11px] font-semibold capitalize ${
                      active
                        ? 'bg-[var(--crm-primary)] text-[var(--crm-primary-contrast)]'
                        : 'bg-[var(--crm-bg)] text-[var(--crm-text-muted)] hover:bg-[var(--crm-surface-2)]'
                    }`}
                  >
                    {f} {count !== undefined ? `(${count})` : ''}
                  </button>
                );
              })}
            </div>

            <select
              aria-label="Filter by channel"
              className="crm-select !min-h-9 !text-xs"
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value)}
            >
              <option value="">All channels</option>
              {CONVERSATION_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {c.replace('_', ' ')}
                </option>
              ))}
            </select>
          </div>

          <div
            role="region"
            aria-label="Conversation threads"
            tabIndex={0}
            className="min-h-0 flex-1 overflow-y-auto divide-y divide-[var(--crm-border)]"
          >
            {listLoading && !listData ? (
              <p className="p-4 text-xs text-[var(--crm-text-muted)]">Loading conversations…</p>
            ) : !listData || listData.items.length === 0 ? (
              <div className="p-6 text-center text-xs text-[var(--crm-text-muted)]">
                No conversations in this bucket yet.
              </div>
            ) : (
              listData.items.map((c) => {
                const active = conversationId === c.id;
                return (
                  <Link
                    key={c.id}
                    to={`/crm/conversations/${c.id}`}
                    className={`block px-3.5 py-3 text-xs transition-colors hover:bg-[var(--crm-surface-2)] ${
                      active ? 'bg-[var(--crm-primary-soft)]' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="rounded bg-[var(--crm-surface-2)] px-1.5 py-0.5 text-[10px] font-semibold uppercase">
                        {c.channel.replace('_', ' ')}
                      </span>
                      <time
                        dateTime={new Date(c.lastMessageAt).toISOString()}
                        className="crm-tabular text-[11px] text-[var(--crm-text-muted)]"
                      >
                        {new Date(c.lastMessageAt).toLocaleDateString()}
                      </time>
                    </div>
                    <p className="mt-1 truncate text-sm font-semibold">{c.subject}</p>
                    <p className="mt-0.5 truncate text-[var(--crm-text-muted)]">
                      {c.personName ?? 'Unmatched contact'} · {c.state}
                    </p>
                  </Link>
                );
              })
            )}
          </div>
        </aside>
      )}

      {showThreadPane && (
        <section className="flex min-w-0 flex-1 flex-col bg-[var(--crm-bg)]">
          {!conversationId ? (
            <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-xs text-[var(--crm-text-muted)]">
              <MessageSquare size={28} aria-hidden="true" className="mb-2 opacity-60" />
              <p className="text-sm font-semibold text-[var(--crm-text)]">Select a conversation</p>
              <p className="mt-1 max-w-sm">
                Inbound messages are data from external contacts. Only humans can click Send in the CRM UI.
              </p>
            </div>
          ) : detailLoading && !detail ? (
            <div className="p-6 text-xs text-[var(--crm-text-muted)]">Loading thread…</div>
          ) : detail ? (
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <div className="flex min-w-0 flex-1 flex-col">
                {/* Thread header */}
                <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--crm-border)] bg-[var(--crm-surface)] px-4 py-3 text-xs">
                  <div className="flex min-w-0 items-center gap-2">
                    {isCompact && (
                      <Link to="/crm/conversations" className="crm-btn-secondary !min-h-9 !px-2.5 !py-1 !text-xs">
                        Back
                      </Link>
                    )}
                    <div className="min-w-0">
                      <h2 className="truncate text-sm font-semibold">{detail.conversation.subject}</h2>
                      <p className="truncate text-[var(--crm-text-muted)]">
                        {detail.conversation.channel} ·{' '}
                        {detail.conversation.humanAgentEligible
                          ? '7d Human Agent window'
                          : detail.conversation.windowOpen
                            ? 'Window open'
                            : detail.conversation.requiresTemplate
                              ? '24h window closed (approved template required)'
                              : 'Window closed'}
                        {detail.channelAccountMode ? ` · ${detail.channelAccountMode}` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <select
                      aria-label="Conversation state"
                      className="crm-select !min-h-9 !w-auto !py-1 !text-xs"
                      value={detail.conversation.state}
                      disabled={isOffline}
                      onChange={(e) =>
                        void setConversationState(
                          {
                            conversationId: detail.conversation.id,
                            state: e.target.value as ConversationState,
                            expectedRev: detail.conversation.rev,
                          },
                          { requestId: generateCrmRequestId() },
                        ).then(() => Promise.all([loadDetail(), loadList()]))
                      }
                    >
                      {CONVERSATION_STATES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="Assign teammate"
                      className="crm-select !min-h-9 !w-auto !py-1 !text-xs"
                      value={detail.conversation.assigneeId ?? ''}
                      disabled={isOffline}
                      onChange={(e) =>
                        void assignConversation(
                          {
                            conversationId: detail.conversation.id,
                            assigneeId: e.target.value || null,
                            expectedRev: detail.conversation.rev,
                          },
                          { requestId: generateCrmRequestId() },
                        ).then(() => Promise.all([loadDetail(), loadList()]))
                      }
                    >
                      <option value="">Unassigned</option>
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                    {layout !== 'expanded' && (
                      <button
                        type="button"
                        onClick={() => setContextOpen(true)}
                        className="crm-btn-secondary !min-h-9 !px-2.5 !py-1 !text-xs"
                      >
                        Context
                      </button>
                    )}
                  </div>
                </header>

                {error && (
                  <div role="alert" className="m-3 rounded-lg border px-3 py-2 text-xs" style={{ backgroundColor: 'var(--crm-err-bg)', color: 'var(--crm-err-text)', borderColor: 'var(--crm-err-border)' }}>
                    {error}
                  </div>
                )}
                {notice && (
                  <div role="status" className="mx-3 mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs" style={{ backgroundColor: 'var(--crm-ok-bg)', color: 'var(--crm-ok-text)', borderColor: 'var(--crm-ok-border)' }}>
                    <CheckCircle2 size={14} aria-hidden="true" />
                    <span>{notice}</span>
                  </div>
                )}

                {/* Messages stream */}
                <div
                  role="region"
                  aria-label="Conversation messages"
                  tabIndex={0}
                  className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4"
                >
                  {detail.messages.map((m) => {
                    const isNote = m.direction === 'note';
                    const isDraft = m.status === 'draft';
                    const isInbound = m.direction === 'inbound';
                    return (
                      <article
                        key={m.id}
                        className={`max-w-2xl rounded-lg border p-3 text-xs ${
                          isNote
                            ? 'border-[var(--crm-warn-border)] bg-[var(--crm-warn-bg)] text-[var(--crm-warn-text)]'
                            : isInbound
                              ? 'border-[var(--crm-border)] bg-[var(--crm-surface)]'
                              : 'ml-auto border-[var(--crm-border)] bg-[var(--crm-primary-soft)]'
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-semibold">
                          <span className="inline-flex items-center gap-1">
                            {isNote ? <StickyNote size={12} aria-hidden="true" /> : isDraft ? <Bot size={12} aria-hidden="true" /> : null}
                            <span>
                              {isNote
                                ? 'Internal team note (not sent)'
                                : isDraft
                                  ? 'Draft (not sent)'
                                  : isInbound
                                    ? `Inbound (${m.senderEndpoint ?? m.channel})`
                                    : `Sent by ${m.authorName ?? 'team'} (${m.status})`}
                            </span>
                          </span>
                          <time
                            dateTime={new Date(m.createdAt).toISOString()}
                            className={isNote ? 'crm-tabular text-[var(--crm-warn-text)]' : 'crm-tabular text-[var(--crm-text-muted)]'}
                          >
                            {new Date(m.createdAt).toLocaleString()}
                          </time>
                        </div>
                        <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-[var(--crm-text)]">
                          {m.bodyText}
                        </p>
                        {m.messageTag && (
                          <p className="mt-1 text-[11px] font-medium text-[var(--crm-primary)]">
                            Tag: {m.messageTag}
                          </p>
                        )}
                        {m.inReplyTo && (
                          <p className="mt-1 truncate text-[10px] text-[var(--crm-text-muted)]">
                            In-Reply-To: {m.inReplyTo}
                          </p>
                        )}
                        {m.aiMetadata && m.aiMetadata.citedFactIds.length > 0 && (
                          <p className="mt-1.5 text-[11px] text-[var(--crm-text-muted)]">
                            Cited verified facts: {m.aiMetadata.citedFactIds.join(', ')}
                          </p>
                        )}
                        {m.status === 'review_required' && detail.canSend && (
                          <div
                            className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded border px-2.5 py-2 text-[11px]"
                            style={{
                              backgroundColor: 'var(--crm-warn-bg)',
                              color: 'var(--crm-warn-text)',
                              borderColor: 'var(--crm-warn-border)',
                            }}
                          >
                            <span className="inline-flex items-center gap-1 font-semibold">
                              <ShieldAlert size={12} aria-hidden="true" />
                              <span>Ambiguous delivery — confirm before retrying</span>
                            </span>
                            <div className="flex flex-wrap gap-1.5">
                              <button
                                type="button"
                                disabled={isOffline || busyAction}
                                onClick={() =>
                                  void resolveMessageReview(
                                    { messageId: m.id, resolution: 'confirm_sent' },
                                    { requestId: generateCrmRequestId() },
                                  ).then(() => loadDetail())
                                }
                                className="crm-btn-primary !min-h-8 !px-2 !py-1 !text-[11px]"
                              >
                                Confirm sent
                              </button>
                              <button
                                type="button"
                                disabled={isOffline || busyAction}
                                onClick={() =>
                                  void resolveMessageReview(
                                    { messageId: m.id, resolution: 'mark_failed' },
                                    { requestId: generateCrmRequestId() },
                                  ).then(() => loadDetail())
                                }
                                className="crm-btn-secondary !min-h-8 !px-2 !py-1 !text-[11px]"
                              >
                                Mark failed
                              </button>
                            </div>
                          </div>
                        )}
                        {m.status === 'failed' && detail.canSend && (
                          <button
                            type="button"
                            disabled={isOffline || busyAction}
                            onClick={() =>
                              void retryConversationMessage(
                                { messageId: m.id },
                                { requestId: generateCrmRequestId() },
                              ).then(() => loadDetail())
                            }
                            className="crm-btn-secondary !mt-2 !min-h-8 !text-xs"
                          >
                            <RefreshCw size={12} aria-hidden="true" />
                            <span>Retry send</span>
                          </button>
                        )}
                      </article>
                    );
                  })}
                </div>

                {/* Sticky keyboard-safe composer */}
                <form
                  onSubmit={(e) => void handleSendOrNote(e)}
                  className="shrink-0 space-y-2.5 border-t border-[var(--crm-border)] bg-[var(--crm-surface)] p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div role="tablist" aria-label="Composer mode" className="flex items-center gap-1 rounded-md border border-[var(--crm-border)] p-0.5 text-xs">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={composerMode === 'reply'}
                        onClick={() => setComposerMode('reply')}
                        className={`min-h-9 rounded px-2.5 py-1 font-semibold ${
                          composerMode === 'reply'
                            ? 'bg-[var(--crm-primary)] text-[var(--crm-primary-contrast)]'
                            : 'text-[var(--crm-text-muted)]'
                        }`}
                      >
                        Reply ({detail.conversation.channel})
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={composerMode === 'note'}
                        onClick={() => setComposerMode('note')}
                        className={`min-h-9 rounded px-2.5 py-1 font-semibold ${
                          composerMode === 'note'
                            ? 'bg-[var(--crm-warn-bg)] text-[var(--crm-warn-text)]'
                            : 'text-[var(--crm-text-muted)]'
                        }`}
                      >
                        Internal note
                      </button>
                    </div>

                    <button
                      type="button"
                      disabled={isOffline || busyAction}
                      onClick={() => void handleGenerateAiDraft()}
                      className="crm-btn-secondary !min-h-9 !px-2.5 !py-1 !text-xs"
                    >
                      <Sparkles size={13} aria-hidden="true" />
                      <span>Draft with AI</span>
                    </button>
                  </div>

                  {aiMetaPreview && aiMetaPreview.unconfirmedItems.length > 0 && (
                    <div className="rounded border border-[var(--crm-warn-border)] bg-[var(--crm-warn-bg)] px-2.5 py-1.5 text-[11px] text-[var(--crm-warn-text)]">
                      To be confirmed: {aiMetaPreview.unconfirmedItems.join('; ')}
                    </div>
                  )}

                  {composerMode === 'reply' && detail.consentStatus === 'withdrawn' && (
                    <p className="flex items-center gap-1.5 text-xs text-[var(--crm-err-text)]">
                      <Lock size={13} aria-hidden="true" />
                      <span>Consent is withdrawn for this person/channel. Sending is blocked.</span>
                    </p>
                  )}

                  {composerMode === 'reply' && detail.conversation.humanAgentEligible && (
                    <p className="flex items-center gap-1.5 text-xs text-[var(--crm-primary)]">
                      <Clock size={13} aria-hidden="true" />
                      <span>24h window elapsed — human reply eligible within 7 days via Meta HUMAN_AGENT tag.</span>
                    </p>
                  )}

                  {composerMode === 'reply' && !detail.conversation.windowOpen && (
                    <div className="space-y-1.5">
                      <p className="flex items-center gap-1.5 text-xs text-[var(--crm-warn-text)]">
                        <Clock size={13} aria-hidden="true" />
                        <span>
                          {detail.conversation.requiresTemplate
                            ? '24h WhatsApp window is closed. Choose an approved template to send.'
                            : 'Messaging window is closed. Wait for new inbound or add an internal note.'}
                        </span>
                      </p>
                      {detail.conversation.requiresTemplate && (
                        <select
                          aria-label="Approved message template"
                          className="crm-select !min-h-10 !text-xs"
                          value={selectedTemplateId}
                          onChange={(e) => {
                            const id = e.target.value;
                            setSelectedTemplateId(id);
                            const found = (detail.approvedTemplates ?? []).find((t) => t.id === id);
                            if (found && !draftText.trim()) setDraftText(found.bodyText);
                          }}
                        >
                          <option value="">Select approved template…</option>
                          {(detail.approvedTemplates ?? []).map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name} ({t.language} · {t.category})
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}

                  <textarea
                    rows={3}
                    aria-label={composerMode === 'note' ? 'Internal team note' : 'Reply message'}
                    placeholder={
                      composerMode === 'note'
                        ? 'Write an internal team note (never sent externally)…'
                        : 'Write a reply for human review before sending…'
                    }
                    className={`crm-input !py-2 text-sm ${
                      composerMode === 'note' ? 'border-[var(--crm-warn-border)] bg-[var(--crm-warn-bg)]' : ''
                    }`}
                    value={draftText}
                    onChange={(e) => setDraftText(e.target.value)}
                  />

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <button
                      type="button"
                      disabled={isOffline || busyAction || !draftText.trim() || composerMode === 'note'}
                      onClick={() => void handleSaveDraft()}
                      className="crm-btn-secondary !min-h-10 !text-xs"
                    >
                      Save draft
                    </button>
                    {composerMode === 'note' ? (
                      <button
                        type="submit"
                        disabled={isOffline || busyAction || !draftText.trim()}
                        className="crm-btn-secondary !min-h-10 !text-xs"
                      >
                        <StickyNote size={14} aria-hidden="true" />
                        <span>Add internal note</span>
                      </button>
                    ) : (
                      <button
                        type="submit"
                        disabled={
                          isOffline ||
                          busyAction ||
                          !draftText.trim() ||
                          !detail.canSend ||
                          detail.consentStatus === 'withdrawn' ||
                          (!detail.conversation.windowOpen && !selectedTemplateId)
                        }
                        className="crm-btn-primary !min-h-10 !text-xs"
                      >
                        <Send size={14} aria-hidden="true" />
                        <span>
                          {selectedTemplateId
                            ? 'Send template'
                            : detail.conversation.humanAgentEligible
                              ? 'Send (Human Agent)'
                              : 'Send reply'}
                        </span>
                      </button>
                    )}
                  </div>
                </form>
              </div>

              {layout === 'expanded' && (
                <aside className="w-[300px] shrink-0 overflow-y-auto border-l border-[var(--crm-border)] bg-[var(--crm-surface)]">
                  {contextBody}
                </aside>
              )}
            </div>
          ) : null}
        </section>
      )}

      {contextOpen && detail && layout !== 'expanded' && (
        <Sheet onClose={() => setContextOpen(false)} label="Conversation context">
          <div data-app="crm" className="h-full overflow-y-auto bg-[var(--crm-surface)] text-[var(--crm-text)]">
            {contextBody}
          </div>
        </Sheet>
      )}

      {logOpen && (
        <AdaptiveDialog title="Log manual conversation" onClose={() => setLogOpen(false)}>
          <form onSubmit={(e) => void handleLogManual(e)} data-app="crm" className="space-y-3 text-xs text-[var(--crm-text)]">
            <div>
              <label htmlFor="log-conv-channel" className="mb-1 block font-medium text-[var(--crm-text-muted)]">Channel</label>
              <select id="log-conv-channel" className="crm-select" value={logChannel} onChange={(e) => setLogChannel(e.target.value as ConversationChannel)}>
                {CONVERSATION_CHANNELS.map((c) => (
                  <option key={c} value={c}>{c.replace('_', ' ')}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="log-conv-person" className="mb-1 block font-medium text-[var(--crm-text-muted)]">Person (optional)</label>
              <select id="log-conv-person" className="crm-select" value={logPersonId} onChange={(e) => setLogPersonId(e.target.value)}>
                <option value="">None / unmatched</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>{recordTitle(p)}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="log-conv-subject" className="mb-1 block font-medium text-[var(--crm-text-muted)]">Subject</label>
              <input id="log-conv-subject" type="text" className="crm-input" value={logSubject} onChange={(e) => setLogSubject(e.target.value)} required />
            </div>
            <div>
              <label htmlFor="log-conv-body" className="mb-1 block font-medium text-[var(--crm-text-muted)]">Summary / notes</label>
              <textarea id="log-conv-body" rows={3} className="crm-input !py-2" value={logBody} onChange={(e) => setLogBody(e.target.value)} required />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setLogOpen(false)} className="crm-btn-secondary">Cancel</button>
              <button type="submit" disabled={busyAction} className="crm-btn-primary">Log conversation</button>
            </div>
          </form>
        </AdaptiveDialog>
      )}

      {simOpen && (
        <AdaptiveDialog title="Simulate inbound message (local-test only)" onClose={() => setSimOpen(false)}>
          <form onSubmit={(e) => void handleSimulateInbound(e)} data-app="crm" className="space-y-3 text-xs text-[var(--crm-text)]">
            <p className="text-[var(--crm-text-muted)]">
              Matches active normalized endpoints against existing People records or places unmatched senders into Unmatched.
            </p>
            <div>
              <label htmlFor="sim-channel" className="mb-1 block font-medium text-[var(--crm-text-muted)]">Channel</label>
              <select id="sim-channel" className="crm-select" value={simChannel} onChange={(e) => setSimChannel(e.target.value as CrmChannel)}>
                {CRM_CHANNELS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="sim-from" className="mb-1 block font-medium text-[var(--crm-text-muted)]">From (email, phone, or handle)</label>
              <input id="sim-from" type="text" className="crm-input" placeholder="+919847012345 or email" value={simFrom} onChange={(e) => setSimFrom(e.target.value)} required />
            </div>
            <div>
              <label htmlFor="sim-prog" className="mb-1 block font-medium text-[var(--crm-text-muted)]">Programme (optional)</label>
              <select id="sim-prog" className="crm-select" value={simProg} onChange={(e) => setSimProg(e.target.value)}>
                <option value="">Global / unspecified</option>
                {CRM_PROGRAMMES.map((p) => (
                  <option key={p.slug} value={p.slug}>{p.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="sim-body" className="mb-1 block font-medium text-[var(--crm-text-muted)]">Inbound message</label>
              <textarea id="sim-body" rows={3} className="crm-input !py-2" value={simBody} onChange={(e) => setSimBody(e.target.value)} required />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setSimOpen(false)} className="crm-btn-secondary">Cancel</button>
              <button type="submit" disabled={busyAction} className="crm-btn-primary">Simulate inbound</button>
            </div>
          </form>
        </AdaptiveDialog>
      )}
    </div>
  );
}
