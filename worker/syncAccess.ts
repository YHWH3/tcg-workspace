/** Permission-aware sync reads. Activation remains off until the snapshot and
 * client reconciliation protocol and every other read surface are integrated. */
import { Hono } from 'hono';
import { effectiveSpaceRole, isActivePrincipal } from '../shared/access';
import type { PulledRecord } from '../shared/types';
import { accessFence, AccessError, loadAccessContext, MAX_ACCESS_SPACES, readableSpaceIds, spaceAccess, type AccessContext } from './access';
import { requireAuth, type AuthUser, type Env } from './auth';
import { readAuthorizedRecords, RecordAccessError } from './recordAccess';

export interface AccessState { generation: number; enabled: number }
export async function loadAccessState(db: D1Database): Promise<AccessState> {
  const state = await db.prepare('SELECT generation,enabled FROM access_state WHERE id=1').first<AccessState>();
  if (!state || !Number.isSafeInteger(state.generation) || state.generation < 1 || ![0, 1].includes(state.enabled)) throw new AccessError('permission_schema_unavailable');
  return state;
}

export class SyncProtocolError extends Error {
  constructor(public readonly code: 'permission_protocol_required' | 'invalid_sync_request' | 'access_reset_required' | 'unauthenticated', public readonly status: 400 | 401 | 409 | 426) {
    super(code); this.name = 'SyncProtocolError';
  }
}

export function validateSyncProtocol(state: AccessState, protocol: unknown, generation: unknown): void {
  if (!state.enabled) return;
  if (protocol !== 2 && protocol !== '2') throw new SyncProtocolError('permission_protocol_required', 426);
  const parsed = typeof generation === 'string' && /^\d+$/.test(generation) ? Number(generation) : generation;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 1) throw new SyncProtocolError('invalid_sync_request', 400);
  if (parsed !== state.generation) throw new SyncProtocolError('access_reset_required', 409);
}

/** Bounded space discovery contains IDs only. Names/configurations are fetched
 * only after effective membership has been checked. */
async function syncContext(db: D1Database, userId: string, state: AccessState): Promise<AccessContext> {
  const ids = (await db.prepare('SELECT id FROM spaces ORDER BY id LIMIT ?').bind(MAX_ACCESS_SPACES + 1).all<{ id: string }>()).results;
  if (ids.length > MAX_ACCESS_SPACES) throw new RecordAccessError('scope_graph_budget');
  const context = await loadAccessContext(db, userId, ids.map(r => r.id));
  if (!isActivePrincipal(context.principal)) throw new SyncProtocolError('unauthenticated', 401);
  if (context.generation !== state.generation || context.enabled !== (state.enabled === 1)) throw new SyncProtocolError('access_reset_required', 409);
  return context;
}

async function fencedRead(db: D1Database, context: AccessContext, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  try { return await db.batch([accessFence(db, context), ...statements]); }
  catch (error) {
    // Translate an epoch guard rollback into the protocol's recoverable reset,
    // while preserving unrelated SQL/runtime errors as genuine failures.
    const current = await loadAccessState(db);
    if (current.generation !== context.generation || (current.enabled === 1) !== context.enabled) throw new SyncProtocolError('access_reset_required', 409);
    throw error;
  }
}

export interface PullV2 { protocol: 2; generation: number; records: PulledRecord[]; cursor: number; hasMore: boolean }

export async function pullAuthorized(db: D1Database, userId: string, state: AccessState, since: number, limit: number): Promise<PullV2> {
  if (!Number.isSafeInteger(since) || since < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new SyncProtocolError('invalid_sync_request', 400);
  const context = await syncContext(db, userId, state);
  // Denormalized scope is an indexed prefilter, never a grant: every candidate
  // is resolved through current ancestry and both relation endpoints below.
  // No private content is materialized by this candidate query.
  const [, highWater, candidates] = await fencedRead(db, context, [
    db.prepare('SELECT COALESCE(MAX(seq),0) cutoff FROM records'),
    db.prepare('SELECT id,seq FROM records WHERE space_id IN (SELECT value FROM json_each(?)) AND seq>? ORDER BY seq,id LIMIT ?')
      .bind(JSON.stringify(readableSpaceIds(context)), since, limit + 1),
  ]);
  const cutoff = (highWater.results[0] as { cutoff: number }).cutoff;
  if (since > cutoff) throw new SyncProtocolError('access_reset_required', 409);
  const seeds = (candidates.results as unknown as { id: string; seq: number }[]).slice(0, limit);
  const hasMore = candidates.results.length > limit;
  const authorized = await readAuthorizedRecords(db, userId, seeds.map(r => r.id), { includeDeleted: true });
  if (authorized.context.generation !== state.generation || !authorized.context.enabled) throw new SyncProtocolError('access_reset_required', 409);
  const records: PulledRecord[] = [];
  for (const seed of seeds) {
    const record = authorized.records.get(seed.id);
    if (!record) continue;
    // Moving/updating a candidate after the cutoff must not skip a revision or
    // publish content from a different page. A clean retry recomputes the page.
    if (record.rev !== seed.seq) throw new SyncProtocolError('access_reset_required', 409);
    records.push({ id: record.id, collection: record.collection, data: record.data, field_ts: record.fieldTs, seq: record.rev });
  }
  // Even an empty result must reject revocation that happened during graph
  // filtering. A read-only fence cannot mutate application data.
  await fencedRead(db, context, []);
  return { protocol: 2, generation: state.generation, records, cursor: hasMore ? seeds[seeds.length - 1].seq : cutoff, hasMore };
}

export const accessApi = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
accessApi.use('*', requireAuth);
accessApi.get('/', async c => {
  c.header('Cache-Control', 'no-store');
  const state = await loadAccessState(c.env.DB), context = await syncContext(c.env.DB, c.get('user').id, state);
  const [, rows] = await fencedRead(c.env.DB, context, [
    c.env.DB.prepare('SELECT id,name,export_policy FROM spaces WHERE id IN (SELECT value FROM json_each(?)) ORDER BY name,id')
      .bind(JSON.stringify(readableSpaceIds(context))),
  ]);
  const spaces = (rows.results as unknown as { id: string; name: string; export_policy: string }[]).map(s => ({
    id: s.id, name: s.name, role: effectiveSpaceRole(spaceAccess(context, s.id)), exportPolicy: s.export_policy,
  }));
  return c.json({ protocol: state.enabled ? 2 : 1, userId: context.userId, generation: state.generation, spaces });
});

/** Register at each router boundary; never turn permission failures into a
 * successful empty page. The app's outer handler still owns unexpected errors. */
export function syncFailure(error: unknown): { error: string; status: 400 | 401 | 409 | 426 | 503 } | null {
  if (error instanceof SyncProtocolError) return { error: error.code, status: error.status };
  if (error instanceof RecordAccessError) return { error: error.code === 'scope_graph_budget' ? 'authorization_budget' : 'access_reset_required', status: error.code === 'scope_graph_budget' ? 503 : 409 };
  if (error instanceof AccessError) return { error: error.code, status: 503 };
  return null;
}
accessApi.onError((error, c) => {
  const result = syncFailure(error);
  if (result) return c.json({ error: result.error }, result.status);
  throw error;
});
