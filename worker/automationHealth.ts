import type {Env} from './auth';
import {withReadGate} from './readAccess';
import {formOperationsStatements,formOperationsProjection} from './forms';
import {FormOperationsChanged} from './formOperations';
import {recordHref} from '../shared/recordRoutes';
import {healthErrorClass,type AutomationHealthReport,type RecoveryState} from '../shared/automationHealth';
const DAY=86_400_000;
const live=(alias:string)=>`COALESCE(json_extract(${alias}.data,'$.deleted'),0)!=1 AND COALESCE(json_extract(${alias}.data,'$.archived'),0)!=1`;
const name=(alias:string,field:string,fallback:string)=>`CASE WHEN json_type(${alias}.data,'$.${field}')='text' THEN substr(json_extract(${alias}.data,'$.${field}'),1,300) ELSE '${fallback}' END`;
const error=(field:string)=>`CASE WHEN ${field} IN('execution attempt limit reached','D1 invocation budget reached; retry pending work') THEN ${field} END`;

/** Metadata projections only; no journal payload, plan, receipt, note or exception text is returned. */
export const AUTOMATION_HEALTH_SQL=[`WITH candidates AS(
 SELECT a.id,a.data,a.seq FROM records a WHERE a.collection='automations' AND ${live('a')}
 AND EXISTS(SELECT 1 FROM automation_runs run WHERE run.automation_id=a.id AND run.created_at BETWEEN ?1 AND ?2 AND run.status IN('retryable_failure','terminal_failure')) ORDER BY a.id LIMIT 51)
 SELECT 'automation' bucket,a.id,a.seq rev,json_object('name',${name('a','name','Unnamed automation')},
 'databaseId',COALESCE(json_extract(a.data,'$.trigger.databaseId'),json_extract(a.data,'$.databaseId')),
 'failedCount',(SELECT COUNT(*) FROM automation_runs run WHERE run.automation_id=a.id AND run.created_at BETWEEN ?1 AND ?2 AND run.status IN('retryable_failure','terminal_failure')),
 'lastRun',json((SELECT json_object('id',run.id,'createdAt',run.created_at,'attempts',run.attempts,'retryAt',run.retry_at,
 'recovery',CASE WHEN run.status='terminal_failure' OR run.attempts>=8 THEN 'stopped' WHEN run.payload IS NULL THEN 'blocked' ELSE 'automatic' END,
 'errorCode',${error('run.error')}) FROM automation_runs run WHERE run.automation_id=a.id AND run.created_at BETWEEN ?1 AND ?2 AND run.status IN('retryable_failure','terminal_failure') ORDER BY run.created_at DESC,run.id DESC LIMIT 1))) data FROM candidates a`,
 `WITH candidates AS(SELECT id,payload,created_at,attempts,terminal_at,last_error FROM event_outbox WHERE processed_at IS NULL AND (terminal_at IS NOT NULL OR attempts>=5) ORDER BY created_at,id LIMIT 51),
 refs AS(SELECT e.id outbox_id,ref.value record_id FROM candidates e,json_each((SELECT json_group_array(id) FROM(
 SELECT DISTINCT id FROM(
 SELECT json_extract(value,'$.id') id FROM json_each(CASE WHEN json_valid(e.payload) THEN e.payload ELSE '{}' END,'$.applied')
 UNION ALL SELECT json_extract(value,'$.recordId') FROM json_each(CASE WHEN json_valid(e.payload) THEN e.payload ELSE '{}' END,'$.extra')
 UNION ALL SELECT json_extract(value,'$.targetId') FROM json_each(CASE WHEN json_valid(e.payload) THEN e.payload ELSE '{}' END,'$.notifications'))
 WHERE typeof(id)='text' AND length(id) BETWEEN 1 AND 64 ORDER BY id LIMIT 5))) ref)
 SELECT 'event' bucket,e.id,0 rev,json_object('createdAt',e.created_at,'attempts',e.attempts,
 'recovery',CASE WHEN e.terminal_at IS NOT NULL OR e.attempts>=8 THEN 'stopped' WHEN NOT json_valid(e.payload) THEN 'blocked' ELSE 'automatic' END,
 'errorCode',${error('e.last_error')},'sources',json(COALESCE((SELECT json_group_array(json_object('id',ref.record_id,'rev',r.seq,
 'title',${name('r','title','Source record')},'collection',r.collection,'boardId',json_extract(r.data,'$.boardId')))
 FROM refs ref LEFT JOIN records r ON r.id=ref.record_id AND ${live('r')} WHERE ref.outbox_id=e.id),'[]'))) data FROM candidates e`,
 `SELECT 'approval' bucket,r.id,COALESCE(r.seq,0) rev,json_object('id',a.id,'targetId',a.target_id,'createdAt',a.created_at,
 'title',${name('r','title','Approval target')},'collection',r.collection,'boardId',json_extract(r.data,'$.boardId')) data
 FROM approvals a JOIN records r ON r.id=a.target_id AND ${live('r')} WHERE a.status='pending' AND a.created_at<=?1
 AND (a.requested_by=?2 OR a.approver_id=?2) ORDER BY a.created_at,a.id LIMIT 101`];
