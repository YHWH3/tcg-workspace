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
  // A WebSocket upgrade must reach the runtime untouched: c.header() rebuilds a
  // finalized response (`new Response(body, res)`), which drops the socket and
  // is not even constructible for status 101.
  if (c.res.status === 101 || (c.res as Response & { webSocket?: unknown }).webSocket) return;
  const has = (name: string) => c.res.headers.has(name);
  if (!has('X-Content-Type-Options')) c.header('X-Content-Type-Options', 'nosniff');
  if (!has('X-Frame-Options')) c.header('X-Frame-Options', 'SAMEORIGIN');
  if (!has('Referrer-Policy')) c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
}
