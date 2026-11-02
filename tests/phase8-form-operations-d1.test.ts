import {afterEach,expect,it,vi} from 'vitest';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {openAuditFixture,type AuditFixture} from './audit-fixture';
import {applyChanges} from '../worker/sync';
import {formsApi} from '../worker/forms';
import {collectFormOperations,FORM_OPERATIONS_SQL} from '../worker/formOperations';
import {withD1Budget,d1BudgetRemaining} from '../worker/d1budget';
import {createReadGate} from '../worker/readAccess';
import {WEBSITE_INBOX_ID} from '../shared/websiteInbox';
import type {FormOperationsReport} from '../shared/formOperations';

let f:AuditFixture;
const now=Date.parse('2026-11-03T12:00:00Z'),DAY=86_400_000;
afterEach(async()=>{vi.restoreAllMocks();await f?.dispose();});
async function seed(enabled:boolean){
  vi.spyOn(Date,'now').mockReturnValue(now);f=await openAuditFixture();
  const rows=[
    ...['b1','b2',WEBSITE_INBOX_ID].map(id=>({id,collection:'boards',patch:{name:id,kind:'records',columns:[{id:'new',name:'New'},{id:'done',name:'Done'}],fields:[]}})),
    ...['f1','f2'].map((id,i)=>({id,collection:'forms',patch:{title:'Synthetic form '+id,databaseId:'b'+(i+1),fields:[{fieldKey:'title',label:'Name'}],successMessage:'Recorded',enabled:true,notifyUserIds:[]}})),
    ...['new','done','moved','old'].map(id=>({id:'record-'+id,collection:'tasks',patch:{boardId:id==='moved'?'b2':'b1',title:'Synthetic '+id,status:id==='done'?'done':'new'}})),
    {id:'website-record',collection:'tasks',patch:{boardId:WEBSITE_INBOX_ID,title:'Synthetic Website intake',status:'new',createdAt:now-DAY,p_secret:'NEVER_COPY_WEBSITE_ANSWERS'}},
  ];
  expect((await applyChanges(f.env,'alice',rows.map(row=>({...row,ts:now})),{serverTs:true})).rejected).toBe(0);
  const submissions:[string,string,number,string|null,string|null][]=[
    ['pending','pending',1,null,null],['processing','processing',2,null,null],
    ['retry','retryable_failure',3,null,JSON.stringify({error:'temporary_failure',private:'NEVER_COPY_ERROR'})],
    ['rejected','rejected',4,null,JSON.stringify({error:'validation',fieldErrors:{secret:'NEVER_COPY_FIELD_ERROR'}})],
    ['accepted','accepted',5,'record-new',null],['done','accepted',15,'record-done',null],
    ['boundary30','pending',30,null,null],['outside','rejected',31,null,'not JSON: NEVER_COPY_RAW_ERROR'],
    ['old','accepted',40,'record-old',null],['future','pending',-1,null,null],
    ['moved','accepted',6,'record-moved',null],
  ];
  await f.db.batch(submissions.map(([id,state,age,recordId,error])=>f.db.prepare(`INSERT INTO form_submissions(submission_id,form_id,state,record_id,error,created_at,attempts,retry_at,payload,plan,receipt)
    VALUES(?,'f1',?,?,?,?,2,?,'NEVER_COPY_PAYLOAD','NEVER_COPY_PLAN','NEVER_COPY_RECEIPT')`).bind(id,state,recordId,error,now-age*DAY,now+60_000)));
  await f.db.prepare('UPDATE access_state SET enabled=?').bind(enabled?1:0).run();
}
const read=(path='/operations',user='alice',env=f.env)=>formsApi.request('https://local.test'+path,{headers:f.auth(user)},env,f.ctx);

