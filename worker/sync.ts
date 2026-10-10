import { Hono } from 'hono';
import { isCollection } from '../shared/collections';
import type { Mutation } from '../shared/types';
import { mergeRecord } from './merge';
import { requireAuth } from './auth';
import type { Env, AuthUser } from './auth';
import { emitChanges, type EventSource } from './events';
import { guardStageWrites } from './approvals';
import type { SemanticEvent } from '../shared/events';

const MAX_CHANGES = 500;
const MAX_ID_LEN = 64;
const MAX_ATTEMPTS = 3;
/** expectedRev ids must fit in ONE atomic batch. */
export const MAX_EXPECTED = 100;

interface RecordRow {
  id: string;
  collection: string;
  data: string;
  field_ts: string;
  seq: number;
  updated_by: string | null;
  updated_at: number | null;
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
  /** Touched-field values/timestamps before this call's merge (for change sets). */
  beforeData: Record<string, unknown>;
  beforeTs: Record<string, number>;
}

async function readRows(db: D1Database, ids: string[]): Promise<Map<string, RecordRow>> {
  const out = new Map<string, RecordRow>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { results } = await db
      .prepare(`SELECT id, collection, data, field_ts, seq, updated_by, updated_at FROM records WHERE id IN (${chunk.map(() => '?').join(',')})`)
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
  plan.beforeData = prev?.data ?? {};
  plan.beforeTs = prev?.field_ts ?? {};
}

export interface ApplyOptions {
  /**
   * MCP/server-side writes: stamp every field with max(now, existingTs+1) so an
   * AI edit wins against older client values — same as a fresh client write
   * being the newest. When unset the caller's `ts` is used verbatim (push).
   */
  serverTs?: boolean;
  /** id → rev the caller read. Mismatch ⇒ conflict, nothing written for that id. */
  expect?: Map<string, number>;
  /** all-or-nothing: if any expectation fails, write nothing (default true when expect is set). */
  atomic?: boolean;
  /**
   * Phase 4 event emission: when set, successfully applied changes are staged
   * in event_outbox and processed (notifications/automations/date_index).
   * Every write pathway that should produce semantic events passes this.
   */
  event?: {
    source: EventSource;
    ctx: { waitUntil(p: Promise<unknown>): void };
    changesetId?: string;
    /** Synthetic events appended post-derivation (e.g. form.submitted). */
    extra?: SemanticEvent[];
  };
}

export interface ConflictInfo {
  id: string;
  collection: string;
  expectedRev: number;
  currentRev: number | null;
  current: Record<string, unknown> | null;
  updatedBy: string | null;
  updatedAt: number | null;
}

export interface AppliedChange {
  id: string;
  collection: string;
  created: boolean;
  fields: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  fieldTs: Record<string, number>;
  rev: number;
}

export interface RejectedItem {
  id: string;
  collection: string;
  reason: string;
}

export interface ApplyResult {
  rejected: number;
  changed: number;
  /** Per-item disposition for rejected changes — clients keep these locally
   * instead of treating an HTTP 200 as universal success (review B5). */
  rejectedItems?: RejectedItem[];
  /** Filled on hard conflict after retries — caller turns it into a 409. */
  conflict?: boolean;
  /** expectedRev mismatches — nothing written for those ids. */
  conflicts?: ConflictInfo[];
  /** What actually changed (touched fields only) — feeds change sets. */
  applied: AppliedChange[];
}

/**
 * Pure expectation check, extracted for tests: id → expected seq vs the rows
 * read this call. Missing row or seq mismatch → ConflictInfo with current data.
 */
