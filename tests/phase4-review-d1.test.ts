import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyChanges } from '../worker/sync';
import { runDateOffsetAutomations } from '../worker/automations';
import { validateAutomation, type AutomationConfig } from '../shared/automations';
import { todayUtc } from '../shared/recurrence';
import type { Env } from '../worker/auth';
import { files, QUOTA_BYTES } from '../worker/files';
import { sha256Hex } from '../worker/password';
import { publicFormsApi, resumeSubmission } from '../worker/forms';
import { interceptD1Batches } from './d1WriteBoundary';

// Keep routes, SQL transactions and explicit recovery real. Background
// acceleration must not outlive this disposable fixture's assertions.
vi.mock('../worker/events', async original => ({
  ...await original<typeof import('../worker/events')>(), scheduleOutbox: vi.fn(),
}));

let mf: Miniflare;
let db: D1Database;
let env: Env;
beforeEach(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'phase4-review', modules: true,
    script: 'export default {fetch(){return new Response("disposable review fixture")}}',
    compatibilityDate: '2026-09-25', d1Databases: { DB: 'disposable-review' },
  }] }));
  db = await mf.getD1Database('DB') as D1Database;
  env = { DB: db, WORKSPACE_ENV: 'local-test', TURNSTILE_LOCAL_TEST: '1' } as Env;
  const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const filename of readdirSync(folder).filter(f => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(`${folder}/${filename}`, 'utf8').replace(/--[^\n]*/g, '');
    await db.batch((sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi) ?? []).map(s => db.prepare(s.trim())));
  }
  await db.prepare("INSERT INTO users(id,username,name,role) VALUES('alice','alice','Alice','admin')").run();
  await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
    .bind(await sha256Hex('review-session'), 'alice', Date.now() + 86_400_000, Date.now()).run();
});

it.each(['schema', 'stored-plan-target', 'transaction-schema'])('C19 recovered public submission revalidates current relation authority (%s)', async phase => {
  const form = {
    databaseId: 'intake', title: 'Intake', enabled: true,
    fields: [{ fieldKey: 'title', label: 'Your name', required: true }], successMessage: 'Recorded',
    createRelations: [{ fieldId: 'project', toId: 'private-project' }],
  };
  await applyChanges(env, 'alice', [
    { id: 'intake', collection: 'boards', patch: { name: 'Intake', columns: [{ id: 'open' }], fields: [{ id: 'project', name: 'Project', type: 'relation', relation: { target: 'projects' } }] }, ts: 1 },
    { id: 'projects', collection: 'boards', patch: { name: 'Projects', columns: [{ id: 'open' }], fields: [] }, ts: 1 },
    { id: 'other', collection: 'boards', patch: { name: 'Other', columns: [{ id: 'open' }], fields: [] }, ts: 1 },
    { id: 'private-project', collection: 'tasks', patch: { title: 'Private project', boardId: 'projects', status: 'open' }, ts: 1 },
    { id: 'form', collection: 'forms', patch: form, ts: 1 },
  ]);
  await db.prepare("INSERT INTO form_tokens(token,form_id,created_at) VALUES('published','form',1)").run();
  if (phase === 'schema') await db.prepare("CREATE TRIGGER interrupt_reservation BEFORE UPDATE OF lease_id ON form_submissions WHEN NEW.state='processing' BEGIN SELECT RAISE(ABORT,'interrupted reservation'); END").run();
  else if (phase === 'stored-plan-target') await db.prepare("CREATE TRIGGER interrupt_reservation BEFORE INSERT ON records WHEN NEW.collection='tasks' BEGIN SELECT RAISE(ABORT,'interrupted record'); END").run();
  const ctx = { waitUntil: (_promise: Promise<unknown>) => {}, passThroughOnException: () => {} } as ExecutionContext;
  let raced = false;
  const raceDb = new Proxy(db, { get(target, key) {
    if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
      if (!raced) {
        raced = true;
        await applyChanges(env, 'alice', [{ id: 'intake', collection: 'boards', patch: { fields: [{ id: 'project', name: 'Project', type: 'relation', relation: { target: 'other' } }] }, ts: 2 }]);
      }
      return target.batch(statements);
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const response = await publicFormsApi.request('http://localhost/published', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ submissionId: 'schema-change', values: { title: 'Visitor' }, turnstileToken: 'pass' }),
  }, phase === 'transaction-schema' ? { ...env, DB: raceDb } : env, ctx);
  expect(response.status).toBe(phase === 'schema' ? 500 : 503);
  if (phase !== 'transaction-schema') await db.prepare('DROP TRIGGER interrupt_reservation').run();
  if (phase === 'schema') await applyChanges(env, 'alice', [{ id: 'intake', collection: 'boards', patch: { fields: [{ id: 'project', name: 'Project', type: 'relation', relation: { target: 'other' } }] }, ts: 2 }]);
  else if (phase === 'stored-plan-target') {
    expect((await db.prepare("SELECT plan FROM form_submissions WHERE submission_id='schema-change'").first<{ plan: string | null }>())!.plan).not.toBeNull();
    await applyChanges(env, 'alice', [{ id: 'private-project', collection: 'tasks', patch: { boardId: 'other' }, ts: 2 }]);
    await db.prepare("UPDATE form_submissions SET retry_at=0 WHERE submission_id='schema-change'").run();
  }
  else await db.prepare("UPDATE form_submissions SET retry_at=0 WHERE submission_id='schema-change'").run();
  const outcome = await resumeSubmission(env, 'schema-change', ctx);
  expect(outcome.status).toBe(422);
  expect((await db.prepare("SELECT COUNT(*) n FROM records WHERE collection='links'").first<{ n: number }>())!.n).toBe(0);
  expect((await db.prepare("SELECT COUNT(*) n FROM records WHERE collection='tasks'").first<{ n: number }>())!.n).toBe(1);
});

