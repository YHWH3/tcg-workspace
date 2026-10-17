// Protocol 3 on actual D1: the access manifest and the per-space pull feed
// (docs/architecture/phase-5-per-space-feeds.md §3.2–3.4). A reference client
// (tests/feedClient.ts) drives the real server so each property is checked end to end.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sync } from '../worker/sync';
import { loadManifest } from '../worker/spaceFeed';
import { sha256Hex } from '../worker/password';
import type { Env } from '../worker/auth';
import type { PullRequestV3 } from '../shared/protocol';
import { interceptD1Batches } from './d1WriteBoundary';
import { RefClient, type PullFn } from './feedClient';

vi.mock('../worker/events', async original => ({ ...await original<typeof import('../worker/events')>(), scheduleOutbox: vi.fn() }));
let mf: Miniflare, db: D1Database, env: Env, seq: number;
const ctx = { waitUntil: (_p: Promise<unknown>) => {}, passThroughOnException: () => {} } as ExecutionContext;
const token = (id: string) => `feeds-fixture-${id}`;

async function put(id: string, collection: string, data: Record<string, unknown>, space = 'space-core', peer: string | null = null, explicitSeq?: number) {
  await db.prepare('INSERT INTO records(id,collection,data,field_ts,seq,space_id,peer_space_id) VALUES(?,?,?,?,?,?,?)')
    .bind(id, collection, JSON.stringify(data), JSON.stringify(Object.fromEntries(Object.keys(data).map(k => [k, 1]))), explicitSeq ?? ++seq, space, peer).run();
}
/** Revise a row the way the write path does: new revision, same space unless told otherwise. */
async function touch(id: string, patch: Record<string, unknown> = {}, space?: string, peer?: string | null) {
  const next = Number(await db.prepare('SELECT MAX((SELECT MAX(seq) FROM records),(SELECT floor FROM seq_floor WHERE id=1))+1 n').first('n'));
  seq = Math.max(seq, next);
  const row = await db.prepare('SELECT data FROM records WHERE id=?').bind(id).first<{ data: string }>();
  const data = { ...JSON.parse(row!.data), ...patch };
  await db.prepare('UPDATE records SET data=?, seq=?, space_id=COALESCE(?,space_id), peer_space_id=CASE WHEN ? THEN ? ELSE peer_space_id END WHERE id=?')
    .bind(JSON.stringify(data), next, space ?? null, peer === undefined ? 0 : 1, peer ?? null, id).run();
  return next;
}
const member = (space: string, user: string, role = 'editor', access = 'allow') =>
  db.prepare('INSERT INTO space_members(space_id,user_id,role,access) VALUES(?,?,?,?) ON CONFLICT(space_id,user_id) DO UPDATE SET role=excluded.role,access=excluded.access').bind(space, user, role, access).run();
const unmember = (space: string, user: string) => db.prepare('DELETE FROM space_members WHERE space_id=? AND user_id=?').bind(space, user).run();
const etagOf = async (actor: string) => (await loadManifest(db, actor)).manifest.etag;
const headers = (actor: string) => ({ authorization: `Bearer ${token(actor)}`, 'content-type': 'application/json' });
async function rawPull(actor: string, body: unknown) {
  const response = await sync.request('http://localhost/pull', { method: 'POST', headers: headers(actor), body: JSON.stringify(body) }, env, ctx);
  return { status: response.status, body: await response.json().catch(() => null) as any };
}
const puller = (actor: string): PullFn => (request: PullRequestV3) => rawPull(actor, request);
const request = async (actor: string, partial: Partial<PullRequestV3> = {}): Promise<PullRequestV3> =>
  ({ protocol: 3, etag: await etagOf(actor), cursor: 0, joining: [], limit: 500, ...partial });
