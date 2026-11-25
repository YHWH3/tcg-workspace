import { z } from 'zod';
import {
  CRM_CAPABILITIES,
  PROGRAMME_SCOPED,
  type CrmCapability,
  type CrmScope,
} from './capabilities';
import { parseProgrammeScope } from './programmes';

export const CRM_CONTRACT_VERSION = 'crm-s0-v2' as const;

/** 8-64 characters from [A-Za-z0-9_-]. Client-generated, one per user action;
 * reused verbatim when the same action is retried after a network or 503 failure. */
export type RequestId = string;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const MAX_COMMAND_BODY_BYTES = 65_536; // contract value (UTF-8 bytes)
export const MAX_COMMAND_RESULT_BYTES = 16_384; // contract value (UTF-8 bytes)
export const MAX_EXPECTED_ENTRIES = 100; // matches MAX_EXPECTED in worker/sync.ts

export const CRM_COMMAND_CHANNELS = ['ui', 'mcp', 'automation', 'ingest'] as const;
export type CrmCommandChannel = typeof CRM_COMMAND_CHANNELS[number];

export interface CommandRequest<I> {
  requestId: RequestId;
  input: I;
  /** object id -> revision the caller read (non-negative safe integer). */
  expected?: Record<string, number>;
}

export interface CommandResult<O> {
  ok: true;
  commandId: string;
  result: O;
  /** Records whose projection fields this command wrote. Empty in S0. */
  projections: { recordId: string; rev: number }[];
}

export interface CommandError {
  ok: false;
  error: CrmErrorCode;
  detail?: Record<string, unknown>;
  retryable: boolean;
}

export const CRM_ERROR_CODES = [
  'unauthenticated',
  'forbidden',
  'not_found',
  'stale',
  'idempotency_conflict',
  'invalid_input',
  'capacity_exceeded',
  'hold_expired',
  'window_closed',
  'consent_withdrawn',
  'provider_unavailable',
  'currency_mismatch',
  'approval_required',
  'budget_exceeded',
  'source_changed',
] as const;
export type CrmErrorCode = typeof CRM_ERROR_CODES[number];

/** retryable value every CommandError must carry for each code. */
export const CRM_ERROR_RETRYABLE: Record<CrmErrorCode, boolean> = {
  unauthenticated: false,
  forbidden: false,
  not_found: false,
  stale: true,
  idempotency_conflict: false,
  invalid_input: false,
  capacity_exceeded: false,
  hold_expired: false,
  window_closed: false,
  consent_withdrawn: false,
  provider_unavailable: true,
  currency_mismatch: false,
  approval_required: false,
  budget_exceeded: false,
  source_changed: true,
};

export const CRM_CURSOR_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const AUDIT_PAGE_LIMIT = 50; // contract value

export const CrmHttpErrorSchema = z.object({
  error: z.string().min(1),
}).strict();

export const CrmRetryableHttpErrorSchema = z.object({
  error: z.enum(['processing_budget', 'write_interrupted']),
  retryable: z.literal(true),
}).strict();

export const CommandRequestEnvelopeSchema = z.object({
  requestId: z.string().regex(REQUEST_ID_PATTERN),
  input: z.record(z.string(), z.unknown()),
  expected: z.record(
    z.string().min(1).max(64),
    z.number().int().min(0).refine(Number.isSafeInteger),
  ).refine((obj) => Object.keys(obj).length <= MAX_EXPECTED_ENTRIES, {
    message: `expected may contain at most ${MAX_EXPECTED_ENTRIES} entries`,
  }).optional(),
}).strict();

export const commandResultSchema = <O extends z.ZodTypeAny>(outputSchema: O) =>
  z.object({
    ok: z.literal(true),
    commandId: z.string().min(1).max(64),
    result: outputSchema,
    projections: z.array(z.object({
      recordId: z.string().min(1).max(64),
      rev: z.number().int().min(1),
    }).strict()),
  }).strict();

export const CrmErrorCodeSchema = z.enum(CRM_ERROR_CODES);

export const CommandErrorSchema = z.object({
  ok: z.literal(false),
  error: CrmErrorCodeSchema,
  detail: z.record(z.string(), z.unknown()).optional(),
  retryable: z.boolean(),
}).strict().superRefine((val, ctx) => {
  if (val.retryable !== CRM_ERROR_RETRYABLE[val.error]) {
    ctx.addIssue({
      code: 'custom',
      path: ['retryable'],
      message: `retryable must be ${CRM_ERROR_RETRYABLE[val.error]} for ${val.error}`,
    });
  }
});

export const CrmCapabilitySchema = z.enum(CRM_CAPABILITIES);
export const CrmScopeSchema = z.string().min(1).max(64);
export const S0ScopeSchema = z.literal('*');

export interface CrmStatus {
  contract: typeof CRM_CONTRACT_VERSION;
  enabled: boolean; // SC-9
  access: boolean; // holds crm.access (always false when !enabled)
  owner: boolean; // current role is owner
  capabilities: { capability: CrmCapability; scope: CrmScope }[]; // effective; [] when !enabled || !access
}

