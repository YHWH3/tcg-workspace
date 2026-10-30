import {afterEach,describe,it,expect,vi} from 'vitest';
const handlers=vi.hoisted(()=>new Map<string,(a:unknown)=>Promise<{content:{text:string}[];isError?:boolean}>>());
vi.mock('@modelcontextprotocol/server',()=>({McpServer:class{registerTool(name:string,_meta:unknown,handler:(a:unknown)=>Promise<{content:{text:string}[]}>){handlers.set(name,handler);}registerPrompt(){}registerResource(){}},ResourceTemplate:class{}}));
vi.mock('agents/mcp/server',()=>({createMcpHandler:vi.fn()}));
import {createWorkspaceServer} from '../worker/mcp';
import {openAuditFixture,type AuditFixture} from './audit-fixture';
import {applyChanges} from '../worker/sync';
import {withD1Budget,d1BudgetRemaining} from '../worker/d1budget';
import {withWorkspaceContext} from '../worker/workspaceSettings';
import {collectFieldEvidence,fieldEvidenceApi} from '../worker/fieldEvidence';
import {fieldEvidenceConfigSchema} from '../shared/fieldEvidenceConfig';
let f:AuditFixture;const now=Date.parse('2026-10-29T12:00Z');
afterEach(async()=>{vi.restoreAllMocks();await f?.dispose();handlers.clear();});
const cfg=()=>fieldEvidenceConfigSchema.parse({databaseId:'logs'});
const fields=[{id:'f_date',name:'Date',type:'date'},{id:'f_measurement',name:'Measurement',type:'number'},{id:'f_unit',name:'Unit',type:'text'},{id:'f_observation',name:'Observation',type:'text'},{id:'f_photos',name:'Photos',type:'url'},...['place','experiment','project'].map(k=>({id:'f_'+k,name:k,type:'relation',relation:{target:k,primary:true}}))];
async function call(args:Record<string,unknown>){
 const env=withWorkspaceContext(withD1Budget(f.env));createWorkspaceServer({env,ectx:f.ctx,userId:'alice',userRole:'admin',origin:'https://workspace.test',userByKey:new Map(),userNameById:new Map(),pageTitleById:new Map(),recordTitleById:new Map(),recordIdByTitle:new Map(),cachesReady:false,warnings:[],cs:null,toolName:''} as never);
 const result=await handlers.get('dashboard_snapshot')!(args);return {data:JSON.parse(result.content[0].text),error:result.isError,used:45-d1BudgetRemaining(env.DB)};
}
async function seed(enabled:boolean){
 vi.spyOn(Date,'now').mockReturnValue(now);f=await openAuditFixture();
 const rows=[{id:'logs',collection:'boards',patch:{name:'Field Log',kind:'records',fields}},...['place','experiment','project'].map(k=>({id:k,collection:'boards',patch:{name:k,kind:'records',fields:[]}})),
 {id:'place1',collection:'tasks',patch:{boardId:'place',title:'Authorized place'}},{id:'experiment1',collection:'tasks',patch:{boardId:'experiment',title:'Authorized experiment'}},
 {id:'observation',collection:'tasks',patch:{boardId:'logs',title:'Synthetic observation',p_f_date:'2026-10-29',p_f_measurement:0,p_f_unit:' kg ',p_f_observation:'NEVER_COPY_FULL_OBSERVATION',description:'NEVER_COPY_BODY',captureEvidence:{v:1,photoCount:1}}},
 ...['place','experiment'].map(k=>({id:'link-'+k,collection:'links',patch:{kind:'relation',fieldId:'f_'+k,fromType:'record',toType:'record',fromId:'observation',toId:k+'1'}})),
 {id:'review',collection:'pages',patch:{title:'Field review'}},...['fieldsessions','measurechart'].map((type,i)=>({id:type,collection:'blocks',patch:{pageId:'review',databaseId:'logs',type,order:'a'+i}})),
 ];
 expect((await applyChanges(f.env,'alice',rows.map(r=>({...r,ts:now})),{serverTs:true})).rejected).toBe(0);await f.db.prepare('UPDATE access_state SET enabled=? WHERE id=1').bind(enabled?1:0).run();
}
for(const enabled of [false,true])describe(`field evidence actualD1 permissions ${enabled?'ENABLED':'DISABLED'}`,()=>{
 it('reads scoped metadata with exact grouping/series and no observation/body copies',async()=>{
  await seed(enabled);const env=withWorkspaceContext(withD1Budget(f.env)),[page]=await collectFieldEvidence(env,'alice',[cfg()],now);
  expect(page).toMatchObject({status:'ready',partial:false,records:[{measurement:0,unit:'kg',missing:['photo'],photoEvidence:'unavailable'}],sessions:[{recordIds:['observation'],missingCount:1}],series:{points:[{recordId:'observation',value:0}]}});
  expect(JSON.stringify(page)).not.toMatch(/NEVER_COPY/);expect(45-d1BudgetRemaining(env.DB)).toBeLessThanOrEqual(25);
 });
 it('keeps HTTP/MCP calculations identical with source-linked absolute MCP urls',async()=>{
  await seed(enabled);const [direct]=await collectFieldEvidence(withWorkspaceContext(withD1Budget(f.env)),'alice',[cfg()],now),result=await call({pageId:'review'});
  expect(result.error,JSON.stringify(result.data)).not.toBe(true);expect(result.used).toBeLessThanOrEqual(45);
  expect(result.data.blocks).toHaveLength(2);for(const block of result.data.blocks){expect(block.series).toEqual(direct.series);expect(block.sessions).toEqual(direct.sessions);expect(block.records[0].url).toBe('https://workspace.test/boards/logs/tasks/observation');}
  const response=await fieldEvidenceApi.request('https://local.test/',{method:'POST',headers:f.auth('alice'),body:JSON.stringify([cfg()])},withWorkspaceContext(withD1Budget(f.env)));expect(response.status).toBe(200);expect((await response.json() as {pages:unknown[]}).pages).toEqual([direct]);
 });
 it('uses attachment metadata without reading bytes and respects removal',async()=>{
  await seed(enabled);await applyChanges(f.env,'alice',[{id:'photo',collection:'files',patch:{parentId:'observation',parentType:'task',kind:'image',name:'Synthetic photo',mime:'image/png',size:10},ts:now}],{serverTs:true});
  const read=()=>collectFieldEvidence(withWorkspaceContext(withD1Budget(f.env)),'alice',[cfg()],now);
  expect((await read())[0].records[0]).toMatchObject({photoEvidence:'available',missing:[]});
  await applyChanges(f.env,'alice',[{id:'photo',collection:'files',patch:{deleted:true},ts:now}],{serverTs:true});expect((await read())[0].records[0]).toMatchObject({photoEvidence:'unavailable',missing:['photo']});
 });
 it('preserves unknown historical intent and treats only actual Observation text as present',async()=>{
  await seed(enabled);await applyChanges(f.env,'alice',[{id:'observation',collection:'tasks',patch:{captureEvidence:null,p_f_observation:'\u00a0\ufeff\u2002\n'},ts:now}],{serverTs:true});
  let [page]=await collectFieldEvidence(withWorkspaceContext(withD1Budget(f.env)),'alice',[cfg()],now);expect(page.records[0]).toMatchObject({photoIntent:'unknown',photoEvidence:'unknown',missing:['observation'],issues:[]});
  await applyChanges(f.env,'alice',[{id:'observation',collection:'tasks',patch:{p_f_observation:' '.repeat(5000)+'Actual text'},ts:now}],{serverTs:true});
  [page]=await collectFieldEvidence(withWorkspaceContext(withD1Budget(f.env)),'alice',[cfg()],now);expect(page.records[0].missing).not.toContain('observation');expect(JSON.stringify(page)).not.toContain('Actual text');
 });
 it('preserves typed invalid values and bounds oversized units/URLs',async()=>{
  await seed(enabled);await applyChanges(f.env,'alice',[{id:'observation',collection:'tasks',patch:{p_f_measurement:true,p_f_unit:' '.repeat(3000)+'kg',p_f_photos:'https://example.org/'+'x'.repeat(3000),captureEvidence:{v:true,photoCount:true}},ts:now}],{serverTs:true});
  const [page]=await collectFieldEvidence(withWorkspaceContext(withD1Budget(f.env)),'alice',[cfg()],now);expect(page.records[0]).toMatchObject({measurement:null,unit:'',photoEvidence:'unknown',issues:['capture_provenance_invalid','measurement_invalid','photo_link_invalid','unit_invalid']});
 });
 it('does not replace a unit field when another config uses it as an observation field',async()=>{
  await seed(enabled);const pages=await collectFieldEvidence(withWorkspaceContext(withD1Budget(f.env)),'alice',[cfg(),{...cfg(),observationKey:'p_f_unit'}],now);expect(pages.map(p=>p.records[0].unit)).toEqual(['kg','kg']);expect(pages.map(p=>p.records[0].missing)).toEqual([['photo'],['photo']]);
 });
 it('reports mixed units and respects explicit unit/context selections',async()=>{
  await seed(enabled);await applyChanges(f.env,'alice',[{id:'second',collection:'tasks',patch:{boardId:'logs',p_f_date:'2026-10-28',p_f_unit:'cm',p_f_measurement:-1,p_f_observation:'Other source'},ts:now}],{serverTs:true});
  const [mixed,selected,empty]=await collectFieldEvidence(withWorkspaceContext(withD1Budget(f.env)),'alice',[cfg(),{...cfg(),unit:'kg'},{...cfg(),placeId:'missing'}],now);expect(mixed.series).toMatchObject({error:'mixed_units',points:[]});expect(selected.series).toMatchObject({unit:'kg',points:[{recordId:'observation'}],excludedByUnit:1});expect(empty.records).toEqual([]);
 });
 it('keeps binding calls flat as the number of observations increases',async()=>{
  await seed(enabled);await applyChanges(f.env,'alice',Array.from({length:49},(_,i)=>({id:'log'+i,collection:'tasks',patch:{boardId:'logs',p_f_date:'2026-10-29',p_f_measurement:i,p_f_unit:'kg',p_f_observation:'Source'},ts:now})),{serverTs:true});
  const env=withWorkspaceContext(withD1Budget(f.env)),[page]=await collectFieldEvidence(env,'alice',[cfg()],now);expect(page.records).toHaveLength(50);expect(45-d1BudgetRemaining(env.DB)).toBeLessThanOrEqual(25);
 });
});
it('redacts private source metadata and refuses disabled principals',async()=>{
 await seed(true);await f.db.batch([f.db.prepare("UPDATE spaces SET default_access='private' WHERE id='space-core'"),f.db.prepare("INSERT OR REPLACE INTO space_members(space_id,user_id,role) VALUES('space-core','alice','owner')")]);
 const [page]=await collectFieldEvidence(withWorkspaceContext(withD1Budget(f.env)),'bob',[cfg()],now);expect(page).toMatchObject({status:'source_unavailable',records:[],sessions:[],context:[]});expect(JSON.stringify(page)).not.toContain('Synthetic observation');
 await f.db.prepare("UPDATE users SET disabled_at=? WHERE id='alice'").bind(now).run();await expect(collectFieldEvidence(withWorkspaceContext(withD1Budget(f.env)),'alice',[cfg()],now)).rejects.toThrow('unauthenticated');
});
for(const enabled of [false,true])it(`refuses a source revision changed during collection, permissions ${enabled}`,async()=>{
 await seed(enabled);let changed=false;
 const wrap=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(statement,{get(target,key){
  if(key==='bind')return(...values:Parameters<D1PreparedStatement['bind']>)=>wrap(target.bind(...values),sql);
  if(key==='all')return async()=>{const result=await target.all();if(!changed&&sql.includes('SELECT r.id,r.seq rev')){changed=true;await applyChanges(f.env,'alice',[{id:'observation',collection:'tasks',patch:{p_f_measurement:42},ts:now}],{serverTs:true});}return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 const database=new Proxy(f.db,{get(target,key){if(key==='prepare')return(sql:string)=>wrap(target.prepare(sql),sql);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const response=await fieldEvidenceApi.request('https://local.test/',{method:'POST',headers:f.auth('alice'),body:JSON.stringify([cfg()])},withWorkspaceContext(withD1Budget({...f.env,DB:database})));expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'field_evidence_sources_changed'});expect(changed).toBe(true);
});
it('rejects invalid/oversized/unauthenticated HTTP configurations at the boundary',async()=>{
 await seed(false);const req=(body:string,auth=true)=>fieldEvidenceApi.request('https://local.test/',{method:'POST',headers:auth?f.auth('alice'):{},body},withWorkspaceContext(withD1Budget(f.env)));
 expect((await req(JSON.stringify([cfg()]))).status).toBe(200);expect((await req('[]',false)).status).toBe(401);expect((await req('{')).status).toBe(400);expect((await req('[]')).status).toBe(400);expect((await req(JSON.stringify([{databaseId:'logs',limit:51}]))).status).toBe(400);expect((await req(' '.repeat(12001))).status).toBe(413);
});
it('reports bounded candidates instead of claiming a complete workspace set',async()=>{
 await seed(false);await applyChanges(f.env,'alice',Array.from({length:205},(_,i)=>({id:'log'+String(i).padStart(3,'0'),collection:'tasks',patch:{boardId:'logs',p_f_date:'2026-10-29',p_f_unit:'kg',p_f_measurement:i,p_f_observation:'Source'},ts:now})),{serverTs:true});
 const [page]=await collectFieldEvidence(withWorkspaceContext(withD1Budget(f.env)),'alice',[cfg()],now);expect(page.records).toHaveLength(200);expect(page.partial).toBe(true);expect(page.partialSources).toContain('records');expect(page.series.points).toHaveLength(200);
});
it('trims and bounds Unicode titles without copying long observations',async()=>{
 await seed(false);const title=' '.repeat(400)+'👩🏽‍💻'.repeat(200);await applyChanges(f.env,'alice',[{id:'observation',collection:'tasks',patch:{title,p_f_observation:'\ufeff'.repeat(3000)+'NEVER_COPY_FULL_OBSERVATION'},ts:now}],{serverTs:true});
 const [page]=await collectFieldEvidence(withWorkspaceContext(withD1Budget(f.env)),'alice',[cfg()],now);expect(page.records[0].title).toBe(Array.from(title.trim()).slice(0,300).join(''));expect(page.records[0].missing).not.toContain('observation');expect(JSON.stringify(page)).not.toContain('NEVER_COPY');
});
it('refuses authority revoked during source collection',async()=>{
 await seed(true);let changed=false;
 const wrap=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(statement,{get(target,key){
  if(key==='bind')return(...values:Parameters<D1PreparedStatement['bind']>)=>wrap(target.bind(...values),sql);
  if(key==='all')return async()=>{const result=await target.all();if(!changed&&sql.includes("SELECT 'log' bucket")){changed=true;await f.db.prepare("UPDATE users SET disabled_at=? WHERE id='alice'").bind(now).run();}return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 const database=new Proxy(f.db,{get(target,key){if(key==='prepare')return(sql:string)=>wrap(target.prepare(sql),sql);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 await expect(collectFieldEvidence(withWorkspaceContext(withD1Budget({...f.env,DB:database})),'alice',[cfg()],now)).rejects.toThrow();expect(changed).toBe(true);
});

it('normalizes object/array field corruption without expanding it or failing the read',async()=>{
 await seed(false);for(const value of [{nested:'UNTRUSTED'},['UNTRUSTED']]){
  await applyChanges(f.env,'alice',[{id:'observation',collection:'tasks',patch:{p_f_measurement:value,p_f_unit:value,p_f_photos:value},ts:now}],{serverTs:true});
  const [page]=await collectFieldEvidence(withWorkspaceContext(withD1Budget(f.env)),'alice',[cfg()],now);expect(page.records[0].measurement).toBe(null);expect(page.records[0].unit).toBe('');expect(page.records[0].issues).toContain('measurement_invalid');expect(JSON.stringify(page)).not.toContain('UNTRUSTED');
 }
});
