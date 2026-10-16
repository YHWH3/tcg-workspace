import { readFileSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canEdit, canManageMembers, canRead, effectiveSpaceRole } from '../shared/access';
import { accessFence, loadAccessContext, MAX_ACCESS_SPACES, readableSpaceIds, spaceAccess } from '../worker/access';
import { createSpace, setSpaceMember } from '../worker/spaces';
import { loadScopeGraph, readAuthorizedRecords } from '../worker/recordAccess';

const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
const migrations = readdirSync(folder).filter(name => name.endsWith('.sql')).sort();
const foundation = '0012_phase5_access_foundation.sql';
let runtime: Miniflare;
let db: D1Database;

async function migrate(names = migrations) {
  for (const name of names) {
    const sql = readFileSync(`${folder}/${name}`, 'utf8').replace(/--[^\n]*/g, '');
    const statements = sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi) ?? [];
    await db.batch(statements.map(statement => db.prepare(statement.trim())));
  }
}
async function generation() {
  return (await db.prepare('SELECT generation FROM access_state WHERE id=1').first<{ generation: number }>())!.generation;
}
async function user(id: string, role: 'admin' | 'member' = 'member', workspaceRole: string | null = null) {
  await db.prepare('INSERT INTO users(id,username,name,role,workspace_role,created_at) VALUES(?,?,?,?,?,?)')
    .bind(id, id, id, role, workspaceRole, 100).run();
}
async function space(id: string, access = 'private') {
  await db.prepare('INSERT INTO spaces(id,name,default_access,created_at) VALUES(?,?,?,?)').bind(id, id, access, 100).run();
}
async function member(spaceId: string, userId: string, role = 'viewer', access = 'allow') {
  await db.prepare(`INSERT INTO space_members(space_id,user_id,role,access) VALUES(?,?,?,?)
    ON CONFLICT(space_id,user_id) DO UPDATE SET role=excluded.role,access=excluded.access`)
    .bind(spaceId, userId, role, access).run();
}

beforeEach(async () => {
  runtime = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'phase5-access', modules: true, script: 'export default {fetch(){return new Response("disposable access fixture")}}',
    compatibilityDate: '2026-09-25', d1Databases: { DB: 'disposable-phase5-access' },
  }] }));
  db = await runtime.getD1Database('DB') as D1Database;
});

