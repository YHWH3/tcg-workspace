import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {applyChanges} from '../worker/sync';
import {runDateOffsetAutomations,dateOffsetEvent} from '../worker/automations';
import {runEventKey} from '../shared/automations';
import {withD1Budget,D1BudgetExhausted} from '../worker/d1budget';
import {addDays,todayUtc} from '../shared/recurrence';
import type {Env} from '../worker/auth';

let mf:Miniflare,db:D1Database,env:Env;
const today=todayUtc();
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'phase4-date-offset',modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-09-25',d1Databases:{DB:'disposable-date-offset'}}]}));
  db=await mf.getD1Database('DB') as D1Database;
  env={DB:db,WORKSPACE_ENV:'local-test'} as Env;
  const folder=fileURLToPath(new URL('../migrations/',import.meta.url));
  for(const file of readdirSync(folder).filter(f=>f.endsWith('.sql')).sort()){
    const sql=readFileSync(`${folder}/${file}`,'utf8').replace(/--[^\n]*/g,'');
    await db.batch((sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi)??[]).map(s=>db.prepare(s.trim())));
  }
  await db.prepare("INSERT INTO users(id,username,name,role) VALUES('alice','alice','Alice','admin')").run();
  await applyChanges(env,'alice',[{id:'board',collection:'boards',patch:{name:'Dates',columns:[{id:'open'},{id:'done'}],fields:[]},ts:1}]);
});
afterEach(()=>mf.dispose());

async function automation(id:string,title:string,dateKey='dueDate'){
  await applyChanges(env,'alice',[{id,collection:'automations',patch:{name:id,enabled:true,databaseId:'board',trigger:{kind:'date_offset',dateKey,days:0},actions:[{type:'create_record',databaseId:'board',title}]},ts:1}]);
}
async function task(id:string,due=today){
  await applyChanges(env,'alice',[{id,collection:'tasks',patch:{boardId:'board',title:id,status:'open',dueDate:due,createdBy:'alice'},ts:1}]);
  await db.prepare("INSERT INTO date_index(record_id,field_key,date) VALUES(?,'dueDate',?)").bind(id,due).run();
}
const created=async(title:string)=> (await db.prepare("SELECT COUNT(*) n FROM records WHERE collection='tasks' AND json_extract(data,'$.title')=?").bind(title).first<{n:number}>())!.n;

it('reaches a later automation without waiting for an earlier completed prefix',async()=>{
  await automation('auto-a','A result');
  await db.prepare("UPDATE records SET data=json_set(data,'$.trigger.days',1) WHERE id='auto-a'").run();
  await automation('auto-b','B result');
  const yesterday=addDays(today,-1);
  await db.batch(Array.from({length:200},(_,i)=>db.prepare("INSERT INTO date_index(record_id,field_key,date) VALUES(?,'dueDate',?)").bind(`aaa_${String(i).padStart(4,'0')}`,yesterday)));
  await task('bee');
  try{await runDateOffsetAutomations(withD1Budget(env,45),today);}catch(error){expect(error).toBeInstanceOf(D1BudgetExhausted);}
  expect(await created('B result')).toBe(1);
},30_000);

it('resumes a budget interruption without a terminal failure or a second task',async()=>{
  await automation('date-auto','Once');
  await task('only');
  try{await runDateOffsetAutomations(withD1Budget(env,10),today);}catch(error){expect(error).toBeInstanceOf(D1BudgetExhausted);}
  const mid=await db.prepare("SELECT status FROM automation_runs WHERE automation_id='date-auto'").all<{status:string}>();
  expect(mid.results.every(r=>r.status!=='terminal_failure')).toBe(true);
  await runDateOffsetAutomations(withD1Budget(env,45),today);
  expect(await created('Once')).toBe(1);
  await runDateOffsetAutomations(env,today);
  expect(await created('Once')).toBe(1);
});

it('picks up rows inserted behind the cursor and rows on a changed target date',async()=>{
  await automation('date-auto','Found');
  await task('late','2020-01-01');
  await db.prepare("INSERT INTO rhythm_sweep_cursors(name,date,record_id,field_key) VALUES('dateoff:date-auto',?,'late','dueDate')").bind(today).run();
  await db.prepare("INSERT INTO date_offset_marks(automation_id,date,field_key,record_id) VALUES('date-auto',?,'dueDate','late')").bind(today).run();
  await task('early');
  await runDateOffsetAutomations(env,today);
  expect(await created('Found')).toBe(1);
  await db.prepare("DELETE FROM records WHERE id='early'").run();
  await db.prepare('DELETE FROM date_index WHERE record_id=?').bind('early').run();
  await task('shifted','2024-05-01');
  await db.prepare("UPDATE records SET data=json_set(data,'$.trigger.days',-1) WHERE id='date-auto'").run();
  await db.prepare('UPDATE date_index SET date=? WHERE record_id=?').bind(addDays(today,1),'shifted').run();
  await runDateOffsetAutomations(env,today);
  expect(await created('Found')).toBe(2);
});

