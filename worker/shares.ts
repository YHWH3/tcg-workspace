import { Hono } from 'hono';
import { requireAuth, type AuthUser, type Env } from './auth';
import { randomToken } from './password';

export const shares = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
shares.use('*', requireAuth);

shares.get('/', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT token, target_type, page_id, created_by, created_at FROM shares').all();
  return c.json(results);
});

shares.post('/', async (c) => {
  const body = await c.req.json<{ pageId?: string; moodboardId?: string; targetType?: string }>().catch(() => null);
  if (!body) return c.json({ error: 'invalid body' }, 400);
  let targetType: 'page' | 'moodboard' = 'page';
  let targetId: string | undefined;
  if (body.moodboardId) {
    if (body.pageId) return c.json({ error: 'pass exactly one of pageId/moodboardId' }, 400);
    targetType = 'moodboard';
    targetId = body.moodboardId;
  } else {
    targetType = body.targetType === 'moodboard' ? 'moodboard' : 'page';
    targetId = body.pageId;
  }
  if (typeof targetId !== 'string' || !targetId || targetId.length > 64) return c.json({ error: 'invalid target' }, 400);
  const collection = targetType === 'moodboard' ? 'moodboards' : 'pages';
  const target = await c.env.DB.prepare('SELECT 1 FROM records WHERE collection = ? AND id = ?').bind(collection, targetId).first();
  if (!target) return c.json({ error: `${targetType} not found` }, 404);
  const existing = await c.env.DB.prepare('SELECT token FROM shares WHERE target_type = ? AND page_id = ?').bind(targetType, targetId).first<{ token: string }>();
  if (existing) return c.json({ token: existing.token, target_type: targetType, page_id: targetId });
  const token = randomToken();
  await c.env.DB.prepare('INSERT INTO shares (token, target_type, page_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)').bind(token, targetType, targetId, c.get('user').id, Date.now()).run();
  return c.json({ token, target_type: targetType, page_id: targetId });
});

shares.delete('/:pageId', async (c) => {
  await c.env.DB.prepare('DELETE FROM shares WHERE page_id = ?').bind(c.req.param('pageId')).run();
  return c.json({ ok: true });
});
