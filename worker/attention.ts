import {responseAge,responseConfig,receivedDate,type FlatRecord} from '../shared/websiteStats';
import {WEBSITE_INBOX_ID} from '../shared/websiteInbox';
import {aiDeskLink} from '../shared/aiReviewDesk';
/** Bounded, request-scoped derived queue. This never persists queue authority. */
import {Hono} from 'hono';
import {requireAuth,type Env,type AuthUser,parsePrefs} from './auth';
import {serverDateContext} from './workspaceSettings';
import {withReadGate,type ReadDecision} from './readAccess';
import {loadAccessContext,spaceAccess} from './access';
import {canEdit,canRead} from '../shared/access';
import {levelSql} from './capability';
import {d1BudgetRemaining} from './d1budget';
import {argsHash} from '../shared/stablejson';
import {recordHref} from '../shared/recordRoutes';
import {toDateOnlyInZone} from '../shared/dates';
import {attentionConfig,attentionDoneStage,attentionAge,compareAttention,attentionRankKey,datedAttentionKind,isAttentionKind,isAttentionTriager,openAttentionRecord,rankAttention,type AttentionItem,type AttentionKind,type AttentionPage} from '../shared/attention';

interface Query {limit?:number;cursor?:string;kinds?:AttentionKind[]}
interface SourceRow {
 id:string;target_id:string|null;target_collection:string|null;target_data:string;target_rev:number|null;
 board_id:string|null;board_data:string;board_rev:number|null;created_at?:number;event_date?:string;person_value?:unknown;
}
const caps={approval_pending:100,ai_preview_pending:100,suggestion_pending:100,dated:500,record_unassigned:200,mention_unread:50,automation_failed:20,website_aging:200} as const;
const live=(alias:string)=>`COALESCE(json_extract(${alias}.data,'$.deleted'),0)!=1 AND COALESCE(json_extract(${alias}.data,'$.archived'),0)!=1`;
// Project only queue metadata. Never load answer bodies, attachment bytes, old
// notification copies or provider text just to paint an attention row.
const projection=`r.id target_id,r.collection target_collection,r.seq target_rev,
 json_object('title',substr(json_extract(r.data,'$.title'),1,300),'name',substr(json_extract(r.data,'$.name'),1,300),'status',json_extract(r.data,'$.status'),'assigneeId',json_extract(r.data,'$.assigneeId'),'createdAt',json_extract(r.data,'$.createdAt'),'p_wi_received',json_extract(r.data,'$.p_wi_received'),'p_wi_replied',json_extract(r.data,'$.p_wi_replied'),'p_wi_stage',json_extract(r.data,'$.p_wi_stage'),'boardId',json_extract(r.data,'$.boardId'),'deleted',json(CASE WHEN json_extract(r.data,'$.deleted')=1 THEN 'true' ELSE 'false' END),'archived',json(CASE WHEN json_extract(r.data,'$.archived')=1 THEN 'true' ELSE 'false' END)) target_data,
 b.id board_id,b.seq board_rev,json_object('name',substr(json_extract(b.data,'$.name'),1,300),'kind',json_extract(b.data,'$.kind'),'deleted',json(CASE WHEN json_extract(b.data,'$.deleted')=1 THEN 'true' ELSE 'false' END),'archived',json(CASE WHEN json_extract(b.data,'$.archived')=1 THEN 'true' ELSE 'false' END),
 'attention',json_extract(b.data,'$.attention'),'responseBands',json_extract(b.data,'$.responseBands'),'responseTargetDays',json_extract(b.data,'$.responseTargetDays'),
 'fields',json((SELECT json_group_array(json_object('id',json_extract(f.value,'$.id'),'type',json_extract(f.value,'$.type'))) FROM json_each(b.data,'$.fields') f WHERE 'p_'||json_extract(f.value,'$.id') IN (json_extract(b.data,'$.attention.personKey'),json_extract(b.data,'$.attention.dateKey')))),
 'columns',json((SELECT json_group_array(json_object('id',json_extract(col.value,'$.id'))) FROM json_each(b.data,'$.columns') col))) board_data`;
