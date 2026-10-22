// Anonymous, short-lived test ingress. Never uses a Cloudflare account, named
// tunnel, production binding or personal browser. API access needs an unlogged
// random cookie, while only the installed build's static files are public.
import assert from 'node:assert/strict';
import https from 'node:https';
import {spawn,execFileSync} from 'node:child_process';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,appendFileSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {startFixture,eventually} from '../phase4-fixture.mjs';
import {freePort} from './core.mjs';

export function publicFixturePolicy(path,cookie,secret,entry) {
  if(path===entry)return 'entry';
  const supplied=String(cookie??'').split(';').map(v=>v.trim()).find(v=>v.startsWith('tcg_qa='))?.slice(7)??'';
  if(/^[a-f0-9]{64}$/.test(supplied)&&supplied.length===secret.length&&timingSafeEqual(Buffer.from(supplied),Buffer.from(secret)))return 'authenticated';
  if(path==='/manifest.webmanifest'||/^\/icons\/[a-zA-Z0-9_.-]+\.png$/.test(path)||/^\/assets\/[a-zA-Z0-9_.-]+$/.test(path))return 'static';
  return 'deny';
}

export async function startPublicFixture({output,tls}) {
  assert.ok(tls?.cert&&tls?.key,'Owned local TLS is required');
  output=resolve(output);mkdirSync(output,{recursive:true});
  const fixture=await startFixture({port:await freePort(),build:false,artifactDirectory:join(output,'fixture'),tls});
  const secret=randomBytes(32).toString('hex'),entry='/qa-entry-'+randomBytes(32).toString('hex');
  const sockets=new Set(),upstream=new URL(fixture.base);assert.equal(upstream.hostname,'127.0.0.1');
  const guard=https.createServer({key:readFileSync(tls.key),cert:readFileSync(tls.cert)},(req,res)=>{
    const path=new URL(req.url,'https://fixture.invalid').pathname;
    const policy=publicFixturePolicy(path,req.headers.cookie,secret,entry);
    if(policy==='entry'){res.writeHead(303,{'Set-Cookie':`tcg_qa=${secret}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`,'Location':'/pages/qa-page','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end();return;}
    if(policy==='deny'||policy==='static'&&req.method!=='GET'&&req.method!=='HEAD'){appendFileSync(join(output,'guard-denied.jsonl'),JSON.stringify({path,method:req.method})+'\n');res.writeHead(404,{'Cache-Control':'no-store'});res.end();return;}
    const request=https.request({hostname:upstream.hostname,servername:'localhost',port:upstream.port,path:req.url,method:req.method,headers:{...req.headers,'x-forwarded-proto':'https'}},response=>{res.writeHead(response.statusCode,{...response.headers,'referrer-policy':'no-referrer'});response.pipe(res);});
    request.on('error',error=>{writeFileSync(join(output,'origin-error.json'),JSON.stringify({code:error.code,message:error.message,path},null,2));res.destroy();});req.on('error',()=>request.destroy());res.on('close',()=>request.destroy());req.pipe(request);
  });
  guard.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  // The public test has no need for presence; reject rather than exposing an
  // unguarded upgrade path. Core local certification separately checks sockets.
  guard.on('upgrade',(_req,socket)=>socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'));
  await new Promise(resolve=>guard.listen(0,'127.0.0.1',resolve));
  const dir=mkdtempSync(join(tmpdir(),'tcg-anonymous-ingress-')),config=join(dir,'empty.yml');writeFileSync(config,'{}\n');
  let logs='',base,tunnelError;
  const tunnel=spawn('cloudflared',['tunnel','--config',config,'--no-autoupdate','--url',`https://127.0.0.1:${guard.address().port}`,'--origin-ca-pool',tls.cert,'--origin-server-name','localhost','--protocol','http2'],{stdio:['ignore','pipe','pipe'],env:{...process.env,TUNNEL_TOKEN:'',TUNNEL_ORIGIN_CERT:''}});
  tunnel.on('error',error=>{tunnelError=error;});
  for(const stream of [tunnel.stdout,tunnel.stderr])stream.on('data',data=>{logs=(logs+data).slice(-200000);writeFileSync(join(output,'tunnel.log'),logs);base??=logs.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0];});
  let stopPromise;
  const stop=()=>stopPromise??=(async()=>{clearTimeout(expiry);process.removeListener('exit',kill);tunnel.kill('SIGTERM');for(const socket of sockets)socket.destroy();await new Promise(resolve=>guard.close(resolve));await fixture.stop();writeFileSync(join(output,'tunnel.log'),logs);})();
  const kill=()=>tunnel.kill('SIGTERM');process.once('exit',kill);
  const expiry=setTimeout(()=>void stop(),60*60*1000);expiry.unref();
  try {
    assert.equal((await fetch(`https://127.0.0.1:${guard.address().port}/manifest.webmanifest`)).status,200,'Guard must reach the local built manifest before exposing ingress');
    await eventually(async()=>{if(tunnelError)throw tunnelError;if(tunnel.exitCode!==null)throw new Error('Anonymous test ingress exited');return base;},{timeout:45000});
    const readiness=[];
    try{await eventually(async()=>{try{const r=await fetch(base+'/manifest.webmanifest',{signal:AbortSignal.timeout(5000)});readiness.push({status:r.status});if(r.status!==200)await new Promise(resolve=>setTimeout(resolve,1000));return r.status===200;}catch(e){readiness.push({error:e.cause?.code??e.name});await new Promise(resolve=>setTimeout(resolve,1000));return false;}},{timeout:180000});}
    finally{writeFileSync(join(output,'public-readiness.json'),JSON.stringify({base,attempts:readiness},null,2));}
    assert.equal((await fetch(base+'/api/auth/status')).status,404,'Anonymous ingress must deny APIs');
    const auth={cookie:`tcg_qa=${secret}`};
    const username='qa'+randomBytes(6).toString('hex'),password=randomBytes(24).toString('base64url');
    const signup=await fetch(fixture.base+'/api/auth/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,name:'Disposable platform tester',password})});
    const admin=await signup.json();assert.ok(admin.token);
    const changes=[{id:'qa-page',collection:'pages',patch:{title:'Cross-platform QA',order:'a0'}},{id:'qa-block',collection:'blocks',patch:{pageId:'qa-page',type:'p',text:'Trusted origin fixture café',order:'a0'}}].map(c=>({...c,ts:Date.now()}));
    const pushed=await fetch(fixture.base+'/api/sync/push',{method:'POST',headers:{Authorization:`Bearer ${admin.token}`,'Content-Type':'application/json'},body:JSON.stringify({changes})});assert.equal(pushed.status,200);assert.equal((await pushed.json()).rejected,0);
    writeFileSync(join(output,'public-origin.json'),JSON.stringify({base,certificateValidation:true,apiGuard:true,staticManifestPublic:true,anonymousQuickTunnel:true,productionResources:false,limitations:['Ephemeral test ingress, no SLA','Quick Tunnels do not support SSE; not an AI-host acceptance environment','WebSocket upgrades intentionally denied by this test guard']},null,2));
    return {base,entry:base+entry,username,password,userId:admin.user.id,fixture,auth,stop,async serverRows(){const r=await fetch(fixture.base+'/api/sync/pull?since=0',{headers:{Authorization:`Bearer ${admin.token}`}});assert.equal(r.status,200);return (await r.json()).records;}};
  }catch(error){await stop();throw error;}
}

// Re-exec before opening TLS sockets: Node's public trust roots remain intact,
// with only the isolated loopback fixture CA added. Browsers get NO TLS bypass.
export function fixtureTlsEnvironment(marker) {
  if(process.env[marker])return {cert:process.env[marker],key:process.env[marker+'_KEY']};
  const dir=mkdtempSync(join(tmpdir(),'tcg-platform-ca-')),cert=join(dir,'cert.pem'),key=join(dir,'key.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','2','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore'});chmodSync(key,0o600);
  return {reexec:{...process.env,[marker]:cert,[marker+'_KEY']:key,NODE_EXTRA_CA_CERTS:cert}};
}
