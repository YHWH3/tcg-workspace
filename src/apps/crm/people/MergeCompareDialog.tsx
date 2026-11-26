import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  GitMerge,
  RefreshCw,
  ShieldAlert,
  X,
} from 'lucide-react';
import type {
  MergeEndpointSummaryDto,
  MergeFieldChoice,
  MergePreviewResponse,
  PersonMergeOutput,
} from '../../../../shared/crm/merge';
import type { CrmEndpointKind } from '../../../../shared/crm/identity';
import { authStore } from '../../../core/auth';
import { accessClientStore } from '../../../core/accessClient';
import { useStore } from '../../../core/store';
import { onlineStore, syncNow } from '../../../core/sync/engine';
import {
  CrmTransportError,
  describeCommandError,
  fetchMergePreview,
  generateCrmRequestId,
  isIdentityChangedError,
  mergePeople,
} from '../api';

export interface MergeCompareDialogProps {
  initialSurvivorId: string;
  initialLoserId: string;
  onClose: () => void;
  onMerged: (result: PersonMergeOutput, survivorTitle: string, loserTitle: string) => void;
}

function formatComparisonValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) {
    return value.length > 0 ? value.map((v) => String(v)).join(', ') : '—';
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function choiceLabel(choice: MergeFieldChoice): string {
  switch (choice) {
    case 'survivor':
      return 'Keep canonical person value';
    case 'loser':
      return 'Use archived record value';
    case 'union':
      return 'Combine unique values';
    case 'concat':
      return 'Join both text values';
  }
}

export function MergeCompareDialog({
  initialSurvivorId,
  initialLoserId,
  onClose,
  onMerged,
}: MergeCompareDialogProps) {
  const isOffline = !useStore(onlineStore);
  const auth = useStore(authStore);
  const accessState = useStore(accessClientStore);
  const identityKey = `${auth.user?.id ?? ''}:${accessState.epoch}`;
  const prevIdentityRef = useRef(identityKey);

  const titleId = useId();
  const noteInputId = useId();
  const confirmCheckboxId = useId();
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  const [survivorId, setSurvivorId] = useState(initialSurvivorId);
  const [loserId, setLoserId] = useState(initialLoserId);
  const [preview, setPreview] = useState<MergePreviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [fieldResolutions, setFieldResolutions] = useState<Record<string, MergeFieldChoice>>({});
  const [primaryEndpoints, setPrimaryEndpoints] = useState<Partial<Record<CrmEndpointKind, string>>>({});
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const requestIdRef = useRef<string | null>(null);

  // Close & clear protected preview immediately on account/access switch.
  useEffect(() => {
    if (prevIdentityRef.current !== identityKey) {
      prevIdentityRef.current = identityKey;
      setPreview(null);
      setSubmitError(null);
      onClose();
    }
  }, [identityKey, onClose]);

  useEffect(() => {
    closeBtnRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, submitting]);

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setSubmitError(null);
    requestIdRef.current = null;
    try {
      const data = await fetchMergePreview(survivorId, loserId);
      setPreview(data);
      const nextFields: Record<string, MergeFieldChoice> = {};
      for (const fc of data.fieldComparisons) {
        nextFields[fc.key] = fc.suggestedChoice;
      }
      setFieldResolutions(nextFields);

      const nextEps: Partial<Record<CrmEndpointKind, string>> = {};
      for (const epPlan of data.endpointPlans) {
        if (epPlan.recommendedPrimaryId) {
          nextEps[epPlan.kind] = epPlan.recommendedPrimaryId;
        }
      }
      setPrimaryEndpoints(nextEps);
    } catch (err) {
      if (isIdentityChangedError(err)) return;
      if (err instanceof CrmTransportError && err.kind === 'offline') {
        setLoadError('Loading a merge preview requires a connection to the server.');
      } else {
        setLoadError(err instanceof CrmTransportError ? err.userMessage : 'Could not load merge preview.');
      }
    } finally {
      setLoading(false);
    }
  }, [survivorId, loserId]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const handleSwap = () => {
    if (submitting || loading) return;
    setConfirmed(false);
    setSubmitError(null);
    setSurvivorId(loserId);
    setLoserId(survivorId);
  };

  const canSubmit = Boolean(
    preview &&
      !preview.alreadyMerged &&
      preview.withinBudget &&
      confirmed &&
      !isOffline &&
      !submitting &&
      !loading,
  );

  const activeEndpointOptionsByKind = useMemo(() => {
    const map = new Map<CrmEndpointKind, MergeEndpointSummaryDto[]>();
    if (!preview) return map;
    for (const plan of preview.endpointPlans) {
      const merged: MergeEndpointSummaryDto[] = [];
      const seenNorm = new Set<string>();
      for (const ep of [...plan.survivorEndpoints, ...plan.loserEndpoints]) {
        if (ep.retiredAt !== null) continue;
        if (seenNorm.has(ep.valueNorm)) continue;
        seenNorm.add(ep.valueNorm);
        merged.push(ep);
      }
      map.set(plan.kind, merged);
    }
    return map;
  }, [preview]);

  const handleConfirmMerge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!preview || !confirmed || submitting || isOffline) return;

    const reqId = requestIdRef.current ?? generateCrmRequestId();
    requestIdRef.current = reqId;
    setSubmitting(true);
    setSubmitError(null);

    try {
      const cleanedPrimaries: Partial<Record<CrmEndpointKind, string>> = {};
      for (const [k, v] of Object.entries(primaryEndpoints)) {
        if (typeof v === 'string' && v.trim()) {
          cleanedPrimaries[k as CrmEndpointKind] = v.trim();
        }
      }

      const res = await mergePeople(
        {
          survivorId: preview.survivor.id,
          loserId: preview.loser.id,
          confirm: true,
          fieldResolutions,
          ...(Object.keys(cleanedPrimaries).length > 0 ? { primaryEndpoints: cleanedPrimaries } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
        {
          requestId: reqId,
          expected: {
            [preview.survivor.id]: preview.survivor.rev,
            [preview.loser.id]: preview.loser.rev,
          },
        },
      );

      if (res.ok) {
        requestIdRef.current = null;
        onMerged(res.result, preview.survivor.title, preview.loser.title);
        void syncNow().catch(() => {});
      } else {
        setSubmitError(describeCommandError(res));
        if (res.error === 'stale') {
          requestIdRef.current = null;
          await loadPreview();
        }
      }
    } catch (err) {
      if (isIdentityChangedError(err)) return;
      if (err instanceof CrmTransportError && err.kind === 'offline') {
        setSubmitError('Merging people requires a connection to the server.');
      } else {
        setSubmitError(describeCommandError(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      data-app="crm"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[92dvh] w-full max-w-4xl flex-col overflow-hidden rounded-t-2xl border border-[var(--crm-border)] bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-xl sm:rounded-2xl"
      >
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--crm-border)] px-4 py-3 sm:px-5">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <GitMerge size={18} aria-hidden="true" className="shrink-0 text-[var(--crm-primary)]" />
            <h2 id={titleId} className="min-w-0 text-base font-semibold leading-snug">
              Compare &amp; merge people
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              disabled={loading || submitting || isOffline}
              onClick={handleSwap}
              className="crm-btn-secondary !min-h-11 !px-3 !text-xs"
            >
              <ArrowLeftRight size={14} aria-hidden="true" />
              <span>Swap survivor</span>
            </button>
            <button
              ref={closeBtnRef}
              type="button"
              disabled={submitting}
              onClick={onClose}
              aria-label="Close merge comparison"
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-[var(--crm-text-muted)] hover:bg-[var(--crm-surface-2)] hover:text-[var(--crm-text)]"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div
          role="region"
          aria-label="Merge comparison details"
          tabIndex={0}
          className="min-h-0 flex-1 space-y-5 overflow-y-auto overflow-x-hidden p-4 text-xs sm:p-5"
        >
          {isOffline && (
            <div
              role="status"
              className="rounded-lg border px-3 py-2.5"
              style={{
                backgroundColor: 'var(--crm-warn-bg)',
                color: 'var(--crm-warn-text)',
                borderColor: 'var(--crm-warn-border)',
              }}
            >
              Merging people requires a connection to the server. Reconnect to review and apply this merge.
            </div>
          )}

          {loadError ? (
            <div
              role="alert"
              className="space-y-3 rounded-lg border p-4"
              style={{
                backgroundColor: 'var(--crm-err-bg)',
                color: 'var(--crm-err-text)',
                borderColor: 'var(--crm-err-border)',
              }}
            >
              <p>{loadError}</p>
              <button
                type="button"
                disabled={isOffline}
                onClick={() => void loadPreview()}
                className="crm-btn-secondary !min-h-11 !text-xs"
              >
                <RefreshCw size={14} aria-hidden="true" />
                <span>Retry preview</span>
              </button>
            </div>
          ) : loading || !preview ? (
            <div className="space-y-3" aria-busy="true">
              <div className="crm-skeleton h-20 w-full" />
              <div className="crm-skeleton h-28 w-full" />
              <div className="crm-skeleton h-24 w-full" />
            </div>
          ) : (
            <form id="crm-merge-form" onSubmit={(e) => void handleConfirmMerge(e)} className="space-y-5">
              {/* Survivor vs Loser header cards */}
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="rounded-lg border border-[var(--crm-ok-border)] bg-[var(--crm-ok-bg)] p-3.5 text-[var(--crm-ok-text)]">
                  <p className="text-[11px] font-semibold uppercase tracking-wide">
                    Keep — canonical person (rev {preview.survivor.rev})
                  </p>
                  <p className="mt-1 text-sm font-semibold text-[var(--crm-text)] break-words">
                    {preview.survivor.title}
                  </p>
                  <p className="mt-1 text-[11px] text-[var(--crm-text-muted)] break-all">
                    {preview.survivor.primaryEmail ?? 'No primary email'} · {preview.survivor.primaryPhone ?? 'No primary phone'}
                  </p>
                </div>

                <div className="rounded-lg border border-[var(--crm-warn-border)] bg-[var(--crm-warn-bg)] p-3.5 text-[var(--crm-warn-text)]">
                  <p className="text-[11px] font-semibold uppercase tracking-wide">
                    Archive — merge into survivor (rev {preview.loser.rev})
                  </p>
                  <p className="mt-1 text-sm font-semibold text-[var(--crm-text)] break-words">
                    {preview.loser.title}
                  </p>
                  <p className="mt-1 text-[11px] text-[var(--crm-text-muted)] break-all">
                    {preview.loser.primaryEmail ?? 'No primary email'} · {preview.loser.primaryPhone ?? 'No primary phone'}
                  </p>
                </div>
              </div>

              {preview.alreadyMerged && (
                <div
                  role="alert"
                  className="rounded-lg border p-3"
                  style={{
                    backgroundColor: 'var(--crm-err-bg)',
                    color: 'var(--crm-err-text)',
                    borderColor: 'var(--crm-err-border)',
                  }}
                >
                  One of these records has already been merged or archived. Close and refresh the directory.
                </div>
              )}

              {!preview.withinBudget && (
                <div
                  role="alert"
                  className="space-y-1 rounded-lg border p-3"
                  style={{
                    backgroundColor: 'var(--crm-err-bg)',
                    color: 'var(--crm-err-text)',
                    borderColor: 'var(--crm-err-border)',
                  }}
                >
                  <p className="font-semibold">Safe single-batch limit exceeded</p>
                  {preview.budgetReasons.map((r) => (
                    <p key={r}>{r}</p>
                  ))}
                </div>
              )}

              {preview.warnings.length > 0 && (
                <div
                  role="status"
                  className="space-y-1 rounded-lg border p-3"
                  style={{
                    backgroundColor: 'var(--crm-warn-bg)',
                    color: 'var(--crm-warn-text)',
                    borderColor: 'var(--crm-warn-border)',
                  }}
                >
                  <p className="flex items-center gap-1.5 font-semibold">
                    <AlertTriangle size={14} aria-hidden="true" />
                    <span>Merge notices</span>
                  </p>
                  <ul className="list-disc space-y-0.5 pl-4">
                    {preview.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Field comparisons */}
              <section className="space-y-2.5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--crm-text-muted)]">
                  Field resolution ({preview.fieldComparisons.length})
                </h3>
                {preview.fieldComparisons.length === 0 ? (
                  <p className="rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-3 text-[var(--crm-text-muted)]">
                    No differing person fields to resolve.
                  </p>
                ) : (
                  <ul className="space-y-2.5">
                    {preview.fieldComparisons.map((fc) => (
                      <li
                        key={fc.key}
                        className="rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-3 space-y-2"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-[var(--crm-text)]">{fc.label}</span>
                            {fc.conflict && (
                              <span
                                className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                                style={{ backgroundColor: 'var(--crm-warn-bg)', color: 'var(--crm-warn-text)' }}
                              >
                                Conflict
                              </span>
                            )}
                          </div>
                          <select
                            aria-label={`Resolution for ${fc.label}`}
                            className="crm-select !min-h-11 sm:!w-64 !text-xs"
                            value={fieldResolutions[fc.key] ?? fc.suggestedChoice}
                            onChange={(ev) =>
                              setFieldResolutions((prev) => ({
                                ...prev,
                                [fc.key]: ev.target.value as MergeFieldChoice,
                              }))
                            }
                          >
                            {fc.allowedChoices.map((choice) => (
                              <option key={choice} value={choice}>
                                {choiceLabel(choice)}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <div className="rounded border border-[var(--crm-border)] bg-[var(--crm-surface)] p-2">
                            <span className="block text-[10px] uppercase tracking-wide text-[var(--crm-text-muted)]">
                              Canonical
                            </span>
                            <span className="mt-0.5 block break-words font-medium text-[var(--crm-text)]">
                              {formatComparisonValue(fc.survivorValue)}
                            </span>
                          </div>
                          <div className="rounded border border-[var(--crm-border)] bg-[var(--crm-surface)] p-2">
                            <span className="block text-[10px] uppercase tracking-wide text-[var(--crm-text-muted)]">
                              Archived
                            </span>
                            <span className="mt-0.5 block break-words font-medium text-[var(--crm-text)]">
                              {formatComparisonValue(fc.loserValue)}
                            </span>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Endpoints plan */}
              {preview.endpointPlans.length > 0 && (
                <section className="space-y-2.5">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--crm-text-muted)]">
                    Endpoints &amp; primary selection
                  </h3>
                  <ul className="space-y-2">
                    {preview.endpointPlans.map((plan) => {
                      const options = activeEndpointOptionsByKind.get(plan.kind) ?? [];
                      return (
                        <li
                          key={plan.kind}
                          className="rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-3 space-y-2"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <span className="font-semibold uppercase text-[var(--crm-text)]">{plan.kind}</span>
                              <span className="ml-2 text-[var(--crm-text-muted)]">
                                {plan.survivorEndpoints.length} canonical · {plan.loserEndpoints.length} archived
                                {plan.collisionCount > 0 ? ` · ${plan.collisionCount} exact duplicate retired` : ''}
                              </span>
                            </div>
                            {options.length > 0 && (
                              <select
                                aria-label={`Primary ${plan.kind} endpoint`}
                                className="crm-select !min-h-11 sm:!w-72 !text-xs"
                                value={primaryEndpoints[plan.kind] ?? plan.recommendedPrimaryId ?? options[0]!.id}
                                onChange={(ev) =>
                                  setPrimaryEndpoints((prev) => ({
                                    ...prev,
                                    [plan.kind]: ev.target.value,
                                  }))
                                }
                              >
                                {options.map((ep) => (
                                  <option key={ep.id} value={ep.id}>
                                    {ep.valueRaw} ({ep.personId === preview.survivor.id ? 'canonical' : 'archived'})
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              {/* Non-broadening consent preview */}
              <section className="space-y-2">
                <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--crm-text-muted)]">
                  <ShieldAlert size={13} aria-hidden="true" />
                  <span>Consent result (withdrawal never broadened)</span>
                </h3>
                {preview.consentPreviews.length === 0 ? (
                  <p className="rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-3 text-[var(--crm-text-muted)]">
                    No consent records exist on either person yet.
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {preview.consentPreviews.map((c) => (
                      <div
                        key={`${c.channel}:${c.scope}`}
                        className="rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-3 space-y-1"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold text-[var(--crm-text)]">
                            {c.channel} · {c.scope}
                          </span>
                          <span
                            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                            style={{
                              backgroundColor: c.effectiveStatus === 'granted' ? 'var(--crm-ok-bg)' : 'var(--crm-err-bg)',
                              color: c.effectiveStatus === 'granted' ? 'var(--crm-ok-text)' : 'var(--crm-err-text)',
                            }}
                          >
                            {c.effectiveStatus}
                          </span>
                        </div>
                        <p className="text-[11px] text-[var(--crm-text-muted)]">
                          Canonical: {c.survivorStatus} · Archived: {c.loserStatus}
                        </p>
                        {c.strictestApplied && (
                          <p className="text-[11px] font-semibold text-[var(--crm-err-text)]">
                            Strictest applied — withdrawal preserved cleanly
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Reference counts */}
              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--crm-text-muted)]">
                  Linked data summary
                </h3>
                <div className="rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-3 space-y-1.5">
                  <p className="text-[var(--crm-text)]">
                    Links to repoint: <strong>{preview.referenceCounts.links}</strong> · Endpoints:{' '}
                    <strong>{preview.referenceCounts.endpoints}</strong> · Conversations:{' '}
                    <strong>{preview.referenceCounts.conversations}</strong> · Files:{' '}
                    <strong>{preview.referenceCounts.files}</strong> · Sub-records:{' '}
                    <strong>{preview.referenceCounts.subRecords}</strong> · Website email keys:{' '}
                    <strong>{preview.referenceCounts.formPeopleKeys}</strong>
                  </p>
                  <p className="text-[11px] text-[var(--crm-text-muted)]">
                    Page blocks ({preview.referenceCounts.loserBlocksPreserved}) and Workspace comments (
                    {preview.referenceCounts.comments}) remain preserved intact on the archived record.
                  </p>
                </div>
              </section>

              {/* Note & explicit confirmation */}
              <div className="space-y-3 border-t border-[var(--crm-border)] pt-3">
                <div>
                  <label htmlFor={noteInputId} className="mb-1 block font-medium text-[var(--crm-text)]">
                    Merge note (optional audit note)
                  </label>
                  <input
                    id={noteInputId}
                    type="text"
                    maxLength={500}
                    className="crm-input !min-h-11 !text-xs"
                    placeholder="Reason for merging these records"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </div>

                <label
                  htmlFor={confirmCheckboxId}
                  className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] px-3 py-2 font-medium text-[var(--crm-text)]"
                >
                  <input
                    id={confirmCheckboxId}
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    className="h-5 w-5 shrink-0 accent-[var(--crm-primary)]"
                  />
                  <span>
                    Archive <strong>{preview.loser.title}</strong> into canonical{' '}
                    <strong>{preview.survivor.title}</strong> (reversible while linked records are unchanged).
                  </span>
                </label>

                {submitError && (
                  <div
                    role="alert"
                    className="rounded-lg border p-3"
                    style={{
                      backgroundColor: 'var(--crm-err-bg)',
                      color: 'var(--crm-err-text)',
                      borderColor: 'var(--crm-err-border)',
                    }}
                  >
                    {submitError}
                  </div>
                )}

                <div className="flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={onClose}
                    className="crm-btn-secondary !min-h-11 !text-xs"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={!canSubmit}
                    className="crm-btn-primary !min-h-11 !text-xs"
                  >
                    <CheckCircle2 size={14} aria-hidden="true" />
                    <span>{submitting ? 'Merging…' : 'Merge people'}</span>
                  </button>
                </div>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
