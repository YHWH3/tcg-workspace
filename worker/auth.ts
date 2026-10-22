import { usableInviteSql } from './guestInvites';
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
  /** Exact trusted media hosts; no remote network imports unless explicitly configured. */
  REMOTE_IMPORT_HOSTS?: string;
  AI_PROVIDER?:'none'|'workers-ai';
  AI_DAILY_UNITS?:string;
  AI_CLASSIFICATION?:string;
  TURNSTILE_LOCAL_TEST?: string;
  /** Shared HMAC secret for POST /api/ingest/website (worker/websiteIngest.ts). Secret, never a var. */
  WEBSITE_INGEST_SECRET?: string;
  /** '1' or 'true' turns the website inbox on; anything else answers 503. */
  WEBSITE_INGEST_ENABLED?: string;
  DB: D1Database;
  AI: Ai;
  LIVE: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  /** Injected by the OAuthProvider wrapper — MCP OAuth helpers. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** Request-scoped, never a binding: the caller's read gate (worker/readAccess.ts).
   * Present only on the per-request copy built by `withReadGate`. */
  /** Server-created request constraint; never a client binding or tool argument. */
  /** In-process MCP planner; never exposed through bindings or HTTP input. */
  MCP_PLAN?: {ops: import('./aiPreviews').PreviewOp[];expected:Map<string,number>};
  CONNECTOR?: import('./connectorAccess').ConnectorAuthority;
  READ_GATE?: import('./readAccess').ReadGate;
  /** The ungated environment of the same request (service reads only). */
  SERVICE_ENV?: Env;
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
      `SELECT s.token_hash, s.expires_at, s.last_seen_at, u.id, u.username, u.name, u.role, u.color
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND u.disabled_at IS NULL`,
    )
    .bind(tokenHash)
    .first<{ token_hash: string; expires_at: number; last_seen_at: number | null; id: string; username: string; name: string; role: 'admin' | 'member'; color: string }>();
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at <= now) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  if (row.expires_at - now < SESSION_RENEW_MS || (row.last_seen_at ?? 0) < now - 5 * 60_000) {
    await db.prepare('UPDATE sessions SET expires_at=?,last_seen_at=? WHERE token_hash=?')
      .bind(row.expires_at - now < SESSION_RENEW_MS ? now + SESSION_TTL_MS : row.expires_at, now, tokenHash).run();
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
  // A buffered authenticated read can outlive its credential. Recheck before
  // committing headers/body; writes retain their existing transactional fences.
  if ((c.req.method === 'GET' || c.req.method === 'HEAD') && c.res.status < 400) {
    const active = await c.env.DB.prepare(`SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>? AND u.disabled_at IS NULL`)
      .bind(user.tokenHash,user.id,Date.now()).first();
    if (!active) c.res = c.json({error:'unauthenticated'},401);
  }
}

export async function requireAdmin(c: Ctx, next: Next) {
  if (c.get('user').role !== 'admin') return c.json({ error: 'forbidden' }, 403);
  await next();
}

function publicUser(u: { id: string; username: string; name: string; role: 'admin' | 'member'; color: string }): PublicUser {
  return { id: u.id, username: u.username, name: u.name, role: u.role, color: u.color };
}

