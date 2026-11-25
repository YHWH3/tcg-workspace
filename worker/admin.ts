import {migrateFiles} from './fileStore';
import {FileAccessError} from './fileAccess';
import { Hono } from 'hono';
import { inviteCode, requireAdmin, requireAuth, MAX_USERS } from './auth';
import type { Env, AuthUser } from './auth';
import type { PublicUser } from '../shared/types';
import { maintainDateIndex } from './events';
import {pokeLive} from './sync';
import { revokeAllGrants } from './ratelimit';
import {websiteAuthority,websiteGrantFence,defaultWebsiteDestinations} from './websiteAuthority';
import {loadAccessContext,spaceAccess} from './access';
import {canEdit} from '../shared/access';
import {levelSql} from './capability';
import {fieldsOf,propKey} from '../shared/fields';
import { OWNER_PROTECTED_ERROR } from '../shared/crm/contracts';

export const admin = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
admin.use('*', requireAuth);

function adminSessionFence(env:Env,user:AuthUser,spaceId?:string){
 return env.DB.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
 WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>? AND u.disabled_at IS NULL AND COALESCE(u.workspace_role,u.role) IN ('owner','admin'))
 ${spaceId?`AND ${levelSql('?','?')}>=3`:''} THEN 1 ELSE json_extract('{','$') END`)
 .bind(user.tokenHash,user.id,Date.now(),...(spaceId?[spaceId,user.id]:[]));
}
function ownerSessionFence(env:Env,user:AuthUser){
 return env.DB.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
 WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>? AND u.disabled_at IS NULL AND COALESCE(u.workspace_role,u.role)='owner')
 THEN 1 ELSE json_extract('{','$') END`)
 .bind(user.tokenHash,user.id,Date.now());
}

admin.post('/admin/files/migrate', requireAdmin, async c => {
  const cursor = c.req.query('after') ?? '0';
  const after = Number(cursor);
  const dryRun = c.req.query('dryRun');
  if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(after) || (dryRun !== undefined && dryRun !== '1')) {
    return c.json({ error: 'invalid_migration_parameters' }, 400);
  }
  if (c.env.FILE_STORAGE !== 'r2' || !c.env.FILES) return c.json({ error: 'storage_not_configured' }, 503);
  try {
    return c.json(await migrateFiles(c.env, after, dryRun === '1', () => adminSessionFence(c.env, c.get('user')), c.get('user')));
  } catch (error) {
    if (error instanceof FileAccessError) return c.json({ error: error.message }, error.status);
    if (/malformed JSON/i.test(String(error))) return c.json({ error: 'authority_changed' }, 409);
    throw error;
  }
});

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

// Explicit operator recovery only: never resurrect or replace an erased identity.
admin.post('/admin/website-ingest/people-rebind',requireAdmin,async c=>{
 const body=await c.req.json().catch(()=>null);
 if(!body||typeof body.email!=='string'||typeof body.personId!=='string'||body.personId.length>200)return c.json({error:'invalid_rebind'},400);
 const email=body.email.trim().toLowerCase();
 if(!email||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return c.json({error:'invalid_email'},400);
 const grant=await websiteAuthority(c.env);if(!grant)return c.json({error:'authority_unavailable'},503);
 const actor=c.get('user');
 if(!canEdit(spaceAccess(await loadAccessContext(c.env.DB,actor.id,[grant.space_id]),grant.space_id)))return c.json({error:'destination_not_authorized'},403);
 const board=await c.env.DB.prepare("SELECT data FROM records WHERE id=? AND collection='boards'").bind(grant.people_id).first<{data:string}>();
 const field=board&&fieldsOf(JSON.parse(board.data)).find(f=>f.name.toLowerCase()==='email');
 if(!field)return c.json({error:'people_destination_unavailable'},409);
 const key=propKey(field.id);
 const target=await c.env.DB.prepare("SELECT seq FROM records WHERE id=? AND collection='tasks' AND space_id=? AND json_extract(data,'$.boardId')=? AND COALESCE(json_extract(data,'$.deleted'),0)=0 AND COALESCE(json_extract(data,'$.archived'),0)=0 AND lower(trim(json_extract(data,?)))=?")
 .bind(body.personId,grant.space_id,grant.people_id,'$.'+key,email).first<{seq:number}>();
 if(!target)return c.json({error:'person_unusable'},409);
 await c.env.DB.batch([adminSessionFence(c.env,actor,grant.space_id),websiteGrantFence(c.env,grant),
 c.env.DB.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM records WHERE id=? AND seq=?) THEN 1 ELSE json_extract('{','$') END").bind(body.personId,target.seq),
 c.env.DB.prepare('INSERT INTO form_people_keys(database_id,field_key,email,record_id) VALUES(?,?,?,?) ON CONFLICT(database_id,field_key,email) DO UPDATE SET record_id=excluded.record_id').bind(grant.people_id,key,email,body.personId),
 c.env.DB.prepare("INSERT INTO access_audit(id,actor_id,space_id,action,after_json,generation,created_at) VALUES(?,?,?,'website_people_rebind',?,(SELECT generation FROM access_state WHERE id=1),?)")
 .bind(crypto.randomUUID(),actor.id,grant.space_id,JSON.stringify({personId:body.personId,databaseId:grant.people_id}),Date.now())]);
 return c.json({ok:true,personId:body.personId});
});