it('C18 rejects file completion when a concurrent chunk changes the validated byte count', async () => {
  await db.batch([
    db.prepare("INSERT INTO files(id,uploaded_by,created_at,complete) VALUES('race','alice',1,0)"),
    db.prepare("INSERT INTO file_chunks(file_id,idx,data) VALUES('race',0,?)").bind(new Uint8Array([1])),
  ]);
  let raced = false;
  const raceDb = interceptD1Batches(db, async (target, statements, sql) => {
    if (!raced && sql.some(s => s.startsWith('UPDATE files SET mime'))) {
      raced = true;
      await target.prepare("UPDATE file_chunks SET data=? WHERE file_id='race' AND idx=0").bind(new Uint8Array([1, 2])).run();
    }
    return target.batch(statements);
  });
  const response = await files.request('http://localhost/race/complete', {
    method: 'POST', headers: { authorization: 'Bearer review-session', 'content-type': 'application/json' },
    body: JSON.stringify({ mime: 'image/png', size: 1, chunks: 1 }),
  }, { ...env, DB: raceDb });
  expect(raced).toBe(true); expect(response.status).toBe(409);
  expect((await db.prepare("SELECT complete FROM files WHERE id='race'").first<{ complete: number }>())!.complete).toBe(0);
});

it('C18 concurrent completions cannot exceed the workspace file quota', async () => {
  await db.batch([
    db.prepare("INSERT INTO files(id,size,complete,created_at) VALUES('padding',?,1,1)").bind(QUOTA_BYTES - 1),
    ...['one', 'two'].flatMap(id => [
      db.prepare('INSERT INTO files(id,uploaded_by,created_at,complete) VALUES(?,?,1,0)').bind(id, 'alice'),
      db.prepare('INSERT INTO file_chunks(file_id,idx,data) VALUES(?,0,?)').bind(id, new Uint8Array([1])),
    ]),
  ]);
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const raceDb = new Proxy(db, { get(target, key) {
    if (key === 'prepare') return (sql: string) => {
      const statement = target.prepare(sql);
      if (sql !== 'SELECT COALESCE(SUM(size), 0) AS used FROM files WHERE complete = 1') return statement;
      return new Proxy(statement, { get(prepared, method) {
        if (method === 'first') return async () => {
          const result = await prepared.first();
          if (++arrivals === 2) release();
          await barrier;
          return result;
        };
        const value = Reflect.get(prepared, method);
        return typeof value === 'function' ? value.bind(prepared) : value;
      } });
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const responses = await Promise.all(['one', 'two'].map(id => files.request(`http://localhost/${id}/complete`, {
    method: 'POST', headers: { authorization: 'Bearer review-session', 'content-type': 'application/json' },
    body: JSON.stringify({ mime: 'image/png', size: 1, chunks: 1 }),
  }, { ...env, DB: raceDb })));
  expect(responses.map(response => response.status).sort()).toEqual([200, 507]);
  expect((await db.prepare('SELECT SUM(size) used FROM files WHERE complete=1').first<{ used: number }>())!.used).toBe(QUOTA_BYTES);
});

it('C18 a chunk PUT that observed pending state cannot mutate a completed file', async () => {
  await db.batch([
    db.prepare("INSERT INTO files(id,uploaded_by,created_at,complete) VALUES('race-put','alice',1,0)"),
    db.prepare("INSERT INTO file_chunks(file_id,idx,data) VALUES('race-put',0,?)").bind(new Uint8Array([1])),
  ]);
  const raceDb = new Proxy(db, { get(target, key) {
    if (key === 'prepare') return (sql: string) => {
      const statement = target.prepare(sql);
      if (sql !== 'SELECT id, complete FROM files WHERE id = ?') return statement;
      return new Proxy(statement, { get(prepared, method) {
        if (method === 'bind') return (...values: unknown[]) => {
          const bound = prepared.bind(...values);
          return new Proxy(bound, { get(query, operation) {
            if (operation === 'first') return async () => {
              const result = await query.first();
              await target.prepare("UPDATE files SET complete=1,size=1,chunks=1 WHERE id='race-put'").run();
              return result;
            };
            const value = Reflect.get(query, operation);
            return typeof value === 'function' ? value.bind(query) : value;
          } });
        };
        const value = Reflect.get(prepared, method);
        return typeof value === 'function' ? value.bind(prepared) : value;
      } });
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const response = await files.request('http://localhost/race-put/chunks/0', {
    method: 'PUT', headers: { authorization: 'Bearer review-session' }, body: new Uint8Array([9, 9]),
  }, { ...env, DB: raceDb });
  expect(response.status).toBe(409);
  expect((await db.prepare("SELECT LENGTH(data) n FROM file_chunks WHERE file_id='race-put'").first<{ n: number }>())!.n).toBe(1);
});

it('C18 an interrupted SVG completion retains the original pending chunks atomically', async () => {
  const source = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>');
  await db.batch([
    db.prepare("INSERT INTO files(id,uploaded_by,created_at,complete) VALUES('svg-race','alice',1,0)"),
    db.prepare("INSERT INTO file_chunks(file_id,idx,data) VALUES('svg-race',0,?)").bind(source),
    db.prepare("CREATE TRIGGER svg_completion_fault BEFORE UPDATE OF complete ON files WHEN NEW.id='svg-race' BEGIN SELECT RAISE(ABORT,'svg completion fault'); END"),
  ]);
  const response = await files.request('http://localhost/svg-race/complete', {
    method: 'POST', headers: { authorization: 'Bearer review-session', 'content-type': 'application/json' },
    body: JSON.stringify({ mime: 'image/svg+xml', size: source.byteLength, chunks: 1 }),
  }, env);
  expect(response.status).toBe(503);
  expect((await db.prepare("SELECT complete FROM files WHERE id='svg-race'").first<{ complete: number }>())!.complete).toBe(0);
  const row = (await db.prepare("SELECT data FROM file_chunks WHERE file_id='svg-race' AND idx=0").first<{ data: Uint8Array }>())!;
  expect(Buffer.from(row.data)).toEqual(Buffer.from(source));
});
afterEach(() => mf.dispose());

it.each([
  { conditions: {} },
  { actions: {} },
  { actions: [null] },
  { trigger: { kind: 'date_offset', dateKey: {}, days: 0 } },
])('C17 malformed synced automation cannot starve a later valid date-offset rule (%j)', async malformed => {
  const today = todayUtc();
  const config = {
    name: 'Rule', enabled: true, databaseId: 'board',
    trigger: { kind: 'date_offset', dateKey: 'dueDate', days: 0 },
    actions: [{ type: 'create_record', databaseId: 'board', title: 'Valid follow up' }],
  };
  await applyChanges(env, 'alice', [
    { id: 'board', collection: 'boards', patch: { name: 'Dates', columns: [{ id: 'open' }], fields: [] }, ts: 1 },
    { id: 'a-malformed', collection: 'automations', patch: { ...config, ...malformed }, ts: 1 },
    { id: 'z-valid', collection: 'automations', patch: config, ts: 1 },
    { id: 'candidate', collection: 'tasks', patch: { boardId: 'board', title: 'Candidate', status: 'open', dueDate: today, createdBy: 'alice' }, ts: 1 },
  ]);
  await db.prepare("INSERT INTO date_index(record_id,field_key,date) VALUES('candidate','dueDate',?)").bind(today).run();
  await expect(runDateOffsetAutomations(env, today)).resolves.toBeUndefined();
  expect((await db.prepare("SELECT COUNT(*) n FROM records WHERE collection='tasks' AND json_extract(data,'$.title')='Valid follow up'").first<{ n: number }>())!.n).toBe(1);
  expect((await db.prepare("SELECT COUNT(*) n FROM automation_runs WHERE automation_id='a-malformed' AND status='completed'").first<{ n: number }>())!.n).toBe(0);
  await runDateOffsetAutomations(env, today);
  expect((await db.prepare("SELECT COUNT(*) n FROM automation_runs WHERE automation_id='z-valid' AND status='completed'").first<{ n: number }>())!.n).toBe(1);
}, 30_000);

it.each([
  { conditions: {} },
  { conditions: 'invalid' },
  { trigger: { kind: 'date_offset', dateKey: {} } },
  { trigger: { kind: 'field_changed', fieldId: 123 } },
  { actions: [{ type: 'set_field', fieldKey: 123 }] },
  { actions: [{ type: 'notify', userIds: {}, message: 'No' }] },
  { actions: [{ type: 'create_record', databaseId: 'board', title: 'No', fields: [] }] },
])('C17 malformed nested automation configuration returns validation errors (%j)', malformed => {
  const config = {
    name: 'Malformed', databaseId: 'board', trigger: { kind: 'record.created' },
    actions: [{ type: 'notify', userIds: ['alice'], message: 'Yes' }], ...malformed,
  } as unknown as AutomationConfig;
  const ctx = { boardsById: new Map([['board', { fields: [], columns: [{ id: 'open' }] }]]), memberIds: new Set(['alice']) };
  expect(() => validateAutomation(config, ctx)).not.toThrow();
  expect(validateAutomation(config, ctx).length).toBeGreaterThan(0);
});
