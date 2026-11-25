import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, CheckCircle2, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import type { CrmStatus } from '../../../../shared/crm/contracts';
import type { CrmFactDto } from '../../../../shared/crm/conversations';
import { CRM_PROGRAMMES } from '../../../../shared/crm/programmes';
import { canManageCrmAccess } from '../../../core/crmStatus';
import { useStore } from '../../../core/store';
import { onlineStore } from '../../../core/sync/engine';
import {
  describeCommandError,
  fetchFacts,
  generateCrmRequestId,
  proposeCrmFact,
  retireCrmFact,
  verifyCrmFact,
} from '../api';

export function FactsSettings({ status }: { status: CrmStatus }) {
  const isOffline = !useStore(onlineStore);
  const canManage = canManageCrmAccess(status);

  const [facts, setFacts] = useState<CrmFactDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [statement, setStatement] = useState('');
  const [programmeSlug, setProgrammeSlug] = useState('');
  const [sourceRef, setSourceRef] = useState('');
  const [reviewDate, setReviewDate] = useState('');

  const loadFacts = useCallback(async () => {
    if (isOffline) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchFacts({ includeStale: true });
      setFacts(res.facts);
    } catch (err) {
      setError(describeCommandError(err));
    } finally {
      setLoading(false);
    }
  }, [isOffline]);

  useEffect(() => {
    void loadFacts();
  }, [loadFacts]);

  const canVerifyFact = (fact: CrmFactDto) => {
    if (status.owner) return true;
    const scope = fact.programmeSlug ? `programme:${fact.programmeSlug}` : '*';
    return status.capabilities.some((c) => c.capability === 'crm.configure' && (c.scope === '*' || c.scope === scope));
  };

  const handlePropose = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !statement.trim() || isOffline || busyId) return;
    setBusyId('__propose__');
    setError(null);
    setNotice(null);
    try {
      const reviewBy = reviewDate ? Date.parse(`${reviewDate}T23:59:59Z`) : null;
      const res = await proposeCrmFact(
        {
          title: title.trim(),
          statement: statement.trim(),
          programmeSlug: programmeSlug || null,
          category: 'general',
          sourceRef: sourceRef.trim() || null,
          reviewBy: Number.isFinite(reviewBy) ? reviewBy : null,
        },
        { requestId: generateCrmRequestId() },
      );
      if (res.ok) {
        setTitle('');
        setStatement('');
        setSourceRef('');
        setNotice('Proposed draft fact. An authorized admin/owner can verify it below.');
        await loadFacts();
      } else {
        setError(describeCommandError(res));
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-3 py-5 sm:px-6 sm:py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-[var(--crm-text-muted)]">Settings</p>
          <h1 className="mt-0.5 text-xl font-semibold leading-tight">Verified knowledge store</h1>
          <p className="mt-1 text-xs text-[var(--crm-text-muted)]">
            AI message drafts cite only verified, non-stale facts from this ledger. Unverified or stale facts are excluded automatically.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canManage && (
            <Link to="/crm/settings/access" className="crm-btn-secondary">
              Accounts & capabilities
            </Link>
          )}
          <Link to="/crm/settings/programmes" className="crm-btn-secondary">
            Programme profiles
          </Link>
          <button type="button" disabled={loading || isOffline} onClick={() => void loadFacts()} className="crm-btn-secondary">
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

      <form onSubmit={(e) => void handlePropose(e)} className="crm-panel space-y-3 p-4 text-xs">
        <h2 className="text-sm font-semibold">Propose new operational fact (draft)</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="fact-title" className="mb-1 block font-medium text-[var(--crm-text-muted)]">Title</label>
            <input id="fact-title" type="text" className="crm-input" value={title} onChange={(e) => setTitle(e.target.value)} required />
          </div>
          <div>
            <label htmlFor="fact-prog" className="mb-1 block font-medium text-[var(--crm-text-muted)]">Programme scope</label>
            <select id="fact-prog" className="crm-select" value={programmeSlug} onChange={(e) => setProgrammeSlug(e.target.value)}>
              <option value="">Global (all programmes)</option>
              {CRM_PROGRAMMES.map((p) => (
                <option key={p.slug} value={p.slug}>{p.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label htmlFor="fact-stmt" className="mb-1 block font-medium text-[var(--crm-text-muted)]">Verified statement</label>
          <textarea id="fact-stmt" rows={2} className="crm-input !py-2" value={statement} onChange={(e) => setStatement(e.target.value)} required />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="fact-source" className="mb-1 block font-medium text-[var(--crm-text-muted)]">Source reference (optional)</label>
            <input id="fact-source" type="text" className="crm-input" placeholder="e.g. Programme handbook p.4" value={sourceRef} onChange={(e) => setSourceRef(e.target.value)} />
          </div>
          <div>
            <label htmlFor="fact-review" className="mb-1 block font-medium text-[var(--crm-text-muted)]">Review-by date (optional)</label>
            <input id="fact-review" type="date" className="crm-input" value={reviewDate} onChange={(e) => setReviewDate(e.target.value)} />
          </div>
        </div>
        <div className="flex justify-end">
          <button type="submit" disabled={isOffline || busyId === '__propose__'} className="crm-btn-primary">
            <Plus size={14} aria-hidden="true" />
            <span>Propose draft fact</span>
          </button>
        </div>
      </form>

      <ul className="space-y-2.5">
        {facts.map((fact) => {
          const mayVerify = canVerifyFact(fact);
          return (
            <li key={fact.id} className="crm-panel flex flex-wrap items-start justify-between gap-3 p-4 text-xs">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">{fact.title}</span>
                  <span className="rounded-full bg-[var(--crm-surface-2)] px-2 py-0.5 text-[11px] font-medium capitalize">
                    {fact.status}
                  </span>
                  <span className="rounded-full border border-[var(--crm-border)] px-2 py-0.5 text-[11px] text-[var(--crm-text-muted)]">
                    {fact.scope}
                  </span>
                  {fact.isStale && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-[var(--crm-warn-border)] bg-[var(--crm-warn-bg)] px-2 py-0.5 text-[11px] font-semibold text-[var(--crm-warn-text)]">
                      <AlertTriangle size={11} aria-hidden="true" />
                      <span>Stale (review overdue)</span>
                    </span>
                  )}
                </div>
                <p className="text-[var(--crm-text)]">{fact.statement}</p>
                <p className="text-[var(--crm-text-muted)]">
                  ID: <code>{fact.id}</code>
                  {fact.sourceRef ? ` · Source: ${fact.sourceRef}` : ''}
                  {fact.reviewBy ? ` · Review by: ${new Date(fact.reviewBy).toISOString().slice(0, 10)}` : ''}
                </p>
              </div>
              {mayVerify && fact.status !== 'retired' && (
                <div className="flex flex-wrap items-center gap-2">
                  {fact.status !== 'verified' || fact.isStale ? (
                    <button
                      type="button"
                      disabled={isOffline || busyId === fact.id}
                      onClick={() => {
                        setBusyId(fact.id);
                        void verifyCrmFact(
                          { factId: fact.id, expectedRev: fact.rev, reviewBy: Date.now() + 90 * 86_400_000 },
                          { requestId: generateCrmRequestId() },
                        )
                          .then(() => loadFacts())
                          .finally(() => setBusyId(null));
                      }}
                      className="crm-btn-primary !min-h-10 !text-xs"
                    >
                      <ShieldCheck size={13} aria-hidden="true" />
                      <span>{fact.isStale ? 'Re-verify' : 'Verify'}</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={isOffline || busyId === fact.id}
                    onClick={() => {
                      setBusyId(fact.id);
                      void retireCrmFact(
                        { factId: fact.id, expectedRev: fact.rev },
                        { requestId: generateCrmRequestId() },
                      )
                        .then(() => loadFacts())
                        .finally(() => setBusyId(null));
                    }}
                    className="crm-btn-secondary !min-h-10 !text-xs"
                  >
                    <Trash2 size={13} aria-hidden="true" />
                    <span>Retire</span>
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
