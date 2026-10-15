import type { Context, Next } from 'hono';

/**
 * Browser hardening for every Worker-generated response (API, served files, the
 * OAuth consent page). Same-origin framing stays allowed — the public page
 * iframes its own PDF route — but another site cannot frame the consent form or
 * the app; nosniff stops type confusion on anything a route forgot to type.
 * Existing headers are never overridden (file routes set their own).
 * Static assets get the same set from public/_headers.
 */
export async function browserHardening(c: Context, next: Next): Promise<void> {
  await next();
  const has = (name: string) => c.res.headers.has(name);
  if (!has('X-Content-Type-Options')) c.header('X-Content-Type-Options', 'nosniff');
  if (!has('X-Frame-Options')) c.header('X-Frame-Options', 'SAMEORIGIN');
  if (!has('Referrer-Policy')) c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
}
