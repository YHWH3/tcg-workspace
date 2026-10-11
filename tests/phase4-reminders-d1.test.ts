import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {runDueReminders} from '../worker/reminders';
import {withD1Budget,D1BudgetExhausted} from '../worker/d1budget';
import {applyChanges} from '../worker/sync';
import {todayUtc,addDays} from '../shared/recurrence';
import type {Env} from '../worker/auth';

let mf:Miniflare,db:D1Database,env:Env;
const today=todayUtc();
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'phase4-reminders',modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-09-25',d1Databases:{DB:'disposable-reminders'}}]}));
  db=await mf.getD1Database('DB') as D1Database;
  env={DB:db} as Env;
  const folder=fileURLToPath(new URL('../migrations/',import.meta.url));
  for(const file of readdirSync(folder).filter(f=>f.endsWith('.sql')).sort()){
    const sql=readFileSync(`${folder}/${file}`,'utf8').replace(/--[^\n]*/g,'');
    await db.batch((sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi)??[]).map(s=>db.prepare(s.trim())));
  }
  await db.prepare("INSERT INTO users(id,username,name,role,prefs) VALUES('alice','alice','Alice','admin',NULL)").run();
  await db.prepare("INSERT INTO users(id,username,name,role,prefs) VALUES('bob','bob','Bob','member',?)").bind(JSON.stringify({notifications:{due_soon:'off',overdue:'off'}})).run();
  await applyChanges(env,'alice',[{id:'board',collection:'boards',patch:{name:'Work',columns:[{id:'open',name:'Open'},{id:'done',name:'Done'}],fields:[]},ts:1}]);
});
afterEach(()=>mf.dispose());

async function task(id:string,due:string,assignee='alice',extra:Record<string,unknown>={}){
  await applyChanges(env,'alice',[{id,collection:'tasks',patch:{boardId:'board',title:id,status:'open',dueDate:due,assigneeId:assignee,createdBy:'alice',...extra},ts:1}]);
  await db.prepare('INSERT OR REPLACE INTO date_index(record_id,field_key,date) VALUES(?,?,?)').bind(id,'dueDate',due).run();
}
const sent=async(id:string)=> (await db.prepare("SELECT COUNT(*) n FROM reminder_sent WHERE record_id=?").bind(id).first<{n:number}>())!.n;
const notes=async(id:string)=> (await db.prepare("SELECT COUNT(*) n FROM notifications WHERE target_id=?").bind(id).first<{n:number}>())!.n;

it('delivers a newly urgent earlier date within one lookbehind while the forward backlog remains',async()=>{
  const early=addDays(today,-3), later=addDays(today,1);
  await db.prepare("INSERT INTO rhythm_sweep_cursors(name,date,record_id,field_key) VALUES('reminders',?, 'm', 'dueDate')").bind(today).run();
  const laterRows=Array.from({length:30},(_,i)=>db.prepare('INSERT INTO date_index(record_id,field_key,date) VALUES(?,?,?)').bind(`later_${String(i).padStart(3,'0')}`,'dueDate',later));
  await db.batch(laterRows);
  for(const stmt of laterRows) void stmt;
  for(let i=0;i<30;i++) await applyChanges(env,'alice',[{id:`later_${String(i).padStart(3,'0')}`,collection:'tasks',patch:{boardId:'board',title:'later',status:'open',dueDate:later,assigneeId:'alice'},ts:1}]);
  await task('urgent',early);
  await runDueReminders(env,today);
  expect(await sent('urgent')).toBe(1);
  expect(await notes('urgent')).toBe(1);
  const forward=await db.prepare("SELECT date FROM rhythm_sweep_cursors WHERE name='reminders'").first<{date:string}>();
  expect(forward?.date).not.toBe('');
  await db.batch(Array.from({length:10},(_,i)=>db.prepare('INSERT INTO date_index(record_id,field_key,date) VALUES(?,?,?)').bind(`more_${i}`,'dueDate',later)));
  await runDueReminders(env,today);
  expect(await sent('urgent')).toBe(1);
  expect(await notes('urgent')).toBe(1);
},60_000);

