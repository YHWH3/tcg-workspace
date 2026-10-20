// Seam between the Phase 5 write authorizer (worker/mutationAccess.ts) and the
// audit's timestamp discipline (shared/clock.ts, applied in worker/sync.ts).
//
// The authorizer decides which fields a change "touches" by comparing the
// change timestamp with the STORED field timestamp. A record written before the
// drift ceiling existed can carry a far-future timestamp. If the authorizer
// read that value while the merge read the healed one, the authorizer would see
// a no-op where the merge applies a write: an identity or scope field would be
// changed without ever being checked. Both must see one ordering.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyChanges } from '../worker/sync';
import { MAX_FUTURE_SKEW_MS } from '../shared/clock';
import { sha256Hex } from '../worker/password';
import type { Env } from '../worker/auth';

vi.mock('../worker/events', async original => ({ ...await original<typeof import('../worker/events')>(), scheduleOutbox: vi.fn() }));
// LiveRoom extends the runtime's DurableObject; the sweep is exercised against
// fake sockets and real D1 (same stub as tests/audit-auth-d1.test.ts).
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) { this.ctx = ctx; this.env = env; }
  },
}));

/** Only a write from before the ceiling existed (or a broken clock) produces this. */
const POISON = 9_000_000_000_000_000;
let mf: Miniflare, db: D1Database, env: Env;

async function put(id: string, collection: string, data: Record<string, unknown>, poisoned: string[] = [], space = 'private') {
  const fieldTs = Object.fromEntries(Object.keys(data).map(k => [k, poisoned.includes(k) ? POISON : 1]));
  await db.prepare('INSERT INTO records(id,collection,data,field_ts,seq,space_id,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .bind(id, collection, JSON.stringify(data), JSON.stringify(fieldTs), 1, space, 'owner', 1000).run();
}
async function stored(id: string) {
  const row = await db.prepare('SELECT data,field_ts,space_id FROM records WHERE id=?').bind(id).first<{ data: string; field_ts: string; space_id: string }>();
  return { data: JSON.parse(row!.data) as Record<string, unknown>, fieldTs: JSON.parse(row!.field_ts) as Record<string, number>, space: row!.space_id };
}
const edit = (id: string, patch: Record<string, unknown>) => [{ id, collection: 'pages', patch, ts: Date.now() }];

beforeEach(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'phase5-audit-interplay', modules: true,
    script: 'export default {fetch(){return new Response("disposable interplay fixture")}}',
    compatibilityDate: '2026-09-25', d1Databases: { DB: 'disposable-phase5-audit-interplay' },
  }] }));
  db = await mf.getD1Database('DB') as D1Database;
  env = { DB: db } as Env;
  const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const name of readdirSync(folder).filter(n => n.endsWith('.sql')).sort()) {
    const sql = readFileSync(`${folder}/${name}`, 'utf8').replace(/--[^\n]*/g, '');
    await db.batch((sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi) ?? []).map(s => db.prepare(s.trim())));
  }
  await db.prepare("INSERT INTO spaces(id,name,default_access,created_at) VALUES('private','Private','private',1),('other','Other private','private',1)").run();
  for (const [id, role] of [['owner', 'owner'], ['editor', 'member']] as const) {
    await db.prepare('INSERT INTO users(id,username,name,role,workspace_role) VALUES(?,?,?,?,?)').bind(id, id, id, id === 'owner' ? 'admin' : 'member', role).run();
    await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await sha256Hex(`interplay-${id}`), id, Date.now() + 86_400_000, Date.now()).run();
  }
  // The editor can edit in BOTH spaces, so the only thing standing between a
  // plain write and a move is the authorizer's explicit-move rule.
  for (const space of ['private', 'other']) {
    await db.prepare('INSERT INTO space_members(space_id,user_id,role) VALUES(?,?,?)').bind(space, 'owner', 'owner').run();
    await db.prepare('INSERT INTO space_members(space_id,user_id,role) VALUES(?,?,?)').bind(space, 'editor', 'editor').run();
  }
  await db.prepare('UPDATE access_state SET enabled=1 WHERE id=1').run();
});
afterEach(async () => { await mf?.dispose(); });

