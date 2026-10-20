/** Suggestions are retained separately from authoritative records. Only an
 * authenticated human session can accept/edit them using exact record revisions. */
import {Hono} from 'hono';
import type {McpServer} from '@modelcontextprotocol/server';
import {z} from 'zod';
import {requireAuth,type Env,type AuthUser} from './auth';
import {withReadGate,editableBy} from './readAccess';
import {getRec} from './records';
import {argsHash} from '../shared/stablejson';
import {applyChanges} from './sync';
import {beginChangeset} from './changesets';
import {coerceFieldValue,fieldsOf} from '../shared/fields';
import {connectorRecordFence} from './connectorAccess';
const safeKey=(key:string)=>['title','description','priority','dueDate','assigneeId','status'].includes(key)||/^p_[A-Za-z0-9_-]+$/.test(key);
const patchSchema=z.record(z.string(),z.unknown()).refine(p=>Object.keys(p).length>0&&Object.keys(p).length<=25&&Object.keys(p).every(safeKey),'Only supported content fields can be suggested');
export async function createSuggestion(env:Env,userId:string,targetId:string,patch:Record<string,unknown>,rationale:string,provider='mcp-client',model='user-selected',id:string=crypto.randomUUID()){
 if(!patchSchema.safeParse(patch).success||JSON.stringify(patch).length>20000||rationale.length>4000)throw new Error('invalid_suggestion');
 const scoped=withReadGate(env,userId),target=await getRec(scoped,targetId);
 if(!target||target.data.deleted||target.collection!=='tasks')throw new Error('not_found');
 const hash=await argsHash(target.data),guard=await connectorRecordFence(scoped,userId,[targetId]);
 const statement=env.DB.prepare(`INSERT OR IGNORE INTO ai_suggestions(id,user_id,target_id,source_hash,source_rev,patch_json,rationale,provider,model,created_at)
 SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM records WHERE id=? AND seq=?) AND (SELECT COUNT(*) FROM ai_suggestions WHERE user_id=? AND created_at>?)<100`)
  .bind(id,userId,targetId,hash,target.rev,JSON.stringify(patch),rationale,provider,model,Date.now(),targetId,target.rev,userId,Date.now()-86400000);
 const inserted=guard?(await env.DB.batch([guard,statement]))[1]:await statement.run();
 if(!inserted.meta.changes){const prior=await env.DB.prepare('SELECT user_id,target_id FROM ai_suggestions WHERE id=?').bind(id).first<{user_id:string;target_id:string}>();if(!prior||prior.user_id!==userId||prior.target_id!==targetId)throw new Error('suggestion_daily_limit');}
 return {suggestionId:id,status:'pending',sourceHash:hash,sourceRev:target.rev};
}
export function registerSuggestionTools(server:McpServer,c:{env:Env;userId:string;origin:string}){
 server.registerTool('propose_suggestion',{description:'Persist suggested fields for one authorized source record, never apply them. Public submissions confer no authority over other records. The human reviews/edits/accepts in Workspace. No model is called by this tool.',inputSchema:z.object({targetId:z.string(),patch:patchSchema,rationale:z.string().max(4000)}),annotations:{idempotentHint:false}},async a=>{
  try{return {content:[{type:'text' as const,text:JSON.stringify({...await createSuggestion(c.env,c.userId,a.targetId,a.patch,a.rationale),reviewUrl:c.origin+'/ai',trust:{untrusted:true,source:'assistant_suggestion'}})}]};}
  catch(e){return {content:[{type:'text' as const,text:JSON.stringify({error:e instanceof Error?e.message:'suggestion_failed'})}],isError:true};}
 });
}
export const aiSuggestionsApi=new Hono<{Bindings:Env;Variables:{user:AuthUser}}>();
aiSuggestionsApi.use('*',requireAuth);
aiSuggestionsApi.get('/',async c=>{
 const uid=c.get('user').id,env=withReadGate(c.env,uid);
 const rows=(await env.DB.prepare("SELECT * FROM ai_suggestions WHERE user_id=? ORDER BY created_at DESC LIMIT 100").bind(uid).all<{id:string;target_id:string;patch_json:string;rationale:string;provider:string;model:string;status:string;source_rev:number;source_hash:string;created_at:number}>()).results;
 const allowed=await env.READ_GATE!.decide(rows.map(r=>r.target_id));
 return c.json({suggestions:rows.filter(r=>!allowed.enabled||allowed.readable.has(r.target_id)).map(r=>({...r,patch:JSON.parse(r.patch_json),patch_json:undefined}))});
});
aiSuggestionsApi.post('/:id/decision',async c=>{
 const u=c.get('user'),id=c.req.param('id'),b=await c.req.json().catch(()=>null);
 const row=await c.env.DB.prepare('SELECT * FROM ai_suggestions WHERE id=? AND user_id=?').bind(id,u.id).first<{target_id:string;patch_json:string;source_hash:string;status:string;changeset_id:string|null}>();
 if(!row)return c.json({error:'not_found'},404);
 const target=await getRec(withReadGate(c.env,u.id),row.target_id);if(!target||target.data.deleted)return c.json({error:'not_found'},404);
 if(!b||!['accept','reject'].includes(b.decision))return c.json({error:'invalid_decision'},400);
 if(row.status!=='pending')return c.json({status:row.status,replayed:true,changesetId:row.changeset_id});
 if(b.decision==='reject'){const updated=await c.env.DB.prepare("UPDATE ai_suggestions SET status='rejected',decided_at=? WHERE id=? AND user_id=? AND status='pending'").bind(Date.now(),id,u.id).run();if(!updated.meta.changes)return c.json({error:'suggestion_already_decided'},409);return c.json({status:'rejected'});}
 if(!Number.isSafeInteger(b.expectedRev)||b.expectedRev!==target.rev||await argsHash(target.data)!==row.source_hash||!await editableBy(c.env.DB,u.id,row.target_id))return c.json({error:'source_changed_or_access_denied'},409);
 const proposed=b.patch??JSON.parse(row.patch_json);if(!patchSchema.safeParse(proposed).success)return c.json({error:'invalid_patch'},400);
 const patch:Record<string,unknown>={};const board=await getRec(withReadGate(c.env,u.id),String(target.data.boardId??'board-default'));
 for(const [key,value] of Object.entries(proposed)){
  if(key.startsWith('p_')){const field=fieldsOf(board?.data).find(f=>f.id===key.slice(2));if(!field||field.type==='relation')return c.json({error:'field_unavailable'},409);patch[key]=coerceFieldValue(field,value);}
  else {
   if(key==='title'&&(typeof value!=='string'||!value.trim()||value.length>1000)||key==='description'&&(typeof value!=='string'||value.length>60000)||key==='priority'&&!['none','low','medium','high','urgent',null].includes(value as string|null)||key==='dueDate'&&value!==null&&(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))||key==='status'&&!(board?.data.columns as {id:string}[]|undefined)?.some(s=>s.id===value))return c.json({error:'invalid_field_value'},400);
   patch[key]=value;
  }
 }
 const personIds=Object.entries(patch).flatMap(([key,value])=>value&&(key==='assigneeId'||key.startsWith('p_')&&fieldsOf(board?.data).some(f=>f.id===key.slice(2)&&f.type==='person'))?[String(value)]:[]);
 if(personIds.length){const users=(await c.env.DB.prepare('SELECT id FROM users WHERE disabled_at IS NULL AND id IN(SELECT value FROM json_each(?))').bind(JSON.stringify(personIds)).all<{id:string}>()).results;if(personIds.some(id=>!users.some(u=>u.id===id)))return c.json({error:'resolve_actual_member_ids'},400);}
 const cs=beginChangeset({userId:u.id,tool:'accept_ai_suggestion',requestId:'suggestion:'+id});
 const result=await applyChanges(c.env,u.id,[{id:row.target_id,collection:'tasks',patch,ts:0}],{serverTs:true,expect:new Map([[row.target_id,b.expectedRev]]),atomic:true,session:{tokenHash:u.tokenHash},journal:cs,event:{source:'mcp',ctx:c.executionCtx,changesetId:cs.id},execution:{guard:()=>c.env.DB.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM ai_suggestions WHERE id=? AND user_id=? AND status='pending') THEN 1 ELSE json_extract('{','$') END").bind(id,u.id),checkpoint:()=>c.env.DB.prepare("UPDATE ai_suggestions SET status='accepted',decided_at=?,changeset_id=? WHERE id=? AND status='pending'").bind(Date.now(),cs.id,id)}});
 if(result.rejected||result.conflicts?.length||result.partialError)return c.json({error:'suggestion_conflict_or_access_changed'},409);
 if(!result.changed)return c.json({error:'no_change'},409);
 return c.json({status:'accepted',changesetId:cs.id});
});
