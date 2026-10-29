/** Targeted device snapshot for offline review. It intentionally has no cached
 * server approvals and always marks health Unknown until online verification. */
import type {LocalDB,LocalRow} from './db';
import {fieldsOf} from '../../shared/fields';
import {applyView} from '../../shared/views';
import {recordHref} from '../../shared/recordRoutes';
import {projectHealth,type HealthLink,type ProjectHealthPage} from '../../shared/projectHealth';
import {projectHealthFieldsAvailable,type ProjectHealthConfig} from '../../shared/projectHealthConfig';

type HealthStore=Pick<LocalDB,'tasks'|'boards'|'links'|'activity'>;
const active=(r:LocalRow|undefined):r is LocalRow=>!!r&&!r.deleted&&!r.archived;
export async function readLocalProjectHealth(store:HealthStore,config:ProjectHealthConfig,context:{userId:string;today:string;timeZone:string;now:number}):Promise<ProjectHealthPage>{
 const partial=new Set(['device_snapshot','offline_approvals']);
 const roots=config.projectId?(await store.tasks.bulkGet([config.projectId])).filter(active):await store.tasks.where('boardId').equals(config.databaseId!).and(r=>active(r)&&!r.parentId).limit(201).toArray();
 if(roots.length>200)partial.add('project_selection');
 const records=new Map(roots.slice(0,200).map(r=>[r.id,r]));
 const expand=async(ids:string[])=>{
  let frontier=ids;const tree=new Set(ids);
  for(let depth=0;depth<3&&frontier.length;depth++){
   const rows=await store.tasks.where('parentId').anyOf(frontier).and(active).limit(501).toArray();if(rows.length>500)partial.add('descendants');
   frontier=[];for(const r of rows.slice(0,500))if(!tree.has(r.id)){records.set(r.id,r);tree.add(r.id);frontier.push(r.id);}
  }
  return [...tree];
 };
 const projectTree=await expand([...records.keys()]);
 const relations=projectTree.length?await store.links.where('fromId').anyOf(projectTree).or('toId').anyOf(projectTree).and(r=>active(r)&&r.kind==='relation').limit(501).toArray():[];
 if(relations.length>500)partial.add('relations');
 const peers=[...new Set(relations.slice(0,500).flatMap(r=>[String(r.fromId),String(r.toId)]))];
 for(const r of (await store.tasks.bulkGet(peers)).filter(active))records.set(r.id,r);
 const boardIds=[...new Set([...(config.databaseId?[config.databaseId]:[]),...[...records.values()].map(r=>String(r.boardId??''))])];
 const boards=new Map((await store.boards.bulkGet(boardIds)).filter(active).map(b=>[b.id,b]));
 const taskRoots=peers.filter(id=>{const r=records.get(id),b=r?boards.get(String(r.boardId)):undefined;return !!b&&(b.templateDbKey==='tasks'||b.kind!=='records');});
 const taskTree=await expand(taskRoots),targets=[...new Set([...projectTree,...taskTree])];
 const incoming=targets.length?await store.links.where('toId').anyOf(targets).and(r=>active(r)&&r.kind==='blocks').limit(501).toArray():[];
 if(incoming.length>500)partial.add('dependencies');
 for(const r of (await store.tasks.bulkGet([...new Set(incoming.slice(0,500).map(l=>String(l.fromId)))])).filter(active))records.set(r.id,r);
 for(const b of (await store.boards.bulkGet([...new Set([...records.values()].map(r=>String(r.boardId??'')))])).filter(active))boards.set(b.id,b);
 const rows=targets.length?await store.activity.where('targetId').anyOf(targets).and(r=>!r.deleted).limit(1001).toArray():[];
 if(rows.length>1000)partial.add('activity');
 const activity=rows.slice(0,1000).filter(r=>typeof r.targetId==='string'&&typeof r.createdAt==='number').map(r=>({id:r.id,targetId:r.targetId as string,at:r.createdAt as number}));
 const links:HealthLink[]=[...relations.slice(0,500),...incoming.slice(0,500)].filter(r=>typeof r.kind==='string'&&typeof r.fromId==='string'&&typeof r.toId==='string').map(r=>({id:r.id,kind:r.kind as string,fromId:r.fromId as string,toId:r.toId as string,...(typeof r.fieldId==='string'?{fieldId:r.fieldId}:{})}));
 const database=config.databaseId?boards.get(config.databaseId):undefined;
 const candidates=roots.slice(0,200).filter(r=>config.projectId?!config.databaseId||r.boardId===config.databaseId:true),board=database??boards.get(String(candidates[0]?.boardId??''));
 if(board&&!projectHealthFieldsAvailable(board,config))partial.add('field_configuration');
 const filtered=applyView(candidates,{filters:config.filters},{meId:context.userId,today:context.today,timeZone:context.timeZone,fieldsById:new Map(fieldsOf({fields:board?.fields}).map(f=>[f.id,f])),relationTitles:(id,fid)=>links.filter(l=>l.kind==='relation'&&l.fromId===id&&l.fieldId===fid&&records.has(l.toId)).map(l=>String(records.get(l.toId)!.title??''))}).rows as LocalRow[];
 if(filtered.length>config.limit)partial.add('project_selection');
 const projects=filtered.slice(0,config.limit).map(project=>({id:project.id,title:String(project.title??'Untitled project'),databaseId:String(project.boardId),url:recordHref(String(project.boardId),undefined,project.id),health:projectHealth(project,{today:context.today,now:context.now,records:[...records.values()],boards:[...boards.values()],links,activity,approvals:[],partialSources:[...partial],ownerKey:config.ownerKey,startKey:config.startKey,endKey:config.endKey,staleDays:config.staleDays})}));
 const referenced=new Set(projects.flatMap(p=>p.health.recordIds));
 const unavailable=!!config.databaseId&&!database||!!config.projectId&&!projects.length;
 return {status:unavailable?'source_unavailable':'ready',asOf:context.now,today:context.today,partial:true,partialSources:[...partial].sort(),projects,records:[...records.values()].filter(r=>referenced.has(r.id)).map(r=>({id:r.id,title:String(r.title??'Untitled record'),databaseId:String(r.boardId),url:recordHref(String(r.boardId),undefined,r.id)})),approvalScope:'requested_or_approver',trust:{untrusted:true,instructions:false}};
}
