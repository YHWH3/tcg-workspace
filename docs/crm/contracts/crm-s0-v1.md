# CRM shared contracts: `crm-s0-v1`

| Item | Value |
|---|---|
| Version | `crm-s0-v1` |
| Status | **Candidate.** Pending independent review by ChatGPT. Not frozen until that review is recorded in the change log below. This is not an authorisation to implement S0. |
| Date | 24 November 2026 |
| Baseline | `38c388ac1787b0ff14e8e26d7abd1bf8c6bd0444`, branch `crm/foundation` |
| Owner | Opus (technical contracts, A-26) |
| Consumers | Neon (backend), Opus (frontend), ChatGPT (review) |
| Decisions applied | A-19 to A-26 (`../01-DECISIONS.md`) |
| Related | `../07-CONTRACTS.md` (full CRM contract catalogue for all slices), `../S0-PLAN.md` (S0 implementation plan), `../BACKEND-S0-BRIEF.md` (backend handoff) |

## How to read this document

- **Normative.** Everything in this file is binding for S0 once frozen. Where `07-CONTRACTS.md` covers later slices, this file is the S0 subset and wins for S0 if the two ever differ (report any difference as a discrepancy).
- **Code transcription.** The TypeScript blocks are the exact public shape of three shared files: `shared/crm/contracts.ts` (SC-1, SC-4, SC-5, SC-6), `shared/crm/capabilities.ts` (SC-2 catalogue) and `shared/crm/projection.ts` (SC-3). Opus creates them verbatim when implementation is authorised; zod schemas in `shared/crm/contracts.ts` must accept exactly what these types describe. Behaviour-only contracts (SC-7, SC-9) and the SQL contract (SC-8) are implemented by Neon.
- **Changing a contract.** Only through the change procedure (`../S0-PLAN.md` section 2): change request, ChatGPT review, Opus edits this file and bumps the version (`crm-s0-v2`), Paul approves when an owner decision, security behaviour, the authority model or an applied migration is affected. Neither implementation agent edits this file or the three shared code files on its own.
- **Bounded values** marked *(contract value)* are design choices made here, not measured facts; changing one is a contract change.

## SC-1. Command envelope, error codes, request IDs

```ts
// shared/crm/contracts.ts
export const CRM_CONTRACT_VERSION = 'crm-s0-v1' as const;

/** 8-64 characters from [A-Za-z0-9_-]. Client-generated, one per user action;
 * reused verbatim when the same action is retried after a network failure. */
export type RequestId = string;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export interface CommandRequest<I> {
  requestId: RequestId;
  input: I;
  /** object id -> revision the caller read. Commands that use authority fences
   * instead of record revisions (capability.grant, capability.revoke) ignore it. */
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
  'unauthenticated', 'forbidden', 'not_found', 'stale', 'idempotency_conflict',
  'invalid_input', 'capacity_exceeded', 'hold_expired', 'window_closed',
  'consent_withdrawn', 'provider_unavailable', 'currency_mismatch',
  'approval_required', 'budget_exceeded', 'source_changed',
] as const;
export type CrmErrorCode = typeof CRM_ERROR_CODES[number];

/** retryable value every CommandError must carry for each code. */
export const CRM_ERROR_RETRYABLE: Record<CrmErrorCode, boolean> = {
  unauthenticated: false, forbidden: false, not_found: false, stale: true,
  idempotency_conflict: false, invalid_input: false, capacity_exceeded: false,
  hold_expired: false, window_closed: false, consent_withdrawn: false,
  provider_unavailable: true, currency_mismatch: false, approval_required: false,
  budget_exceeded: false, source_changed: true,
};
```

Rules:

1. Same actor + same `requestId` + same request hash → the stored `CommandResult` or `CommandError` is returned and no effect repeats. The hash covers `{ name, input }` (canonical JSON, SHA-256).
2. Same actor + same `requestId` + different hash → `idempotency_conflict`.
3. A plan-time refusal (`forbidden`, `invalid_input`, `not_found`) writes nothing, **not even a journal row**, so the caller may correct the input and retry with a new `requestId`.
4. `stale` means an authority or revision fence failed at commit: nothing was written; re-read, then retry with a new `requestId`.
5. `not_found` covers both "missing" and "not readable by you" (no information leak).
6. Codes emitted in S0: `forbidden`, `not_found`, `stale`, `idempotency_conflict`, `invalid_input`, `budget_exceeded`. The other codes are reserved for later slices; their meaning is in `../07-CONTRACTS.md` section 2.

