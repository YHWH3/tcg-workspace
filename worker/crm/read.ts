import { isCrmCapability, type CrmCapability, type CrmScope } from '../../shared/crm/capabilities';
import type { Env } from '../auth';
import { createReadGate } from '../readAccess';
import {
  canAccessCrmApi,
  evaluateCapability,
  isCrmEnabled,
  normalizeCanonicalRole,
  type CrmActor,
  type StoredGrant,
} from './rules';

export const SQLITE_NOW_MS = `CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`;

interface SessionRow {
  id: string;
  name: string;
  disabled_at: number | null;
  canonicalRole: string;
}

interface GrantRow {
  capability: string;
  scope: string;
  granted_by: string;
  granted_at: number;
}

export function buildActorFromRows(sessionRow: SessionRow, grantRows: GrantRow[]): CrmActor {
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

/**
 * Transactional SQL fence for P1 CRM commands.
 * Re-checks live session, non-disabled, canonical role != guest, role match,
 * `crm.access`, and optional specialized capability + scope inside the D1 write batch.
 */
export function crmActorFence(
  db: D1Database,
  actor: Pick<CrmActor, 'id' | 'role'>,
  tokenHash: string,
  requiredCap?: CrmCapability,
  scope: CrmScope = '*',
  now = Date.now(),
): D1PreparedStatement {
  if (actor.role === 'owner') {
    return db
      .prepare(
        `SELECT CASE WHEN EXISTS (
           SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > MAX(?, ${SQLITE_NOW_MS})
             AND u.disabled_at IS NULL AND COALESCE(u.workspace_role, u.role) = 'owner'
         ) THEN 1 ELSE json_extract('{', '$') END`,
      )
      .bind(tokenHash, actor.id, now);
  }
  const extraCap = requiredCap && requiredCap !== 'crm.access' ? requiredCap : null;
  if (!extraCap) {
    return db
      .prepare(
        `SELECT CASE WHEN EXISTS (
           SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > MAX(?, ${SQLITE_NOW_MS})
             AND u.disabled_at IS NULL AND COALESCE(u.workspace_role, u.role) = ?
             AND COALESCE(u.workspace_role, u.role) != 'guest'
         )
         AND EXISTS (
           SELECT 1 FROM crm_capability_grants
           WHERE user_id = ? AND capability = 'crm.access' AND scope = '*'
         )
         THEN 1 ELSE json_extract('{', '$') END`,
      )
      .bind(tokenHash, actor.id, now, actor.role, actor.id);
  }
  return db
    .prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > MAX(?, ${SQLITE_NOW_MS})
           AND u.disabled_at IS NULL AND COALESCE(u.workspace_role, u.role) = ?
           AND COALESCE(u.workspace_role, u.role) != 'guest'
       )
       AND EXISTS (
         SELECT 1 FROM crm_capability_grants
         WHERE user_id = ? AND capability = 'crm.access' AND scope = '*'
       )
       AND EXISTS (
         SELECT 1 FROM crm_capability_grants
         WHERE user_id = ? AND capability = ? AND scope IN ('*', ?)
       )
       THEN 1 ELSE json_extract('{', '$') END`,
    )
    .bind(tokenHash, actor.id, now, actor.role, actor.id, actor.id, extraCap, scope);
}

export type CrmReadAuthResult =
  | { ok: true; actor: CrmActor; actorName: string }
  | { ok: false; status: 401 | 403 | 404; body: { error: 'unauthenticated' | 'forbidden' | 'not_found' } };

/**
 * Single D1 batch authority snapshot for CRM read endpoints.
 */
export async function loadCrmReadContext(
  env: Env,
  actorId: string,
  tokenHash: string,
  requiredCap?: CrmCapability,
  scope: CrmScope = '*',
): Promise<CrmReadAuthResult> {
  if (!isCrmEnabled(env)) {
    return { ok: false, status: 404, body: { error: 'not_found' } };
  }
  const now = Date.now();
  const [sessionRes, grantsRes] = await env.DB.batch([
    env.DB
      .prepare(
        `SELECT u.id, u.name, u.disabled_at, COALESCE(u.workspace_role, u.role) AS canonicalRole
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > MAX(?, ${SQLITE_NOW_MS})`,
      )
      .bind(tokenHash, actorId, now),
    env.DB
      .prepare(
        `SELECT capability, scope, granted_by, granted_at
         FROM crm_capability_grants
         WHERE user_id = ?
         ORDER BY capability, scope`,
      )
      .bind(actorId),
  ]);
  const sessionRow = sessionRes.results[0] as SessionRow | undefined;
  if (!sessionRow || sessionRow.disabled_at !== null) {
    return { ok: false, status: 401, body: { error: 'unauthenticated' } };
  }
  const actor = buildActorFromRows(sessionRow, grantsRes.results as unknown as GrantRow[]);
  if (!canAccessCrmApi(actor)) {
    return { ok: false, status: 403, body: { error: 'forbidden' } };
  }
  if (requiredCap && !evaluateCapability(actor, requiredCap, scope)) {
    return { ok: false, status: 403, body: { error: 'forbidden' } };
  }
  return { ok: true, actor, actorName: sessionRow.name };
}

export interface LoadedTaskRecord {
  id: string;
  collection: string;
  data: Record<string, unknown>;
  seq: number;
}

export async function loadReadableTaskRecord(
  env: Env,
  actorId: string,
  recordId: string,
): Promise<LoadedTaskRecord | null> {
  const gate = createReadGate(env.DB, actorId);
  const row = await env.DB
    .prepare(`SELECT id, collection, data, seq FROM records WHERE id = ? AND collection = 'tasks'`)
    .bind(recordId)
    .first<{ id: string; collection: string; data: string; seq: number }>();
  if (!row) return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(row.data) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (data.deleted === true) return null;
  const kept = await gate.filter([{ id: row.id, rev: row.seq }]);
  if (kept.length === 0) return null;
  return { id: row.id, collection: row.collection, data, seq: row.seq };
}

export function encodeTimeIdCursor(ts: number, id: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify([ts, id]));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeTimeIdCursor(raw: string): { ts: number; id: string } | null {
  if (!raw || raw.length > 256 || !/^[A-Za-z0-9_-]+$/.test(raw) || raw.length % 4 === 1) {
    return null;
  }
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (raw.length % 4)) % 4);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [ts, id] = parsed;
    if (typeof ts !== 'number' || !Number.isSafeInteger(ts) || ts < 0) return null;
    if (typeof id !== 'string' || id.length < 1 || id.length > 128) return null;
    return { ts, id };
  } catch {
    return null;
  }
}
