// TEMPORARY evidence harness: measures the Phase 5 draft's (4d8e15a) generation +
// materialized-snapshot reconciliation cost on actual D1. It only runs against a
// tree that still contains worker/syncSnapshot.ts and the p5_* generation triggers.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sync } from '../worker/sync';
import { auth } from '../worker/auth';
import { createSyncSnapshot, readSyncSnapshot } from '../worker/syncSnapshot';
import { sha256Hex } from '../worker/password';
import type { Env } from '../worker/auth';

vi.mock('../worker/events', async original => ({ ...await original<typeof import('../worker/events')>(), scheduleOutbox: vi.fn() }));
let mf: Miniflare, raw: D1Database;
const ctx = { waitUntil: (_p: Promise<unknown>) => {}, passThroughOnException: () => {} } as ExecutionContext;
const token = (id: string) => `baseline-cost-${id}`;
const counters = { rowsRead: 0, rowsWritten: 0, statements: 0, calls: 0 };
const reset = () => { counters.rowsRead = counters.rowsWritten = counters.statements = counters.calls = 0; };
function meter(db: D1Database): D1Database {
  const original = new WeakMap<object, D1PreparedStatement>();
  const add = (r: D1Result) => { counters.rowsRead += r.meta.rows_read ?? 0; counters.rowsWritten += r.meta.rows_written ?? 0; };
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => {
    const p = new Proxy(s, { get(t, k) {
      if (k === 'bind') return (...v: never[]) => wrap(t.bind(...v));
      if (k === 'first') return async (c?: string) => { counters.calls++; counters.statements++; const r = await t.all(); add(r); const row = r.results[0]; if (!row) return null; return c === undefined ? row : (row as Record<string, unknown>)[c]; };
      if (k === 'all' || k === 'run') return async () => { counters.calls++; counters.statements++; const r = await t[k](); add(r); return r; };
      const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v;
    } }); original.set(p, s); return p;
  };
  return new Proxy(db, { get(t, k) {
    if (k === 'prepare') return (sql: string) => wrap(t.prepare(sql));
    if (k === 'batch') return async (input: D1PreparedStatement[]) => { counters.calls++; counters.statements += input.length; const out = await t.batch(input.map(s => original.get(s) ?? s)); out.forEach(add); return out; };
    const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v;
  } });
}
let env: Env;
async function setup(n: number) {
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'baseline-cost', modules: true, script: 'export default {fetch(){return new Response("x")}}', compatibilityDate: '2026-09-25', d1Databases: { DB: 'disposable-baseline-cost' } }] }));
  raw = await mf.getD1Database('DB') as D1Database; env = { DB: meter(raw) } as Env;
  const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const name of readdirSync(folder).filter(f => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(`${folder}/${name}`, 'utf8').replace(/--[^\n]*/g, '');
    await raw.batch((sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi) ?? []).map(s => raw.prepare(s.trim())));
  }
  for (const id of ['u1', 'u2']) {
    await raw.prepare('INSERT INTO users(id,username,name,role,workspace_role) VALUES(?,?,?,?,?)').bind(id, id, id, 'member', 'member').run();
    for (const label of ['a', 'b']) await raw.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await sha256Hex(token(id + label)), id, Date.now() + 86_400_000, Date.now()).run();
  }
  const rows: D1PreparedStatement[] = [];
  for (let i = 1; i <= n; i++) rows.push(raw.prepare('INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES(?,?,?,?,?,?)').bind(`rec-${i}`, 'pages', JSON.stringify({ title: `Page ${i}`, body: 'x'.repeat(200) }), JSON.stringify({ title: 1, body: 1 }), i, 'space-core'));
  for (let i = 0; i < rows.length; i += 50) await raw.batch(rows.slice(i, i + 50));
  await raw.prepare('UPDATE access_state SET enabled=1 WHERE id=1').run();
}
afterEach(async () => { await mf?.dispose(); });

const results: Record<string, unknown>[] = [];
for (const n of [500, 1000, 2000]) {
  it(`baseline 4d8e15a snapshot reconciliation cost, ${n} readable records`, async () => {
    await setup(n);
    const generation = async () => (await raw.prepare('SELECT generation FROM access_state WHERE id=1').first<{ generation: number }>())!.generation;
    const g0 = await generation();
    // 1. An ordinary logout of ANOTHER user's second device.
    reset();
    const logout = await auth.request('http://localhost/logout', { method: 'POST', headers: { authorization: `Bearer ${token('u2a')}` } }, env, ctx);
    expect(logout.status).toBeLessThan(300);
    const logoutCost = { ...counters }; const g1 = await generation();
    // 2. u1's next pull with the old generation is refused (reset required).
    const stale = await sync.request(`http://localhost/pull?protocol=2&generation=${g0}&since=0`, { headers: { authorization: `Bearer ${token('u1a')}` } }, env, ctx);
    // 3. u1 must reconcile: snapshot creation (materialization).
    reset();
    const created = await createSyncSnapshot(env.DB, 'u1', { protocol: 2, generation: g1, requestId: `r-${n}-1`, pageSize: 500 });
    const create = { ...counters };
    // 4. reading the snapshot out
    reset(); let cursor: string | null = created.cursor; let pages = 0;
    while (cursor) { const page = await readSyncSnapshot(env.DB, 'u1', created.snapshotId, cursor); pages++; cursor = page.cursor; }
    const read = { ...counters, pages };
    // 5. a single soft-delete by a client push bumps the generation again
    const gBefore = await generation();
    reset();
    const push = await sync.request('http://localhost/push', { method: 'POST', headers: { authorization: `Bearer ${token('u1b')}`, 'content-type': 'application/json' }, body: JSON.stringify({ protocol: 2, generation: gBefore, changes: [{ id: 'rec-1', collection: 'pages', patch: { deleted: true }, ts: Date.now() }] }) }, env, ctx);
    const deleteCost = { ...counters }; const gAfter = await generation();
    // 6. expiry pruning + next snapshot (delete cost of the old copy)
    await raw.prepare('UPDATE sync_snapshots SET expires_at=1').run();
    reset();
    await createSyncSnapshot(env.DB, 'u1', { protocol: 2, generation: gAfter, requestId: `r-${n}-2`, pageSize: 500 });
    const secondCreate = { ...counters };
    results.push({ records: n, logout: { ...logoutCost, generationBumped: g1 - g0, staleStatus: stale.status },
      snapshotCreate: create, snapshotRead: read, softDeletePush: { ...deleteCost, status: push.status, generationBumped: gAfter - gBefore },
      pruneOldPlusCreateNew: secondCreate });
    mkdirSync('.artifacts/phase5', { recursive: true });
    writeFileSync('.artifacts/phase5/baseline-4d8e15a-snapshot-cost.json', JSON.stringify({ commit: '4d8e15a', note: 'draft protocol: global generation + materialized snapshots', results }, null, 2));
  }, 120_000);
}
