/* Targeted reads for the MCP surface (Phase 0 §3). Every read carries
 * `rev` (records.seq) so AI callers can issue expectedRev writes. */

import { applyChanges, type AppliedChange, type ApplyResult } from './sync';
import type { Env } from './auth';
import type { ChangesetCtx } from './changesets';
import { gateRows } from './readAccess';
import { levelSql } from './capability';

export interface RecRow {
  id: string;
  collection: string;
  data: Record<string, unknown>;
  fieldTs: Record<string, number>;
  rev: number;
  updatedBy: string | null;
  updatedAt: number | null;
}

export interface RawRow {
  id: string;
  collection: string;
  data: string;
  field_ts: string;
  seq: number;
  updated_by: string | null;
  updated_at: number | null;
}

export function toRow(r: RawRow): RecRow {
  return { id: r.id, collection: r.collection, data: JSON.parse(r.data) as Record<string, unknown>, fieldTs: JSON.parse(r.field_ts) as Record<string, number>, rev: r.seq, updatedBy: r.updated_by, updatedAt: r.updated_at };
}

export const SELECT = 'id, collection, data, field_ts, seq, updated_by, updated_at';

/* Every helper below applies the request's read gate when the environment carries one
 * (user-visible reads: MCP, member routes). Service callers pass the plain environment. */

export async function getRec(env: Env, id: string): Promise<RecRow | null> {
  const row = await env.DB.prepare(`SELECT ${SELECT} FROM records WHERE id = ?`).bind(id).first<RawRow>();
  const current=row ? (await gateRows(env,[toRow(row)]))[0]??null:null;
  const planned=env.MCP_PLAN?.ops.filter(o=>o.id===id)??[];
  if(!planned.length)return current;
  return {...(current??{id,collection:planned[0].collection,fieldTs:{},rev:-1,updatedBy:null,updatedAt:null}),data:Object.assign({},current?.data,...planned.map(o=>o.patch))};
}

