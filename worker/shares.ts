import { Hono } from 'hono';
import { requireAuth, type AuthUser, type Env } from './auth';
import { randomToken } from './password';
import { shareAuthority, visibleShares } from './shareAccess';
import { accessEnabled } from './readAccess';

export const shares = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
shares.use('*', requireAuth);

const EXPIRY_DAYS = new Set([null, 7, 30, 90]);
function expiryAt(value: unknown, now = Date.now()): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || !EXPIRY_DAYS.has(value)) return undefined;
  return now + value * 86_400_000;
}

shares.get('/', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT token, target_type, page_id, created_by, created_at, expires_at, rotated_at FROM shares').all<{ token: string; target_type: string; page_id: string; created_by: string | null; created_at: number; expires_at: number | null; rotated_at: number | null }>();
  // A token is a capability: while permissions are enabled only the root's space admins see it.
  return c.json(await visibleShares(c.env, c.get('user').id, results));
});

shares.post('/', async (c) => {
  const body = await c.req.json<{ pageId?: string; moodboardId?: string; targetType?: string; expiresInDays?: number | null }>().catch(() => null);
  if (!body) return c.json({ error: 'invalid body' }, 400);
  const now = Date.now();
  const expiresAt = expiryAt(body.expiresInDays, now);
  if (expiresAt === undefined) return c.json({ error: 'invalid expiry' }, 400);
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
  const authority = await shareAuthority(c.env, c.get('user').id, collection, targetId);
  if (!authority.ok) return c.json({ error: `${targetType} not found` }, 404);
  const existing = await c.env.DB.prepare('SELECT token, expires_at FROM shares WHERE target_type = ? AND page_id = ?').bind(targetType, targetId).first<{ token: string; expires_at: number | null }>();
  if (existing) return c.json({ token: existing.token, target_type: targetType, page_id: targetId, expiresAt: existing.expires_at });
  const token = randomToken();
  const insert = c.env.DB.prepare('INSERT INTO shares (token, target_type, page_id, created_by, created_at, space_id, expires_at, rotated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)').bind(token, targetType, targetId, c.get('user').id, now, authority.spaceId, expiresAt);
  try { await (authority.fence ? c.env.DB.batch([authority.fence, insert]) : insert.run()); }
  catch { return c.json({ error: `${targetType} not found` }, 404); }
  return c.json({ token, target_type: targetType, page_id: targetId, expiresAt });
});

shares.post('/:pageId/rotate', async (c) => {
  const pageId = c.req.param('pageId');
  const row = await c.env.DB.prepare('SELECT target_type, expires_at FROM shares WHERE page_id = ?').bind(pageId).first<{ target_type: string; expires_at: number | null }>();
  if (!row || (row.target_type !== 'page' && row.target_type !== 'moodboard')) return c.json({ error: 'not found' }, 404);
  const collection = row.target_type === 'moodboard' ? 'moodboards' : 'pages';
  const authority = await shareAuthority(c.env, c.get('user').id, collection, pageId);
  if (!authority.ok) return c.json({ error: 'not found' }, 404);
  const token = randomToken();
  const now = Date.now();
  const update = c.env.DB.prepare('UPDATE shares SET token = ?, rotated_at = ? WHERE page_id = ? AND target_type = ?').bind(token, now, pageId, row.target_type);
  try { await (authority.fence ? c.env.DB.batch([authority.fence, update]) : update.run()); }
  catch { return c.json({ error: 'not found' }, 404); }
  return c.json({ token, target_type: row.target_type, page_id: pageId, expiresAt: row.expires_at, rotatedAt: now });
});

shares.delete('/:pageId', async (c) => {
  const pageId = c.req.param('pageId');
  const row = await c.env.DB.prepare('SELECT target_type FROM shares WHERE page_id = ?').bind(pageId).first<{ target_type: string }>();
  // Legacy keeps the historical behavior (any member may unpublish). Enabled: only the root's
  // space admins; anyone else gets the same answer as for a page that was never shared.
  if (row && await accessEnabled(c.env.DB)) {
    const authority = await shareAuthority(c.env, c.get('user').id, row.target_type === 'moodboard' ? 'moodboards' : 'pages', pageId);
    if (!authority.ok) return c.json({ ok: true });
  }
  await c.env.DB.prepare('DELETE FROM shares WHERE page_id = ?').bind(pageId).run();
  return c.json({ ok: true });
});
