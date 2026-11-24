# CRM shared contracts: `crm-s0-v2`

| Item | Value |
|---|---|
| Version | `crm-s0-v2` (supersedes [`crm-s0-v1`](crm-s0-v1.md)) |
| Status | **Candidate.** Resolves independent review findings CR-01 through CR-06 and updated governance A-26. Pending ChatGPT review and freeze. Not an authorisation to implement S0. |
| Date | 24 November 2026 |
| Workspace baseline | `38c388ac1787b0ff14e8e26d7abd1bf8c6bd0444`, branch `crm/foundation` |
| Owner | Neon (principal engineering agent in T3 Code, A-26) |
| Reviewer | ChatGPT (independent review) |
| Approver | Paul (workspace owner) |
| Decisions applied | A-19 to A-26 ([`01-DECISIONS.md`](../01-DECISIONS.md)) |
| Related | [`07-CONTRACTS.md`](../07-CONTRACTS.md), [`S0-PLAN.md`](../S0-PLAN.md), [`BACKEND-S0-BRIEF.md`](../BACKEND-S0-BRIEF.md), [`PROGRESS.md`](../PROGRESS.md) |

## How to read this document

- **Normative.** Everything in this file is binding for S0 once frozen. Where `07-CONTRACTS.md` covers later slices, this file is the S0 subset and wins for S0 if the two ever differ.
- **Single contract source (`CR-06`).** Once frozen, Neon creates `shared/crm/capabilities.ts`, `shared/crm/projection.ts` and `shared/crm/contracts.ts` in Stage 1 from this document, validates them with `tests/crm-contract.test.ts` and `npm run typecheck`, and consumes that single source from both `worker/` and `src/`. The TypeScript types and Zod schemas below define the exact public shape of those three files. Behaviour-only contracts (SC-7, SC-9) and the SQL contract (SC-8) are implemented directly in the Stage 2 backend.
- **Changing a contract.** Change request (what, why, repository evidence, impact) -> ChatGPT review -> Neon updates this document and bumps the version (`crm-s0-v3`). Paul's approval is required whenever an owner decision, security invariant, authority model or applied migration is affected.
- **Bounded values** marked *(contract value)* are design choices specified here; changing one requires a contract version bump.

---

## SC-1. Command envelope, canonical hashing, idempotency, error codes & persistence (`CR-01`)

