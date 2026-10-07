import { Hono } from 'hono';
import { isCollection } from '../shared/collections';
import type { Mutation } from '../shared/types';
import { mergeRecord } from './merge';
import { requireAuth } from './auth';
import type { Env, AuthUser } from './auth';

const MAX_CHANGES = 500;
const MAX_ID_LEN = 64;
const MAX_ATTEMPTS = 3;

interface RecordRow {
  id: string;
  collection: string;
  data: string;
  field_ts: string;
  seq: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validChange(ch: unknown): ch is Mutation {
  if (!isPlainObject(ch)) return false;
  return (
    typeof ch.id === 'string' &&
    ch.id.length > 0 &&
    ch.id.length <= MAX_ID_LEN &&
    typeof ch.collection === 'string' &&
    isCollection(ch.collection) &&
    isPlainObject(ch.patch) &&
    typeof ch.ts === 'number' &&
    Number.isFinite(ch.ts)
  );
}

/** One write per record id: ordered patches re-merged against the freshest row. */
interface Plan {
  id: string;
  collection: string;
  /** Patch+ts pairs applied in request order. */
  patches: { patch: Record<string, unknown>; ts: number }[];
  /** seq of the row we merged against; -1 when the row didn't exist. */
  baseSeq: number;
  data: Record<string, unknown>;
  field_ts: Record<string, number>;
  changed: boolean;
}

async function readRows(db: D1Database, ids: string[]): Promise<Map<string, RecordRow>> {
  const out = new Map<string, RecordRow>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { results } = await db
      .prepare(`SELECT id, collection, data, field_ts, seq FROM records WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<RecordRow>();
    for (const row of results) out.set(row.id, row);
  }
  return out;
}

function applyPatches(plan: Plan, existing: RecordRow | null): void {
  const prev = existing ? { data: JSON.parse(existing.data) as Record<string, unknown>, field_ts: JSON.parse(existing.field_ts) as Record<string, number> } : null;
  let merged = prev ?? { data: {}, field_ts: {} };
  let changed = false;
  for (const p of plan.patches) {
    const r = mergeRecord(merged, p);
    merged = { data: r.data, field_ts: r.field_ts };
    changed = changed || r.changed;
  }
  plan.baseSeq = existing?.seq ?? -1;
  plan.data = merged.data;
  plan.field_ts = merged.field_ts;
  plan.changed = changed;
}

export interface ApplyOptions {
  /**
   * MCP/server-side writes: stamp every field with max(now, existingTs+1) so an
   * AI edit wins against older client values — same as a fresh client write
   * being the newest. When unset the caller's `ts` is used verbatim (push).
   */
  serverTs?: boolean;
}

/**
 * Re-stamp each patch with a timestamp guaranteed newer than every existing
 * field timestamp on its record (and ≥ now). Pure — unit-tested.
 */
export function restampForServer(changes: Mutation[], existingTs: Map<string, number>, now: number): Mutation[] {
  // Track the max ts issued per record so consecutive patches to the same
  // record still tick forward.
  const issued = new Map<string, number>();
  return changes.map((ch) => {
    const floor = Math.max(now, (existingTs.get(ch.id) ?? 0) + 1, (issued.get(ch.id) ?? 0) + 1);
    issued.set(ch.id, floor);
    return { ...ch, ts: floor };
  });
}

export interface ApplyResult {
  rejected: number;
  changed: number;
  /** Filled on hard conflict after retries — caller turns it into a 409. */
  conflict?: boolean;
}

/**
 * Merge + upsert core shared by /api/sync/push and the MCP write tools.
 * Invalid changes are skipped (counted in `rejected`); concurrent updates are
 * re-read, re-merged and retried up to MAX_ATTEMPTS.
 */
export async function applyChanges(env: Env, userId: string, changes: unknown[], opts: ApplyOptions = {}): Promise<ApplyResult> {
  const db = env.DB;
  const now = Date.now();

  let rejected = 0;
  let incoming = (changes as unknown[]).filter((ch): ch is Mutation => {
    if (!validChange(ch)) {
      rejected++;
      return false;
    }
    return true;
  });

  if (opts.serverTs && incoming.length) {
    // Read field_ts floors for stamping before planning.
    const allIds = [...new Set(incoming.map((c) => c.id))];
    const rows = await readRows(db, allIds);
    const floors = new Map<string, number>();
    for (const [id, row] of rows) {
      try {
        const ts = JSON.parse(row.field_ts) as Record<string, number>;
        floors.set(id, Math.max(0, ...Object.values(ts)));
      } catch {
        floors.set(id, 0);
      }
    }
    incoming = restampForServer(incoming, floors, now);
  }

  const plans = new Map<string, Plan>();
  for (const ch of incoming) {
    let plan = plans.get(ch.id);
    if (!plan) {
      plan = { id: ch.id, collection: ch.collection, patches: [], baseSeq: -1, data: {}, field_ts: {}, changed: false };
      plans.set(ch.id, plan);
    }
    if (plan.collection !== ch.collection) {
      rejected++;
      continue;
    }
    plan.patches.push({ patch: ch.patch, ts: ch.ts });
  }

  const ids = [...plans.keys()];
  const existing = await readRows(db, ids);
  for (const plan of plans.values()) {
    const row = existing.get(plan.id);
    if (row && row.collection !== plan.collection) {
      plan.changed = false;
      plan.baseSeq = row.seq;
      plan.data = JSON.parse(row.data);
      plan.field_ts = JSON.parse(row.field_ts);
      rejected += plan.patches.length;
      plans.delete(plan.id);
      continue;
    }
    applyPatches(plan, row ?? null);
  }

  let todo = [...plans.values()].filter((p) => p.changed);
  let attempt = 0;
  while (todo.length > 0 && attempt < MAX_ATTEMPTS) {
    const failed: Plan[] = [];
    for (let i = 0; i < todo.length; i += 100) {
      const chunk = todo.slice(i, i + 100);
      const stmts = chunk.map((p) =>
        db
          .prepare(
            `INSERT INTO records (id, collection, data, field_ts, seq, updated_by, updated_at)
             VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM records), ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               data = excluded.data,
               field_ts = excluded.field_ts,
               seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM records),
               updated_by = excluded.updated_by,
               updated_at = excluded.updated_at
             WHERE records.seq = ?`,
          )
          .bind(p.id, p.collection, JSON.stringify(p.data), JSON.stringify(p.field_ts), userId, now, p.baseSeq),
      );
      const results = await db.batch(stmts);
      results.forEach((r, j) => {
        if (!r.success || (r.meta.changes ?? 0) === 0) failed.push(chunk[j]);
      });
    }
    if (failed.length === 0) {
      todo = [];
      break;
    }
    attempt++;
    // Concurrent writer touched these rows: re-read, re-merge, retry.
    const fresh = await readRows(db, failed.map((p) => p.id));
    todo = [];
    for (const p of failed) {
      const row = fresh.get(p.id);
      if (row && row.collection !== p.collection) continue;
      applyPatches(p, row ?? null);
      if (p.changed) todo.push(p);
    }
  }

  return { rejected, changed: plans.size, conflict: todo.length > 0 };
}

/** Wake live clients so they pull immediately (best-effort). */
export function pokeLive(env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): void {
  try {
    const stub = env.LIVE.get(env.LIVE.idFromName('workspace'));
    ctx.waitUntil(Promise.resolve((stub as unknown as { poke(): void }).poke()));
  } catch {
    /* presence is best-effort */
  }
}

export const sync = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
sync.use('*', requireAuth);

sync.post('/push', async (c) => {
  const body = await c.req.json<{ changes?: unknown }>().catch(() => null);
  if (!body || !Array.isArray(body.changes)) return c.json({ error: 'invalid body' }, 400);
  if (body.changes.length > MAX_CHANGES) return c.json({ error: `max ${MAX_CHANGES} changes per request` }, 400);

  const user = c.get('user');
  const result = await applyChanges(c.env, user.id, body.changes);
  if (result.conflict) return c.json({ error: 'conflict, retry' }, 409);

  pokeLive(c.env, c.executionCtx);

  return c.json({ ok: true, serverTime: Date.now(), rejected: result.rejected });
});

sync.get('/pull', async (c) => {
  const since = Number(c.req.query('since') ?? '0');
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? '500') || 500, 1), 500);
  const { results } = await c.env.DB
    .prepare('SELECT id, collection, data, field_ts, seq FROM records WHERE seq > ? ORDER BY seq LIMIT ?')
    .bind(Number.isFinite(since) ? since : 0, limit + 1)
    .all<RecordRow>();
  const hasMore = results.length > limit;
  const page = hasMore ? results.slice(0, limit) : results;
  const records = page.map((r) => ({
    id: r.id,
    collection: r.collection,
    data: JSON.parse(r.data) as Record<string, unknown>,
    field_ts: JSON.parse(r.field_ts) as Record<string, number>,
    seq: r.seq,
  }));
  return c.json({ records, cursor: page.length ? page[page.length - 1].seq : since, hasMore });
});
