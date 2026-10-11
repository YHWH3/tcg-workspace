#!/usr/bin/env node
// Phase 4 independent built-Worker/browser certification. Every run owns an
// isolated D1 fixture; faults are real SQLite triggers, never production.
// node scripts/verify-v9.mjs [--only=chromium|firefox|webkit] [--skip-build]
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium,firefox,webkit} from 'playwright';
import {startFixture,bootstrap,api,push,pull,eventually} from './phase4-fixture.mjs';

const output=mkdtempSync(join(tmpdir(),'tcg-phase4-v9-'));
const results=[],performanceResults=[],browsers={chromium,firefox,webkit};
const selected=process.argv.find(a=>a.startsWith('--only='))?.split('=')[1];
if(selected&&!browsers[selected]) throw new Error('Unknown browser engine');
const fixture=await startFixture({port:8799,build:!process.argv.includes('--skip-build')});
const {base}=fixture,{admin,bob}=await bootstrap(base);
const request=(path,opts={})=>api(base,path,opts);
const update=changes=>push(base,admin.token,changes);
const rows=()=>pull(base,admin.token);
const allNotifications=async user=>(await request('/api/notifications?limit=100',{token:user.token})).data.notifications??[];
const sqlString=v=>"'"+String(v).replaceAll("'","''")+"'";
const sqlRows=async sql=>(await fixture.sql(sql)).flatMap(r=>r.results??[]);
const cron=async()=>{const response=await fetch(base+'/cdn-cgi/handler/scheduled?cron=*/15%20*%20*%20*%20*',{method:'POST'});assert.equal(response.status,200);const text=await response.text();assert.ok(!text.includes('<html'), 'Cron must execute the supported scheduled handler, not the SPA fallback');};
async function check(engine,name,fn) {
  const start=performance.now();
  try {await fn();results.push({engine,name,status:'PASS',ms:Math.round(performance.now()-start)});console.log(`PASS [${engine}] ${name}`);}
  catch(error){results.push({engine,name,status:'FAIL',error:String(error?.stack??error)});console.error(`FAIL [${engine}] ${name}: ${error}`);}
}
async function authenticatedPage(browser,user,options={}) {
  const context=await browser.newContext({viewport:{width:390,height:844},...options});
  await context.addInitScript(([token,user])=>{if(sessionStorage.getItem('v9_login_initialized'))return;sessionStorage.setItem('v9_login_initialized','1');localStorage.setItem('ws_token',token);localStorage.setItem('ws_user',JSON.stringify(user));localStorage.setItem('ws_uid',user.id);},[user.token,user.user]);
  return {context,page:await context.newPage()};
}
async function visible(page,text){await page.getByText(text,{exact:false}).first().waitFor({timeout:20_000});}
async function formFixture(prefix,{people=false}={}) {
  const databaseId=prefix+'_intake',id=prefix+'_form';
  await update([{id:databaseId,collection:'boards',patch:{name:prefix+' Intake',kind:'records',columns:[{id:'new',name:'New'},{id:'done',name:'Done'}],fields:people?[{id:'email',name:'Email',type:'text'}]:[]}}]);
  const config={id,databaseId,title:prefix+' Intake',enabled:true,fields:[{fieldKey:'title',label:'Your name',required:true},...(people?[{fieldKey:'p_email',label:'Email',required:true}]:[])],successMessage:'Server confirmed your response',notifyUserIds:[admin.user.id],...(people?{peopleMatch:{emailField:'email'}}:{})};
  const created=await request('/api/forms',{token:admin.token,method:'POST',body:config});assert.equal(created.status,200,JSON.stringify(created));
  const token=(await request(`/api/forms/${id}/tokens`,{token:admin.token,method:'POST'})).data.token;assert.ok(token);
  return {id,token,databaseId,config,url:base+'/f/'+token};
}
async function submission(page,form,name,email) {
  await page.goto(form.url);await page.getByLabel('Your name').fill(name);
  if(email)await page.getByLabel('Email').fill(email);
  await page.getByRole('button',{name:'Submit',exact:true}).click();
  await visible(page,'Server confirmed your response');
}
async function layout(page) {
  const state=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,
    unnamed:[...document.querySelectorAll('button,input:not([type=hidden]),select,textarea')].filter(el=>{
      if(!el.getClientRects().length)return false;
      return !(el.getAttribute('aria-label')||el.getAttribute('aria-labelledby')||el.getAttribute('title')||el.textContent?.trim()||el.labels?.length);
    }).map(el=>el.outerHTML.slice(0,140))}));
  assert.ok(state.scroll<=state.width+2,`horizontal document overflow ${JSON.stringify(state)}`);
  assert.deepEqual(state.unnamed,[],`unnamed visible controls ${JSON.stringify(state.unnamed)}`);
}

