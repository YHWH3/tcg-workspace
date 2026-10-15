import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import type { PublicUser } from '../shared/types';
import { hashPassword, inviteCode, newSalt, randomToken, sha256Hex, verifyPassword } from './password';
import { clearLoginFailures, clientAddress, loginRetryAfter, recordLoginFailure, revokeAllGrants } from './ratelimit';

import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_HOSTNAMES?: string;
  /** Disposable loopback HTTP fixtures only; omitted in deployed config. */
  WORKSPACE_ENV?: string;
  /** MCP write tool calls per user per 10 minutes (default 300; 0 disables). */
  MCP_WRITE_LIMIT?: string;
  TURNSTILE_LOCAL_TEST?: string;
  DB: D1Database;
  AI: Ai;
  LIVE: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  /** Injected by the OAuthProvider wrapper — MCP OAuth helpers. */
  OAUTH_PROVIDER: OAuthHelpers;
}

export interface AuthUser extends PublicUser {
  tokenHash: string;
}

export const MAX_USERS = 7;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_RENEW_MS = 15 * 24 * 60 * 60 * 1000;

const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;
const USER_COLORS = ['#e5484d', '#e93d82', '#8e4ec6', '#6e56cf', '#0091ff', '#12a594', '#30a46c', '#e5a000'];

type Ctx = Context<{ Bindings: Env; Variables: { user: AuthUser } }>;

/* ---------- Notification prefs (Phase 4 §4, Workstream B) ----------
 * users.prefs is a JSON blob; NULL = all defaults. Only the shape below is
 * stored — PATCH /api/me sanitizes unknown keys/values away. Notification
 * data itself lives in the server-controlled `notifications` table, never
 * in a synced collection. */
export type NotifKind =
  | 'mention'
  | 'assigned'
  | 'comment_on_mine'
  | 'due_soon'
  | 'overdue'
  | 'approval_requested'
  | 'approval_decided'
  | 'form_submission'
  | 'automation';

export const NOTIF_KINDS: readonly NotifKind[] = [
  'mention',
  'assigned',
  'comment_on_mine',
  'due_soon',
  'overdue',
  'approval_requested',
  'approval_decided',
  'form_submission',
  'automation',
];

export interface UserPrefs {
  /** Per-kind delivery: 'inbox' (default) or 'off'. */
  notifications?: Partial<Record<NotifKind, 'inbox' | 'off'>>;
  /** Quiet digest: low-urgency kinds still land in the Inbox but do not
   * count against the nav badge. */
  quietDigest?: boolean;
}

/** Drop every key/value that isn't part of the prefs contract. */
export function sanitizePrefs(raw: unknown): UserPrefs {
  const out: UserPrefs = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  const n = (raw as Record<string, unknown>).notifications;
  if (typeof n === 'object' && n !== null && !Array.isArray(n)) {
    const notif: Partial<Record<NotifKind, 'inbox' | 'off'>> = {};
    for (const k of NOTIF_KINDS) {
      const v = (n as Record<string, unknown>)[k];
      if (v === 'inbox' || v === 'off') notif[k] = v;
    }
    if (Object.keys(notif).length) out.notifications = notif;
  }
  if (typeof (raw as Record<string, unknown>).quietDigest === 'boolean') {
    out.quietDigest = (raw as Record<string, unknown>).quietDigest as boolean;
  }
  return out;
}

/** Deep-merge an incoming (already sanitized) prefs patch onto stored prefs. */
export function mergePrefs(stored: UserPrefs, patch: UserPrefs): UserPrefs {
  const out: UserPrefs = { ...stored, notifications: { ...(stored.notifications ?? {}) } };
  if (patch.notifications) {
    for (const k of NOTIF_KINDS) {
      const v = patch.notifications[k];
      if (v === undefined) continue;
      if (v === 'inbox') delete out.notifications![k]; // 'inbox' is the default — store nothing
      else out.notifications![k] = v;
    }
    if (out.notifications && !Object.keys(out.notifications).length) delete out.notifications;
  }
  if (patch.quietDigest !== undefined) out.quietDigest = patch.quietDigest;
  return out;
}

/** The server-side delivery gate used by notify(): per-kind inbox|off.
 * Recipient restriction (e.g. form notifyUserIds) is the caller's job. */
export function kindAllowed(prefs: UserPrefs | null | undefined, kind: NotifKind): boolean {
  return prefs?.notifications?.[kind] !== 'off';
}

