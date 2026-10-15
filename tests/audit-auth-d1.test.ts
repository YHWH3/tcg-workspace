// Cross-phase audit regressions — authentication, session lifetime and live
// connections (Phase 0 sessions × Phase 1 live presence × Phase 4 OAuth/MCP).
// Invariants: password guessing is throttled on every password-accepting
// endpoint, rotating a credential revokes what was derived from it, and an
// open WebSocket never outlives the session that authorized it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth, me } from '../worker/auth';
import { admin } from '../worker/admin';
import { hashPassword, newSalt, sha256Hex } from '../worker/password';
import { openAuditFixture, ctx, type AuditFixture } from './audit-fixture';

// The DurableObject base class only exists in workerd; the room's own logic
// (sweep + session validation) is exercised against fake sockets and real D1.
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) { this.ctx = ctx; this.env = env; }
  },
}));

let fx: AuditFixture;
const PASSWORD = 'correct horse battery';
const grants = { items: [{ id: 'g1' }, { id: 'g2' }] };
const oauth = { listUserGrants: vi.fn(async () => grants), revokeGrant: vi.fn(async () => {}) };

beforeEach(async () => {
  oauth.listUserGrants.mockClear();
  oauth.revokeGrant.mockClear();
  fx = await openAuditFixture([{ id: 'alice', role: 'admin' }, { id: 'bob' }], { OAUTH_PROVIDER: oauth as never });
  const salt = newSalt();
  const hash = await hashPassword(PASSWORD, Uint8Array.from(atob(salt), (c) => c.charCodeAt(0)));
  await fx.db.prepare('UPDATE users SET password_hash=?, salt=? WHERE id IN (?,?)').bind(hash, salt, 'alice', 'bob').run();
});
afterEach(async () => { await fx.dispose(); });

const login = (username: string, password: string, ip = '203.0.113.7') =>
  auth.request('http://localhost/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ username, password }),
  }, fx.env, ctx);

describe('login attempts are throttled', () => {
  it('locks a (client, account) pair after repeated failures — even for the correct password', async () => {
    for (let i = 0; i < 10; i++) expect((await login('bob', 'wrong-password-' + i)).status).toBe(401);
    const blocked = await login('bob', PASSWORD);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('does not lock other clients or accounts out', async () => {
    for (let i = 0; i < 10; i++) await login('bob', 'wrong-password-' + i);
    expect((await login('bob', PASSWORD, '198.51.100.9')).status).toBe(200);
    expect((await login('alice', PASSWORD)).status).toBe(200);
  });

  it('a successful login clears the failure count', async () => {
    for (let i = 0; i < 9; i++) await login('bob', 'wrong-password-' + i);
    expect((await login('bob', PASSWORD)).status).toBe(200);
    for (let i = 0; i < 9; i++) expect((await login('bob', 'again-wrong-' + i)).status).toBe(401);
    expect((await login('bob', PASSWORD)).status).toBe(200);
  });

  it('the window expires', async () => {
    for (let i = 0; i < 10; i++) await login('bob', 'wrong-password-' + i);
    expect((await login('bob', PASSWORD)).status).toBe(429);
    await fx.db.prepare('UPDATE rate_limits SET reset_at=1').run();
    expect((await login('bob', PASSWORD)).status).toBe(200);
  });
});

describe('rotating or removing a credential revokes OAuth/MCP grants derived from it', () => {
  it('changing the password revokes every grant of that user (sessions were already revoked)', async () => {
    const res = await me.request('http://localhost/password', {
      method: 'POST', headers: fx.auth('bob'), body: JSON.stringify({ current: PASSWORD, next: 'a brand new passphrase' }),
    }, fx.env, ctx);
    expect(res.status).toBe(200);
    expect(oauth.listUserGrants).toHaveBeenCalledWith('bob', expect.anything());
    expect(oauth.revokeGrant.mock.calls).toEqual([['g1', 'bob'], ['g2', 'bob']]);
  });

  it('removing a user revokes their grants', async () => {
    const res = await admin.request('http://localhost/users/bob', { method: 'DELETE', headers: fx.auth('alice') }, fx.env, ctx);
    expect(res.status).toBe(200);
    expect(oauth.revokeGrant.mock.calls).toEqual([['g1', 'bob'], ['g2', 'bob']]);
  });
});

describe('open live sockets are bound to their session', () => {
  interface Socket { att: unknown; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; serializeAttachment(a: unknown): void; deserializeAttachment(): unknown }
  const socket = (att: Record<string, unknown>): Socket => ({
    att, send: vi.fn(), close: vi.fn(),
    serializeAttachment(a) { this.att = a; },
    deserializeAttachment() { return this.att; },
  });

  async function room(sockets: Socket[]) {
    const { LiveRoom } = await import('../worker/live');
    const state = { storage: { getAlarm: async () => 1, setAlarm: vi.fn() }, getWebSockets: () => sockets, acceptWebSocket: vi.fn() };
    return new LiveRoom(state as never, fx.env);
  }

  it('the periodic sweep closes sockets whose session was revoked, expired or whose user was removed', async () => {
    const live = socket({ userId: 'bob', sid: await sha256Hex(fx.token('bob')), path: '/', lastSeen: Date.now() });
    const loggedOut = socket({ userId: 'alice', sid: await sha256Hex('a-token-that-was-revoked'), path: '/', lastSeen: Date.now() });
    const r = await room([live, loggedOut]);
    await r.alarm();
    expect(live.close).not.toHaveBeenCalled();
    expect(loggedOut.close).toHaveBeenCalled();
  });

  it('a revoked session stops receiving presence and change pokes after the next sweep', async () => {
    const sid = await sha256Hex(fx.token('bob'));
    const s = socket({ userId: 'bob', sid, path: '/pages/secret', lastSeen: Date.now() });
    const r = await room([s]);
    await fx.db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(sid).run();
    await r.alarm();
    expect(s.close).toHaveBeenCalled();
  });
});