it('follows date moves, reassignment, archive, missing and opted-out recipients without a second delivery',async()=>{
  await task('move',addDays(today,20));
  await runDueReminders(env,today);
  expect(await sent('move')).toBe(0);
  await db.prepare('UPDATE date_index SET date=? WHERE record_id=?').bind(today,'move').run();
  await db.prepare("UPDATE records SET data=json_set(data,'$.dueDate',?) WHERE id='move'").bind(today).run();
  await runDueReminders(env,today);
  expect(await sent('move')).toBe(1);
  await db.prepare('UPDATE date_index SET date=? WHERE record_id=?').bind(addDays(today,20),'move').run();
  await runDueReminders(env,today);
  expect(await sent('move')).toBe(1);
  await task('solo',today,'');
  await db.prepare("UPDATE records SET data=json_remove(data,'$.assigneeId') WHERE id='solo'").run();
  await runDueReminders(env,today);
  expect(await sent('solo')).toBe(0);
  await task('quiet',today,'bob');
  const later=addDays(today,1);
  for(let i=0;i<6;i++) await task(`hold_${i}`,later);
  await runDueReminders(env,today);
  expect(await sent('quiet')).toBe(0);
  await db.prepare("UPDATE records SET data=json_set(data,'$.assigneeId','alice') WHERE id='quiet'").run();
  for(let i=0;i<8 && (await sent('quiet'))===0;i++) await runDueReminders(env,today);
  expect(await sent('quiet')).toBe(1);
  expect(await notes('quiet')).toBe(1);
  const owner=await db.prepare("SELECT user_id FROM notifications WHERE target_id='quiet'").first<{user_id:string}>();
  expect(owner?.user_id).toBe('alice');
  const stillForward=await db.prepare("SELECT date FROM rhythm_sweep_cursors WHERE name='reminders'").first<{date:string}>();
  expect(stillForward?.date).toBeTruthy();
  await task('clear',today);
  await db.prepare("DELETE FROM date_index WHERE record_id='clear'").run();
  await db.prepare("UPDATE records SET data=json_remove(data,'$.dueDate') WHERE id='clear'").run();
  await runDueReminders(env,today);
  expect(await sent('clear')).toBe(0);
  await db.prepare("UPDATE records SET data=json_set(data,'$.dueDate',?) WHERE id='clear'").bind(today).run();
  await db.prepare('INSERT INTO date_index(record_id,field_key,date) VALUES(?,?,?)').bind('clear','dueDate',today).run();
  for(let i=0;i<8 && (await sent('clear'))===0;i++) await runDueReminders(env,today);
  expect(await sent('clear')).toBe(1);
  await runDueReminders(env,today);
  expect(await sent('clear')).toBe(1);
  await task('box',today);
  await db.prepare("UPDATE records SET data=json_set(data,'$.archived',json('true')) WHERE id='box'").run();
  await runDueReminders(env,today);
  expect(await sent('box')).toBe(0);
  await db.prepare("UPDATE records SET data=json_set(data,'$.archived',json('false')) WHERE id='box'").run();
  for(let i=0;i<8 && (await sent('box'))===0;i++) await runDueReminders(env,today);
  expect(await sent('box')).toBe(1);
  await runDueReminders(env,today);
  expect(await sent('box')).toBe(1);
},30_000);

