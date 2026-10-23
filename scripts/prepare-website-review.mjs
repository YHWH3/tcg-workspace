// Disposable synthetic review. Creates a proposal and opens it; never approves.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {startFixture,PASSWORD} from './phase4-fixture.mjs';
import {freePort,fingerprint} from './certification/core.mjs';
const root=resolve(import.meta.dirname,'..'),out=join(root,'.artifacts/ui-human-review');mkdirSync(out,{recursive:true});
let fixture,client,browser;
try {
 const tls={cert:join(root,'.artifacts/website-https/cert.pem'),key:join(root,'.artifacts/website-https/key.pem')};
 fixture=await startFixture({port:await freePort(),build:false,tls,artifactDirectory:join(out,'fixture'),vars:{WEBSITE_INGEST_ENABLED:'true',WEBSITE_INGEST_SECRET:'manual-review-disposable'}});
 const signup=await fetch(fixture.base+'/api/auth/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',name:'Synthetic Review Admin',password:PASSWORD})});const admin=await signup.json();assert.ok(admin.token);
 const auth={Authorization:'Bearer '+admin.token,'Content-Type':'application/json'};
 assert.equal((await fetch(fixture.base+'/api/admin/website-ingest',{method:'PUT',headers:auth,body:JSON.stringify({spaceId:'space-core'})})).status,200);
 const records=[];
 for(let i=0;i<3;i++){
  const body={v:2,id:'human-review-'+i,event:'form.submitted',occurred_at:new Date().toISOString(),form_id:'consulting',subject:'Synthetic review application',reply_to:`review${i}@example.org`,page:'/consulting/',answers:[{name:'Name',label:'Your name',value:'Synthetic Reviewer '+i},{name:'Email',label:'Email',value:`review${i}@example.org`},{name:'Why',label:'What are you building?',value:'Synthetic evidence for the integration review. No real applicant data.'}]};
  const raw=JSON.stringify(body),ts=String(Math.floor(Date.now()/1000));const response=await fetch(fixture.base+'/api/ingest/website',{method:'POST',headers:{'Content-Type':'application/json','X-TCG-Timestamp':ts,'X-TCG-Signature':'sha256='+crypto.createHmac('sha256','manual-review-disposable').update(`${ts}.${raw}`).digest('hex')},body:raw});assert.equal(response.status,200,await response.clone().text());records.push((await response.json()).recordId);
 }
 await fixture.sql('UPDATE access_state SET enabled=1 WHERE id=1');
 const redirect='http://localhost:8123/cb',resource=fixture.base+'/mcp';
 const dcr=await fetch(fixture.base+'/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Disposable manual review preparation',redirect_uris:[redirect],grant_types:['authorization_code'],response_types:['code'],token_endpoint_auth_method:'none'})}).then(r=>r.json());
 const verifier=crypto.randomBytes(32).toString('base64url'),state=crypto.randomUUID(),q=new URLSearchParams({response_type:'code',client_id:dcr.client_id,redirect_uri:redirect,state,resource,scope:'mcp',code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
 const consent=await fetch(fixture.base+'/oauth/authorize?'+q),html=await consent.text(),handle=html.match(/name="handle" value="([^"]+)"/)?.[1],cookie=consent.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');assert.ok(handle);
 const selected=await fetch(fixture.base+'/oauth/authorize?'+q,{method:'POST',redirect:'manual',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({handle,username:'admin',password:PASSWORD,decision:'allow'})});const scopes=await selected.text(),selection=scopes.match(/name="selection" value="([^"]+)"/)?.[1];assert.ok(selection);
 const approved=await fetch(fixture.base+'/oauth/authorize?'+q,{method:'POST',redirect:'manual',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({handle,selection,decision:'allow',spaces:'space-core'})});const callback=new URL(approved.headers.get('location'));assert.equal(callback.searchParams.get('state'),state);
 const tokens=await fetch(fixture.base+'/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code:callback.searchParams.get('code'),redirect_uri:redirect,client_id:dcr.client_id,code_verifier:verifier,resource})}).then(r=>r.json());assert.ok(tokens.access_token);
 client=new Client({name:'Manual review fixture',version:'1'},{capabilities:{}});await client.connect(new StreamableHTTPClientTransport(new URL(resource),{requestInit:{headers:{Authorization:'Bearer '+tokens.access_token}}}));
 const proposal=await client.callTool({name:'propose_website_triage',arguments:{updates:records.map(recordId=>({recordId,status:'in_review',priority:'low'}))}});assert.ok(!proposal.isError,JSON.stringify(proposal));const pending=JSON.parse(proposal.content[0].text);assert.ok(pending.previewId&&pending.reviewUrl);
 // No /decision or execute_preview call: approval and execution remain with the human.
 const source={sha:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),fingerprint:fingerprint(root)};
 // Human review must use the real window and Retina scale. Emulating a fixed
 // viewport/device scale in a native desktop window displaces OS select menus.
 browser=await chromium.launch({headless:false,args:['--window-size=1440,960']});
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:null});
 await context.route('**/*',route=>route.request().url().startsWith(fixture.base+'/')?route.continue():route.abort());
 await context.addInitScript(a=>{localStorage.setItem('ws_token',a.token);localStorage.setItem('ws_uid',a.user.id);localStorage.setItem('ws_user',JSON.stringify(a.user));},admin);
 const page=await context.newPage();await page.goto(pending.reviewUrl);await page.getByRole('heading',{name:'Review proposed changes',exact:true}).waitFor();await page.screenshot({path:join(out,'pending-review.png'),fullPage:true});
 const inbox=await context.newPage();await inbox.goto(fixture.base+'/boards/board-website-inbox/views/view-wi-all');
 await inbox.getByRole('heading',{name:'🌐 Website inbox',exact:true}).waitFor();
 await inbox.getByRole('combobox',{name:'Stage',exact:true}).first().waitFor();
 await inbox.screenshot({path:join(out,'inbox.png'),fullPage:true});
 const display=await inbox.evaluate(()=>({width:innerWidth,height:innerHeight,devicePixelRatio,screenWidth:screen.width,screenHeight:screen.height}));
 writeFileSync(join(out,'ready.json'),JSON.stringify({source,display,viewportMode:'NATIVE_WINDOW',preparedAt:new Date().toISOString(),base:fixture.base,reviewUrl:pending.reviewUrl,previewId:pending.previewId,status:'PENDING_GENUINE_HUMAN_REVIEW',approvalPerformedByAgent:false,provider:'OFF',permissionMode:'ENABLED_DISPOSABLE_FIXTURE_ONLY',records:records.length},null,2));
 writeFileSync(join(out,'REVIEW.md'),`# Genuine human review prepared\n\nA separate disposable Chromium window shows the pending proposal at ${pending.reviewUrl}. All three records and the user account are synthetic. The preparation script has not approved or executed the proposal. Review the answer bodies and proposed changes. Use the browser controls only if you choose to approve, cancel or execute this disposable example. This is separate from automated approval fixtures, and does not authorize production.\n\nSource: ${source.sha}. TLS exceptions are limited to this disposable browser context. Closing the browser stops its owned local Worker; the inbox is in the second tab. Rerun scripts/prepare-website-review.mjs with the fixture CA environment to recreate an expired proposal.\n`);
 console.log('READY: pending genuine human review at '+pending.reviewUrl);
 await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);browser.once('disconnected',resolve);});
}finally{await browser?.close().catch(()=>{});await client?.close().catch(()=>{});await fixture?.stop();}
