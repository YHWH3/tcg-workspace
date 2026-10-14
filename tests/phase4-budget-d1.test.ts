import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {withD1Budget,d1BudgetRemaining,D1BudgetExhausted} from '../worker/d1budget';
import {applyChanges} from '../worker/sync';
import {processOutbox,scheduleOutbox} from '../worker/events';
import {runScheduled} from '../worker/reminders';
import {runDateOffsetAutomations,dateOffsetEvent} from '../worker/automations';
import {runEventKey} from '../shared/automations';
import {publicFormsApi,resumeSubmission} from '../worker/forms';
import {todayUtc} from '../shared/recurrence';
import type {Env} from '../worker/auth';

// No worker modules are mocked: accounting wraps the actual D1 binding;
// transaction SQL, leases, retries, Cron phases and route execution are real.
let mf:Miniflare,db:D1Database,env:Env;
const ctx={waitUntil:(_p:Promise<unknown>)=>{},passThroughOnException:()=>{}} as ExecutionContext;
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'phase4-budget',modules:true,script:'export default {fetch(){return new Response("local budget fixture")}}',compatibilityDate:'2026-09-25',d1Databases:{DB:'disposable-budget'}}]}));
  db=await mf.getD1Database('DB') as D1Database;
  env={DB:db,WORKSPACE_ENV:'local-test',TURNSTILE_LOCAL_TEST:'1'} as Env;
  const folder=fileURLToPath(new URL('../migrations/',import.meta.url));
  for(const file of readdirSync(folder).filter(f=>f.endsWith('.sql')).sort()) {
    const sql=readFileSync(`${folder}/${file}`,'utf8').replace(/--[^\n]*/g,'');
    await db.batch((sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi)??[]).map(s=>db.prepare(s.trim())));
  }
  await db.prepare("INSERT INTO users(id,username,name,role) VALUES('alice','alice','Alice','admin')").run();
  await applyChanges(env,'alice',[{id:'board',collection:'boards',patch:{name:'Budget fixture',columns:[{id:'open'},{id:'done'}],fields:[]},ts:1}]);
});
afterEach(async()=>{vi.restoreAllMocks();await mf?.dispose();});
async function rows(table:string){return (await db.prepare(`SELECT * FROM ${table}`).all<Record<string,unknown>>()).results;}
async function event(id:string,payload:Record<string,unknown>={source:'automation',userId:'alice',applied:[]}){
  await db.prepare('INSERT INTO event_outbox(id,payload,created_at) VALUES(?,?,?)').bind(id,JSON.stringify(payload),1).run();
}
async function submit(id:string,bindings=env){return publicFormsApi.request('http://localhost/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({submissionId:id,values:{title:'Visitor'},turnstileToken:'pass'})},bindings,ctx);}

it('keeps fresh invocation budgets isolated, shares session accounting, and counts a native D1 batch as one binding call',async()=>{
  const a=withD1Budget(env,3),b=withD1Budget(env,3);
  // Reference checks stay off expect().not.toBe: a failed Object.is walks the
  // D1 proxy and Miniflare tries to RPC `asymmetricMatch`.
  expect(a===env).toBe(false);expect(a.DB===b.DB).toBe(false);expect(withD1Budget(a)).toBe(a);
  await a.DB.batch([a.DB.prepare('SELECT 1'),a.DB.prepare('SELECT 2')]);
  // Limit 3 keeps one call in reserve, so one batch leaves one usable call (not two).
  expect(d1BudgetRemaining(a.DB)).toBe(1);expect(d1BudgetRemaining(b.DB)).toBe(2);
  await a.DB.withSession('first-primary').prepare('SELECT 1').first();
  expect(d1BudgetRemaining(a.DB)).toBe(0);
  expect(()=>a.DB.prepare('SELECT ? n').bind(3).all()).toThrow(D1BudgetExhausted);
  await b.DB.prepare('SELECT 1').first();expect(d1BudgetRemaining(b.DB)).toBe(1);
  expect(d1BudgetRemaining(env.DB)).toBe(Infinity);
});

it('leaves all events pending when background acceleration has insufficient headroom',async()=>{
  await event('no-headroom');const pending:Promise<unknown>[]=[];
  scheduleOutbox(withD1Budget(env,17),{waitUntil:p=>pending.push(p)},['no-headroom']);
  await Promise.all(pending);
  expect((await rows('event_outbox'))[0]).toMatchObject({processed_at:null,terminal_at:null,attempts:0,lease_id:null});
});

it('reports exact 150-row partial writes when the binding budget ends at a batch boundary, then replays without duplicate events',async()=>{
  const changes=Array.from({length:150},(_,i)=>({id:`partial_${i}`,collection:'pages',patch:{title:`Page ${i}`},ts:1}));
  const result=await applyChanges(withD1Budget(env,3),'alice',changes,{event:{source:'client'}});
  expect(result.partialError).toMatch(/budget/i);expect(result.changed).toBe(100);expect(result.applied).toHaveLength(100);
  expect((await rows('event_outbox'))).toHaveLength(100);
  expect((await rows('records')).filter(r=>r.collection==='pages')).toHaveLength(100);
  const replay=await applyChanges(withD1Budget(env,45),'alice',changes,{event:{source:'client'}});
  expect(replay.partialError).toBeUndefined();expect(replay.changed).toBe(50);
  expect((await rows('event_outbox'))).toHaveLength(150);
},30_000);

it('budget-only interruptions never consume terminal failure attempts for a healthy large board event',async()=>{
  for(let start=0;start<100;start+=50) await applyChanges(env,'alice',Array.from({length:50},(_,i)=>({id:`large_${start+i}`,collection:'tasks',patch:{boardId:'board',dueDate:todayUtc()},ts:1})));
  await event('large-board',{source:'client',userId:'alice',applied:[{id:'board',collection:'boards',created:false,fields:['fields'],before:{fields:[]},after:{fields:[]},fieldTs:{fields:2},rev:2}]});
  for(let retry=0;retry<9;retry++) {
    await db.prepare("UPDATE event_outbox SET lease_until=0 WHERE id='large-board'").run();
    await expect(processOutbox(withD1Budget(env,18),'large-board')).rejects.toThrow(D1BudgetExhausted);
    const row=(await rows('event_outbox'))[0];
    expect(row.processed_at).toBeNull();expect(row.terminal_at).toBeNull();expect(Number(row.attempts)).toBeLessThan(8);
  }
},30_000);

it('budget-only submission interruptions keep a retryable reservation instead of eventually rejecting a valid visitor',async()=>{
  await applyChanges(env,'alice',[{id:'form',collection:'forms',patch:{databaseId:'board',title:'Form',enabled:true,fields:[{fieldKey:'title',label:'Name',required:true}],successMessage:'Recorded'},ts:1}]);
  await db.prepare("INSERT INTO form_tokens(token,form_id,created_at) VALUES('token','form',1)").run();
  await db.prepare("CREATE TRIGGER stop_receipt BEFORE UPDATE OF state ON form_submissions WHEN NEW.state='accepted' BEGIN SELECT RAISE(ABORT,'receipt fault'); END").run();
  expect((await submit('budget-reservation')).status).toBe(503);
  await db.prepare('DROP TRIGGER stop_receipt').run();
  for(let retry=0;retry<9;retry++){
    await db.prepare("UPDATE form_submissions SET lease_until=0,retry_at=0 WHERE submission_id='budget-reservation'").run();
    await expect(resumeSubmission(withD1Budget(env,2),'budget-reservation',ctx)).rejects.toThrow(D1BudgetExhausted);
    expect((await rows('form_submissions'))[0].state).not.toBe('rejected');
    expect(Number((await rows('form_submissions'))[0].attempts)).toBeLessThan(8);
  }
  await db.prepare("UPDATE form_submissions SET lease_until=0,retry_at=0 WHERE submission_id='budget-reservation'").run();
  expect((await resumeSubmission(withD1Budget(env,45),'budget-reservation',ctx)).status).toBe(200);
  expect((await rows('records')).filter(r=>r.collection==='tasks')).toHaveLength(1);
});

it('rotating budgeted Cron phases advance past 600 ignored dates despite 500 pending events and run a date automation',async()=>{
  const today=todayUtc();
  await applyChanges(env,'alice',Array.from({length:500},(_,i)=>({id:`ignored_${String(i).padStart(4,'0')}`,collection:'tasks',patch:{boardId:'board',title:'Unassigned',status:'open'},ts:1})));
  await applyChanges(env,'alice',Array.from({length:100},(_,i)=>({id:`ignored_${String(500+i).padStart(4,'0')}`,collection:'tasks',patch:{boardId:'board',title:'Unassigned',status:'open'},ts:1})));
  await applyChanges(env,'alice',[{id:'relevant',collection:'tasks',patch:{boardId:'board',title:'Relevant',status:'open',assigneeId:'alice',dueDate:today},ts:1},{id:'date-auto',collection:'automations',patch:{name:'Date automation',enabled:true,databaseId:'board',trigger:{kind:'date_offset',dateKey:'dueDate',days:0},actions:[{type:'create_record',databaseId:'board',title:'Date result'}]},ts:1}]);
  await db.batch(Array.from({length:600},(_,i)=>db.prepare("INSERT INTO date_index(record_id,field_key,date) VALUES(?,'dueDate','2020-01-01')").bind(`ignored_${String(i).padStart(4,'0')}`)));
  await db.prepare("INSERT INTO date_index(record_id,field_key,date) VALUES('relevant','dueDate',?)").bind(today).run();
  await db.batch(Array.from({length:500},(_,i)=>db.prepare('INSERT INTO event_outbox(id,payload,created_at) VALUES(?,?,1)').bind(`pending_${i}`,JSON.stringify({source:'automation',userId:'alice',applied:[]}))));
  const start=(Math.floor(Date.now()/5_400_000)*6+4)*900_000;
  // Delayed Cron deliveries can share a wall-clock slot. Fairness follows the
  // supplied scheduled times while leases and retries keep using real time.
  vi.spyOn(Date,'now').mockReturnValue(start);
  for(let tick=0;tick<24;tick++){
    const scoped=withD1Budget(env,45);await runScheduled(scoped,start+tick*900_000);expect(d1BudgetRemaining(scoped.DB)).toBeGreaterThanOrEqual(0);
  }
  expect((await rows('reminder_sent')).filter(r=>r.record_id==='relevant')).toHaveLength(1);
  expect((await rows('automation_runs')).filter(r=>r.status==='completed')).toHaveLength(1);
  const outbox=await rows('event_outbox');
  expect(outbox.some(r=>r.processed_at!==null)).toBe(true);
  expect(outbox.filter(r=>String(r.id).startsWith('pending_')&&r.processed_at===null).length).toBeGreaterThan(0);
  expect(outbox.every(r=>r.terminal_at===null)).toBe(true);
},60_000);

it('date-offset automation scan does not permanently revisit 600 already-completed candidates and starve the tail',async()=>{
  const today=todayUtc(),auto={id:'date-auto',data:{name:'Date automation',enabled:true,databaseId:'board',trigger:{kind:'date_offset',dateKey:'dueDate',days:0},actions:[{type:'create_record',databaseId:'board',title:'Tail result'}]}};
  await applyChanges(env,'alice',[{id:auto.id,collection:'automations',patch:auto.data,ts:1}]);
  for(let start=0;start<601;start+=100){
    const n=Math.min(100,601-start);
    await applyChanges(env,'alice',Array.from({length:n},(_,i)=>({id:`candidate_${String(start+i).padStart(4,'0')}`,collection:'tasks',patch:{boardId:'board',title:'Candidate',status:'open',dueDate:today,createdBy:'alice'},ts:1})));
    await db.batch(Array.from({length:n},(_,i)=>db.prepare("INSERT INTO date_index(record_id,field_key,date) VALUES(?,'dueDate',?)").bind(`candidate_${String(start+i).padStart(4,'0')}`,today)));
  }
  await db.batch(Array.from({length:600},(_,i)=>{
    const ev=dateOffsetEvent(`candidate_${String(i).padStart(4,'0')}`,'board','dueDate',today),key=runEventKey(auto.id,ev,`cron:${today}`);
    return db.prepare("INSERT INTO automation_runs(id,automation_id,event_key,status,created_at) VALUES(?,?,?,'completed',1)").bind(`arun_${key}`,auto.id,key);
  }));
  for(let tick=0;tick<6;tick++)try{await runDateOffsetAutomations(withD1Budget(env,45),today);}catch(error){expect(error).toBeInstanceOf(D1BudgetExhausted);}
  const tail=await db.prepare("SELECT id FROM records WHERE collection='tasks' AND json_extract(data,'$.title')='Tail result'").all();
  expect(tail.results).toHaveLength(1);
},60_000);
