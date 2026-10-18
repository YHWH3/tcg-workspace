import { Hono } from 'hono';
import { inviteCode, requireAdmin, requireAuth, MAX_USERS } from './auth';
import type { Env, AuthUser } from './auth';
import type { PublicUser } from '../shared/types';
import { maintainDateIndex } from './events';
import { revokeAllGrants } from './ratelimit';

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

// Phase 4 §5 (Workstream B): backfill after migration 0007 — resync date_index
// for every tasks row. Safe to re-run (delete + insert per record). Paginated by
// a keyset cursor: one request handles a bounded page (a request has a fixed D1
// call budget, and the previous single call silently stopped at 5,000 rows).
// Repeat with `?after=<next>` until `next` is null.
const REINDEX_PAGE = 400;
admin.post('/admin/reindex-dates', requireAdmin, async (c) => {
  const after = c.req.query('after') ?? '';
  const { results } = await c.env.DB
    .prepare(`SELECT id, data FROM records WHERE collection = 'tasks' AND id > ? ORDER BY id LIMIT ?`)
    .bind(after, REINDEX_PAGE)
    .all<{ id: string; data: string }>();
  const applied = results.map((r) => {
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(r.data) as Record<string, unknown>;
    } catch {
      /* keep empty — maintainDateIndex will just clear its rows */
    }
    return { id: r.id, collection: 'tasks', created: false, fields: [] as string[], before: {}, after: data };
  });
  if (applied.length) await maintainDateIndex(c.env, applied, true);
  return c.json({ ok: true, reindexed: applied.length, next: results.length === REINDEX_PAGE ? results[results.length - 1].id : null });
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
  if (target) await revokeAllGrants(c.env, target);
  return c.json({ ok: true });
});

// Phase 5 search index recovery: mark a keyset page of documents dirty and rebuild one chunk.
// Repeat with `?after=<next>` until `next` is null; the cron drains the rest. The index is
// derived data: rebuilding never changes records.
admin.post('/admin/reindex-search', requireAdmin, async (c) => {
  const { enqueueSearchRebuild, processSearchDirty } = await import('./search');
  const queued = await enqueueSearchRebuild(c.env, c.req.query('after') ?? '');
  const rebuilt = await processSearchDirty(c.env);
  return c.json({ ok: true, queued: queued.queued, rebuilt, next: queued.next });
});