try {
  for(const [engine,browserType] of Object.entries(browsers).filter(([name])=>!selected||name===selected)) {
    let browser;
    try {browser=await browserType.launch({headless:true});}catch(error){results.push({engine,name:'engine launch',status:'FAIL',error:String(error)});continue;}
    console.log(`${engine} version ${browser.version()}`);
    const prefix=`v9_${engine}`,board=prefix+'_work',task=prefix+'_task';
    const main=await authenticatedPage(browser,bob),second=await authenticatedPage(browser,bob),owner=await authenticatedPage(browser,admin);
    const publicContext=await browser.newContext({viewport:{width:390,height:844}}),publicPage=await publicContext.newPage();
    const form=await formFixture(prefix),peopleForm=await formFixture(prefix+'_people',{people:true});
    await update([{id:board,collection:'boards',patch:{name:prefix+' Work',columns:[{id:'open',name:'Open'},{id:'done',name:'Done'}],fields:[]}},
      {id:task,collection:'tasks',patch:{boardId:board,title:prefix+' Assignment',status:'open',assigneeId:bob.user.id}}]);
    await check(engine,'J1 notifications: assignment/comment/mention, grouping, prefs, read-state and second device',async()=>{
      await update([{id:prefix+'_comment',collection:'comments',patch:{targetType:'task',targetId:task,body:`Hello @[user:${bob.user.id}]`,authorId:admin.user.id,createdAt:Date.now()}}]);
      await eventually(async()=>{const n=(await allNotifications(bob)).filter(n=>n.targetId===task||n.targetId===prefix+'_comment');return ['assigned','comment_on_mine','mention'].every(kind=>n.some(x=>x.kind===kind));});
      await main.page.goto(base+'/inbox');await visible(main.page,prefix+' Assignment');
      await second.page.goto(base+'/inbox');await visible(second.page,prefix+' Assignment');
      const notif=(await allNotifications(bob)).find(n=>n.targetId===task&&n.kind==='assigned');
      assert.ok(notif);const forbidden=await request(`/api/notifications/${notif.id}/read`,{token:admin.token,method:'POST'});assert.ok([403,404].includes(forbidden.status));
      await main.page.getByRole('button',{name:'Mark all read'}).click();
      await eventually(async()=>(await allNotifications(bob)).every(n=>n.readAt!==null));
      await second.page.reload();await visible(second.page,'Earlier');
      await main.page.getByRole('button',{name:'Notification preferences'}).click();
      await main.page.getByLabel('Assignments',{exact:true}).selectOption('off');
      await visible(main.page,'Saved');
      await update([{id:task,collection:'tasks',patch:{assigneeId:admin.user.id}}]);
      await update([{id:task,collection:'tasks',patch:{assigneeId:bob.user.id}}]);
      await eventually(async()=>(await rows()).find(r=>r.id===task)?.data.assigneeId===bob.user.id);
      assert.equal((await allNotifications(bob)).filter(n=>n.targetId===task&&n.kind==='assigned').length,1);
      await main.page.getByLabel('Assignments',{exact:true}).selectOption('inbox');await visible(main.page,'Saved');
      await update([{id:task,collection:'tasks',patch:{assigneeId:admin.user.id}}]);
      await update([{id:task,collection:'tasks',patch:{assigneeId:bob.user.id}}]);
      await eventually(async()=>(await allNotifications(bob)).filter(n=>n.targetId===task&&n.kind==='assigned').length===2);
      assert.ok(!(await allNotifications(admin)).some(n=>n.id===notif.id));
    });
    await check(engine,'J2 Cron twice: due indexing and reminder dedupe',async()=>{
      const due=new Date().toISOString().slice(0,10);await update([{id:task,collection:'tasks',patch:{dueDate:due}},{id:task,collection:'tasks',patch:{title:prefix+' Due reminder'}}]);
      await eventually(async()=>((await sqlRows(`SELECT * FROM date_index WHERE record_id=${sqlString(task)}`)).length===1));
      await cron();await eventually(async()=>(await allNotifications(bob)).some(n=>n.targetId===task&&n.kind==='due_soon'));
      const before=(await allNotifications(bob)).filter(n=>n.targetId===task&&n.kind==='due_soon');await cron();
      assert.deepEqual((await allNotifications(bob)).filter(n=>n.targetId===task&&n.kind==='due_soon'),before);
      await main.page.goto(base+'/inbox');await visible(main.page,prefix+' Due reminder');
    });
    await check(engine,'J3 completing recurrence creates exactly one next record',async()=>{
      await update([{id:prefix+'_repeat',collection:'tasks',patch:{boardId:board,title:prefix+' Repeat',status:'open',dueDate:'2026-10-20',recurrence:{freq:'weekly',interval:1}}}]);
      await update([{id:prefix+'_repeat',collection:'tasks',patch:{status:'done'}}]);
      await eventually(async()=>(await rows()).filter(r=>r.collection==='tasks'&&r.data.title===prefix+' Repeat'&&!r.data.deleted).length===2);
      await cron();assert.equal((await rows()).filter(r=>r.collection==='tasks'&&r.data.title===prefix+' Repeat'&&!r.data.deleted).length,2);
      await owner.page.goto(base+'/boards/'+board);await visible(owner.page,prefix+' Repeat');
    });
    await check(engine,'J4 unauthenticated form browser receives only server-confirmed receipt',async()=>{
      await publicPage.goto(form.url);assert.equal(await publicPage.evaluate(()=>localStorage.getItem('ws_token')),null);
      const responsePromise=publicPage.waitForResponse(r=>r.url()===base+'/api/public/forms/'+form.token&&r.request().method()==='POST');
      responsePromise.catch(()=>{});
      await submission(publicPage,form,prefix+' Visitor');const response=await responsePromise;assert.equal(response.status(),200);
      const receipt=await response.json();assert.equal(receipt.state,'accepted');assert.equal(receipt.recordId,undefined);assert.equal(receipt.recordUrl,undefined);
      assert.equal((await rows()).filter(r=>r.data.title===prefix+' Visitor').length,1);
    });
    await check(engine,'J5 lost accepted HTTP response → same submission ID/receipt/one record',async()=>{
      let accepted,requests=[];
      await publicPage.route('**/api/public/forms/'+form.token,async route=>{
        if(route.request().method()!=='POST')return route.continue();
        const body=route.request().postDataJSON();requests.push(body.submissionId);
        if(!accepted){const response=await route.fetch();assert.equal(response.status(),200);accepted=await response.json();await route.abort('failed');}
        else await route.continue();
      });
      await publicPage.goto(form.url);await publicPage.getByLabel('Your name').fill(prefix+' Lost response');
      await publicPage.getByRole('button',{name:'Submit',exact:true}).click();await visible(publicPage,'Network error');
      const replayPromise=publicPage.waitForResponse(r=>r.url()===base+'/api/public/forms/'+form.token&&r.request().method()==='POST');
      replayPromise.catch(()=>{});
      await publicPage.getByRole('button',{name:'Submit',exact:true}).click();await visible(publicPage,'Server confirmed your response');
      assert.deepEqual(await (await replayPromise).json(),accepted);assert.equal(requests.length,2);assert.equal(requests[0],requests[1]);
      assert.equal((await rows()).filter(r=>r.data.title===prefix+' Lost response').length,1);await publicPage.unroute('**/api/public/forms/'+form.token);
    });
    await check(engine,'J6 offline draft/invalid field/expired challenge/disabled form/stale processing recovery',async()=>{
      await publicPage.goto(form.url);await publicPage.getByLabel('Your name').fill(prefix+' Offline');
      await publicContext.setOffline(true);await publicPage.getByRole('button',{name:'Submit',exact:true}).click();await visible(publicPage,'Network error');
      await eventually(async()=>await publicPage.evaluate(token=>JSON.parse(localStorage.getItem('wsform_'+token)||'{}').values?.title,form.token)===prefix+' Offline');
      await publicContext.setOffline(false);await publicPage.reload();assert.equal(await publicPage.getByLabel('Your name').inputValue(),prefix+' Offline');
      await publicPage.getByLabel('Your name').fill('');await publicPage.getByRole('button',{name:'Submit',exact:true}).click();await publicPage.getByRole('alert').waitFor();
      assert.equal(await publicPage.getByLabel('Your name').getAttribute('aria-invalid'),'true');
      assert.equal(await publicPage.getByLabel('Your name').evaluate(el=>el===document.activeElement),true);
      await publicPage.getByLabel('Your name').fill(prefix+' Security retry');
      await publicPage.route('**/api/public/forms/'+form.token,async route=>{if(route.request().method()!=='POST')return route.continue();await route.continue({postData:JSON.stringify({...route.request().postDataJSON(),turnstileToken:'expired'})});});
      await publicPage.getByRole('button',{name:'Submit',exact:true}).click();await visible(publicPage,'Security check failed');await publicPage.unroute('**/api/public/forms/'+form.token);
      await fixture.sql("CREATE TRIGGER v9_receipt_fault BEFORE UPDATE OF state ON form_submissions WHEN NEW.state='accepted' BEGIN SELECT RAISE(ABORT,'v9 receipt interruption'); END;");
      await publicPage.getByRole('button',{name:'Submit',exact:true}).click();await visible(publicPage,'try again');
      await fixture.sql("DROP TRIGGER v9_receipt_fault; UPDATE form_submissions SET state='processing',lease_id='expired-v9',lease_until=1,retry_at=0 WHERE state='retryable_failure';");await cron();
      await publicPage.getByRole('button',{name:'Submit',exact:true}).click();await visible(publicPage,'Server confirmed your response');
      assert.equal((await rows()).filter(r=>r.data.title===prefix+' Security retry').length,1);
      await update([{id:form.id,collection:'forms',patch:{enabled:false}}]);await publicPage.goto(form.url);await visible(publicPage,'no longer accepting');
      await update([{id:form.id,collection:'forms',patch:{enabled:true}}]);
    });
    await check(engine,'J7 equivalent normalized emails reuse one Person without private match data',async()=>{
      const receipts=[];for(const email of [' ADA@EXAMPLE.COM ','ada@example.com']){
        const promise=publicPage.waitForResponse(r=>r.url()===base+'/api/public/forms/'+peopleForm.token&&r.request().method()==='POST');
        promise.catch(()=>{});
        await submission(publicPage,peopleForm,prefix+' Person',email);receipts.push(await(await promise).json());
      }
      assert.equal((await rows()).filter(r=>r.collection==='tasks'&&r.data.boardId===peopleForm.databaseId&&!r.data.deleted).length,1);
      assert.ok(receipts.every(r=>!('recordId'in r)&&!JSON.stringify(r).includes('ada@example.com')));
    });
    await check(engine,'J8 UI/direct-sync gate denial; authorized request/decision unlocks stage',async()=>{
      const gated=prefix+'_gated';await update([{id:board,collection:'boards',patch:{approvalGate:{stageId:'done'}}},{id:gated,collection:'tasks',patch:{boardId:board,title:prefix+' Gated',status:'open'}}]);
      const denied=await request('/api/sync/push',{token:admin.token,method:'POST',body:{changes:[{id:gated,collection:'tasks',patch:{status:'done'},ts:Date.now()}]}});
      assert.ok(denied.data.rejectedItems?.some(r=>r.reason==='approval_required'));
      await owner.page.goto(base+'/boards/'+board+'/tasks/'+gated);await visible(owner.page,prefix+' Gated');
      const stage=owner.page.locator('select').filter({has:owner.page.locator('option[value="done"]')}).first();await stage.selectOption('done');
      await visible(owner.page,'Approval required');
      assert.equal((await rows()).find(r=>r.id===gated)?.data.status,'open');
      const requested=await request('/api/approvals',{token:admin.token,method:'POST',body:{targetType:'record',targetId:gated,stageId:'done',approverId:bob.user.id,requestId:prefix+'_approval'}});assert.ok([200,201].includes(requested.status),JSON.stringify(requested));
      await main.page.goto(base+'/boards/'+board+'/tasks/'+gated);await main.page.getByRole('button',{name:'Approve',exact:true}).click();
      await eventually(async()=>(await request('/api/approvals?targetId='+gated,{token:bob.token})).data.approvals?.some(a=>a.status==='approved'));
      await update([{id:gated,collection:'tasks',patch:{status:'done'}}]);assert.equal((await rows()).find(r=>r.id===gated)?.data.status,'done');
      await update([{id:board,collection:'boards',patch:{approvalGate:null}}]);
    });
    const autoId=prefix+'_automation',autoTitle=prefix+' Review',triggerId=prefix+'_trigger';
    await check(engine,'J9 When/If/Then automation: records/subrecords/relations/notices/audit/logs/replay',async()=>{
      await update([{id:autoId,collection:'automations',patch:{name:prefix+' Rule',databaseId:board,enabled:true,trigger:{kind:'stage_changed',to:'done'},actions:[
        {type:'create_record',databaseId:board,title:autoTitle,link:{}},{type:'add_subrecords',titles:['Follow up {{record.title}}']},{type:'notify',userIds:[bob.user.id],message:'Review {{record.title}}'},
      ]}},{id:triggerId,collection:'tasks',patch:{boardId:board,title:prefix+' Trigger',status:'open'}}]);
      await owner.page.goto(base+'/automations/'+board);await owner.page.getByLabel('Automation name').filter({visible:true}).first().waitFor();
      assert.equal(await owner.page.getByLabel('Trigger').first().inputValue(),'stage_changed');
      await update([{id:triggerId,collection:'tasks',patch:{status:'done'}}]);
      const run=await eventually(async()=>{const r=(await request(`/api/automations/${autoId}/runs`,{token:admin.token})).data.runs?.find(r=>r.status==='completed');return r;});
      const outputs=(await rows()).filter(r=>r.collection==='tasks'&&[autoTitle,'Follow up '+prefix+' Trigger'].includes(r.data.title));assert.equal(outputs.length,2);
      assert.ok((await rows()).some(r=>r.collection==='links'&&r.data.fromId===outputs.find(r=>r.data.title===autoTitle)?.id&&r.data.toId===triggerId));
      assert.ok((await request('/api/changes/'+run.changeset_id,{token:admin.token})).data.items.length>=2);
      await owner.page.getByRole('button',{name:'Run history'}).first().click();await visible(owner.page,'Completed');
      await cron();assert.equal((await rows()).filter(r=>r.data.title===autoTitle&&!r.data.deleted).length,1);
    });
    await check(engine,'J10 actual SQLite failure before automation completion; concurrent recovery/undo',async()=>{
      await fixture.sql(`CREATE TRIGGER v9_run_fault BEFORE UPDATE OF status ON automation_runs WHEN NEW.status='completed' AND NEW.automation_id=${sqlString(autoId)} BEGIN SELECT RAISE(ABORT,'v9 completion interruption'); END;`);
      const failedTrigger=prefix+'_failed_trigger';await update([{id:failedTrigger,collection:'tasks',patch:{boardId:board,title:prefix+' Failed trigger',status:'open'}}]);await update([{id:failedTrigger,collection:'tasks',patch:{status:'done'}}]);
      const failed=await eventually(async()=>(await request(`/api/automations/${autoId}/runs`,{token:admin.token})).data.runs?.find(r=>r.status==='retryable_failure'));
      await fixture.sql(`DROP TRIGGER v9_run_fault; UPDATE automation_runs SET retry_at=0,lease_until=0 WHERE id=${sqlString(failed.id)};`);await Promise.all([cron(),cron()]);
      const recovered=await eventually(async()=>(await request(`/api/automations/${autoId}/runs`,{token:admin.token})).data.runs?.find(r=>r.id===failed.id&&r.status==='completed'));
      const before=(await request('/api/changes/'+recovered.changeset_id,{token:admin.token})).data.items;assert.equal(before.length,3);
      const undone=await request('/api/changes/'+recovered.changeset_id+'/undo',{token:admin.token,method:'POST'});assert.equal(undone.status,200,JSON.stringify(undone));
      await cron();assert.ok((await rows()).filter(r=>before.some(i=>i.record_id===r.id)).every(r=>r.data.deleted===true));
    });
    await check(engine,'J11 TCG pack install/reinstall preserves edited records/templates/views and five rules',async()=>{
      await owner.page.goto(base+'/settings');await visible(owner.page,'Template gallery');
      const row=owner.page.locator('li').filter({hasText:'TCG Operating Pack'}).first();await row.getByRole('button',{name:/Add to workspace|Reinstall|Preview/}).first().click();
      await owner.page.getByRole('dialog').getByRole('button',{name:/^Install$|^Reinstall$/}).click();
      await eventually(async()=>owner.page.url().includes('/pages/'),{timeout:60_000});
      let installed=await eventually(async()=>{const r=await rows();return r.some(x=>x.collection==='pages'&&x.data.templateKey==='tcg-pack'&&!x.data.deleted)?r:false;},{timeout:30_000});const root=installed.find(r=>r.collection==='pages'&&r.data.templateKey==='tcg-pack'&&!r.data.deleted);assert.ok(root);
      const edit=installed.find(r=>r.collection==='tasks'&&r.id.startsWith('inst_')&&!r.data.deleted)??installed.find(r=>r.collection==='boards'&&r.data.templateDbKey);assert.ok(edit);
      await update([{id:edit.id,collection:edit.collection,patch:{...(edit.collection==='boards'?{name:'User edited pack database'}:{title:'User edited pack record'})}},{id:root.id,collection:'pages',patch:{title:'User edited pack root'}}]);
      const before=await rows();await owner.page.goto(base+'/settings');const reinstall=owner.page.locator('li').filter({hasText:'TCG Operating Pack'}).first();await reinstall.getByRole('button',{name:/Reinstall|Preview/}).first().click();await owner.page.getByRole('dialog').getByRole('button',{name:'Reinstall',exact:true}).click();
      await eventually(async()=>owner.page.url().includes('/pages/'),{timeout:60_000});await eventually(async()=>(await rows()).find(r=>r.id===root.id)?.data.title==='User edited pack root');const after=await rows();
      assert.equal(after.find(r=>r.id===edit.id)?.data.title??after.find(r=>r.id===edit.id)?.data.name,'User edited pack '+(edit.collection==='boards'?'database':'record'));
      for(const r of before.filter(r=>['views','pages'].includes(r.collection)&&r.data.templateKey==='tcg-pack'))assert.deepEqual(after.find(a=>a.id===r.id)?.data,r.data);
      const rules=after.filter(r=>r.collection==='automations'&&!r.data.deleted&&r.id.startsWith('inst_'));assert.ok(rules.length>=5,`only ${rules.length} TCG rules`);
      for(const rule of rules){const validation=await request(`/api/automations/${rule.id}/validate`,{token:admin.token});assert.deepEqual(validation.data.errors,[],JSON.stringify(validation));}
    });
    await check(engine,'J12 shared browser logout/account switch clears private Inbox and account data',async()=>{
      const alice=await allNotifications(admin),bobRows=await allNotifications(bob);assert.ok(bobRows.length);
      await main.page.goto(base+'/inbox');await visible(main.page,'Inbox');
      await main.page.evaluate(()=>{localStorage.removeItem('ws_token');localStorage.removeItem('ws_user');localStorage.removeItem('ws_uid');});await main.page.reload();
      await main.page.locator('input[type="password"]').waitFor();assert.ok(!(await main.page.locator('body').innerText()).includes(prefix+' Assignment'));
      await main.page.evaluate(([token,user])=>{localStorage.setItem('ws_token',token);localStorage.setItem('ws_user',JSON.stringify(user));localStorage.setItem('ws_uid',user.id);},[admin.token,admin.user]);
      await main.page.goto(base+'/inbox');await visible(main.page,'Inbox');
      const clientData=await main.page.evaluate(async()=>{const response=await fetch('/api/notifications?limit=100',{headers:{Authorization:'Bearer '+localStorage.getItem('ws_token')}});return response.json();});
      assert.deepEqual(clientData.notifications.map(n=>n.id).sort(),alice.map(n=>n.id).sort());assert.ok(!clientData.notifications.some(n=>bobRows.some(b=>b.id===n.id)));
    });
    // Layout certification is separate from journeys: all five widths on the
    // priority surfaces, then text-growth/reflow, reduced motion and keyboard.
    for(const viewport of [{width:320,height:780},{width:390,height:844},{width:768,height:1024},{width:1024,height:768},{width:1440,height:1000}]) {
      await check(engine,`platform ${viewport.width}px form/inbox/automation reflow`,async()=>{
        for(const [page,path] of [[publicPage,form.url],[owner.page,base+'/inbox'],[owner.page,base+'/automations/'+board]]) {
          await page.setViewportSize(viewport);await page.goto(path);await page.locator('h1').first().waitFor({timeout:20_000});if(path.includes('/f/'))await page.getByLabel('Your name').waitFor();await layout(page);
          await page.screenshot({path:join(output,`${engine}-${viewport.width}-${path.includes('/f/')?'form':path.includes('/inbox')?'inbox':'automation'}.png`),fullPage:true});
        }
      });
    }
    await check(engine,'platform keyboard/errors/dialog/reduced-motion/200% text/400% reflow/offline Inbox/slow form',async()=>{
      await publicPage.setViewportSize({width:390,height:844});await publicPage.goto(form.url);await publicPage.getByLabel('Your name').waitFor();
      await publicPage.emulateMedia({reducedMotion:'reduce'});assert.ok(await publicPage.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches));
      await publicPage.getByLabel('Your name').focus();await publicPage.keyboard.press('Tab');assert.ok(await publicPage.evaluate(()=>document.activeElement?.tagName!=='BODY'));
      await publicPage.addStyleTag({content:'html{font-size:200% !important}'});await layout(publicPage);await publicPage.screenshot({path:join(output,engine+'-form-text200.png'),fullPage:true});
      await publicPage.setViewportSize({width:320,height:800});await layout(publicPage);await publicPage.screenshot({path:join(output,engine+'-form-400-reflow-equivalent.png'),fullPage:true});
      await owner.page.setViewportSize({width:390,height:844});await owner.page.goto(base+'/boards/'+board+'/tasks/'+task);await owner.page.getByRole('button',{name:'Request approval',exact:true}).first().click();
      await owner.page.getByRole('dialog').waitFor();await owner.page.keyboard.press('Escape');assert.equal(await owner.page.getByRole('dialog').count(),0);
      await main.context.setOffline(true);await main.page.goto(base+'/inbox').catch(()=>{});await main.context.setOffline(false);await main.page.goto(base+'/inbox');await visible(main.page,'Inbox');
      await publicPage.route('**/api/public/forms/'+form.token,async route=>{await new Promise(resolve=>setTimeout(resolve,250));await route.continue();});const started=performance.now();await publicPage.goto(form.url);await publicPage.getByLabel('Your name').waitFor();performanceResults.push({engine,metric:'slow form schema paint',ms:Math.round(performance.now()-started),delayMs:250});await publicPage.unroute('**/api/public/forms/'+form.token);
    });
    for(const context of [main.context,second.context,owner.context,publicContext])await context.close();await browser.close();
  }
} finally {
  fixture.stop();
  writeFileSync(join(output,'results.json'),JSON.stringify({base,fixture:fixture.directory,results,performance:performanceResults,externalGates:[{name:'Physical iPhone Safari',status:'NOT RUN',reason:'No physical device attached'},{name:'Physical Android',status:'NOT RUN',reason:'No physical device attached'},{name:'Screen reader/assistive technology',status:'NOT RUN',reason:'No human assistive-technology session available'},{name:'Native browser 400% zoom',status:'NOT RUN',reason:'320px reflow-equivalent viewport is tested; native zoom is not falsely equated'}]},null,2));
  console.log(`Evidence: ${output}; PASS ${results.filter(r=>r.status==='PASS').length}; FAIL ${results.filter(r=>r.status==='FAIL').length}`);
}
process.exitCode=results.some(r=>r.status==='FAIL')?1:0;
