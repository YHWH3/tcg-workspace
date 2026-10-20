import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {openAuditFixture,type AuditFixture} from './audit-fixture';
import {runWeeklyDigests} from '../worker/aiDigest';
let f:AuditFixture;
const now=Date.now();
beforeEach(async()=>{
 f=await openAuditFixture();await f.db.batch([
  f.db.prepare('UPDATE access_state SET enabled=1'),
  f.db.prepare(`INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES('approval-page','pages','{"title":"Confidential approval"}','{}',1,'space-core'),('board','boards','{"name":"Tasks"}','{}',2,'space-core')`),
 ]);
});
afterEach(async()=>f.dispose());
async function approval(){await f.db.prepare("INSERT INTO approvals(id,target_type,target_id,requested_by,approver_id,status,created_at) VALUES('a','page','approval-page','bob','alice','pending',?)").bind(now).run();}
async function task(){await f.db.prepare(`INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES('due','tasks','{"title":"Overdue","boardId":"board","dueDate":"2020-01-01"}','{}',3,'space-core')`).run();}
const count=()=>f.db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id='alice' AND group_key LIKE 'weekly-digest:%'").first<number>('n');
describe('P6-R02 weekly digest — actual D1; permissions ENABLED unless labelled',()=>{
 it('delivers pending approvals without qualifying task records',async()=>{await approval();await runWeeklyDigests(f.env,now);expect(await count()).toBe(1);expect(await f.db.prepare("SELECT target_id FROM notifications WHERE user_id='alice'").first('target_id')).toBe('approval-page');});
 it.each(['tasks','both','none'])('handles %s actionable content and repeated same-week scheduling',async mode=>{if(mode==='both')await approval();if(mode!=='none')await task();await runWeeklyDigests(f.env,now);await runWeeklyDigests(f.env,now);expect(await count()).toBe(mode==='none'?0:1);});
 it('never targets a revoked approval',async()=>{await approval();await f.db.prepare("INSERT INTO space_members(space_id,user_id,role,access) VALUES('space-core','alice','viewer','deny')").run();await runWeeklyDigests(f.env,now);expect(await count()).toBe(0);});
 it('skips disabled recipients',async()=>{await approval();await f.db.prepare("UPDATE users SET disabled_at=1 WHERE id='alice'").run();await runWeeklyDigests(f.env,now);expect(await count()).toBe(0);expect(await f.db.prepare("SELECT COUNT(*) n FROM ai_digest_runs WHERE user_id='alice'").first('n')).toBe(0);});
 it('respects explicit automation notifications-off',async()=>{await approval();await f.db.prepare(`UPDATE users SET prefs='{"notifications":{"automation":"off"}}' WHERE id='alice'`).run();await runWeeklyDigests(f.env,now);expect(await count()).toBe(0);});
 it('retries failed delivery without duplicating an approval-only digest',async()=>{await approval();await f.db.prepare("CREATE TRIGGER fail_weekly BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'injected'); END").run();await runWeeklyDigests(f.env,now);expect(await f.db.prepare("SELECT attempts FROM ai_digest_runs WHERE user_id='alice'").first('attempts')).toBe(1);await f.db.prepare('DROP TRIGGER fail_weekly').run();await f.db.prepare('UPDATE ai_digest_runs SET retry_at=0').run();await runWeeklyDigests(f.env,now);await runWeeklyDigests(f.env,now);expect(await count()).toBe(1);});
 it('DISABLED: retains approval-only compatibility',async()=>{await approval();await f.db.prepare('UPDATE access_state SET enabled=0').run();await runWeeklyDigests(f.env,now);expect(await count()).toBe(1);});
});
it('records preference suppression separately from successful delivery and empty work',async()=>{
 await approval();await f.db.prepare(`UPDATE users SET prefs='{"notifications":{"automation":"off"}}' WHERE id='alice'`).run();await runWeeklyDigests(f.env,now);
 expect(await f.db.prepare("SELECT outcome FROM ai_digest_runs WHERE user_id='alice'").first('outcome')).toBe('preferences_off');expect(await count()).toBe(0);
});
it('records no-content terminal processing without claiming a notification was delivered',async()=>{await runWeeklyDigests(f.env,now);expect(await f.db.prepare("SELECT outcome FROM ai_digest_runs WHERE user_id='alice'").first('outcome')).toBe('no_content');expect(await count()).toBe(0);});
it('revocation at the notification transaction barrier rolls back the delivery checkpoint',async()=>{
 await approval();let injected=false;
 const raced=new Proxy(f.db,{get(t,k){if(k==='batch')return async(stmts:D1PreparedStatement[])=>{if(!injected&&stmts.some(s=>String((s as unknown as {statement:string}).statement).includes('INSERT INTO notifications'))){injected=true;await t.prepare("INSERT INTO space_members(space_id,user_id,role,access) VALUES('space-core','alice','viewer','deny')").run();}return t.batch(stmts);};const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;}});
 await runWeeklyDigests({...f.env,DB:raced},now);expect(injected).toBe(true);expect(await count()).toBe(0);expect(await f.db.prepare("SELECT delivered FROM ai_digest_runs WHERE user_id='alice'").first('delivered')).toBe(0);
 await f.db.prepare("DELETE FROM space_members WHERE user_id='alice'").run();await f.db.prepare('UPDATE ai_digest_runs SET retry_at=0').run();await runWeeklyDigests(f.env,now);expect(await count()).toBe(1);
});
it('a lost notification commit acknowledgement retains its terminal checkpoint and deduplication',async()=>{
 await approval();let injected=false;
 const raced=new Proxy(f.db,{get(t,k){if(k==='batch')return async(stmts:D1PreparedStatement[])=>{const result=await t.batch(stmts);if(!injected&&stmts.some(s=>String((s as unknown as {statement:string}).statement).includes('INSERT INTO notifications'))){injected=true;throw new Error('lost commit acknowledgement');}return result;};const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;}});
 await runWeeklyDigests({...f.env,DB:raced},now);expect(injected).toBe(true);expect(await count()).toBe(1);expect(await f.db.prepare("SELECT outcome FROM ai_digest_runs WHERE user_id='alice'").first('outcome')).toBe('delivered');await runWeeklyDigests(f.env,now);expect(await count()).toBe(1);
});
it('dead-letters delivery after eight failed attempts without a false delivered outcome',async()=>{
 await approval();await f.db.prepare("CREATE TRIGGER fail_weekly BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'persistent failure'); END").run();for(let i=0;i<9;i++)await runWeeklyDigests(f.env,now+i*3600001);
 const row=await f.db.prepare("SELECT attempts,delivered,outcome FROM ai_digest_runs WHERE user_id='alice'").first();expect(row).toMatchObject({attempts:8,delivered:0,outcome:'pending'});expect(await count()).toBe(0);
});

it('bounded scheduler reaches the approval recipient after an earlier-ID empty user',async()=>{
 await approval();await f.db.prepare("INSERT INTO users(id,username,name,role) VALUES('000-first','empty-first','Empty first','member')").run();
 await runWeeklyDigests(f.env,now);expect(await count()).toBe(0);expect(await f.db.prepare("SELECT outcome FROM ai_digest_runs WHERE user_id='000-first'").first('outcome')).toBe('no_content');
 await runWeeklyDigests(f.env,now);expect(await count()).toBe(1);expect(await f.db.prepare("SELECT outcome FROM ai_digest_runs WHERE user_id='alice'").first('outcome')).toBe('delivered');
 await runWeeklyDigests(f.env,now);expect(await count()).toBe(1);
});
