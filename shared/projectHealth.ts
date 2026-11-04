/** Deterministic project review. Inputs are authorized, bounded snapshots; a
 * signal explains evidence and a next step, never grants permission to edit. */
import {parseDateOnly} from './dates';
import {columnsOf,isDone} from './boardModel';

export type HealthRecord={id:string}&Record<string,unknown>;
export interface HealthLink {id:string;kind:string;fromId:string;toId:string;fieldId?:string;deleted?:boolean}
export interface HealthActivity {id:string;targetId:string;at:number}
export interface HealthApproval {id:string;targetId:string;status:string}
export interface ProjectHealthContext {
 today:string;now:number;records:HealthRecord[];boards:HealthRecord[];links:HealthLink[];
 activity:HealthActivity[];approvals:HealthApproval[];partialSources:string[];
 ownerKey?:string;startKey?:string;endKey?:string;staleDays?:number;
}
export type HealthRule='blocked_stage'|'dependency_blocked'|'owner_missing'|'dates_missing'|'overdue_tasks'|'open_decisions'|'pending_approvals'|'no_recent_activity';
export interface HealthSignal {
 rule:HealthRule;label:string;sourceIds:string[];count:number;
 action:'assign_owner'|'set_dates'|'open_records'|'open_approvals'|'open_activity';
 approvalIds?:string[];
}
export interface ProjectHealth {
 projectId:string;status:'on_track'|'at_risk'|'blocked'|'unknown';signals:HealthSignal[];
 partialSources:string[];asOf:number;today:string;recordIds:string[];
}
export interface ProjectHealthPage {
 status:'ready'|'source_unavailable';asOf:number;today:string;partial:boolean;partialSources:string[];
 projects:{id:string;title:string;databaseId:string;url:string;health:ProjectHealth}[];
 records:{id:string;title:string;databaseId:string;url:string}[];
 approvalScope:'requested_or_approver';
 trust:{untrusted:true;instructions:false};
}
const active=(r:HealthRecord)=>!r.deleted&&!r.archived;

/** A derived record-detail block, never a silent persisted body edit. Any
 * saved health block, including a tombstone, reserves the user's choice. */
export function defaultProjectHealthBlock(record:HealthRecord,board:HealthRecord,bodyTypes:unknown[]){
 if(!active(record)||!active(board)||board.templateDbKey!=='projects'||bodyTypes.includes('projecthealth'))return null;
 return {id:`projecthealth:${record.id}`,type:'projecthealth',pageId:record.id,parentType:'record',databaseId:board.id,projectId:'self',heading:'Project health'};
}

/** Pack records have named terminal stages before their final column. Ordinary
 * task databases retain the canonical last-column completion rule. */
export function healthRecordDone(record:HealthRecord,board:HealthRecord):boolean {
 if(board.templateDbKey==='projects')return record.status==='completed'||record.status==='cancelled';
 if(board.templateDbKey==='decisions')return record.status==='decided'||record.status==='superseded';
 return isDone(record,board);
}

