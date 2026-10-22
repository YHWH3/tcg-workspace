import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { applyChanges, sync } from '../worker/sync';
import { notificationsApi, notify } from '../worker/notifications';
import { approvalsApi, insertApproval, decideApproval } from '../worker/approvals';
import { formsApi, publicFormsApi, resumeSubmission } from '../worker/forms';
import { processOutbox } from '../worker/events';
import { sha256Hex } from '../worker/password';
import { planTemplateInstantiation } from '../shared/templates';
import type { Env } from '../worker/auth';
import type { Mutation } from '../shared/types';
import { interceptRecordWrites } from './d1WriteBoundary';

// Only background acceleration is disabled. Routes, sessions, SQLite CAS,
// transaction guards, migrations and explicit recovery use actual D1.
vi.mock('../worker/events', async original => ({
  ...await original<typeof import('../worker/events')>(), scheduleOutbox: vi.fn(),
}));

let mf: Miniflare;
let db: D1Database;
let env: Env;
const ctx = { waitUntil: (_promise: Promise<unknown>) => {}, passThroughOnException: () => {} } as ExecutionContext;
const token = (id: string) => `disposable-security-session-${id}`;
const auth = (id: string) => ({ authorization: `Bearer ${token(id)}`, 'Content-Type': 'application/json' });
const change = (id: string, collection: string, patch: Record<string, unknown>, ts = Date.now()): Mutation => ({ id, collection, patch, ts } as Mutation);
const baseForm = {
  databaseId: 'intake', title: 'Public intake', enabled: true,
  fields: [{ fieldKey: 'title', label: 'Your name', required: true }],
  successMessage: 'Recorded', notifyUserIds: ['alice'],
};

beforeEach(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'phase4-security', modules: true,
    script: 'export default {fetch(){return new Response("local security fixture")}}',
    compatibilityDate: '2026-09-25', d1Databases: { DB: 'disposable-security' },
  }] }));
  db = await mf.getD1Database('DB') as D1Database;
  env = { DB: db, WORKSPACE_ENV: 'local-test', TURNSTILE_LOCAL_TEST: '1' } as Env;
  const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const filename of readdirSync(folder).filter(f => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(`${folder}/${filename}`, 'utf8').replace(/--[^\n]*/g, '');
    const statements = sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi) ?? [];
    await db.batch(statements.map(statement => db.prepare(statement.trim())));
  }
  for (const id of ['alice', 'bob', 'carol']) {
    await db.prepare('INSERT INTO users(id,username,name,role,prefs) VALUES(?,?,?,?,NULL)')
      .bind(id, id, id, id === 'alice' ? 'admin' : 'member').run();
    await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
      .bind(await sha256Hex(token(id)), id, Date.now() + 86_400_000 * 30, Date.now()).run();
  }
  await applyChanges(env, 'alice', [
    change('intake', 'boards', { name: 'Intake', columns: [{ id: 'todo' }, { id: 'done' }], fields: [{ id: 'project', name: 'Project', type: 'relation', relation: { target: 'projects' } }] }, 1),
    change('projects', 'boards', { name: 'Projects', columns: [{ id: 'todo' }, { id: 'done' }], fields: [] }, 1),
    change('other', 'boards', { name: 'Other', columns: [{ id: 'todo' }, { id: 'done' }], fields: [] }, 1),
    change('project', 'tasks', { title: 'Private project', boardId: 'projects', status: 'todo' }, 1),
    change('wrongtarget', 'tasks', { title: 'Wrong database', boardId: 'other', status: 'todo' }, 1),
    change('private-page', 'pages', { title: 'Private page' }, 1),
  ]);
});

afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await mf?.dispose(); });

