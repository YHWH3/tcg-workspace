import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { auth, type Env } from '../worker/auth';
import { interceptD1Batches } from './d1WriteBoundary';

let runtime: Miniflare, db: D1Database;
beforeEach(async () => {
  runtime = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'phase5-auth', modules: true,
    script: 'export default {fetch(){return new Response("disposable signup fixture")}}',
    compatibilityDate: '2026-09-25', d1Databases: { DB: 'disposable-phase5-auth' },
  }] }));
  db = await runtime.getD1Database('DB') as D1Database;
  const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const name of readdirSync(folder).filter(n => n.endsWith('.sql')).sort()) {
    const sql = readFileSync(`${folder}/${name}`, 'utf8').replace(/--[^\n]*/g, '');
    await db.batch((sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi) ?? []).map(s => db.prepare(s.trim())));
  }
});
afterEach(async () => { await runtime.dispose(); });
const signup = (username: string, inviteCode?: string, database = db) => auth.request('http://localhost/signup', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, name: username, password: 'fixture-only-password', inviteCode }),
}, { DB: database } as Env);
async function seed(n: number) {
  for (let i = 0; i < n; i++) await db.prepare('INSERT INTO users(id,username,name,role,workspace_role) VALUES(?,?,?,?,?)')
    .bind(`seed-${i}`, `seed-${i}`, `seed-${i}`, i === 0 ? 'admin' : 'member', i === 0 ? 'owner' : 'member').run();
}
async function invite(code: string) { await db.prepare('INSERT INTO invites(code,created_by,created_at) VALUES(?,?,?)').bind(code, 'seed-0', 1).run(); }

it('bootstraps workspace and Core ownership with an audit and session, leaving permission activation off', async () => {
  const response = await signup('founder'); expect(response.status).toBe(200);
  const body = await response.json() as { user: { id: string; role: string }; token: string };
  expect(body.user.role).toBe('admin'); expect(body.token).toBeTruthy();
  expect(await db.prepare('SELECT workspace_role FROM users WHERE id=?').bind(body.user.id).first()).toEqual({ workspace_role: 'owner' });
  expect(await db.prepare("SELECT role,access FROM space_members WHERE space_id='space-core' AND user_id=?").bind(body.user.id).first()).toEqual({ role: 'owner', access: 'allow' });
  expect(await db.prepare("SELECT created_by FROM spaces WHERE id='space-core'").first()).toEqual({ created_by: body.user.id });
  expect(await db.prepare("SELECT COUNT(*) n FROM access_audit WHERE actor_id=? AND action='bootstrap_owner'").bind(body.user.id).first('n')).toBe(1);
  expect(await db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').bind(body.user.id).first('n')).toBe(1);
  expect(await db.prepare('SELECT enabled FROM access_state WHERE id=1').first('enabled')).toBe(0);
});

it('elects exactly one owner during concurrent initial signup', async () => {
  const responses = await Promise.all([signup('first'), signup('second')]);
  expect(responses.filter(r => r.status === 200)).toHaveLength(1);
  expect(await db.prepare('SELECT COUNT(*) n FROM users').first('n')).toBe(1);
  expect(await db.prepare("SELECT COUNT(*) n FROM users WHERE workspace_role='owner'").first('n')).toBe(1);
  expect(await db.prepare('SELECT COUNT(*) n FROM sessions').first('n')).toBe(1);
});

it('redeems a shared invite exactly once without orphaned accounts or sessions', async () => {
  await seed(1); await invite('SHARED');
  const responses = await Promise.all([signup('inviteone', 'SHARED'), signup('invitetwo', 'SHARED')]);
  expect(responses.filter(r => r.status === 200)).toHaveLength(1);
  expect(await db.prepare('SELECT COUNT(*) n FROM users').first('n')).toBe(2);
  expect(await db.prepare('SELECT COUNT(*) n FROM sessions').first('n')).toBe(1);
  const id = await db.prepare("SELECT used_by FROM invites WHERE code='SHARED'").first<string>('used_by');
  expect(await db.prepare('SELECT workspace_role FROM users WHERE id=?').bind(id).first('workspace_role')).toBe('member');
});

it('atomically admits only the seventh seat when two different invites race', async () => {
  await seed(6); await invite('SEATA'); await invite('SEATB');
  const responses = await Promise.all([signup('seatone', 'SEATA'), signup('seattwo', 'SEATB')]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 403]);
  expect(await db.prepare('SELECT COUNT(*) n FROM users').first('n')).toBe(7);
  expect(await db.prepare('SELECT COUNT(*) n FROM invites WHERE used_by IS NULL').first('n')).toBe(1);
  expect(await db.prepare('SELECT COUNT(*) n FROM sessions').first('n')).toBe(1);
});

it('rolls back the account, invite redemption and audit if session persistence fails', async () => {
  await seed(1); await invite('RETRY');
  await db.prepare("CREATE TRIGGER fail_fixture_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'fixture session failure'); END").run();
  const response = await signup('retryuser', 'RETRY'); expect(response.status).toBe(500);
  expect(await db.prepare('SELECT COUNT(*) n FROM users').first('n')).toBe(1);
  expect(await db.prepare("SELECT used_by FROM invites WHERE code='RETRY'").first('used_by')).toBeNull();
  expect(await db.prepare('SELECT COUNT(*) n FROM access_audit').first('n')).toBe(0);
  await db.prepare('DROP TRIGGER fail_fixture_session').run(); expect((await signup('retryuser', 'RETRY')).status).toBe(200);
});

it('rolls back bootstrap ownership if the atomic commit is interrupted', async () => {
  const broken = interceptD1Batches(db, (target, statements, sql) => target.batch(sql.some(s => /INSERT INTO users/.test(s))
    ? [...statements, target.prepare("SELECT json_extract('{','$')")] : statements));
  expect((await signup('retryfounder', undefined, broken)).status).toBe(500);
  expect(await db.prepare('SELECT COUNT(*) n FROM users').first('n')).toBe(0);
  expect(await db.prepare('SELECT COUNT(*) n FROM space_members').first('n')).toBe(0);
  expect(await db.prepare('SELECT COUNT(*) n FROM sessions').first('n')).toBe(0);
  expect((await signup('retryfounder')).status).toBe(200);
});

it('keeps an invite usable after a username conflict and never changes existing identity', async () => {
  await seed(1); await invite('AVAILABLE');
  expect((await signup('seed-0', 'AVAILABLE')).status).toBe(409);
  expect(await db.prepare("SELECT used_by FROM invites WHERE code='AVAILABLE'").first('used_by')).toBeNull();
  expect(await db.prepare("SELECT workspace_role FROM users WHERE id='seed-0'").first('workspace_role')).toBe('owner');
  expect((await signup('newmember', 'AVAILABLE')).status).toBe(200);
  expect(await db.prepare('SELECT COUNT(*) n FROM users').first('n')).toBe(2);
});
