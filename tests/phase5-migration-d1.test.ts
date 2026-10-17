// Migration 0017 (per-space feed schema): applied through BOTH SQL splitters the
// project uses (the vitest fixture regex and `wrangler d1 migrations apply`), upgraded
// over populated data, and its triggers/floor exercised on actual D1.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyChanges } from '../worker/sync';
import type { Env } from '../worker/auth';

vi.mock('../worker/events', async original => ({ ...await original<typeof import('../worker/events')>(), scheduleOutbox: vi.fn() }));
const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
const files = readdirSync(folder).filter(n => n.endsWith('.sql')).sort();
let mf: Miniflare | undefined;
afterEach(async () => { await mf?.dispose(); mf = undefined; });

async function open(until?: string): Promise<D1Database> {
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'phase5-migration', modules: true,
    script: 'export default {fetch(){return new Response("disposable migration fixture")}}', compatibilityDate: '2026-09-25', d1Databases: { DB: 'disposable-phase5-migration' } }] }));
  const db = await mf.getD1Database('DB') as D1Database;
  for (const name of files) { if (until && name > until) break; await apply(db, name); }
  return db;
}
async function apply(db: D1Database, name: string) {
  const sql = readFileSync(`${folder}/${name}`, 'utf8').replace(/--[^\n]*/g, '');
  await db.batch((sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi) ?? []).map(s => db.prepare(s.trim())));
}
const put = (db: D1Database, id: string, collection: string, data: Record<string, unknown>, seq: number, space = 'space-core', peer: string | null = null) =>
  db.prepare('INSERT INTO records(id,collection,data,field_ts,seq,space_id,peer_space_id) VALUES(?,?,?,?,?,?,?)').bind(id, collection, JSON.stringify(data), '{}', seq, space, peer).run();
const events = async (db: D1Database) => (await db.prepare('SELECT space_id,seq,record_id,kind FROM space_events ORDER BY space_id,seq,record_id').all()).results;

describe('migration 0017 schema', () => {
  it('is the last migration and creates the per-space feed objects', async () => {
    expect(files).toContain('0017_phase5_space_feeds.sql');
    const db = await open();
    const names = (await db.prepare("SELECT name FROM sqlite_master WHERE name IN ('seq_floor','space_events','idx_space_events_created','idx_records_peer_seq','p5_seq_floor','p5_space_event_move','p5_space_event_link_retarget') ORDER BY name").all<{ name: string }>()).results.map(r => r.name);
    expect(names).toEqual(['idx_records_peer_seq', 'idx_space_events_created', 'p5_seq_floor', 'p5_space_event_link_retarget', 'p5_space_event_move', 'seq_floor', 'space_events']);
    expect(await db.prepare('SELECT floor FROM seq_floor WHERE id=1').first('floor')).toBe(0);
    expect(await db.prepare("SELECT events_floor FROM spaces WHERE id='space-core'").first('events_floor')).toBe(0);
    expect(await db.prepare('SELECT enabled FROM access_state WHERE id=1').first('enabled')).toBe(0); // activation stays off
  });

  it('applies through `wrangler d1 migrations apply` too (a different SQL splitter)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tcg-phase5-migration-')), config = join(dir, 'wrangler.json'), state = join(dir, 'state');
    writeFileSync(config, JSON.stringify({ name: 'tcg-phase5-migration', compatibility_date: '2026-09-25',
      d1_databases: [{ binding: 'DB', database_name: 'workspace-db', database_id: '00000000-0000-0000-0000-000000000004', migrations_dir: resolve(folder) }] }));
    const env = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_API_KEY: '' };
    const wrangler = resolve('node_modules/.bin/wrangler');
    execFileSync(wrangler, ['d1', 'migrations', 'apply', 'DB', '--local', '--config', config, '--persist-to', state], { env, stdio: 'pipe', timeout: 120_000 });
    const out = execFileSync(wrangler, ['d1', 'execute', 'DB', '--local', '--config', config, '--persist-to', state, '--json', '--command',
      "SELECT name FROM sqlite_master WHERE name IN ('seq_floor','space_events','p5_seq_floor','p5_space_event_move','p5_space_event_link_retarget','idx_records_peer_seq') ORDER BY name"], { env, stdio: 'pipe', timeout: 120_000 }).toString();
    const rows = (JSON.parse(out) as { results: { name: string }[] }[]).flatMap(r => r.results).map(r => r.name);
    expect(rows).toEqual(['idx_records_peer_seq', 'p5_seq_floor', 'p5_space_event_link_retarget', 'p5_space_event_move', 'seq_floor', 'space_events']);
  }, 180_000);

  it('upgrades populated data: link peers are backfilled, nothing else is rewritten', async () => {
    const db = await open('0016_phase5_thumbnail_visibility.sql');
    await db.prepare("INSERT INTO spaces(id,name,default_access,created_at) VALUES('other','Other','private',1)").run();
    await db.batch([
      db.prepare("INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES('a','pages','{\"title\":\"A\"}','{}',1,'space-core')"),
      db.prepare("INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES('b','pages','{\"title\":\"B\"}','{}',2,'other')"),
      db.prepare("INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES('same','links','{\"fromId\":\"a\",\"toId\":\"a\"}','{}',3,'space-core')"),
      db.prepare("INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES('cross','links','{\"fromId\":\"a\",\"toId\":\"b\"}','{}',4,'space-core')"),
      db.prepare("INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES('dangling','links','{\"fromId\":\"a\",\"toId\":\"nobody\"}','{}',5,'space-core')"),
    ]);
    const before = (await db.prepare('SELECT id,data,field_ts,seq,space_id,updated_at FROM records ORDER BY id').all()).results;
    await apply(db, '0017_phase5_space_feeds.sql');
    const after = (await db.prepare('SELECT id,data,field_ts,seq,space_id,updated_at FROM records ORDER BY id').all()).results;
    expect(after).toEqual(before);
    expect((await db.prepare('SELECT id,peer_space_id FROM records ORDER BY id').all()).results).toEqual([
      { id: 'a', peer_space_id: null }, { id: 'b', peer_space_id: null }, { id: 'cross', peer_space_id: 'other' },
      { id: 'dangling', peer_space_id: null }, { id: 'same', peer_space_id: null }]);
    expect(await events(db)).toEqual([]);
  });
});