async function count(table: string) {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

async function taskEvents() {
  return (await db.prepare("SELECT COUNT(*) AS n FROM event_outbox WHERE EXISTS(SELECT 1 FROM json_each(payload,'$.applied') a WHERE json_extract(a.value,'$.collection')='tasks')").first<{ n: number }>())!.n;
}

async function requestForm(config: Record<string, unknown>, id = 'configured') {
  return formsApi.request('http://localhost/', { method: 'POST', headers: auth('alice'), body: JSON.stringify({ id, ...baseForm, ...config }) }, env, ctx);
}

async function publicSubmit(id: string, publicToken = 'published', extra: Record<string, unknown> = {}, bindings = env) {
  return publicFormsApi.request(`http://localhost/${publicToken}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ submissionId: id, values: { title: 'Visitor' }, turnstileToken: 'pass', ...extra }),
  }, bindings, ctx);
}

async function publishUploadForm(id = 'upload-form', published = 'upload-token') {
  await applyChanges(env, 'alice', [change(id, 'forms', { ...baseForm })]);
  await db.prepare('INSERT INTO form_tokens(token,form_id,created_at) VALUES(?,?,1)').bind(published, id).run();
}

async function uploadImage(publicToken = 'upload-token', bindings = env) {
  // Actual image bytes are sent through multipart parsing, not a seeded
  // fake file row. The PNG magic is deliberately valid for server sniffing.
  const data = new FormData();
  data.set('turnstileToken', 'pass');
  data.set('file', new File([new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0])], 'visitor.png', { type: 'image/png' }));
  return publicFormsApi.request(`http://localhost/${publicToken}/files`, { method: 'POST', body: data }, bindings, ctx);
}

describe('real D1 public upload claim authority and recovery', () => {
  it('keeps upload claims secret and refuses missing, guessed, and cross-form claims without task writes', async () => {
    await publishUploadForm();
    const response = await uploadImage(); expect(response.status).toBe(200);
    const uploaded = await response.json() as { id: string; claim: string };
    expect(uploaded.claim.length).toBeGreaterThanOrEqual(32);
    const file = await db.prepare('SELECT data FROM records WHERE id=?').bind(uploaded.id).first<{ data: string }>();
    expect(file).not.toBeNull(); expect(file!.data).not.toContain(uploaded.claim);
    expect(JSON.parse(file!.data).uploadClaimHash).toBe(await sha256Hex(uploaded.claim));
    for (const [id, fileClaims] of [['missing', {}], ['guessed', { [uploaded.id]: 'not-the-claim' }]] as const) {
      const rejected = await publicSubmit(id, 'upload-token', { fileIds: [uploaded.id], fileClaims });
      expect(rejected.status).toBe(422); expect(await rejected.json()).toMatchObject({ error: 'validation' });
    }
    await publishUploadForm('other-upload-form', 'other-upload-token');
    const crossForm = await publicSubmit('cross-form', 'other-upload-token', { fileIds: [uploaded.id], fileClaims: { [uploaded.id]: uploaded.claim } });
    expect(crossForm.status).toBe(422);
    expect((await db.prepare("SELECT COUNT(*) n FROM records WHERE collection='tasks' AND id NOT IN ('project','wrongtarget')").first<{ n: number }>())!.n).toBe(0);
    expect(await taskEvents()).toBe(0);
    expect(JSON.parse((await db.prepare('SELECT data FROM records WHERE id=?').bind(uploaded.id).first<{ data: string }>())!.data).parentType).toBe('form-pending');
    expect(await count('files')).toBe(1); expect(await count('file_chunks')).toBe(1);
  });

  it('a lost acknowledgement replays one uploaded attachment; a different visitor cannot reclaim it', async () => {
    await publishUploadForm();
    const uploaded = await (await uploadImage()).json() as { id: string; claim: string };
    const extra = { fileIds: [uploaded.id], fileClaims: { [uploaded.id]: uploaded.claim } };
    const accepted = await publicSubmit('attachment-owner', 'upload-token', extra); expect(accepted.status).toBe(200);
    const receipt = await accepted.json();
    const replay = await publicSubmit('attachment-owner', 'upload-token', { ...extra, turnstileToken: 'expired' });
    expect(replay.status).toBe(200); expect(await replay.json()).toEqual(receipt);
    expect(JSON.stringify(receipt)).not.toContain(uploaded.id); expect(JSON.stringify(receipt)).not.toContain(uploaded.claim);
    const file = JSON.parse((await db.prepare('SELECT data FROM records WHERE id=?').bind(uploaded.id).first<{ data: string }>())!.data);
    expect(file.parentType).toBe('task');
    const other = await publicSubmit('attachment-thief', 'upload-token', extra); expect(other.status).toBe(422);
    expect(JSON.parse((await db.prepare('SELECT data FROM records WHERE id=?').bind(uploaded.id).first<{ data: string }>())!.data).parentId).toBe(file.parentId);
    expect((await db.prepare("SELECT COUNT(*) n FROM records WHERE collection='tasks' AND id NOT IN ('project','wrongtarget')").first<{ n: number }>())!.n).toBe(1);
    expect(await count('files')).toBe(1); expect(await count('file_chunks')).toBe(1);
  });

  it('concurrent submissions cannot both accept the same one-use upload claim after both validate it', async () => {
    await publishUploadForm();
    const uploaded = await (await uploadImage()).json() as { id: string; claim: string };
    let plans = 0; let release!: () => void;
    const bothValidated = new Promise<void>(resolve => { release = resolve; });
    const fenced = new Proxy(db, { get(target, key) {
      if (key === 'prepare') return (sql: string) => {
        const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(inner, method) {
          if (method === 'bind') return (...values: Parameters<D1PreparedStatement['bind']>) => wrap(inner.bind(...values));
          if (method === 'run' && sql.startsWith('UPDATE form_submissions SET plan=')) return async () => {
            const result = await inner.run(); if (++plans === 2) release(); await bothValidated; return result;
          };
          const value = Reflect.get(inner, method); return typeof value === 'function' ? value.bind(inner) : value;
        } });
        return wrap(target.prepare(sql));
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const extra = { fileIds: [uploaded.id], fileClaims: { [uploaded.id]: uploaded.claim } };
    const responses = await Promise.all(['claim-a','claim-b'].map(id => publicSubmit(id, 'upload-token', extra, { ...env, DB: fenced })));
    const accepted = (await db.prepare("SELECT submission_id,record_id FROM form_submissions WHERE state='accepted'").all<{ submission_id: string; record_id: string }>()).results;
    expect(accepted).toHaveLength(1); expect(responses.filter(r => r.status === 200)).toHaveLength(1);
    const file = JSON.parse((await db.prepare('SELECT data FROM records WHERE id=?').bind(uploaded.id).first<{ data: string }>())!.data);
    expect(file.parentId).toBe(accepted[0].record_id);
    expect(await count('files')).toBe(1);
  }, 15_000);

  it('challenge timeout is retryable and does not reserve, stage bytes, or accept a submission', async () => {
    await publishUploadForm();
    const production = { ...env, TURNSTILE_SECRET: 'disposable-secret', TURNSTILE_SITE_KEY: 'sitekey', TURNSTILE_HOSTNAMES: 'workspace.example' };
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException('Challenge timed out', 'TimeoutError');
    }));
    const response = await publicFormsApi.request('https://workspace.example/upload-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ submissionId: 'timeout', values: { title: 'Visitor' }, turnstileToken: 'fresh' }) }, production, ctx);
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ error: 'challenge_unavailable', retryable: true });
    expect(await count('form_submissions')).toBe(0); expect(await count('files')).toBe(0); expect(await count('file_chunks')).toBe(0); expect(await taskEvents()).toBe(0);
  });
});