```ts
// shared/crm/contracts.ts
import { z } from 'zod';
import {
  CRM_CAPABILITIES,
  type CrmCapability,
  type CrmScope,
} from './capabilities';

export const CRM_CONTRACT_VERSION = 'crm-s0-v2' as const;

/** 8-64 characters from [A-Za-z0-9_-]. Client-generated, one per user action;
 * reused verbatim when the same action is retried after a network or 503 failure. */
export type RequestId = string;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const MAX_COMMAND_BODY_BYTES = 65_536; // contract value (UTF-8 bytes)
export const MAX_COMMAND_RESULT_BYTES = 16_384; // contract value (UTF-8 bytes)
export const MAX_EXPECTED_ENTRIES = 100; // matches MAX_EXPECTED in worker/sync.ts:42

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

### SC-1.1 Canonical request hashing (`CR-01`)

1. The server computes the canonical request hash **after** envelope & wire parsing over the normalised semantic payload:
   ```ts
   requestHash = sha256Hex(stableJson(stripUndefined({
     v: 1,
     name,
     via,
     input: canonicalInput,
     expected: canonicalExpected,
   })));
   ```
   using `stableJson` (`shared/stablejson.ts:4-19`) and `sha256Hex` (`worker/password.ts`) — **never** `argsHash()`.
   - **Important `stableJson` precaution (`shared/stablejson.ts:13-18`)**: `sortValue(undefined)` returns `null`, so `if (val !== undefined)` at `:14` is always true (`stableJson({ a: 1, reason: undefined })` emits `{"a":1,"reason":null}`, whereas `stableJson({ a: 1 })` emits `{"a":1}`). `worker/crm/commands.ts` MUST recursively strip `undefined` object properties (while leaving array `undefined` semantics standard) before calling `stableJson`, without modifying `shared/stablejson.ts` in S0.
2. `name` is the canonical command identifier (e.g. `'capability.grant'`).
3. `via` is server-derived (`'ui'`, `'mcp'`, `'automation'`, `'ingest'`), never trusted from the client body. Cross-channel `requestId` reuse with the same actor collides as `idempotency_conflict` rather than replaying silently across channels.
4. `canonicalInput` is the parsed, normalised semantic input returned by the command's parser:
   - `reason` is trimmed; empty or whitespace-only `reason` is omitted so `{ reason: '' }` and `{}` hash identically when semantically identical.
   - All semantically significant fields (`userId`, `capability`, `scope`, etc.) are included.
5. `canonicalExpected` is a sorted key-value map of `expected`, or `{}` when `expected` is omitted or empty (`{}` and `undefined` hash identically). Including `expected` prevents retrying with a newly refreshed revision under an old `requestId` from silently returning an outdated result or bypassing revision intent.

### SC-1.2 Journal persistence policy (`crm_commands`, `CR-01`)

1. **Persisted atomically in the command commit batch**:
   - **Every committed `CommandResult` (`ok: true`, `status = 'ok'`)**, **including successful no-op commands** (such as `capability.grant` / `capability.revoke` returning `{ already: true }`, which commits fences + `crm_commands` with zero `crm_capability_audit` rows).
   - **Effect-producing `CommandError`s (`ok: false`, `status = 'error'`) in future slices only**: specifically `approval_required` when an approval record is created atomically in the same batch. **In S0, no `CommandError` is persisted** (`status` is always `'ok'`).
2. **Never persisted (zero database writes, no `crm_commands` row)**:
   - All HTTP transport/envelope failures (`401`, `404`, `413`, `400`, `503`).
   - All plan-time refusals: `forbidden`, `invalid_input`, `not_found`, `budget_exceeded`.
   - All stateless business refusals: `capacity_exceeded`, `hold_expired`, `window_closed`, `consent_withdrawn`, `currency_mismatch`.
   - All commit-time aborts: `stale`, `source_changed`, `provider_unavailable`, `idempotency_conflict`.
   Callers fix the input or re-read state and retry with a **new** `requestId`.
3. **Result byte cap (`SC-8`)**: Before committing, the server verifies `new TextEncoder().encode(serializedEnvelope).byteLength <= MAX_COMMAND_RESULT_BYTES` (16,384 bytes). Exceeding this cap returns `200 CommandError('budget_exceeded', { retryable: false })` before any write — never silently truncates a contract-validated response.

### SC-1.3 Replay authorisation, concurrent identical/conflicting requests & lost-ack recovery (`CR-01`, `CR-03`)

1. **Pre-commit snapshot**: Inside a single read `db.batch`, `runCommand` loads:
   - current session validity (`sessions` joined with `users`), active account status, canonical `workspaceRole`, and actor CRM grants (`crm_capability_grants`), and
   - any existing `crm_commands` row for `(actor_id, request_id)`.
2. **Current authority before input parsing & replay disclosure (`CR-03`)**:
   - If session is invalid/expired or actor is disabled -> `401 { error: 'unauthenticated' }`.
   - Evaluate coarse current command access (`crm.access` for non-owners, plus command-level coarse authority such as `crm.capabilities.manage` + `admin` when applicable) **before** command input parsing or inspecting/returning any stored `crm_commands` outcome, preventing unauthorised callers from probing schemas or `idempotency_conflict`. If currently unauthorised -> `200 CommandError('forbidden')`.
   - Parse command input (`SC-4`, `SC-5`) and run fine capability checks (e.g., non-owner touching `crm.capabilities.manage`) before checking `crm_commands` and target state (preventing target enumeration).
   - Once authorised and parsed, check stored `crm_commands` row:
     - If `row.name !== name || row.request_hash !== requestHash` -> `200 CommandError('idempotency_conflict', { detail: { requestId }, retryable: false })`.
     - If hash matches -> run command-specific `authorizeReplay` (in S0, actor still holds current command capability and passes current authority checks above; in future slices with record-scoped reads, re-verify read-gate / restricted-read rights over `row.result` before returning) -> return the stored `CommandResult` (or persisted `CommandError`) verbatim without repeating any write.
3. **Fresh execution & atomic commit**:
   - Guard defensively against non-HTTP invocation when `CRM_ENABLED` is off (returning `not_found`).
   - If no `crm_commands` row exists in the pre-commit snapshot, `load()` reads command state and `plan()` produces either a refusal (`error`) or commit plan (`result`, `fences`, `rows`, `records`, `recordExpect`).
   - All fences (`actorFence`, `capabilityFence` when applicable, command `fences`), operational `rows`, record mutations + projection `changes() = 1` guards, and `INSERT INTO crm_commands(...)` execute in ONE atomic batch (`SC-3`, `SC-8`).
4. **Commit-error recovery (concurrent identical/conflicting races & lost acknowledgements)**:
   - On ANY failure thrown or returned during commit:
     1. If the error is `D1BudgetExhausted`, rethrow immediately so the app handler returns `503 { error: 'processing_budget', retryable: true }` (`worker/index.ts:53`).
     2. Run a single recovery read batch querying `crm_commands` for `(actor_id, request_id)` together with current actor session, `disabled_at`, `workspaceRole`, and actor grants (`[crm_commands, session+user+role, actor_grants]`).
     3. If the recovery lookup itself throws (D1 unavailable or budget exhausted), return HTTP `503 { error: 'write_interrupted', retryable: true }` so the caller retries with the **same `requestId`**.
     4. **Precedence of current-authority & idempotency recovery**:
        - **First**, if current session is gone/expired or `disabled_at IS NOT NULL` -> return HTTP **`401 { error: 'unauthenticated' }`** (takes precedence even if a `crm_commands` row exists).
        - **Second**, if actor lost `crm.access`, `admin` role, or required capability for this command -> return **`200 CommandError('forbidden', { retryable: false })`** (takes precedence over replay).
        - **Third**, if a `crm_commands` row **exists** in recovery:
          - If `row.name !== name || row.request_hash !== requestHash` -> return `200 CommandError('idempotency_conflict', { detail: { requestId }, retryable: false })`.
          - Else run `authorizeReplay` -> return the stored envelope verbatim. This cleanly recovers lost commit acks, concurrent `UNIQUE(actor_id, request_id)` collisions, and concurrent winner-tripped-fence races (`malformed JSON` when winner wrote target state + journal before loser's fence ran)!
        - **Fourth**, if NO `crm_commands` row exists in recovery (confirmed rolled back, zero writes committed):
          - If commit aborted via a fence (`fenceAborted` / `malformed JSON` / record expectation conflict) -> return **`200 CommandError('stale', { retryable: true })`**.
          - If commit failed with an **unrelated SQLite constraint** (e.g., `CHECK`, `FOREIGN KEY`, append-only trigger abort, or `UNIQUE` on a table other than `crm_commands`): never misclassify as idempotency replay or `stale`; map via optional command constraint handler or rethrow (`500 { error: 'internal error' }`).
          - If commit failed with a transient/ambiguous D1 error and recovery confirmed no journal row exists -> return HTTP **`503 { error: 'write_interrupted', retryable: true }`** (caller retries with the same `requestId`).
5. **No generic Undo**: CRM commands never attach `opts.journal` (`changesets`). Operational reversals in later slices are explicit commands.
6. **S0 error set**: `forbidden`, `not_found`, `stale`, `idempotency_conflict`, `invalid_input`, `budget_exceeded` (plus HTTP `401`, `404`, `413`, `400`, `503`).

---

## SC-2. Capability catalogue, `crm.access` gate, evaluation rules & client invalidation (`CR-03`)

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

export const ALL_SCOPE = '*' as const;
/** Scope '*' = all programmes. crm-s0-v2 accepts only '*' (programme scopes arrive in S2). */
export type CrmScope = '*' | string;

/** Capabilities that will accept a programme scope once the programme registry exists (S2). */
export const PROGRAMME_SCOPED: ReadonlySet<CrmCapability> = new Set(['crm.restricted.read', 'crm.configure']);

export function isCrmCapability(value: string): value is CrmCapability {
  return (CRM_CAPABILITIES as readonly string[]).includes(value);
}

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

### SC-2.1 Authorisation & evaluation rules (`worker/crm/rules.ts` & `worker/crm/grants.ts`)

`shared/crm/capabilities.ts` holds only the pure catalogue, type guard and UI labels. All server-side authorisation rules live in `worker/crm/rules.ts` and `worker/crm/grants.ts`; the client displays what `GET /api/crm/status` returns.

1. **Active credential**: The actor must have `users.disabled_at IS NULL` and an unexpired `sessions` row (`expires_at > now`). Any MCP/connector request in future slices also requires a live connector grant (`worker/connectorAccess.ts`).
2. **Owner implicit all (A-21)**: If the actor's **current** `COALESCE(workspace_role, role)` is `'owner'`, all 13 capabilities are held at every scope. Computed live from `users`; zero `crm_capability_grants` rows; cannot be granted or revoked.
3. **Guests & role non-implication (A-21)**: Guests hold zero CRM capabilities and cannot be granted any. `admin` or `member` implies zero CRM capabilities on its own.
4. **Relationship between `crm.access` and specialised capabilities (`CR-03`)**:
   - `crm.access` (scope `'*'`) is the mandatory CRM gate for the `/crm/*` UI, every `/api/crm/read/*` route, and every `/api/crm/commands/*` route. Only `GET /api/crm/status` is callable without `crm.access`.
   - For any **non-owner**, **no specialised capability** (including `crm.capabilities.manage`) **is effective unless the actor ALSO currently holds `crm.access` at scope `'*'`**.
   - Specialised grants remain stored as independent explicit rows in `crm_capability_grants`: granting a specialised capability does **not** silently create a `crm.access` row, and revoking `crm.access` does **not** silently delete specialised grant rows (preserving A-21's explicit audit trail). If `crm.access` is revoked and later re-granted, specialised grants take effect again once `crm.access` is restored, and `GET /api/crm/read/capabilities` exposes `effectiveAccess` per account so admins can see and revoke lingering rows.
5. **Manage capability rule (`crm.capabilities.manage`)**: Requires current role `'admin'` **and** explicit grant of `crm.access` (`'*'`) **and** explicit grant of `crm.capabilities.manage` (`'*'`). If an admin is demoted to `'member'`, `crm.capabilities.manage` immediately ceases to take effect without needing a revoke row; if re-promoted while still holding `crm.access` and `crm.capabilities.manage`, it takes effect again unless explicitly revoked.
6. **Grant storage match**: Otherwise a capability `(cap, scope)` is effectively held iff the actor holds `crm.access` (`'*'`) **and** a `crm_capability_grants` row exists for `(user_id, cap, scope)` or `(user_id, cap, '*')`.
7. **S0 scope constraint**: `crm-s0-v2` accepts only scope `'*'`. Any other non-empty scope string returns `invalid_input` with `detail.reason = 'unknown_scope'`. Programme scopes for `PROGRAMME_SCOPED` capabilities arrive in S2.
8. **Independent of Workspace permissions (A-19)**: Never depends on `access_state.enabled`.

### SC-2.2 Protected read snapshot consistency (`CR-03`)

`worker/auth.ts:199-214` (`userByToken`) loads only `u.role` (`'admin' | 'member'`), never `u.workspace_role` (`'owner' | 'guest'`), and `requireAuth`'s post-handler check (`:227-232`) rechecks only `sessions` and `disabled_at IS NULL` — not role or CRM capability grants. Therefore:
- CRM handlers MUST NEVER inspect `c.get('user').role` for authority or ownership.
- `GET /api/crm/status`, `GET /api/crm/read/capabilities` and `GET /api/crm/read/capability-audit` must read the actor's current `users` state (`COALESCE(u.workspace_role, u.role)`), current `sessions` row (`token_hash` & `expires_at > now`), current actor grants and the returned payload inside **one `db.batch`** snapshot.
- If the actor's session is missing/expired or `disabled_at IS NOT NULL`, return `401 { error: 'unauthenticated' }`.
- For protected reads (`/read/capabilities`, `/read/capability-audit`), if `CRM_ENABLED` is off return `404 { error: 'not_found' }`; if actor lacks current read authority (must be owner, or active `admin` holding both `crm.access` and `crm.capabilities.manage`), return `403 { error: 'forbidden' }` with zero leaked rows.
- `/read/capability-audit` MUST `LEFT JOIN users` for both `actor_id` and `target_user_id` so historical audit rows for removed accounts keep `actorName: null` / `targetName: null` instead of being dropped.

### SC-2.3 Frontend capability state refresh & invalidation (`src/core/crmStatus.ts`, `CR-03`)

`crmStatusStore` is **in-memory only** (never persisted in `localStorage` or IndexedDB; `/api/*` already sets `Cache-Control: no-store` at `worker/index.ts:49`). Every in-flight fetch binds `(uid, token, accessClientStore.epoch, generation)` using the `createCurrentRead` / `workspaceSettings.ts` pattern (`src/core/aiReviewRead.ts:1-15`, `src/core/workspaceSettings.ts:9-63`), discarding any stale response if identity, token, epoch or generation changes before resolution.

| Event | Server trigger / signal | Client behaviour (`src/core/crmStatus.ts` & CRM views) |
|---|---|---|
| **Local grant / revoke** | `POST /api/crm/commands/capability.*` returns `ok: true` with `already: false`; server calls `pokeLive()` (`worker/sync.ts:695-702`) | Command caller awaits `refreshCrmStatus()` and reloads `/read/capabilities` + `/read/capability-audit`; writes a lightweight hint `{ userId, nonce }` to `localStorage` key `ws_crm_status_update` (other same-origin tabs re-fetch `/api/crm/status` on `storage` event). |
| **Remote grant / revoke** | `pokeLive()` broadcasts `{ t: 'changed' }` -> `src/core/live.ts:75` dispatches `ws-records-changed` | `crmStatusStore` subscribes to `ws-records-changed`, `focus`, `pageshow`, `visibilitychange` (when visible) and calls `refreshCrmStatus()`. If any `/api/crm/*` call returns HTTP `403`, `404` (when `CRM_ENABLED` changed) or `200 CommandError('forbidden')`, client immediately sets `crmStatus` unready / triggers `refreshCrmStatus()` and unmounts protected CRM views into Access denied. |
| **Admin demotion** | `PATCH /api/users/:id` already calls `pokeLive()` (`worker/admin.ts:178`) | Same as remote grant/revoke: `ws-records-changed` refreshes `/api/crm/status`; any in-flight or subsequent protected read/command returning `403` / `forbidden` unmounts `Capabilities`/`History` tabs immediately. |
| **Account disablement / session revocation** | `POST /api/users/:id/disable` deletes `sessions` and calls `pokeLive()` (`worker/admin.ts:114,122`); `LiveRoom.alarm` closes sockets with `4401` (`worker/live.ts:79`); HTTP returns `401` | On any `401` from `/api/crm/*`, call `dropSession()` (`src/core/auth.ts:29-34`), synchronously clear `crmStatusStore` to initial empty state (`enabled: false, access: false, status: 'unauthed'`), and clear `AccessSettings` in-memory state so `RequireAuth` renders `AuthScreen`. |
| **Account switching** | `finishLogin` / `runAccountSwitch` changes `ws_uid`, `ws_token`, reloads, or increments `accessClientStore.epoch` | `crmStatusStore` subscribes to `authStore` & `accessClientStore.epoch`: whenever `uid`, `token`, or `epoch` changes or `status !== 'authed'`, synchronously reset `crmStatusStore` to `{ status: 'idle', statusData: null }` before triggering a fresh `/status` fetch for the new session. |
| **Offline & reconnection** | `window` `offline` / `online`, live WebSocket `onopen` (`src/core/live.ts:59-66`), `pageshow` | Offline: capability switches and command buttons are disabled with `'Capability changes need a connection'`; existing cached `access` state stays presentation-only (server remains authoritative). Reconnect (`online` or `document.visibilityState === 'visible'`): immediately call `refreshCrmStatus()` and re-validate open CRM routes. |

---

## SC-3. Projection keys & atomic Records Commit Mode (`CR-02`)

```ts
// shared/crm/projection.ts
export const CRM_PROJECTION_PREFIX = '_crm_' as const;

export const isCrmProjectionKey = (key: string): boolean => key.startsWith(CRM_PROJECTION_PREFIX);

/** Constructed ONLY by worker/crm/commands.ts from a registered command's static key list. */
export interface ProjectionGrant {
  command: string;
  keys: ReadonlySet<string>;
}
```

### SC-3.1 Unconditional `_crm_` write protection

1. In `applyChanges` (`worker/sync.ts`), immediately after cloning patches (`:350`) and **before** `if (snapshot.enabled === 1 || env.CONNECTOR)` (`:353`), run an unconditional item-wise pre-check:
   - Any change whose patch contains a key starting with `_crm_` is rejected item-wise with `reason = 'protected_field'` unless `opts.projection` is present, `ch.collection === 'tasks'`, and `opts.projection.keys.has(key)`. Ensure non-atomic rejection counts (`rejected`) equal `rejectedItems.length` cleanly even if multiple mutations share an `id`.
   - If `projectionDenied.length > 0` and `(opts.atomic === true || (!!opts.expect?.size && opts.atomic !== false))`, return `{ rejected, rejectedItems, changed: 0, applied: [] }` immediately without mutating anything or invoking `opts.commit`.
2. In `authorizeMutations` (`worker/mutationAccess.ts:48,65-68`), add trailing `projection?: ProjectionGrant`. Granted `_crm_` keys are exempt from the general `field.startsWith('_')` rule when `ch.collection === 'tasks'` and permissions are enabled, while all space read/edit checks and parent/dependency checks remain enforced against the command's actor.
3. `defineCommand` validates `projectionKeys` against `/^_crm_[a-z0-9_]{1,59}$/` so malformed or non-`_crm_` keys can never be registered.
3. Applies identically with Workspace permissions off (`access_state.enabled = 0`) and on (`= 1`), across all write paths: client `/api/sync/push`, MCP generic tools, automations, forms, website ingest, history restore, and changeset undo.
4. `worker/historyPersistence.ts:3` (`historyField`) naturally excludes `_crm_` keys from `record_history` restore.
5. No S0 production command writes projections; S0 proves SC-3 with dedicated projection and records-commit tests.

### SC-3.2 Atomic Records Commit Mode (`applyChanges` / `flushAtomicCommit`, `CR-02`)

`applyChanges` gains two options used **only** by `worker/crm/commands.ts`:

```ts
projection?: ProjectionGrant;
/** Server-only CRM rows + command journal committed atomically in the same single batch.
 *  Requires atomic: true; incompatible with journal, execution, env.MCP_PLAN, and multi-chunking. */
