import { isCrmCapability, type CrmCapability } from '../../shared/crm/capabilities';
import {
  AUDIT_PAGE_LIMIT,
  CRM_CONTRACT_VERSION,
  CRM_CURSOR_ID_PATTERN,
  type CapabilityAuditItem,
  type CapabilityAuditPage,
  type CapabilityChangeInput,
  type CapabilityChangeOutput,
  type CapabilityOverview,
  type CapabilityOverviewAccount,
  type CrmStatus,
} from '../../shared/crm/contracts';
import type { Env } from '../auth';
import { pokeLive } from '../sync';
import type { CommandDefinition } from './commands';
import {
  canManageCapabilities,
  canTouchCapability,
  effectiveCapabilitiesForUser,
  hasEffectiveAccess,
  isCrmEnabled,
  normalizeCanonicalRole,
  parseCapabilityChangeInput,
  planCapabilityChange,
  type CapabilityTarget,
  type CrmActor,
  type StoredGrant,
} from './rules';

interface SessionUserRow {
  id: string;
  disabled_at: number | null;
  canonicalRole: string;
}

interface GrantRow {
  user_id?: string;
  capability: string;
  scope: string;
  granted_by: string;
  granted_at: number;
}

interface OverviewUserRow {
  id: string;
  name: string;
  username: string;
  canonicalRole: string;
  disabled_at: number | null;
}

interface AuditRow {
  id: string;
  created_at: number;
  actor_id: string;
  actor_name: string | null;
  target_user_id: string;
  target_name: string | null;
  action: 'grant' | 'revoke';
  capability: string;
  scope: string;
  reason: string | null;
}

function toStoredGrants(rows: GrantRow[]): StoredGrant[] {
  const out: StoredGrant[] = [];
  for (const r of rows) {
    if (!isCrmCapability(r.capability)) continue;
    out.push({
      capability: r.capability,
      scope: r.scope,
      grantedBy: r.granted_by,
      grantedAt: r.granted_at,
    });
  }
  return out;
}

function toActor(sessionRow: SessionUserRow, grantRows: GrantRow[]): CrmActor {
  return {
    id: sessionRow.id,
    role: normalizeCanonicalRole(sessionRow.canonicalRole),
    disabled: sessionRow.disabled_at !== null,
    grants: toStoredGrants(grantRows),
  };
}

function sessionQuery(db: D1Database, tokenHash: string, actorId: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT u.id, u.disabled_at, COALESCE(u.workspace_role, u.role) AS canonicalRole
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > ?`,
    )
    .bind(tokenHash, actorId, now);
}

function actorGrantsQuery(db: D1Database, actorId: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT capability, scope, granted_by, granted_at
       FROM crm_capability_grants
       WHERE user_id = ?
       ORDER BY capability, scope`,
    )
    .bind(actorId);
}

/** SC-5.2 Fence 1: actor session live, active, same canonical role, and (for non-owner) holds crm.access + crm.capabilities.manage. */
export function actorFence(
  db: D1Database,
  actor: CrmActor,
  tokenHash: string,
  now: number,
): D1PreparedStatement {
  if (actor.role === 'owner') {
    return db
      .prepare(
        `SELECT CASE WHEN EXISTS (
           SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > ?
             AND u.disabled_at IS NULL AND COALESCE(u.workspace_role, u.role) = 'owner'
         ) THEN 1 ELSE json_extract('{', '$') END`,
      )
      .bind(tokenHash, actor.id, now);
  }
  return db
    .prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > ?
           AND u.disabled_at IS NULL AND COALESCE(u.workspace_role, u.role) = ?
       )
       AND EXISTS (
         SELECT 1 FROM crm_capability_grants
         WHERE user_id = ? AND capability = 'crm.access' AND scope = '*'
       )
       AND EXISTS (
         SELECT 1 FROM crm_capability_grants
         WHERE user_id = ? AND capability = 'crm.capabilities.manage' AND scope = '*'
       )
       THEN 1 ELSE json_extract('{', '$') END`,
    )
    .bind(tokenHash, actor.id, now, actor.role, actor.id, actor.id);
}

/** SC-5.2 Fence 2: target user exists with unchanged canonical role and disabled_at. */
export function targetAccountFence(db: D1Database, target: CapabilityTarget): D1PreparedStatement {
  return db
    .prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM users
         WHERE id = ? AND COALESCE(workspace_role, role) = ? AND disabled_at IS ?
       ) THEN 1 ELSE json_extract('{', '$') END`,
    )
    .bind(target.id, target.role, target.disabledAt);
}

