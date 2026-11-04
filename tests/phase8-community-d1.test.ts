import {it,describe,expect,afterEach,vi} from 'vitest';
const handlers=vi.hoisted(()=>new Map<string,(args:unknown)=>Promise<{content:{text:string}[];isError?:boolean}>>());
vi.mock('@modelcontextprotocol/server',()=>({McpServer:class{registerTool(name:string,_meta:unknown,handler:(args:unknown)=>Promise<{content:{text:string}[]}>){handlers.set(name,handler);}registerPrompt(){}registerResource(){}},ResourceTemplate:class{}}));
vi.mock('agents/mcp/server',()=>({createMcpHandler:vi.fn()}));
import {createWorkspaceServer} from '../worker/mcp';
import {openAuditFixture,type AuditFixture} from './audit-fixture';
import {applyChanges} from '../worker/sync';
import {collectEventOps,eventOpsApi} from '../worker/eventOps';
import {withD1Budget,d1BudgetRemaining} from '../worker/d1budget';
import {withWorkspaceContext} from '../worker/workspaceSettings';
import {eventOpsConfigSchema} from '../shared/eventOpsConfig';
let fixture:AuditFixture;const now=Date.parse('2026-10-31T12:00Z'),config=eventOpsConfigSchema.parse({databaseId:'events'});
const fields=[{id:'f_start',name:'Start date',type:'date'},{id:'f_capacity',name:'Capacity',type:'number'},...['facilitators','volunteers','participants'].map(role=>({id:'f_'+role,name:role,type:'relation',relation:{target:'people',primary:true}}))];
afterEach(async()=>{vi.restoreAllMocks();handlers.clear();await fixture?.dispose();});
async function seed(enabled:boolean){
 vi.spyOn(Date,'now').mockReturnValue(now);fixture=await openAuditFixture();
 const changes=[{id:'events',collection:'boards',patch:{name:'Events',kind:'records',templateDbKey:'events',fields}},
 {id:'people',collection:'boards',patch:{name:'People',kind:'records',fields:[]}},
 {id:'event1',collection:'tasks',patch:{boardId:'events',title:'Synthetic event',p_f_start:'2026-11-01',p_f_capacity:0,description:'NEVER_COPY_EVENT_BODY'}},
 {id:'person1',collection:'tasks',patch:{boardId:'people',title:'Synthetic participant',description:'NEVER_COPY_BIOGRAPHY',p_email:'NEVER_COPY_EMAIL'}},
 {id:'participants1',collection:'links',patch:{kind:'relation',fieldId:'f_participants',fromType:'record',toType:'record',fromId:'event1',toId:'person1',createdAt:now-1000}}];
 expect((await applyChanges(fixture.env,'alice',changes.map(change=>({...change,ts:now})),{serverTs:true})).rejected).toBe(0);await fixture.db.prepare('UPDATE access_state SET enabled=? WHERE id=1').bind(enabled?1:0).run();
}
const read=()=>collectEventOps(withWorkspaceContext(withD1Budget(fixture.env)),'alice',[config],now);
for(const enabled of [false,true])describe(`community actual D1 permissions ${enabled?'ENABLED':'DISABLED'}`,()=>{
 it('keeps MCP and browser counts identical and links authorized sources within the request budget',async()=>{
  await seed(enabled);await applyChanges(fixture.env,'alice',[{id:'review',collection:'pages',patch:{title:'Event desk'},ts:now},{id:'roles',collection:'blocks',patch:{pageId:'review',type:'eventops',databaseId:'events',order:'a0'},ts:now}],{serverTs:true});
  const env=withWorkspaceContext(withD1Budget(fixture.env));createWorkspaceServer({env,ectx:fixture.ctx,userId:'alice',userRole:'admin',origin:'https://workspace.test',userByKey:new Map(),userNameById:new Map(),pageTitleById:new Map(),recordTitleById:new Map(),recordIdByTitle:new Map(),cachesReady:false,warnings:[],cs:null,toolName:''} as never);
  const result=await handlers.get('dashboard_snapshot')!({pageId:'review'}),data=JSON.parse(result.content[0].text),direct=(await read())[0];
  expect(result.isError,JSON.stringify(data)).not.toBe(true);expect(data.blocks[0]).toMatchObject({status:'ready',events:[{coverage:direct.events[0].coverage,url:'https://workspace.test/boards/events/tasks/event1',formsUrl:'https://workspace.test/forms/people',recentParticipants:[{url:'https://workspace.test/boards/people/tasks/person1'}]}]});expect(data.truncated).toBe(false);expect(45-d1BudgetRemaining(env.DB)).toBeLessThanOrEqual(45);
 });
 it('counts readable current relationships without reading form payloads or biographies',async()=>{
  await seed(enabled);const env=withWorkspaceContext(withD1Budget(fixture.env)),[page]=await collectEventOps(env,'alice',[config],now);
  expect(page).toMatchObject({status:'ready',partial:false,events:[{coverage:{participants:1,capacity:0,remaining:-1,overCapacity:true},formsUrl:'/forms/people',registrationSource:'participant_relations',recentParticipants:[{id:'person1',linkedAt:now-1000}]}]});expect(JSON.stringify(page)).not.toContain('NEVER_COPY');expect(45-d1BudgetRemaining(env.DB)).toBeLessThanOrEqual(30);
  const response=await eventOpsApi.request('https://local.test/',{method:'POST',headers:fixture.auth('alice'),body:JSON.stringify([config])},withWorkspaceContext(withD1Budget(fixture.env)));expect(response.status).toBe(200);expect((await response.json() as {pages:unknown[]}).pages).toEqual([page]);
 });
 it('reflects participant removal and restoration without resurrecting a deleted person',async()=>{
  await seed(enabled);await applyChanges(fixture.env,'alice',[{id:'person1',collection:'tasks',patch:{deleted:true},ts:now}],{serverTs:true});expect((await read())[0].events[0].coverage.participants).toBe(0);
  await applyChanges(fixture.env,'alice',[{id:'person1',collection:'tasks',patch:{deleted:false},ts:now}],{serverTs:true});expect((await read())[0].events[0].coverage.participants).toBe(1);
  await applyChanges(fixture.env,'alice',[{id:'participants1',collection:'links',patch:{deleted:true},ts:now}],{serverTs:true});expect((await read())[0].events[0].coverage.participants).toBe(0);
 });
 it('keeps invalid JSON scalar types invalid and never treats true as capacity one or timestamp one',async()=>{
  await seed(enabled);await applyChanges(fixture.env,'alice',[{id:'event1',collection:'tasks',patch:{p_f_capacity:true},ts:now},{id:'participants1',collection:'links',patch:{createdAt:true},ts:now}],{serverTs:true});const [page]=await read();expect(page.events[0]).toMatchObject({coverage:{capacity:null,participants:1},recentParticipants:[{linkedAt:null}],issues:['capacity_invalid']});
 });
 it('keeps binding calls bounded when the participant list grows',async()=>{
  await seed(enabled);let env=withWorkspaceContext(withD1Budget(fixture.env));await collectEventOps(env,'alice',[config],now);const initial=45-d1BudgetRemaining(env.DB);
  await applyChanges(fixture.env,'alice',Array.from({length:49},(_,index)=>[{id:'p'+index,collection:'tasks',patch:{boardId:'people',title:'Synthetic participant '+index},ts:now},{id:'link'+index,collection:'links',patch:{kind:'relation',fieldId:'f_participants',fromType:'record',toType:'record',fromId:'event1',toId:'p'+index,createdAt:now-index},ts:now}]).flat(),{serverTs:true});
  env=withWorkspaceContext(withD1Budget(fixture.env));const [page]=await collectEventOps(env,'alice',[config],now);expect(page.events[0]).toMatchObject({coverage:{participants:50},recentParticipantsTotal:50,recentParticipantsTruncated:true});expect(page.events[0].recentParticipants).toHaveLength(20);expect(45-d1BudgetRemaining(env.DB)).toBeLessThanOrEqual(initial+2);
 });
});
it('marks capped Event inventories and field drift explicitly',async()=>{
 await seed(false);await applyChanges(fixture.env,'alice',Array.from({length:205},(_,index)=>({id:'e'+String(index).padStart(3,'0'),collection:'tasks',patch:{boardId:'events',p_f_start:'2026-11-01',p_f_capacity:0},ts:now})),{serverTs:true});
 const page=(await read())[0];expect(page.partialSources).toEqual(expect.arrayContaining(['events','event_selection']));expect(page.events).toHaveLength(10);
 await applyChanges(fixture.env,'alice',[{id:'events',collection:'boards',patch:{fields:fields.filter(field=>field.id!=='f_participants')},ts:now}],{serverTs:true});expect((await read())[0]).toMatchObject({status:'configuration_required',events:[]});
});
it('refuses authority revoked while gathering an Event snapshot',async()=>{
 await seed(true);let changed=false;
 const wrap=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(statement,{get(target,key){
  if(key==='bind')return(...values:Parameters<D1PreparedStatement['bind']>)=>wrap(target.bind(...values),sql);
  if(key==='all')return async()=>{const result=await target.all();if(!changed&&sql.includes("SELECT 'event' bucket")){changed=true;await fixture.db.prepare("UPDATE users SET disabled_at=? WHERE id='alice'").bind(now).run();}return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 const database=new Proxy(fixture.db,{get(target,key){if(key==='prepare')return(sql:string)=>wrap(target.prepare(sql),sql);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 await expect(collectEventOps(withWorkspaceContext(withD1Budget({...fixture.env,DB:database})),'alice',[config],now)).rejects.toThrow();expect(changed).toBe(true);
});
it('does not leak a private People database through public Event relationships',async()=>{
 await seed(true);await fixture.db.batch([fixture.db.prepare("INSERT INTO spaces(id,name,default_access,created_at) VALUES('vault','Private people','private',1)"),fixture.db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('vault','alice','owner')"),fixture.db.prepare("UPDATE records SET space_id='vault' WHERE id IN('people','person1')"),fixture.db.prepare("UPDATE records SET peer_space_id='vault' WHERE id='participants1'")]);
 const [page]=await collectEventOps(withWorkspaceContext(withD1Budget(fixture.env)),'bob',[config],now);expect(page.events[0]).toMatchObject({coverage:{participants:0},formsUrl:null,recentParticipants:[]});expect(JSON.stringify(page)).not.toMatch(/Synthetic participant|Private people/);expect(page.records).toEqual([]);
});
it('fails closed for private Events and disabled sponsors',async()=>{
 await seed(true);await fixture.db.batch([fixture.db.prepare("UPDATE spaces SET default_access='private' WHERE id='space-core'"),fixture.db.prepare("INSERT OR REPLACE INTO space_members(space_id,user_id,role) VALUES('space-core','alice','owner')")]);
 expect((await collectEventOps(withWorkspaceContext(withD1Budget(fixture.env)),'bob',[config],now))[0]).toMatchObject({status:'source_unavailable',events:[],records:[]});await fixture.db.prepare("UPDATE users SET disabled_at=? WHERE id='alice'").bind(now).run();await expect(read()).rejects.toThrow('unauthenticated');
});
for(const enabled of [false,true])it(`refuses an Event revision changed mid-read in permission mode ${enabled}`,async()=>{
 await seed(enabled);let changed=false;
 const wrap=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(statement,{get(target,key){
  if(key==='bind')return(...values:Parameters<D1PreparedStatement['bind']>)=>wrap(target.bind(...values),sql);
  if(key==='all')return async()=>{const result=await target.all();if(!changed&&sql.includes('SELECT r.id,r.seq rev')){changed=true;await applyChanges(fixture.env,'alice',[{id:'event1',collection:'tasks',patch:{p_f_capacity:20},ts:now}],{serverTs:true});}return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 const database=new Proxy(fixture.db,{get(target,key){if(key==='prepare')return(sql:string)=>wrap(target.prepare(sql),sql);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const response=await eventOpsApi.request('https://local.test/',{method:'POST',headers:fixture.auth('alice'),body:JSON.stringify([config])},withWorkspaceContext(withD1Budget({...fixture.env,DB:database})));expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'event_sources_changed'});expect(changed).toBe(true);
});
it('bounds authenticated request bodies before parsing and validates configuration',async()=>{
 await seed(false);const request=(body:string,auth=true)=>eventOpsApi.request('https://local.test/',{method:'POST',headers:auth?fixture.auth('alice'):{},body},withWorkspaceContext(withD1Budget(fixture.env)));
 expect((await request('[]',false)).status).toBe(401);expect((await request('{')).status).toBe(400);expect((await request('[]')).status).toBe(400);expect((await request(' '.repeat(12001))).status).toBe(413);expect((await request(JSON.stringify([{databaseId:'events',limit:21}]))).status).toBe(400);
});
