import { readFileSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { files } from '../worker/files';
import { sha256Hex } from '../worker/password';
import type { Env } from '../worker/auth';
import { interceptD1Batches } from './d1WriteBoundary';
import { withD1Budget, d1BudgetRemaining } from '../worker/d1budget';
let runtime: Miniflare, db: D1Database, env: Env;
const ai = vi.fn(async () => ({ text: 'private transcript' }));
beforeEach(async () => {
  runtime = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'phase5-files', modules: true,
    script: 'export default {fetch(){return new Response("disposable file fixture")}}',
    compatibilityDate: '2026-09-25', d1Databases: { DB: 'disposable-phase5-files' },
  }] }));
  db = await runtime.getD1Database('DB') as D1Database; env = { DB: db, AI: { run: ai } } as unknown as Env; ai.mockClear();
  const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const name of readdirSync(folder).filter(n => n.endsWith('.sql')).sort()) {
    const sql = readFileSync(`${folder}/${name}`, 'utf8').replace(/--[^\n]*/g, '');
    await db.batch((sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi) ?? []).map(s => db.prepare(s.trim())));
  }
  await db.prepare("INSERT INTO spaces(id,name,default_access,created_at) VALUES('private','Private','private',1)").run();
  for (const id of ['editor', 'viewer', 'outsider']) {
    await db.prepare('INSERT INTO users(id,username,role,workspace_role) VALUES(?,?,?,?)').bind(id, id, 'member', 'guest').run();
    await db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)').bind(await sha256Hex(`fixture-${id}`), id, Date.now(), Date.now() + 86400_000).run();
  }
  await db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('private','editor','editor'),('private','viewer','viewer')").run();
  for (const [id, collection, data, space] of [
    ['board', 'boards', { name: 'Private board' }, 'private'], ['record', 'tasks', { title: 'Private record', boardId: 'board' }, 'private'],
    ['audio', 'files', { name: 'Private audio', parentType: 'task', parentId: 'record' }, 'private'],
    ['pending', 'files', { name: 'Pending', parentType: 'task', parentId: 'record' }, 'private'],
    ['stale', 'files', { name: 'Stale inherited scope', parentType: 'task', parentId: 'record' }, 'space-core'],
  ] as const) await db.prepare('INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES(?,?,?,?,?,?)').bind(id, collection, JSON.stringify(data), '{}', 1, space).run();
  await db.prepare("INSERT INTO files(id,uploaded_by,mime,size,chunks,complete,created_at) VALUES('audio','editor','audio/webm',7,1,1,1)").run();
  await db.prepare("INSERT INTO file_chunks(file_id,idx,data) VALUES('audio',0,?)").bind(new TextEncoder().encode('private')).run();
  await db.prepare('UPDATE access_state SET enabled=1 WHERE id=1').run();
});
afterEach(async () => { await runtime.dispose(); });
const call = (actor: string, path: string, method = 'GET', body?: BodyInit, bindings = env) => files.request(`http://localhost${path}`, {
  method, headers: { Authorization: `Bearer fixture-${actor}` }, ...(body ? { body } : {}),
}, bindings);
const requestContext: NonNullable<Parameters<typeof files.request>[3]> = { waitUntil() {}, passThroughOnException() {}, props: {} };

it('allows the editor to delete canonical bytes through the normal mutation path', async () => {
  const response = await files.request('http://localhost/audio', { method: 'DELETE', headers: { Authorization: 'Bearer fixture-editor' } }, env, requestContext);
  expect(await response.text()).toContain('"ok":true'); expect(response.status).toBe(200);
  expect(await db.prepare("SELECT COUNT(*) n FROM file_chunks WHERE file_id='audio'").first('n')).toBe(0);
});

