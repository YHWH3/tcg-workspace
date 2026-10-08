/* Targeted reads for the MCP surface (Phase 0 §3). Every read carries
 * `rev` (records.seq) so AI callers can issue expectedRev writes. */

import { applyChanges, type ApplyResult } from './sync';
import type { Env } from './auth';

export interface RecRow {
  id: string;
  collection: string;
  data: Record<string, unknown>;
  fieldTs: Record<string, number>;
  rev: number;
  updatedBy: string | null;
  updatedAt: number | null;
}

interface RawRow {
  id: string;
  collection: string;
  data: string;
  field_ts: string;
  seq: number;
  updated_by: string | null;
  updated_at: number | null;
}

function toRow(r: RawRow): RecRow {
  return { id: r.id, collection: r.collection, data: JSON.parse(r.data) as Record<string, unknown>, fieldTs: JSON.parse(r.field_ts) as Record<string, number>, rev: r.seq, updatedBy: r.updated_by, updatedAt: r.updated_at };
}

const SELECT = 'id, collection, data, field_ts, seq, updated_by, updated_at';

export async function getRec(env: Env, id: string): Promise<RecRow | null> {
  const row = await env.DB.prepare(`SELECT ${SELECT} FROM records WHERE id = ?`).bind(id).first<RawRow>();
  return row ? toRow(row) : null;
}

export async function getRecs(env: Env, ids: string[]): Promise<Map<string, RecRow>> {
  const out = new Map<string, RecRow>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    if (!chunk.length) continue;
    const { results } = await env.DB.prepare(`SELECT ${SELECT} FROM records WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all<RawRow>();
    for (const r of results) out.set(r.id, toRow(r));
  }
  return out;
}

const JSON_FIELD_RE = /^[A-Za-z0-9_]+$/;

/** Live-rows-only read via the per-field expression indexes (§3, §11). */
export async function listBy(env: Env, collection: string, jsonField: string, value: unknown, opts: { includeDeleted?: boolean } = {}): Promise<RecRow[]> {
  if (!JSON_FIELD_RE.test(jsonField)) throw new Error('bad field');
  let sql = `SELECT ${SELECT} FROM records WHERE collection = ? AND json_extract(data, '$.${jsonField}') = ?`;
  if (!opts.includeDeleted) sql += ` AND COALESCE(json_extract(data, '$.deleted'), 0) != 1`;
  const { results } = await env.DB.prepare(sql).bind(collection, value as string | number).all<RawRow>();
  return results.map(toRow);
}

/** WHERE data.boardId IS NULL (boardless default board) — json_extract returns NULL for absent keys. */
export async function listDefaultBoardTasks(env: Env): Promise<RecRow[]> {
  const { results } = await env.DB
    .prepare(`SELECT ${SELECT} FROM records WHERE collection = 'tasks' AND json_extract(data, '$.boardId') IS NULL AND COALESCE(json_extract(data, '$.deleted'), 0) != 1`)
    .all<RawRow>();
  return results.map(toRow);
}

export async function listCollection(env: Env, collection: string, opts: { includeDeleted?: boolean; limit?: number } = {}): Promise<RecRow[]> {
  let sql = `SELECT ${SELECT} FROM records WHERE collection = ?`;
  if (!opts.includeDeleted) sql += ` AND COALESCE(json_extract(data, '$.deleted'), 0) != 1`;
  sql += ' LIMIT ?';
  const { results } = await env.DB.prepare(sql).bind(collection, opts.limit ?? 5000).all<RawRow>();
  return results.map(toRow);
}

/**
 * CAS read-modify-write (§6): read row, run `mutate` on its data, write the
 * patch guarded by the rev we read. On conflict, re-read and retry — up to
 * 5 attempts. `mutate` returns a patch or null to abort without writing.
 */
export async function casUpdate(
  env: Env,
  collection: string,
  id: string,
  mutate: (data: Record<string, unknown>, rev: number) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>,
  opts: { attempts?: number } = {},
): Promise<{ row: RecRow; result: ApplyResult } | { conflict: true } | { notFound: true }> {
  const attempts = opts.attempts ?? 5;
  for (let i = 0; i < attempts; i++) {
    const row = await getRec(env, id);
    if (!row || row.collection !== collection || row.data.deleted === true) return { notFound: true };
    const patch = await mutate(row.data, row.rev);
    if (patch === null) return { row, result: { rejected: 0, changed: 0, applied: [] } };
    const result = await applyChanges(env, 'mcp', [{ id, collection, patch, ts: Date.now() }], { serverTs: true, expect: new Map([[id, row.rev]]) });
    if (!result.conflicts?.length) return { row, result };
  }
  return { conflict: true };
}