for(const enabled of [false,true]){
  it(`returns operational counts, safe failures and current first-stage records, permissions ${enabled}`,async()=>{
    await seed(enabled);const response=await read();expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('no-store');
    const report=await response.json() as FormOperationsReport,form=report.forms.find(form=>form.id==='f1')!;
    expect(form.counts.last7Days).toEqual({pending:1,processing:1,retryable_failure:1,rejected:1,accepted:2});
    expect(form.counts.last30Days).toEqual({pending:2,processing:1,retryable_failure:1,rejected:1,accepted:3});
    expect(form.failures.map(row=>row.errorClass).sort()).toEqual(['processing','validation']);
    expect(form.followups.map(row=>row.recordId).sort()).toEqual(['record-new','record-old']);
    expect(report.website).toMatchObject({available:true,partial:false,records:[{id:'website-record',title:'Synthetic Website intake'}]});
    expect(report.partial).toEqual({forms:false,failures:false,followups:false});expect(JSON.stringify(report)).not.toContain('NEVER_COPY');
    const scoped=await read('/f1/operations?followupDays=10');expect(scoped.status).toBe(200);const result=await scoped.json() as FormOperationsReport;
    expect(result.forms).toHaveLength(1);expect(result.forms[0].followups.map(row=>row.recordId)).toEqual(['record-old']);
  });
  it(`uses at most6 binding calls including renewal and final credential fence, permissions ${enabled}`,async()=>{
    await seed(enabled);await f.db.prepare('UPDATE sessions SET last_seen_at=0').run();
    const env=withD1Budget(f.env),before=d1BudgetRemaining(env.DB),response=await read('/operations','alice',env);
    expect(response.status).toBe(200);expect(before-d1BudgetRemaining(env.DB)).toBeLessThanOrEqual(6);
    const direct=withD1Budget(f.env),start=d1BudgetRemaining(direct.DB);await collectFormOperations(direct,'alice',{followupDays:3},now);expect(start-d1BudgetRemaining(direct.DB)).toBe(3);
  });
}

it('uses canonical edit rights, including private-space isolation for workspace admins',async()=>{
  await seed(true);await f.db.batch([
    f.db.prepare("INSERT INTO spaces(id,name,default_access,created_at) VALUES('vault','Private destination','private',1)"),
    f.db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('vault','carol','owner')"),
    f.db.prepare("UPDATE records SET space_id='vault' WHERE id='b2'"),
    f.db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('space-core','bob','viewer')"),
  ]);
  const alice=await (await read()).json() as FormOperationsReport;expect(alice.forms.map(row=>row.id)).toEqual(['f1']);
  const bob=await (await read('/operations','bob')).json() as FormOperationsReport;expect(bob.forms).toEqual([]);expect(bob.website.available).toBe(true);
  expect((await read('/f1/operations','bob')).status).toBe(404);expect((await read('/missing/operations','bob')).status).toBe(404);
  const carol=await (await read('/operations','carol')).json() as FormOperationsReport;expect(carol.forms.map(row=>row.id)).toEqual(['f1','f2']);
  const decision=await createReadGate(f.db,'bob').decideEditable(['f1','b1']);expect(decision.readable.has('f1')).toBe(true);expect(decision.editable.size).toBe(0);
});

it('validates options before reading journals and keeps config routes intact',async()=>{
  await seed(true);for(const path of ['/operations?followupDays=0','/operations?followupDays=1.5','/operations?followupDays=3651','/operations?databaseId='+('x'.repeat(65))])expect((await read(path)).status).toBe(400);
  expect((await formsApi.request('https://local.test/operations',{},f.env)).status).toBe(401);
  const config=await read('/f1');expect(config.status).toBe(200);expect(await config.json()).toMatchObject({form:{title:'Synthetic form f1'},tokens:[]});
});

