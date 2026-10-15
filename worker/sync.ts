import { Hono } from 'hono';
import { isCollection } from '../shared/collections';
import type { Mutation } from '../shared/types';
import { mergeRecord } from './merge';
import { requireAuth } from './auth';
import type { Env, AuthUser } from './auth';
import { stageAppliedEvent, scheduleOutbox, type EventSource } from './events';
import { guardStageWrites } from './approvals';
import type { SemanticEvent } from '../shared/events';
import type { ChangesetCtx } from './changesets';
import {D1BudgetExhausted} from './d1budget';
import { AccessError } from './access';
import { authorizeMutations, writeAuthorityFences, type WriteAuthority } from './mutationAccess';
import { readAuthorizedRecords, RecordAccessError } from './recordAccess';
import { loadAccessState, pullAuthorized, syncFailure, validateSyncProtocol } from './syncAccess';
import { snapshotsApi } from './syncSnapshot';
import { MAX_FUTURE_SKEW_MS, healTimestamps } from '../shared/clock';

const MAX_CHANGES = 500;
const MAX_ID_LEN = 64;
const MAX_ATTEMPTS = 3;
// Drift bound for client timestamps lives in shared/clock.ts (also enforced
// client-side in hlc.observe); re-exported for callers and tests.
export { MAX_FUTURE_SKEW_MS };

/**
 * Largest serialized `data` a write may produce. D1 rejects any string/row of
 * 2,000,000 bytes or more; a write that large aborts its whole batch, so the
 * limit is enforced per item with headroom for `field_ts` and row metadata.
 */
export const MAX_RECORD_BYTES = 1_000_000;
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

