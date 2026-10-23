// Website inbox reads and proposals with per-space access ENABLED, measured on
// 1,000 inbox rows inside the production invocation budget (45 bindings).
import {afterEach,expect,it,vi} from 'vitest';
const handlers=vi.hoisted(()=>new Map<string,(a:Record<string,unknown>)=>Promise<{content:{text:string}[];isError?:boolean}>>());
vi.mock('@modelcontextprotocol/server',()=>({McpServer:class{registerTool(n:string,_m:unknown,f:never){handlers.set(n,f);}registerPrompt(){}}}));
vi.mock('agents/mcp/server',()=>({createMcpHandler:vi.fn()}));
vi.mock('../worker/events',async o=>({...await o<typeof import('../worker/events')>(),scheduleOutbox:vi.fn()}));
import {openAuditFixture,type AuditFixture} from './audit-fixture';
import {reviewMeter} from './reviewMetrics';
import {withD1Budget} from '../worker/d1budget';
import {buildDigest} from '../worker/aiDigest';
import {createWorkspaceServer} from '../worker/mcp';
import {WEBSITE_INBOX_BOARD,WEBSITE_INBOX_ID} from '../shared/websiteInbox';

let f:AuditFixture;afterEach(async()=>f?.dispose());

it('digest, website_digest and a 500-record triage proposal stay inside the budget with access enabled',async()=>{
  f=await openAuditFixture();
  await f.db.batch([
    f.db.prepare('UPDATE access_state SET enabled=1'),
    f.db.prepare(`INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES(?,?,?,'{}',1,'space-core')`).bind(WEBSITE_INBOX_ID,'boards',JSON.stringify(WEBSITE_INBOX_BOARD)),
  ]);
  const now=Date.now();
  await f.db.prepare(`WITH RECURSIVE n(i) AS(VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1000)
    INSERT INTO records(id,collection,data,field_ts,seq,space_id) SELECT 'web_'||i,'tasks',json_object('title','Project application · Person '||i,'boardId',?,'status','new','createdAt',?-i*60000,
      'p_wi_family',CASE i%3 WHEN 0 THEN 'consulting' WHEN 1 THEN 'join' ELSE 'patrons' END,'p_wi_received',date('now'),'websiteEventAt',?-i*60000),'{}',i+1,'space-core' FROM n`).bind(WEBSITE_INBOX_ID,now,now).run();
  const measurements:{name:string;bindings:number}[]=[];
  async function measure<T>(name:string,run:(env:typeof f.env)=>Promise<T>):Promise<T>{
    const meter=reviewMeter(f.db),env=withD1Budget({...f.env,DB:meter.db},45);
    const out=await run(env);
    measurements.push({name,bindings:meter.metrics.bindings});
    expect(meter.metrics.bindings,name).toBeLessThanOrEqual(45);
    return out;
  }
  const digest=await measure('weekly digest (Website part)',env=>buildDigest(env,'alice'));
  expect(digest.website?.received).toBe(1000);
  const server=(env:typeof f.env)=>createWorkspaceServer({env,ectx:f.ctx,userId:'alice',userRole:'admin',origin:'http://localhost',userByKey:new Map(),userNameById:new Map(),pageTitleById:new Map(),recordTitleById:new Map(),recordIdByTitle:new Map(),pageIdByTitle:new Map(),cachesReady:false,warnings:[],cs:null,toolName:''} as never);
  const call=async(env:typeof f.env,name:string,args:Record<string,unknown>)=>{server(env);const r=await handlers.get(name)!(args);return JSON.parse(r.content[0]!.text) as Record<string,any>;};
  const md=await measure('website_digest',env=>call(env,'website_digest',{}));
  expect(md.received.count,JSON.stringify(md).slice(0,200)).toBe(1000);
  const q=await measure('website_query (200, fields only)',env=>call(env,'website_query',{limit:200,includeAnswers:false}));
  expect(q.records).toHaveLength(200);
  const p=await measure('propose_website_triage (500)',env=>call(env,'propose_website_triage',{updates:Array.from({length:500},(_,i)=>({recordId:'web_'+(i+1),status:'In review',priority:'low'}))}));
  expect(p.humanApprovalRequired,JSON.stringify(p).slice(0,300)).toBe(true);
  console.log('website cost (access enabled, 1,000 rows):',JSON.stringify(measurements));
},120_000);
