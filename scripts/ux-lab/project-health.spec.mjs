import {test,expect,open,health,request,readRecord,fixture,setOfflineForTest} from './support.mjs';
import {reloadReady} from '../navigation-ready.mjs';
import {readAccountStore} from '../certification/browser-db.mjs';
import {linkId} from '../../shared/linkid.ts';
const user=fixture.admin.user.id;
async function seed(info){
 const key=info.project.name.replaceAll('-','')+'-'+Date.now(),board='phb-'+key,tasks='pht-'+key,pageId='php-'+key,project='phr-'+key,task='phw-'+key,block='phk-'+key;
 const title='Project café 日本語 العربية 👩🏽‍💻 '+key;
 const rows=[
  {id:board,collection:'boards',patch:{name:'Review projects '+key,kind:'records',templateDbKey:'projects',columns:[{id:'active',name:'Active'},{id:'blocked',name:'Blocked'},{id:'completed',name:'Completed'}],fields:[{id:'f_owner',name:'Owner',type:'person'},{id:'f_start',name:'Start',type:'date'},{id:'f_end',name:'End',type:'date'}]}},
  {id:tasks,collection:'boards',patch:{name:'Review tasks '+key,kind:'tasks',columns:[{id:'todo',name:'Todo'},{id:'blocked',name:'Blocked'},{id:'done',name:'Done'}],fields:[{id:'project',name:'Project',type:'relation',relation:{target:board,primary:true}}]}},
  {id:project,collection:'tasks',patch:{boardId:board,title,status:'active',p_f_owner:null,p_f_start:null,p_f_end:null,createdAt:Date.now(),order:'a0'}},
  {id:task,collection:'tasks',patch:{boardId:tasks,title:'Blocked work '+key,status:'blocked',dueDate:'2020-01-01',createdAt:Date.now(),order:'a0'}},
  {id:linkId('relation','project',task,project),collection:'links',patch:{kind:'relation',fieldId:'project',fromType:'record',toType:'record',fromId:task,toId:project}},
  {id:pageId,collection:'pages',patch:{title:'Project review '+key,order:'a0'}},
  {id:block,collection:'blocks',patch:{pageId,type:'projecthealth',heading:'Review cockpit',databaseId:board,limit:10,order:'a0'}},
 ];
 expect((await request('/api/sync/push',{protocol:3,changes:rows.map(r=>({...r,ts:Date.now()}))})).rejectedItems).toEqual([]);
 return {board,tasks,pageId,project,task,block,title,rows,async cleanup(){await request('/api/sync/push',{protocol:3,changes:[...rows.map(r=>({id:r.id,collection:r.collection,patch:{deleted:true},ts:Date.now()})),{id:'projecthealth:'+project,collection:'blocks',patch:{deleted:true},ts:Date.now()}]});}};
}
async function cockpit(page,f){await open(page,{id:'project-health',path:'/pages/'+f.pageId,ready:{role:'heading',name:'Review cockpit'}});const region=page.getByRole('region',{name:'Project health',exact:true});await expect(region.getByText(f.title,{exact:true})).toBeVisible();return region;}

test('Project cockpit: transparent signals, exact cross-database sources and recovery',async({page,context},info)=>{
 const f=await seed(info);
 try{
  const region=await cockpit(page,f);await expect(region).toContainText('Blocked');await expect(region).toContainText('Overdue tasks');await expect(region).toContainText('Owner needed');await expect(region).toContainText('Start and end dates needed');
  const signal=region.getByRole('listitem').filter({has:page.getByText('Overdue tasks',{exact:true})}).last();await signal.getByRole('button',{name:'View sources',exact:true}).click();
  const sheet=page.getByRole('dialog',{name:'Records',exact:true});await expect(sheet).toContainText('Blocked work');await sheet.getByRole('button',{name:/Blocked work/}).click();await expect(page).toHaveURL(new RegExp('/boards/'+f.tasks+'/tasks/'+f.task+'$'));
  const back=await cockpit(page,f);await setOfflineForTest(page,context,true);await expect(back).toContainText('Offline device snapshot');await expect(back).toContainText('Unknown');await health(page,'Project cockpit offline',info);
  await setOfflineForTest(page,context,false);await expect(back.getByRole('button',{name:'Refresh health'})).toBeEnabled();await back.getByRole('button',{name:'Refresh health'}).click();await expect(back).toContainText('Blocked');await health(page,'Project cockpit recovered',info);
 }finally{if(!page.isClosed())await setOfflineForTest(page,context,false);await f.cleanup();}
});

