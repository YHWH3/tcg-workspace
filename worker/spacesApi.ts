/** Space routes. Inert (404) while permissions are not active; the activation flag is
 * owned by a reviewed migration, never by a client API. */
import { Hono } from 'hono';
import { requireAuth, type AuthUser, type Env } from './auth';
import { moveRoot, SpaceMoveError } from './spaceMove';
import { createSpace,setSpaceMember,SpaceMutationError } from './spaces';
import { levelSql } from './capability';
import { makeGuestInvite,acceptGuestInvite,sessionGuard } from './guestInvites';
import { pokeLive } from './sync';
import { loadAccessState, syncFailure } from './syncAccess';

export const spacesApi = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
spacesApi.use('*', requireAuth);
spacesApi.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });

spacesApi.use('*',async(c,next)=>{if(!(await loadAccessState(c.env.DB)).enabled)return c.json({error:'permissions_not_active'},404);await next();});
spacesApi.use('*',async(c,next)=>{if(['POST','PATCH'].includes(c.req.method)){const b=await c.req.json().catch(()=>null);if(!b||typeof b!=='object'||Array.isArray(b))return c.json({error:'invalid_request'},400);}await next();});
spacesApi.get('/',async c=>{const uid=c.get('user').id;const after=c.req.query('after')??'';const {results}=await c.env.DB.prepare(`SELECT s.id,s.name,s.default_access,s.guest_directory_restricted,${levelSql('?','s.id')} level FROM spaces s WHERE s.id>? AND ${levelSql('?','s.id')}>=1 ORDER BY s.id LIMIT 101`).bind(uid,after,uid).all();return c.json({spaces:results.slice(0,100),next:results.length>100?results[99].id:null});});
spacesApi.post('/',async c=>{const body=await c.req.json();const result=await createSpace(c.env.DB,c.get('user').id,{...body,session:c.get('user').tokenHash});pokeLive(c.env,c.executionCtx);return c.json(result);});
spacesApi.get('/:id/members',async c=>{const uid=c.get('user').id,id=c.req.param('id');const {results}=await c.env.DB.prepare(`SELECT u.id,u.name,u.username,COALESCE(u.workspace_role,u.role) workspaceRole,m.role,m.access FROM space_members m JOIN users u ON u.id=m.user_id WHERE m.space_id=? AND ${levelSql('?','m.space_id')}>=4 ORDER BY u.id LIMIT 100`).bind(id,uid).all();return c.json({members:results});});
spacesApi.post('/:id/members',async c=>{const body=await c.req.json();const result=await setSpaceMember(c.env.DB,c.get('user').id,{...body,spaceId:c.req.param('id'),session:c.get('user').tokenHash});pokeLive(c.env,c.executionCtx);return c.json(result);});
spacesApi.patch('/:id',async c=>{const body=await c.req.json();if(typeof body.name!=='string'||!body.name.trim()||body.name.length>120||!['private','members'].includes(body.defaultAccess))return c.json({error:'invalid_request'},400);const u=c.get('user'),id=c.req.param('id');const results=await c.env.DB.batch([sessionGuard(c.env.DB,u),c.env.DB.prepare(`UPDATE spaces SET name=?,default_access=? WHERE id=? AND ${levelSql('?','spaces.id')}>=4`).bind(body.name.trim(),body.defaultAccess,id,u.id),c.env.DB.prepare(`INSERT INTO access_audit(id,actor_id,space_id,action,after_json,generation,created_at) SELECT ?,?,?,'update_space',?,generation,? FROM access_state WHERE id=1 AND changes()=1`).bind(crypto.randomUUID(),u.id,id,JSON.stringify({name:body.name.trim(),defaultAccess:body.defaultAccess}),Date.now())]);if(!results[1].meta.changes)return c.json({error:'not found'},404);pokeLive(c.env,c.executionCtx);return c.json({ok:true});});
spacesApi.get('/:id/invites',async c=>{const {results}=await c.env.DB.prepare(`SELECT id,role,expires_at,revoked_at,used_by,used_at FROM guest_invites WHERE space_id=? AND ${levelSql('?','guest_invites.space_id')}>=4 ORDER BY created_at DESC,id LIMIT 100`).bind(c.req.param('id'),c.get('user').id).all();return c.json({invites:results});});
spacesApi.post('/:id/invites',async c=>{const b=await c.req.json();if(!['viewer','commenter','editor'].includes(b.role))return c.json({error:'invalid_role'},400);const result=await makeGuestInvite(c.env,c.get('user'),c.req.param('id'),b.role);return result?c.json(result):c.json({error:'not found'},404);});
spacesApi.delete('/:id/invites/:invite',async c=>{const u=c.get('user');const r=await c.env.DB.batch([sessionGuard(c.env.DB,u),c.env.DB.prepare(`UPDATE guest_invites SET revoked_at=? WHERE id=? AND space_id=? AND used_by IS NULL AND ${levelSql('?','guest_invites.space_id')}>=4`).bind(Date.now(),c.req.param('invite'),c.req.param('id'),u.id)]);return r[1].meta.changes?c.json({ok:true}):c.json({error:'not found'},404);});
spacesApi.post('/accept',async c=>{const b=await c.req.json();if(typeof b.token!=='string'||b.token.length>100)return c.json({error:'invalid_invitation'},400);const r=await acceptGuestInvite(c.env,c.get('user'),b.token);if(!r)return c.json({error:'invalid_expired_revoked_or_used_invitation'},409);pokeLive(c.env,c.executionCtx);return c.json(r);});

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
  if (error instanceof SpaceMutationError) return c.json({error:error.code},error.status);
  if (error instanceof SpaceMoveError) return c.json({ error: error.code }, error.status);
  const failure = syncFailure(error);
  if (failure) return c.json({ error: failure.error }, failure.status);
  throw error;
});
