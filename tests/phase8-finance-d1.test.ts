import {afterEach,describe,it,expect,vi} from 'vitest';
const handlers=vi.hoisted(()=>new Map<string,(a:unknown)=>Promise<{content:{text:string}[];isError?:boolean}>>());
vi.mock('@modelcontextprotocol/server',()=>({McpServer:class{registerTool(name:string,_meta:unknown,handler:(a:unknown)=>Promise<{content:{text:string}[]}>){handlers.set(name,handler);}registerPrompt(){}registerResource(){}},ResourceTemplate:class{}}));
vi.mock('agents/mcp/server',()=>({createMcpHandler:vi.fn()}));
import {createWorkspaceServer} from '../worker/mcp';
import {openAuditFixture,type AuditFixture} from './audit-fixture';
import {applyChanges} from '../worker/sync';
import {withD1Budget,d1BudgetRemaining} from '../worker/d1budget';
import {withWorkspaceContext} from '../worker/workspaceSettings';
import {collectFinance,financeApi} from '../worker/finance';
import {financeConfigSchema} from '../shared/financeConfig';
import {aiPreviewApi,executePreview,type PreviewOp} from '../worker/aiPreviews';
import {linkId} from '../shared/linkid';
let f:AuditFixture;const now=Date.parse('2026-10-29T12:00Z');
afterEach(async()=>{vi.restoreAllMocks();await f?.dispose();handlers.clear();});
const cfg=()=>financeConfigSchema.parse({databaseId:'projects'});
async function call(args:Record<string,unknown>,name='dashboard_snapshot'){
 const env=withWorkspaceContext(withD1Budget(f.env));
 createWorkspaceServer({env,ectx:f.ctx,userId:'alice',userRole:'admin',origin:'https://workspace.test',userByKey:new Map(),userNameById:new Map(),pageTitleById:new Map(),recordTitleById:new Map(),recordIdByTitle:new Map(),pageIdByTitle:new Map(),cachesReady:false,warnings:[],cs:null,toolName:''} as never);
 const result=await handlers.get(name)!(args);return {data:JSON.parse(result.content[0].text),error:result.isError,used:45-d1BudgetRemaining(env.DB)};
}
async function seed(enabled:boolean){
 vi.spyOn(Date,'now').mockReturnValue(now);f=await openAuditFixture();
 const rows=[
 {id:'projects',collection:'boards',patch:{name:'Projects',kind:'records',fields:[{id:'f_budget',name:'Budget',type:'number',format:'currency'},{id:'f_transactions',name:'Transactions',type:'relation',relation:{target:'money',primary:false,pairedFieldId:'f_project'}}]}},
 {id:'money',collection:'boards',patch:{name:'Transactions',kind:'records',fields:[{id:'f_amount',name:'Amount',type:'number',format:'currency'},{id:'f_type',name:'Type',type:'select',options:[{id:'expense',name:'Expense',color:''},{id:'income',name:'Income',color:''},{id:'budget',name:'Budget line',color:''}]},{id:'f_project',name:'Project',type:'relation',relation:{target:'projects',primary:true,pairedFieldId:'f_transactions'}}]}},
 {id:'products',collection:'boards',patch:{name:'Products',kind:'records',templateDbKey:'products',fields:[{id:'f_price',name:'Price',type:'number',format:'currency'},{id:'f_cost',name:'Cost',type:'number',format:'currency'},{id:'f_margin',name:'Margin',type:'text'}]}},
 {id:'project',collection:'tasks',patch:{boardId:'projects',title:'Current project',p_f_budget:100,description:'NEVER_INCLUDE_PRIVATE_BODY'}},
 {id:'expense',collection:'tasks',patch:{boardId:'money',title:'Materials',p_f_type:'expense',p_f_amount:20,description:'NEVER_INCLUDE_PRIVATE_BODY'}},
 {id:'income',collection:'tasks',patch:{boardId:'money',title:'Funding',p_f_type:'income',p_f_amount:60}},
 {id:'product',collection:'tasks',patch:{boardId:'products',title:'Cup',p_f_price:100,p_f_cost:60,p_f_margin:'NEVER_INCLUDE_PRIVATE_MARGIN'}},
 ...['expense','income'].map(id=>({id:linkId('relation','f_project',id,'project'),collection:'links',patch:{kind:'relation',fromType:'record',toType:'record',fromId:id,toId:'project',fieldId:'f_project'}})),
 ];
 expect((await applyChanges(f.env,'alice',rows.map(r=>({...r,ts:now})),{serverTs:true})).rejected).toBe(0);
 await f.db.prepare('UPDATE access_state SET enabled=? WHERE id=1').bind(enabled?1:0).run();
}
for(const enabled of [false,true])describe(`finance actualD1 permissions ${enabled?'ENABLED':'DISABLED'}`,()=>{
 it('calculates exact authorized linked amounts with bounded calls and no bodies',async()=>{
  await seed(enabled);const env=withWorkspaceContext(withD1Budget(f.env)),[page]=await collectFinance(env,'alice',[cfg()],now);
  expect(page).toMatchObject({status:'ready',partial:false,items:[{id:'project',money:{budget:100,spent:20,income:60,remaining:80,currency:'INR',partial:false,transactionIds:['expense','income']}}]});
  expect(page.records.map(r=>r.id)).toEqual(['expense','income']);expect(JSON.stringify(page)).not.toContain('NEVER_INCLUDE');expect(45-d1BudgetRemaining(env.DB)).toBeLessThanOrEqual(30);
 });
 it('uses product mode and explicit schema/mixed-currency outcomes',async()=>{
  await seed(enabled);const [product]=await collectFinance(withWorkspaceContext(withD1Budget(f.env)),'alice',[financeConfigSchema.parse({databaseId:'products',mode:'product'})],now);
  expect(product.items[0].economics).toMatchObject({price:100,cost:60,difference:40,marginPercent:40,partial:false});expect(JSON.stringify(product)).not.toContain('NEVER_INCLUDE');
  const money=await f.db.prepare("SELECT data FROM records WHERE id='money'").first<{data:string}>();const fields=JSON.parse(money!.data).fields;fields[0].currency='USD';await applyChanges(f.env,'alice',[{id:'money',collection:'boards',patch:{fields},ts:now}],{serverTs:true});
  const [mixed]=await collectFinance(withWorkspaceContext(withD1Budget(f.env)),'alice',[cfg()],now);expect(mixed.items[0].money).toMatchObject({error:'mixed_currency',spent:null,currencies:['INR','USD']});
 });
 it('supports exact/root filters and distinguishes missing sources from an empty database',async()=>{
  await seed(enabled);const env=()=>withWorkspaceContext(withD1Budget(f.env));
  const [filtered,wrong,missing]=await collectFinance(env(),'alice',[financeConfigSchema.parse({databaseId:'projects',filters:[{key:'title',op:'contains',value:'no match'}]}),financeConfigSchema.parse({databaseId:'project'}),financeConfigSchema.parse({recordId:'unknown'})],now);
  expect(filtered).toMatchObject({status:'ready',items:[]});expect(wrong).toMatchObject({status:'source_unavailable'});expect(missing).toMatchObject({status:'source_unavailable'});
 });
 it('keeps dashboard MCP and direct calculation in parity, including Products database context',async()=>{
  await seed(enabled);await applyChanges(f.env,'alice',[{id:'review',collection:'pages',patch:{title:'Finance review'},ts:now},{id:'budget',collection:'blocks',patch:{pageId:'review',type:'budget',databaseId:'projects',order:'a0'},ts:now}],{serverTs:true});
  const [direct]=await collectFinance(withWorkspaceContext(withD1Budget(f.env)),'alice',[cfg()],now),snapshot=await call({pageId:'review'});
  expect(snapshot.error,JSON.stringify(snapshot.data)).not.toBe(true);expect(snapshot.data.blocks[0].items[0].money).toEqual(direct.items[0].money);expect(snapshot.data.blocks[0].items[0].url).toBe('https://workspace.test/boards/projects/tasks/project');expect(snapshot.used).toBeLessThanOrEqual(45);
  const products=await call({pageId:'products'});expect(products.error,JSON.stringify(products.data)).not.toBe(true);expect(products.data.blocks[0].items[0].economics).toMatchObject({difference:40,marginPercent:40});expect(products.used).toBeLessThanOrEqual(45);
 });
 it('validates authenticated HTTP input and rejects unresolved record context',async()=>{
  await seed(enabled);const req=(body:string,auth=true)=>financeApi.request('https://local.test/',{method:'POST',headers:auth?f.auth('alice'):{},body},withWorkspaceContext(withD1Budget(f.env)));
  expect((await req(JSON.stringify([cfg()]))).status).toBe(200);expect((await req('[]',false)).status).toBe(401);expect((await req('{')).status).toBe(400);expect((await req(JSON.stringify([{recordId:'self'}]))).status).toBe(400);expect((await req(JSON.stringify([{databaseId:'projects',limit:21}]))).status).toBe(400);
 });
 it('excludes deleted transactions instead of silently returning a complete zero',async()=>{
  await seed(enabled);await applyChanges(f.env,'alice',[{id:'expense',collection:'tasks',patch:{deleted:true},ts:now}],{serverTs:true});const [page]=await collectFinance(withWorkspaceContext(withD1Budget(f.env)),'alice',[cfg()],now);
  // Removed entries do not contribute to active totals in either permission mode.
  expect(page.records.map(r=>r.id)).not.toContain('expense');expect(page.items[0].money).toMatchObject({spent:0,partial:false,transactionIds:['income']});
 });
 it('combines health and budget blocks within the invocation budget',async()=>{
  await seed(enabled);await applyChanges(f.env,'alice',[{id:'combined',collection:'pages',patch:{title:'Project review'},ts:now},{id:'health-block',collection:'blocks',patch:{pageId:'combined',type:'projecthealth',databaseId:'projects',order:'a0'},ts:now},{id:'budget-block',collection:'blocks',patch:{pageId:'combined',type:'budget',databaseId:'projects',order:'a1'},ts:now}],{serverTs:true});
  const result=await call({pageId:'combined'});expect(result.error,JSON.stringify(result.data)).not.toBe(true);expect(result.used).toBeLessThanOrEqual(45);
  const budget=result.data.blocks.find((b:{type:string})=>b.type==='budget');expect(budget,JSON.stringify(result.data)).toMatchObject({status:'ready',items:[{money:{spent:20,remaining:80}}]});
 });
 it('keeps collection cost flat as the number of projects grows',async()=>{
  await seed(enabled);await applyChanges(f.env,'alice',Array.from({length:19},(_,i)=>({id:'project'+i,collection:'tasks',patch:{boardId:'projects',title:'Project '+i,p_f_budget:100},ts:now})),{serverTs:true});
  const env=withWorkspaceContext(withD1Budget(f.env)),[page]=await collectFinance(env,'alice',[financeConfigSchema.parse({databaseId:'projects',limit:20})],now);expect(page.items).toHaveLength(20);expect(page.partial).toBe(false);expect(45-d1BudgetRemaining(env.DB)).toBeLessThanOrEqual(30);
 });
});

