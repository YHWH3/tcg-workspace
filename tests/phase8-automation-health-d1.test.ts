import {afterEach,expect,it,vi} from 'vitest';
import {openAuditFixture,type AuditFixture} from './audit-fixture';
import {applyChanges} from '../worker/sync';
import {automationsApi} from '../worker/automations';
import {collectAutomationHealth,AUTOMATION_HEALTH_SQL} from '../worker/automationHealth';
import {withD1Budget,d1BudgetRemaining} from '../worker/d1budget';
import type {AutomationHealthReport} from '../shared/automationHealth';
let f:AuditFixture;
const DAY=86_400_000,now=Date.parse('2026-11-03T12:00:00Z');
afterEach(async()=>{vi.restoreAllMocks();await f?.dispose();});
async function seed(enabled:boolean){
 vi.spyOn(Date,'now').mockReturnValue(now);f=await openAuditFixture();
 const changes=[...['b1','b2'].map(id=>({id,collection:'boards',patch:{name:id,kind:'records',columns:[{id:'new',name:'New'}],fields:[]}})),...['t1','t2'].map((id,i)=>({id,collection:'tasks',patch:{boardId:'b'+(i+1),title:'Source '+id,status:'new'}})),...['a1','a2'].map((id,i)=>({id,collection:'automations',patch:{name:'Automation '+id,databaseId:'b'+(i+1),trigger:{kind:'record.created'},enabled:false,actions:[]}})),{id:'f1',collection:'forms',patch:{databaseId:'b1',title:'Public form',fields:[],enabled:false}}];
 expect((await applyChanges(f.env,'alice',changes.map(row=>({...row,ts:now})),{serverTs:true})).rejected).toBe(0);
 const runs=[['r1','a1','retryable_failure',1,2,true],['r2','a1','terminal_failure',2,3,true],['r3','a1','completed',1,1,true],['r4','a1','retryable_failure',8,2,true],['r5','a2','retryable_failure',1,2,false],['future','a1','retryable_failure',-1,1,true]] as const;
 await f.db.batch(runs.map(([id,auto,status,age,attempts,payload])=>f.db.prepare('INSERT INTO automation_runs(id,automation_id,event_key,status,error,created_at,attempts,retry_at,payload,plan) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id,auto,'event-'+id,status,'NEVER_COPY_RUN_ERROR',now-age*DAY,attempts,now+1000,payload?JSON.stringify({private:'NEVER_COPY_RUN_PAYLOAD'}):null,JSON.stringify({private:'NEVER_COPY_RUN_PLAN'}))));
 const events=[['e1',5,null,null,{applied:[{id:'t1',after:{secret:'NEVER_COPY_EVENT_BODY'}}]}],['e2',1,now,null,{extra:[{recordId:'t1'}]}],['processed',8,null,now,{applied:[{id:'t1'}]}],['website',5,null,null,{notifications:[{targetId:'t1',body:'NEVER_COPY_NOTIFICATION'}]}],['mixed',5,null,null,{applied:[{id:'t1'},{id:'t2'}]}],['not-stuck',4,null,null,{applied:[{id:'t1'}]}]] as const;
 await f.db.batch(events.map(([id,attempts,terminal,processed,payload])=>f.db.prepare('INSERT INTO event_outbox(id,payload,created_at,attempts,terminal_at,processed_at,last_error) VALUES(?,?,?,?,?,?,?)').bind(id,JSON.stringify(payload),now-DAY,attempts,terminal,processed,'NEVER_COPY_EVENT_ERROR')));
 await f.db.batch([['s1','retryable_failure',true],['s2','retryable_failure',false],['s3','rejected',true]].map(([id,state,payload])=>f.db.prepare("INSERT INTO form_submissions(submission_id,form_id,state,created_at,attempts,error,payload) VALUES(?,'f1',?,?,2,?,?)").bind(id,state,now-DAY,JSON.stringify({error:'validation',body:'NEVER_COPY_FORM_ERROR'}),payload?'NEVER_COPY_FORM_BODY':null)));
 await f.db.batch([['p1','pending',4,'alice'],['p2','pending',2,'alice'],['p3','pending',4,'carol'],['p4','approved',4,'alice']].map(([id,status,age,approver])=>f.db.prepare("INSERT INTO approvals(id,target_type,target_id,status,requested_by,approver_id,note,created_at) VALUES(?,'record','t1',?,'bob',?,?,?)").bind(id,status,approver,'NEVER_COPY_APPROVAL_NOTE',now-Number(age)*DAY)));
 await f.db.prepare('UPDATE access_state SET enabled=?').bind(enabled?1:0).run();
}
const read=(user='alice',env=f.env)=>automationsApi.request('https://local.test/health',{headers:f.auth(user)},env,f.ctx);
for(const enabled of [false,true]){
 it(`collects safe operational state and participant approvals, permissions ${enabled}`,async()=>{
  await seed(enabled);const response=await read();expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('no-store');const report=await response.json() as AutomationHealthReport;
  expect(report.automations).toMatchObject([{id:'a1',failedCount:2,lastRunId:'r1',recovery:'automatic',errorClass:'unknown'},{id:'a2',failedCount:1,recovery:'blocked'}]);
  expect(report.events.map(row=>row.id).sort()).toEqual(['e1','e2','mixed','website']);expect(report.events.find(row=>row.id==='e2')?.recovery).toBe('stopped');
  expect(report.forms[0]).toMatchObject({id:'f1',failed7Days:3,failed30Days:3});expect(report.forms[0].failures.map(row=>row.recovery).sort()).toEqual(['automatic','blocked','stopped']);
  expect(report.approvals.map(row=>row.id)).toEqual(['p1']);expect(report.scheduler).toEqual({available:false,reason:'not_recorded'});expect(JSON.stringify(report)).not.toContain('NEVER_COPY');
 });
 it(`stays within8 binding calls including auth renewal and final credential fence, permissions ${enabled}`,async()=>{
  await seed(enabled);await f.db.prepare('UPDATE sessions SET last_seen_at=0').run();const env=withD1Budget(f.env),before=d1BudgetRemaining(env.DB),response=await read('alice',env);
  expect(response.status).toBe(200);expect(before-d1BudgetRemaining(env.DB)).toBe(7);
 });
}
it('rejects nonadmins and never treats a session role as current authority',async()=>{
 await seed(true);expect((await read('bob')).status).toBe(403);await f.db.prepare("UPDATE users SET workspace_role='member' WHERE id='alice'").run();expect((await read()).status).toBe(403);
 expect((await automationsApi.request('https://local.test/health',{},f.env)).status).toBe(401);
});
it('keeps private automations, approval targets and mixed-audience events out',async()=>{
 await seed(true);await f.db.batch([f.db.prepare("INSERT INTO spaces(id,name,default_access,created_at) VALUES('vault','Private','private',1)"),f.db.prepare("UPDATE records SET space_id='vault' WHERE id='b2'"),f.db.prepare("INSERT INTO approvals(id,target_type,target_id,status,requested_by,approver_id,created_at) VALUES('private','record','t2','pending','alice','alice',?)").bind(now-4*DAY)]);
 const report=await (await read()).json() as AutomationHealthReport;expect(report.automations.map(row=>row.id)).toEqual(['a1']);expect(report.events.map(row=>row.id)).not.toContain('mixed');expect(report.partial.events).toBe(true);expect(report.approvals.map(row=>row.id)).toEqual(['p1']);
});
function afterBatch(action:()=>Promise<void>,number=1){let calls=0;return new Proxy(f.db,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{const result=await target.batch(statements);if(++calls===number)await action();return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});}
it('fences role revocation, source changes and lost sessions during collection',async()=>{
 await seed(true);let db=afterBatch(async()=>{await f.db.prepare("UPDATE users SET workspace_role='member' WHERE id='alice'").run();});expect((await read('alice',{...f.env,DB:db})).status).toBe(403);
 await f.db.prepare("UPDATE users SET workspace_role='admin' WHERE id='alice'").run();db=afterBatch(async()=>{await applyChanges(f.env,'alice',[{id:'a1',collection:'automations',patch:{name:'Changed'},ts:now}],{serverTs:true});});expect((await read('alice',{...f.env,DB:db})).status).toBe(409);
 db=afterBatch(async()=>{await f.db.prepare("DELETE FROM sessions WHERE user_id='alice'").run();});expect((await read('alice',{...f.env,DB:db})).status).toBe(401);
});
it('does not claim automatic recovery for missing source references or exhausted events',async()=>{
 await seed(true);await f.db.batch([f.db.prepare("UPDATE event_outbox SET attempts=8 WHERE id='e1'"),f.db.prepare("INSERT INTO event_outbox(id,payload,created_at,attempts) VALUES('broken','not JSON',?,5)").bind(now)]);
 const report=await collectAutomationHealth(f.env,'alice',now);expect(report.events.find(row=>row.id==='e1')?.recovery).toBe('stopped');expect(report.events.map(row=>row.id)).not.toContain('broken');expect(report.partial.events).toBe(true);
});
it('groups1000 failed runs without growing binding costs and keeps source caps explicit',async()=>{
 await seed(true);await f.db.batch(Array.from({length:1000},(_,i)=>f.db.prepare("INSERT INTO automation_runs(id,automation_id,event_key,status,error,created_at,attempts,payload) VALUES(?,'a1',?,'retryable_failure','NEVER_COPY_BULK_ERROR',?,1,?)").bind('bulk-'+i,'bulk-event-'+i,now-1000-i,JSON.stringify({private:'NEVER_COPY_BULK_PAYLOAD'}))));
 await f.db.batch(Array.from({length:55},(_,i)=>f.db.prepare("INSERT INTO event_outbox(id,payload,created_at,attempts) VALUES(?,?,?,5)").bind('capped-'+i,JSON.stringify({applied:[{id:'t1'}]}),now-i)));
 const env=withD1Budget(f.env),before=d1BudgetRemaining(env.DB),response=await read('alice',env),report=await response.json() as AutomationHealthReport;
 expect(response.status).toBe(200);expect(report.automations.find(row=>row.id==='a1')!.failedCount).toBe(1002);expect(report.events).toHaveLength(50);expect(report.partial.events).toBe(true);expect(before-d1BudgetRemaining(env.DB)).toBeLessThanOrEqual(8);expect(JSON.stringify(report)).not.toContain('NEVER_COPY');
});
for(const enabled of [false,true])it(`MCP health agrees with REST, remains read-only and checks current admin, permissions ${enabled}`,async()=>{
 await seed(enabled);const {openBridge}=await import('../worker/assistant/bridge');const before=await f.db.prepare('SELECT MAX(seq) FROM records').first('MAX(seq)');
 const bridge=await openBridge(f.env,f.ctx,{userId:'alice',userRole:'member',origin:'https://localhost',provider:'simulated',model:'no-inference'});
 try{expect((await bridge.listTools()).map(tool=>tool.name)).toContain('automation_health');const result=await bridge.call('automation_health',{});expect(result.ok,JSON.stringify(result.json)).toBe(true);const rest=await (await read()).json() as AutomationHealthReport;expect(result.json).toMatchObject(rest);expect(result.json?.trust).toMatchObject({untrusted:true,instructions:false});expect(result.json?.url).toBe('https://localhost/automations/health');expect(result.text).not.toContain('NEVER_COPY');expect(result.sourceIds).toContain('a1');}finally{await bridge.close();}
 const denied=await openBridge(f.env,f.ctx,{userId:'bob',userRole:'admin',origin:'https://localhost',provider:'simulated',model:'no-inference'});
 try{const result=await denied.call('automation_health',{});expect(result.ok).toBe(false);expect(result.json).toMatchObject({error:'forbidden',status:403});}finally{await denied.close();}
 expect(await f.db.prepare('SELECT MAX(seq) FROM records').first('MAX(seq)')).toBe(before);
});
it('bounds all source inventories and refuses an event with too many source records',async()=>{
 await seed(true);const rows=[...Array.from({length:55},(_,i)=>({id:'cap-auto-'+i,collection:'automations',patch:{databaseId:'b1',name:'Capped rule '+i,enabled:false}})),...Array.from({length:45},(_,i)=>({id:'cap-form-'+i,collection:'forms',patch:{databaseId:'b1',title:'Capped form '+i,enabled:false}})),...Array.from({length:5},(_,i)=>({id:'cap-target-'+i,collection:'tasks',patch:{boardId:'b1',title:'Capped target '+i}}))];
 expect((await applyChanges(f.env,'alice',rows.map(row=>({...row,ts:now})),{serverTs:true})).rejected).toBe(0);
 await f.db.batch([...Array.from({length:55},(_,i)=>f.db.prepare("INSERT INTO automation_runs(id,automation_id,event_key,status,created_at) VALUES(?,?,?,'terminal_failure',?)").bind('cap-run-'+i,'cap-auto-'+i,'cap-event-'+i,now-DAY)),...Array.from({length:105},(_,i)=>f.db.prepare("INSERT INTO approvals(id,target_type,target_id,status,requested_by,approver_id,created_at) VALUES(?,'record','t1','pending','alice','alice',?)").bind('cap-approval-'+i,now-4*DAY)),f.db.prepare('UPDATE event_outbox SET payload=? WHERE id=\'e1\'').bind(JSON.stringify({applied:Array.from({length:5},(_,i)=>({id:'cap-target-'+i}))}))]);
 const env=withD1Budget(f.env),before=d1BudgetRemaining(env.DB),response=await read('alice',env),report=await response.json() as AutomationHealthReport;
 expect(response.status).toBe(200);expect(report.automations).toHaveLength(50);expect(report.approvals).toHaveLength(100);expect(report.events.map(row=>row.id)).not.toContain('e1');expect(report.partial).toMatchObject({automations:true,forms:true,events:true,approvals:true});expect(before-d1BudgetRemaining(env.DB)).toBeLessThanOrEqual(8);
});
it('keeps connector scopes and current revocation in the shared canonical gate',async()=>{
 await seed(true);await f.db.prepare("INSERT INTO ai_connections(id,user_id,client_id,spaces_json,created_at,expires_at) VALUES('health','alice','fixture','[]',1,?)").bind(now+DAY).run();
 const env={...f.env,CONNECTOR:{id:'health',version:1}},report=await collectAutomationHealth(env,'alice',now);expect(report.automations).toEqual([]);expect(report.forms).toEqual([]);expect(report.approvals).toEqual([]);expect(report.events).toEqual([]);
 await f.db.prepare("UPDATE ai_connections SET spaces_json='[\"space-core\"]',version=2 WHERE id='health'").run();await expect(collectAutomationHealth(env,'alice',now)).rejects.toThrow('access_reset_required');
});

it('uses the existing automation/time index for its real grouped lookup',async()=>{
 await seed(true);const plan=await f.db.prepare('EXPLAIN QUERY PLAN '+AUTOMATION_HEALTH_SQL[0]).bind(now-7*DAY,now).all<{detail:string}>();
 expect(plan.results.map(row=>row.detail).join('\n')).toMatch(/USING (?:COVERING )?INDEX idx_runs_auto \(automation_id=\? AND created_at/);
});