function deviceLabel(value: string | undefined): string {
  return (value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 160) || 'Unknown device';
}
async function createSession(db: D1Database, userId: string, device: string): Promise<string | null> {
  const token = randomToken();
  const now = Date.now();
  const created = await db
    .prepare(`INSERT INTO sessions (token_hash,user_id,expires_at,created_at,id,device_label,last_seen_at)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL)`)
    .bind(await sha256Hex(token), userId, now + SESSION_TTL_MS, now, crypto.randomUUID(), device, now, userId)
    .run();
  return created.meta.changes === 1 ? token : null;
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
  const body = await c.req.json<{ username?: string; name?: string; password?: string; inviteCode?: string; guestInvite?:string }>().catch(() => null);
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

  const guestHash=typeof body.guestInvite==='string'&&body.guestInvite.length<=100?await sha256Hex(body.guestInvite):null;
  let role: 'admin' | 'member' = 'member';
  if (bootstrap) {
    role = 'admin';
  } else if(guestHash){
    const invite=await db.prepare(`SELECT id FROM guest_invites i WHERE i.token_hash=? AND ${usableInviteSql()}`).bind(guestHash,Date.now()).first();
    if(!invite)return c.json({error:'Invalid, expired or revoked invitation'},403);
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

  const code = (body.inviteCode ?? '').trim().toUpperCase();
  const token = randomToken(), tokenHash = await sha256Hex(token);
  // Ownership, capacity, invite redemption and the returned session are one
  // D1 transaction. In particular the pre-hash count is never authority: two
  // first-signup requests must not each create a workspace owner.
  const eligibility = bootstrap ? 'NOT EXISTS(SELECT 1 FROM users)'
    : guestHash ? `EXISTS(SELECT 1 FROM guest_invites i WHERE token_hash=? AND ${usableInviteSql()})` : 'EXISTS(SELECT 1 FROM invites WHERE code=? AND used_by IS NULL)';
  const insert = db.prepare(`INSERT INTO users
    (id,username,name,password_hash,salt,role,workspace_role,color,created_at)
    SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM users) < ? AND ${eligibility}`);
  const values = [id, username, name, hash, salt, role, bootstrap ? 'owner' : guestHash ? 'guest' : 'member', color, now, MAX_USERS];
  const statements = [
    insert.bind(...values, ...(bootstrap ? [] : guestHash ? [guestHash,now] : [code])),
    db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM users WHERE id=?) THEN 1 ELSE json_extract('{','$') END").bind(id),
  ];
  if (bootstrap) {
    statements.push(
      db.prepare("INSERT INTO space_members(space_id,user_id,role,access,updated_at) VALUES('space-core',?,'owner','allow',?)").bind(id, now),
      db.prepare("UPDATE spaces SET created_by=? WHERE id='space-core'").bind(id),
      db.prepare(`INSERT INTO access_audit(id,actor_id,space_id,action,after_json,generation,created_at)
        SELECT ?,?,'space-core','bootstrap_owner',?,generation,? FROM access_state WHERE id=1`)
        .bind(crypto.randomUUID(), id, JSON.stringify({ workspaceRole: 'owner', spaceRole: 'owner' }), now),
    );
  } else if(guestHash){
    statements.push(db.prepare(`INSERT INTO space_members(space_id,user_id,role,access,updated_at) SELECT space_id,?,role,'allow',? FROM guest_invites WHERE token_hash=?`).bind(id,now,guestHash),db.prepare('UPDATE guest_invites SET used_by=?,used_at=? WHERE token_hash=?').bind(id,now,guestHash),db.prepare(`INSERT INTO access_audit(id,actor_id,space_id,target_user_id,action,after_json,generation,created_at) SELECT ?,?,space_id,?,'guest_signup',json_object('inviteId',id,'role',role),(SELECT generation FROM access_state WHERE id=1),? FROM guest_invites WHERE token_hash=?`).bind(crypto.randomUUID(),id,id,now,guestHash));
  } else {
    statements.push(db.prepare('UPDATE invites SET used_by=?,used_at=? WHERE code=? AND used_by IS NULL').bind(id, now, code));
  }
  statements.push(db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at,id,device_label,last_seen_at) VALUES(?,?,?,?,?,?,?)')
    .bind(tokenHash, id, now + SESSION_TTL_MS, now, crypto.randomUUID(), deviceLabel(c.req.header('user-agent')), now));
  try {
    await db.batch(statements);
  } catch (error) {
    // Read-only diagnosis after rollback. Never compensate by deleting a user:
    // another request may already own the invite/capacity we observed earlier.
    if (await db.prepare('SELECT id FROM users WHERE username=?').bind(username).first()) return c.json({ error: 'Username taken' }, 409);
    if ((await userCount(db)) >= MAX_USERS) return c.json({ error: 'Workspace is full (7 seats)' }, 403);
    if (bootstrap && (await userCount(db)) > 0) return c.json({ error: 'Workspace already initialized; use an invite' }, 409);
    if(guestHash)return c.json({error:'Invalid, expired, revoked or already used invitation'},409);
    if (!bootstrap) {
      const available = await db.prepare('SELECT code FROM invites WHERE code=? AND used_by IS NULL').bind(code).first();
      if (!available) return c.json({ error: 'Invalid or used invite code' }, 403);
    }
    throw error;
  }

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
    .prepare('SELECT id, username, name, role, color, password_hash, salt FROM users WHERE username = ? AND disabled_at IS NULL')
    .bind(body.username.trim().toLowerCase())
    .first<{ id: string; username: string; name: string; role: 'admin' | 'member'; color: string; password_hash: string; salt: string }>();
  if (!row) await hashPassword(body.password, DUMMY_SALT);
  if (!row || !(await verifyPassword(body.password, row.salt, row.password_hash))) {
    await recordLoginFailure(c.env, ip, body.username);
    return c.json({ error: 'Invalid username or password' }, 401);
  }
  const token = await createSession(c.env.DB, row.id, deviceLabel(c.req.header('user-agent')));
  if (!token) return c.json({ error: 'Invalid username or password' }, 401);
  await clearLoginFailures(c.env, ip, body.username);
  return c.json({ token, user: publicUser(row) });
});