## SC-2. Capability catalogue and evaluation

```ts
// shared/crm/capabilities.ts
export const CRM_CHANNELS = ['email', 'whatsapp', 'instagram', 'facebook'] as const;
export type CrmChannel = typeof CRM_CHANNELS[number];

export const CRM_CAPABILITIES = [
  'crm.access',
  'crm.send:email', 'crm.send:whatsapp', 'crm.send:instagram', 'crm.send:facebook',
  'crm.restricted.read', 'crm.finance.read', 'crm.finance.record', 'crm.refund.approve',
  'crm.configure', 'crm.merge', 'crm.channels.manage', 'crm.capabilities.manage',
] as const;
export type CrmCapability = typeof CRM_CAPABILITIES[number];

/** Scope '*' = all programmes. crm-s0-v1 accepts only '*' (see rule 7). */
export type CrmScope = '*' | string;
export const ALL_SCOPE = '*' as const;

/** Capabilities that will accept a programme scope once the programme registry exists (S2). */
export const PROGRAMME_SCOPED: ReadonlySet<CrmCapability> = new Set(['crm.restricted.read', 'crm.configure']);

export const CRM_CAPABILITY_LABELS: Record<CrmCapability, { label: string; description: string; sensitive: boolean }> = {
  'crm.access':              { label: 'Open the CRM', description: 'Use the CRM app and its relationship records.', sensitive: false },
  'crm.send:email':          { label: 'Send email', description: 'Send email from the shared mailbox.', sensitive: false },
  'crm.send:whatsapp':       { label: 'Send WhatsApp', description: 'Send WhatsApp messages.', sensitive: false },
  'crm.send:instagram':      { label: 'Send Instagram', description: 'Send Instagram messages.', sensitive: false },
  'crm.send:facebook':       { label: 'Send Facebook', description: 'Send Facebook Page messages.', sensitive: false },
  'crm.restricted.read':     { label: 'Read restricted notes', description: 'See screening, health, suitability and other restricted notes.', sensitive: true },
  'crm.finance.read':        { label: 'See money', description: 'See payments, balances and refunds.', sensitive: true },
  'crm.finance.record':      { label: 'Record payments', description: 'Record payments, reversals and issued refunds.', sensitive: true },
  'crm.refund.approve':      { label: 'Approve refunds', description: 'Approve refund requests made by others.', sensitive: true },
  'crm.configure':           { label: 'Configure', description: 'Change programmes, CRM views, fields, automations and templates.', sensitive: false },
  'crm.merge':               { label: 'Merge people', description: 'Merge and unmerge duplicate people.', sensitive: false },
  'crm.channels.manage':     { label: 'Connect channels', description: 'Connect and disconnect channel accounts.', sensitive: false },
  'crm.capabilities.manage': { label: 'Manage capabilities', description: 'Grant and revoke CRM capabilities. Owner grants this, to admins only.', sensitive: true },
};
```

Evaluation rules (implemented server-side only, by Neon; the client never decides authority, it only displays what `/status` returns):

1. The actor must be active (`users.disabled_at IS NULL`) with a live session; a connector request also needs a live connector grant.
2. If the actor's **current** `COALESCE(workspace_role, role)` is `owner`, every capability is held at every scope. Computed at check time; no rows; cannot be revoked.
3. Otherwise a capability is held iff a `crm_capability_grants` row exists for (user, capability, scope) or (user, capability, `*`).
4. `crm.capabilities.manage` also requires the actor's current role to be `admin`; it has no effect for a member, and a demoted admin loses it without a revoke.
5. Guests hold nothing and cannot be granted anything.
6. `admin` or `member` alone implies nothing.
7. **crm-s0-v1 accepts only scope `*`.** Any other scope returns `invalid_input` with reason `unknown_scope`. Programme scopes for `PROGRAMME_SCOPED` capabilities arrive with the programme registry (S2) as a contract change.
8. These checks never depend on `access_state.enabled` (A-19).