/** Parse the users.prefs column (NULL/malformed → {}). */
export function parsePrefs(raw: unknown): UserPrefs {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    return sanitizePrefs(JSON.parse(raw));
  } catch {
    return {};
  }
}

export async function loadPrefs(db: D1Database, userId: string): Promise<UserPrefs> {
  const row = await db.prepare('SELECT prefs FROM users WHERE id = ?').bind(userId).first<{ prefs: string | null }>();
  return parsePrefs(row?.prefs);
}

export async function userByToken(db: D1Database, token: string): Promise<AuthUser | null> {
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT s.token_hash, s.expires_at, u.id, u.username, u.name, u.role, u.color
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    )
    .bind(tokenHash)
    .first<{ token_hash: string; expires_at: number; id: string; username: string; name: string; role: 'admin' | 'member'; color: string }>();
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at < now) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  if (row.expires_at - now < SESSION_RENEW_MS) {
    await db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').bind(now + SESSION_TTL_MS, tokenHash).run();
  }
  return { id: row.id, username: row.username, name: row.name, role: row.role, color: row.color, tokenHash };
}

export async function requireAuth(c: Ctx, next: Next) {
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return c.json({ error: 'unauthenticated' }, 401);
  const user = await userByToken(c.env.DB, token);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  c.set('user', user);
  await next();
}

export async function requireAdmin(c: Ctx, next: Next) {
  if (c.get('user').role !== 'admin') return c.json({ error: 'forbidden' }, 403);
  await next();
}

function publicUser(u: { id: string; username: string; name: string; role: 'admin' | 'member'; color: string }): PublicUser {
  return { id: u.id, username: u.username, name: u.name, role: u.role, color: u.color };
}

async function createSession(db: D1Database, userId: string): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, now + SESSION_TTL_MS, now)
    .run();
  return token;
}

async function userCount(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS c FROM users').first<{ c: number }>();
  return row?.c ?? 0;
}

export const auth = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

auth.get('/status', async (c) => {
  const count = await userCount(c.env.DB);
  return c.json({ needsBootstrap: count === 0, seatsUsed: count, seatsTotal: MAX_USERS });
});