auth.post('/logout', requireAuth, async (c) => {
  await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(c.get('user').tokenHash).run();
  return c.json({ ok: true });
});

export const sessionsApi = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
sessionsApi.use('*', requireAuth);
sessionsApi.get('/', async c => {
  const user = c.get('user'), raw = c.req.query('cursor');
  let after: [number, string] | null = null;
  if (raw !== undefined) {
    try {
      const decoded: unknown = JSON.parse(raw);
      if (!Array.isArray(decoded) || decoded.length !== 2 || !Number.isSafeInteger(decoded[0]) || decoded[0] < 0
          || typeof decoded[1] !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(decoded[1])) throw new Error('cursor');
      after = decoded as [number, string];
    } catch { return c.json({ error: 'invalid_cursor' }, 400); }
  }
  const { results } = await c.env.DB.prepare(`SELECT id,device_label,created_at,last_seen_at,expires_at,
    CASE WHEN token_hash=? THEN 1 ELSE 0 END is_current FROM sessions
    WHERE user_id=? AND expires_at>? ${after ? 'AND (created_at < ? OR (created_at=? AND id < ?))' : ''}
    ORDER BY created_at DESC,id DESC LIMIT 51`)
    .bind(user.tokenHash, user.id, Date.now(), ...(after ? [after[0], after[0], after[1]] : []))
    .all<{ id: string; device_label: string; created_at: number; last_seen_at: number | null; expires_at: number; is_current: number }>();
  const page = results.slice(0, 50), last = page.at(-1);
  return c.json({ sessions: page.map(row => ({ id: row.id, device: row.device_label, current: row.is_current === 1,
    createdAt: row.created_at, lastSeenAt: row.last_seen_at ?? row.created_at, expiresAt: row.expires_at })),
    nextCursor: results.length > 50 && last ? JSON.stringify([last.created_at, last.id]) : null });
});

/** Ownership is constrained in the DELETE itself, not just a preflight lookup.
 * The session/disabled check, deletion and access audit share one transaction. */
async function revokeSessions(c: Ctx, others: boolean) {
  const user = c.get('user'), id = others ? null : c.req.param('id');
  if (!others && (!id || !/^[a-zA-Z0-9-]{16,64}$/.test(id))) return c.json({ error: 'not found' }, 404);
  const db = c.env.DB, now = Date.now();
  let result: D1Result[];
  try {
    result = await db.batch([
      db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>? AND u.disabled_at IS NULL)
        THEN 1 ELSE json_extract('{','$') END`).bind(user.tokenHash, user.id, now),
      db.prepare(`DELETE FROM sessions WHERE user_id=? AND ${others ? 'token_hash != ?' : 'id=?'}`)
        .bind(user.id, others ? user.tokenHash : id),
      db.prepare(`INSERT INTO access_audit(id,actor_id,action,after_json,generation,created_at)
        SELECT ?,?,?,?,generation,? FROM access_state WHERE id=1 AND changes()>0`)
        .bind(crypto.randomUUID(), user.id, others ? 'revoke_other_sessions' : 'revoke_session', JSON.stringify(others ? { scope: 'others' } : { sessionId: id }), now),
    ]);
  } catch (error) {
    if (!await db.prepare(`SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>? AND u.disabled_at IS NULL`).bind(user.tokenHash, user.id, Date.now()).first()) {
      return c.json({ error: 'unauthenticated' }, 401);
    }
    throw error;
  }
  const revoked = result[1].meta.changes;
  if (!others && !revoked) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true, revoked });
}
sessionsApi.delete('/others', c => revokeSessions(c, true));
sessionsApi.delete('/:id', c => revokeSessions(c, false));

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
