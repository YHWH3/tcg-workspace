import {afterEach,describe,it,expect,vi} from 'vitest';
import {openAuditFixture,ctx,type AuditFixture} from './audit-fixture';
import {withD1Budget,d1BudgetRemaining} from '../worker/d1budget';
import {applyChanges} from '../worker/sync';
const tools=vi.hoisted(()=>new Map<string,(args:any)=>Promise<any>>());
vi.mock('@modelcontextprotocol/server',()=>({McpServer:class{registerTool(name:string,_meta:unknown,fn:any){tools.set(name,fn);}registerPrompt(){}registerResource(){}},ResourceTemplate:class{}}));
vi.mock('agents/mcp/server',()=>({createMcpHandler:vi.fn()}));
vi.mock('../worker/events',async original=>({...await original<typeof import('../worker/events')>(),scheduleOutbox:vi.fn()}));
import {createWorkspaceServer} from '../worker/mcp';
let fx:AuditFixture|undefined;
afterEach(async()=>{vi.restoreAllMocks();await fx?.dispose();fx=undefined;});
async function call(name:string,args:any){const env=withD1Budget(fx!.env);createWorkspaceServer({env,ectx:ctx,userId:'alice',userRole:'admin',origin:'https://localhost',userByKey:new Map(),userNameById:new Map(),pageTitleById:new Map(),recordTitleById:new Map(),recordIdByTitle:new Map(),pageIdByTitle:new Map(),cachesReady:false,warnings:[],cs:null,toolName:''} as never);const result=await tools.get(name)!(args);expect(result.isError,JSON.stringify(result)).not.toBe(true);expect(45-d1BudgetRemaining(env.DB)).toBeLessThanOrEqual(45);return JSON.parse(result.content[0].text);}
describe.each([false,true])('locale MCP parity permissions=%s',enabled=>{
 it('agrees with workspace midnight in queries, metrics and overview and preserves explicit USD',async()=>{
  fx=await openAuditFixture();await fx.db.prepare('UPDATE access_state SET enabled=? WHERE id=1').bind(enabled?1:0).run();
  await fx.db.prepare("UPDATE workspace_settings SET time_zone='Asia/Kolkata',currency='INR' WHERE id='workspace'").run();
  const filters=[{key:'dueDate',op:'is',value:'today'}];
  await applyChanges(fx.env,'alice',[
   {id:'money',collection:'boards',ts:1,patch:{name:'Money',kind:'records',fields:[{id:'amount',name:'Amount',type:'number',format:'currency'},{id:'dollars',name:'Dollars',type:'number',format:'currency',currency:'USD'}],columns:[{id:'open',name:'Open'},{id:'done',name:'Done'}]}},
   ...['2026-10-24','2026-10-25'].map((dueDate,i)=>({id:'money-'+i,collection:'tasks' as const,ts:1,patch:{boardId:'money',title:'Money '+i,status:'open',dueDate,p_amount:1234.5,p_dollars:50}})),
   {id:'dashboard',collection:'pages',ts:1,patch:{title:'Dashboard'}},
   {id:'metric',collection:'blocks',ts:1,patch:{pageId:'dashboard',type:'metric',databaseId:'money',agg:'count',filters,order:'a0'}},
   {id:'currency-metric',collection:'blocks',ts:1,patch:{pageId:'dashboard',type:'metric',databaseId:'money',agg:'sum',fieldKey:'p_dollars',format:'currency',filters,order:'a1'}},
  ]);
  vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-10-24T20:00Z'));
  const overview=await call('workspace_overview',{});expect(overview.workspace).toMatchObject({timeZone:'Asia/Kolkata',currency:'INR',today:'2026-10-25'});
  const query=await call('query_records',{databaseId:'money',filters:[{field:'dueDate',op:'is',value:'today'}]});expect(query.rows.map((r:any)=>r.id)).toEqual(['money-1']);
  const dashboard=await call('dashboard_snapshot',{pageId:'dashboard'});expect(dashboard.blocks.find((b:any)=>b.id==='metric').ids).toEqual(['money-1']);expect(dashboard.blocks.find((b:any)=>b.id==='currency-metric')).toMatchObject({value:50,formattedValue:'$50.00',currency:'USD',currencySource:'field'});
  const board=await call('get_board',{boardId:'money'});expect(board.tasks[0].fields.Amount).toContain('₹');expect(board.tasks[0].fields.Dollars).toContain('$');
 });
});
