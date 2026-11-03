import type {Env} from './auth';
import {withReadGate,type EditableReadDecision} from './readAccess';
import {columnIdFor,firstColumnId} from '../shared/boardModel';
import {recordHref} from '../shared/recordRoutes';
import {WEBSITE_INBOX_ID} from '../shared/websiteInbox';
import {websiteRecordUrl} from '../shared/websiteStats';
import {FORM_PROCESSING_STATES,formProcessingErrorClass,type FormProcessingCounts,type FormProcessingState,type FormOperation,type FormOperationsReport} from '../shared/formOperations';

const DAY=86_400_000;
const live=(alias:string)=>`COALESCE(json_extract(${alias}.data,'$.deleted'),0)!=1 AND COALESCE(json_extract(${alias}.data,'$.archived'),0)!=1`;
const title=(alias:string,key:string,fallback:string)=>`CASE WHEN json_type(${alias}.data,'$.${key}')='text' THEN substr(json_extract(${alias}.data,'$.${key}'),1,300) ELSE '${fallback}' END`;

/** Bounded projections in one D1 batch. No payload, plan, receipt or token is read. */
const SOURCES=`WITH
 form_candidates AS(SELECT r.id,r.data,r.seq FROM records r WHERE r.collection='forms' AND ${live('r')}
   AND json_type(r.data,'$.databaseId')='text' AND (?1 IS NULL OR r.id=?1)
   AND (?2 IS NULL OR json_extract(r.data,'$.databaseId')=?2) ORDER BY r.id LIMIT 41),
 selected_forms AS(SELECT * FROM form_candidates ORDER BY id LIMIT 40),
 boards AS(SELECT r.id,r.data,r.seq FROM records r WHERE r.collection='boards' AND ${live('r')}
   AND r.id IN(SELECT json_extract(data,'$.databaseId') FROM selected_forms UNION SELECT ?7 WHERE ?8=1)),
 counts AS(SELECT s.form_id,s.state,COUNT(*) n30,SUM(s.created_at>=?4) n7 FROM selected_forms f
   CROSS JOIN form_submissions s ON s.form_id=f.id WHERE s.created_at BETWEEN ?3 AND ?6
   AND s.state IN('pending','processing','retryable_failure','rejected','accepted') GROUP BY s.form_id,s.state),
 failure_refs AS(SELECT f.id form_id,ref.value submission_id FROM selected_forms f,json_each((
   SELECT json_group_array(submission_id) FROM(SELECT submission_id FROM form_submissions
    WHERE form_id=f.id AND state IN('retryable_failure','rejected') AND created_at BETWEEN ?3 AND ?6
    ORDER BY created_at DESC,submission_id DESC LIMIT 11))) ref),
 followup_refs AS(SELECT f.id form_id,ref.value submission_id FROM selected_forms f,json_each((
   SELECT json_group_array(submission_id) FROM(SELECT submission_id FROM form_submissions
    WHERE ?8=1 AND form_id=f.id AND state='accepted' AND created_at<=?5 AND record_id IS NOT NULL
    ORDER BY created_at,submission_id LIMIT CASE WHEN ?1 IS NULL THEN 6 ELSE 121 END))) ref),
 website_candidates AS(SELECT r.id,r.data,r.seq FROM records r WHERE ?8=1 AND r.collection='tasks' AND ${live('r')}
   AND json_extract(r.data,'$.boardId')=?7 AND json_type(r.data,'$.createdAt') IN('integer','real')
   AND json_extract(r.data,'$.createdAt') BETWEEN ?3 AND ?6
   ORDER BY json_extract(r.data,'$.createdAt') DESC,r.id DESC LIMIT 151)
`;
export const FORM_OPERATIONS_SQL=[`${SOURCES}
 SELECT 'form' bucket,r.id,r.seq rev,json_object('title',${title('r','title','Untitled form')},
   'databaseId',json_extract(r.data,'$.databaseId'),'enabled',json(CASE WHEN json_extract(r.data,'$.enabled')=1 THEN 'true' ELSE 'false' END)) data FROM selected_forms r
 UNION ALL SELECT 'board',r.id,r.seq,json_object('name',${title('r','name','Untitled database')},'columns',json_extract(r.data,'$.columns')) FROM boards r
 UNION ALL SELECT 'count',form_id,0,json_object('state',state,'last7Days',n7,'last30Days',n30) FROM counts
 UNION ALL SELECT 'failure',s.submission_id,0,json_object('formId',f.form_id,'state',s.state,'createdAt',s.created_at,
   'attempts',s.attempts,'recovery',CASE WHEN s.state='rejected' OR s.attempts>=8 THEN 'stopped' WHEN s.payload IS NULL THEN 'blocked' ELSE 'automatic' END,'retryAt',CASE WHEN s.state='retryable_failure' THEN s.retry_at END,
   'errorCode',CASE WHEN json_valid(s.error) THEN CASE WHEN json_type(s.error,'$.error')='text' THEN json_extract(s.error,'$.error') END END)
   FROM failure_refs f JOIN form_submissions s ON s.submission_id=f.submission_id
`,`${SOURCES}
 SELECT 'followup' bucket,r.id,r.seq rev,json_object('formId',f.form_id,'submissionId',s.submission_id,
   'createdAt',s.created_at,'title',${title('r','title','Untitled record')},'boardId',json_extract(r.data,'$.boardId'),
   'status',json_extract(r.data,'$.status')) data FROM followup_refs f JOIN form_submissions s ON s.submission_id=f.submission_id
   JOIN records r ON r.id=s.record_id AND r.collection='tasks' AND ${live('r')}
 UNION ALL SELECT 'website',r.id,r.seq,json_object('title',${title('r','title','Untitled submission')},
   'status',COALESCE(json_extract(r.data,'$.status'),'new'),'createdAt',json_extract(r.data,'$.createdAt'))
   FROM(SELECT * FROM website_candidates LIMIT 150) r
 UNION ALL SELECT 'caps','caps',0,json_object('forms',(SELECT COUNT(*) FROM form_candidates),'website',(SELECT COUNT(*) FROM website_candidates))
 UNION ALL SELECT 'followup_cap',form_id,0,json_object('count',COUNT(*)) FROM followup_refs GROUP BY form_id`];

