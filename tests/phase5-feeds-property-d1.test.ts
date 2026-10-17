// Randomized convergence proof for protocol 3 on actual D1. Seeded schedules interleave
// edits, soft deletes, inserts, explicit moves, relation creation and retargeting, membership
// grants/denials/removals, retention pruning (which raises floors) and partially paged client
// syncs. Whatever the schedule, every client — after the feed is exhausted — holds exactly the
// rows its CURRENT access allows, at their CURRENT revisions and spaces.
// A failure prints the seed and the operation log: rerun with PHASE5_SEEDS=<seed>.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sync } from '../worker/sync';
import { loadManifest } from '../worker/spaceFeed';
import { moveRoot } from '../worker/spaceMove';
import { pruneSpaceEvents } from '../worker/spaceEvents';
import { sha256Hex } from '../worker/password';
import type { Env } from '../worker/auth';
import { RefClient } from './feedClient';

vi.mock('../worker/events', async original => ({ ...await original<typeof import('../worker/events')>(), scheduleOutbox: vi.fn() }));
const ctx = { waitUntil: (_p: Promise<unknown>) => {}, passThroughOnException: () => {} } as ExecutionContext;
const token = (id: string) => `property-fixture-${id}`;
const SPACES = ['space-core', 's1', 's2', 's3'];
const ACTORS = ['u1', 'u2', 'u3', 'g1'];
const rng = (seed: number) => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const SEEDS = (process.env.PHASE5_SEEDS ? process.env.PHASE5_SEEDS.split(',').map(Number) : [1, 2, 3, 4, 5, 6, 7, 8]);
const OPERATIONS = 90;

const coverage = { moves: 0, retargets: 0, links: 0, memberships: 0, prunes: 0, partialSyncs: 0, manifestChanged: 0, rebackfill: 0, cursorAhead: 0, evictions: 0, peerDeliveries: 0 };
let mf: Miniflare | undefined;
afterEach(async () => { await mf?.dispose(); mf = undefined; });

async function world() {
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'phase5-property', modules: true,
    script: 'export default {fetch(){return new Response("disposable property fixture")}}', compatibilityDate: '2026-09-25', d1Databases: { DB: 'disposable-phase5-property' } }] }));
  const db = await mf.getD1Database('DB') as D1Database, env = { DB: db } as Env;
  const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const name of readdirSync(folder).filter(n => n.endsWith('.sql')).sort()) {
    const sql = readFileSync(`${folder}/${name}`, 'utf8').replace(/--[^\n]*/g, '');
    await db.batch((sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi) ?? []).map(s => db.prepare(s.trim())));
  }
  await db.prepare("INSERT INTO spaces(id,name,default_access,created_at) VALUES('s1','One','private',1),('s2','Two','private',1),('s3','Three','private',1)").run();
  for (const [id, role] of [['u1', 'member'], ['u2', 'member'], ['u3', 'member'], ['g1', 'guest'], ['mover', 'member']] as const) {
    await db.prepare('INSERT INTO users(id,username,name,role,workspace_role) VALUES(?,?,?,?,?)').bind(id, id, id, 'member', role).run();
    await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await sha256Hex(token(id)), id, Date.now() + 86_400_000, Date.now()).run();
  }
  for (const space of ['s1', 's2', 's3']) await db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES(?,?,'editor')").bind(space, 'mover').run();
  await db.prepare('UPDATE access_state SET enabled=1 WHERE id=1').run();
  return { db, env };
}

