#!/usr/bin/env node
// Embedded AI + universal MCP acceptance on the real built Worker, local D1 and
// real browsers. Provider: the deterministic SIMULATED fixture provider only
// (WORKSPACE_ENV=local-test). This is NOT real-provider acceptance.
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {chromium,firefox,webkit} from 'playwright';
import {startFixture,bootstrap,push,pull,api,eventually} from './phase4-fixture.mjs';
import {connectFixtureMcp} from './certification/mcp-client.mjs';
import {freePort,fingerprint} from './certification/core.mjs';
import {createCertificationReporter} from './certification-report.mjs';

const engines={chromium,firefox,webkit},only=process.argv.find(a=>a.startsWith('--only='))?.slice(7);
if(only&&!engines[only])throw new Error('Unknown browser');
const names=['embedded sourced answer with keyboard open/close','selection rewrite applied through editor mutate','meeting workflow proposal approved and executed with attribution','provider failure keeps workspace usable without fallback','external MCP host uses the same canonical capabilities','session revocation stops an in-flight run','mobile assistant and approval journey','permission-enabled assistant cache clears on revocation','keyboard-height long composer keeps Send reachable'];
const accessOnly=process.argv.includes('--only-access'),keyboardOnly=process.argv.includes('--only-keyboard');
if(accessOnly&&keyboardOnly)throw new Error('Select one focused assistant journey');
const mandatoryNames=accessOnly?[names[7]]:keyboardOnly?[names[8]]:names;
const reporter=createCertificationReporter('verify-assistant',(only?[only]:Object.keys(engines)).flatMap(e=>mandatoryNames.map(n=>e+'/'+n)));
process.env.CERT_SOURCE_SHA??=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const output=process.env.CERT_ARTIFACT_DIR??mkdtempSync(join(tmpdir(),'tcg-assistant-'));mkdirSync(output,{recursive:true});process.env.CERT_ARTIFACT_DIR??=output;process.env.CERT_RESULT_PATH??=join(output,'results.json');
reporter.setMetadata('providerMode','SIMULATED fixture provider only; no real model execution');reporter.setMetadata('permissionMode',accessOnly?'ENABLED':keyboardOnly?'DISABLED':'MIXED — compatibility/keyboard assertions DISABLED; cache-revocation assertion ENABLED');reporter.setMetadata('sourceFingerprint',fingerprint(process.cwd()));
let built=process.argv.includes('--skip-build');

