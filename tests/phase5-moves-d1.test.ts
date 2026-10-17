// Explicit cross-space moves, relations and eviction facts on actual D1
// (docs/architecture/phase-5-per-space-feeds.md §3.4, §3.6), proven through the real
// feed with the reference client (tests/feedClient.ts).
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sync, applyChanges } from '../worker/sync';
import { spacesApi } from '../worker/spacesApi';
import { loadManifest } from '../worker/spaceFeed';
import { moveRoot, SpaceMoveError } from '../worker/spaceMove';
import { pruneSpaceEvents, EVENT_RETENTION_MS } from '../worker/spaceEvents';
import { sha256Hex } from '../worker/password';
import type { Env } from '../worker/auth';
import type { PullRequestV3 } from '../shared/protocol';
import { interceptD1Batches } from './d1WriteBoundary';
import { RefClient } from './feedClient';

vi.mock('../worker/events', async original => ({ ...await original<typeof import('../worker/events')>(), scheduleOutbox: vi.fn() }));
let mf: Miniflare, db: D1Database, env: Env, seq: number;
const ctx = { waitUntil: (_p: Promise<unknown>) => {}, passThroughOnException: () => {} } as ExecutionContext;
const token = (id: string) => `moves-fixture-${id}`;
const headers = (actor: string) => ({ authorization: `Bearer ${token(actor)}`, 'content-type': 'application/json' });

async function put(id: string, collection: string, data: Record<string, unknown>, space: string, peer: string | null = null) {
  await db.prepare('INSERT INTO records(id,collection,data,field_ts,seq,space_id,peer_space_id) VALUES(?,?,?,?,?,?,?)')
    .bind(id, collection, JSON.stringify(data), JSON.stringify(Object.fromEntries(Object.keys(data).map(k => [k, 1]))), ++seq, space, peer).run();
}
const member = (space: string, user: string, role = 'editor', access = 'allow') =>
  db.prepare('INSERT INTO space_members(space_id,user_id,role,access) VALUES(?,?,?,?) ON CONFLICT(space_id,user_id) DO UPDATE SET role=excluded.role,access=excluded.access').bind(space, user, role, access).run();
const row = async (id: string) => db.prepare('SELECT id,space_id,peer_space_id,seq FROM records WHERE id=?').bind(id).first<{ id: string; space_id: string; peer_space_id: string | null; seq: number }>();
const events = async () => (await db.prepare('SELECT space_id,seq,record_id FROM space_events ORDER BY seq,record_id').all<{ space_id: string; seq: number; record_id: string }>()).results;
const maxSeq = async () => Number(await db.prepare('SELECT MAX(seq) n FROM records').first('n'));
/** The next revision, allocated exactly as the write path does (never below the floor). */
const nextSeq = async () => Number(await db.prepare('SELECT MAX((SELECT COALESCE(MAX(seq),0) FROM records),(SELECT floor FROM seq_floor WHERE id=1))+1 n').first('n'));
const user = (id: string) => ({ id, tokenHash: undefined as string | undefined });
async function client(actor: string) {
  const c = new RefClient(async (request: PullRequestV3) => {
    const response = await sync.request('http://localhost/pull', { method: 'POST', headers: headers(actor), body: JSON.stringify(request) }, env, ctx);
    return { status: response.status, body: await response.json() as any };
  });
  c.reconcile((await loadManifest(db, actor)).manifest); return c;
}
const MOVED = ['P', 'P2', 'b1', 'b2', 'b3', 'c1', 'f1'];

