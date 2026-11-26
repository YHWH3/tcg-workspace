import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Mail,
  Plus,
  Radio,
  RefreshCw,
  Send,
  ShieldAlert,
  SlidersHorizontal,
} from 'lucide-react';
import { CRM_CHANNELS, type CrmChannel } from '../../../../shared/crm/capabilities';
import type {
  ChannelAccountMode,
  ChannelProvider,
  ChannelsOverviewResponse,
  CrmChannelAccountDto,
  TemplateCategory,
  ZohoDataCenter,
} from '../../../../shared/crm/channels';
import { TEMPLATE_CATEGORIES, ZOHO_DATA_CENTERS } from '../../../../shared/crm/channels';
import type { CrmStatus } from '../../../../shared/crm/contracts';
import { accessClientStore } from '../../../core/accessClient';
import { authStore } from '../../../core/auth';
import { canManageCrmAccess } from '../../../core/crmStatus';
import { useStore } from '../../../core/store';
import { onlineStore } from '../../../core/sync/engine';
import { AdaptiveDialog } from '../../../core/ui';
import {
  configureChannelAccount,
  describeCommandError,
  fetchChannelsOverview,
  generateCrmRequestId,
  isIdentityChangedError,
  pollChannelAccountNow,
  processOutboxNow,
  resolveMessageReview,
  retryConversationMessage,
  setChannelAccountMode,
  submitCrmTemplate,
  syncCrmTemplateStatus,
  upsertCrmTemplate,
} from '../api';

type SettingsTab = 'accounts' | 'templates' | 'deliveries';

function defaultProviderForChannel(channel: CrmChannel): ChannelProvider {
  if (channel === 'email') return 'email_zoho';
  if (channel === 'whatsapp') return 'whatsapp_cloud';
  if (channel === 'instagram') return 'instagram_meta';
  return 'facebook_meta';
}

function healthBadgeStyle(state: CrmChannelAccountDto['healthState']) {
  if (state === 'connected') {
    return { backgroundColor: 'var(--crm-ok-bg)', color: 'var(--crm-ok-text)', borderColor: 'var(--crm-ok-border)' };
  }
  if (state === 'degraded') {
    return { backgroundColor: 'var(--crm-warn-bg)', color: 'var(--crm-warn-text)', borderColor: 'var(--crm-warn-border)' };
  }
  if (state === 'error') {
    return { backgroundColor: 'var(--crm-err-bg)', color: 'var(--crm-err-text)', borderColor: 'var(--crm-err-border)' };
  }
  return { backgroundColor: 'var(--crm-surface-2)', color: 'var(--crm-text-muted)', borderColor: 'var(--crm-border)' };
}