admin.get('/users', async (c) => {
  const { results } = await c.env.DB
    .prepare(`SELECT id, username, name, role, color, created_at,COALESCE(workspace_role,role) AS workspaceRole,(disabled_at IS NOT NULL) AS disabled FROM users WHERE id=? OR COALESCE((SELECT workspace_role FROM users WHERE id=?),'member')!='guest' ORDER BY created_at`).bind(c.get('user').id,c.get('user').id)
    .all<PublicUser & { created_at: number }>();
  return c.json({ users: results.map(({ created_at: _created_at, ...u }) => ({...u,disabled:!!u.disabled})), seatsTotal: MAX_USERS });
});

type AccountState={id:string;name:string;disabled_at:number|null;canonicalRole:string};
const privilegedCount="(SELECT COUNT(*) FROM users WHERE disabled_at IS NULL AND COALESCE(workspace_role,role) IN ('owner','admin'))";
function accountState(env:Env,id:string){return env.DB.prepare('SELECT id,name,disabled_at,COALESCE(workspace_role,role) AS canonicalRole FROM users WHERE id=?').bind(id).first<AccountState>();}
function accountFence(env:Env,target:string,before:AccountState,protectLast=false,protectOwner=false){
 return env.DB.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM users WHERE id=? AND disabled_at IS ? AND COALESCE(workspace_role,role)=? ${protectOwner?`AND COALESCE(workspace_role,role)!='owner'`:''} ${protectLast?`AND (disabled_at IS NOT NULL OR COALESCE(workspace_role,role) NOT IN ('owner','admin') OR ${privilegedCount}>1)`:''}) THEN 1 ELSE json_extract('{','$') END`).bind(target,before.disabled_at,before.canonicalRole);
}
async function accountBatch(env:Env,statements:D1PreparedStatement[]){try{await env.DB.batch(statements);return true;}catch(error){if(/malformed JSON/i.test(String(error)))return false;throw error;}}

admin.post('/users/:id/disable',requireAdmin,async c=>{
 const target=c.req.param('id')!,actor=c.get('user');if(target===actor.id)return c.json({error:'Cannot disable yourself'},400);
 const before=await accountState(c.env,target);if(!before)return c.json({error:'not found'},404);
 if(before.canonicalRole==='owner')return c.json({error:OWNER_PROTECTED_ERROR},403);
 const now=Date.now(),already=before.disabled_at!==null;
 const statements=[adminSessionFence(c.env,actor),accountFence(c.env,target,before,true,true),
  c.env.DB.prepare('UPDATE users SET disabled_at=COALESCE(disabled_at,?) WHERE id=?').bind(now,target),
  c.env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(target),
  c.env.DB.prepare('UPDATE ai_connections SET revoked_at=?,version=version+1 WHERE user_id=? AND revoked_at IS NULL').bind(now,target),
  c.env.DB.prepare('UPDATE ai_scope_consents SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL').bind(now,target),
  c.env.DB.prepare('UPDATE website_ingest_grant SET revoked_at=?,version=version+1,updated_at=? WHERE sponsor_id=? AND revoked_at IS NULL').bind(now,now,target),
 ];
 if(!already){
  const disableEventId=crypto.randomUUID();
  statements.push(
   c.env.DB.prepare(`INSERT INTO crm_capability_audit(id,actor_id,target_user_id,action,capability,scope,before_json,after_json,reason,request_id,created_at)
    SELECT lower(hex(randomblob(16))),?,user_id,'revoke',capability,scope,
      json_object('held',json('true'),'grantedBy',granted_by,'grantedAt',granted_at),
      json_object('held',json('false')),'account_disabled','disable|'||?||'|'||capability||'|'||scope,?
    FROM crm_capability_grants WHERE user_id=? ORDER BY capability,scope`).bind(actor.id,disableEventId,now,target),
   c.env.DB.prepare('DELETE FROM crm_capability_grants WHERE user_id=?').bind(target),
   c.env.DB.prepare("INSERT INTO access_audit(id,actor_id,target_user_id,action,before_json,after_json,generation,created_at) VALUES(?,?,?,'user.disable',?,?,(SELECT generation FROM access_state WHERE id=1),?)").bind(crypto.randomUUID(),actor.id,target,JSON.stringify({disabled:false}),JSON.stringify({disabled:true,connectorRevocation:'requested'}),now),
  );
 }
 if(!await accountBatch(c.env,statements))return c.json({error:'account_or_authority_changed'},409);
 let grantsRevoked=false;try{grantsRevoked=await revokeAllGrants(c.env,target,true);}catch{/* The account stays disabled; restoration requires a successful sweep. */}
 pokeLive(c.env,c.executionCtx);
 return c.json({ok:true,disabled:true,already,grantsRevoked,cleanupPending:!grantsRevoked});
});
admin.post('/users/:id/enable',requireAdmin,async c=>{
 const target=c.req.param('id')!,actor=c.get('user'),before=await accountState(c.env,target);
 if(!before)return c.json({error:'not found'},404);
 if(before.disabled_at===null)return c.json({ok:true,disabled:false,already:true});
 const count=await c.env.DB.prepare('SELECT COUNT(*) n FROM users WHERE disabled_at IS NULL').first<number>('n');
 if((count??0)>=MAX_USERS)return c.json({error:'capacity_full',message:'All seven active places are in use. Free a place before restoring access.'},409);
 // A partial provider sweep must never resurrect a legacy token that has no
 // connection id. Keep the user disabled and let the operator retry cleanup.
 try{await revokeAllGrants(c.env,target,true);}catch{return c.json({error:'connector_cleanup_pending',message:'Account remains disabled. Retry when connector revocation is available.'},503);}
 const now=Date.now();
 const committed=await accountBatch(c.env,[adminSessionFence(c.env,actor),accountFence(c.env,target,before),
  c.env.DB.prepare(`SELECT CASE WHEN (SELECT COUNT(*) FROM users WHERE disabled_at IS NULL)<? THEN 1 ELSE json_extract('{','$') END`).bind(MAX_USERS),
  c.env.DB.prepare('UPDATE users SET disabled_at=NULL WHERE id=?').bind(target),
  c.env.DB.prepare("INSERT INTO access_audit(id,actor_id,target_user_id,action,before_json,after_json,generation,created_at) VALUES(?,?,?,'user.enable',?,?,(SELECT generation FROM access_state WHERE id=1),?)").bind(crypto.randomUUID(),actor.id,target,JSON.stringify({disabled:true}),JSON.stringify({disabled:false,sessionsRestored:false,connectorsRestored:false}),now),
 ]);
 if(!committed)return c.json({error:'capacity_or_authority_changed',message:'Capacity or account access changed. Refresh and retry.'},409);
 pokeLive(c.env,c.executionCtx);return c.json({ok:true,disabled:false});
});

admin.post('/invites', requireAdmin, async (c) => {
  const code = inviteCode();
  if(!await accountBatch(c.env,[adminSessionFence(c.env,c.get('user')),c.env.DB.prepare('INSERT INTO invites (code, created_by, created_at) VALUES (?, ?, ?)').bind(code,c.get('user').id,Date.now())]))return c.json({error:'authority_changed'},409);
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
  if(!await accountBatch(c.env,[adminSessionFence(c.env,c.get('user')),c.env.DB.prepare('DELETE FROM invites WHERE code = ? AND used_by IS NULL').bind(c.req.param('code'))]))return c.json({error:'authority_changed'},409);
  return c.json({ ok: true });
});

admin.patch('/users/:id', requireAdmin, async (c) => {
  const target=c.req.param('id')!,actor=c.get('user');
  const body=await c.req.json<{role?:unknown;name?:unknown}>().catch(()=>null);
  if(!body||(body.role===undefined&&body.name===undefined))return c.json({error:'invalid update'},400);

  let nextRole:'admin'|'member'|undefined;
  if(body.role!==undefined){
    if(body.role!=='admin'&&body.role!=='member')return c.json({error:'invalid role'},400);
    nextRole=body.role;
  }

  let nextName:string|undefined;
  if(body.name!==undefined){
    if(typeof body.name!=='string')return c.json({error:'invalid_name'},400);
    const trimmed=body.name.trim();
    if(!trimmed||trimmed.length>80||/[\u0000-\u001F\u007F]/.test(trimmed))return c.json({error:'invalid_name'},400);
    nextName=trimmed;
  }

  // Owner-only audited account renaming (checked live against canonical owner role in D1).
  if(nextName!==undefined){
    const actorRow=await accountState(c.env,actor.id);
    if(!actorRow||actorRow.disabled_at!==null||actorRow.canonicalRole!=='owner'){
      return c.json({error:'owner_only'},403);
    }
  }

  if(nextRole!==undefined&&target===actor.id)return c.json({error:'Cannot change your own role'},400);
  const before=await accountState(c.env,target);if(!before)return c.json({error:'not found'},404);
  if(nextRole!==undefined){
    if(before.canonicalRole==='owner')return c.json({error:OWNER_PROTECTED_ERROR},403);
    if(before.canonicalRole==='guest')return c.json({error:'Guest roles must be managed through guest access'},400);
  }

  const statements:D1PreparedStatement[]=[
    nextName!==undefined?ownerSessionFence(c.env,actor):adminSessionFence(c.env,actor),
    accountFence(c.env,target,before,nextRole==='member',nextRole!==undefined),
  ];
  const now=Date.now();
  if(nextRole!==undefined&&nextName!==undefined){
    statements.push(
      c.env.DB.prepare('UPDATE users SET name=?,role=?,workspace_role=? WHERE id=?').bind(nextName,nextRole,nextRole,target),
      c.env.DB.prepare("INSERT INTO access_audit(id,actor_id,target_user_id,action,before_json,after_json,generation,created_at) VALUES(?,?,?,'user.role',?,?,(SELECT generation FROM access_state WHERE id=1),?)")
        .bind(crypto.randomUUID(),actor.id,target,JSON.stringify({role:before.canonicalRole}),JSON.stringify({role:nextRole}),now),
      c.env.DB.prepare("INSERT INTO access_audit(id,actor_id,target_user_id,action,before_json,after_json,generation,created_at) VALUES(?,?,?,'user.rename',?,?,(SELECT generation FROM access_state WHERE id=1),?)")
        .bind(crypto.randomUUID(),actor.id,target,JSON.stringify({name:before.name}),JSON.stringify({name:nextName}),now),
    );
  }else if(nextRole!==undefined){
    statements.push(
      c.env.DB.prepare('UPDATE users SET role=?,workspace_role=? WHERE id=?').bind(nextRole,nextRole,target),
      c.env.DB.prepare("INSERT INTO access_audit(id,actor_id,target_user_id,action,before_json,after_json,generation,created_at) VALUES(?,?,?,'user.role',?,?,(SELECT generation FROM access_state WHERE id=1),?)")
        .bind(crypto.randomUUID(),actor.id,target,JSON.stringify({role:before.canonicalRole}),JSON.stringify({role:nextRole}),now),
    );
  }else if(nextName!==undefined){
    statements.push(
      c.env.DB.prepare('UPDATE users SET name=? WHERE id=?').bind(nextName,target),
      c.env.DB.prepare("INSERT INTO access_audit(id,actor_id,target_user_id,action,before_json,after_json,generation,created_at) VALUES(?,?,?,'user.rename',?,?,(SELECT generation FROM access_state WHERE id=1),?)")
        .bind(crypto.randomUUID(),actor.id,target,JSON.stringify({name:before.name}),JSON.stringify({name:nextName}),now),
    );
  }
  if(!await accountBatch(c.env,statements))return c.json({error:'account_or_authority_changed'},409);
  pokeLive(c.env,c.executionCtx);
  return c.json({ok:true,...(nextName!==undefined?{name:nextName}:{}),...(nextRole!==undefined?{role:nextRole}:{})});
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
  const target=c.req.param('id')!,actor=c.get('user');
  if(target===actor.id)return c.json({error:'Cannot remove yourself'},400);
  const before=await accountState(c.env,target);if(!before)return c.json({error:'not found'},404);
  if(before.canonicalRole==='owner')return c.json({error:OWNER_PROTECTED_ERROR},403);
  if(!await accountBatch(c.env,[adminSessionFence(c.env,actor),accountFence(c.env,target,before,true,true),
    c.env.DB.prepare('DELETE FROM crm_capability_grants WHERE user_id=?').bind(target),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(target),
    c.env.DB.prepare('DELETE FROM users WHERE id=?').bind(target),
  ]))return c.json({error:'account_or_authority_changed'},409);
  await revokeAllGrants(c.env,target);pokeLive(c.env,c.executionCtx);return c.json({ok:true});
});

// Phase 5/9 search index recovery: mark a keyset page of documents dirty and rebuild one
// chunk. Repeat with `?after=<next>` until `next` is null; the cron drains the rest. The
// derived date metadata used by date-filtered search is refreshed by the same rebuild.
admin.post('/admin/reindex-search', requireAdmin, async (c) => {
  const { enqueueSearchRebuild, processSearchDirty } = await import('./search');
  const queued = await enqueueSearchRebuild(c.env, c.req.query('after') ?? '');
  const rebuilt = await processSearchDirty(c.env);
  return c.json({ ok: true, queued: queued.queued, rebuilt, next: queued.next });
});
