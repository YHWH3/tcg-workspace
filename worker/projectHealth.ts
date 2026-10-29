/** Named-source project health reads. Every record/link is gated together;
 * approvals retain participant visibility and no applicant/body bytes are read. */
import {Hono} from 'hono';
import {z} from 'zod';
import {requireAuth,type AuthUser,type Env} from './auth';
import {withReadGate} from './readAccess';
import {loadAccessContext} from './access';
import {getRecs} from './records';
import {serverDateContext} from './workspaceSettings';
import {fieldsOf} from '../shared/fields';
import {applyView} from '../shared/views';
import {recordHref} from '../shared/recordRoutes';
import {projectHealth,type HealthRecord,type HealthLink,type HealthActivity,type HealthApproval,type ProjectHealthPage} from '../shared/projectHealth';
import {projectHealthConfigSchema,projectHealthFieldsAvailable,type ProjectHealthConfig} from '../shared/projectHealthConfig';

interface Source {bucket:string;id:string;collection:string;data:string;rev:number}
const live=`COALESCE(json_extract(r.data,'$.deleted'),0)!=1 AND COALESCE(json_extract(r.data,'$.archived'),0)!=1`;
const recordProjection=`json_patch(json_object('title',json_extract(r.data,'$.title'),'boardId',json_extract(r.data,'$.boardId'),'parentId',json_extract(r.data,'$.parentId'),'status',json_extract(r.data,'$.status'),'assigneeId',json_extract(r.data,'$.assigneeId'),'dueDate',json_extract(r.data,'$.dueDate'),'createdAt',json_extract(r.data,'$.createdAt')),
 COALESCE((SELECT json_group_object(p.key,p.value) FROM json_each(r.data) p WHERE p.key IN(SELECT value FROM json_each(?2))),'{}'))`;
const flat=(r:{id:string;data:Record<string,unknown>}):HealthRecord=>({...r.data,id:r.id});
class ProjectHealthSourceChanged extends Error{constructor(){super('project_sources_changed');}}
/** A readable row with a newer revision is a changed snapshot, not a missing
 * project. Keep normal denial redaction while refusing stale source bytes. */
async function currentHealthRows<T extends {id:string;rev?:number}>(env:Env,rows:T[]):Promise<T[]>{
 if(!rows.length)return [];
 const decision=await env.READ_GATE!.decide(rows.map(r=>r.id));
 if(!decision.enabled)return rows;
 if(rows.some(r=>decision.readable.has(r.id)&&r.rev!==undefined&&decision.revs.get(r.id)!==r.rev))throw new ProjectHealthSourceChanged();
 return rows.filter(r=>decision.readable.has(r.id));
}
/** MCP links need an origin; the authenticated app keeps relative routes. */
export function projectHealthForOrigin(page:ProjectHealthPage,origin:string):ProjectHealthPage {
 return {...page,projects:page.projects.map(p=>({...p,url:origin+p.url})),records:page.records.map(r=>({...r,url:origin+r.url}))};
}

