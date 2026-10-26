import {Hono} from 'hono';
import {afterEach,expect,it,vi} from 'vitest';
import {openAuditFixture,ctx,type AuditFixture} from './audit-fixture';
import {registerAuthorize} from '../worker/oauth';
import {type AuthUser,type Env} from '../worker/auth';
import {newSalt,hashPassword,sha256Hex} from '../worker/password';
import {interceptD1Batches} from './d1WriteBoundary';
let f:AuditFixture;
afterEach(async()=>{vi.restoreAllMocks();await f?.dispose();});
async function fixture(){
 const provider={parseAuthRequest:vi.fn(async()=>({clientId:'client'})),describeConsent:vi.fn(async()=>({clientName:'Fixture connector',scopes:[]})),approveConsent:vi.fn(async()=>({request:{clientId:'client',redirectUri:'https://client.example.invalid/callback',scope:['mcp']}})),completeAuthorization:vi.fn(async()=>({redirectTo:'https://client.example.invalid/callback?code=fixture'}))};
 f=await openAuditFixture(undefined,{OAUTH_PROVIDER:provider as never});
 const app=new Hono<{Bindings:Env;Variables:{user:AuthUser}}>();registerAuthorize(app);return {app,provider};
}
const form=(data:Record<string,string>)=>({method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',Cookie:'fixture-cookie'},body:new URLSearchParams(data)});
it('does not persist an OAuth consent when disable wins during provider approval',async()=>{
 const {app,provider}=await fixture(),salt=newSalt(),password=crypto.randomUUID();
 await f.db.prepare("UPDATE users SET salt=?,password_hash=? WHERE id='bob'").bind(salt,await hashPassword(password,Uint8Array.from(atob(salt),c=>c.charCodeAt(0)))).run();
 provider.approveConsent.mockImplementation(async()=>{await f.db.prepare("UPDATE users SET disabled_at=1 WHERE id='bob'").run();return {request:{clientId:'client',redirectUri:'https://client.example.invalid/callback',scope:['mcp']}};});
 vi.spyOn(console,'error').mockImplementation(()=>{});
 expect((await app.request('/oauth/authorize',form({handle:'h',decision:'allow',username:'bob',password}),f.env,ctx)).status).toBe(400);
 expect(await f.db.prepare('SELECT COUNT(*) n FROM ai_scope_consents').first('n')).toBe(0);
 expect(provider.completeAuthorization).not.toHaveBeenCalled();
});
it.each([false,true])('fences the final consent transaction against a disable race, permissions=%s',async enabled=>{
 const {app,provider}=await fixture();await f.db.prepare('UPDATE access_state SET enabled=?').bind(enabled?1:0).run();
 const token='fixture-selection',hash=await sha256Hex(token);
 await f.db.prepare('INSERT INTO ai_scope_consents(token_hash,user_id,handle,client_id,request_json,cookie_hash,expires_at) VALUES(?,?,?,?,?,?,?)').bind(hash,'bob','h','client',JSON.stringify({redirectUri:'https://client.example.invalid/callback',scope:['mcp']}),await sha256Hex('fixture-cookie'),Date.now()+60000).run();
 let injected=false;const db=interceptD1Batches(f.db,async(t,statements,sql)=>{
  if(!injected&&sql.some(s=>s.includes('INSERT INTO ai_connections'))){injected=true;await t.prepare("UPDATE users SET disabled_at=1 WHERE id='bob'").run();}
  return t.batch(statements);
 });
 vi.spyOn(console,'error').mockImplementation(()=>{});
 expect((await app.request('/oauth/authorize',form({handle:'h',decision:'allow',selection:token}),{...f.env,DB:db},ctx)).status).toBe(400);
 expect(injected).toBe(true);expect(await f.db.prepare('SELECT COUNT(*) n FROM ai_connections').first('n')).toBe(0);
 expect(provider.completeAuthorization).not.toHaveBeenCalled();
});
