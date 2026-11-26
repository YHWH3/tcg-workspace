import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  CheckCircle2,
  CloudOff,
  Lock,
  Plus,
  RefreshCw,
  Sprout,
  XCircle,
} from 'lucide-react';
import type { CrmStatus } from '../../../../shared/crm/contracts';
import {
  formatMinorMoney,
  type CrmMembershipDto,
  type CrmMembershipSchemeDto,
  type MembershipsOverviewResponse,
  type MembershipState,
} from '../../../../shared/crm/operations';
import { authStore } from '../../../core/auth';
import { useLayoutMode } from '../../../core/mobile';
import { recordTitle } from '../../../core/records';
import { useStore } from '../../../core/store';
import { onlineStore } from '../../../core/sync/engine';
import { AdaptiveDialog } from '../../../core/ui';
import {
  activateMembership,
  applyMembership,
  cancelMembership,
  decideMembership,
  describeCommandError,
  fetchMembershipsOverview,
  isIdentityChangedError,
  issueMembershipContributionRequest,
  renewMembership,
  upsertMembershipScheme,
} from '../api';
import { useCrmDatabases } from '../hooks/useCrmDatabases';

function membershipBadgeStyle(state: MembershipState): { bg: string; fg: string } {
  switch (state) {
    case 'active':
      return { bg: 'var(--crm-status-river)', fg: 'var(--crm-status-fg)' };
    case 'renewal_due':
    case 'awaiting_contribution':
    case 'approved':
      return { bg: 'var(--crm-warn-bg)', fg: 'var(--crm-warn-text)' };
    case 'lapsed':
    case 'declined':
    case 'cancelled':
      return { bg: 'var(--crm-err-bg)', fg: 'var(--crm-err-text)' };
    default:
      return { bg: 'var(--crm-surface-2)', fg: 'var(--crm-text)' };
  }
}