const pull = async (actor: string, partial: Partial<PullRequestV3> = {}) => rawPull(actor, await request(actor, partial));
async function client(actor: string) { const c = new RefClient(puller(actor)); c.reconcile((await loadManifest(db, actor)).manifest); return c; }
/** Ground truth for the fixture: every row whose home (and peer) space the actor can read. */
async function truth(actor: string): Promise<string[]> {
  const readable = new Set((await loadManifest(db, actor)).manifest.spaces.map(s => s.id));
  const rows = (await db.prepare('SELECT id,collection,data,space_id,peer_space_id FROM records').all<{ id: string; collection: string; data: string; space_id: string; peer_space_id: string | null }>()).results;
  return rows.filter(r => readable.has(r.space_id) && (!r.peer_space_id || readable.has(r.peer_space_id)) && !JSON.parse(r.data).hidden).map(r => r.id).sort();
}

beforeEach(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'phase5-feeds', modules: true,
    script: 'export default {fetch(){return new Response("disposable feed fixture")}}', compatibilityDate: '2026-09-25', d1Databases: { DB: 'disposable-phase5-feeds' } }] }));
  db = await mf.getD1Database('DB') as D1Database; env = { DB: db } as Env; seq = 0;
  const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const name of readdirSync(folder).filter(n => n.endsWith('.sql')).sort()) {
    const sql = readFileSync(`${folder}/${name}`, 'utf8').replace(/--[^\n]*/g, '');
    await db.batch((sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi) ?? []).map(s => db.prepare(s.trim())));
  }
  await db.prepare("INSERT INTO spaces(id,name,default_access,created_at) VALUES('private','Private','private',1),('other','Other','private',1),('third','Third','private',1)").run();
  for (const [id, role] of [['alice', 'member'], ['bob', 'member'], ['guest', 'guest']] as const) {
    await db.prepare('INSERT INTO users(id,username,name,role,workspace_role) VALUES(?,?,?,?,?)').bind(id, id, id, 'member', role).run();
    await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await sha256Hex(token(id)), id, Date.now() + 86_400_000, Date.now()).run();
  }
  await member('private', 'alice', 'editor'); await member('private', 'guest', 'viewer');
  await db.prepare('UPDATE access_state SET enabled=1 WHERE id=1').run();
});
afterEach(async () => { await mf?.dispose(); });

