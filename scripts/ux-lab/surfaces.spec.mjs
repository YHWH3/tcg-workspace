import AxeBuilder from '@axe-core/playwright';
import {WCAG_AA_TAGS} from '../accessibility-tags.mjs';
import {test,expect,open,health,fixture,request,readRecord,setOfflineForTest} from './support.mjs';
import {randomUUID} from 'node:crypto';
import {readAccountStore} from '../certification/browser-db.mjs';
import {surfaces} from './catalog.mjs';
import {assertControlGeometry} from '../control-geometry.mjs';
for(const surface of surfaces)test(`surface: ${surface.id}`,async({page},info)=>{
  await open(page,surface);
  await info.attach(surface.id,{body:await page.screenshot({fullPage:true,animations:'disabled'}),contentType:'image/png'});
  await health(page,surface.id,info);
});
test('visual reference: website inbox',async({page},info)=>{
  await open(page,surfaces.find(s=>s.id==='website-inbox'));
  await expect(page.getByRole('textbox',{name:'Title',exact:true}).or(page.getByText('UX application · Example Applicant',{exact:true})).first()).toBeVisible();
  await health(page,'visual-inbox',info);
  // A reference is a change detector, not proof its first image is correct.
  await expect(page.locator('main')).toHaveScreenshot('website-inbox.png');
});
test('opened search: focus, empty results and recovery',async({page},info)=>{
  await open(page,surfaces.find(s=>s.id==='page'));
  const trigger=page.getByRole('button',{name:/^Search/}).first();await trigger.focus();await trigger.press('Enter');
  const input=page.getByRole('combobox',{name:'Search workspace',exact:true});await expect(input).toBeVisible();await input.fill('zzzzNoSyntheticMatch');
  await expect(page.getByText('No matching records',{exact:true})).toBeVisible();await health(page,'search-empty',info);
  await info.attach('search-empty',{body:await page.screenshot(),contentType:'image/png'});
  await page.keyboard.press('Escape');await expect(input).toBeHidden();await expect(trigger).toBeFocused();
  await trigger.press('Enter');await input.fill('UX journal');await expect(page.getByRole('option').filter({hasText:'UX journal'})).toBeVisible();
  await health(page,'search-recovered',info);
});
test('approvals network failure and recovery',async({page,context},info)=>{
  await context.route('**/api/approvals**',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"synthetic_unavailable"}'}));
  await open(page,surfaces.find(s=>s.id==='approvals-empty'));
  await expect(page.getByText(/Needs a connection/).first()).toBeVisible();await health(page,'approvals-failure',info);
  await context.unroute('**/api/approvals**');await page.reload();
  await expect(page.getByText('Nothing waiting on you.',{exact:true})).toBeVisible();await expect(page.getByText(/Needs a connection/)).toHaveCount(0);
  await health(page,'approvals-recovered',info);
});
test('negative controls: clipped labels and mismatched names must be detected',async({page},info)=>{
  await open(page,surfaces.find(s=>s.id==='task-detail'));
  const style=await page.addStyleTag({content:'select {height:28px!important;min-height:0!important;padding-top:8px!important;padding-bottom:8px!important;line-height:20px!important;}'});
  await expect(assertControlGeometry(page,'injected old clipping defect')).rejects.toThrow(/clipped control labels/);
  await style.evaluate(e=>e.remove());await assertControlGeometry(page,'restored controls');
  // Confirm that the configured tags detect a visible-label/name mismatch.
  // This deliberately inserted defect is removed before the restored audit.
  await page.evaluate(()=>{const button=document.createElement('button');button.id='ux-negative-label';button.textContent='Save changes';button.setAttribute('aria-label','Different action');button.style.cssText='position:fixed;top:80px;left:16px;z-index:99999;padding:8px;background:white;color:black;font-size:16px';(document.querySelector('[aria-label="Task title"]').closest('[role="dialog"]')??document.querySelector('main')).append(button);});
  await expect(page.locator('#ux-negative-label')).toBeVisible();
  try{
    const result=await new AxeBuilder({page}).include('#ux-negative-label').withTags(WCAG_AA_TAGS).analyze();
    expect(result.violations.map(v=>v.id)).toContain('label-content-name-mismatch');
  }finally{await page.locator('#ux-negative-label').evaluate(e=>e.remove());}
  await health(page,'restored negative controls',info);
  await open(page,surfaces.find(s=>s.id==='website-inbox'));
  await expect(page.getByRole('combobox',{name:'Group by',exact:true})).toBeVisible();
  await expect(page.getByRole('combobox',{name:'Group by',exact:true})).toHaveValue('');
  const widthStyle=await page.addStyleTag({content:'select[aria-label="Group by"] {width:80px!important;max-width:80px!important;}'});
  await expect(assertControlGeometry(page,'injected inline clipping')).rejects.toThrow(/clipped control labels/);
  await widthStyle.evaluate(e=>e.remove());await health(page,'restored grouping caption',info);
});
test('profile: every avatar palette colour remains readable',async({page},info)=>{
  await open(page,surfaces.find(s=>s.id==='settings'));
  for(const color of ['#e5484d','#e93d82','#8e4ec6','#6e56cf','#0091ff','#12a594','#30a46c','#e5a000']){
    await page.getByRole('button',{name:color,exact:true}).click();
    await health(page,'avatar '+color,info);
  }
});
test('opened view controls: filters, sorting and properties',async({page},info)=>{
  const viewId='ux-controls-'+info.project.name;
  await request('/api/sync/push',{protocol:3,changes:[{id:viewId,collection:'views',ts:Date.now(),patch:{databaseId:'ux-records',name:'Controls '+info.project.name,type:'table',config:{filters:[],sorts:[],visible:['title','status']},order:'z0'}}]});
  await open(page,{...surfaces.find(s=>s.id==='records-table'),path:'/boards/ux-records/views/'+viewId});
  for(const [name,match] of [['Filter',/^Filter(?: · \d+)?$/],['Sort',/^Sort(?: · \d+)?$/],['Properties','Properties']]){
    const trigger=page.getByRole('toolbar',{name:'View controls',exact:true}).getByRole('button',{name:match,exact:true});await trigger.focus();await trigger.press('Enter');
    const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
    if(name==='Filter')await dialog.getByRole('button',{name:'Add filter',exact:true}).click();
    if(name==='Sort')await dialog.getByRole('button',{name:'Add sort',exact:true}).click();
    if(name==='Filter'||name==='Sort')await expect(trigger).toHaveAccessibleName(name+' · 1');
    await health(page,'opened '+name,info);
    await info.attach('opened '+name,{body:await page.screenshot(),contentType:'image/png'});
    if(name==='Filter')await dialog.getByRole('button',{name:'Remove filter',exact:true}).click();
    if(name==='Sort')await dialog.getByRole('button',{name:'Remove sort',exact:true}).click();
    await page.keyboard.press('Escape');await expect(dialog).toBeHidden();await expect(trigger).toBeFocused();
  }
  await expect.poll(async()=>{const r=await readRecord(viewId);return {filters:r?.data.config.filters,sorts:r?.data.config.sorts};}).toEqual({filters:[],sorts:[]});
});
test('table: horizontal recovery exposes complete controls',async({page},info)=>{
  await open(page,surfaces.find(s=>s.id==='website-inbox'));
  const table=page.getByTestId('record-table');
  if(info.project.use.viewport.width<768){await expect(table).toHaveCount(0);await health(page,'compact record list',info);return;}
  await expect(table).toBeVisible();
  await table.evaluate(el=>{el.scrollLeft=el.scrollWidth;});
  await assertControlGeometry(page,'rightmost inbox columns');
  const event=page.getByRole('combobox',{name:'Event',exact:true}).first();
  await expect(event).toBeVisible();
  const box=await event.boundingBox(),container=await table.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(container.x-1);
  expect(box.x+box.width).toBeLessThanOrEqual(container.x+container.width+1);
  await table.evaluate(el=>{el.scrollLeft=0;});await health(page,'table scroll restored',info);
});
test('text enlargement: 200 percent in inbox and task detail',async({page},info)=>{
  for(const id of ['website-inbox','task-detail']){
    await open(page,surfaces.find(s=>s.id===id));await page.addStyleTag({content:'html {font-size:200% !important}'});
    await health(page,id+' text 200%',info);
    await info.attach(id+' text enlargement',{body:await page.screenshot(),contentType:'image/png'});
  }
});
test('task draft: focus, cross-field edits and responsive recovery',async({page,context},info)=>{
  const taskId='ux-draft-'+randomUUID();
  await request('/api/sync/push',{protocol:3,changes:[{id:taskId,collection:'tasks',ts:Date.now(),patch:{boardId:'ux-tasks',title:'Original draft',description:'Original description',status:'todo',order:'z0'}}]});
  await page.goto(fixture.base+'/boards/ux-tasks/tasks/'+taskId);
  const title=page.getByRole('textbox',{name:'Task title',exact:true}),description=page.getByRole('textbox',{name:'Task description',exact:true});
  await expect(title).toHaveValue('Original draft');await expect(description).toHaveValue('Original description');
  const writes=[];page.on('request',r=>{if(r.url().endsWith('/api/sync/push'))for(const ch of r.postDataJSON()?.changes??[])if(ch.id===taskId&&('title' in ch.patch||'description' in ch.patch))writes.push(ch.patch);});
  await title.focus();await title.press('Tab');await description.focus();await description.press('Tab');
  // Observe longer than the 800ms sync debounce and inspect retained local work
  // too, so a slow request cannot turn absence on the wire into a false pass.
  await page.waitForTimeout(1200);
  const pending=await readAccountStore(page,'outbox');
  expect([...writes,...pending.filter(r=>r.id===taskId).map(r=>r.patch)],'Focus-only navigation must not rewrite task text').toEqual([]);
  // A focused but unedited field must follow newly synchronized source text.
  // Compact sheets focus the title before the initial pull may finish.
  await title.focus();
  const changed=await request('/api/sync/push',{protocol:3,changes:[{id:taskId,collection:'tasks',ts:Date.now(),patch:{title:'Updated while focused'}}]});
  expect(changed.rejected).toBe(0);
  await expect.poll(async()=>(await readRecord(taskId))?.data.title).toBe('Updated while focused');
  // Exercise the real foreground-refresh path without blurring the input.
  // This tests source hydration, not a deadline for the 15s fallback poll
  // (whose timer can be reset by the engine's 5s connection-state check).
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(title).toHaveValue('Updated while focused',{timeout:20_000});
  await setOfflineForTest(page,context,true);
  const draft='Preserved café 👩🏽‍💻 '+('long text '.repeat(12)),body=('Description survives title changes and responsive remounts.\n').repeat(8);
  // Settle in-flight foreground reads after the offline transition, then click
  // the actual editable control. Source text can arrive before reconciliation.
  await expect.poll(()=>page._uxPending.size,'Foreground requests must settle before text entry').toBe(0);
  await title.click();await expect(title).toBeFocused();
  await title.fill(draft);await expect(title).toHaveValue(draft);
  await description.click();await expect(description).toBeFocused();
  await description.fill(body);await expect(description).toHaveValue(body);
  await page.setViewportSize({width:info.project.use.viewport.width<768?1440:390,height:900});
  await expect(title).toHaveValue(draft);await expect(description).toHaveValue(body);
  for (const input of [title,description]) await expect.poll(()=>input.evaluate(el=>el.scrollHeight-el.clientHeight),'All wrapped task text must remain visible').toBeLessThanOrEqual(1);
  await setOfflineForTest(page,context,false);
  await expect.poll(async()=>{const r=await readRecord(taskId);return {title:r?.data.title,description:r?.data.description};},{timeout:20_000}).toEqual({title:draft,description:body});
  await page.reload();await expect(title).toHaveValue(draft);await expect(description).toHaveValue(body);
  await health(page,'draft recovery',info);
});
