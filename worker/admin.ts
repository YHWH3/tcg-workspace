import { Hono } from 'hono';
import { inviteCode, requireAdmin, requireAuth, MAX_USERS } from './auth';
import type { Env, AuthUser } from './auth';
import type { PublicUser } from '../shared/types';
import { maintainDateIndex } from './events';

export const admin = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
admin.use('*', requireAuth);

admin.get('/users', async (c) => {
  const { results } = await c.env.DB
    .prepare('SELECT id, username, name, role, color, created_at FROM users ORDER BY created_at')
    .all<PublicUser & { created_at: number }>();
  return c.json({ users: results.map(({ created_at: _created_at, ...u }) => u), seatsTotal: MAX_USERS });
});

admin.post('/invites', requireAdmin, async (c) => {
  const code = inviteCode();
  await c.env.DB
    .prepare('INSERT INTO invites (code, created_by, created_at) VALUES (?, ?, ?)')
    .bind(code, c.get('user').id, Date.now())
    .run();
  return c.json({ code });
});

admin.get('/invites', requireAdmin, async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT i.code, i.created_at, i.used_by, i.used_at, u.name AS used_by_name
       FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC`,
    )
    .all();
  return c.json({ invites: results });
});

admin.delete('/invites/:code', requireAdmin, async (c) => {
  await c.env.DB.prepare('DELETE FROM invites WHERE code = ? AND used_by IS NULL').bind(c.req.param('code')).run();
  return c.json({ ok: true });
});

admin.patch('/users/:id', requireAdmin, async (c) => {
  const target = c.req.param('id');
  const body = await c.req.json<{ role?: string }>().catch(() => null);
  if (body?.role !== 'admin' && body?.role !== 'member') return c.json({ error: 'invalid role' }, 400);
  const me = c.get('user');
  if (target === me.id) return c.json({ error: 'Cannot change your own role' }, 400);
  if (body.role === 'member') {
    const admins = await c.env.DB.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").first<{ c: number }>();
    const t = await c.env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(target).first<{ role: string }>();
    if (!t) return c.json({ error: 'not found' }, 404);
    if (t.role === 'admin' && (admins?.c ?? 0) <= 1) return c.json({ error: 'Cannot demote the last admin' }, 400);
  }
  await c.env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(body.role, target).run();
  return c.json({ ok: true });
});

// Phase 4 §5 (Workstream B): one-shot backfill after migration 0007 — resync
// date_index for every tasks row. Safe to re-run (delete + insert per record).
// Doc-mandated path (other admin routes keep the historical /api/<x> shape).
admin.post('/admin/reindex-dates', requireAdmin, async (c) => {
  const { results } = await c.env.DB
    .prepare(`SELECT id, data FROM records WHERE collection = 'tasks' LIMIT 5000`)
    .all<{ id: string; data: string }>();
  let reindexed = 0;
  for (let i = 0; i < results.length; i += 200) {
    const applied = results.slice(i, i + 200).map((r) => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(r.data) as Record<string, unknown>;
      } catch {
        /* keep empty — maintainDateIndex will just clear its rows */
      }
      return { id: r.id, collection: 'tasks', created: false, fields: [] as string[], before: {}, after: data };
    });
    await maintainDateIndex(c.env, applied, true);
    reindexed += applied.length;
  }
  return c.json({ ok: true, reindexed });
});

admin.delete('/users/:id', requireAdmin, async (c) => {
  const target = c.req.param('id');
  const me = c.get('user');
  if (target === me.id) return c.json({ error: 'Cannot remove yourself' }, 400);
  const t = await c.env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(target).first<{ role: string }>();
  if (!t) return c.json({ error: 'not found' }, 404);
  if (t.role === 'admin') {
    const admins = await c.env.DB.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").first<{ c: number }>();
    if ((admins?.c ?? 0) <= 1) return c.json({ error: 'Cannot remove the last admin' }, 400);
  }
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target),
    c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(target),
  ]);
  return c.json({ ok: true });
});