export async function collectProjectHealth(env:Env,userId:string,configs:ProjectHealthConfig[],now=Date.now()):Promise<ProjectHealthPage[]> {
 env=withReadGate(env,userId);
 const authority=await loadAccessContext(env.DB,userId,[],undefined,env.CONNECTOR);
 if(!authority.principal||authority.principal.disabledAt!==null||env.CONNECTOR&&authority.connector?.version!==env.CONNECTOR.version)throw new Error('unauthenticated');
 const date=await serverDateContext(env,now),databaseIds=[...new Set(configs.flatMap(c=>c.databaseId?[c.databaseId]:[]))],projectIds=[...new Set(configs.flatMap(c=>c.projectId?[c.projectId]:[]))];
 if(projectIds.includes('self'))throw new Error('project_context_required');
 const keys=[...new Set(configs.flatMap(c=>[c.ownerKey,c.startKey,c.endKey,...(c.filters??[]).map(f=>f.key)]))];
 const raw=await env.DB.prepare(`SELECT 'root' bucket,r.id,r.collection,${recordProjection} data,r.seq rev FROM records r WHERE r.collection='tasks' AND ${live} AND (r.id IN(SELECT value FROM json_each(?1)) OR json_extract(r.data,'$.boardId') IN(SELECT value FROM json_each(?3)) AND COALESCE(json_extract(r.data,'$.parentId'),'')='') ORDER BY r.id LIMIT 201`).bind(JSON.stringify(projectIds),JSON.stringify(keys),JSON.stringify(databaseIds)).all<Source>();
 const roots=(await currentHealthRows(env,raw.results.slice(0,200))).map(r=>flat({id:r.id,data:JSON.parse(r.data)}));
 const rootBoards=await getRecs(env,[...new Set([...databaseIds,...roots.map(r=>String(r.boardId??''))])]);
 // Resolve relations before evaluating filters; relation values are never
 // record properties. Filter and cap projects only after this gated snapshot.
 const selected=roots.map(r=>r.id);
 // Each CTE has its own sentinel. Caps are reported, never treated as evidence
 // that omitted tasks, blockers, activity or approvals do not exist.
 const snapshot=await env.DB.prepare(`WITH RECURSIVE
 project_tree(id,depth) AS(SELECT value,0 FROM json_each(?1) UNION ALL SELECT r.id,t.depth+1 FROM records r JOIN project_tree t ON json_extract(r.data,'$.parentId')=t.id WHERE r.collection='tasks' AND ${live} AND t.depth<3 LIMIT 501),
 relations AS(SELECT r.id,r.data,r.seq FROM records r WHERE r.collection='links' AND ${live} AND json_extract(r.data,'$.kind')='relation' AND (json_extract(r.data,'$.fromId') IN(SELECT id FROM project_tree) OR json_extract(r.data,'$.toId') IN(SELECT id FROM project_tree)) ORDER BY r.id LIMIT 501),
 neighbors AS(SELECT r.id,r.data FROM records r WHERE r.collection='tasks' AND ${live} AND r.id IN(SELECT json_extract(data,'$.fromId') FROM relations UNION SELECT json_extract(data,'$.toId') FROM relations) ORDER BY r.id LIMIT 501),
 task_tree(id,depth) AS(SELECT n.id,0 FROM neighbors n JOIN records b ON b.id=json_extract(n.data,'$.boardId') AND b.collection='boards' WHERE COALESCE(json_extract(b.data,'$.kind'),'tasks')!='records' OR json_extract(b.data,'$.templateDbKey')='tasks' UNION ALL SELECT r.id,t.depth+1 FROM records r JOIN task_tree t ON json_extract(r.data,'$.parentId')=t.id WHERE r.collection='tasks' AND ${live} AND t.depth<3 LIMIT 501),
 incoming AS(SELECT r.id,r.data,r.seq FROM records r WHERE r.collection='links' AND ${live} AND json_extract(r.data,'$.kind')='blocks' AND json_extract(r.data,'$.toId') IN(SELECT id FROM project_tree UNION SELECT id FROM task_tree) ORDER BY r.id LIMIT 501),
 sources AS(SELECT r.id,r.collection,r.data,r.seq FROM records r WHERE r.collection='tasks' AND ${live} AND r.id IN(SELECT id FROM project_tree UNION SELECT id FROM neighbors UNION SELECT id FROM task_tree UNION SELECT json_extract(data,'$.fromId') FROM incoming) ORDER BY r.id LIMIT 1001),
 boards AS(SELECT r.id,r.collection,r.data,r.seq FROM records r WHERE r.collection='boards' AND ${live} AND r.id IN(SELECT json_extract(data,'$.boardId') FROM sources) ORDER BY r.id LIMIT 101)
 SELECT 'record' bucket,r.id,r.collection,${recordProjection} data,r.seq rev FROM sources r
 UNION ALL SELECT 'board',r.id,r.collection,json_object('name',substr(json_extract(r.data,'$.name'),1,300),'kind',json_extract(r.data,'$.kind'),'templateDbKey',json_extract(r.data,'$.templateDbKey'),'columns',json_extract(r.data,'$.columns'),'fields',json_extract(r.data,'$.fields')),r.seq FROM boards r
 UNION ALL SELECT 'link',r.id,'links',json_object('kind',json_extract(r.data,'$.kind'),'fromId',json_extract(r.data,'$.fromId'),'toId',json_extract(r.data,'$.toId'),'fieldId',json_extract(r.data,'$.fieldId')),r.seq FROM relations r
 UNION ALL SELECT 'link',r.id,'links',json_object('kind',json_extract(r.data,'$.kind'),'fromId',json_extract(r.data,'$.fromId'),'toId',json_extract(r.data,'$.toId')),r.seq FROM incoming r
 UNION ALL SELECT 'caps','caps','',json_object('project_tree',(SELECT COUNT(*) FROM project_tree),'relations',(SELECT COUNT(*) FROM relations),'neighbors',(SELECT COUNT(*) FROM neighbors),'task_tree',(SELECT COUNT(*) FROM task_tree),'incoming',(SELECT COUNT(*) FROM incoming),'sources',(SELECT COUNT(*) FROM sources),'boards',(SELECT COUNT(*) FROM boards)),0`).bind(JSON.stringify(selected),JSON.stringify(keys)).all<Source>();
 const caps=JSON.parse(snapshot.results.find(r=>r.bucket==='caps')!.data) as Record<string,number>,partial=Object.entries(caps).filter(([k,n])=>n>(k==='sources'?1000:k==='boards'?100:500)).map(([k])=>k);
 const allowed=await currentHealthRows(env,snapshot.results.filter(r=>r.bucket!=='caps'));
 const records=allowed.filter(r=>r.bucket==='record').map(r=>flat({id:r.id,data:JSON.parse(r.data)})),boards=allowed.filter(r=>r.bucket==='board').map(r=>flat({id:r.id,data:JSON.parse(r.data)}));
 const links=allowed.filter(r=>r.bucket==='link').map(r=>({id:r.id,...JSON.parse(r.data)}) as HealthLink);
 const ids=records.map(r=>r.id);
 const extra=await env.DB.batch([
  env.DB.prepare(`WITH ranked AS(SELECT id,seq,json_extract(data,'$.targetId') target_id,CAST(json_extract(data,'$.createdAt') AS REAL) at,ROW_NUMBER() OVER(PARTITION BY json_extract(data,'$.targetId') ORDER BY CAST(json_extract(data,'$.createdAt') AS REAL) DESC,id DESC) n FROM records WHERE collection='activity' AND COALESCE(json_extract(data,'$.deleted'),0)!=1 AND json_extract(data,'$.targetId') IN(SELECT value FROM json_each(?)) AND CAST(json_extract(data,'$.createdAt') AS REAL)<=?) SELECT id,seq rev,target_id,at FROM ranked WHERE n=1 ORDER BY id LIMIT 1001`).bind(JSON.stringify(ids),now),
  env.DB.prepare("SELECT id,target_id,status FROM approvals WHERE status='pending' AND (approver_id=? OR requested_by=?) AND target_id IN(SELECT value FROM json_each(?)) ORDER BY id LIMIT 201").bind(userId,userId,JSON.stringify(ids)),
 ]);
 const activityRows=extra[0].results as unknown as {id:string;rev:number;target_id:string;at:number}[];
 if(activityRows.length>1000)partial.push('activity');
 const activity:HealthActivity[]=(await currentHealthRows(env,activityRows.slice(0,1000))).map(r=>({id:r.id,targetId:r.target_id,at:r.at}));
 const approvals=extra[1].results as unknown as {id:string;target_id:string;status:string}[];
 if(approvals.length>200)partial.push('approvals');
 const approvalContext:HealthApproval[]=approvals.slice(0,200).map(r=>({id:r.id,targetId:r.target_id,status:r.status}));
 if(!await env.READ_GATE!.validateObserved())throw new Error('access_reset_required');
 const current=await loadAccessContext(env.DB,userId,[],undefined,env.CONNECTOR);
 if(!current.principal||current.principal.disabledAt!==null||current.enabled!==authority.enabled||env.CONNECTOR&&current.connector?.version!==env.CONNECTOR.version)throw new Error('access_reset_required');
 const byId=new Map(records.map(r=>[r.id,r])),boardById=new Map(boards.map(b=>[b.id,b]));
 return configs.map(config=>{
  const sources=[...partial],database=config.databaseId?rootBoards.get(config.databaseId):undefined;
  const candidates=roots.flatMap(r=>{const current=byId.get(r.id);return current&&(config.projectId?current.id===config.projectId&&(!config.databaseId||current.boardId===config.databaseId):current.boardId===config.databaseId&&!current.parentId)?[current]:[];});
  const board=boardById.get(config.databaseId??String(candidates[0]?.boardId??''));
  const filtered=applyView(candidates,{filters:config.filters},{meId:userId,today:date.today,timeZone:date.timeZone,fieldsById:new Map(fieldsOf({fields:board?.fields}).map(f=>[f.id,f])),relationTitles:(id,fid)=>links.filter(l=>l.kind==='relation'&&l.fromId===id&&l.fieldId===fid&&byId.has(l.toId)).map(l=>String(byId.get(l.toId)!.title??''))}).rows as HealthRecord[];
  const chosen=filtered.slice(0,config.limit);
  if(board&&!projectHealthFieldsAvailable(board,config))sources.push('field_configuration');
  const unavailable=!!config.databaseId&&(!database||database.collection!=='boards'||database.data.deleted||database.data.archived)||!!config.projectId&&!chosen.length;
  const projects=chosen.map(r=>{
   const project=byId.get(r.id)!,health=projectHealth(project,{today:date.today,now,records,boards,links,activity,approvals:approvalContext,partialSources:sources,ownerKey:config.ownerKey,startKey:config.startKey,endKey:config.endKey,staleDays:config.staleDays});
   return {id:project.id,title:String(project.title??'Untitled project').slice(0,300),databaseId:String(project.boardId),url:recordHref(String(project.boardId),undefined,project.id),health};
  });
  const referenced=new Set(projects.flatMap(p=>p.health.recordIds));
  return {status:unavailable?'source_unavailable':'ready',asOf:now,today:date.today,partial:!!sources.length||raw.results.length>200||filtered.length>config.limit,partialSources:[...sources,...(raw.results.length>200||filtered.length>config.limit?['project_selection']:[])],projects,records:records.filter(r=>referenced.has(r.id)).map(r=>({id:r.id,title:String(r.title??'Untitled record').slice(0,300),databaseId:String(r.boardId),url:recordHref(String(r.boardId),undefined,r.id)})),approvalScope:'requested_or_approver',trust:{untrusted:true,instructions:false}};
 });
}

export const projectHealthApi=new Hono<{Bindings:Env;Variables:{user:AuthUser}}>();
projectHealthApi.onError((error,c)=>{if(error instanceof ProjectHealthSourceChanged)return c.json({error:error.message},409);throw error;});
projectHealthApi.use('*',requireAuth);
projectHealthApi.post('/',async c=>{
 const raw=await c.req.text();if(raw.length>12_000)return c.json({error:'configuration_too_large'},413);
 let value:unknown;try{value=JSON.parse(raw);}catch{return c.json({error:'invalid_configuration'},400);}
 const parsed=z.array(projectHealthConfigSchema).min(1).max(20).safeParse(value);if(!parsed.success)return c.json({error:'invalid_configuration'},400);
 if(parsed.data.some(config=>config.projectId==='self'))return c.json({error:'project_context_required'},400);
 return c.json({pages:await collectProjectHealth(c.env,c.get('user').id,parsed.data)});
});
