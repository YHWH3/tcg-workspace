import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  History,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserCheck,
  UserMinus,
  Users,
  XCircle,
} from 'lucide-react';
import {
  ALL_SCOPE,
  CRM_CAPABILITIES,
  CRM_CAPABILITY_LABELS,
  PROGRAMME_SCOPED,
  type CrmCapability,
} from '../../../../shared/crm/capabilities';
import { CRM_PROGRAMMES, CRM_PROGRAMME_BY_SLUG, programmeScopeForSlug } from '../../../../shared/crm/programmes';
import {
  MAX_CAPABILITY_REASON_CHARS,
  type CapabilityAuditItem,
  type CapabilityOverviewAccount,
  type CrmStatus,
} from '../../../../shared/crm/contracts';
import type { PublicUser } from '../../../../shared/types';
import { authStore } from '../../../core/auth';
import { currentCrmIdentityKey, useCrmStatus } from '../../../core/crmStatus';
import { useLayoutMode } from '../../../core/mobile';
import { useStore } from '../../../core/store';
import { onlineStore } from '../../../core/sync/engine';
import { AdaptiveDialog, Avatar, Sheet } from '../../../core/ui';
import {
  CrmTransportError,
  createWorkspaceInvite,
  deleteWorkspaceInvite,
  deleteWorkspaceUser,
  describeAccountError,
  describeCommandError,
  disableWorkspaceUser,
  enableWorkspaceUser,
  fetchCapabilityAudit,
  fetchCapabilityOverview,
  fetchWorkspaceAccounts,
  generateCrmRequestId,
  grantCrmCapability,
  isIdentityChangedError,
  renameWorkspaceUser,
  revokeCrmCapability,
  updateWorkspaceUserRole,
  type WorkspaceInviteRow,
} from '../api';

type SettingsTab = 'accounts' | 'capabilities' | 'history';

interface PendingToggle {
  requestId: string;
  targetHeld: boolean;
}

interface FailedToggle {
  userId: string;
  capability: CrmCapability;
  targetHeld: boolean;
  scope?: string;
  reason?: string;
  requestId: string;
  message: string;
  retryable: boolean;
}

type AccountConfirmAction =
  | { kind: 'disable'; account: CapabilityOverviewAccount }
  | { kind: 'enable'; account: CapabilityOverviewAccount }
  | { kind: 'remove'; account: CapabilityOverviewAccount };

function formatTimestamp(ms: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

function roleLabel(role: CapabilityOverviewAccount['role']): string {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'admin':
      return 'Admin';
    case 'member':
      return 'Member';
    case 'guest':
      return 'Guest';
  }
}

function effectiveGrantCount(account: CapabilityOverviewAccount): number {
  if (account.implicitAll) return CRM_CAPABILITIES.length;
  if (!account.effectiveAccess) return 0;
  return account.grants.filter(
    (g) => g.capability !== 'crm.capabilities.manage' || account.role === 'admin',
  ).length;
}

interface CapabilityMatrixProps {
  account: CapabilityOverviewAccount;
  actorId: string;
  actorIsOwner: boolean;
  isOffline: boolean;
  reasonInput: string;
  onReasonChange: (value: string) => void;
  accountNames: Map<string, string>;
  pendingByKey: Record<string, PendingToggle>;
  failedToggle: FailedToggle | null;
  onToggle: (
    account: CapabilityOverviewAccount,
    capability: CrmCapability,
    targetHeld: boolean,
    retryOpts?: { requestId: string; reason?: string; scope?: string },
  ) => void;
}

