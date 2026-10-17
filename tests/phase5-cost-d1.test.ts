// Local D1 resource evidence for protocol 3. Counts every binding call and result
// meta row count, including individual statements outside db.batch.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openAuditFixture, type AuditFixture } from './audit-fixture';
import { auth } from '../worker/auth';
import { applyChanges } from '../worker/sync';
import { loadManifest, pullFeed } from '../worker/spaceFeed';
interface Metrics { bindings: number; statements: number; rowsRead: number; rowsWritten: number; durationMs: number }
function meter(db: D1Database) {
  const metrics: Metrics = { bindings: 0, statements: 0, rowsRead: 0, rowsWritten: 0, durationMs: 0 }, originals = new WeakMap<object, D1PreparedStatement>();
  const record = (r: D1Result) => { metrics.rowsRead += r.meta.rows_read ?? 0; metrics.rowsWritten += r.meta.rows_written ?? 0; };
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => {
    const p = new Proxy(s, { get(t, key) {
      if (key === 'bind') return (...v: Parameters<D1PreparedStatement['bind']>) => wrap(t.bind(...v));
      if (key === 'all' || key === 'run') return async () => { metrics.bindings++; metrics.statements++; const r = await t[key](); record(r); return r; };
      if (key === 'first') return async (column?: string) => { metrics.bindings++; metrics.statements++; const r = await t.all(); record(r); const first = r.results[0]; return first ? column ? first[column] : first : null; };
      const v = Reflect.get(t, key); return typeof v === 'function' ? v.bind(t) : v;
    } }); originals.set(p, s); return p;
  };
  const observed = new Proxy(db, { get(t, key) {
    if (key === 'prepare') return (sql: string) => wrap(t.prepare(sql));
    if (key === 'batch') return async (statements: D1PreparedStatement[]) => { metrics.bindings++; metrics.statements += statements.length; const results = await t.batch(statements.map(s => originals.get(s) ?? s)); results.forEach(record); return results; };
    const v = Reflect.get(t, key); return typeof v === 'function' ? v.bind(t) : v;
  } });
  return { db: observed, metrics };
}
let fixture: AuditFixture | undefined;
afterEach(async () => { await fixture?.dispose(); fixture = undefined; });
it.each([500, 1000])('protocol 3 has zero backfill writes and constant logout/delete overhead with %i records', async size => {
  fixture = await openAuditFixture(); const db = fixture.db;
  for (let start = 0; start < size; start += 100) await db.batch(Array.from({ length: 100 }, (_, i) => db.prepare('INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES(?,?,?,?,?,?)')
    .bind(`cost-${start + i}`, 'pages', JSON.stringify({ title: `Record ${start + i}` }), '{"title":1}', start + i + 1, 'space-core')));
  await db.prepare('UPDATE access_state SET enabled=1 WHERE id=1').run();
  const manifest = (await loadManifest(db, 'alice')).manifest;
  const results: Record<string, Metrics> = {};
  const measure = async <T>(name: string, fn: (db: D1Database) => Promise<T>) => {
    const observed = meter(db), started = performance.now(); const value = await fn(observed.db); observed.metrics.durationMs = Number((performance.now() - started).toFixed(2)); results[name] = observed.metrics; return value;
  };
  const generation = await db.prepare('SELECT generation FROM access_state WHERE id=1').first('generation');
  const response = await measure('other-user logout', async observed => auth.request('http://fixture.local/logout', { method: 'POST', headers: fixture!.auth('bob') }, { ...fixture!.env, DB: observed }, fixture!.ctx));
  expect(response.status).toBe(200); expect(results['other-user logout'].bindings).toBeLessThan(10); expect(results['other-user logout'].rowsWritten).toBeLessThan(20);
  expect((await loadManifest(db, 'alice')).manifest.etag).toBe(manifest.etag);
  let after = 0, total = 0;
  do {
    const outcome = await measure(`backfill page ${after}`, observed => pullFeed(observed, 'alice', { protocol: 3, etag: manifest.etag, cursor: 0,
      joining: [{ space: 'space-core', after, base: after ? size : 0 }], limit: 500 }));
    expect(outcome.status).toBe(200); if (outcome.status !== 200) throw new Error('unexpected feed response');
    total += outcome.body.records.length; after = outcome.body.joining[0].after;
    if (!outcome.body.hasMore) break;
  } while (after < size);
  expect(total).toBe(size);
  for (const [name, metric] of Object.entries(results)) if (name.startsWith('backfill')) { expect(metric.rowsWritten).toBe(0); expect(metric.bindings).toBeLessThanOrEqual(5); }
  const deleted = await measure('ordinary soft delete', observed => applyChanges({ ...fixture!.env, DB: observed }, 'alice', [{ id: 'cost-0', collection: 'pages', patch: { deleted: true }, ts: Date.now() }], { serverTs: true }));
  expect(deleted.rejected).toBe(0); expect(deleted.partialError).toBeUndefined(); expect(deleted.changed).toBe(1);
  expect(results['ordinary soft delete'].rowsWritten).toBeLessThan(80); expect(results['ordinary soft delete'].bindings).toBeLessThan(15);
  expect((await loadManifest(db, 'alice')).manifest.etag).toBe(manifest.etag); expect(await db.prepare('SELECT generation FROM access_state WHERE id=1').first('generation')).toBe(generation);
  expect((await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sync_snapshots','sync_snapshot_items')").all()).results).toEqual([]);
  const directory = join(process.env.CERT_ARTIFACT_DIR ?? '.artifacts/phase5', 'performance'); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `phase5-feed-cost-${size}.json`), JSON.stringify({ schemaVersion: 1, sourceSha: process.env.CERT_SOURCE_SHA ?? null, records: size,
    runtime: 'local Miniflare D1; not production billing or latency', scope: 'all observed D1 result metadata; index writes included', results }, null, 2));
});