/** SC-5.2 Fence 3: target grant row presence (and provenance if present) unchanged. */
export function targetGrantStateFence(
  db: D1Database,
  targetUserId: string,
  capability: CrmCapability,
  scope: string,
  existingGrant: StoredGrant | null,
): D1PreparedStatement {
  if (!existingGrant) {
    return db
      .prepare(
        `SELECT CASE WHEN NOT EXISTS (
           SELECT 1 FROM crm_capability_grants
           WHERE user_id = ? AND capability = ? AND scope = ?
         ) THEN 1 ELSE json_extract('{', '$') END`,
      )
      .bind(targetUserId, capability, scope);
  }
  return db
    .prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM crm_capability_grants
         WHERE user_id = ? AND capability = ? AND scope = ? AND granted_by = ? AND granted_at = ?
       ) THEN 1 ELSE json_extract('{', '$') END`,
    )
    .bind(targetUserId, capability, scope, existingGrant.grantedBy, existingGrant.grantedAt);
}

function makeCapabilityCommand(
  action: 'grant' | 'revoke',
): CommandDefinition<CapabilityChangeInput, CapabilityChangeOutput> {
  return {
    name: action === 'grant' ? 'capability.grant' : 'capability.revoke',
    authorizeCoarse: (actor) => canManageCapabilities(actor),
    parseInput: (raw) => parseCapabilityChangeInput(raw),
    authorizeFine: (actor, input) => canTouchCapability(actor, input.capability),
    authorizeReplay: (actor, input) => canTouchCapability(actor, input.capability),
    plan: async ({ env, actor, tokenHash, input, requestId, now }) => {
      const [targetRes, grantRes] = await env.DB.batch([
        env.DB
          .prepare(
            `SELECT id, COALESCE(workspace_role, role) AS canonicalRole, disabled_at
             FROM users WHERE id = ?`,
          )
          .bind(input.userId),
        env.DB
          .prepare(
            `SELECT capability, scope, granted_by, granted_at
             FROM crm_capability_grants
             WHERE user_id = ? AND capability = ? AND scope = ?`,
          )
          .bind(input.userId, input.capability, input.scope),
      ]);

      const rawTarget = targetRes.results[0] as
        | { id: string; canonicalRole: string; disabled_at: number | null }
        | undefined;
      const target: CapabilityTarget | null = rawTarget
        ? {
            id: rawTarget.id,
            role: normalizeCanonicalRole(rawTarget.canonicalRole),
            disabled: rawTarget.disabled_at !== null,
            disabledAt: rawTarget.disabled_at,
          }
        : null;

      const rawGrant = grantRes.results[0] as GrantRow | undefined;
      const existingGrant: StoredGrant | null =
        rawGrant && isCrmCapability(rawGrant.capability)
          ? {
              capability: rawGrant.capability,
              scope: rawGrant.scope,
              grantedBy: rawGrant.granted_by,
              grantedAt: rawGrant.granted_at,
            }
          : null;

      const decision = planCapabilityChange(action, actor, input, target, existingGrant);
      if (!decision.ok) {
        return { kind: 'refuse', error: decision.error, detail: decision.detail };
      }

      const fences = [
        actorFence(env.DB, actor, tokenHash, now),
        targetAccountFence(env.DB, target!),
        targetGrantStateFence(env.DB, target!.id, input.capability, input.scope, existingGrant),
      ];

      const output: CapabilityChangeOutput = {
        already: decision.already,
        grant: {
          userId: target!.id,
          capability: input.capability,
          scope: input.scope,
          held: decision.held,
        },
      };

      // Step 14: no-op commits all 3 fences + crm_commands journal ONLY (zero grant/audit writes).
      if (decision.already) {
        return { kind: 'commit', result: output, fences, rows: [] };
      }

      // Step 15: state change writes grant + append-only audit row in the same batch.
      const beforeJson = existingGrant
        ? JSON.stringify({
            held: true,
            grantedBy: existingGrant.grantedBy,
            grantedAt: existingGrant.grantedAt,
          })
        : JSON.stringify({ held: false });
      const afterJson =
        action === 'grant'
          ? JSON.stringify({ held: true, grantedBy: actor.id, grantedAt: now })
          : JSON.stringify({ held: false });

      const rows: D1PreparedStatement[] = [
        action === 'grant'
          ? env.DB
              .prepare(
                `INSERT INTO crm_capability_grants (user_id, capability, scope, granted_by, granted_at, reason)
                 VALUES (?, ?, ?, ?, ?, ?)`,
              )
              .bind(
                target!.id,
                input.capability,
                input.scope,
                actor.id,
                now,
                input.reason ?? null,
              )
          : env.DB
              .prepare(
                `DELETE FROM crm_capability_grants
                 WHERE user_id = ? AND capability = ? AND scope = ?`,
              )
              .bind(target!.id, input.capability, input.scope),
        env.DB
          .prepare(
            `INSERT INTO crm_capability_audit
               (id, actor_id, target_user_id, action, capability, scope, before_json, after_json, reason, request_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            actor.id,
            target!.id,
            action,
            input.capability,
            input.scope,
            beforeJson,
            afterJson,
            input.reason ?? null,
            requestId,
            now,
          ),
      ];

      return { kind: 'commit', result: output, fences, rows };
    },
    afterCommit: ({ env, executionCtx, result }) => {
      if (!result.already) {
        pokeLive(env, executionCtx);
      }
    },
  };
}

