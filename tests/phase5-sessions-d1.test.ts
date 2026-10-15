import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { auth, me, userByToken, type Env } from '../worker/auth';
import { Hono } from 'hono';
import { interceptD1Batches } from './d1WriteBoundary';
import { sha256Hex } from '../worker/password';

let runtime: Miniflare, db: D1Database, app: Hono;
beforeEach(async () => {
  runtime = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'phase5-sessions', modules: true,
    script: 'export default {fetch(){return new Response("disposable session fixture")}}',
    compatibilityDate: '2026-09-25', d1Databases: { DB: 'disposable-phase5-sessions', LEGACY: 'disposable-phase5-session-upgrade' },
  }] }));
  db = await runtime.getD1Database('DB') as D1Database;
  const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const name of readdirSync(folder).filter(n => n.endsWith('.sql')).sort()) {
    const sql = readFileSync(`${folder}/${name}`, 'utf8').replace(/--[^\n]*/g, '');
    await db.batch((sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi) ?? []).map(s => db.prepare(s.trim())));
  }
  app = new Hono(); app.route('/auth', auth); app.route('/me', me);
  const exported = await import('../worker/auth') as unknown as { sessionsApi?: Hono };
  if (exported.sessionsApi) app.route('/sessions', exported.sessionsApi);
});
afterEach(async () => { await runtime.dispose(); });
const call = (path: string, token?: string, method = 'GET', body?: unknown) => app.request(`http://localhost${path}`, {
  method, headers: { 'Content-Type': 'application/json', 'User-Agent': 'Disposable browser fixture', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
}, { DB: db } as Env);
async function owner() { const r = await call('/auth/signup', undefined, 'POST', { username: 'alice', password: 'fixture-password' }); return await r.json() as { token: string; user: { id: string } }; }
async function login() { const r = await call('/auth/login', undefined, 'POST', { username: 'alice', password: 'fixture-password' }); return (await r.json() as { token: string }).token; }
interface SessionPage { sessions: { id: string; current: boolean; device: string; createdAt: number; lastSeenAt: number; expiresAt: number }[]; nextCursor: string | null }

it('lists only owned sessions with opaque IDs and current-device indication, without credentials', async () => {
  const alice = await owner(), second = await login();
  await db.prepare("INSERT INTO users(id,username,role) VALUES('bob','bob','member')").run();
  await db.prepare("INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES('foreign-hash','bob',?,?)").bind(Date.now(), Date.now() + 86400_000).run();
  const response = await call('/sessions', alice.token); expect(response.status).toBe(200);
  const text = await response.text(), page = JSON.parse(text) as SessionPage;
  expect(page.sessions).toHaveLength(2); expect(page.sessions.filter(s => s.current)).toHaveLength(1);
  expect(page.sessions.every(s => s.device === 'Disposable browser fixture' && s.id.length >= 32)).toBe(true);
  expect(text).not.toMatch(/token_hash|password|foreign-hash/); expect(text).not.toContain(alice.token); expect(text).not.toContain(second);
});

it('revokes another owned device but keeps the current session and records an audit', async () => {
  const alice = await owner(), otherToken = await login();
  const page = await (await call('/sessions', alice.token)).json() as SessionPage, other = page.sessions.find(s => !s.current)!;
  expect((await call(`/sessions/${other.id}`, alice.token, 'DELETE')).status).toBe(200);
  expect((await call('/me', otherToken)).status).toBe(401); expect((await call('/me', alice.token)).status).toBe(200);
  expect(await db.prepare("SELECT COUNT(*) n FROM access_audit WHERE action='revoke_session'").first('n')).toBe(1);
  expect((await call(`/sessions/${other.id}`, alice.token, 'DELETE')).status).toBe(404);
});

it('rejects another account session ID exactly like a missing ID and leaves its credentials valid', async () => {
  const alice = await owner();
  await db.prepare("INSERT INTO users(id,username,role) VALUES('bob','bob','member')").run();
  await db.prepare("INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES('foreign-hash','bob',?,?)").bind(Date.now(), Date.now() + 86400_000).run();
  const foreign = await db.prepare("SELECT id FROM sessions WHERE user_id='bob'").first<string>('id');
  expect((await call(`/sessions/${foreign}`, alice.token, 'DELETE')).status).toBe(404);
  expect(await db.prepare("SELECT COUNT(*) n FROM sessions WHERE user_id='bob'").first('n')).toBe(1);
});

it('revokes all other sessions, is safe to repeat, and supports current-device logout', async () => {
  const alice = await owner(), others = await Promise.all([login(), login()]);
  expect((await call('/sessions/others', alice.token, 'DELETE')).status).toBe(200);
  for (const token of others) expect((await call('/me', token)).status).toBe(401);
  expect((await call('/sessions/others', alice.token, 'DELETE')).status).toBe(200);
  const page = await (await call('/sessions', alice.token)).json() as SessionPage;
  expect(page.sessions).toHaveLength(1); expect(page.sessions[0].current).toBe(true);
  expect((await call(`/sessions/${page.sessions[0].id}`, alice.token, 'DELETE')).status).toBe(200);
  expect((await call('/sessions', alice.token)).status).toBe(401);
});

it('enforces expiry and disabled-user rejection for login and existing credentials', async () => {
  const alice = await owner();
  await db.prepare('UPDATE sessions SET expires_at=? WHERE user_id=?').bind(Date.now() - 1, alice.user.id).run();
  expect((await call('/sessions', alice.token)).status).toBe(401);
  const fresh = await login(); await db.prepare('UPDATE users SET disabled_at=? WHERE id=?').bind(Date.now(), alice.user.id).run();
  expect((await call('/me', fresh)).status).toBe(401);
  expect((await call('/auth/login', undefined, 'POST', { username: 'alice', password: 'fixture-password' })).status).toBe(401);
});

it('paginates active sessions without duplicates, expiry rows or another account metadata', async () => {
  const alice = await owner(), now = Date.now();
  for (let i = 0; i < 105; i++) await db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)').bind(`pagination-fixture-${i}`, alice.user.id, now + i, now + 86400_000).run();
  const seen: string[] = []; let cursor: string | null = null;
  do {
    const response = await call(`/sessions${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`, alice.token); expect(response.status).toBe(200);
    const page = await response.json() as SessionPage; expect(page.sessions.length).toBeLessThanOrEqual(50);
    seen.push(...page.sessions.map(s => s.id)); cursor = page.nextCursor;
    expect(seen.length).toBeLessThanOrEqual(106);
  } while (cursor);
  expect(seen).toHaveLength(106); expect(new Set(seen).size).toBe(106);
  expect((await call('/sessions?cursor=invalid', alice.token)).status).toBe(400);
});

