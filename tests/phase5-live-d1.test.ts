// Runtime regression: the REAL Worker (worker/index.ts bundled with esbuild) and the REAL
// LiveRoom Durable Object in workerd/Miniflare, with D1. While permissions are enabled a
// socket is scoped: its route is never recorded or shared, and it never receives anyone's
// route — a path such as /pages/<id> names a record the recipient may not be allowed to read.
// Presence (who is online) and change pokes still flow. With permissions disabled, Phase 0–4
// presence is unchanged. Permissions are enabled only inside this disposable fixture.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../worker/password';

// PHASE5_LIVE_ENTRY points the bundle at another source tree (red-evidence runs only).
let mf: Miniflare, db: D1Database;
const token = (id: string) => `live-fixture-${id}`;
type Msg = { t: string; users?: { userId: string; path: string }[] };
interface Client { user: string; messages: Msg[]; send: (m: unknown) => void; close: () => void }

beforeAll(async () => {
  const bundle = await build({ entryPoints: [process.env.PHASE5_LIVE_ENTRY ?? fileURLToPath(new URL('../worker/index.ts', import.meta.url))], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
    external: ['cloudflare:*', 'node:*'], mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'browser'], write: false, logLevel: 'error' });
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'phase5-live', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-25', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'disposable-phase5-live' }, kvNamespaces: ['OAUTH_KV'], durableObjects: { LIVE: { className: 'LiveRoom', useSQLite: true } } }] }));
  db = await mf.getD1Database('DB') as unknown as D1Database;
  const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const name of readdirSync(folder).filter(n => n.endsWith('.sql')).sort()) {
    const sql = readFileSync(`${folder}/${name}`, 'utf8').replace(/--[^\n]*/g, '');
    await db.batch((sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi) ?? []).map(s => db.prepare(s.trim())));
  }
  for (const id of ['alice', 'bob', 'carol']) {
    await db.prepare("INSERT INTO users(id,username,name,role,workspace_role) VALUES(?,?,?,'member','member')").bind(id, id, id).run();
    await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await sha256Hex(token(id)), id, Date.now() + 86_400_000, Date.now()).run();
  }
}, 120_000);
afterAll(async () => { await mf?.dispose(); });
const open: Client[] = [];
beforeEach(async () => { while (open.length) open.pop()!.close(); await new Promise(r => setTimeout(r, 100)); await enable(false); });

const enable = (on: boolean) => db.prepare('UPDATE access_state SET enabled=? WHERE id=1').bind(on ? 1 : 0).run();
async function connect(user: string): Promise<Client> {
  const res = await mf.dispatchFetch('http://localhost/api/live', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `ws-auth, ${token(user)}` } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const messages: Msg[] = [];
  ws.addEventListener('message', (event) => { messages.push(JSON.parse(String(event.data)) as Msg); });
  ws.accept();
  const client = { user, messages, send: (m: unknown) => ws.send(JSON.stringify(m)), close: () => { try { ws.close(); } catch { /* closed */ } } };
  open.push(client);
  return client;
}
const settle = () => new Promise(r => setTimeout(r, 250));
const routes = (c: Client) => c.messages.filter(m => m.t === 'presence').flatMap(m => m.users ?? []).map(u => u.path);
const lastPresence = (c: Client) => [...c.messages].reverse().find(m => m.t === 'presence')?.users ?? [];

describe('live presence on the real Worker and LiveRoom (actual runtime)', () => {
  it('permissions disabled: routes are shared exactly as before (Phase 0–4)', async () => {
    const alice = await connect('alice'), bob = await connect('bob');
    bob.send({ t: 'here', path: '/pages/plan' }); await settle();
    expect(lastPresence(alice)).toContainEqual({ userId: 'bob', path: '/pages/plan' });
  });

  it('enabled: a scoped socket never sends or receives a route, but presence still flows', async () => {
    await enable(true);
    const alice = await connect('alice'), bob = await connect('bob');
    bob.send({ t: 'here', path: '/pages/secret-vault-page' }); alice.send({ t: 'here', path: '/boards/private-board' }); await settle();
    expect(lastPresence(alice).map(u => u.userId).sort()).toEqual(['alice', 'bob']);   // who is online still flows
    expect(lastPresence(bob).map(u => u.userId).sort()).toEqual(['alice', 'bob']);
    for (const c of [alice, bob]) expect(new Set(routes(c))).toEqual(new Set(['/']));
    expect(JSON.stringify([alice.messages, bob.messages])).not.toMatch(/secret-vault-page|private-board/);
  });

  it('a socket opened before activation keeps its own view, but never sees a scoped user\'s route, and scoped users never see its route', async () => {
    const carol = await connect('carol');             // legacy socket (permissions still off)
    await enable(true);
    const bob = await connect('bob');                 // scoped socket
    carol.send({ t: 'here', path: '/pages/carol-legacy-route' }); bob.send({ t: 'here', path: '/pages/secret-vault-page' }); await settle();
    expect(JSON.stringify(bob.messages)).not.toMatch(/carol-legacy-route/);         // scoped recipient: no routes at all
    expect(JSON.stringify(carol.messages)).not.toMatch(/secret-vault-page/);        // a scoped route is never recorded
    expect(lastPresence(carol)).toContainEqual({ userId: 'bob', path: '/' });
    expect(lastPresence(bob)).toContainEqual({ userId: 'carol', path: '/' });
  });

  it('an unauthenticated or revoked session cannot open a socket at all', async () => {
    await enable(true);
    const none = await mf.dispatchFetch('http://localhost/api/live', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'ws-auth, not-a-session' } });
    expect(none.status).toBe(401);
    await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256Hex(token('carol'))).run();
    const revoked = await mf.dispatchFetch('http://localhost/api/live', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `ws-auth, ${token('carol')}` } });
    expect(revoked.status).toBe(401);
  });
});
