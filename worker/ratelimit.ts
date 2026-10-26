// Fixed-window counters in the server-only `rate_limits` D1 table (migration
// 0007). Shared by public forms and by every endpoint that accepts a password.
// Counters never sync and hold no content: (bucket, key) → count, reset_at.

import type { Env } from './auth';

/** Sliding-window counter, atomic against concurrent hits. Returns the count
 *  this request consumed (the caller compares it to its limit). */
export async function rateLimitHit(env: { DB: D1Database }, bucket: string, key: string, windowMs: number): Promise<number> {
  const now = Date.now();
  const resetAt = now + windowMs;
  await env.DB.prepare('INSERT INTO rate_limits (bucket, key, count, reset_at) VALUES (?, ?, 0, 0) ON CONFLICT(bucket, key) DO NOTHING').bind(bucket, key).run();
  const row = await env.DB
    .prepare(
      `UPDATE rate_limits
         SET count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END,
             reset_at = CASE WHEN reset_at <= ? THEN ? ELSE reset_at END
       WHERE bucket = ? AND key = ?
       RETURNING count`,
    )
    .bind(now, now, resetAt, bucket, key)
    .first<{ count: number }>();
  return row?.count ?? 1;
}

/* ---------- password-guessing throttle ---------- */

/** Failures tolerated per (client address, account) in one window. */
export const LOGIN_ACCOUNT_LIMIT = 10;
/** Failures tolerated per client address, across accounts. */
export const LOGIN_CLIENT_LIMIT = 40;
/** Failures tolerated per account from anywhere in one hour. Bounds distributed
 *  guessing. Trade-off (accepted, documented in the audit register): a
 *  sustained attack from many addresses can hold one account in lockout for the
 *  window; per-client buckets keep any single address from doing so cheaply. */
export const LOGIN_DISTRIBUTED_LIMIT = 300;
export const LOGIN_WINDOW_MS = 15 * 60_000;
const DISTRIBUTED_WINDOW_MS = 60 * 60_000;

export function clientAddress(req: { header(name: string): string | undefined }): string {
  // cf-connecting-ip is set by Cloudflare and cannot be supplied by the caller.
  return (req.header('cf-connecting-ip') ?? 'local').slice(0, 64);
}

const norm = (username: string) => username.trim().toLowerCase().slice(0, 64);

/** 0 when the attempt may proceed, else the seconds until the window reopens. */
export async function loginRetryAfter(env: { DB: D1Database }, ip: string, username: string): Promise<number> {
  const now = Date.now();
  const user = norm(username);
  const { results } = await env.DB
    .prepare(
      `SELECT bucket, count, reset_at FROM rate_limits WHERE reset_at > ? AND
         ((bucket='login_acct' AND key=?) OR (bucket='login_ip' AND key=?) OR (bucket='login_user' AND key=?))`,
    )
    .bind(now, `${ip}|${user}`, ip, user)
    .all<{ bucket: string; count: number; reset_at: number }>();
  const limits: Record<string, number> = { login_acct: LOGIN_ACCOUNT_LIMIT, login_ip: LOGIN_CLIENT_LIMIT, login_user: LOGIN_DISTRIBUTED_LIMIT };
  let wait = 0;
  for (const r of results) if (r.count >= (limits[r.bucket] ?? Infinity)) wait = Math.max(wait, Math.ceil((r.reset_at - now) / 1000));
  return wait;
}

export async function recordLoginFailure(env: { DB: D1Database }, ip: string, username: string): Promise<void> {
  const user = norm(username);
  await rateLimitHit(env, 'login_acct', `${ip}|${user}`, LOGIN_WINDOW_MS);
  await rateLimitHit(env, 'login_ip', ip, LOGIN_WINDOW_MS);
  await rateLimitHit(env, 'login_user', user, DISTRIBUTED_WINDOW_MS);
}

/** A correct password proves the legitimate owner is at the keyboard. */
export async function clearLoginFailures(env: { DB: D1Database }, ip: string, username: string): Promise<void> {
  await env.DB.prepare("DELETE FROM rate_limits WHERE bucket='login_acct' AND key=?").bind(`${ip}|${norm(username)}`).run();
}

/** Revoke OAuth/MCP grants, with bounded pagination. Strict callers must keep
 * restoration closed on provider failure or an unfinished sweep. Other credential
 * changes retain best-effort behavior; callers can inspect the boolean result. */
export async function revokeAllGrants(env: Pick<Env, 'OAUTH_PROVIDER'>, userId: string, strict=false): Promise<boolean> {
  const provider = env.OAUTH_PROVIDER;
  if (!provider) {if(strict)throw new Error('connector_revocation_unavailable');return false;}
  try {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const out = await provider.listUserGrants(userId, { limit: 100, ...(cursor ? { cursor } : {}) });
      for (const grant of out.items) {if(typeof grant.id!=='string'||!grant.id)throw new Error('invalid_grant');await provider.revokeGrant(grant.id, userId);}
      if (!out.cursor) return true;
      cursor = out.cursor;
    }
    throw new Error('connector_revocation_incomplete');
  } catch {
    if(strict)throw new Error('connector_revocation_incomplete');
    // Provider errors may contain request details. Never log credentials or URLs.
    console.error(JSON.stringify({ message: 'grant revocation failed', userId }));
    return false;
  }
}
