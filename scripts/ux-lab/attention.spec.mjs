import {test,expect,open,health,request,readRecord,fixture,setOfflineForTest} from './support.mjs';
import {reloadReady} from '../navigation-ready.mjs';
const user=fixture.admin.user.id;
async function seed(info,{gate=false}={}){
 const suffix=info.project.name.replaceAll('-','')+'-'+Date.now(),board='att-b-'+suffix,pageId='att-p-'+suffix,record='att-r-'+suffix,unassigned='att-u-'+suffix;
 const rows=[
  {id:board,collection:'boards',patch:{name:'Attention workflow '+suffix,kind:'tasks',columns:[{id:'todo',name:'To do'},{id:'done',name:'Done'}],fields:[{id:'owner',name:'Owner',type:'person'},{id:'date',name:'Response date',type:'date'}],attention:{enabled:true,personKey:'assigneeId',dateKey:'dueDate',triage:true},...(gate?{approvalGate:{stageId:'done'}}:{})}},
  {id:record,collection:'tasks',patch:{boardId:board,title:'Respond to café 日本語 العربية 👩🏽‍💻 '+suffix,status:'todo',assigneeId:user,dueDate:'2020-01-01',order:'a0'}},
  {id:unassigned,collection:'tasks',patch:{boardId:board,title:'Triage request '+suffix,status:'todo',assigneeId:null,order:'a1'}},
  {id:pageId,collection:'pages',patch:{title:'Attention test '+suffix,order:'a0'}},
  {id:'att-block-'+suffix,collection:'blocks',patch:{pageId,type:'attention',heading:'Daily attention',limit:20,order:'a0'}},
 ];
 expect((await request('/api/sync/push',{protocol:3,changes:rows.map(r=>({...r,ts:Date.now()}))})).rejectedItems).toEqual([]);
 return {board,pageId,record,unassigned,rows,title:rows[1].patch.title,triageTitle:rows[2].patch.title};
}
async function cleanup(f){await request('/api/sync/push',{protocol:3,changes:f.rows.map(r=>({id:r.id,collection:r.collection,patch:{deleted:true},ts:Date.now()}))});}
async function queue(page,f){await open(page,{id:'attention-block',path:'/pages/'+f.pageId,ready:{role:'heading',name:'Needs attention'}});const region=page.getByRole('region',{name:'Needs attention',exact:true});await expect(region.getByText(f.title,{exact:true})).toBeVisible();return region;}

test('attention: ranked block, keyboard completion, offline assignment and reconnect',async({page,context},info)=>{
 const f=await seed(info);
 try{
  const region=await queue(page,f),row=region.getByRole('listitem').filter({hasText:f.title});
  await expect(row).toContainText('Overdue');await health(page,'attention populated',info);
  await info.attach('attention-populated',{body:await page.screenshot(),contentType:'image/png'});
  const done=row.getByRole('button',{name:'Mark done',exact:true});await done.focus();await done.press('Enter');
  await expect.poll(async()=>(await readRecord(f.record))?.data.status).toBe('done');
  const refresh=region.getByRole('button',{name:'Refresh',exact:true});await expect(refresh).toBeEnabled();await refresh.click();await expect(region.getByText(f.title,{exact:true})).toHaveCount(0);
  await setOfflineForTest(page,context,true);await expect(region).toContainText('(offline)');
  const triage=region.getByRole('listitem').filter({hasText:f.triageTitle});await triage.getByRole('button',{name:'Assign to me',exact:true}).click();
  await expect(region).toContainText('Saved on this device. Sync will confirm the server change.');
  expect((await readRecord(f.unassigned))?.data.assigneeId).toBeNull();await health(page,'attention offline',info);
  await info.attach('attention-offline',{body:await page.screenshot(),contentType:'image/png'});
  await setOfflineForTest(page,context,false);await expect.poll(async()=>(await readRecord(f.unassigned))?.data.assigneeId).toBe(user);
  await expect(refresh).toBeEnabled();await refresh.click();await expect(region.getByText(f.triageTitle,{exact:true})).toHaveCount(0);
  await expect(region).toContainText('No items in this snapshot need your attention');await health(page,'attention recovered',info);
 }finally{await setOfflineForTest(page,context,false);await cleanup(f);}
});

