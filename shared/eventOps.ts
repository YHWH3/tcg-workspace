import {fieldsOf} from './fields';
import {isDone} from './boardModel';
import {parseDateOnly} from './dates';
import {recordHref} from './recordRoutes';
import type {EventOpsConfig} from './eventOpsConfig';
export const EVENT_ROLES=['facilitators','volunteers','participants'] as const;
export type EventRole=typeof EVENT_ROLES[number];
export interface EventRoleLink {eventId:string;personId:string;role:EventRole;linkedAt:number|null}
/** Counts distinct accessible people per role; one person may have several roles.
 * Capacity is informational and never changes registration or attendance. */
export function roleCoverage(event:{id:string;capacity:number|null},links:readonly EventRoleLink[]){
 const people={facilitators:new Set<string>(),volunteers:new Set<string>(),participants:new Set<string>()};
 for(const link of links)if(link.eventId===event.id)people[link.role].add(link.personId);
 const ids={facilitators:[...people.facilitators].sort(),volunteers:[...people.volunteers].sort(),participants:[...people.participants].sort()},participants=ids.participants.length;
 return {facilitators:ids.facilitators.length,volunteers:ids.volunteers.length,participants,people:ids,capacity:event.capacity,remaining:event.capacity===null?null:event.capacity-participants,overCapacity:event.capacity===null?null:participants>event.capacity};
}
export type EventOpsRecord={id:string;deleted?:unknown;archived?:unknown}&Record<string,unknown>;
export interface EventOpsLink {id:string;kind:string;fieldId:string;fromId:string;toId:string;createdAt?:unknown;deleted?:unknown;archived?:unknown}
export interface EventOpsSnapshot {events:EventOpsRecord[];people:EventOpsRecord[];boards:EventOpsRecord[];links:EventOpsLink[];partialSources:string[]}
/** Normalize untrusted stored metadata once. No biography, form payload, email,
 * observation body or submission receipt is copied into this summary. */