describe('healed timestamps and the Phase 5 authorizer share one ordering', () => {
  it('a poisoned createdBy timestamp cannot hide an identity forgery from the authorizer', async () => {
    await put('doc', 'pages', { title: 'Plan', createdBy: 'owner' }, ['createdBy']);
    const result = await applyChanges(env, 'editor', edit('doc', { createdBy: 'editor' }));
    // The invariant first (the stored identity is untouched), then the reason.
    expect((await stored('doc')).data.createdBy).toBe('owner');
    expect(result.rejectedItems).toEqual([{ id: 'doc', collection: 'pages', reason: 'protected_field' }]);
    expect(result.changed).toBe(0);
  });

  it('a poisoned spaceId timestamp cannot move a root record without the explicit move', async () => {
    await put('doc', 'pages', { title: 'Roadmap', spaceId: 'private' }, ['spaceId']);
    const result = await applyChanges(env, 'editor', edit('doc', { spaceId: 'other' }));
    // Neither the document's claim nor the server-owned column may move.
    const row = await stored('doc');
    expect(row.data.spaceId).toBe('private');
    expect(row.space).toBe('private');
    expect(result.rejectedItems).toEqual([{ id: 'doc', collection: 'pages', reason: 'explicit_move_required' }]);
    expect(result.changed).toBe(0);
  });

  it('healing is not a denial of service: a permitted edit applies and the stored timestamp is repaired', async () => {
    await put('doc', 'pages', { title: 'Plan', createdBy: 'owner' }, ['createdBy', 'title']);
    const before = Date.now();
    const result = await applyChanges(env, 'editor', edit('doc', { title: 'Plan v2' }));
    expect(result.rejectedItems ?? []).toEqual([]);
    expect(result.changed).toBe(1);
    const row = await stored('doc');
    expect(row.data.title).toBe('Plan v2');
    for (const ts of Object.values(row.fieldTs)) expect(ts).toBeLessThanOrEqual(Date.now() + MAX_FUTURE_SKEW_MS);
    expect(row.fieldTs.title).toBeGreaterThanOrEqual(before);
  });
});

describe('a disabled principal is not a live session for open sockets either', () => {
  interface Socket { att: unknown; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; serializeAttachment(a: unknown): void; deserializeAttachment(): unknown }

  // The audit binds a socket to its session row (worker/live.ts). HTTP auth
  // additionally treats `users.disabled_at` as "no session" (worker/auth.ts).
  // The sweep must use the same definition, or a disabled account keeps
  // receiving presence (page paths) and change pokes until its tab closes.
  it('the next sweep closes a socket whose session row still exists', async () => {
    const { LiveRoom } = await import('../worker/live');
    const sid = await sha256Hex('interplay-editor');
    const socket: Socket = {
      att: { userId: 'editor', sid, path: '/pages/secret', lastSeen: Date.now() },
      send: vi.fn(), close: vi.fn(),
      serializeAttachment(a) { this.att = a; },
      deserializeAttachment() { return this.att; },
    };
    const state = { storage: { getAlarm: async () => 1, setAlarm: vi.fn() }, getWebSockets: () => [socket], acceptWebSocket: vi.fn() };
    const room = new LiveRoom(state as never, env);
    await room.alarm();
    expect(socket.close).not.toHaveBeenCalled(); // control: an enabled principal's session stays open

    await db.prepare('UPDATE users SET disabled_at=? WHERE id=?').bind(Date.now(), 'editor').run();
    expect(await db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').bind('editor').first('n')).toBe(1);
    await room.alarm();
    expect(socket.close).toHaveBeenCalledWith(4401, 'session ended');
  });
});