describe('audited space administration foundation in actual D1', () => {
  async function setup() {
    await migrate(); await user('alice'); await user('bob'); await user('guest', 'member', 'guest');
    return createSpace(db, 'alice', { name: 'Partner', requestId: 'create-partner' });
  }

  it('creates a private, export-disabled space with an explicit owner and one audit entry', async () => {
    const created = await setup();
    expect(await db.prepare('SELECT name,default_access,export_policy,created_by FROM spaces WHERE id=?').bind(created.spaceId).first())
      .toEqual({ name: 'Partner', default_access: 'private', export_policy: 'disabled', created_by: 'alice' });
    const context = await loadAccessContext(db, 'alice', [created.spaceId]);
    expect(effectiveSpaceRole(spaceAccess(context, created.spaceId))).toBe('owner');
    expect(readableSpaceIds(await loadAccessContext(db, 'bob', [created.spaceId]))).toEqual([]);
    expect((await db.prepare('SELECT COUNT(*) n FROM access_audit').first<{ n: number }>())!.n).toBe(1);
    expect(created.generation).toBe(context.generation);
  });

  it('refuses guest, disabled and nonexistent creators and validates input before writing', async () => {
    await migrate(); await user('guest', 'member', 'guest'); await user('disabled');
    await db.prepare("UPDATE users SET disabled_at=1 WHERE id='disabled'").run();
    for (const id of ['guest', 'disabled', 'missing']) await expect(createSpace(db, id, { name: 'Private', requestId: 'deny' })).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    await user('alice');
    for (const input of [{ name: ' ', requestId: 'x' }, { name: 'A', requestId: '' }, { name: 'A', requestId: 'x\n' }, { name: 'x'.repeat(121), requestId: 'x' }]) {
      await expect(createSpace(db, 'alice', input)).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    }
    expect((await db.prepare('SELECT COUNT(*) n FROM spaces').first<{ n: number }>())!.n).toBe(1);
  });

  it('replays concurrent identical creates once and rejects reuse with different arguments', async () => {
    await migrate(); await user('alice');
    const results = await Promise.all([1, 2].map(() => createSpace(db, 'alice', { name: 'Partner', requestId: 'same' })));
    expect(results[0].spaceId).toBe(results[1].spaceId);
    expect((await db.prepare('SELECT COUNT(*) n FROM spaces').first<{ n: number }>())!.n).toBe(2);
    expect((await db.prepare('SELECT COUNT(*) n FROM access_audit').first<{ n: number }>())!.n).toBe(1);
    await expect(createSpace(db, 'alice', { name: 'Different', requestId: 'same' })).rejects.toMatchObject({ code: 'request_id_reused', status: 409 });
  });

  it('audits grant, downgrade, deny, remove and regrant without granting default guest access', async () => {
    const { spaceId } = await setup();
    for (const [requestId, membership] of [
      ['grant', { role: 'editor', access: 'allow' }], ['downgrade', { role: 'viewer', access: 'allow' }],
      ['deny', { role: 'viewer', access: 'deny' }], ['remove', null], ['regrant', { role: 'commenter', access: 'allow' }],
    ] as const) {
      await setSpaceMember(db, 'alice', { spaceId, targetUserId: 'guest', membership, requestId });
      const current = spaceAccess(await loadAccessContext(db, 'guest', [spaceId]), spaceId);
      expect(effectiveSpaceRole(current)).toBe(membership?.access === 'allow' ? membership.role : null);
    }
    const audits = (await db.prepare("SELECT action,before_json,after_json FROM access_audit WHERE action='set_member' ORDER BY rowid").all<{ action: string; before_json: string; after_json: string }>()).results;
    expect(audits).toHaveLength(5);
    expect(JSON.parse(audits[0].before_json)).toBeNull();
    expect(JSON.parse(audits[1].before_json)).toEqual({ role: 'editor', access: 'allow' });
    expect(JSON.parse(audits[3].after_json)).toBeNull();
  });

  it('prevents viewer/editor/guest administration and admin-to-owner/admin privilege escalation', async () => {
    const { spaceId } = await setup();
    for (const role of ['viewer', 'editor'] as const) {
      await member(spaceId, 'bob', role);
      await expect(setSpaceMember(db, 'bob', { spaceId, targetUserId: 'guest', membership: { role: 'editor', access: 'allow' }, requestId: role })).rejects.toMatchObject({ code: 'forbidden' });
    }
    await member(spaceId, 'bob', 'admin');
    for (const targetUserId of ['bob', 'guest']) for (const role of ['owner', 'admin'] as const) {
      await expect(setSpaceMember(db, 'bob', { spaceId, targetUserId, membership: { role, access: 'allow' }, requestId: `grant-${targetUserId}-${role}` })).rejects.toMatchObject({ code: 'forbidden' });
    }
    await expect(setSpaceMember(db, 'bob', { spaceId, targetUserId: 'alice', membership: null, requestId: 'remove-owner' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(setSpaceMember(db, 'alice', { spaceId, targetUserId: 'guest', membership: { role: 'admin', access: 'allow' }, requestId: 'guest-admin' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('does not remove or downgrade the last owner and does not emit an audit for denied changes', async () => {
    const { spaceId } = await setup();
    for (const membership of [null, { role: 'viewer', access: 'allow' }, { role: 'viewer', access: 'deny' }] as const) {
      await expect(setSpaceMember(db, 'alice', { spaceId, targetUserId: 'alice', membership, requestId: `last-${membership?.access ?? 'remove'}` })).rejects.toMatchObject({ code: 'last_space_owner', status: 409 });
    }
    expect((await db.prepare('SELECT COUNT(*) n FROM access_audit').first<{ n: number }>())!.n).toBe(1);
    expect(effectiveSpaceRole(spaceAccess(await loadAccessContext(db, 'alice', [spaceId]), spaceId))).toBe('owner');
  });

  it('serializes concurrent owner removals without ending with no owner', async () => {
    const { spaceId } = await setup(); await member(spaceId, 'bob', 'owner');
    const results = await Promise.allSettled([
      setSpaceMember(db, 'alice', { spaceId, targetUserId: 'bob', membership: null, requestId: 'remove-bob' }),
      setSpaceMember(db, 'bob', { spaceId, targetUserId: 'alice', membership: null, requestId: 'remove-alice' }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await db.prepare("SELECT COUNT(*) n FROM space_members WHERE space_id=? AND role='owner' AND access='allow'").bind(spaceId).first<{ n: number }>())!.n).toBe(1);
    expect((await db.prepare("SELECT COUNT(*) n FROM access_audit WHERE action='set_member'").first<{ n: number }>())!.n).toBe(1);
  });

  function failBatchAt(database: D1Database, batchNumber: number, afterCommit: boolean): D1Database {
    let count = 0;
    return new Proxy(database, { get(target, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        const fail = ++count === batchNumber;
        if (fail && !afterCommit) throw new Error('injected before commit');
        const result = await target.batch(statements);
        if (fail) throw new Error('injected lost commit acknowledgement');
        return result;
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
  }

  it('recovers a lost creation response and retries a precommit crash without orphan spaces or owners', async () => {
    await migrate(); await user('alice');
    const input = { name: 'Partner', requestId: 'lost-create' };
    const recovered = await createSpace(failBatchAt(db, 2, true), 'alice', input);
    expect(recovered.replayed).toBe(true);
    expect((await createSpace(db, 'alice', input)).spaceId).toBe(recovered.spaceId);
    await expect(createSpace(failBatchAt(db, 2, false), 'alice', { name: 'Crash', requestId: 'before-create' })).rejects.toThrow('injected before commit');
    await createSpace(db, 'alice', { name: 'Crash', requestId: 'before-create' });
    expect((await db.prepare('SELECT COUNT(*) n FROM spaces').first<{ n: number }>())!.n).toBe(3);
    expect((await db.prepare('SELECT COUNT(*) n FROM access_audit').first<{ n: number }>())!.n).toBe(2);
  });

  it('recovers a lost membership response without duplicating journal or generation changes', async () => {
    const { spaceId } = await setup();
    const input = { spaceId, targetUserId: 'bob', membership: { role: 'editor', access: 'allow' } as const, requestId: 'lost-grant' };
    const result = await setSpaceMember(failBatchAt(db, 3, true), 'alice', input);
    expect(result.replayed).toBe(true); const epoch = await generation();
    expect(await setSpaceMember(db, 'alice', input)).toMatchObject({ replayed: true, generation: epoch });
    expect(await generation()).toBe(epoch);
    expect((await db.prepare("SELECT COUNT(*) n FROM access_audit WHERE action='set_member'").first<{ n: number }>())!.n).toBe(1);
    await expect(setSpaceMember(db, 'alice', { ...input, membership: { role: 'viewer', access: 'allow' } })).rejects.toMatchObject({ code: 'request_id_reused' });
  });

  it('reauthorizes idempotent replay instead of returning a stale administration result', async () => {
    const { spaceId } = await setup();
    await setSpaceMember(db, 'alice', { spaceId, targetUserId: 'bob', membership: { role: 'viewer', access: 'allow' }, requestId: 'old-grant' });
    await member(spaceId, 'alice', 'viewer');
    await expect(setSpaceMember(db, 'alice', { spaceId, targetUserId: 'bob', membership: { role: 'viewer', access: 'allow' }, requestId: 'old-grant' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(createSpace(db, 'alice', { name: 'Partner', requestId: 'create-partner' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('bounded authoritative record graph reads in actual D1', () => {
  async function put(id: string, collection: string, data: Record<string, unknown>, spaceId = 'space-core') {
    await db.prepare('INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES(?,?,?,?,?,?)')
      .bind(id, collection, JSON.stringify(data), '{}', 1, spaceId).run();
  }
  async function fixture() {
    await migrate(); await user('alice'); await user('guest', 'member', 'guest'); await space('private');
    await put('page', 'pages', { title: 'Public within Core' });
    await put('secret', 'pages', { title: 'Private title' }, 'private');
    await put('body', 'blocks', { pageId: 'secret', spaceId: 'space-core', text: 'Private body' });
    await put('comment', 'comments', { targetType: 'block', targetId: 'body', body: 'Private comment' });
  }

  it('resolves true parent ownership rather than a forged or stale denormalized child space', async () => {
    await fixture();
    const graph = await loadScopeGraph(db, ['body', 'comment']);
    expect(JSON.stringify([...graph.records.values()])).not.toContain('Private');
    const denied = await readAuthorizedRecords(db, 'alice', ['page', 'secret', 'body', 'comment', 'guessed']);
    expect([...denied.records.keys()]).toEqual(['page']);
    expect(JSON.stringify([...denied.records.values()])).not.toContain('Private');
    await member('private', 'alice', 'viewer');
    const allowed = await readAuthorizedRecords(db, 'alice', ['body', 'comment']);
    expect([...allowed.records.keys()]).toEqual(['body', 'comment']);
    expect(allowed.records.get('body')?.scope.spaceId).toBe('private');
    expect(allowed.records.get('body')?.data.text).toBe('Private body');
  });

  it('does not reveal links when only one endpoint is readable and does reveal them after a valid regrant', async () => {
    await fixture(); await put('link', 'links', { fromType: 'page', fromId: 'page', toType: 'page', toId: 'secret' });
    expect((await readAuthorizedRecords(db, 'alice', ['link'])).records.size).toBe(0);
    await member('private', 'alice', 'viewer');
    expect((await readAuthorizedRecords(db, 'alice', ['link'])).records.get('link')?.scope.readSpaceIds).toEqual(['private', 'space-core']);
    await member('private', 'alice', 'viewer', 'deny');
    expect((await readAuthorizedRecords(db, 'alice', ['link'])).records.size).toBe(0);
  });

  it('hides pending public-upload metadata even from an ordinary form-space editor', async () => {
    await fixture(); await member('private', 'alice', 'editor');
    await put('board', 'boards', { name: 'Private database' }, 'private');
    await put('form', 'forms', { databaseId: 'board' });
    await put('pending-file', 'files', { parentType: 'form-pending', parentId: 'form', uploadClaimHash: 'fixture-only-hash' });
    const result = await readAuthorizedRecords(db, 'alice', ['board', 'form', 'pending-file']);
    expect([...result.records.keys()]).toEqual(['board', 'form']);
    expect(JSON.stringify([...result.records.values()])).not.toContain('fixture-only-hash');
  });

  it('terminates graph cycles and denies malformed parent types without publishing any record', async () => {
    await fixture();
    await put('a', 'pages', { parentId: 'b' }); await put('b', 'pages', { parentId: 'a' });
    await put('bad', 'tasks', { boardId: 'page' });
    const graph = await loadScopeGraph(db, ['a', 'bad']);
    expect(graph.records.size).toBe(4);
    expect((await readAuthorizedRecords(db, 'alice', ['a', 'b', 'bad'])).records.size).toBe(0);
  });

  it('rejects a graph/authorization generation race instead of authorizing a stale graph', async () => {
    await fixture(); await member('private', 'alice', 'viewer');
    let batches = 0;
    const racing = new Proxy(db, { get(target, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (++batches === 2) await member('private', 'alice', 'viewer', 'deny');
        return target.batch(statements);
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(readAuthorizedRecords(racing, 'alice', ['secret', 'body'])).rejects.toThrow('access_reset_required');
    expect((await readAuthorizedRecords(db, 'alice', ['secret', 'body'])).records.size).toBe(0);
  });

  it('rejects a reference revision changed between graph authorization and content loading', async () => {
    await fixture();
    await put('link', 'links', { fromType: 'page', fromId: 'page', toType: 'page', toId: 'page' });
    let batches = 0;
    const racing = new Proxy(db, { get(target, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (++batches === 3) await db.prepare("UPDATE records SET data=json_set(data,'$.toId','secret'),seq=seq+1 WHERE id='link'").run();
        return target.batch(statements);
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(readAuthorizedRecords(racing, 'alice', ['link'])).rejects.toThrow('access_reset_required');
    expect((await readAuthorizedRecords(db, 'alice', ['link'])).records.size).toBe(0);
  });

  it('treats nonexistent and inaccessible IDs alike and respects current disabled identity', async () => {
    await fixture();
    expect((await readAuthorizedRecords(db, 'guest', ['page', 'secret', 'guessed'])).records.size).toBe(0);
    expect((await readAuthorizedRecords(db, 'unknown', ['page', 'secret', 'guessed'])).records.size).toBe(0);
    await db.prepare("UPDATE users SET disabled_at=1 WHERE id='alice'").run();
    expect((await readAuthorizedRecords(db, 'alice', ['page'])).records.size).toBe(0);
    await expect(loadScopeGraph(db, Array.from({ length: 501 }, (_, i) => String(i)))).rejects.toThrow('invalid_scope_request');
  });

  it('deduplicates shared ancestors for 500 requested records from a 1000-record fixture in one graph batch', async () => {
    await fixture(); await put('board', 'boards', { name: 'Core records' });
    for (let start = 0; start < 1000; start += 100) {
      await db.batch(Array.from({ length: 100 }, (_, offset) => db.prepare('INSERT INTO records(id,collection,data,field_ts,seq) VALUES(?,?,?,?,?)')
        .bind(`task-${start + offset}`, 'tasks', '{"boardId":"board"}', '{}', start + offset + 10)));
    }
    let batchCount = 0, statements = 0, rowsRead = 0, rowsWritten = 0;
    const observed = new Proxy(db, { get(target, key) {
      if (key === 'batch') return async (input: D1PreparedStatement[]) => {
        batchCount++; statements += input.length;
        const result = await target.batch(input);
        for (const r of result) { rowsRead += r.meta.rows_read ?? 0; rowsWritten += r.meta.rows_written ?? 0; }
        return result;
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const ids = Array.from({ length: 500 }, (_, i) => `task-${i}`);
    const graph = await loadScopeGraph(observed, ids);
    expect(batchCount).toBe(1); expect(graph.records.size).toBe(501);
    batchCount = statements = rowsRead = rowsWritten = 0;
    const started = performance.now();
    const allowed = await readAuthorizedRecords(observed, 'alice', ids);
    const ms = Number((performance.now() - started).toFixed(2));
    expect(allowed.records.size).toBe(500); expect(batchCount).toBe(3); expect(statements).toBe(8);
    expect(rowsRead).toBeLessThan(10_000); expect(rowsWritten).toBe(0);
    const directory = process.env.CERT_ARTIFACT_DIR
      ? join(process.env.CERT_ARTIFACT_DIR, 'performance') : mkdtempSync(join(tmpdir(), 'tcg-phase5-access-'));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'phase5-access.json'), JSON.stringify({
      schemaVersion: 1, sourceSha: process.env.CERT_SOURCE_SHA ?? null,
      records: 1000, requested: 500, returned: allowed.records.size, runtime: process.version,
      ms, bindingCalls: batchCount, statements, rowsRead, rowsWritten,
      limitations: ['Disposable local Miniflare/D1 only', 'No production latency or billing measured', 'Fixture setup excluded'],
    }, null, 2));
  });
});
afterEach(async () => { await runtime?.dispose(); });

describe('Phase 5 additive migration and real D1 authority', () => {
  it('fresh migration keeps activation off and never creates fictitious users or sessions', async () => {
    await migrate();
    expect(await db.prepare('SELECT * FROM access_state').first()).toEqual({ id: 1, generation: 1, enabled: 0 });
    expect(await db.prepare('SELECT id,name,default_access,export_policy FROM spaces').all()).toMatchObject({
      results: [{ id: 'space-core', name: 'Core', default_access: 'members', export_policy: 'members' }],
    });
    expect((await db.prepare('SELECT COUNT(*) n FROM users').first<{ n: number }>())!.n).toBe(0);
    expect((await db.prepare('SELECT COUNT(*) n FROM sessions').first<{ n: number }>())!.n).toBe(0);
  });

  it('upgrades seven existing accounts without rewriting credentials, sessions, records, leases or receipts', async () => {
    await migrate(migrations.filter(name => name < foundation));
    for (let i = 0; i < 7; i++) {
      await db.prepare('INSERT INTO users(id,username,name,role,password_hash,salt,prefs,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .bind(`user-${i}`, `user-${i}`, `User ${i}`, i < 2 ? 'admin' : 'member', `hash-${i}`, `salt-${i}`, '{"quietDigest":true}', 100 + i).run();
      await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
        .bind(`session-${i}`, `user-${i}`, 999999, 10).run();
    }
    await db.batch([
      db.prepare(`INSERT INTO records(id,collection,data,field_ts,seq,updated_by,updated_at)
        VALUES('record','tasks','{"title":"Keep","deleted":true}','{"title":123,"deleted":124}',77,'user-0',125)`),
      db.prepare("INSERT INTO event_outbox(id,payload,created_at,lease_id,lease_until) VALUES('event','{}',10,'event-lease',1000)"),
      db.prepare("INSERT INTO form_submissions(submission_id,form_id,state,receipt,created_at) VALUES('submission','form','accepted','private-receipt',10)"),
    ]);
    const before = await db.prepare('SELECT id,username,name,role,password_hash,salt,prefs,created_at FROM users ORDER BY id').all();
    const sessions = await db.prepare('SELECT * FROM sessions ORDER BY token_hash').all();
    const record = await db.prepare('SELECT * FROM records').first();
    await migrate([foundation]);
    expect((await db.prepare('SELECT id,username,name,role,password_hash,salt,prefs,created_at FROM users ORDER BY id').all()).results).toEqual(before.results);
    expect((await db.prepare('SELECT * FROM sessions ORDER BY token_hash').all()).results).toEqual(sessions.results);
    expect(await db.prepare('SELECT * FROM records').first()).toEqual({ ...record, space_id: 'space-core' });
    expect(await db.prepare("SELECT lease_id,lease_until FROM event_outbox WHERE id='event'").first()).toEqual({ lease_id: 'event-lease', lease_until: 1000 });
    expect(await db.prepare("SELECT state,receipt FROM form_submissions WHERE submission_id='submission'").first()).toEqual({ state: 'accepted', receipt: 'private-receipt' });
    for (let i = 0; i < 7; i++) {
      const ctx = await loadAccessContext(db, `user-${i}`, ['space-core']);
      expect(canEdit(spaceAccess(ctx, 'space-core'))).toBe(true);
      expect(ctx.principal?.workspaceRole).toBe(i === 0 ? 'owner' : i === 1 ? 'admin' : 'member');
      expect(effectiveSpaceRole(spaceAccess(ctx, 'space-core'))).toBe(i === 0 ? 'owner' : i === 1 ? 'admin' : 'editor');
    }
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('selects the earliest admin deterministically without promoting an earlier ordinary member', async () => {
    await migrate(migrations.filter(name => name < foundation));
    for (const [id, role, time] of [['member', 'member', 0], ['z-admin', 'admin', 10], ['a-admin', 'admin', 10]] as const) {
      await db.prepare('INSERT INTO users(id,username,role,created_at) VALUES(?,?,?,?)').bind(id, id, role, time).run();
    }
    await migrate([foundation]);
    expect(await db.prepare("SELECT id FROM users WHERE workspace_role='owner'").first()).toEqual({ id: 'a-admin' });
    expect(await db.prepare("SELECT created_by FROM spaces WHERE id='space-core'").first()).toEqual({ created_by: 'a-admin' });
  });

  it('guests get only explicit valid access, including denial after membership removal and regrant', async () => {
    await migrate(); await user('guest', 'member', 'guest'); await space('partner');
    let ctx = await loadAccessContext(db, 'guest', ['space-core', 'partner', 'guessed']);
    expect(readableSpaceIds(ctx)).toEqual([]);
    await member('partner', 'guest', 'commenter');
    ctx = await loadAccessContext(db, 'guest', ['space-core', 'partner']);
    expect(readableSpaceIds(ctx)).toEqual(['partner']); expect(canEdit(spaceAccess(ctx, 'partner'))).toBe(false);
    const granted = ctx.generation;
    await db.prepare("DELETE FROM space_members WHERE user_id='guest'").run();
    ctx = await loadAccessContext(db, 'guest', ['partner']);
    expect(readableSpaceIds(ctx)).toEqual([]); expect(ctx.generation).toBeGreaterThan(granted);
    await member('partner', 'guest', 'editor');
    const regrant = await loadAccessContext(db, 'guest', ['partner']);
    expect(canEdit(spaceAccess(regrant, 'partner'))).toBe(true); expect(regrant.generation).toBeGreaterThan(ctx.generation);
    await member('partner', 'guest', 'admin');
    expect(canRead(spaceAccess(await loadAccessContext(db, 'guest', ['partner']), 'partner'))).toBe(false);
  });

  it('workspace owner/admin do not bypass a private space, explicit viewer or explicit deny', async () => {
    await migrate(); await user('owner', 'admin', 'owner'); await space('private');
    let ctx = await loadAccessContext(db, 'owner', ['space-core', 'private']);
    expect(canRead(spaceAccess(ctx, 'private'))).toBe(false);
    await member('space-core', 'owner', 'viewer');
    ctx = await loadAccessContext(db, 'owner', ['space-core']);
    expect(canRead(spaceAccess(ctx, 'space-core'))).toBe(true); expect(canEdit(spaceAccess(ctx, 'space-core'))).toBe(false);
    await member('space-core', 'owner', 'owner', 'deny');
    expect(canManageMembers(spaceAccess(await loadAccessContext(db, 'owner', ['space-core']), 'space-core'))).toBe(false);
  });

  it('keeps a permission fence and its write atomic when access is revoked after preflight', async () => {
    await migrate(); await user('alice'); await space('private'); await member('private', 'alice', 'editor');
    await db.prepare("INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES('r','pages','{\"title\":\"Original\"}','{}',1,'private')").run();
    const stale = await loadAccessContext(db, 'alice', ['private']);
    expect(canEdit(spaceAccess(stale, 'private'))).toBe(true);
    await member('private', 'alice', 'viewer');
    await expect(db.batch([accessFence(db, stale), db.prepare("UPDATE records SET data='{\"title\":\"Should roll back\"}' WHERE id='r'")])).rejects.toThrow();
    expect(await db.prepare("SELECT data FROM records WHERE id='r'").first()).toEqual({ data: '{"title":"Original"}' });
    const current = await loadAccessContext(db, 'alice', ['private']);
    expect(canEdit(spaceAccess(current, 'private'))).toBe(false);
    // A fresh fence validates authority freshness, not permission to edit.
    // Callers must still check the capability before including it in a write.
    await expect(db.batch([accessFence(db, current)])).resolves.toHaveLength(1);
  });

  it('fences a transaction when the same batch changes authority before the guarded mutation', async () => {
    await migrate(); await user('alice');
    const ctx = await loadAccessContext(db, 'alice', ['space-core']);
    await expect(db.batch([
      db.prepare("UPDATE users SET disabled_at=50 WHERE id='alice'"),
      accessFence(db, ctx),
      db.prepare("INSERT INTO access_audit(id,actor_id,action,generation,created_at) VALUES('bad','alice','should-rollback',1,1)"),
    ])).rejects.toThrow();
    expect(await db.prepare("SELECT disabled_at FROM users WHERE id='alice'").first()).toEqual({ disabled_at: null });
    expect(await generation()).toBe(ctx.generation);
    expect((await db.prepare('SELECT COUNT(*) n FROM access_audit').first<{ n: number }>())!.n).toBe(0);
  });

  it('disabled, deleted and unknown accounts fail closed without sharing cached request authority', async () => {
    await migrate(); await user('alice'); await user('bob', 'member', 'guest');
    const alice = await loadAccessContext(db, 'alice', ['space-core']);
    const bob = await loadAccessContext(db, 'bob', ['space-core']);
    expect(readableSpaceIds(alice)).toEqual(['space-core']); expect(readableSpaceIds(bob)).toEqual([]);
    await db.prepare("UPDATE users SET disabled_at=0 WHERE id='alice'").run();
    const disabled = await loadAccessContext(db, 'alice', ['space-core']);
    expect(readableSpaceIds(disabled)).toEqual([]); expect(() => accessFence(db, disabled)).toThrow('permission_context_invalid');
    await db.prepare("DELETE FROM users WHERE id='alice'").run();
    const gone = await loadAccessContext(db, 'alice', ['space-core']);
    expect(gone.principal).toBeNull(); expect(readableSpaceIds(gone)).toEqual([]);
    expect(readableSpaceIds(await loadAccessContext(db, 'nobody', ['space-core']))).toEqual([]);
    await expect(db.batch([accessFence(db, alice)])).rejects.toThrow();
  });

  it('bumps epochs on authority changes, session revocation and record moves, but not profile text', async () => {
    await migrate(); await user('alice'); await space('private');
    await db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES('hash','alice',9999,1)").run();
    await db.prepare("INSERT INTO records(id,collection,data,field_ts,seq) VALUES('r','pages','{}','{}',1)").run();
    let previous = await generation();
    await db.prepare("UPDATE users SET name='New name' WHERE id='alice'").run(); expect(await generation()).toBe(previous);
    for (const sql of [
      "UPDATE users SET workspace_role='guest' WHERE id='alice'",
      "UPDATE users SET role='admin' WHERE id='alice'",
      "UPDATE users SET disabled_at=9 WHERE id='alice'",
      "UPDATE spaces SET default_access='members' WHERE id='private'",
      "UPDATE records SET space_id='private' WHERE id='r'",
      "DELETE FROM sessions WHERE token_hash='hash'",
    ]) {
      await db.prepare(sql).run(); expect(await generation()).toBe(previous + 1); previous++;
    }
    await db.prepare("UPDATE records SET space_id='private' WHERE id='r'").run(); expect(await generation()).toBe(previous);
  });

  it('activation change invalidates the preactivation fence even without an epoch change', async () => {
    await migrate(); await user('alice');
    const ctx = await loadAccessContext(db, 'alice', ['space-core']);
    await db.prepare('UPDATE access_state SET enabled=1 WHERE id=1').run();
    await expect(db.batch([accessFence(db, ctx)])).rejects.toThrow();
    expect((await loadAccessContext(db, 'alice', ['space-core'])).enabled).toBe(true);
  });

  it('rejects invalid role/default/access values and nonexistent space/user references in actual SQLite', async () => {
    await migrate(); await user('alice');
    for (const sql of [
      "UPDATE users SET workspace_role='superadmin' WHERE id='alice'",
      "UPDATE spaces SET default_access='everyone' WHERE id='space-core'",
      "INSERT INTO space_members(space_id,user_id,role,access) VALUES('space-core','alice','superadmin','allow')",
      "INSERT INTO space_members(space_id,user_id,role,access) VALUES('space-core','alice','viewer','default')",
      "INSERT INTO space_members(space_id,user_id,role) VALUES('missing','alice','viewer')",
      "INSERT INTO space_members(space_id,user_id,role) VALUES('space-core','missing','viewer')",
      "INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES('bad','pages','{}','{}',1,'missing')",
    ]) await expect(db.prepare(sql).run()).rejects.toThrow();
  });

  it('bounds access dependency loading and rejects missing schema instead of falling back to all records', async () => {
    await expect(loadAccessContext(db, 'alice', ['space-core'])).rejects.toThrow();
    await migrate(); await user('alice');
    await expect(loadAccessContext(db, '', [])).rejects.toThrow('invalid_access_request');
    await expect(loadAccessContext(db, 'alice', ['x'.repeat(65)])).rejects.toThrow('invalid_access_request');
    await expect(loadAccessContext(db, 'alice', Array.from({ length: MAX_ACCESS_SPACES + 1 }, (_, n) => `space-${n}`))).rejects.toThrow('invalid_access_request');
    const empty = await loadAccessContext(db, 'alice', []); expect(readableSpaceIds(empty)).toEqual([]);
    expect(canRead(spaceAccess(empty, 'space-core'))).toBe(false);
  });

  it('indexes a 1000-record fixture by space/sequence without requiring per-record membership reads', async () => {
    await migrate(); await user('alice'); await space('private');
    for (let start = 0; start < 1000; start += 100) {
      await db.batch(Array.from({ length: 100 }, (_, offset) => {
        const n = start + offset;
        return db.prepare('INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES(?,?,?,?,?,?)')
          .bind(`record-${n}`, 'pages', JSON.stringify({ title: `Page ${n}` }), '{}', n + 1, n % 2 ? 'private' : 'space-core');
      }));
    }
    const ctx = await loadAccessContext(db, 'alice', ['space-core', 'private']);
    expect(readableSpaceIds(ctx)).toEqual(['space-core']);
    const result = await db.prepare('SELECT id FROM records WHERE space_id=? AND seq>? ORDER BY seq LIMIT 51')
      .bind(readableSpaceIds(ctx)[0], 0).all<{ id: string }>();
    expect(result.results).toHaveLength(51); expect(result.meta.rows_read).toBeLessThan(120);
    const plan = await db.prepare('EXPLAIN QUERY PLAN SELECT id FROM records WHERE space_id=? AND seq>? ORDER BY seq LIMIT 51')
      .bind('space-core', 0).all<{ detail: string }>();
    expect(plan.results.some(row => row.detail.includes('idx_records_space_seq'))).toBe(true);
  });
});