beforeEach(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'phase5-moves', modules: true,
    script: 'export default {fetch(){return new Response("disposable move fixture")}}', compatibilityDate: '2026-09-25', d1Databases: { DB: 'disposable-phase5-moves' } }] }));
  db = await mf.getD1Database('DB') as D1Database; env = { DB: db } as Env; seq = 0;
  const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const name of readdirSync(folder).filter(n => n.endsWith('.sql')).sort()) {
    const sql = readFileSync(`${folder}/${name}`, 'utf8').replace(/--[^\n]*/g, '');
    await db.batch((sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi) ?? []).map(s => db.prepare(s.trim())));
  }
  await db.prepare("INSERT INTO spaces(id,name,default_access,created_at) VALUES('s1','One','private',1),('s2','Two','private',1),('s3','Three','private',1)").run();
  for (const [id, role] of [['alice', 'member'], ['bob', 'member'], ['carol', 'member'], ['guest', 'guest']] as const) {
    await db.prepare('INSERT INTO users(id,username,name,role,workspace_role) VALUES(?,?,?,?,?)').bind(id, id, id, 'member', role).run();
    await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await sha256Hex(token(id)), id, Date.now() + 86_400_000, Date.now()).run();
  }
  await member('s1', 'alice'); await member('s2', 'alice'); await member('s1', 'bob', 'viewer'); await member('s2', 'carol', 'viewer');
  await member('s1', 'guest'); await member('s2', 'guest');
  // A page subtree in s1 (root P, nested page P2, blocks, a comment, an attachment) ...
  await put('P', 'pages', { title: 'Plan' }, 's1'); await put('P2', 'pages', { title: 'Nested', parentId: 'P' }, 's1');
  await put('b1', 'blocks', { pageId: 'P', text: 'one' }, 's1'); await put('b2', 'blocks', { pageId: 'P', text: 'two' }, 's1'); await put('b3', 'blocks', { pageId: 'P2', text: 'three' }, 's1');
  await put('c1', 'comments', { targetType: 'page', targetId: 'P', body: 'hi', authorId: 'alice' }, 's1');
  await put('f1', 'files', { parentType: 'block', parentId: 'b1', name: 'x.png' }, 's1');
  // ... a page in s2, and a relation from P to it (home s1, peer s2).
  await put('Q', 'pages', { title: 'Other plan' }, 's2'); await put('stay', 'pages', { title: 'Stays' }, 's1');
  await put('L1', 'links', { fromType: 'page', fromId: 'P', toType: 'page', toId: 'Q', kind: 'related' }, 's1', 's2');
  await db.prepare('UPDATE access_state SET enabled=1 WHERE id=1').run();
});
afterEach(async () => { await mf?.dispose(); });