interface Raw {bucket:string;id:string;rev:number;data:string}
type Source =
 | {bucket:'form';id:string;rev:number;data:{title:string;databaseId:string;enabled:boolean}}
 | {bucket:'board';id:string;rev:number;data:{name:string;columns:unknown}}
 | {bucket:'count';id:string;rev:number;data:{state:FormProcessingState;last7Days:number;last30Days:number}}
 | {bucket:'failure';id:string;rev:number;data:{formId:string;state:'retryable_failure'|'rejected';createdAt:number;attempts:number;recovery:'automatic'|'stopped'|'blocked';retryAt:number|null;errorCode:string|null}}
 | {bucket:'followup';id:string;rev:number;data:{formId:string;submissionId:string;createdAt:number;title:string;boardId:string;status:unknown}}
 | {bucket:'website';id:string;rev:number;data:{title:string;status:string;createdAt:number}}
 | {bucket:'followup_cap';id:string;rev:number;data:{count:number}}
 | {bucket:'caps';id:string;rev:number;data:{forms:number;website:number}};
export class FormOperationsChanged extends Error {constructor(){super('form_operations_sources_changed');}}

export interface FormOperationsOptions {formId?:string;databaseId?:string;followupDays:number}
/** Shared source projection: health omits Website/follow-ups to leave room for its other gated sources. */
export function formOperationsStatements(db:D1Database,options:FormOperationsOptions,now:number,includeIntake=true){
  return FORM_OPERATIONS_SQL.map(sql=>db.prepare(sql).bind(options.formId??null,options.databaseId??null,now-30*DAY,now-7*DAY,now-options.followupDays*DAY,now,WEBSITE_INBOX_ID,includeIntake?1:0));
}
export function formOperationsProjection(raw:readonly D1Result<Raw>[]){
  // Shapes and string projections are owned by the query above, not visitor JSON.
  const rows=raw.flatMap(result=>result.results).map(row=>({...row,data:JSON.parse(row.data)})) as Source[];
  const sources=rows.filter(row=>['form','board','followup','website'].includes(row.bucket));
  return {recordIds:[...new Set(sources.map(row=>row.id))],report(decision:EditableReadDecision,options:FormOperationsOptions,now:number):FormOperationsReport|null{
  for(const row of sources)if(decision.readable.has(row.id)&&decision.revs.get(row.id)!==row.rev)throw new FormOperationsChanged();
  const boards=new Map(rows.filter(row=>row.bucket==='board').filter(row=>decision.readable.has(row.id)).map(row=>[row.id,row.data]));
  const emptyCounts=()=>Object.fromEntries(FORM_PROCESSING_STATES.map(state=>[state,0])) as FormProcessingCounts;
  let failureCap=false,followupCap=false;
  const forms:FormOperation[]=rows.filter(row=>row.bucket==='form').flatMap(row=>{
    if(!decision.editable.has(row.id)||!decision.editable.has(row.data.databaseId))return [];
    const board=boards.get(row.data.databaseId);if(!board)return [];
    const counts={last7Days:emptyCounts(),last30Days:emptyCounts()};
    for(const count of rows.filter(source=>source.bucket==='count').filter(source=>source.id===row.id)){
      counts.last7Days[count.data.state]=count.data.last7Days;counts.last30Days[count.data.state]=count.data.last30Days;
    }
    const failures=rows.filter(source=>source.bucket==='failure').filter(source=>source.data.formId===row.id).sort((a,b)=>b.data.createdAt-a.data.createdAt||b.id.localeCompare(a.id));
    if(failures.length>10)failureCap=true;
    const candidates=rows.filter(source=>source.bucket==='followup').filter(source=>source.data.formId===row.id).sort((a,b)=>a.data.createdAt-b.data.createdAt||a.data.submissionId.localeCompare(b.data.submissionId));
    const followupLimit=options.formId?120:5;
    if(rows.some(source=>source.bucket==='followup_cap'&&source.id===row.id&&source.data.count>followupLimit))followupCap=true;
    const followups=candidates.filter(source=>decision.readable.has(source.id)&&source.data.boardId===row.data.databaseId&&columnIdFor(source.data,board)===firstColumnId(board));
    return [{id:row.id,title:row.data.title,databaseId:row.data.databaseId,databaseName:board.name,enabled:row.data.enabled,counts,
      failures:failures.slice(0,10).map(source=>({submissionId:source.id,state:source.data.state,createdAt:source.data.createdAt,attempts:source.data.attempts,recovery:source.data.recovery,retryAt:source.data.retryAt,errorClass:formProcessingErrorClass(source.data.errorCode)})),
      followups:followups.slice(0,followupLimit).map(source=>({submissionId:source.data.submissionId,recordId:source.id,title:source.data.title,url:recordHref(row.data.databaseId,undefined,source.id),createdAt:source.data.createdAt}))}];
  });
  if(options.formId&&!forms.length)return null;
  const caps=rows.find(row=>row.bucket==='caps')!.data,websiteAvailable=boards.has(WEBSITE_INBOX_ID);
  const website=websiteAvailable?rows.filter(row=>row.bucket==='website').filter(row=>decision.readable.has(row.id)).map(row=>({id:row.id,...row.data,url:websiteRecordUrl(row.id)})).sort((a,b)=>b.createdAt-a.createdAt||b.id.localeCompare(a.id)):[];
  return {asOf:now,followupDays:options.followupDays,forms,partial:{forms:caps.forms>40,failures:failureCap,followups:followupCap},website:{available:websiteAvailable,partial:websiteAvailable&&caps.website>150,records:website}};
  }};
}
/** Reused by authenticated Forms operations and the admin delivery-health view. */
export async function collectFormOperations(env:Env,userId:string,options:FormOperationsOptions,now=Date.now()):Promise<FormOperationsReport|null>{
  const projection=formOperationsProjection(await env.DB.batch<Raw>(formOperationsStatements(env.DB,options,now)));
  const decision=await withReadGate(env,userId).READ_GATE!.decideEditable(projection.recordIds);
  return projection.report(decision,options,now);
}