describe('protocol 3 converges under random schedules', () => {
  it.each(SEEDS)('seed %i', async seed => {
    const { db, env } = await world(), random = rng(seed), log: string[] = [];
    const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)];
    const next = async () => Number(await db.prepare('SELECT MAX((SELECT COALESCE(MAX(seq),0) FROM records),(SELECT floor FROM seq_floor WHERE id=1))+1 n').first('n'));
    const spaceOf = async (id: string) => (await db.prepare('SELECT space_id FROM records WHERE id=?').bind(id).first<{ space_id: string }>())?.space_id;
    const insert = async (id: string, collection: string, data: Record<string, unknown>, space: string, peer: string | null = null) =>
      db.prepare('INSERT INTO records(id,collection,data,field_ts,seq,space_id,peer_space_id) VALUES(?,?,?,?,?,?,?)').bind(id, collection, JSON.stringify(data), '{}', await next(), space, peer).run();
    const roots: string[] = [], links: string[] = [];
    for (let i = 0; i < 6; i++) {
      roots.push(`R${i}`); await insert(`R${i}`, 'pages', { title: `Root ${i}` }, pick(SPACES));
      for (let b = 0; b < 5; b++) await insert(b ? `B${i}_${b}` : `B${i}`, 'blocks', { pageId: `R${i}`, text: `block ${i}.${b}` }, (await spaceOf(`R${i}`))!);
    }
    const relate = async (id: string, from: string, to: string) => {
      const home = (await spaceOf(from))!, other = (await spaceOf(to))!;
      return { home, peer: other === home ? null : other, data: { fromType: 'page', fromId: from, toType: 'page', toId: to, kind: 'related', id } };
    };
    const clients = new Map<string, RefClient>();
    for (const actor of ACTORS) {
      const c = new RefClient(async request => {
        const response = await sync.request('http://localhost/pull', { method: 'POST', headers: { authorization: `Bearer ${token(actor)}`, 'content-type': 'application/json' }, body: JSON.stringify(request) }, env, ctx);
        return { status: response.status, body: await response.json() as any };
      });
      clients.set(actor, c);
    }
    const adopt = async (actor: string) => clients.get(actor)!.reconcile((await loadManifest(db, actor)).manifest);
    await Promise.all(ACTORS.map(adopt));

    let counter = 0;
    try {
      for (let step = 0; step < OPERATIONS; step++) {
        const roll = random();
        if (roll < 0.14) { const id = pick([...roots, ...roots.map((_, i) => `B${i}`), ...roots.map((_, i) => `B${i}_${1 + Math.floor(random() * 4)}`)]); await db.prepare("UPDATE records SET data=json_set(data,'$.n',?), seq=? WHERE id=?").bind(++counter, await next(), id).run(); log.push(`edit ${id}`); }
        else if (roll < 0.20) { const id = pick(roots); const on = random() < 0.5; await db.prepare("UPDATE records SET data=json_set(data,'$.deleted',json(?)), seq=? WHERE id=?").bind(on ? 'true' : 'false', await next(), id).run(); log.push(`${on ? 'delete' : 'restore'} ${id}`); }
        else if (roll < 0.28) { const root = pick(roots), id = `N${++counter}`; await insert(id, 'blocks', { pageId: root, text: id }, (await spaceOf(root))!); log.push(`insert ${id} under ${root}`); }
        else if (roll < 0.40) { const root = pick(roots), to = pick(SPACES.filter(space => space !== null)); const outcome = await moveRoot(db, { id: 'mover' }, { recordId: root, toSpaceId: to, requestId: `mv-${seed}-${step}` }).then(() => 'ok', (error: Error) => error.message); if (outcome === 'ok') coverage.moves++; log.push(`move ${root} -> ${to}: ${outcome}`); }
        else if (roll < 0.48) { const from = pick(roots), to = pick(roots.filter(r => r !== from)), id = `L${++counter}`; const r = await relate(id, from, to); await insert(id, 'links', r.data, r.home, r.peer); links.push(id); coverage.links++; log.push(`link ${id} ${from}->${to}`); }
        else if (roll < 0.54 && links.length) {
          const id = pick(links); const row = await db.prepare('SELECT data FROM records WHERE id=?').bind(id).first<{ data: string }>(); const data = JSON.parse(row!.data);
          const to = pick(roots.filter(r => r !== data.fromId)); const r = await relate(id, data.fromId, to);
          await db.prepare("UPDATE records SET data=json_set(data,'$.toId',?), space_id=?, peer_space_id=?, seq=? WHERE id=?").bind(to, r.home, r.peer, await next(), id).run(); coverage.retargets++; log.push(`retarget ${id} -> ${to}`);
        } else if (roll < 0.66) {
          const user = pick(ACTORS), space = pick(['s1', 's2', 's3']), choice = pick(['remove', 'viewer', 'editor', 'deny']);
          if (choice === 'remove') await db.prepare('DELETE FROM space_members WHERE space_id=? AND user_id=?').bind(space, user).run();
          else await db.prepare('INSERT INTO space_members(space_id,user_id,role,access) VALUES(?,?,?,?) ON CONFLICT(space_id,user_id) DO UPDATE SET role=excluded.role,access=excluded.access').bind(space, user, choice === 'deny' ? 'editor' : choice, choice === 'deny' ? 'deny' : 'allow').run();
          coverage.memberships++; log.push(`member ${user} ${space} ${choice}`);
        } else if (roll < 0.70) { const removed = await pruneSpaceEvents(env, Date.now() + 40 * 86_400_000); if (removed) coverage.prunes++; log.push(`prune ${removed}`); }
        else { const actor = pick(ACTORS), pages = 1 + Math.floor(random() * 3); for (let i = 0; i < pages; i++) { const reply = await clients.get(actor)!.step(8 + Math.floor(random() * 9)); if (reply.status === 200 && reply.body.hasMore) coverage.partialSyncs++; } log.push(`sync ${actor} x${pages}`); }
      }
      // Quiescence: no more writes. Every client pages until its feed is exhausted.
      for (const actor of ACTORS) await clients.get(actor)!.sync(8 + Math.floor(random() * 33));
      for (const actor of ACTORS) {
        const c = clients.get(actor)!, manifest = (await loadManifest(db, actor)).manifest, readable = new Set(manifest.spaces.map(s => s.id));
        const rows = (await db.prepare('SELECT id,collection,data,seq,space_id,peer_space_id FROM records ORDER BY id').all<{ id: string; collection: string; data: string; seq: number; space_id: string; peer_space_id: string | null }>()).results
          .filter(r => readable.has(r.space_id) && (!r.peer_space_id || readable.has(r.peer_space_id)));
        const wanted = rows.map(r => r.id).sort();
        if (JSON.stringify(c.ids()) !== JSON.stringify(wanted) && process.env.PHASE5_LOG_ALL) {
          for (const id of [...new Set([...c.ids().filter(x => !wanted.includes(x)), ...wanted.filter(x => !c.ids().includes(x))])]) {
            const server = await db.prepare('SELECT id,seq,space_id,peer_space_id,data FROM records WHERE id=?').bind(id).first();
            log.push(`DIAG ${actor} ${id}: client=${JSON.stringify(c.live.get(id))} server=${JSON.stringify(server)} manifest=${[...readable]} settled=${[...c.settled]} joining=${[...c.joining.keys()]} clientlog=${c.log.join('|')}`);
          }
        }
        expect(c.ids(), `${actor} rows`).toEqual(wanted);
        for (const r of rows) {
          const mine = c.live.get(r.id)!;
          expect({ seq: mine.seq, space: mine.spaceId, data: mine.data }, `${actor} ${r.id}`).toEqual({ seq: r.seq, space: r.space_id, data: JSON.parse(r.data) });
        }
        for (const line of c.log) { if (line.includes('manifest_changed')) coverage.manifestChanged++; if (line.includes('rebackfill_required')) coverage.rebackfill++; if (line.includes('cursor_ahead')) coverage.cursorAhead++; }
        expect(c.dangling(), `${actor} dangling relations (no client-side sweep exists; facts alone must suffice)`).toEqual([]);
        expect(c.joining.size, `${actor} still joining`).toBe(0);
        expect([...c.settled].sort(), `${actor} settled`).toEqual([...readable].sort());
      }
    } catch (error) {
      console.error(`PHASE5 PROPERTY FAILURE seed=${seed}\n${(process.env.PHASE5_LOG_ALL ? log : log.slice(-40)).join('\n')}`);
      throw error;
    }
  }, 120_000);

  it('the schedules exercised every protocol branch (the property is not vacuous)', () => {
    expect(coverage.moves).toBeGreaterThanOrEqual(10);
    expect(coverage.links).toBeGreaterThanOrEqual(10); expect(coverage.retargets).toBeGreaterThanOrEqual(3);
    expect(coverage.memberships).toBeGreaterThanOrEqual(20); expect(coverage.prunes).toBeGreaterThanOrEqual(3);
    expect(coverage.partialSyncs).toBeGreaterThanOrEqual(25);
    expect(coverage.manifestChanged).toBeGreaterThanOrEqual(10); expect(coverage.rebackfill).toBeGreaterThanOrEqual(1);
    console.log('property coverage', JSON.stringify(coverage));
  });
});