describe('moving a root with its closure', () => {
  it('re-stamps the whole closure with distinct new revisions and writes one eviction fact per moved row', async () => {
    const before = await maxSeq();
    const result = await moveRoot(db, user('alice'), { recordId: 'P', toSpaceId: 's2', requestId: 'move-1' });
    expect(result).toMatchObject({ recordId: 'P', fromSpaceId: 's1', toSpaceId: 's2', moved: 7, links: 1, replayed: false });
    const seqs: number[] = [];
    for (const id of MOVED) { const r = (await row(id))!; expect(r.space_id, id).toBe('s2'); seqs.push(r.seq); }
    const link = (await row('L1'))!;
    expect(link).toMatchObject({ space_id: 's2', peer_space_id: null }); // both endpoints now in s2
    seqs.push(link.seq);
    expect(new Set(seqs).size).toBe(8); expect(Math.min(...seqs)).toBeGreaterThan(before);
    expect(await events()).toEqual([...MOVED, 'L1'].map(id => ({ space_id: 's1', seq: id === 'L1' ? link.seq : seqs[MOVED.indexOf(id)], record_id: id })).sort((a, b) => a.seq - b.seq || (a.record_id < b.record_id ? -1 : 1)));
    expect((await row('stay'))!.space_id).toBe('s1'); expect((await row('Q'))!.space_id).toBe('s2'); // untouched
    // The next ordinary write is allocated above every moved revision.
    await db.prepare("INSERT INTO users(id,username,name,role) VALUES('writer','writer','w','member')").run();
    expect((await applyChanges(env, 'writer', [{ id: 'fresh', collection: 'pages', patch: { title: 'x' }, ts: Date.now() }])).changed).toBe(1);
    expect((await row('fresh'))!.seq).toBeGreaterThan(Math.max(...seqs));
    expect(await db.prepare("SELECT action,space_id FROM access_audit WHERE request_id='move-1'").first()).toEqual({ action: 'move_record', space_id: 's1' });
  });

  it('every audience converges: the source-only reader loses the subtree, the destination-only reader gains it, a reader of both keeps it once', async () => {
    const bob = await client('bob'), carol = await client('carol'), alice = await client('alice');
    await Promise.all([bob.sync(), carol.sync(), alice.sync()]);
    expect(bob.ids()).toEqual(['P', 'P2', 'b1', 'b2', 'b3', 'c1', 'f1', 'stay']);
    expect(carol.ids()).toEqual(['Q']);
    expect(alice.ids()).toEqual(['L1', ...MOVED, 'Q', 'stay'].sort());
    await moveRoot(db, user('alice'), { recordId: 'P', toSpaceId: 's2', requestId: 'move-2' });
    for (const limit of [8, 500]) {
      for (const [c, label] of [[bob, 'bob'], [carol, 'carol'], [alice, 'alice']] as const) { await c.sync(limit); void label; }
    }
    expect(bob.ids()).toEqual(['stay']);                               // read s1 only: the subtree and the relation left
    expect(carol.ids()).toEqual(['L1', ...MOVED, 'Q'].sort());         // read s2 only: everything arrived, incl. the relation (both ends in s2 now)
    expect(alice.ids()).toEqual(['L1', ...MOVED, 'Q', 'stay'].sort()); // read both: nothing lost or duplicated
    for (const id of MOVED) expect(alice.live.get(id)!.spaceId, id).toBe('s2');
  });

  it('moving out and back is order-independent: stale clients end with the rows in the space they are in now', async () => {
    for (const limit of [8, 9, 12, 500]) {
      await db.exec("DELETE FROM space_events"); // not part of the property: keep each iteration independent
      const stale = await client('alice'); await stale.sync();
      await moveRoot(db, user('alice'), { recordId: 'P', toSpaceId: 's2', requestId: `out-${limit}` });
      await moveRoot(db, user('alice'), { recordId: 'P', toSpaceId: 's1', requestId: `back-${limit}` });
      await stale.sync(limit);
      for (const id of MOVED) { expect(stale.live.has(id), `${id} at limit ${limit}`).toBe(true); expect(stale.live.get(id)!.spaceId).toBe('s1'); }
      expect(stale.ids()).toEqual(['L1', ...MOVED, 'Q', 'stay'].sort());
    }
  });

  it('a client that applies an old eviction AFTER the newer row keeps the row (the revision rule)', async () => {
    const alice = await client('alice'); await alice.sync();
    await moveRoot(db, user('alice'), { recordId: 'P', toSpaceId: 's2', requestId: 'out' });
    await moveRoot(db, user('alice'), { recordId: 'P', toSpaceId: 's1', requestId: 'back' });
    const reply = await alice.step(500);
    expect(reply.status).toBe(200);
    // The page carries the row at its newest revision AND the stale s1 eviction facts from the first move.
    expect(reply.body.evictions.some((e: { id: string; spaceId: string }) => e.id === 'P' && e.spaceId === 's1')).toBe(true);
    expect(alice.live.get('P')!.spaceId).toBe('s1');
  });
});

describe('relations across spaces', () => {
  it('moving ONE endpoint re-homes the relation: it is readable only to those who read both new spaces', async () => {
    await put('R', 'pages', { title: 'Lonely' }, 's1'); await put('L2', 'links', { fromType: 'page', fromId: 'R', toType: 'page', toId: 'P' }, 's1');
    await member('s3', 'bob', 'viewer'); await member('s3', 'alice');
    const bob = await client('bob'); await bob.sync();
    expect(bob.live.has('L2')).toBe(true);                       // R and P both in s1, bob reads s1
    await moveRoot(db, user('alice'), { recordId: 'R', toSpaceId: 's3', requestId: 'm' });
    expect(await row('L2')).toMatchObject({ space_id: 's3', peer_space_id: 's1' }); // from R (s3), to P (s1)
    await bob.sync();
    expect(bob.live.has('L2')).toBe(true);                       // bob reads s3 and s1: still both
    await db.prepare("DELETE FROM space_members WHERE space_id='s3' AND user_id='bob'").run(); await bob.sync();
    expect(bob.live.has('L2')).toBe(false); expect(bob.live.has('R')).toBe(false); expect(bob.live.has('P')).toBe(true);
  });

  it('moving the OTHER endpoint updates the relation\'s peer; its home stays where its FROM record is', async () => {
    await member('s3', 'alice');
    await moveRoot(db, user('alice'), { recordId: 'Q', toSpaceId: 's3', requestId: 'm' });
    // Q moved s2 -> s3; the relation P(s1) -> Q is now home s1, peer s3.
    expect(await row('L1')).toMatchObject({ space_id: 's1', peer_space_id: 's3' });
  });

  it('a reader of s1 and s2 (not s3) loses the relation to the moved endpoint by an explicit fact, with no client-side sweep', async () => {
    await member('s3', 'alice');
    const bob = await client('bob'); await member('s2', 'bob', 'viewer'); await bob.sync();   // bob: s1 + s2
    expect(bob.live.has('L1')).toBe(true); expect(bob.live.has('Q')).toBe(true);
    await moveRoot(db, user('alice'), { recordId: 'Q', toSpaceId: 's3', requestId: 'm' });
    const l1 = await row('L1');
    expect(await events()).toContainEqual({ space_id: 's1', seq: l1!.seq, record_id: 'L1' });   // the fact for the home every holder can read
    await bob.sync();
    expect(bob.live.has('Q')).toBe(false); expect(bob.live.has('L1')).toBe(false); expect(bob.live.has('P')).toBe(true);
    expect(bob.dangling()).toEqual([]);
  });

  it('retargeting a relation emits eviction facts for its previous home and peer at the new revision', async () => {
    const revised = await nextSeq();
    await db.prepare("UPDATE records SET data=json_set(data,'$.toId','stay'), peer_space_id=NULL, seq=? WHERE id='L1'").bind(revised).run();
    const e = await events();
    expect(e).toEqual([{ space_id: 's1', seq: revised, record_id: 'L1' }, { space_id: 's2', seq: revised, record_id: 'L1' }]);
    const carol = await client('carol'); await carol.sync(); expect(carol.live.has('L1')).toBe(false);
  });
});

