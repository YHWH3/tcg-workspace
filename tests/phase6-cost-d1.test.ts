import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {openAuditFixture,type AuditFixture} from './audit-fixture';
import {reviewMeter} from './reviewMetrics';
import {withD1Budget} from '../worker/d1budget';
import {proposePreview,executePreview,aiPreviewApi} from '../worker/aiPreviews';
import {withReadGate} from '../worker/readAccess';
import {buildDigest,runWeeklyDigests} from '../worker/aiDigest';
import {registerReadTools} from '../worker/mcpReadTools';
import type {McpServer} from '@modelcontextprotocol/server';
vi.mock('../worker/events',async o=>({...await o<typeof import('../worker/events')>(),scheduleOutbox:vi.fn()}));
let f:AuditFixture;afterEach(async()=>f?.dispose());
it('records actual local D1 costs on 1000 rows and bounded approved executions',async()=>{
 f=await openAuditFixture();await f.db.batch([f.db.prepare('UPDATE access_state SET enabled=1'),f.db.prepare(`INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES('b','boards','{"name":"Tasks","columns":[{"id":"todo"},{"id":"done"}]}','{}',1,'space-core')`)]);
 await f.db.prepare(`WITH RECURSIVE n(i) AS(VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1000) INSERT INTO records(id,collection,data,field_ts,seq,space_id) SELECT 't'||i,'tasks',json_object('title','Fixed workload '||i,'boardId','b','status','todo','dueDate','2026-01-01'),'{}',i+1,'space-core' FROM n`).run();
 const measurements:unknown[]=[];
 async function measure(name:string,operation:(env:typeof f.env)=>Promise<unknown>){const meter=reviewMeter(f.db),env=withD1Budget({...f.env,DB:meter.db},45),start=performance.now();const result=await operation(env);expect(meter.metrics.bindings).toBeLessThanOrEqual(45);measurements.push({name,permissionMode:'ENABLED',metrics:{...meter.metrics},durationMs:performance.now()-start});return result;}
 await measure('digest-1000-records',async env=>{const d=await buildDigest(env,'alice');expect(d.truncated).toBe(true);expect(d.records).toHaveLength(500);});
 await measure('weekly-delivery-1000-records',async env=>{await runWeeklyDigests(env);expect(await f.db.prepare("SELECT outcome FROM ai_digest_runs WHERE user_id='alice'").first('outcome')).toBe('delivered');});
 await f.db.prepare(`INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES('dashboard','pages','{"title":"Measured dashboard"}','{}',1100,'space-core'),('dashboard-view','blocks','{"pageId":"dashboard","type":"view","databaseId":"b"}','{}',1101,'space-core')`).run();
 await measure('dashboard-links-1000-records',async env=>{
  let snapshot!:()=>Promise<{content:{text:string}[]}>;const server={registerTool:(name:string,_meta:unknown,fn:(args:Record<string,unknown>)=>Promise<{content:{text:string}[]}>)=>{if(name==='dashboard_snapshot')snapshot=()=>fn({pageId:'dashboard'});}} as unknown as McpServer;
  registerReadTools(server,{env:withReadGate(env,'alice'),userId:'alice',origin:'http://localhost'});
  const result=JSON.parse((await snapshot()).content[0].text);expect(result.blocks[0].records).toHaveLength(100);for(const record of result.blocks[0].records)expect(record.url).toBe('http://localhost/boards/b/tasks/'+record.id);expect(result.blocks[0].truncated).toBe(true);
 });
 const p=await measure('frozen-plan-150-records',async env=>proposePreview(withReadGate(env,'alice'),'alice','meeting_to_actions',{fixture:'1000'},Array.from({length:150},(_,i)=>({id:'new'+i,collection:'pages',patch:{title:'Reviewed '+i}})))) as {previewId:string;argsHash:string};
 expect((await aiPreviewApi.request(`/${p.previewId}/decision`,{method:'POST',headers:f.auth('alice'),body:JSON.stringify({decision:'approve',argsHash:p.argsHash})},f.env,f.ctx)).status).toBe(200);
 let completed=false;for(let i=0;i<10&&!completed;i++){const r=await measure('approved-execution-'+i,env=>executePreview(env,'alice',p.previewId,p.argsHash)) as {completed:boolean};completed=r.completed;}expect(completed).toBe(true);
 const directory=process.env.CERT_ARTIFACT_DIR??'.artifacts/phase6';mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'phase6-cost.json'),JSON.stringify({sourceSha:process.env.CERT_SOURCE_SHA??null,records:1000,permissionMode:'ENABLED',measurements,limitations:'Local Miniflare D1 row metadata and binding calls, not production billing or regional latency'},null,2));
});
