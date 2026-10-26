import {afterEach,describe,it,expect,vi} from 'vitest';
import {openAuditFixture,ctx,type AuditFixture} from './audit-fixture';
import {workspaceSettingsApi,withWorkspaceContext,readWorkspaceSettings,serverToday} from '../worker/workspaceSettings';
import {withD1Budget,d1BudgetRemaining} from '../worker/d1budget';
import {runDueReminders} from '../worker/reminders';
import {buildDigest} from '../worker/aiDigest';
import {runDateOffsetAutomations} from '../worker/automations';
import {applyChanges} from '../worker/sync';
let fx:AuditFixture|undefined;
afterEach(async()=>{vi.restoreAllMocks();await fx?.dispose();fx=undefined;});
const body={timeZone:'Asia/Kolkata',currency:'INR',weekStart:0,version:1};
async function request(method='GET',data:unknown=undefined,user='alice',env=fx!.env){
 const scoped=withWorkspaceContext(withD1Budget(env));
 const response=await workspaceSettingsApi.request('/settings',{method,headers:user?fx!.auth(user):{},...(data===undefined?{}:{body:JSON.stringify(data)})},scoped,ctx);
 expect(45-d1BudgetRemaining(scoped.DB)).toBeLessThanOrEqual(45);
 return response;
}
describe.each([false,true])('workspace locale permissions=%s',enabled=>{
 async function setup(){fx=await openAuditFixture();await fx.db.prepare('UPDATE access_state SET enabled=? WHERE id=1').bind(enabled?1:0).run();}
 it('authenticates reads and canonical admin-only edits with version CAS and audit',async()=>{
  await setup();expect((await request('GET',undefined,'')).status).toBe(401);
  const initial=await (await request()).json() as any;expect(initial.settings).toMatchObject({timeZone:'UTC',currency:'INR',weekStart:1,version:1});
  expect((await request('PUT',body,'bob')).status).toBe(403);
  const updated=await request('PUT',body);expect(updated.status).toBe(200);
  expect((await updated.json() as any).settings).toMatchObject({...body,version:2});
  expect((await request('PUT',body)).status).toBe(409);
  const audit=await fx!.db.prepare("SELECT before_json,after_json FROM access_audit WHERE action='workspace_settings.update'").all<any>();
  expect(audit.results).toHaveLength(1);expect(JSON.parse(audit.results[0].before_json).timeZone).toBe('UTC');expect(JSON.parse(audit.results[0].after_json).timeZone).toBe('Asia/Kolkata');
  await fx!.db.prepare("UPDATE users SET workspace_role='member' WHERE id='alice'").run();
  expect((await request('PUT',{...body,version:2})).status).toBe(403);
 });
 it('rejects invalid settings and lets only one concurrent same-version edit commit',async()=>{
  await setup();
  for(const patch of [{timeZone:'Invalid/Zone'},{currency:'XYZ'},{currency:'inr'},{weekStart:7},{weekStart:.5},{version:0}])expect((await request('PUT',{...body,...patch})).status).toBe(400);
  const results=await Promise.all([request('PUT',body),request('PUT',{...body,currency:'USD'})]);
  expect(results.map(r=>r.status).sort()).toEqual([200,409]);
  expect(await fx!.db.prepare("SELECT COUNT(*) n FROM access_audit WHERE action='workspace_settings.update'").first('n')).toBe(1);
 });
 it('fences session revocation or canonical demotion at the commit',async()=>{
  await setup();const raw=fx!.db;
  const raced=new Proxy(raw,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{await raw.prepare("UPDATE users SET workspace_role='member' WHERE id='alice'").run();return target.batch(statements);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
  expect((await request('PUT',body,'alice',{...fx!.env,DB:raced})).status).toBe(409);
  expect(await raw.prepare("SELECT version FROM workspace_settings WHERE id='workspace'").first('version')).toBe(1);
  expect(await raw.prepare("SELECT COUNT(*) n FROM access_audit WHERE action='workspace_settings.update'").first('n')).toBe(0);
 });
 it('shares one settings SELECT within a request but refreshes the next request',async()=>{
  await setup();const env=withWorkspaceContext(withD1Budget(fx!.env));const start=d1BudgetRemaining(env.DB);
  const now=Date.parse('2026-10-24T20:00Z');expect(await serverToday(env,now)).toBe('2026-10-24');await readWorkspaceSettings(env);await serverToday(env,now);
  expect(start-d1BudgetRemaining(env.DB)).toBe(1);
  await request('PUT',body);expect(await serverToday(env,now)).toBe('2026-10-24');
  expect(await serverToday(withWorkspaceContext(fx!.env),now)).toBe('2026-10-25');
 });
 it('fires date-offset work on the workspace day and keeps duplicate sweeps idempotent',async()=>{
  await setup();
  await applyChanges(fx!.env,'alice',[
   {id:'offset-board',collection:'boards',ts:1,patch:{name:'Work',columns:[{id:'open',name:'Open'},{id:'done',name:'Done'}],fields:[]}},
   {id:'offset-source',collection:'tasks',ts:1,patch:{boardId:'offset-board',title:'Source',status:'open',dueDate:'2026-10-25',createdBy:'alice'}},
   {id:'offset-auto',collection:'automations',ts:1,patch:{name:'Follow up',enabled:true,databaseId:'offset-board',trigger:{kind:'date_offset',dateKey:'dueDate',days:0},actions:[{type:'create_record',databaseId:'offset-board',title:'Locale follow up'}]}},
  ]);
  await fx!.db.prepare("INSERT OR REPLACE INTO date_index(record_id,field_key,date) VALUES('offset-source','dueDate','2026-10-25')").run();
  const count=()=>fx!.db.prepare("SELECT COUNT(*) n FROM records WHERE collection='tasks' AND json_extract(data,'$.title')='Locale follow up'").first<number>('n');
  vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-10-24T20:00Z'));
  await runDateOffsetAutomations(fx!.env);expect(await count()).toBe(0);
  await request('PUT',body);
  for(let n=0;n<2;n++){const scoped=withWorkspaceContext(withD1Budget(fx!.env));await runDateOffsetAutomations(scoped);expect(45-d1BudgetRemaining(scoped.DB)).toBeLessThanOrEqual(45);}
  expect(await count()).toBe(1);
 });
 it('uses workspace midnight in digest and reminders without duplicate logical reminders',async()=>{
  await setup();const env=fx!.env;
  await applyChanges(env,'alice',[{id:'work',collection:'boards',ts:1,patch:{name:'Projects',columns:[{id:'open',name:'Open'},{id:'done',name:'Done'}],fields:[]}},{id:'deadline',collection:'tasks',ts:1,patch:{boardId:'work',title:'Due work',status:'open',assigneeId:'alice',createdBy:'alice',dueDate:'2026-10-25'}}]);
  await fx!.db.prepare("INSERT OR REPLACE INTO date_index(record_id,field_key,date) VALUES('deadline','dueDate','2026-10-25')").run();
  const now=Date.parse('2026-10-24T20:00Z');const utc=await buildDigest(env,'alice',now);expect(utc.today).toBe('2026-10-24');
  await runDueReminders(env,await serverToday(env,now));
  const count=await fx!.db.prepare("SELECT COUNT(*) n FROM reminder_sent WHERE record_id='deadline'").first<number>('n');expect(count).toBeGreaterThan(0);
  await request('PUT',body);const local=await buildDigest(env,'alice',now);expect(local.today).toBe('2026-10-25');expect(local.week).toBe('2026-10-25');
  await runDueReminders(env,await serverToday(env,now));await runDueReminders(env,await serverToday(env,now));
  expect(await fx!.db.prepare("SELECT COUNT(*) n FROM reminder_sent WHERE record_id='deadline'").first('n')).toBe(count);
 });
});
