import { stableJson } from '../../shared/stablejson';
import { isCrmCapability } from '../../shared/crm/capabilities';
import {
  CRM_ERROR_RETRYABLE,
  MAX_COMMAND_RESULT_BYTES,
  type CommandError,
  type CommandRequest,
  type CommandResult,
  type CrmCommandChannel,
  type CrmErrorCode,
} from '../../shared/crm/contracts';
import type { ProjectionGrant } from '../../shared/crm/projection';
import type { Mutation } from '../../shared/types';
import type { Env } from '../auth';
import { D1BudgetExhausted } from '../d1budget';
import { sha256Hex } from '../password';
import { applyChanges, type ApplyOptions } from '../sync';
import { isValidProjectionKey } from './projection';
import {
  canAccessCrmApi,
  isCrmEnabled,
  normalizeCanonicalRole,
  type CrmActor,
  type StoredGrant,
} from './rules';

export function makeCommandError(
  error: CrmErrorCode,
  detail?: Record<string, unknown>,
): CommandError {
  return {
    ok: false,
    error,
    ...(detail !== undefined ? { detail } : {}),
    retryable: CRM_ERROR_RETRYABLE[error],
  };
}

/**
 * Recursively strips `undefined` object properties before calling `stableJson`
 * (avoiding `shared/stablejson.ts:13-18` converting `undefined` to `null`).
 */
export function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : stripUndefined(item)));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = stripUndefined(v);
    }
    return out;
  }
  return value;
}

export async function computeCommandRequestHash(args: {
  name: string;
  via: CrmCommandChannel;
  input: unknown;
  expected?: Record<string, number>;
}): Promise<string> {
  const canonicalExpected: Record<string, number> = {};
  if (args.expected) {
    for (const key of Object.keys(args.expected).sort()) {
      canonicalExpected[key] = args.expected[key];
    }
  }
  const payload = stripUndefined({
    v: 1,
    name: args.name,
    via: args.via,
    input: args.input,
    expected: canonicalExpected,
  });
  return sha256Hex(stableJson(payload));
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function isMalformedJsonError(err: unknown): boolean {
  return err instanceof Error && /malformed JSON/i.test(err.message);
}

function isSqliteConstraintOrAbortError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /(?:SQLITE_CONSTRAINT|SQLITE_ABORT|constraint failed|append-only)/i.test(msg);
}

function binaryCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const SQLITE_NOW_MS = `CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`;

export type FenceInput = D1PreparedStatement | (() => D1PreparedStatement);

export interface CommandCommitPlan<O> {
  kind: 'commit';
  result: O;
  fences: FenceInput[];
  rows?: D1PreparedStatement[];
  records?: Mutation[];
  recordExpect?: Map<string, number>;
  /** Force routing through applyChanges atomic commit mode even when records and recordExpect are empty. */
  forceRecordsCommit?: boolean;
  serverTs?: boolean;
  event?: ApplyOptions['event'];
}

export interface CommandRefusalPlan {
  kind: 'refuse';
  error: CrmErrorCode;
  detail?: Record<string, unknown>;
}

export type CommandPlan<O> = CommandCommitPlan<O> | CommandRefusalPlan;

