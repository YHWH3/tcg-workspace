import {makeGuestInvite} from '../worker/guestInvites';
import {userByToken as loadUser} from '../worker/auth';
import {sync} from '../worker/sync';
import {mcpApiHandler} from '../worker/mcp';
import {levelSql} from '../worker/capability';
import {revokeAllGrants} from '../worker/ratelimit';
import {interceptD1Batches} from './d1WriteBoundary';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {openAuditFixture,ctx,type AuditFixture} from './audit-fixture';
import {admin} from '../worker/admin';
import {auth,userByToken} from '../worker/auth';
import {withD1Budget,d1BudgetRemaining} from '../worker/d1budget';
import {hashPassword,newSalt} from '../worker/password';
let fx:AuditFixture|undefined;
let grants:Map<string,{id:string}[]>;
let provider:{listUserGrants:ReturnType<typeof vi.fn>;revokeGrant:ReturnType<typeof vi.fn>};
afterEach(async()=>{vi.restoreAllMocks();await fx?.dispose();fx=undefined;});
async function setup(enabled:boolean){
 grants=new Map([['bob',[{id:'legacy-bob'}]]]);
 provider={listUserGrants:vi.fn(async(id:string)=>({items:grants.get(id)??[]})),revokeGrant:vi.fn(async(id:string,uid:string)=>{grants.set(uid,(grants.get(uid)??[]).filter(g=>g.id!==id));})};
 fx=await openAuditFixture([{id:'alice',role:'admin'},{id:'bob'},{id:'carol',role:'admin'}],{OAUTH_PROVIDER:provider as never});
 await fx.db.batch([fx.db.prepare('UPDATE access_state SET enabled=? WHERE id=1').bind(enabled?1:0),fx.db.prepare("UPDATE users SET workspace_role=CASE id WHEN 'alice' THEN 'owner' WHEN 'carol' THEN 'admin' ELSE 'member' END"),fx.db.prepare("INSERT INTO ai_connections(id,user_id,client_id,spaces_json,created_at,expires_at) VALUES('modern-bob','bob','test-client','[\"space-core\"]',?,?)").bind(Date.now(),Date.now()+86400000)]);
}
async function request(path:string,method='POST',data:unknown=undefined,actor='alice',env=fx!.env){const scoped=withD1Budget(env);const response=await admin.request(path,{method,headers:actor?fx!.auth(actor):{},...(data===undefined?{}:{body:JSON.stringify(data)})},scoped,ctx);expect(45-d1BudgetRemaining(scoped.DB)).toBeLessThanOrEqual(45);return response;}
async function countActive(){return fx!.db.prepare('SELECT COUNT(*) n FROM users WHERE disabled_at IS NULL').first<number>('n');}
describe.each([false,true])('account disable permissions=%s',enabled=>{
 it('cuts off sessions, revokes modern and legacy grants, retains history, and restores with a fresh login',async()=>{
  await setup(enabled);const secret=crypto.randomUUID(),salt=newSalt();await fx!.db.prepare("UPDATE users SET salt=?,password_hash=? WHERE id='bob'").bind(salt,await hashPassword(secret,Uint8Array.from(atob(salt),c=>c.charCodeAt(0)))).run();
  expect((await auth.request('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'bob',password:secret})},fx!.env,ctx)).status).toBe(200);
  await fx!.db.prepare("INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES('history','tasks','{\"title\":\"Retained work\",\"createdBy\":\"bob\"}','{}',1,'space-core')").run();
  const disabled=await request('/users/bob/disable');expect(disabled.status).toBe(200);expect(await disabled.json()).toMatchObject({ok:true,disabled:true,grantsRevoked:true});
  expect((await sync.request('/pull',{headers:fx!.auth('bob')},fx!.env,ctx)).status).toBe(401);
  expect((await mcpApiHandler.fetch(new Request('http://localhost/mcp'),fx!.env,{...ctx,props:{userId:'bob'}} as ExecutionContext)).status).toBe(401);
  expect(await fx!.db.prepare(`SELECT ${levelSql("'bob'","'space-core'")} n`).first('n')).toBe(0);
  expect(await userByToken(fx!.db,fx!.token('bob'))).toBeNull();expect(await fx!.db.prepare("SELECT COUNT(*) n FROM sessions WHERE user_id='bob'").first('n')).toBe(0);
  expect(await fx!.db.prepare("SELECT revoked_at FROM ai_connections WHERE id='modern-bob'").first('revoked_at')).not.toBeNull();expect(grants.get('bob')).toEqual([]);
  expect(await fx!.db.prepare("SELECT data FROM records WHERE id='history'").first('data')).toContain('Retained work');
  const users=await (await request('/users','GET')).json() as any;expect(users.users.find((u:any)=>u.id==='bob').disabled).toBe(true);
  expect((await auth.request('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'bob',password:secret})},fx!.env,ctx)).status).toBe(401);
  const replay=await request('/users/bob/disable');expect(await replay.json()).toMatchObject({already:true});
  expect(await fx!.db.prepare("SELECT COUNT(*) n FROM access_audit WHERE action='user.disable'").first('n')).toBe(1);
  expect((await request('/users/bob/enable')).status).toBe(200);expect(await userByToken(fx!.db,fx!.token('bob'))).toBeNull();
  expect(await fx!.db.prepare("SELECT revoked_at FROM ai_connections WHERE id='modern-bob'").first('revoked_at')).not.toBeNull();
  expect((await auth.request('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'bob',password:secret})},fx!.env,ctx)).status).toBe(200);
 });
 it('frees the disabled place and refuses restoration at seven active accounts',async()=>{
  await setup(enabled);expect((await request('/users/bob/disable')).status).toBe(200);expect(await countActive()).toBe(2);
  await fx!.db.batch(Array.from({length:5},(_,i)=>fx!.db.prepare('INSERT INTO users(id,username,name,role,workspace_role) VALUES(?,?,?,\'member\',\'member\')').bind('extra'+i,'extra'+i,'Extra '+i)));
  const status=await (await auth.request('/status',{},fx!.env,ctx)).json() as any;expect(status).toMatchObject({needsBootstrap:false,seatsUsed:7});
  expect((await request('/users/bob/enable')).status).toBe(409);expect(await countActive()).toBe(7);
  expect((await request('/users/extra0','DELETE')).status).toBe(200);expect((await request('/users/bob/enable')).status).toBe(200);expect(await countActive()).toBe(7);
 });
 it('keeps restoration closed when provider cleanup fails, then recovers explicitly',async()=>{
  await setup(enabled);provider.listUserGrants.mockRejectedValue(new Error('simulated provider failure'));
  const disabled=await request('/users/bob/disable');expect(disabled.status).toBe(200);expect(await disabled.json()).toMatchObject({disabled:true,grantsRevoked:false});
  expect((await request('/users/bob/enable')).status).toBe(503);expect(await fx!.db.prepare("SELECT disabled_at FROM users WHERE id='bob'").first('disabled_at')).not.toBeNull();
  provider.listUserGrants.mockResolvedValue({items:[]});expect((await request('/users/bob/enable')).status).toBe(200);
 });
 it('uses canonical authority and refuses self disable plus a raced actor demotion',async()=>{
  await setup(enabled);expect((await request('/users/alice/disable')).status).toBe(400);expect((await request('/users/bob/disable','POST',undefined,'bob')).status).toBe(403);
  await fx!.db.prepare("UPDATE users SET workspace_role='member' WHERE id='alice'").run();expect((await request('/users/bob/disable')).status).toBe(403);
  await fx!.db.prepare("UPDATE users SET workspace_role='owner' WHERE id='alice'").run();const raw=fx!.db;let raced=false;
  const db=new Proxy(raw,{get(t,k){if(k==='batch')return async(stmts:D1PreparedStatement[])=>{if(!raced){raced=true;await raw.prepare("UPDATE users SET workspace_role='member' WHERE id='alice'").run();}return t.batch(stmts);};const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;}});
  expect((await request('/users/bob/disable','POST',undefined,'alice',{...fx!.env,DB:db})).status).toBe(409);expect(await fx!.db.prepare("SELECT disabled_at FROM users WHERE id='bob'").first('disabled_at')).toBeNull();
 });
 it('fences last enabled canonical administrator against concurrent disable, demotion and removal',async()=>{
  for(const [method,suffix,data] of [['POST','/disable',undefined],['PATCH','',{role:'member'}],['DELETE','',undefined]] as const){
   if(fx){await fx.dispose();fx=undefined;}await setup(enabled);
   let injected=false;const raw=fx!.db;
   const db=interceptD1Batches(raw,async(t,stmts,sql)=>{
    if(!injected&&sql.some(s=>/UPDATE users|DELETE FROM users/.test(s))){injected=true;await raw.prepare("UPDATE users SET disabled_at=1 WHERE id='alice'").run();}
    return t.batch(stmts);
   });
   expect((await request('/users/carol'+suffix,method,data,'alice',{...fx!.env,DB:db})).status).toBe(409);
   expect(await raw.prepare("SELECT disabled_at FROM users WHERE id='carol'").first('disabled_at')).toBeNull();
   expect(await raw.prepare("SELECT workspace_role FROM users WHERE id='carol'").first('workspace_role')).toBe('admin');
  }
 });
 it('updates canonical role, protects guest identity, and ignores disabled backup admins',async()=>{
  await setup(enabled);expect((await request('/users/carol','PATCH',{role:'member'})).status).toBe(200);
  expect(await fx!.db.prepare("SELECT workspace_role FROM users WHERE id='carol'").first('workspace_role')).toBe('member');
  expect((await request('/users/bob','PATCH',{role:'admin'})).status).toBe(200);
  expect(await fx!.db.prepare("SELECT workspace_role FROM users WHERE id='bob'").first('workspace_role')).toBe('admin');
  await fx!.db.prepare("UPDATE users SET workspace_role='guest' WHERE id='bob'").run();expect((await request('/users/bob','PATCH',{role:'admin'})).status).toBe(400);
  await fx!.db.prepare("UPDATE users SET disabled_at=1 WHERE id='alice'").run();
  // A disabled legacy admin never authorizes even though users.role still says admin.
  expect((await request('/users/carol/disable')).status).toBe(401);
 });
 it('counts disabled accounts separately from bootstrap and atomically races signup with restoration',async()=>{
  await setup(enabled);await request('/users/bob/disable');
  await fx!.db.batch(Array.from({length:4},(_,i)=>fx!.db.prepare("INSERT INTO users(id,username,name,role,workspace_role) VALUES(?,?,?,'member','member')").bind('seat'+i,'seat'+i,'Seat '+i)));
  await fx!.db.prepare("INSERT INTO invites(code,created_by,created_at) VALUES('RACE','alice',1)").run();
  const replies=await Promise.all([request('/users/bob/enable'),auth.request('/signup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'newperson',name:'New person',password:crypto.randomUUID(),inviteCode:'RACE'})},fx!.env,ctx)]);
  expect(replies.filter(r=>r.status===200)).toHaveLength(1);expect(await countActive()).toBe(7);
  await fx!.db.prepare('UPDATE users SET disabled_at=1').run();
  expect(await (await auth.request('/status',{},fx!.env,ctx)).json()).toMatchObject({needsBootstrap:false,seatsUsed:0});
  expect((await auth.request('/signup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'notfounder',name:'No',password:crypto.randomUUID()})},fx!.env,ctx)).status).toBe(403);
 });
 it('revokes pending OAuth consent and sponsored ingest authority without restoring either',async()=>{
  await setup(enabled);
  await fx!.db.batch([
    fx!.db.prepare("INSERT INTO ai_scope_consents(token_hash,user_id,handle,client_id,request_json,cookie_hash,expires_at) VALUES('pending','bob','handle','client','{}','cookie',?)").bind(Date.now()+60000),
    fx!.db.prepare("INSERT INTO website_ingest_grant(id,sponsor_id,space_id,inbox_id,people_id,updated_at) VALUES(1,'bob','space-core','inbox','people',1)"),
  ]);
  expect((await request('/users/bob/disable')).status).toBe(200);
  expect(await fx!.db.prepare("SELECT consumed_at FROM ai_scope_consents WHERE token_hash='pending'").first('consumed_at')).not.toBeNull();
  expect(await fx!.db.prepare('SELECT revoked_at FROM website_ingest_grant WHERE id=1').first('revoked_at')).not.toBeNull();
  expect((await request('/users/bob/enable')).status).toBe(200);
  expect(await fx!.db.prepare('SELECT revoked_at FROM website_ingest_grant WHERE id=1').first('revoked_at')).not.toBeNull();
 });
 it('keeps restore closed on missing provider and unfinished bounded pagination',async()=>{
  await setup(enabled);await request('/users/bob/disable');
  expect((await request('/users/bob/enable','POST',undefined,'alice',{...fx!.env,OAUTH_PROVIDER:undefined as never})).status).toBe(503);
  provider.listUserGrants.mockResolvedValue({items:[],cursor:'more'});
  const before=provider.listUserGrants.mock.calls.length;
  expect((await request('/users/bob/enable')).status).toBe(503);expect(provider.listUserGrants.mock.calls.length-before).toBe(20);
  await expect(revokeAllGrants({...fx!.env,OAUTH_PROVIDER:undefined as never},'bob',true)).rejects.toThrow('connector_revocation_unavailable');
 });

 if(enabled)it('blocks a disabled guest-invite issuer and atomically races guest signup against restore',async()=>{
  await setup(enabled);await fx!.db.batch([
   fx!.db.prepare("INSERT INTO spaces(id,name,default_access,created_at) VALUES('guest-room','Guest room','private',1)"),
   fx!.db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('guest-room','carol','admin')"),
  ]);
  const issuer=(await loadUser(fx!.db,fx!.token('carol')))!;
  const invite=(await makeGuestInvite(fx!.env,issuer,'guest-room','viewer'))!;expect(invite).toBeTruthy();
  await request('/users/carol/disable');
  const signup=(name:string)=>auth.request('/signup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:name,name,password:crypto.randomUUID(),guestInvite:invite.token})},fx!.env,ctx);
  expect((await signup('blockedguest')).status).toBe(403);
  await request('/users/carol/enable');await request('/users/bob/disable');
  await fx!.db.batch(Array.from({length:4},(_,i)=>fx!.db.prepare("INSERT INTO users(id,username,name,role,workspace_role) VALUES(?,?,?,'member','member')").bind('guestseat'+i,'guestseat'+i,'Seat '+i)));
  const responses=await Promise.all([request('/users/bob/enable'),signup('racingguest')]);
  expect(responses.filter(r=>r.status===200)).toHaveLength(1);expect(await countActive()).toBe(7);
 });

});
