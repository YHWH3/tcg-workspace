import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  AlertTriangle,
  History,
  RefreshCw,
  RotateCcw,
  X,
} from 'lucide-react';
import type { MergeHistoryItemDto, UnmergeConflictDto } from '../../../../shared/crm/merge';
import { authStore } from '../../../core/auth';
import { accessClientStore } from '../../../core/accessClient';
import { useStore } from '../../../core/store';
import { onlineStore, syncNow } from '../../../core/sync/engine';
import {
  CrmTransportError,
  describeCommandError,
  extractUnmergeConflicts,
  fetchMergeHistory,
  generateCrmRequestId,
  isIdentityChangedError,
  unmergePeople,
} from '../api';

export interface MergeHistoryTabProps {
  canUnmerge: boolean;
  onOpenPerson: (personId: string) => void;
  onUnmerged: (message: string) => void;
}

function formatTime(ms: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

export function MergeHistoryTab({ canUnmerge, onOpenPerson, onUnmerged }: MergeHistoryTabProps) {
  const isOffline = !useStore(onlineStore);
  const auth = useStore(authStore);
  const accessState = useStore(accessClientStore);
  const identityKey = `${auth.user?.id ?? ''}:${accessState.epoch}`;
  const prevIdentityRef = useRef(identityKey);

  const [items, setItems] = useState<MergeHistoryItemDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeItem, setActiveItem] = useState<MergeHistoryItemDto | null>(null);
  const [unmergeReason, setUnmergeReason] = useState('');
  const [unmergeConfirmed, setUnmergeConfirmed] = useState(false);
  const [unmergeBusy, setUnmergeBusy] = useState(false);
  const [unmergeError, setUnmergeError] = useState<string | null>(null);
  const [unmergeConflicts, setUnmergeConflicts] = useState<UnmergeConflictDto[]>([]);

  const dialogTitleId = useId();
  const reasonId = useId();
  const confirmId = useId();

  const loadHistory = useCallback(async (cursor?: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchMergeHistory(cursor ? { cursor } : undefined);
      setItems((prev) => (cursor ? [...prev, ...res.items] : res.items));
      setNextCursor(res.next);
      setPartial(res.partial);
    } catch (err) {
      if (isIdentityChangedError(err)) return;
      setError(
        err instanceof CrmTransportError
          ? err.userMessage
          : 'Could not load merge history. Retry when connected.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (prevIdentityRef.current !== identityKey) {
      prevIdentityRef.current = identityKey;
      setItems([]);
      setNextCursor(null);
      setActiveItem(null);
      setUnmergeError(null);
      setUnmergeConflicts([]);
    }
  }, [identityKey]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory, identityKey]);

  useEffect(() => {
    if (!activeItem) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !unmergeBusy) {
        e.preventDefault();
        setActiveItem(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeItem, unmergeBusy]);

  const openUnmergeDialog = (item: MergeHistoryItemDto) => {
    setActiveItem(item);
    setUnmergeReason('');
    setUnmergeConfirmed(false);
    setUnmergeError(null);
    setUnmergeConflicts([]);
  };

  const handleUnmergeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeItem || !unmergeConfirmed || unmergeBusy || isOffline) return;
    setUnmergeBusy(true);
    setUnmergeError(null);
    setUnmergeConflicts([]);

    try {
      const res = await unmergePeople(
        {
          mergeId: activeItem.id,
          confirm: true,
          ...(unmergeReason.trim() ? { reason: unmergeReason.trim() } : {}),
        },
        { requestId: generateCrmRequestId() },
      );

      if (res.ok) {
        const restoredName = activeItem.mergedTitle ?? activeItem.mergedId;
        const survivorName = activeItem.survivorTitle ?? activeItem.survivorId;
        setActiveItem(null);
        onUnmerged(`Unmerged ${restoredName} from ${survivorName}.`);
        void syncNow().catch(() => {});
        await loadHistory();
      } else {
        setUnmergeConflicts(extractUnmergeConflicts(res));
        setUnmergeError(describeCommandError(res));
      }
    } catch (err) {
      if (isIdentityChangedError(err)) return;
      if (err instanceof CrmTransportError && err.kind === 'offline') {
        setUnmergeError('Unmerging people requires a connection to the server.');
      } else {
        setUnmergeError(describeCommandError(err));
      }
    } finally {
      setUnmergeBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      <div className="crm-panel flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="space-y-1 text-xs">
          <p className="font-semibold">Person merge ledger (reversible while clean)</p>
          <p className="text-[var(--crm-text-muted)]">
            Every contact merge records exact prior revisions. Admins and owners can reverse clean merges without data loss.
          </p>
        </div>
        <button
          type="button"
          disabled={loading || isOffline}
          onClick={() => void loadHistory()}
          className="crm-btn-secondary !min-h-11 !text-xs"
        >
          <RefreshCw size={14} aria-hidden="true" className={loading ? 'animate-spin' : ''} />
          <span>Refresh</span>
        </button>
      </div>

      {partial && (
        <p className="rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] px-3 py-2 text-xs text-[var(--crm-text-muted)]">
          Showing accessible recent merge history; restricted entries are omitted.
        </p>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-lg border p-3 text-xs"
          style={{
            backgroundColor: 'var(--crm-err-bg)',
            color: 'var(--crm-err-text)',
            borderColor: 'var(--crm-err-border)',
          }}
        >
          {error}
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="crm-panel space-y-2 p-4" aria-busy="true">
          <div className="crm-skeleton h-14 w-full" />
          <div className="crm-skeleton h-14 w-full" />
        </div>
      ) : items.length === 0 ? (
        <div className="crm-panel p-6 text-center text-xs text-[var(--crm-text-muted)]">
          <History size={22} aria-hidden="true" className="mx-auto mb-2 text-[var(--crm-text-muted)]" />
          <p className="font-semibold text-[var(--crm-text)]">No person merges recorded yet</p>
          <p className="mt-1">Merged contacts from Duplicates review or Compare &amp; merge appear here.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.id} className="crm-panel flex flex-wrap items-center justify-between gap-3 p-4 text-xs">
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onOpenPerson(item.survivorId)}
                    className="min-h-11 inline-flex items-center font-semibold text-[var(--crm-primary)] hover:underline"
                  >
                    {item.survivorTitle ?? item.survivorId}
                  </button>
                  <span className="text-[var(--crm-text-muted)]">absorbed</span>
                  <button
                    type="button"
                    onClick={() => onOpenPerson(item.mergedId)}
                    className="min-h-11 inline-flex items-center font-semibold text-[var(--crm-primary)] hover:underline"
                  >
                    {item.mergedTitle ?? item.mergedId}
                  </button>
                  {item.unmerged ? (
                    <span
                      className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
                      style={{ backgroundColor: 'var(--crm-surface-2)', color: 'var(--crm-text-muted)' }}
                    >
                      Unmerged
                    </span>
                  ) : (
                    <span
                      className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
                      style={{ backgroundColor: 'var(--crm-ok-bg)', color: 'var(--crm-ok-text)' }}
                    >
                      Merged
                    </span>
                  )}
                </div>

                <p className="text-[var(--crm-text-muted)]">
                  <span>
                    By {item.actorName ?? item.actorId} · Moved {item.movedCounts.linksMoved} links,{' '}
                    {item.movedCounts.endpointsMoved} endpoints, {item.movedCounts.conversationsMoved} conversations
                  </span>
                  <time
                    className="crm-tabular block text-[11px]"
                    dateTime={new Date(item.createdAt).toISOString()}
                  >
                    {formatTime(item.createdAt)}
                  </time>
                </p>

                {item.note && (
                  <p className="text-[var(--crm-text)]">
                    Note: {item.note}
                  </p>
                )}

                {item.unmerged && (
                  <p className="text-[var(--crm-text-muted)]">
                    <span>
                      Reversed by {item.unmerged.actorName ?? item.unmerged.actorId}
                      {item.unmerged.reason ? ` — ${item.unmerged.reason}` : ''}
                    </span>
                    <time
                      className="crm-tabular block text-[11px]"
                      dateTime={new Date(item.unmerged.createdAt).toISOString()}
                    >
                      {formatTime(item.unmerged.createdAt)}
                    </time>
                  </p>
                )}
              </div>

              {canUnmerge && !item.unmerged && (
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    disabled={isOffline}
                    onClick={() => openUnmergeDialog(item)}
                    className="crm-btn-secondary !min-h-11 !text-xs"
                  >
                    <RotateCcw size={13} aria-hidden="true" />
                    <span>Unmerge…</span>
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {nextCursor && !isOffline && (
        <div className="flex justify-center">
          <button
            type="button"
            disabled={loading}
            onClick={() => void loadHistory(nextCursor)}
            className="crm-btn-secondary !min-h-11 !text-xs"
          >
            {loading ? 'Loading…' : 'Load older'}
          </button>
        </div>
      )}

      {activeItem && (
        <div
          data-app="crm"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !unmergeBusy) setActiveItem(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={dialogTitleId}
            className="flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-[var(--crm-border)] bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-xl sm:rounded-2xl"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-[var(--crm-border)] px-4 py-3">
              <h2 id={dialogTitleId} className="text-base font-semibold">
                Reverse person merge
              </h2>
              <button
                type="button"
                disabled={unmergeBusy}
                onClick={() => setActiveItem(null)}
                aria-label="Close unmerge dialog"
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-[var(--crm-text-muted)] hover:bg-[var(--crm-surface-2)] hover:text-[var(--crm-text)]"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            <form
              onSubmit={(e) => void handleUnmergeSubmit(e)}
              className="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-4 text-xs"
            >
              <p className="text-[var(--crm-text-muted)]">
                Restores <strong>{activeItem.mergedTitle ?? activeItem.mergedId}</strong> and reverts fields,
                links, endpoints, conversations, and duplicate status to their exact pre-merge revisions on{' '}
                <strong>{activeItem.survivorTitle ?? activeItem.survivorId}</strong>.
              </p>

              {isOffline && (
                <div
                  role="status"
                  className="rounded-lg border px-3 py-2"
                  style={{
                    backgroundColor: 'var(--crm-warn-bg)',
                    color: 'var(--crm-warn-text)',
                    borderColor: 'var(--crm-warn-border)',
                  }}
                >
                  Unmerging people requires a connection to the server.
                </div>
              )}

              <div>
                <label htmlFor={reasonId} className="mb-1 block font-medium">
                  Reason (optional)
                </label>
                <input
                  id={reasonId}
                  type="text"
                  maxLength={500}
                  placeholder="Why this merge is being reversed"
                  className="crm-input !min-h-11 !text-xs"
                  value={unmergeReason}
                  onChange={(e) => setUnmergeReason(e.target.value)}
                />
              </div>

              <label
                htmlFor={confirmId}
                className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] px-3 py-2 font-medium"
              >
                <input
                  id={confirmId}
                  type="checkbox"
                  checked={unmergeConfirmed}
                  onChange={(e) => setUnmergeConfirmed(e.target.checked)}
                  className="h-5 w-5 shrink-0 accent-[var(--crm-primary)]"
                />
                <span>Confirm lossless unmerge if no linked records changed after the merge.</span>
              </label>

              {unmergeError && (
                <div
                  role="alert"
                  className="space-y-2 rounded-lg border p-3"
                  style={{
                    backgroundColor: 'var(--crm-err-bg)',
                    color: 'var(--crm-err-text)',
                    borderColor: 'var(--crm-err-border)',
                  }}
                >
                  <p className="flex items-center gap-1.5 font-semibold">
                    <AlertTriangle size={14} aria-hidden="true" />
                    <span>{unmergeError}</span>
                  </p>
                  {unmergeConflicts.length > 0 && (
                    <ul className="list-disc space-y-1 pl-4">
                      {unmergeConflicts.map((c, idx) => (
                        <li key={`${c.code}-${c.entityId}-${idx}`}>
                          <span className="font-semibold">{c.code}</span>: {c.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  disabled={unmergeBusy}
                  onClick={() => setActiveItem(null)}
                  className="crm-btn-secondary !min-h-11 !text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!unmergeConfirmed || unmergeBusy || isOffline}
                  className="crm-btn-danger !min-h-11 !text-xs"
                >
                  <RotateCcw size={14} aria-hidden="true" />
                  <span>{unmergeBusy ? 'Unmerging…' : 'Confirm unmerge'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
