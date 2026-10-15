import { readFileSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sync } from '../worker/sync';
import { accessApi, pullAuthorized, loadAccessState } from '../worker/syncAccess';
import { withD1Budget, d1BudgetRemaining } from '../worker/d1budget';
import { interceptD1Batches } from './d1WriteBoundary';
import { sha256Hex } from '../worker/password';
import type { Env } from '../worker/auth';

vi.mock('../worker/events', async original => ({ ...await original<typeof import('../worker/events')>(), scheduleOutbox: vi.fn() }));
let mf: Miniflare, db: D1Database, env: Env, sequence: number;
const ctx = { waitUntil: (_p: Promise<unknown>) => {}, passThroughOnException: () => {} } as ExecutionContext;
const token = (id: string) => `phase5-sync-fixture-${id}`;
async function put(id: string, collection: string, data: Record<string, unknown>, space = 'space-core') {
  await db.prepare('INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES(?,?,?,?,?,?)')
    .bind(id, collection, JSON.stringify(data), JSON.stringify(Object.fromEntries(Object.keys(data).map(k => [k, 1]))), ++sequence, space).run();
}
async function generation() { return (await db.prepare('SELECT generation FROM access_state WHERE id=1').first<{ generation: number }>())!.generation; }
async function pull(actor: string, query: Record<string, string | number> = {}) {
  const params = new URLSearchParams(Object.entries({ protocol: 2, generation: await generation(), since: 0, ...query }).map(([k, v]) => [k, String(v)]));
  return sync.request(`http://localhost/pull?${params}`, { headers: { authorization: `Bearer ${token(actor)}` } }, env, ctx);
}
beforeEach(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'phase5-sync', modules: true,
    script: 'export default {fetch(){return new Response("disposable sync fixture")}}', compatibilityDate: '2026-09-25', d1Databases: { DB: 'disposable-phase5-sync' },
  }] }));
  db = await mf.getD1Database('DB') as D1Database; env = { DB: db } as Env; sequence = 0;
  const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const name of readdirSync(folder).filter(n => n.endsWith('.sql')).sort()) {
    const sql = readFileSync(`${folder}/${name}`, 'utf8').replace(/--[^\n]*/g, '');
    await db.batch((sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi) ?? []).map(s => db.prepare(s.trim())));
  }
  await db.prepare("INSERT INTO spaces(id,name,default_access,created_at) VALUES('private','Private','private',1)").run();
  for (const [id, role] of [['editor', 'member'], ['viewer', 'guest'], ['outsider', 'guest']] as const) {
    await db.prepare('INSERT INTO users(id,username,name,role,workspace_role) VALUES(?,?,?,?,?)').bind(id, id, id, 'member', role).run();
    await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await sha256Hex(token(id)), id, Date.now() + 86400_000, Date.now()).run();
  }
  await db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('private','viewer','viewer')").run();
  await put('core', 'pages', { title: 'Core title' });
  await put('private-page', 'pages', { title: 'Private Secret' }, 'private');
  await put('private-body', 'blocks', { pageId: 'private-page', text: 'Private body' }, 'private');
  await put('hidden-link', 'links', { fromType: 'page', fromId: 'core', toType: 'page', toId: 'private-page', label: 'Hidden relation' });
  await put('stale-child', 'blocks', { pageId: 'private-page', text: 'Cannot trust child SQL scope' });
  await db.prepare('UPDATE access_state SET enabled=1 WHERE id=1').run();
});
afterEach(async () => { await mf?.dispose(); });