it('does not revoke another device if the caller session is revoked between authentication and commit', async () => {
  const alice = await owner(), otherToken = await login(), hash = await sha256Hex(alice.token);
  let intercepted = false;
  const raced = interceptD1Batches(db, async (target, statements, sql) => {
    if (!intercepted && sql.some(s => /DELETE FROM sessions/.test(s))) {
      intercepted = true; await target.prepare('DELETE FROM sessions WHERE token_hash=?').bind(hash).run();
    }
    return target.batch(statements);
  });
  const response = await app.request('http://localhost/sessions/others', { method: 'DELETE', headers: { Authorization: `Bearer ${alice.token}` } }, { DB: raced } as Env);
  expect(response.status).toBe(401); expect(intercepted).toBe(true);
  expect((await call('/me', otherToken)).status).toBe(200);
  expect(await db.prepare("SELECT COUNT(*) n FROM access_audit WHERE action='revoke_other_sessions'").first('n')).toBe(0);
});

it('adds metadata to old sessions without changing credential hashes, owners or expiry', async () => {
  const legacy = await runtime.getD1Database('LEGACY') as D1Database;
  const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const name of readdirSync(folder).filter(n => n.endsWith('.sql') && n < '0015').sort()) {
    const sql = readFileSync(`${folder}/${name}`, 'utf8').replace(/--[^\n]*/g, '');
    await legacy.batch((sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi) ?? []).map(s => legacy.prepare(s.trim())));
  }
  const token = 'legacy-fixture-secret', hash = await sha256Hex(token), expiry = Date.now() + 30 * 86400_000;
  await legacy.prepare("INSERT INTO users(id,username,role) VALUES('old','old','member')").run();
  await legacy.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)').bind(hash, 'old', 123, expiry).run();
  const before = await legacy.prepare('SELECT * FROM sessions').first();
  const sql = readFileSync(`${folder}/0015_phase5_sessions.sql`, 'utf8').replace(/--[^\n]*/g, '');
  await legacy.batch((sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi) ?? []).map(s => legacy.prepare(s.trim())));
  const after = await legacy.prepare('SELECT * FROM sessions').first<{ id: string; device_label: string; last_seen_at: number }>();
  expect(after).toMatchObject({ ...before, device_label: 'Unknown device', last_seen_at: 123 });
  expect(after!.id).toMatch(/^[a-f0-9]{32}$/); expect(after!.id).not.toBe(hash);
  expect((await userByToken(legacy, token))!.id).toBe('old');
  expect(await legacy.prepare('SELECT token_hash,user_id,expires_at,created_at FROM sessions').first()).toEqual(before);
});