describe('who may move what', () => {
  const attempt = (actor: string, input: Record<string, unknown>) => moveRoot(db, user(actor), { recordId: 'P', toSpaceId: 's2', requestId: `r-${Math.random()}`, ...input } as never);
  const code = async (promise: Promise<unknown>) => { try { await promise; return 'moved'; } catch (error) { return error instanceof SpaceMoveError ? `${error.code}:${error.status}` : String(error); } };

  it.each([
    ['a viewer of the source', 'bob', {}, 'forbidden:403'],
    ['an editor of the source who cannot edit the destination', 'bob', {}, 'forbidden:403'],
    ['someone who cannot read the source', 'carol', {}, 'not_found:404'],
    ['a destination the caller cannot read', 'alice', { toSpaceId: 's3' }, 'forbidden:403'],
    ['a destination that does not exist', 'alice', { toSpaceId: 'nowhere' }, 'forbidden:403'],
    ['the same space', 'alice', { toSpaceId: 's1' }, 'same_space:400'],
    ['a non-root block', 'alice', { recordId: 'b1' }, 'not_a_root:400'],
    ['a nested page', 'alice', { recordId: 'P2' }, 'not_a_root:400'],
    ['a built-in board', 'alice', { recordId: 'board-default' }, 'not_a_root:400'],
    ['an unknown record', 'alice', { recordId: 'ghost' }, 'not_found:404'],
    ['a stale expected revision', 'alice', { expectedRev: 999 }, 'conflict:409'],
    ['malformed input', 'alice', { recordId: 5 }, 'invalid_request:400'],
  ])('%s is refused (%s)', async (_label, actor, input, expected) => {
    expect(await code(attempt(actor, input))).toBe(expected);
    expect((await row('P'))!.space_id).toBe('s1'); expect(await events()).toEqual([]);
    expect(await db.prepare("SELECT COUNT(*) n FROM access_audit WHERE action='move_record'").first('n')).toBe(0);
  });

  it('refuses a deleted root, a disabled caller and a workspace with permissions off', async () => {
    await db.prepare("UPDATE records SET data=json_set(data,'$.deleted',json('true')) WHERE id='P'").run();
    expect(await code(attempt('alice', {}))).toBe('deleted_root:409');
    await db.prepare("UPDATE records SET data=json_set(data,'$.deleted',json('false')) WHERE id='P'").run();
    await db.prepare('UPDATE users SET disabled_at=1 WHERE id=?').bind('alice').run();
    expect(await code(attempt('alice', {}))).toBe('not_found:404');
    await db.prepare('UPDATE users SET disabled_at=NULL WHERE id=?').bind('alice').run();
    await db.prepare('UPDATE access_state SET enabled=0 WHERE id=1').run();
    expect(await code(attempt('alice', {}))).toBe('not_found:404');
  });

  it('allows a guest who edits both spaces and refuses one who only views the destination', async () => {
    await member('s2', 'guest', 'viewer');
    expect(await code(attempt('guest', {}))).toBe('forbidden:403');
    await member('s2', 'guest', 'editor');
    expect(await code(attempt('guest', {}))).toBe('moved');
  });

  it('caps the closure it will move in one atomic batch', async () => {
    expect(await code(moveRoot(db, user('alice'), { recordId: 'P', toSpaceId: 's2', requestId: 'big' }, { maxRecords: 3 }))).toBe('move_too_large:413');
    expect((await row('P'))!.space_id).toBe('s1');
  });
});

