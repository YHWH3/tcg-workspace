import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Award, ExternalLink, Lock, RefreshCw, Search } from 'lucide-react';
import type { CrmStatus } from '../../../../shared/crm/contracts';
import type { PatronsReadResponse } from '../../../../shared/crm/pipelines';
import { useLayoutMode } from '../../../core/mobile';
import { useStore } from '../../../core/store';
import { onlineStore } from '../../../core/sync/engine';
import { describeCommandError, fetchPatrons } from '../api';

export function PatronsView(_props: { status: CrmStatus }) {
  const layout = useLayoutMode();
  const isOffline = !useStore(onlineStore);

  const [data, setData] = useState<PatronsReadResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [tierFilter, setTierFilter] = useState<string>('');

  const loadPatrons = useCallback(async () => {
    if (isOffline) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchPatrons();
      setData(res);
    } catch (err) {
      setError(describeCommandError(err));
    } finally {
      setLoading(false);
    }
  }, [isOffline]);

  useEffect(() => {
    void loadPatrons();
  }, [loadPatrons]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.items.filter((item) => {
      if (tierFilter && item.tier !== tierFilter) return false;
      if (q) {
        const hay = `${item.title} ${item.email ?? ''} ${item.edition ?? ''} ${item.applicationCode ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [data, query, tierFilter]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-3 py-5 sm:px-6 sm:py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-[var(--crm-text-muted)]">Community support</p>
          <h1 className="mt-0.5 text-xl font-semibold leading-tight">Patrons (read-only mirror)</h1>
        </div>
        <button
          type="button"
          disabled={loading || isOffline}
          onClick={() => void loadPatrons()}
          className="crm-btn-secondary"
        >
          <RefreshCw size={14} aria-hidden="true" className={loading ? 'animate-spin' : ''} />
          <span>Refresh</span>
        </button>
      </header>

      <div
        role="status"
        className="flex items-start gap-2.5 rounded-lg border px-4 py-3 text-xs"
        style={{
          backgroundColor: 'var(--crm-surface)',
          borderColor: 'var(--crm-border)',
          color: 'var(--crm-text-muted)',
        }}
      >
        <Lock size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--crm-primary)]" />
        <div>
          <p className="font-semibold text-[var(--crm-text)]">Read-only projection from The Common Ground website relay</p>
          <p className="mt-0.5">
            Patron tier applications, payments, edition allocation, and refunds remain governed exclusively by the website and Workspace inbox. CRM exposes read-only context with zero Patron mutation controls.
          </p>
        </div>
      </div>

      {data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 text-xs">
          <div className="crm-panel p-3.5">
            <span className="text-[var(--crm-text-muted)]">Founding</span>
            <p className="crm-tabular mt-1 text-lg font-semibold">{data.countsByTier.founding}</p>
          </div>
          <div className="crm-panel p-3.5">
            <span className="text-[var(--crm-text-muted)]">Builder</span>
            <p className="crm-tabular mt-1 text-lg font-semibold">{data.countsByTier.builder}</p>
          </div>
          <div className="crm-panel p-3.5">
            <span className="text-[var(--crm-text-muted)]">Partner</span>
            <p className="crm-tabular mt-1 text-lg font-semibold">{data.countsByTier.partner}</p>
          </div>
          <div className="crm-panel p-3.5">
            <span className="text-[var(--crm-text-muted)]">Total mirrored</span>
            <p className="crm-tabular mt-1 text-lg font-semibold">{data.items.length}</p>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-lg border px-4 py-3 text-xs" style={{ backgroundColor: 'var(--crm-err-bg)', color: 'var(--crm-err-text)', borderColor: 'var(--crm-err-border)' }}>
          {error}
        </div>
      )}

      <div className="crm-panel flex flex-wrap items-center gap-3 p-3">
        <div className="relative min-w-0 flex-1">
          <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--crm-text-muted)]" />
          <input
            type="search"
            aria-label="Filter patrons"
            placeholder="Search by patron name, email, or edition…"
            className="crm-input !pl-9 !text-xs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select
          aria-label="Filter by tier"
          className="crm-select !w-auto !min-w-[9rem] !text-xs"
          value={tierFilter}
          onChange={(e) => setTierFilter(e.target.value)}
        >
          <option value="">All tiers</option>
          <option value="founding">Founding</option>
          <option value="builder">Builder</option>
          <option value="partner">Partner</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="crm-panel p-6 text-center text-xs text-[var(--crm-text-muted)]">
          No Patron website submissions matched your filter.
        </div>
      ) : layout === 'compact' ? (
        <ul className="space-y-2.5">
          {filtered.map((item) => (
            <li key={item.submissionId} className="crm-panel space-y-2 p-4 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{item.title}</p>
                  {item.email && <p className="text-[var(--crm-text-muted)]">{item.email}</p>}
                </div>
                {item.tier && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[var(--crm-primary-soft)] px-2.5 py-0.5 font-semibold capitalize text-[var(--crm-primary)]">
                    <Award size={11} aria-hidden="true" />
                    <span>{item.tier}</span>
                  </span>
                )}
              </div>
              <p className="text-[var(--crm-text-muted)]">
                Stage: {item.stage ?? '—'} · Edition: {item.edition ?? '—'} · Paid: {item.paid ?? '—'}
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                {item.personId && (
                  <Link to={`/crm/people/${item.personId}`} className="crm-btn-secondary !min-h-10 !text-xs">
                    Person profile
                  </Link>
                )}
                <Link to={`/boards/${item.boardId}/tasks/${item.submissionId}`} className="crm-btn-secondary !min-h-10 !text-xs">
                  <ExternalLink size={12} aria-hidden="true" />
                  <span>Source submission</span>
                </Link>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="crm-table-wrap" role="region" aria-label="Read-only Patron directory" tabIndex={0}>
          <table className="crm-table">
            <thead>
              <tr>
                <th scope="col" className="crm-sticky-col">Patron</th>
                <th scope="col">Tier</th>
                <th scope="col">Stage</th>
                <th scope="col">Edition</th>
                <th scope="col">Last event</th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr key={item.submissionId}>
                  <td className="crm-sticky-col">
                    <div className="font-semibold">{item.title}</div>
                    {item.email && <div className="text-xs text-[var(--crm-text-muted)]">{item.email}</div>}
                  </td>
                  <td className="capitalize">{item.tier ?? '—'}</td>
                  <td>{item.stage ?? '—'}</td>
                  <td>{item.edition ?? '—'}</td>
                  <td>{item.event ?? '—'}</td>
                  <td>
                    <div className="flex items-center gap-2 text-xs">
                      {item.personId && (
                        <Link to={`/crm/people/${item.personId}`} className="font-medium text-[var(--crm-primary)] hover:underline">
                          Person
                        </Link>
                      )}
                      <Link
                        to={`/boards/${item.boardId}/tasks/${item.submissionId}`}
                        className="inline-flex items-center gap-1 text-[var(--crm-text-muted)] hover:underline"
                      >
                        <ExternalLink size={12} aria-hidden="true" />
                        <span>Workspace</span>
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