function afterProjection(action:()=>Promise<void>,batchNumber=1){
  let calls=0;
  return new Proxy(f.db,{get(target,key){
    if(key==='batch')return async(statements:D1PreparedStatement[])=>{const result=await target.batch(statements);if(++calls===batchNumber)await action();return result;};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
}
it('refuses changed record versions instead of returning a false-empty followup list',async()=>{
  await seed(true);const db=afterProjection(async()=>{await applyChanges(f.env,'alice',[{id:'record-new',collection:'tasks',patch:{status:'done'},ts:now}],{serverTs:true});});
  const response=await read('/f1/operations','alice',{...f.env,DB:db});expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'form_operations_sources_changed',retryable:true});
});
it('fences disablement and session revocation during a read',async()=>{
  await seed(true);let db=afterProjection(async()=>{await f.db.prepare("UPDATE users SET disabled_at=? WHERE id='alice'").bind(now).run();});
  expect((await read('/operations','alice',{...f.env,DB:db})).status).toBe(409);
  await f.db.prepare("UPDATE users SET disabled_at=NULL WHERE id='alice'").run();db=afterProjection(async()=>{await f.db.prepare("DELETE FROM sessions WHERE user_id='alice'").run();});
  const response=await read('/operations','alice',{...f.env,DB:db});expect(response.status).toBe(401);expect(await response.json()).toEqual({error:'unauthenticated'});
});
it('keeps deleted, archived and moved records out and sanitizes unknown error text',async()=>{
  await seed(true);await applyChanges(f.env,'alice',[{id:'record-new',collection:'tasks',patch:{archived:true},ts:now},{id:'record-old',collection:'tasks',patch:{deleted:true},ts:now}],{serverTs:true});
  await f.db.prepare("UPDATE form_submissions SET error=? WHERE submission_id='retry'").bind(JSON.stringify({error:'NEVER_COPY_ARBITRARY_CODE'})).run();
  const report=await (await read()).json() as FormOperationsReport;expect(report.forms[0].followups).toEqual([]);expect(report.forms[0].failures.find(row=>row.submissionId==='retry')?.errorClass).toBe('unknown');expect(JSON.stringify(report)).not.toContain('NEVER_COPY');
});
it('uses a form-keyed journal index for the real operational query',async()=>{
  await seed(false);const plans=await f.db.batch<{detail:string}>(FORM_OPERATIONS_SQL.map(sql=>f.db.prepare('EXPLAIN QUERY PLAN '+sql).bind(null,null,now-30*DAY,now-7*DAY,now-3*DAY,now,WEBSITE_INBOX_ID)));
  const plan=plans.flatMap(result=>result.results);
  if(process.env.FORM_OPS_PLAN_PATH){mkdirSync(dirname(process.env.FORM_OPS_PLAN_PATH),{recursive:true});writeFileSync(process.env.FORM_OPS_PLAN_PATH,JSON.stringify(plan,null,2));}
  expect(plan.map(row=>row.detail).join('\n')).toMatch(/SEARCH s USING COVERING INDEX idx_submissions_form_state_created \(form_id=\?/);
});

it('reports an incomplete candidate window even when capped references are deleted',async()=>{
  await seed(true);
  await f.db.batch(Array.from({length:7},(_,i)=>f.db.prepare("INSERT INTO form_submissions(submission_id,form_id,state,record_id,created_at) VALUES(?,'f2','accepted',?,?)").bind('capped-'+i,i===6?'last-live':'deleted-'+i,now-(100-i)*DAY)));
  await applyChanges(f.env,'alice',[{id:'last-live',collection:'tasks',patch:{boardId:'b2',title:'Still unresolved outside first window',status:'new'},ts:now}],{serverTs:true});
  const report=await (await read()).json() as FormOperationsReport;
  expect(report.forms.find(form=>form.id==='f2')!.followups).toEqual([]);expect(report.partial.followups).toBe(true);
  const scoped=await (await read('/f2/operations')).json() as FormOperationsReport;
  expect(scoped.forms[0].followups.map(row=>row.recordId)).toEqual(['last-live']);expect(scoped.partial.followups).toBe(false);
});
it('keeps counts exact and binding work flat for 1000 representative submissions',async()=>{
  await seed(true);const states=['pending','processing','retryable_failure','rejected','accepted'];
  await f.db.batch(Array.from({length:1000},(_,i)=>f.db.prepare('INSERT INTO form_submissions(submission_id,form_id,state,created_at,error) VALUES(?,?,?,?,?)').bind('bulk-'+String(i).padStart(4,'0'),'f2',states[i%5],now-(i%2===0?2:15)*DAY,JSON.stringify({error:'validation',private:'NEVER_COPY_BULK'}))));
  await f.db.prepare('UPDATE sessions SET last_seen_at=0').run();const env=withD1Budget(f.env),before=d1BudgetRemaining(env.DB);
  const response=await read('/operations','alice',env);expect(response.status).toBe(200);const report=await response.json() as FormOperationsReport,form=report.forms.find(form=>form.id==='f2')!;
  expect(form.counts.last30Days).toEqual(Object.fromEntries(states.map(state=>[state,200])));expect(form.counts.last7Days).toEqual(Object.fromEntries(states.map(state=>[state,100])));
  expect(form.failures).toHaveLength(10);expect(report.partial.failures).toBe(true);expect(before-d1BudgetRemaining(env.DB)).toBeLessThanOrEqual(6);expect(JSON.stringify(report)).not.toContain('NEVER_COPY');
});
it('bounds the form and Website inventories without presenting them as complete',async()=>{
  await seed(true);const rows=[...Array.from({length:42},(_,i)=>({id:'extra-form-'+i,collection:'forms',patch:{databaseId:'b1',title:'Extra '+i}})),...Array.from({length:151},(_,i)=>({id:'extra-website-'+i,collection:'tasks',patch:{boardId:WEBSITE_INBOX_ID,title:'Synthetic intake '+i,createdAt:now-i*1000}}))];
  expect((await applyChanges(f.env,'alice',rows.map(row=>({...row,ts:now})),{serverTs:true})).rejected).toBe(0);
  const env=withD1Budget(f.env),before=d1BudgetRemaining(env.DB),response=await read('/operations','alice',env),report=await response.json() as FormOperationsReport;
  expect(response.status).toBe(200);expect(report.forms).toHaveLength(40);expect(report.partial.forms).toBe(true);expect(report.website.records).toHaveLength(150);expect(report.website.partial).toBe(true);expect(before-d1BudgetRemaining(env.DB)).toBeLessThanOrEqual(6);
  expect((await (await read('/f2/operations')).json() as FormOperationsReport).forms[0].id).toBe('f2');
});
it('rechecks destination and guest authority after projection',async()=>{
  await seed(true);await f.db.batch([f.db.prepare("UPDATE users SET workspace_role='guest' WHERE id='bob'"),f.db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('space-core','bob','viewer')")]);
  expect((await read('/f1/operations','bob')).status).toBe(404);
  const db=afterProjection(async()=>{await f.db.prepare("DELETE FROM space_members WHERE space_id='space-core' AND user_id='alice'").run();await f.db.prepare("UPDATE spaces SET default_access='private' WHERE id='space-core'").run();});
  const response=await read('/f1/operations','alice',{...f.env,DB:db});expect(response.status).toBe(404);
});

it('rejects configuration changes and graph races before serializing operational metadata',async()=>{
  await seed(true);let db=afterProjection(async()=>{await applyChanges(f.env,'alice',[{id:'f1',collection:'forms',patch:{title:'Concurrent configuration'},ts:now}],{serverTs:true});});
  expect((await read('/f1/operations','alice',{...f.env,DB:db})).status).toBe(409);
  db=afterProjection(async()=>{await applyChanges(f.env,'alice',[{id:'record-new',collection:'tasks',patch:{status:'done'},ts:now}],{serverTs:true});},2);
  const response=await read('/f1/operations','alice',{...f.env,DB:db});expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'form_operations_sources_changed',retryable:true});
});
