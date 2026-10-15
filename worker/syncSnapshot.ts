/** Frozen, ephemeral permission-reconciliation snapshots. Generic record
 * writes/history never use these tables. Session secrets never leave D1. */
import { Hono } from 'hono';
import type { PulledRecord } from '../shared/types';
import { readableSpaceIds, type AccessContext } from './access';
import { requireAuth, type AuthUser, type Env } from './auth';
import { randomToken } from './password';
import { readAuthorizedRecords } from './recordAccess';
import { fencedRead, loadAccessState, syncContext, syncFailure, SyncProtocolError, validateSyncProtocol } from './syncAccess';

export const SNAPSHOT_TTL_MS = 15 * 60_000;
export const MAX_SNAPSHOT_RECORDS = 20_000;
export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export const MAX_ALL_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_ACTIVE_SNAPSHOTS = 2;
interface SnapshotRow {
  id: string; user_id: string; request_id: string; generation: number; cutoff: number; page_size: number;
  cursor_secret: string; created_at: number; expires_at: number;
}
interface ItemRow { ordinal: number; record_id: string; collection: string; data: string; field_ts: string; seq: number }
class SnapshotError extends Error {
  constructor(public readonly code: 'snapshot_not_found' | 'snapshot_expired' | 'snapshot_capacity' | 'snapshot_too_large' | 'request_id_reused' | 'invalid_snapshot_request', public readonly status: 400 | 404 | 409 | 410 | 413 | 429) {
    super(code); this.name = 'SnapshotError';
  }
}
const validId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64 && !/[\u0000-\u001f\u007f]/.test(v);
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function decode(value: string) { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); }
async function cursorKey(row: SnapshotRow) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(row.cursor_secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function continuation(row: SnapshotRow, ordinal: number): Promise<string> {
  const payload = `${row.id}:${ordinal}`;
  return `${ordinal}.${encode(new Uint8Array(await crypto.subtle.sign('HMAC', await cursorKey(row), new TextEncoder().encode(payload))))}`;
}
async function ordinalFrom(row: SnapshotRow, cursor: unknown): Promise<number> {
  if (typeof cursor !== 'string' || cursor.length > 128 || !/^\d+\.[A-Za-z0-9_-]{43}$/.test(cursor)) throw new SnapshotError('invalid_snapshot_request', 400);
  const [value, signature] = cursor.split('.'), ordinal = Number(value);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || String(ordinal) !== value) throw new SnapshotError('invalid_snapshot_request', 400);
  const verified = await crypto.subtle.verify('HMAC', await cursorKey(row), decode(signature), new TextEncoder().encode(`${row.id}:${ordinal}`));
  if (!verified) throw new SnapshotError('invalid_snapshot_request', 400);
  return ordinal;
}
async function describe(row: SnapshotRow) {
  return { protocol: 2, snapshotId: row.id, generation: row.generation, cutoff: row.cutoff, cursor: await continuation(row, 0), expiresAt: row.expires_at };
}
async function requireCurrent(db: D1Database, userId: string, row: SnapshotRow) {
  const state = await loadAccessState(db);
  if (!state.enabled || row.generation !== state.generation) throw new SyncProtocolError('access_reset_required', 409);
  if (row.expires_at <= Date.now()) throw new SnapshotError('snapshot_expired', 410);
  return syncContext(db, userId, state);
}
function requestStatement(db: D1Database, userId: string, requestId: string) {
  return db.prepare('SELECT * FROM sync_snapshots WHERE user_id=? AND request_id=?').bind(userId, requestId);
}

