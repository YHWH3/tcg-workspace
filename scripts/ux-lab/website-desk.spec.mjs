import {test,expect,open,health,request,readRecord,fixture,setOfflineForTest} from './support.mjs';
import {reloadReady} from '../navigation-ready.mjs';
const user=fixture.admin.user.id,board='board-website-inbox';
async function seed(info){
 const key=info.project.name.replaceAll('-','')+'-'+Date.now(),ids=['one','two','old'].map(n=>'response-'+n+'-'+key);
 const rows=ids.map((id,i)=>({id,collection:'tasks',patch:{boardId:board,title:'Synthetic response '+i+' café 日本語 العربية '+key,status:'new',assigneeId:null,createdAt:Date.now()-i*1000,p_wi_received:i===2?'2020-01-01':new Date().toISOString().slice(0,10),p_wi_family:'consulting',order:'a'+i}}));
 const result=await request('/api/sync/push',{protocol:3,changes:rows.map(r=>({...r,ts:Date.now()}))});expect(result.rejectedItems).toEqual([]);
 return {ids,rows,async cleanup(){await request('/api/sync/push',{protocol:3,changes:rows.map(r=>({id:r.id,collection:r.collection,patch:{deleted:true},ts:Date.now()}))});}};
}
async function desk(page){await open(page,{id:'website-response',path:'/website',ready:{role:'heading',name:'Website'}});return page.getByRole('region',{name:'Response desk',exact:true});}
function row(region,title){return region.getByRole('article').filter({hasText:title});}

test('Website response desk: offline assignment, guarded bulk undo and follow-up recovery',async({page,context},info)=>{
 const f=await seed(info);
 try{
  const region=await desk(page),first=row(region,f.rows[0].patch.title),second=row(region,f.rows[1].patch.title);
  await expect(first).toBeVisible();await first.getByRole('checkbox').check();await second.getByRole('checkbox').check();
  await region.getByRole('combobox',{name:'Bulk response owner',exact:true}).selectOption(user);
  await setOfflineForTest(page,context,true);
  await region.getByRole('button',{name:'Assign selected (2)',exact:true}).press('Enter');await expect(first).toHaveCount(0);await expect(region).toContainText('2 responses saved on this device');
  expect((await readRecord(f.ids[0]))?.data.assigneeId).toBeNull();
  await region.getByRole('button',{name:'Mine',exact:true}).click();await expect(first).toBeVisible();
  await region.getByRole('button',{name:'Undo last response changes',exact:true}).click();await expect(region).toContainText('2 response changes restored on this device');await expect(first).toHaveCount(0);
  await region.getByRole('button',{name:'Unassigned',exact:true}).click();await expect(first).toBeVisible();await first.getByRole('button',{name:'Assign to me',exact:true}).click();
  await setOfflineForTest(page,context,false);await expect.poll(async()=>(await readRecord(f.ids[0]))?.data.assigneeId).toBe(user);await expect.poll(async()=>(await readRecord(f.ids[1]))?.data.assigneeId).toBeNull();
  await region.getByRole('button',{name:'Mine',exact:true}).click();await first.getByText('Owner, follow-up and reply draft',{exact:true}).click();await first.getByLabel('Response follow-up date',{exact:true}).fill('2020-01-01');await first.getByRole('button',{name:'Save follow-up',exact:true}).click();
  await expect.poll(async()=>(await readRecord(f.ids[0]))?.data.dueDate).toBe('2020-01-01');
  await region.getByRole('button',{name:'Follow-up due',exact:true}).click();await expect(first).toBeVisible();
  await health(page,'Website response follow-up',info);await info.attach('website-response-followup',{body:await page.screenshot(),contentType:'image/png'});
  await reloadReady(page);await region.getByRole('button',{name:'Mine',exact:true}).click();await expect(first).toContainText('2020-01-01');
  await first.getByRole('button',{name:'Mark replied',exact:true}).click();await expect.poll(async()=>(await readRecord(f.ids[0]))?.data.status).toBe('replied');await expect.poll(async()=>(await readRecord(f.ids[0]))?.data.p_wi_replied,{timeout:30_000}).toMatch(/^\d{4}-\d{2}-\d{2}$/);await expect(first).toHaveCount(0);
 }finally{await setOfflineForTest(page,context,false);await f.cleanup();}
});

