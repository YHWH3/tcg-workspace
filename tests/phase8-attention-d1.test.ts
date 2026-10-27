import {afterEach,describe,it,expect,vi} from 'vitest';
import {openAuditFixture,ctx,type AuditFixture} from './audit-fixture';
import {attentionApi,collectAttention} from '../worker/attention';
import {applyChanges} from '../worker/sync';
import {withD1Budget,d1BudgetRemaining} from '../worker/d1budget';
import {withWorkspaceContext} from '../worker/workspaceSettings';
import {proposePreview} from '../worker/aiPreviews';
import type {Env} from '../worker/auth';
let fx:AuditFixture|undefined;
const NOW=Date.parse('2026-10-27T12:00:00Z');
afterEach(async()=>{vi.restoreAllMocks();await fx?.dispose();fx=undefined;});
async function seed(enabled:boolean){
 vi.spyOn(Date,'now').mockReturnValue(NOW);fx=await openAuditFixture();await fx.db.prepare('UPDATE access_state SET enabled=? WHERE id=1').bind(enabled?1:0).run();
 await applyChanges(fx.env,'alice',[
  {id:'work',collection:'boards',ts:1,patch:{name:'Work',columns:[{id:'open',name:'Open'},{id:'done',name:'Done'}],fields:[],attention:{enabled:true,personKey:'assigneeId',dateKey:'dueDate',triage:true}}},
  ...['late','today','soon','far','done','unassigned','bob-task'].map((id,i)=>({id,collection:'tasks',ts:1,patch:{boardId:'work',title:id,createdBy:'alice',status:id==='done'?'done':'open',assigneeId:id==='unassigned'?null:id==='bob-task'?'bob':'alice',dueDate:i===0?'2026-10-26':i===1?'2026-10-27':i===2?'2026-10-30':i===3?'2026-10-31':'2026-10-26',description:'NEVER_INCLUDE_ANSWERS'}})),
  {id:'auto',collection:'automations',ts:1,patch:{name:'Follow up',databaseId:'work',enabled:false,trigger:{kind:'record_created'},actions:[]}},
 ]);
 for(const [id,date] of [['late','2026-10-26'],['today','2026-10-27'],['soon','2026-10-30'],['far','2026-10-31'],['done','2026-10-26'],['bob-task','2026-10-26']])await fx.db.prepare('INSERT INTO date_index(record_id,field_key,date) VALUES(?,?,?)').bind(id,'dueDate',date).run();
 await fx.db.batch([
  fx.db.prepare("INSERT INTO approvals(id,target_type,target_id,requested_by,approver_id,status,created_at,note) VALUES('approval','record','late','bob','alice','pending',?,'NEVER_INCLUDE_OLD_COPY')").bind(NOW-1000),
  fx.db.prepare("INSERT INTO ai_suggestions(id,user_id,target_id,source_hash,source_rev,patch_json,rationale,provider,model,created_at) VALUES('suggestion','alice','late','fixture',1,'{}','NEVER_INCLUDE_PROVIDER','simulated','fixture',?)").bind(NOW),
  fx.db.prepare("INSERT INTO notifications(id,user_id,kind,target_type,target_id,title,created_at) VALUES('mention','alice','mention','record','late','NEVER_INCLUDE_OLD_COPY',?)").bind(NOW),
  fx.db.prepare("INSERT INTO automation_runs(id,automation_id,event_key,status,error,created_at) VALUES('failure','auto','fixture-failure','retryable_failure','NEVER_INCLUDE_PROVIDER',?)").bind(NOW-1000),
 ]);
 await proposePreview(fx.env,'alice','update_records',{fixture:true},[{id:'today',collection:'tasks',patch:{title:'Proposed title'}}]);
}
async function collect(user='alice',query:Parameters<typeof collectAttention>[2]={},env:Env=fx!.env){const scoped=withWorkspaceContext(withD1Budget(env)),start=d1BudgetRemaining(scoped.DB);const result=await collectAttention(scoped,user,query,NOW);expect(start-d1BudgetRemaining(scoped.DB)).toBeLessThanOrEqual(12);return result;}
describe.each([false,true])('attention actual D1 permissions=%s',enabled=>{
 it('collects all sources with current titles, admin triage, ranking and bounded calls',async()=>{
  await seed(enabled);const result=await collect();expect(result.partial).toBe(false);expect(result.today).toBe('2026-10-27');expect(new Set(result.items.slice(0,2).map(i=>i.kind))).toEqual(new Set(['approval_pending','ai_preview_pending']));
  expect(new Set(result.items.map(i=>i.kind))).toEqual(new Set(['approval_pending','ai_preview_pending','suggestion_pending','record_overdue','record_due_today','record_due_soon','record_unassigned','mention_unread','automation_failed']));
  expect(result.items.filter(i=>i.kind.startsWith('record_due')||i.kind==='record_overdue').map(i=>i.targetId).sort()).toEqual(['late','soon','today']);
  expect(result.items.find(i=>i.kind==='record_unassigned')).toMatchObject({targetId:'unassigned',personKey:'assigneeId',actions:['open','assign_me']});expect(JSON.stringify(result)).not.toMatch(/NEVER_INCLUDE/);
  const bob=await collect('bob');expect(bob.items.map(i=>i.targetId)).toEqual(['bob-task']);expect(bob.items.some(i=>['approval_pending','ai_preview_pending','suggestion_pending','mention_unread','record_unassigned','automation_failed'].includes(i.kind))).toBe(false);
 });
 it('pages tied ranks without omissions and binds cursors to user, filter and workspace day',async()=>{
  await seed(enabled);const all=await collect(),keys:string[]=[],seen=new Set<string>();let cursor:undefined|string;
  do{const page=await collect('alice',{limit:2,cursor});for(const i of page.items){expect(seen.has(i.key)).toBe(false);seen.add(i.key);keys.push(i.key);}cursor=page.nextCursor??undefined;}while(cursor);
  expect(keys).toEqual(all.items.map(i=>i.key));const first=await collect('alice',{limit:1});await expect(collect('bob',{cursor:first.nextCursor!})).rejects.toThrow('invalid_cursor');await expect(collect('alice',{cursor:first.nextCursor!,kinds:['record_overdue']})).rejects.toThrow('invalid_cursor');
  await expect(collectAttention(fx!.env,'alice',{cursor:first.nextCursor!},NOW+86400000)).rejects.toThrow('invalid_cursor');
 });
 it('clears from source state and preserves quiet-digest preference',async()=>{
  await seed(enabled);await applyChanges(fx!.env,'alice',[{id:'late',collection:'tasks',ts:NOW,patch:{status:'done'}},{id:'today',collection:'tasks',ts:NOW,patch:{assigneeId:'bob'}},{id:'soon',collection:'tasks',ts:NOW,patch:{archived:true}},{id:'unassigned',collection:'tasks',ts:NOW,patch:{assigneeId:'alice'}}]);
  await fx!.db.batch([fx!.db.prepare("UPDATE approvals SET status='approved'"),fx!.db.prepare("UPDATE ai_previews SET status='cancelled'"),fx!.db.prepare("UPDATE ai_suggestions SET status='rejected'"),fx!.db.prepare('UPDATE notifications SET read_at=?').bind(NOW),fx!.db.prepare("INSERT INTO automation_runs(id,automation_id,event_key,status,created_at) VALUES('success','auto','fixture-success','completed',?)").bind(NOW),fx!.db.prepare("UPDATE users SET prefs='{\"quietDigest\":true}' WHERE id='alice'")]);
  const result=await collect();expect(result.items).toEqual([]);expect(result.quietDigest).toBe(true);
 });
 it('authenticates the route and rejects invalid queries before returning records',async()=>{
  await seed(enabled);expect((await attentionApi.request('/',{},fx!.env,ctx)).status).toBe(401);for(const q of ['limit=51','limit=-1','limit=bad','cursor=bad','kinds=unknown'])expect((await attentionApi.request('/?'+q,{headers:fx!.auth('alice')},fx!.env,ctx)).status).toBe(400);
  expect((await attentionApi.request('/',{headers:fx!.auth('alice')},withWorkspaceContext(withD1Budget(fx!.env)),ctx)).status).toBe(200);
 });
 it('reports source caps and low-budget partiality, never a false complete count',async()=>{
  await seed(enabled);const inserts=Array.from({length:52},(_,n)=>fx!.db.prepare("INSERT INTO notifications(id,user_id,kind,target_id,title,created_at) VALUES(?,'alice','mention','late','NEVER_INCLUDE_OLD_COPY',?)").bind('many-'+n,NOW+n));await fx!.db.batch(inserts);expect(await collect()).toMatchObject({partial:true,partialSources:['mention_unread']});
  const partial=await collectAttention(withD1Budget(fx!.env,8),'alice',{},NOW);expect(partial).toMatchObject({items:[],partial:true,partialSources:['processing_budget'],urgentCount:0});
 });
});