auth.post('/signup', async (c) => {
  const body = await c.req.json<{ username?: string; name?: string; password?: string; inviteCode?: string }>().catch(() => null);
  if (!body) return c.json({ error: 'invalid body' }, 400);
  const username = (body.username ?? '').trim().toLowerCase();
  const name = (body.name ?? '').trim() || username;
  const password = body.password ?? '';
  if (!USERNAME_RE.test(username)) return c.json({ error: 'Username must be 3-32 chars: a-z 0-9 _ . -' }, 400);
  if (password.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400);

  const db = c.env.DB;
  const count = await userCount(db);
  const bootstrap = count === 0;

  if (count >= MAX_USERS) return c.json({ error: 'Workspace is full (7 seats)' }, 403);

  let role: 'admin' | 'member' = 'member';
  if (bootstrap) {
    role = 'admin';
  } else {
    const code = (body.inviteCode ?? '').trim().toUpperCase();
    if (!code) return c.json({ error: 'Invite code required' }, 403);
    const invite = await db.prepare('SELECT code, used_by FROM invites WHERE code = ?').bind(code).first();
    if (!invite || invite.used_by) return c.json({ error: 'Invalid or used invite code' }, 403);
  }

  const id = crypto.randomUUID();
  const salt = newSalt();
  const hash = await hashPassword(password, Uint8Array.from(atob(salt), (ch) => ch.charCodeAt(0)));
  const color = USER_COLORS[count % USER_COLORS.length];
  const now = Date.now();

  if (!bootstrap) {
    const code = (body.inviteCode ?? '').trim().toUpperCase();
    const redeemed = await db
      .prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL')
      .bind(id, now, code)
      .run();
    if (!redeemed.meta.changes) return c.json({ error: 'Invalid or used invite code' }, 403);
  }

  try {
    await db
      .prepare('INSERT INTO users (id, username, name, password_hash, salt, role, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, username, name, hash, salt, role, color, now)
      .run();
  } catch (e) {
    if (!bootstrap) {
      await db.prepare('UPDATE invites SET used_by = NULL, used_at = NULL WHERE used_by = ?').bind(id).run();
    }
    if (String(e).includes('UNIQUE')) return c.json({ error: 'Username taken' }, 409);
    throw e;
  }

  const seats = await userCount(db);
  if (seats > MAX_USERS) {
    await db.batch([
      db.prepare('DELETE FROM users WHERE id = ?').bind(id),
      db.prepare('UPDATE invites SET used_by = NULL, used_at = NULL WHERE used_by = ?').bind(id),
    ]);
    return c.json({ error: 'Workspace is full (7 seats)' }, 403);
  }

  const token = await createSession(db, id);
  return c.json({ token, user: publicUser({ id, username, name, role, color }) });
});

/** Burned for unknown usernames so response time does not reveal which
 * accounts exist (a real verification costs one PBKDF2 derivation). */
const DUMMY_SALT = new Uint8Array(16);

auth.post('/login', async (c) => {
  const body = await c.req.json<{ username?: string; password?: string }>().catch(() => null);
  if (!body?.username || !body.password) return c.json({ error: 'invalid body' }, 400);
  const ip = clientAddress(c.req);
  const wait = await loginRetryAfter(c.env, ip, body.username);
  if (wait > 0) {
    c.header('Retry-After', String(wait));
    return c.json({ error: 'Too many failed attempts. Try again later.' }, 429);
  }
  const row = await c.env.DB
    .prepare('SELECT id, username, name, role, color, password_hash, salt FROM users WHERE username = ?')
    .bind(body.username.trim().toLowerCase())
    .first<{ id: string; username: string; name: string; role: 'admin' | 'member'; color: string; password_hash: string; salt: string }>();
  if (!row) await hashPassword(body.password, DUMMY_SALT);
  if (!row || !(await verifyPassword(body.password, row.salt, row.password_hash))) {
    await recordLoginFailure(c.env, ip, body.username);
    return c.json({ error: 'Invalid username or password' }, 401);
  }
  await clearLoginFailures(c.env, ip, body.username);
  const token = await createSession(c.env.DB, row.id);
  return c.json({ token, user: publicUser(row) });
});

auth.post('/logout', requireAuth, async (c) => {
  await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(c.get('user').tokenHash).run();
  return c.json({ ok: true });
});

export const me = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
me.use('*', requireAuth);

me.get('/', async (c) => {
  const user = c.get('user');
  const row = await c.env.DB.prepare('SELECT prefs FROM users WHERE id = ?').bind(user.id).first<{ prefs: string | null }>();
  return c.json({ user: publicUser(user), prefs: parsePrefs(row?.prefs) });
});

me.patch('/', async (c) => {
  const body = await c.req.json<{ name?: string; color?: string; prefs?: unknown }>().catch(() => null);
  if (!body) return c.json({ error: 'invalid body' }, 400);
  const user = c.get('user');
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : user.name;
  const color = typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color : user.color;
  let prefs: UserPrefs | undefined;
  if (body.prefs !== undefined) {
    const existing = await loadPrefs(c.env.DB, user.id);
    prefs = mergePrefs(existing, sanitizePrefs(body.prefs));
    await c.env.DB.prepare('UPDATE users SET name = ?, color = ?, prefs = ? WHERE id = ?')
      .bind(name, color, JSON.stringify(prefs), user.id)
      .run();
  } else {
    await c.env.DB.prepare('UPDATE users SET name = ?, color = ? WHERE id = ?').bind(name, color, user.id).run();
    prefs = await loadPrefs(c.env.DB, user.id);
  }
  return c.json({ user: publicUser({ ...user, name, color }), prefs });
});

me.post('/password', async (c) => {
  const body = await c.req.json<{ current?: string; next?: string }>().catch(() => null);
  if (!body?.current || !body.next) return c.json({ error: 'invalid body' }, 400);
  if (body.next.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400);
  const user = c.get('user');
  const row = await c.env.DB.prepare('SELECT password_hash, salt FROM users WHERE id = ?').bind(user.id).first<{ password_hash: string; salt: string }>();
  if (!row || !(await verifyPassword(body.current, row.salt, row.password_hash))) {
    return c.json({ error: 'Current password is incorrect' }, 403);
  }
  const salt = newSalt();
  const hash = await hashPassword(body.next, Uint8Array.from(atob(salt), (ch) => ch.charCodeAt(0)));
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').bind(hash, salt, user.id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(user.id, user.tokenHash),
  ]);
  // Sessions were already revoked; MCP/OAuth grants are credentials derived
  // from the same password and must not survive its rotation.
  await revokeAllGrants(c.env, user.id);
  return c.json({ ok: true });
});

export { inviteCode };
