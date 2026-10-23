import { Hono } from 'hono';
import { inviteCode, requireAdmin, requireAuth, MAX_USERS } from './auth';
import type { Env, AuthUser } from './auth';
import type { PublicUser } from '../shared/types';
import { maintainDateIndex } from './events';
import { revokeAllGrants } from './ratelimit';
import {websiteAuthority,websiteGrantFence,defaultWebsiteDestinations} from './websiteAuthority';
import {loadAccessContext,spaceAccess} from './access';
import {canEdit} from '../shared/access';
import {levelSql} from './capability';

export const admin = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
admin.use('*', requireAuth);

function adminSessionFence(env:Env,user:AuthUser,spaceId?:string){
 return env.DB.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
 WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>? AND u.disabled_at IS NULL AND u.role='admin')
 ${spaceId?`AND ${levelSql('?','?')}>=3`:''} THEN 1 ELSE json_extract('{','$') END`)
 .bind(user.tokenHash,user.id,Date.now(),...(spaceId?[user.id,spaceId]:[]));
}

admin.get('/admin/website-ingest',requireAdmin,async c=>{
 const grant=await c.env.DB.prepare('SELECT * FROM website_ingest_grant WHERE id=1').first<{space_id:string}>();
 const readable=grant&&canEdit(spaceAccess(await loadAccessContext(c.env.DB,c.get('user').id,[grant.space_id]),grant.space_id));
 return c.json({grant:readable?grant:null,available:readable&&!!await websiteAuthority(c.env),defaults:defaultWebsiteDestinations});
});
admin.put('/admin/website-ingest',requireAdmin,async c=>{
 const body=await c.req.json().catch(()=>null),uid=c.get('user').id;
 if(!body||typeof body.spaceId!=='string'||!body.spaceId||body.spaceId.length>64||body.peopleId!==undefined&&(typeof body.peopleId!=='string'||!body.peopleId||body.peopleId.length>64))return c.json({error:'invalid_destination'},400);
 const access=await loadAccessContext(c.env.DB,uid,[body.spaceId]);
 if(!canEdit(spaceAccess(access,body.spaceId)))return c.json({error:'destination_not_authorized'},403);
 const peopleId=body.peopleId??defaultWebsiteDestinations.peopleId;
 const invalid=await c.env.DB.prepare(`SELECT id FROM records WHERE id IN (?,?) AND (collection!='boards' OR space_id!=? OR COALESCE(json_extract(data,'$.deleted'),0)=1 OR COALESCE(json_extract(data,'$.archived'),0)=1)`).bind(defaultWebsiteDestinations.inboxId,peopleId,body.spaceId).first();
 if(invalid)return c.json({error:'destination_unavailable'},409);
 await c.env.DB.batch([adminSessionFence(c.env,c.get('user'),body.spaceId),c.env.DB.prepare(`INSERT INTO website_ingest_grant(id,sponsor_id,space_id,inbox_id,people_id,updated_at) VALUES(1,?,?,?,?,?)
 ON CONFLICT(id) DO UPDATE SET sponsor_id=excluded.sponsor_id,space_id=excluded.space_id,inbox_id=excluded.inbox_id,people_id=excluded.people_id,version=version+1,revoked_at=NULL,updated_at=excluded.updated_at`)
 .bind(uid,body.spaceId,defaultWebsiteDestinations.inboxId,peopleId,Date.now())]);
 const grant=await websiteAuthority(c.env);
 if(!grant)return c.json({error:'authority_changed'},409);
 await c.env.DB.batch([websiteGrantFence(c.env,grant)]);
 return c.json({ok:true,grant});
});
admin.delete('/admin/website-ingest',requireAdmin,async c=>{
 await c.env.DB.batch([adminSessionFence(c.env,c.get('user')),c.env.DB.prepare('UPDATE website_ingest_grant SET revoked_at=?,version=version+1,updated_at=? WHERE id=1').bind(Date.now(),Date.now())]);
 return c.json({ok:true});
});

admin.get('/users', async (c) => {
  const { results } = await c.env.DB
    .prepare(`SELECT id, username, name, role, color, created_at FROM users WHERE id=? OR COALESCE((SELECT workspace_role FROM users WHERE id=?),'member')!='guest' ORDER BY created_at`).bind(c.get('user').id,c.get('user').id)
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