export function ChannelsSettings({ status }: { status: CrmStatus }) {
  const isOffline = !useStore(onlineStore);
  const auth = useStore(authStore);
  const accessState = useStore(accessClientStore);
  const identityKey = `${auth.user?.id ?? ''}:${accessState.epoch}`;
  const prevIdentityRef = useRef(identityKey);
  const canManageAccess = canManageCrmAccess(status);

  const [tab, setTab] = useState<SettingsTab>('accounts');
  const [data, setData] = useState<ChannelsOverviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deliveryFilter, setDeliveryFilter] = useState<string>('all');

  // Channel configure dialog state
  const [cfgOpen, setCfgOpen] = useState(false);
  const [cfgChannel, setCfgChannel] = useState<CrmChannel>('email');
  const [cfgProvider, setCfgProvider] = useState<ChannelProvider>('email_zoho');
  const [cfgLabel, setCfgLabel] = useState('');
  const [cfgExternalId, setCfgExternalId] = useState('');
  const [cfgMode, setCfgMode] = useState<ChannelAccountMode>('disabled');
  const [cfgSecretName, setCfgSecretName] = useState('');
  const [cfgDataCenter, setCfgDataCenter] = useState<ZohoDataCenter>('in');
  const [cfgZohoAccountId, setCfgZohoAccountId] = useState('');
  const [cfgPhoneNumberId, setCfgPhoneNumberId] = useState('');
  const [cfgPageId, setCfgPageId] = useState('');
  const [cfgHumanAgentApproved, setCfgHumanAgentApproved] = useState(false);

  // Template draft form state
  const [tplOpen, setTplOpen] = useState(false);
  const [tplChannel, setTplChannel] = useState<CrmChannel>('whatsapp');
  const [tplName, setTplName] = useState('');
  const [tplLanguage, setTplLanguage] = useState('en');
  const [tplCategory, setTplCategory] = useState<TemplateCategory>('utility');
  const [tplBody, setTplBody] = useState('');
  const [tplVars, setTplVars] = useState('');

  const loadOverview = useCallback(async () => {
    if (isOffline) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchChannelsOverview();
      setData(res);
    } catch (err) {
      if (isIdentityChangedError(err)) return;
      setError(describeCommandError(err));
    } finally {
      setLoading(false);
    }
  }, [isOffline]);

  useEffect(() => {
    if (prevIdentityRef.current !== identityKey) {
      prevIdentityRef.current = identityKey;
      setData(null);
      setError(null);
      setNotice(null);
      setCfgOpen(false);
      setTplOpen(false);
    }
  }, [identityKey]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview, identityKey]);

  const canSendChannel = (channel: string) =>
    status.owner ||
    status.capabilities.some((c) => c.capability === `crm.send:${channel}` && c.scope === '*');

  const handleSaveChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cfgLabel.trim() || !cfgExternalId.trim() || isOffline || busyId) return;
    setBusyId('__cfg__');
    setError(null);
    setNotice(null);
    try {
      const config: Record<string, unknown> = {};
      if (cfgProvider === 'email_zoho') {
        config.dataCenter = cfgDataCenter;
        if (cfgZohoAccountId.trim()) config.zohoAccountId = cfgZohoAccountId.trim();
        if (cfgExternalId.includes('@')) config.fromAddress = cfgExternalId.trim();
      } else if (cfgProvider === 'whatsapp_cloud') {
        if (cfgPhoneNumberId.trim()) config.phoneNumberId = cfgPhoneNumberId.trim();
      } else if (cfgProvider === 'instagram_meta') {
        if (cfgPageId.trim()) config.instagramAccountId = cfgPageId.trim();
        config.humanAgentApproved = cfgHumanAgentApproved;
      } else if (cfgProvider === 'facebook_meta') {
        if (cfgPageId.trim()) config.pageId = cfgPageId.trim();
        config.humanAgentApproved = cfgHumanAgentApproved;
      }

      const res = await configureChannelAccount(
        {
          channel: cfgChannel,
          provider: cfgProvider,
          label: cfgLabel.trim(),
          externalId: cfgExternalId.trim(),
          mode: cfgMode,
          active: cfgMode !== 'disabled',
          secretName: cfgSecretName.trim() ? cfgSecretName.trim() : null,
          config,
        },
        { requestId: generateCrmRequestId() },
      );
      if (res.ok) {
        setCfgOpen(false);
        setCfgLabel('');
        setCfgExternalId('');
        setCfgSecretName('');
        setNotice(`Saved channel account "${res.result.account.label}" (${res.result.account.mode}).`);
        await loadOverview();
      } else {
        setError(describeCommandError(res));
      }
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleAccount = async (acc: CrmChannelAccountDto, nextMode: ChannelAccountMode) => {
    if (isOffline || busyId) return;
    setBusyId(acc.id);
    setError(null);
    setNotice(null);
    try {
      const res = await setChannelAccountMode(
        { accountId: acc.id, mode: nextMode, active: nextMode !== 'disabled', expectedRev: acc.rev },
        { requestId: generateCrmRequestId() },
      );
      if (res.ok) {
        setNotice(`Updated "${acc.label}" to ${nextMode}.`);
        await loadOverview();
      } else {
        setError(describeCommandError(res));
      }
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setBusyId(null);
    }
  };

  const handlePollNow = async (acc: CrmChannelAccountDto) => {
    if (isOffline || busyId) return;
    setBusyId(`poll:${acc.id}`);
    setError(null);
    setNotice(null);
    try {
      const res = await pollChannelAccountNow({ accountId: acc.id }, { requestId: generateCrmRequestId() });
      if (res.ok) {
        setNotice(
          `Polled "${acc.label}": ${res.result.ingested} ingested, ${res.result.duplicatesSkipped} skipped.`,
        );
        await loadOverview();
      } else {
        setError(describeCommandError(res));
      }
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleSaveTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tplName.trim() || !tplBody.trim() || isOffline || busyId) return;
    setBusyId('__tpl__');
    setError(null);
    setNotice(null);
    try {
      const variables = tplVars
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      const res = await upsertCrmTemplate(
        {
          channel: tplChannel,
          name: tplName.trim(),
          language: tplLanguage.trim() || 'en',
          category: tplCategory,
          bodyText: tplBody.trim(),
          variables,
        },
        { requestId: generateCrmRequestId() },
      );
      if (res.ok) {
        setTplOpen(false);
        setTplName('');
        setTplBody('');
        setTplVars('');
        setNotice(`Saved draft template "${res.result.template.name}".`);
        await loadOverview();
      } else {
        setError(describeCommandError(res));
      }
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleResolveReview = async (messageId: string, resolution: 'confirm_sent' | 'mark_failed' | 'cancel') => {
    if (isOffline || busyId) return;
    setBusyId(`rev:${messageId}`);
    setError(null);
    setNotice(null);
    try {
      const res = await resolveMessageReview(
        {
          messageId,
          resolution,
          note:
            resolution === 'confirm_sent'
              ? 'Verified delivered in provider console'
              : resolution === 'mark_failed'
                ? 'Verified not delivered; unlocked for human retry'
                : 'Cancelled after review',
        },
        { requestId: generateCrmRequestId() },
      );
      if (res.ok) {
        setNotice(`Resolved delivery review (${res.result.status}).`);
        await loadOverview();
      } else {
        setError(describeCommandError(res));
      }
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleRetryDelivery = async (messageId: string) => {
    if (isOffline || busyId) return;
    setBusyId(`retry:${messageId}`);
    setError(null);
    setNotice(null);
    try {
      const res = await retryConversationMessage({ messageId }, { requestId: generateCrmRequestId() });
      if (res.ok) {
        setNotice(`Retried message (${res.result.receiptId}).`);
        await loadOverview();
      } else {
        setError(describeCommandError(res));
      }
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleProcessOutbox = async () => {
    if (isOffline || busyId) return;
    setBusyId('__outbox__');
    setError(null);
    setNotice(null);
    try {
      const res = await processOutboxNow({ limit: 10 }, { requestId: generateCrmRequestId() });
      if (res.ok) {
        setNotice(
          `Outbox sweep complete: ${res.result.sent} sent, ${res.result.requeued} requeued, ${res.result.reviewRequired} awaiting review, ${res.result.failed} failed.`,
        );
        await loadOverview();
      } else {
        setError(describeCommandError(res));
      }
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setBusyId(null);
    }
  };

  const filteredDeliveries = (data?.deliveries ?? []).filter((d) =>
    deliveryFilter === 'all' ? true : d.status === deliveryFilter,
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-3 py-5 sm:px-6 sm:py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-[var(--crm-text-muted)]">Settings</p>
          <h1 className="mt-0.5 text-xl font-semibold leading-tight">Channels, templates &amp; delivery</h1>
          <p className="mt-1 text-xs text-[var(--crm-text-muted)]">
            Configure Zoho Mail, WhatsApp Cloud API, Instagram and Facebook messaging adapters. Production transport stays disabled until account details (O-04, O-20, O-21) and Worker secrets are verified.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canManageAccess && (
            <Link to="/crm/settings/access" className="crm-btn-secondary !min-h-11">
              Accounts &amp; capabilities
            </Link>
          )}
          <Link to="/crm/settings/facts" className="crm-btn-secondary !min-h-11">
            Verified knowledge
          </Link>
          <button
            type="button"
            disabled={loading || isOffline}
            onClick={() => void loadOverview()}
            className="crm-btn-secondary !min-h-11"
          >
            <RefreshCw size={15} aria-hidden="true" className={loading ? 'animate-spin' : ''} />
            <span>Refresh</span>
          </button>
        </div>
      </header>

      {data?.simulatedMode && (
        <div
          role="status"
          className="rounded-lg border px-4 py-2.5 text-xs"
          style={{
            backgroundColor: 'var(--crm-warn-bg)',
            color: 'var(--crm-warn-text)',
            borderColor: 'var(--crm-warn-border)',
          }}
        >
          <strong>Local simulated transport enabled:</strong> simulated accounts test internal delivery, windows, opt-outs and review workflows only — never real provider compatibility.
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-lg border px-4 py-3 text-xs"
          style={{
            backgroundColor: 'var(--crm-err-bg)',
            color: 'var(--crm-err-text)',
            borderColor: 'var(--crm-err-border)',
          }}
        >
          {error}
        </div>
      )}

      {notice && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg border px-4 py-3 text-xs"
          style={{
            backgroundColor: 'var(--crm-ok-bg)',
            color: 'var(--crm-ok-text)',
            borderColor: 'var(--crm-ok-border)',
          }}
        >
          <CheckCircle2 size={15} aria-hidden="true" />
          <span>{notice}</span>
        </div>
      )}

      <div role="tablist" aria-label="Channel settings tabs" className="flex flex-wrap gap-2 border-b border-[var(--crm-border)] pb-2">
        {(
          [
            { id: 'accounts', label: `Channels (${data?.accounts.length ?? 0})`, icon: Radio },
            { id: 'templates', label: `Templates (${data?.templates.length ?? 0})`, icon: FileText },
            {
              id: 'deliveries',
              label: `Delivery & review (${(data?.counts.reviewRequired ?? 0) + (data?.counts.failed ?? 0)} alerts)`,
              icon: SlidersHorizontal,
            },
          ] as const
        ).map((item) => {
          const Icon = item.icon;
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(item.id)}
              className={`inline-flex min-h-11 items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors ${
                active
                  ? 'bg-[var(--crm-primary)] text-[var(--crm-primary-contrast)]'
                  : 'bg-[var(--crm-surface)] text-[var(--crm-text-muted)] border border-[var(--crm-border)] hover:bg-[var(--crm-surface-2)]'
              }`}
            >
              <Icon size={14} aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>

      {tab === 'accounts' && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-[var(--crm-text-muted)]">
              Secrets are referenced by Worker binding name only and never stored in D1.
            </p>
            {data?.canManageChannels && (
              <button
                type="button"
                disabled={isOffline}
                onClick={() => setCfgOpen(true)}
                className="crm-btn-primary !min-h-11 !text-xs"
              >
                <Plus size={14} aria-hidden="true" />
                <span>Add channel account</span>
              </button>
            )}
          </div>

          {!data || data.accounts.length === 0 ? (
            <div className="crm-panel p-6 text-center text-xs text-[var(--crm-text-muted)]">
              <Mail size={22} aria-hidden="true" className="mx-auto mb-2 opacity-60" />
              <p className="font-semibold text-[var(--crm-text)]">No channel accounts configured yet</p>
              <p className="mt-1">
                Production providers stay disabled by default until credentials and owner decisions (O-04, O-20, O-21) are confirmed.
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {data.accounts.map((acc) => (
                <li key={acc.id} className="crm-panel flex flex-wrap items-start justify-between gap-3 p-4 text-xs">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{acc.label}</span>
                      <span className="rounded bg-[var(--crm-surface-2)] px-2 py-0.5 text-[11px] font-semibold uppercase">
                        {acc.channel} · {acc.provider}
                      </span>
                      <span
                        className="rounded-full border px-2.5 py-0.5 text-[11px] font-semibold capitalize"
                        style={healthBadgeStyle(acc.healthState)}
                      >
                        {acc.healthState}
                      </span>
                      <span className="rounded-full border border-[var(--crm-border)] px-2 py-0.5 text-[11px] capitalize">
                        Mode: {acc.mode}
                      </span>
                    </div>
                    <p className="text-[var(--crm-text-muted)]">
                      Identifier: <span className="font-medium text-[var(--crm-text)]">{acc.externalId}</span> · Secret:{' '}
                      {acc.secretName ? `${acc.secretName} (${acc.secretBound ? 'bound' : 'not bound'})` : 'none'}
                    </p>
                    {acc.provider === 'email_zoho' && (
                      <p className="text-[var(--crm-text-muted)]">
                        Poll cursor: <span className="crm-tabular">{acc.pollCursor ?? 'none'}</span>
                        {acc.lastPollAt ? (
                          <>
                            {' '}· Last poll:{' '}
                            <time className="crm-tabular" dateTime={new Date(acc.lastPollAt).toISOString()}>
                              {new Date(acc.lastPollAt).toLocaleString()}
                            </time>
                          </>
                        ) : null}
                      </p>
                    )}
                    {acc.lastError && (
                      <p className="text-[var(--crm-err-text)]">Last error: {acc.lastError}</p>
                    )}
                  </div>

                  {data.canManageChannels && (
                    <div className="flex flex-wrap items-center gap-2">
                      {acc.provider === 'email_zoho' && acc.active && (
                        <button
                          type="button"
                          disabled={isOffline || busyId !== null}
                          onClick={() => void handlePollNow(acc)}
                          className="crm-btn-secondary !min-h-11 !text-xs"
                        >
                          <RefreshCw size={13} aria-hidden="true" />
                          <span>Poll now</span>
                        </button>
                      )}
                      {acc.mode !== 'disabled' ? (
                        <button
                          type="button"
                          disabled={isOffline || busyId !== null}
                          onClick={() => void handleToggleAccount(acc, 'disabled')}
                          className="crm-btn-secondary !min-h-11 !text-xs"
                        >
                          Disconnect
                        </button>
                      ) : data.simulatedMode ? (
                        <button
                          type="button"
                          disabled={isOffline || busyId !== null}
                          onClick={() => void handleToggleAccount(acc, 'simulated')}
                          className="crm-btn-primary !min-h-11 !text-xs"
                        >
                          Enable simulated
                        </button>
                      ) : null}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === 'templates' && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-[var(--crm-text-muted)]">
              Approved WhatsApp templates are required when the 24-hour customer service window is closed.
            </p>
            {data?.canManageChannels && (
              <button
                type="button"
                disabled={isOffline}
                onClick={() => setTplOpen(true)}
                className="crm-btn-primary !min-h-11 !text-xs"
              >
                <Plus size={14} aria-hidden="true" />
                <span>New template</span>
              </button>
            )}
          </div>

          {!data || data.templates.length === 0 ? (
            <div className="crm-panel p-6 text-center text-xs text-[var(--crm-text-muted)]">
              No message templates yet.
            </div>
          ) : (
            <ul className="space-y-3">
              {data.templates.map((tpl) => (
                <li key={tpl.id} className="crm-panel flex flex-wrap items-start justify-between gap-3 p-4 text-xs">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{tpl.name}</span>
                      <span className="rounded bg-[var(--crm-surface-2)] px-2 py-0.5 text-[11px] uppercase">
                        {tpl.channel} · {tpl.language} · {tpl.category}
                      </span>
                      <span className="rounded-full border border-[var(--crm-border)] px-2.5 py-0.5 text-[11px] font-semibold capitalize">
                        {tpl.status}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap text-[var(--crm-text)]">{tpl.bodyText}</p>
                    {tpl.rejectionReason && (
                      <p className="text-[var(--crm-err-text)]">Rejection: {tpl.rejectionReason}</p>
                    )}
                  </div>
                  {data.canManageChannels && (
                    <div className="flex flex-wrap items-center gap-2">
                      {(tpl.status === 'draft' || tpl.status === 'rejected') && (
                        <button
                          type="button"
                          disabled={isOffline || busyId !== null}
                          onClick={() =>
                            void submitCrmTemplate({ templateId: tpl.id }, { requestId: generateCrmRequestId() }).then(
                              () => loadOverview(),
                            )
                          }
                          className="crm-btn-secondary !min-h-11 !text-xs"
                        >
                          Submit
                        </button>
                      )}
                      {tpl.status === 'submitted' && (
                        <>
                          <button
                            type="button"
                            disabled={isOffline || busyId !== null}
                            onClick={() =>
                              void syncCrmTemplateStatus(
                                { templateId: tpl.id, status: 'approved' },
                                { requestId: generateCrmRequestId() },
                              ).then(() => loadOverview())
                            }
                            className="crm-btn-primary !min-h-11 !text-xs"
                          >
                            Mark approved
                          </button>
                          <button
                            type="button"
                            disabled={isOffline || busyId !== null}
                            onClick={() =>
                              void syncCrmTemplateStatus(
                                { templateId: tpl.id, status: 'rejected', rejectionReason: 'Rejected in provider review' },
                                { requestId: generateCrmRequestId() },
                              ).then(() => loadOverview())
                            }
                            className="crm-btn-secondary !min-h-11 !text-xs"
                          >
                            Mark rejected
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === 'deliveries' && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              {(['all', 'review_required', 'failed', 'queued', 'sent', 'cancelled'] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setDeliveryFilter(st)}
                  className={`min-h-11 rounded-md px-3 py-1.5 font-semibold capitalize ${
                    deliveryFilter === st
                      ? 'bg-[var(--crm-primary)] text-[var(--crm-primary-contrast)]'
                      : 'border border-[var(--crm-border)] bg-[var(--crm-surface)] text-[var(--crm-text-muted)]'
                  }`}
                >
                  {st.replace('_', ' ')}
                </button>
              ))}
            </div>
            {data?.canManageChannels && (
              <button
                type="button"
                disabled={isOffline || busyId !== null}
                onClick={() => void handleProcessOutbox()}
                className="crm-btn-secondary !min-h-11 !text-xs"
              >
                <Send size={13} aria-hidden="true" />
                <span>Process due outbox</span>
              </button>
            )}
          </div>

          {filteredDeliveries.length === 0 ? (
            <div className="crm-panel p-6 text-center text-xs text-[var(--crm-text-muted)]">
              No outbound deliveries match this filter.
            </div>
          ) : (
            <ul className="space-y-3">
              {filteredDeliveries.map((d) => {
                const canSend = canSendChannel(d.channel);
                return (
                  <li key={d.id} className="crm-panel space-y-2 p-4 text-xs">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            to={`/crm/conversations/${d.conversationId}`}
                            className="font-semibold text-[var(--crm-primary)] hover:underline"
                          >
                            {d.conversationSubject || d.conversationId}
                          </Link>
                          <span className="rounded bg-[var(--crm-surface-2)] px-2 py-0.5 text-[11px] uppercase">
                            {d.channel}
                          </span>
                          <span className="rounded-full border border-[var(--crm-border)] px-2.5 py-0.5 text-[11px] font-semibold">
                            {d.status.replace('_', ' ')}
                          </span>
                          {d.messageTag && (
                            <span className="rounded bg-[var(--crm-primary-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--crm-primary)]">
                              {d.messageTag}
                            </span>
                          )}
                        </div>
                        <p className="text-[var(--crm-text-muted)]">
                          To: {d.recipientEndpoint ?? '—'} · Attempts: {d.attempts}/{d.maxAttempts} · Receipt:{' '}
                          <span className="crm-tabular">{d.providerReceipt ?? '—'}</span>
                        </p>
                        <p className="text-[var(--crm-text)]">{d.bodyPreview}</p>
                        {d.lastError && (
                          <p className="flex items-center gap-1 text-[var(--crm-err-text)]">
                            <AlertTriangle size={12} aria-hidden="true" />
                            <span>
                              {d.lastErrorClass ?? 'error'}: {d.lastError}
                            </span>
                          </p>
                        )}
                      </div>
                      <time className="crm-tabular text-[11px] text-[var(--crm-text-muted)]" dateTime={new Date(d.updatedAt).toISOString()}>
                        {new Date(d.updatedAt).toLocaleString()}
                      </time>
                    </div>

                    {d.status === 'review_required' && canSend && (
                      <div
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2.5"
                        style={{
                          backgroundColor: 'var(--crm-warn-bg)',
                          color: 'var(--crm-warn-text)',
                          borderColor: 'var(--crm-warn-border)',
                        }}
                      >
                        <p className="flex items-center gap-1.5 font-medium">
                          <ShieldAlert size={14} aria-hidden="true" />
                          <span>Ambiguous provider outcome — verify before retrying to prevent duplicates.</span>
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={isOffline || busyId !== null}
                            onClick={() => void handleResolveReview(d.messageId, 'confirm_sent')}
                            className="crm-btn-primary !min-h-11 !text-xs"
                          >
                            Confirm sent
                          </button>
                          <button
                            type="button"
                            disabled={isOffline || busyId !== null}
                            onClick={() => void handleResolveReview(d.messageId, 'mark_failed')}
                            className="crm-btn-secondary !min-h-11 !text-xs"
                          >
                            Mark failed for retry
                          </button>
                          <button
                            type="button"
                            disabled={isOffline || busyId !== null}
                            onClick={() => void handleResolveReview(d.messageId, 'cancel')}
                            className="crm-btn-secondary !min-h-11 !text-xs"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}

                    {d.status === 'failed' && canSend && (
                      <div className="flex justify-end">
                        <button
                          type="button"
                          disabled={isOffline || busyId !== null}
                          onClick={() => void handleRetryDelivery(d.messageId)}
                          className="crm-btn-secondary !min-h-11 !text-xs"
                        >
                          <RefreshCw size={13} aria-hidden="true" />
                          <span>Retry send</span>
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {cfgOpen && (
        <AdaptiveDialog title="Configure channel account" onClose={() => setCfgOpen(false)}>
          <form onSubmit={(e) => void handleSaveChannel(e)} data-app="crm" className="space-y-3 text-xs text-[var(--crm-text)]">
            <div>
              <label htmlFor="ch-cfg-channel" className="mb-1 block font-medium">Channel</label>
              <select
                id="ch-cfg-channel"
                className="crm-select !min-h-11"
                value={cfgChannel}
                onChange={(e) => {
                  const next = e.target.value as CrmChannel;
                  setCfgChannel(next);
                  setCfgProvider(defaultProviderForChannel(next));
                }}
              >
                {CRM_CHANNELS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="ch-cfg-label" className="mb-1 block font-medium">Display label</label>
              <input
                id="ch-cfg-label"
                type="text"
                required
                placeholder="e.g. Riverbank Contact Desk"
                className="crm-input !min-h-11"
                value={cfgLabel}
                onChange={(e) => setCfgLabel(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="ch-cfg-ext" className="mb-1 block font-medium">External address / ID</label>
              <input
                id="ch-cfg-ext"
                type="text"
                required
                placeholder={cfgChannel === 'email' ? 'contact@example.org' : '+919800000001 or page ID'}
                className="crm-input !min-h-11"
                value={cfgExternalId}
                onChange={(e) => setCfgExternalId(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="ch-cfg-mode" className="mb-1 block font-medium">Transport mode</label>
              <select
                id="ch-cfg-mode"
                className="crm-select !min-h-11"
                value={cfgMode}
                onChange={(e) => setCfgMode(e.target.value as ChannelAccountMode)}
              >
                <option value="disabled">Disabled (recommended default)</option>
                {data?.simulatedMode && <option value="simulated">Simulated (local-test only)</option>}
                <option value="production">Production (requires bound secret &amp; owner sign-off)</option>
              </select>
            </div>
            <div>
              <label htmlFor="ch-cfg-secret" className="mb-1 block font-medium">Worker secret binding name (optional)</label>
              <input
                id="ch-cfg-secret"
                type="text"
                placeholder="ZOHO_MAIL_CRED_JSON"
                className="crm-input !min-h-11"
                value={cfgSecretName}
                onChange={(e) => setCfgSecretName(e.target.value)}
              />
            </div>
            {cfgProvider === 'email_zoho' && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div>
                  <label htmlFor="ch-cfg-dc" className="mb-1 block font-medium">Zoho data centre (O-20)</label>
                  <select
                    id="ch-cfg-dc"
                    className="crm-select !min-h-11"
                    value={cfgDataCenter}
                    onChange={(e) => setCfgDataCenter(e.target.value as ZohoDataCenter)}
                  >
                    {ZOHO_DATA_CENTERS.map((dc) => (
                      <option key={dc} value={dc}>mail.zoho.{dc}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="ch-cfg-zacc" className="mb-1 block font-medium">Zoho Account ID</label>
                  <input
                    id="ch-cfg-zacc"
                    type="text"
                    className="crm-input !min-h-11"
                    value={cfgZohoAccountId}
                    onChange={(e) => setCfgZohoAccountId(e.target.value)}
                  />
                </div>
              </div>
            )}
            {cfgProvider === 'whatsapp_cloud' && (
              <div>
                <label htmlFor="ch-cfg-phone-id" className="mb-1 block font-medium">Meta Phone Number ID (O-04)</label>
                <input
                  id="ch-cfg-phone-id"
                  type="text"
                  className="crm-input !min-h-11"
                  value={cfgPhoneNumberId}
                  onChange={(e) => setCfgPhoneNumberId(e.target.value)}
                />
              </div>
            )}
            {(cfgProvider === 'instagram_meta' || cfgProvider === 'facebook_meta') && (
              <>
                <div>
                  <label htmlFor="ch-cfg-page-id" className="mb-1 block font-medium">Meta Page / IG Account ID</label>
                  <input
                    id="ch-cfg-page-id"
                    type="text"
                    className="crm-input !min-h-11"
                    value={cfgPageId}
                    onChange={(e) => setCfgPageId(e.target.value)}
                  />
                </div>
                <label className="flex min-h-11 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={cfgHumanAgentApproved}
                    onChange={(e) => setCfgHumanAgentApproved(e.target.checked)}
                    className="h-5 w-5 accent-[var(--crm-primary)]"
                  />
                  <span>Meta HUMAN_AGENT 7-day human reply approval active</span>
                </label>
              </>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setCfgOpen(false)} className="crm-btn-secondary !min-h-11">
                Cancel
              </button>
              <button type="submit" disabled={busyId !== null} className="crm-btn-primary !min-h-11">
                Save account
              </button>
            </div>
          </form>
        </AdaptiveDialog>
      )}

      {tplOpen && (
        <AdaptiveDialog title="Create draft message template" onClose={() => setTplOpen(false)}>
          <form onSubmit={(e) => void handleSaveTemplate(e)} data-app="crm" className="space-y-3 text-xs text-[var(--crm-text)]">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label htmlFor="tpl-ch" className="mb-1 block font-medium">Channel</label>
                <select id="tpl-ch" className="crm-select !min-h-11" value={tplChannel} onChange={(e) => setTplChannel(e.target.value as CrmChannel)}>
                  {CRM_CHANNELS.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="tpl-cat" className="mb-1 block font-medium">Category</label>
                <select id="tpl-cat" className="crm-select !min-h-11" value={tplCategory} onChange={(e) => setTplCategory(e.target.value as TemplateCategory)}>
                  {TEMPLATE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label htmlFor="tpl-name" className="mb-1 block font-medium">Template name</label>
                <input id="tpl-name" type="text" required placeholder="workshop_dates_update" className="crm-input !min-h-11" value={tplName} onChange={(e) => setTplName(e.target.value)} />
              </div>
              <div>
                <label htmlFor="tpl-lang" className="mb-1 block font-medium">Language code</label>
                <input id="tpl-lang" type="text" required value={tplLanguage} onChange={(e) => setTplLanguage(e.target.value)} className="crm-input !min-h-11" />
              </div>
            </div>
            <div>
              <label htmlFor="tpl-body" className="mb-1 block font-medium">Template body</label>
              <textarea id="tpl-body" rows={3} required placeholder="Hi {{1}}, we have an update on {{2}}." className="crm-input !py-2" value={tplBody} onChange={(e) => setTplBody(e.target.value)} />
            </div>
            <div>
              <label htmlFor="tpl-vars" className="mb-1 block font-medium">Variable labels (comma-separated)</label>
              <input id="tpl-vars" type="text" placeholder="name, programme" className="crm-input !min-h-11" value={tplVars} onChange={(e) => setTplVars(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setTplOpen(false)} className="crm-btn-secondary !min-h-11">Cancel</button>
              <button type="submit" disabled={busyId !== null} className="crm-btn-primary !min-h-11">Save draft</button>
            </div>
          </form>
        </AdaptiveDialog>
      )}
    </div>
  );
}
