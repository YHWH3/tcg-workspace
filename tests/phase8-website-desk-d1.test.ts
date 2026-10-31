import {afterEach,describe,expect,it,vi} from 'vitest';
const handlers=vi.hoisted(()=>new Map<string,(a:Record<string,unknown>)=>Promise<{content:{text:string}[];isError?:boolean}>>());
vi.mock('@modelcontextprotocol/server',()=>({ResourceTemplate:class{},McpServer:class{registerResource(){}registerTool(n:string,_m:unknown,f:never){handlers.set(n,f);}registerPrompt(){}}}));
vi.mock('agents/mcp/server',()=>({createMcpHandler:vi.fn()}));
import {openAuditFixture,type AuditFixture} from './audit-fixture';
import {applyChanges} from '../worker/sync';
import {websiteQuery} from '../worker/website';
import {withReadGate} from '../worker/readAccess';
import {collectAttention} from '../worker/attention';
import {withD1Budget,d1BudgetRemaining} from '../worker/d1budget';
import {withWorkspaceContext} from '../worker/workspaceSettings';
import {WEBSITE_INBOX_BOARD,WEBSITE_INBOX_ID} from '../shared/websiteInbox';
import {createWorkspaceServer} from '../worker/mcp';
import {buildDigest} from '../worker/aiDigest';
let f:AuditFixture;
const now=Date.parse('2026-10-28T00:01:00+05:30');
afterEach(async()=>{vi.restoreAllMocks();await f?.dispose();handlers.clear();});
async function seed(enabled:boolean){
 vi.spyOn(Date,'now').mockReturnValue(now);f=await openAuditFixture();
 await f.db.prepare("UPDATE workspace_settings SET time_zone='Asia/Kolkata'").run();
 const patches=[{id:WEBSITE_INBOX_ID,collection:'boards',patch:{...WEBSITE_INBOX_BOARD,attention:{enabled:true,personKey:'assigneeId',dateKey:'dueDate',triage:true,triagers:'admins'},responseBands:[2,7],responseTargetDays:3}},
  ...[
   {id:'old',p_wi_received:'2026-10-20',assigneeId:null},
   {id:'mine',p_wi_received:'2026-10-21',assigneeId:'bob',dueDate:'2026-10-28'},
   {id:'future',p_wi_received:'2026-10-28',assigneeId:'bob',dueDate:'2026-10-29'},
   {id:'refund',p_wi_received:'2026-10-28',p_wi_stage:'refund_needed'},
   {id:'done',status:'done',p_wi_received:'2026-10-20'},
   {id:'archived',archived:true,p_wi_received:'2026-10-20'},
   {id:'reply',status:'new',p_wi_replied:'2026-10-26',p_wi_received:'2026-10-20'},
  ].map(({id,...patch},i)=>({id,collection:'tasks',patch:{title:id,boardId:WEBSITE_INBOX_ID,status:'new',createdAt:now-i*1000,...patch}}))];
 await applyChanges(f.env,'alice',patches.map(p=>({...p,ts:now})),{serverTs:true});
 await f.db.prepare('UPDATE access_state SET enabled=? WHERE id=1').bind(enabled?1:0).run();
}
async function query(userId:string,queue:'mine'|'open'|'unassigned'|'followup_due'){
 const env=withReadGate(withWorkspaceContext(withD1Budget(f.env)),userId),result=await websiteQuery(env,'https://workspace.test',{queue,includeAnswers:false},userId);
 expect(d1BudgetRemaining(env.DB)).toBeGreaterThanOrEqual(25);return result;
}
function call(name:string,args:Record<string,unknown>,userId='alice'){
 const env=withWorkspaceContext(withD1Budget(f.env));
 createWorkspaceServer({env,ectx:f.ctx,userId,userRole:userId==='alice'?'admin':'member',origin:'https://workspace.test',userByKey:new Map(),userNameById:new Map(),pageTitleById:new Map(),recordTitleById:new Map(),recordIdByTitle:new Map(),pageIdByTitle:new Map(),cachesReady:false,warnings:[],cs:null,toolName:''} as never);
 return handlers.get(name)!(args).then(r=>({data:JSON.parse(r.content[0]!.text),error:r.isError,used:45-d1BudgetRemaining(env.DB)}));
}
for(const enabled of [false,true])describe(`Website response desk permissions ${enabled?'ENABLED':'DISABLED'}`,()=>{
 it('filters queues before pagination using authenticated owner and workspace today',async()=>{
  await seed(enabled);
  expect((await query('bob','mine')).records?.map(r=>r.id)).toEqual(['mine','future']);
  expect((await query('bob','followup_due')).records?.map(r=>r.id)).toEqual(['mine']);
  expect((await query('bob','unassigned')).records?.map(r=>r.id)).toEqual(['old','refund']);
  expect((await query('alice','mine')).records).toEqual([]);
  const result=await call('website_query',{queue:'mine',includeAnswers:false},'bob');expect(result.data.records.map((r:{id:string})=>r.id)).toEqual(['mine','future']);
 });
 it('offers overdue Website work to owners and unassigned triagers, with refund severity2',async()=>{
  await seed(enabled);
  const env=withWorkspaceContext(withD1Budget(f.env)),admin=await collectAttention(env,'alice',{kinds:['website_aging']},now);
  expect(admin.items.map(r=>r.targetId).sort()).toEqual(['old','refund']);expect(admin.items.find(r=>r.targetId==='refund')).toMatchObject({severity:2,reason:'Refund needed'});
  expect(admin.items.find(r=>r.targetId==='old')).toMatchObject({ageDays:8,reason:'First reply overdue'});
  expect(45-d1BudgetRemaining(env.DB)).toBeLessThanOrEqual(12);
  const bob=await collectAttention(withWorkspaceContext(withD1Budget(f.env)),'bob',{kinds:['website_aging']},now);expect(bob.items.map(r=>r.targetId)).toEqual(['mine']);
  const carol=await collectAttention(withWorkspaceContext(withD1Budget(f.env)),'carol',{kinds:['website_aging']},now);expect(carol.items).toEqual([]);
 });
 it('keeps assignment/date triage behind approval and returns deterministic bands',async()=>{
  await seed(enabled);
  const result=await call('propose_website_triage',{updates:[{recordId:'old',assigneeId:'bob',dueDate:'2026-10-29'}]});expect(result.error).not.toBe(true);expect(result.data.humanApprovalRequired).toBe(true);
  const unchanged=await f.db.prepare("SELECT data FROM records WHERE id='old'").first<string>('data');expect(JSON.parse(unchanged!).assigneeId).toBeNull();
  await f.db.prepare("UPDATE users SET disabled_at=? WHERE id='bob'").bind(now).run();
  expect((await call('propose_website_triage',{updates:[{recordId:'old',assigneeId:'bob'}]})).error).toBe(true);
  const digest=await call('website_digest',{});expect(digest.data.targetBreaches.count).toBe(2);expect(digest.data.responseBands.map((g:{count:number})=>g.count)).toEqual([2,1,1]);expect(digest.data.targetBreaches.urls[0]).toMatch(/^https:\/\/workspace.test\//);
  const weeklyEnv=withWorkspaceContext(withD1Budget(f.env)),weekly=await buildDigest(weeklyEnv,'alice',now);
  expect(weekly.website?.responseBands.map(g=>g.count)).toEqual(digest.data.responseBands.map((g:{count:number})=>g.count));
  expect(weekly.website?.targetBreaches).toBe(2);expect(weekly.website?.targetDays).toBe(3);
  expect(45-d1BudgetRemaining(weeklyEnv.DB)).toBeLessThanOrEqual(45);
 });
 it('uses the dashboard default for invalid stored reply targets before capping attention',async()=>{
  await seed(enabled);
  for(const responseTargetDays of [4000,-1,'30',3.2]){
   await applyChanges(f.env,'alice',[{id:WEBSITE_INBOX_ID,collection:'boards',patch:{responseTargetDays},ts:now}],{serverTs:true});
   const result=await collectAttention(withWorkspaceContext(withD1Budget(f.env)),'alice',{kinds:['website_aging']},now);
   expect(result.items.map(r=>r.targetId).sort(),String(responseTargetDays)).toEqual(['old','refund']);
  }
 });
});
it('hides private Website queues and response attention from unrelated members',async()=>{
 // Built-in Website roots are pinned. Restrict their actual space in this
 // disposable permission fixture rather than trying to move a built-in root.
 await seed(true);await f.db.batch([f.db.prepare("UPDATE spaces SET default_access='private' WHERE id='space-core'"),f.db.prepare("INSERT OR REPLACE INTO space_members(space_id,user_id,role) VALUES('space-core','alice','owner')")]);
 expect(await query('bob','open')).toMatchObject({error:'website_inbox_unavailable'});
 expect((await collectAttention(withWorkspaceContext(withD1Budget(f.env)),'bob',{kinds:['website_aging']},now)).items).toEqual([]);
});