export function createCapabilityCommandDefs(): [
  CommandDefinition<CapabilityChangeInput, CapabilityChangeOutput>,
  CommandDefinition<CapabilityChangeInput, CapabilityChangeOutput>,
] {
  return [makeCapabilityCommand('grant'), makeCapabilityCommand('revoke')];
}

/**
 * GET /api/crm/status (SC-2.2, SC-4, SC-9).
 * Single db.batch snapshot reading current session, canonical role, and actor grants.
 */
export async function readCrmStatus(
  env: Env,
  actorId: string,
  tokenHash: string,
): Promise<{ status: 200; body: CrmStatus } | { status: 401; body: { error: 'unauthenticated' } }> {
  const now = Date.now();
  const enabled = isCrmEnabled(env);
  const [sessionRes, grantsRes] = await env.DB.batch([
    sessionQuery(env.DB, tokenHash, actorId, now),
    actorGrantsQuery(env.DB, actorId),
  ]);
  const sessionRow = sessionRes.results[0] as SessionUserRow | undefined;
  if (!sessionRow || sessionRow.disabled_at !== null) {
    return { status: 401, body: { error: 'unauthenticated' } };
  }
  const actor = toActor(sessionRow, grantsRes.results as unknown as GrantRow[]);
  const owner = actor.role === 'owner';
  const access = enabled && hasEffectiveAccess(actor);
  const capabilities = effectiveCapabilitiesForUser(actor, enabled);
  return {
    status: 200,
    body: {
      contract: CRM_CONTRACT_VERSION,
      enabled,
      access,
      owner,
      capabilities,
    },
  };
}

/**
 * GET /api/crm/read/capabilities (SC-2.2, SC-4).
 * Single db.batch snapshot reading actor authority AND all users + grants together.
 */
export async function readCapabilitiesOverview(
  env: Env,
  actorId: string,
  tokenHash: string,
): Promise<
  | { status: 200; body: CapabilityOverview }
  | { status: 401; body: { error: 'unauthenticated' } }
  | { status: 403; body: { error: 'forbidden' } }
  | { status: 404; body: { error: 'not_found' } }