it('ENABLED: isolates private sources, redacts owned copies and respects read-only guests',async()=>{
 await seed(true);await fx!.db.prepare("INSERT INTO spaces(id,name,default_access,created_at) VALUES('vault','Vault','private',1),('guest-room','Guest room','private',1)").run();await fx!.db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('vault','alice','admin'),('guest-room','carol','viewer')").run();
 await fx!.db.prepare("UPDATE users SET workspace_role='guest' WHERE id='carol'").run();
 await applyChanges(fx!.env,'alice',[
  {id:'vault-board',collection:'boards',ts:1,patch:{name:'SECRET Board',spaceId:'vault',columns:[{id:'open'},{id:'done'}],attention:{enabled:true,personKey:'assigneeId',dateKey:'dueDate',triage:true,triagers:['bob']}}},
  {id:'vault-late',collection:'tasks',ts:1,patch:{title:'SECRET Task',boardId:'vault-board',assigneeId:'bob',status:'open',createdBy:'alice',dueDate:'2026-10-26'}},
  {id:'vault-triage',collection:'tasks',ts:1,patch:{title:'SECRET Triage',boardId:'vault-board',status:'open',createdBy:'alice'}},
 ]);
 await fx!.db.batch([fx!.db.prepare("INSERT INTO date_index VALUES('vault-late','dueDate','2026-10-26')"),fx!.db.prepare("INSERT INTO approvals(id,target_type,target_id,requested_by,approver_id,status,created_at) VALUES('secret-approval','record','vault-late','alice','bob','pending',?)").bind(NOW),fx!.db.prepare("INSERT INTO notifications(id,user_id,kind,target_id,title,created_at) VALUES('secret-mention','bob','mention','vault-late','SECRET COPY',?)").bind(NOW)]);
 const bob=await collect('bob');expect(JSON.stringify(bob)).not.toMatch(/SECRET|vault/);expect(bob.items.filter(i=>i.restricted)).toHaveLength(2);expect(bob.items.filter(i=>i.restricted).every(i=>i.title===''&&i.url===null)).toBe(true);expect((await collect('carol')).items).toEqual([]);
});

