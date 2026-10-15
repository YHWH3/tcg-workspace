import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyChanges, sync } from '../worker/sync';
import { beginChangeset } from '../worker/changesets';
import { sha256Hex } from '../worker/password';
import type { Env } from '../worker/auth';
import type { Mutation } from '../shared/types';
import { interceptRecordWrites } from './d1WriteBoundary';

vi.mock('../worker/events', async original => ({ ...await original<typeof import('../worker/events')>(), scheduleOutbox: vi.fn() }));
let mf: Miniflare, db: D1Database, env: Env;
const ctx = { waitUntil: (_p: Promise<unknown>) => {}, passThroughOnException: () => {} } as ExecutionContext;
const change = (id: string, collection: string, patch: Record<string, unknown>): Mutation => ({ id, collection, patch, ts: 100 });
const token = (id: string) => `phase5-write-fixture-${id}`;

async function put(id: string, collection: string, data: Record<string, unknown>, space = 'private') {
  await db.prepare('INSERT INTO records(id,collection,data,field_ts,seq,space_id,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .bind(id, collection, JSON.stringify(data), JSON.stringify(Object.fromEntries(Object.keys(data).map(k => [k, 1]))), 1, space, 'owner', 1).run();
}
async function data(id: string) {
  const row = await db.prepare('SELECT data,space_id FROM records WHERE id=?').bind(id).first<{ data: string; space_id: string }>();
  return row ? { ...JSON.parse(row.data), _space: row.space_id } : null;
}

function interceptWriteBatches(before?: (index: number) => Promise<void>, after?: (index: number) => Promise<void>): D1Database {
  return interceptRecordWrites(db, async (target, statements, index) => {
    await before?.(index);
    const result = await target.batch(statements);
    await after?.(index);
    return result;
  });
}

beforeEach(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'phase5-writes', modules: true,
    script: 'export default {fetch(){return new Response("disposable write authority fixture")}}',
    compatibilityDate: '2026-09-25', d1Databases: { DB: 'disposable-phase5-writes' },
  }] }));
  db = await mf.getD1Database('DB') as D1Database;
  env = { DB: db } as Env;
  const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const name of readdirSync(folder).filter(n => n.endsWith('.sql')).sort()) {
    const sql = readFileSync(`${folder}/${name}`, 'utf8').replace(/--[^\n]*/g, '');
    await db.batch((sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi) ?? []).map(s => db.prepare(s.trim())));
  }
  await db.prepare("INSERT INTO spaces(id,name,default_access,created_at) VALUES('private','Private','private',1),('other','Other private','private',1)").run();
  for (const [id, role] of [['owner', 'owner'], ['editor', 'member'], ['viewer', 'guest'], ['commenter', 'guest'], ['outsider', 'guest']] as const) {
    await db.prepare('INSERT INTO users(id,username,name,role,workspace_role) VALUES(?,?,?,?,?)').bind(id, id, id, id === 'owner' ? 'admin' : 'member', role).run();
    await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await sha256Hex(token(id)), id, Date.now() + 30 * 86400_000, Date.now()).run();
  }
  for (const [id, role] of [['owner', 'owner'], ['editor', 'editor'], ['viewer', 'viewer'], ['commenter', 'commenter']] as const) {
    await db.prepare('INSERT INTO space_members(space_id,user_id,role) VALUES(?,?,?)').bind('private', id, role).run();
  }
  await put('board', 'boards', { name: 'Restricted database', columns: [{ id: 'open' }, { id: 'done' }], approvalGate: { stageId: 'done' } });
  await put('record', 'tasks', { boardId: 'board', title: 'Restricted Secret', status: 'open' });
  await put('page', 'pages', { title: 'Private page' });
  await put('core', 'pages', { title: 'Core page' }, 'space-core');
  await put('own-comment', 'comments', { targetType: 'task', targetId: 'record', authorId: 'commenter', body: 'Original' });
  await put('other-comment', 'comments', { targetType: 'task', targetId: 'record', authorId: 'editor', body: 'Other' });
  await db.prepare('UPDATE access_state SET enabled=1 WHERE id=1').run();
});
afterEach(async () => { await mf?.dispose(); });

