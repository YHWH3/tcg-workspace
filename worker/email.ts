import { Hono } from 'hono';
import { requireAuth, type AuthUser, type Env } from './auth';
import { rateLimitHit } from './ratelimit';

const codeLifetime = 15 * 60_000;
const invalidCode = 'That code could not be verified. Check it or request a new code.';
const activeSession = `EXISTS (
  SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
  WHERE s.user_id=? AND s.token_hash=? AND s.expires_at>? AND u.disabled_at IS NULL
)`;

export type EmailEnv = Pick<Env, 'EMAIL_LINK_KEY' | 'EMAIL_PROVIDER' | 'EMAIL_FROM' | 'EMAIL_APP_ORIGIN' | 'RESEND_API_KEY' | 'WORKSPACE_ENV' | 'EMAIL_TEST_SINK'>;

export function deliveryMode(env: EmailEnv) {
  if (!env.EMAIL_LINK_KEY) return null;
  if (env.EMAIL_PROVIDER === 'resend' && env.RESEND_API_KEY && env.EMAIL_FROM) return 'resend';
  if (env.EMAIL_PROVIDER === 'simulated' && env.WORKSPACE_ENV === 'local-test' && env.EMAIL_TEST_SINK) return 'simulated';
  return null;
}

export function notificationEmailOrigin(env: EmailEnv) {
  if (!deliveryMode(env) || !env.EMAIL_APP_ORIGIN) return null;
  const url = URL.parse(env.EMAIL_APP_ORIGIN);
  return url?.protocol === 'https:' && url.origin === env.EMAIL_APP_ORIGIN ? url.origin : null;
}