describe('idempotency', () => {
  it('replays the committed result for the same request and rejects reuse with different arguments', async () => {
    const first = await moveRoot(db, user('alice'), { recordId: 'P', toSpaceId: 's2', requestId: 'same' });
    const again = await moveRoot(db, user('alice'), { recordId: 'P', toSpaceId: 's2', requestId: 'same' });
    expect(again).toMatchObject({ ...first, replayed: true });
    expect((await events()).length).toBe(8); // not doubled
    await expect(moveRoot(db, user('alice'), { recordId: 'Q', toSpaceId: 's3', requestId: 'same' })).rejects.toMatchObject({ code: 'request_id_reused' });
  });

  it('a replay is re-authorized: a caller who lost the destination no longer sees success', async () => {
    await moveRoot(db, user('alice'), { recordId: 'P', toSpaceId: 's2', requestId: 'same' });
    await member('s2', 'alice', 'editor', 'deny');
    await expect(moveRoot(db, user('alice'), { recordId: 'P', toSpaceId: 's2', requestId: 'same' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('a move is atomic under concurrent change', () => {
  /** Run the move with `race` applied immediately before its write batch commits. */
  async function raced(race: () => Promise<unknown>, actor = 'alice') {
    let hit = false;
    const wrapped = interceptD1Batches(db, async (target, statements, sql) => {
      if (!hit && sql.some(s => /UPDATE seq_floor/.test(s))) { hit = true; await race(); }
      return target.batch(statements);
    });
    const outcome = await moveRoot(wrapped, user(actor), { recordId: 'P', toSpaceId: 's2', requestId: `race-${Math.random()}` }).then(() => 'moved', (error: SpaceMoveError) => error.code);
    expect(hit).toBe(true);
    return outcome;
  }
  const untouched = async () => {
    expect((await row('P'))!.space_id).toBe('s1'); expect(await events()).toEqual([]);
    expect(await db.prepare("SELECT COUNT(*) n FROM access_audit WHERE action='move_record'").first('n')).toBe(0);
  };

  it('a child created under the root after the plan was read aborts the move (no orphan left behind)', async () => {
    expect(await raced(() => put('late-child', 'blocks', { pageId: 'P', text: 'late' }, 's1'))).toBe('access_changed_retry');
    await untouched();
  });
  it('an edit to a moved row after the plan was read aborts the move', async () => {
    expect(await raced(() => db.prepare("UPDATE records SET seq=seq+1000 WHERE id='b2'").run())).toBe('access_changed_retry');
    await untouched();
  });
  it('a relation created to the subtree after the plan was read aborts the move', async () => {
    expect(await raced(() => put('L9', 'links', { fromType: 'page', fromId: 'Q', toType: 'page', toId: 'b1' }, 's2', 's1'))).toBe('access_changed_retry');
    await untouched();
  });
  it('revocation of the actor on the destination between plan and commit aborts the move', async () => {
    expect(await raced(() => member('s2', 'alice', 'viewer'))).toBe('access_changed_retry');
    await untouched();
  });
  it('a concurrent move of the same root aborts the loser and leaves the winner intact', async () => {
    const outcome = await raced(() => moveRoot(db, user('alice'), { recordId: 'P', toSpaceId: 's3', requestId: 'winner' }).catch(() => undefined));
    // alice cannot edit s3, so the "winner" is refused; the original move then succeeds.
    expect(outcome).toBe('moved');
    await member('s3', 'alice');
    const second = await moveRoot(db, user('alice'), { recordId: 'Q', toSpaceId: 's3', requestId: 'q' });
    expect(second.toSpaceId).toBe('s3');
  });
});

describe('POST /api/spaces/move', () => {
  const post = (actor: string | null, body: unknown, bindings = env) => spacesApi.request('http://localhost/move', { method: 'POST', headers: actor ? headers(actor) : { 'content-type': 'application/json' }, body: JSON.stringify(body) }, bindings, ctx);

  it('moves and reports the result; unauthenticated, malformed and refused requests are rejected', async () => {
    expect((await post(null, {})).status).toBe(401);
    expect((await post('alice', 'x')).status).toBe(400);
    expect((await post('bob', { recordId: 'P', toSpaceId: 's2', requestId: 'r1' })).status).toBe(403);
    const ok = await post('alice', { recordId: 'P', toSpaceId: 's2', requestId: 'r2' });
    expect(ok.status).toBe(200); expect(await ok.json()).toMatchObject({ ok: true, moved: 7, links: 1, fromSpaceId: 's1', toSpaceId: 's2' });
  });

  it('is inert while permissions are not active', async () => {
    await db.prepare('UPDATE access_state SET enabled=0 WHERE id=1').run();
    const response = await post('alice', { recordId: 'P', toSpaceId: 's2', requestId: 'r1' });
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'permissions_not_active' });
    expect((await row('P'))!.space_id).toBe('s1');
  });

  it('a revoked session cannot complete a move that was authorized before it was revoked', async () => {
    const wrapped = interceptD1Batches(db, async (target, statements, sql) => {
      if (sql.some(s => /UPDATE seq_floor/.test(s))) await target.prepare("DELETE FROM sessions WHERE user_id='alice'").run();
      return target.batch(statements);
    });
    const response = await post('alice', { recordId: 'P', toSpaceId: 's2', requestId: 'r3' }, { ...env, DB: wrapped });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect((await row('P'))!.space_id).toBe('s1'); expect(await events()).toEqual([]);
  });
});

describe('retention of eviction facts', () => {
  it('deletes facts past the window and raises each space\'s floor to the highest deleted revision in one batch', async () => {
    await moveRoot(db, user('alice'), { recordId: 'P', toSpaceId: 's2', requestId: 'old' });
    const oldMax = Math.max(...(await events()).map(e => e.seq));
    await db.prepare('UPDATE space_events SET created_at=?').bind(Date.now() - EVENT_RETENTION_MS - 5000).run();
    await put('X', 'pages', { title: 'recent' }, 's1'); const fresh = await nextSeq();
    await db.prepare("UPDATE records SET space_id='s2', seq=? WHERE id='X'").bind(fresh).run(); // a fresh fact stays
    expect(await pruneSpaceEvents(env)).toBe(8);
    expect(await events()).toEqual([{ space_id: 's1', seq: fresh, record_id: 'X' }]);
    expect(await db.prepare("SELECT events_floor FROM spaces WHERE id='s1'").first('events_floor')).toBe(oldMax);
    expect(await db.prepare("SELECT events_floor FROM spaces WHERE id='s2'").first('events_floor')).toBe(0);
    // A client older than the floor is told to re-backfill that space.
    const reply = await sync.request('http://localhost/pull', { method: 'POST', headers: headers('alice'), body: JSON.stringify({ protocol: 3, etag: (await loadManifest(db, 'alice')).manifest.etag, cursor: 1, joining: [], limit: 500 }) }, env, ctx);
    expect(await reply.json()).toEqual({ error: 'rebackfill_required', spaces: ['s1'] });
  });

  it('is bounded per call and never raises a floor above what it deleted', async () => {
    await moveRoot(db, user('alice'), { recordId: 'P', toSpaceId: 's2', requestId: 'old' });
    await db.prepare('UPDATE space_events SET created_at=?').bind(Date.now() - EVENT_RETENTION_MS - 5000).run();
    expect(await pruneSpaceEvents(env, Date.now(), EVENT_RETENTION_MS, 3)).toBe(3);
    const remaining = (await events()).length; expect(remaining).toBe(5);
    const floor = Number(await db.prepare("SELECT events_floor FROM spaces WHERE id='s1'").first('events_floor'));
    expect(Math.min(...(await events()).map(e => e.seq))).toBeGreaterThan(floor);
    expect(await pruneSpaceEvents(env)).toBe(5); expect(await events()).toEqual([]);
  });
});