async function snapshotRead(db: D1Database, context: AccessContext, row: SnapshotRow, statements: D1PreparedStatement[]) {
  try {
    const result = await fencedRead(db, context, [
      db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM sync_snapshots WHERE id=? AND user_id=? AND generation=? AND cutoff=? AND expires_at>?)
        THEN 1 ELSE json_extract('{','$') END`).bind(row.id, context.userId, row.generation, row.cutoff, Date.now()),
      ...statements,
    ]);
    // Keep the same indexing contract as fencedRead for caller statements.
    return [result[0], ...result.slice(2)];
  } catch (error) {
    const current = await db.prepare('SELECT expires_at FROM sync_snapshots WHERE id=? AND user_id=?').bind(row.id, context.userId).first<{ expires_at: number }>();
    if (!current) throw new SnapshotError('snapshot_not_found', 404);
    if (current.expires_at <= Date.now()) throw new SnapshotError('snapshot_expired', 410);
    throw error;
  }
}

export async function createSyncSnapshot(db: D1Database, userId: string, input: { protocol?: unknown; generation?: unknown; requestId?: unknown; pageSize?: unknown }) {
  if (!validId(input.requestId) || (input.pageSize !== undefined && (!Number.isInteger(input.pageSize) || Number(input.pageSize) < 1 || Number(input.pageSize) > 500))) throw new SnapshotError('invalid_snapshot_request', 400);
  const state = await loadAccessState(db);
  if (!state.enabled) throw new SyncProtocolError('permission_protocol_required', 426);
  validateSyncProtocol(state, input.protocol, input.generation);
  const context = await syncContext(db, userId, state), pageSize = Number(input.pageSize ?? 500);
  const prior = await requestStatement(db, userId, input.requestId).first<SnapshotRow>();
  if (prior) {
    if (prior.generation !== state.generation || prior.page_size !== pageSize) throw new SnapshotError('request_id_reused', 409);
    await requireCurrent(db, userId, prior); return describe(prior);
  }
  const now = Date.now(), id = crypto.randomUUID(), secret = randomToken(), spaces = JSON.stringify(readableSpaceIds(context));
  try {
    await fencedRead(db, context, [
      // Prune only expired ephemeral copies, with bounded metadata discovery.
      db.prepare('DELETE FROM sync_snapshots WHERE id IN (SELECT id FROM sync_snapshots WHERE expires_at<=? ORDER BY expires_at,id LIMIT 100)').bind(now),
      db.prepare(`SELECT CASE WHEN (SELECT COUNT(*) FROM sync_snapshots WHERE user_id=? AND expires_at>?)<?
        OR EXISTS(SELECT 1 FROM sync_snapshots WHERE user_id=? AND request_id=?) THEN 1 ELSE json_extract('{','$') END`)
        .bind(userId, now, MAX_ACTIVE_SNAPSHOTS, userId, input.requestId),
      db.prepare(`INSERT OR IGNORE INTO sync_snapshots(id,user_id,request_id,generation,cutoff,page_size,cursor_secret,created_at,expires_at)
        VALUES(?,?,?,?,(SELECT COALESCE(MAX(seq),0) FROM records),?,?,?,?)`)
        .bind(id, userId, input.requestId, state.generation, pageSize, secret, now, now + SNAPSHOT_TTL_MS),
      // SQL freezes payloads/cutoff in one transaction. The scope index is only
      // a prefilter: publication still checks both endpoints/current ancestry.
      db.prepare(`INSERT INTO sync_snapshot_items(snapshot_id,ordinal,record_id,collection,data,field_ts,seq)
        SELECT ?,ROW_NUMBER() OVER(ORDER BY r.seq,r.id),r.id,r.collection,r.data,r.field_ts,r.seq FROM records r
        WHERE r.space_id IN (SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM sync_snapshots WHERE id=?)
        ORDER BY r.seq,r.id LIMIT ?`).bind(id, spaces, id, MAX_SNAPSHOT_RECORDS + 1),
      db.prepare(`SELECT CASE WHEN COUNT(*)<=? AND COALESCE(SUM(length(CAST(data AS BLOB))+length(CAST(field_ts AS BLOB))),0)<=?
        THEN 1 ELSE json_extract('{','$') END FROM sync_snapshot_items WHERE snapshot_id=?`).bind(MAX_SNAPSHOT_RECORDS, MAX_SNAPSHOT_BYTES, id),
      db.prepare(`SELECT CASE WHEN COALESCE(SUM(length(CAST(data AS BLOB))+length(CAST(field_ts AS BLOB))),0)<=?
        THEN 1 ELSE json_extract('{','$') END FROM sync_snapshot_items`).bind(MAX_ALL_SNAPSHOT_BYTES),
    ]);
  } catch (error) {
    // A lost transaction response is recovered by the unique request identity;
    // an incomplete transaction cannot leave a usable snapshot header behind.
    const committed = await requestStatement(db, userId, input.requestId).first<SnapshotRow>();
    if (committed) {
      if (committed.generation !== state.generation || committed.page_size !== pageSize) throw new SnapshotError('request_id_reused', 409);
      await requireCurrent(db, userId, committed); return describe(committed);
    }
    if (error instanceof Error && /malformed JSON/i.test(error.message)) {
      const count = await db.prepare('SELECT COUNT(*) n FROM sync_snapshots WHERE user_id=? AND expires_at>?').bind(userId, now).first<{ n: number }>();
      throw new SnapshotError(count!.n >= MAX_ACTIVE_SNAPSHOTS ? 'snapshot_capacity' : 'snapshot_too_large', count!.n >= MAX_ACTIVE_SNAPSHOTS ? 429 : 413);
    }
    throw error;
  }
  const committed = await requestStatement(db, userId, input.requestId).first<SnapshotRow>();
  if (!committed) throw new Error('snapshot commit evidence missing');
  if (committed.page_size !== pageSize) throw new SnapshotError('request_id_reused', 409);
  await requireCurrent(db, userId, committed); return describe(committed);
}

export async function readSyncSnapshot(db: D1Database, userId: string, snapshotId: string, cursor: unknown) {
  if (!validId(snapshotId)) throw new SnapshotError('snapshot_not_found', 404);
  const row = await db.prepare('SELECT * FROM sync_snapshots WHERE id=? AND user_id=?').bind(snapshotId, userId).first<SnapshotRow>();
  if (!row) throw new SnapshotError('snapshot_not_found', 404);
  const context = await requireCurrent(db, userId, row), after = await ordinalFrom(row, cursor);
  const [, items] = await snapshotRead(db, context, row, [db.prepare('SELECT ordinal,record_id,collection,data,field_ts,seq FROM sync_snapshot_items WHERE snapshot_id=? AND ordinal>? ORDER BY ordinal LIMIT ?').bind(row.id, after, row.page_size + 1)]);
  const candidates = (items.results as unknown as ItemRow[]).slice(0, row.page_size), done = items.results.length <= row.page_size;
  const authorized = await readAuthorizedRecords(db, userId, candidates.map(r => r.record_id), { includeDeleted: true });
  if (authorized.context.generation !== row.generation || !authorized.context.enabled) throw new SyncProtocolError('access_reset_required', 409);
  const records: PulledRecord[] = candidates.filter(r => authorized.records.has(r.record_id)).map(r => ({ id: r.record_id, collection: r.collection,
    data: JSON.parse(r.data), field_ts: JSON.parse(r.field_ts), seq: r.seq }));
  await snapshotRead(db, context, row, []);
  return { protocol: 2, snapshotId: row.id, generation: row.generation, cutoff: row.cutoff, records, done,
    cursor: done ? null : await continuation(row, candidates[candidates.length - 1].ordinal) };
}

export const snapshotsApi = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
snapshotsApi.use('*', requireAuth);
snapshotsApi.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
snapshotsApi.post('/', async c => {
  const input = await c.req.json().catch(() => null);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SnapshotError('invalid_snapshot_request', 400);
  return c.json(await createSyncSnapshot(c.env.DB, c.get('user').id, input));
});
snapshotsApi.get('/:id', async c => c.json(await readSyncSnapshot(c.env.DB, c.get('user').id, c.req.param('id'), c.req.query('cursor'))));
snapshotsApi.delete('/:id', async c => {
  const id = c.req.param('id');
  if (!validId(id)) throw new SnapshotError('snapshot_not_found', 404);
  const result = await c.env.DB.prepare('DELETE FROM sync_snapshots WHERE id=? AND user_id=?').bind(id, c.get('user').id).run();
  if (!result.meta.changes) throw new SnapshotError('snapshot_not_found', 404);
  return c.json({ ok: true });
});
snapshotsApi.onError((error, c) => {
  if (error instanceof SnapshotError) return c.json({ error: error.code }, error.status);
  const result = syncFailure(error);
  if (result) return c.json({ error: result.error }, result.status);
  throw error;
});