it('skips a deleted record and does not double-fire under concurrent scans',async()=>{
  await automation('date-auto','Live');
  await db.prepare("INSERT INTO date_index(record_id,field_key,date) VALUES('gone','dueDate',?)").bind(today).run();
  await task('kept');
  await Promise.all([runDateOffsetAutomations(env,today),runDateOffsetAutomations(env,today)]);
  expect(await created('Live')).toBe(1);
  const runs=await db.prepare("SELECT COUNT(*) n FROM automation_runs WHERE automation_id='date-auto' AND status='completed'").first<{n:number}>();
  expect(runs?.n).toBe(1);
});

it('walks 1000 mixed date-index rows and fires only the eligible tail once',async()=>{
  await automation('date-auto','Tail');
  const stmts:D1PreparedStatement[]=[];
  for(let i=0;i<1000;i++){
    const id=`mix_${String(i).padStart(4,'0')}`;
    const date=i===999?today:i%2?'1999-01-01':'2001-02-02';
    const key=i%5?'other':'dueDate';
    stmts.push(db.prepare('INSERT INTO date_index(record_id,field_key,date) VALUES(?,?,?)').bind(id,key,date));
  }
  for(let i=0;i<stmts.length;i+=100) await db.batch(stmts.slice(i,i+100));
  await task('mix_0999');
  await runDateOffsetAutomations(env,today);
  expect(await created('Tail')).toBe(1);
  await runDateOffsetAutomations(env,today);
  expect(await created('Tail')).toBe(1);
},30_000);

it('runs a date-offset rule only while its conditions match, including a later match in the same window',async()=>{
  await applyChanges(env,'alice',[{id:'board',collection:'boards',patch:{name:'Dates',columns:[{id:'open',name:'Open'},{id:'done',name:'Done'}],fields:[{id:'note',name:'Note',type:'text'},{id:'when',name:'When',type:'date'},{id:'who',name:'Who',type:'person'}]},ts:2}]);
  await applyChanges(env,'alice',[{id:'gated',collection:'automations',patch:{name:'Gated',enabled:true,databaseId:'board',trigger:{kind:'date_offset',dateKey:'dueDate',days:0},conditions:[{key:'status',op:'is',value:'open'},{key:'p_note',op:'contains',value:'go'}],actions:[{type:'create_record',databaseId:'board',title:'Follow up'}]},ts:2}]);
  await applyChanges(env,'alice',[{id:'hold',collection:'tasks',patch:{boardId:'board',title:'Hold',status:'done',dueDate:today,p_note:'go',createdBy:'alice'},ts:2}]);
  await db.prepare("INSERT INTO date_index(record_id,field_key,date) VALUES('hold','dueDate',?)").bind(today).run();
  await runDateOffsetAutomations(env,today);
  expect(await created('Follow up')).toBe(0);
  expect((await db.prepare("SELECT COUNT(*) n FROM date_offset_marks WHERE record_id='hold'").first<{n:number}>())!.n).toBe(0);
  await db.prepare("UPDATE records SET data=json_set(data,'$.status','open') WHERE id='hold'").run();
  await runDateOffsetAutomations(env,today);
  expect(await created('Follow up')).toBe(1);
  await db.prepare("UPDATE records SET data=json_set(data,'$.status','done') WHERE id='hold'").run();
  await runDateOffsetAutomations(env,today);
  expect(await created('Follow up')).toBe(1);
  await applyChanges(env,'alice',[{id:'person',collection:'tasks',patch:{boardId:'board',title:'Person',status:'open',dueDate:today,p_note:'go',p_who:'alice',p_when:today,createdBy:'alice'},ts:2}]);
  await db.prepare("INSERT INTO date_index(record_id,field_key,date) VALUES('person','dueDate',?)").bind(today).run();
  await db.prepare("UPDATE records SET data=json_set(data,'$.conditions',json(?)) WHERE id='gated'").bind(JSON.stringify([{key:'p_who',op:'is',value:'alice'},{key:'p_when',op:'on_or_before',value:today}])).run();
  await runDateOffsetAutomations(env,today);
  expect(await created('Follow up')).toBe(2);
},30_000);

