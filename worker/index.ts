import { Hono } from 'hono';
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { auth, me, sessionsApi, userByToken } from './auth';
import { sync } from './sync';
import { accessApi } from './syncAccess';
import { admin } from './admin';
import { files } from './files';
import { shares } from './shares';
import { publicApi } from './public';
import { oauthGrants, registerAuthorize } from './oauth';
import { changesApi } from './changesets';
import { mcpApiHandler } from './mcp';
import { notificationsApi } from './notifications';
import { approvalsApi } from './approvals';
import { formsApi, publicFormsApi } from './forms';
import { automationsApi } from './automations';
import { runScheduled } from './reminders';
import {withD1Budget,D1BudgetExhausted} from './d1budget';
import { browserHardening } from './headers';
import type { Env, AuthUser } from './auth';

const app = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
// API state must not survive account switches or public-form disable/re-enable
// through HTTP caches. The service worker separately excludes these routes.
app.use('/api/*',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
app.use('*',browserHardening);

app.onError((err, c) => {
  if(err instanceof D1BudgetExhausted)return c.json({error:'processing_budget',retryable:true},503);
  console.error(JSON.stringify({ message: err.message, stack: err.stack }));
  return c.json({ error: 'internal error' }, 500);
});

/**
 * Live presence socket. Auth travels in Sec-WebSocket-Protocol as
 * `['ws-auth', <session token>]` — never in the URL. The subprotocol is
 * echoed back so the browser accepts the upgrade.
 */
app.get('/api/live', async (c) => {
  if ((c.req.header('upgrade') ?? '').toLowerCase() !== 'websocket') return c.json({ error: 'websocket upgrade expected' }, 400);
  const protos = (c.req.header('sec-websocket-protocol') ?? '').split(',').map((s) => s.trim());
  const token = protos[0] === 'ws-auth' ? (protos[1] ?? '') : '';
  if (!token) return c.json({ error: 'unauthenticated' }, 401);
  const user = await userByToken(c.env.DB, token);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);
  const stub = c.env.LIVE.get(c.env.LIVE.idFromName('workspace'));
  const res = await stub.fetch(
    new Request('https://live-room/ws', {
      headers: { Upgrade: 'websocket', 'x-user-id': user.id, 'x-session-hash': user.tokenHash },
    }),
  );
  const ws = res.webSocket;
  if (!ws) return c.json({ error: 'upgrade failed' }, 502);
  return new Response(null, {
    status: 101,
    webSocket: ws,
    headers: { 'Sec-WebSocket-Protocol': 'ws-auth' },
  });
});

app.route('/api/auth', auth);
app.route('/api/me', me);
app.route('/api/sessions', sessionsApi);
app.route('/api/sync', sync);
app.route('/api/access', accessApi);
app.route('/api/files', files);
app.route('/api/shares', shares);
app.route('/api/public', publicApi);
app.route('/api/oauth', oauthGrants);
app.route('/api/changes', changesApi);
app.route('/api/notifications', notificationsApi);
app.route('/api/approvals', approvalsApi);
app.route('/api/forms', formsApi);
app.route('/api/automations', automationsApi);
app.route('/api/public/forms', publicFormsApi);
app.route('/api', admin);

app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

registerAuthorize(app);

/**
 * The whole app sits behind the OAuth provider: `/mcp` (and anything under it)
 * requires an OAuth access token and lands on the stateless MCP handler with
 * `ctx.props`; the provider serves `/token`, `/register` and the
 * `/.well-known` metadata itself; everything else falls through to the Hono
 * app (SPA assets, `/api/*`, and our `/oauth/authorize` page).
 */
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    env=withD1Budget(env);
    // The protected-resource URL must equal this request's origin or token
    // audience validation fails — derive it per request (no var needed).
    const base = new URL(request.url).origin;
    return new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: mcpApiHandler,
      defaultHandler: app as unknown as ExportedHandler<Env>,
      authorizeEndpoint: '/oauth/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
      scopesSupported: ['mcp'],
      resourceMetadata: { resource: `${base}/mcp`, resource_name: 'Workspace' },
      allowPrivateUseRedirectUris: true,
    }).fetch(request, env, ctx);
  },

  /**
   * Phase 4 cron (every 15 min): reminders, date-offset automation triggers,
   * and the durable event-outbox sweep. Local testing:
   * `wrangler dev --test-scheduled` then POST /cdn-cgi/handler/scheduled.
   */
  scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runScheduled(withD1Budget(env), event.scheduledTime));
  },
} satisfies ExportedHandler<Env>;

export { LiveRoom } from './live';
