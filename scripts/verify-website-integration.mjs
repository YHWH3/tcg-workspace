#!/usr/bin/env node
// Actual relay handler + actual Miniflare D1 -> HTTPS built Workspace Worker.
// Node trusts only the fixture CA via NODE_EXTRA_CA_CERTS. No global trust changes.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:https';
import {createServer as httpServer} from 'node:http';
import {createHmac} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {startFixture,PASSWORD} from './phase4-fixture.mjs';
import {freePort,fingerprint} from './certification/core.mjs';
const root=resolve(import.meta.dirname,'..'),site=resolve(process.env.WEBSITE_REPOSITORY_PATH??'');
assert.ok(process.env.WEBSITE_REPOSITORY_PATH,'Set WEBSITE_REPOSITORY_PATH to the isolated website checkout');
assert.equal(readFileSync(join(root,'docs/integrations/the-common-ground.md'),'utf8'),readFileSync(join(site,'INTEGRATION-WORKSPACE.md'),'utf8'),'mirrored integration contract');
const out=resolve(process.env.WEBSITE_INTEGRATION_ARTIFACT_DIR??'.artifacts/website-https');mkdirSync(out,{recursive:true});
const tls={key:join(out,'key.pem'),cert:join(out,'cert.pem')};
const {default:relay,forwardSweep}=await import(pathToFileURL(join(site,'services/form-relay/dist/worker.js')));
let worker,mf,server,providers;
const results=[];const test=async(name,fn)=>{await fn();results.push({test:name,status:'PASS'});console.log('PASS '+name);};
try{
 worker=await startFixture({port:await freePort(),build:!process.argv.includes('--skip-build'),artifactDirectory:join(out,'workspace'),tls,vars:{WEBSITE_INGEST_ENABLED:'true',WEBSITE_INGEST_SECRET:'fixture-integration-signing-key'}});
 const signup=await fetch(worker.base+'/api/auth/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',name:'Fixture Admin',password:PASSWORD})});
 const admin=await signup.json();assert.ok(admin.token,'HTTPS fixture signup');const auth={Authorization:'Bearer '+admin.token,'Content-Type':'application/json'};
 const configured=await fetch(worker.base+'/api/admin/website-ingest',{method:'PUT',headers:auth,body:JSON.stringify({spaceId:'space-core'})});assert.equal(configured.status,200,await configured.clone().text());
 mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'relay-d1',modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-09-25',d1Databases:{PATRON_DB:'isolated-relay'}}]}));
 const db=await mf.getD1Database('PATRON_DB');
 for(const file of readdirSync(join(site,'services/form-relay/migrations')).filter(f=>f.endsWith('.sql')).sort()){
  const sql=readFileSync(join(site,'services/form-relay/migrations',file),'utf8').replace(/--[^\n]*/g,'');
  await db.batch((sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi)??[]).map(s=>db.prepare(s.trim())));
 }
 let emails=0;
 providers=httpServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;res.setHeader('Content-Type','application/json');
  if(req.url==='/emails'){emails++;res.end(JSON.stringify({id:'fixture-email-'+emails}));}
  else if(req.url==='/payment_links')res.end(JSON.stringify({id:'plink_fixture',short_url:'https://example.invalid/fixture'}));
  else if(req.url==='/orders')res.end(JSON.stringify({id:'order_fixture'}));
  else{res.statusCode=500;res.end('{}');}});
 await new Promise(r=>providers.listen(0,'127.0.0.1',r));const providerBase='http://127.0.0.1:'+providers.address().port;
 const env={FORWARD_ENABLED:'1',FORWARD_URL:worker.base+'/api/ingest/website',FORWARD_SECRET:'fixture-integration-signing-key',PATRON_DB:db,RESEND_API_KEY:'fixture-only',RESEND_API_URL:providerBase+'/emails',FROM_EMAIL:'Fixture <fixture@example.org>',TO_EMAIL:'team@example.org',ALLOWED_ORIGINS:'https://thecommonground.living',PATRON_ADMIN_TOKEN:'fixture-admin',RAZORPAY_KEY_ID:'rzp_test_fixture',RAZORPAY_KEY_SECRET:'fixture-key',RAZORPAY_WEBHOOK_SECRET:'fixture-hook',RAZORPAY_API_URL:providerBase,PATRON_CHECKOUT:'on'};
 const pending=[];server=createServer({key:readFileSync(tls.key),cert:readFileSync(tls.cert)},async(req,res)=>{
  try{let raw='';for await(const chunk of req)raw+=chunk;const request=new Request('https://127.0.0.1'+req.url,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:raw});
   const response=await relay.fetch(request,env,{waitUntil:p=>pending.push(p)});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());}
  catch{res.writeHead(500);res.end('{}');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='https://127.0.0.1:'+server.address().port;
 const settle=async()=>{while(pending.length)await Promise.all(pending.splice(0));};
 const call=async(path,body,extra={})=>{const response=await fetch(base+path,{method:'POST',headers:{Origin:'https://thecommonground.living','Content-Type':'application/json',...extra},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
 const ops=(action,body)=>call('/patron/admin/'+action,body,{Authorization:'Bearer fixture-admin'});
 const form={form_id:'book',submission_id:'https-form',page:'/culture/book/',elapsed_ms:9000,answers:[{name:'Name',value:'Fixture Person'},{name:'Email',value:'fixture@example.org'},{name:'Craft',value:'Music, Film'},{name:'Work',value:'https://example.org/work'},{name:'About',value:'Synthetic integration answer'}]};
 await test('HTTPS form, durable delivery and browser retry preserve one event and email',async()=>{
  assert.equal((await call('/',form)).status,200);await settle();assert.equal((await call('/',form)).status,200);await settle();
  assert.equal(emails,1);const rows=(await db.prepare('SELECT state,attempts FROM relay_deliveries WHERE event_id=?').bind(form.submission_id).all()).results;assert.equal(rows[0].state,'delivered');assert.equal(rows[0].attempts,1);
 });
 let app;
 await test('apply, approve, paid and minted traverse the signed HTTPS relay',async()=>{
  const application=await call('/patron/apply',{tier:'founding',currency:'inr',name:'Fixture Patron',email:'fixture@example.org',country:'India',motivation:'Synthetic patron answers',elapsed_ms:9000,submission_id:'https-patron'});assert.equal(application.status,200,JSON.stringify(application.body));app=application.body.id;await settle();
  assert.equal((await ops('approve',{id:app,currency:'inr'})).status,200);await settle();
  const hook={event:'payment_link.paid',payload:{payment_link:{entity:{id:'plink_fixture',reference_id:app}},payment:{entity:{id:'pay_fixture',amount:8500000,currency:'INR',status:'captured'}}}};
  const raw=JSON.stringify(hook),signature=createHmac('sha256','fixture-hook').update(raw).digest('hex');
  assert.equal((await call('/patron/webhook',hook,{'X-Razorpay-Signature':signature,'X-Razorpay-Event-Id':'evt_fixture'})).status,200);await settle();
  assert.equal((await ops('minted',{id:app,tx:'0x'+'1'.repeat(64),token:'1000001'})).status,200);await settle();
  const row=await db.prepare("SELECT COUNT(*) n FROM relay_deliveries WHERE state='delivered'").first();assert.equal(row.n,5);
  const state=await worker.sql("SELECT COUNT(*) n FROM records WHERE collection='tasks' AND json_extract(data,'$.boardId')='board-website-inbox'");assert.equal(state[0].results[0].n,2);
  const patron=await worker.sql("SELECT json_extract(data,'$.p_wi_stage') stage FROM records WHERE collection='tasks' AND json_extract(data,'$.p_wi_application')='"+app+"'");assert.equal(patron[0].results[0].stage,'minted');
 });
 await test('outage returns visitor success only after durable storage, then recovery delivers',async()=>{
  const saved=env.FORWARD_URL;env.FORWARD_URL='https://127.0.0.1:1/api/ingest/website';assert.equal((await call('/',{...form,submission_id:'https-outage'})).status,200);await settle();
  assert.equal((await db.prepare("SELECT state FROM relay_deliveries WHERE event_id='https-outage'").first()).state,'pending');env.FORWARD_URL=saved;
  await db.prepare("UPDATE relay_deliveries SET next_attempt=0 WHERE event_id='https-outage'").run();await forwardSweep({...env});assert.equal((await db.prepare("SELECT state FROM relay_deliveries WHERE event_id='https-outage'").first()).state,'delivered');
 });
 await test('signed ingest succeeds with permissions enabled and grant revocation prevents writing',async()=>{
  await worker.sql('UPDATE access_state SET enabled=1 WHERE id=1');
  assert.equal((await call('/',{...form,submission_id:'https-permission'})).status,200);await settle();assert.equal((await db.prepare("SELECT state FROM relay_deliveries WHERE event_id='https-permission'").first()).state,'delivered');
  assert.equal((await fetch(worker.base+'/api/admin/website-ingest',{method:'DELETE',headers:auth})).status,200);
  assert.equal((await call('/',{...form,submission_id:'https-revoked'})).status,200);await settle();assert.equal((await db.prepare("SELECT state FROM relay_deliveries WHERE event_id='https-revoked'").first()).state,'pending');
 });
 await test('unsigned public ingest fails before processing',async()=>assert.equal((await fetch(worker.base+'/api/ingest/website',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401));
} finally {
 await new Promise(r=>server?server.close(r):r());await new Promise(r=>providers?providers.close(r):r());await mf?.dispose();await worker?.stop();
 writeFileSync(join(out,'results.json'),JSON.stringify({scope:'Local HTTPS; actual relay handler with Miniflare D1 and built Workspace Worker; providers simulated; no global trust change',sourceFingerprint:fingerprint(root),results},null,2));
}