const boardJoin=`LEFT JOIN records b ON b.collection='boards' AND b.id=CASE r.collection WHEN 'tasks' THEN COALESCE(json_extract(r.data,'$.boardId'),'board-default') WHEN 'automations' THEN COALESCE(json_extract(r.data,'$.trigger.databaseId'),json_extract(r.data,'$.databaseId')) END`;
// Apply the same normalized stage rule before a source cap: old completed
// records must not occupy the entire bounded window and starve open work.
const openRecord=`CASE WHEN json_type(b.data,'$.columns')='array' AND json_array_length(b.data,'$.columns')>0 THEN COALESCE((SELECT json_extract(col.value,'$.id') FROM json_each(b.data,'$.columns') col WHERE json_extract(col.value,'$.id')=json_extract(r.data,'$.status') LIMIT 1),json_extract(b.data,'$.columns[0].id')) IS NOT json_extract(b.data,'$.columns[#-1].id') ELSE COALESCE(json_extract(r.data,'$.status'),'')!='done' END`;
const configuredDate=`CASE WHEN json_type(b.data,'$.attention') IS NULL OR json_type(b.data,'$.attention')='null' THEN 'dueDate' ELSE json_extract(b.data,'$.attention.dateKey') END`;
const configured=`(json_extract(b.data,'$.attention.enabled')=1 OR (json_type(b.data,'$.attention') IS NULL OR json_type(b.data,'$.attention')='null') AND COALESCE(json_extract(b.data,'$.kind'),'tasks')!='records')`;
// Stored board settings are untyped here. Match responseConfig before limiting
// candidates, so an invalid target cannot hide overdue work from the window.
const websiteTarget=`CASE WHEN json_type(b.data,'$.responseTargetDays') IN('integer','real') AND json_extract(b.data,'$.responseTargetDays') BETWEEN 0 AND 3650 AND CAST(json_extract(b.data,'$.responseTargetDays') AS INTEGER)=json_extract(b.data,'$.responseTargetDays') THEN json_extract(b.data,'$.responseTargetDays') ELSE 3 END`;
const personValue=`(SELECT value FROM json_each(r.data) prop WHERE prop.key=COALESCE(json_extract(b.data,'$.attention.personKey'),'assigneeId'))`;
const scopeSql=(env:Env,enabled:boolean)=>`${enabled?` AND ${levelSql('(SELECT uid FROM caller)','r.space_id')}>=1 AND (r.peer_space_id IS NULL OR ${levelSql('(SELECT uid FROM caller)','r.peer_space_id')}>=1)`:''}${env.CONNECTOR?` AND r.space_id IN(SELECT value FROM json_each((SELECT spaces_json FROM ai_connections WHERE id=? AND user_id=(SELECT uid FROM caller) AND version=? AND revoked_at IS NULL AND expires_at>?)))`:''}`;
const base64=(value:unknown)=>btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
function decodeCursor(value:string):Record<string,unknown>{try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(value),c=>c.charCodeAt(0))));}catch{throw new Error('invalid_cursor');}}
function empty(today:string,now:number,source:string):AttentionPage{return {items:[],nextCursor:null,partial:true,partialSources:[source],today,asOf:now,urgentCount:0,quietDigest:false};}