test('attention: configuration, source filters, 200 percent text and recovery',async({page,context},info)=>{
 const f=await seed(info);
 try{
  await queue(page,f);
  const config=page.getByRole('button',{name:'Configure Attention',exact:true});await config.focus();await config.press('Enter');
  const limit=page.getByRole('combobox',{name:'Attention item limit',exact:true});await expect(limit).toBeVisible();await limit.selectOption('5');
  await page.getByRole('combobox',{name:'Attention density',exact:true}).selectOption('compact');
  await page.getByRole('checkbox',{name:'Overdue',exact:true}).check();await page.keyboard.press('Escape');
  const region=page.getByRole('region',{name:'Needs attention',exact:true});await expect(region.getByText(f.triageTitle,{exact:true})).toHaveCount(0);
  await page.addStyleTag({content:'html{font-size:200%!important}'});await health(page,'attention enlarged',info);await info.attach('attention-enlarged',{body:await page.screenshot(),contentType:'image/png'});
  await reloadReady(page);await expect(region.getByText(f.title,{exact:true})).toBeVisible();
  await open(page,{id:'attention-settings',path:'/boards/'+f.board,ready:{role:'heading',name:'🗂️ Attention workflow '+f.board.slice('att-b-'.length)}});
  const menu=page.getByRole('button',{name:'Board menu',exact:true});await menu.focus();await menu.press('Enter');await page.getByRole('button',{name:'Attention',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Attention settings',exact:true});await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox',{name:'Attention person field',exact:true}).selectOption('p_owner');await dialog.getByRole('combobox',{name:'Attention date field',exact:true}).selectOption('p_date');await dialog.getByRole('spinbutton',{name:'Upcoming window (days)',exact:true}).fill('7');
  await health(page,'attention settings',info);await info.attach('attention-settings',{body:await page.screenshot(),contentType:'image/png'});
  await dialog.getByRole('button',{name:'Save attention settings',exact:true}).click();await expect(dialog).toContainText('Saved on this device');
  await expect.poll(async()=>(await readRecord(f.board))?.data.attention).toMatchObject({personKey:'p_owner',dateKey:'p_date',soonDays:7});
  await page.keyboard.press('Escape');await expect(dialog).toBeHidden();
  const region2=await queueAfterChange(page,f);await expect(region2).toContainText('No items in this snapshot need your attention');
  await context.route('**/api/attention?*',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"synthetic_outage"}'}));await region2.getByRole('button',{name:'Refresh',exact:true}).click();await expect(region2).toContainText('Attention could not refresh');await expect(region2).toContainText('(saved snapshot)');
  await context.unroute('**/api/attention?*');await region2.getByRole('button',{name:'Refresh',exact:true}).click();await expect(region2.getByRole('alert')).toHaveCount(0);await health(page,'attention failure recovered',info);
 }finally{await context.unroute('**/api/attention?*');await cleanup(f);}
});
async function queueAfterChange(page,f){await open(page,{id:'attention-empty',path:'/pages/'+f.pageId,ready:{role:'heading',name:'Needs attention'}});const region=page.getByRole('region',{name:'Needs attention',exact:true});await expect(region.getByText(/As of/)).toBeVisible();return region;}

test('attention: completion opens the existing approval request flow',async({page},info)=>{
 const f=await seed(info,{gate:true});
 try{
  const region=await queue(page,f);await region.getByRole('listitem').filter({hasText:f.title}).getByRole('button',{name:'Mark done',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Approval required',exact:true});await expect(dialog).toBeVisible();await expect(dialog.getByRole('combobox')).toBeVisible();
  await health(page,'attention gated completion',info);await info.attach('attention-approval-fixture',{body:await page.screenshot(),contentType:'image/png'});
  expect((await readRecord(f.record))?.data.status).toBe('todo');
  await page.keyboard.press('Escape');await expect(dialog).toBeHidden();
 }finally{await cleanup(f);}
});