describe('Phase 5 permission-aware sync HTTP contract on actual D1', () => {
  it('pages a 1000-record mixed-space fixture with bounded D1 calls and no gaps or duplicates', async () => {
    for (let start = 0; start < 1000; start += 100) {
      await db.batch(Array.from({ length: 100 }, (_, offset) => {
        const i = start + offset;
        return db.prepare('INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES(?,?,?,?,?,?)')
          .bind(`workload-${i}`, 'pages', JSON.stringify({ title: i % 2 ? 'Hidden workload' : `Visible ${i}` }), '{}', ++sequence, i % 2 ? 'private' : 'space-core');
      }));
    }
    const state = await loadAccessState(db), seen: string[] = [], metrics: { durationMs: number; bindingCalls: number; statementsInBatches: number; batchRowsRead: number; batchRowsWritten: number }[] = [];
    let cursor = 0;
    for (let page = 0; page < 30; page++) {
      let statementsInBatches = 0, batchRowsRead = 0, batchRowsWritten = 0;
      const observed = interceptD1Batches(db, async (target, statements) => {
        statementsInBatches += statements.length;
        const results = await target.batch(statements);
        for (const r of results) { batchRowsRead += r.meta.rows_read ?? 0; batchRowsWritten += r.meta.rows_written ?? 0; }
        return results;
      });
      const budget = withD1Budget({ DB: observed }), before = d1BudgetRemaining(budget.DB), started = performance.now();
      const result = await pullAuthorized(budget.DB, 'editor', state, cursor, 50);
      const bindingCalls = before - d1BudgetRemaining(budget.DB);
      metrics.push({ durationMs: Number((performance.now() - started).toFixed(2)), bindingCalls, statementsInBatches, batchRowsRead, batchRowsWritten });
      expect(bindingCalls).toBeLessThanOrEqual(8); expect(batchRowsRead).toBeLessThan(2000); expect(batchRowsWritten).toBe(0);
      expect(result.cursor).toBeGreaterThan(cursor); expect(result.records.length).toBeLessThanOrEqual(50);
      expect(JSON.stringify(result)).not.toMatch(/Hidden workload|Private Secret|Hidden relation/);
      seen.push(...result.records.map(r => r.id)); cursor = result.cursor;
      if (!result.hasMore) break;
    }
    expect(cursor).toBe(sequence); expect(seen).toHaveLength(501); expect(new Set(seen).size).toBe(501);
    const directory = process.env.CERT_ARTIFACT_DIR ? join(process.env.CERT_ARTIFACT_DIR, 'performance') : mkdtempSync(join(tmpdir(), 'tcg-phase5-sync-'));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'phase5-sync.json'), JSON.stringify({ schemaVersion: 1, sourceSha: process.env.CERT_SOURCE_SHA ?? null,
      runtime: 'local disposable Miniflare D1; no production latency or billing claim', fixtureRecords: 1000, results: seen.length, pages: metrics,
      rowMetricScope: 'D1 batch statements only; indexed space-ID discovery uses one additional direct read per page; bindingCalls include it',
    }, null, 2));
  });

  it('invalidates incremental caches on ancestor deletion, restore and reference changes', async () => {
    let previous = await generation();
    await db.prepare("UPDATE records SET data=json_set(data,'$.title','Renamed') WHERE id='private-page'").run();
    expect(await generation()).toBe(previous);
    for (const sql of [
      "UPDATE records SET data=json_set(data,'$.deleted',json('true')) WHERE id='private-page'",
      "UPDATE records SET data=json_set(data,'$.deleted',json('false')) WHERE id='private-page'",
      "UPDATE records SET data=json_set(data,'$.pageId','core') WHERE id='private-body'",
      "UPDATE records SET data=json_set(data,'$.toId','core') WHERE id='hidden-link'",
    ]) {
      await db.prepare(sql).run(); expect(await generation()).toBeGreaterThan(previous); previous = await generation();
    }
    await db.prepare("DELETE FROM records WHERE id='private-page'").run();
    expect(await generation()).toBeGreaterThan(previous);
  });

  it('changes generation on activation and deactivation without changing record payloads', async () => {
    const before = await generation();
    await db.prepare('UPDATE access_state SET enabled=0 WHERE id=1').run();
    expect(await generation()).toBe(before + 1);
    const legacy = await generation();
    await db.prepare("UPDATE records SET data=json_set(data,'$.deleted',json('true')) WHERE id='private-page'").run();
    expect(await generation()).toBe(legacy);
    await db.prepare('UPDATE access_state SET enabled=1 WHERE id=1').run();
    expect(await generation()).toBe(legacy + 1);
  });

  it('returns only currently authorized space names and roles in the access manifest', async () => {
    for (const [actor, names] of [['editor', ['Core']], ['viewer', ['Private']], ['outsider', []]] as const) {
      const response = await accessApi.request('http://localhost/', { headers: { authorization: `Bearer ${token(actor)}` } }, env, ctx);
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await response.json() as { protocol: number; userId: string; generation: number; spaces: { name: string; role: string }[] };
      expect(body).toMatchObject({ protocol: 2, userId: actor, generation: await generation() });
      expect(body.spaces.map(s => s.name)).toEqual(names);
      if (actor === 'viewer') expect(body.spaces[0].role).toBe('viewer');
    }
  });

  it('does not publish even an empty page if membership changes at its final fence', async () => {
    let loads = 0;
    const raced = interceptD1Batches(db, async (target, statements, sql) => {
      const result = await target.batch(statements);
      if (sql.some(s => s.startsWith('SELECT id,COALESCE(workspace_role,role)')) && ++loads === 2) {
        await db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('private','outsider','viewer')").run();
      }
      return result;
    });
    const original = env; env = { ...env, DB: raced };
    const response = await pull('outsider'); env = original;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'access_reset_required' });
  });

  it('rejects membership revocation between graph authorization and content fetch', async () => {
    let fired = false;
    const raced = interceptD1Batches(db, async (target, statements, sql) => {
      if (!fired && sql.some(s => s.startsWith('SELECT id,collection,data,space_id,seq,field_ts'))) {
        fired = true; await db.prepare("UPDATE space_members SET access='deny' WHERE user_id='viewer'").run();
      }
      return target.batch(statements);
    });
    env = { ...env, DB: raced };
    const response = await pull('viewer');
    expect(fired).toBe(true); expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'access_reset_required' });
  });

  it('rejects old pull and push protocols after activation', async () => {
    const headers = { authorization: `Bearer ${token('editor')}`, 'Content-Type': 'application/json' };
    expect((await sync.request('http://localhost/pull', { headers }, env, ctx)).status).toBe(426);
    expect((await sync.request('http://localhost/push', { method: 'POST', headers, body: JSON.stringify({ changes: [] }) }, env, ctx)).status).toBe(426);
  });

  it('filters inherited content, both relation endpoints and stale child SQL scopes', async () => {
    const member = await pull('editor'), guest = await pull('viewer');
    expect(member.status).toBe(200); expect(guest.status).toBe(200);
    const m = await member.json() as { records: { id: string }[] }, g = await guest.json() as { records: { id: string }[] };
    expect(m.records.map(r => r.id)).toEqual(['core']);
    expect(g.records.map(r => r.id)).toContain('private-page'); expect(g.records.map(r => r.id)).toContain('private-body');
    expect(g.records.map(r => r.id)).not.toContain('core'); expect(g.records.map(r => r.id)).not.toContain('hidden-link');
    expect(JSON.stringify(m)).not.toMatch(/Private Secret|Private body|Hidden relation|Cannot trust/);
  });

  it('advances the cursor across empty invisible pages without stalling', async () => {
    const response = await pull('outsider', { limit: 2 });
    expect(response.status).toBe(200);
    const body = await response.json() as { records: unknown[]; cursor: number; hasMore: boolean; protocol: number; generation: number };
    expect(body.records).toEqual([]); expect(body.cursor).toBe(sequence); expect(body.hasMore).toBe(false);
    expect(body.protocol).toBe(2); expect(body.generation).toBe(await generation());
  });

  it('rejects stale generations on reads and writes without returning any records', async () => {
    const old = await generation();
    await db.prepare("UPDATE space_members SET access='deny' WHERE user_id='viewer'").run();
    const response = await pull('viewer', { generation: old });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: 'access_reset_required' });
    const write = await sync.request('http://localhost/push', { method: 'POST', headers: { authorization: `Bearer ${token('editor')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocol: 2, generation: old, changes: [{ id: 'core', collection: 'pages', patch: { title: 'Stale manifest' }, ts: 100 }] }) }, env, ctx);
    expect(write.status).toBe(409);
    expect(await db.prepare("SELECT json_extract(data,'$.title') title FROM records WHERE id='core'").first('title')).toBe('Core title');
  });

  it.each(['-1', 'NaN', '1.5', '9007199254740992'])('rejects invalid cursor %s', async since => {
    expect((await pull('editor', { since })).status).toBe(400);
  });

  it('preserves the legacy sync response while permission activation is off', async () => {
    await db.prepare('UPDATE access_state SET enabled=0 WHERE id=1').run();
    const response = await sync.request('http://localhost/pull?since=0', { headers: { authorization: `Bearer ${token('editor')}` } }, env, ctx);
    expect(response.status).toBe(200);
    const body = await response.json() as { records: unknown[]; protocol?: number };
    expect(body.records).toHaveLength(sequence); expect(body.protocol).toBeUndefined();
  });
});

describe('durable permission reconciliation snapshots on actual D1', () => {
  const headers = (actor: string) => ({ authorization: `Bearer ${token(actor)}`, 'Content-Type': 'application/json' });
  async function begin(actor = 'editor', requestId = 'snapshot-test', pageSize = 2) {
    return sync.request('http://localhost/snapshot', { method: 'POST', headers: headers(actor), body: JSON.stringify({ protocol: 2, generation: await generation(), requestId, pageSize }) }, env, ctx);
  }
  type Snapshot = { snapshotId: string; generation: number; cutoff: number; cursor: string; expiresAt: number };
  type Page = { records: { id: string; data: Record<string, unknown> }[]; cursor: string | null; done: boolean; cutoff: number };
  async function page(snapshot: Snapshot, actor = 'editor', cursor = snapshot.cursor) {
    return sync.request(`http://localhost/snapshot/${snapshot.snapshotId}?cursor=${encodeURIComponent(cursor)}`, { headers: headers(actor) }, env, ctx);
  }

  it('rejects a 20001-record snapshot atomically instead of certifying a truncated cache', async () => {
    await db.prepare(`WITH RECURSIVE fixture(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM fixture WHERE i<20001)
      INSERT INTO records(id,collection,data,field_ts,seq,space_id)
      SELECT 'capacity-'||i,'pages','{"title":"fixture"}','{}',i+100,'space-core' FROM fixture`).run();
    const response = await begin(); expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'snapshot_too_large' });
    expect((await db.prepare('SELECT COUNT(*) n FROM sync_snapshots').first<{ n: number }>())!.n).toBe(0);
    expect((await db.prepare('SELECT COUNT(*) n FROM sync_snapshot_items').first<{ n: number }>())!.n).toBe(0);
    expect((await db.prepare('SELECT COUNT(*) n FROM records').first<{ n: number }>())!.n).toBe(20001 + sequence);
  }, 60000);

  it.each([0, 501, 1.5, '2'])('rejects invalid snapshot page size %s', async pageSize => {
    const response = await sync.request('http://localhost/snapshot', { method: 'POST', headers: headers('editor'),
      body: JSON.stringify({ protocol: 2, generation: await generation(), requestId: 'invalid', pageSize }) }, env, ctx);
    expect(response.status).toBe(400);
    expect((await db.prepare('SELECT COUNT(*) n FROM sync_snapshots').first<{ n: number }>())!.n).toBe(0);
  });

  it('does not allow permission activation or a missing protocol to be bypassed by snapshot routes', async () => {
    await db.prepare('UPDATE access_state SET enabled=0 WHERE id=1').run();
    expect((await begin()).status).toBe(426);
    await db.prepare('UPDATE access_state SET enabled=1 WHERE id=1').run();
    const response = await sync.request('http://localhost/snapshot', { method: 'POST', headers: headers('editor'), body: JSON.stringify({ requestId: 'old-client' }) }, env, ctx);
    expect(response.status).toBe(426);
  });

  it('freezes payloads and cutoff, filters hidden references, and replays identical continuations', async () => {
    const response = await begin(); expect(response.status).toBe(200);
    const snapshot = await response.json() as Snapshot;
    expect(snapshot.cutoff).toBe(sequence);
    await db.prepare("UPDATE records SET data=json_set(data,'$.title','New title'),seq=? WHERE id='core'").bind(++sequence).run();
    const first = await page(snapshot); expect(first.status).toBe(200);
    const body = await first.json() as Page;
    expect(body.records).toEqual([expect.objectContaining({ id: 'core', data: { title: 'Core title' } })]);
    expect(await (await page(snapshot)).json()).toEqual(body);
    expect(body.done).toBe(false); expect(body.cursor).toBeTruthy();
    const tail = await page(snapshot, 'editor', body.cursor!);
    expect(await tail.json()).toMatchObject({ records: [], done: true, cursor: null, cutoff: snapshot.cutoff });
    const catchup = await (await pull('editor', { since: snapshot.cutoff })).json() as Page;
    expect(catchup.records).toEqual([expect.objectContaining({ id: 'core', data: { title: 'New title' } })]);
    expect(JSON.stringify(body)).not.toMatch(/Private Secret|Private body|Hidden relation|Cannot trust/);
  });

  it('binds snapshot IDs and continuations to the authenticated account and rejects cursor tampering', async () => {
    const response = await begin(); expect(response.status).toBe(200); const snapshot = await response.json() as Snapshot;
    expect((await page(snapshot, 'viewer')).status).toBe(404);
    expect((await page(snapshot, 'editor', `${snapshot.cursor}x`)).status).toBe(400);
    const other = await (await begin('editor', 'other')).json() as Snapshot;
    expect((await page(other, 'editor', snapshot.cursor)).status).toBe(400);
    const row = await db.prepare('SELECT cursor_secret FROM sync_snapshots WHERE id=?').bind(snapshot.snapshotId).first<{ cursor_secret: string }>();
    expect(JSON.stringify(snapshot)).not.toContain(row!.cursor_secret);
  });

  it.each(['cancel', 'expire'])('does not publish a successful empty page if a snapshot is invalidated by %s during paging', async mode => {
    const response = await begin(); expect(response.status).toBe(200); const snapshot = await response.json() as Snapshot;
    let fired = false;
    const raced = interceptD1Batches(db, async (target, statements, sql) => {
      if (!fired && sql.some(s => s.startsWith('SELECT ordinal,record_id'))) {
        fired = true;
        await db.prepare(mode === 'cancel' ? 'DELETE FROM sync_snapshots WHERE id=?' : 'UPDATE sync_snapshots SET expires_at=1 WHERE id=?').bind(snapshot.snapshotId).run();
      }
      return target.batch(statements);
    });
    env = { ...env, DB: raced };
    const result = await page(snapshot);
    expect(fired).toBe(true); expect(result.status).toBe(mode === 'cancel' ? 404 : 410);
    expect(await result.json()).not.toHaveProperty('records');
  });

  it('recovers duplicate/concurrent starts once and rejects different-input request reuse', async () => {
    const responses = await Promise.all([begin(), begin()]);
    expect(responses.map(r => r.status)).toEqual([200, 200]);
    const snapshots = await Promise.all(responses.map(r => r.json())) as Snapshot[];
    expect(snapshots[0]).toEqual(snapshots[1]);
    expect((await db.prepare('SELECT COUNT(*) n FROM sync_snapshots').first<{ n: number }>())!.n).toBe(1);
    expect((await begin('editor', 'snapshot-test', 3)).status).toBe(409);
  });

  it('invalidates snapshots after revocation and does not reuse them after regrant', async () => {
    const response = await begin('viewer'); expect(response.status).toBe(200); const snapshot = await response.json() as Snapshot;
    expect((await page(snapshot, 'viewer')).status).toBe(200);
    await db.prepare("UPDATE space_members SET access='deny' WHERE user_id='viewer'").run();
    expect((await page(snapshot, 'viewer')).status).toBe(409);
    await db.prepare("UPDATE space_members SET access='allow' WHERE user_id='viewer'").run();
    expect((await page(snapshot, 'viewer')).status).toBe(409);
    const fresh = await begin('viewer', 'regrant'); expect(fresh.status).toBe(200);
    const newSnapshot = await fresh.json() as Snapshot;
    expect(newSnapshot.generation).toBeGreaterThan(snapshot.generation);
    expect((await page(newSnapshot, 'viewer')).status).toBe(200);
  });

  it('expires snapshots and permits only their owner to cancel ephemeral state', async () => {
    const response = await begin(); expect(response.status).toBe(200); const snapshot = await response.json() as Snapshot;
    const cancel = (actor: string) => sync.request(`http://localhost/snapshot/${snapshot.snapshotId}`, { method: 'DELETE', headers: headers(actor) }, env, ctx);
    expect((await cancel('viewer')).status).toBe(404);
    await db.prepare('UPDATE sync_snapshots SET expires_at=1 WHERE id=?').bind(snapshot.snapshotId).run();
    expect((await page(snapshot)).status).toBe(410);
    expect((await cancel('editor')).status).toBe(200);
    expect((await cancel('editor')).status).toBe(404);
    expect((await db.prepare('SELECT COUNT(*) n FROM sync_snapshot_items').first<{ n: number }>())!.n).toBe(0);
    expect((await db.prepare('SELECT COUNT(*) n FROM records').first<{ n: number }>())!.n).toBe(sequence);
  });

  it.each(['before', 'after'])('recovers a %s-commit interruption without a partial frozen snapshot', async mode => {
    let injected = false;
    const raced = interceptD1Batches(db, async (target, statements, sql) => {
      const creation = sql.some(s => s.includes('INSERT INTO sync_snapshot_items'));
      if (creation && !injected && mode === 'before') { injected = true; throw new Error('injected snapshot creation interruption'); }
      const result = await target.batch(statements);
      if (creation && !injected && mode === 'after') { injected = true; throw new Error('injected lost snapshot response'); }
      return result;
    });
    const original = env; env = { ...env, DB: raced };
    let first: Response | undefined;
    if (mode === 'before') await expect(begin()).rejects.toThrow('injected snapshot creation interruption');
    else { first = await begin(); expect(first.status).toBe(200); }
    env = original;
    expect(injected).toBe(true);
    const retry = await begin(); expect(retry.status).toBe(200); const snapshot = await retry.json() as Snapshot;
    if (mode === 'after') expect(await first!.json()).toEqual(snapshot);
    expect((await db.prepare('SELECT COUNT(*) n FROM sync_snapshots').first<{ n: number }>())!.n).toBe(1);
    expect((await page(snapshot)).status).toBe(200);
  });

  it('bounds concurrent active snapshots and reclaims only expired ephemeral copies', async () => {
    expect((await begin('editor', 'a')).status).toBe(200);
    expect((await begin('editor', 'b')).status).toBe(200);
    expect((await begin('editor', 'c')).status).toBe(429);
    await db.prepare("UPDATE sync_snapshots SET expires_at=1 WHERE request_id='a'").run();
    expect((await begin('editor', 'c')).status).toBe(200);
    expect((await db.prepare('SELECT COUNT(*) n FROM sync_snapshots').first<{ n: number }>())!.n).toBe(2);
    expect((await db.prepare('SELECT COUNT(*) n FROM records').first<{ n: number }>())!.n).toBe(sequence);
  });
});
