// Actual disposable D1; permission mode is explicitly enabled unless a test says otherwise.
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {openAuditFixture,type AuditFixture} from './audit-fixture';
import {createReadGate,withReadGate} from '../worker/readAccess';
import {applyChanges} from '../worker/sync';
import {reduceConnection} from '../worker/connectorAccess';
import {loadAccessContext,readableSpaceIds} from '../worker/access';
import {capabilityFence} from '../worker/capability';
import {searchRecords,processSearchDirty} from '../worker/search';
let f:AuditFixture;
beforeEach(async()=>{
 f=await openAuditFixture();
 await f.db.batch([
  f.db.prepare('UPDATE access_state SET enabled=1'),
  f.db.prepare("INSERT INTO spaces(id,name,default_access,created_at) VALUES('lab','Common Lab','private',1),('private','Private','private',1)"),
  f.db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('lab','alice','admin'),('private','alice','admin')"),
  f.db.prepare(`INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES('a','pages','{"title":"Lab needle"}','{}',1,'lab'),('b','pages','{"title":"Secret needle"}','{}',2,'private'),('ab','links','{"kind":"related","fromType":"page","fromId":"a","toType":"page","toId":"b"}','{}',3,'lab')`),
  f.db.prepare("INSERT INTO ai_connections(id,user_id,client_id,spaces_json,created_at,expires_at) VALUES('c','alice','client','[\"lab\"]',1,?)").bind(Date.now()+1000000),
 ]);
});
afterEach(async()=>{await f.dispose();});
const connector={id:'c',version:1};
const env=()=>withReadGate({...f.env,CONNECTOR:connector},'alice');
describe('Phase 6 durable connector scopes — permissions ENABLED',()=>{
 it('intersects human rights and approved spaces including both relation audiences',async()=>{
  const gate=createReadGate(f.db,'alice',connector);
  expect([...((await gate.decide(['a','b','ab'])).readable)]).toEqual(['a']);
  expect(await createReadGate(f.db,'alice').canRead('b')).toBe(true);
 });
 it('does not let a connector write another human-readable space',async()=>{
  const r=await applyChanges(env(),'alice',[{id:'b',collection:'pages',patch:{title:'forged'},ts:0}],{serverTs:true});
  expect(r.changed).toBe(0);expect(r.rejected).toBe(1);
  expect((await f.db.prepare("SELECT json_extract(data,'$.title') title FROM records WHERE id='b'").first<{title:string}>())?.title).toBe('Secret needle');
  expect((await applyChanges(env(),'alice',[{id:'a',collection:'pages',patch:{title:'Allowed'},ts:0}],{serverTs:true})).changed).toBe(1);
 });
 it('rechecks reduction and revocation within the same read gate',async()=>{
  const gate=createReadGate(f.db,'alice',connector);expect(await gate.canRead('a')).toBe(true);
  expect(await reduceConnection(f.env,'alice','c',[],1)).toBe(true);
  expect(await gate.canRead('a')).toBe(false);expect(await gate.validateObserved()).toBe(false);
 });
 it('rejects scope increases, stale reductions, another user and duplicate concurrent reductions',async()=>{
  expect(await reduceConnection(f.env,'alice','c',['lab','private'],1)).toBe(false);
  expect(await reduceConnection(f.env,'bob','c',[],1)).toBe(false);
  const results=await Promise.all([reduceConnection(f.env,'alice','c',[],1),reduceConnection(f.env,'alice','c',[],1)]);
  expect(results.filter(Boolean)).toHaveLength(1);
 });
 it('fences a previously planned write when connection authority changes',async()=>{
  const context=await loadAccessContext(f.db,'alice',['lab'],undefined,connector);
  const fence=()=>capabilityFence(f.db,{userId:'alice',needs:new Map([['lab',3]]),workspaceRole:context.principal!.workspaceRole,enabled:true,connector:context.connector});
  await fence().first();await reduceConnection(f.env,'alice','c',[],1);
  await expect(fence().first()).rejects.toThrow();
 });
 it('never grants rights through membership regrant outside approved scope',async()=>{
  await f.db.prepare("DELETE FROM space_members WHERE user_id='alice' AND space_id='lab'").run();
  expect(await env().READ_GATE!.canRead('a')).toBe(false);
  await f.db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('lab','alice','viewer')").run();
  expect(await env().READ_GATE!.canRead('a')).toBe(true);
  expect((await applyChanges(env(),'alice',[{id:'a',collection:'pages',patch:{title:'bad'},ts:0}],{serverTs:true})).changed).toBe(0);
 });
 it.each(['revoked','expired','other-account'])('fails closed for %s connections',async state=>{
  if(state==='revoked')await f.db.prepare("UPDATE ai_connections SET revoked_at=1 WHERE id='c'").run();
  if(state==='expired')await f.db.prepare("UPDATE ai_connections SET expires_at=1 WHERE id='c'").run();
  if(state==='other-account')await f.db.prepare("UPDATE ai_connections SET user_id='bob' WHERE id='c'").run();
  expect(readableSpaceIds(await loadAccessContext(f.db,'alice',['lab','private'],undefined,connector))).toEqual([]);
  expect(await env().READ_GATE!.canRead('a')).toBe(false);
 });
 it('filters search before ranking/pagination and binds cursors to the connection',async()=>{
  for(let i=0;i<3;i++)await f.db.prepare('INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES(?,?,?,?,?,?)').bind('extra'+i,'pages',JSON.stringify({title:'Lab needle '+i}),'{}',10+i,'lab').run();
  await processSearchDirty(f.env);
  const r=await searchRecords(env(),'alice',{q:'needle',limit:1});
  expect(r.results).toHaveLength(1);expect(JSON.stringify(r)).not.toContain('Secret needle');expect(r.nextCursor).toBeTruthy();
  await expect(searchRecords(withReadGate(f.env,'alice'),'alice',{q:'needle',limit:1,cursor:r.nextCursor})).rejects.toThrow('invalid_cursor');
 });
 it('retains ordinary disabled-mode reads but enforces an explicitly scoped connector',async()=>{
  await f.db.prepare('UPDATE access_state SET enabled=0').run();
  expect(await createReadGate(f.db,'alice').canRead('b')).toBe(true);
  expect(await env().READ_GATE!.canRead('b')).toBe(false);
  expect((await applyChanges(env(),'alice',[{id:'b',collection:'pages',patch:{title:'bad'},ts:0}],{serverTs:true})).changed).toBe(0);
 });
});