export async function collectAttention(env:Env,userId:string,query:Query={},now=Date.now()):Promise<AttentionPage> {
 const limit=query.limit??50;
 if(!Number.isInteger(limit)||limit<1||limit>50||query.cursor!==undefined&&(typeof query.cursor!=='string'||query.cursor.length>2048)||query.kinds!==undefined&&(!Array.isArray(query.kinds)||query.kinds.length>10||query.kinds.some(k=>!isAttentionKind(k))))throw new Error('invalid_attention_query');
 const kinds=[...new Set(query.kinds??[])].sort(),settings=await serverDateContext(env,now),initial=await loadAccessContext(env.DB,userId,[],undefined,env.CONNECTOR);
 if(!initial.principal||initial.principal.disabledAt!==null||env.CONNECTOR&&initial.connector?.version!==env.CONNECTOR.version)throw new Error('unauthenticated');
 const admin=['owner','admin'].includes(initial.principal.workspaceRole),enabled=initial.enabled||!!env.CONNECTOR;
 const fingerprint=await argsHash({userId,connector:env.CONNECTOR??null,today:settings.today,settingsVersion:settings.version,kinds,enabled});
 let after:AttentionItem|null=null;
 if(query.cursor){const c=decodeCursor(query.cursor);if(c.f!==fingerprint||![0,1,2,3].includes(Number(c.severity))||typeof c.severity!=='number'||typeof c.date!=='string'||!/^(\d{4}-\d{2}-\d{2}|9999-99-99)$/.test(c.date)||typeof c.ageDays!=='number'||!Number.isSafeInteger(c.ageDays)||c.ageDays<0||typeof c.key!=='string'||!c.key||c.key.length>256)throw new Error('invalid_cursor');after={...c} as unknown as AttentionItem;}
 // No content has been loaded yet. A saturated caller gets an explicitly
 // incomplete empty queue, never an authorization shortcut or a false total.
 if(d1BudgetRemaining(env.DB)<8)return empty(settings.today,now,'processing_budget');
 const scoped=scopeSql(env,enabled),scopeBinds=env.CONNECTOR?[env.CONNECTOR.id,env.CONNECTOR.version,now]:[];
 const prepare=(sql:string,bind:(string|number)[]=[],scopedRead=false)=>env.DB.prepare(`WITH caller AS(SELECT ? uid) ${sql}`).bind(userId,...bind,...(scopedRead?scopeBinds:[]));
 const windowDays=`MIN(30,MAX(0,COALESCE(json_extract(b.data,'$.attention.soonDays'),3)))`;
 const results=await env.DB.batch([
  prepare(`SELECT a.id,a.created_at,${projection} FROM approvals a LEFT JOIN records r ON r.id=a.target_id ${boardJoin} WHERE a.approver_id=(SELECT uid FROM caller) AND a.status='pending' ORDER BY a.created_at,a.id LIMIT ${caps.approval_pending+1}`),
  prepare(`SELECT id,created_at FROM ai_previews WHERE user_id=(SELECT uid FROM caller) AND status='pending' AND expires_at>? ORDER BY created_at,id LIMIT ${caps.ai_preview_pending+1}`,[now]),
  prepare(`SELECT s.id,s.created_at,${projection} FROM ai_suggestions s LEFT JOIN records r ON r.id=s.target_id ${boardJoin} WHERE s.user_id=(SELECT uid FROM caller) AND s.status='pending' ORDER BY s.created_at,s.id LIMIT ${caps.suggestion_pending+1}`),
  prepare(`SELECT r.id,d.date event_date,${personValue} person_value,${projection} FROM date_index d JOIN records r ON r.id=d.record_id AND r.collection='tasks' ${boardJoin} WHERE b.id IS NOT NULL AND ${live('r')} AND ${live('b')} AND (${openRecord}) AND ${configured} AND d.field_key=${configuredDate} AND d.date<=date(?,'+'||${windowDays}||' days') AND ${personValue}=(SELECT uid FROM caller)${scoped} ORDER BY d.date,r.id LIMIT ${caps.dated+1}`,[settings.today],true),
  prepare(`SELECT r.id,${personValue} person_value,${projection} FROM records r ${boardJoin} WHERE r.collection='tasks' AND b.id IS NOT NULL AND ${live('r')} AND ${live('b')} AND (${openRecord}) AND ${configured} AND json_extract(b.data,'$.attention.triage')=1 AND COALESCE(${personValue},'')='' AND (json_type(b.data,'$.attention.triagers')='array' AND EXISTS(SELECT 1 FROM json_each(b.data,'$.attention.triagers') triager WHERE triager.value=(SELECT uid FROM caller)) OR COALESCE(json_extract(b.data,'$.attention.triagers'),'admins')='admins' AND ?=1)${scoped} ORDER BY r.id LIMIT ${caps.record_unassigned+1}`,[admin?1:0],true),
  prepare(`SELECT n.id,n.created_at,${projection} FROM notifications n LEFT JOIN records r ON r.id=n.target_id ${boardJoin} WHERE n.user_id=(SELECT uid FROM caller) AND n.kind='mention' AND n.read_at IS NULL ORDER BY n.created_at,n.id LIMIT ${caps.mention_unread+1}`),
  prepare(`SELECT run.id,run.created_at,${projection} FROM automation_runs run JOIN records r ON r.id=run.automation_id AND r.collection='automations' ${boardJoin} WHERE ?=1 AND run.created_at>=? AND run.status IN('retryable_failure','terminal_failure') AND ${live('r')} AND NOT EXISTS(SELECT 1 FROM automation_runs success WHERE success.automation_id=run.automation_id AND success.status='completed' AND (success.created_at>run.created_at OR success.created_at=run.created_at AND success.id>run.id))${scoped} ORDER BY run.created_at,run.id LIMIT ${caps.automation_failed+1}`,[admin?1:0,now-7*86400000],true),
  prepare(`SELECT r.id,${projection} FROM records r ${boardJoin} WHERE r.collection='tasks' AND b.id=? AND ${live('r')} AND ${live('b')} AND COALESCE(json_extract(r.data,'$.parentId'),'')='' AND ${configured}
   AND (json_extract(r.data,'$.assigneeId')=(SELECT uid FROM caller) OR ?=1 AND (COALESCE(json_extract(r.data,'$.assigneeId'),'')='' OR json_extract(r.data,'$.p_wi_stage')='refund_needed'))
   AND (json_extract(r.data,'$.p_wi_stage')='refund_needed' AND COALESCE(json_extract(r.data,'$.status'),'new')!='done' OR COALESCE(json_extract(r.data,'$.status'),'new') IN('new','in_review') AND COALESCE(json_extract(r.data,'$.p_wi_replied'),'')='' AND (CASE WHEN date(json_extract(r.data,'$.p_wi_received'),'+0 days')=json_extract(r.data,'$.p_wi_received') THEN json_extract(r.data,'$.p_wi_received')<date(?,'-'||(${websiteTarget})||' days') ELSE COALESCE(json_extract(r.data,'$.createdAt'),?)<?-((${websiteTarget})-1)*86400000 END))${scoped}
   ORDER BY CASE WHEN json_extract(r.data,'$.p_wi_stage')='refund_needed' THEN 0 ELSE 1 END,COALESCE(json_extract(r.data,'$.p_wi_received'),''),r.id LIMIT ${caps.website_aging+1}`,[WEBSITE_INBOX_ID,admin?1:0,settings.today,now+86400000,now],true),
  prepare('SELECT prefs FROM users WHERE id=(SELECT uid FROM caller) AND disabled_at IS NULL'),
 ]);
 const sources=Object.keys(caps) as (keyof typeof caps)[],partialSources=sources.filter((key,i)=>results[i].results.length>caps[key]);
 const buckets=sources.map((key,i)=>(results[i].results as unknown as SourceRow[]).slice(0,caps[key]));
 const nodes=new Map<string,{data:Record<string,unknown>;rev:number}>();
 for(const row of buckets.flat()){if(row.target_id&&row.target_rev!==null)nodes.set(row.target_id,{data:JSON.parse(row.target_data),rev:row.target_rev});if(row.board_id&&row.board_rev!==null)nodes.set(row.board_id,{data:JSON.parse(row.board_data),rev:row.board_rev});}
 const gate=withReadGate(env,userId).READ_GATE!;let decision:ReadDecision;
 try{decision=await gate.decide([...nodes.keys()]);}catch(error){if((error as {code?:string}).code==='scope_graph_budget')return empty(settings.today,now,'authorization_budget');throw error;}
 const spaces=[...new Set([...decision.scopes.values()].flatMap(s=>[...s.readSpaceIds]))];
 const current=await loadAccessContext(env.DB,userId,spaces,decision.graphRevs,env.CONNECTOR);
 if(!current.principal||current.principal.disabledAt!==null)throw new Error('unauthenticated');
 if(env.CONNECTOR&&current.connector?.version!==env.CONNECTOR.version||current.recordsCurrent===false||(current.enabled||!!env.CONNECTOR)!==decision.enabled)throw new Error('access_reset_required');
 const currentAdmin=['owner','admin'].includes(current.principal.workspaceRole);
 const readable=(id:string|null)=>!!id&&nodes.has(id)&&nodes.get(id)!.data.deleted!==true&&nodes.get(id)!.data.archived!==true&&(!decision.enabled||(decision.readable.has(id)&&decision.revs.get(id)===nodes.get(id)!.rev&&decision.scopes.get(id)!.readSpaceIds.every(s=>canRead(spaceAccess(current,s)))));
 const editable=(id:string)=>readable(id)&&(!decision.enabled||canEdit(spaceAccess(current,decision.scopes.get(id)!.spaceId)));
 const title=(data:Record<string,unknown>)=>String(data.title??data.name??'Untitled').slice(0,300);
 const items:AttentionItem[]=[];
 const recordItem=(row:SourceRow,kind:AttentionKind,severity:AttentionItem['severity'],actions:AttentionItem['actions']):AttentionItem=>{
  const data=nodes.get(row.target_id!)?.data??{},board=nodes.get(row.board_id!)?.data;
  return {key:`${kind}:${row.id}`,kind,targetType:row.target_collection==='pages'?'page':'record',targetId:row.target_id??'',title:title(data),url:row.target_collection==='pages'?`/pages/${encodeURIComponent(row.target_id!)}`:recordHref(row.board_id??'board-default',undefined,row.target_id!),...(row.board_id&&readable(row.board_id)?{databaseId:row.board_id,databaseName:String(board?.name??'Database').slice(0,300)}:{}),severity,actions};
 };
 for(const row of buckets[0]){
  const visible=readable(row.target_id),base=recordItem(row,'approval_pending',3,['decide']);
  items.push({...base,targetType:'approval',targetId:row.id,title:visible?base.title:'',url:visible?'/approvals':null,...(!visible?{restricted:true as const}:{}),...(visible?{}:{databaseId:undefined,databaseName:undefined})});
 }
 for(const row of buckets[1])items.push({key:`ai_preview_pending:${row.id}`,kind:'ai_preview_pending',targetType:'preview',targetId:row.id,title:'Review proposed changes',url:aiDeskLink('preview',row.id),severity:3,actions:['review']});
 for(const row of buckets[2])if(row.target_id&&editable(row.target_id))items.push({...recordItem(row,'suggestion_pending',1,['review']),targetType:'suggestion',targetId:row.id,url:aiDeskLink('suggestion',row.id),title:title(nodes.get(row.target_id)!.data)});
 for(const row of buckets[3]){
  if(!readable(row.target_id)||!readable(row.board_id))continue;const data=nodes.get(row.target_id!)!.data,board=nodes.get(row.board_id!)!.data,config=attentionConfig(board);
  if(!config?.enabled||row.person_value!==userId||!openAttentionRecord(data,board))continue;
  const kind=datedAttentionKind(row.event_date,settings.today,config.soonDays);if(!kind)continue;
  items.push({...recordItem(row,kind,kind==='record_overdue'?2:kind==='record_due_today'?1:0,['open',...(editable(row.target_id!)&&attentionDoneStage(board)?['mark_done' as const]:[])]),ownerId:userId,personKey:config.personKey,date:row.event_date,ageDays:attentionAge(row.event_date!,settings.today)});
 }
 for(const row of buckets[4]){
  if(!readable(row.target_id)||!readable(row.board_id))continue;const data=nodes.get(row.target_id!)!.data,board=nodes.get(row.board_id!)!.data,config=attentionConfig(board);
  if(!config?.enabled||!isAttentionTriager(config,userId,currentAdmin)||!openAttentionRecord(data,board))continue;
  items.push({...recordItem(row,'record_unassigned',0,['open',...(editable(row.target_id!)?['assign_me' as const]:[])]),ownerId:null,personKey:config.personKey});
 }
 for(const row of buckets[5]){
  const visible=readable(row.target_id),base=recordItem(row,'mention_unread',1,['open']);
  items.push({...base,title:visible?base.title:'',url:visible?'/inbox':null,...(!visible?{restricted:true as const,targetId:'',databaseId:undefined,databaseName:undefined}:{}),date:toDateOnlyInZone(row.created_at!,settings.timeZone)});
 }
 if(currentAdmin)for(const row of buckets[6])if(readable(row.target_id))items.push({...recordItem(row,'automation_failed',2,['open']),targetType:'automation',url:'/automations',date:toDateOnlyInZone(row.created_at!,settings.timeZone)});
 for(const row of buckets[7]){
  if(!readable(row.target_id)||!readable(row.board_id))continue;
  const data=nodes.get(row.target_id!)!.data,board=nodes.get(row.board_id!)!.data,config=attentionConfig(board);if(!config?.enabled)continue;
  const refund=data.p_wi_stage==='refund_needed'&&data.status!=='done',owner=typeof data.assigneeId==='string'&&data.assigneeId?data.assigneeId:null,triager=isAttentionTriager(config,userId,currentAdmin);
  if(owner!==userId&&!(triager&&(!owner||refund)))continue;
  const flat={...data,id:row.target_id!} as FlatRecord,age=responseAge(flat,settings.today,settings.timeZone),target=responseConfig(board).targetDays;
  if(!refund&&(age===null||age<=target))continue;
  items.push({...recordItem(row,'website_aging',2,['open']),ownerId:owner,date:receivedDate(flat,settings.timeZone),...(age===null?{}:{ageDays:age}),reason:refund?'Refund needed':'First reply overdue'});
 }
 const ranked=rankAttention(items.filter(i=>!kinds.length||kinds.includes(i.kind)),settings.today),remaining=ranked.filter(i=>!after||compareAttention(i,after)>0),page=remaining.slice(0,limit);
 return {items:page,nextCursor:remaining.length>limit?base64({f:fingerprint,...attentionRankKey(page.at(-1)!)}):null,partial:partialSources.length>0,partialSources,asOf:now,today:settings.today,urgentCount:ranked.filter(i=>i.severity>=2).length,quietDigest:parsePrefs((results[8].results[0] as {prefs?:string}|undefined)?.prefs).quietDigest===true};
}

export const attentionApi=new Hono<{Bindings:Env;Variables:{user:AuthUser}}>();
attentionApi.use('*',requireAuth);
attentionApi.get('/',async c=>{
 try{return c.json(await collectAttention(c.env,c.get('user').id,{...(c.req.query('limit')===undefined?{}:{limit:Number(c.req.query('limit'))}),...(c.req.query('cursor')===undefined?{}:{cursor:c.req.query('cursor')}),...(c.req.query('kinds')===undefined?{}:{kinds:c.req.query('kinds')!.split(',') as AttentionKind[]})}));}
 catch(error){const message=error instanceof Error?error.message:'attention_unavailable';if(['invalid_cursor','invalid_attention_query'].includes(message))return c.json({error:message},400);if(message==='unauthenticated')return c.json({error:message},401);if(message==='access_reset_required')return c.json({error:message,retryable:true},409);throw error;}
});
