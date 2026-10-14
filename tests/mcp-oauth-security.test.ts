import {afterEach,it,expect,vi} from 'vitest';
import {auth as legacyAuth, type OAuthClientProvider} from '@modelcontextprotocol/sdk/client/auth.js';
import {auth as modernAuth} from '@modelcontextprotocol/client';
import type {OAuthProvider as ProviderClass,OAuthHelpers} from '@cloudflare/workers-oauth-provider';
import {build} from 'esbuild';

afterEach(()=>vi.useRealTimers());
for(const [name,auth] of [['SDK 1.x',legacyAuth],['client 2.x',modernAuth]] as const) {
 it(`${name} refuses issuer-bound credentials before contacting a substituted authorization server`,async()=>{
  const fetchFn=vi.fn(async()=>{throw new Error('Credential forwarding must not occur');});
  const provider={
   redirectUrl:'https://client.example.invalid/cb',
   clientMetadata:{redirect_uris:[]},
   clientInformation:()=>({client_id:'fixture-client',client_secret:'non-secret-fixture',issuer:'https://legitimate.example.invalid/'}),
   tokens:()=>({access_token:'fixture',token_type:'Bearer',refresh_token:'non-secret-refresh',issuer:'https://legitimate.example.invalid/'}),
   discoveryState:()=>({authorizationServerUrl:'https://substituted.example.invalid/',authorizationServerMetadata:{issuer:'https://substituted.example.invalid/',authorization_endpoint:'https://substituted.example.invalid/authorize',token_endpoint:'https://substituted.example.invalid/token',response_types_supported:['code']},resourceMetadata:{resource:'https://mcp.example.invalid/mcp',authorization_servers:['https://substituted.example.invalid/']}}),
   saveTokens:async()=>{},redirectToAuthorization:async()=>{},saveCodeVerifier:async()=>{},codeVerifier:async()=>'',
  } satisfies OAuthClientProvider;
  await expect(auth(provider,{serverUrl:'https://mcp.example.invalid/mcp',fetchFn})).rejects.toThrow(/issuer|bound|authorization server/i);
  expect(fetchFn).not.toHaveBeenCalled();
 });
}

it('provider expires access tokens, validates audience, and recovers by refresh without wall-clock waiting',async()=>{
 // Bundle the real provider for Node; only its unused WorkerEntrypoint base is a platform stub.
 const bundled=await build({entryPoints:['node_modules/@cloudflare/workers-oauth-provider/dist/oauth-provider.js'],bundle:true,write:false,format:'esm',platform:'browser',plugins:[{name:'test-entrypoint',setup(b){b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'workers',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export class WorkerEntrypoint {}'}));}}]});
 const moduleUrl='data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].contents).toString('base64');
 const {OAuthProvider}=await import(/* @vite-ignore */ moduleUrl) as {OAuthProvider:typeof ProviderClass};
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-15T00:00:00Z'));
 // Ephemeral KV contract fixture, never production or persisted credentials.
 const values=new Map<string,string>();
 const kv={get:async(key:string,options?:{type?:string}|string)=>{const s=values.get(key);return s===undefined?null:(options==='json'||typeof options==='object'&&options?.type==='json')?JSON.parse(s):s;},put:async(key:string,value:string)=>{values.set(key,value);},delete:async(key:string)=>{values.delete(key);},list:async()=>({keys:[],list_complete:true})};
 const env={OAUTH_KV:kv} as unknown as {OAUTH_KV:KVNamespace;OAUTH_PROVIDER:OAuthHelpers};
 const pending:Promise<unknown>[]=[];const ctx={waitUntil:(p:Promise<unknown>)=>pending.push(p)} as unknown as ExecutionContext;
 const origin='https://workspace.example.invalid',resource=origin+'/mcp',redirect='https://client.example.invalid/cb';
 const provider=new OAuthProvider<typeof env>({apiRoute:'/mcp',apiHandler:{fetch:async()=>Response.json({ok:true})},defaultHandler:{fetch:async(request,bindings)=>{
  const helpers=bindings.OAUTH_PROVIDER;
  const authRequest=await helpers.parseAuthRequest(request);
  const completed=await helpers.completeAuthorization({request:authRequest,userId:'fixture-user',scope:['mcp'],metadata:{},props:{userId:'fixture-user'}});
  return Response.redirect(completed.redirectTo);
 }},authorizeEndpoint:'/authorize',tokenEndpoint:'/token',clientRegistrationEndpoint:'/register',scopesSupported:['mcp'],accessTokenTTL:60,resourceMetadata:{resource}});
 const request=(path:string,init?:RequestInit)=>provider.fetch(new Request(origin+path,init),env,ctx);
 const form=(data:Record<string,string>)=>({method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(data)});
 const registration=await request('/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Expiry fixture',redirect_uris:[redirect],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});
 const client=(await registration.json()) as {client_id:string};expect(client.client_id).toBeTruthy();
 const verifier='a'.repeat(43);const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier));const challenge=Buffer.from(digest).toString('base64url');
 const approved=await request('/authorize?'+new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',code_challenge:challenge,code_challenge_method:'S256',scope:'mcp',resource,state:'fixture-state'}));
 const code=new URL(approved.headers.get('location')!).searchParams.get('code')!;
 const issued=await request('/token',form({grant_type:'authorization_code',client_id:client.client_id,redirect_uri:redirect,code,code_verifier:verifier,resource}));
 const tokens=await issued.json() as {access_token:string;refresh_token:string};expect(tokens.access_token).toBeTruthy();
 const call=(token:string,path='/mcp')=>request(path,{method:'POST',headers:{Authorization:'Bearer '+token},body:'{}'});
 expect((await call(tokens.access_token)).status).toBe(200);
 vi.setSystemTime(new Date('2026-10-15T00:01:01Z'));
 expect((await call(tokens.access_token)).status).toBe(401);
 const wrong=await request('/token',form({grant_type:'refresh_token',client_id:client.client_id,refresh_token:tokens.refresh_token,resource:'https://other.example.invalid/mcp'}));expect(wrong.status).toBe(400);
 const refreshed=await request('/token',form({grant_type:'refresh_token',client_id:client.client_id,refresh_token:tokens.refresh_token,resource}));
 const renewed=await refreshed.json() as {access_token:string};expect(refreshed.status).toBe(200);expect((await call(renewed.access_token)).status).toBe(200);
 await Promise.all(pending);
});