commit?: (committedProjectionsSqlExpr?: { recordIds: string[] }) => D1PreparedStatement[];
```

When `opts.commit` is provided:
1. **Option validation (fail closed)**:
   - `opts.atomic !== true` -> throw `Error('commit requires atomic: true')`.
   - `opts.journal || opts.execution || env.MCP_PLAN` -> throw `Error('commit cannot be combined with changesets, execution, or MCP_PLAN')`.
   - `(opts.expect?.size ?? 0) > MAX_EXPECTED` -> throws as today (`worker/sync.ts:308`).
   - All expected record IDs plus all changed record IDs (`changedPlans`) must fit in one D1 batch (max `MAX_EXPECTED` = 100 changed/expected records); exceeding fails closed before calling `opts.commit`.
2. **Pre-commit refusals never invoke `opts.commit`**:
   - If ANY item is rejected (`validChange`, `_crm_` projection check, `authorizeMutations`, `ifUnchanged`, `guardStageWrites`, `collection_mismatch`, `record_too_large`), `applyChanges` returns `{ rejected, rejectedItems, changed: 0, applied: [] }` without executing any batch.
   - If `checkExpectations(existing, opts.expect)` finds any mismatch, `applyChanges` returns `{ rejected, rejectedItems, changed: 0, conflicts, applied: [] }` without executing any batch.
3. **Single-batch `flushAtomicCommit` (never uses `flushPlans` retry/chunk loop)**:
   - **Never skips empty `todo`**: Even when `changedPlans.length === 0` (e.g., an idempotent projection value produced `plan.changed === false`, or a command passed read-only `opts.expect` without writing records), `flushAtomicCommit` STILL executes the single batch containing authority fences + `opts.fences` + `strictExpectationGuard` + `opts.commit()` rows/journal.
   - **`strictExpectationGuard` (preserves `tests/sync-atomic.test.ts:44`)**: Existing `expectationGuard` (`worker/sync.ts:515-523`) stays untouched for legacy callers because `tests/sync-atomic.test.ts:44` intercepts `/JOIN json_each\(\?\)/`. `flushAtomicCommit` uses a dedicated `strictExpectationGuard`:
     ```sql
     SELECT CASE WHEN (
       SELECT COUNT(*) FROM json_each(?) e LEFT JOIN records r ON r.id = e.key
       WHERE COALESCE(r.seq, -1) <> e.value
     ) = 0 THEN 1 ELSE json_extract('{', '$') END
     ```
     The map passed to `strictExpectationGuard` is the union of:
     - every `(id, expectedRev)` in `opts.expect` (catching missing rows where `COALESCE(r.seq, -1)` is `-1` vs expected rev, and read-only expected records where `changedPlans` is empty), and
     - every `(p.id, p.baseSeq)` in `changedPlans` (for non-expected records created/updated in the same batch).
     If `opts.expect` specifies rev for an ID also in `changedPlans`, `expectedRev` wins (already verified by `checkExpectations` and pinned at `worker/sync.ts:445`).
   - **Strict per-record `changes() = 1` assertion (`CR-02`)**: Immediately after each `stmtFor(p)` in `changedPlans`, append:
     ```sql
     SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('{', '$') END
     ```
     If any record `INSERT ... ON CONFLICT DO UPDATE ... WHERE records.seq = ?` touches 0 rows (e.g., a race or unexpected state slip), this statement throws `malformed JSON` and aborts the **entire** D1 batch — guaranteeing a failed projection write **cannot** allow consequential server-only rows or `crm_commands` to commit.
   - **Atomic `projections` revision capture in `crm_commands.result`**: Because `records.seq` is allocated inside SQL via `NEXT_SEQ` (`worker/sync.ts:40`), the committed `rev` of each written record is captured in the **same single batch** by having `commit` update the journal JSON inside SQL (using `json_set(?, '$.projections', COALESCE((SELECT json_group_array(json_object('recordId', id, 'rev', seq)) FROM records WHERE id IN (SELECT value FROM json_each(?))), json('[]')))`) right after all `stmtFor(p)` statements and before `INSERT INTO crm_commands`, so `crm_commands.result` and `CommandResult.projections` always match the exact committed D1 `seq` values.
   - Statement order inside the single `db.batch(statements)`:
     - `writeAuthorityFences(db, authority)` when permissions are enabled (`authority` present), OR `SELECT CASE WHEN (SELECT enabled FROM access_state WHERE id = 1) = 0 THEN 1 ELSE json_extract('{', '$') END` when `!authority` (prevents concurrent Track A activation from bypassing `authorizeMutations`),
     - `opts.fences`, `strictExpectationGuard`,
     - for each `p` in `changedPlans`: `approvalGate` guard -> `stmtFor(p)` -> `SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('{', '$') END` -> `historyStatement` -> `stageAppliedEvent`,
     - `...opts.commit(...)` (including SQL `json_set` capturing committed `records.seq` into `crm_commands.result`).
   - **No partial chunks, no retry loop, structured errors**:
     - `flushAtomicCommit` executes `db.batch(statements)` **once** (never retries on CAS miss, never splits into multiple chunks, never returns `partialError`).
     - If `db.batch` throws `malformed JSON`, return `{ rejected: 0, changed: 0, applied: [], conflict: true, fenceAborted: true }` without burning extra `readRows` or hydrating un-gated `ConflictInfo` records; let `runCommand`'s single post-abort diagnostic batch decide `401` / `forbidden` / replay / `idempotency_conflict` / `stale`.
     - If `db.batch` throws `D1BudgetExhausted` or any other SQL/transport error (including `UNIQUE` or `CHECK` constraint failures), **rethrow the error** to `runCommand` rather than swallowing it into a string `partialError`, so `runCommand` can execute its journal-based recovery (`SC-1.3`).

---

## SC-4. CRM HTTP API, exact validation order & shared Zod schemas (`CR-04`)

All routes mount at `/api/crm` before `app.route('/api', admin)` in `worker/index.ts:123`, require Workspace bearer session auth (`requireAuth`, `worker/auth.ts:217-222`), carry `Cache-Control: no-store` (`worker/index.ts:49`), and terminate unknown sub-routes with `crmApi.all('*', c => c.json({ error: 'not_found' }, 404))` so unmatched paths never fall through to `worker/index.ts:125` (`'not found'`).

| Route | Caller | Success | HTTP Errors (outside `CommandResult`/`CommandError`) |
|---|---|---|---|
| `GET /api/crm/status` | Any signed-in account | `200 CrmStatus` | `401 { error: 'unauthenticated' }`, `503 { error: 'processing_budget', retryable: true }` |
| `POST /api/crm/commands/:name` | Any signed-in account (`crm.access` + command rights checked inside) | `200 CommandResult` or `200 CommandError` | `401 { error: 'unauthenticated' }`; `404 { error: 'not_found' }` (disabled or unknown `:name`); `413 { error: 'request_too_large' }` (>65,536 UTF-8 bytes); `400 { error: 'invalid_body' }` (invalid JSON or envelope schema); `503 { error: 'processing_budget' \| 'write_interrupted', retryable: true }`; `500 { error: 'internal error' }` |
| `GET /api/crm/read/capabilities` | Owner, or active admin holding `crm.access` + `crm.capabilities.manage` | `200 CapabilityOverview` | `401 { error: 'unauthenticated' }`; `404 { error: 'not_found' }` (disabled); `403 { error: 'forbidden' }`; `503 { error: 'processing_budget', retryable: true }` |
| `GET /api/crm/read/capability-audit?cursor=` | Same as above | `200 CapabilityAuditPage` | `401`; `404` (disabled); `403`; `400 { error: 'invalid_cursor' }`; `503` |

### SC-4.1 Exact validation precedence order (`CR-04`)

**`POST /api/crm/commands/:name`:**
1. **`401 { error: 'unauthenticated' }`**: `requireAuth` validates bearer token, active session (`expires_at > now`), and `users.disabled_at IS NULL`.
2. **`404 { error: 'not_found' }`**: `CRM_ENABLED` is not `'1'`/`'true'` (`SC-9`).
3. **`404 { error: 'not_found' }`**: `:name` is not a registered command in the per-request command registry.
4. **`413 { error: 'request_too_large' }`**: Read raw body with `boundedRequestBody(c.req.raw, MAX_COMMAND_BODY_BYTES)` (`worker/forms.ts:395-403`), rejecting both oversized `Content-Length` headers AND unannounced/chunked streams exceeding 65,536 bytes.
5. **`400 { error: 'invalid_body' }`**: Decode UTF-8 strictly (`new TextDecoder('utf-8', { fatal: true })`), `JSON.parse`, and validate against `CommandRequestEnvelopeSchema` (`requestId` matching `REQUEST_ID_PATTERN`, `input` present plain object, optional `expected` map <= 100 entries of non-negative safe integers).
6. **Pre-commit read batch** (loads actor status/role/grants + `crm_commands` by `(actor_id, requestId)`):
   - If actor session disappeared/expired or `disabled_at` became non-null since middleware -> `401 { error: 'unauthenticated' }`.
   - **Coarse authority check (before input parsing / idempotency disclosure)**: Non-owner lacking `crm.access` -> `200 CommandError('forbidden', { retryable: false })`; commands requiring admin manage rights (`capability.grant` / `capability.revoke`) refuse non-owner/non-manage callers as `200 CommandError('forbidden')` before wire schema probing.
   - **Command input validation (`CR-04` resolution)**: Parse `input` with the command's **wire schema** (e.g., `CapabilityChangeRequestInputSchema` where `capability` and `scope` are strings, not narrow enums):
     - Structural failure (missing/wrong-type `userId`, non-string `capability`/`scope`, `reason` > 500 chars, extra keys) -> `200 CommandError('invalid_input', { detail: { fields } })`.
     - Unsupported capability string (`!isCrmCapability(capability)`) -> `200 CommandError('invalid_input', { detail: { reason: 'unknown_capability', fields: { capability: 'unknown_capability' } } })`.
     - Unsupported scope string (`scope !== '*'`) -> `200 CommandError('invalid_input', { detail: { reason: 'unknown_scope', fields: { scope: 'unknown_scope' } } })`.
   - **Command-level fine capability check**: Non-owner attempting to grant or revoke `crm.capabilities.manage` -> `200 CommandError('forbidden')` (runs strictly before idempotency & target lookup).
   - **Idempotency lookup**: Check `crm_commands` row (`idempotency_conflict` on hash/name mismatch, else `authorizeReplay` -> return stored result).
7. **Load & Plan**: Load command targets, evaluate business rules (`SC-5`), return plan-time refusals (`200 CommandError`, no journal row written), or compute canonical result size (if `> 16_384` bytes -> `200 CommandError('budget_exceeded')`).
8. **Commit & Recovery**: Execute single atomic batch -> on success return `200 CommandResult`; on error run journal recovery (`SC-1.3`).

**`GET /api/crm/read/capability-audit?cursor=`:**
1. **`401`** (`requireAuth`).
2. **`404`** (`CRM_ENABLED` off).
3. **Authority snapshot batch + check** (actor active, live session, owner OR active admin with `crm.access` + `crm.capabilities.manage`) -> **`401`** or **`403 { error: 'forbidden' }` BEFORE cursor parsing** (so an unauthorised caller cannot probe cursor semantics).
4. **Cursor validation**: If `cursor` query param is present (including empty string `""` or exceeding 256 chars), base64url-decode UTF-8 JSON `[createdAt, id]` where `Number.isSafeInteger(createdAt) && createdAt >= 0` and `typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id)`; any failure returns **`400 { error: 'invalid_cursor' }`**.
5. **Keyset query & response**: Query `WHERE (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT 51` inside `withD1Budget(env, 45)`; return up to 50 items + `next` opaque base64url cursor (`null` when no more rows), re-checked by `requireAuth`'s post-handler GET fence.

### SC-4.2 Shared TypeScript interfaces & Zod schemas (`shared/crm/contracts.ts`)

```ts
// shared/crm/contracts.ts (exact public schemas)
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
  ).refine(obj => Object.keys(obj).length <= MAX_EXPECTED_ENTRIES, {
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
  enabled: boolean;              // SC-9
  access: boolean;               // holds crm.access (always false when !enabled)
  owner: boolean;                // current role is owner
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
  eligible: boolean;             // false for guests and disabled accounts
  implicitAll: boolean;          // true only for the owner
  effectiveAccess: boolean;      // true for owner, or active non-guest holding crm.access
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
  actorName: string | null;      // null when the account was removed
  targetUserId: string;
  targetName: string | null;
  action: 'grant' | 'revoke';
  capability: CrmCapability;
  scope: CrmScope;
  reason: string | null;         // includes 'account_disabled' (SC-7)
}
export interface CapabilityAuditPage {
  items: CapabilityAuditItem[];  // newest first, at most 50 (contract value)
  next: string | null;           // opaque base64url keyset cursor over (created_at, id)
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
```

Rules:
1. When `CRM_ENABLED` is off (`SC-9`), every route except `GET /api/crm/status` returns `404 { error: 'not_found' }`, and `/status` returns `{ contract: 'crm-s0-v2', enabled: false, access: false, owner, capabilities: [] }`.
2. When `CRM_ENABLED` is on and the caller is `owner`, `/status` lists all 13 capabilities with scope `'*'`. When a non-owner lacks `crm.access`, `/status` returns `access: false` and `capabilities: []` even if stale specialised grant rows remain in `crm_capability_grants`.
3. Every response (and client test mock) validates against the shared Zod schema in `shared/crm/contracts.ts`.
4. All endpoints run inside `withD1Budget(env, 45)`.

---

## SC-5. `capability.grant` and `capability.revoke` (`CR-01`, `CR-03`, `CR-04`)

```ts
// shared/crm/contracts.ts (continued)
export const MAX_CAPABILITY_REASON_CHARS = 500; // contract value

/** Wire schema accepted by the command parser so unknown_capability and unknown_scope
 *  produce business CommandError('invalid_input') rather than HTTP 400. */
export const CapabilityChangeRequestInputSchema = z.object({
  userId: z.string().min(1).max(64),
  capability: z.string().min(1).max(64),
  scope: z.string().min(1).max(64),
  reason: z.string().max(MAX_CAPABILITY_REASON_CHARS * 2).optional(),
}).strict();

export interface CapabilityChangeInput {
  userId: string;
  capability: CrmCapability;
  scope: '*';
  reason?: string;               // trimmed, at most 500 characters (omitted when blank)
}
export const CapabilityChangeInputSchema = z.object({
  userId: z.string().min(1).max(64),
  capability: CrmCapabilitySchema,
  scope: S0ScopeSchema,
  reason: z.string().min(1).max(MAX_CAPABILITY_REASON_CHARS).optional(),
}).strict();

export interface CapabilityChangeOutput {
  already: boolean;              // true: no grant/audit state change (still writes crm_commands journal)
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
  'guest_not_eligible', 'self_grant', 'owner_implicit',
  'unknown_capability', 'unknown_scope', 'account_disabled', 'not_admin',
] as const;
export type CapabilityInvalidReason = typeof CAPABILITY_INVALID_REASONS[number];
```

### SC-5.1 Deterministic precedence & evaluation rules

Evaluated in this exact order (post-envelope validation):

| Order | Condition | Outcome (no writes unless row reaches commit) |
|---|---|---|
| 1 | Actor session dead or `disabled_at IS NOT NULL` | `401 { error: 'unauthenticated' }` |
| 2 | Actor is neither `owner` nor (`admin` holding `crm.access` + `crm.capabilities.manage`) | `200 CommandError('forbidden')` |
| 3 | Wire `input` fails `CapabilityChangeRequestInputSchema`, or trimmed `reason.length > 500` | `200 CommandError('invalid_input', { detail: { fields } })` |
| 4 | `!isCrmCapability(input.capability)` | `200 CommandError('invalid_input', { detail: { reason: 'unknown_capability', fields: { capability: 'unknown_capability' } } })` |
| 5 | `input.scope !== '*'` | `200 CommandError('invalid_input', { detail: { reason: 'unknown_scope', fields: { scope: 'unknown_scope' } } })` |
| 6 | Non-owner actor attempting to grant or revoke `crm.capabilities.manage` | `200 CommandError('forbidden')` |
| 7 | Existing `crm_commands` row for `(actor_id, requestId)`: hash/name mismatch -> `idempotency_conflict`; matching hash -> replay stored result (`SC-1.3`) | `200` |
| 8 | Target user row does not exist | `200 CommandError('not_found')` |
| 9 | Target's current role is `'owner'` | `200 CommandError('invalid_input', { detail: { reason: 'owner_implicit' } })` |
| 10 | Target is actor (`userId === actor.id`) | `200 CommandError('invalid_input', { detail: { reason: 'self_grant' } })` |
| 11 | Target's current role is `'guest'` | `200 CommandError('invalid_input', { detail: { reason: 'guest_not_eligible' } })` |
| 12 | Command is `capability.grant` AND target has `disabled_at IS NOT NULL` | `200 CommandError('invalid_input', { detail: { reason: 'account_disabled' } })` |
| 13 | Command is `capability.grant` AND `capability === 'crm.capabilities.manage'` AND target role is not `'admin'` (`capability.revoke` does NOT fail with `not_admin`, so the owner can revoke dormant grants on demoted members) | `200 CommandError('invalid_input', { detail: { reason: 'not_admin' } })` |
| 14 | Grant already held (`capability.grant`) or grant not held (`capability.revoke`) | Commit fences + `crm_commands` journal row ONLY (zero grant writes, zero audit rows) -> `200 CommandResult({ already: true, grant: { ..., held: action === 'grant' } })` |
| 15 | Otherwise (state changes) | Commit fences + grant `INSERT`/`DELETE` + `crm_capability_audit` row (`request_id = requestId`) + `crm_commands` journal row in one batch -> call `pokeLive()` -> `200 CommandResult({ already: false, ... })` |

### SC-5.2 Mandatory commit fences (`CR-01`, `CR-03`)

Every commit batch for `capability.grant` and `capability.revoke` (including `already: true` no-op commits) MUST include all three fences before any write statement:
1. **`actorFence`**: Actor session live (`token_hash`, `expires_at > now`), `users.disabled_at IS NULL`, current `COALESCE(workspace_role, role)` matches snapshot, and if non-owner, actor still holds `crm.access` (`'*'`) and `crm.capabilities.manage` (`'*'`).
2. **`targetAccountFence`**: Target user still exists with identical `COALESCE(workspace_role, role)` and `disabled_at IS ?` as loaded.
3. **`targetGrantStateFence`**: If `existingGrant` was absent, `NOT EXISTS (SELECT 1 FROM crm_capability_grants WHERE user_id = ? AND capability = ? AND scope = ?)`; if `existingGrant` was present, `EXISTS (SELECT 1 FROM crm_capability_grants WHERE user_id = ? AND capability = ? AND scope = ? AND granted_by = ? AND granted_at = ?)`. This guarantees concurrent `grant`/`revoke` calls can never double-insert, double-audit or silently skip an audit row.

Neither `capability.grant` nor `capability.revoke` is ever registered as an MCP tool.

---

## SC-6. Owner protection on account routes (A-23, `CR-05`)

**ALWAYS ACTIVE regardless of `CRM_ENABLED` (`CR-05`).**

| Route (existing, `worker/admin.ts`) | Target is `owner` and actor is not | Everything else |
|---|---|---|
| `PATCH /api/users/:id` | `403 { error: 'owner_protected' }`, nothing written | Unchanged current behaviour |
| `POST /api/users/:id/disable` | `403 { error: 'owner_protected' }`, nothing written | Unchanged, plus SC-7 |
| `DELETE /api/users/:id` | `403 { error: 'owner_protected' }`, nothing written | Unchanged |

```ts
// shared/crm/contracts.ts (continued)
export const OWNER_PROTECTED_ERROR = 'owner_protected' as const;
```

Rules: Enforced server-side by a pre-check on `before` (explicitly placed **before** `worker/admin.ts:172` in `PATCH` so even `{ role: 'admin' }` on an owner returns `403`, and **before** `already` at `:111` in `disable`) AND a `protectOwner` SQL fence in `accountFence` (`worker/admin.ts:103-105`) adding `AND COALESCE(workspace_role, role) != 'owner'` (so a target promoted concurrently aborts with `409 { error: 'account_or_authority_changed' }`). Existing self-change refusals (`worker/admin.ts:109,169,208`) and last-privileged-account fence (`protectLast`, `:103-105`) remain intact. No HTTP route can demote, disable or delete the owner.

---

## SC-7. Capability revocation on disable (A-25, `CR-05`)

**ALWAYS ACTIVE regardless of `CRM_ENABLED` (`CR-05`).**

1. `POST /api/users/:id/disable`, when the account was not already disabled, writes one `crm_capability_audit` row per held grant (ordered deterministically by `capability, scope`: `action = 'revoke'`, `reason = 'account_disabled'`, `actor_id` = actor performing disable, `request_id = 'disable|' || <fresh per-request UUID> || '|' || capability || '|' || scope` — using `|` since capability IDs contain `:`) and deletes all `crm_capability_grants` rows for the target inside the **same `db.batch`** that sets `disabled_at` (`worker/admin.ts:111-120`).
2. If the batch aborts, neither grants nor audit rows change.
3. `POST /api/users/:id/enable` writes nothing to CRM tables; a re-enabled account holds zero CRM capabilities until explicitly granted again.
4. `DELETE /api/users/:id` explicitly executes `DELETE FROM crm_capability_grants WHERE user_id = ?` in the same batch before `DELETE FROM users` (matching `:211`'s explicit `DELETE FROM sessions`, protecting against environments with foreign keys disabled, in addition to `ON DELETE CASCADE`); `crm_capability_audit` rows remain.

---

## SC-8. Table contract (`migrations/0045_crm_foundation.sql`)

Server-only D1 tables, never added to `shared/collections.ts`.

```sql
CREATE TABLE crm_commands (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('ui','mcp','automation','ingest')),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 8 AND 64),
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error')),
  result TEXT NOT NULL DEFAULT '{}' CHECK (length(CAST(result AS BLOB)) <= 16384),
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

Notes:
- `crm_commands.result` byte cap (16,384 UTF-8 bytes) is checked in code before commit (returning `budget_exceeded` rather than truncating) and backed by `CHECK (length(CAST(result AS BLOB)) <= 16384)`.
- No foreign key on `crm_capability_audit`: audit rows must survive `DELETE /api/users/:id`.
- No other CRM tables are created in S0.

---

## SC-9. `CRM_ENABLED` feature flag (`CR-05`)

- `Env.CRM_ENABLED?: string`. Enabled iff `(env.CRM_ENABLED ?? '').trim().toLowerCase()` is `'1'` or `'true'` (matching `WEBSITE_INGEST_ENABLED` at `worker/websiteIngest.ts:139-141`). Absent, empty or any other value is off.
- `runCommand` also checks `CRM_ENABLED` defensively so future non-HTTP callers fail closed (`not_found`) when CRM is off.
- Not added to committed `wrangler.jsonc` (stays off by default); local test fixtures and UX lab pass it via `startFixture({ vars })`.
- Client never reads the environment variable directly; it reads `GET /api/crm/status`.
- **Presence path privacy (`worker/live.ts:52-57`, `worker/index.ts:73`)**: While Workspace permissions are off (`access_state.enabled = 0`), `LiveRoom` sockets are unscoped and broadcast `here` paths to all signed-in accounts (including guests and non-CRM accounts). `CrmShell` MUST NOT call `sendHere('/crm/...')` while permissions are off (keep presence at `'/'` or omit `/crm/*` paths) so CRM URLs never leak over presence broadcasts.

| Surface | When `CRM_ENABLED` is OFF | When `CRM_ENABLED` is ON |
|---|---|---|
| Workspace shell & app switcher | Switcher absent; Workspace markup and UX screenshots pixel-identical to baseline | Switcher visible only when `/api/crm/status` says `enabled && access` |
| `/crm/*` SPA routes | Renders CRM Access denied / CRM disabled state (`08` section 15) | Renders CRM shell if `access`, else Access denied |
| `GET /api/crm/status` | `200 { contract: 'crm-s0-v2', enabled: false, access: false, owner, capabilities: [] }` | `200` with live effective capabilities |
| All other `/api/crm/*` routes (`/commands/*`, `/read/*`) | `401` if unauthenticated, else **`404 { error: 'not_found' }`** | Normal contract handling |
| Owner protection on `worker/admin.ts` (SC-6, A-23) | **ALWAYS ACTIVE** (`403 owner_protected`) | **ALWAYS ACTIVE** |
| Disable-time CRM grant revocation (SC-7, A-25) | **ALWAYS ACTIVE** (revokes any stored CRM grants + writes audit rows) | **ALWAYS ACTIVE** |
| Unconditional `_crm_` projection rejection (SC-3, ADR-04) | **ALWAYS ACTIVE** (both permission modes) | **ALWAYS ACTIVE** |

---

## Conformance tests (owned by Neon, backend-first stages)

| Contract | Stage 1 & Stage 2 (Contracts + Backend) | Stage 3 (Frontend + UX Lab) |
|---|---|---|
| SC-1 | `tests/crm-contract.test.ts` (envelope, error codes, retryability, request IDs); `tests/crm-commands-d1.test.ts` (canonical hash incl. `expected`/`via`/trimmed `reason`, no-op journalling, zero error persistence, 16 KB `budget_exceeded`, concurrent identical/conflicting races, fence-tripped winner replay, lost-ack recovery, unrelated SQL constraint error isolation, unauthorized replay refusal) | `tests/crm-client-contract.test.ts` (`runCrmCommand` schema parsing, fresh `requestId` per action, reuse on network/503 retry) |
| SC-2 | `tests/crm-contract.test.ts` (13 capabilities, labels); `tests/crm-rules.test.ts` (`crm.access` prerequisite, owner implicit, manage+admin, demotion, guests); `tests/crm-grants-d1.test.ts` | `tests/crm-client-contract.test.ts` (`crmStatusStore` invalidation on switch, `401`, `403`, `404`, `ws-records-changed`) |
| SC-3 | `tests/crm-projection-keys-d1.test.ts`, `tests/crm-mcp-projection-d1.test.ts`, `tests/crm-commands-d1.test.ts` (`flushAtomicCommit` empty-`todo` `strictExpectationGuard`, missing expected row `stale`, `changes()=1` abort rolling back server rows, atomic `projections` rev in journal, no retry loop) | `tests/crm-isolation.test.ts` (UI never writes `_crm_` keys; CSS/bundle isolation) |
| SC-4 | `tests/crm-api-d1.test.ts` (every response against shared Zod schemas; exact order 401->404->413->400->200; streamed >65 KB body without `Content-Length`; invalid JSON/UTF-8; `unknown_capability`/`unknown_scope`; invalid cursor after auth check; 503 budget/interrupted) | `tests/crm-client-contract.test.ts` & `tests/crm-routes.test.ts` |
| SC-5 | `tests/crm-grants-d1.test.ts` (16-step precedence, 3-fence concurrent races, `pokeLive`, disabled-target revoke vs grant, `account_disabled`, `not_admin`, append-only audit triggers) | `scripts/ux-lab/crm-shell.spec.mjs` |
| SC-6 | `tests/admin-owner-protection-d1.test.ts` (HTTP routes directly, tested with `CRM_ENABLED` BOTH off and on) | `scripts/ux-lab/crm-shell.spec.mjs` (`owner_protected` message) |
| SC-7 | `tests/crm-disable-revocation-d1.test.ts` (tested with `CRM_ENABLED` BOTH off and on, batch failure rollback, repeated disable UUID uniqueness, enable restores none) | — |
| SC-8 | Migration `0045` applies on fresh local D1; `CHECK` constraints (`status`, UTF-8 byte cap); `migrations.json` & `selftest.mjs` pass | — |
| SC-9 | `tests/crm-api-d1.test.ts` (`CRM_ENABLED` unset, `''`, `'0'`, `'false'`, `'1'`, `'true'`, `'TRUE'`) + CR-05 always-on controls verified while off | `npm run qa:ux` (off, 0 diff pixels) & `npm run qa:ux -- --crm` (on) |

---

## Change log

| Version | Date | Change | Review |
|---|---|---|---|
| `crm-s0-v1` (superseded) | 24 Nov 2026 | First candidate from `07-CONTRACTS.md` and `S0-PLAN.md` after A-19 to A-26 | Reviewed by ChatGPT (CR-01 to CR-06 raised) |
| `crm-s0-v2` (candidate) | 24 Nov 2026 | Resolved CR-01 (canonical hash w/ `expected` & `via`, no-op journal, error persistence policy, journal recovery, replay auth), CR-02 (single-batch `flushAtomicCommit`, `strictExpectationGuard`, `changes()=1`, atomic SQL `projections`, no retry loop), CR-03 (`crm.access` gate over specialised capabilities, single-snapshot reads, 3 grant fences, `pokeLive`, `crmStatusStore` invalidation), CR-04 (validation precedence, streamed 413, wire vs strict schemas, exact cursors), CR-05 (`CRM_ENABLED` off vs always-on A-23/A-25/SC-3), CR-06 (single Neon contract/code owner, backend-first Stage 1-4 sequence) | Pending ChatGPT review & freeze |