## SC-3. Projection keys

```ts
// shared/crm/projection.ts
export const CRM_PROJECTION_PREFIX = '_crm_' as const;
export const isCrmProjectionKey = (key: string): boolean => key.startsWith(CRM_PROJECTION_PREFIX);

/** Constructed only by worker/crm/commands.ts from a registered command's static key list. */
export interface ProjectionGrant {
  command: string;
  keys: ReadonlySet<string>;
}
```

Rules:

1. A change whose patch contains a `_crm_` key is rejected item-wise by `applyChanges` with reason `protected_field` unless the call carries a `ProjectionGrant` that lists that exact key **and** the change's collection is `tasks`.
2. Applies with permissions off and on, to every caller: client push, MCP generic tools, automations, history restore, undo, forms, website ingest.
3. With permissions on, a granted key is not caught by the general `_` rule in `authorizeMutations`, but the normal space edit checks still apply to the command's actor.
4. Projections are display data. No decision may read a projection; decisions read server-only tables.
5. No S0 production command writes projections. S0 proves the rule with test-only commands.

## SC-4. CRM HTTP API

All routes are mounted at `/api/crm`, use the Workspace bearer session (`requireAuth`, `worker/auth.ts:217-222`) and set `Cache-Control: no-store` (already applied to `/api/*`, `worker/index.ts:49`).

| Route | Who | Success | Failure |
|---|---|---|---|
| `GET /api/crm/status` | Any signed-in account | `200 CrmStatus` | `401 { error: 'unauthenticated' }` |
| `POST /api/crm/commands/:name` | Any signed-in account (the command checks its own rights) | `200 CommandResult` or `200 CommandError` | `401 { error: 'unauthenticated' }`; `404 { error: 'not_found' }` when the CRM is disabled or `:name` is unknown; `413 { error: 'request_too_large' }` when the body exceeds 65,536 bytes *(contract value)*; `400 { error: 'invalid_body' }` when the body is not JSON or fails the envelope schema |
| `GET /api/crm/read/capabilities` | Owner, or admin holding `crm.capabilities.manage` | `200 CapabilityOverview` | 401; `403 { error: 'forbidden' }`; 404 when disabled |
| `GET /api/crm/read/capability-audit?cursor=` | Same as above | `200 CapabilityAuditPage` | 401; 403; 404 when disabled; `400 { error: 'invalid_cursor' }` |

```ts
// shared/crm/contracts.ts (continued)
export interface CrmStatus {
  contract: typeof CRM_CONTRACT_VERSION;
  enabled: boolean;              // SC-9
  access: boolean;               // holds crm.access (always false when !enabled)
  owner: boolean;                // current role is owner
  capabilities: { capability: CrmCapability; scope: CrmScope }[]; // effective; [] when !enabled
}

export interface CapabilityOverview {
  accounts: {
    userId: string; name: string; username: string;
    role: 'owner' | 'admin' | 'member' | 'guest';
    disabled: boolean;
    eligible: boolean;           // false for guests and for disabled accounts
    implicitAll: boolean;        // true only for the owner
    grants: { capability: CrmCapability; scope: CrmScope; grantedBy: string; grantedAt: number }[];
  }[];
}

export interface CapabilityAuditItem {
  id: string;
  createdAt: number;
  actorId: string; actorName: string | null;     // null when the account was removed
  targetUserId: string; targetName: string | null;
  action: 'grant' | 'revoke';
  capability: CrmCapability; scope: CrmScope;
  reason: string | null;                         // includes 'account_disabled' (SC-7)
}
export interface CapabilityAuditPage {
  items: CapabilityAuditItem[];                  // newest first, at most 50 (contract value)
  next: string | null;                           // opaque keyset cursor over (created_at, id)
}
```

Rules:

