import {afterEach,expect,it} from 'vitest';
import {openAuditFixture,type AuditFixture} from './audit-fixture';
import {notificationsForEvent} from '../worker/notifications';
import {withD1Budget,d1BudgetRemaining} from '../worker/d1budget';
import type {SemanticEvent} from '../shared/events';
let f:AuditFixture;afterEach(async()=>f?.dispose());
async function setup(enabled=1,text='Notify @[group:space-core]'){
 f=await openAuditFixture();await f.db.batch([
  f.db.prepare('UPDATE access_state SET enabled=?').bind(enabled),
  f.db.prepare("INSERT INTO records(id,collection,data,field_ts,seq) VALUES('page','pages','{\"title\":\"Shared work\"}','{}',1)"),
  f.db.prepare("INSERT INTO records(id,collection,data,field_ts,seq) VALUES('body','blocks',?,'{}',2)").bind(JSON.stringify({pageId:'page',type:'p',text})),
 ]);
}
const group=(id='space-core'):SemanticEvent=>({kind:'mention.created',recordId:'body',collection:'blocks',targetId:'page',targetType:'page',groupId:id});
const context={source:'client' as const,userId:'alice',outboxId:'space-test'};
const rows=async()=> (await f.db.prepare('SELECT user_id,group_count,body FROM notifications ORDER BY user_id').all<{user_id:string;group_count:number;body:string}>()).results;
async function privateSpace(id='group-private',members=['alice','bob']){
 await f.db.batch([f.db.prepare("INSERT INTO spaces(id,name,default_access,export_policy,created_by,created_at) VALUES(?,?,'private','members','alice',1)").bind(id,id),...members.map(user=>f.db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES(?,?,'viewer')").bind(id,user))]);
}
it.each([0,1])('mode %i: fans out to current members, excludes the author and preserves delivery receipts',async mode=>{
 await setup(mode);await notificationsForEvent(f.env,[group()],context);await notificationsForEvent(f.env,[group()],context);
 expect(await rows()).toMatchObject([{user_id:'bob',group_count:1},{user_id:'carol',group_count:1}]);expect((await rows())[0].body).not.toContain('@[group:');
});
it('deduplicates overlapping Space and direct mentions with the established direct receipt identity',async()=>{
 await setup(1,'@[user:bob] @[group:space-core] @[group:group-private]');await privateSpace();
 const events=[{...group(),groupId:undefined,to:'bob'},group(),group('group-private')];
 await notificationsForEvent(f.env,events,context);await notificationsForEvent(f.env,events,context);
 expect(await rows()).toMatchObject([{user_id:'bob',group_count:1},{user_id:'carol',group_count:1}]);
 expect(await f.db.prepare("SELECT notification_id FROM notification_deliveries WHERE delivery_key='bob|event:space-test:0'").first()).not.toBeNull();
});
it('does not broadcast to a private Space the author cannot read',async()=>{
 await setup(1,'@[group:group-private]');await privateSpace('group-private',['bob']);await notificationsForEvent(f.env,[group('group-private')],context);expect(await rows()).toEqual([]);
});
it('intersects Space membership with target and source readability',async()=>{
 await setup();await privateSpace('target-private');await f.db.prepare("UPDATE records SET space_id='target-private',seq=3 WHERE id='page'").run();await notificationsForEvent(f.env,[group()],context);expect(await rows()).toMatchObject([{user_id:'bob'}]);
});
it('respects disabled members and notification preferences',async()=>{
 await setup();await f.db.batch([f.db.prepare("UPDATE users SET disabled_at=1 WHERE id='bob'"),f.db.prepare("UPDATE users SET prefs='{\"notifications\":{\"mention\":\"off\"}}' WHERE id='carol'")]);await notificationsForEvent(f.env,[group()],context);expect(await rows()).toEqual([]);
});
it.each(['removed-token','moved','deleted'] as const)('does not copy obsolete source text after %s',async change=>{
 await setup();const patch=change==='removed-token'?{text:'No mention'}:change==='moved'?{pageId:'elsewhere'}:{deleted:true};
 await f.db.prepare("UPDATE records SET data=json_patch(data,?),seq=3 WHERE id='body'").bind(JSON.stringify(patch)).run();await notificationsForEvent(f.env,[group()],context);expect(await rows()).toEqual([]);
});
it.each(['membership','source','preferences'] as const)('a raced %s change rolls back all recipients and receipts, then recovers on retry',async change=>{
 await setup(1,'@[group:group-private]');await privateSpace('group-private',['alice','bob','carol']);let calls=0;
 const raced=new Proxy(f.db,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{calls++;if(calls===3){
  if(change==='membership')await target.prepare("DELETE FROM space_members WHERE space_id='group-private' AND user_id='bob'").run();
  if(change==='source')await target.prepare("UPDATE records SET data=json_set(data,'$.text','Updated'),seq=3 WHERE id='body'").run();
  if(change==='preferences')await target.prepare("UPDATE users SET prefs='{\"notifications\":{\"mention\":\"off\"}}' WHERE id='bob'").run();
 }return target.batch(statements);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 await expect(notificationsForEvent({DB:raced},[group('group-private')],context)).rejects.toThrow();expect(await rows()).toEqual([]);expect((await f.db.prepare('SELECT COUNT(*) n FROM notification_deliveries').first())?.n).toBe(0);
 await notificationsForEvent(f.env,[group('group-private')],context);expect((await rows()).map(row=>row.user_id)).toEqual(change==='source'?[]:['carol']);
});
it('caps 25 synthetic members at 20 deliveries using four binding calls',async()=>{
 await setup();await f.db.batch(Array.from({length:23},(_,i)=>f.db.prepare("INSERT INTO users(id,username,name,role) VALUES(?,?,?,'member')").bind('synthetic'+i,'synthetic'+i,'Synthetic '+i)));
 const budget=withD1Budget(f.env),before=d1BudgetRemaining(budget.DB);await notificationsForEvent(budget,[group()],context);
 expect((await rows()).length).toBe(20);expect(before-d1BudgetRemaining(budget.DB)).toBe(4);
});