> {
  if (!isCrmEnabled(env)) {
    return { status: 404, body: { error: 'not_found' } };
  }
  const now = Date.now();
  const [sessionRes, actorGrantsRes, usersRes, allGrantsRes] = await env.DB.batch([
    sessionQuery(env.DB, tokenHash, actorId, now),
    actorGrantsQuery(env.DB, actorId),
    env.DB.prepare(
      `SELECT id, name, username, COALESCE(workspace_role, role) AS canonicalRole, disabled_at
       FROM users
       ORDER BY created_at, id`,
    ),
    env.DB.prepare(
      `SELECT user_id, capability, scope, granted_by, granted_at
       FROM crm_capability_grants
       ORDER BY user_id, capability, scope`,
    ),
  ]);

  const sessionRow = sessionRes.results[0] as SessionUserRow | undefined;
  if (!sessionRow || sessionRow.disabled_at !== null) {
    return { status: 401, body: { error: 'unauthenticated' } };
  }
  const actor = toActor(sessionRow, actorGrantsRes.results as unknown as GrantRow[]);
  if (!canManageCapabilities(actor)) {
    return { status: 403, body: { error: 'forbidden' } };
  }

  const grantsByUser = new Map<string, StoredGrant[]>();
  for (const row of allGrantsRes.results as unknown as GrantRow[]) {
    if (!row.user_id || !isCrmCapability(row.capability)) continue;
    const list = grantsByUser.get(row.user_id) ?? [];
    list.push({
      capability: row.capability,
      scope: row.scope,
      grantedBy: row.granted_by,
      grantedAt: row.granted_at,
    });
    grantsByUser.set(row.user_id, list);
  }

  const accounts: CapabilityOverviewAccount[] = (
    usersRes.results as unknown as OverviewUserRow[]
  ).map((u) => {
    const role = normalizeCanonicalRole(u.canonicalRole);
    const disabled = u.disabled_at !== null;
    const implicitAll = role === 'owner';
    const rawGrants = implicitAll ? [] : (grantsByUser.get(u.id) ?? []);
    return {
      userId: u.id,
      name: u.name,
      username: u.username,
      role,
      disabled,
      eligible: !disabled && role !== 'guest',
      implicitAll,
      effectiveAccess: hasEffectiveAccess({ role, disabled, grants: rawGrants }),
      grants: rawGrants,
    };
  });

  return { status: 200, body: { accounts } };
}