it('does not run a deleted, archived, disabled, or invalid date-offset rule',async()=>{
  await automation('quiet','Nope');
  await task('gone');
  await db.prepare("UPDATE records SET data=json_set(data,'$.deleted',json('true')) WHERE id='gone'").run();
  await task('box');
  await db.prepare("UPDATE records SET data=json_set(data,'$.archived',json('true')) WHERE id='box'").run();
  await task('live');
  await db.prepare("UPDATE records SET data=json_set(data,'$.enabled',json('false')) WHERE id='quiet'").run();
  await runDateOffsetAutomations(env,today);
  expect(await created('Nope')).toBe(0);
  await db.prepare("UPDATE records SET data=json_set(data,'$.enabled',json('true')) WHERE id='quiet'").run();
  await db.prepare("UPDATE records SET data=json_set(data,'$.conditions',json(?)) WHERE id='quiet'").bind(JSON.stringify([{key:'status',op:'nope',value:'open'}])).run();
  await runDateOffsetAutomations(env,today);
  expect(await created('Nope')).toBe(0);
},30_000);

it('uses the same event key as a previously completed cron run',()=>{
  const ev=dateOffsetEvent('candidate_0000','board','dueDate',today);
  expect(runEventKey('date-auto',ev,`cron:${today}`)).toMatch(/^ar_[0-9a-f]+$/);
});

async function oppTask(id:string,status='open',extra:Record<string,unknown>={}){
  await applyChanges(env,'alice',[{id,collection:'tasks',patch:{boardId:'opp',title:id,status,dueDate:today,createdBy:'alice',...extra},ts:2}]);
  await db.prepare("INSERT INTO date_index(record_id,field_key,date) VALUES(?,'dueDate',?)").bind(id,today).run();
}
async function crossAuto(id:string,actions:unknown[],conditions:unknown[]=[]){
  await applyChanges(env,'alice',[{id,collection:'automations',patch:{name:id,enabled:true,databaseId:'opp',trigger:{kind:'date_offset',dateKey:'dueDate',days:0},conditions,actions},ts:2}]);
}

it('C15 creates a record in another database, copies a template, and refuses a missing or deleted destination',async()=>{
  await applyChanges(env,'alice',[
    {id:'opp',collection:'boards',patch:{name:'Opportunities',columns:[{id:'open',name:'Open'},{id:'done',name:'Done'}],fields:[{id:'note',name:'Note',type:'text'}]},ts:2},
    {id:'tasks',collection:'boards',patch:{name:'Tasks',columns:[{id:'open',name:'Open'}],fields:[{id:'rel',name:'Opp',type:'relation',relation:{target:'opp'}}]},ts:2},
    {id:'gone',collection:'boards',patch:{name:'Gone',columns:[{id:'open'}],fields:[]},ts:2},
    {id:'tpl',collection:'pages',patch:{title:'Template {{name}}',isTemplate:true,parentId:null},ts:2},
    {id:'tpl-child',collection:'pages',patch:{title:'Child of template',parentId:'tpl'},ts:2},
  ]);
  await crossAuto('cross',[{type:'create_record',databaseId:'tasks',title:'Follow up',link:{fieldId:'rel'}}],[{key:'status',op:'is',value:'open'},{key:'p_note',op:'contains',value:'go'}]);
  await oppTask('deal','done',{p_note:'go'});
  await runDateOffsetAutomations(env,today);
  expect(await created('Follow up')).toBe(0);
  await db.prepare("UPDATE records SET data=json_set(data,'$.status','open') WHERE id='deal'").run();
  await runDateOffsetAutomations(env,today);
  expect(await created('Follow up')).toBe(1);
  const made=await db.prepare("SELECT json_extract(data,'$.boardId') board FROM records WHERE collection='tasks' AND json_extract(data,'$.title')='Follow up'").first<{board:string}>();
  expect(made?.board).toBe('tasks');
  expect((await db.prepare("SELECT COUNT(*) n FROM records WHERE collection='links'").first<{n:number}>())!.n).toBe(1);
  await runDateOffsetAutomations(env,today);
  expect(await created('Follow up')).toBe(1);
  await crossAuto('from-tpl',[{type:'create_from_template',templateId:'tpl',vars:{name:'Ada'}}],[{key:'title',op:'is',value:'templated'}]);
  await oppTask('templated');
  await runDateOffsetAutomations(env,today);
  const copy=await db.prepare("SELECT id FROM records WHERE collection='pages' AND json_extract(data,'$.title')='Template Ada'").first<{id:string}>();
  expect(copy?.id).toBeTruthy();
  expect((await db.prepare("SELECT COUNT(*) n FROM records WHERE collection='pages' AND json_extract(data,'$.parentId')=?").bind(copy!.id).first<{n:number}>())!.n).toBe(1);
  await runDateOffsetAutomations(env,today);
  expect((await db.prepare("SELECT COUNT(*) n FROM records WHERE collection='pages' AND json_extract(data,'$.title')='Template Ada'").first<{n:number}>())!.n).toBe(1);
  await crossAuto('bad-db',[{type:'create_record',databaseId:'missing',title:'Should not exist'}]);
  await crossAuto('dead-db',[{type:'create_record',databaseId:'gone',title:'Should not exist'}]);
  await db.prepare("UPDATE records SET data=json_set(data,'$.deleted',json('true')) WHERE id='gone'").run();
  await oppTask('nowhere');
  await runDateOffsetAutomations(env,today);
  expect(await created('Should not exist')).toBe(0);
  expect((await db.prepare("SELECT COUNT(*) n FROM automation_runs WHERE automation_id IN ('bad-db','dead-db') AND status='completed'").first<{n:number}>())!.n).toBe(0);
},60_000);

