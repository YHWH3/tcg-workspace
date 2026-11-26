import { isCrmCapability, type CrmCapability, type CrmScope } from '../../shared/crm/capabilities';
import type { Env } from '../auth';
import { createReadGate, type ReadGate } from '../readAccess';
import {
  canAccessCrmApi,
  evaluateCapability,
  isCrmEnabled,
  normalizeCanonicalRole,
  type CrmActor,
  type StoredGrant,
} from './rules';

export const SQLITE_NOW_MS = `CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`;

export interface CrmSessionRow {
  id: string;
  name: string;
  disabled_at: number | null;
  canonicalRole: string;
}

export interface CrmGrantRow {
  capability: string;
  scope: string;
  granted_by: string;
  granted_at: number;
}

export function buildActorFromRows(sessionRow: CrmSessionRow, grantRows: CrmGrantRow[]): CrmActor {
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

export function sessionAuthStmt(
  db: D1Database,
  actorId: string,
  tokenHash: string,
  now = Date.now(),
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT u.id, u.name, u.disabled_at, COALESCE(u.workspace_role, u.role) AS canonicalRole
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > MAX(?, ${SQLITE_NOW_MS})`,
    )
    .bind(tokenHash, actorId, now);
}

export function actorGrantsStmt(db: D1Database, actorId: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT capability, scope, granted_by, granted_at
       FROM crm_capability_grants
       WHERE user_id = ?
       ORDER BY capability, scope`,
    )
    .bind(actorId);
}

export function evaluateCrmReadAuthRows(
  sessionRow: CrmSessionRow | undefined,
  grantRows: CrmGrantRow[],
  requiredCap?: CrmCapability,
  scope: CrmScope = '*',
): CrmReadAuthResult {
  if (!sessionRow || sessionRow.disabled_at !== null) {
    return { ok: false, status: 401, body: { error: 'unauthenticated' } };
  }
  const actor = buildActorFromRows(sessionRow, grantRows);
  if (!canAccessCrmApi(actor)) {
    return { ok: false, status: 403, body: { error: 'forbidden' } };
  }
  if (requiredCap && !evaluateCapability(actor, requiredCap, scope)) {
    return { ok: false, status: 403, body: { error: 'forbidden' } };
  }
  return { ok: true, actor, actorName: sessionRow.name };
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
    sessionAuthStmt(env.DB, actorId, tokenHash, now),
    actorGrantsStmt(env.DB, actorId),
  ]);
  return evaluateCrmReadAuthRows(
    sessionRes.results[0] as CrmSessionRow | undefined,
    grantsRes.results as unknown as CrmGrantRow[],
    requiredCap,
    scope,
  );
}

/**
 * Post-read atomic re-verification of current session, non-disablement, canonical role,
 * CRM capability grants, and ReadGate observed records (SC-2.2 parity).
 */
export async function finalizeCrmReadAuth(
  env: Env,
  actorId: string,
  tokenHash: string,
  opts: {
    requiredCap?: CrmCapability;
    scope?: CrmScope;
    gate?: ReadGate;
    deniedStatus?: 403 | 404;
  } = {},
): Promise<CrmReadAuthResult> {
  const auth = await loadCrmReadContext(env, actorId, tokenHash, opts.requiredCap, opts.scope);
  if (!auth.ok) return auth;
  if (opts.gate && !(await opts.gate.validateObserved())) {
    const denied = opts.deniedStatus ?? 403;
    return { ok: false, status: denied, body: { error: denied === 404 ? 'not_found' : 'forbidden' } };
  }
  return auth;
}

export interface LoadedTaskRecord {
  id: string;
  collection: string;
  data: Record<string, unknown>;
  seq: number;
}

export async function loadReadableTaskRecords(
  env: Env,
  gate: ReadGate,
  ids: readonly string[],
): Promise<Map<string, LoadedTaskRecord & { updatedAt: number }>> {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 128))];
  const out = new Map<string, LoadedTaskRecord & { updatedAt: number }>();
  if (unique.length === 0) return out;

  const parsed: (LoadedTaskRecord & { updatedAt: number })[] = [];
  for (let i = 0; i < unique.length; i += 500) {
    const slice = unique.slice(i, i + 500);
    const { results } = await env.DB
      .prepare(
        `SELECT id, collection, data, seq, updated_at
         FROM records
         WHERE collection = 'tasks'
           AND id IN (SELECT value FROM json_each(?))`,
      )
      .bind(JSON.stringify(slice))
      .all<{ id: string; collection: string; data: string; seq: number; updated_at: number | null }>();
    for (const row of results) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(row.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (data.deleted === true) continue;
      parsed.push({
        id: row.id,
        collection: row.collection,
        data,
        seq: row.seq,
        updatedAt: Number(data.createdAt ?? row.updated_at ?? 0),
      });
    }
  }
  if (parsed.length === 0) return out;
  const kept = await gate.filter(parsed.map((r) => ({ id: r.id, rev: r.seq })));
  const allowedIds = new Set(kept.map((k) => k.id));
  for (const rec of parsed) {
    if (allowedIds.has(rec.id)) out.set(rec.id, rec);
  }
  return out;
}

export async function loadReadableTaskRecord(
  env: Env,
  actorId: string,
  recordId: string,
): Promise<LoadedTaskRecord | null> {
  const gate = createReadGate(env.DB, actorId);
  const map = await loadReadableTaskRecords(env, gate, [recordId]);
  const hit = map.get(recordId);
  if (!hit) return null;
  return { id: hit.id, collection: hit.collection, data: hit.data, seq: hit.seq };
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
