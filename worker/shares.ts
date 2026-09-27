import { Hono } from 'hono';
import { requireAuth, type AuthUser, type Env } from './auth';
import { randomToken } from './password';

export const shares = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
shares.use('*', requireAuth);

shares.get('/', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT token, page_id, created_by, created_at FROM shares').all();
  return c.json(results);
});

shares.post('/', async (c) => {
  const body = await c.req.json<{ pageId?: string }>().catch(() => null);
  const pageId = body?.pageId;
  if (typeof pageId !== 'string' || pageId.length > 64) return c.json({ error: 'invalid page' }, 400);
  const page = await c.env.DB.prepare(`SELECT 1 FROM records WHERE collection = 'pages' AND id = ?`).bind(pageId).first();
  if (!page) return c.json({ error: 'page not found' }, 404);
  const existing = await c.env.DB.prepare('SELECT token FROM shares WHERE page_id = ?').bind(pageId).first<{ token: string }>();
  if (existing) return c.json({ token: existing.token });
  const token = randomToken();
  await c.env.DB.prepare('INSERT INTO shares (token, page_id, created_by, created_at) VALUES (?, ?, ?, ?)').bind(token, pageId, c.get('user').id, Date.now()).run();
  return c.json({ token });
});

shares.delete('/:pageId', async (c) => {
  await c.env.DB.prepare('DELETE FROM shares WHERE page_id = ?').bind(c.req.param('pageId')).run();
  return c.json({ ok: true });
});