async function sse(base,token,path,body){
 const r=await fetch(base+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const t=await r.text();return {status:r.status,events:t.split('\n').filter(l=>l.startsWith('data:')).map(l=>JSON.parse(l.slice(5)))};
}

for(const [engine,type] of Object.entries(engines).filter(([e])=>!only||e===only)){
 let fixture,browser,context,page,mcp;const dir=join(output,engine);mkdirSync(dir,{recursive:true});
 const check=async(name,viewport,fn)=>{if(!mandatoryNames.includes(name))return;const t=performance.now();try{await fn();reporter.record(engine,viewport,name,'PASS',null,{durationMs:Math.round(performance.now()-t),permissionMode:name===names[7]?'ENABLED':'DISABLED'});console.log('PASS ['+engine+'] '+name);}catch(e){await page?.screenshot({path:join(dir,name.replace(/\W+/g,'-')+'.png')}).catch(()=>{});reporter.record(engine,viewport,name,'FAIL',e,{permissionMode:name===names[7]?'ENABLED':'DISABLED'});console.error('FAIL ['+engine+'] '+name+': '+e.message);}};
 try{
  fixture=await startFixture({port:await freePort(),build:!built,artifactDirectory:dir});built=true;
  const {admin,bob}=await bootstrap(fixture.base),token=admin.token,base=fixture.base;
  await push(base,token,[
   {id:'proj',collection:'pages',patch:{title:'Project Atlas',order:'a0'}},
   {id:'proj_b1',collection:'blocks',patch:{pageId:'proj',type:'p',text:'Atlas launch is blocked by vendor review and needs owner follow up.',order:'a0'}},
   {id:'meet',collection:'pages',patch:{title:'Weekly meeting notes',order:'a1'}},
   {id:'meet_b1',collection:'blocks',patch:{pageId:'meet',type:'p',text:'Decision: ship beta. Action: prepare release checklist.',order:'a0'}},
  ]);
  const boards=(await pull(base,token)).filter(r=>r.collection==='boards');const boardId=boards.find(b=>b.id==='board-default')?.id??boards[0]?.id??'board-default';
  browser=await type.launch({headless:true});await reporter.trackBrowser?.(browser,engine);
  context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});
  await context.addInitScript(a=>{localStorage.setItem('ws_token',a.token);localStorage.setItem('ws_uid',a.user.id);localStorage.setItem('ws_user',JSON.stringify(a.user));},admin);
  page=await context.newPage();page.setDefaultTimeout(25000);
  const panel=()=>page.getByTestId('assistant-panel');
  const chooseSimulated=async()=>{const sel=panel().getByTestId('assistant-provider-select');await sel.waitFor();if(await sel.inputValue()!=='simulated')await sel.selectOption('simulated');};
  const ask=async text=>{await panel().getByTestId('assistant-input').fill(text);await panel().getByTestId('assistant-send').click();};
  const openPanel=async()=>{if(!(await panel().isVisible()))await page.getByTestId('assistant-toggle').filter({visible:true}).first().click();await panel().waitFor();};
  const closePanel=async()=>{if(await panel().isVisible())await panel().getByRole('button',{name:'Close assistant'}).first().click();await panel().waitFor({state:'hidden'});};

  await check(names[0],'1440',async()=>{
   await page.goto(base+'/pages/proj');await page.getByText('Atlas launch is blocked').first().waitFor();
   const toggle=page.getByTestId('assistant-toggle').first();await toggle.focus();
   await page.keyboard.press(process.platform==='darwin'?'Meta+j':'Control+j');await panel().waitFor();
   await panel().getByTestId('assistant-context-chip').first().waitFor();
   await chooseSimulated();await ask('Summarize progress and blockers for this project');
   const reply=panel().getByTestId('assistant-message-assistant').last();await reply.getByText(/\[proj\]|authorized sources/).waitFor({timeout:30000});
   await panel().getByTestId('assistant-source-chip').first().waitFor();
   const href=await panel().getByTestId('assistant-source-chip').first().getAttribute('href');assert.ok(!href||href.startsWith('/'),'citation links stay internal');
   await page.keyboard.press('Escape');await panel().waitFor({state:'hidden'});
  });
  await check(names[1],'1440',async()=>{
   await page.goto(base+'/pages/proj');const block=page.locator('[data-block-id="proj_b1"] [contenteditable="true"]').first();await block.waitFor();
   await block.evaluate(el=>{const t=el.firstChild;const r=document.createRange();const s=(t.textContent??'').indexOf('blocked');r.setStart(t,s);r.setEnd(t,s+'blocked by vendor review'.length);const sel=getSelection();sel.removeAllRanges();sel.addRange(r);el.focus();document.dispatchEvent(new Event('selectionchange'));});
   const trigger=page.getByTestId('ask-ai-selection');await trigger.waitFor();await trigger.click();await page.getByRole('group',{name:'AI actions for the selection'}).getByTestId('ask-ai-action-selection_rewrite').click();
   await panel().waitFor();await chooseSimulated();
   if(!(await panel().getByTestId('assistant-message-user').count()))await ask('Rewrite the selection');
   const apply=panel().getByTestId('assistant-apply-selection').last();await apply.waitFor({timeout:30000});await apply.click();
   await eventually(async()=>{const b=(await pull(base,token)).find(r=>r.id==='proj_b1');return String(b?.data?.text??'').includes('Rewritten: blocked by vendor review');},{timeout:20000});
   await closePanel();
  });
  await check(names[2],'1440',async()=>{
   await page.goto(base+'/pages/meet');await page.getByText('Decision: ship beta').first().waitFor();await openPanel();await chooseSimulated();
   const args={workflow:'meeting_to_actions',workflowId:'e2e-meeting',sourceIds:['meet'],destinationDatabaseId:boardId,title:'Meeting actions',items:[{title:'Prepare release checklist',inferred:false},{title:'Confirm beta scope',inferred:true}]};
   await ask('/tool propose_workflow '+JSON.stringify(args));
   const card=panel().getByTestId('assistant-approval-card').last();await card.waitFor({timeout:30000});
   await card.getByText(/^Content items: /).waitFor();
   await card.getByText(/^Activity\/audit rows: /).waitFor();
   await card.getByText(/^Total planned operations: /).waitFor();
   assert.equal((await pull(base,token)).filter(r=>r.collection==='tasks'&&r.data?.title==='Prepare release checklist').length,0,'nothing written before approval');
   await card.getByTestId('assistant-approve').click();
   await eventually(async()=>(await pull(base,token)).some(r=>r.collection==='tasks'&&r.data?.title==='Prepare release checklist'&&r.data?.aiProvenance?.workflow==='meeting_to_actions'),{timeout:20000});
   await card.getByText(/changeset/i).first().waitFor();
   const changes=await api(base,'/api/changes?mine=1',{token});assert.ok(JSON.stringify(changes.data).includes('meeting_to_actions')||JSON.stringify(changes.data).includes('propose_workflow')||changes.status===200);
   await closePanel();
  });
  await check(names[3],'1440',async()=>{
   await openPanel();await chooseSimulated();
   await ask('/fail subscription_sharing_usage_limit_exceeded');
   await panel().getByText(/No other provider was used/i).first().waitFor({timeout:30000});
   await closePanel();await page.goto(base+'/pages/proj');await page.getByText('Project Atlas').first().waitFor();
   const runs=await api(base,'/api/assistant/providers',{token});assert.equal(runs.status,200);
  });
  await check(names[4],'api',async()=>{
   mcp=await connectFixtureMcp(base,{name:'Assistant parity host'});
   const autos=await mcp.call('list_automations',{});assert.ok(Array.isArray(autos.automations));
   const pageData=await mcp.call('get_page',{pageId:'proj'});assert.ok(JSON.stringify(pageData).includes('Project Atlas'));
   const meet=await mcp.call('get_page',{pageId:'meet'});const rev=meet.page?.rev??meet.rev;assert.ok(Number.isInteger(rev),'get_page exposes rev');
   const preview=await mcp.call('delete_item',{type:'page',id:'meet',expectedRev:rev,dryRun:true});
   assert.equal(preview.humanApprovalRequired,true,'external destructive writes keep the human-approval contract');
   assert.ok((await pull(base,token)).some(r=>r.id==='meet'&&!r.data?.deleted),'external proposal did not delete');
  });
  await check(names[5],'api',async()=>{
   const second=await api(base,'/api/auth/login',{method:'POST',body:{username:'admin',password:'password123'}});const t2=second.data.token;assert.ok(t2);
   const conv=await api(base,'/api/assistant/conversations',{token:t2,method:'POST',body:{}});
   const first=await sse(base,t2,`/api/assistant/conversations/${conv.data.id}/messages`,{text:'Summarize',provider:'simulated',context:[{kind:'page',id:'proj'}]});
   const end=first.events.find(e=>e.type==='step_end');assert.equal(end?.next,'continue');
   assert.equal((await api(base,'/api/auth/logout',{token:t2,method:'POST'})).status,200);
   const cont=await fetch(base+`/api/assistant/runs/${end.runId}/continue`,{method:'POST',headers:{Authorization:'Bearer '+t2,'Content-Type':'application/json'},body:JSON.stringify({step:end.step})});
   assert.equal(cont.status,401);
  });
  await context.close();
  context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:engine!=='firefox',serviceWorkers:'block'});
  await context.addInitScript(a=>{localStorage.setItem('ws_token',a.token);localStorage.setItem('ws_uid',a.user.id);localStorage.setItem('ws_user',JSON.stringify(a.user));},admin);
  page=await context.newPage();page.setDefaultTimeout(25000);
  await check(names[6],'390',async()=>{
   await page.goto(base+'/pages/proj');await page.getByText('Project Atlas').first().waitFor();
   const toggle=page.getByTestId('assistant-toggle').filter({visible:true}).first();await toggle.tap?.().catch(()=>toggle.click());if(!(await panel().isVisible()))await toggle.click();await panel().waitFor();
   const box=await panel().boundingBox();assert.ok(box&&box.width<=390+1,'panel fits the compact viewport');
   await chooseSimulated();await page.evaluate(()=>document.documentElement.style.setProperty('--vvh','287px'));await ask('/tool create_page {"title":"Mobile draft from assistant"}');
   const card=panel().getByTestId('assistant-approval-card').last();await card.waitFor({timeout:30000});
   const approve=card.getByTestId('assistant-approve');await approve.scrollIntoViewIfNeeded();const ab=await approve.boundingBox();assert.ok(ab&&ab.height>=40&&ab.x>=0&&ab.x+ab.width<=391,'approve control reachable');
   assert.ok(await approve.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),'keyboard-sized approval center must receive its own tap');
   await approve.tap();
   await eventually(async()=>(await pull(base,token)).filter(r=>r.collection==='pages'&&r.data?.title==='Mobile draft from assistant').length===1,{timeout:20000});
   await page.evaluate(()=>document.documentElement.style.removeProperty('--vvh'));
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);assert.equal(overflow,false,'no page-wide horizontal overflow');
  });


  await check(names[8],'320/375 keyboard',async()=>{
   await page.setViewportSize({width:375,height:667});await page.goto(base+'/pages/proj');await page.getByPlaceholder('Untitled',{exact:true}).waitFor();await openPanel();await chooseSimulated();
   const longDraft='Please propose actions from these source-linked meeting notes: café 中文. '.repeat(20);
   const actionVisible=async()=>{const sheet=await panel().boundingBox(),send=await panel().getByTestId('assistant-send').boundingBox();return sheet&&send&&send.y>=sheet.y&&send.y+send.height<=sheet.y+sheet.height+1&&await panel().getByTestId('assistant-send').evaluate(el=>{const r=el.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===el;});};
   for(const width of [320,375])for(const height of [220,275,362]){
    await page.setViewportSize({width,height:667});await panel().getByTestId('assistant-input').fill(longDraft);
    await page.evaluate(height=>{document.documentElement.style.setProperty('--vvh',height+'px');document.documentElement.style.setProperty('--vvo','0px');},height);
    await eventually(actionVisible,{timeout:5000}); // Existing draft survives a keyboard resize too.
    // Trigger textarea growth after the visible viewport shrinks. No manual
    // scrolling: the application must keep the action itself in view.
    await panel().getByTestId('assistant-input').fill(longDraft+' End.');
    await eventually(actionVisible,{timeout:5000});
    assert.equal(await panel().getByTestId('assistant-input').inputValue(),longDraft+' End.','Viewport fitting must preserve the complete unsent draft');
    await page.screenshot({path:join(dir,`assistant-keyboard-${width}-${height}.png`)});
   }
   await page.evaluate(()=>{document.documentElement.style.removeProperty('--vvh');document.documentElement.style.removeProperty('--vvo');});
  });

  await context.close();
  await check(names[7],'390',async()=>{
   const canary='CLIENT_PRIVATE_CANARY_'+engine,space='assistant_private_'+engine,secret='assistant_secret_'+engine,block=secret+'_block';
   await push(base,token,[{id:secret,collection:'pages',patch:{title:canary,order:'a0'}},{id:block,collection:'blocks',patch:{pageId:secret,type:'p',text:'A confidential source for assistant cache revocation testing.',order:'a0'}}]);
   const quote=v=>"'"+String(v).replaceAll("'","''")+"'";
   await fixture.sql(`INSERT INTO spaces(id,name,default_access,created_at) VALUES(${quote(space)},'Assistant private','private',1);
    INSERT INTO space_members(space_id,user_id,role) VALUES(${quote(space)},${quote(admin.user.id)},'owner'),(${quote(space)},${quote(bob.user.id)},'viewer');
    UPDATE users SET workspace_role='guest' WHERE id=${quote(bob.user.id)};
    UPDATE records SET space_id=${quote(space)} WHERE id IN(${quote(secret)},${quote(block)});
    UPDATE access_state SET enabled=1 WHERE id=1;`);
   context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:engine!=='firefox',serviceWorkers:'block'});
   await context.addInitScript(a=>{localStorage.setItem('ws_token',a.token);localStorage.setItem('ws_uid',a.user.id);localStorage.setItem('ws_user',JSON.stringify(a.user));},bob);
   page=await context.newPage();page.setDefaultTimeout(25000);
   await page.goto(base+'/pages/'+secret);await page.getByPlaceholder('Untitled',{exact:true}).waitFor();
   await openPanel();await chooseSimulated();await ask('Summarize this authorized source');
   await panel().getByTestId('assistant-source-chip').filter({hasText:canary}).waitFor({timeout:30000});
   const revoked=await api(base,'/api/spaces/'+space+'/members',{token,method:'POST',body:{targetUserId:bob.user.id,membership:{role:'viewer',access:'deny'},requestId:'assistant-revoke-'+engine}});assert.equal(revoked.status,200);
   // A real foreground reconciliation fetches the new server capabilities and
   // evicts this guest's private rows. No mocked access-store transition.
   await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
   await page.getByText('Page not found',{exact:true}).waitFor({timeout:30000});await openPanel();
   assert.ok(!(await panel().innerText()).includes(canary),'revoked source cannot survive the shell remount in assistant memory');
   await panel().getByRole('button',{name:'Conversation history',exact:true}).click();
   await panel().getByRole('button',{name:/^Summarize this authorized source /}).click();
   await eventually(async()=>await panel().getByTestId('assistant-message-assistant').count()>0);
   assert.ok(!(await panel().innerText()).includes(canary),'reopening history revalidates rather than reusing revoked memory');
   assert.equal(await panel().getByTestId('assistant-source-chip').count(),0);
   await page.screenshot({path:join(dir,'assistant-revoked-cache.png'),fullPage:true});
  });

 }catch(e){console.error('FAIL ['+engine+'] '+e.message);if(!reporter.results?.some?.(r=>r.engine===engine&&r.status==='FAIL'))reporter.record(engine,'none','setup','FAIL',e);}
 finally{await mcp?.close().catch(()=>{});await context?.close().catch(()=>{});await browser?.close().catch(()=>{});await fixture?.stop().catch(()=>{});}
}
const result=reporter.finish();console.log(`${result.status}: ${result.summary.pass} PASS / ${result.summary.fail} FAIL`);
