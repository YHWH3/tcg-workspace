import {
  ALL_SCOPE,
  CRM_CAPABILITIES,
  isCrmCapability,
  type CrmCapability,
  type CrmScope,
} from '../../shared/crm/capabilities';
import {
  CapabilityChangeRequestInputSchema,
  MAX_CAPABILITY_REASON_CHARS,
  type CapabilityChangeInput,
  type CapabilityInvalidReason,
  type CrmErrorCode,
} from '../../shared/crm/contracts';
import type { Env } from '../auth';

export type CanonicalRole = 'owner' | 'admin' | 'member' | 'guest';

export interface StoredGrant {
  capability: CrmCapability;
  scope: CrmScope;
  grantedBy: string;
  grantedAt: number;
}

export interface CrmActor {
  id: string;
  role: CanonicalRole;
  disabled: boolean;
  grants: StoredGrant[];
}

export interface CapabilityTarget {
  id: string;
  role: CanonicalRole;
  disabled: boolean;
  disabledAt: number | null;
}

export function isCrmEnabled(env: Pick<Env, 'CRM_ENABLED'>): boolean {
  const value = (env.CRM_ENABLED ?? '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

export function normalizeCanonicalRole(
  workspaceRole: string | null | undefined,
  legacyRole?: string | null | undefined,
): CanonicalRole {
  const raw = workspaceRole ?? legacyRole ?? 'member';
  if (raw === 'owner' || raw === 'admin' || raw === 'member' || raw === 'guest') return raw;
  return 'member';
}

export function hasRawGrant(
  grants: readonly Pick<StoredGrant, 'capability' | 'scope'>[],
  capability: CrmCapability,
  scope: CrmScope = ALL_SCOPE,
): boolean {
  return grants.some(
    (g) => g.capability === capability && (g.scope === ALL_SCOPE || g.scope === scope),
  );
}

/**
 * Mandatory CRM gate (`crm.access`, SC-2.1).
 * Owners implicitly hold access; guests and disabled accounts never do.
 */
export function hasEffectiveAccess(
  actor: Pick<CrmActor, 'role' | 'disabled' | 'grants'>,
): boolean {
  if (actor.disabled || actor.role === 'guest') return false;
  if (actor.role === 'owner') return true;
  return hasRawGrant(actor.grants, 'crm.access', ALL_SCOPE);
}

/**
 * Evaluate whether an actor effectively holds `(capability, scope)` (SC-2.1).
 * For non-owners, no specialised capability is effective without `crm.access` ('*'),
 * and `crm.capabilities.manage` additionally requires current role === 'admin'.
 */
export function evaluateCapability(
  actor: Pick<CrmActor, 'role' | 'disabled' | 'grants'>,
  capability: CrmCapability,
  scope: CrmScope = ALL_SCOPE,
): boolean {
  if (actor.disabled || actor.role === 'guest') return false;
  if (actor.role === 'owner') return true;
  if (!hasEffectiveAccess(actor)) return false;
  if (capability === 'crm.access') return true;
  if (capability === 'crm.capabilities.manage') {
    return actor.role === 'admin' && hasRawGrant(actor.grants, 'crm.capabilities.manage', ALL_SCOPE);
  }
  return hasRawGrant(actor.grants, capability, scope);
}

export function effectiveCapabilitiesForUser(
  actor: Pick<CrmActor, 'role' | 'disabled' | 'grants'>,
  enabled: boolean,
): { capability: CrmCapability; scope: CrmScope }[] {
  if (!enabled || !hasEffectiveAccess(actor)) return [];
  if (actor.role === 'owner') {
    return CRM_CAPABILITIES.map((capability) => ({ capability, scope: ALL_SCOPE }));
  }
  const seen = new Set<string>();
  const out: { capability: CrmCapability; scope: CrmScope }[] = [];
  for (const grant of actor.grants) {
    if (!isCrmCapability(grant.capability)) continue;
    if (!evaluateCapability(actor, grant.capability, grant.scope)) continue;
    const key = `${grant.capability}\0${grant.scope}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ capability: grant.capability, scope: grant.scope });
  }
  out.sort((a, b) =>
    a.capability < b.capability
      ? -1
      : a.capability > b.capability
        ? 1
        : a.scope < b.scope
          ? -1
          : a.scope > b.scope
            ? 1
            : 0,
  );
  return out;
}

export function canAccessCrmApi(actor: Pick<CrmActor, 'role' | 'disabled' | 'grants'>): boolean {
  return hasEffectiveAccess(actor);
}

export function canManageCapabilities(
  actor: Pick<CrmActor, 'role' | 'disabled' | 'grants'>,
): boolean {
  return evaluateCapability(actor, 'crm.capabilities.manage', ALL_SCOPE);
}

export function canTouchCapability(
  actor: Pick<CrmActor, 'role' | 'disabled' | 'grants'>,
  capability: CrmCapability,
): boolean {
  if (!canManageCapabilities(actor)) return false;
  if (capability === 'crm.capabilities.manage') return actor.role === 'owner';
  return true;
}

export type ParsedCapabilityInputResult =
  | { ok: true; input: CapabilityChangeInput }
  | { ok: false; error: 'invalid_input'; detail: Record<string, unknown> };

/**
 * Implements SC-5.1 steps 3, 4, 5 in exact precedence order:
 * 3. Wire schema + trimmed reason <= 500 chars
 * 4. unknown_capability
 * 5. unknown_scope (S0 accepts only '*')
 */
export function parseCapabilityChangeInput(
  raw: Record<string, unknown>,
): ParsedCapabilityInputResult {
  const parsed = CapabilityChangeRequestInputSchema.safeParse(raw);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.length > 0 ? String(issue.path[0]) : '_root';
      if (!(key in fields)) fields[key] = issue.message;
    }
    return { ok: false, error: 'invalid_input', detail: { fields } };
  }

  const trimmedReason = parsed.data.reason !== undefined ? parsed.data.reason.trim() : undefined;
  if (trimmedReason !== undefined && trimmedReason.length > MAX_CAPABILITY_REASON_CHARS) {
    return {
      ok: false,
      error: 'invalid_input',
      detail: { fields: { reason: `must be at most ${MAX_CAPABILITY_REASON_CHARS} characters` } },
    };
  }

  if (!isCrmCapability(parsed.data.capability)) {
    return {
      ok: false,
      error: 'invalid_input',
      detail: {
        reason: 'unknown_capability' satisfies CapabilityInvalidReason,
        fields: { capability: 'unknown_capability' },
      },
    };
  }

  if (parsed.data.scope !== ALL_SCOPE) {
    return {
      ok: false,
      error: 'invalid_input',
      detail: {
        reason: 'unknown_scope' satisfies CapabilityInvalidReason,
        fields: { scope: 'unknown_scope' },
      },
    };
  }

  return {
    ok: true,
    input: {
      userId: parsed.data.userId,
      capability: parsed.data.capability,
      scope: ALL_SCOPE,
      ...(trimmedReason ? { reason: trimmedReason } : {}),
    },
  };
}

export type CapabilityChangePlanDecision =
  | { ok: false; error: CrmErrorCode; detail?: Record<string, unknown> }
  | { ok: true; already: boolean; held: boolean };

/**
 * Implements SC-5.1 steps 8-15 in exact precedence order.
 * Caller must have already verified steps 1-7 (auth, coarse, wire parse, fine, idempotency).
 */
export function planCapabilityChange(
  action: 'grant' | 'revoke',
  actor: Pick<CrmActor, 'id' | 'role' | 'disabled' | 'grants'>,
  input: CapabilityChangeInput,
  target: Pick<CapabilityTarget, 'id' | 'role' | 'disabled'> | null,
  existingGrant: StoredGrant | null,
): CapabilityChangePlanDecision {
  // Step 8: Target exists
  if (!target) {
    return { ok: false, error: 'not_found' };
  }
  // Step 9: Owner is implicit
  if (target.role === 'owner') {
    return {
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'owner_implicit' satisfies CapabilityInvalidReason },
    };
  }
  // Step 10: Self grant/revoke forbidden
  if (target.id === actor.id) {
    return {
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'self_grant' satisfies CapabilityInvalidReason },
    };
  }
  // Step 11: Guests are never eligible
  if (target.role === 'guest') {
    return {
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'guest_not_eligible' satisfies CapabilityInvalidReason },
    };
  }
  // Step 12: Disabled accounts cannot be granted (revocation is still allowed)
  if (action === 'grant' && target.disabled) {
    return {
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'account_disabled' satisfies CapabilityInvalidReason },
    };
  }
  // Step 13: Only admins can be granted crm.capabilities.manage (revoke allowed on demoted members)
  if (action === 'grant' && input.capability === 'crm.capabilities.manage' && target.role !== 'admin') {
    return {
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'not_admin' satisfies CapabilityInvalidReason },
    };
  }
  // Step 14: No-op when state already matches
  const held = action === 'grant';
  const already = held ? existingGrant !== null : existingGrant === null;
  // Step 15: State change when !already
  return { ok: true, already, held };
}