export async function getRecs(env: Env, ids: string[]): Promise<Map<string, RecRow>> {
  const out = new Map<string, RecRow>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    if (!chunk.length) continue;
    const { results } = await env.DB.prepare(`SELECT ${SELECT} FROM records WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all<RawRow>();
    for (const r of results) out.set(r.id, toRow(r));
  }
  if (!env.READ_GATE) return out;
  return new Map((await gateRows(env, [...out.values()])).map((row) => [row.id, row]));
}

const JSON_FIELD_RE = /^[A-Za-z0-9_]+$/;

/** Live-rows-only read via the per-field expression indexes (§3, §11). */
export async function listBy(env: Env, collection: string, jsonField: string, value: unknown, opts: { includeDeleted?: boolean } = {}): Promise<RecRow[]> {
  if (!JSON_FIELD_RE.test(jsonField)) throw new Error('bad field');
  let sql = `SELECT ${SELECT} FROM records WHERE collection = ? AND json_extract(data, '$.${jsonField}') = ?`;
  if (!opts.includeDeleted) sql += ` AND COALESCE(json_extract(data, '$.deleted'), 0) != 1`;
  const { results } = await env.DB.prepare(sql).bind(collection, value as string | number).all<RawRow>();
  return gateRows(env, results.map(toRow));
}

/** WHERE data.boardId IS NULL (boardless default board) — json_extract returns NULL for absent keys. */
export async function listDefaultBoardTasks(env: Env): Promise<RecRow[]> {
  const { results } = await env.DB
    .prepare(`SELECT ${SELECT} FROM records WHERE collection = 'tasks' AND json_extract(data, '$.boardId') IS NULL AND COALESCE(json_extract(data, '$.deleted'), 0) != 1`)
    .all<RawRow>();
  return gateRows(env, results.map(toRow));
}

/** Default row ceiling of whole-collection reads. */
export const COLLECTION_READ_LIMIT = 5000;

/**
 * Whole-collection read, capped at `limit` rows (default 5,000, no stable
 * order). Callers that need EXACT answers must not use it — use a targeted
 * read (`listBy`, `listLinksByKind`, a recursive closure). A capped read is
 * never silent: it logs a structured `collection_read_truncated` warning with
 * the collection and ceiling, so the condition is observable in Worker logs
 * instead of surfacing as wrong results.
 */
export async function listCollection(env: Env, collection: string, opts: { includeDeleted?: boolean; limit?: number } = {}): Promise<RecRow[]> {
  const limit = opts.limit ?? COLLECTION_READ_LIMIT;
  // A gated whole-collection read first narrows to the caller's readable spaces in SQL
  // (records.space_id is only a prefilter; the gate below still decides every row).
  const scoped = env.READ_GATE ? await env.READ_GATE.enabled() : false;
  let sql = `SELECT ${SELECT} FROM records WHERE collection = ?`;
  if (!opts.includeDeleted) sql += ` AND COALESCE(json_extract(data, '$.deleted'), 0) != 1`;
  if (scoped) sql += ` AND space_id IN (SELECT s.id FROM spaces s WHERE ${levelSql('?', 's.id')} >= 1)`;
  sql += ' LIMIT ?';
  const { results } = await env.DB.prepare(sql).bind(...(scoped ? [collection, env.READ_GATE!.userId, limit + 1] : [collection, limit + 1])).all<RawRow>();
  if (results.length > limit) {
    console.warn(JSON.stringify({ message: 'collection_read_truncated', collection, limit }));
    return gateRows(env, results.slice(0, limit).map(toRow));
  }
  return gateRows(env, results.map(toRow));
}

/**
 * Every live link of one kind ('blocks' dependencies, 'relation', 'related'),
 * exact and uncapped. Dependency-cycle checks and relation reads must see ALL
 * edges of their kind: a whole-collection read silently drops rows past its
 * ceiling, and a dropped edge defeats cycle detection (a Phase 1 invariant).
 */
export async function listLinksByKind(env: Env, kind: 'blocks' | 'relation' | 'related'): Promise<RecRow[]> {
  const { results } = await env.DB
    .prepare(`SELECT ${SELECT} FROM records WHERE collection = 'links' AND json_extract(data, '$.kind') = ? AND COALESCE(json_extract(data, '$.deleted'), 0) != 1`)
    .bind(kind)
    .all<RawRow>();
  return gateRows(env, results.map(toRow));
}

/** Links touching one record, via the fromId/toId expression indexes. */
export async function listLinksTouching(env: Env, id: string): Promise<RecRow[]> {
  const [from, to] = await env.DB.batch<RawRow>([
    env.DB.prepare(`SELECT ${SELECT} FROM records WHERE collection = 'links' AND json_extract(data, '$.fromId') = ? AND COALESCE(json_extract(data, '$.deleted'), 0) != 1`).bind(id),
    env.DB.prepare(`SELECT ${SELECT} FROM records WHERE collection = 'links' AND json_extract(data, '$.toId') = ? AND COALESCE(json_extract(data, '$.deleted'), 0) != 1`).bind(id),
  ]);
  const seen = new Set<string>();
  return gateRows(env, [...from.results, ...to.results].filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true))).map(toRow));
}

/**
 * CAS read-modify-write (§6): read row, run `mutate` on its data, write the
 * patch guarded by the rev we read. On conflict, re-read and retry — up to
 * 5 attempts. `mutate` returns a patch or null to abort without writing.
 */
export async function casUpdate(
  env: Env,
  userId: string,
  collection: string,
  id: string,
  mutate: (data: Record<string, unknown>, rev: number) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>,
  opts: {
    attempts?: number;
    recordTo?: AppliedChange[];
    journal?:ChangesetCtx;
    /** Phase 4: emit semantic events for applied changes (MCP/automation callers). */
    ectx?: { waitUntil(p: Promise<unknown>): void };
    source?: 'mcp' | 'automation';
  } = {},
): Promise<{ row: RecRow; result: ApplyResult } | { conflict: true } | { notFound: true }> {
  const attempts = opts.attempts ?? 5;
  for (let i = 0; i < attempts; i++) {
    const row = await getRec(env, id);
    if (!row || row.collection !== collection || row.data.deleted === true) return { notFound: true };
    const patch = await mutate(row.data, row.rev);
    if (patch === null) return { row, result: { rejected: 0, changed: 0, applied: [] } };
    const result = await applyChanges(env, userId, [{ id, collection, patch, ts: Date.now() }], {
      serverTs: true,
      expect: new Map([[id, row.rev]]),
      journal:opts.journal,
      event: { source: opts.source ?? 'mcp',ctx:opts.ectx,changesetId:opts.journal?.id },
    });
    if(result.partialError) throw new Error('write interrupted; retry');
    if(result.rejectedItems?.length) throw new Error(result.rejectedItems.map(r=>r.reason).join('; '));
    if (!result.conflicts?.length) {
      // Record landed writes into the caller's change set synchronously — no
      // write can be stranded by a later failure in the tool call (§4.2).
      if (opts.recordTo) opts.recordTo.push(...result.applied.filter((x) => x.collection !== 'activity'));
      return { row, result };
    }
  }
  return { conflict: true };
}

/** Live links touching any of `ids` (optionally one kind), in one binding call — the
 * targeted alternative to a whole-kind scan for per-record reads. Gated like the rest. */
export async function listLinksFor(env: Env, ids: string[], kind?: 'blocks' | 'relation' | 'related'): Promise<RecRow[]> {
  if (!ids.length) return [];
  const { results } = await env.DB.prepare(`SELECT ${SELECT} FROM records WHERE collection = 'links'
      AND (json_extract(data, '$.fromId') IN (SELECT value FROM json_each(?)) OR json_extract(data, '$.toId') IN (SELECT value FROM json_each(?)))
      AND COALESCE(json_extract(data, '$.deleted'), 0) != 1${kind ? " AND json_extract(data, '$.kind') = ?" : ''}`)
    .bind(...[JSON.stringify(ids), JSON.stringify(ids), ...(kind ? [kind] : [])]).all<RawRow>();
  return gateRows(env, results.map(toRow));
}

/** Live root pages (no parent), for sibling ordering and root title lookups. */
export async function listRootPages(env: Env): Promise<RecRow[]> {
  const { results } = await env.DB.prepare(`SELECT ${SELECT} FROM records WHERE collection = 'pages'
      AND (json_extract(data, '$.parentId') IS NULL OR json_extract(data, '$.parentId') = '') AND COALESCE(json_extract(data, '$.deleted'), 0) != 1`).all<RawRow>();
  return gateRows(env, results.map(toRow));
}

export interface ScanKey { o: string; id: string }
export interface ScanPage { rows: RecRow[]; next: ScanKey | null }

/**
 * One page of a collection (or of one database's records) in a total order — (order key as
 * text, id), or id alone — with the request's gate applied window by window. The returned
 * `next` is the last SCANNED key, so a page shortened by the gate or by `keep` never skips
 * or repeats rows. At most `maxScan` rows are examined per call; `next` is non-null whenever
 * rows may remain (the caller reports that explicitly, never as "no more").
 */
export async function scanCollection(env: Env, collection: string, opts: {
  limit: number; after?: ScanKey | null; by?: 'order' | 'id'; boardId?: string; maxScan?: number;
  keep?: (rows: RecRow[]) => RecRow[] | Promise<RecRow[]>;
}): Promise<ScanPage> {
  const by = opts.by ?? 'order', maxScan = opts.maxScan ?? 2000, window = Math.min(500, Math.max(opts.limit * 2, 50));
  const scoped = env.READ_GATE ? await env.READ_GATE.enabled() : false;
  const key = by === 'order' ? "COALESCE(CAST(json_extract(data,'$.order') AS TEXT),'')" : "''";
  const out: RecRow[] = [];
  let after = opts.after ?? null, scanned = 0;
  while (out.length < opts.limit && scanned < maxScan) {
    let sql = `SELECT ${SELECT}, ${key} AS scan_key FROM records WHERE collection = ? AND COALESCE(json_extract(data, '$.deleted'), 0) != 1`;
    const binds: unknown[] = [collection];
    if (opts.boardId !== undefined) {
      sql += opts.boardId === 'board-default' ? ` AND (json_extract(data,'$.boardId') = ? OR json_extract(data,'$.boardId') IS NULL)` : ` AND json_extract(data,'$.boardId') = ?`;
      binds.push(opts.boardId);
    }
    if (scoped) { sql += ` AND space_id IN (SELECT s.id FROM spaces s WHERE ${levelSql('?', 's.id')} >= 1)`; binds.push(env.READ_GATE!.userId); }
    if (after) { sql += ` AND (${key} > ? OR (${key} = ? AND id > ?))`; binds.push(after.o, after.o, after.id); }
    sql += ` ORDER BY ${key}, id LIMIT ?`; binds.push(window);
    const { results } = await env.DB.prepare(sql).bind(...binds).all<RawRow & { scan_key: string }>();
    if (!results.length) return { rows: out, next: null };
    scanned += results.length;
    const rows = results.map(toRow);
    let kept = await gateRows(env, rows);
    if (opts.keep) kept = await opts.keep(kept);
    const keptIds = new Set(kept.map((r) => r.id));
    for (let i = 0; i < rows.length; i++) {
      after = { o: results[i].scan_key, id: results[i].id };
      if (keptIds.has(rows[i].id)) out.push(kept.find((r) => r.id === rows[i].id)!);
      if (out.length === opts.limit) return { rows: out, next: i < rows.length - 1 || results.length === window ? after : null };
    }
    if (results.length < window) return { rows: out, next: null };
  }
  return { rows: out, next: after };
}
