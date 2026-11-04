/** Indexed metadata from the current account; never server completeness. */
import type {LocalDB,LocalRow} from './db';
import {fieldsOf} from '../../shared/fields';
import {commitmentsPage,type CommitmentLink} from '../../shared/commitments';
import type {CommitmentsConfig} from '../../shared/commitmentsConfig';
export async function readLocalCommitments(store:Pick<LocalDB,'tasks'|'boards'|'links'>,config:CommitmentsConfig,today:string,now:number){
 const active=(row:LocalRow|undefined):row is LocalRow=>!!row&&!row.deleted&&!row.archived,partial=new Set(['device_snapshot']);
 const board=await store.boards.get(config.databaseId),candidates=config.meetingId?[await store.tasks.get(config.meetingId)].filter(active):await store.tasks.where('boardId').equals(config.databaseId).and(row=>active(row)&&!row.parentId).limit(201).toArray();
 if(candidates.length>200)partial.add('meetings');const meetings=candidates.slice(0,200),ids=meetings.map(row=>row.id);
 const rawLinks=ids.length?await store.links.where('fromId').anyOf(ids).or('toId').anyOf(ids).and(row=>active(row)&&row.kind==='relation').limit(1001).toArray():[];
 if(rawLinks.length>1000)partial.add('relations');
 const links:CommitmentLink[]=rawLinks.slice(0,1000).flatMap(row=>typeof row.fromId==='string'&&typeof row.toId==='string'&&typeof row.fieldId==='string'?[{id:row.id,kind:'relation',fromId:row.fromId,toId:row.toId,fieldId:row.fieldId}]:[]);
 if(links.length<Math.min(rawLinks.length,1000))partial.add('relation_configuration');
 const peers=[...new Set(links.flatMap(link=>[link.fromId,link.toId]))];if(peers.length>1000)partial.add('records');
 const records=(await store.tasks.bulkGet(peers.slice(0,1000))).filter(active),relationKeys=[config.actionsKey,config.decisionsKey];
 const databaseIds=fieldsOf({fields:board?.fields}).filter(field=>relationKeys.includes('rel_'+field.id)&&field.type==='relation'&&field.relation).map(field=>field.relation!.target),boards=[board,...await store.boards.bulkGet([...new Set(databaseIds)])].filter(active);
 return commitmentsPage(config,{meetings,records,boards,links,partialSources:[...partial]},{today,now});
}
