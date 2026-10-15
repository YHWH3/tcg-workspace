import { Hono } from 'hono';
import { requireAuth, type AuthUser, type Env } from './auth';
import { verifyPassword } from './password';

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function page(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Authorize — Workspace</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; margin: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif;
    background: #fafafa; color: #171717; min-height: 100dvh;
    display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  .card {
    width: 100%; max-width: 380px; background: #fff;
    border: 1px solid #e5e5e5; border-radius: 18px; padding: 32px 28px;
    box-shadow: 0 12px 40px rgba(0,0,0,.06);
  }
  .logo {
    width: 44px; height: 44px; border-radius: 12px; background: #171717; color: #fff;
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 20px; margin-bottom: 18px;
  }
  h1 { font-size: 19px; font-weight: 650; letter-spacing: -.01em; margin-bottom: 6px; }
  .sub { font-size: 13.5px; color: #737373; line-height: 1.5; margin-bottom: 4px; }
  .sub b { color: #404040; font-weight: 600; }
  .warn { color: #b45309; font-size: 12.5px; margin-top: 8px; }
  label { display: block; font-size: 12px; font-weight: 600; color: #525252; margin: 18px 0 5px; }
  input {
    width: 100%; height: 40px; padding: 0 12px; font-size: 14px; border-radius: 10px;
    border: 1px solid #d4d4d4; background: #fff; color: inherit; outline: none;
  }
  input:focus { border-color: #171717; box-shadow: 0 0 0 3px rgba(0,0,0,.06); }
  .err { background: #fef2f2; color: #b91c1c; border-radius: 10px; padding: 9px 12px; font-size: 13px; margin-top: 16px; }
  .row { display: flex; gap: 10px; margin-top: 22px; }
  button {
    flex: 1; height: 40px; border-radius: 10px; border: 0; font-size: 14px; font-weight: 600;
    cursor: pointer; font-family: inherit;
  }
  .allow { background: #171717; color: #fff; }
  .allow:hover { background: #333; }
  .deny { background: transparent; color: #525252; border: 1px solid #d4d4d4; }
  .deny:hover { background: #f5f5f5; }
  .foot { margin-top: 20px; font-size: 11.5px; color: #a3a3a3; text-align: center; }
  @media (prefers-color-scheme: dark) {
    body { background: #0a0a0a; color: #f5f5f5; }
    .card { background: #141414; border-color: #262626; box-shadow: none; }
    .logo { background: #f5f5f5; color: #171717; }
    .sub { color: #a3a3a3; } .sub b { color: #d4d4d4; }
    label { color: #a3a3a3; }
    input { background: #0a0a0a; border-color: #333; color: #f5f5f5; }
    input:focus { border-color: #d4d4d4; box-shadow: 0 0 0 3px rgba(255,255,255,.08); }
    .err { background: #2d1213; color: #fca5a5; }
    .allow { background: #f5f5f5; color: #171717; }
    .allow:hover { background: #fff; }
    .deny { border-color: #333; color: #a3a3a3; }
    .deny:hover { background: #1c1c1c; }
    .foot { color: #525252; }
  }
</style>
</head>
<body>
<div class="card">
  <div class="logo">W</div>
  ${body}
  <p class="foot">Workspace · self-hosted</p>
</div>
</body>
</html>`;
}

function consentBody(details: { clientName: string; redirectHost: string; redirectIsLoopback: boolean; clientDomain?: string }, handle: string, error?: string): string {
  const who = esc(details.clientName || 'An app');
  const from = details.clientDomain ? `Published by <b>${esc(details.clientDomain)}</b>. ` : 'This app registered itself; its name is not verified. ';
  const warn = details.redirectIsLoopback ? `<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting it.</p>` : '';
  const errHtml = error ? `<div class="err">${esc(error)}</div>` : '';
  return `
  <h1>${who} wants to access your Workspace</h1>
  <p class="sub">${from}Access will be sent to <b>${esc(details.redirectHost)}</b>. Sign in to continue.</p>
  ${warn}
  <form method="post">
    <input type="hidden" name="handle" value="${esc(handle)}">
    <label for="u">Username</label>
    <input id="u" name="username" autocomplete="username" autocapitalize="none" required>
    <label for="p">Password</label>
    <input id="p" name="password" type="password" autocomplete="current-password" required>
    ${errHtml}
    <div class="row">
      <button class="deny" name="decision" value="deny" type="submit" formnovalidate>Cancel</button>
      <button class="allow" name="decision" value="allow" type="submit">Allow</button>
    </div>
  </form>`;
}

const htmlRes = (html: string, status = 200, headers?: Headers) => {
  const h = headers ?? new Headers();
  h.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(html, { status, headers: h });
};

/**
 * The OAuth authorize page: parseAuthRequest + beginConsent render the form
 * (browser-bound one-time handle); the POST verifies workspace credentials,
 * then approveConsent + completeAuthorization mints the code.
 * Mounted on the default handler — the provider never serves this path itself.
 */
export function registerAuthorize(app: Hono<{ Bindings: Env; Variables: { user: AuthUser } }>) {
  app.get('/oauth/authorize', async (c) => {
    try {
      const authReq = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
      const details = await c.env.OAUTH_PROVIDER.describeConsent(authReq);
      const consent = await c.env.OAUTH_PROVIDER.beginConsent(authReq);
      return htmlRes(page(consentBody(details, consent.handle)), 200, consent.headers);
    } catch {
      return htmlRes(page(`<h1>Invalid request</h1><p class="sub">This link is incomplete or has expired. Start the connection from your AI app again.</p>`), 400);
    }
  });

  app.post('/oauth/authorize', async (c) => {
    const form = await c.req.formData().catch(() => null);
    const handle = String(form?.get('handle') ?? '');
    const decision = String(form?.get('decision') ?? '');
    try {
      if (decision === 'deny' || !handle) {
        const denied = await c.env.OAUTH_PROVIDER.denyConsent(c.req.raw, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const username = String(form?.get('username') ?? '').trim();
      const password = String(form?.get('password') ?? '');
      const user = await c.env.DB.prepare('SELECT id, username, password_hash, salt, name FROM users WHERE username = ? AND disabled_at IS NULL').bind(username).first<{ id: string; name: string; password_hash: string; salt: string }>();
      const ok = user ? await verifyPassword(password, user.salt, user.password_hash) : false;
      // Re-derive the client facts from the query (the form posts to the same
      // URL) so an error re-render shows accurate, unspoofable details.
      const authReq = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
      const details = await c.env.OAUTH_PROVIDER.describeConsent(authReq);
      if (!ok || !user) {
        return htmlRes(page(consentBody(details, handle, 'Incorrect username or password.')), 401);
      }
      const approved = await c.env.OAUTH_PROVIDER.approveConsent(c.req.raw, handle);
      const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
        request: approved.request,
        userId: user.id,
        metadata: {},
        scope: approved.request.scope,
        props: { userId: user.id, clientName: details.clientName },
      });
      approved.headers.set('Location', redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    } catch (e) {
      console.error('[oauth] authorize POST failed:', e instanceof Error ? `${e.name}: ${e.message}` : e);
      return htmlRes(page(`<h1>Something went wrong</h1><p class="sub">The authorization request is invalid or has expired. Go back to your AI app and start the connection again.</p>`), 400);
    }
  });
}

/** Settings → AI connectors: list/revoke the signed-in user's OAuth grants. */
export const oauthGrants = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
oauthGrants.use('*', requireAuth);

oauthGrants.get('/grants', async (c) => {
  const user = c.get('user');
  const out = await c.env.OAUTH_PROVIDER.listUserGrants(user.id, { limit: 100 });
  const items = await Promise.all(
    out.items.map(async (g) => {
      const client = await c.env.OAUTH_PROVIDER.lookupClient(g.clientId).catch(() => null);
      return {
        id: g.id,
        clientId: g.clientId,
        clientName: client?.clientName ?? g.clientId,
        scope: g.scope,
        createdAt: g.createdAt,
        expiresAt: g.expiresAt ?? null,
      };
    }),
  );
  return c.json({ grants: items });
});

oauthGrants.delete('/grants/:id', async (c) => {
  const user = c.get('user');
  await c.env.OAUTH_PROVIDER.revokeGrant(c.req.param('id'), user.id);
  return c.json({ ok: true });
});