describe('Phase 5 actual applyChanges and sync write enforcement', () => {
  it('returns visible conflict content only after current read authorization', async () => {
    const result = await applyChanges(env, 'editor', [change('record', 'tasks', { title: 'Stale' })], { expect: new Map([['record', 0]]) });
    expect(result.changed).toBe(0);
    expect(result.conflicts).toEqual([expect.objectContaining({ id: 'record', currentRev: 1, current: expect.objectContaining({ title: 'Restricted Secret' }) })]);
    expect((await data('record')).title).toBe('Restricted Secret');
  });

  it('counts every stale or unauthorized item in a mixed non-atomic write', async () => {
    await put('hidden', 'pages', { title: 'Hidden Secret' }, 'other');
    const result = await applyChanges(env, 'editor', [
      change('hidden', 'pages', { title: 'Denied' }),
      change('record', 'tasks', { title: 'Stale' }),
      change('core', 'pages', { title: 'Allowed' }),
    ], { expect: new Map([['record', 0]]), atomic: false });
    expect(result.changed).toBe(1); expect(result.rejected).toBe(2);
    expect(result.rejectedItems).toContainEqual(expect.objectContaining({ id: 'hidden', reason: 'not_found_or_forbidden' }));
    expect(result.conflicts).toEqual([expect.objectContaining({ id: 'record', currentRev: 1 })]);
    expect(JSON.stringify(result)).not.toContain('Hidden Secret');
    expect((await data('core')).title).toBe('Allowed');
  });

  it('fails closed when the mandatory permission state is missing', async () => {
    await db.prepare('DELETE FROM access_state').run();
    await expect(applyChanges(env, 'editor', [change('record', 'tasks', { title: 'No authority' })])).rejects.toThrow('permission_schema_unavailable');
    expect((await data('record')).title).toBe('Restricted Secret');
  });

  it('requires write access to automation destination databases and read access to templates', async () => {
    await put('destination', 'boards', { name: 'Private destination' }, 'other');
    await put('template', 'pages', { title: 'Private template', isTemplate: true }, 'other');
    for (const action of [{ type: 'create_record', databaseId: 'destination' }, { type: 'create_from_template', templateId: 'template' }]) {
      const result = await applyChanges(env, 'editor', [change('rule', 'automations', { trigger: { type: 'record_created', databaseId: 'board' }, actions: [action] })]);
      expect(result.changed).toBe(0); expect(result.rejectedItems).toContainEqual(expect.objectContaining({ reason: 'reference_unavailable' }));
    }
    await db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('other','editor','viewer')").run();
    const denied = await applyChanges(env, 'editor', [change('rule', 'automations', { trigger: { databaseId: 'board' }, actions: [{ type: 'create_record', databaseId: 'destination' }] })]);
    expect(denied.changed).toBe(0);
    const allowed = await applyChanges(env, 'editor', [change('rule', 'automations', { trigger: { databaseId: 'board' }, actions: [{ type: 'create_from_template', templateId: 'template' }] })]);
    expect(allowed.changed).toBe(1); expect(allowed.rejected).toBe(0);
  });

  it.each(['viewer', 'commenter', 'outsider'])('%s cannot edit a known private record through the shared write kernel', async actor => {
    const result = await applyChanges(env, actor, [change('record', 'tasks', { title: 'Unauthorized' })], { serverTs: true, event: { source: 'client' } });
    expect(result.changed).toBe(0); expect(result.rejected).toBeGreaterThan(0);
    expect((await data('record')).title).toBe('Restricted Secret');
    expect((await db.prepare('SELECT COUNT(*) n FROM event_outbox').first<{ n: number }>())!.n).toBe(0);
  });

  it('denies a workspace owner without private-space membership and a disabled editor', async () => {
    await db.prepare("DELETE FROM space_members WHERE user_id='owner'").run();
    await db.prepare("UPDATE users SET disabled_at=1 WHERE id='editor'").run();
    for (const actor of ['owner', 'editor', 'missing']) {
      const result = await applyChanges(env, actor, [change('record', 'tasks', { title: actor })], { serverTs: true });
      expect(result.changed).toBe(0); expect(result.rejected).toBeGreaterThan(0);
    }
  });

  it('does not disclose conflict content or approval configuration to an unauthorized caller', async () => {
    const result = await applyChanges(env, 'outsider', [change('record', 'tasks', { status: 'done' })], { expect: new Map([['record', 0]]), atomic: true });
    expect(result.changed).toBe(0); expect(result.rejected).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toMatch(/Restricted Secret|Restricted database|approval_required/);
    expect(result.conflicts ?? []).toEqual([]);
  });

  it('applies a legitimate edit and assigns the authoritative parent space to a new body block', async () => {
    const result = await applyChanges(env, 'editor', [change('record', 'tasks', { title: 'Authorized' }), change('body', 'blocks', { pageId: 'page', type: 'p', text: 'Body', spaceId: 'space-core' })], { serverTs: true, event: { source: 'mcp' } });
    expect(result.rejected).toBe(0); expect(result.changed).toBe(2);
    expect((await data('body'))._space).toBe('private');
    expect((await data('record')).title).toBe('Authorized');
  });

  it('allows own-comment writing but refuses author/target spoofing, other comments and ordinary content', async () => {
    const own = await applyChanges(env, 'commenter', [change('own-comment', 'comments', { body: 'Updated' })]);
    expect(own.changed).toBe(1);
    for (const mutation of [change('other-comment', 'comments', { body: 'Spoof' }), change('own-comment', 'comments', { authorId: 'editor' }), change('own-comment', 'comments', { targetId: 'core' }), change('record', 'tasks', { title: 'No' })]) {
      const result = await applyChanges(env, 'commenter', [mutation], { serverTs: true });
      expect(result.changed).toBe(0); expect(result.rejected).toBeGreaterThan(0);
    }
    expect((await data('own-comment')).body).toBe('Updated');
  });

  it('requires comment rights for creation and cannot mint a comment as another author', async () => {
    const valid = await applyChanges(env, 'commenter', [change('new-comment', 'comments', { targetType: 'task', targetId: 'record', authorId: 'commenter', body: 'Hello' })]);
    expect(valid.changed).toBe(1); expect((await data('new-comment'))._space).toBe('private');
    for (const [actor, authorId] of [['viewer', 'viewer'], ['commenter', 'editor']]) {
      const result = await applyChanges(env, actor, [change(`bad-${actor}`, 'comments', { targetType: 'task', targetId: 'record', authorId, body: 'Denied' })]);
      expect(result.changed).toBe(0); expect(result.rejected).toBeGreaterThan(0);
    }
  });

  it('rejects cross-space moves through generic patches until the durable move operation runs', async () => {
    const result = await applyChanges(env, 'editor', [change('page', 'pages', { spaceId: 'space-core' })]);
    expect(result.changed).toBe(0); expect(result.rejectedItems?.[0].reason).toBe('explicit_move_required');
    expect((await data('page'))._space).toBe('private');
  });

  it('does not let a caller turn source labels or an audit journal into an authorization bypass', async () => {
    for (const source of ['mcp', 'automation', 'form', 'undo'] as const) {
      const journal = beginChangeset({ userId: 'outsider', tool: 'denied', source });
      const result = await applyChanges(env, 'outsider', [change('record', 'tasks', { title: source })], { serverTs: true, journal, event: { source } });
      expect(result.changed).toBe(0); expect(result.rejected).toBeGreaterThan(0);
    }
    expect((await db.prepare('SELECT COUNT(*) n FROM changesets').first<{ n: number }>())!.n).toBe(0);
  });

  it('rejects unauthorized expected IDs even when the guarded ID is outside the mutation list', async () => {
    await put('hidden', 'pages', { title: 'Hidden Secret' }, 'other');
    const result = await applyChanges(env, 'editor', [change('core', 'pages', { title: 'Must not commit' })], { expect: new Map([['hidden', 0]]), atomic: true });
    expect(result.changed).toBe(0); expect(JSON.stringify(result)).not.toContain('Hidden Secret');
    expect(result.conflicts ?? []).toEqual([]);
    expect((await data('core')).title).toBe('Core page');
  });

  it('enforces the same restrictions on the real authenticated sync route', async () => {
    const generation = await db.prepare('SELECT generation FROM access_state WHERE id=1').first('generation');
    const response = await sync.request('http://localhost/push', { method: 'POST', headers: { authorization: `Bearer ${token('viewer')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ protocol: 2, generation, changes: [change('record', 'tasks', { title: 'HTTP attack' })] }) }, env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ rejected: 1, rejectedItems: [expect.objectContaining({ id: 'record' })] });
    expect((await data('record')).title).toBe('Restricted Secret');
  });

  it('fences concurrent membership revocation before a record, audit and outbox commit', async () => {
    const journal = beginChangeset({ userId: 'editor', tool: 'race' });
    const racing = interceptWriteBatches(async () => { await db.prepare("UPDATE space_members SET access='deny' WHERE space_id='private' AND user_id='editor'").run(); });
    const result = await applyChanges({ ...env, DB: racing }, 'editor', [change('record', 'tasks', { title: 'Race must lose' })], { journal, event: { source: 'mcp' } });
    expect(result.changed).toBe(0); expect(result.partialError).toBeTruthy();
    expect((await data('record')).title).toBe('Restricted Secret');
    for (const table of ['event_outbox', 'changesets', 'changeset_items']) expect((await db.prepare(`SELECT COUNT(*) n FROM ${table}`).first<{ n: number }>())!.n).toBe(0);
  });

  it('fences parent deletion even when the permission generation and parent space do not change', async () => {
    const racing = interceptWriteBatches(async () => { await db.prepare("UPDATE records SET data=json_set(data,'$.deleted',json('true')),seq=seq+1 WHERE id='page'").run(); });
    const result = await applyChanges({ ...env, DB: racing }, 'editor', [change('new-body', 'blocks', { pageId: 'page', text: 'Cannot attach' })], { event: { source: 'client' } });
    expect(result.changed).toBe(0); expect(result.partialError).toBeTruthy(); expect(await data('new-body')).toBeNull();
  });

  it('fences a relation target change without returning newly inaccessible content', async () => {
    await put('hidden', 'pages', { title: 'Hidden Secret' }, 'other');
    await put('link', 'links', { fromType: 'page', fromId: 'core', toType: 'page', toId: 'core' }, 'space-core');
    const racing = interceptWriteBatches(async () => { await db.prepare("UPDATE records SET data=json_set(data,'$.toId','hidden'),seq=seq+1 WHERE id='link'").run(); });
    const result = await applyChanges({ ...env, DB: racing }, 'editor', [change('link', 'links', { label: 'Cannot update hidden link' })], { expect: new Map([['link', 1]]) });
    expect(result.changed).toBe(0); expect(result.partialError).toBeTruthy(); expect(JSON.stringify(result)).not.toContain('Hidden Secret');
    expect((await data('link')).label).toBeUndefined();
  });

  it('does not attach a child to an ID another actor acquired after parent-creation preflight', async () => {
    const racing = interceptWriteBatches(async () => { await put('new-page', 'pages', { title: 'Other owner secret' }, 'other'); });
    const result = await applyChanges({ ...env, DB: racing }, 'editor', [
      change('child', 'blocks', { pageId: 'new-page', text: 'Must not commit' }),
      change('new-page', 'pages', { title: 'Our proposed parent', spaceId: 'private' }),
    ]);
    expect(result.changed).toBe(0); expect(result.partialError).toBeTruthy(); expect(await data('child')).toBeNull();
    expect((await data('new-page')).title).toBe('Other owner secret');
  });

  it('keeps exact partial audit/outbox/checkpoints and resumes after a 100-row commit followed by revocation', async () => {
    await db.prepare('CREATE TABLE write_checkpoints(id TEXT PRIMARY KEY)').run();
    const journal = beginChangeset({ userId: 'editor', tool: 'partial-authorization' });
    const mutations = Array.from({ length: 150 }, (_, i) => change(`body-${i}`, 'blocks', { pageId: 'page', type: 'p', text: `Paragraph ${i}` }));
    const execution = { guard: () => db.prepare('SELECT 1'), checkpoint: (id: string) => db.prepare('INSERT OR IGNORE INTO write_checkpoints(id) VALUES(?)').bind(id) };
    const racing = interceptWriteBatches(undefined, async index => { if (index === 1) await db.prepare("UPDATE space_members SET access='deny' WHERE space_id='private' AND user_id='editor'").run(); });
    const result = await applyChanges({ ...env, DB: racing }, 'editor', mutations, { journal, execution, event: { source: 'mcp' }, createOnly: new Set(mutations.map(m => m.id)) });
    expect(result.changed).toBe(100); expect(result.applied).toHaveLength(100); expect(result.partialError).toBeTruthy();
    for (const table of ['event_outbox', 'changeset_items', 'write_checkpoints']) expect((await db.prepare(`SELECT COUNT(*) n FROM ${table}`).first<{ n: number }>())!.n).toBe(100);
    expect((await db.prepare('SELECT item_count FROM changesets WHERE id=?').bind(journal.id).first<{ item_count: number }>())!.item_count).toBe(100);
    await db.prepare("UPDATE space_members SET access='allow' WHERE space_id='private' AND user_id='editor'").run();
    const resumed = await applyChanges(env, 'editor', mutations, { journal, execution, event: { source: 'mcp' }, createOnly: new Set(mutations.map(m => m.id)) });
    expect(resumed.changed).toBe(50); expect(resumed.partialError).toBeUndefined();
    for (const table of ['event_outbox', 'changeset_items', 'write_checkpoints']) expect((await db.prepare(`SELECT COUNT(*) n FROM ${table}`).first<{ n: number }>())!.n).toBe(150);
  });

  it('recovers a lost committed write response with exact journal evidence and an idempotent retry', async () => {
    const journal = beginChangeset({ userId: 'editor', tool: 'lost-response' });
    const mutation = change('new-body', 'blocks', { pageId: 'page', text: 'Once' });
    const lost = interceptWriteBatches(undefined, async () => { throw new Error('injected lost response'); });
    const result = await applyChanges({ ...env, DB: lost }, 'editor', [mutation], { journal, event: { source: 'mcp' }, createOnly: new Set(['new-body']) });
    expect(result.changed).toBe(1); expect(result.applied).toHaveLength(1); expect(result.partialError).toContain('injected lost response');
    const retried = await applyChanges(env, 'editor', [mutation], { journal, event: { source: 'mcp' }, createOnly: new Set(['new-body']) });
    expect(retried.changed).toBe(0);
    for (const table of ['event_outbox', 'changeset_items']) expect((await db.prepare(`SELECT COUNT(*) n FROM ${table}`).first<{ n: number }>())!.n).toBe(1);
  });

  it('accepts a new parent and child in either request order with server-derived scope', async () => {
    for (const childFirst of [true, false]) {
      const id = childFirst ? 'first' : 'last';
      const parent = change(`parent-${id}`, 'pages', { title: 'Parent', spaceId: 'private' });
      const child = change(`child-${id}`, 'blocks', { pageId: parent.id, text: 'Child', spaceId: 'space-core' });
      const result = await applyChanges(env, 'editor', childFirst ? [child, parent] : [parent, child]);
      expect(result.rejected).toBe(0); expect(result.changed).toBe(2);
      expect((await data(child.id))._space).toBe('private');
    }
  });

  it('does not commit a proposed parent denied by authorization or protected-field validation', async () => {
    const result = await applyChanges(env, 'editor', [change('bad-parent', 'pages', { title: 'Denied', spaceId: 'private', _spaceId: 'other' }), change('bad-child', 'blocks', { pageId: 'bad-parent', text: 'Must not commit' })]);
    expect(result.changed).toBe(0); expect(result.rejected).toBe(2);
    expect(await data('bad-parent')).toBeNull(); expect(await data('bad-child')).toBeNull();
  });

  it.each([0, 1])('P5-SEC-01: cannot bypass a proposed approval gate with activation=%i and task before board', async activation => {
    await db.prepare('UPDATE access_state SET enabled=? WHERE id=1').bind(activation).run();
    const result = await applyChanges(env, 'editor', [
      change('gated-new-record', 'tasks', { boardId: 'gated-new-board', title: 'Must await approval', status: 'done' }),
      change('gated-new-board', 'boards', { name: 'New gate', spaceId: 'private', columns: [{ id: 'open' }, { id: 'done' }], approvalGate: { stageId: 'done' } }),
    ], { atomic: true });
    expect(result.changed).toBe(0); expect(result.rejectedItems).toContainEqual(expect.objectContaining({ id: 'gated-new-record', reason: 'approval_required' }));
    expect(await data('gated-new-record')).toBeNull(); expect(await data('gated-new-board')).toBeNull();
  });
});
