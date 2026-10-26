import {afterEach,describe,it,expect,vi} from 'vitest';
import {openAuditFixture,ctx,type AuditFixture} from './audit-fixture';
import {withD1Budget,d1BudgetRemaining} from '../worker/d1budget';
import {applyChanges} from '../worker/sync';
import {aiPreviewApi} from '../worker/aiPreviews';
import {planTemplateInstantiation} from '../shared/templates';
const tools=vi.hoisted(()=>new Map<string,(args:any)=>Promise<any>>());
vi.mock('@modelcontextprotocol/server',()=>({McpServer:class{registerTool(name:string,_meta:unknown,fn:any){tools.set(name,fn);}registerPrompt(){}registerResource(){}},ResourceTemplate:class{}}));
vi.mock('agents/mcp/server',()=>({createMcpHandler:vi.fn()}));
vi.mock('../worker/events',async original=>({...await original<typeof import('../worker/events')>(),scheduleOutbox:vi.fn()}));
vi.mock('../worker/bundledTemplates',async()=>{
 const {toBundled}=await import('../shared/bundled');
 const author={version:2,name:'Upgrade fixture',description:'Disposable',icon:'P',databases:[{id:'db',key:'fixture-projects',name:'Projects',fields:[{id:'money',name:'Budget',type:'number',format:'currency'}],views:[{id:'all',key:'all',name:'All',config:{}}]}],pages:[{id:'home',key:'home',title:'Home',blocks:[{key:'metric',type:'metric',databaseId:'db',agg:'count',label:'Count'}]}]};
 const bundle=toBundled('fixture',author as never);
 return {BUNDLED:{fixture:bundle},BUNDLED_AUTHORS:{fixture:author},bundledTemplate:(key:string)=>key==='fixture'?bundle:undefined};
});
import {createWorkspaceServer} from '../worker/mcp';
import {bundledTemplate} from '../worker/bundledTemplates';
let f:AuditFixture;
afterEach(async()=>{vi.restoreAllMocks();await f?.dispose();});
async function setup(enabled:boolean){
 f=await openAuditFixture();await f.db.batch([f.db.prepare('UPDATE access_state SET enabled=?').bind(enabled?1:0),f.db.prepare("UPDATE users SET workspace_role='owner' WHERE id='alice'"),f.db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('space-core','alice','owner')"),f.db.prepare("INSERT INTO ai_connections(id,user_id,client_id,spaces_json,created_at,expires_at) VALUES('pack-connector','alice','fixture','[\"space-core\"]',1,?)").bind(Date.now()+86400000)]);
 const bundle=bundledTemplate('fixture')!,plan=planTemplateInstantiation(bundle.snapshot,{templateId:bundle.root,templateKey:bundle.key,stableIds:true,packInstall:true,actorId:'alice'},{id:()=>crypto.randomUUID(),now:1})!;
 const board=plan.writes.find(w=>w.collection==='boards')!,root=plan.writes.find(w=>w.id===plan.rootPageId)!;
 board.patch.fields=[{id:'money',name:'Our budget',type:'number'}];root.patch.templateVersion=1;
 const view=plan.writes.find(w=>w.collection==='views')!;view.patch.name='Renamed by team';view.patch.config={filters:[{key:'title',op:'contains',value:'team'}]};
 const seeded=await applyChanges(f.env,'alice',plan.writes.map(w=>({...w,ts:0})),{serverTs:true});expect(seeded.rejected).toBe(0);return {board,root,view};
}
async function call(name:string,args:any){const env=withD1Budget({...f.env,CONNECTOR:{id:'pack-connector',version:1}});createWorkspaceServer({env,ectx:ctx,userId:'alice',userRole:'admin',origin:'https://localhost',userByKey:new Map(),userNameById:new Map(),pageTitleById:new Map(),recordTitleById:new Map(),recordIdByTitle:new Map(),pageIdByTitle:new Map(),cachesReady:false,warnings:[],cs:null,toolName:''} as never);const result=await tools.get(name)!(args);expect(45-d1BudgetRemaining(env.DB)).toBeLessThanOrEqual(45);return {result,json:JSON.parse(result.content[0].text)};}
describe.each([false,true])('frozen pack upgrade permissions=%s',enabled=>{
 it('requires labelled session approval, applies exactly the preview, and preserves renamed views',async()=>{
  const {board,root,view}=await setup(enabled);
  const proposed=await call('install_template',{bundled:'fixture',mode:'upgrade',dryRun:true});expect(proposed.result.isError,JSON.stringify(proposed.json)).not.toBe(true);
  const p=proposed.json;expect(p.humanApprovalRequired).toBe(true);expect(p.changes.map((c:any)=>c.id)).toEqual([board.id,root.id]);
  expect((await call('execute_preview',{previewId:p.previewId,argsHash:p.argsHash})).json.error).toBe('human_approval_required');
  // Disposable test session, never a genuine human approval claim.
  expect((await aiPreviewApi.request('/'+p.previewId+'/decision',{method:'POST',headers:f.auth('alice'),body:JSON.stringify({decision:'approve',argsHash:p.argsHash})},f.env,ctx)).status).toBe(200);
  expect((await call('execute_preview',{previewId:p.previewId,argsHash:p.argsHash})).json.completed).toBe(true);
  const rows=await f.db.prepare('SELECT id,data FROM records WHERE id IN(?,?,?)').bind(board.id,root.id,view.id).all<{id:string;data:string}>();const by=new Map(rows.results.map(r=>[r.id,JSON.parse(r.data)]));
  expect(by.get(board.id).fields[0]).toMatchObject({name:'Our budget',format:'currency'});expect(by.get(root.id).templateVersion).toBe(2);expect(by.get(view.id)).toMatchObject({name:'Renamed by team',config:{filters:[{key:'title',op:'contains',value:'team'}]}});
  const again=await call('install_template',{bundled:'fixture',mode:'upgrade',dryRun:true});expect(again.json.alreadyCurrent).toBe(true);
 });
 it('rejects a frozen upgrade after a human edits its source fields',async()=>{
  const {board}=await setup(enabled);const {json:p}=await call('install_template',{bundled:'fixture',mode:'upgrade',dryRun:true});
  await aiPreviewApi.request('/'+p.previewId+'/decision',{method:'POST',headers:f.auth('alice'),body:JSON.stringify({decision:'approve',argsHash:p.argsHash})},f.env,ctx);
  await applyChanges(f.env,'alice',[{id:board.id,collection:'boards',ts:0,patch:{fields:[{id:'money',name:'Changed after approval',type:'number',format:'currency',currency:'USD'}]}}],{serverTs:true});
  const result=await call('execute_preview',{previewId:p.previewId,argsHash:p.argsHash});expect(result.result.isError).toBe(true);
  expect(JSON.parse((await f.db.prepare('SELECT data FROM records WHERE id=?').bind(board.id).first<string>('data'))!).fields[0].currency).toBe('USD');
 });
});
