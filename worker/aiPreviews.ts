/** Frozen plans, a real session-authenticated decision, and crash-resumable writes.
 * A preview ID conveys no authority. Only this user's Workspace session can approve;
 * MCP only proposes and executes. Each batch journals and checkpoints atomically. */
import {Hono} from 'hono';
import {requireAuth,type Env,type AuthUser} from './auth';
import {scopeParentIds} from '../shared/recordScope';
import {argsHash} from '../shared/stablejson';
import {isCollection,type Collection} from '../shared/collections';
import {applyChanges,type AppliedChange} from './sync';
import {authorizeMutations,type AuthorityRow} from './mutationAccess';
import {withReadGate,accessEnabled} from './readAccess';
import {getRecs} from './records';
import {beginChangeset,undoChangeset} from './changesets';
import {loadConnection} from './connectorAccess';
import {hasD1Budget,d1CleanupDatabase} from './d1budget';
import {levelSql} from './capability';
export interface PreviewOp {id:string;collection:Collection;patch:Record<string,unknown>}
interface Preview {
 id:string;user_id:string;connection_id:string|null;connection_version:number|null;tool:string;request_id:string|null;result_meta:string;args_hash:string;workflow_id:string|null;
 plan_json:string;expected_json:string;dependencies_json:string;dependency_revs:string;impact_json:string;changeset_id:string;status:string;expires_at:number;approved_session:string|null;
}
export class PreviewError extends Error {constructor(public code:string,public status:400|403|404|409|410=409){super(code);}}
export const previewUrl=(origin:string,id:string)=>`${origin}/ai/review/${encodeURIComponent(id)}`;
async function currentRows(env:Env,ids:string[]) {
 const map=new Map<string,AuthorityRow>();
 for(let i=0;i<ids.length;i+=500){const rows=(await env.DB.prepare('SELECT id,collection,data,field_ts,seq FROM records WHERE id IN(SELECT value FROM json_each(?))').bind(JSON.stringify(ids.slice(i,i+500))).all<AuthorityRow>()).results;for(const r of rows)map.set(r.id,r);}
 return map;
}
async function validate(env:Env,userId:string,ops:PreviewOp[],rows:Map<string,AuthorityRow>) {
 if(await accessEnabled(env.DB)||env.CONNECTOR){
  const a=await authorizeMutations(env.DB,userId,ops.map(o=>({...o,ts:Date.now()+1})),rows,undefined,undefined,env.CONNECTOR);
  if(a.rejected.length)throw new PreviewError('plan_not_authorized',403);
 }
}
export async function proposePreview(env:Env,userId:string,tool:string,args:unknown,ops:PreviewOp[],workflowId?:string,sourceIds:readonly string[]=[],requestId?:string,resultMeta:Record<string,unknown>={},validatedRevisions?:ReadonlyMap<string,number>) {
 if(!Array.isArray(ops)||!ops.length||ops.length>2000||new TextEncoder().encode(JSON.stringify(ops)).length>512000||new Set(ops.map(o=>o.id)).size!==ops.length
  ||ops.some(o=>!isCollection(o.collection)||typeof o.id!=='string'||!o.id||o.id.length>64||!o.patch||typeof o.patch!=='object'||Array.isArray(o.patch))
  ||workflowId!==undefined&&(!/^[A-Za-z0-9_-]{1,64}$/.test(workflowId)))throw new PreviewError('invalid_or_oversized_plan',400);
 // Order parents before dependents, while keeping a delete's activity beside
 // its target so the canonical same-plan tombstone authorization still applies.
 const byId=new Map(ops.map(o=>[o.id,o])),ordered:PreviewOp[]=[],visiting=new Set<string>(),visited=new Set<string>();
 const visit=(op:PreviewOp)=>{if(visited.has(op.id))return;if(visiting.has(op.id))throw new PreviewError('cyclic_preview_plan',400);visiting.add(op.id);for(const parent of scopeParentIds({id:op.id,collection:op.collection,data:op.patch})){const p=byId.get(parent);if(p)visit(p);}visiting.delete(op.id);if(visited.has(op.id))return;visited.add(op.id);ordered.push(op);for(const activity of ops)if(activity.collection==='activity'&&activity.patch.targetId===op.id&&!visited.has(activity.id)){visited.add(activity.id);ordered.push(activity);}};
 for(const op of ops)visit(op);ops=ordered;
 const dependencies=[...new Set([...sourceIds,...(env.READ_GATE?.observedIds()??[])])].filter(id=>!ops.some(o=>o.id===id));
 if(dependencies.length>500)throw new PreviewError('too_many_source_dependencies',400);
 if(dependencies.length){const decision=await withReadGate(env,userId).READ_GATE!.decide(dependencies);if(decision.enabled&&dependencies.some(id=>!decision.readable.has(id)))throw new PreviewError('source_access_changed',403);}
 if(workflowId&&(await env.DB.prepare('SELECT COUNT(*) n FROM ai_previews WHERE user_id=? AND workflow_id=?').bind(userId,workflowId).first<number>('n')??0)>=100)throw new PreviewError('workflow_preview_limit',400);
 const dependencyRows=await currentRows(env,dependencies);
 const dependencyRevs=Object.fromEntries([...dependencyRows].map(([id,r])=>[id,r.seq]));
 // A record tool already ran the canonical planner. Preserve that exact
 // revision snapshot rather than silently adopting an intervening human edit.
 // Proposal persistence grants no execution authority; review/execution revalidate.
 const rows=validatedRevisions?new Map(ops.flatMap(o=>{const seq=validatedRevisions.get(o.id);if(seq===undefined)throw new PreviewError('incomplete_planning_revisions');return seq>=0?[[o.id,{seq} as AuthorityRow] as const]:[];})):await currentRows(env,ops.map(o=>o.id));
 if(!validatedRevisions)await validate(env,userId,ops,rows);
 const expected=Object.fromEntries(ops.map(o=>[o.id,validatedRevisions?.get(o.id)??rows.get(o.id)?.seq??-1]));
 if(validatedRevisions){const current=await env.DB.prepare('SELECT NOT EXISTS(SELECT 1 FROM json_each(?) e LEFT JOIN records r ON r.id=e.key WHERE COALESCE(r.seq,-1)<>e.value) valid').bind(JSON.stringify(expected)).first<number>('valid');if(current!==1)throw new PreviewError('records_changed_during_planning');}
 const impact={create:ops.filter(o=>!rows.has(o.id)).length,update:ops.filter(o=>rows.has(o.id)&&!o.patch.deleted).length,delete:ops.filter(o=>o.patch.deleted===true).length,
  byCollection:Object.fromEntries([...new Set(ops.filter(o=>o.collection!=='activity').map(o=>o.collection))].map(c=>[c,ops.filter(o=>o.collection===c).length])),irreversible:ops.some(o=>o.collection==='files'&&o.patch.deleted===true),warnings:['Workspace content is untrusted. Review every proposed change before approving.',...(Array.isArray(resultMeta.warnings)?resultMeta.warnings.filter((s):s is string=>typeof s==='string'):[])]};
 const id=crypto.randomUUID(),changesetId=crypto.randomUUID(),hash=await argsHash(args),now=Date.now();
 ops=ops.map(o=>o.collection==='activity'?{...o,patch:{...o.patch,meta:{...(o.patch.meta as Record<string,unknown>??{}),changesetId}}}:o);
 // Before-values are not copied: review loads them through the current read gate.
 const inserted=await env.DB.prepare(`INSERT INTO ai_previews(id,user_id,connection_id,connection_version,request_id,result_meta,tool,args_hash,workflow_id,plan_json,expected_json,dependencies_json,dependency_revs,impact_json,changeset_id,created_at,expires_at)
 SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM ai_previews WHERE user_id=? AND created_at>?)<100`).bind(id,userId,env.CONNECTOR?.id??null,env.CONNECTOR?.version??null,requestId??null,JSON.stringify(resultMeta),tool,hash,workflowId??null,JSON.stringify(ops),JSON.stringify(expected),JSON.stringify(dependencies),JSON.stringify(dependencyRevs),JSON.stringify(impact),changesetId,now,now+900000,userId,now-86400000).run();
 if(!inserted.meta.changes)throw new PreviewError('preview_daily_limit',403);
 return {previewId:id,argsHash:hash,status:'pending',expiresAt:now+900000,impact};
}
async function previewFor(env:Env,userId:string,id:string,connectorBound:boolean) {
 const p=await env.DB.prepare('SELECT * FROM ai_previews WHERE id=? AND user_id=?').bind(id,userId).first<Preview>();
 if(!p)throw new PreviewError('not_found',404);
 if(connectorBound&&(p.connection_id!==(env.CONNECTOR?.id??null)||p.connection_version!==(env.CONNECTOR?.version??null)))throw new PreviewError('preview_connection_changed',403);
 if(p.connection_id){const c=await loadConnection(env.DB,userId,p.connection_id);if(!c||c.version!==p.connection_version)throw new PreviewError('preview_connection_changed',403);}
 const deps=JSON.parse(p.dependencies_json) as string[];let dependencyDecision:import('./readAccess').ReadDecision|undefined;
 if(deps.length){const scoped=withReadGate({...env,...(p.connection_id?{CONNECTOR:{id:p.connection_id,version:p.connection_version!},READ_GATE:undefined}:{})},userId);const decision=await scoped.READ_GATE!.decide(deps);dependencyDecision=decision;if(decision.enabled&&deps.some(id=>!decision.readable.has(id)))throw new PreviewError('source_access_changed',403);}
 return {...p,dependencyDecision};
}
/** No retained payload is returned on completion: current links/history can be fetched anew. */
export async function executePreview(env:Env,userId:string,id:string,hash:string,ectx?:{waitUntil(p:Promise<unknown>):void}) {
 const p=await previewFor(env,userId,id,true);
 if(p.args_hash!==hash)throw new PreviewError('preview_arguments_changed');
 if(p.status==='completed')return {completed:true,replayed:true,changesetId:p.changeset_id};
 if(p.expires_at<=Date.now())throw new PreviewError('preview_expired',410);
 if(!['approved','executing'].includes(p.status))throw new PreviewError('human_approval_required',403);
 const lease=crypto.randomUUID(),now=Date.now();
 const claim=await env.DB.prepare(`UPDATE ai_previews SET status='executing',lease_id=?,lease_until=? WHERE id=? AND status IN('approved','executing') AND COALESCE(lease_until,0)<?`).bind(lease,now+120000,id,now).run();
 if(!claim.meta.changes)throw new PreviewError('preview_busy');
 try {
 let dependencyDecision=p.dependencyDecision;
 let dependencySpaces=dependencyDecision?[...new Set([...dependencyDecision.scopes.values()].flatMap(s=>[...s.readSpaceIds]))]:[];
 let graphRevs:Record<string,number>={};
 const sourceRevs=JSON.parse(p.dependency_revs) as Record<string,number>;
 const plan=JSON.parse(p.plan_json) as PreviewOp[],expected=JSON.parse(p.expected_json) as Record<string,number>;
 graphRevs=Object.fromEntries([...(dependencyDecision?.graphRevs??[])].filter(([id])=>!plan.some(o=>o.id===id)));
 const cs=beginChangeset({userId,tool:p.tool,summary:'Human-approved AI operation',requestId:p.request_id??'preview:'+id});cs.id=p.changeset_id;
  const done=new Set((await env.DB.prepare('SELECT record_id FROM ai_preview_done WHERE preview_id=?').bind(id).all<{record_id:string}>()).results.map(r=>r.record_id));
  const pending=plan.filter(o=>!done.has(o.id));
  // Guard ALL remaining expectations, including IDs reserved for future batches.
  // Each own completed record is excluded by its durable checkpoint.
  const guard=()=>env.DB.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM ai_previews p JOIN sessions s ON s.token_hash=p.approved_session AND s.user_id=p.user_id JOIN users u ON u.id=p.user_id
    WHERE p.id=? AND p.user_id=? AND p.status='executing' AND p.lease_id=? AND p.lease_until>? AND p.expires_at>? AND s.expires_at>? AND u.disabled_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM json_each(?) s WHERE ${levelSql('?', 's.value')}<1)
    AND NOT EXISTS(SELECT 1 FROM json_each(?) g LEFT JOIN records r ON r.id=g.key WHERE r.seq IS NOT g.value)
    AND NOT EXISTS(SELECT 1 FROM json_each(?) g LEFT JOIN records r ON r.id=g.key WHERE r.seq IS NOT g.value)
    AND NOT EXISTS(SELECT 1 FROM changesets WHERE id=? AND undone_by IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM json_each(?) e LEFT JOIN records r ON r.id=e.key WHERE COALESCE(r.seq,-1)<>e.value AND NOT EXISTS(SELECT 1 FROM ai_preview_done d WHERE d.preview_id=? AND d.record_id=e.key))
    THEN 1 ELSE json_extract('{','$') END`).bind(id,userId,lease,Date.now(),Date.now(),Date.now(),JSON.stringify(dependencyDecision?.enabled?dependencySpaces:[]),userId,JSON.stringify(graphRevs),JSON.stringify(sourceRevs),p.changeset_id,JSON.stringify(expected),id);
  let processed=0;
  for(let i=0;i<pending.length&&hasD1Budget(env.DB,14);i+=50){
   const fresh=await previewFor(env,userId,id,true);dependencyDecision=fresh.dependencyDecision;dependencySpaces=dependencyDecision?[...new Set([...dependencyDecision.scopes.values()].flatMap(s=>[...s.readSpaceIds]))]:[];graphRevs=Object.fromEntries([...(dependencyDecision?.graphRevs??[])].filter(([id])=>!plan.some(o=>o.id===id)));
   await env.DB.prepare('UPDATE ai_previews SET lease_until=? WHERE id=? AND lease_id=?').bind(Date.now()+120000,id,lease).run();
   const chunk=pending.slice(i,i+50);const existing=new Map(chunk.filter(o=>expected[o.id]>=0).map(o=>[o.id,expected[o.id]]));
   const result=await applyChanges(env,userId,chunk.map(o=>({...o,ts:0})),{serverTs:true,expect:existing,atomic:true,journal:cs,event:{source:'mcp',ctx:ectx,changesetId:cs.id},execution:{guard,checkpoint:recordId=>env.DB.prepare('INSERT OR IGNORE INTO ai_preview_done(preview_id,record_id) VALUES(?,?)').bind(id,recordId)}});
   if(result.conflicts?.length||result.rejected||result.conflict||result.partialError)throw new PreviewError('preview_conflict_or_access_changed');
   // Unchanged patches have no record transaction/checkpoint. Mark only after
   // the same expectation/approval guard succeeds, so retries remain honest.
   const applied=new Set(result.applied.map((a:AppliedChange)=>a.id));
   const noops=chunk.filter(o=>!applied.has(o.id));
   if(noops.length)await env.DB.batch([guard(),...noops.map(o=>env.DB.prepare('INSERT OR IGNORE INTO ai_preview_done(preview_id,record_id) VALUES(?,?)').bind(id,o.id))]);
   processed+=chunk.length;
  }
  const completed=done.size+processed===plan.length;
  if(completed)await env.DB.batch([guard(),
   env.DB.prepare("UPDATE ai_previews SET status='completed',lease_id=NULL,lease_until=NULL WHERE id=? AND lease_id=?").bind(id,lease),
   ...(p.workflow_id?[env.DB.prepare('INSERT OR IGNORE INTO ai_workflow_changesets(workflow_id,user_id,changeset_id,preview_id) VALUES(?,?,?,?)').bind(p.workflow_id,userId,cs.id,id)]:[]),
  ]);
  return {...(completed?JSON.parse(p.result_meta):{}),completed,pending:!completed,changesetId:cs.id,processed:done.size+processed,total:plan.length,workflowId:p.workflow_id};
 }catch(original){
  const e=original instanceof Error&&/malformed JSON/i.test(original.message)?new PreviewError('preview_conflict_or_access_changed'):original;
  await d1CleanupDatabase(env.DB).prepare('UPDATE ai_previews SET last_error=? WHERE id=? AND lease_id=?').bind(e instanceof PreviewError?e.code:'execution_interrupted',id,lease).run().catch(()=>{});
  throw e;
 }finally {await d1CleanupDatabase(env.DB).prepare('UPDATE ai_previews SET lease_id=NULL,lease_until=NULL WHERE id=? AND lease_id=?').bind(id,lease).run().catch(()=>{});}
}
export const aiPreviewApi=new Hono<{Bindings:Env;Variables:{user:AuthUser}}>();
aiPreviewApi.use('*',requireAuth);
aiPreviewApi.onError((e,c)=>{if(e instanceof PreviewError)return c.json({error:e.code},e.status);throw e;});
aiPreviewApi.get('/',async c=>{const rows=(await c.env.DB.prepare('SELECT id,tool,status,created_at,expires_at,workflow_id,changeset_id FROM ai_previews WHERE user_id=? ORDER BY created_at DESC LIMIT 50').bind(c.get('user').id).all()).results;return c.json({previews:rows});});
aiPreviewApi.get('/:id',async c=>{
 const uid=c.get('user').id,p=await previewFor(c.env,uid,c.req.param('id'),false),ops=JSON.parse(p.plan_json) as PreviewOp[];
 if(p.status==='completed')return c.json({id:p.id,tool:p.tool,status:p.status,expiresAt:p.expires_at,workflowId:p.workflow_id,argsHash:p.args_hash,changesetId:p.changeset_id,impact:{create:0,update:0,delete:0,irreversible:false,warnings:['Completed operation. Open current records or changeset history for authorized details.']},changes:[]});
 const env=withReadGate({...c.env,...(p.connection_id?{CONNECTOR:{id:p.connection_id,version:p.connection_version!}}:{})},uid);
 const rows=await getRecs(env,ops.map(o=>o.id));const expected=JSON.parse(p.expected_json) as Record<string,number>;
 // Existing denied records cannot be mistaken for proposed creations.
 if(ops.some(o=>expected[o.id]>=0&&!rows.has(o.id)))throw new PreviewError('preview_access_changed',403);
 await validate(env,uid,ops,await currentRows(env,ops.map(o=>o.id)));
 return c.json({id:p.id,tool:p.tool,status:p.status,expiresAt:p.expires_at,workflowId:p.workflow_id,impact:JSON.parse(p.impact_json),argsHash:p.args_hash,changes:ops.map(o=>({id:o.id,collection:o.collection,before:rows.get(o.id)?.data??null,after:o.patch,expectedRev:expected[o.id],currentRev:rows.get(o.id)?.rev??-1,conflict:(rows.get(o.id)?.rev??-1)!==expected[o.id]}))});
});
aiPreviewApi.post('/:id/decision',async c=>{
 const u=c.get('user'),p=await previewFor(c.env,u.id,c.req.param('id'),false),body=await c.req.json().catch(()=>null);
 if(!body||!['approve','cancel'].includes(body.decision)||body.argsHash!==p.args_hash)throw new PreviewError('invalid_decision',400);
 if(p.expires_at<=Date.now())throw new PreviewError('preview_expired',410);
 const result=await c.env.DB.prepare(`UPDATE ai_previews SET status=?,approved_at=?,approved_session=? WHERE id=? AND user_id=? AND status='pending' AND expires_at>?`).bind(body.decision==='approve'?'approved':'cancelled',Date.now(),u.tokenHash,p.id,u.id,Date.now()).run();
 if(!result.meta.changes)throw new PreviewError('preview_already_decided');
 return c.json({ok:true,status:body.decision==='approve'?'approved':'cancelled'});
});

aiPreviewApi.post('/:id/execute',async c=>{
 const u=c.get('user'),p=await previewFor(c.env,u.id,c.req.param('id'),false),body=await c.req.json().catch(()=>null);
 if(!body||body.argsHash!==p.args_hash)throw new PreviewError('invalid_execution',400);
 const env={...c.env,...(p.connection_id?{CONNECTOR:{id:p.connection_id,version:p.connection_version!},READ_GATE:undefined}:{})};
 return c.json(await executePreview(env,u.id,p.id,body.argsHash,c.executionCtx));
});

// Human-only grouped recovery. Each inverse is durable individually; a group
// explicitly reports partial progress and never promises an atomic group undo.
aiPreviewApi.get('/workflows/:workflowId',async c=>{
 const rows=(await c.env.DB.prepare('SELECT changeset_id,id AS preview_id,status FROM ai_previews WHERE user_id=? AND workflow_id=? ORDER BY created_at DESC,id DESC LIMIT 101').bind(c.get('user').id,c.req.param('workflowId')).all()).results;
 return c.json({changesets:rows.slice(0,100),truncated:rows.length>100,atomic:false});
});
aiPreviewApi.post('/workflows/:workflowId/undo',async c=>{
 await c.env.DB.prepare("UPDATE ai_previews SET status='cancelled',lease_id=NULL,lease_until=NULL WHERE id IN(SELECT id FROM ai_previews WHERE user_id=? AND workflow_id=? AND status IN('pending','approved','executing') LIMIT 100)").bind(c.get('user').id,c.req.param('workflowId')).run();
 const rows=(await c.env.DB.prepare('SELECT p.changeset_id FROM ai_previews p JOIN changesets c ON c.id=p.changeset_id WHERE p.user_id=? AND p.workflow_id=? AND c.undone_by IS NULL ORDER BY p.created_at DESC,p.id DESC LIMIT 11').bind(c.get('user').id,c.req.param('workflowId')).all<{changeset_id:string}>()).results;
 const results=[];for(const r of rows.slice(0,10)){if(!hasD1Budget(c.env.DB,20))break;results.push(await undoChangeset(c.env,c.get('user'),r.changeset_id,c.executionCtx));}
 return c.json({results,atomic:false,partial:results.length<rows.length||results.some(r=>!r.ok),more:rows.length>results.length});
});
