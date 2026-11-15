import { Hono } from 'hono';
import { startOfWeek } from '../shared/dates';
import { parsePrefs, requireAuth, type AuthUser, type Env } from './auth';
import { notificationEmailOrigin, type EmailEnv } from './email';
import { serverDateContext } from './workspaceSettings';
import { rateLimitHit } from './ratelimit';

export async function enqueueEmailDigests(env: {DB:D1Database} & EmailEnv, now = Date.now()) {
  if (!notificationEmailOrigin(env)) return;
  const settings = await serverDateContext(env, now);
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: settings.timeZone, hour: '2-digit', hourCycle: 'h23',
  }).format(now));
  const week = startOfWeek(settings.today, 1);
  const {results} = await env.DB.prepare(`
    SELECT id,prefs,email_verified_at FROM users
    WHERE email IS NOT NULL AND email_verified_at IS NOT NULL AND disabled_at IS NULL
    ORDER BY id LIMIT 7`
  ).all<{id:string;prefs:string|null;email_verified_at:number}>();
  const writes = results.flatMap(row => {
    const prefs = parsePrefs(row.prefs);
    if ((prefs.emailDigest !== 'daily' && prefs.emailDigest !== 'weekly') || hour < (prefs.digestHour ?? 7)) return [];
    const key = prefs.emailDigest === 'daily' ? 'd:' + settings.today : 'w:' + week;
    return [env.DB.prepare(`
      INSERT OR IGNORE INTO email_outbox(id,user_id,kind,digest_key,verified_at,created_at,next_attempt_at)
      SELECT ?,id,'digest',?,email_verified_at,?,? FROM users
      WHERE id=? AND disabled_at IS NULL AND email IS NOT NULL AND email_verified_at=? AND prefs IS ?`
    ).bind(crypto.randomUUID(),key,now,now,row.id,row.email_verified_at,row.prefs)];
  });
  if (writes.length) await env.DB.batch(writes);
}

export const emailDigestApi = new Hono<{Bindings:Env;Variables:{user:AuthUser}}>();
emailDigestApi.use('*', requireAuth);
emailDigestApi.post('/test', async c => {
  if (!notificationEmailOrigin(c.env)) return c.json({error:'Email delivery is currently unavailable.'},503);
  const user = c.get('user');
  const now = Date.now();
  if (await rateLimitHit(c.env,'email_digest_test',user.id,15*60_000)>2) {
    return c.json({error:'Too many test digests. Wait 15 minutes and try again.'},429);
  }
  const id = crypto.randomUUID();
  const result = await c.env.DB.prepare(`
    INSERT INTO email_outbox(id,user_id,kind,digest_key,verified_at,created_at,next_attempt_at)
    SELECT ?,u.id,'digest',?,u.email_verified_at,?,? FROM users u
    JOIN sessions s ON s.user_id=u.id WHERE u.id=? AND s.token_hash=? AND s.expires_at>?
    AND u.disabled_at IS NULL AND u.email IS NOT NULL AND u.email_verified_at IS NOT NULL`
  ).bind(id,'t:'+id,now,now,user.id,user.tokenHash,now).run();
  if (!result.meta.changes) return c.json({error:'Verify an email address in Profile before sending a test digest.'},409);
  return c.json({queued:true},202);
});