describe('real D1 sync and private Inbox security boundaries', () => {
  it('rejects every server-controlled collection through direct sync without staging records or events', async () => {
    const forbidden = ['notifications', 'approvals', 'automation_runs', 'form_tokens', 'form_submissions', 'date_index', 'reminder_sent', 'event_outbox', 'rate_limits', 'notification_deliveries', 'execution_steps', 'form_people_keys', 'website_ingest'];
    const response = await sync.request('http://localhost/push', {
      method: 'POST', headers: auth('bob'),
      body: JSON.stringify({ changes: forbidden.map((collection, index) => ({ id: `forbidden_${index}`, collection, patch: { userId: 'alice', status: 'approved', title: 'Spoofed' }, ts: Date.now() })) }),
    }, env, ctx);
    expect(response.status).toBe(200);
    const body = await response.json() as { rejected: number; rejectedItems: { reason: string }[] };
    expect(body.rejected).toBe(forbidden.length);
    expect(body.rejectedItems.map(item => item.reason)).toEqual(forbidden.map(() => 'invalid_mutation'));
    expect((await db.prepare("SELECT COUNT(*) AS n FROM records WHERE id LIKE 'forbidden_%'").first<{ n: number }>())!.n).toBe(0);
    for (const table of forbidden) expect(await count(table)).toBe(0);
  });

  it('requires a valid session for sync and notification operations', async () => {
    for (const path of ['/', '/badge']) expect((await notificationsApi.request(`http://localhost${path}`, {}, env, ctx)).status).toBe(401);
    expect((await sync.request('http://localhost/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ changes: [] }) }, env, ctx)).status).toBe(401);
    await db.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').bind('alice').run();
    expect((await notificationsApi.request('http://localhost/', { headers: auth('alice') }, env, ctx)).status).toBe(401);
  });

  it('lists and counts only the session recipient, ignoring attacker-supplied userId', async () => {
    await notify(env, { userId: 'alice', kind: 'mention', title: 'Alice private', dedupeKey: 'alice-private' });
    await notify(env, { userId: 'bob', kind: 'mention', title: 'Bob private', dedupeKey: 'bob-private' });
    const response = await notificationsApi.request('http://localhost/?userId=bob', { headers: auth('alice') }, env, ctx);
    expect(response.status).toBe(200);
    const body = await response.json() as { notifications: { title: string }[] };
    expect(body.notifications.map(row => row.title)).toEqual(['Alice private']);
    expect(JSON.stringify(body)).not.toContain('Bob private');
    expect(await (await notificationsApi.request('http://localhost/badge?userId=bob', { headers: auth('alice') }, env, ctx)).json()).toEqual({ unread: 1 });
  });

  it('cross-user mark-read returns the same refusal as an unknown id, and read-all affects only its caller', async () => {
    await notify(env, { userId: 'alice', kind: 'mention', title: 'Alice', dedupeKey: 'alice' });
    await notify(env, { userId: 'bob', kind: 'mention', title: 'Bob', dedupeKey: 'bob' });
    const bob = (await db.prepare("SELECT id FROM notifications WHERE user_id='bob'").first<{ id: string }>())!;
    const foreign = await notificationsApi.request(`http://localhost/${bob.id}/read`, { method: 'POST', headers: auth('alice') }, env, ctx);
    const missing = await notificationsApi.request('http://localhost/unknown/read', { method: 'POST', headers: auth('alice') }, env, ctx);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
    const all = await notificationsApi.request('http://localhost/read-all', { method: 'POST', headers: auth('alice'), body: JSON.stringify({ userId: 'bob' }) }, env, ctx);
    expect(await all.json()).toEqual({ ok: true, updated: 1 });
    expect((await db.prepare("SELECT read_at FROM notifications WHERE user_id='bob'").first<{ read_at: number | null }>())!.read_at).toBeNull();
    expect((await notificationsApi.request(`http://localhost/${bob.id}/read`, { method: 'POST', headers: auth('bob') }, env, ctx)).status).toBe(200);
    expect((await notificationsApi.request(`http://localhost/${bob.id}/read`, { method: 'POST', headers: auth('bob') }, env, ctx)).status).toBe(200);
  });

  it('a legitimate delivery after a read group starts an unread generation, while replay remains read', async () => {
    const notification = { userId: 'bob', kind: 'assigned' as const, targetId: 'project', groupKey: 'assigned:project', title: 'First assignment', dedupeKey: 'assignment:1' };
    await notify(env, notification);
    const first = (await db.prepare("SELECT id FROM notifications WHERE user_id='bob'").first<{ id: string }>())!;
    expect((await notificationsApi.request(`http://localhost/${first.id}/read`, { method: 'POST', headers: auth('bob') }, env, ctx)).status).toBe(200);
    await notify(env, { ...notification, title: 'New assignment', dedupeKey: 'assignment:2' });
    const rows = (await db.prepare("SELECT id,title,read_at,group_count FROM notifications WHERE user_id='bob'").all<{ id: string; title: string; read_at: number | null; group_count: number }>()).results;
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.id === first.id)?.read_at).not.toBeNull();
    const second = rows.find(row => row.id !== first.id)!;
    expect(second).toMatchObject({ title: 'New assignment', read_at: null, group_count: 1 });
    expect(await (await notificationsApi.request('http://localhost/badge', { headers: auth('bob') }, env, ctx)).json()).toEqual({ unread: 1 });
    expect((await notificationsApi.request(`http://localhost/${second.id}/read`, { method: 'POST', headers: auth('bob') }, env, ctx)).status).toBe(200);
    await notify(env, { ...notification, title: 'New assignment', dedupeKey: 'assignment:2' });
    expect(await count('notifications')).toBe(2);
    expect(await (await notificationsApi.request('http://localhost/badge', { headers: auth('bob') }, env, ctx)).json()).toEqual({ unread: 0 });
    expect((await db.prepare('SELECT group_count FROM notifications WHERE id=?').bind(second.id).first<{ group_count: number }>())!.group_count).toBe(1);
  });

  it('quiet digest suppresses quiet badge kinds while retaining every unread Inbox item', async () => {
    await db.prepare('UPDATE users SET prefs=? WHERE id=?').bind(JSON.stringify({ quietDigest: true }), 'bob').run();
    for (const kind of ['assigned', 'due_soon', 'form_submission', 'automation'] as const) {
      await notify(env, { userId: 'bob', kind, title: kind, dedupeKey: `quiet:${kind}` });
    }
    expect(await (await notificationsApi.request('http://localhost/badge', { headers: auth('bob') }, env, ctx)).json()).toEqual({ unread: 1 });
    const inbox = await (await notificationsApi.request('http://localhost/', { headers: auth('bob') }, env, ctx)).json() as { notifications: { kind: string; readAt: number | null }[] };
    expect(inbox.notifications.map(row => row.kind).sort()).toEqual(['assigned', 'due_soon', 'form_submission', 'automation'].sort());
    expect(inbox.notifications.every(row => row.readAt === null)).toBe(true);
    expect(await (await notificationsApi.request('http://localhost/read-all', { method: 'POST', headers: auth('bob') }, env, ctx)).json()).toEqual({ ok: true, updated: 4 });
    expect(await (await notificationsApi.request('http://localhost/badge', { headers: auth('bob') }, env, ctx)).json()).toEqual({ unread: 0 });
  });
});

describe('real D1 form configuration and public authority boundaries', () => {
  it.each(['wrongtarget', 'private-page'])('member config rejects a fixed relation targeting the wrong database/type (%s)', async target => {
    const response = await requestForm({ createRelations: [{ fieldId: 'project', toId: target }] });
    expect(response.status).toBe(422);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM records WHERE collection='forms'").first<{ n: number }>())!.n).toBe(0);
    expect(await count('event_outbox')).toBe(0);
  });

  it('generic config sync cannot turn an invalid fixed relation into public write authority', async () => {
    await applyChanges(env, 'bob', [change('unsafeform', 'forms', { ...baseForm, createRelations: [{ fieldId: 'project', toId: 'wrongtarget' }] })]);
    await db.prepare("INSERT INTO form_tokens(token,form_id,created_at) VALUES('published','unsafeform',?)").bind(Date.now()).run();
    const result = await publicSubmit('invalidrelation');
    expect(result.status).toBe(422);
    expect(await result.json()).toMatchObject({ error: 'form_configuration' });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM records WHERE collection='tasks'").first<{ n: number }>())!.n).toBe(2);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM records WHERE collection='links'").first<{ n: number }>())!.n).toBe(0);
    expect(await taskEvents()).toBe(0);
  });

  it('public schema and receipt expose no recipients, fixed relations, private IDs or workspace URLs', async () => {
    const response = await requestForm({ createRelations: [{ fieldId: 'project', toId: 'project' }] });
    expect(response.status).toBe(200);
    await db.prepare("INSERT INTO form_tokens(token,form_id,created_at) VALUES('published','configured',?)").bind(Date.now()).run();
    const publicSchema = await publicFormsApi.request('http://localhost/published', {}, env, ctx);
    const schema = await publicSchema.json() as Record<string, unknown>;
    for (const privateKey of ['notifyUserIds', 'createRelations', 'peopleMatch', 'databaseId']) expect(schema).not.toHaveProperty(privateKey);
    expect(JSON.stringify(schema)).not.toContain('alice');
    expect(JSON.stringify(schema)).not.toContain('Private project');
    const submitted = await publicSubmit('public');
    expect(submitted.status).toBe(200);
    const receipt = await submitted.json() as Record<string, unknown>;
    expect(receipt.state).toBe('accepted');
    for (const privateKey of ['recordId', 'recordUrl', 'personId', 'databaseId']) expect(receipt).not.toHaveProperty(privateKey);
    expect(JSON.stringify(receipt)).not.toMatch(/\/tasks\/|\/boards\/|Private project|alice/);
  });

  it('recovery refuses a pending submission whose form was remapped after reservation', async () => {
    await requestForm({ createRelations: [{ fieldId: 'project', toId: 'project' }] });
    await db.prepare("INSERT INTO form_tokens(token,form_id,created_at) VALUES('published','configured',?)").bind(Date.now()).run();
    await db.prepare("CREATE TRIGGER interrupt_reservation BEFORE UPDATE OF lease_id ON form_submissions WHEN NEW.state='processing' BEGIN SELECT RAISE(ABORT,'interrupted reservation'); END").run();
    expect((await publicSubmit('remapped')).status).toBe(500);
    await db.prepare('DROP TRIGGER interrupt_reservation').run();
    await applyChanges(env, 'bob', [change('configured', 'forms', { databaseId: 'other', createRelations: [] })]);
    const resumed = await resumeSubmission(env, 'remapped', ctx);
    expect([409, 410, 422]).toContain(resumed.status);
    expect((await db.prepare("SELECT state FROM form_submissions WHERE submission_id='remapped'").first())!).toMatchObject({ state: 'rejected' });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM records WHERE collection='tasks'").first<{ n: number }>())!.n).toBe(2);
    expect(await taskEvents()).toBe(0);
  });

  it('installed form relation/database references remap together and submit against their copied targets', async () => {
    let index = 0;
    const plan = planTemplateInstantiation({
      pages: { root: { title: 'Form pack', isTemplate: true } }, blocks: {},
      boards: {
        authored_intake: { name: 'Copied intake', columns: [{ id: 'new' }], fields: [{ id: 'authored_relation', name: 'Project', type: 'relation', relation: { target: 'authored_projects' } }] },
        authored_projects: { name: 'Copied projects', columns: [{ id: 'todo' }], fields: [] },
      },
      tasks: { authored_project: { title: 'Copied project', boardId: 'authored_projects', status: 'todo' } },
      forms: { authored_form: { ...baseForm, databaseId: 'authored_intake', createRelations: [{ fieldId: 'authored_relation', toId: 'authored_project' }] } },
    }, { templateId: 'root', packInstall: true, actorId: 'alice' }, { id: () => `copied_${index++}`, now: Date.now() });
    expect(plan).toBeTruthy();
    await applyChanges(env, 'alice', plan!.writes.map(write => change(write.id, write.collection, write.patch)));
    const copiedForm = plan!.writes.find(write => write.collection === 'forms')!;
    const copiedProject = plan!.writes.find(write => write.collection === 'tasks')!;
    expect(copiedForm.patch.databaseId).not.toBe('authored_intake');
    expect(copiedForm.patch.createRelations).toMatchObject([{ toId: copiedProject.id }]);
    await db.prepare('INSERT INTO form_tokens(token,form_id,created_at) VALUES(?,?,?)').bind('copied', copiedForm.id, Date.now()).run();
    const result = await publicSubmit('copiedsubmission', 'copied');
    expect(result.status).toBe(200);
    const link = (await db.prepare("SELECT data FROM records WHERE collection='links'").first<{ data: string }>())!;
    const linked = JSON.parse(link.data);
    expect(linked.toId).toBe(copiedProject.id);
    const relations = copiedForm.patch.createRelations as { fieldId: string; toId: string }[];
    expect(linked.fieldId).toBe(relations[0].fieldId);
    const copiedBoard = plan!.writes.find(write => write.id === copiedForm.patch.databaseId)!;
    const field = (copiedBoard.patch.fields as { id: string; relation: { target: string } }[]).find(definition => definition.id === linked.fieldId)!;
    expect(field.relation.target).toBe(copiedProject.patch.boardId);
    // Field ids are board-local property keys and may be preserved. Record
    // and database references must point into this installed copy.
    expect([linked.fromId, linked.toId, copiedForm.patch.databaseId, field.relation.target]).not.toContain('authored_project');
    expect([linked.fromId, linked.toId, copiedForm.patch.databaseId, field.relation.target]).not.toContain('authored_intake');
    expect([linked.fromId, linked.toId, copiedForm.patch.databaseId, field.relation.target]).not.toContain('authored_projects');
  });
});

