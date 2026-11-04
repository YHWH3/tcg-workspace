/** Bounded Event/People/relation metadata; no submission payloads or receipts. */
import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {z} from 'zod';
import {requireAuth,type AuthUser,type Env} from './auth';
import {withReadGate} from './readAccess';
import {loadAccessContext} from './access';
import {serverDateContext} from './workspaceSettings';
import {eventOpsConfigSchema,type EventOpsConfig} from '../shared/eventOpsConfig';
import {eventOpsPage,type EventOpsPage,type EventOpsRecord,type EventOpsLink} from '../shared/eventOps';
interface Source {bucket:string;id:string;data:string;rev:number}
const live="COALESCE(json_extract(r.data,'$.deleted'),0)!=1 AND COALESCE(json_extract(r.data,'$.archived'),0)!=1";
const trimChars='\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const projection="json_patch(json_object('title',CASE WHEN json_type(r.data,'$.title')='text' THEN substr(trim(json_extract(r.data,'$.title'),?4),1,300) END,'boardId',json_extract(r.data,'$.boardId'),'parentId',json_extract(r.data,'$.parentId'),'status',json_extract(r.data,'$.status')),COALESCE((SELECT json_group_object(p.key,json(CASE p.type WHEN 'text' THEN json_quote(substr(p.value,1,2049)) WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN 'null' WHEN 'object' THEN 'false' WHEN 'array' THEN 'false' ELSE p.value END)) FROM json_each(r.data) p WHERE p.key IN(SELECT value FROM json_each(?2))),'{}'))";
class EventOpsChanged extends Error{constructor(){super('event_sources_changed');}}
export function eventOpsForOrigin(page:EventOpsPage,origin:string):EventOpsPage{return {...page,events:page.events.map(event=>({...event,url:origin+event.url,formsUrl:event.formsUrl?origin+event.formsUrl:null,recentParticipants:event.recentParticipants.map(person=>({...person,url:origin+person.url}))})),records:page.records.map(record=>({...record,url:origin+record.url})),undatedEvents:page.undatedEvents.map(event=>({...event,url:origin+event.url}))};}
export async function collectEventOps(env:Env,userId:string,configs:EventOpsConfig[],now=Date.now()):Promise<EventOpsPage[]>{
 env=withReadGate(env,userId);const authority=await loadAccessContext(env.DB,userId,[],undefined,env.CONNECTOR);
 if(!authority.principal||authority.principal.disabledAt!==null||env.CONNECTOR&&authority.connector?.version!==env.CONNECTOR.version)throw new Error('unauthenticated');
 const date=await serverDateContext(env,now),databases=[...new Set(configs.map(config=>config.databaseId))],allDatabases=[...new Set(configs.filter(config=>!config.eventId).map(config=>config.databaseId))],ids=[...new Set(configs.flatMap(config=>config.eventId?[config.eventId]:[]))],keys=[...new Set(configs.flatMap(config=>[config.startKey,config.capacityKey]))],roleIds=[...new Set(configs.flatMap(config=>[config.facilitatorsKey,config.volunteersKey,config.participantsKey]).map(key=>key.slice(4)))];
 const raw=await env.DB.prepare(`SELECT r.id,r.seq rev FROM records r WHERE r.collection='tasks' AND ${live} AND (r.id IN(SELECT value FROM json_each(?1)) OR json_extract(r.data,'$.boardId') IN(SELECT value FROM json_each(?2)) AND COALESCE(json_extract(r.data,'$.parentId'),'')='') ORDER BY r.id LIMIT 201`).bind(JSON.stringify(ids),JSON.stringify(allDatabases)).all<{id:string;rev:number}>();
 const roots=raw.results.slice(0,200),eventIds=roots.map(root=>root.id);
 const snapshot=await env.DB.prepare(`WITH
 events AS(SELECT r.id,r.data,r.seq FROM records r WHERE r.collection='tasks' AND ${live} AND r.id IN(SELECT value FROM json_each(?1))),
 rels AS(SELECT r.id,r.data,r.seq FROM records r WHERE r.collection='links' AND ${live} AND json_extract(r.data,'$.kind')='relation' AND (json_extract(r.data,'$.fromId') IN(SELECT id FROM events) OR json_extract(r.data,'$.toId') IN(SELECT id FROM events)) ORDER BY r.id LIMIT 1001),
 people AS(SELECT r.id,r.data,r.seq FROM records r WHERE r.collection='tasks' AND ${live} AND r.id IN(SELECT json_extract(data,'$.fromId') FROM rels UNION SELECT json_extract(data,'$.toId') FROM rels) ORDER BY r.id LIMIT 1001),
 root_boards AS(SELECT r.id,r.data,r.seq FROM records r WHERE r.collection='boards' AND ${live} AND r.id IN(SELECT value FROM json_each(?3))),
 boards AS(SELECT r.id,r.data,r.seq FROM records r WHERE r.collection='boards' AND ${live} AND r.id IN(SELECT id FROM root_boards UNION SELECT json_extract(f.value,'$.relation.target') FROM root_boards b,json_each(json_extract(b.data,'$.fields')) f WHERE json_extract(f.value,'$.id') IN(SELECT value FROM json_each(?5))) ORDER BY r.id LIMIT 101)
 SELECT 'event' bucket,r.id,${projection} data,r.seq rev FROM events r
 UNION ALL SELECT 'link',id,json_object('kind','relation','fieldId',json_extract(data,'$.fieldId'),'fromId',json_extract(data,'$.fromId'),'toId',json_extract(data,'$.toId'),'createdAt',CASE WHEN json_type(data,'$.createdAt') IN('integer','real') THEN json_extract(data,'$.createdAt') END),seq FROM rels
 UNION ALL SELECT 'person',id,json_object('title',CASE WHEN json_type(data,'$.title')='text' THEN substr(trim(json_extract(data,'$.title'),?4),1,300) END,'boardId',json_extract(data,'$.boardId')),seq FROM people
 UNION ALL SELECT 'board',id,json_object('fields',json_extract(data,'$.fields'),'columns',json_extract(data,'$.columns'),'templateDbKey',json_extract(data,'$.templateDbKey')),seq FROM boards
 UNION ALL SELECT 'caps','caps',json_object('relations',(SELECT COUNT(*) FROM rels),'people',(SELECT COUNT(*) FROM people),'boards',(SELECT COUNT(*) FROM boards)),0`).bind(JSON.stringify(eventIds),JSON.stringify(keys),JSON.stringify(databases),trimChars,JSON.stringify(roleIds)).all<Source>();
 const rows=snapshot.results.filter(row=>row.bucket!=='caps'),currentRoots=new Map(rows.filter(row=>row.bucket==='event').map(row=>[row.id,row.rev]));
 if(roots.some(root=>currentRoots.get(root.id)!==root.rev))throw new EventOpsChanged();
 const decision=await env.READ_GATE!.decide(rows.map(row=>row.id));
 if(decision.enabled&&rows.some(row=>decision.readable.has(row.id)&&decision.revs.get(row.id)!==row.rev))throw new EventOpsChanged();
 const allowed=rows.filter(row=>!decision.enabled||decision.readable.has(row.id)),flat=(row:Source):EventOpsRecord=>({...JSON.parse(row.data),id:row.id}),caps=JSON.parse(snapshot.results.find(row=>row.bucket==='caps')!.data) as Record<string,number>;
 const partialSources=Object.entries(caps).filter(([key,count])=>count>(key==='boards'?100:1000)).map(([key])=>key);if(raw.results.length>200)partialSources.push('events');
 const sources={events:allowed.filter(row=>row.bucket==='event').map(flat),people:allowed.filter(row=>row.bucket==='person').map(flat),boards:allowed.filter(row=>row.bucket==='board').map(flat),links:allowed.filter(row=>row.bucket==='link').map(row=>{const data:Omit<EventOpsLink,'id'>=JSON.parse(row.data);return {...data,id:row.id};}),partialSources};
 if(!await env.READ_GATE!.validateObserved())throw new Error('access_reset_required');
 const current=await loadAccessContext(env.DB,userId,[],undefined,env.CONNECTOR);
 if(!current.principal||current.principal.disabledAt!==null||current.enabled!==authority.enabled||env.CONNECTOR&&current.connector?.version!==env.CONNECTOR.version)throw new Error('access_reset_required');
 return configs.map(config=>eventOpsPage(config,sources,{today:date.today,now}));
}
export const eventOpsApi=new Hono<{Bindings:Env;Variables:{user:AuthUser}}>();
eventOpsApi.onError((error,c)=>{if(error instanceof EventOpsChanged)return c.json({error:error.message},409);throw error;});
eventOpsApi.use('*',requireAuth);
eventOpsApi.use('*',bodyLimit({maxSize:12_000,onError:c=>c.json({error:'configuration_too_large'},413)}));
eventOpsApi.post('/',async c=>{
 let value:unknown;try{value=await c.req.json();}catch{return c.json({error:'invalid_configuration'},400);}
 const parsed=z.array(eventOpsConfigSchema).min(1).max(20).safeParse(value);if(!parsed.success)return c.json({error:'invalid_configuration'},400);
 return c.json({pages:await collectEventOps(c.env,c.get('user').id,parsed.data)});
});