test('Project cockpit: guarded offline owner/date changes and concurrent edit refusal',async({page,context},info)=>{
 const f=await seed(info);
 try{
  const region=await cockpit(page,f);await region.getByRole('button',{name:'Edit owner and dates',exact:true}).click();await page.getByRole('combobox',{name:'Project owner',exact:true}).selectOption(user);await page.getByLabel('Project start date',{exact:true}).fill('2026-10-01');await page.getByLabel('Project end date',{exact:true}).fill('2026-11-01');
  await setOfflineForTest(page,context,true);await expect(region).toContainText('Offline device snapshot');
  // Connection changes discard old read evidence and retain this account's unsaved edits.
  await expect(page.getByRole('combobox',{name:'Project owner',exact:true})).toHaveValue(user);await expect(page.getByLabel('Project end date',{exact:true})).toHaveValue('2026-11-01');await page.getByRole('button',{name:'Save project changes',exact:true}).press('Enter');await expect(page.getByRole('status').filter({hasText:'Project changes saved on this device'})).toBeVisible();expect((await readRecord(f.project)).data.p_f_owner).toBeNull();
  await setOfflineForTest(page,context,false);await expect.poll(async()=>(await readRecord(f.project)).data.p_f_owner).toBe(user);await expect.poll(async()=>(await readRecord(f.project)).data.p_f_end).toBe('2026-11-01');
  await region.getByRole('button',{name:'Edit owner and dates',exact:true}).click();await page.getByLabel('Project end date',{exact:true}).fill('2026-12-01');await request('/api/sync/push',{protocol:3,changes:[{id:f.project,collection:'tasks',patch:{p_f_end:'2026-11-15'},ts:Date.now()}]});
  await expect.poll(async()=>(await readAccountStore(page,'tasks',{id:f.project}))?.p_f_end).toBe('2026-11-15');
  // Explicitly refresh the health read, while the editor retains its baseline.
  await region.getByRole('button',{name:'Refresh health',exact:true}).click();await expect(region.getByRole('button',{name:'Refresh health',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Save project changes',exact:true}).click();await expect(page.getByRole('alert')).toHaveText('Project changed. Close and reopen this editor before saving.');expect((await readRecord(f.project)).data.p_f_end).toBe('2026-11-15');await health(page,'Project cockpit edit guard',info);
 }finally{if(!page.isClosed())await setOfflineForTest(page,context,false);await f.cleanup();}
});

test('Project cockpit: filter configuration, empty/error states and 200 percent reflow',async({page},info)=>{
 const f=await seed(info);
 try{
  const region=await cockpit(page,f);await page.getByRole('button',{name:'Configure Project health',exact:true}).press('Enter');await page.getByRole('button',{name:'Add project filter',exact:true}).click();await page.getByLabel('Filter value',{exact:true}).fill('no matching project');await page.keyboard.press('Escape');await expect(region).toContainText('No available projects match');await expect.poll(async()=>(await readRecord(f.block)).data.filters?.[0]?.value).toBe('no matching project');
  await page.getByRole('button',{name:'Configure Project health',exact:true}).click();await page.getByRole('button',{name:'Remove filter',exact:true}).click();await page.keyboard.press('Escape');await expect(region.getByText(f.title,{exact:true})).toBeVisible();await expect.poll(async()=>(await readRecord(f.block)).data.filters).toEqual([]);
  await page.route('**/api/project-health',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"disposable_outage"}'}));await region.getByRole('button',{name:'Refresh health',exact:true}).click();await expect(region).toContainText('Project sources could not be refreshed');await page.unroute('**/api/project-health');await region.getByRole('button',{name:'Refresh health',exact:true}).click();await expect(region.getByText(f.title,{exact:true})).toBeVisible();
  let reads=0;await page.route('**/api/project-health',route=>++reads===1?route.fulfill({status:409,contentType:'application/json',body:'{"error":"project_sources_changed"}'}):route.continue());await region.getByRole('button',{name:'Refresh health',exact:true}).click();await expect(region.getByText(f.title,{exact:true})).toBeVisible();await expect.poll(()=>reads).toBeGreaterThanOrEqual(2);await page.unroute('**/api/project-health');
  await expect.poll(async()=>(await readAccountStore(page,'outbox')).length).toBe(0);
  await expect(page.getByRole('link',{name:'Review work on this device',exact:true})).toHaveCount(0);
  await info.attach('project-cockpit-device-queue-metadata.json',{body:JSON.stringify({observedAt:await page.evaluate(()=>Date.now()),outbox:(await readAccountStore(page,'outbox')).map(({id,state,rejectReason,enqueuedAt,ts})=>({id,state,rejectReason,enqueuedAt,ts})),held:(await readAccountStore(page,'accessQuarantineInfo')).map(({id,reason})=>({id,reason}))}),contentType:'application/json'});
  await page.addStyleTag({content:'html{font-size:200%!important}'});const heading=page.getByRole('heading',{name:'Review cockpit',exact:true});const headingBounds=await heading.evaluate(el=>({scroll:el.scrollWidth,width:el.clientWidth}));expect(headingBounds.scroll,'Full cockpit heading remains readable at enlarged text').toBeLessThanOrEqual(headingBounds.width+1);const titleBounds=await region.getByRole('link',{name:f.title,exact:true}).evaluate(el=>({scroll:el.scrollWidth,width:el.clientWidth}));expect(titleBounds.scroll,'The full project title wraps inside its own card').toBeLessThanOrEqual(titleBounds.width+1);await region.getByRole('heading',{name:'Project health',exact:true}).evaluate(el=>el.scrollIntoView({block:'start'}));await region.getByRole('button',{name:'Refresh health',exact:true}).scrollIntoViewIfNeeded();await expect(region.getByRole('button',{name:'Refresh health',exact:true})).toBeInViewport({ratio:1});await health(page,'Project cockpit enlarged',info);await info.attach('project-cockpit-enlarged',{body:await page.screenshot(),contentType:'image/png'});await region.getByRole('button',{name:'Edit owner and dates',exact:true}).scrollIntoViewIfNeeded();await expect(region.getByRole('button',{name:'Edit owner and dates',exact:true})).toBeInViewport({ratio:1});await health(page,'Project cockpit enlarged actions',info);await info.attach('project-cockpit-enlarged-actions',{body:await page.screenshot(),contentType:'image/png'});
 }finally{await f.cleanup();}
});

test('Project cockpit: default current-record panel respects explicit hiding',async({page},info)=>{
 const f=await seed(info);
 try{
  await open(page,{id:'project-health-record',path:'/boards/'+f.board+'/tasks/'+f.project,ready:{role:'heading',name:'Project health'}});const region=page.getByRole('region',{name:'Project health',exact:true});await expect(region.getByText(f.title,{exact:true})).toBeVisible();await page.getByRole('button',{name:'Hide default health',exact:true}).click();await expect(region).toHaveCount(0);await expect.poll(async()=>(await readRecord('projecthealth:'+f.project))?.data.deleted).toBe(true);await reloadReady(page);await expect(page.getByRole('button',{name:'Hide default health',exact:true})).toHaveCount(0);
  await health(page,'Project cockpit hidden default',info);
 }finally{await f.cleanup();}
});

test('Project cockpit: customized current-record block persists without rewriting existing body text',async({page},info)=>{
 const f=await seed(info),text='Existing project notes stay here',body='body-'+f.project;
 try{
  await request('/api/sync/push',{protocol:3,changes:[{id:body,collection:'blocks',patch:{pageId:f.project,parentType:'record',type:'p',text,order:'a1'},ts:Date.now()}]});
  await open(page,{id:'project-health-record',path:'/boards/'+f.board+'/tasks/'+f.project,ready:{role:'heading',name:'Project health'}});await page.getByRole('button',{name:'Customize project health',exact:true}).click();await expect(page.getByRole('button',{name:'Customize project health',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Configure Project health',exact:true})).toBeVisible();await expect.poll(async()=>(await readRecord('projecthealth:'+f.project))?.data.projectId).toBe('self');expect((await readRecord(body)).data.text).toBe(text);
  await reloadReady(page);await expect(page.getByRole('region',{name:'Project health',exact:true})).toContainText(f.title);await expect(page.getByRole('button',{name:'Customize project health',exact:true})).toHaveCount(0);await health(page,'Project cockpit customized body',info);
 }finally{await request('/api/sync/push',{protocol:3,changes:[{id:body,collection:'blocks',patch:{deleted:true},ts:Date.now()}]});await f.cleanup();}
});
