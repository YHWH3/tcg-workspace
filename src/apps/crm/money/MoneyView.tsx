import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CloudOff,
  FileWarning,
  IndianRupee,
  Lock,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import type { CrmStatus } from '../../../../shared/crm/contracts';
import {
  formatMinorMoney,
  type CrmLedgerEntryDto,
  type CrmRefundRequestDto,
  type MoneyOverviewResponse,
} from '../../../../shared/crm/operations';
import { authStore } from '../../../core/auth';
import { useLayoutMode } from '../../../core/mobile';
import { useStore } from '../../../core/store';
import { onlineStore } from '../../../core/sync/engine';
import { AdaptiveDialog } from '../../../core/ui';
import {
  configureRefundPolicy,
  createPaymentRequest,
  decideRefund,
  describeCommandError,
  fetchMoneyOverview,
  isIdentityChangedError,
  issueRefund,
  recordManualReceipt,
  requestRefund,
  reverseLedgerEntry,
} from '../api';

type MoneyTab = 'requests' | 'ledger' | 'refunds' | 'policy';

export function MoneyView({ status }: { status: CrmStatus }) {
  const layout = useLayoutMode();
  const isOffline = !useStore(onlineStore);
  const currentUser = useStore(authStore).user;
  const uid = currentUser?.id ?? null;

  const canReadFinance =
    status.owner ||
    status.capabilities.some(
      (c) => c.capability === 'crm.finance.read' || c.capability === 'crm.finance.record',
    );
  const canConfigure = status.owner || status.capabilities.some((c) => c.capability === 'crm.configure');

  const [tab, setTab] = useState<MoneyTab>('requests');
  const [data, setData] = useState<MoneyOverviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Dialogs
  const [reqModalOpen, setReqModalOpen] = useState(false);
  const [receiptModalOpen, setReceiptModalOpen] = useState(false);
  const [refundModalOpen, setRefundModalOpen] = useState(false);
  const [reversingEntry, setReversingEntry] = useState<CrmLedgerEntryDto | null>(null);
  const [decidingRefund, setDecidingRefund] = useState<CrmRefundRequestDto | null>(null);
  const [issuingRefund, setIssuingRefund] = useState<CrmRefundRequestDto | null>(null);

  // Form states
  const [objType, setObjType] = useState<'booking' | 'membership'>('booking');
  const [objId, setObjId] = useState('');
  const [amountMajor, setAmountMajor] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [reqLabel, setReqLabel] = useState('');

  const [rcptPaymentReqId, setRcptPaymentReqId] = useState('');
  const [rcptEvidenceKind, setRcptEvidenceKind] = useState<'bank_reference' | 'proof_file' | 'cash_voucher'>('bank_reference');
  const [rcptEvidenceRef, setRcptEvidenceRef] = useState('');
  const [rcptNote, setRcptNote] = useState('');
  const [rcptResidency, setRcptResidency] = useState<'domestic' | 'foreign'>('domestic');

  const [revReason, setRevReason] = useState('');
  const [refReason, setRefReason] = useState('');
  const [refDecision, setRefDecision] = useState<'approve' | 'reject'>('approve');
  const [refDecisionNote, setRefDecisionNote] = useState('');
  const [refIssueRef, setRefIssueRef] = useState('');
  const [policyThresholdMajor, setPolicyThresholdMajor] = useState('');

  // Clear financial state when signed-in account or capability set changes
  useEffect(() => {
    setData(null);
    setError(null);
    setNotice(null);
  }, [uid, status.owner, status.capabilities.length]);

  const loadMoney = useCallback(async () => {
    if (isOffline || !canReadFinance) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchMoneyOverview();
      setData(res);
      const inrPolicy = res.refundPolicies.find((p) => p.currency === 'INR');
      setPolicyThresholdMajor(
        inrPolicy && inrPolicy.dualApprovalThresholdMinor !== null
          ? String(inrPolicy.dualApprovalThresholdMinor / 100)
          : '',
      );
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setLoading(false);
    }
  }, [isOffline, canReadFinance]);

  useEffect(() => {
    void loadMoney();
  }, [loadMoney]);

  if (!canReadFinance) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-10">
        <section className="crm-panel space-y-2 p-6">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--crm-surface-2)]">
            <Lock size={18} aria-hidden="true" />
          </div>
          <h1 className="text-lg font-semibold">Finance access required</h1>
          <p className="text-sm text-[var(--crm-text-muted)]">
            Viewing payment requests, the append-only financial ledger, and programme income requires the{' '}
            <code>crm.finance.read</code> capability.
          </p>
        </section>
      </div>
    );
  }

  const handleCreateRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || isOffline) return;
    const minor = Math.round(Number(amountMajor) * 100);
    if (!objId.trim() || !Number.isFinite(minor) || minor <= 0) {
      setError('Enter a valid booking/membership ID and positive amount.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await createPaymentRequest({
        objectType: objType,
        objectId: objId.trim(),
        amountMinor: minor,
        currency: currency.trim().toUpperCase(),
        label: reqLabel.trim() || undefined,
      });
      if (!res.ok) {
        setError(describeCommandError(res));
        return;
      }
      setReqModalOpen(false);
      setNotice(`Created payment request ${res.result.paymentRequest.id}.`);
      await loadMoney();
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRecordReceipt = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || isOffline) return;
    const minor = Math.round(Number(amountMajor) * 100);
    if (!objId.trim() || !rcptEvidenceRef.trim() || !Number.isFinite(minor) || minor <= 0) {
      setError('Enter object ID, positive amount, and evidence reference.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await recordManualReceipt({
        objectType: objType,
        objectId: objId.trim(),
        paymentRequestId: rcptPaymentReqId.trim() || null,
        amountMinor: minor,
        currency: currency.trim().toUpperCase(),
        evidenceKind: rcptEvidenceKind,
        evidenceRef: rcptEvidenceRef.trim(),
        evidenceNote: rcptNote.trim() || null,
        contributorResidency: rcptResidency,
      });
      if (!res.ok) {
        setError(describeCommandError(res));
        return;
      }
      setReceiptModalOpen(false);
      setRcptEvidenceRef('');
      setRcptNote('');
      setNotice(
        res.result.paidWithoutSeat
          ? 'Receipt recorded in append-only ledger. WARNING: booking hold had expired — flagged as paid_without_seat!'
          : `Receipt recorded (${res.result.paymentStatus.replace(/_/g, ' ')}).`,
      );
      await loadMoney();
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleReverse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reversingEntry || !revReason.trim() || busy || isOffline) return;
    setBusy(true);
    setError(null);
    try {
      const res = await reverseLedgerEntry({
        entryId: reversingEntry.id,
        reason: revReason.trim(),
      });
      if (!res.ok) {
        setError(describeCommandError(res));
        return;
      }
      setReversingEntry(null);
      setRevReason('');
      setNotice(`Recorded compensating reversal entry ${res.result.reversalEntry.id}.`);
      await loadMoney();
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRequestRefund = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || isOffline) return;
    const minor = Math.round(Number(amountMajor) * 100);
    if (!objId.trim() || !refReason.trim() || !Number.isFinite(minor) || minor <= 0) {
      setError('Enter object ID, positive refund amount, and reason.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await requestRefund({
        objectType: objType,
        objectId: objId.trim(),
        amountMinor: minor,
        currency: currency.trim().toUpperCase(),
        reason: refReason.trim(),
      });
      if (!res.ok) {
        setError(describeCommandError(res));
        return;
      }
      setRefundModalOpen(false);
      setRefReason('');
      setNotice(
        res.result.refundRequest.requiresIndependentApproval
          ? 'Refund requested — requires independent approval from another authorised reviewer.'
          : 'Refund requested.',
      );
      await loadMoney();
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDecideRefund = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!decidingRefund || !refDecisionNote.trim() || busy || isOffline) return;
    setBusy(true);
    setError(null);
    try {
      const res = await decideRefund({
        refundRequestId: decidingRefund.id,
        decision: refDecision,
        note: refDecisionNote.trim(),
        expectedRev: decidingRefund.rev,
      });
      if (!res.ok) {
        setError(describeCommandError(res));
        return;
      }
      setDecidingRefund(null);
      setRefDecisionNote('');
      setNotice(`Refund ${res.result.refundRequest.state}.`);
      await loadMoney();
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleIssueRefund = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!issuingRefund || !refIssueRef.trim() || busy || isOffline) return;
    setBusy(true);
    setError(null);
    try {
      const res = await issueRefund({
        refundRequestId: issuingRefund.id,
        evidenceRef: refIssueRef.trim(),
        expectedRev: issuingRefund.rev,
      });
      if (!res.ok) {
        setError(describeCommandError(res));
        return;
      }
      setIssuingRefund(null);
      setRefIssueRef('');
      setNotice(`Refund issued and appended to ledger (${res.result.ledgerEntry.id}).`);
      await loadMoney();
    } catch (err) {
      if (!isIdentityChangedError(err)) setError(describeCommandError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSavePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || isOffline) return;
    const thresholdMinor = policyThresholdMajor.trim()
      ? Math.round(Number(policyThresholdMajor) * 100)
      : null;
    setBusy(true);
    setError(null);
    try {
      const res = await configureRefundPolicy({
        currency: 'INR',
        dualApprovalThresholdMinor: thresholdMinor,
      });
      if (!res.ok) {
        setError(describeCommandError(res));
        return;
      }
      setNotice('Saved refund approval policy for INR.');
      await loadMoney();
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
          <p className="text-xs font-medium text-[var(--crm-text-muted)]">Operations · S7 Manual Finance</p>
          <h1 className="mt-0.5 text-xl font-semibold leading-tight">Money &amp; Append-Only Ledger</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={loading || isOffline}
            onClick={() => void loadMoney()}
            className="crm-btn-secondary min-h-11"
          >
            <RefreshCw size={14} aria-hidden="true" className={loading ? 'animate-spin' : ''} />
            <span>Refresh</span>
          </button>
          {data?.canRecordFinance && (
            <>
              <button
                type="button"
                disabled={isOffline}
                onClick={() => setReqModalOpen(true)}
                className="crm-btn-secondary min-h-11"
              >
                <Plus size={14} aria-hidden="true" />
                <span>Payment request</span>
              </button>
              <button
                type="button"
                disabled={isOffline}
                onClick={() => setReceiptModalOpen(true)}
                className="crm-btn-primary min-h-11"
              >
                <IndianRupee size={14} aria-hidden="true" />
                <span>Record manual receipt</span>
              </button>
            </>
          )}
        </div>
      </header>

      {isOffline && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg border border-[var(--crm-warn-border)] bg-[var(--crm-warn-bg)] px-4 py-3 text-xs text-[var(--crm-warn-text)]"
        >
          <CloudOff size={15} aria-hidden="true" />
          <span>Offline: recording receipts, reversals, and refunds requires a live server connection.</span>
        </div>
      )}

      {/* Policy Guardrails Banner */}
      <div className="crm-panel flex flex-wrap items-start gap-3 p-4 text-xs text-[var(--crm-text-muted)]">
        <FileWarning size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--crm-primary)]" />
        <div className="space-y-1">
          <p className="font-semibold text-[var(--crm-text)]">
            Append-only integer ledger · Domestic INR only (O-14 / C-03) · No statutory/GST invoice generation (O-10)
          </p>
          <p>
            Ledger entries can never be edited or deleted — corrections require a compensating reversal entry. Foreign contributors and non-INR currencies are blocked pending policy sign-off.
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

      {/* Per-currency isolated totals */}
      {data && (
        <section aria-label="Per-currency ledger totals" className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-xs">
            {data.totalsByCurrency.length === 0 ? (
              <div className="crm-panel p-4 text-[var(--crm-text-muted)]">
                No ledger entries recorded yet.
              </div>
            ) : (
              data.totalsByCurrency.map((tot) => (
                <div key={tot.currency} className="crm-panel space-y-1.5 p-4">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-[var(--crm-text)]">Ledger ({tot.currency})</span>
                    <span className="rounded-full bg-[var(--crm-primary-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--crm-primary)]">
                      Isolated currency
                    </span>
                  </div>
                  <p className="crm-tabular text-lg font-semibold">
                    Net: {formatMinorMoney(tot.netMinor, tot.currency)}
                  </p>
                  <p className="crm-tabular text-[11px] text-[var(--crm-text-muted)]">
                    Receipts {formatMinorMoney(tot.receiptsMinor, tot.currency)} · Reversals{' '}
                    {formatMinorMoney(tot.reversalsMinor, tot.currency)} · Refunds{' '}
                    {formatMinorMoney(tot.refundsMinor, tot.currency)}
                  </p>
                </div>
              ))
            )}
          </div>

          {data.programmeIncomeByCurrency.length > 0 && (
            <div className="crm-panel p-4 text-xs space-y-2">
              <h2 className="font-semibold">Programme income by currency</h2>
              <div className="flex flex-wrap gap-2">
                {data.programmeIncomeByCurrency.map((row) => (
                  <div
                    key={`${row.programmeSlug}:${row.currency}`}
                    className="rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] px-3 py-2"
                  >
                    <p className="font-semibold">{row.programmeSlug}</p>
                    <p className="crm-tabular text-[var(--crm-text-muted)]">
                      {row.currency} net {formatMinorMoney(row.netMinor, row.currency)}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Navigation Tabs */}
      <div role="tablist" aria-label="Money sections" className="flex flex-wrap gap-2">
        {(
          [
            ['requests', `Payment requests (${data?.paymentRequests.length ?? 0})`],
            ['ledger', `Append-only ledger (${data?.ledgerEntries.length ?? 0})`],
            ['refunds', `Refunds (${data?.refundRequests.length ?? 0})`],
            ['policy', 'Refund policy (O-09)'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`min-h-11 rounded-lg border px-3.5 text-xs font-medium ${
              tab === id
                ? 'border-[var(--crm-primary)] bg-[var(--crm-primary-soft)] text-[var(--crm-primary)] font-semibold'
                : 'border-[var(--crm-border)] bg-[var(--crm-surface)] text-[var(--crm-text-muted)]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab 1: Payment Requests */}
      {tab === 'requests' && data && (
        <section aria-label="Payment requests" className="space-y-3">
          {data.paymentRequests.length === 0 ? (
            <div className="crm-panel p-6 text-center text-xs text-[var(--crm-text-muted)]">
              No payment requests yet.
            </div>
          ) : layout === 'compact' ? (
            <ul className="space-y-2.5">
              {data.paymentRequests.map((pr) => (
                <li key={pr.id} className="crm-panel space-y-1.5 p-4 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{pr.label ?? `${pr.objectType} ${pr.objectId}`}</span>
                    <span className="rounded-full bg-[var(--crm-surface-2)] px-2 py-0.5 text-[10px] font-semibold uppercase">
                      {pr.state.replace(/_/g, ' ')}
                    </span>
                  </div>
                  <p className="crm-tabular font-semibold">{formatMinorMoney(pr.amountMinor, pr.currency)}</p>
                  <p className="text-[11px] text-[var(--crm-text-muted)]">
                    {pr.objectType} · {pr.objectId}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <div className="crm-table-wrap" role="region" aria-label="Payment requests table" tabIndex={0}>
              <table className="crm-table">
                <thead>
                  <tr>
                    <th scope="col" className="crm-sticky-col">Reference</th>
                    <th scope="col">Object</th>
                    <th scope="col">Amount</th>
                    <th scope="col">State</th>
                  </tr>
                </thead>
                <tbody>
                  {data.paymentRequests.map((pr) => (
                    <tr key={pr.id}>
                      <td className="crm-sticky-col">
                        <div className="font-semibold">{pr.label ?? pr.id}</div>
                        <div className="text-[11px] text-[var(--crm-text-muted)]">{pr.id}</div>
                      </td>
                      <td>
                        {pr.objectType} · {pr.objectId}
                      </td>
                      <td className="crm-tabular font-semibold">{formatMinorMoney(pr.amountMinor, pr.currency)}</td>
                      <td className="uppercase text-xs">{pr.state.replace(/_/g, ' ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Tab 2: Append-Only Ledger */}
      {tab === 'ledger' && data && (
        <section aria-label="Append-only ledger" className="space-y-3">
          {data.ledgerEntries.length === 0 ? (
            <div className="crm-panel p-6 text-center text-xs text-[var(--crm-text-muted)]">
              No ledger entries yet.
            </div>
          ) : layout === 'compact' ? (
            <ul className="space-y-2.5">
              {data.ledgerEntries.map((entry) => (
                <li key={entry.id} className="crm-panel space-y-2 p-4 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold uppercase">{entry.kind}</span>
                    <span className="crm-tabular font-semibold">
                      {formatMinorMoney(entry.amountMinor, entry.currency)}
                    </span>
                  </div>
                  <p className="text-[var(--crm-text-muted)]">
                    {entry.evidenceKind.replace(/_/g, ' ')}: {entry.evidenceRef}
                  </p>
                  <p className="text-[11px] text-[var(--crm-text-muted)]">
                    {entry.objectType} {entry.objectId} · {new Date(entry.recordedAt).toLocaleString()}
                  </p>
                  {data.canRecordFinance && entry.kind === 'receipt' && (
                    <button
                      type="button"
                      disabled={isOffline}
                      onClick={() => setReversingEntry(entry)}
                      className="crm-btn-secondary w-full min-h-11"
                    >
                      <RotateCcw size={13} aria-hidden="true" />
                      <span>Record compensating reversal</span>
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="crm-table-wrap" role="region" aria-label="Append-only ledger table" tabIndex={0}>
              <table className="crm-table">
                <thead>
                  <tr>
                    <th scope="col" className="crm-sticky-col">Entry</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Evidence</th>
                    <th scope="col">Recorded</th>
                    <th scope="col">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.ledgerEntries.map((entry) => (
                    <tr key={entry.id}>
                      <td className="crm-sticky-col">
                        <div className="font-semibold">
                          {entry.objectType} · {entry.objectId}
                        </div>
                        <div className="text-[11px] text-[var(--crm-text-muted)]">{entry.id}</div>
                      </td>
                      <td className="uppercase text-xs">{entry.kind}</td>
                      <td className="crm-tabular font-semibold">
                        {formatMinorMoney(entry.amountMinor, entry.currency)}
                      </td>
                      <td>
                        <div>{entry.evidenceRef}</div>
                        <div className="text-[11px] text-[var(--crm-text-muted)]">
                          {entry.evidenceKind.replace(/_/g, ' ')}
                        </div>
                      </td>
                      <td className="crm-tabular text-xs">{new Date(entry.recordedAt).toLocaleString()}</td>
                      <td>
                        {data.canRecordFinance && entry.kind === 'receipt' ? (
                          <button
                            type="button"
                            disabled={isOffline}
                            onClick={() => setReversingEntry(entry)}
                            className="crm-btn-secondary !min-h-11 !text-xs"
                          >
                            <RotateCcw size={13} aria-hidden="true" />
                            <span>Reverse</span>
                          </button>
                        ) : (
                          <span className="text-[11px] text-[var(--crm-text-muted)]">Immutable</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Tab 3: Refunds & Dual-Control Approvals */}
      {tab === 'refunds' && data && (
        <section aria-label="Refund requests" className="space-y-3">
          {data.canRecordFinance && (
            <div className="flex justify-end">
              <button
                type="button"
                disabled={isOffline}
                onClick={() => setRefundModalOpen(true)}
                className="crm-btn-primary min-h-11"
              >
                <Plus size={14} aria-hidden="true" />
                <span>Request refund</span>
              </button>
            </div>
          )}
          {data.refundRequests.length === 0 ? (
            <div className="crm-panel p-6 text-center text-xs text-[var(--crm-text-muted)]">
              No refund requests yet.
            </div>
          ) : (
            <ul className="space-y-2.5">
              {data.refundRequests.map((rf) => {
                const isSelf = uid !== null && rf.requestedBy === uid;
                return (
                  <li key={rf.id} className="crm-panel space-y-2 p-4 text-xs">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-semibold">
                          {formatMinorMoney(rf.amountMinor, rf.currency)} · {rf.objectType} {rf.objectId}
                        </p>
                        <p className="text-[var(--crm-text-muted)]">Reason: {rf.reason}</p>
                        {rf.decisionNote && (
                          <p className="text-[11px] text-[var(--crm-text-muted)]">
                            Review note: {rf.decisionNote}
                          </p>
                        )}
                      </div>
                      <span className="rounded-full bg-[var(--crm-surface-2)] px-2.5 py-0.5 text-[10px] font-semibold uppercase">
                        {rf.state}
                      </span>
                    </div>

                    {rf.requiresIndependentApproval && rf.state === 'requested' && (
                      <p className="flex items-center gap-1.5 text-[11px] text-[var(--crm-warn-text)]">
                        <AlertTriangle size={13} aria-hidden="true" />
                        <span>
                          Independent approval required from a second person with <code>crm.refund.approve</code>.
                        </span>
                      </p>
                    )}

                    <div className="flex flex-wrap gap-2 pt-1">
                      {rf.state === 'requested' && data.canApproveRefunds && (
                        <button
                          type="button"
                          disabled={isSelf || isOffline || busy}
                          title={isSelf ? 'You cannot approve a refund you requested' : undefined}
                          onClick={() => {
                            setDecidingRefund(rf);
                            setRefDecision('approve');
                          }}
                          className="crm-btn-primary min-h-11"
                        >
                          <ShieldCheck size={14} aria-hidden="true" />
                          <span>{isSelf ? 'Self-approval blocked' : 'Review refund'}</span>
                        </button>
                      )}
                      {(rf.state === 'approved' ||
                        (rf.state === 'requested' && !rf.requiresIndependentApproval)) &&
                        data.canRecordFinance && (
                          <button
                            type="button"
                            disabled={isOffline || busy}
                            onClick={() => setIssuingRefund(rf)}
                            className="crm-btn-secondary min-h-11"
                          >
                            <CheckCircle2 size={14} aria-hidden="true" />
                            <span>Record payout</span>
                          </button>
                        )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {/* Tab 4: Refund Dual-Approval Policy (O-09) */}
      {tab === 'policy' && (
        <section aria-label="Refund approval policy" className="crm-panel space-y-3 p-5 text-xs">
          <h2 className="text-sm font-semibold">Refund dual-approval threshold (O-09)</h2>
          <p className="text-[var(--crm-text-muted)]">
            When no threshold is configured, independent approval from a second person with{' '}
            <code>crm.refund.approve</code> is required for every refund (fail-closed). Foreign contributions remain unconditionally disabled pending O-14 / C-03.
          </p>
          <form onSubmit={(e) => void handleSavePolicy(e)} className="flex flex-wrap items-end gap-3">
            <label className="min-w-[14rem] flex-1 space-y-1">
              <span className="font-medium">INR threshold (leave blank = always require independent approval)</span>
              <input
                type="number"
                min={0}
                step="1"
                disabled={!canConfigure || isOffline}
                className="crm-input min-h-11"
                value={policyThresholdMajor}
                onChange={(e) => setPolicyThresholdMajor(e.target.value)}
                placeholder="Unconfigured (strict)"
              />
            </label>
            {canConfigure && (
              <button type="submit" disabled={busy || isOffline} className="crm-btn-primary min-h-11">
                Save policy
              </button>
            )}
          </form>
        </section>
      )}

      {/* Payment Request Modal */}
      {reqModalOpen && (
        <AdaptiveDialog title="Create payment request" onClose={() => setReqModalOpen(false)}>
          <form onSubmit={(e) => void handleCreateRequest(e)} data-app="crm" className="space-y-3 p-1 text-xs">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="font-medium">Object type</span>
                <select
                  className="crm-select min-h-11"
                  value={objType}
                  onChange={(e) => setObjType(e.target.value as 'booking' | 'membership')}
                >
                  <option value="booking">Booking</option>
                  <option value="membership">Membership</option>
                </select>
              </label>
              <label className="block space-y-1">
                <span className="font-medium">Object ID</span>
                <input
                  type="text"
                  required
                  className="crm-input min-h-11"
                  value={objId}
                  onChange={(e) => setObjId(e.target.value)}
                  placeholder="bk_... or mem_..."
                />
              </label>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="font-medium">Amount</span>
                <input
                  type="number"
                  required
                  min={1}
                  step="0.01"
                  className="crm-input min-h-11"
                  value={amountMajor}
                  onChange={(e) => setAmountMajor(e.target.value)}
                />
              </label>
              <label className="block space-y-1">
                <span className="font-medium">Currency (ISO 4217)</span>
                <input
                  type="text"
                  required
                  maxLength={3}
                  className="crm-input min-h-11 uppercase"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                />
              </label>
            </div>
            <label className="block space-y-1">
              <span className="font-medium">Label</span>
              <input
                type="text"
                className="crm-input min-h-11"
                value={reqLabel}
                onChange={(e) => setReqLabel(e.target.value)}
                placeholder="e.g. Programme fee"
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setReqModalOpen(false)} className="crm-btn-secondary min-h-11">
                Cancel
              </button>
              <button type="submit" disabled={busy} className="crm-btn-primary min-h-11">
                Create request
              </button>
            </div>
          </form>
        </AdaptiveDialog>
      )}

      {/* Manual Receipt Modal */}
      {receiptModalOpen && (
        <AdaptiveDialog title="Record manual receipt (append-only)" onClose={() => setReceiptModalOpen(false)}>
          <form onSubmit={(e) => void handleRecordReceipt(e)} data-app="crm" className="space-y-3 p-1 text-xs">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="font-medium">Object type</span>
                <select
                  className="crm-select min-h-11"
                  value={objType}
                  onChange={(e) => setObjType(e.target.value as 'booking' | 'membership')}
                >
                  <option value="booking">Booking</option>
                  <option value="membership">Membership</option>
                </select>
              </label>
              <label className="block space-y-1">
                <span className="font-medium">Object ID</span>
                <input
                  type="text"
                  required
                  className="crm-input min-h-11"
                  value={objId}
                  onChange={(e) => setObjId(e.target.value)}
                />
              </label>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="block space-y-1">
                <span className="font-medium">Amount</span>
                <input
                  type="number"
                  required
                  min={1}
                  step="0.01"
                  className="crm-input min-h-11"
                  value={amountMajor}
                  onChange={(e) => setAmountMajor(e.target.value)}
                />
              </label>
              <label className="block space-y-1">
                <span className="font-medium">Currency</span>
                <input
                  type="text"
                  required
                  maxLength={3}
                  className="crm-input min-h-11 uppercase"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                />
              </label>
              <label className="block space-y-1">
                <span className="font-medium">Contributor</span>
                <select
                  className="crm-select min-h-11"
                  value={rcptResidency}
                  onChange={(e) => setRcptResidency(e.target.value as 'domestic' | 'foreign')}
                >
                  <option value="domestic">Domestic</option>
                  <option value="foreign">Foreign (blocked)</option>
                </select>
              </label>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="font-medium">Evidence kind</span>
                <select
                  className="crm-select min-h-11"
                  value={rcptEvidenceKind}
                  onChange={(e) =>
                    setRcptEvidenceKind(e.target.value as 'bank_reference' | 'proof_file' | 'cash_voucher')
                  }
                >
                  <option value="bank_reference">Bank / UPI reference</option>
                  <option value="proof_file">Proof file ID</option>
                  <option value="cash_voucher">Cash voucher</option>
                </select>
              </label>
              <label className="block space-y-1">
                <span className="font-medium">Evidence reference</span>
                <input
                  type="text"
                  required
                  className="crm-input min-h-11"
                  value={rcptEvidenceRef}
                  onChange={(e) => setRcptEvidenceRef(e.target.value)}
                  placeholder="UTR / voucher #"
                />
              </label>
            </div>
            <label className="block space-y-1">
              <span className="font-medium">Payment request ID (optional)</span>
              <input
                type="text"
                className="crm-input min-h-11"
                value={rcptPaymentReqId}
                onChange={(e) => setRcptPaymentReqId(e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span className="font-medium">Note (optional)</span>
              <input
                type="text"
                className="crm-input min-h-11"
                value={rcptNote}
                onChange={(e) => setRcptNote(e.target.value)}
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setReceiptModalOpen(false)} className="crm-btn-secondary min-h-11">
                Cancel
              </button>
              <button type="submit" disabled={busy} className="crm-btn-primary min-h-11">
                Append receipt
              </button>
            </div>
          </form>
        </AdaptiveDialog>
      )}

      {/* Reversal Modal */}
      {reversingEntry && (
        <AdaptiveDialog title={`Reverse ledger entry ${reversingEntry.id}`} onClose={() => setReversingEntry(null)}>
          <form onSubmit={(e) => void handleReverse(e)} data-app="crm" className="space-y-3 p-1 text-xs">
            <p className="text-[var(--crm-text-muted)]">
              Appends a compensating negative entry for {formatMinorMoney(reversingEntry.amountMinor, reversingEntry.currency)}. The original entry remains immutable.
            </p>
            <label className="block space-y-1">
              <span className="font-medium">Reversal reason</span>
              <input
                type="text"
                required
                className="crm-input min-h-11"
                value={revReason}
                onChange={(e) => setRevReason(e.target.value)}
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setReversingEntry(null)} className="crm-btn-secondary min-h-11">
                Cancel
              </button>
              <button type="submit" disabled={busy} className="crm-btn-primary min-h-11">
                Append reversal
              </button>
            </div>
          </form>
        </AdaptiveDialog>
      )}

      {/* Request Refund Modal */}
      {refundModalOpen && (
        <AdaptiveDialog title="Request refund" onClose={() => setRefundModalOpen(false)}>
          <form onSubmit={(e) => void handleRequestRefund(e)} data-app="crm" className="space-y-3 p-1 text-xs">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="font-medium">Object type</span>
                <select
                  className="crm-select min-h-11"
                  value={objType}
                  onChange={(e) => setObjType(e.target.value as 'booking' | 'membership')}
                >
                  <option value="booking">Booking</option>
                  <option value="membership">Membership</option>
                </select>
              </label>
              <label className="block space-y-1">
                <span className="font-medium">Object ID</span>
                <input
                  type="text"
                  required
                  className="crm-input min-h-11"
                  value={objId}
                  onChange={(e) => setObjId(e.target.value)}
                />
              </label>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="font-medium">Refund amount</span>
                <input
                  type="number"
                  required
                  min={1}
                  step="0.01"
                  className="crm-input min-h-11"
                  value={amountMajor}
                  onChange={(e) => setAmountMajor(e.target.value)}
                />
              </label>
              <label className="block space-y-1">
                <span className="font-medium">Currency</span>
                <input
                  type="text"
                  required
                  maxLength={3}
                  className="crm-input min-h-11 uppercase"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                />
              </label>
            </div>
            <label className="block space-y-1">
              <span className="font-medium">Reason</span>
              <input
                type="text"
                required
                className="crm-input min-h-11"
                value={refReason}
                onChange={(e) => setRefReason(e.target.value)}
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setRefundModalOpen(false)} className="crm-btn-secondary min-h-11">
                Cancel
              </button>
              <button type="submit" disabled={busy} className="crm-btn-primary min-h-11">
                Submit refund request
              </button>
            </div>
          </form>
        </AdaptiveDialog>
      )}

      {/* Decide Refund Modal */}
      {decidingRefund && (
        <AdaptiveDialog title="Review refund request" onClose={() => setDecidingRefund(null)}>
          <form onSubmit={(e) => void handleDecideRefund(e)} data-app="crm" className="space-y-3 p-1 text-xs">
            <p className="font-semibold">
              {formatMinorMoney(decidingRefund.amountMinor, decidingRefund.currency)} · {decidingRefund.reason}
            </p>
            <label className="block space-y-1">
              <span className="font-medium">Decision</span>
              <select
                className="crm-select min-h-11"
                value={refDecision}
                onChange={(e) => setRefDecision(e.target.value as 'approve' | 'reject')}
              >
                <option value="approve">Approve</option>
                <option value="reject">Reject</option>
              </select>
            </label>
            <label className="block space-y-1">
              <span className="font-medium">Decision note</span>
              <input
                type="text"
                required
                className="crm-input min-h-11"
                value={refDecisionNote}
                onChange={(e) => setRefDecisionNote(e.target.value)}
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setDecidingRefund(null)} className="crm-btn-secondary min-h-11">
                Cancel
              </button>
              <button type="submit" disabled={busy} className="crm-btn-primary min-h-11">
                Confirm decision
              </button>
            </div>
          </form>
        </AdaptiveDialog>
      )}

      {/* Issue Refund Modal */}
      {issuingRefund && (
        <AdaptiveDialog title="Record refund payout" onClose={() => setIssuingRefund(null)}>
          <form onSubmit={(e) => void handleIssueRefund(e)} data-app="crm" className="space-y-3 p-1 text-xs">
            <p className="font-semibold">
              Payout {formatMinorMoney(issuingRefund.amountMinor, issuingRefund.currency)}
            </p>
            <label className="block space-y-1">
              <span className="font-medium">Bank / payout reference</span>
              <input
                type="text"
                required
                className="crm-input min-h-11"
                value={refIssueRef}
                onChange={(e) => setRefIssueRef(e.target.value)}
                placeholder="NEFT / UPI refund ref"
              />
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setIssuingRefund(null)} className="crm-btn-secondary min-h-11">
                Cancel
              </button>
              <button type="submit" disabled={busy} className="crm-btn-primary min-h-11">
                Append refund payout
              </button>
            </div>
          </form>
        </AdaptiveDialog>
      )}
    </div>
  );
}
