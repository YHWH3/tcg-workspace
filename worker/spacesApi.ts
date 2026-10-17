/** Space routes. Inert (404) while permissions are not active; the activation flag is
 * owned by a reviewed migration, never by a client API. */
import { Hono } from 'hono';
import { requireAuth, type AuthUser, type Env } from './auth';
import { moveRoot, SpaceMoveError } from './spaceMove';
import { pokeLive } from './sync';
import { loadAccessState, syncFailure } from './syncAccess';

export const spacesApi = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
spacesApi.use('*', requireAuth);
spacesApi.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });

/** Move a root (database/board, mood board or root page) and everything under it. */
spacesApi.post('/move', async c => {
  if (!(await loadAccessState(c.env.DB)).enabled) return c.json({ error: 'permissions_not_active' }, 404);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'invalid_request' }, 400);
  const user = c.get('user');
  const result = await moveRoot(c.env.DB, { id: user.id, tokenHash: user.tokenHash }, body as Record<string, unknown> as never);
  pokeLive(c.env, c.executionCtx);
  return c.json({ ok: true, ...result });
});

spacesApi.onError((error, c) => {
  if (error instanceof SpaceMoveError) return c.json({ error: error.code }, error.status);
  const failure = syncFailure(error);
  if (failure) return c.json({ error: failure.error }, failure.status);
  throw error;
});
