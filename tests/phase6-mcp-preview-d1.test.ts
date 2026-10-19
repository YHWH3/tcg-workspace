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