describe('real D1 approval authority, replay and stage gates', () => {
  it('isolates identical request keys by requester and rejects different-input reuse', async () => {
    const input = { targetType: 'record', targetId: 'project', approverId: 'carol', requestKey: 'same-key' };
    const [alice, bob] = await Promise.all([
      insertApproval(db, { ...input, requestedBy: 'alice' }),
      insertApproval(db, { ...input, requestedBy: 'bob' }),
    ]);
    expect(alice.row.id).not.toBe(bob.row.id);
    expect(await count('approvals')).toBe(2);
    expect((await insertApproval(db, { ...input, requestedBy: 'alice' })).row.id).toBe(alice.row.id);
    await expect(insertApproval(db, { ...input, requestedBy: 'alice', targetId: 'wrongtarget' })).rejects.toThrow(/requestId reused/);
    expect(await count('approvals')).toBe(2);
    const list = await approvalsApi.request('http://localhost/', { headers: auth('alice') }, env, ctx);
    const body = await list.json() as { approvals: { id: string }[] };
    expect(body.approvals.map(row => row.id)).toEqual([alice.row.id]);
  });

  it('two concurrent decisions settle once, preserve the winning decision on replay and deny another user', async () => {
    const { row } = await insertApproval(db, { targetType: 'record', targetId: 'project', requestedBy: 'alice', approverId: 'bob', requestKey: 'decision' });
    const unauthorized = await approvalsApi.request(`http://localhost/${row.id}/decide`, { method: 'POST', headers: auth('carol'), body: JSON.stringify({ decision: 'approved', expectedRev: row.created_at }) }, env, ctx);
    expect(unauthorized.status).toBe(403);
    expect((await db.prepare('SELECT status FROM approvals WHERE id=?').bind(row.id).first())!).toMatchObject({ status: 'pending' });
    const stale = await approvalsApi.request(`http://localhost/${row.id}/decide`, { method: 'POST', headers: auth('bob'), body: JSON.stringify({ decision: 'approved', expectedRev: row.created_at - 1 }) }, env, ctx);
    expect(stale.status).toBe(409);
    const outcomes = await Promise.all([
      decideApproval(db, { approvalId: row.id, approverId: 'bob', decision: 'approved', expectedRev: row.created_at }),
      decideApproval(db, { approvalId: row.id, approverId: 'bob', decision: 'rejected', expectedRev: row.created_at }),
    ]);
    expect(outcomes.map(outcome => outcome.outcome).sort()).toEqual(['already_decided', 'ok']);
    const stored = (await db.prepare('SELECT status,decided_at FROM approvals WHERE id=?').bind(row.id).first<{ status: 'approved' | 'rejected'; decided_at: number }>())!;
    const replay = await decideApproval(db, { approvalId: row.id, approverId: 'bob', decision: stored.status, expectedRev: row.created_at });
    expect(replay).toMatchObject({ outcome: 'ok', replayed: true, row: { status: stored.status, decided_at: stored.decided_at } });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM event_outbox WHERE id LIKE 'ev_approval_decided_%'").first<{ n: number }>())!.n).toBe(1);
    const events = (await db.prepare('SELECT id FROM event_outbox').all<{ id: string }>()).results;
    for (const event of events) await processOutbox(env, event.id);
    for (const event of events) await processOutbox(env, event.id);
    expect((await db.prepare("SELECT user_id,kind,group_count FROM notifications WHERE kind='approval_decided'").all()).results).toEqual([{ user_id: 'alice', kind: 'approval_decided', group_count: 1 }]);
  });

  it('concurrent identical REST approval requests and trigger replay create one authority row and one delivery', async () => {
    const body = JSON.stringify({ targetType: 'record', targetId: 'project', approverId: 'bob', requestId: 'same-public-request' });
    const responses = await Promise.all([
      approvalsApi.request('http://localhost/', { method: 'POST', headers: auth('alice'), body }, env, ctx),
      approvalsApi.request('http://localhost/', { method: 'POST', headers: auth('alice'), body }, env, ctx),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
    const decoded = await Promise.all(responses.map(response => response.json() as Promise<{ approval: { id: string }; replayed: boolean }>));
    expect(decoded[0].approval.id).toBe(decoded[1].approval.id);
    expect(decoded.map(response => response.replayed).sort()).toEqual([false, true]);
    expect(await count('approvals')).toBe(1);
    const event = (await db.prepare("SELECT id FROM event_outbox WHERE id LIKE 'ev_approval_requested_%'").first<{ id: string }>())!;
    await processOutbox(env, event.id);
    await processOutbox(env, event.id);
    expect((await db.prepare("SELECT user_id,kind,group_count FROM notifications WHERE kind='approval_requested'").all()).results).toEqual([{ user_id: 'bob', kind: 'approval_requested', group_count: 1 }]);
  });

  it('a boardId-only move cannot enter a gated stage without an approval', async () => {
    await applyChanges(env, 'alice', [change('intake', 'boards', { approvalGate: { stageId: 'done' } }), change('moving', 'tasks', { title: 'Moving', boardId: 'other', status: 'done' })]);
    const response = await sync.request('http://localhost/push', { method: 'POST', headers: auth('bob'), body: JSON.stringify({ changes: [change('moving', 'tasks', { boardId: 'intake' })] }) }, env, ctx);
    const result = await response.json() as { rejected?: number; committed?: string[]; error?: string };
    expect(response.status === 503 || (response.status === 200 && (result.rejected ?? 0) > 0)).toBe(true);
    expect(result.committed ?? []).toEqual([]);
    expect(JSON.parse((await db.prepare("SELECT data FROM records WHERE id='moving'").first<{ data: string }>())!.data).boardId).toBe('other');
    expect(await taskEvents()).toBe(0);
  });

  it('clearing the configured approver cannot reuse a prior approval while remaining in the gated stage', async () => {
    await applyChanges(env, 'alice', [
      change('intake', 'boards', { approvalGate: { stageId: 'done', approverField: 'owner' }, fields: [{ id: 'owner', name: 'Approver', type: 'person' }] }),
      change('owned', 'tasks', { title: 'Owned', boardId: 'intake', status: 'todo', p_owner: 'bob' }),
    ]);
    const approval = await insertApproval(db, { targetType: 'record', targetId: 'owned', stageId: 'done', requestedBy: 'alice', approverId: 'bob', requestKey: 'owner-gate' });
    expect((await decideApproval(db, { approvalId: approval.row.id, approverId: 'bob', decision: 'approved' })).outcome).toBe('ok');
    expect((await applyChanges(env, 'alice', [change('owned', 'tasks', { status: 'done' })])).changed).toBe(1);
    const result = await applyChanges(env, 'bob', [change('owned', 'tasks', { p_owner: null })], { event: { source: 'client', ctx } });
    expect(result.changed).toBe(0);
    expect(result.partialError || result.rejectedItems?.length).toBeTruthy();
    expect(JSON.parse((await db.prepare("SELECT data FROM records WHERE id='owned'").first<{ data: string }>())!.data)).toMatchObject({ p_owner: 'bob', status: 'done' });
    expect(await taskEvents()).toBe(0);
  });

  it('the transaction observes a gate configuration committed after the precheck', async () => {
    await applyChanges(env, 'alice', [change('racing', 'tasks', { title: 'Racing', boardId: 'intake', status: 'todo' })]);
    let first = true;
    const raced = interceptRecordWrites(db, async (target, statements) => {
      if (first) { first = false; await applyChanges(env, 'alice', [change('intake', 'boards', { approvalGate: { stageId: 'done' } })]); }
      return target.batch(statements);
    });
    const result = await applyChanges({ ...env, DB: raced }, 'bob', [change('racing', 'tasks', { status: 'done' })], { event: { source: 'client', ctx } });
    expect(result.changed).toBe(0);
    expect(result.partialError).toBeTruthy();
    expect(JSON.parse((await db.prepare("SELECT data FROM records WHERE id='racing'").first<{ data: string }>())!.data).status).toBe('todo');
    expect(await taskEvents()).toBe(0);
  });
});