export function MembershipsView({ status }: { status: CrmStatus }) {
  const layout = useLayoutMode();
  const isOffline = !useStore(onlineStore);
  const currentUser = useStore(authStore).user;
  const uid = currentUser?.id ?? null;
  const { peopleDb, tasks } = useCrmDatabases();

  const peopleOptions = useMemo(() => {
    if (!peopleDb) return [];
    return tasks
      .filter((t) => !t.deleted && !t.archived && t.boardId === peopleDb.id)
      .map((t) => ({ id: t.id, title: recordTitle(t) }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [peopleDb, tasks]);

  const [data, setData] = useState<MembershipsOverviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Dialog states
  const [schemeModalOpen, setSchemeModalOpen] = useState(false);
  const [editingScheme, setEditingScheme] = useState<CrmMembershipSchemeDto | null>(null);
  const [applyModalOpen, setApplyModalOpen] = useState(false);
  const [actionMembership, setActionMembership] = useState<{
    kind: 'decide' | 'cancel';
    membership: CrmMembershipDto;
  } | null>(null);

  // Scheme form
  const [scSlug, setScSlug] = useState('common-roots-annual');
  const [scName, setScName] = useState('Common Roots');
  const [scAmountMajor, setScAmountMajor] = useState('');
  const [scCurrency, setScCurrency] = useState('INR');
  const [scValidityDays, setScValidityDays] = useState('');
  const [scNoticeDays, setScNoticeDays] = useState('');
  const [scPrefix, setScPrefix] = useState('');
  const [scDigits, setScDigits] = useState('4');

  // Apply form
  const [appSchemeId, setAppSchemeId] = useState('');
  const [appPersonId, setAppPersonId] = useState('');
  const [appNotes, setAppNotes] = useState('');

  // Decide/cancel form
  const [decisionKind, setDecisionKind] = useState<'approve' | 'decline'>('approve');
  const [decisionReason, setDecisionReason] = useState('');

  useEffect(() => {
    setData(null);
    setError(null);
    setNotice(null);
  }, [uid, status.owner, status.capabilities.length]);

  const loadMemberships = useCallback(async () => {
    if (isOffline) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchMembershipsOverview();
      setData(res);
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setLoading(false);
    }
  }, [isOffline]);

  useEffect(() => {
    void loadMemberships();
  }, [loadMemberships]);

  const openConfigureScheme = (existing?: CrmMembershipSchemeDto) => {
    setEditingScheme(existing ?? null);
    setScSlug(existing?.slug ?? 'common-roots-annual');
    setScName(existing?.name ?? 'Common Roots');
    setScAmountMajor(
      existing?.contributionAmountMinor ? String(existing.contributionAmountMinor / 100) : '',
    );
    setScCurrency(existing?.currency ?? 'INR');
    setScValidityDays(existing?.validityDays ? String(existing.validityDays) : '');
    setScNoticeDays(existing?.renewalNoticeDays ? String(existing.renewalNoticeDays) : '');
    setScPrefix(existing?.identifierPrefix ?? '');
    setScDigits(existing?.identifierDigits ? String(existing.identifierDigits) : '4');
    setSchemeModalOpen(true);
  };

  const handleSaveScheme = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || isOffline) return;
    setBusy(true);
    setError(null);
    try {
      const amountMinor = scAmountMajor.trim() ? Math.round(Number(scAmountMajor) * 100) : null;
      const res = await upsertMembershipScheme({
        ...(editingScheme ? { schemeId: editingScheme.id, expectedRev: editingScheme.rev } : {}),
        slug: scSlug.trim().toLowerCase(),
        name: scName.trim(),
        programmeSlug: 'common-roots',
        contributionAmountMinor: amountMinor,
        currency: amountMinor ? scCurrency.trim().toUpperCase() : null,
        validityDays: scValidityDays.trim() ? Number(scValidityDays) : null,
        renewalNoticeDays: scNoticeDays.trim() ? Number(scNoticeDays) : null,
        identifierPrefix: scPrefix.trim() || null,
        identifierDigits: scPrefix.trim() ? Number(scDigits) || 4 : null,
        active: true,
      });
      if (!res.ok) {
        setError(describeCommandError(res));
        return;
      }
      setSchemeModalOpen(false);
      setNotice(`Saved membership scheme "${res.result.scheme.name}".`);
      await loadMemberships();
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleApply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || isOffline || !appSchemeId || !appPersonId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await applyMembership({
        schemeId: appSchemeId,
        personId: appPersonId,
        notes: appNotes.trim() || null,
      });
      if (!res.ok) {
        setError(describeCommandError(res));
        return;
      }
      setApplyModalOpen(false);
      setAppNotes('');
      setNotice('Created membership application.');
      await loadMemberships();
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmAction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!actionMembership || !decisionReason.trim() || busy || isOffline) return;
    setBusy(true);
    setError(null);
    try {
      const m = actionMembership.membership;
      const res =
        actionMembership.kind === 'decide'
          ? await decideMembership({
              membershipId: m.id,
              decision: decisionKind,
              reason: decisionReason.trim(),
              expectedRev: m.rev,
            })
          : await cancelMembership({
              membershipId: m.id,
              reason: decisionReason.trim(),
              expectedRev: m.rev,
            });
      if (!res.ok) {
        setError(describeCommandError(res));
        return;
      }
      setActionMembership(null);
      setDecisionReason('');
      setNotice(`Membership state updated to ${res.result.membership.state}.`);
      await loadMemberships();
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setBusy(false);
    }
  };

  const runDirectAction = async (
    label: string,
    fn: () => Promise<
      | { ok: true; result: { membership: CrmMembershipDto } }
      | { ok: false; error: string; detail?: Record<string, unknown> }
    >,
  ) => {
    if (busy || isOffline) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) {
        setError(describeCommandError(res));
        return;
      }
      setNotice(`${label}: ${res.result.membership.state.replace(/_/g, ' ')}.`);
      await loadMemberships();
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-3 py-5 sm:px-6 sm:py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-[var(--crm-text-muted)]">Operations · S8 Common Roots</p>
          <h1 className="mt-0.5 text-xl font-semibold leading-tight">Common Roots Memberships</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={loading || isOffline}
            onClick={() => void loadMemberships()}
            className="crm-btn-secondary min-h-11"
          >
            <RefreshCw size={14} aria-hidden="true" className={loading ? 'animate-spin' : ''} />
            <span>Refresh</span>
          </button>
          {data?.canConfigure && (
            <button
              type="button"
              disabled={isOffline}
              onClick={() => openConfigureScheme()}
              className="crm-btn-secondary min-h-11"
            >
              <Plus size={14} aria-hidden="true" />
              <span>Configure scheme</span>
            </button>
          )}
          <button
            type="button"
            disabled={isOffline || !data?.schemes.length}
            onClick={() => {
              setAppSchemeId(data?.schemes[0]?.id ?? '');
              setAppPersonId(peopleOptions[0]?.id ?? '');
              setApplyModalOpen(true);
            }}
            className="crm-btn-primary min-h-11"
          >
            <Sprout size={15} aria-hidden="true" />
            <span>New membership application</span>
          </button>
        </div>
      </header>

      {isOffline && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg border border-[var(--crm-warn-border)] bg-[var(--crm-warn-bg)] px-4 py-3 text-xs text-[var(--crm-warn-text)]"
        >
          <CloudOff size={15} aria-hidden="true" />
          <span>Offline: membership applications, approvals, and ledger-linked activations require a connection.</span>
        </div>
      )}

      {/* O-07 Policy Guardrail Banner */}
      <div className="crm-panel flex items-start gap-2.5 p-4 text-xs text-[var(--crm-text-muted)]">
        <Lock size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--crm-primary)]" />
        <div>
          <p className="font-semibold text-[var(--crm-text)]">
            Benefits &amp; redemption disabled pending O-07 · Ledger-backed activation
          </p>
          <p className="mt-0.5">
            Contribution amounts, validity windows, and member identifier formats are configured per scheme without hardcoded historical defaults. Activation and renewal require a recorded receipt in Money.
          </p>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-[var(--crm-err-border)] bg-[var(--crm-err-bg)] px-4 py-3 text-xs text-[var(--crm-err-text)]"
        >
          {error}
        </div>
      )}

      {notice && (
        <div role="status" className="crm-panel px-4 py-3 text-xs font-medium">
          {notice}
        </div>
      )}

      {data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 text-xs">
          <div className="crm-panel p-3.5">
            <span className="text-[var(--crm-text-muted)]">Schemes</span>
            <p className="crm-tabular mt-1 text-lg font-semibold">{data.schemes.length}</p>
          </div>
          <div className="crm-panel p-3.5">
            <span className="text-[var(--crm-text-muted)]">Memberships</span>
            <p className="crm-tabular mt-1 text-lg font-semibold">{data.memberships.length}</p>
          </div>
          <div className="crm-panel p-3.5">
            <span className="text-[var(--crm-text-muted)]">Renewals due</span>
            <p className="crm-tabular mt-1 text-lg font-semibold">{data.renewalsDueCount}</p>
          </div>
          <div className="crm-panel p-3.5">
            <span className="text-[var(--crm-text-muted)]">Lapsed</span>
            <p className="crm-tabular mt-1 text-lg font-semibold">{data.lapsedCount}</p>
          </div>
        </div>
      )}

      {/* Schemes */}
      {data && data.schemes.length > 0 && (
        <section aria-label="Membership schemes" className="grid gap-3 sm:grid-cols-2">
          {data.schemes.map((sc) => (
            <div key={sc.id} className="crm-panel flex flex-col justify-between gap-2 p-4 text-xs">
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold">{sc.name}</h2>
                  <span className="rounded-full bg-[var(--crm-surface-2)] px-2 py-0.5 text-[10px] font-semibold">
                    Benefits off (O-07)
                  </span>
                </div>
                <p className="text-[var(--crm-text-muted)]">
                  Contribution:{' '}
                  {sc.contributionAmountMinor !== null && sc.currency
                    ? formatMinorMoney(sc.contributionAmountMinor, sc.currency)
                    : 'Unconfigured (O-07)'}{' '}
                  · Validity: {sc.validityDays ? `${sc.validityDays} days` : 'Unconfigured'}
                </p>
                {sc.identifierPrefix && (
                  <p className="text-[11px] text-[var(--crm-text-muted)]">
                    Identifier format: {sc.identifierPrefix}-{'0'.repeat(sc.identifierDigits ?? 4)}
                  </p>
                )}
              </div>
              {data.canConfigure && (
                <div className="pt-1">
                  <button
                    type="button"
                    disabled={isOffline}
                    onClick={() => openConfigureScheme(sc)}
                    className="crm-btn-secondary !min-h-11 !text-xs"
                  >
                    Edit scheme
                  </button>
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      {/* Memberships list */}
      {data && (
        <section aria-label="Memberships directory" className="space-y-3">
          {data.memberships.length === 0 ? (
            <div className="crm-panel p-6 text-center text-xs text-[var(--crm-text-muted)]">
              No memberships recorded yet.
            </div>
          ) : layout === 'compact' ? (
            <ul className="space-y-2.5">
              {data.memberships.map((m) => {
                const badge = membershipBadgeStyle(m.effectiveState);
                return (
                  <li key={m.id} className="crm-panel space-y-2.5 p-4 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold">{m.personName ?? m.personId}</p>
                        <p className="text-[var(--crm-text-muted)]">
                          {m.schemeName}
                          {m.memberIdentifier ? ` · ${m.memberIdentifier}` : ''}
                        </p>
                      </div>
                      <span
                        className="rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase"
                        style={{ backgroundColor: badge.bg, color: badge.fg }}
                      >
                        {m.effectiveState.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <p className="text-[11px] text-[var(--crm-text-muted)]">
                      Payment: {m.paymentStatus.replace(/_/g, ' ')} · Valid until:{' '}
                      {m.validUntil ? new Date(m.validUntil).toLocaleDateString() : '—'}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {m.effectiveState === 'applied' && (
                        <button
                          type="button"
                          disabled={busy || isOffline}
                          onClick={() => {
                            setActionMembership({ kind: 'decide', membership: m });
                            setDecisionKind('approve');
                          }}
                          className="crm-btn-primary min-h-11"
                        >
                          Review
                        </button>
                      )}
                      {m.effectiveState === 'approved' && (
                        <button
                          type="button"
                          disabled={busy || isOffline}
                          onClick={() =>
                            void runDirectAction('Issue contribution request', () =>
                              issueMembershipContributionRequest({ membershipId: m.id, expectedRev: m.rev }),
                            )
                          }
                          className="crm-btn-primary min-h-11"
                        >
                          Request contribution
                        </button>
                      )}
                      {m.effectiveState === 'awaiting_contribution' && (
                        <>
                          <button
                            type="button"
                            disabled={busy || isOffline}
                            onClick={() =>
                              void runDirectAction('Activate membership', () =>
                                activateMembership({ membershipId: m.id, expectedRev: m.rev }),
                              )
                            }
                            className="crm-btn-primary min-h-11"
                          >
                            Activate
                          </button>
                          <Link to="/crm/money" className="crm-btn-secondary min-h-11">
                            Record receipt
                          </Link>
                        </>
                      )}
                      {(m.effectiveState === 'renewal_due' || m.effectiveState === 'lapsed') && (
                        <button
                          type="button"
                          disabled={busy || isOffline}
                          onClick={() =>
                            void runDirectAction('Renew membership', () =>
                              renewMembership({ membershipId: m.id, expectedRev: m.rev }),
                            )
                          }
                          className="crm-btn-primary min-h-11"
                        >
                          Renew
                        </button>
                      )}
                      {m.effectiveState !== 'cancelled' && m.effectiveState !== 'declined' && (
                        <button
                          type="button"
                          disabled={busy || isOffline}
                          onClick={() => setActionMembership({ kind: 'cancel', membership: m })}
                          className="crm-btn-secondary min-h-11"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="crm-table-wrap" role="region" aria-label="Memberships table" tabIndex={0}>
              <table className="crm-table">
                <thead>
                  <tr>
                    <th scope="col" className="crm-sticky-col">Member</th>
                    <th scope="col">Scheme</th>
                    <th scope="col">Identifier</th>
                    <th scope="col">State</th>
                    <th scope="col">Payment</th>
                    <th scope="col">Valid until</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.memberships.map((m) => {
                    const badge = membershipBadgeStyle(m.effectiveState);
                    return (
                      <tr key={m.id}>
                        <td className="crm-sticky-col">
                          <div className="font-semibold">{m.personName ?? m.personId}</div>
                          <div className="text-[11px] text-[var(--crm-text-muted)]">{m.id}</div>
                        </td>
                        <td>{m.schemeName}</td>
                        <td className="crm-tabular">{m.memberIdentifier ?? '—'}</td>
                        <td>
                          <span
                            className="inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase"
                            style={{ backgroundColor: badge.bg, color: badge.fg }}
                          >
                            {m.effectiveState.replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td className="capitalize">{m.paymentStatus.replace(/_/g, ' ')}</td>
                        <td className="crm-tabular">
                          {m.validUntil ? new Date(m.validUntil).toLocaleDateString() : '—'}
                        </td>
                        <td>
                          <div className="flex flex-wrap gap-1.5">
                            {m.effectiveState === 'applied' && (
                              <button
                                type="button"
                                disabled={busy || isOffline}
                                onClick={() => {
                                  setActionMembership({ kind: 'decide', membership: m });
                                  setDecisionKind('approve');
                                }}
                                className="crm-btn-primary !min-h-11 !text-xs"
                              >
                                Review
                              </button>
                            )}
                            {m.effectiveState === 'approved' && (
                              <button
                                type="button"
                                disabled={busy || isOffline}
                                onClick={() =>
                                  void runDirectAction('Issue contribution request', () =>
                                    issueMembershipContributionRequest({ membershipId: m.id, expectedRev: m.rev }),
                                  )
                                }
                                className="crm-btn-primary !min-h-11 !text-xs"
                              >
                                Request fee
                              </button>
                            )}
                            {m.effectiveState === 'awaiting_contribution' && (
                              <button
                                type="button"
                                disabled={busy || isOffline}
                                onClick={() =>
                                  void runDirectAction('Activate membership', () =>
                                    activateMembership({ membershipId: m.id, expectedRev: m.rev }),
                                  )
                                }
                                className="crm-btn-primary !min-h-11 !text-xs"
                              >
                                <CheckCircle2 size={13} aria-hidden="true" />
                                <span>Activate</span>
                              </button>
                            )}
                            {(m.effectiveState === 'renewal_due' || m.effectiveState === 'lapsed') && (
                              <button
                                type="button"
                                disabled={busy || isOffline}
                                onClick={() =>
                                  void runDirectAction('Renew membership', () =>
                                    renewMembership({ membershipId: m.id, expectedRev: m.rev }),
                                  )
                                }
                                className="crm-btn-primary !min-h-11 !text-xs"
                              >
                                Renew
                              </button>
                            )}
                            {m.effectiveState !== 'cancelled' && m.effectiveState !== 'declined' && (
                              <button
                                type="button"
                                disabled={busy || isOffline}
                                onClick={() => setActionMembership({ kind: 'cancel', membership: m })}
                                className="crm-btn-secondary !min-h-11 !text-xs"
                              >
                                <XCircle size={13} aria-hidden="true" />
                                <span>Cancel</span>
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Configure Scheme Modal */}
      {schemeModalOpen && (
        <AdaptiveDialog
          title={editingScheme ? `Edit scheme: ${editingScheme.name}` : 'Configure Common Roots scheme'}
          onClose={() => setSchemeModalOpen(false)}
        >
          <form onSubmit={(e) => void handleSaveScheme(e)} data-app="crm" className="space-y-3 p-1 text-xs">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="font-medium">Slug</span>
                <input
                  type="text"
                  required
                  className="crm-input min-h-11"
                  value={scSlug}
                  onChange={(e) => setScSlug(e.target.value)}
                />
              </label>
              <label className="block space-y-1">
                <span className="font-medium">Name</span>
                <input
                  type="text"
                  required
                  className="crm-input min-h-11"
                  value={scName}
                  onChange={(e) => setScName(e.target.value)}
                />
              </label>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="font-medium">Contribution amount (INR, optional until O-07)</span>
                <input
                  type="number"
                  min={1}
                  step="1"
                  className="crm-input min-h-11"
                  value={scAmountMajor}
                  onChange={(e) => setScAmountMajor(e.target.value)}
                  placeholder="Unconfigured"
                />
              </label>
              <label className="block space-y-1">
                <span className="font-medium">Currency</span>
                <input
                  type="text"
                  maxLength={3}
                  className="crm-input min-h-11 uppercase"
                  value={scCurrency}
                  onChange={(e) => setScCurrency(e.target.value)}
                />
              </label>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="font-medium">Validity (days)</span>
                <input
                  type="number"
                  min={1}
                  className="crm-input min-h-11"
                  value={scValidityDays}
                  onChange={(e) => setScValidityDays(e.target.value)}
                  placeholder="e.g. 365"
                />
              </label>
              <label className="block space-y-1">
                <span className="font-medium">Renewal notice (days before expiry)</span>
                <input
                  type="number"
                  min={1}
                  className="crm-input min-h-11"
                  value={scNoticeDays}
                  onChange={(e) => setScNoticeDays(e.target.value)}
                  placeholder="e.g. 30"
                />
              </label>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="font-medium">Identifier prefix (optional)</span>
                <input
                  type="text"
                  className="crm-input min-h-11"
                  value={scPrefix}
                  onChange={(e) => setScPrefix(e.target.value)}
                  placeholder="e.g. CR"
                />
              </label>
              <label className="block space-y-1">
                <span className="font-medium">Identifier digits</span>
                <input
                  type="number"
                  min={2}
                  max={10}
                  className="crm-input min-h-11"
                  value={scDigits}
                  onChange={(e) => setScDigits(e.target.value)}
                />
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setSchemeModalOpen(false)} className="crm-btn-secondary min-h-11">
                Cancel
              </button>
              <button type="submit" disabled={busy} className="crm-btn-primary min-h-11">
                Save scheme
              </button>
            </div>
          </form>
        </AdaptiveDialog>
      )}

      {/* Apply Membership Modal */}
      {applyModalOpen && data && (
        <AdaptiveDialog title="New Common Roots membership application" onClose={() => setApplyModalOpen(false)}>
          <form onSubmit={(e) => void handleApply(e)} data-app="crm" className="space-y-3 p-1 text-xs">
            <label className="block space-y-1">
              <span className="font-medium">Scheme</span>
              <select
                className="crm-select min-h-11"
                value={appSchemeId}
                onChange={(e) => setAppSchemeId(e.target.value)}
              >
                {data.schemes.map((sc) => (
                  <option key={sc.id} value={sc.id}>
                    {sc.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="font-medium">Person</span>
              {peopleOptions.length > 0 ? (
                <select
                  className="crm-select min-h-11"
                  value={appPersonId}
                  onChange={(e) => setAppPersonId(e.target.value)}
                >
                  <option value="">Select person…</option>
                  {peopleOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  required
                  className="crm-input min-h-11"
                  value={appPersonId}
                  onChange={(e) => setAppPersonId(e.target.value)}
                  placeholder="Person record ID"
                />
              )}
            </label>
            <label className="block space-y-1">
              <span className="font-medium">Notes</span>
              <input
                type="text"
                className="crm-input min-h-11"
                value={appNotes}
                onChange={(e) => setAppNotes(e.target.value)}
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setApplyModalOpen(false)} className="crm-btn-secondary min-h-11">
                Cancel
              </button>
              <button type="submit" disabled={busy} className="crm-btn-primary min-h-11">
                Submit application
              </button>
            </div>
          </form>
        </AdaptiveDialog>
      )}

      {/* Review / Cancel Membership Modal */}
      {actionMembership && (
        <AdaptiveDialog
          title={
            actionMembership.kind === 'decide'
              ? 'Review membership application'
              : 'Cancel membership'
          }
          onClose={() => setActionMembership(null)}
        >
          <form onSubmit={(e) => void handleConfirmAction(e)} data-app="crm" className="space-y-3 p-1 text-xs">
            {actionMembership.kind === 'decide' && (
              <label className="block space-y-1">
                <span className="font-medium">Decision</span>
                <select
                  className="crm-select min-h-11"
                  value={decisionKind}
                  onChange={(e) => setDecisionKind(e.target.value as 'approve' | 'decline')}
                >
                  <option value="approve">Approve</option>
                  <option value="decline">Decline</option>
                </select>
              </label>
            )}
            <label className="block space-y-1">
              <span className="font-medium">Reason</span>
              <input
                type="text"
                required
                className="crm-input min-h-11"
                value={decisionReason}
                onChange={(e) => setDecisionReason(e.target.value)}
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setActionMembership(null)} className="crm-btn-secondary min-h-11">
                Cancel
              </button>
              <button type="submit" disabled={busy} className="crm-btn-primary min-h-11">
                Confirm
              </button>
            </div>
          </form>
        </AdaptiveDialog>
      )}
    </div>
  );
}
