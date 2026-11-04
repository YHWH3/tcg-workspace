/** Indexed metadata from the current account; never server completeness. */
import type {LocalDB,LocalRow} from './db';
import {fieldsOf} from '../../shared/fields';
import {eventOpsPage,type EventOpsLink} from '../../shared/eventOps';
import type {EventOpsConfig} from '../../shared/eventOpsConfig';
export async function readLocalEventOps(store:Pick<LocalDB,'tasks'|'boards'|'links'>,config:EventOpsConfig,today:string,now:number){
 const active=(row:LocalRow|undefined):row is LocalRow=>!!row&&!row.deleted&&!row.archived,partial=new Set(['device_snapshot']);
 const board=await store.boards.get(config.databaseId),candidates=config.eventId?[await store.tasks.get(config.eventId)].filter(active):await store.tasks.where('boardId').equals(config.databaseId).and(row=>active(row)&&!row.parentId).limit(201).toArray();
 if(candidates.length>200)partial.add('events');const events=candidates.slice(0,200),ids=events.map(row=>row.id);
 const rawLinks=ids.length?await store.links.where('fromId').anyOf(ids).or('toId').anyOf(ids).and(row=>active(row)&&row.kind==='relation').limit(1001).toArray():[];
 if(rawLinks.length>1000)partial.add('relations');
 const links:EventOpsLink[]=rawLinks.slice(0,1000).flatMap(row=>typeof row.fromId==='string'&&typeof row.toId==='string'&&typeof row.fieldId==='string'?[{id:row.id,kind:'relation',fromId:row.fromId,toId:row.toId,fieldId:row.fieldId,createdAt:row.createdAt}]:[]);
 if(links.length<Math.min(rawLinks.length,1000))partial.add('relation_configuration');
 const peers=[...new Set(links.flatMap(link=>[link.fromId,link.toId]))];if(peers.length>1000)partial.add('people');
 const people=(await store.tasks.bulkGet(peers.slice(0,1000))).filter(active),roleKeys=[config.facilitatorsKey,config.volunteersKey,config.participantsKey];
 const databaseIds=fieldsOf({fields:board?.fields}).filter(field=>roleKeys.includes('rel_'+field.id)&&field.type==='relation'&&field.relation).map(field=>field.relation!.target),boards=[board,...await store.boards.bulkGet([...new Set(databaseIds)])].filter(active);
 return eventOpsPage(config,{events,people,boards,links,partialSources:[...partial]},{today,now});
}