interface Raw {bucket:string;id:string;rev:number;data:string}
interface Target {id:string;rev:number|null;title:string;collection:string|null;boardId:string|null}
type Row=
 |{bucket:'automation';id:string;rev:number;data:{name:string;databaseId:string|null;failedCount:number;lastRun:{id:string;createdAt:number;attempts:number;retryAt:number;recovery:RecoveryState;errorCode:string|null}}}
 |{bucket:'event';id:string;rev:number;data:{createdAt:number;attempts:number;recovery:RecoveryState;errorCode:string|null;sources:Target[]}}
 |{bucket:'approval';id:string;rev:number;data:{id:string;targetId:string;title:string;createdAt:number;collection:string|null;boardId:string|null}};
export class AutomationHealthDenied extends Error {constructor(){super('forbidden');}}
export class AutomationHealthChanged extends Error {constructor(){super('automation_health_sources_changed');}}
const sourceUrl=(id:string,collection:string|null,boardId:string|null)=>collection==='tasks'?recordHref(boardId??'board-default',undefined,id):collection==='pages'?'/pages/'+id:collection==='boards'?'/boards/'+id:null;

export async function collectAutomationHealth(env:Env,userId:string,now=Date.now()):Promise<AutomationHealthReport>{
 const principal=await env.DB.prepare('SELECT COALESCE(workspace_role,role) role FROM users WHERE id=? AND disabled_at IS NULL').bind(userId).first<{role:string}>();
 if(!principal||!['admin','owner'].includes(principal.role))throw new AutomationHealthDenied();
 const options={followupDays:3},formStatements=formOperationsStatements(env.DB,options,now,false);
 const results=await env.DB.batch<Raw>([...formStatements,env.DB.prepare(AUTOMATION_HEALTH_SQL[0]).bind(now-7*DAY,now),env.DB.prepare(AUTOMATION_HEALTH_SQL[1]),env.DB.prepare(AUTOMATION_HEALTH_SQL[2]).bind(now-3*DAY,userId)]);
 const forms=formOperationsProjection(results.slice(0,formStatements.length));
 const rows=results.slice(formStatements.length).flatMap(result=>result.results).map(row=>({...row,data:JSON.parse(row.data)})) as Row[];
 const autoRows=rows.filter(row=>row.bucket==='automation'),eventRows=rows.filter(row=>row.bucket==='event'),approvalRows=rows.filter(row=>row.bucket==='approval');
 const events=eventRows.slice(0,50),eventSources=events.filter(row=>row.data.sources.length<=4).flatMap(row=>row.data.sources);
 const ids=[...new Set([...forms.recordIds,...autoRows.map(row=>row.id),...eventSources.map(row=>row.id),...approvalRows.map(row=>row.id).filter(id=>id!==null)])];
 const decision=await withReadGate(env,userId).READ_GATE!.decideEditable(ids);
 if(!['admin','owner'].includes(decision.workspaceRole??''))throw new AutomationHealthDenied();
 for(const row of [...autoRows,...approvalRows,...eventSources])if(decision.readable.has(row.id)&&decision.revs.get(row.id)!==row.rev)throw new AutomationHealthChanged();
 const formReport=forms.report(decision,options,now)!;
 let eventPartial=eventRows.length>50;
 const outEvents:AutomationHealthReport['events']=events.flatMap(row=>{
  if(!row.data.sources.length||row.data.sources.length>4||row.data.sources.some(source=>source.rev===null||!decision.readable.has(source.id))){eventPartial=true;return [];}
  return [{id:row.id,createdAt:row.data.createdAt,attempts:row.data.attempts,recovery:row.data.recovery,errorClass:healthErrorClass(row.data.errorCode),sources:row.data.sources.map(source=>({id:source.id,title:source.title,url:sourceUrl(source.id,source.collection,source.boardId)}))}];
 });
 return {asOf:now,automations:autoRows.slice(0,50).filter(row=>decision.readable.has(row.id)).map(row=>({id:row.id,name:row.data.name,databaseId:row.data.databaseId,failedCount:row.data.failedCount,lastRunId:row.data.lastRun.id,lastFailedAt:row.data.lastRun.createdAt,attempts:row.data.lastRun.attempts,retryAt:row.data.lastRun.retryAt,recovery:row.data.lastRun.recovery,errorClass:healthErrorClass(row.data.lastRun.errorCode)})),
 events:outEvents,forms:formReport.forms.filter(form=>form.failures.length>0).map(form=>({id:form.id,title:form.title,databaseId:form.databaseId,databaseName:form.databaseName,failed7Days:form.counts.last7Days.retryable_failure+form.counts.last7Days.rejected,failed30Days:form.counts.last30Days.retryable_failure+form.counts.last30Days.rejected,failures:form.failures})),
 approvals:approvalRows.slice(0,100).filter(row=>decision.readable.has(row.id)).map(row=>({id:row.data.id,targetId:row.id,title:row.data.title,createdAt:row.data.createdAt,url:sourceUrl(row.id,row.data.collection,row.data.boardId)})),
 partial:{automations:autoRows.length>50,events:eventPartial,forms:formReport.partial.forms,failures:formReport.partial.failures,approvals:approvalRows.length>100},scheduler:{available:false,reason:'not_recorded'}};
}
export {FormOperationsChanged};
