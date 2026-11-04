/** Bounded money metadata only; no notes, bodies or attachment bytes. */
import {Hono} from 'hono';
import {z} from 'zod';
import {requireAuth,type AuthUser,type Env} from './auth';
import {withReadGate} from './readAccess';
import {loadAccessContext} from './access';
import {serverDateContext} from './workspaceSettings';
import {financeConfigSchema,type FinanceConfig} from '../shared/financeConfig';
import {financePage,type FinancePage} from '../shared/financePage';
import type {FinanceRecord,FinanceLink} from '../shared/finance';
interface Source {bucket:string;id:string;data:string;rev:number}
const live="COALESCE(json_extract(r.data,'$.deleted'),0)!=1 AND COALESCE(json_extract(r.data,'$.archived'),0)!=1";
const projection="json_patch(json_object('deleted',json_extract(r.data,'$.deleted'),'archived',json_extract(r.data,'$.archived'),'title',substr(json_extract(r.data,'$.title'),1,300),'boardId',json_extract(r.data,'$.boardId'),'parentId',json_extract(r.data,'$.parentId'),'status',json_extract(r.data,'$.status'),'assigneeId',json_extract(r.data,'$.assigneeId'),'dueDate',json_extract(r.data,'$.dueDate'),'createdAt',json_extract(r.data,'$.createdAt'),'createdBy',json_extract(r.data,'$.createdBy')),COALESCE((SELECT json_group_object(p.key,p.value) FROM json_each(r.data) p WHERE p.key IN(SELECT value FROM json_each(?2))),'{}'))";
class FinanceSourceChanged extends Error{constructor(){super('finance_sources_changed');}}
export function financeForOrigin(page:FinancePage,origin:string):FinancePage{return {...page,items:page.items.map(r=>({...r,url:origin+r.url})),records:page.records.map(r=>({...r,url:origin+r.url}))};}
export async function collectFinance(env:Env,userId:string,configs:FinanceConfig[],now=Date.now()):Promise<FinancePage[]> {
 env=withReadGate(env,userId);const authority=await loadAccessContext(env.DB,userId,[],undefined,env.CONNECTOR);
 if(!authority.principal||authority.principal.disabledAt!==null||env.CONNECTOR&&authority.connector?.version!==env.CONNECTOR.version)throw new Error('unauthenticated');
 const date=await serverDateContext(env,now),databaseIds=[...new Set(configs.flatMap(c=>c.databaseId?[c.databaseId]:[]))],ids=[...new Set(configs.flatMap(c=>c.recordId?[c.recordId]:[]))];
 if(ids.includes('self'))throw new Error('record_context_required');
 const keys=[...new Set(configs.flatMap(c=>[c.budgetKey,c.amountKey,c.typeKey,c.priceKey,c.costKey,...(c.filters??[]).map(f=>f.key)]))];
 const raw=await env.DB.prepare(`SELECT 'root' bucket,r.id,${projection} data,r.seq rev FROM records r WHERE r.collection='tasks' AND ${live} AND (r.id IN(SELECT value FROM json_each(?1)) OR json_extract(r.data,'$.boardId') IN(SELECT value FROM json_each(?3)) AND COALESCE(json_extract(r.data,'$.parentId'),'')='') ORDER BY r.id LIMIT 201`).bind(JSON.stringify(ids),JSON.stringify(keys),JSON.stringify(databaseIds)).all<Source>();
 const roots=raw.results.slice(0,200),rootIds=roots.map(r=>r.id);
 const snapshot=await env.DB.prepare(`WITH
 rels AS(SELECT r.id,r.data,r.seq FROM records r WHERE r.collection='links' AND ${live} AND json_extract(r.data,'$.kind')='relation' AND (json_extract(r.data,'$.fromId') IN(SELECT value FROM json_each(?1)) OR json_extract(r.data,'$.toId') IN(SELECT value FROM json_each(?1))) ORDER BY r.id LIMIT 1001),
 sources AS(SELECT r.id,r.data,r.seq FROM records r WHERE r.collection='tasks' AND r.id IN(SELECT value FROM json_each(?1) UNION SELECT json_extract(data,'$.fromId') FROM rels UNION SELECT json_extract(data,'$.toId') FROM rels) ORDER BY CASE WHEN r.id IN(SELECT value FROM json_each(?1)) THEN 0 ELSE 1 END,r.id LIMIT 1201),
 root_boards AS(SELECT r.id,r.data,r.seq FROM records r WHERE r.collection='boards' AND ${live} AND r.id IN(SELECT value FROM json_each(?3) UNION SELECT json_extract(data,'$.boardId') FROM sources) ORDER BY r.id LIMIT 101),
 boards AS(SELECT r.id,r.data,r.seq FROM records r WHERE r.collection='boards' AND ${live} AND r.id IN(SELECT id FROM root_boards UNION SELECT json_extract(f.value,'$.relation.target') FROM root_boards b,json_each(json_extract(b.data,'$.fields')) f WHERE json_extract(f.value,'$.type')='relation') ORDER BY r.id LIMIT 101)
 SELECT 'record' bucket,r.id,${projection} data,r.seq rev FROM sources r
 UNION ALL SELECT 'link',id,json_object('kind','relation','fieldId',json_extract(data,'$.fieldId'),'fromId',json_extract(data,'$.fromId'),'toId',json_extract(data,'$.toId')),seq FROM rels
 UNION ALL SELECT 'board',id,json_object('name',substr(json_extract(data,'$.name'),1,300),'fields',json_extract(data,'$.fields')),seq FROM boards
 UNION ALL SELECT 'caps','caps',json_object('relations',(SELECT COUNT(*) FROM rels),'records',(SELECT COUNT(*) FROM sources),'root_boards',(SELECT COUNT(*) FROM root_boards),'boards',(SELECT COUNT(*) FROM boards)),0`).bind(JSON.stringify(rootIds),JSON.stringify(keys),JSON.stringify(databaseIds)).all<Source>();
 const caps=JSON.parse(snapshot.results.find(r=>r.bucket==='caps')!.data) as Record<string,number>;
 const currentRoots=new Map(snapshot.results.filter(r=>r.bucket==='record').map(r=>[r.id,r.rev]));
 if(roots.some(r=>currentRoots.get(r.id)!==r.rev))throw new FinanceSourceChanged();
 const rows=[...roots,...snapshot.results.filter(r=>r.bucket!=='caps')],decision=await env.READ_GATE!.decide(rows.map(r=>r.id));
 if(decision.enabled&&rows.some(r=>decision.readable.has(r.id)&&decision.revs.get(r.id)!==r.rev))throw new FinanceSourceChanged();
 const allowed=rows.filter(r=>!decision.enabled||decision.readable.has(r.id)),flat=(r:Source):FinanceRecord=>({...JSON.parse(r.data),id:r.id});
 const partialSources=Object.entries(caps).filter(([k,v])=>v>(k==='records'?1200:k==='relations'?1000:100)).map(([k])=>k);
 if(raw.results.length>200)partialSources.push('record_selection');
 // The gate redacts denied sources. Expose no private count or identity; totals
 // describe the caller's accessible set. Dangling authorized links remain partial.
 const allowedSnapshot={roots:allowed.filter(r=>r.bucket==='root').map(flat),records:allowed.filter(r=>r.bucket==='record').map(flat),boards:allowed.filter(r=>r.bucket==='board').map(flat),links:allowed.filter(r=>r.bucket==='link').map(r=>{const data:Omit<FinanceLink,'id'>=JSON.parse(r.data);return {...data,id:r.id};}),partialSources};
 if(!await env.READ_GATE!.validateObserved())throw new Error('access_reset_required');
 const current=await loadAccessContext(env.DB,userId,[],undefined,env.CONNECTOR);
 if(!current.principal||current.principal.disabledAt!==null||current.enabled!==authority.enabled||env.CONNECTOR&&current.connector?.version!==env.CONNECTOR.version)throw new Error('access_reset_required');
 return configs.map(config=>financePage(config,allowedSnapshot,{userId,today:date.today,timeZone:date.timeZone,currency:date.currency,now}));
}
export const financeApi=new Hono<{Bindings:Env;Variables:{user:AuthUser}}>();
financeApi.onError((error,c)=>{if(error instanceof FinanceSourceChanged)return c.json({error:error.message},409);throw error;});
financeApi.use('*',requireAuth);
financeApi.post('/',async c=>{
 const raw=await c.req.text();if(raw.length>12_000)return c.json({error:'configuration_too_large'},413);
 let value:unknown;try{value=JSON.parse(raw);}catch{return c.json({error:'invalid_configuration'},400);}
 const parsed=z.array(financeConfigSchema).min(1).max(20).safeParse(value);if(!parsed.success)return c.json({error:'invalid_configuration'},400);
 if(parsed.data.some(c=>c.recordId==='self'))return c.json({error:'record_context_required'},400);
 return c.json({pages:await collectFinance(c.env,c.get('user').id,parsed.data)});
});
