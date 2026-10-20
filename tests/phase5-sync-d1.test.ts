// The HTTP contract around the protocol 3 feed on actual D1: manifest route, push, protocol
// refusal, filtered content and bounded cost. The feed's own properties (cursors, joining,
// revocation, moves, relations) are proven in phase5-feeds-d1, phase5-moves-d1 and the
// randomized phase5-feeds-property-d1.
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sync } from '../worker/sync';
import { accessApi } from '../worker/syncAccess';
import { loadManifest, pullFeed } from '../worker/spaceFeed';
import { withD1Budget, d1BudgetRemaining } from '../worker/d1budget';
import { interceptD1Batches } from './d1WriteBoundary';
import { sha256Hex } from '../worker/password';
import type { Env } from '../worker/auth';
import { RefClient } from './feedClient';

vi.mock('../worker/events', async original => ({ ...await original<typeof import('../worker/events')>(), scheduleOutbox: vi.fn() }));
let mf: Miniflare, db: D1Database, env: Env, sequence: number;
const ctx = { waitUntil: (_p: Promise<unknown>) => {}, passThroughOnException: () => {} } as ExecutionContext;
const token = (id: string) => `phase5-sync-fixture-${id}`;
const headers = (actor: string) => ({ authorization: `Bearer ${token(actor)}`, 'Content-Type': 'application/json' });
async function put(id: string, collection: string, data: Record<string, unknown>, space = 'space-core') {
  await db.prepare('INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES(?,?,?,?,?,?)')
    .bind(id, collection, JSON.stringify(data), JSON.stringify(Object.fromEntries(Object.keys(data).map(k => [k, 1]))), ++sequence, space).run();
}
const etagOf = async (actor: string) => (await loadManifest(db, actor)).manifest.etag;
async function client(actor: string) {
  const c = new RefClient(async request => {
    const response = await sync.request('http://localhost/pull', { method: 'POST', headers: headers(actor), body: JSON.stringify(request) }, env, ctx);
    return { status: response.status, body: await response.json() as any };
  });
  c.reconcile((await loadManifest(db, actor)).manifest); return c;
}
const push = (actor: string, body: Record<string, unknown>) =>
  sync.request('http://localhost/push', { method: 'POST', headers: headers(actor), body: JSON.stringify(body) }, env, ctx);

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
    const etag = await etagOf('editor'), seen: string[] = [], metrics: { durationMs: number; bindingCalls: number; statementsInBatches: number; batchRowsRead: number; batchRowsWritten: number }[] = [];
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
      const outcome = await pullFeed(budget.DB, 'editor', { protocol: 3, etag, cursor, joining: [], limit: 50 });
      expect(outcome.status).toBe(200);
      const result = (outcome as { body: { records: { id: string }[]; cursor: number; hasMore: boolean } }).body;
      const bindingCalls = before - d1BudgetRemaining(budget.DB);
      metrics.push({ durationMs: Number((performance.now() - started).toFixed(2)), bindingCalls, statementsInBatches, batchRowsRead, batchRowsWritten });
      expect(bindingCalls).toBeLessThanOrEqual(5); expect(batchRowsRead).toBeLessThan(3000); expect(batchRowsWritten).toBe(0);
      expect(result.cursor).toBeGreaterThan(cursor); expect(result.records.length).toBeLessThanOrEqual(50);
      expect(JSON.stringify(result)).not.toMatch(/Hidden workload|Private Secret|Hidden relation/);
      seen.push(...result.records.map(r => r.id)); cursor = result.cursor;
      if (!result.hasMore) break;
    }
    expect(cursor).toBe(sequence); expect(seen).toHaveLength(501); expect(new Set(seen).size).toBe(501);
    const directory = process.env.CERT_ARTIFACT_DIR ? join(process.env.CERT_ARTIFACT_DIR, 'performance') : mkdtempSync(join(tmpdir(), 'tcg-phase5-sync-'));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'phase5-sync.json'), JSON.stringify({ schemaVersion: 2, protocol: 3, sourceSha: process.env.CERT_SOURCE_SHA ?? null,
      runtime: 'local disposable Miniflare D1; no production latency or billing claim', fixtureRecords: 1000, results: seen.length, pages: metrics,
      rowMetricScope: 'D1 batch statements only (the manifest and every candidate statement are one batch per page); bindingCalls include the three authorization reads per page',
    }, null, 2));
  });

  it('returns only currently authorized space names, roles and an etag in the access manifest', async () => {
    const etags = new Set<string>();
    for (const [actor, names] of [['editor', ['Core']], ['viewer', ['Private']], ['outsider', []]] as const) {
      const response = await accessApi.request('http://localhost/', { headers: { authorization: `Bearer ${token(actor)}` } }, env, ctx);
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await response.json() as { protocol: number; userId: string; etag: string; workspaceRole: string; spaces: { name: string; role: string }[] };
      expect(body).toMatchObject({ protocol: 3, userId: actor, etag: await etagOf(actor) });
      expect(body.spaces.map(s => s.name)).toEqual(names);
      if (actor === 'viewer') expect(body.spaces[0].role).toBe('viewer');
      etags.add(body.etag);
    }
    expect(etags.size).toBe(3);
  });

  it('reports the legacy protocol, and nothing about spaces, while permissions are off', async () => {
    await db.prepare('UPDATE access_state SET enabled=0 WHERE id=1').run();
    const response = await accessApi.request('http://localhost/', { headers: { authorization: `Bearer ${token('editor')}` } }, env, ctx);
    expect(await response.json()).toEqual({ protocol: 1, userId: 'editor' });
  });

  it('refuses every older protocol after activation and accepts protocol 3', async () => {
    expect((await sync.request('http://localhost/pull', { headers: headers('editor') }, env, ctx)).status).toBe(426);
    expect((await sync.request('http://localhost/pull?protocol=3&since=0', { headers: headers('editor') }, env, ctx)).status).toBe(426); // pulls are POSTs now
    for (const protocol of [undefined, 1, 2, '2', 4]) {
      const response = await push('editor', { changes: [], ...(protocol === undefined ? {} : { protocol }) });
      expect(response.status, String(protocol)).toBe(426);
    }
    const ok = await push('editor', { changes: [], protocol: 3 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, rejected: 0, accessEtag: await etagOf('editor') });
  });

  it('filters inherited content, both relation endpoints and stale child SQL scopes', async () => {
    const member = await client('editor'), guest = await client('viewer');
    await member.sync(); await guest.sync();
    expect(member.ids()).toEqual(['core']);
    expect(guest.ids()).toEqual(['private-body', 'private-page']);
    expect(JSON.stringify([...member.live.values()])).not.toMatch(/Private Secret|Private body|Hidden relation|Cannot trust/);
    expect(guest.ids()).not.toContain('hidden-link'); expect(guest.ids()).not.toContain('core');
  });

  it('a write after revocation is refused per item, nothing is stored, and the reply already carries the new etag', async () => {
    const before = await etagOf('viewer');
    await db.prepare("UPDATE space_members SET access='deny' WHERE user_id='viewer'").run();
    const response = await push('viewer', { protocol: 3, changes: [{ id: 'private-page', collection: 'pages', patch: { title: 'After revocation' }, ts: Date.now() }] });
    expect(response.status).toBe(200);
    const body = await response.json() as { rejected: number; rejectedItems: { id: string; reason: string }[]; accessEtag: string };
    expect(body.rejected).toBe(1); expect(body.rejectedItems).toEqual([expect.objectContaining({ id: 'private-page', reason: 'not_found_or_forbidden' })]);
    expect(body.accessEtag).not.toBe(before); expect(body.accessEtag).toBe(await etagOf('viewer'));
    expect(await db.prepare("SELECT json_extract(data,'$.title') title FROM records WHERE id='private-page'").first('title')).toBe('Private Secret');
  });

  it('an authorized write is applied and the etag is unchanged by it', async () => {
    const before = await etagOf('editor');
    const response = await push('editor', { protocol: 3, changes: [{ id: 'core', collection: 'pages', patch: { title: 'Edited' }, ts: Date.now() }] });
    expect(response.status).toBe(200); expect((await response.json() as { accessEtag: string }).accessEtag).toBe(before);
    expect(await db.prepare("SELECT json_extract(data,'$.title') title FROM records WHERE id='core'").first('title')).toBe('Edited');
  });

  it('preserves the legacy sync response while permission activation is off', async () => {
    await db.prepare('UPDATE access_state SET enabled=0 WHERE id=1').run();
    const response = await sync.request('http://localhost/pull?since=0', { headers: { authorization: `Bearer ${token('editor')}` } }, env, ctx);
    expect(response.status).toBe(200);
    const body = await response.json() as { records: unknown[]; protocol?: number };
    expect(body.records).toHaveLength(sequence); expect(body.protocol).toBeUndefined();
    const legacyPush = await push('editor', { changes: [{ id: 'core', collection: 'pages', patch: { title: 'Legacy' }, ts: Date.now() }] });
    expect(legacyPush.status).toBe(200); expect((await legacyPush.json() as { accessEtag?: string }).accessEtag).toBeUndefined();
  });
});