export function checkExpectations(rows: Map<string, { id: string; collection: string; seq: number; data: string; updated_by: string | null; updated_at: number | null }>, expect: Map<string, number>): ConflictInfo[] {
  const conflicts: ConflictInfo[] = [];
  for (const [id, expectedRev] of expect) {
    const row = rows.get(id);
    if (!row || row.seq !== expectedRev) {
      conflicts.push({
        id,
        collection: row?.collection ?? '',
        expectedRev,
        currentRev: row?.seq ?? null,
        current: row ? (JSON.parse(row.data) as Record<string, unknown>) : null,
        updatedBy: row?.updated_by ?? null,
        updatedAt: row?.updated_at ?? null,
      });
    }
  }
  return conflicts;
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

/**
 * Merge + upsert core shared by /api/sync/push and the MCP write tools.
 * Invalid changes are skipped (counted in `rejected`); concurrent updates are
 * re-read, re-merged and retried up to MAX_ATTEMPTS.
 *
 * With `opts.expect`, ids whose stored seq differs from the expected rev are
 * reported as conflicts and never written — the per-statement
 * `WHERE records.seq = ?` guard is the correctness invariant; the precheck
 * only fails fast and returns current content. `atomic !== false` writes all
 * expected ids in ONE db.batch() so they land or fail together.
 */
export async function applyChanges(env: Env, userId: string, changes: unknown[], opts: ApplyOptions = {}): Promise<ApplyResult> {
  const db = env.DB;
  const now = Date.now();

  let rejected = 0;
  const rejectedItems: RejectedItem[] = [];
  const reject = (id: unknown, collection: unknown, reason: string) => {
    rejected++;
    rejectedItems.push({ id: typeof id === 'string' ? id : '', collection: typeof collection === 'string' ? collection : '', reason });
  };
  let incoming = (changes as unknown[]).filter((ch): ch is Mutation => {
    if (!validChange(ch)) {
      reject((ch as { id?: unknown })?.id, (ch as { collection?: unknown })?.collection, 'invalid_mutation');
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

  // Phase 4 approval gates: a status write into a gated stage without a
  // matching approved decision is refused here — on EVERY pathway (client
  // push, MCP, automation, undo) — so generic sync can never bypass it.
  await guardStageWrites(env, incoming, reject);

  const plans = new Map<string, Plan>();
  for (const ch of incoming) {
    let plan = plans.get(ch.id);
    if (!plan) {
      plan = { id: ch.id, collection: ch.collection, patches: [], baseSeq: -1, data: {}, field_ts: {}, changed: false, beforeData: {}, beforeTs: {} };
      plans.set(ch.id, plan);
    }
    if (plan.collection !== ch.collection) {
      reject(ch.id, ch.collection, 'collection_mismatch');
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
      for (let i = 0; i < plan.patches.length; i++) reject(plan.id, plan.collection, 'collection_mismatch');
      plans.delete(plan.id);
      continue;
    }
    applyPatches(plan, row ?? null);
  }

  // expectedRev precheck (§4.2): fail fast, return current content.
  const expected = new Set(opts.expect?.keys() ?? []);
  if (opts.expect && expected.size > MAX_EXPECTED) throw new Error(`at most ${MAX_EXPECTED} expected ids per call`);
  if (opts.expect && expected.size) {
    const conflicts = checkExpectations(existing, opts.expect);
    if (conflicts.length && opts.atomic !== false) {
      return { rejected: rejected + expected.size, rejectedItems, changed: 0, conflicts, applied: [] };
    }
    // Pin expected ids to the caller's rev so a concurrent bump fails the
    // CAS instead of merging into a newer row.
    for (const plan of plans.values()) {
      if (expected.has(plan.id)) plan.baseSeq = opts.expect.get(plan.id)!;
    }
    if (conflicts.length) {
      // Non-atomic: drop the failed ids, write the rest.
      for (const c of conflicts) plans.delete(c.id);
      const result = await flushPlans(env, userId, plans, expected, now, opts.expect, opts.atomic);
      result.rejected += rejected;
      result.conflicts = conflicts;
      emitApplied(env, userId, result, opts);
      return result;
    }
  }

  const result = await flushPlans(env, userId, plans, expected, now, opts.expect, opts.atomic);
  result.rejected += rejected;
  if (rejectedItems.length) result.rejectedItems = [...rejectedItems, ...(result.rejectedItems ?? [])];
  emitApplied(env, userId, result, opts);
  return result;
}

/** Post-commit event emission — applied changes only, never intentions. */
function emitApplied(env: Env, userId: string, result: ApplyResult, opts: ApplyOptions): void {
  if (!opts.event || !result.applied.length) return;
  emitChanges(env, opts.event.ctx, {
    source: opts.event.source,
    userId,
    applied: result.applied,
    changesetId: opts.event.changesetId,
    extra: opts.event.extra,
  });
}

/** Extract the fields that changed on a written row for change-set recording. */
function makeApplied(p: Plan, row: RecordRow): AppliedChange {
  const fields = Object.keys(p.field_ts).filter((f) => p.beforeTs[f] !== p.field_ts[f] || p.beforeData[f] !== p.data[f]);
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const fieldTs: Record<string, number> = {};
  for (const f of fields) {
    before[f] = p.beforeData[f];
    after[f] = p.data[f];
    fieldTs[f] = p.field_ts[f];
  }
  return { id: p.id, collection: p.collection, created: Object.keys(p.beforeTs).length === 0 && !p.beforeData.id, fields, before, after, fieldTs, rev: row.seq };
}

function hydrateConflicts(conflicts: ConflictInfo[], fresh: Map<string, RecordRow>): void {
  for (const c of conflicts) {
    const row = fresh.get(c.id);
    c.currentRev = row?.seq ?? null;
    c.current = row ? (JSON.parse(row.data) as Record<string, unknown>) : null;
    c.updatedBy = row?.updated_by ?? null;
    c.updatedAt = row?.updated_at ?? null;
  }
}

/**
 * Poison-pill SELECT: returns 1 when every `id → expectedRev` pair in the
 * bound JSON map still matches `records.seq`; raises a malformed-JSON error
 * otherwise. Placed FIRST in the expected batch it makes the batch truly
 * all-or-nothing — a CAS miss inside a D1 batch is meta.changes=0, not an
 * error, so without this guard earlier statements would still commit.
 */
function expectationGuard(db: D1Database, expect: Map<string, number>): D1PreparedStatement {
  return db
    .prepare(
      `SELECT CASE WHEN (
         SELECT COUNT(*) FROM records r JOIN json_each(?) e ON r.id = e.key WHERE r.seq <> e.value
       ) = 0 THEN 1 ELSE json_extract('{', '$') END`,
    )
    .bind(JSON.stringify(Object.fromEntries(expect)));
}

/** Write the planned merges with seq CAS, retries and applied-change capture. */
async function flushPlans(env: Env, userId: string, plans: Map<string, Plan>, expected: Set<string>, now: number, expect?: Map<string, number>, atomic?: boolean): Promise<ApplyResult> {
  const db = env.DB;
  const conflicts: ConflictInfo[] = [];
  const applied: AppliedChange[] = [];
  const isAtomic = atomic !== false && expected.size > 0;

  // Expected ids go first and in a single batch (atomic group); the rest
  // follow in 100-statement chunks with the normal re-merge retry loop.
  const expectedPlans = [...plans.values()].filter((p) => p.changed && expected.has(p.id)).slice(0, MAX_EXPECTED);
  const freePlans = [...plans.values()].filter((p) => p.changed && !expected.has(p.id));

  const stmtFor = (p: Plan) =>
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
      .bind(p.id, p.collection, JSON.stringify(p.data), JSON.stringify(p.field_ts), userId, now, p.baseSeq);

  if (expectedPlans.length) {
    let results: D1Result<Record<string, unknown>>[] | null;
    if (isAtomic && expect) {
      try {
        // The guard verifies every expectation INSIDE the batch transaction;
        // a violation poisons the first statement and rolls the whole batch
        // back — nothing commits, expected or not.
        results = await db.batch([expectationGuard(db, expect), ...expectedPlans.map(stmtFor)]);
      } catch (e) {
        // The guard's poison pill is the only malformed-JSON error this batch
        // can produce — treat it as a raced expectation, rethrow the rest.
        if (!(e instanceof Error && /malformed JSON/i.test(e.message))) throw e;
        results = null;
      }
    } else {
      results = await db.batch(expectedPlans.map(stmtFor));
    }
    if (results === null) {
      // Guard aborted the batch: zero statements committed. Every expected
      // write is a conflict and ALL other writes are skipped (§4.2 atomic).
      const fresh = await readRows(db, expectedPlans.map((p) => p.id));
      for (const p of expectedPlans) {
        conflicts.push({ id: p.id, collection: p.collection, expectedRev: expect?.get(p.id) ?? p.baseSeq, currentRev: null, current: null, updatedBy: null, updatedAt: null });
      }
      hydrateConflicts(conflicts, fresh);
      return { rejected: expectedPlans.length + freePlans.length, changed: 0, conflicts, applied: [] };
    }
    const writeResults = isAtomic ? results.slice(1) : results;
    writeResults.forEach((r, j) => {
      const p = expectedPlans[j];
      if (!r.success || (r.meta.changes ?? 0) === 0) {
        // Expected-id CAS miss: record a conflict, NEVER re-merge (the row
        // changed since the caller's rev).
        conflicts.push({
          id: p.id,
          collection: p.collection,
          expectedRev: expect?.get(p.id) ?? p.baseSeq,
          currentRev: null,
          current: null,
          updatedBy: null,
          updatedAt: null,
        });
      }
    });
    if (conflicts.length) {
      // Hydrate the raced conflicts with current content for the response.
      hydrateConflicts(conflicts, await readRows(db, conflicts.map((c) => c.id)));
      if (isAtomic) {
        // All-or-nothing: skip every other write in this call. Anything that
        // already committed (only reachable via a defensive CAS miss after
        // the guard passed) is still reported faithfully in `applied`.
        const landed = expectedPlans.filter((p) => !conflicts.some((c) => c.id === p.id));
        const landedRows = landed.length ? await readRows(db, landed.map((p) => p.id)) : new Map<string, RecordRow>();
        for (const p of landed) {
          const row = landedRows.get(p.id);
          if (row) applied.push(makeApplied(p, row));
        }
        return { rejected: conflicts.length + freePlans.length, changed: 0, conflicts, applied };
      }
    }
  }

  let todo = freePlans;
  let attempt = 0;
  while (todo.length > 0 && attempt < MAX_ATTEMPTS) {
    const failed: Plan[] = [];
    for (let i = 0; i < todo.length; i += 100) {
      const chunk = todo.slice(i, i + 100);
      const results = await db.batch(chunk.map(stmtFor));
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

  // Fetch new revs for everything that landed (change-set recording).
  const written = [...plans.values()].filter((p) => p.changed && !conflicts.some((c) => c.id === p.id) && (expected.has(p.id) || !todo.includes(p)));
  const writtenRows = written.length ? await readRows(db, written.map((p) => p.id)) : new Map<string, RecordRow>();
  for (const p of written) {
    const row = writtenRows.get(p.id);
    if (!row) continue;
    const fields = Object.keys(p.field_ts).filter((f) => p.beforeTs[f] !== p.field_ts[f] || p.beforeData[f] !== p.data[f]);
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const fieldTs: Record<string, number> = {};
    for (const f of fields) {
      before[f] = p.beforeData[f];
      after[f] = p.data[f];
      fieldTs[f] = p.field_ts[f];
    }
    applied.push({ id: p.id, collection: p.collection, created: Object.keys(p.beforeTs).length === 0 && !p.beforeData.id, fields, before, after, fieldTs, rev: row.seq });
  }

  return { rejected: 0, changed: plans.size, conflict: todo.length > 0, conflicts: conflicts.length ? conflicts : undefined, applied };
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
  const result = await applyChanges(c.env, user.id, body.changes, {
    event: { source: 'client', ctx: c.executionCtx },
  });
  if (result.conflict) return c.json({ error: 'conflict, retry' }, 409);

  pokeLive(c.env, c.executionCtx);

  return c.json({ ok: true, serverTime: Date.now(), rejected: result.rejected, rejectedItems: result.rejectedItems ?? [] });
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