export function eventOpsPage(config:EventOpsConfig,snapshot:EventOpsSnapshot,context:{today:string;now:number}){
 const active=(record:{deleted?:unknown;archived?:unknown})=>!record.deleted&&!record.archived;
 const label=(value:unknown,fallback:string)=>typeof value==='string'&&value.trim()?Array.from(value.trim()).slice(0,300).join(''):fallback;
 const boards=new Map(snapshot.boards.filter(active).map(board=>[board.id,board])),board=boards.get(config.databaseId),fields=fieldsOf({fields:board?.fields});
 const keys=[config.facilitatorsKey,config.volunteersKey,config.participantsKey],roleFields=keys.map(key=>fields.find(field=>`rel_${field.id}`===key&&field.type==='relation'&&field.relation));
 const valid=!!board&&roleFields.every(Boolean)&&fields.some(field=>`p_${field.id}`===config.capacityKey&&field.type==='number')&&fields.some(field=>`p_${field.id}`===config.startKey&&field.type==='date');
 const people=new Map(snapshot.people.filter(active).map(person=>[person.id,person])),partialSources=new Set(snapshot.partialSources),roleLinks:EventRoleLink[]=[];
 if(!valid)partialSources.add('field_configuration');
 const items=valid?snapshot.events.filter(active).filter(event=>event.boardId===config.databaseId&&(!!config.eventId||!event.parentId)&&(!config.eventId||event.id===config.eventId)).map(event=>{
  const issues:string[]=[],capacityRaw=event[config.capacityKey],capacity=typeof capacityRaw==='number'&&Number.isSafeInteger(capacityRaw)&&capacityRaw>=0?capacityRaw:null;
  if(capacity===null&&capacityRaw!==undefined&&capacityRaw!==null&&capacityRaw!=='')issues.push('capacity_invalid');
  const start=parseDateOnly(event[config.startKey])?String(event[config.startKey]):null;
  if(!start)issues.push('start_date_unavailable');
  const eventLinks:EventRoleLink[]=[];
  for(const [index,role] of EVENT_ROLES.entries()){
   const field=roleFields[index]!,relation=field.relation!,reverse=relation.primary!==true&&!!relation.pairedFieldId,fieldId=reverse?relation.pairedFieldId!:field.id;
   for(const link of snapshot.links){
    if(!active(link)||link.kind!=='relation'||link.fieldId!==fieldId||(reverse?link.toId:link.fromId)!==event.id)continue;
    const personId=reverse?link.fromId:link.toId,person=people.get(personId);
    if(!person||person.boardId!==relation.target){issues.push('person_unavailable');continue;}
    const linkedAt=typeof link.createdAt==='number'&&Number.isSafeInteger(link.createdAt)&&link.createdAt>=0&&link.createdAt<=context.now+60_000?link.createdAt:null;
    eventLinks.push({eventId:event.id,personId,role,linkedAt});
   }
  }
  roleLinks.push(...eventLinks);
  const recent=new Map<string,number|null>();
  for(const link of eventLinks.filter(link=>link.role==='participants'))if(!recent.has(link.personId)||(link.linkedAt??-1)>(recent.get(link.personId)??-1))recent.set(link.personId,link.linkedAt);
  const coverage=roleCoverage({id:event.id,capacity},eventLinks),participantField=roleFields[2]!,peopleDatabaseId=participantField.relation!.target;
  const recentParticipants=[...recent].map(([id,linkedAt])=>{const person=people.get(id)!;return {id,title:label(person.title,'Untitled person'),url:recordHref(String(person.boardId),undefined,id),linkedAt};}).sort((a,b)=>(b.linkedAt??-1)-(a.linkedAt??-1)||(a.id<b.id?-1:a.id>b.id?1:0)).slice(0,20);
  return {id:event.id,title:label(event.title,'Untitled event'),url:recordHref(config.databaseId,undefined,event.id),start,coverage,recentParticipants,recentParticipantsTotal:recent.size,recentParticipantsTruncated:recent.size>20,registrationSource:'participant_relations' as const,formsUrl:boards.has(peopleDatabaseId)?'/forms/'+encodeURIComponent(peopleDatabaseId):null,issues:[...new Set(issues)].sort(),completed:board.templateDbKey==='events'?['done','reviewed'].includes(String(event.status)):isDone(event,board)};
 }):[];
 const undated=items.filter(item=>!item.completed&&!item.start),selected=items.filter(item=>!!config.eventId||!config.upcomingOnly||!item.completed&&!!item.start&&item.start>=context.today).sort((a,b)=>a.start!==b.start?(a.start===null?1:b.start===null?-1:a.start<b.start?-1:1):a.id<b.id?-1:a.id>b.id?1:0);
 if(selected.length>config.limit)partialSources.add('event_selection');
 if(config.upcomingOnly&&!config.eventId&&undated.length)partialSources.add('event_dates');
 const events=selected.slice(0,config.limit),visible=new Set(events.map(event=>event.id)),refs=new Set(roleLinks.filter(link=>visible.has(link.eventId)).map(link=>link.personId));
 return {status:board?(valid?(config.eventId&&!items.length?'event_unavailable' as const:'ready' as const):'configuration_required' as const):'source_unavailable' as const,asOf:context.now,today:context.today,partial:partialSources.size>0||events.some(event=>event.issues.length>0),partialSources:[...partialSources].sort(),events,undatedCount:undated.length,undatedEvents:config.upcomingOnly&&!config.eventId?undated.slice(0,config.limit).map(event=>({id:event.id,title:event.title,url:event.url+'?focusField='+encodeURIComponent(config.startKey)})):[],records:[...people.values()].filter(person=>refs.has(person.id)).map(person=>({id:person.id,title:label(person.title,'Untitled person'),url:recordHref(String(person.boardId),undefined,person.id)})),trust:{untrusted:true as const,instructions:false as const},registrationNote:'Recently linked participants are current relationships, not submission receipts or attendance proof. Links may be entered by the team or a configured registration form.'};
}
export type EventOpsPage=ReturnType<typeof eventOpsPage>;