export function projectHealth(project:HealthRecord,ctx:ProjectHealthContext):ProjectHealth {
 const records=new Map(ctx.records.filter(active).map(r=>[r.id,r])),boards=new Map(ctx.boards.filter(active).map(b=>[b.id,b]));
 const partial=new Set(ctx.partialSources),signals:HealthSignal[]=[];
 const result=(ids:string[]):ProjectHealth=>({projectId:project.id,status:partial.size?'unknown':signals.some(s=>s.rule==='blocked_stage'||s.rule==='dependency_blocked')?'blocked':signals.some(s=>['dates_missing','overdue_tasks','open_decisions'].includes(s.rule))?'at_risk':'on_track',signals,partialSources:[...partial].sort(),asOf:ctx.now,today:ctx.today,recordIds:ids});
 if(!active(project)){partial.add('project_unavailable');return result([]);}
 if(!parseDateOnly(ctx.today)||!Number.isFinite(ctx.now)){partial.add('date_context');return result([project.id]);}
 const board=boards.get(String(project.boardId??''));
 if(!board){partial.add('project_database_unavailable');return result([project.id]);}
 records.set(project.id,project);
 // Parent edges are bounded by the supplied snapshot; visited ids also make
 // corrupt historic cycles harmless. Include descendants of linked tasks.
 const descendants=(roots:Set<string>)=>{
  let added=true;while(added){added=false;for(const r of records.values())if(typeof r.parentId==='string'&&roots.has(r.parentId)&&!roots.has(r.id)){roots.add(r.id);added=true;}}
 };
 const projectTree=new Set([project.id]);descendants(projectTree);
 const related=new Set<string>();
 for(const l of ctx.links)if(!l.deleted&&l.kind==='relation'){
  if(projectTree.has(l.fromId))related.add(l.toId);
  if(projectTree.has(l.toId))related.add(l.fromId);
 }
 const tasks=new Set<string>(),decisions=new Set<string>();
 for(const id of related){
  const r=records.get(id);if(!r){partial.add('related_source_unavailable');continue;}
  const b=boards.get(String(r.boardId??''));if(!b){partial.add('related_database_unavailable');continue;}
  if(b.templateDbKey==='decisions')decisions.add(id);
  else if(b.templateDbKey==='tasks'||b.kind!=='records')tasks.add(id);
 }
 descendants(tasks);
 const tree=new Set([...projectTree,...tasks]);
 const done=(r:HealthRecord)=>{const b=boards.get(String(r.boardId??''));if(!b){partial.add('related_database_unavailable');return false;}return healthRecordDone(r,b);};
 const add=(rule:HealthRule,label:string,ids:string[],action:HealthSignal['action'],approvalIds?:string[])=>{const sourceIds=[...new Set(ids)].sort();signals.push({rule,label,sourceIds,count:approvalIds?.length??sourceIds.length,action,...(approvalIds?{approvalIds}: {})});};
 const blocked=[...tree].filter(id=>{const r=records.get(id)!,b=boards.get(String(r.boardId??''));return r.status==='blocked'||b&&columnsOf(b).some(c=>c.id===r.status&&c.name?.toLowerCase()==='blocked');});
 if(blocked.length)add('blocked_stage','Blocked stage',blocked,'open_records');
 const blockers=new Set<string>();
 for(const l of ctx.links)if(!l.deleted&&l.kind==='blocks'&&tree.has(l.toId)){
  const r=records.get(l.fromId);if(!r){partial.add('dependency_source_unavailable');continue;}
  if(!done(r))blockers.add(r.id);
 }
 if(blockers.size)add('dependency_blocked','Unfinished dependencies',[...blockers],'open_records');
 if(!project[ctx.ownerKey??'p_f_owner'])add('owner_missing','Owner needed',[project.id],'assign_owner');
 if(!parseDateOnly(project[ctx.startKey??'p_f_start'])||!parseDateOnly(project[ctx.endKey??'p_f_end']))add('dates_missing','Start and end dates needed',[project.id],'set_dates');
 const overdue=[...tasks].filter(id=>{const r=records.get(id)!;return !done(r)&&parseDateOnly(r.dueDate)&&String(r.dueDate)<ctx.today;});
 if(overdue.length)add('overdue_tasks','Overdue tasks',overdue,'open_records');
 const openDecisions=[...decisions].filter(id=>!done(records.get(id)!));
 if(openDecisions.length)add('open_decisions','Open decisions',openDecisions,'open_records');
 const pending=ctx.approvals.filter(a=>a.status==='pending'&&tree.has(a.targetId));
 if(pending.length)add('pending_approvals','Pending approvals',pending.map(a=>a.targetId),'open_approvals',pending.map(a=>a.id).sort());
 const observed=ctx.activity.filter(a=>tree.has(a.targetId)).map(a=>a.at).filter(at=>Number.isFinite(at)&&at<=ctx.now);
 const created=typeof project.createdAt==='number'&&Number.isFinite(project.createdAt)&&project.createdAt<=ctx.now?project.createdAt:null;
 const last=observed.length?Math.max(...observed):created;
 if(last===null)partial.add('activity_age_unavailable');
 else if(ctx.now-last>=(ctx.staleDays??14)*86400000)add('no_recent_activity','No recent activity',[project.id],'open_activity');
 return result([...new Set([...tree,...decisions,...blockers])].sort());
}