describe('manifest and etag', () => {
  it('lists exactly the caller\'s readable spaces with roles; a guest only has explicit grants', async () => {
    const alice = (await loadManifest(db, 'alice')).manifest, guest = (await loadManifest(db, 'guest')).manifest;
    expect(alice.spaces.map(s => [s.id, s.role])).toEqual([['space-core', 'editor'], ['private', 'editor']].sort((a, b) => a[0] < b[0] ? -1 : 1).sort((x, y) => (x[0] === 'space-core' ? 'Core' : 'Private') < (y[0] === 'space-core' ? 'Core' : 'Private') ? -1 : 1));
    expect(guest.spaces.map(s => [s.id, s.role])).toEqual([['private', 'viewer']]);
    expect(alice.workspaceRole).toBe('member'); expect(guest.workspaceRole).toBe('guest');
    expect((await loadManifest(db, 'bob')).manifest.spaces.map(s => s.id)).toEqual(['space-core']);
  });

  it('is stable across sessions, logouts, record writes, deletes, restores and OTHER users\' membership', async () => {
    const before = await etagOf('alice');
    await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind('another-device', 'alice', Date.now() + 1000, Date.now()).run();
    await db.prepare("DELETE FROM sessions WHERE token_hash='another-device'").run();
    await put('p', 'pages', { title: 'P' }, 'private'); await touch('p', { deleted: true }); await touch('p', { deleted: false });
    await member('private', 'bob', 'viewer'); await unmember('private', 'bob');
    await member('other', 'guest', 'viewer');
    await db.prepare("UPDATE users SET name='Alice Renamed' WHERE id='alice'").run();
    expect(await etagOf('alice')).toBe(before);
  });

  it('is a pure function of the manifest: it changes exactly when what the caller may read changes', async () => {
    const base = await etagOf('alice');
    await member('other', 'alice', 'viewer'); const granted = await etagOf('alice'); expect(granted).not.toBe(base);
    await member('other', 'alice', 'editor'); const promoted = await etagOf('alice'); expect(new Set([base, granted, promoted]).size).toBe(3);
    await db.prepare("UPDATE spaces SET name='Renamed' WHERE id='other'").run(); const renamed = await etagOf('alice'); expect(new Set([base, granted, promoted, renamed]).size).toBe(4);
    await db.prepare("UPDATE spaces SET export_policy='members' WHERE id='other'").run(); const exportable = await etagOf('alice'); expect(new Set([base, granted, promoted, renamed, exportable]).size).toBe(5);
    // Deleting the space returns the caller to the manifest she had before the grant; restoring brings the grant back.
    await db.prepare("UPDATE spaces SET deleted_at=5 WHERE id='other'").run(); expect(await etagOf('alice')).toBe(base);
    await db.prepare("UPDATE spaces SET deleted_at=NULL WHERE id='other'").run(); expect(await etagOf('alice')).toBe(exportable);
    await member('other', 'alice', 'editor', 'deny'); expect(await etagOf('alice')).toBe(base);
    await unmember('other', 'alice');
    // A workspace-role change alters what default access gives her.
    await db.prepare("UPDATE users SET workspace_role='guest' WHERE id='alice'").run(); const asGuest = await etagOf('alice'); expect(asGuest).not.toBe(base);
    await db.prepare("UPDATE users SET workspace_role='member' WHERE id='alice'").run(); expect(await etagOf('alice')).toBe(base);
    // Default access of a space she is not a member of: members of the workspace gain it, guests do not.
    await db.prepare("UPDATE spaces SET default_access='members' WHERE id='third'").run();
    const withThird = await etagOf('alice'); expect(withThird).not.toBe(base);
    expect((await loadManifest(db, 'alice')).manifest.spaces.map(s => s.id)).toContain('third');
    expect((await loadManifest(db, 'guest')).manifest.spaces.map(s => s.id)).not.toContain('third');
  });

  it('refuses a disabled or unknown principal', async () => {
    await db.prepare('UPDATE users SET disabled_at=1 WHERE id=?').bind('alice').run();
    await expect(loadManifest(db, 'alice')).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(loadManifest(db, 'nobody')).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

describe('steady-state pull', () => {
  it('returns only readable rows with their resolved space and passes hidden rows without stalling', async () => {
    await put('core', 'pages', { title: 'Core' }); await put('secret', 'pages', { title: 'Secret' }, 'other'); await put('mine', 'pages', { title: 'Mine' }, 'private');
    // Everything is "joining" for a brand-new client; settled spaces use the shared cursor.
    const c = await client('alice');
    await c.sync();
    expect(c.ids()).toEqual(['core', 'mine']);
    expect(c.live.get('mine')!.spaceId).toBe('private');
    expect(c.cursor).toBe(seq); // the cursor reached the high-water mark across the invisible tail
  });

  it('advances the cursor across a long run of invisible rows', async () => {
    await put('visible', 'pages', { title: 'V' }, 'private');
    for (let i = 0; i < 30; i++) await put(`hidden-${i}`, 'pages', { title: 'H' }, 'other');
    const c = await client('alice'); await c.sync(8);
    expect(c.ids()).toEqual(['visible']); expect(c.cursor).toBe(seq);
    const reply = await pull('alice', { cursor: c.cursor });
    expect(reply.body.records).toEqual([]); expect(reply.body.hasMore).toBe(false); expect(reply.body.cursor).toBe(seq);
  });

  it('a stale etag returns the manifest only, never rows', async () => {
    await put('p', 'pages', { title: 'P' }, 'private');
    const reply = await pull('alice', { etag: 'stale' });
    expect(reply.status).toBe(409); expect(reply.body.error).toBe('manifest_changed');
    expect(reply.body.manifest.spaces.map((s: { id: string }) => s.id).sort()).toEqual(['private', 'space-core']);
    expect(reply.body.records).toBeUndefined();
  });

  it('delivers soft-deleted rows and descendants of a deleted ancestor (FD-05)', async () => {
    await put('page', 'pages', { title: 'Parent' }, 'private'); await put('body', 'blocks', { pageId: 'page', text: 'Body' }, 'private');
    await touch('page', { deleted: true });
    const c = await client('alice'); await c.sync();
    expect(c.ids()).toEqual(['body', 'page']);
    expect(c.live.get('page')!.data.deleted).toBe(true);
    // Restoring the parent needs no re-delivery of the child.
    await touch('page', { deleted: false }); await c.sync();
    expect(c.live.get('page')!.data.deleted).toBe(false); expect(c.live.has('body')).toBe(true);
  });

  it('never delivers service-only pending uploads', async () => {
    await put('form', 'boards', { name: 'Form db' }, 'private');
    await put('pending', 'files', { parentType: 'form-pending', parentId: 'form', name: 'x' }, 'private');
    const c = await client('alice'); await c.sync();
    expect(c.ids()).toEqual(['form']);
  });
});

describe('revocation and regrant', () => {
  it('after revocation no row of the space is ever returned; the old etag only yields the manifest', async () => {
    await put('a', 'pages', { title: 'A' }, 'private');
    const c = await client('alice'); await c.sync();
    expect(c.ids()).toEqual(['a']);
    await member('private', 'alice', 'editor', 'deny');
    await put('b', 'pages', { title: 'B (written after revocation)' }, 'private');
    const stale = await rawPull('alice', { protocol: 3, etag: c.etag, cursor: c.cursor, joining: [], limit: 500 });
    expect(stale.status).toBe(409); expect(JSON.stringify(stale.body)).not.toContain('"title"');
    await c.sync();
    expect(c.ids()).toEqual([]); // evicted first, then nothing of the space can arrive
    expect(c.settled.has('private')).toBe(false);
    // Even from cursor 0 with the current etag nothing of the revoked space can be returned.
    const fromZero = await rawPull('alice', { protocol: 3, etag: c.etag, cursor: 0, joining: [], limit: 500 });
    expect(fromZero.status).toBe(200); expect(fromZero.body.records.map((r: { id: string }) => r.id)).not.toContain('a');
    expect(JSON.stringify(fromZero.body)).not.toContain('written after revocation');
  });

  it('regrant backfills from zero, including rows changed while revoked, and sweeps nothing live in other spaces', async () => {
    await put('core', 'pages', { title: 'Core' }); await put('a', 'pages', { title: 'A' }, 'private');
    const c = await client('alice'); await c.sync();
    await member('private', 'alice', 'editor', 'deny');
    await c.sync(); expect(c.ids()).toEqual(['core']);
    await touch('a', { title: 'A edited while revoked' }); await put('c', 'pages', { title: 'C created while revoked' }, 'private');
    await member('private', 'alice', 'editor', 'allow');
    await c.sync(8);
    expect(c.ids()).toEqual(['a', 'c', 'core']);
    expect(c.live.get('a')!.data.title).toBe('A edited while revoked');
    expect(c.ids()).toEqual(await truth('alice'));
  });

  it('a backfilling space is not mixed into the shared cursor and activates only when complete', async () => {
    await put('core1', 'pages', { title: 'C1' });
    for (let i = 0; i < 25; i++) await put(`p${i}`, 'pages', { title: `P${i}` }, 'private');
    const c = await client('alice');
    c.settled.add('space-core'); c.joining.delete('space-core'); c.live.set('core1', { id: 'core1', collection: 'pages', data: { title: 'C1' }, seq: 1, spaceId: 'space-core' });
    c.cursor = 1;
    // Mid-backfill: nothing of the joining space is visible, the shared cursor never went backwards.
    const first = await c.step(8);
    expect(first.status).toBe(200); expect(first.body.hasMore).toBe(true);
    expect([...c.live.keys()]).toEqual(['core1']);
    expect(c.joining.get('private')!.staged.size).toBeGreaterThan(0);
    expect(c.cursor).toBeGreaterThanOrEqual(1);
    await c.sync(8);
    expect(c.ids().length).toBe(26); expect(c.settled.has('private')).toBe(true);
  });
});

describe('stale and impossible cursors', () => {
  it('a cursor older than a space\'s retained events must re-backfill that space only', async () => {
    await put('core', 'pages', { title: 'Core' }); await put('a', 'pages', { title: 'A' }, 'private');
    const c = await client('alice'); await c.sync();
    await db.prepare("UPDATE spaces SET events_floor=? WHERE id='private'").bind(c.cursor + 5).run();
    const reply = await pull('alice', { cursor: c.cursor });
    expect(reply.status).toBe(409); expect(reply.body).toEqual({ error: 'rebackfill_required', spaces: ['private'] });
    await c.sync(); // the reference client re-joins just that space, keeps showing it, then sweeps
    expect(c.ids()).toEqual(['a', 'core']);
    expect(c.log).toContain('409 rebackfill_required');
  });

  it('re-backfill sweeps a row that left the space while the cursor was too old to learn it', async () => {
    await put('a', 'pages', { title: 'A' }, 'private'); await put('gone', 'pages', { title: 'Moved out' }, 'private');
    const c = await client('alice'); await c.sync();
    expect(c.ids()).toEqual(['a', 'gone']);
    await touch('gone', {}, 'other'); // moved out: an eviction fact is written
    await db.prepare('DELETE FROM space_events').run(); // retention pruned it ...
    await db.prepare("UPDATE spaces SET events_floor=? WHERE id='private'").bind(seq).run(); // ... and raised the floor
    await c.sync();
    expect(c.ids()).toEqual(['a']);
  });

  it('a cursor beyond the database (a restore) is refused and the client re-backfills everything', async () => {
    await put('core', 'pages', { title: 'Core' }); await put('a', 'pages', { title: 'A' }, 'private');
    const c = await client('alice'); await c.sync();
    c.cursor += 1000;
    const reply = await pull('alice', { cursor: c.cursor });
    expect(reply.status).toBe(409); expect(reply.body).toEqual({ error: 'cursor_ahead' });
    await c.sync();
    expect(c.ids()).toEqual(['a', 'core']); expect(c.cursor).toBeLessThanOrEqual(seq);
  });
});

describe('request validation and inertness', () => {
  it('rejects malformed requests before touching data', async () => {
    const good = await request('alice');
    for (const [label, body] of [
      ['limit below the minimum group size', { ...good, limit: 7 }], ['limit above the page cap', { ...good, limit: 501 }], ['negative cursor', { ...good, cursor: -1 }],
      ['fractional cursor', { ...good, cursor: 1.5 }], ['non-string etag', { ...good, etag: 5 }], ['duplicate joining space', { ...good, joining: [{ space: 'private', after: 0, base: 0 }, { space: 'private', after: 0, base: 0 }] }],
      ['too many joining spaces', { ...good, joining: Array.from({ length: 21 }, (_, i) => ({ space: `s${i}`, after: 0, base: 0 })) }],
      ['negative after', { ...good, joining: [{ space: 'private', after: -3, base: 0 }] }], ['not an object', 'x'],
    ] as const) {
      const reply = await rawPull('alice', body);
      expect(reply.status, label).toBe(400);
    }
    expect((await rawPull('alice', { ...good, protocol: 2 })).status).toBe(426);
    expect((await rawPull('alice', { ...good, protocol: undefined })).status).toBe(426);
  });

  it('a joining space the caller cannot read is a client error once the etag matches', async () => {
    const reply = await pull('alice', { joining: [{ space: 'other', after: 0, base: 0 }] });
    expect(reply.status).toBe(400);
  });

  it('is inert while permissions are not active, and the legacy GET route still refuses protocol 1 once active', async () => {
    const legacy = await sync.request('http://localhost/pull?since=0', { headers: headers('alice') }, env, ctx);
    expect(legacy.status).toBe(426);
    await db.prepare('UPDATE access_state SET enabled=0 WHERE id=1').run();
    const reply = await rawPull('alice', { protocol: 3, etag: 'x', cursor: 0, joining: [], limit: 500 });
    expect(reply.status).toBe(404); expect(reply.body).toEqual({ error: 'permissions_not_active' });
    expect((await sync.request('http://localhost/pull?since=0', { headers: headers('alice') }, env, ctx)).status).toBe(200);
  });

  it('requires authentication', async () => {
    const response = await sync.request('http://localhost/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, env, ctx);
    expect(response.status).toBe(401);
  });
});

describe('page boundaries', () => {
  it('never ends a page inside an equal-revision group of a record row and its eviction facts', async () => {
    // A link retargeted at revision R emits facts for its old home AND old peer at R,
    // and the row itself is delivered at R: three items share one revision.
    await put('x', 'pages', { title: 'X' }, 'private'); await put('y', 'pages', { title: 'Y' }, 'other'); await member('other', 'alice', 'viewer');
    await put('link', 'links', { fromType: 'page', fromId: 'x', toType: 'page', toId: 'y' }, 'private', 'other');
    for (let i = 0; i < 4; i++) await put(`f${i}`, 'pages', { title: 'filler' }, 'private');
    const retargeted = await touch('link', { toId: 'elsewhere' }, undefined, 'third'); // events for private and other at `retargeted`
    for (let i = 4; i < 12; i++) await put(`f${i}`, 'pages', { title: 'filler' }, 'private');
    const groups = await db.prepare('SELECT COUNT(*) n FROM space_events WHERE seq=?').bind(retargeted).first('n');
    expect(groups).toBe(2);
    // Page with every possible small limit: the stream must be complete and duplicate-free.
    for (const limit of [8, 9, 10, 11, 13]) {
      const seenEvents: string[] = [], seenRecords: string[] = [];
      let cursor = 0, hasMore = true, joining = [{ space: 'private', after: 0, base: 0 }, { space: 'other', after: 0, base: 0 }], guard = 0;
      while (hasMore && guard++ < 100) {
        const reply = await pull('alice', { cursor, joining, limit });
        expect(reply.status).toBe(200);
        seenRecords.push(...reply.body.records.map((r: { id: string }) => r.id)); seenEvents.push(...reply.body.evictions.map((e: { spaceId: string; rev: number }) => `${e.spaceId}@${e.rev}`));
        cursor = reply.body.cursor; joining = reply.body.joining; hasMore = reply.body.hasMore;
      }
      expect(new Set(seenRecords).size, `records at limit ${limit}`).toBe(seenRecords.length);
      expect(seenEvents.sort(), `events at limit ${limit}`).toEqual([`other@${retargeted}`, `private@${retargeted}`]);
    }
  });
});

describe('cross-space relations (FD-02)', () => {
  async function relation() {
    await put('a1', 'pages', { title: 'In private' }, 'private'); await put('b1', 'pages', { title: 'In other' }, 'other');
    await put('link', 'links', { fromType: 'page', fromId: 'a1', toType: 'page', toId: 'b1' }, 'private', 'other');
  }

  it('is readable only with BOTH endpoint spaces', async () => {
    await relation();
    const onlyHome = await client('alice'); await onlyHome.sync();
    expect(onlyHome.ids()).toEqual(['a1']); // the link is not delivered, and never leaks the other endpoint's id
    await member('other', 'alice', 'viewer');
    const both = await client('alice'); await both.sync();
    expect(both.ids()).toEqual(['a1', 'b1', 'link']);
    expect(both.ids()).toEqual(await truth('alice'));
  });

  it('regranting the PEER space delivers a link whose own revision never changed', async () => {
    await relation();
    const c = await client('alice'); await c.sync();
    expect(c.ids()).toEqual(['a1']);
    const linkRev = Number(await db.prepare("SELECT seq FROM records WHERE id='link'").first('seq'));
    expect(c.cursor).toBeGreaterThanOrEqual(linkRev); // the shared cursor is at or past it: `seq > cursor` can never return the link
    await member('other', 'alice', 'viewer');
    await c.sync();
    expect(c.ids()).toEqual(['a1', 'b1', 'link']);
  });

  it('revoking the peer space removes the link as soon as its endpoint is evicted', async () => {
    await relation(); await member('other', 'alice', 'viewer');
    const c = await client('alice'); await c.sync();
    expect(c.ids()).toEqual(['a1', 'b1', 'link']);
    await unmember('other', 'alice');
    await c.sync();
    expect(c.ids()).toEqual(['a1']);
  });

  it('retargeting a link evicts it for the previous audience and delivers it to the new one', async () => {
    await relation(); await put('c1', 'pages', { title: 'In third' }, 'third');
    await member('other', 'alice', 'viewer'); await member('third', 'alice', 'viewer');   // alice reads private, other AND third
    await member('private', 'bob', 'viewer'); await member('other', 'bob', 'viewer');      // bob reads private and other, NOT third
    const alice = await client('alice'), bob = await client('bob'); await alice.sync(); await bob.sync();
    expect(alice.live.has('link')).toBe(true); expect(bob.live.has('link')).toBe(true);
    await db.prepare("UPDATE records SET data=json_set(data,'$.toId','c1'), peer_space_id='third', seq=? WHERE id='link'").bind(++seq).run();
    await alice.sync(); await bob.sync();
    expect(alice.live.get('link')!.data.toId).toBe('c1'); // still readable: alice reads private AND third
    expect(bob.live.has('link')).toBe(false);              // previous audience: evicted by the retarget facts
    expect(bob.ids()).toEqual(['a1', 'b1']);
  });
});

describe('writes interleaved with paging', () => {
  it('a row revised between pages is delivered at its new revision and nothing is missed or lost', async () => {
    for (let i = 0; i < 30; i++) await put(`p${i}`, 'pages', { title: `P${i}`, rev: 0 }, 'private');
    const c = await client('alice');
    await c.step(8); await c.step(8);
    await touch('p3', { rev: 1 }); await touch('p29', { rev: 1 }); await put('late', 'pages', { title: 'Late' }, 'private');
    await c.sync(8);
    expect(c.ids()).toEqual(await truth('alice'));
    expect(c.live.get('p3')!.data.rev).toBe(1); expect(c.live.get('p29')!.data.rev).toBe(1); expect(c.live.has('late')).toBe(true);
  });

  it('a revocation between the batch and the content read aborts the page instead of publishing', async () => {
    await put('a', 'pages', { title: 'A' }, 'private');
    let batches = 0;
    const raced = interceptD1Batches(db, async (target, statements) => {
      // batch 1 = the feed; 2 = scope graph; 3 = authority; 4 = capability-fenced content read
      if (++batches === 4) await member('private', 'alice', 'editor', 'deny');
      return target.batch(statements);
    });
    const response = await sync.request('http://localhost/pull', { method: 'POST', headers: headers('alice'), body: JSON.stringify(await request('alice', { joining: [{ space: 'private', after: 0, base: 0 }] })) }, { ...env, DB: raced }, ctx);
    expect(batches).toBe(4);
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'access_changed_retry' });
  });

  it('a revocation before the authority read yields a page without the revoked rows', async () => {
    await put('a', 'pages', { title: 'A' }, 'private');
    let batches = 0;
    const raced = interceptD1Batches(db, async (target, statements) => {
      if (++batches === 3) await member('private', 'alice', 'editor', 'deny');
      return target.batch(statements);
    });
    const response = await sync.request('http://localhost/pull', { method: 'POST', headers: headers('alice'), body: JSON.stringify(await request('alice', { joining: [{ space: 'private', after: 0, base: 0 }] })) }, { ...env, DB: raced }, ctx);
    const body = await response.json() as { records?: unknown[] };
    expect(response.status).toBe(200); expect(body.records).toEqual([]);
    // ... and the very next request is told the manifest changed.
    expect((await pull('alice', { etag: await etagOf('alice') })).status).toBe(200);
    const next = await rawPull('alice', { protocol: 3, etag: (await request('alice')).etag, cursor: 0, joining: [{ space: 'private', after: 0, base: 0 }], limit: 500 });
    expect(next.status).toBe(400); // private is no longer readable, so it cannot be a joining space
  });
});
