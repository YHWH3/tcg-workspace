import {test,expect,open,health,request,setOfflineForTest} from './support.mjs';
import {surfaces} from './catalog.mjs';
import {readAccountStore} from '../certification/browser-db.mjs';

test('workspace locale: settings validation, currency metric and offline cache',async({page,context},info)=>{
 const initial=await request('/api/workspace/settings',undefined,'GET');
 const pageId='locale-page-'+info.project.name,boardId='locale-money-'+info.project.name;
 try{
  await open(page,surfaces.find(s=>s.id==='settings'));
  const workspace=page.locator('section').filter({has:page.getByRole('heading',{name:'Workspace',exact:true})});
  const zone=workspace.getByRole('combobox',{name:'Timezone',exact:true}),currency=workspace.getByRole('combobox',{name:'Currency',exact:true});
  await expect(zone).toBeEnabled();await zone.fill('Invalid/Zone');await currency.fill('XYZ');
  await expect(workspace.getByRole('alert')).toContainText('valid timezone');await expect(workspace.getByRole('button',{name:'Save workspace settings'})).toBeDisabled();
  await zone.fill('Asia/Kolkata');await currency.fill('INR');
  const week=workspace.getByRole('combobox',{name:'Week starts on',exact:true});await week.focus();await week.pressSequentially('Sunday',{delay:30});await week.press('Tab');await expect(week).toHaveValue('0');
  const save=workspace.getByRole('button',{name:'Save workspace settings'});await save.focus();await save.press('Enter');
  await expect(workspace.getByRole('status').filter({hasText:'Workspace settings saved.'})).toBeVisible();
  const expected=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',weekday:'long',day:'numeric',month:'long',year:'numeric'}).format(Date.now());
  await expect(workspace.getByTestId('workspace-date-preview')).toContainText(expected);await health(page,'workspace settings',info);
  await info.attach('workspace settings',{body:await page.screenshot(),contentType:'image/png'});
  await expect.poll(async()=>(await readAccountStore(page,'meta',{id:'workspaceSettings'}))?.value?.settings?.timeZone).toBe('Asia/Kolkata');
  await setOfflineForTest(page,context,true);await expect(workspace.getByRole('status').filter({hasText:'Cached settings remain'})).toBeVisible();await expect(zone).toHaveValue('Asia/Kolkata');await setOfflineForTest(page,context,false);
  await request('/api/sync/push',{protocol:3,changes:[
   {id:boardId,collection:'boards',ts:Date.now(),patch:{name:'Locale money',kind:'records',columns:[{id:'open',name:'Open'},{id:'done',name:'Done'}],fields:[{id:'amount',name:'Amount',type:'number',format:'currency'},{id:'usd',name:'Dollars',type:'number',format:'currency',currency:'USD'}]}},
   {id:pageId,collection:'pages',ts:Date.now(),patch:{title:'Locale dashboard',order:'z0'}},
   {id:pageId+'-metric',collection:'blocks',ts:Date.now(),patch:{pageId,type:'metric',databaseId:boardId,agg:'sum',fieldKey:'p_amount',format:'currency',label:'Local amount',order:'a0'}},
   {id:pageId+'-usd',collection:'blocks',ts:Date.now(),patch:{pageId,type:'metric',databaseId:boardId,agg:'sum',fieldKey:'p_usd',format:'currency',label:'Explicit dollars',order:'a1'}},
   {id:pageId+'-record',collection:'tasks',ts:Date.now(),patch:{boardId,title:'Synthetic amount',status:'open',p_amount:1234.5,p_usd:50,order:'a0'}},
  ]});
  await open(page,{id:'locale-money-table',path:'/boards/'+boardId,ready:{role:'heading',name:'🗃️ Locale money'}});
  await page.getByRole('button',{name:'Database menu',exact:true}).click();await page.getByRole('button',{name:'Fields…',exact:true}).click();
  const format=page.getByRole('combobox',{name:'Amount number format',exact:true});await expect(format).toHaveValue('currency');
  const override=page.getByRole('textbox',{name:'Amount currency override',exact:true});
  const amountField=async()=>(await readAccountStore(page,'boards',{id:boardId})).fields.find(f=>f.id==='amount');
  await override.fill('XYZ');await override.press('Tab');await expect(override).toHaveAttribute('aria-invalid','true');expect((await amountField()).currency).toBeUndefined();
  await override.fill('USD');await override.press('Tab');await expect.poll(async()=>(await amountField()).currency).toBe('USD');
  await override.fill('');await override.press('Tab');await expect.poll(async()=>(await amountField()).currency).toBeUndefined();
  const newName=page.getByRole('textbox',{name:'New field name',exact:true});await newName.scrollIntoViewIfNeeded();
  const placeholder=await newName.evaluate(el=>{const s=getComputedStyle(el),canvas=document.createElement('canvas'),context=canvas.getContext('2d');context.font=s.font;return {available:el.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight),required:context.measureText(el.placeholder).width};});
  expect(placeholder.available,'New field name placeholder must fit').toBeGreaterThanOrEqual(placeholder.required);
  await newName.fill('New amount');const newType=page.getByRole('combobox',{name:'New field type',exact:true});await newType.focus();await newType.pressSequentially('Number',{delay:30});await newType.press('Tab');await expect(newType).toHaveValue('number');
  const addField=page.getByRole('button',{name:'Add field',exact:true});if(info.project.use.viewport.width<640){const box=await addField.boundingBox();expect(box.width).toBeGreaterThanOrEqual(44);expect(box.height).toBeGreaterThanOrEqual(44);}
  if(info.project.use.hasTouch)await addField.tap();else{await addField.focus();await addField.press('Enter');}
  await expect(newName).toHaveValue('');await expect.poll(async()=>(await readAccountStore(page,'boards',{id:boardId})).fields.find(f=>f.name==='New amount')?.type).toBe('number');
  await health(page,'currency field editor',info);await info.attach('currency field editor',{body:await page.screenshot(),contentType:'image/png'});await page.keyboard.press('Escape');
  await expect(page.getByText('₹1,234.50',{exact:true})).toBeVisible();
  await open(page,{id:'locale-dashboard',path:'/pages/'+pageId,ready:{placeholder:'Untitled'}});
  const metric=page.getByRole('button',{name:/₹1,234.50 Local amount/});await expect(metric).toBeVisible();await expect(metric).toContainText('INR, workspace default');await expect(page.getByRole('button',{name:/\$50.00 Explicit dollars/})).toContainText('USD, field currency');await health(page,'workspace money metric',info);
  await info.attach('workspace money metric',{body:await page.screenshot(),contentType:'image/png'});
 }finally{
  await setOfflineForTest(page,context,false);
  const current=await request('/api/workspace/settings',undefined,'GET');await request('/api/workspace/settings',{...initial.settings,version:current.settings.version},'PUT');
  await request('/api/sync/push',{protocol:3,changes:[boardId,pageId,pageId+'-metric',pageId+'-usd',pageId+'-record'].map(id=>({id,collection:id===boardId?'boards':id===pageId?'pages':(id.endsWith('-metric')||id.endsWith('-usd'))?'blocks':'tasks',ts:Date.now()+10,patch:{deleted:true}}))});
 }
});