it('does not double-deliver under concurrent runs or a notification failure, and a budget stop stays retryable',async()=>{
  await task('once',today);
  await Promise.all([runDueReminders(env,today),runDueReminders(env,today)]);
  expect(await sent('once')).toBe(1);
  expect(await notes('once')).toBe(1);
  await task('boom',today);
  await db.prepare("CREATE TRIGGER note_fault BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'note fault'); END").run();
  await expect(runDueReminders(env,today)).rejects.toThrow(/note fault/);
  expect(await sent('boom')).toBe(0);
  await db.prepare('DROP TRIGGER note_fault').run();
  await runDueReminders(env,today);
  expect(await sent('boom')).toBe(1);
  await task('tight',addDays(today,-1));
  try { await runDueReminders(withD1Budget(env,6),today); } catch(error) { expect(error).toBeInstanceOf(D1BudgetExhausted); }
  await runDueReminders(env,today);
  expect(await sent('tight')).toBeLessThanOrEqual(1);
  expect(await notes('tight')).toBeLessThanOrEqual(1);
});

it('restarts after the forward scan empties and still sends a later urgent row once',async()=>{
  await task('done-today',today);
  await runDueReminders(env,today);
  expect(await sent('done-today')).toBe(1);
  await runDueReminders(env,today);
  expect(await db.prepare("SELECT COUNT(*) n FROM rhythm_sweep_cursors WHERE name='reminders'").first<{n:number}>()).toMatchObject({n:0});
  await task('after-wrap',addDays(today,-2));
  await runDueReminders(env,today);
  expect(await sent('after-wrap')).toBe(1);
  await runDueReminders(env,today);
  expect(await sent('after-wrap')).toBe(1);
});

it('delivers an earlier row behind five unsent reminders within two runs while later rows remain',async()=>{
  const early=addDays(today,-2), later=addDays(today,1);
  await db.prepare("INSERT INTO rhythm_sweep_cursors(name,date,record_id,field_key) VALUES('reminders',?,'m','dueDate')").bind(today).run();
  for(let i=0;i<5;i++) await task(`ahead_${i}`,early);
  await task('sixth',early);
  await db.batch(Array.from({length:12},(_,i)=>db.prepare('INSERT INTO date_index(record_id,field_key,date) VALUES(?,?,?)').bind(`tail_${i}`,'dueDate',later)));
  for(let i=0;i<12;i++) await applyChanges(env,'alice',[{id:`tail_${i}`,collection:'tasks',patch:{boardId:'board',title:'tail',status:'open',dueDate:later,assigneeId:'alice'},ts:1}]);
  await runDueReminders(env,today);
  expect(await sent('sixth')).toBe(0);
  const held=await db.prepare("SELECT date FROM rhythm_sweep_cursors WHERE name='reminders'").first<{date:string}>();
  expect(held?.date).toBe(today);
  await runDueReminders(env,today);
  expect(await sent('sixth')).toBe(1);
  expect(await notes('sixth')).toBe(1);
  await runDueReminders(env,today);
  expect(await sent('sixth')).toBe(1);
},60_000);

it('reaches one urgent row among 1000 indexed dates without a second send',async()=>{
  await db.batch(Array.from({length:1000},(_,i)=>db.prepare("INSERT INTO date_index(record_id,field_key,date) VALUES(?,'dueDate','2020-01-01')").bind(`old_${String(i).padStart(4,'0')}`)));
  await db.batch(Array.from({length:1000},(_,i)=>db.prepare("INSERT INTO reminder_sent(record_id,field_key,date,kind,created_at) VALUES(?,'dueDate','2020-01-01','overdue',?)").bind(`old_${String(i).padStart(4,'0')}`,Date.now())));
  await db.prepare("INSERT INTO rhythm_sweep_cursors(name,date,record_id,field_key) VALUES('reminders','2024-01-01','z','dueDate')").run();
  await task('fresh',addDays(today,-1));
  await db.prepare("INSERT INTO date_index(record_id,field_key,date) VALUES('ahead','dueDate',?)").bind(addDays(today,1)).run();
  await runDueReminders(env,today);
  expect(await sent('fresh')).toBe(1);
  await runDueReminders(env,today);
  expect(await notes('fresh')).toBe(1);
},30_000);