function rowsStatement(db: D1Database, ids: string[]): D1PreparedStatement {
  // One binding call for the whole id set. A 100-parameter chunk made a
  // 150-row write spend its budget on reads and commit nothing.
  // At most 100 placeholders keeps the fake D1 fixtures and D1's parameter cap.
  if (ids.length > 100 || !ids.length) {
    return db
      .prepare(`SELECT id, collection, data, field_ts, seq, updated_by, updated_at FROM records WHERE id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(ids));
  }
  return db
    .prepare(`SELECT id, collection, data, field_ts, seq, updated_by, updated_at FROM records WHERE id IN (${ids.map(() => '?').join(',')})`)
    .bind(...ids);
}
async function readRows(db: D1Database, ids: string[]): Promise<Map<string, RecordRow>> {
  if (!ids.length) return new Map();
  const { results } = await rowsStatement(db, ids).all<RecordRow>();
  return new Map(results.map(row => [row.id, row]));
}
async function readWriteSnapshot(db: D1Database, ids: string[]) {
  const [records, stateResult] = await db.batch([
    rowsStatement(db, ids), db.prepare('SELECT generation,enabled FROM access_state WHERE id=1'),
  ]);
  const state = stateResult.results[0] as { generation: number; enabled: number } | undefined;
  if (!state || !Number.isSafeInteger(state.generation) || state.generation < 1 || ![0, 1].includes(state.enabled)) throw new AccessError('permission_schema_unavailable');
  return { existing: new Map((records.results as unknown as RecordRow[]).map(row => [row.id, row])), ...state };
}

function applyPatches(plan: Plan, existing: RecordRow | null, now = Date.now()): void {
  const prev = existing
    ? {
        data: JSON.parse(existing.data) as Record<string, unknown>,
        field_ts: healTimestamps(JSON.parse(existing.field_ts) as Record<string, number>, now, existing.updated_at),
      }
    : null;
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

/**
 * A write that would leave a record over MAX_RECORD_BYTES is refused per item
 * (`record_too_large`) instead of aborting the D1 batch that carries it —
 * which, for a client push, would jam the whole offline outbox behind it. The
 * limit never traps existing data: small patches (flags, order, status) and
 * writes that do not grow the record always pass, so an oversized legacy row
 * can still be shrunk, archived or soft-deleted.
 */
const SMALL_PATCH_BYTES = 1024;
function exceedsRecordBudget(plan: Plan, existing: RecordRow | null): boolean {
  const json = JSON.stringify(plan.data);
  if (json.length * 3 <= MAX_RECORD_BYTES) return false;
  const encoder = new TextEncoder();
  const size = json.length > MAX_RECORD_BYTES ? json.length : encoder.encode(json).length;
  if (size <= MAX_RECORD_BYTES) return false;
  const patchBytes = plan.patches.reduce((n, p) => n + JSON.stringify(p.patch).length, 0);
  if (patchBytes <= SMALL_PATCH_BYTES) return false;
  return size > (existing ? encoder.encode(existing.data).length : 0);
}

export interface ApplyOptions {
  /** Set only by the sync router. Rechecked against the same authority snapshot
   * used to plan writes so a revocation after HTTP validation cannot slip in. */
  syncProtocol?: { protocol?: unknown; generation?: unknown };
  createOnly?:Set<string>;
  /** Persist audit items in the same transaction as the record and event. */
  journal?: ChangesetCtx;
  /** Durable execution fence/checkpoint, owned by a server-only operation. */
  execution?: { guard: () => D1PreparedStatement; checkpoint: (id: string) => D1PreparedStatement };
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
    ctx?: { waitUntil(p: Promise<unknown>): void };
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
  /** Complete committed state for event consumers; audit deltas remain sparse. */
  snapshot?: Record<string, unknown>;
}

export interface RejectedItem {
  id: string;
  collection: string;
  reason: string;
}

export interface ApplyResult {
  /** Earlier chunks may have committed; callers must not acknowledge success. */
  partialError?: string;
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

  if ((opts.expect?.size ?? 0) > MAX_EXPECTED) throw new Error(`at most ${MAX_EXPECTED} expected ids per call`);
  if (!incoming.length && !opts.expect?.size) return { rejected, rejectedItems, changed: 0, applied: [] };
  // One binding request still loads rows. The authority state is in the same
  // read transaction, not a cached flag or an optional caller-provided grant.
  // The same read serves restamping, authorization, the gate pre-check and the
  // merge plans.
  const snapshot = await readWriteSnapshot(db, [...new Set([...incoming.map(ch => ch.id), ...(opts.expect?.keys() ?? [])])]);
  if (opts.syncProtocol) validateSyncProtocol(snapshot, opts.syncProtocol.protocol, opts.syncProtocol.generation);
  const existing = snapshot.existing;
  // Timestamp discipline (audit XP-03). Stored timestamps beyond the drift
  // ceiling were written before it existed; they are healed to the row's last
  // server write time BEFORE anything reasons about them, so the authorizer, the
  // gate pre-check and the merge all see one ordering (a poisoned protected
  // field must not be "untouched" to the authorizer yet applied by the merge).
  const ceiling = now + MAX_FUTURE_SKEW_MS;
  for (const row of existing.values()) {
    try {
      const ts = JSON.parse(row.field_ts) as Record<string, number>;
      const healed = healTimestamps(ts, now, row.updated_at);
      if (healed !== ts) row.field_ts = JSON.stringify(healed);
    } catch {
      /* unparseable timestamps: the merge reports it the way it always did */
    }
  }
  if (opts.serverTs && incoming.length) {
    // Server-side writes win: stamp every field above the freshest stored
    // timestamp (healed above).
    const floors = new Map<string, number>();
    for (const [id, row] of existing) {
      try {
        const ts = healTimestamps(JSON.parse(row.field_ts) as Record<string, number>, now, row.updated_at);
        floors.set(id, Math.max(0, ...Object.values(ts)));
      } catch {
        floors.set(id, 0);
      }
    }
    incoming = restampForServer(incoming, floors, now);
  } else {
    // Client timestamps are untrusted: bound them so a wrong clock cannot win
    // every later merge on a field or advance every peer's HLC without limit.
    incoming = incoming.map((ch) => (ch.ts > ceiling ? { ...ch, ts: ceiling } : ch));
  }
  incoming=incoming.map(ch=>({...ch,patch:{...ch.patch}}));

  let authority: WriteAuthority | undefined;
  if (snapshot.enabled === 1) {
    try {
      const authorization = await authorizeMutations(db, userId, incoming, existing, opts.expect, snapshot.generation);
      authority = authorization.authority;
      for (const item of authorization.rejected) reject(item.id, item.collection, item.reason);
      incoming = authorization.changes;
      if (authorization.blockedExpectation || (rejected && (opts.atomic === true || (!!opts.expect?.size && opts.atomic !== false)))) return { rejected, rejectedItems, changed: 0, applied: [] };
    } catch (error) {
      if (!(error instanceof RecordAccessError)) throw error;
      for (const ch of incoming) reject(ch.id, ch.collection, error.code === 'access_reset_required' ? 'access_changed_retry' : 'authorization_budget');
      return { rejected, rejectedItems, changed: 0, applied: [] };
    }
  }

  // Phase 4 approval gates: entering a gated stage (by status or board) or
  // re-pinning its approver without a matching approved decision is refused
  // item-wise here — on EVERY pathway (client push, MCP, automation, undo).
  // The transactional guard in flushPlans is only the race backstop; this
  // pre-check mirrors its predicate so a policy refusal never aborts a batch.
  // `proposedBoards` carries board configuration introduced by this same write.
  const proposedBoards = new Map<string, { data: Record<string, unknown>; field_ts: Record<string, number> }>();
  for (const ch of incoming) if (ch.collection === 'boards') {
    const row = existing.get(ch.id);
    const initial = proposedBoards.get(ch.id) ?? (row?.collection === 'boards' ? { data: JSON.parse(row.data), field_ts: JSON.parse(row.field_ts) } : null);
    proposedBoards.set(ch.id, mergeRecord(initial, ch));
  }
  await guardStageWrites(env, incoming, reject, {
    existing, now,
    proposedBoards: new Map([...proposedBoards].map(([id, r]) => [id, r.data])),
  });

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
    applyPatches(plan, row ?? null, now);
    if (plan.changed && exceedsRecordBudget(plan, row ?? null)) {
      reject(plan.id, plan.collection, 'record_too_large');
      plans.delete(plan.id);
      continue;
    }
    if(row&&opts.createOnly?.has(plan.id)) plan.changed=false;
  }
  // Atomic server operations must not create half a logical operation after
  // a denied stage/config field. Client LWW pushes retain per-item rejection.
  if(opts.atomic===true && rejected) return {rejected,rejectedItems,changed:0,applied:[]};

  // expectedRev precheck (§4.2): fail fast, return current content.
  const expected = new Set(opts.expect?.keys() ?? []);
  if (opts.expect && expected.size > MAX_EXPECTED) throw new Error(`at most ${MAX_EXPECTED} expected ids per call`);
  if (opts.expect && expected.size) {
    const conflicts = checkExpectations(existing, opts.expect);
    if (authority && conflicts.length) await authorizedConflicts(db, userId, conflicts);
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
      const result = await flushPlans(env, userId, plans, expected, now, opts, authority);
      result.rejected += rejected + conflicts.length;
      if (rejectedItems.length) result.rejectedItems = [...rejectedItems, ...(result.rejectedItems ?? [])];
      result.conflicts = [...conflicts, ...(result.conflicts ?? [])];
      return result;
    }
  }

  const result = await flushPlans(env, userId, plans, expected, now, opts, authority);
  result.rejected += rejected;
  if (rejectedItems.length) result.rejectedItems = [...rejectedItems, ...(result.rejectedItems ?? [])];
  return result;
}

/** A conflict reply is a read. Recheck CURRENT access before returning content
 * or revision metadata after a race, especially after a relation/root move. */
async function authorizedConflicts(db: D1Database, userId: string, conflicts: ConflictInfo[]): Promise<void> {
  const { records } = await readAuthorizedRecords(db, userId, conflicts.map(c => c.id), { includeDeleted: true });
  for (const conflict of conflicts) {
    const current = records.get(conflict.id);
    conflict.current = current ? { ...current.data } : null;
    conflict.currentRev = current?.rev ?? null;
    conflict.updatedBy = null; conflict.updatedAt = null;
  }
}

/** Extract the fields that changed on a written row for change-set recording. */
function makeApplied(p: Plan, rev: number): AppliedChange {
  const fields = Object.keys(p.field_ts).filter((f) => p.beforeTs[f] !== p.field_ts[f] || p.beforeData[f] !== p.data[f]);
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const fieldTs: Record<string, number> = {};
  for (const f of fields) {
    before[f] = p.beforeData[f];
    after[f] = p.data[f];
    fieldTs[f] = p.field_ts[f];
  }
  return { id: p.id, collection: p.collection, created: Object.keys(p.beforeTs).length === 0 && !p.beforeData.id, fields, before, after, fieldTs, rev, snapshot: p.data };
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
async function flushPlans(env: Env, userId: string, plans: Map<string, Plan>, expected: Set<string>, now: number, opts: ApplyOptions, authority?: WriteAuthority): Promise<ApplyResult> {
  const db = env.DB;
  const conflicts: ConflictInfo[] = [];
  const applied: AppliedChange[] = [];
  const isAtomic = opts.atomic === true || (opts.atomic !== false && expected.size > 0);
  const eventIds: string[] = [];
  const refusedOnRetry: RejectedItem[] = [];
  const stmtFor = (p: Plan) => authority ? db.prepare(`INSERT INTO records(id,collection,data,field_ts,seq,updated_by,updated_at,space_id)
      VALUES(?,?,?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM records),?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data,field_ts=excluded.field_ts,
        seq=(SELECT COALESCE(MAX(seq),0)+1 FROM records),updated_by=excluded.updated_by,updated_at=excluded.updated_at,space_id=excluded.space_id
      WHERE records.seq=? RETURNING seq`)
      .bind(p.id,p.collection,JSON.stringify(p.data),JSON.stringify(p.field_ts),userId,now,authority.spaces.get(p.id)!,p.baseSeq) :
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
         WHERE records.seq = ? RETURNING seq`,
      )
      .bind(p.id, p.collection, JSON.stringify(p.data), JSON.stringify(p.field_ts), userId, now, p.baseSeq);

  const changedPlans=[...plans.values()].filter(p=>p.changed);
  let todo = [...changedPlans.filter(p=>expected.has(p.id)),...changedPlans.filter(p=>!expected.has(p.id))];
  let attempt = 0;
  while (todo.length > 0 && attempt < MAX_ATTEMPTS) {
    const failed: Plan[] = [];
    let size=100;
    for (let i = 0; i < todo.length; i += size) {
      size=opts.atomic===true?todo.length:(isAtomic && expected.has(todo[i].id)?todo.filter(p=>expected.has(p.id)).length:100);
      const chunk = todo.slice(i, i + size);
      const statements: D1PreparedStatement[] = [];
      if (authority) statements.push(...writeAuthorityFences(db, authority));
      if (opts.execution) statements.push(opts.execution.guard());
      const chunkAtomic=opts.atomic===true || (isAtomic&&chunk.some(p=>expected.has(p.id)));
      if (chunkAtomic) statements.push(expectationGuard(db, new Map(chunk.map(p => [p.id, p.baseSeq]))));
      if(opts.journal) {
        const cs=opts.journal;
        statements.push(db.prepare(`INSERT OR IGNORE INTO changesets
          (id,user_id,source,client_name,tool,summary,request_id,undoes,item_count,created_at)
          VALUES (?,?,?,?,?,?,?,?,0,?)`).bind(cs.id,cs.userId,cs.source,cs.clientName,cs.tool,cs.summary,cs.requestId,cs.undoes,now));
      }
      const indices: number[] = [];
      const staged: { id: string; plan: Plan }[] = [];
      for (const p of chunk) {
        if(p.collection==='tasks') statements.push(db.prepare(`SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM records b WHERE b.id=COALESCE(json_extract(?,'$.boardId'),'board-default') AND b.collection='boards'
          AND json_extract(b.data,'$.approvalGate.stageId')=json_extract(?,'$.status')
          AND (json_extract(?,'$.status') IS NOT json_extract(?,'$.status') OR json_extract(?,'$.boardId') IS NOT json_extract(?,'$.boardId')
            OR (json_extract(b.data,'$.approvalGate.approverField') IS NOT NULL
              AND json_extract(?,'$.p_'||json_extract(b.data,'$.approvalGate.approverField')) IS NOT json_extract(?,'$.p_'||json_extract(b.data,'$.approvalGate.approverField'))))
          AND NOT EXISTS(SELECT 1 FROM approvals a WHERE a.target_type='record' AND a.target_id=? AND a.status='approved'
            AND (a.stage_id=json_extract(b.data,'$.approvalGate.stageId') OR a.stage_id IS NULL)
            AND (json_extract(b.data,'$.approvalGate.approverField') IS NULL OR a.approver_id=json_extract(?,'$.p_'||json_extract(b.data,'$.approvalGate.approverField'))))
        ) THEN 1 ELSE json_extract('{','$') END`).bind(JSON.stringify(p.data),JSON.stringify(p.data),JSON.stringify(p.data),JSON.stringify(p.beforeData),JSON.stringify(p.data),JSON.stringify(p.beforeData),JSON.stringify(p.data),JSON.stringify(p.beforeData),p.id,JSON.stringify(p.data)));
        indices.push(statements.length);
        statements.push(stmtFor(p));
        const item = makeApplied(p, p.baseSeq);
        if (opts.event) {
          const event = stageAppliedEvent(db, {
            source: opts.event.source, userId, applied: [item],
            changesetId: opts.event.changesetId ?? opts.journal?.id,
            extra: opts.event.extra?.filter(e => e.recordId === p.id),
          }, now);
          staged.push({ id: event.id, plan: p });
          statements.push(event.statement);
        }
        if (opts.journal && p.collection !== 'activity') {
          const cs = opts.journal;
          statements.push(db.prepare(`INSERT INTO changeset_items
            (changeset_id,idx,collection,record_id,created,before,after,field_ts)
            SELECT ?, (SELECT COALESCE(MAX(idx),-1)+1 FROM changeset_items WHERE changeset_id=?), ?,?,?,?,?,?
            WHERE changes()=1
            AND NOT EXISTS (SELECT 1 FROM changeset_items WHERE changeset_id=? AND record_id=? AND field_ts=?)`)
            .bind(cs.id,cs.id,item.collection,item.id,item.created?1:0,JSON.stringify(item.before),JSON.stringify(item.after),JSON.stringify(item.fieldTs),cs.id,p.id,JSON.stringify(item.fieldTs)));
        }
        if (opts.execution) statements.push(opts.execution.checkpoint(p.id));
      }
      if (opts.journal) statements.push(db.prepare(`UPDATE changesets SET item_count=(SELECT COUNT(*) FROM changeset_items WHERE changeset_id=?) WHERE id=?`).bind(opts.journal.id, opts.journal.id));
      let results: D1Result<Record<string, unknown>>[];
      try {
        results = await db.batch(statements);
      } catch (err) {
        if (authority && err instanceof Error && /malformed JSON/i.test(err.message)) {
          // No protected state in this batch committed. Return a retryable
          // failure without hydrating unrestricted records. Earlier chunks
          // remain truthfully listed in applied and their journals/outboxes.
          if (opts.event && eventIds.length) scheduleOutbox(env, opts.event.ctx, eventIds);
          return { rejected: 0, changed: applied.length, applied, partialError: 'access or dependency changed; reauthorize and retry' };
        }
        if (chunkAtomic && err instanceof Error && /malformed JSON/i.test(err.message) && !opts.execution) {
          const fresh = await readRows(db, chunk.map(p=>p.id));
          for (const p of chunk) conflicts.push({id:p.id,collection:p.collection,expectedRev:opts.expect?.get(p.id)??p.baseSeq,currentRev:null,current:null,updatedBy:null,updatedAt:null});
          hydrateConflicts(conflicts, fresh);
          return {rejected:chunk.length,changed:applied.length,applied,conflicts};
        }
        if(chunkAtomic && opts.execution && err instanceof Error && /malformed JSON/i.test(err.message)) {
          const fresh=await readRows(db,chunk.map(p=>p.id));
          const raced=chunk.filter(p=>(fresh.get(p.id)?.seq??-1)!==p.baseSeq);
          if(raced.length) {
            for(const p of raced) conflicts.push({id:p.id,collection:p.collection,expectedRev:opts.expect?.get(p.id)??p.baseSeq,currentRev:null,current:null,updatedBy:null,updatedAt:null});
            hydrateConflicts(conflicts,fresh);
            return {rejected:conflicts.length,changed:applied.length,applied,conflicts};
          }
        }
        // A lost commit acknowledgement is ambiguous. Recover the exact
        // committed deltas from durable events before reporting failure.
        for (const s of err instanceof D1BudgetExhausted?[]:staged) {
          const row = await db.prepare('SELECT payload FROM event_outbox WHERE id=?').bind(s.id).first<{payload:string}>().catch(()=>null);
          if (row) { applied.push(...(JSON.parse(row.payload).applied as AppliedChange[])); eventIds.push(s.id); }
        }
        if (opts.event && eventIds.length) scheduleOutbox(env, opts.event.ctx, eventIds);
        return {rejected:0,changed:applied.length,applied,partialError:err instanceof Error?err.message:String(err)};
      }
      for (let j=0;j<chunk.length;j++) {
        const p=chunk[j], r=results[indices[j]];
        if (!r.success || (r.meta.changes??0)===0) {
          if (expected.has(p.id)) conflicts.push({id:p.id,collection:p.collection,expectedRev:opts.expect?.get(p.id)??p.baseSeq,currentRev:null,current:null,updatedBy:null,updatedAt:null});
          else failed.push(p);
          continue;
        }
        const rev = Number(r.results?.[0]?.seq ?? (await readRows(db,[p.id])).get(p.id)?.seq ?? 0);
        applied.push(makeApplied(p,rev));
        authority?.dependencies.set(p.id, rev);
        const event=staged.find(s=>s.plan===p); if(event) eventIds.push(event.id);
      }
      if(chunkAtomic&&conflicts.length) {
        if (authority) await authorizedConflicts(db,userId,conflicts);
        else hydrateConflicts(conflicts,await readRows(db,conflicts.map(c=>c.id)));
        if(opts.event&&eventIds.length) scheduleOutbox(env,opts.event.ctx,eventIds);
        return {rejected:conflicts.length+todo.length-i-chunk.length,changed:applied.length,applied,conflicts};
      }
    }
    if (failed.length === 0) {
      todo = [];
      break;
    }
    if (authority) return { rejected: 0, changed: applied.length, applied, partialError: 'record changed; reauthorize and retry' };
    attempt++;
    // Concurrent writer touched these rows: re-read, re-merge, retry.
    const fresh = await readRows(db, failed.map((p) => p.id));
    todo = [];
    for (const p of failed) {
      const row = fresh.get(p.id);
      if (row && row.collection !== p.collection) { conflicts.push({id:p.id,collection:p.collection,expectedRev:p.baseSeq,currentRev:row.seq,current:null,updatedBy:row.updated_by,updatedAt:row.updated_at}); continue; }
      applyPatches(p, row ?? null);
      if (p.changed && exceedsRecordBudget(p, row ?? null)) { refusedOnRetry.push({ id: p.id, collection: p.collection, reason: 'record_too_large' }); continue; }
      if(row&&opts.createOnly?.has(p.id)) p.changed=false;
      if (p.changed) todo.push(p);
    }
  }

  if (conflicts.length) {
    if (authority) await authorizedConflicts(db,userId,conflicts);
    else hydrateConflicts(conflicts, await readRows(db, conflicts.map(c=>c.id)));
  }
  if (opts.event && eventIds.length) scheduleOutbox(env, opts.event.ctx, eventIds);
  return { rejected: refusedOnRetry.length, ...(refusedOnRetry.length ? { rejectedItems: refusedOnRetry } : {}), changed: applied.length, conflict: todo.length > 0, conflicts: conflicts.length ? conflicts : undefined, applied };
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
sync.onError((error, c) => {
  const result = syncFailure(error);
  if (result) return c.json({ error: result.error }, result.status);
  throw error;
});
sync.route('/snapshot', snapshotsApi);

sync.post('/push', async (c) => {
  const body = await c.req.json<{ changes?: unknown; protocol?: unknown; generation?: unknown }>().catch(() => null);
  if (!body || !Array.isArray(body.changes)) return c.json({ error: 'invalid body' }, 400);
  if (body.changes.length > MAX_CHANGES) return c.json({ error: `max ${MAX_CHANGES} changes per request` }, 400);
  const state = await loadAccessState(c.env.DB);
  validateSyncProtocol(state, body.protocol, body.generation);

  const user = c.get('user');
  const result = await applyChanges(c.env, user.id, body.changes, {
    event: { source: 'client', ctx: c.executionCtx },
    syncProtocol: { protocol: body.protocol, generation: body.generation },
  });
  if (result.partialError) return c.json({ error: 'write interrupted; retry', committed: result.applied.map(a=>a.id) }, 503);
  if (result.conflict) return c.json({ error: 'conflict, retry' }, 409);

  pokeLive(c.env, c.executionCtx);

  return c.json({ ok: true, serverTime: Date.now(), rejected: result.rejected, rejectedItems: result.rejectedItems ?? [] });
});

sync.get('/pull', async (c) => {
  const state = await loadAccessState(c.env.DB);
  validateSyncProtocol(state, c.req.query('protocol'), c.req.query('generation'));
  const since = Number(c.req.query('since') ?? '0');
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? '500') || 500, 1), 500);
  if (state.enabled) return c.json(await pullAuthorized(c.env.DB, c.get('user').id, state, since, limit));
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
