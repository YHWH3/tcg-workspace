import {readFileSync,readdirSync,writeFileSync,mkdtempSync} from 'node:fs';
import {tmpdir,cpus} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {it,expect,vi} from 'vitest';
import {applyChanges} from '../worker/sync';
import {processOutbox,maintainDateIndex} from '../worker/events';
import {notify} from '../worker/notifications';
import {runScheduled} from '../worker/reminders';
import {publicFormsApi} from '../worker/forms';
import {runOneAutomation} from '../worker/automations';
import {todayUtc} from '../shared/recurrence';
import type {Env} from '../worker/auth';

vi.mock('../worker/events',async original=>({...await original<typeof import('../worker/events')>(),scheduleOutbox:vi.fn()}));

it('measures Phase 4 actual D1 operations on a fixed 1000-record fixture and proves bounded reminder sweep progress',async()=>{
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'phase4-performance',modules:true,script:'export default {fetch(){return new Response("local")}}',compatibilityDate:'2026-09-25',d1Databases:{DB:'phase4-performance-disposable'}}]}));
  const db=await mf.getD1Database('DB') as D1Database;
  const metrics:{name:string;ms:number;subrequests:number;statements:number;rowsRead:number;rowsWritten:number;note?:string}[]=[];
  const directory=mkdtempSync(join(tmpdir(),'tcg-phase4-performance-'));
  let subrequests=0,statements=0,rowsRead=0,rowsWritten=0;
  const unwrap=new WeakMap<object,D1PreparedStatement>();
  function metadata(result:D1Result) {rowsRead+=result.meta.rows_read??0;rowsWritten+=result.meta.rows_written??0;}
  function wrap(statement:D1PreparedStatement):D1PreparedStatement {
    const proxy=new Proxy(statement,{get(target,key){
      if(key==='bind')return (...values:(string|number|null|ArrayBuffer|number[])[])=>wrap(target.bind(...values));
      if(key==='first')return async (...args:Parameters<D1PreparedStatement['first']>)=>{subrequests++;statements++;return target.first(...args);};
      if(key==='all'||key==='run')return async()=>{subrequests++;statements++;const result=await target[key]();metadata(result);return result;};
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});unwrap.set(proxy,statement);return proxy;
  }
  const observed=new Proxy(db,{get(target,key){
    if(key==='prepare')return (sql:string)=>wrap(target.prepare(sql));
    if(key==='batch')return async(input:D1PreparedStatement[])=>{subrequests++;statements+=input.length;const output=await target.batch(input.map(s=>unwrap.get(s)??s));for(const r of output)metadata(r);return output;};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  const env={DB:observed,WORKSPACE_ENV:'local-test',TURNSTILE_LOCAL_TEST:'1'} as Env;
  const ctx={waitUntil:(_p:Promise<unknown>)=>{},passThroughOnException:()=>{}} as ExecutionContext;
  async function measure(name:string,operation:()=>Promise<unknown>,note?:string){subrequests=statements=rowsRead=rowsWritten=0;const start=performance.now();await operation();metrics.push({name,ms:Number((performance.now()-start).toFixed(2)),subrequests,statements,rowsRead,rowsWritten,note});}
  try {
    const folder=fileURLToPath(new URL('../migrations/',import.meta.url));
    for(const file of readdirSync(folder).filter(f=>f.endsWith('.sql')).sort()){
      const source=readFileSync(join(folder,file),'utf8').replace(/--[^\n]*/g,'');
      await db.batch((source.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi)??[]).map(sql=>db.prepare(sql)));
    }
    await db.prepare("INSERT INTO users(id,username,name,role) VALUES('alice','alice','Alice','admin'),('bob','bob','Bob','member')").run();
    await applyChanges(env,'alice',[{id:'perf',collection:'boards',patch:{name:'1000-row fixed fixture',columns:[{id:'open'},{id:'done'}],fields:[{id:'date',name:'Date',type:'date'}]},ts:1}]);
    await measure('seed 1000 records',async()=>{
      for(let start=0;start<1000;start+=100){const result=await applyChanges(env,'alice',Array.from({length:100},(_,index)=>({id:`perf_${String(start+index).padStart(4,'0')}`,collection:'tasks',patch:{boardId:'perf',title:`Fixed row ${start+index}`,status:'open',order:String(start+index).padStart(4,'0')},ts:1})));expect(result.changed).toBe(100);}
    },'Fixture setup, not a production request; no event fan-out during seed');
    expect((await db.prepare("SELECT COUNT(*) n FROM records WHERE collection='tasks'").first<{n:number}>())!.n).toBe(1000);
    await measure('record/event commit 100 rows',async()=>{
      const result=await applyChanges(env,'alice',Array.from({length:100},(_,index)=>({id:`perf_${String(index).padStart(4,'0')}`,collection:'tasks',patch:{description:'Measured change'},ts:2})),{event:{source:'client'}});expect(result.changed).toBe(100);
    });
    const pending=(await db.prepare('SELECT id FROM event_outbox ORDER BY created_at LIMIT 5').all<{id:string}>()).results;
    for(const event of pending)await measure('event processing one record',()=>processOutbox(env,event.id));
    for(let index=0;index<5;index++)await measure('notification grouping one delivery',()=>notify(env,{userId:'bob',kind:'automation',title:'Performance group',groupKey:'perf-group',dedupeKey:`perf:${index}`}));
    for(let index=0;index<5;index++)await measure('Inbox indexed query',async()=>{await env.DB.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 60').bind('bob').all();});
    await measure('typed date index update',async()=>{
      const result=await applyChanges(env,'alice',[{id:'perf_0999',collection:'tasks',patch:{dueDate:todayUtc(),p_date:'2026-10-20',assigneeId:'bob'},ts:3}]);await maintainDateIndex(env,result.applied);
    });
    // 600 earlier unassigned dates cannot permanently starve the actionable
    // final date. Indexed keyset progress is persisted across bounded ticks.
    await db.batch(Array.from({length:600},(_,i)=>db.prepare('INSERT OR IGNORE INTO date_index(record_id,field_key,date) VALUES(?,\'dueDate\',\'2020-01-01\')').bind(`perf_${String(i).padStart(4,'0')}`)));
    await db.prepare('UPDATE event_outbox SET processed_at=1').run();
    for(let tick=0;tick<4;tick++)await measure('bounded reminder Cron tick',()=>runScheduled(env));
    expect((await db.prepare("SELECT COUNT(*) n FROM reminder_sent WHERE record_id='perf_0999'").first<{n:number}>())!.n).toBe(1);
    await measure('repeat reminder Cron dedupe',()=>runScheduled(env));
    expect((await db.prepare("SELECT COUNT(*) n FROM reminder_sent WHERE record_id='perf_0999'").first<{n:number}>())!.n).toBe(1);
    await applyChanges(env,'alice',[{id:'perf-form',collection:'forms',patch:{databaseId:'perf',title:'Performance intake',enabled:true,fields:[{fieldKey:'title',label:'Name',required:true}],successMessage:'Recorded',notifyUserIds:[]},ts:1}]);
    await db.prepare("INSERT INTO form_tokens(token,form_id,created_at) VALUES('perf-token','perf-form',1)").run();
    for(let index=0;index<5;index++)await measure('form accepted acknowledgement',async()=>{const response=await publicFormsApi.request('http://localhost/perf-token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({submissionId:`perf-sub-${index}`,values:{title:`Perf visitor ${index}`},turnstileToken:'pass'})},env,ctx);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({state:'accepted'});});
    const auto={id:'perf-auto',data:{name:'Perf review',databaseId:'perf',enabled:true,trigger:{kind:'stage_changed' as const,to:'done'},actions:[{type:'create_record' as const,databaseId:'perf',title:'Review {{record.title}}'}]}};
    for(let index=0;index<5;index++)await measure('automation one record and journal',()=>runOneAutomation(env,auto,{kind:'record.stage_changed',recordId:'perf_0999',collection:'tasks',boardId:'perf',to:'done'},{userId:'alice',source:'client',outboxId:`perf-auto-${index}`},{title:'Fixed row 999',boardId:'perf',status:'done'},todayUtc()));
    const plans={inbox:(await db.prepare("EXPLAIN QUERY PLAN SELECT * FROM notifications WHERE user_id='bob' ORDER BY created_at DESC LIMIT 60").all()).results,
      dateSweep:(await db.prepare("EXPLAIN QUERY PLAN SELECT * FROM date_index WHERE (date,record_id,field_key)>('2020-01-01','','') AND date<='2026-11-11' ORDER BY date,record_id,field_key LIMIT 250").all()).results,
      outbox:(await db.prepare("EXPLAIN QUERY PLAN SELECT id FROM event_outbox WHERE processed_at IS NULL AND terminal_at IS NULL AND lease_until<1 ORDER BY created_at LIMIT 20").all()).results};
    console.log('PHASE4_PERFORMANCE_EVIDENCE',JSON.stringify({directory,records:1000,metrics,plans}));
    writeFileSync(join(directory,'d1-performance.json'),JSON.stringify({records:1000,runtime:process.version,cpu:cpus()[0]?.model,metrics,plans,limitations:['Local Miniflare latency, not Cloudflare deployed region latency','rows_read/written omit native first() metadata; lower bound, not total','Subrequests count binding RPCs; SQL statements also shown separately','No production resources or billing changed']},null,2));
    expect(plans.inbox.some(row=>String(row.detail).includes('INDEX'))).toBe(true);
    expect(plans.dateSweep.some(row=>String(row.detail).includes('idx_date_sweep'))).toBe(true);
  } finally {await mf.dispose();}
},120_000);