1. When the CRM is disabled (SC-9), every route except `/status` returns 404 and `/status` returns `{ enabled: false, access: false, owner, capabilities: [] }`.
2. For the owner, `capabilities` lists all 13 with scope `*`.
3. Every response validates against the zod schema for its type in `shared/crm/contracts.ts`, on both sides (backend tests and frontend mocks).
4. Reads stay inside `withD1Budget(env, 45)`.

## SC-5. `capability.grant` and `capability.revoke`

```ts
// shared/crm/contracts.ts (continued)
export interface CapabilityChangeInput {
  userId: string;
  capability: CrmCapability;
  scope: CrmScope;               // must be '*' in crm-s0-v1
  reason?: string;               // trimmed, at most 500 characters (contract value)
}
export interface CapabilityChangeOutput {
  already: boolean;              // true: no state change and no audit row
  grant: { userId: string; capability: CrmCapability; scope: CrmScope; held: boolean };
}
export const CAPABILITY_INVALID_REASONS = [
  'guest_not_eligible', 'self_grant', 'owner_implicit', 'unknown_capability', 'unknown_scope', 'account_disabled', 'not_admin',
] as const;
export type CapabilityInvalidReason = typeof CAPABILITY_INVALID_REASONS[number];
```

| Case | Outcome |
|---|---|
| Actor is the owner | Allowed for any eligible target and any capability, including `crm.capabilities.manage` (target must then be an admin) |
| Actor is an admin holding `crm.capabilities.manage` | Allowed for an eligible target other than themselves, for every capability except `crm.capabilities.manage` |
| Anyone else | `forbidden` |
| Target is the actor (non-owner) | `invalid_input`, reason `self_grant` |
| Target is the owner | `invalid_input`, reason `owner_implicit` |
| Target is a guest | `invalid_input`, reason `guest_not_eligible` |
| Target is disabled (grant only; revoke of a disabled account's grants is unnecessary because SC-7 removed them) | `invalid_input`, reason `account_disabled` |
| Granting `crm.capabilities.manage` to a target whose current role is not `admin` | `invalid_input`, reason `guest_not_eligible` for a guest, otherwise `not_admin` |
| Unknown capability string | `invalid_input`, reason `unknown_capability` |
| Scope other than `*` | `invalid_input`, reason `unknown_scope` |
| Target does not exist | `not_found` |
| Grant already held / revoke not held | `ok`, `already: true`, no audit row |
| Actor or target authority changed between read and commit | `stale` (retryable), nothing written |

Every state change writes, in one batch: the grant insert or delete, one `crm_capability_audit` row, and one `crm_commands` journal row. Neither command is ever registered as an MCP tool.

## SC-6. Owner protection on account routes (A-23)

| Route (existing, `worker/admin.ts`) | Target is the owner and actor is not | Everything else |
|---|---|---|
| `PATCH /api/users/:id` | `403 { error: 'owner_protected' }`, nothing written | Unchanged current behaviour |
| `POST /api/users/:id/disable` | `403 { error: 'owner_protected' }`, nothing written | Unchanged, plus SC-7 |
| `DELETE /api/users/:id` | `403 { error: 'owner_protected' }`, nothing written | Unchanged |

```ts
// shared/crm/contracts.ts (continued)
export const OWNER_PROTECTED_ERROR = 'owner_protected' as const;
```

Rules: enforced on the server by a pre-check and by a condition in the same batch's account fence (a target that became owner after the read aborts with the existing `409 { error: 'account_or_authority_changed' }`). The owner's own self-change refusals and the last-privileged-account fence remain. No route takes the owner out of the `owner` role, disables it or removes it.

## SC-7. Capability revocation on disable (A-25)

1. `POST /api/users/:id/disable`, when the account was not already disabled, deletes every `crm_capability_grants` row of the target in the **same batch** that sets `disabled_at`, and first inserts one `crm_capability_audit` row per deleted grant: `action = 'revoke'`, `reason = 'account_disabled'`, `actor_id` = the admin or owner performing the disable, `request_id` = `'disable:' || <fresh per-request UUID> || ':' || capability || ':' || scope`.
2. If the batch aborts, neither grants nor audit change.
3. `POST /api/users/:id/enable` writes nothing to CRM tables; a re-enabled account holds no CRM capability until granted again.
4. `DELETE /api/users/:id` removes grants through the foreign-key cascade; audit rows remain.

## SC-8. Table contract (migration `0045_crm_foundation.sql`)

The migration must create exactly these objects, with these names, columns, types, constraints and triggers. Neon writes the file; any deviation is a contract change.

```sql
CREATE TABLE crm_commands (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('ui','mcp','automation','ingest')),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 8 AND 64),
  request_hash TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE (actor_id, request_id)
);
CREATE INDEX crm_commands_actor_time ON crm_commands(actor_id, created_at);

CREATE TABLE crm_capability_grants (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (length(capability) BETWEEN 1 AND 64),
  scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 64),
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  reason TEXT,
  PRIMARY KEY (user_id, capability, scope)
);

CREATE TABLE crm_capability_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('grant','revoke')),
  capability TEXT NOT NULL,
  scope TEXT NOT NULL,
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json TEXT NOT NULL DEFAULT '{}',
  reason TEXT,
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (actor_id, request_id)
);
CREATE INDEX crm_capability_audit_time ON crm_capability_audit(created_at, id);
CREATE TRIGGER crm_capability_audit_no_update BEFORE UPDATE ON crm_capability_audit
BEGIN SELECT RAISE(ABORT, 'crm_capability_audit is append-only'); END;
CREATE TRIGGER crm_capability_audit_no_delete BEFORE DELETE ON crm_capability_audit
BEGIN SELECT RAISE(ABORT, 'crm_capability_audit is append-only'); END;
```

Rules: server-only tables, never in `shared/collections.ts`. `crm_commands.result` at most 16,384 bytes of JSON *(contract value)*, enforced in code. No other CRM table is created in S0.

## SC-9. `CRM_ENABLED`

- `Env.CRM_ENABLED?: string`. Enabled iff `(env.CRM_ENABLED ?? '').trim().toLowerCase()` is `'1'` or `'true'`, the same parsing as `WEBSITE_INGEST_ENABLED` (`worker/websiteIngest.ts:139-141`). Absent, empty or anything else is off.
- Not added to the committed `wrangler.jsonc`; local fixtures pass it through `startFixture({ vars })`.
- Off: SC-4 rule 1; the Workspace shell renders exactly as at the baseline.
- The client never reads the variable; it reads `GET /api/crm/status`.

## Conformance tests

| Contract | Backend test (Neon) | Frontend test (Opus) |
|---|---|---|
| SC-1 | `tests/crm-commands-d1.test.ts` | `tests/crm-contract.test.ts` (codes, retryability, request-ID pattern) |
| SC-2 | `tests/crm-rules.test.ts`, `tests/crm-grants-d1.test.ts` | `tests/crm-contract.test.ts` (13 capabilities, labels) |
| SC-3 | `tests/crm-projection-keys-d1.test.ts`, `tests/crm-mcp-projection-d1.test.ts` | `tests/crm-isolation.test.ts` (UI never writes `_crm_` keys) |
| SC-4 | `tests/crm-api-d1.test.ts` (every response through the shared zod schemas) | `tests/crm-client-contract.test.ts` (mocks through the same schemas) |
| SC-5 | `tests/crm-grants-d1.test.ts` | UX lab `crm-shell.spec.mjs` (each error has a message) |
| SC-6 | `tests/admin-owner-protection-d1.test.ts` (HTTP routes directly) | UX lab maps `owner_protected` |
| SC-7 | `tests/crm-disable-revocation-d1.test.ts` | — |
| SC-8 | Migration applies on fresh local D1; certification manifest check | — |
| SC-9 | `tests/crm-api-d1.test.ts` (off, `1`, `true`, `TRUE`, other values) | UX lab with and without `--crm` |

## Change log

| Version | Date | Change | Review |
|---|---|---|---|
| `crm-s0-v1` (candidate) | 24 Nov 2026 | First version, from `07-CONTRACTS.md` and `S0-PLAN.md` after decisions A-19 to A-26 | Pending ChatGPT review |