describe('migration 0018 retires the generation and snapshot machinery', () => {
  it('drops the generation triggers and snapshot tables over a populated database, leaving data untouched', async () => {
    const db = await open('0017_phase5_space_feeds.sql');
    await db.prepare("INSERT INTO users(id,username,name,role) VALUES('u','u','u','member')").run();
    await db.prepare("INSERT INTO sync_snapshots(id,user_id,request_id,generation,cutoff,page_size,cursor_secret,created_at,expires_at) VALUES('s','u','r',1,0,50,'x',1,2)").run();
    await db.prepare("INSERT INTO sync_snapshot_items(snapshot_id,ordinal,record_id,collection,data,field_ts,seq) VALUES('s',1,'a','pages','{}','{}',1)").run();
    await put(db, 'a', 'pages', { title: 'A' }, 1);
    const before = (await db.prepare('SELECT * FROM records').all()).results;
    const generation = await db.prepare('SELECT generation FROM access_state WHERE id=1').first('generation');
    expect(Number(await db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name IN ('p5_session_delete','p5_record_visibility','p5_member_insert','p5_access_activation','p5_file_aux_visibility')").first('n'))).toBe(5);
    await apply(db, '0018_phase5_retire_generation_snapshots.sql');
    expect(Number(await db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE (type='trigger' AND name IN ('p5_space_insert','p5_space_update','p5_space_delete','p5_member_insert','p5_member_update','p5_member_delete','p5_user_insert','p5_user_update','p5_user_delete','p5_session_delete','p5_record_scope','p5_record_visibility','p5_record_delete_visibility','p5_access_activation','p5_file_aux_visibility')) OR name IN ('sync_snapshots','sync_snapshot_items')").first('n'))).toBe(0);
    expect((await db.prepare('SELECT * FROM records').all()).results).toEqual(before);
    expect(await db.prepare('SELECT generation FROM access_state WHERE id=1').first('generation')).toBe(generation);
    // Authority changes are now silent on the counter.
    await db.prepare("UPDATE users SET workspace_role='guest' WHERE id='u'").run();
    expect(await db.prepare('SELECT generation FROM access_state WHERE id=1').first('generation')).toBe(generation);
  });
});

describe('sequence floor (FD-17)', () => {
  it('the next write never reuses a revision a hard delete just removed', async () => {
    const db = await open(), env = { DB: db } as Env;
    await db.prepare("INSERT INTO users(id,username,name,role) VALUES('u','u','u','member')").run();
    await put(db, 'pending-upload', 'files', { parentType: 'form-pending', parentId: 'f' }, 100);
    // The two production hard deletes (form upload cleanup, 24h orphan sweep) remove such a row.
    await db.prepare("DELETE FROM records WHERE id='pending-upload'").run();
    expect(await db.prepare('SELECT floor FROM seq_floor WHERE id=1').first('floor')).toBe(100);
    const result = await applyChanges(env, 'u', [{ id: 'after', collection: 'pages', patch: { title: 'x' }, ts: Date.now() }]);
    expect(result.changed).toBe(1);
    expect(Number(await db.prepare("SELECT seq FROM records WHERE id='after'").first('seq'))).toBeGreaterThan(100);
  });

  it('the floor only ever rises', async () => {
    const db = await open();
    await put(db, 'high', 'pages', {}, 50); await put(db, 'low', 'pages', {}, 5);
    await db.prepare("DELETE FROM records WHERE id='high'").run();
    await db.prepare("DELETE FROM records WHERE id='low'").run();
    expect(await db.prepare('SELECT floor FROM seq_floor WHERE id=1').first('floor')).toBe(50);
  });
});

describe('eviction fact triggers', () => {
  async function fixture() {
    const db = await open();
    await db.prepare("INSERT INTO spaces(id,name,default_access,created_at) VALUES('a','A','private',1),('b','B','private',1),('c','C','private',1)").run();
    await put(db, 'page', 'pages', { title: 'P' }, 1, 'a');
    await put(db, 'link', 'links', { fromType: 'page', fromId: 'page', toType: 'page', toId: 'other', label: 'x' }, 2, 'a', 'b');
    return db;
  }

  it('a space_id rewrite emits exactly one eviction fact for the OLD space, at the new revision', async () => {
    const db = await fixture();
    await db.prepare("UPDATE records SET space_id='c', seq=10 WHERE id='page'").run();
    expect(await events(db)).toEqual([{ space_id: 'a', seq: 10, record_id: 'page', kind: 'evict' }]);
  });

  it('an unchanged space_id (a normal edit, or an upsert that restates the space) emits nothing', async () => {
    const db = await fixture();
    await db.prepare("UPDATE records SET space_id='a', seq=11, data=json_set(data,'$.title','Edited') WHERE id='page'").run();
    await db.prepare("INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES('page','pages','{}','{}',12,'a') ON CONFLICT(id) DO UPDATE SET seq=excluded.seq, space_id=excluded.space_id").run();
    expect(await events(db)).toEqual([]);
  });

  it('retargeting a link emits facts for its previous home and previous peer', async () => {
    const db = await fixture();
    await db.prepare("UPDATE records SET data=json_set(data,'$.toId','elsewhere'), peer_space_id='c', seq=20 WHERE id='link'").run();
    expect(await events(db)).toEqual([{ space_id: 'a', seq: 20, record_id: 'link', kind: 'evict' }, { space_id: 'b', seq: 20, record_id: 'link', kind: 'evict' }]);
  });

  it('editing only a link label emits nothing', async () => {
    const db = await fixture();
    await db.prepare("UPDATE records SET data=json_set(data,'$.label','renamed'), seq=21 WHERE id='link'").run();
    expect(await events(db)).toEqual([]);
  });

  it('a move that also retargets emits one fact per old space, not a constraint failure', async () => {
    const db = await fixture();
    await db.prepare("UPDATE records SET space_id='c', peer_space_id='a', data=json_set(data,'$.toId','moved'), seq=30 WHERE id='link'").run();
    expect(await events(db)).toEqual([{ space_id: 'a', seq: 30, record_id: 'link', kind: 'evict' }, { space_id: 'b', seq: 30, record_id: 'link', kind: 'evict' }]);
  });
});