function CapabilityMatrix({
  account,
  actorId,
  actorIsOwner,
  isOffline,
  reasonInput,
  onReasonChange,
  accountNames,
  pendingByKey,
  failedToggle,
  onToggle,
}: CapabilityMatrixProps) {
  const reasonId = useId();
  const [scopeDraftByCap, setScopeDraftByCap] = useState<Record<string, string>>({});
  const isSelf = account.userId === actorId;
  const hasDormantManage =
    account.role === 'member' &&
    account.grants.some((g) => g.capability === 'crm.capabilities.manage');
  const hasInactiveGrants = !account.effectiveAccess && account.grants.length > 0;
  const effectiveCount = effectiveGrantCount(account);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold break-words">{account.name}</span>
            <span className="text-xs text-[var(--crm-text-muted)] break-all">@{account.username}</span>
            <span className="rounded-full border border-[var(--crm-border)] bg-[var(--crm-surface)] px-2 py-0.5 text-[11px] font-medium">
              {roleLabel(account.role)}
            </span>
            {account.disabled && (
              <span
                className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                style={{ backgroundColor: 'var(--crm-err-bg)', color: 'var(--crm-err-text)' }}
              >
                Disabled
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-[var(--crm-text-muted)]">
            {account.implicitAll
              ? 'All capabilities (owner)'
              : account.role === 'guest'
                ? 'Guests cannot hold CRM capabilities.'
                : `Effective: ${effectiveCount} of ${CRM_CAPABILITIES.length} capabilities`}
          </p>
        </div>
      </div>

      {hasInactiveGrants && (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-xs"
          style={{
            backgroundColor: 'var(--crm-warn-bg)',
            color: 'var(--crm-warn-text)',
            borderColor: 'var(--crm-warn-border)',
          }}
        >
          <AlertTriangle size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">
              Specialised grants are inactive until Open the CRM is granted
            </p>
            <p className="mt-0.5">
              This account holds {account.grants.length} stored grant
              {account.grants.length === 1 ? '' : 's'}, but none take effect while Open the CRM is
              off. You can still revoke any stored grant below.
            </p>
          </div>
        </div>
      )}

      {hasDormantManage && (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-xs"
          style={{
            backgroundColor: 'var(--crm-warn-bg)',
            color: 'var(--crm-warn-text)',
            borderColor: 'var(--crm-warn-border)',
          }}
        >
          <ShieldAlert size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Dormant Manage capabilities grant</p>
            <p className="mt-0.5">
              This member was previously an admin and still has a stored Manage capabilities grant,
              which is inactive until they are an admin again.
              {actorIsOwner
                ? ' As owner, you can revoke this dormant grant.'
                : ' Only the owner can revoke it.'}
            </p>
          </div>
        </div>
      )}

      {isOffline && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg border px-3.5 py-2.5 text-xs font-medium"
          style={{
            backgroundColor: 'var(--crm-warn-bg)',
            color: 'var(--crm-warn-text)',
            borderColor: 'var(--crm-warn-border)',
          }}
        >
          <AlertTriangle size={15} aria-hidden="true" className="shrink-0" />
          <span>Capability changes need a connection</span>
        </div>
      )}

      {failedToggle && failedToggle.userId === account.userId && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-xs"
          style={{
            backgroundColor: 'var(--crm-err-bg)',
            color: 'var(--crm-err-text)',
            borderColor: 'var(--crm-err-border)',
          }}
        >
          <span>{failedToggle.message}</span>
          {failedToggle.retryable && !isOffline && (
            <button
              type="button"
              className="crm-btn-secondary !min-h-8 !px-2.5 !py-1 !text-xs"
              onClick={() =>
                onToggle(account, failedToggle.capability, failedToggle.targetHeld, {
                  requestId: failedToggle.requestId,
                  reason: failedToggle.reason,
                  scope: failedToggle.scope,
                })
              }
            >
              Retry
            </button>
          )}
        </div>
      )}

      {account.implicitAll ? (
        <div className="rounded-lg border border-[var(--crm-border)] bg-[var(--crm-surface)] px-4 py-5 text-sm">
          <p className="font-semibold">All capabilities (owner)</p>
          <p className="mt-1 text-xs text-[var(--crm-text-muted)]">
            The workspace owner holds every CRM capability automatically across all scopes. Owner
            access cannot be revoked.
          </p>
        </div>
      ) : account.role === 'guest' ? (
        <div className="rounded-lg border border-[var(--crm-border)] bg-[var(--crm-surface)] px-4 py-5 text-sm">
          <p className="font-semibold">Guests cannot hold CRM capabilities.</p>
          <p className="mt-1 text-xs text-[var(--crm-text-muted)]">
            Guest accounts are scoped to shared Spaces in Workspace and are not eligible for CRM
            access.
          </p>
        </div>
      ) : (
        <>
          <div>
            <label
              htmlFor={reasonId}
              className="mb-1 block text-xs font-medium text-[var(--crm-text-muted)]"
            >
              Reason for audit log (optional)
            </label>
            <input
              id={reasonId}
              type="text"
              className="crm-input max-w-md"
              maxLength={MAX_CAPABILITY_REASON_CHARS}
              placeholder="e.g. Onboarding for December workshop"
              value={reasonInput}
              disabled={isOffline || isSelf}
              onChange={(e) => onReasonChange(e.target.value)}
            />
          </div>

          <ul className="divide-y divide-[var(--crm-border)] rounded-[var(--crm-radius-panel)] border border-[var(--crm-border)] bg-[var(--crm-surface)]">
            {CRM_CAPABILITIES.map((capability) => {
              const meta = CRM_CAPABILITY_LABELS[capability];
              const grant = account.grants.find(
                (g) => g.capability === capability && g.scope === ALL_SCOPE,
              );
              const held = Boolean(grant);
              const key = `${account.userId}:${capability}:${ALL_SCOPE}`;
              const pending = pendingByKey[key];

              let disabledReason = '';
              if (isOffline) {
                disabledReason = 'Capability changes need a connection';
              } else if (isSelf) {
                disabledReason = 'You cannot change your own capabilities';
              } else if (capability === 'crm.capabilities.manage' && !actorIsOwner) {
                disabledReason = 'Owner only can change';
              } else if (
                capability === 'crm.capabilities.manage' &&
                account.role !== 'admin' &&
                !held
              ) {
                disabledReason = 'Admins only';
              } else if (account.disabled && !held) {
                disabledReason = 'Account is disabled';
              }

              const inactiveBadge =
                held &&
                ((capability !== 'crm.access' && !account.effectiveAccess) ||
                  (capability === 'crm.capabilities.manage' && account.role !== 'admin'));

              const grantedByName = grant
                ? accountNames.get(grant.grantedBy) ?? 'Removed account'
                : null;

              const switchLabel = `${meta.label}, scope All`;

              return (
                <li
                  key={capability}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{meta.label}</span>
                      <span className="rounded-full border border-[var(--crm-border)] bg-[var(--crm-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--crm-text-muted)]">
                        All
                      </span>
                      {meta.sensitive && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
                          style={{
                            backgroundColor: 'var(--crm-warn-bg)',
                            color: 'var(--crm-warn-text)',
                          }}
                        >
                          <Lock size={11} aria-hidden="true" />
                          <span>Sensitive</span>
                        </span>
                      )}
                      {inactiveBadge && (
                        <span
                          className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                          style={{
                            backgroundColor: 'var(--crm-warn-bg)',
                            color: 'var(--crm-warn-text)',
                          }}
                        >
                          {capability === 'crm.capabilities.manage' && account.role !== 'admin'
                            ? 'Dormant (not admin)'
                            : 'Inactive until Open the CRM'}
                        </span>
                      )}
                      {pending && (
                        <span
                          role="status"
                          className="rounded-full bg-[var(--crm-primary-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--crm-primary)]"
                        >
                          {pending.targetHeld ? 'Granting…' : 'Revoking…'}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-[var(--crm-text-muted)]">{meta.description}</p>
                    <p className="mt-1 text-[11px] text-[var(--crm-text-muted)]">
                      {grant ? (
                        <>
                          Granted by {grantedByName} ·{' '}
                          <time dateTime={new Date(grant.grantedAt).toISOString()}>
                            {formatTimestamp(grant.grantedAt)}
                          </time>
                        </>
                      ) : (
                        'Not granted'
                      )}
                      {disabledReason ? ` · ${disabledReason}` : ''}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <span className="crm-switch-hit">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={held}
                        aria-label={switchLabel}
                        aria-busy={Boolean(pending)}
                        disabled={Boolean(disabledReason) || Boolean(pending)}
                        data-testid={`cap-switch-${capability}`}
                        onClick={() => onToggle(account, capability, !held)}
                        className="crm-switch"
                      >
                        <span aria-hidden="true" className="crm-switch-thumb" />
                      </button>
                    </span>
                  </div>

                  {PROGRAMME_SCOPED.has(capability) && (
                    <div className="mt-2 basis-full rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-2.5 text-xs">
                      <p className="font-semibold text-[var(--crm-text-muted)]">Programme-specific scopes</p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {account.grants
                          .filter((g) => g.capability === capability && g.scope !== ALL_SCOPE)
                          .map((sg) => {
                            const slug = sg.scope.startsWith('programme:') ? sg.scope.slice('programme:'.length) : sg.scope;
                            const label = CRM_PROGRAMME_BY_SLUG.get(slug)?.name ?? slug;
                            const scKey = `${account.userId}:${capability}:${sg.scope}`;
                            const scPending = Boolean(pendingByKey[scKey]);
                            return (
                              <span
                                key={sg.scope}
                                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--crm-border)] bg-[var(--crm-surface)] px-2.5 py-1"
                              >
                                <span className="font-medium">{label}</span>
                                <button
                                  type="button"
                                  disabled={Boolean(disabledReason) || scPending}
                                  onClick={() =>
                                    onToggle(account, capability, false, {
                                      requestId: generateCrmRequestId(),
                                      scope: sg.scope,
                                    })
                                  }
                                  aria-label={`Revoke ${meta.label} for ${label}`}
                                  className="min-h-7 rounded px-1.5 font-semibold text-[var(--crm-err-text)] hover:underline"
                                >
                                  Revoke
                                </button>
                              </span>
                            );
                          })}
                      </div>
                      {!isSelf && account.role !== 'guest' && !account.disabled && (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <select
                            aria-label={`${meta.label} programme scope`}
                            className="crm-select !min-h-10 !max-w-xs !py-1 !text-xs"
                            value={scopeDraftByCap[capability] ?? ''}
                            onChange={(e) =>
                              setScopeDraftByCap((prev) => ({ ...prev, [capability]: e.target.value }))
                            }
                          >
                            <option value="">Choose programme to add…</option>
                            {CRM_PROGRAMMES.filter(
                              (p) =>
                                !account.grants.some(
                                  (g) => g.capability === capability && g.scope === programmeScopeForSlug(p.slug),
                                ),
                            ).map((p) => (
                              <option key={p.slug} value={p.slug}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            disabled={Boolean(disabledReason) || !(scopeDraftByCap[capability] ?? '')}
                            onClick={() => {
                              const slug = scopeDraftByCap[capability];
                              if (!slug) return;
                              onToggle(account, capability, true, {
                                requestId: generateCrmRequestId(),
                                scope: programmeScopeForSlug(slug),
                              });
                              setScopeDraftByCap((prev) => ({ ...prev, [capability]: '' }));
                            }}
                            className="crm-btn-secondary !min-h-10 !px-3 !py-1 !text-xs"
                          >
                            Grant scope
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

export function AccessSettings({
  status,
  canManage,
}: {
  status: CrmStatus;
  canManage: boolean;
}) {
  const crmState = useCrmStatus();
  const me = useStore(authStore).user;
  const online = useStore(onlineStore);
  const layout = useLayoutMode();
  const isCompact = layout === 'compact';
  const isOffline = !online || crmState.offline;

  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  const tab: SettingsTab =
    rawTab === 'capabilities' || rawTab === 'history' ? rawTab : 'accounts';
  const setTab = useCallback(
    (nextTab: SettingsTab) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (nextTab === 'accounts') next.delete('tab');
          else next.set('tab', nextTab);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  const selectedUserId = searchParams.get('account') ?? '';
  const setSelectedUserId = useCallback(
    (nextId: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (nextId) next.set('account', nextId);
          else next.delete('account');
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const [overview, setOverview] = useState<CapabilityOverviewAccount[] | null>(null);
  const [workspaceUsers, setWorkspaceUsers] = useState<PublicUser[]>([]);
  const [seatsTotal, setSeatsTotal] = useState<number>(7);
  const [invites, setInvites] = useState<WorkspaceInviteRow[]>([]);
  const [loadingOverview, setLoadingOverview] = useState<boolean>(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const [sheetAccountId, setSheetAccountId] = useState<string | null>(null);
  const [reasonInput, setReasonInput] = useState<string>('');
  const [pendingByKey, setPendingByKey] = useState<Record<string, PendingToggle>>({});
  const [failedToggle, setFailedToggle] = useState<FailedToggle | null>(null);

  const [auditItems, setAuditItems] = useState<CapabilityAuditItem[] | null>(null);
  const [auditNext, setAuditNext] = useState<string | null>(null);
  const [loadingAudit, setLoadingAudit] = useState<boolean>(false);
  const [loadingMoreAudit, setLoadingMoreAudit] = useState<boolean>(false);
  const [auditError, setAuditError] = useState<string | null>(null);

  const [confirmAction, setConfirmAction] = useState<AccountConfirmAction | null>(null);
  const [renameTarget, setRenameTarget] = useState<CapabilityOverviewAccount | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [accountBusy, setAccountBusy] = useState<boolean>(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState<boolean>(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [copyFallbackCode, setCopyFallbackCode] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string>('');

  const tabRefs = useRef<Record<SettingsTab, HTMLButtonElement | null>>({
    accounts: null,
    capabilities: null,
    history: null,
  });
  const loadGenRef = useRef(0);
  const auditGenRef = useRef(0);
  const lastIdentityRef = useRef(currentCrmIdentityKey());

  const clearProtectedState = useCallback(() => {
    loadGenRef.current += 1;
    auditGenRef.current += 1;
    setOverview(null);
    setWorkspaceUsers([]);
    setInvites([]);
    setAuditItems(null);
    setAuditNext(null);
    setPendingByKey({});
    setFailedToggle(null);
    setConfirmAction(null);
    setRenameTarget(null);
    setSheetAccountId(null);
    setOverviewError(null);
    setAuditError(null);
    setAccountError(null);
  }, []);

  const loadAll = useCallback(async () => {
    if (!canManage) {
      clearProtectedState();
      return;
    }
    const startIdentity = currentCrmIdentityKey();
    const gen = ++loadGenRef.current;
    setLoadingOverview(true);
    setOverviewError(null);
    try {
      const [capRes, [usersRes, invitesRes]] = await Promise.all([
        fetchCapabilityOverview(),
        fetchWorkspaceAccounts(),
      ]);
      if (loadGenRef.current !== gen || currentCrmIdentityKey() !== startIdentity) return;
      setOverview(capRes.accounts);
      setWorkspaceUsers(usersRes.users);
      setSeatsTotal(usersRes.seatsTotal);
      setInvites(invitesRes.invites);
    } catch (err) {
      if (
        loadGenRef.current !== gen ||
        isIdentityChangedError(err) ||
        currentCrmIdentityKey() !== startIdentity
      ) {
        return;
      }
      setOverviewError(
        err instanceof CrmTransportError
          ? err.userMessage
          : 'Could not load CRM accounts and capabilities. Retry when connected.',
      );
    } finally {
      if (loadGenRef.current === gen && currentCrmIdentityKey() === startIdentity) {
        setLoadingOverview(false);
      }
    }
  }, [canManage, clearProtectedState]);

  const loadAudit = useCallback(
    async (cursor?: string | null) => {
      if (!canManage) return;
      const startIdentity = currentCrmIdentityKey();
      const gen = ++auditGenRef.current;
      if (cursor) setLoadingMoreAudit(true);
      else setLoadingAudit(true);
      setAuditError(null);
      try {
        const page = await fetchCapabilityAudit(cursor);
        if (auditGenRef.current !== gen || currentCrmIdentityKey() !== startIdentity) return;
        setAuditItems((prev) => {
          if (!cursor || !prev) return page.items;
          const seen = new Set(prev.map((i) => i.id));
          return [...prev, ...page.items.filter((i) => !seen.has(i.id))];
        });
        setAuditNext(page.next);
      } catch (err) {
        if (
          auditGenRef.current !== gen ||
          isIdentityChangedError(err) ||
          currentCrmIdentityKey() !== startIdentity
        ) {
          return;
        }
        setAuditError(
          err instanceof CrmTransportError
            ? err.userMessage
            : 'Could not load capability history. Retry when connected.',
        );
      } finally {
        if (auditGenRef.current === gen && currentCrmIdentityKey() === startIdentity) {
          setLoadingAudit(false);
          setLoadingMoreAudit(false);
        }
      }
    },
    [canManage],
  );

  // Synchronously drop in-memory protected data whenever authority disappears or identity/revision changes.
  useEffect(() => {
    const currentIdentity = currentCrmIdentityKey();
    if (currentIdentity !== lastIdentityRef.current) {
      lastIdentityRef.current = currentIdentity;
      clearProtectedState();
    }
    if (!canManage) {
      clearProtectedState();
      return;
    }
    void loadAll();
  }, [canManage, crmState.revision, me?.id, clearProtectedState, loadAll]);

  useEffect(() => {
    if (canManage && tab === 'history' && auditItems === null && !loadingAudit && !auditError) {
      void loadAudit();
    }
  }, [canManage, tab, auditItems, loadingAudit, auditError, loadAudit]);

  const userColors = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of workspaceUsers) {
      map.set(u.id, u.color);
    }
    return map;
  }, [workspaceUsers]);

  const accountNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of overview ?? []) {
      map.set(a.userId, a.name);
    }
    return map;
  }, [overview]);

  if (!canManage) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-10 sm:px-6">
        <section className="crm-panel p-6">
          <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--crm-surface-2)] text-[var(--crm-text)]">
            <Lock size={20} aria-hidden="true" />
          </div>
          <h1 className="text-lg font-semibold">You don't have access to this</h1>
          <p className="mt-2 text-sm text-[var(--crm-text-muted)]">
            Only the workspace owner, or an admin granted Manage capabilities by the owner, can view
            or change CRM capability settings.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link to="/crm" className="crm-btn-primary">
              <ArrowLeft size={15} aria-hidden="true" />
              <span>Back to CRM Home</span>
            </Link>
            <Link to="/" className="crm-btn-secondary">
              <span>Return to Workspace</span>
            </Link>
          </div>
        </section>
      </div>
    );
  }

  const activeCount = overview ? overview.filter((a) => !a.disabled).length : 0;
  const seatsFull = activeCount >= seatsTotal;
  const unusedInvites = invites.filter((i) => !i.used_by);
  const selectedAccount = overview?.length
    ? (overview.find((a) => a.userId === selectedUserId) ??
      overview.find((a) => !a.implicitAll && a.eligible) ??
      overview[0])
    : null;
  const sheetAccount =
    sheetAccountId && overview ? overview.find((a) => a.userId === sheetAccountId) ?? null : null;

  const handleToggle = async (
    account: CapabilityOverviewAccount,
    capability: CrmCapability,
    targetHeld: boolean,
    retryOpts?: { requestId: string; reason?: string; scope?: string },
  ) => {
    const targetScope = retryOpts?.scope ?? ALL_SCOPE;
    const key = `${account.userId}:${capability}:${targetScope}`;
    if (pendingByKey[key]) return;
    if (isOffline) {
      setFailedToggle({
        userId: account.userId,
        capability,
        targetHeld,
        scope: targetScope,
        requestId: retryOpts?.requestId ?? generateCrmRequestId(),
        message: 'Capability changes need a connection',
        retryable: true,
      });
      setAnnouncement('Capability changes need a connection.');
      return;
    }

    const startIdentity = currentCrmIdentityKey();
    const requestId = retryOpts?.requestId ?? generateCrmRequestId();
    const effectiveReason = retryOpts ? retryOpts.reason : reasonInput.trim() || undefined;
    const capLabel = CRM_CAPABILITY_LABELS[capability].label;

    setFailedToggle((prev) => (prev?.userId === account.userId && prev?.capability === capability ? null : prev));
    setPendingByKey((prev) => ({ ...prev, [key]: { requestId, targetHeld } }));

    try {
      const payload = {
        userId: account.userId,
        capability,
        scope: targetScope,
        ...(effectiveReason ? { reason: effectiveReason } : {}),
      };
      const outcome = targetHeld
        ? await grantCrmCapability(payload, { requestId })
        : await revokeCrmCapability(payload, { requestId });
      if (currentCrmIdentityKey() !== startIdentity) return;

      if (outcome.ok) {
        await Promise.all([loadAll(), auditItems !== null ? loadAudit() : Promise.resolve()]);
        if (currentCrmIdentityKey() !== startIdentity) return;
        setAnnouncement(
          outcome.result.already
            ? `${capLabel} for ${account.name} was already ${targetHeld ? 'granted' : 'revoked'}.`
            : `${targetHeld ? 'Granted' : 'Revoked'} ${capLabel} for ${account.name}.`,
        );
      } else {
        const msg = describeCommandError(outcome);
        setFailedToggle({
          userId: account.userId,
          capability,
          targetHeld,
          scope: targetScope,
          reason: effectiveReason,
          requestId: generateCrmRequestId(),
          message: msg,
          retryable: false,
        });
        setAnnouncement(msg);
        if (outcome.error === 'stale' || outcome.error === 'not_found' || outcome.error === 'idempotency_conflict') {
          await loadAll();
        }
      }
    } catch (err) {
      if (isIdentityChangedError(err) || currentCrmIdentityKey() !== startIdentity) return;
      const msg = describeCommandError(err);
      const retryable = err instanceof CrmTransportError ? err.retryable : false;
      setFailedToggle({
        userId: account.userId,
        capability,
        targetHeld,
        scope: targetScope,
        reason: effectiveReason,
        requestId,
        message: msg,
        retryable,
      });
      setAnnouncement(msg);
    } finally {
      if (currentCrmIdentityKey() === startIdentity) {
        setPendingByKey((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    }
  };

  const handleRoleChange = async (account: CapabilityOverviewAccount, nextRole: 'admin' | 'member') => {
    if (isOffline || nextRole === account.role) return;
    const startIdentity = currentCrmIdentityKey();
    setAccountError(null);
    setAccountBusy(true);
    try {
      await updateWorkspaceUserRole(account.userId, nextRole);
      if (currentCrmIdentityKey() !== startIdentity) return;
      await loadAll();
      if (currentCrmIdentityKey() !== startIdentity) return;
      setAnnouncement(`Changed ${account.name} to ${roleLabel(nextRole)}.`);
    } catch (err) {
      if (isIdentityChangedError(err) || currentCrmIdentityKey() !== startIdentity) return;
      const mapped = describeAccountError(err);
      setAccountError(mapped.message);
      setAnnouncement(mapped.message);
      if (mapped.shouldRefresh) await loadAll();
    } finally {
      if (currentCrmIdentityKey() === startIdentity) setAccountBusy(false);
    }
  };

  const handleConfirmAccountAction = async () => {
    if (!confirmAction || isOffline) return;
    const startIdentity = currentCrmIdentityKey();
    setAccountBusy(true);
    setAccountError(null);
    try {
      const target = confirmAction.account;
      if (confirmAction.kind === 'disable') {
        const res = await disableWorkspaceUser(target.userId);
        if (currentCrmIdentityKey() !== startIdentity) return;
        await Promise.all([loadAll(), auditItems !== null ? loadAudit() : Promise.resolve()]);
        if (currentCrmIdentityKey() !== startIdentity) return;
        if (res.cleanupPending) {
          setAccountError(
            'Access is disabled. Connector cleanup is pending. Retry Disable access to complete cleanup.',
          );
          setAnnouncement(`Disabled ${target.name}; connector cleanup pending.`);
        } else {
          setConfirmAction(null);
          setAnnouncement(`Disabled ${target.name} and revoked their CRM capabilities.`);
        }
      } else if (confirmAction.kind === 'enable') {
        await enableWorkspaceUser(target.userId);
        if (currentCrmIdentityKey() !== startIdentity) return;
        await loadAll();
        if (currentCrmIdentityKey() !== startIdentity) return;
        setConfirmAction(null);
        setAnnouncement(
          `Restored workspace access for ${target.name}. CRM capabilities remain revoked until granted again.`,
        );
      } else {
        await deleteWorkspaceUser(target.userId);
        if (currentCrmIdentityKey() !== startIdentity) return;
        await Promise.all([loadAll(), auditItems !== null ? loadAudit() : Promise.resolve()]);
        if (currentCrmIdentityKey() !== startIdentity) return;
        setConfirmAction(null);
        setAnnouncement(`Removed ${target.name} from the workspace.`);
      }
    } catch (err) {
      if (isIdentityChangedError(err) || currentCrmIdentityKey() !== startIdentity) return;
      const mapped = describeAccountError(err);
      setAccountError(mapped.message);
      setAnnouncement(mapped.message);
      if (mapped.shouldRefresh) await loadAll();
    } finally {
      if (currentCrmIdentityKey() === startIdentity) setAccountBusy(false);
    }
  };

  const handleCreateInvite = async () => {
    if (isOffline || seatsFull || inviteBusy) return;
    const startIdentity = currentCrmIdentityKey();
    setInviteBusy(true);
    setAccountError(null);
    try {
      const { code } = await createWorkspaceInvite();
      if (currentCrmIdentityKey() !== startIdentity) return;
      await loadAll();
      if (currentCrmIdentityKey() !== startIdentity) return;
      setAnnouncement(`Created invite code ${code}.`);
    } catch (err) {
      if (isIdentityChangedError(err) || currentCrmIdentityKey() !== startIdentity) return;
      const mapped = describeAccountError(err);
      setAccountError(mapped.message);
      setAnnouncement(mapped.message);
      if (mapped.shouldRefresh) await loadAll();
    } finally {
      if (currentCrmIdentityKey() === startIdentity) setInviteBusy(false);
    }
  };

  const handleCopyInvite = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
      setAnnouncement(`Copied invite code ${code}.`);
      setTimeout(() => setCopiedCode((curr) => (curr === code ? null : curr)), 2000);
    } catch {
      setCopyFallbackCode(code);
      setAnnouncement(`Clipboard unavailable. Invite code ${code} shown for manual copy.`);
    }
  };

  const handleDeleteInvite = async (code: string) => {
    if (isOffline) return;
    const startIdentity = currentCrmIdentityKey();
    setAccountError(null);
    try {
      await deleteWorkspaceInvite(code);
      if (currentCrmIdentityKey() !== startIdentity) return;
      await loadAll();
      if (currentCrmIdentityKey() !== startIdentity) return;
      setAnnouncement(`Deleted unused invite ${code}.`);
    } catch (err) {
      if (isIdentityChangedError(err) || currentCrmIdentityKey() !== startIdentity) return;
      const mapped = describeAccountError(err);
      setAccountError(mapped.message);
      setAnnouncement(mapped.message);
      if (mapped.shouldRefresh) await loadAll();
    }
  };

  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renameTarget || !status.owner || isOffline || renameBusy) return;
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setAccountError('Enter a valid account name (1 to 80 characters).');
      return;
    }
    const startIdentity = currentCrmIdentityKey();
    setRenameBusy(true);
    setAccountError(null);
    try {
      await renameWorkspaceUser(renameTarget.userId, trimmed);
      if (currentCrmIdentityKey() !== startIdentity) return;
      if (renameTarget.userId === me?.id && me) {
        const updatedUser = { ...me, name: trimmed };
        authStore.set({ status: 'authed', user: updatedUser });
        try {
          localStorage.setItem('ws_user', JSON.stringify(updatedUser));
        } catch {
          /* ignore storage failures */
        }
      }
      await loadAll();
      if (currentCrmIdentityKey() !== startIdentity) return;
      setAnnouncement(`Renamed ${renameTarget.name} to ${trimmed}.`);
      setRenameTarget(null);
    } catch (err) {
      if (isIdentityChangedError(err) || currentCrmIdentityKey() !== startIdentity) return;
      const mapped = describeAccountError(err);
      setAccountError(mapped.message);
      setAnnouncement(mapped.message);
      if (mapped.shouldRefresh) await loadAll();
    } finally {
      if (currentCrmIdentityKey() === startIdentity) setRenameBusy(false);
    }
  };

  const tabs: { id: SettingsTab; label: string; icon: typeof Users }[] = [
    { id: 'accounts', label: 'Accounts', icon: Users },
    { id: 'capabilities', label: 'Capabilities', icon: SlidersHorizontal },
    { id: 'history', label: 'History', icon: History },
  ];

  const onTabKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const nextIdx =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? tabs.length - 1
          : (idx + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    const nextTab = tabs[nextIdx].id;
    setTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  };

  const seatPct = seatsTotal > 0 ? Math.min(100, Math.round((activeCount / seatsTotal) * 100)) : 0;

  return (
    <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-5 px-3 py-5 sm:px-6 sm:py-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium text-[var(--crm-text-muted)]">Settings</p>
          <h1 className="mt-0.5 text-xl font-semibold leading-tight">Accounts and capabilities</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(status.owner || status.capabilities.some((c) => c.capability === 'crm.configure')) && (
            <Link to="/crm/settings/programmes" className="crm-btn-secondary">
              Programme profiles
            </Link>
          )}
          <button
            type="button"
            className="crm-btn-secondary"
            disabled={loadingOverview || isOffline}
            onClick={() => {
              void loadAll();
              if (tab === 'history') void loadAudit();
            }}
          >
            <RefreshCw size={15} aria-hidden="true" className={loadingOverview ? 'animate-spin' : ''} />
            <span>Refresh</span>
          </button>
        </div>
      </header>

      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <div
        role="tablist"
        aria-label="CRM access settings"
        className="flex flex-wrap gap-1 border-b border-[var(--crm-border)] pb-2"
      >
        {tabs.map((item, idx) => {
          const Icon = item.icon;
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              ref={(el) => {
                tabRefs.current[item.id] = el;
              }}
              type="button"
              role="tab"
              id={`crm-tab-${item.id}`}
              aria-selected={active}
              aria-controls={`crm-panel-${item.id}`}
              tabIndex={active ? 0 : -1}
              onClick={() => setTab(item.id)}
              onKeyDown={(e) => onTabKeyDown(e, idx)}
              className={
                active
                  ? 'inline-flex min-h-11 items-center gap-2 rounded-md bg-[var(--crm-primary)] px-3.5 py-2 text-sm font-semibold text-[var(--crm-primary-contrast)]'
                  : 'inline-flex min-h-11 items-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium text-[var(--crm-text-muted)] hover:bg-[var(--crm-surface-2)] hover:text-[var(--crm-text)]'
              }
            >
              <Icon size={15} aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>

      {overviewError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm"
          style={{
            backgroundColor: 'var(--crm-err-bg)',
            color: 'var(--crm-err-text)',
            borderColor: 'var(--crm-err-border)',
          }}
        >
          <span>{overviewError}</span>
          <button
            type="button"
            className="crm-btn-secondary !min-h-9 !px-3 !py-1.5 !text-xs"
            onClick={() => void loadAll()}
          >
            Retry
          </button>
        </div>
      )}

      {accountError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm"
          style={{
            backgroundColor: 'var(--crm-err-bg)',
            color: 'var(--crm-err-text)',
            borderColor: 'var(--crm-err-border)',
          }}
        >
          <span>{accountError}</span>
          <button
            type="button"
            className="crm-btn-secondary !min-h-9 !px-3 !py-1.5 !text-xs"
            onClick={() => setAccountError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ---------------- Accounts Tab ---------------- */}
      {tab === 'accounts' && (
        <section
          role="tabpanel"
          id="crm-panel-accounts"
          aria-labelledby="crm-tab-accounts"
          className="space-y-5"
        >
          <div className="crm-panel flex flex-wrap items-center justify-between gap-4 p-4 sm:p-5">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <p className="crm-tabular text-sm font-semibold">
                  {activeCount} of {seatsTotal} places in use (guests included)
                </p>
                {seatsFull && (
                  <span
                    className="rounded-full px-2.5 py-0.5 text-xs font-medium"
                    style={{
                      backgroundColor: 'var(--crm-warn-bg)',
                      color: 'var(--crm-warn-text)',
                    }}
                  >
                    Seat limit reached
                  </span>
                )}
              </div>
              <div className="h-2 w-full max-w-xs overflow-hidden rounded-full bg-[var(--crm-surface-2)]">
                <div
                  className="h-full rounded-full transition-[width] duration-150"
                  style={{
                    width: `${seatPct}%`,
                    backgroundColor: seatsFull ? 'var(--crm-status-ochre)' : 'var(--crm-primary)',
                  }}
                />
              </div>
              <p className="text-xs text-[var(--crm-text-muted)]">
                {status.owner
                  ? 'As workspace owner, you can rename accounts or manage roles and access.'
                  : 'People set their own name in Settings.'}
                {seatsFull ? ' Free a place before creating another account.' : ''}
              </p>
            </div>

            <button
              type="button"
              className="crm-btn-primary shrink-0"
              disabled={seatsFull || isOffline || inviteBusy}
              onClick={() => void handleCreateInvite()}
            >
              <Plus size={15} aria-hidden="true" />
              <span>{inviteBusy ? 'Creating…' : 'Create invite'}</span>
            </button>
          </div>

          {loadingOverview && !overview ? (
            <div className="crm-panel space-y-3 p-5" aria-busy="true">
              <div className="crm-skeleton h-10 w-full" />
              <div className="crm-skeleton h-10 w-full" />
              <div className="crm-skeleton h-10 w-full" />
            </div>
          ) : overview ? (
            isCompact ? (
              <ul className="space-y-3">
                {overview.map((acc) => {
                  const isSelf = acc.userId === me?.id;
                  const isOwner = acc.role === 'owner';
                  const isGuest = acc.role === 'guest';
                  const effectiveCount = effectiveGrantCount(acc);
                  const hasInactive = !acc.effectiveAccess && acc.grants.length > 0;

                  return (
                    <li
                      key={acc.userId}
                      data-testid={`crm-account-${acc.userId}`}
                      className="crm-panel space-y-3 p-4"
                    >
                      <div className="flex items-start gap-3">
                        <Avatar
                          name={acc.name}
                          color={userColors.get(acc.userId)}
                          size={36}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate text-sm font-semibold">
                              {acc.name}
                              {isSelf ? ' (you)' : ''}
                            </span>
                            <span
                              className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                              style={{
                                backgroundColor: acc.disabled
                                  ? 'var(--crm-err-bg)'
                                  : 'var(--crm-ok-bg)',
                                color: acc.disabled ? 'var(--crm-err-text)' : 'var(--crm-ok-text)',
                              }}
                            >
                              {acc.disabled ? 'Disabled' : 'Active'}
                            </span>
                          </div>
                          <p className="text-xs text-[var(--crm-text-muted)]">
                            @{acc.username} · {roleLabel(acc.role)}
                          </p>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--crm-bg)] px-3 py-2 text-xs">
                        <span className="font-medium text-[var(--crm-text-muted)]">CRM access</span>
                        <span className="crm-tabular font-semibold">
                          {isOwner
                            ? 'All (owner)'
                            : isGuest
                              ? 'Not eligible'
                              : acc.effectiveAccess
                                ? `${effectiveCount} of ${CRM_CAPABILITIES.length}`
                                : hasInactive
                                  ? `None (${acc.grants.length} inactive)`
                                  : 'None'}
                        </span>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="crm-btn-secondary flex-1"
                          onClick={() => setSheetAccountId(acc.userId)}
                        >
                          <SlidersHorizontal size={14} aria-hidden="true" />
                          <span>Capabilities</span>
                        </button>
                        {status.owner && (
                          <button
                            type="button"
                            className="crm-btn-secondary"
                            aria-label={`Rename ${acc.name}`}
                            disabled={accountBusy || renameBusy || isOffline}
                            onClick={() => {
                              setAccountError(null);
                              setRenameValue(acc.name);
                              setRenameTarget(acc);
                            }}
                          >
                            <Pencil size={14} aria-hidden="true" />
                            <span>Rename</span>
                          </button>
                        )}

                        {!isOwner && !isSelf && (
                          <>
                            {!isGuest && (
                              <select
                                aria-label={`Role for ${acc.name}`}
                                className="crm-select w-auto min-w-[7.5rem]"
                                value={acc.role}
                                disabled={accountBusy || isOffline}
                                onChange={(e) =>
                                  void handleRoleChange(acc, e.target.value as 'admin' | 'member')
                                }
                              >
                                <option value="admin">Admin</option>
                                <option value="member">Member</option>
                              </select>
                            )}
                            <button
                              type="button"
                              className="crm-btn-secondary"
                              disabled={accountBusy || isOffline}
                              onClick={() => {
                                setAccountError(null);
                                setConfirmAction({
                                  kind: acc.disabled ? 'enable' : 'disable',
                                  account: acc,
                                });
                              }}
                            >
                              {acc.disabled ? 'Restore' : 'Disable'}
                            </button>
                            <button
                              type="button"
                              className="crm-btn-danger"
                              aria-label={`Remove ${acc.name}`}
                              disabled={accountBusy || isOffline}
                              onClick={() => {
                                setAccountError(null);
                                setConfirmAction({ kind: 'remove', account: acc });
                              }}
                            >
                              <Trash2 size={15} aria-hidden="true" />
                              <span>Remove</span>
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="crm-table-wrap" role="region" aria-label="Accounts" tabIndex={0}>
                <table className="crm-table">
                  <thead>
                    <tr>
                      <th scope="col" className="crm-sticky-col">
                        Name
                      </th>
                      <th scope="col">Username</th>
                      <th scope="col">Role</th>
                      <th scope="col">CRM access</th>
                      <th scope="col">Status</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.map((acc) => {
                      const isSelf = acc.userId === me?.id;
                      const isOwner = acc.role === 'owner';
                      const isGuest = acc.role === 'guest';
                      const effectiveCount = effectiveGrantCount(acc);
                      const hasInactive = !acc.effectiveAccess && acc.grants.length > 0;
                      const hasDormantManage =
                        acc.role === 'member' &&
                        acc.grants.some((g) => g.capability === 'crm.capabilities.manage');

                      return (
                        <tr key={acc.userId} data-testid={`crm-account-${acc.userId}`}>
                          <td className="crm-sticky-col">
                            <div className="flex items-center gap-2.5">
                              <Avatar
                                name={acc.name}
                                color={userColors.get(acc.userId)}
                                size={28}
                              />
                              <span className="font-semibold">
                                {acc.name}
                                {isSelf ? ' (you)' : ''}
                              </span>
                            </div>
                          </td>
                          <td className="text-[var(--crm-text-muted)]">@{acc.username}</td>
                          <td>
                            {isOwner ? (
                              <span className="font-medium">Owner</span>
                            ) : isGuest ? (
                              <span className="text-xs text-[var(--crm-text-muted)]">
                                Managed in Spaces
                              </span>
                            ) : isSelf ? (
                              <span className="font-medium">{roleLabel(acc.role)}</span>
                            ) : (
                              <select
                                aria-label={`Role for ${acc.name}`}
                                className="crm-select !min-h-10 !w-32 !py-1.5"
                                value={acc.role}
                                disabled={accountBusy || isOffline}
                                onChange={(e) =>
                                  void handleRoleChange(acc, e.target.value as 'admin' | 'member')
                                }
                              >
                                <option value="admin">Admin</option>
                                <option value="member">Member</option>
                              </select>
                            )}
                          </td>
                          <td>
                            <div className="flex flex-col gap-1">
                              <button
                                type="button"
                                className="inline-flex min-h-8 items-center gap-1.5 self-start rounded px-1.5 text-left font-medium text-[var(--crm-primary)] hover:underline"
                                onClick={() => {
                                  setSearchParams(
                                    (prev) => {
                                      const next = new URLSearchParams(prev);
                                      next.set('account', acc.userId);
                                      next.set('tab', 'capabilities');
                                      return next;
                                    },
                                    { replace: true },
                                  );
                                }}
                              >
                                <span className="crm-tabular">
                                  {isOwner
                                    ? 'All (owner)'
                                    : isGuest
                                      ? 'Not eligible'
                                      : acc.effectiveAccess
                                        ? `${effectiveCount} of ${CRM_CAPABILITIES.length}`
                                        : 'None'}
                                </span>
                              </button>
                              {hasInactive && (
                                <span
                                  className="inline-flex self-start rounded-full px-2 py-0.5 text-[11px] font-medium"
                                  style={{
                                    backgroundColor: 'var(--crm-warn-bg)',
                                    color: 'var(--crm-warn-text)',
                                  }}
                                >
                                  {acc.grants.length} inactive (needs Open the CRM)
                                </span>
                              )}
                              {hasDormantManage && (
                                <span
                                  className="inline-flex self-start rounded-full px-2 py-0.5 text-[11px] font-medium"
                                  style={{
                                    backgroundColor: 'var(--crm-warn-bg)',
                                    color: 'var(--crm-warn-text)',
                                  }}
                                >
                                  Dormant manage grant
                                </span>
                              )}
                            </div>
                          </td>
                          <td>
                            <span
                              className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium"
                              style={{
                                backgroundColor: acc.disabled
                                  ? 'var(--crm-err-bg)'
                                  : 'var(--crm-ok-bg)',
                                color: acc.disabled ? 'var(--crm-err-text)' : 'var(--crm-ok-text)',
                              }}
                            >
                              {acc.disabled ? (
                                <XCircle size={12} aria-hidden="true" />
                              ) : (
                                <CheckCircle2 size={12} aria-hidden="true" />
                              )}
                              <span>{acc.disabled ? 'Disabled' : 'Active'}</span>
                            </span>
                          </td>
                          <td>
                            <div className="flex flex-wrap items-center gap-2">
                              {status.owner && (
                                <button
                                  type="button"
                                  className="crm-btn-secondary !min-h-10 !px-3 !py-1.5 !text-xs"
                                  aria-label={`Rename ${acc.name}`}
                                  disabled={accountBusy || renameBusy || isOffline}
                                  onClick={() => {
                                    setAccountError(null);
                                    setRenameValue(acc.name);
                                    setRenameTarget(acc);
                                  }}
                                >
                                  <Pencil size={14} aria-hidden="true" />
                                  <span>Rename</span>
                                </button>
                              )}
                              {isOwner || isSelf ? (
                                !status.owner && (
                                  <span
                                    className="text-xs text-[var(--crm-text-muted)]"
                                    aria-label="No account actions available"
                                  >
                                    —
                                  </span>
                                )
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    className="crm-btn-secondary !min-h-10 !px-3 !py-1.5 !text-xs"
                                    disabled={accountBusy || isOffline}
                                    onClick={() => {
                                      setAccountError(null);
                                      setConfirmAction({
                                        kind: acc.disabled ? 'enable' : 'disable',
                                        account: acc,
                                      });
                                    }}
                                  >
                                    {acc.disabled ? (
                                      <UserCheck size={14} aria-hidden="true" />
                                    ) : (
                                      <UserMinus size={14} aria-hidden="true" />
                                    )}
                                    <span>{acc.disabled ? 'Restore' : 'Disable'}</span>
                                  </button>
                                  <button
                                    type="button"
                                    className="crm-btn-danger !min-h-10 !px-3 !py-1.5 !text-xs"
                                    aria-label={`Remove ${acc.name}`}
                                    disabled={accountBusy || isOffline}
                                    onClick={() => {
                                      setAccountError(null);
                                      setConfirmAction({ kind: 'remove', account: acc });
                                    }}
                                  >
                                    <Trash2 size={14} aria-hidden="true" />
                                    <span>Remove</span>
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          ) : null}

          <section aria-labelledby="crm-invites-heading" className="crm-panel p-4 sm:p-5">
            <h2 id="crm-invites-heading" className="text-sm font-semibold">
              Unused invites
            </h2>
            {copyFallbackCode && (
              <div className="mt-2 rounded-lg border border-[var(--crm-border)] bg-[var(--crm-bg)] p-2.5 text-xs">
                <span className="font-medium">Copy manually: </span>
                <code className="select-all font-mono font-semibold">{copyFallbackCode}</code>
              </div>
            )}
            {unusedInvites.length === 0 ? (
              <p className="mt-2 text-xs text-[var(--crm-text-muted)]">
                No unused invite codes. Create an invite when adding a teammate.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-[var(--crm-border)] rounded-lg border border-[var(--crm-border)]">
                {unusedInvites.map((inv) => (
                  <li
                    key={inv.code}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
                  >
                    <div className="flex items-center gap-2.5">
                      <code className="font-mono text-sm font-semibold tracking-wider">
                        {inv.code}
                      </code>
                      <span className="rounded-full border border-[var(--crm-border)] bg-[var(--crm-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--crm-text-muted)]">
                        Unused
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="crm-btn-secondary !min-h-10 !px-3 !py-1.5 !text-xs"
                        onClick={() => void handleCopyInvite(inv.code)}
                      >
                        {copiedCode === inv.code ? (
                          <Check size={14} aria-hidden="true" />
                        ) : (
                          <Copy size={14} aria-hidden="true" />
                        )}
                        <span>{copiedCode === inv.code ? 'Copied' : 'Copy'}</span>
                      </button>
                      <button
                        type="button"
                        className="crm-btn-danger !min-h-10 !px-3 !py-1.5 !text-xs"
                        disabled={isOffline}
                        aria-label={`Delete invite ${inv.code}`}
                        onClick={() => void handleDeleteInvite(inv.code)}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                        <span>Delete</span>
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </section>
      )}

      {/* ---------------- Capabilities Tab ---------------- */}
      {tab === 'capabilities' && (
        <section
          role="tabpanel"
          id="crm-panel-capabilities"
          aria-labelledby="crm-tab-capabilities"
          className="space-y-4"
        >
          {overview && overview.length > 0 ? (
            <>
              <div className="crm-panel flex flex-wrap items-end justify-between gap-4 p-3 sm:p-4">
                <div className="w-full min-w-0 flex-1 sm:min-w-[220px] sm:max-w-sm">
                  <label
                    htmlFor="crm-cap-account-select"
                    className="mb-1 block text-xs font-medium text-[var(--crm-text-muted)]"
                  >
                    Account
                  </label>
                  <select
                    id="crm-cap-account-select"
                    aria-label="Account"
                    className="crm-select"
                    value={selectedAccount?.userId ?? ''}
                    onChange={(e) => setSelectedUserId(e.target.value)}
                  >
                    {overview.map((acc) => (
                      <option key={acc.userId} value={acc.userId}>
                        {acc.name} (@{acc.username}) · {roleLabel(acc.role)}
                        {acc.disabled ? ' (Disabled)' : ''}
                      </option>
                    ))}
                  </select>
                </div>

                {selectedAccount && (
                  <p className="crm-tabular text-xs font-medium text-[var(--crm-text-muted)]">
                    {selectedAccount.implicitAll
                      ? 'All 13 capabilities (owner)'
                      : `Effective: ${effectiveGrantCount(selectedAccount)} of ${CRM_CAPABILITIES.length}`}
                  </p>
                )}
              </div>

              {selectedAccount && (
                <CapabilityMatrix
                  account={selectedAccount}
                  actorId={me?.id ?? ''}
                  actorIsOwner={status.owner}
                  isOffline={isOffline}
                  reasonInput={reasonInput}
                  onReasonChange={setReasonInput}
                  accountNames={accountNames}
                  pendingByKey={pendingByKey}
                  failedToggle={failedToggle}
                  onToggle={(acc, cap, held, retryOpts) =>
                    void handleToggle(acc, cap, held, retryOpts)
                  }
                />
              )}
            </>
          ) : loadingOverview ? (
            <div className="crm-panel space-y-3 p-5" aria-busy="true">
              <div className="crm-skeleton h-10 w-64" />
              <div className="crm-skeleton h-16 w-full" />
              <div className="crm-skeleton h-16 w-full" />
            </div>
          ) : (
            <div className="crm-panel p-5 text-sm text-[var(--crm-text-muted)]">
              No accounts loaded yet.
            </div>
          )}
        </section>
      )}

      {/* ---------------- History Tab ---------------- */}
      {tab === 'history' && (
        <section
          role="tabpanel"
          id="crm-panel-history"
          aria-labelledby="crm-tab-history"
          className="space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-[var(--crm-text-muted)]">
              Append-only log of CRM capability grants and revocations, including automatic
              revocations when accounts are disabled.
            </p>
            <button
              type="button"
              className="crm-btn-secondary !min-h-10 !px-3 !py-1.5 !text-xs"
              disabled={loadingAudit || isOffline}
              onClick={() => void loadAudit()}
            >
              <RefreshCw size={14} aria-hidden="true" className={loadingAudit ? 'animate-spin' : ''} />
              <span>Reload log</span>
            </button>
          </div>

          {auditError && (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm"
              style={{
                backgroundColor: 'var(--crm-err-bg)',
                color: 'var(--crm-err-text)',
                borderColor: 'var(--crm-err-border)',
              }}
            >
              <span>{auditError}</span>
              <button
                type="button"
                className="crm-btn-secondary !min-h-9 !px-3 !py-1.5 !text-xs"
                onClick={() => void loadAudit()}
              >
                Retry
              </button>
            </div>
          )}

          {loadingAudit && !auditItems ? (
            <div className="crm-panel space-y-3 p-5" aria-busy="true">
              <div className="crm-skeleton h-10 w-full" />
              <div className="crm-skeleton h-10 w-full" />
              <div className="crm-skeleton h-10 w-full" />
            </div>
          ) : auditItems && auditItems.length === 0 ? (
            <div className="crm-panel p-6 text-center">
              <Clock size={22} aria-hidden="true" className="mx-auto text-[var(--crm-text-muted)]" />
              <p className="mt-2 text-sm font-semibold">No capability changes recorded yet</p>
              <p className="mt-1 text-xs text-[var(--crm-text-muted)]">
                Grants, revocations, and disable-time cleanups will appear here in chronological
                order.
              </p>
            </div>
          ) : auditItems ? (
            <>
              {isCompact ? (
                <ul className="space-y-3">
                  {auditItems.map((item) => {
                    const capMeta = CRM_CAPABILITY_LABELS[item.capability];
                    return (
                      <li key={item.id} className="crm-panel space-y-2 p-4 text-xs">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span
                            className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 font-semibold"
                            style={{
                              backgroundColor:
                                item.action === 'grant'
                                  ? 'var(--crm-ok-bg)'
                                  : 'var(--crm-err-bg)',
                              color:
                                item.action === 'grant'
                                  ? 'var(--crm-ok-text)'
                                  : 'var(--crm-err-text)',
                            }}
                          >
                            {item.action === 'grant' ? (
                              <ShieldCheck size={12} aria-hidden="true" />
                            ) : (
                              <XCircle size={12} aria-hidden="true" />
                            )}
                            <span>{item.action === 'grant' ? 'Granted' : 'Revoked'}</span>
                          </span>
                          <span className="crm-tabular text-[var(--crm-text-muted)]">
                            {formatTimestamp(item.createdAt)}
                          </span>
                        </div>
                        <p className="text-sm font-semibold">{capMeta.label}</p>
                        <p className="text-[var(--crm-text-muted)]">
                          Target: <strong className="text-[var(--crm-text)]">{item.targetName ?? 'Removed account'}</strong> · Actor:{' '}
                          <strong className="text-[var(--crm-text)]">{item.actorName ?? 'Removed account'}</strong>
                        </p>
                        <p className="text-[var(--crm-text-muted)]">
                          Scope: {item.scope === '*' ? 'All' : item.scope}
                          {item.reason
                            ? ` · Reason: ${
                                item.reason === 'account_disabled' ? 'Account disabled' : item.reason
                              }`
                            : ''}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="crm-table-wrap" role="region" aria-label="Capability audit history" tabIndex={0}>
                  <table className="crm-table">
                    <thead>
                      <tr>
                        <th scope="col">Time</th>
                        <th scope="col">Actor</th>
                        <th scope="col">Target</th>
                        <th scope="col">Action</th>
                        <th scope="col">Capability</th>
                        <th scope="col">Scope</th>
                        <th scope="col">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditItems.map((item) => {
                        const capMeta = CRM_CAPABILITY_LABELS[item.capability];
                        return (
                          <tr key={item.id}>
                            <td className="crm-tabular whitespace-nowrap text-xs text-[var(--crm-text-muted)]">
                              {formatTimestamp(item.createdAt)}
                            </td>
                            <td>{item.actorName ?? 'Removed account'}</td>
                            <td className="font-medium">{item.targetName ?? 'Removed account'}</td>
                            <td>
                              <span
                                className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold"
                                style={{
                                  backgroundColor:
                                    item.action === 'grant'
                                      ? 'var(--crm-ok-bg)'
                                      : 'var(--crm-err-bg)',
                                  color:
                                    item.action === 'grant'
                                      ? 'var(--crm-ok-text)'
                                      : 'var(--crm-err-text)',
                                }}
                              >
                                {item.action === 'grant' ? (
                                  <ShieldCheck size={12} aria-hidden="true" />
                                ) : (
                                  <XCircle size={12} aria-hidden="true" />
                                )}
                                <span>{item.action === 'grant' ? 'Granted' : 'Revoked'}</span>
                              </span>
                            </td>
                            <td className="font-medium">{capMeta.label}</td>
                            <td>{item.scope === '*' ? 'All' : item.scope}</td>
                            <td className="text-xs text-[var(--crm-text-muted)]">
                              {item.reason === 'account_disabled' ? (
                                <span
                                  className="rounded-full px-2 py-0.5 font-medium"
                                  style={{
                                    backgroundColor: 'var(--crm-warn-bg)',
                                    color: 'var(--crm-warn-text)',
                                  }}
                                >
                                  Account disabled
                                </span>
                              ) : (
                                item.reason || '—'
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {auditNext && (
                <div className="flex justify-center">
                  <button
                    type="button"
                    className="crm-btn-secondary"
                    disabled={loadingMoreAudit || isOffline}
                    onClick={() => void loadAudit(auditNext)}
                  >
                    <span>{loadingMoreAudit ? 'Loading older…' : 'Load older'}</span>
                  </button>
                </div>
              )}
            </>
          ) : null}
        </section>
      )}

      {/* ---------------- Mobile Capabilities Sheet ---------------- */}
      {sheetAccount && (
        <Sheet
          side="full"
          label={`Capabilities for ${sheetAccount.name}`}
          onClose={() => setSheetAccountId(null)}
        >
          <div data-app="crm" className="flex h-full min-h-0 flex-col bg-[var(--crm-bg)] text-[var(--crm-text)]">
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--crm-border)] bg-[var(--crm-surface)] px-4 py-3">
              <div className="min-w-0">
                <p className="text-xs text-[var(--crm-text-muted)]">Capabilities</p>
                <h2 className="truncate text-base font-semibold">{sheetAccount.name}</h2>
              </div>
              <button
                type="button"
                className="crm-btn-secondary !min-h-11 !px-3.5"
                onClick={() => setSheetAccountId(null)}
              >
                Done
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <CapabilityMatrix
                account={sheetAccount}
                actorId={me?.id ?? ''}
                actorIsOwner={status.owner}
                isOffline={isOffline}
                reasonInput={reasonInput}
                onReasonChange={setReasonInput}
                accountNames={accountNames}
                pendingByKey={pendingByKey}
                failedToggle={failedToggle}
                onToggle={(acc, cap, held, retryOpts) =>
                  void handleToggle(acc, cap, held, retryOpts)
                }
              />
            </div>
          </div>
        </Sheet>
      )}

      {/* ---------------- Confirmation Dialog ---------------- */}
      {confirmAction && (
        <AdaptiveDialog
          title={
            confirmAction.kind === 'disable'
              ? `Disable ${confirmAction.account.name}?`
              : confirmAction.kind === 'enable'
                ? `Restore ${confirmAction.account.name}?`
                : `Remove ${confirmAction.account.name}?`
          }
          onClose={() => {
            if (!accountBusy) setConfirmAction(null);
          }}
          guard={() => !accountBusy}
        >
          <div data-app="crm" className="space-y-4 text-sm text-[var(--crm-text)]">
            {confirmAction.kind === 'disable' && (
              <p className="text-[var(--crm-text-muted)]">
                This signs them out everywhere, frees their active workspace place, and immediately
                revokes every CRM capability they hold with an audit entry. Re-enabling later will
                not restore CRM capabilities.
              </p>
            )}
            {confirmAction.kind === 'enable' && (
              <p className="text-[var(--crm-text-muted)]">
                Restoring workspace access requires a free place within the seven active accounts.
                Previous CRM capabilities stay revoked until granted again.
              </p>
            )}
            {confirmAction.kind === 'remove' && (
              <p className="text-[var(--crm-text-muted)]">
                This permanently removes the account and deletes its CRM capability grants while
                retaining append-only audit history.
              </p>
            )}

            {accountError && (
              <p
                role="alert"
                className="rounded-lg border px-3 py-2 text-xs"
                style={{
                  backgroundColor: 'var(--crm-err-bg)',
                  color: 'var(--crm-err-text)',
                  borderColor: 'var(--crm-err-border)',
                }}
              >
                {accountError}
              </p>
            )}

            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className="crm-btn-secondary"
                disabled={accountBusy}
                onClick={() => setConfirmAction(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={confirmAction.kind === 'enable' ? 'crm-btn-primary' : 'crm-btn-danger'}
                disabled={accountBusy || isOffline}
                onClick={() => void handleConfirmAccountAction()}
              >
                {accountBusy
                  ? 'Updating…'
                  : confirmAction.kind === 'disable'
                    ? 'Disable account'
                    : confirmAction.kind === 'enable'
                      ? 'Restore access'
                      : 'Remove account'}
              </button>
            </div>
          </div>
        </AdaptiveDialog>
      )}

      {/* ---------------- Owner-Only Rename Dialog ---------------- */}
      {renameTarget && status.owner && (
        <AdaptiveDialog
          title={`Rename ${renameTarget.name}`}
          onClose={() => {
            if (!renameBusy) setRenameTarget(null);
          }}
          guard={() => !renameBusy}
        >
          <form onSubmit={(e) => void handleRenameSubmit(e)} data-app="crm" className="space-y-4 text-sm text-[var(--crm-text)]">
            <p className="text-xs text-[var(--crm-text-muted)]">
              Changes are recorded in the workspace access audit log (`user.rename`). Only the workspace owner can rename another account.
            </p>
            <div>
              <label htmlFor="crm-rename-account-input" className="mb-1 block text-xs font-medium text-[var(--crm-text-muted)]">
                Display name
              </label>
              <input
                id="crm-rename-account-input"
                type="text"
                maxLength={80}
                required
                className="crm-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className="crm-btn-secondary"
                disabled={renameBusy}
                onClick={() => setRenameTarget(null)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="crm-btn-primary"
                disabled={renameBusy || isOffline || !renameValue.trim()}
              >
                {renameBusy ? 'Saving…' : 'Save name'}
              </button>
            </div>
          </form>
        </AdaptiveDialog>
      )}
    </div>
  );
}
