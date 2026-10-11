import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {afterEach,expect,it} from 'vitest';

const folder=fileURLToPath(new URL('../migrations/',import.meta.url));
const files=readdirSync(folder).filter(f=>f.endsWith('.sql')).sort();
let mf:Miniflare;
afterEach(()=>mf?.dispose());

function statements(sql:string){
  return (sql.replace(/--[^\n]*/g,'').match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi)??[]).map(s=>s.trim()).filter(Boolean);
}
async function database(){
  mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'phase4-migrate',modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-09-25',d1Databases:{DB:'disposable-migrate'}}]}));
  return await mf.getD1Database('DB') as D1Database;
}
async function apply(db:D1Database,names:string[]){
  for(const name of names){
    const sql=readFileSync(`${folder}/${name}`,'utf8');
    await db.batch(statements(sql).map(s=>db.prepare(s)));
  }
}
async function names(db:D1Database,type:'table'|'index'){
  const rows=await db.prepare("SELECT name FROM sqlite_master WHERE type=? ORDER BY name").bind(type).all<{name:string}>();
  return new Set(rows.results.map(r=>r.name));
}

it('applies 0001 through 0010 on an empty database',async()=>{
  const db=await database();
  await apply(db,files);
  const tables=await names(db,'table');
  for(const table of ['records','event_outbox','automation_runs','form_submissions','rhythm_sweep_cursors','date_offset_marks','approvals']) expect(tables.has(table)).toBe(true);
  const indexes=await names(db,'index');
  for(const index of ['idx_date_sweep','idx_notif_inbox','idx_outbox_pending','idx_records_board_order','idx_date_offset_run']) expect(indexes.has(index)).toBe(true);
  const pending=await db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_outbox_pending'").first<{sql:string}>();
  expect(pending?.sql).toMatch(/terminal_at IS NULL/);
  await db.prepare("INSERT INTO rhythm_sweep_cursors(name,date,record_id,field_key) VALUES('reminders','2026-01-01','r','dueDate')").run();
  await db.prepare("INSERT INTO date_offset_marks(automation_id,date,field_key,record_id) VALUES('a','2026-01-01','dueDate','r')").run();
  expect((await db.prepare('SELECT COUNT(*) n FROM rhythm_sweep_cursors').first<{n:number}>())?.n).toBe(1);
});

it('upgrades a Phase 3 schema without dropping existing records',async()=>{
  const db=await database();
  await apply(db,files.filter(f=>f<'0007'));
  await db.prepare("INSERT INTO users(id,username,name,role) VALUES('alice','alice','Alice','admin')").run();
  await db.prepare("INSERT INTO records(id,collection,data,field_ts,seq,updated_by,updated_at) VALUES('page-1','pages','{\"title\":\"Keep\"}','{\"title\":1}',1,'alice',1)").run();
  await apply(db,files.filter(f=>f>='0007'));
  const row=await db.prepare("SELECT json_extract(data,'$.title') title FROM records WHERE id='page-1'").first<{title:string}>();
  expect(row?.title).toBe('Keep');
  expect((await names(db,'table')).has('date_offset_marks')).toBe(true);
});

it('upgrades a 0007 database and keeps outbox rows while mapping run status',async()=>{
  const db=await database();
  await apply(db,files.filter(f=>f<'0008'));
  await db.prepare("INSERT INTO event_outbox(id,payload,created_at) VALUES('ev1','{\"source\":\"client\"}',10)").run();
  await db.prepare("INSERT INTO automation_runs(id,automation_id,event_key,status,created_at) VALUES('run1','auto','key1','ok',10)").run();
  await apply(db,files.filter(f=>f>='0008'));
  const outbox=await db.prepare("SELECT payload,terminal_at FROM event_outbox WHERE id='ev1'").first<{payload:string;terminal_at:number|null}>();
  expect(outbox?.payload).toContain('client');
  expect(outbox?.terminal_at??null).toBeNull();
  const run=await db.prepare("SELECT status,lease_id,attempts FROM automation_runs WHERE id='run1'").first<{status:string;lease_id:string|null;attempts:number}>();
  expect(run?.status).toBe('completed');
  expect(run?.attempts??0).toBe(0);
});

it('upgrades a 0009 database and preserves leases, receipts and cursor indexes',async()=>{
  const db=await database();
  await apply(db,files.filter(f=>f<='0009'));
  await db.prepare("INSERT INTO event_outbox(id,payload,created_at,lease_id,lease_until) VALUES('ev9','{\"applied\":[]}',11,'lease',99)").run();
  await db.prepare("INSERT INTO automation_runs(id,automation_id,event_key,status,created_at,lease_id,lease_until,attempts,retry_at) VALUES('run9','auto','key9','running',11,'lease-9',123,1,0)").run();
  await db.prepare("INSERT INTO form_submissions(submission_id,form_id,state,created_at,lease_id,attempts,retry_at) VALUES('sub9','form','processing',11,'slot',1,0)").run();
  await apply(db,['0010_phase4_sweep_cursor.sql']);
  expect((await db.prepare("SELECT lease_id FROM event_outbox WHERE id='ev9'").first<{lease_id:string}>())?.lease_id).toBe('lease');
  expect((await db.prepare("SELECT lease_id,status FROM automation_runs WHERE id='run9'").first<{lease_id:string;status:string}>())).toMatchObject({lease_id:'lease-9',status:'running'});
  expect((await db.prepare("SELECT state FROM form_submissions WHERE submission_id='sub9'").first<{state:string}>())?.state).toBe('processing');
  expect((await names(db,'table')).has('rhythm_sweep_cursors')).toBe(true);
  expect((await names(db,'index')).has('idx_date_sweep')).toBe(true);
});