test('Website response desk: bands, full answers, copy-only draft and enlarged text',async({page,context},info)=>{
 const f=await seed(info);
 try{
  const region=await desk(page),old=row(region,f.rows[2].patch.title);
  await region.getByRole('button',{name:/^8\+ days:/}).focus();await page.keyboard.press('Enter');await expect(old).toBeVisible();await expect(row(region,f.rows[0].patch.title)).toHaveCount(0);
  await region.getByRole('combobox',{name:'Response form family',exact:true}).selectOption('join');await expect(region).toContainText('No open submissions in this queue.');await region.getByRole('combobox',{name:'Response form family',exact:true}).selectOption('consulting');await expect(old).toBeVisible();
  await old.getByText('Owner, follow-up and reply draft',{exact:true}).click();await old.getByRole('textbox',{name:'Reply draft',exact:true}).fill('Synthetic reply only. <script>window.__SENT=true</script>');
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(new Error('Disposable denied clipboard fixture'))}}));await old.getByRole('button',{name:'Copy draft',exact:true}).click();await expect(old).toContainText('Select the draft text and copy');
  expect((await readRecord(f.ids[2]))?.data.status).toBe('new');expect(await page.evaluate(()=>window.__SENT)).toBeUndefined();
  await page.addStyleTag({content:'html{font-size:200%!important}'});await old.scrollIntoViewIfNeeded();
  const ownerCaption=await old.getByRole('combobox',{name:'Response owner',exact:true}).evaluate(el=>{const css=getComputedStyle(el),probe=document.createElement('span');Object.assign(probe.style,{position:'fixed',visibility:'hidden',whiteSpace:'pre',font:css.font,letterSpacing:css.letterSpacing});probe.textContent=el.selectedOptions[0].label;document.body.append(probe);const textWidth=probe.getBoundingClientRect().width;probe.remove();return {textWidth,available:el.clientWidth-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight)};});expect(ownerCaption.available,'Unassigned caption must fit at enlarged text size').toBeGreaterThanOrEqual(ownerCaption.textWidth);
  await health(page,'Website response enlarged',info);await info.attach('website-response-enlarged',{body:await page.screenshot(),contentType:'image/png'});
  await old.getByRole('link',{name:'Open answers',exact:true}).click();await expect(page.getByRole('textbox',{name:'submission title',exact:true})).toHaveValue(f.rows[2].patch.title);await health(page,'Website response answers enlarged',info);const bounds=await page.locator('.ws-record-properties').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));expect(bounds.scroll).toBeLessThanOrEqual(bounds.width+1);await info.attach('website-response-answers',{body:await page.screenshot(),contentType:'image/png'});
 }finally{await setOfflineForTest(page,context,false);await f.cleanup();}
});


test('Website response desk: status gates and changed-field undo remain guarded',async({page},info)=>{
 const f=await seed(info),before=(await readRecord(board)).data;
 try{
  await request('/api/sync/push',{protocol:3,changes:[{id:board,collection:'boards',patch:{approvalGate:{stageId:'done'}},ts:Date.now()}]});
  const region=await desk(page),first=row(region,f.rows[0].patch.title);
  await expect(first).toBeVisible();await first.getByRole('button',{name:'Assign to me',exact:true}).click();await expect.poll(async()=>(await readRecord(f.ids[0]))?.data.assigneeId).toBe(user);
  const changed=await request('/api/sync/push',{protocol:3,changes:[{id:f.ids[0],collection:'tasks',patch:{assigneeId:null},ts:Date.now()+30_000}]});expect(changed.rejectedItems).toEqual([]);await expect.poll(async()=>(await readRecord(f.ids[0]))?.data.assigneeId).toBeNull();
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await region.getByRole('button',{name:'All open',exact:true}).click();await expect(first).toContainText('Owner: Unassigned');
  await region.getByRole('button',{name:'Undo last response changes',exact:true}).click();await expect(region.getByRole('alert')).toContainText('could not be restored');expect((await readRecord(f.ids[0]))?.data.assigneeId).toBeNull();
  await first.getByRole('button',{name:'Done',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Approval required',exact:true});await expect(dialog).toBeVisible();await health(page,'Website response gated completion',info);expect((await readRecord(f.ids[0]))?.data.status).toBe('new');await page.keyboard.press('Escape');await expect(dialog).toBeHidden();
 }finally{await request('/api/sync/push',{protocol:3,changes:[{id:board,collection:'boards',patch:{approvalGate:before.approvalGate??null},ts:Date.now()}]});await f.cleanup();}
});
