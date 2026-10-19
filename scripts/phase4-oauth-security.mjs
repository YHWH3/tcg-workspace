import {fixtureFetch} from './certification/oauth-consent.mjs';
import crypto from 'node:crypto';

// Runs inside the existing base-MCP gate, against its disposable Worker only.
// Never logs token bodies, codes, consent handles or fixture credentials.
export const oauthSecurityAssertions = [
 'security: unregistered redirect rejected locally',
 'security: active redirect scheme rejected at registration',
 'security: consent cannot cross browser cookies',
 'security: tampered query cannot change the consent-bound state',
 'security: OAuth state round-trips exactly',
 'security: consent handle is single use',
 'security: code cannot cross clients',
 'security: incorrect PKCE verifier rejected',
 'security: code cannot be replayed',
 'security: invalid bearer token rejected',
 'security: refresh cannot cross clients',
 'security: refresh rotates and authenticates',
 'security: another client cannot revoke a refresh grant',
 'security: access-token revocation is effective',
 'security: refresh recovers a revoked access token',
 'security: refresh-grant revocation rejects access',
 'security: refresh-grant revocation rejects refresh',
];
export async function verifyOAuthSecurity({api,check,BASE,USER,PASS}) {
 const resource=BASE+'/mcp',redirect='http://localhost:8123/security-cb';
 const register=async name=>(await api('/register',{method:'POST',body:{client_name:name,redirect_uris:[redirect],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'}})).data.client_id;
 const a=await register('Security A'),b=await register('Security B');
 if(!a||!b)throw new Error('Security fixture registration failed');
 const begin=async()=>{
  const verifier=crypto.randomBytes(32).toString('base64url'),state=crypto.randomBytes(16).toString('base64url');
  const query=new URLSearchParams({response_type:'code',client_id:a,redirect_uri:redirect,state,code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',scope:'mcp',resource});
  const path='/oauth/authorize?'+query,res=await api(path,{raw:true}),html=await res.text();
  const handle=html.match(/name="handle" value="([^"]+)"/)?.[1];
  const cookie=res.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  if(res.status!==200||!handle||!cookie)throw new Error('Security consent fixture failed');
  return {path,query,verifier,state,handle,cookie};
 };
 const approve=d=>api(d.path,{method:'POST',cookie:d.cookie,form:{handle:d.handle,username:USER,password:PASS,decision:'allow'}});
 const exchange=(d,code,client=a,verifier=d.verifier)=>api('/token',{method:'POST',form:{grant_type:'authorization_code',client_id:client,code,redirect_uri:redirect,code_verifier:verifier,resource}});
 const grant=async()=>{const d=await begin(),approved=await approve(d);const loc=new URL(approved.headers.get('location')??'',BASE);const code=loc.searchParams.get('code');if(!code)throw new Error('Security consent did not issue a code');return {d,code,loc};};
 const mint=async()=>{const g=await grant(),r=await exchange(g.d,g.code);if(!r.data.access_token||!r.data.refresh_token)throw new Error('Security token fixture failed');return r.data;};
 const call=token=>fetch(BASE+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
 const refresh=(token,client=a)=>api('/token',{method:'POST',form:{grant_type:'refresh_token',client_id:client,refresh_token:token,resource}});
 const revoke=(token,hint,client=a)=>api('/token',{method:'POST',form:{client_id:client,token,token_type_hint:hint}});
 let d=await begin();const q=new URLSearchParams(d.query);q.set('redirect_uri','https://unregistered.example.invalid/cb');
 let r=await api('/oauth/authorize?'+q);check(oauthSecurityAssertions[0],r.status===400&&!r.headers.get('location'));
 r=await api('/register',{method:'POST',body:{client_name:'Invalid redirect',redirect_uris:['javascript:alert(1)'],token_endpoint_auth_method:'none'}});check(oauthSecurityAssertions[1],r.status===400);
 const other=await begin();r=await api(d.path,{method:'POST',cookie:other.cookie,form:{handle:d.handle,username:USER,password:PASS,decision:'allow'}});check(oauthSecurityAssertions[2],r.status===400);
 d=await begin();const tampered=new URLSearchParams(d.query);tampered.set('state','changed');r=await api('/oauth/authorize?'+tampered,{method:'POST',cookie:d.cookie,form:{handle:d.handle,username:USER,password:PASS,decision:'allow'}});check(oauthSecurityAssertions[3],r.status===400||(r.status===302&&new URL(r.headers.get('location'),BASE).searchParams.get('state')===d.state));
 let g=await grant();check(oauthSecurityAssertions[4],g.loc.searchParams.get('state')===g.d.state);
 r=await approve(g.d);check(oauthSecurityAssertions[5],r.status===400);
 r=await exchange(g.d,g.code,b);check(oauthSecurityAssertions[6],r.status===400||r.status===401);
 g=await grant();r=await exchange(g.d,g.code,a,'incorrect-verifier'.repeat(4));check(oauthSecurityAssertions[7],r.status===400||r.status===401);
 g=await grant();await exchange(g.d,g.code);r=await exchange(g.d,g.code);check(oauthSecurityAssertions[8],r.status===400||r.status===401);
 r=await call('non-secret-invalid-token');check(oauthSecurityAssertions[9],r.status===401);
 let tokens=await mint();r=await refresh(tokens.refresh_token,b);check(oauthSecurityAssertions[10],r.status===400||r.status===401);
 r=await refresh(tokens.refresh_token);check(oauthSecurityAssertions[11],r.status===200&&!!r.data.access_token&&r.data.refresh_token!==tokens.refresh_token&&(await call(r.data.access_token)).status===200);tokens=r.data;
 await revoke(tokens.refresh_token,'refresh_token',b);check(oauthSecurityAssertions[12],(await call(tokens.access_token)).status===200);
 await revoke(tokens.access_token,'access_token');check(oauthSecurityAssertions[13],(await call(tokens.access_token)).status===401);
 r=await refresh(tokens.refresh_token);check(oauthSecurityAssertions[14],r.status===200&&!!r.data.access_token&&(await call(r.data.access_token)).status===200);tokens=r.data;
 await revoke(tokens.refresh_token,'refresh_token');check(oauthSecurityAssertions[15],(await call(tokens.access_token)).status===401);
 r=await refresh(tokens.refresh_token);check(oauthSecurityAssertions[16],r.status===400||r.status===401,`status=${r.status} ${String(r.text??'').slice(0,160)}`);
}
