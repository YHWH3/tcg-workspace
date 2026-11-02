import {fieldsOf} from './fields';
import {isDone,columnIdFor} from './boardModel';
import {parseDateOnly} from './dates';
import {recordHref} from './recordRoutes';
import type {CommitmentsConfig} from './commitmentsConfig';
export type CommitmentRecord={id:string;title?:unknown;fields?:unknown;deleted?:unknown;archived?:unknown}&Record<string,unknown>;
export interface CommitmentLink {id:string;kind:string;fieldId:string;fromId:string;toId:string;deleted?:unknown;archived?:unknown}
interface Relation {fieldId:string;target:string;reverse:boolean}
interface Meeting {id:string;title:string;url:string;actions:Relation;decisions:Relation}
interface Action {id:string;boardId:string;title:string;url:string;done:boolean;ownerId:string|null;date:string|null;invalidDate:boolean}
interface Decision {id:string;boardId:string;title:string;url:string;unresolved:boolean;ownerId:string|null;ownerFieldAvailable:boolean}
/** Deterministic relationship review. Owners and dates come only from records. */
export function meetingCommitments(meeting:Meeting,links:readonly CommitmentLink[],tasks:readonly Action[],decisions:readonly Decision[],today:string){
 const peers=(relation:Relation)=>new Set(links.filter(link=>!link.deleted&&!link.archived&&link.kind==='relation'&&link.fieldId===relation.fieldId&&(relation.reverse?link.toId:link.fromId)===meeting.id).map(link=>relation.reverse?link.fromId:link.toId));
 const actionIds=peers(meeting.actions),decisionIds=peers(meeting.decisions),source={id:meeting.id,title:meeting.title,url:meeting.url};
 const availableActions=tasks.filter(task=>task.boardId===meeting.actions.target&&actionIds.has(task.id)),availableDecisions=decisions.filter(decision=>decision.boardId===meeting.decisions.target&&decisionIds.has(decision.id));
 const actions=availableActions.filter(task=>!task.done).map(task=>({...task,meeting:source})).sort((a,b)=>((a.date??'9999-99-99')<(b.date??'9999-99-99')?-1:(a.date??'9999-99-99')>(b.date??'9999-99-99')?1:a.id<b.id?-1:a.id>b.id?1:0));
 return {actions,overdue:actions.filter(task=>task.date!==null&&task.date<today),upcoming:actions.filter(task=>task.date!==null&&task.date>=today),undated:actions.filter(task=>task.date===null),decisions:availableDecisions.filter(decision=>decision.unresolved).map(decision=>({...decision,meeting:source})).sort((a,b)=>(a.id<b.id?-1:a.id>b.id?1:0)),unavailable:actionIds.size>availableActions.length||decisionIds.size>availableDecisions.length};
}
export interface CommitmentsSnapshot {meetings:CommitmentRecord[];records:CommitmentRecord[];boards:CommitmentRecord[];links:CommitmentLink[];partialSources:string[]}
/** Normalize projected stored metadata once; notes and answer bodies are absent. */
export function commitmentsPage(config:CommitmentsConfig,snapshot:CommitmentsSnapshot,context:{today:string;now:number}){
 const active=(row:{deleted?:unknown;archived?:unknown})=>!row.deleted&&!row.archived,label=(value:unknown,fallback:string)=>typeof value==='string'&&value.trim()?Array.from(value.trim()).slice(0,300).join(''):fallback;
 const boards=new Map(snapshot.boards.filter(active).map(board=>[board.id,board])),board=boards.get(config.databaseId),fields=fieldsOf(board),partialSources=new Set(snapshot.partialSources);
 const relation=(key:string):Relation|undefined=>{const field=fields.find(field=>'rel_'+field.id===key&&field.type==='relation'&&field.relation),r=field?.relation;if(!field||!r)return;const reverse=r.primary!==true&&!!r.pairedFieldId;return {fieldId:reverse?r.pairedFieldId!:field.id,target:r.target,reverse};};
 const actions=relation(config.actionsKey),decisions=relation(config.decisionsKey),valid=!!actions&&!!decisions&&fields.some(field=>'p_'+field.id===config.dateKey&&field.type==='date');
 if(actions&&decisions&&(!boards.has(actions.target)||!boards.has(decisions.target)))partialSources.add('target_databases');
 if(decisions&&boards.has(decisions.target)&&!fieldsOf(boards.get(decisions.target)).some(field=>'p_'+field.id===config.decisionOwnerKey&&field.type==='person'))partialSources.add('decision_owner_configuration');
 const person=(value:unknown)=>typeof value==='string'&&value?value:null;
 const records=snapshot.records.filter(active),tasks:Action[]=records.flatMap(record=>{
  const database=boards.get(String(record.boardId));if(!database)return [];
  return [{id:record.id,boardId:database.id,title:label(record.title,'Untitled action'),url:recordHref(database.id,undefined,record.id),ownerId:person(record.assigneeId),date:parseDateOnly(record.dueDate)?String(record.dueDate):null,invalidDate:record.dueDate!==undefined&&record.dueDate!==null&&record.dueDate!==''&&!parseDateOnly(record.dueDate),done:isDone(record,database)}];
 }),decisionRecords:Decision[]=records.flatMap(record=>{
  const database=boards.get(String(record.boardId));if(!database)return [];
  const ownerField=fieldsOf(database).find(field=>'p_'+field.id===config.decisionOwnerKey&&field.type==='person');
  return [{id:record.id,boardId:database.id,title:label(record.title,'Untitled decision'),url:recordHref(database.id,undefined,record.id),ownerId:ownerField?person(record[config.decisionOwnerKey]):null,ownerFieldAvailable:!!ownerField,unresolved:['open','recommended'].includes(columnIdFor(record,database))}];
 });
 const candidates=snapshot.meetings.filter(active).filter(meeting=>meeting.boardId===config.databaseId&&(!config.meetingId?!meeting.parentId:meeting.id===config.meetingId)).map(meeting=>({...meeting,date:parseDateOnly(meeting[config.dateKey])?String(meeting[config.dateKey]):null}));
 const cutoff=new Date(Date.parse(context.today+'T00:00:00Z')-config.days*86400000).toISOString().slice(0,10),undated=candidates.filter(meeting=>meeting.date===null);
 const selected=candidates.filter(meeting=>!!config.meetingId||meeting.date!==null&&meeting.date>=cutoff&&meeting.date<=context.today).sort((a,b)=>((a.date??'')>(b.date??'')?-1:(a.date??'')<(b.date??'')?1:0)||(a.id<b.id?-1:a.id>b.id?1:0));
 if(selected.length>config.limit)partialSources.add('meeting_selection');if(!config.meetingId&&undated.length)partialSources.add('meeting_dates');
 let actionBudget=100,decisionBudget=100;
 const meetings=valid?selected.slice(0,config.limit).map(meeting=>{
  const source={id:meeting.id,title:label(meeting.title,'Untitled meeting'),url:recordHref(config.databaseId,undefined,meeting.id),actions:actions!,decisions:decisions!},review=meetingCommitments(source,snapshot.links,tasks,decisionRecords,context.today);
  if(review.unavailable)partialSources.add('commitments_unavailable');
  const shownActions=review.actions.slice(0,Math.min(50,actionBudget)),shownDecisions=review.decisions.slice(0,Math.min(50,decisionBudget)),shownIds=new Set(shownActions.map(action=>action.id));actionBudget-=shownActions.length;decisionBudget-=shownDecisions.length;
  if(shownActions.length<review.actions.length||shownDecisions.length<review.decisions.length)partialSources.add('commitment_selection');
  return {id:source.id,title:source.title,url:source.url,date:meeting.date,...review,actions:shownActions,overdue:review.overdue.filter(action=>shownIds.has(action.id)),upcoming:review.upcoming.filter(action=>shownIds.has(action.id)),undated:review.undated.filter(action=>shownIds.has(action.id)),decisions:shownDecisions,actionTotal:review.actions.length,decisionTotal:review.decisions.length};
 }):[];
 return {status:!board?'source_unavailable' as const:!valid?'configuration_required' as const:config.meetingId&&!candidates.length?'meeting_unavailable' as const:'ready' as const,asOf:context.now,today:context.today,days:config.days,partial:partialSources.size>0,partialSources:[...partialSources].sort(),meetings,undatedMeetings:!config.meetingId?undated.slice(0,config.limit).map(meeting=>({id:meeting.id,title:label(meeting.title,'Untitled meeting'),url:recordHref(config.databaseId,undefined,meeting.id)+'?focusField='+encodeURIComponent(config.dateKey)})):[],undatedCount:undated.length,trust:{untrusted:true as const,instructions:false as const}};
}
export type CommitmentsPage=ReturnType<typeof commitmentsPage>;