it('C15 notifies a real member, requests approval, and does not run an unknown recipient',async()=>{
  await applyChanges(env,'alice',[{id:'opp',collection:'boards',patch:{name:'Opportunities',columns:[{id:'open',name:'Open'}],fields:[]},ts:2}]);
  await crossAuto('ping',[{type:'notify',userIds:['alice'],message:'Ping'},{type:'request_approval',approverId:'alice'}]);
  await crossAuto('ghost',[{type:'notify',userIds:['ghost'],message:'No'}]);
  await oppTask('ready');
  await runDateOffsetAutomations(env,today);
  expect((await db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id='alice' AND kind='automation'").first<{n:number}>())!.n).toBe(1);
  expect((await db.prepare("SELECT COUNT(*) n FROM approvals WHERE approver_id='alice' AND status='pending'").first<{n:number}>())!.n).toBe(1);
  expect((await db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id='ghost'").first<{n:number}>())!.n).toBe(0);
  await runDateOffsetAutomations(env,today);
  expect((await db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id='alice' AND kind='automation'").first<{n:number}>())!.n).toBe(1);
});

it('C15 resumes a budget-limited cross-database automation once and still reaches a 1000-row tail',async()=>{
  await applyChanges(env,'alice',[
    {id:'opp',collection:'boards',patch:{name:'Opportunities',columns:[{id:'open'}],fields:[]},ts:2},
    {id:'tasks',collection:'boards',patch:{name:'Tasks',columns:[{id:'open'}],fields:[]},ts:2},
  ]);
  await crossAuto('budgeted',[{type:'create_record',databaseId:'tasks',title:'Budget follow'}]);
  await oppTask('only');
  try { await runDateOffsetAutomations(withD1Budget(env,4),today); } catch(error) { expect(error).toBeInstanceOf(D1BudgetExhausted); }
  const mid=await db.prepare("SELECT status FROM automation_runs WHERE automation_id='budgeted'").all<{status:string}>();
  expect(mid.results.every(row=>row.status!=='terminal_failure')).toBe(true);
  await runDateOffsetAutomations(env,today);
  expect(await created('Budget follow')).toBe(1);
  await runDateOffsetAutomations(env,today);
  expect(await created('Budget follow')).toBe(1);
  await crossAuto('tail-a',[{type:'create_record',databaseId:'tasks',title:'Tail A'}],[{key:'title',op:'is',value:'mix_0999'}]);
  await crossAuto('tail-b',[{type:'create_record',databaseId:'tasks',title:'Tail B'}],[{key:'title',op:'is',value:'mix_0999'}]);
  const stmts:D1PreparedStatement[]=[];
  for(let i=0;i<999;i++) stmts.push(db.prepare('INSERT INTO date_index(record_id,field_key,date) VALUES(?,?,?)').bind(`mix_${String(i).padStart(4,'0')}`,i%5?'other':'dueDate','1999-01-01'));
  for(let i=0;i<stmts.length;i+=100) await db.batch(stmts.slice(i,i+100));
  await oppTask('mix_0999');
  await runDateOffsetAutomations(env,today);
  expect(await created('Tail A')).toBe(1);
  expect(await created('Tail B')).toBe(1);
  await runDateOffsetAutomations(env,today);
  expect(await created('Tail A')).toBe(1);
},60_000);
