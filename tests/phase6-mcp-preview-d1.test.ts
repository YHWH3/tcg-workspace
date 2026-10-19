import {afterEach,describe,expect,it,vi} from 'vitest';
import {openAuditFixture,type AuditFixture} from './audit-fixture';
const handlers=vi.hoisted(()=>new Map<string,(a:Record<string,unknown>)=>Promise<{content:{text:string}[];isError?:boolean}>>());
vi.mock('@modelcontextprotocol/server',()=>({McpServer:class{registerTool(n:string,_m:unknown,f:never){handlers.set(n,f);}registerPrompt(){}}}));
vi.mock('agents/mcp/server',()=>({createMcpHandler:vi.fn()}));
vi.mock('../worker/events',async o=>({...await o<typeof import('../worker/events')>(),scheduleOutbox:vi.fn()}));
import {createWorkspaceServer} from '../worker/mcp';
import {aiPreviewApi} from '../worker/aiPreviews';
let f:AuditFixture|undefined;afterEach(async()=>f?.dispose());
async function setup(){f=await openAuditFixture();await f.db.batch([f.db.prepare('UPDATE access_state SET enabled=1'),f.db.prepare(`INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES('p','pages','{"title":"Before"}','{}',1,'space-core'),('b','boards','{"name":"Tasks","columns":[{"id":"todo","name":"Todo"},{"id":"done","name":"Done"}]}','{}',2,'space-core')`)]);createWorkspaceServer({env:f.env,ectx:f.ctx,userId:'alice',userRole:'admin',origin:'http://localhost',userByKey:new Map(),userNameById:new Map(),pageTitleById:new Map(),recordTitleById:new Map(),recordIdByTitle:new Map(),pageIdByTitle:new Map(),cachesReady:false,warnings:[],cs:null,toolName:''} as never);}
async function call(name:string,args:Record<string,unknown>){const r=await handlers.get(name)!(args);return {...JSON.parse(r.content[0].text),isError:r.isError};}
async function approve(p:{previewId:string;argsHash:string}){const r=await aiPreviewApi.request(`http://localhost/${p.previewId}/decision`,{method:'POST',headers:f!.auth('alice'),body:JSON.stringify({decision:'approve',argsHash:p.argsHash})},f!.env,f!.ctx);expect(r.status).toBe(200);}
describe('MCP significant-write enforcement (actual D1, permissions ENABLED)',()=>{
 it('does not delete until an authenticated human approves its exact frozen plan',async()=>{
  await setup();const p=await call('delete_item',{type:'page',id:'p',expectedRev:1});expect(p.humanApprovalRequired).toBe(true);
  expect((await f!.db.prepare("SELECT json_extract(data,'$.deleted') d FROM records WHERE id='p'").first<{d:number|null}>())?.d).toBeNull();
  expect((await call('execute_preview',{previewId:p.previewId,argsHash:p.argsHash})).error).toBe('human_approval_required');
  await approve(p);const done=await call('execute_preview',{previewId:p.previewId,argsHash:p.argsHash});expect(done.completed).toBe(true);
  expect((await f!.db.prepare("SELECT json_extract(data,'$.deleted') d FROM records WHERE id='p'").first<{d:number|null}>())?.d).toBe(1);
 });
 it('keeps a small edit compatible and turns a >25-write create into a preview with stable generated IDs',async()=>{
  await setup();const edit=await call('edit_page',{pageId:'p',title:'Small edit',expectedRev:1});expect(edit.error).toBeUndefined();
  const p=await call('create_tasks',{boardId:'b',tasks:Array.from({length:26},(_,i)=>({title:'Proposed '+i}))});expect(p.humanApprovalRequired).toBe(true);
  expect((await f!.db.prepare("SELECT COUNT(*) n FROM records WHERE collection='tasks'").first<{n:number}>())?.n).toBe(0);
  await approve(p);const done=await call('execute_preview',{previewId:p.previewId,argsHash:p.argsHash});expect(done.completed).toBe(true);
  expect((await f!.db.prepare("SELECT COUNT(*) n FROM records WHERE collection='tasks'").first<{n:number}>())?.n).toBe(26);
  expect((await call('execute_preview',{previewId:p.previewId,argsHash:p.argsHash})).replayed).toBe(true);
 });
});
it('workflow request identity survives lost responses and never creates a second plan',async()=>{
 await setup();const args={workflow:'meeting_to_actions',workflowId:'meeting',sourceIds:['p'],destinationDatabaseId:'b',title:'Meeting',items:[{title:'Action',inferred:false}],requestId:'workflow-once'};
 const first=await call('propose_workflow',args),repeat=await call('propose_workflow',args);expect(first.previewId).toBeTruthy();expect(repeat.previewId).toBe(first.previewId);expect((await call('propose_workflow',{...args,title:'Different'})).error).toContain('different arguments');await approve(first);const done=await call('execute_preview',{previewId:first.previewId,argsHash:first.argsHash});expect(done.completed).toBe(true);expect(done.recordIds).toHaveLength(1);expect(await f!.db.prepare("SELECT json_extract(data,'$.meta.changesetId') id FROM records WHERE collection='activity' AND json_extract(data,'$.targetId')=?").bind(done.recordIds[0]).first('id')).toBe(done.changesetId);expect((await call('propose_workflow',args)).changesetId).toBe(done.changesetId);expect(await f!.db.prepare("SELECT COUNT(*) n FROM records WHERE collection='tasks'").first('n')).toBe(1);
});
it('MCP cannot use undo to bypass human confirmation of a deletion',async()=>{
 await setup();const created=await call('create_page',{title:'Created record',markdown:'Evidence'});expect(created.changesetId).toBeTruthy();const inverse=await call('undo_change',{changesetId:created.changesetId});expect(inverse.humanUndoRequired).toBe(true);expect(await f!.db.prepare('SELECT COALESCE(json_extract(data,\'$.deleted\'),0) d FROM records WHERE id=?').bind(created.id).first('d')).toBe(0);
});
it('plans and resumes the complete TCG pack inside real scoped request budgets',async()=>{
 await setup();await f!.db.prepare("INSERT INTO ai_connections(id,user_id,client_id,spaces_json,created_at,expires_at) VALUES('pack-connector','alice','pack','[\"space-core\"]',1,?)").bind(Date.now()+1000000).run();
 const {withD1Budget,d1BudgetRemaining}=await import('../worker/d1budget');
 const server=async()=>{const env=withD1Budget({...f!.env,CONNECTOR:{id:'pack-connector',version:1}},45);for(let i=0;i<3;i++)await env.DB.prepare('SELECT 1').first();createWorkspaceServer({env,ectx:f!.ctx,userId:'alice',userRole:'admin',origin:'http://localhost',userByKey:new Map(),userNameById:new Map(),pageTitleById:new Map(),recordTitleById:new Map(),recordIdByTitle:new Map(),pageIdByTitle:new Map(),cachesReady:false,warnings:[],cs:null,toolName:''} as never);return env;};
 let env=await server();const p=await call('install_template',{bundled:'tcg-pack'});expect(p.humanApprovalRequired,JSON.stringify(p)).toBe(true);expect(d1BudgetRemaining(env.DB)).toBeGreaterThanOrEqual(0);await approve(p);
 let done:Record<string,any>={};for(let i=0;i<30&&!done.completed;i++){env=await server();done=await call('execute_preview',{previewId:p.previewId,argsHash:p.argsHash});expect(done.isError,JSON.stringify(done)).not.toBe(true);expect(d1BudgetRemaining(env.DB)).toBeGreaterThanOrEqual(0);}expect(done.completed).toBe(true);expect(done.rootPageId).toBeTruthy();expect(done.counts.boards).toBeGreaterThanOrEqual(15);
},60000);
it('freezes a multi-step database plan with its new two-way relation intact',async()=>{
 await setup();const p=await call('create_database',{name:'Planned database',kind:'records',fields:[{name:'Related work',type:'relation',target:'b',twoWay:true,reverseName:'Back-reference'}],views:Array.from({length:26},(_,i)=>({name:'View '+i,type:'table'}))});expect(p.humanApprovalRequired,JSON.stringify(p)).toBe(true);await approve(p);const done=await call('execute_preview',{previewId:p.previewId,argsHash:p.argsHash});expect(done.completed,JSON.stringify(done)).toBe(true);const board=await f!.db.prepare('SELECT data FROM records WHERE id=?').bind(done.id).first<{data:string}>();expect(JSON.parse(board!.data).fields[0].relation.target).toBe('b');const target=await f!.db.prepare("SELECT data FROM records WHERE id='b'").first<{data:string}>();expect(JSON.parse(target!.data).fields[0].relation.target).toBe(done.id);
});
it('small record writes preserve parent/body plans and CAS attribution without a second handler pass',async()=>{
 await setup();const out=await call('create_records',{databaseId:'b',dedupe:'none',records:[{title:'Parent'},{title:'Child',parent:'Parent',body:'Evidence body'}]});expect(out.isError,JSON.stringify(out)).not.toBe(true);expect(out.created).toHaveLength(2);
 const child=out.created[1].id;expect(await f!.db.prepare("SELECT json_extract(data,'$.parentId') FROM records WHERE id=?").bind(child).first()).toBeTruthy();expect(await f!.db.prepare("SELECT COUNT(*) n FROM records WHERE collection='blocks' AND json_extract(data,'$.pageId')=?").bind(child).first('n')).toBe(1);
 const before=await f!.db.prepare("SELECT seq FROM records WHERE id='b'").first<number>('seq');const stage=await call('add_stage',{boardId:'b',name:'Review'});expect(stage.isError,JSON.stringify(stage)).not.toBe(true);const row=await f!.db.prepare("SELECT seq,updated_by,data FROM records WHERE id='b'").first<{seq:number;updated_by:string;data:string}>();expect(row!.seq).toBeGreaterThan(before!);expect(row!.updated_by).toBe('alice');expect(JSON.parse(row!.data).columns.some((s:{name:string})=>s.name==='Review')).toBe(true);
});
it('scoped three-record guarded edit remains within a complete Worker invocation budget',async()=>{
 await setup();await f!.db.prepare("INSERT INTO ai_connections(id,user_id,client_id,spaces_json,created_at,expires_at) VALUES('small','alice','small','[\"space-core\"]',1,?)").bind(Date.now()+1000000).run();
 const created=await call('create_records',{databaseId:'b',records:[{title:'One'},{title:'Two'},{title:'Three'}]});expect(created.created).toHaveLength(3);
 const {withD1Budget}=await import('../worker/d1budget');const env=withD1Budget({...f!.env,CONNECTOR:{id:'small',version:1}},45);for(let i=0;i<3;i++)await env.DB.prepare('SELECT 1').first();createWorkspaceServer({env,ectx:f!.ctx,userId:'alice',userRole:'admin',origin:'http://localhost',userByKey:new Map(),userNameById:new Map(),pageTitleById:new Map(),recordTitleById:new Map(),recordIdByTitle:new Map(),pageIdByTitle:new Map(),cachesReady:false,warnings:[],cs:null,toolName:''} as never);
 const updates=[];for(const r of created.created){const rev=await f!.db.prepare('SELECT seq FROM records WHERE id=?').bind(r.id).first('seq');updates.push({recordId:r.id,title:'Changed '+r.id,expectedRev:rev});}const result=await call('update_records',{updates});expect(result.isError,JSON.stringify(result)).not.toBe(true);
});
it('restores deleted descendants through canonical same-plan authorization without exposing hidden copies',async()=>{
 await setup();const created=await call('create_records',{databaseId:'b',records:[{title:'Restore parent'},{title:'Restore child',parent:'Restore parent',body:'Retained'}]});const [parent,child]=created.created;
 const rev=await f!.db.prepare('SELECT seq FROM records WHERE id=?').bind(parent.id).first('seq');const preview=await call('delete_item',{type:'task',id:parent.id,expectedRev:rev});await approve(preview);const deleted=await call('execute_preview',{previewId:preview.previewId,argsHash:preview.argsHash});expect(deleted.completed===true||deleted.operationStatus==='completed',JSON.stringify(deleted)).toBe(true);
 const result=await call('restore_item',{type:'task',id:parent.id});expect(result.isError,JSON.stringify(result)).not.toBe(true);expect(await f!.db.prepare("SELECT json_extract(data,'$.deleted') FROM records WHERE id=?").bind(child.id).first()).toEqual({"json_extract(data,'$.deleted')":0});
});
it('allows only canonical tombstone bookkeeping when deleting a task with another author comment',async()=>{
 await setup();const created=await call('create_records',{databaseId:'b',records:[{title:'Discussion'}]});const id=created.created[0].id;
 const {applyChanges}=await import('../worker/sync');expect((await applyChanges(f!.env,'bob',[{id:'foreign-comment',collection:'comments',patch:{targetType:'task',targetId:id,authorId:'bob',body:'Retained discussion'},ts:0}],{serverTs:true})).rejected).toBe(0);
 const rev=await f!.db.prepare('SELECT seq FROM records WHERE id=?').bind(id).first('seq');const p=await call('delete_item',{type:'task',id,expectedRev:rev});expect(p.humanApprovalRequired,JSON.stringify(p)).toBe(true);await approve(p);const done=await call('execute_preview',{previewId:p.previewId,argsHash:p.argsHash});expect(done.isError,JSON.stringify(done)).not.toBe(true);expect(await f!.db.prepare("SELECT json_extract(data,'$.deleted') FROM records WHERE id='foreign-comment'").first()).toEqual({"json_extract(data,'$.deleted')":1});
});
it('cannot forge cascade bookkeeping without the matching authorized target transition',async()=>{
 await setup();const {applyChanges}=await import('../worker/sync');await applyChanges(f!.env,'bob',[{id:'comment-no-cascade',collection:'comments',patch:{targetType:'page',targetId:'p',authorId:'bob',body:'Unchanged'},ts:0}],{serverTs:true});
 const result=await applyChanges(f!.env,'alice',[{id:'comment-no-cascade',collection:'comments',patch:{deleted:true,deletedVia:'p'},ts:0}],{serverTs:true,atomic:true});expect(result.rejected).toBe(1);expect(await f!.db.prepare("SELECT json_extract(data,'$.body') FROM records WHERE id='comment-no-cascade'").first()).toEqual({"json_extract(data,'$.body')":'Unchanged'});
});
