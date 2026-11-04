/** Bounded observation/context/attachment metadata. No bodies or file bytes. */
import {Hono} from 'hono';
import {z} from 'zod';
import {requireAuth,type AuthUser,type Env} from './auth';
import {withReadGate} from './readAccess';
import {loadAccessContext} from './access';
import {fieldEvidenceConfigSchema,type FieldEvidenceConfig} from '../shared/fieldEvidenceConfig';
import {fieldEvidencePage,type FieldEvidenceRecord,type FieldEvidenceLink,type FieldEvidenceFile,type FieldEvidencePage} from '../shared/fieldEvidence';
interface Source {bucket:string;id:string;data:string;rev:number}
const live="COALESCE(json_extract(r.data,'$.deleted'),0)!=1 AND COALESCE(json_extract(r.data,'$.archived'),0)!=1";
// ECMAScript trim whitespace, also used by the shared JS normalizer. A SQL
// presence bit avoids copying full Observation text into a dashboard read.
const trimChars='\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const projection="json_patch(json_object('title',CASE WHEN json_type(r.data,'$.title')='text' THEN substr(trim(json_extract(r.data,'$.title'),?4),1,300) END,'boardId',json_extract(r.data,'$.boardId'),'parentId',json_extract(r.data,'$.parentId'),'captureEvidence',CASE WHEN json_type(r.data,'$.captureEvidence')='object' THEN json_object('v',CASE WHEN json_type(r.data,'$.captureEvidence.v') IN('integer','real') THEN json_extract(r.data,'$.captureEvidence.v') END,'photoCount',CASE WHEN json_type(r.data,'$.captureEvidence.photoCount') IN('integer','real') THEN json_extract(r.data,'$.captureEvidence.photoCount') END) WHEN json_type(r.data,'$.captureEvidence') IS NOT NULL AND json_type(r.data,'$.captureEvidence')!='null' THEN json('false') END,'observationPresence',json((SELECT json_group_object(p.key,CASE WHEN p.type='text' AND length(trim(p.value,?4))>0 THEN 1 ELSE 0 END) FROM json_each(r.data) p WHERE p.key IN(SELECT value FROM json_each(?3))))),COALESCE((SELECT json_group_object(p.key,json(CASE p.type WHEN 'text' THEN json_quote(substr(p.value,1,2049)) WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN 'null' WHEN 'object' THEN 'false' WHEN 'array' THEN 'false' ELSE p.value END)) FROM json_each(r.data) p WHERE p.key IN(SELECT value FROM json_each(?2))),'{}'))";
class FieldEvidenceChanged extends Error{constructor(){super('field_evidence_sources_changed');}}
export function fieldEvidenceForOrigin(page:FieldEvidencePage,origin:string):FieldEvidencePage{return {...page,records:page.records.map(r=>({...r,url:origin+r.url})),context:page.context.map(r=>({...r,url:origin+r.url}))};}
export async function collectFieldEvidence(env:Env,userId:string,configs:FieldEvidenceConfig[],now=Date.now()):Promise<FieldEvidencePage[]>{
 env=withReadGate(env,userId);const authority=await loadAccessContext(env.DB,userId,[],undefined,env.CONNECTOR);
 if(!authority.principal||authority.principal.disabledAt!==null||env.CONNECTOR&&authority.connector?.version!==env.CONNECTOR.version)throw new Error('unauthenticated');
 const databaseIds=[...new Set(configs.map(c=>c.databaseId))],keys=[...new Set(configs.flatMap(c=>[c.dateKey,c.measurementKey,c.unitKey,c.photoKey]))],observationKeys=[...new Set(configs.map(c=>c.observationKey))];
 const raw=await env.DB.prepare(`SELECT r.id,r.seq rev FROM records r WHERE r.collection='tasks' AND ${live} AND json_extract(r.data,'$.boardId') IN(SELECT value FROM json_each(?)) AND COALESCE(json_extract(r.data,'$.parentId'),'')='' ORDER BY r.id LIMIT 201`).bind(JSON.stringify(databaseIds)).all<{id:string;rev:number}>();
 const roots=raw.results.slice(0,200),ids=roots.map(r=>r.id);
 const snapshot=await env.DB.prepare(`WITH
 logs AS(SELECT r.id,r.data,r.seq FROM records r WHERE r.collection='tasks' AND ${live} AND r.id IN(SELECT value FROM json_each(?1))),
 rels AS(SELECT r.id,r.data,r.seq FROM records r WHERE r.collection='links' AND ${live} AND json_extract(r.data,'$.kind')='relation' AND (json_extract(r.data,'$.fromId') IN(SELECT id FROM logs) OR json_extract(r.data,'$.toId') IN(SELECT id FROM logs)) ORDER BY r.id LIMIT 1001),
 targets AS(SELECT r.id,r.data,r.seq FROM records r WHERE r.collection='tasks' AND ${live} AND r.id IN(SELECT json_extract(data,'$.fromId') FROM rels UNION SELECT json_extract(data,'$.toId') FROM rels) ORDER BY r.id LIMIT 1001),
 boards AS(SELECT r.id,r.data,r.seq FROM records r WHERE r.collection='boards' AND ${live} AND r.id IN(SELECT value FROM json_each(?5)) ORDER BY r.id LIMIT 101),
 files AS(SELECT r.id,r.data,r.seq FROM records r WHERE r.collection='files' AND ${live} AND json_extract(r.data,'$.parentType')='task' AND json_extract(r.data,'$.parentId') IN(SELECT id FROM logs) ORDER BY r.id LIMIT 401)
 SELECT 'log' bucket,r.id,${projection} data,r.seq rev FROM logs r
 UNION ALL SELECT 'target',id,json_object('title',CASE WHEN json_type(data,'$.title')='text' THEN substr(trim(json_extract(data,'$.title'),?4),1,300) END,'boardId',json_extract(data,'$.boardId')),seq FROM targets
 UNION ALL SELECT 'link',id,json_object('kind','relation','fieldId',json_extract(data,'$.fieldId'),'fromId',json_extract(data,'$.fromId'),'toId',json_extract(data,'$.toId')),seq FROM rels
 UNION ALL SELECT CASE WHEN r.collection='boards' THEN 'board' ELSE 'file' END,r.id,CASE WHEN r.collection='boards' THEN json_object('fields',json_extract(r.data,'$.fields')) ELSE json_object('kind',json_extract(r.data,'$.kind'),'parentId',json_extract(r.data,'$.parentId')) END,r.seq FROM records r WHERE r.id IN(SELECT id FROM boards UNION ALL SELECT id FROM files)
 UNION ALL SELECT 'caps','caps',json_object('relations',(SELECT COUNT(*) FROM rels),'targets',(SELECT COUNT(*) FROM targets),'boards',(SELECT COUNT(*) FROM boards),'files',(SELECT COUNT(*) FROM files)),0`).bind(JSON.stringify(ids),JSON.stringify(keys),JSON.stringify(observationKeys),trimChars,JSON.stringify(databaseIds)).all<Source>();
 const rows=snapshot.results.filter(r=>r.bucket!=='caps'),currentRoots=new Map(rows.filter(r=>r.bucket==='log').map(r=>[r.id,r.rev]));
 if(roots.some(r=>currentRoots.get(r.id)!==r.rev))throw new FieldEvidenceChanged();
 const decision=await env.READ_GATE!.decide(rows.map(r=>r.id));
 if(decision.enabled&&rows.some(r=>decision.readable.has(r.id)&&decision.revs.get(r.id)!==r.rev))throw new FieldEvidenceChanged();
 const allowed=rows.filter(r=>!decision.enabled||decision.readable.has(r.id)),flat=(r:Source):FieldEvidenceRecord=>({...JSON.parse(r.data),id:r.id}),caps=JSON.parse(snapshot.results.find(r=>r.bucket==='caps')!.data) as Record<string,number>;
 const partialSources=Object.entries(caps).filter(([key,n])=>n>(key==='boards'?100:key==='files'?400:1000)).map(([key])=>key);if(raw.results.length>200)partialSources.push('records');
 const observationPresence=new Map<string,Record<string,boolean>>();
 const logs=allowed.filter(r=>r.bucket==='log').map(r=>{const {observationPresence:presence,...data}=flat(r);observationPresence.set(r.id,Object.fromEntries(Object.entries(presence as Record<string,number>).map(([key,value])=>[key,value===1])));return data as FieldEvidenceRecord;});
 const sources={observationPresence,logs,targets:allowed.filter(r=>r.bucket==='target').map(flat),boards:allowed.filter(r=>r.bucket==='board').map(flat),links:allowed.filter(r=>r.bucket==='link').map(r=>{const data:Omit<FieldEvidenceLink,'id'>=JSON.parse(r.data);return {...data,id:r.id};}),files:allowed.filter(r=>r.bucket==='file').map(r=>{const data:Omit<FieldEvidenceFile,'id'>=JSON.parse(r.data);return {...data,id:r.id};}),partialSources};
 if(!await env.READ_GATE!.validateObserved())throw new Error('access_reset_required');
 const current=await loadAccessContext(env.DB,userId,[],undefined,env.CONNECTOR);
 if(!current.principal||current.principal.disabledAt!==null||current.enabled!==authority.enabled||env.CONNECTOR&&current.connector?.version!==env.CONNECTOR.version)throw new Error('access_reset_required');
 return configs.map(config=>fieldEvidencePage(config,sources,now));
}
export const fieldEvidenceApi=new Hono<{Bindings:Env;Variables:{user:AuthUser}}>();
fieldEvidenceApi.onError((error,c)=>{if(error instanceof FieldEvidenceChanged)return c.json({error:error.message},409);throw error;});
fieldEvidenceApi.use('*',requireAuth);
fieldEvidenceApi.post('/',async c=>{
 const raw=await c.req.text();if(raw.length>12_000)return c.json({error:'configuration_too_large'},413);
 let value:unknown;try{value=JSON.parse(raw);}catch{return c.json({error:'invalid_configuration'},400);}
 const parsed=z.array(fieldEvidenceConfigSchema).min(1).max(20).safeParse(value);if(!parsed.success)return c.json({error:'invalid_configuration'},400);
 return c.json({pages:await collectFieldEvidence(c.env,c.get('user').id,parsed.data)});
});