it('redacts private sources and fails closed for disabled principals',async()=>{
 await seed(true);await f.db.batch([f.db.prepare("UPDATE spaces SET default_access='private' WHERE id='space-core'"),f.db.prepare("INSERT OR REPLACE INTO space_members(space_id,user_id,role) VALUES('space-core','alice','owner')")]);
 const [page]=await collectFinance(withWorkspaceContext(withD1Budget(f.env)),'bob',[cfg()],now);expect(page).toMatchObject({status:'source_unavailable',items:[],records:[]});expect(JSON.stringify(page)).not.toContain('Current project');
 await f.db.prepare("UPDATE users SET disabled_at=? WHERE id='alice'").bind(now).run();await expect(collectFinance(withWorkspaceContext(withD1Budget(f.env)),'alice',[cfg()],now)).rejects.toThrow('unauthenticated');
});
for(const enabled of [false,true])it(`refuses a changed source snapshot with permissions ${enabled}`,async()=>{
 await seed(enabled);let changed=false;
 const wrap=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(statement,{get(target,key){
  if(key==='bind')return(...values:Parameters<D1PreparedStatement['bind']>)=>wrap(target.bind(...values),sql);
  if(key==='all')return async()=>{const result=await target.all();if(!changed&&sql.includes("'root' bucket")){changed=true;await applyChanges(f.env,'alice',[{id:'project',collection:'tasks',patch:{p_f_budget:120},ts:now}],{serverTs:true});}return result;};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 const database=new Proxy(f.db,{get(target,key){if(key==='prepare')return(sql:string)=>wrap(target.prepare(sql),sql);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const response=await financeApi.request('https://local.test/',{method:'POST',headers:f.auth('alice'),body:JSON.stringify([cfg()])},withWorkspaceContext(withD1Budget({...f.env,DB:database})));expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'finance_sources_changed'});expect(changed).toBe(true);
});

it('marks a bounded project selection partial instead of claiming full coverage',async()=>{
 await seed(true);for(let offset=0;offset<205;offset+=100)expect((await applyChanges(f.env,'alice',Array.from({length:Math.min(100,205-offset)},(_,i)=>({id:'root-'+String(offset+i).padStart(3,'0'),collection:'tasks',patch:{boardId:'projects',title:'Root '+(offset+i),p_f_budget:100},ts:now})),{serverTs:true})).rejected).toBe(0);
 const env=withWorkspaceContext(withD1Budget(f.env)),[page]=await collectFinance(env,'alice',[financeConfigSchema.parse({databaseId:'projects',limit:20})],now);expect(page.items).toHaveLength(20);expect(page).toMatchObject({partial:true,partialSources:['record_selection']});expect(45-d1BudgetRemaining(env.DB)).toBeLessThanOrEqual(30);
});
it('rechecks account authority after the snapshot has been read',async()=>{
 await seed(true);let disabled=false;
 const wrap=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(statement,{get(target,key){
  if(key==='bind')return(...values:Parameters<D1PreparedStatement['bind']>)=>wrap(target.bind(...values),sql);
  if(key==='all')return async()=>{const result=await target.all();if(!disabled&&sql.includes('root_boards AS')){disabled=true;await f.db.prepare("UPDATE users SET disabled_at=? WHERE id='alice'").bind(now).run();}return result;};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 const database=new Proxy(f.db,{get(target,key){if(key==='prepare')return(sql:string)=>wrap(target.prepare(sql),sql);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 await expect(collectFinance(withWorkspaceContext(withD1Budget({...f.env,DB:database})),'alice',[cfg()],now)).rejects.toThrow();expect(disabled).toBe(true);
});

it('copies only validated self-budget config through frozen session-approved conversion',async()=>{
 await seed(true);await applyChanges(f.env,'alice',[{id:'template',collection:'pages',patch:{title:'Budget Review',isTemplate:true},ts:now},{id:'self-budget',collection:'blocks',patch:{pageId:'template',type:'budget',recordId:'self',databaseId:'unrelated',heading:'Our budget',mode:'project',order:'a0'},ts:now},{id:'named-budget',collection:'blocks',patch:{pageId:'template',type:'budget',recordId:'product',databaseId:'products',mode:'product',order:'a1'},ts:now}],{serverTs:true});
 const proposal=await call({recordId:'product',toDatabaseId:'projects',templateId:'template'},'convert_record');expect(proposal.error,JSON.stringify(proposal.data)).not.toBe(true);expect(proposal.data.humanApprovalRequired).toBe(true);
 const saved=await f.db.prepare('SELECT plan_json FROM ai_previews WHERE id=?').bind(proposal.data.previewId).first<{plan_json:string}>(),plan=JSON.parse(saved!.plan_json) as PreviewOp[],budget=plan.filter(op=>op.collection==='blocks'&&op.patch.type==='budget');
 expect(plan.filter(op=>op.collection==='boards')).toEqual([]);expect(budget).toHaveLength(1);expect(budget[0].patch).toMatchObject({databaseId:'projects',recordId:'self',heading:'Our budget',parentType:'record'});
 const env=()=>withWorkspaceContext(withD1Budget(f.env));await expect(executePreview(env(),'alice',proposal.data.previewId,proposal.data.argsHash)).rejects.toThrow('human_approval_required');
 // Automated disposable session approval, not an actual person's acceptance.
 const decision=await aiPreviewApi.request(`https://local.test/${proposal.data.previewId}/decision`,{method:'POST',headers:f.auth('alice'),body:JSON.stringify({decision:'approve',argsHash:proposal.data.argsHash})},f.env,f.ctx);expect(decision.status).toBe(200);
 expect(await executePreview(env(),'alice',proposal.data.previewId,proposal.data.argsHash)).toMatchObject({completed:true});expect(await executePreview(env(),'alice',proposal.data.previewId,proposal.data.argsHash)).toMatchObject({completed:true,replayed:true});
});