it('ENABLED: supports configured person/date fields and explicit non-admin triagers',async()=>{
 await seed(true);await applyChanges(fx!.env,'alice',[
  {id:'custom',collection:'boards',ts:1,patch:{kind:'records',name:'Custom',columns:[{id:'open'},{id:'done'}],fields:[{id:'owner',name:'Owner',type:'person'},{id:'deadline',name:'Deadline',type:'date'}],attention:{enabled:true,personKey:'p_owner',dateKey:'p_deadline',soonDays:2,triage:true,triagers:['bob']}}},
  {id:'custom-mine',collection:'tasks',ts:1,patch:{boardId:'custom',title:'Custom work',status:'open',createdBy:'alice',p_owner:'bob',p_deadline:'2026-10-29'}},
  {id:'custom-triage',collection:'tasks',ts:1,patch:{boardId:'custom',title:'Unassigned custom work',status:'open',createdBy:'alice'}},
 ]);await fx!.db.prepare("INSERT INTO date_index VALUES('custom-mine','p_deadline','2026-10-29')").run();
 const bob=await collect('bob');expect(bob.items.find(i=>i.targetId==='custom-mine')).toMatchObject({kind:'record_due_soon',personKey:'p_owner',ownerId:'bob'});expect(bob.items.find(i=>i.targetId==='custom-triage')).toMatchObject({kind:'record_unassigned',personKey:'p_owner'});expect((await collect()).items.some(i=>i.targetId==='custom-triage')).toBe(false);
});

