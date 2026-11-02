import {it,expect,afterEach,vi} from 'vitest';
const handlers=vi.hoisted(()=>new Map<string,(args:unknown)=>Promise<{content:{text:string}[];isError?:boolean}>>());
vi.mock('@modelcontextprotocol/server',()=>({McpServer:class{registerTool(name:string,_meta:unknown,handler:(args:unknown)=>Promise<{content:{text:string}[]}>){handlers.set(name,handler);}registerPrompt(){}registerResource(){}},ResourceTemplate:class{}}));
vi.mock('agents/mcp/server',()=>({createMcpHandler:vi.fn()}));
import {createWorkspaceServer} from '../worker/mcp';
import {openAuditFixture,type AuditFixture} from './audit-fixture';
import {applyChanges} from '../worker/sync';
import {collectCommitments,commitmentsApi} from '../worker/commitments';
import {withD1Budget,d1BudgetRemaining} from '../worker/d1budget';
import {withWorkspaceContext} from '../worker/workspaceSettings';
import {commitmentsConfigSchema} from '../shared/commitmentsConfig';
let fixture:AuditFixture;const now=Date.parse('2026-11-03T12:00Z'),config=commitmentsConfigSchema.parse({databaseId:'meetings'});
const fields=[{id:'f_date',name:'Date',type:'date'},{id:'f_actions',name:'Actions',type:'relation',relation:{target:'tasks',primary:true}},{id:'f_decisions',name:'Decisions',type:'relation',relation:{target:'decisions',primary:true}}];
afterEach(async()=>{vi.restoreAllMocks();handlers.clear();await fixture?.dispose();});
async function seed(enabled:boolean){
 vi.spyOn(Date,'now').mockReturnValue(now);fixture=await openAuditFixture();
 const changes=[{id:'meetings',collection:'boards',patch:{name:'Meetings',kind:'records',templateDbKey:'meetings',fields}},
 {id:'tasks',collection:'boards',patch:{name:'Tasks',kind:'tasks',columns:[{id:'open',name:'Open'},{id:'done',name:'Done'}],fields:[]}},
 {id:'decisions',collection:'boards',patch:{name:'Decisions',kind:'records',columns:[{id:'open',name:'Open'},{id:'decided',name:'Decided'}],fields:[{id:'f_decider',name:'Decision maker',type:'person'}]}},
 {id:'m',collection:'tasks',patch:{boardId:'meetings',title:'Synthetic meeting',p_f_date:'2026-11-02',description:'NEVER_COPY_MEETING_NOTES'}},
 {id:'t',collection:'tasks',patch:{boardId:'tasks',title:'Synthetic action',status:'open',dueDate:'2026-11-01',description:'NEVER_COPY_ACTION_BODY'}},
 {id:'d',collection:'tasks',patch:{boardId:'decisions',title:'Synthetic decision',status:'open',description:'NEVER_COPY_DECISION_BODY'}},
 {id:'a',collection:'links',patch:{kind:'relation',fieldId:'f_actions',fromType:'record',toType:'record',fromId:'m',toId:'t'}},
 {id:'b',collection:'links',patch:{kind:'relation',fieldId:'f_decisions',fromType:'record',toType:'record',fromId:'m',toId:'d'}}];
 expect((await applyChanges(fixture.env,'alice',changes.map(change=>({...change,ts:now})),{serverTs:true})).rejected).toBe(0);await fixture.db.prepare('UPDATE access_state SET enabled=? WHERE id=1').bind(enabled?1:0).run();
}
const read=()=>collectCommitments(withWorkspaceContext(withD1Budget(fixture.env)),'alice',[config],now);
for(const enabled of [false,true]){
 it(`returns complete projected commitments and matching HTTP/MCP snapshots, permissions ${enabled}`,async()=>{
  await seed(enabled);const env=withWorkspaceContext(withD1Budget(fixture.env)),[page]=await collectCommitments(env,'alice',[config],now);expect(page).toMatchObject({status:'ready',partial:false,meetings:[{overdue:[{id:'t',ownerId:null}],decisions:[{id:'d',ownerId:null}]}]});expect(JSON.stringify(page)).not.toContain('NEVER_COPY');expect(45-d1BudgetRemaining(env.DB)).toBeLessThanOrEqual(30);
  const response=await commitmentsApi.request('https://local.test/',{method:'POST',headers:fixture.auth('alice'),body:JSON.stringify([config])},withWorkspaceContext(withD1Budget(fixture.env)));expect(response.status).toBe(200);expect((await response.json() as {pages:unknown[]}).pages).toEqual([page]);
  await applyChanges(fixture.env,'alice',[{id:'review',collection:'pages',patch:{title:'Meetings review'},ts:now},{id:'commitments',collection:'blocks',patch:{pageId:'review',type:'commitments',databaseId:'meetings',order:'a0'},ts:now}],{serverTs:true});
  const mcp=withWorkspaceContext(withD1Budget(fixture.env));createWorkspaceServer({env:mcp,ectx:fixture.ctx,userId:'alice',userRole:'admin',origin:'https://workspace.test',userByKey:new Map(),userNameById:new Map(),pageTitleById:new Map(),recordTitleById:new Map(),recordIdByTitle:new Map(),cachesReady:false,warnings:[],cs:null,toolName:''} as never);
  const result=await handlers.get('dashboard_snapshot')!({pageId:'review'});expect(result.isError).not.toBe(true);const block=JSON.parse(result.content[0].text).blocks[0];expect(block).toMatchObject({status:'ready',meetings:[{url:'https://workspace.test/boards/meetings/tasks/m',overdue:[{id:'t',url:'https://workspace.test/boards/tasks/tasks/t',meeting:{url:'https://workspace.test/boards/meetings/tasks/m'}}],decisions:[{id:'d'}]}]});expect(45-d1BudgetRemaining(mcp.DB)).toBeLessThanOrEqual(45);
 });
 it(`reflects edits, completion, deletion and explicit historical selection, permissions ${enabled}`,async()=>{
  await seed(enabled);await applyChanges(fixture.env,'alice',[{id:'t',collection:'tasks',patch:{assigneeId:'alice',dueDate:'2026-11-04'},ts:now},{id:'d',collection:'tasks',patch:{status:'decided'},ts:now}],{serverTs:true});expect((await read())[0].meetings[0]).toMatchObject({overdue:[],upcoming:[{id:'t',ownerId:'alice'}],decisions:[]});
  await applyChanges(fixture.env,'alice',[{id:'t',collection:'tasks',patch:{deleted:true},ts:now}],{serverTs:true});expect((await read())[0].meetings[0].actions).toEqual([]);
  await applyChanges(fixture.env,'alice',[{id:'m',collection:'tasks',patch:{p_f_date:'2020-01-01'},ts:now}],{serverTs:true});expect((await read())[0].meetings).toEqual([]);expect((await collectCommitments(withWorkspaceContext(withD1Budget(fixture.env)),'alice',[{...config,meetingId:'m'}],now))[0].meetings).toHaveLength(1);
 });
 it(`keeps calls bounded as linked action inventory grows, permissions ${enabled}`,async()=>{
  await seed(enabled);let env=withWorkspaceContext(withD1Budget(fixture.env));await collectCommitments(env,'alice',[config],now);const initial=45-d1BudgetRemaining(env.DB);
  await applyChanges(fixture.env,'alice',Array.from({length:80},(_,index)=>[{id:'t'+index,collection:'tasks',patch:{boardId:'tasks',title:'Synthetic action '+index,status:'open'},ts:now},{id:'a'+index,collection:'links',patch:{kind:'relation',fieldId:'f_actions',fromType:'record',toType:'record',fromId:'m',toId:'t'+index},ts:now}]).flat(),{serverTs:true});
  env=withWorkspaceContext(withD1Budget(fixture.env));const [page]=await collectCommitments(env,'alice',[config],now);expect(page).toMatchObject({partial:true,partialSources:['commitment_selection'],meetings:[{actionTotal:81}]});expect(page.meetings[0].actions).toHaveLength(50);expect(45-d1BudgetRemaining(env.DB)).toBeLessThanOrEqual(initial+2);
 });
 it(`refuses a root revision changed mid-read, permissions ${enabled}`,async()=>{
  await seed(enabled);let changed=false;
  const wrap=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(statement,{get(target,key){if(key==='bind')return(...values:Parameters<D1PreparedStatement['bind']>)=>wrap(target.bind(...values),sql);if(key==='all')return async()=>{const result=await target.all();if(!changed&&sql.includes('SELECT r.id,r.seq rev')){changed=true;await applyChanges(fixture.env,'alice',[{id:'m',collection:'tasks',patch:{p_f_date:'2026-11-01'},ts:now}],{serverTs:true});}return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const database=new Proxy(fixture.db,{get(target,key){if(key==='prepare')return(sql:string)=>wrap(target.prepare(sql),sql);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  const response=await commitmentsApi.request('https://local.test/',{method:'POST',headers:fixture.auth('alice'),body:JSON.stringify([config])},withWorkspaceContext(withD1Budget({...fixture.env,DB:database})));expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'commitment_sources_changed'});expect(changed).toBe(true);
 });
}
it('keeps private action metadata out while retaining available decisions',async()=>{
 await seed(true);await fixture.db.batch([fixture.db.prepare("INSERT INTO spaces(id,name,default_access,created_at) VALUES('vault','Private actions','private',1)"),fixture.db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('vault','alice','owner')"),fixture.db.prepare("UPDATE records SET space_id='vault' WHERE id IN('tasks','t')"),fixture.db.prepare("UPDATE records SET peer_space_id='vault' WHERE id='a'")]);
 const [page]=await collectCommitments(withWorkspaceContext(withD1Budget(fixture.env)),'bob',[config],now);expect(page).toMatchObject({status:'ready',partial:true,meetings:[{actions:[],decisions:[{id:'d'}]}]});expect(JSON.stringify(page)).not.toMatch(/Synthetic action|Private actions/);
});
it('fails closed for private meetings, disabled actors and oversized or invalid configurations',async()=>{
 await seed(true);const request=(body:string,auth=true)=>commitmentsApi.request('https://local.test/',{method:'POST',headers:auth?fixture.auth('alice'):{},body},withWorkspaceContext(withD1Budget(fixture.env)));
 expect((await request('[]',false)).status).toBe(401);expect((await request('{')).status).toBe(400);expect((await request('[]')).status).toBe(400);expect((await request(' '.repeat(12001))).status).toBe(413);
 await fixture.db.batch([fixture.db.prepare("UPDATE spaces SET default_access='private' WHERE id='space-core'"),fixture.db.prepare("INSERT OR REPLACE INTO space_members(space_id,user_id,role) VALUES('space-core','alice','owner')")]);expect((await collectCommitments(withWorkspaceContext(withD1Budget(fixture.env)),'bob',[config],now))[0]).toMatchObject({status:'source_unavailable',meetings:[]});await fixture.db.prepare("UPDATE users SET disabled_at=? WHERE id='alice'").bind(now).run();await expect(read()).rejects.toThrow('unauthenticated');
});
it('retains explicit caps, rejects field drift and never interprets boolean dates as valid',async()=>{
 await seed(false);await applyChanges(fixture.env,'alice',[{id:'t',collection:'tasks',patch:{dueDate:true},ts:now}],{serverTs:true});expect((await read())[0].meetings[0].undated[0]).toMatchObject({id:'t',date:null,invalidDate:true});
 await applyChanges(fixture.env,'alice',Array.from({length:205},(_,index)=>({id:'m'+String(index).padStart(3,'0'),collection:'tasks',patch:{boardId:'meetings',p_f_date:'2026-11-02'},ts:now})),{serverTs:true});expect((await read())[0]).toMatchObject({partial:true,partialSources:expect.arrayContaining(['meetings','meeting_selection'])});await applyChanges(fixture.env,'alice',[{id:'meetings',collection:'boards',patch:{fields:fields.filter(field=>field.id!=='f_actions')},ts:now}],{serverTs:true});expect((await read())[0]).toMatchObject({status:'configuration_required',meetings:[]});
});
it('refuses an actor disabled during metadata collection',async()=>{
 await seed(true);let disabled=false;
 const wrap=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(statement,{get(target,key){if(key==='bind')return(...values:Parameters<D1PreparedStatement['bind']>)=>wrap(target.bind(...values),sql);if(key==='all')return async()=>{const result=await target.all();if(!disabled&&sql.includes("SELECT 'meeting' bucket")){disabled=true;await fixture.db.prepare("UPDATE users SET disabled_at=? WHERE id='alice'").bind(now).run();}return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const database=new Proxy(fixture.db,{get(target,key){if(key==='prepare')return(sql:string)=>wrap(target.prepare(sql),sql);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 await expect(collectCommitments(withWorkspaceContext(withD1Budget({...fixture.env,DB:database})),'alice',[config],now)).rejects.toThrow();expect(disabled).toBe(true);
});
it('copies only the self-meeting block into a frozen conversion and requires session approval',async()=>{
 await seed(true);await applyChanges(fixture.env,'alice',[{id:'template',collection:'pages',patch:{title:'Meeting template',isTemplate:true},ts:now},{id:'self',collection:'blocks',patch:{pageId:'template',type:'commitments',databaseId:'unrelated',meetingId:'self',heading:'Our meeting commitments',order:'a0'},ts:now},{id:'named',collection:'blocks',patch:{pageId:'template',type:'commitments',databaseId:'meetings',meetingId:'m',order:'a1'},ts:now}],{serverTs:true});
 const env=()=>withWorkspaceContext(withD1Budget(fixture.env));createWorkspaceServer({env:env(),ectx:fixture.ctx,userId:'alice',userRole:'admin',origin:'https://workspace.test',userByKey:new Map(),userNameById:new Map(),pageTitleById:new Map(),recordTitleById:new Map(),recordIdByTitle:new Map(),cachesReady:false,warnings:[],cs:null,toolName:''} as never);
 const result=await handlers.get('convert_record')!({recordId:'t',toDatabaseId:'meetings',templateId:'template'}),proposal=JSON.parse(result.content[0].text);expect(result.isError,JSON.stringify(proposal)).not.toBe(true);expect(proposal.humanApprovalRequired).toBe(true);
 const saved=await fixture.db.prepare('SELECT plan_json FROM ai_previews WHERE id=?').bind(proposal.previewId).first<{plan_json:string}>(),plan=JSON.parse(saved!.plan_json) as {collection:string;id:string;patch:Record<string,unknown>}[];
 expect(plan.filter(op=>op.collection==='boards')).toEqual([]);const blocks=plan.filter(op=>op.collection==='blocks'&&op.patch.type==='commitments');expect(blocks).toHaveLength(1);expect(blocks[0].patch).toMatchObject({databaseId:'meetings',meetingId:'self',parentType:'record',heading:'Our meeting commitments'});
 const {executePreview,aiPreviewApi}=await import('../worker/aiPreviews');await expect(executePreview(env(),'alice',proposal.previewId,proposal.argsHash)).rejects.toThrow('human_approval_required');
 // Automated disposable authenticated session approval, not a real person's acceptance.
 const approval=await aiPreviewApi.request('https://local.test/'+proposal.previewId+'/decision',{method:'POST',headers:fixture.auth('alice'),body:JSON.stringify({decision:'approve',argsHash:proposal.argsHash})},fixture.env,fixture.ctx);expect(approval.status).toBe(200);expect(await executePreview(env(),'alice',proposal.previewId,proposal.argsHash)).toMatchObject({completed:true});expect(await executePreview(env(),'alice',proposal.previewId,proposal.argsHash)).toMatchObject({completed:true,replayed:true});
});
