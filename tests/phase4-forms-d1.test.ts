import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {publicFormsApi,resumeSubmission,recoverFormSubmissions,verifyFormChallenge,localTurnstileTest} from '../worker/forms';
import {applyChanges} from '../worker/sync';
import {processOutbox} from '../worker/events';
import {undoChangeset} from '../worker/changesets';
import type {Env,AuthUser} from '../worker/auth';

vi.mock('../worker/events',async original=>({...await original<typeof import('../worker/events')>(),scheduleOutbox:vi.fn()}));
let mf:Miniflare,db:D1Database,env:Env;
const ctx={waitUntil:(_p:Promise<unknown>)=>{},passThroughOnException:()=>{}} as ExecutionContext;
const config={databaseId:'intake',title:'Intake',enabled:true,fields:[{fieldKey:'title',label:'Name',required:true}],successMessage:'Recorded',notifyUserIds:['alice']};
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'form-regressions',modules:true,script:'export default {fetch(){return new Response("local")}}',compatibilityDate:'2026-09-25',d1Databases:{DB:'disposable-forms'}}]}));
  db=await mf.getD1Database('DB') as D1Database;
  const folder=fileURLToPath(new URL('../migrations/',import.meta.url));
  for(const file of readdirSync(folder).filter(f=>f.endsWith('.sql')).sort()) {
    const sql=readFileSync(`${folder}/${file}`,'utf8').replace(/--[^\n]*/g,'');
    const statements=sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi)??[];
    await db.batch(statements.map(s=>db.prepare(s.trim())));
  }
  env={DB:db,WORKSPACE_ENV:'local-test',TURNSTILE_LOCAL_TEST:'1'} as Env;
  await db.prepare("INSERT INTO users(id,username,name,role,prefs) VALUES('alice','alice','Alice','admin',NULL)").run();
  await applyChanges(env,'alice',[{id:'intake',collection:'boards',patch:{name:'Intake',columns:[{id:'new'},{id:'done'}],fields:[]},ts:1},{id:'form',collection:'forms',patch:config,ts:1}]);
  await db.prepare("INSERT INTO form_tokens(token,form_id,created_at) VALUES('token','form',1)").run();
});
afterEach(async()=>{vi.unstubAllGlobals();await mf?.dispose();});
async function submit(id:string,extra:Record<string,unknown>={},bindings=env) {
  const response=await publicFormsApi.request('http://localhost/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({submissionId:id,values:{title:'Visitor'},turnstileToken:'pass',...extra})},bindings,ctx);
  const text=await response.text();
  return {status:response.status,body:(()=>{try{return JSON.parse(text) as Record<string,unknown>;}catch{return {error:text};}})()};
}
async function rows(table:string) {return (await db.prepare(`SELECT * FROM ${table}`).all<Record<string,unknown>>()).results;}
async function recover(id:string) {await db.prepare('UPDATE form_submissions SET retry_at=0,lease_until=0 WHERE submission_id=?').bind(id).run();return resumeSubmission(env,id,ctx);}

describe('P4-R04 public Turnstile fail-closed boundaries',()=>{
  it('requires deliberate local activation and loopback HTTP; flags never bypass a production origin',async()=>{
    expect(localTurnstileTest(env,'http://localhost/token')).toBe(true);
    for(const url of ['https://localhost/token','http://example.com/token','https://workspace.example/token']) expect(localTurnstileTest(env,url)).toBe(false);
    expect(await verifyFormChallenge(env,'pass','local','http://localhost/token')).toBe('ok');
    expect(await verifyFormChallenge({...env,TURNSTILE_LOCAL_TEST:'0'},'pass','local','http://localhost/token')).toBe('configuration');
    expect(await verifyFormChallenge(env,'pass','local','https://workspace.example/token')).toBe('configuration');
    expect((await submit('disabledtest',{}, {...env,TURNSTILE_LOCAL_TEST:'0'})).status).toBe(503);
    expect(await rows('form_submissions')).toHaveLength(0);
  });
  it('rejects invalid/expired challenges without reserving or creating anything',async()=>{
    expect((await submit('invalid',{turnstileToken:'fail'})).status).toBe(403);
    expect(await rows('form_submissions')).toHaveLength(0);
    expect((await rows('records')).filter(r=>r.collection==='tasks')).toHaveLength(0);
  });
  it.each(['invalid-secret','expired','network','wrong-action','wrong-host','valid'])('verifies production challenge outcome %s',async scenario=>{
    const production={...env,TURNSTILE_SECRET:'disposable-secret',TURNSTILE_SITE_KEY:'sitekey',TURNSTILE_HOSTNAMES:'workspace.example'};
    vi.stubGlobal('fetch',vi.fn(async()=>{
      if(scenario==='network') throw new Error('temporary service failure');
      return Response.json(scenario==='invalid-secret'?{success:false,'error-codes':['invalid-input-secret']}:scenario==='expired'?{success:false,'error-codes':['timeout-or-duplicate']}:{success:true,action:scenario==='wrong-action'?'login':'form_submit',hostname:scenario==='wrong-host'?'attacker.example':'workspace.example'});
    }));
    expect(await verifyFormChallenge(production,'fresh-token','local','https://workspace.example/f/token')).toBe(scenario==='valid'?'ok':scenario==='invalid-secret'?'configuration':scenario==='network'?'unavailable':'challenge');
  });
});

describe('P4-R06 real D1 submission reservation, recovery and receipt',()=>{
  it('accepts an unauthenticated submission and replays the same receipt after a lost response or expired challenge',async()=>{
    const accepted=await submit('lost');expect(accepted.status).toBe(200);expect(accepted.body.state).toBe('accepted');
    const replay=await submit('lost',{turnstileToken:'expired'});expect(replay).toEqual(accepted);
    expect(accepted.body).not.toHaveProperty('recordId');expect(accepted.body).not.toHaveProperty('recordUrl');
    expect((await rows('records')).filter(r=>r.collection==='tasks')).toHaveLength(1);
    const events=await rows('event_outbox');for(const ev of events) await processOutbox(env,String(ev.id));
    expect(await rows('notifications')).toHaveLength(1);
    for(const ev of events) await processOutbox(env,String(ev.id));expect(await rows('notifications')).toHaveLength(1);
  });
  it('resumes a crash immediately after reservation without redeeming the expired challenge again',async()=>{
    await db.prepare("CREATE TRIGGER stop_claim BEFORE UPDATE OF lease_id ON form_submissions WHEN NEW.state='processing' BEGIN SELECT RAISE(ABORT,'claim crash'); END").run();
    expect((await submit('reserved')).status).toBe(500);
    expect((await rows('form_submissions'))[0].state).toBe('pending');
    await db.prepare('DROP TRIGGER stop_claim').run();
    expect((await submit('reserved',{turnstileToken:'expired'})).status).toBe(200);
    expect((await rows('records')).filter(r=>r.collection==='tasks')).toHaveLength(1);
  });
  it('recovers record creation before receipt persistence with one record, one audit item and complete undo',async()=>{
    await db.prepare("CREATE TRIGGER stop_receipt BEFORE UPDATE OF state ON form_submissions WHEN NEW.state='accepted' BEGIN SELECT RAISE(ABORT,'receipt crash'); END").run();
    expect((await submit('receiptcrash')).status).toBe(503);
    expect((await rows('records')).filter(r=>r.collection==='tasks')).toHaveLength(1);
    expect(await rows('changeset_items')).toHaveLength(1);
    await db.prepare('DROP TRIGGER stop_receipt').run();
    expect((await recover('receiptcrash')).status).toBe(200);
    expect(await rows('changeset_items')).toHaveLength(1);
    const cs=(await rows('changesets'))[0];
    const undo=await undoChangeset(env,{id:'alice',role:'admin'} as AuthUser,String(cs.id),ctx);
    expect(undo.ok).toBe(true);expect(undo.restored).toBe(1);
    const task=(await rows('records')).find(r=>r.collection==='tasks')!;expect(JSON.parse(String(task.data)).deleted).toBe(true);
  });
  it('two concurrent identical requests settle on one logical submission and same receipt',async()=>{
    const responses=await Promise.all([submit('concurrent'),submit('concurrent')]);
    expect(responses.every(r=>[200,202].includes(r.status))).toBe(true);
    const final=await recover('concurrent');expect(final.status).toBe(200);
    for(const result of responses.filter(r=>r.status===200)) expect(result.body).toEqual(final.body);
    expect((await rows('records')).filter(r=>r.collection==='tasks')).toHaveLength(1);
    expect(await rows('changeset_items')).toHaveLength(1);
  });
  it('Cron resumes expired processing leases; disabling the form during recovery records a terminal outcome',async()=>{
    await db.prepare("CREATE TRIGGER stop_receipt BEFORE UPDATE OF state ON form_submissions WHEN NEW.state='accepted' BEGIN SELECT RAISE(ABORT,'receipt crash'); END").run();
    await submit('cron');await db.prepare('DROP TRIGGER stop_receipt').run();
    await db.prepare("UPDATE form_submissions SET state='processing',lease_id='dead-worker',lease_until=1,retry_at=0 WHERE submission_id='cron'").run();
    await recoverFormSubmissions(env,ctx);expect((await rows('form_submissions'))[0].state).toBe('accepted');
    await db.prepare("CREATE TRIGGER stop_claim BEFORE UPDATE OF lease_id ON form_submissions WHEN NEW.state='processing' BEGIN SELECT RAISE(ABORT,'claim crash'); END").run();
    await submit('disabled');await db.prepare('DROP TRIGGER stop_claim').run();
    await applyChanges(env,'alice',[{id:'form',collection:'forms',patch:{enabled:false},ts:Date.now()}]);
    expect((await recover('disabled')).status).toBe(410);
    expect((await rows('form_submissions')).find(r=>r.submission_id==='disabled')?.state).toBe('rejected');
  });
  it('invalid fields and gated stages never produce a success receipt or rejected record event',async()=>{
    expect((await submit('bad',{values:{title:''}})).status).toBe(422);
    await applyChanges(env,'alice',[{id:'intake',collection:'boards',patch:{approvalGate:{stageId:'new'}},ts:Date.now()}]);
    expect((await submit('gated')).status).toBe(422);
    expect((await rows('records')).filter(r=>r.collection==='tasks')).toHaveLength(0);
    expect(await rows('event_outbox')).toHaveLength(0);
  });
  it('rejects reused submission IDs with different input or another form, without exposing the stored receipt',async()=>{
    await submit('reuse');expect((await submit('reuse',{values:{title:'Someone else'}})).status).toBe(409);
    await applyChanges(env,'alice',[{id:'other',collection:'forms',patch:config,ts:1}]);
    await db.prepare("INSERT INTO form_tokens(token,form_id,created_at) VALUES('other','other',1)").run();
    const result=await publicFormsApi.request('http://localhost/other',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({submissionId:'reuse',values:{title:'Visitor'},turnstileToken:'pass'})},env,ctx);
    expect(result.status).toBe(409);expect(await result.json()).toEqual({error:'submission_conflict'});
  });
  it('normalizes concurrent equivalent emails to one Person and leaks no match details',async()=>{
    await applyChanges(env,'alice',[{id:'intake',collection:'boards',patch:{fields:[{id:'email',name:'Email',type:'text'}]},ts:Date.now()},{id:'form',collection:'forms',patch:{fields:[...config.fields,{fieldKey:'p_email',label:'Email',required:true}],peopleMatch:{emailField:'email'}},ts:Date.now()}]);
    const results=await Promise.all([submit('person1',{values:{title:'One',p_email:' ADA@EXAMPLE.COM '}}),submit('person2',{values:{title:'Two',p_email:'ada@example.com'}})]);
    for(const id of ['person1','person2']) await recover(id);
    expect((await rows('records')).filter(r=>r.collection==='tasks')).toHaveLength(1);
    for(const result of results) {expect(result.body).not.toHaveProperty('recordId');expect(result.body).not.toHaveProperty('personId');expect(JSON.stringify(result.body)).not.toContain('ada@example.com');}
    expect((await rows('form_submissions')).filter(r=>r.state==='accepted')).toHaveLength(2);
  });
});