export function requestEmail(env: EmailEnv, mode: 'resend' | 'simulated', id: string, body: string) {
  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': id },
    redirect: 'error' as const,
    signal: AbortSignal.timeout(5_000),
    body,
  };
  return mode === 'simulated'
    ? env.EMAIL_TEST_SINK!.fetch('https://email-test-sink.invalid/messages', options)
    : fetch('https://api.resend.com/emails', {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${env.RESEND_API_KEY}` },
    });
}

async function challengeHash(key: string, challenge: string, code: string) {
  const encoder = new TextEncoder();
  const secret = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', secret, encoder.encode(`email-verification:${challenge}:${code}`));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export const emailApi = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
emailApi.use('*', requireAuth);
emailApi.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});

emailApi.get('/delivery', async c => {
  const available = Boolean(notificationEmailOrigin(c.env));
  const verified = available && Boolean(await c.env.DB.prepare(
    'SELECT 1 FROM users WHERE id=? AND email IS NOT NULL AND email_verified_at IS NOT NULL'
  ).bind(c.get('user').id).first());
  return c.json({ available, verified });
});

emailApi.get('/', async c => {
  const user = c.get('user');
  const state = await c.env.DB.prepare(`
    SELECT u.email, v.email AS pending
    FROM users u LEFT JOIN email_verifications v
      ON v.user_id=u.id AND v.session_hash=? AND v.expires_at>? AND v.attempts<5
    WHERE u.id=? AND u.disabled_at IS NULL`
  ).bind(user.tokenHash, Date.now(), user.id).first<{email: string | null; pending: string | null}>();
  return c.json({ ...state, available: Boolean(deliveryMode(c.env)) });
});

emailApi.post('/', async c => {
  const env = c.env;
  const mode = deliveryMode(env);
  if (!mode) return c.json({ error: 'Email verification is currently unavailable.' }, 503);
  const body = await c.req.json<{email?: unknown}>().catch(() => null);
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email)) {
    return c.json({ error: 'Enter a valid email address.' }, 400);
  }
  const user = c.get('user');
  if (await rateLimitHit(env, 'email_verification_send', user.id, codeLifetime) > 3) {
    return c.json({ error: 'Too many code requests. Wait 15 minutes and try again.' }, 429);
  }
  const id = crypto.randomUUID();
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
  const hash = await challengeHash(env.EMAIL_LINK_KEY!, id, code);
  const now = Date.now();
  const started = await env.DB.prepare(`
    INSERT INTO email_verifications(user_id, session_hash, id, email, code_hash, expires_at)
    SELECT ?,?,?,?,?,? WHERE ${activeSession}
    ON CONFLICT(user_id) DO UPDATE SET session_hash=excluded.session_hash, id=excluded.id,
      email=excluded.email, code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0`
  ).bind(user.id, user.tokenHash, id, email, hash, now + codeLifetime, user.id, user.tokenHash, now).run();
  if (!started.meta.changes) return c.json({ error: 'unauthenticated' }, 401);

  const message = {
    to: [email],
    subject: 'Verify your TCG Workspace email',
    text: `Your verification code is ${code}. It expires in 15 minutes.`,
  };
  let accepted = false;
  try {
    const response = await requestEmail(env, mode, id, JSON.stringify({ ...message, from: env.EMAIL_FROM }));
    accepted = response.ok;
    await response.body?.cancel();
  } catch {
    // The provider may have accepted the message. Keep the challenge valid so
    // a delivered code can still be used, and never auto-retry this operation.
  }
  return c.json({ pending: email, delivery: accepted ? 'accepted' : 'uncertain' }, 202);
});

emailApi.post('/verify', async c => {
  const env = c.env;
  if (!deliveryMode(env)) return c.json({ error: 'Email verification is currently unavailable.' }, 503);
  const body = await c.req.json<{code?: unknown}>().catch(() => null);
  if (typeof body?.code !== 'string' || !/^\d{6}$/.test(body.code.trim())) {
    return c.json({ error: 'Enter the six-digit code.' }, 400);
  }
  const user = c.get('user');
  const challenge = await env.DB.prepare('SELECT id FROM email_verifications WHERE user_id=? AND session_hash=?')
    .bind(user.id, user.tokenHash).first<{id: string}>();
  if (!challenge) return c.json({ error: invalidCode }, 400);
  const hash = await challengeHash(env.EMAIL_LINK_KEY!, challenge.id, body.code.trim());
  const now = Date.now();
  const candidate = 'user_id=? AND session_hash=? AND id=? AND expires_at>? AND attempts<5';
  const args = [user.id, user.tokenHash, challenge.id, now];
  const fenced = [user.id, user.tokenHash, now];
  const [verified] = await env.DB.batch<{email: string}>([
    env.DB.prepare(`
      UPDATE OR IGNORE users SET email=(SELECT email FROM email_verifications WHERE user_id=?), email_verified_at=?
      WHERE id=? AND ${activeSession}
        AND EXISTS (SELECT 1 FROM email_verifications WHERE ${candidate} AND code_hash=?)
      RETURNING email`
    ).bind(user.id, now, user.id, ...fenced, ...args, hash),
    // A uniqueness conflict follows the same attempt-count path as a wrong code.
    env.DB.prepare(`DELETE FROM email_verifications WHERE changes()=1 AND ${candidate} AND code_hash=? AND ${activeSession}`)
      .bind(...args, hash, ...fenced),
    env.DB.prepare(`UPDATE email_verifications SET attempts=attempts+1 WHERE ${candidate} AND ${activeSession}`)
      .bind(...args, ...fenced),
  ]);
  const email = verified.results[0]?.email;
  return email ? c.json({ email }) : c.json({ error: invalidCode }, 400);
});

emailApi.delete('/', async c => {
  const { DB } = c.env;
  const user = c.get('user');
  const fence = [user.id, user.tokenHash, Date.now()];
  const [removed] = await DB.batch([
    DB.prepare(`UPDATE users SET email=NULL, email_verified_at=NULL WHERE id=? AND ${activeSession}`).bind(user.id, ...fence),
    DB.prepare(`DELETE FROM email_verifications WHERE user_id=? AND ${activeSession}`).bind(user.id, ...fence),
  ]);
  return removed.meta.changes ? c.json({ ok: true }) : c.json({ error: 'unauthenticated' }, 401);
});