export const CrmStatusSchema = z.object({
  contract: z.literal(CRM_CONTRACT_VERSION),
  enabled: z.boolean(),
  access: z.boolean(),
  owner: z.boolean(),
  capabilities: z.array(z.object({
    capability: CrmCapabilitySchema,
    scope: CrmScopeSchema,
  }).strict()),
}).strict();

export interface CapabilityOverviewAccount {
  userId: string;
  name: string;
  username: string;
  role: 'owner' | 'admin' | 'member' | 'guest';
  disabled: boolean;
  eligible: boolean; // false for guests and disabled accounts
  implicitAll: boolean; // true only for the owner
  effectiveAccess: boolean; // true for owner, or active non-guest holding crm.access
  grants: { capability: CrmCapability; scope: CrmScope; grantedBy: string; grantedAt: number }[];
}

export interface CapabilityOverview {
  accounts: CapabilityOverviewAccount[];
}

export const CapabilityOverviewSchema = z.object({
  accounts: z.array(z.object({
    userId: z.string().min(1).max(64),
    name: z.string(),
    username: z.string(),
    role: z.enum(['owner', 'admin', 'member', 'guest']),
    disabled: z.boolean(),
    eligible: z.boolean(),
    implicitAll: z.boolean(),
    effectiveAccess: z.boolean(),
    grants: z.array(z.object({
      capability: CrmCapabilitySchema,
      scope: CrmScopeSchema,
      grantedBy: z.string().min(1).max(64),
      grantedAt: z.number().int().nonnegative(),
    }).strict()),
  }).strict()),
}).strict();

export interface CapabilityAuditItem {
  id: string;
  createdAt: number;
  actorId: string;
  actorName: string | null; // null when the account was removed
  targetUserId: string;
  targetName: string | null;
  action: 'grant' | 'revoke';
  capability: CrmCapability;
  scope: CrmScope;
  reason: string | null; // includes 'account_disabled' (SC-7)
}

export interface CapabilityAuditPage {
  items: CapabilityAuditItem[]; // newest first, at most 50 (contract value)
  next: string | null; // opaque base64url keyset cursor over (created_at, id)
}

export const CapabilityAuditItemSchema = z.object({
  id: z.string().min(1).max(64),
  createdAt: z.number().int().nonnegative(),
  actorId: z.string().min(1).max(64),
  actorName: z.string().nullable(),
  targetUserId: z.string().min(1).max(64),
  targetName: z.string().nullable(),
  action: z.enum(['grant', 'revoke']),
  capability: CrmCapabilitySchema,
  scope: CrmScopeSchema,
  reason: z.string().nullable(),
}).strict();

export const CapabilityAuditPageSchema = z.object({
  items: z.array(CapabilityAuditItemSchema).max(AUDIT_PAGE_LIMIT),
  next: z.string().max(256).nullable(),
}).strict();

export const MAX_CAPABILITY_REASON_CHARS = 500; // contract value

/** Wire schema accepted by the command parser so unknown_capability and unknown_scope
 * produce business CommandError('invalid_input') rather than HTTP 400. */
export const CapabilityChangeRequestInputSchema = z.object({
  userId: z.string().min(1).max(64),
  capability: z.string().min(1).max(64),
  scope: z.string().min(1).max(64),
  reason: z.string().max(MAX_CAPABILITY_REASON_CHARS * 2).optional(),
}).strict();

export interface CapabilityChangeInput {
  userId: string;
  capability: CrmCapability;
  scope: CrmScope;
  reason?: string; // trimmed, at most 500 characters (omitted when blank)
}

export const CapabilityChangeInputSchema = z.object({
  userId: z.string().min(1).max(64),
  capability: CrmCapabilitySchema,
  scope: CrmScopeSchema,
  reason: z.string().min(1).max(MAX_CAPABILITY_REASON_CHARS).optional(),
}).strict().superRefine((val, ctx) => {
  const parsedScope = parseProgrammeScope(val.scope);
  if (!parsedScope.ok) {
    ctx.addIssue({ code: 'custom', path: ['scope'], message: 'unknown_scope' });
    return;
  }
  if (parsedScope.slug !== '*' && !PROGRAMME_SCOPED.has(val.capability)) {
    ctx.addIssue({ code: 'custom', path: ['scope'], message: 'unknown_scope' });
  }
});

export interface CapabilityChangeOutput {
  already: boolean; // true: no grant/audit state change (still writes crm_commands journal)
  grant: { userId: string; capability: CrmCapability; scope: CrmScope; held: boolean };
}

export const CapabilityChangeOutputSchema = z.object({
  already: z.boolean(),
  grant: z.object({
    userId: z.string().min(1).max(64),
    capability: CrmCapabilitySchema,
    scope: CrmScopeSchema,
    held: z.boolean(),
  }).strict(),
}).strict();

export const CapabilityChangeResultSchema = commandResultSchema(CapabilityChangeOutputSchema);

export const CAPABILITY_INVALID_REASONS = [
  'guest_not_eligible',
  'self_grant',
  'owner_implicit',
  'unknown_capability',
  'unknown_scope',
  'account_disabled',
  'not_admin',
] as const;
export type CapabilityInvalidReason = typeof CAPABILITY_INVALID_REASONS[number];

export const OWNER_PROTECTED_ERROR = 'owner_protected' as const;