export interface CommandDefinition<I = Record<string, unknown>, O = unknown> {
  name: string;
  projectionKeys?: readonly string[];
  authorizeCoarse: (actor: CrmActor, via?: CrmCommandChannel) => boolean;
  parseInput: (
    raw: Record<string, unknown>,
  ) =>
    | { ok: true; input: I }
    | { ok: false; error: CrmErrorCode; detail?: Record<string, unknown> };
  authorizeFine?: (actor: CrmActor, input: I, via?: CrmCommandChannel) => boolean;
  authorizeReplay?: (
    actor: CrmActor,
    input: I,
    stored: CommandResult<O> | CommandError,
  ) => boolean;
  plan: (ctx: {
    env: Env;
    actor: CrmActor;
    tokenHash: string;
    via: CrmCommandChannel;
    input: I;
    expected?: ReadonlyMap<string, number>;
    requestId: string;
    now: number;
  }) => Promise<CommandPlan<O>>;
  mapConstraintError?: (err: unknown) => CommandError | null;
  afterCommit?: (ctx: { env: Env; executionCtx: { waitUntil(p: Promise<unknown>): void }; result: O }) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCommandDefinition = CommandDefinition<any, any>;

export interface CommandRegistry {
  has: (name: string) => boolean;
  get: (name: string) => AnyCommandDefinition | undefined;
}

/**
 * Per-request command registry factory (zero module-level mutable state).
 * Validates `projectionKeys` against PROJECTION_KEY_RE (SC-3.1).
 */
export function createCommandRegistry(defs: readonly AnyCommandDefinition[]): CommandRegistry {
  const map = new Map<string, AnyCommandDefinition>();
  for (const def of defs) {
    if (!def.name || map.has(def.name)) {
      throw new Error(`invalid or duplicate CRM command: ${def.name}`);
    }
    if (def.projectionKeys) {
      for (const key of def.projectionKeys) {
        if (!isValidProjectionKey(key)) {
          throw new Error(`invalid CRM projection key "${key}" on command "${def.name}"`);
        }
      }
    }
    map.set(def.name, def);
  }
  return {
    has: (name) => map.has(name),
    get: (name) => map.get(name),
  };
}

interface SessionUserRow {
  id: string;
  disabled_at: number | null;
  canonicalRole: string;
}

interface GrantRow {
  capability: string;
  scope: string;
  granted_by: string;
  granted_at: number;
}

interface StoredCommandRow {
  id: string;
  name: string;
  request_hash: string;
  status: 'ok' | 'error';
  result: string;
}

function buildActor(sessionRow: SessionUserRow, grantRows: GrantRow[]): CrmActor {
  const grants: StoredGrant[] = [];
  for (const row of grantRows) {
    if (!isCrmCapability(row.capability)) continue;
    grants.push({
      capability: row.capability,
      scope: row.scope,
      grantedBy: row.granted_by,
      grantedAt: row.granted_at,
    });
  }
  return {
    id: sessionRow.id,
    role: normalizeCanonicalRole(sessionRow.canonicalRole),
    disabled: sessionRow.disabled_at !== null,
    grants,
  };
}

export type RunCommandOutcome =
  | { status: 200; body: CommandResult<unknown> | CommandError }
  | { status: 401; body: { error: 'unauthenticated' } }
  | { status: 404; body: { error: 'not_found' } }
  | { status: 503; body: { error: 'write_interrupted'; retryable: true } };

export async function runCommand(args: {
  env: Env;
  executionCtx: { waitUntil(p: Promise<unknown>): void };
  actorId: string;
  tokenHash: string;
  via: CrmCommandChannel;
  name: string;
  envelope: CommandRequest<Record<string, unknown>>;
  registry: CommandRegistry;
}): Promise<RunCommandOutcome> {
  const { env, executionCtx, actorId, tokenHash, via, name, envelope, registry } = args;

  // Defensive SC-9 guard for non-HTTP callers as well as HTTP.
  if (!isCrmEnabled(env)) {
    return { status: 404, body: { error: 'not_found' } };
  }

  const def = registry.get(name);
  if (!def) {
    return { status: 404, body: { error: 'not_found' } };
  }

  const now = Date.now();
  // Step 6 (SC-1.3 / SC-4.1): single pre-commit snapshot batch.
  const [sessionRes, grantsRes, cmdRes] = await env.DB.batch([
    env.DB
      .prepare(
        `SELECT u.id, u.disabled_at, COALESCE(u.workspace_role, u.role) AS canonicalRole
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > MAX(?, ${SQLITE_NOW_MS})`,
      )
      .bind(tokenHash, actorId, now),
    env.DB
      .prepare(
        `SELECT capability, scope, granted_by, granted_at
         FROM crm_capability_grants
         WHERE user_id = ?`,
      )
      .bind(actorId),
    env.DB
      .prepare(
        `SELECT id, name, request_hash, status, result
         FROM crm_commands
         WHERE actor_id = ? AND request_id = ?`,
      )
      .bind(actorId, envelope.requestId),
  ]);

  const sessionRow = sessionRes.results[0] as SessionUserRow | undefined;
  if (!sessionRow || sessionRow.disabled_at !== null) {
    return { status: 401, body: { error: 'unauthenticated' } };
  }

  const actor = buildActor(sessionRow, grantsRes.results as unknown as GrantRow[]);

  // Coarse authority check BEFORE input parsing or idempotency disclosure (CR-03).
  if (!canAccessCrmApi(actor) || !def.authorizeCoarse(actor, via)) {
    return { status: 200, body: makeCommandError('forbidden') };
  }

  // Wire input parsing (CR-04).
  const parsed = def.parseInput(envelope.input);
  if (!parsed.ok) {
    return { status: 200, body: makeCommandError(parsed.error, parsed.detail) };
  }

  // Fine authority check BEFORE idempotency inspection & target lookup.
  if (def.authorizeFine && !def.authorizeFine(actor, parsed.input, via)) {
    return { status: 200, body: makeCommandError('forbidden') };
  }

  const requestHash = await computeCommandRequestHash({
    name: def.name,
    via,
    input: parsed.input,
    expected: envelope.expected,
  });

  // Check pre-commit idempotency row.
  const existingCmd = cmdRes.results[0] as StoredCommandRow | undefined;
  if (existingCmd) {
    return resolveStoredCommand(existingCmd, def, actor, parsed.input, requestHash, envelope.requestId);
  }

  const expectedMap = envelope.expected
    ? new Map<string, number>(Object.entries(envelope.expected))
    : undefined;

  const plan = await def.plan({
    env,
    actor,
    tokenHash,
    via,
    input: parsed.input,
    expected: expectedMap,
    requestId: envelope.requestId,
    now,
  });

  if (plan.kind === 'refuse') {
    return { status: 200, body: makeCommandError(plan.error, plan.detail) };
  }

  const commandId = crypto.randomUUID();
  const baseEnvelope: CommandResult<unknown> = {
    ok: true,
    commandId,
    result: plan.result,
    projections: [],
  };

  // Pre-commit 16,384 UTF-8 byte cap (SC-1.2, SC-8): never truncate.
  const plannedRecordIds = [...new Set((plan.records ?? []).map((r) => r.id))].sort(binaryCompare);
  const conservativeEnvelope: CommandResult<unknown> = {
    ...baseEnvelope,
    projections: plannedRecordIds.map((recordId) => ({
      recordId,
      rev: Number.MAX_SAFE_INTEGER,
    })),
  };
  if (utf8ByteLength(JSON.stringify(conservativeEnvelope)) > MAX_COMMAND_RESULT_BYTES) {
    return { status: 200, body: makeCommandError('budget_exceeded') };
  }

  const baseEnvelopeJson = JSON.stringify(baseEnvelope);
  const insertCommandStmt = (recordIds: string[]): D1PreparedStatement => {
    if (recordIds.length === 0) {
      return env.DB
        .prepare(
          `INSERT INTO crm_commands (id, name, actor_id, via, request_id, request_hash, status, result, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'ok', ?, ?)`,
        )
        .bind(commandId, def.name, actor.id, via, envelope.requestId, requestHash, baseEnvelopeJson, now);
    }
    return env.DB
      .prepare(
        `INSERT INTO crm_commands (id, name, actor_id, via, request_id, request_hash, status, result, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'ok',
           json_set(?, '$.projections', COALESCE(
             (SELECT json_group_array(json_object('recordId', id, 'rev', seq))
              FROM (SELECT id, seq FROM records WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id)),
             json('[]')
           )),
           ?)`,
      )
      .bind(
        commandId,
        def.name,
        actor.id,
        via,
        envelope.requestId,
        requestHash,
        baseEnvelopeJson,
        JSON.stringify(recordIds),
        now,
      );
  };

  const usesRecordsCommit = Boolean(
    plan.forceRecordsCommit ||
      (plan.records && plan.records.length > 0) ||
      (plan.recordExpect && plan.recordExpect.size > 0),
  );

  let commitError: unknown = null;
  let fenceAborted = false;
  let committedProjections: { recordId: string; rev: number }[] = [];

  try {
    if (!usesRecordsCommit) {
      const commitFences = plan.fences.map((f) => (typeof f === 'function' ? f() : f));
      await env.DB.batch([
        ...commitFences,
        ...(plan.rows ?? []),
        insertCommandStmt([]),
      ]);
    } else {
      const projection: ProjectionGrant | undefined =
        def.projectionKeys && def.projectionKeys.length > 0
          ? { command: def.name, keys: new Set(def.projectionKeys) }
          : undefined;
      let commitCallbackInvoked = false;
      const applyResult = await applyChanges(env, actor.id, plan.records ?? [], {
        atomic: true,
        serverTs: plan.serverTs ?? true,
        expect: plan.recordExpect,
        session: { tokenHash },
        projection,
        event: plan.event,
        fences: plan.fences.map((f) => (typeof f === 'function' ? f : () => f)),
        commit: ({ recordIds }) => {
          commitCallbackInvoked = true;
          return [...(plan.rows ?? []), insertCommandStmt(recordIds)];
        },
      });

      if (applyResult.authorizationError) {
        if (applyResult.authorizationError === 'access_reset_required') {
          fenceAborted = true;
        } else {
          return { status: 200, body: makeCommandError('budget_exceeded') };
        }
      } else if (applyResult.conflicts && applyResult.conflicts.length > 0) {
        return { status: 200, body: makeCommandError('stale') };
      } else if (applyResult.rejected > 0) {
        const forbiddenReasons = new Set(['not_found_or_forbidden', 'read_only']);
        const staleReasons = new Set(['access_changed_retry', 'source_changed_refresh_preview']);
        const budgetReasons = new Set(['authorization_budget', 'record_too_large']);
        const items = applyResult.rejectedItems ?? [];
        if (items.some((item) => forbiddenReasons.has(item.reason))) {
          return { status: 200, body: makeCommandError('forbidden') };
        }
        if (items.some((item) => staleReasons.has(item.reason))) {
          fenceAborted = true;
        } else if (items.some((item) => budgetReasons.has(item.reason))) {
          return { status: 200, body: makeCommandError('budget_exceeded') };
        } else {
          return {
            status: 200,
            body: makeCommandError('invalid_input', {
              rejectedItems: items,
            }),
          };
        }
      } else if (applyResult.fenceAborted || applyResult.conflict) {
        fenceAborted = true;
      } else if (applyResult.partialError) {
        commitError = new Error(applyResult.partialError);
      } else if (!commitCallbackInvoked || applyResult.committed !== true) {
        commitError = new Error('atomic_commit_not_executed');
      } else {
        committedProjections = [...applyResult.applied]
          .sort((a, b) => binaryCompare(a.id, b.id))
          .map((a) => ({ recordId: a.id, rev: a.rev }));
      }
    }
  } catch (err) {
    if (err instanceof D1BudgetExhausted) throw err;
    commitError = err;
  }

  if (commitError !== null || fenceAborted) {
    return recoverAfterCommitFailure({
      env,
      def,
      actorId: actor.id,
      tokenHash,
      input: parsed.input,
      requestId: envelope.requestId,
      requestHash,
      fenceAborted,
      commitError,
    });
  }

  def.afterCommit?.({ env, executionCtx, result: plan.result });
  return {
    status: 200,
    body: {
      ok: true,
      commandId,
      result: plan.result,
      projections: committedProjections,
    },
  };
}

function resolveStoredCommand(
  row: StoredCommandRow,
  def: AnyCommandDefinition,
  actor: CrmActor,
  input: unknown,
  requestHash: string,
  requestId: string,
): RunCommandOutcome {
  if (row.name !== def.name || row.request_hash !== requestHash) {
    return {
      status: 200,
      body: makeCommandError('idempotency_conflict', { requestId }),
    };
  }
  const stored = JSON.parse(row.result) as CommandResult<unknown> | CommandError;
  if (def.authorizeReplay && !def.authorizeReplay(actor, input, stored)) {
    return { status: 200, body: makeCommandError('forbidden') };
  }
  return { status: 200, body: stored };
}

/**
 * Commit-error recovery (SC-1.3 step 4):
 * Single read batch [crm_commands, session+user, actor_grants] with strict precedence:
 * 1. dead session / disabled actor -> 401
 * 2. lost actor authority -> 200 forbidden
 * 3. crm_commands row exists -> idempotency_conflict or authorized replay
 * 4. no crm_commands row -> stale (fence abort) | constraint map / rethrow 500 | 503 write_interrupted
 */
async function recoverAfterCommitFailure(args: {
  env: Env;
  def: AnyCommandDefinition;
  actorId: string;
  tokenHash: string;
  input: unknown;
  requestId: string;
  requestHash: string;
  fenceAborted: boolean;
  commitError: unknown;
}): Promise<RunCommandOutcome> {
  const {
    env,
    def,
    actorId,
    tokenHash,
    input,
    requestId,
    requestHash,
    fenceAborted,
    commitError,
  } = args;

  let cmdRes: D1Result<Record<string, unknown>>;
  let sessionRes: D1Result<Record<string, unknown>>;
  let grantsRes: D1Result<Record<string, unknown>>;
  try {
    const recoveryNow = Date.now();
    [cmdRes, sessionRes, grantsRes] = await env.DB.batch([
      env.DB
        .prepare(
          `SELECT id, name, request_hash, status, result
           FROM crm_commands
           WHERE actor_id = ? AND request_id = ?`,
        )
        .bind(actorId, requestId),
      env.DB
        .prepare(
          `SELECT u.id, u.disabled_at, COALESCE(u.workspace_role, u.role) AS canonicalRole
           FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > MAX(?, ${SQLITE_NOW_MS})`,
        )
        .bind(tokenHash, actorId, recoveryNow),
      env.DB
        .prepare(
          `SELECT capability, scope, granted_by, granted_at
           FROM crm_capability_grants
           WHERE user_id = ?`,
        )
        .bind(actorId),
    ]);
  } catch {
    return { status: 503, body: { error: 'write_interrupted', retryable: true } };
  }

  // First: dead session or disabled account -> 401 (takes precedence even if crm_commands exists).
  const sessionRow = sessionRes.results[0] as unknown as SessionUserRow | undefined;
  if (!sessionRow || sessionRow.disabled_at !== null) {
    return { status: 401, body: { error: 'unauthenticated' } };
  }

  // Second: lost current authority -> 200 forbidden (takes precedence over replay).
  const recoveredActor = buildActor(sessionRow, grantsRes.results as unknown as GrantRow[]);
  if (
    !canAccessCrmApi(recoveredActor) ||
    !def.authorizeCoarse(recoveredActor) ||
    (def.authorizeFine && !def.authorizeFine(recoveredActor, input))
  ) {
    return { status: 200, body: makeCommandError('forbidden') };
  }

  // Third: existing crm_commands row -> replay or idempotency_conflict.
  const existingCmd = cmdRes.results[0] as unknown as StoredCommandRow | undefined;
  if (existingCmd) {
    return resolveStoredCommand(existingCmd, def, recoveredActor, input, requestHash, requestId);
  }

  // Fourth: confirmed rolled back (no crm_commands row).
  if (fenceAborted || isMalformedJsonError(commitError)) {
    return { status: 200, body: makeCommandError('stale') };
  }

  if (commitError !== null && isSqliteConstraintOrAbortError(commitError)) {
    const mapped = def.mapConstraintError?.(commitError);
    if (mapped) return { status: 200, body: mapped };
    throw commitError;
  }

  return { status: 503, body: { error: 'write_interrupted', retryable: true } };
}