export function encodeAuditCursor(createdAt: number, id: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify([createdAt, id]));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function parseAuditCursor(raw: string): { createdAt: number; id: string } | null {
  if (!raw || raw.length > 256) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  if (raw.length % 4 === 1) return null;
  try {
    const base64 = raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (raw.length % 4)) % 4);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(decoded);
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [createdAt, id] = parsed;
    if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0) return null;
    if (typeof id !== 'string' || !CRM_CURSOR_ID_PATTERN.test(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function formatAuditPage(rows: AuditRow[]): CapabilityAuditPage {
  const hasMore = rows.length > AUDIT_PAGE_LIMIT;
  const page = hasMore ? rows.slice(0, AUDIT_PAGE_LIMIT) : rows;
  const items: CapabilityAuditItem[] = [];
  for (const row of page) {
    if (!isCrmCapability(row.capability)) continue;
    items.push({
      id: row.id,
      createdAt: row.created_at,
      actorId: row.actor_id,
      actorName: row.actor_name,
      targetUserId: row.target_user_id,
      targetName: row.target_name,
      action: row.action,
      capability: row.capability,
      scope: row.scope,
      reason: row.reason,
    });
  }
  const last = page[page.length - 1];
  const next = hasMore && last ? encodeAuditCursor(last.created_at, last.id) : null;
  return { items, next };
}

/**
 * GET /api/crm/read/capability-audit?cursor= (SC-2.2, SC-4.1, N1 snapshot clarification).
 *
 * Preserves exact precedence: 401 -> 404 -> 403 -> 400 invalid_cursor.
 * AND rechecks current session, canonical role, and CRM capabilities in the SAME
 * D1 `db.batch` snapshot as the returned audit rows so a concurrent revocation,
 * demotion, or disablement between pre-cursor check and final read cannot disclose
 * protected audit data.
 */
export async function readCapabilityAudit(
  env: Env,
  actorId: string,
  tokenHash: string,
  rawCursor?: string,
): Promise<
  | { status: 200; body: CapabilityAuditPage }
  | { status: 400; body: { error: 'invalid_cursor' } }
  | { status: 401; body: { error: 'unauthenticated' } }
  | { status: 403; body: { error: 'forbidden' } }
  | { status: 404; body: { error: 'not_found' } }
> {
  if (!isCrmEnabled(env)) {
    return { status: 404, body: { error: 'not_found' } };
  }

  // First page (no cursor): authority + audit rows in ONE single atomic snapshot batch.
  if (rawCursor === undefined) {
    const now = Date.now();
    const [sessionRes, grantsRes, auditRes] = await env.DB.batch([
      sessionQuery(env.DB, tokenHash, actorId, now),
      actorGrantsQuery(env.DB, actorId),
      env.DB
        .prepare(
          `SELECT a.id, a.created_at, a.actor_id, au.name AS actor_name,
                  a.target_user_id, tu.name AS target_name,
                  a.action, a.capability, a.scope, a.reason
           FROM crm_capability_audit a
           LEFT JOIN users au ON au.id = a.actor_id
           LEFT JOIN users tu ON tu.id = a.target_user_id
           ORDER BY a.created_at DESC, a.id DESC
           LIMIT ?`,
        )
        .bind(AUDIT_PAGE_LIMIT + 1),
    ]);
    const sessionRow = sessionRes.results[0] as SessionUserRow | undefined;
    if (!sessionRow || sessionRow.disabled_at !== null) {
      return { status: 401, body: { error: 'unauthenticated' } };
    }
    const actor = toActor(sessionRow, grantsRes.results as unknown as GrantRow[]);
    if (!canManageCapabilities(actor)) {
      return { status: 403, body: { error: 'forbidden' } };
    }
    return { status: 200, body: formatAuditPage(auditRes.results as unknown as AuditRow[]) };
  }

  // Cursor provided:
  // 1. Pre-cursor authority check (so unauthorized callers get 401/403 before 400 invalid_cursor).
  const preNow = Date.now();
  const [preSessionRes, preGrantsRes] = await env.DB.batch([
    sessionQuery(env.DB, tokenHash, actorId, preNow),
    actorGrantsQuery(env.DB, actorId),
  ]);
  const preSessionRow = preSessionRes.results[0] as SessionUserRow | undefined;
  if (!preSessionRow || preSessionRow.disabled_at !== null) {
    return { status: 401, body: { error: 'unauthenticated' } };
  }
  const preActor = toActor(preSessionRow, preGrantsRes.results as unknown as GrantRow[]);
  if (!canManageCapabilities(preActor)) {
    return { status: 403, body: { error: 'forbidden' } };
  }

  // 2. Cursor validation (only after caller is confirmed authorized).
  const cursor = parseAuditCursor(rawCursor);
  if (!cursor) {
    return { status: 400, body: { error: 'invalid_cursor' } };
  }

  // 3. Final audit retrieval + live authority recheck in ONE single atomic db.batch snapshot.
  const finalNow = Date.now();
  const [finalSessionRes, finalGrantsRes, auditRes] = await env.DB.batch([
    sessionQuery(env.DB, tokenHash, actorId, finalNow),
    actorGrantsQuery(env.DB, actorId),
    env.DB
      .prepare(
        `SELECT a.id, a.created_at, a.actor_id, au.name AS actor_name,
                a.target_user_id, tu.name AS target_name,
                a.action, a.capability, a.scope, a.reason
         FROM crm_capability_audit a
         LEFT JOIN users au ON au.id = a.actor_id
         LEFT JOIN users tu ON tu.id = a.target_user_id
         WHERE (a.created_at < ? OR (a.created_at = ? AND a.id < ?))
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT ?`,
      )
      .bind(cursor.createdAt, cursor.createdAt, cursor.id, AUDIT_PAGE_LIMIT + 1),
  ]);

  const finalSessionRow = finalSessionRes.results[0] as SessionUserRow | undefined;
  if (!finalSessionRow || finalSessionRow.disabled_at !== null) {
    return { status: 401, body: { error: 'unauthenticated' } };
  }
  const finalActor = toActor(finalSessionRow, finalGrantsRes.results as unknown as GrantRow[]);
  if (!canManageCapabilities(finalActor)) {
    return { status: 403, body: { error: 'forbidden' } };
  }

  return { status: 200, body: formatAuditPage(auditRes.results as unknown as AuditRow[]) };
}