describe.each([false,true])('attention concurrent authority permissions=%s',enabled=>{
 function afterContent(change:()=>Promise<unknown>):Env {
  let batches=0;const raw=fx!.db;
  const DB=new Proxy(raw,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{const result=await target.batch(statements);if(++batches===2)await change();return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  return {...fx!.env,DB};
 }
 it('withholds content if the principal is disabled after the source read',async()=>{
  await seed(enabled);const env=afterContent(()=>fx!.db.prepare("UPDATE users SET disabled_at=? WHERE id='alice'").bind(NOW).run());await expect(collect('alice',{},env)).rejects.toThrow('unauthenticated');
 });
 it('removes admin-only failure and default triage rows after canonical demotion',async()=>{
  await seed(enabled);const env=afterContent(()=>fx!.db.prepare("UPDATE users SET workspace_role='member',role='member' WHERE id='alice'").run());const result=await collect('alice',{},env);expect(result.items.some(i=>['record_unassigned','automation_failed'].includes(i.kind))).toBe(false);
 });
 it('reflects changed record data or withholds it instead of publishing an authorized stale title',async()=>{
  await seed(enabled);const env=afterContent(()=>applyChanges(fx!.env,'alice',[{id:'late',collection:'tasks',ts:NOW,patch:{title:'Replacement title',status:'done'}}]));const result=await collect('alice',{},env);
  if(enabled)expect(result.items.some(i=>i.kind==='record_overdue'&&i.targetId==='late')).toBe(false);
  // Disabled mode preserves its existing point-in-time read contract. Enabled
  // mode additionally fences the captured revision through the canonical gate.
  expect(JSON.stringify(result)).not.toContain('NEVER_INCLUDE');
 });
});

it('ENABLED: measures a capped 550-record queue without per-record D1 calls',async()=>{
 await seed(true);const rows=Array.from({length:550},(_,n)=>({id:'bulk-'+String(n).padStart(4,'0'),collection:'tasks',ts:1,patch:{boardId:'work',title:'Bulk '+n,status:'open',assigneeId:'alice',createdBy:'alice',dueDate:'2026-10-26'}}));
 for(let i=0;i<rows.length;i+=100)await applyChanges(fx!.env,'alice',rows.slice(i,i+100));
 await fx!.db.batch(rows.map(r=>fx!.db.prepare('INSERT INTO date_index(record_id,field_key,date) VALUES(?,?,?)').bind(r.id,'dueDate','2026-10-26')));
 const result=await collect();expect(result.items).toHaveLength(50);expect(result.nextCursor).toBeTruthy();expect(result.partialSources).toContain('dated');expect(result.partial).toBe(true);
});

it('ENABLED: completed prefixes cannot starve dated or unassigned open work',async()=>{
 await seed(true);const rows=Array.from({length:520},(_,n)=>({id:'a-done-'+String(n).padStart(4,'0'),collection:'tasks',ts:1,patch:{boardId:'work',title:'Completed '+n,status:'done',assigneeId:n%2?'alice':null,createdBy:'alice',dueDate:'2026-10-01'}}));
 for(let i=0;i<rows.length;i+=100)await applyChanges(fx!.env,'alice',rows.slice(i,i+100));
 await fx!.db.batch(rows.map(r=>fx!.db.prepare('INSERT INTO date_index(record_id,field_key,date) VALUES(?,?,?)').bind(r.id,'dueDate','2026-10-01')));
 const result=await collect();expect(result.items.some(i=>i.targetId==='late'&&i.kind==='record_overdue')).toBe(true);expect(result.items.some(i=>i.targetId==='unassigned')).toBe(true);expect(result.items.some(i=>i.targetId.startsWith('a-done-'))).toBe(false);expect(result.partial).toBe(false);
});

it('DISABLED: explicitly omitting a date field enables triage without accidental due-date work',async()=>{
 await seed(false);await applyChanges(fx!.env,'alice',[{id:'work',collection:'boards',ts:NOW,patch:{attention:{enabled:true,personKey:'assigneeId',triage:true}}}]);
 const result=await collect();expect(result.items.some(i=>i.kind.startsWith('record_due')||i.kind==='record_overdue')).toBe(false);expect(result.items.some(i=>i.kind==='record_unassigned')).toBe(true);
});