it('does not commit a metadata deletion after its authenticated session is revoked', async () => {
  let hit = false;
  const raced = interceptD1Batches(db, async (target, statements, sql) => {
    if (!hit && sql.some(s => /INSERT INTO records\(/.test(s))) { hit = true; await target.prepare("DELETE FROM sessions WHERE user_id='editor'").run(); }
    return target.batch(statements);
  });
  const response = await files.request('http://localhost/audio', { method: 'DELETE', headers: { Authorization: 'Bearer fixture-editor' } }, { ...env, DB: raced }, requestContext);
  expect(hit).toBe(true); expect(response.status).toBe(503);
  expect(await db.prepare("SELECT json_extract(data,'$.deleted') FROM records WHERE id='audio'").first("json_extract(data,'$.deleted')")).toBeNull();
  expect(await db.prepare("SELECT COUNT(*) n FROM file_chunks WHERE file_id='audio'").first('n')).toBe(1);
});

it('serves authorized bytes without a persistent HTTP cache and conceals guessed or hidden files', async () => {
  const visible = await call('viewer', '/audio'); expect(visible.status).toBe(200); expect(await visible.text()).toBe('private');
  expect(visible.headers.get('cache-control')).toContain('no-store');
  for (const id of ['audio', 'missing']) { const hidden = await call('outsider', `/${id}`); expect(hidden.status).toBe(404); expect(await hidden.text()).not.toContain('private'); }
});
it('authorizes the existing deterministic thumbnail through its canonical main attachment', async () => {
  await db.prepare("UPDATE records SET data=json_set(data,'$.thumbId','audiot') WHERE id='audio'").run();
  expect((await call('viewer', '/audiot/chunks/0', 'PUT', 'thumb')).status).toBe(403);
  expect((await call('editor', '/audiot/chunks/0', 'PUT', 'thumb')).status).toBe(200);
  expect((await call('editor', '/audiot/complete', 'POST', JSON.stringify({ chunks: 1, size: 5, mime: 'image/png' }))).status).toBe(200);
  const response = await call('viewer', '/audiot'); expect(response.status).toBe(200); expect(await response.text()).toBe('thumb');
  expect((await (await call('viewer', '/usage')).json() as { used: number }).used).toBe(12);
  expect((await call('outsider', '/audiot')).status).toBe(404);
});
it('requires editable canonical metadata before accepting bytes; knowing an ID is insufficient', async () => {
  expect((await call('viewer', '/pending/chunks/0', 'PUT', 'bytes')).status).toBe(403);
  expect((await call('outsider', '/pending/chunks/0', 'PUT', 'bytes')).status).toBe(404);
  expect((await call('editor', '/unknown/chunks/0', 'PUT', 'bytes')).status).toBe(404);
  expect(await db.prepare("SELECT COUNT(*) n FROM files WHERE id IN ('pending','unknown')").first('n')).toBe(0);
  expect((await call('editor', '/pending/chunks/0', 'PUT', 'bytes')).status).toBe(200);
});
it('does not treat an arbitrary visible thumbnail reference as ownership of hidden bytes', async () => {
  await db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('space-core','outsider','editor')").run();
  await db.prepare("INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES('fake','files',?,'{}',2,'space-core')")
    .bind(JSON.stringify({ parentType: 'task', parentId: 'record', thumbId: 'audiot' })).run();
  await db.prepare("UPDATE records SET data=json_set(data,'$.thumbId','audiot') WHERE id='audio'").run();
  await db.prepare("INSERT INTO files(id,uploaded_by,mime,size,chunks,complete,created_at) VALUES('audiot','editor','image/png',5,1,1,1)").run();
  await db.prepare("INSERT INTO file_chunks(file_id,idx,data) VALUES('audiot',0,?)").bind(new TextEncoder().encode('thumb')).run();
  expect((await call('outsider', '/audiot')).status).toBe(404);
});
it('preserves a real thumbnail-ID record authority and fences concurrent record creation', async () => {
  await db.prepare("UPDATE records SET data=json_set(data,'$.thumbId','audiot') WHERE id='audio'").run();
  await db.prepare("INSERT INTO files(id,uploaded_by,mime,size,chunks,complete,created_at) VALUES('audiot','editor','image/png',5,1,1,1)").run();
  await db.prepare("INSERT INTO file_chunks(file_id,idx,data) VALUES('audiot',0,?)").bind(new TextEncoder().encode('thumb')).run();
  let hit = false;
  const raced = interceptD1Batches(db, async (target, statements, sql) => {
    if (!hit && sql.some(s => /SELECT idx, data FROM file_chunks/.test(s))) {
      hit = true;
      await target.prepare("INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES('audiot','files',?,'{}',4,'space-core')")
        .bind(JSON.stringify({ parentType: 'block', parentId: 'hidden-missing' })).run();
    }
    return target.batch(statements);
  });
  expect((await call('viewer', '/audiot', 'GET', undefined, { ...env, DB: raced })).status).toBe(409);
  expect(hit).toBe(true);
  expect((await call('viewer', '/audiot')).status).toBe(404);
});
it('does not delete auxiliary thumbnail bytes after a concurrent revocation', async () => {
  await db.prepare("UPDATE records SET data=json_set(data,'$.thumbId','audiot') WHERE id='audio'").run();
  expect((await call('editor', '/audiot/chunks/0', 'PUT', 'thumb')).status).toBe(200);
  let hit = false;
  const raced = interceptD1Batches(db, async (target, statements, sql) => {
    if (!hit && sql.some(s => /INSERT INTO file_deletions/.test(s))) { hit = true; await target.prepare("UPDATE space_members SET access='deny' WHERE user_id='editor'").run(); }
    return target.batch(statements);
  });
  expect((await call('editor', '/audiot', 'DELETE', undefined, { ...env, DB: raced })).status).toBe(409);
  expect(hit).toBe(true);
  expect(await db.prepare("SELECT COUNT(*) n FROM file_chunks WHERE file_id='audiot'").first('n')).toBe(1);
  expect(await db.prepare("SELECT COUNT(*) n FROM file_deletions WHERE id='audiot'").first('n')).toBe(0);
});
it('prevents viewers completing, deleting or transcribing files and preserves canonical bytes', async () => {
  for (const [path, method, body] of [['/audio/complete', 'POST', JSON.stringify({ chunks: 1, size: 7, mime: 'audio/webm' })], ['/audio/transcribe', 'POST', '{}'], ['/audio', 'DELETE', undefined]] as const) {
    expect((await call('viewer', path, method, body)).status).toBe(403);
  }
  expect(ai).not.toHaveBeenCalled(); expect(await db.prepare("SELECT complete FROM files WHERE id='audio'").first('complete')).toBe(1);
  expect((await call('editor', '/audio/transcribe', 'POST', '{}')).status).toBe(200); expect(ai).toHaveBeenCalledTimes(1);
});
it('uses actual inherited scope even when a stale files index claims Core', async () => {
  expect((await call('outsider', '/stale/chunks/0', 'PUT', 'bytes')).status).toBe(404);
  await db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('space-core','outsider','editor')").run();
  expect((await call('outsider', '/stale/chunks/0', 'PUT', 'bytes')).status).toBe(404);
  expect(await db.prepare("SELECT COUNT(*) n FROM files WHERE id='stale'").first('n')).toBe(0);
});
it('does not expose private workspace storage usage to an outsider', async () => {
  const hidden = await (await call('outsider', '/usage')).json() as { used: number };
  const visible = await (await call('viewer', '/usage')).json() as { used: number };
  expect(hidden.used).toBe(0); expect(visible.used).toBe(7);
});
it('rolls back tentative binary metadata and chunks when edit access disappears before commit', async () => {
  let hit = false;
  const raced = interceptD1Batches(db, async (target, statements, sql) => {
    if (!hit && sql.some(s => /INSERT INTO file_chunks/.test(s))) { hit = true; await target.prepare("UPDATE space_members SET access='deny' WHERE user_id='editor'").run(); }
    return target.batch(statements);
  });
  const response = await call('editor', '/pending/chunks/0', 'PUT', 'bytes', { ...env, DB: raced });
  expect(hit).toBe(true); expect(response.status).toBe(409);
  expect(await db.prepare("SELECT COUNT(*) n FROM files WHERE id='pending'").first('n')).toBe(0);
  expect(await db.prepare("SELECT COUNT(*) n FROM file_chunks WHERE file_id='pending'").first('n')).toBe(0);
});

it('does not return bytes if permission is revoked between graph authorization and byte read', async () => {
  let hit = false;
  const raced = interceptD1Batches(db, async (target, statements, sql) => {
    if (!hit && sql.some(s => /SELECT idx, data FROM file_chunks/.test(s))) { hit = true; await target.prepare("UPDATE space_members SET access='deny' WHERE user_id='viewer'").run(); }
    return target.batch(statements);
  });
  const response = await call('viewer', '/audio', 'GET', undefined, { ...env, DB: raced });
  expect(hit).toBe(true); expect(response.status).toBe(409); expect(await response.text()).not.toContain('private');
});

it('does not complete a pending upload after a concurrent role downgrade', async () => {
  expect((await call('editor', '/pending/chunks/0', 'PUT', 'bytes')).status).toBe(200);
  let hit = false;
  const raced = interceptD1Batches(db, async (target, statements, sql) => {
    if (!hit && sql.some(s => /UPDATE files SET mime/.test(s))) { hit = true; await target.prepare("UPDATE space_members SET role='viewer' WHERE user_id='editor'").run(); }
    return target.batch(statements);
  });
  const response = await call('editor', '/pending/complete', 'POST', JSON.stringify({ mime: 'text/plain', chunks: 1, size: 5 }), { ...env, DB: raced });
  expect(hit).toBe(true); expect(response.status).toBe(409);
  expect(await db.prepare("SELECT complete FROM files WHERE id='pending'").first('complete')).toBe(0);
  expect(await db.prepare("SELECT COUNT(*) n FROM file_chunks WHERE file_id='pending'").first('n')).toBe(1);
});

it('withholds a transcription result after access is revoked during the AI request', async () => {
  ai.mockImplementationOnce(async () => { await db.prepare("UPDATE space_members SET access='deny' WHERE user_id='editor'").run(); return { text: 'private transcript' }; });
  const response = await call('editor', '/audio/transcribe', 'POST', '{}');
  expect(response.status).toBe(409); expect(await response.text()).not.toContain('private transcript');
});

it('preserves pending chunks on duplicate retry and refuses uploads after their credential expires', async () => {
  expect((await call('editor', '/pending/chunks/0', 'PUT', 'bytes')).status).toBe(200);
  expect((await call('editor', '/pending/chunks/0', 'PUT', 'bytes')).status).toBe(200);
  expect(await db.prepare("SELECT COUNT(*) n FROM file_chunks WHERE file_id='pending'").first('n')).toBe(1);
  await db.prepare("UPDATE sessions SET expires_at=1 WHERE user_id='editor'").run();
  expect((await call('editor', '/pending/chunks/1', 'PUT', 'more')).status).toBe(401);
  expect(await db.prepare("SELECT COUNT(*) n FROM file_chunks WHERE file_id='pending'").first('n')).toBe(1);
});

it('bounds readable usage computation for 1,000 files without per-file binding calls', async () => {
  for (let start = 0; start < 1000; start += 100) {
    const statements: D1PreparedStatement[] = [];
    for (let i = start; i < start + 100; i++) {
      const id = `usage-${i}`;
      statements.push(db.prepare("INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES(?,'files',?,'{}',?,'private')").bind(id, JSON.stringify({ parentType: 'task', parentId: 'record' }), i + 10),
        db.prepare("INSERT INTO files(id,uploaded_by,size,complete,created_at) VALUES(?,'editor',1,1,1)").bind(id));
    }
    await db.batch(statements);
  }
  let statementsInBatches = 0, batchRowsRead = 0, batchRowsWritten = 0;
  const observed = interceptD1Batches(db, async (target, statements) => {
    statementsInBatches += statements.length;
    const results = await target.batch(statements);
    for (const r of results) { batchRowsRead += r.meta.rows_read ?? 0; batchRowsWritten += r.meta.rows_written ?? 0; }
    return results;
  });
  const budget = withD1Budget({ ...env, DB: observed }), before = d1BudgetRemaining(budget.DB), started = performance.now();
  const response = await call('viewer', '/usage', 'GET', undefined, budget), result = await response.json() as { used: number };
  expect(response.status).toBe(200); expect(result.used).toBe(1007);
  const bindingCalls = before - d1BudgetRemaining(budget.DB), durationMs = Number((performance.now() - started).toFixed(2));
  expect(bindingCalls).toBeLessThanOrEqual(18); expect(batchRowsRead).toBeLessThan(20_000); expect(batchRowsWritten).toBe(0);
  expect(durationMs).toBeLessThan(30_000);
  const directory = process.env.CERT_ARTIFACT_DIR ? join(process.env.CERT_ARTIFACT_DIR, 'performance') : mkdtempSync(join(tmpdir(), 'tcg-phase5-files-'));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'phase5-files.json'), JSON.stringify({ schemaVersion: 1, sourceSha: process.env.CERT_SOURCE_SHA ?? null,
    runtime: 'local disposable Miniflare D1; no production latency or billing claim', fixtureFiles: 1000,
    bindingCalls, statementsInBatches, batchRowsRead, batchRowsWritten, durationMs,
    rowMetricScope: 'D1 batch statements; direct authentication/state/space discovery reads excluded from row totals but included in bindingCalls',
  }, null, 2));
});
