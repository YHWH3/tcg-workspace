import {Hono} from 'hono';
import {requireAuth,type Env,type AuthUser} from './auth';
import {validCurrency,validTimeZone,type WorkspaceSettings} from '../shared/workspaceSettings';
import {workspaceToday} from '../shared/dates';
import {pokeLive} from './sync';
export interface WorkspaceContext {settings?:Promise<WorkspaceSettings>}
/** Fresh at the request boundary, shared only by copies of that request's env. */
export function withWorkspaceContext<T extends {DB:D1Database}>(env:T):T&{WORKSPACE_CONTEXT:WorkspaceContext}{return {...env,WORKSPACE_CONTEXT:{}};}
export async function readWorkspaceSettings(env:{DB:D1Database;WORKSPACE_CONTEXT?:WorkspaceContext}):Promise<WorkspaceSettings>{
 const load=async()=>{
  const r=await env.DB.prepare("SELECT time_zone,currency,week_start,version,updated_at FROM workspace_settings WHERE id='workspace'").first<{time_zone:string;currency:string;week_start:number;version:number;updated_at:number}>();
  if(!r||!validTimeZone(r.time_zone)||!validCurrency(r.currency)||!Number.isInteger(r.week_start)||r.week_start<0||r.week_start>6)throw new Error('workspace_settings_unavailable');
  return {timeZone:r.time_zone,currency:r.currency,weekStart:r.week_start,version:r.version,updatedAt:r.updated_at};
 };
 return env.WORKSPACE_CONTEXT?(env.WORKSPACE_CONTEXT.settings??=load()):load();
}
export async function serverToday(env:{DB:D1Database;WORKSPACE_CONTEXT?:WorkspaceContext},now=Date.now()):Promise<string>{return workspaceToday(now,(await readWorkspaceSettings(env)).timeZone);}
export async function serverDateContext(env:{DB:D1Database;WORKSPACE_CONTEXT?:WorkspaceContext},now=Date.now()){
 const settings=await readWorkspaceSettings(env);return {...settings,today:workspaceToday(now,settings.timeZone)};
}
export const workspaceSettingsApi=new Hono<{Bindings:Env;Variables:{user:AuthUser}}>();
workspaceSettingsApi.use('*',requireAuth);
workspaceSettingsApi.get('/settings',async c=>{
 const settings=await readWorkspaceSettings(c.env),user=c.get('user');
 const role=await c.env.DB.prepare('SELECT COALESCE(workspace_role,role) AS role FROM users WHERE id=? AND disabled_at IS NULL').bind(user.id).first<string>('role');
 return c.json({settings,canEdit:role==='owner'||role==='admin'});
});
workspaceSettingsApi.put('/settings',async c=>{
 const user=c.get('user'),db=c.env.DB;
 const role=await db.prepare('SELECT COALESCE(workspace_role,role) AS role FROM users WHERE id=? AND disabled_at IS NULL').bind(user.id).first<string>('role');
 if(role!=='owner'&&role!=='admin')return c.json({error:'forbidden'},403);
 const b=await c.req.json().catch(()=>null);
 if(!b||!validTimeZone(b.timeZone)||!validCurrency(b.currency)||!Number.isInteger(b.weekStart)||b.weekStart<0||b.weekStart>6||!Number.isSafeInteger(b.version)||b.version<1)return c.json({error:'invalid_workspace_settings'},400);
 const before=await readWorkspaceSettings(c.env);if(before.version!==b.version)return c.json({error:'version_conflict',settings:before},409);
 const now=Date.now(),after:WorkspaceSettings={timeZone:b.timeZone,currency:b.currency,weekStart:b.weekStart,version:b.version+1,updatedAt:now};
 try{
  await db.batch([
   db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>? AND u.disabled_at IS NULL AND COALESCE(u.workspace_role,u.role) IN ('owner','admin')) AND EXISTS(SELECT 1 FROM workspace_settings WHERE id='workspace' AND version=?) THEN 1 ELSE json_extract('{','$') END`).bind(user.tokenHash,user.id,now,b.version),
   db.prepare("UPDATE workspace_settings SET time_zone=?,currency=?,week_start=?,version=version+1,updated_by=?,updated_at=? WHERE id='workspace' AND version=?").bind(b.timeZone,b.currency,b.weekStart,user.id,now,b.version),
   db.prepare("INSERT INTO access_audit(id,actor_id,action,before_json,after_json,generation,created_at) VALUES(?,?,'workspace_settings.update',?,?,(SELECT generation FROM access_state WHERE id=1),?)").bind(crypto.randomUUID(),user.id,JSON.stringify(before),JSON.stringify(after),now),
  ]);
 }catch(error){if(/malformed JSON/i.test(String(error)))return c.json({error:'settings_or_authority_changed'},409);throw error;}
 if(c.env.WORKSPACE_CONTEXT)c.env.WORKSPACE_CONTEXT.settings=Promise.resolve(after);
 pokeLive(c.env,c.executionCtx);
 return c.json({ok:true,settings:after});
});
