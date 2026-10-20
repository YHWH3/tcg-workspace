/** Permission-aware sync: activation state, protocol validation and the access
 * manifest route. The feed itself is worker/spaceFeed.ts (protocol 3). */
import { Hono } from 'hono';
import { AccessError } from './access';
import { requireAuth, type AuthUser, type Env } from './auth';
import { RecordAccessError } from './recordAccess';
import { loadManifest } from './spaceFeed';
import { loadAccessState, SyncProtocolError } from './syncState';

export { loadAccessState, SyncProtocolError, validateSyncProtocol, type AccessState } from './syncState';

export const accessApi = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
accessApi.use('*', requireAuth);
/** The caller's access manifest: which spaces, in which role, and the etag that every
 * pull and push is checked against. Legacy while permissions are off. */
accessApi.get('/', async c => {
  c.header('Cache-Control', 'no-store');
  const user = c.get('user');
  if (!(await loadAccessState(c.env.DB)).enabled) return c.json({ protocol: 1, userId: user.id });
  const { manifest } = await loadManifest(c.env.DB, user.id);
  return c.json(manifest);
});

/** Register at each router boundary; never turn permission failures into a
 * successful empty page. The app's outer handler still owns unexpected errors. */
export function syncFailure(error: unknown): { error: string; status: 400 | 401 | 409 | 426 | 503 } | null {
  if (error instanceof SyncProtocolError) return { error: error.code, status: error.status };
  if (error instanceof RecordAccessError) return { error: error.code === 'scope_graph_budget' ? 'authorization_budget' : 'access_changed_retry', status: error.code === 'scope_graph_budget' ? 503 : 409 };
  if (error instanceof AccessError) return { error: error.code, status: 503 };
  return null;
}
accessApi.onError((error, c) => {
  const result = syncFailure(error);
  if (result) return c.json({ error: result.error }, result.status);
  throw error;
});
