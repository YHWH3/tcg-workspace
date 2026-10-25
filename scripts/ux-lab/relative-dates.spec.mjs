import {test,expect,open,health,request} from './support.mjs';
import {readAccountStore} from '../certification/browser-db.mjs';
import {surfaces} from './catalog.mjs';

async function readableDateSelectors(page,names){
  for(const name of names){
    const measured=await page.getByRole('combobox',{name,exact:true}).evaluate(el=>{
      const style=getComputedStyle(el),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');ctx.font=style.font;
      return {text:el.selectedOptions[0].text,width:ctx.measureText(el.selectedOptions[0].text).width,available:el.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)-20};
    });
    expect(measured.width,name+' selected caption: '+measured.text).toBeLessThanOrEqual(measured.available);
  }
}

test('relative dates: filter and automation hints with bounded results',async({page},info)=>{
  const suffix=info.project.name,viewId='ux-relative-'+suffix,automationId='ux-relative-auto-'+suffix;
  await request('/api/sync/push',{protocol:3,changes:[
    {id:viewId,collection:'views',ts:Date.now(),patch:{databaseId:'ux-records',name:'Relative '+suffix,type:'table',config:{filters:[{key:'p_date',op:'before',value:'today+30'}],visible:['title','p_date']},order:'z0'}},
    {id:automationId,collection:'automations',ts:Date.now(),patch:{databaseId:'ux-records',name:'Relative automation '+suffix,enabled:false,trigger:{kind:'record.created'},conditions:[{key:'p_date',op:'on_or_before',value:'today+30'}],actions:[{type:'set_field',fieldKey:'title',value:'Matched'}]}}
  ]});
  try{
    await open(page,{...surfaces.find(s=>s.id==='records-table'),path:'/boards/ux-records/views/'+viewId});
    const trigger=page.getByRole('toolbar',{name:'View controls',exact:true}).getByRole('button',{name:'Filter · 1',exact:true});
    await trigger.focus();await trigger.press('Enter');
    const input=page.getByRole('spinbutton',{name:'Filter days',exact:true});
    await expect(input).toHaveValue('30');
    await expect(input).toHaveAccessibleDescription(/0 to 3650/);
    await expect(page.getByRole('combobox',{name:'Filter date mode',exact:true})).toHaveValue('relative');
    await readableDateSelectors(page,['Filter field','Filter operator']);
    await keyboardSelect(page.getByRole('combobox',{name:'Filter relative day',exact:true}),'past');
    await input.focus();await input.fill('7');await input.press('Tab');
    await health(page,'relative date filter',info);
    await info.attach('relative date filter',{body:await page.screenshot(),contentType:'image/png'});
    await page.keyboard.press('Escape');await expect(input).toBeHidden();await expect(trigger).toBeFocused();
    await expect(page.getByText('No records',{exact:true})).toBeVisible();
    await open(page,{id:'relative-automation',path:'/automations/ux-records',ready:{role:'heading',name:/Automations/}});
    const condition=page.getByRole('spinbutton',{name:'Condition days',exact:true});
    await expect(condition).toHaveCount(1);await expect(condition).toHaveValue('30');
    await expect(condition).toHaveAccessibleDescription(/0 to 3650/);
    await readableDateSelectors(page,['Condition field','Condition operator']);
    await keyboardSelect(page.getByRole('combobox',{name:'Condition relative day',exact:true}),'past');
    await condition.focus();await condition.fill('7');await condition.press('Tab');
    await health(page,'relative automation condition',info);
    await info.attach('relative automation condition',{body:await page.screenshot(),contentType:'image/png'});
  }finally{
    await request('/api/sync/push',{protocol:3,changes:[{id:automationId,collection:'automations',ts:Date.now()+10,patch:{deleted:true}}]});
  }
});

async function keyboardSelect(locator,value){
  const label=await locator.evaluate((el,value)=>[...el.options].find(o=>o.value===value)?.text??null,value);
  expect(label).not.toBeNull();await locator.focus();await locator.pressSequentially(label,{delay:30});await locator.press('Tab');
  await expect(locator).toHaveValue(value);
}

// Actual keyboard and touch UI creation; inspect durable state rather than count
// only the controls that rendered. Each project owns its created view/records.
test('date ranges: keyboard creation, touch presets, validation and reload',async({page},info)=>{
  const suffix=info.project.name,recordId='ux-range-'+suffix;
  const today=new Date().toISOString().slice(0,10),far=new Date(Date.parse(today+'T00:00Z')+90*86400000).toISOString().slice(0,10);
  let viewId;
  await request('/api/sync/push',{protocol:3,changes:[{id:recordId,collection:'tasks',ts:Date.now(),patch:{boardId:'ux-records',title:'Far deadline '+suffix,status:'todo',p_date:far,order:'z0'}}]});
  try{
    await open(page,surfaces.find(s=>s.id==='records-table'));
    const newView=page.getByRole('button',{name:'New view',exact:true});await newView.focus();await newView.press('Enter');
    const table=page.getByRole('button',{name:'Table',exact:true});await table.focus();await table.press('Enter');
    await expect(page).not.toHaveURL(/views\/ux-table$/);viewId=new URL(page.url()).pathname.split('/').at(-1);
    const filter=page.getByRole('toolbar',{name:'View controls',exact:true}).getByRole('button',{name:'Filter',exact:true});await filter.focus();await filter.press('Enter');
    const add=page.getByRole('button',{name:'Add filter',exact:true});await add.focus();await add.press('Enter');
    await keyboardSelect(page.getByRole('combobox',{name:'Filter field',exact:true}),'p_date');
    await keyboardSelect(page.getByRole('combobox',{name:'Filter operator',exact:true}),'within');
    const preset=page.getByRole('group',{name:'Filter date presets',exact:true});const next30=preset.getByRole('button',{name:'Next 30 days',exact:true});
    await next30.focus();await next30.press('Enter');await expect(next30).toHaveAttribute('aria-pressed','true');
    const value=async()=>(await readAccountStore(page,'views',{id:viewId}))?.config?.filters?.[0];
    await expect.poll(value).toEqual({key:'p_date',op:'within',value:{from:'today',to:'today+30'}});
    await health(page,'keyboard date range',info);await info.attach('keyboard date range',{body:await page.screenshot(),contentType:'image/png'});
    const days=page.getByRole('spinbutton',{name:'Filter to days',exact:true});await days.fill('3651');await days.press('Tab');
    await expect(days).toHaveAttribute('aria-invalid','true');await expect(page.getByText('Enter a whole number from 0 to 3650.',{exact:true})).toBeVisible();
    expect((await value()).value.to).toBe('today+30');await days.fill('7');await days.press('Tab');await expect.poll(async()=>(await value()).value.to).toBe('today+7');
    await page.keyboard.press('Escape');await expect(preset).toBeHidden();
    await expect(page.getByText('Far deadline '+suffix,{exact:true})).toHaveCount(0);
    await page.reload();await page.getByRole('toolbar',{name:'View controls',exact:true}).waitFor();
    const reopen=page.getByRole('button',{name:'Filter · 1',exact:true});
    if(info.project.use.hasTouch)await reopen.tap();else {await reopen.focus();await reopen.press('Enter');}
    await expect(page.getByRole('spinbutton',{name:'Filter to days',exact:true})).toHaveValue('7');
    const last30=page.getByRole('group',{name:'Filter date presets',exact:true}).getByRole('button',{name:'Last 30 days',exact:true});
    if(info.project.use.hasTouch)await last30.tap();else {await last30.focus();await last30.press('Enter');}
    await expect.poll(async()=>(await value()).value).toEqual({from:'today-30',to:'today'});
    await health(page,'date range recovery',info);
    const addAnother=page.getByRole('button',{name:'Add filter',exact:true});
    await addAnother.scrollIntoViewIfNeeded();
    if(info.project.use.hasTouch)await addAnother.tap();else {await addAnother.focus();await addAnother.press('Enter');}
    await expect(page.getByRole('combobox',{name:'Filter field',exact:true})).toHaveCount(2);
    if(info.project.use.hasTouch)await expect(page.getByRole('dialog',{name:'Filters',exact:true})).toBeVisible();
  }finally{
    await request('/api/sync/push',{protocol:3,changes:[{id:recordId,collection:'tasks',ts:Date.now()+10,patch:{deleted:true}},...(viewId?[{id:viewId,collection:'views',ts:Date.now()+10,patch:{deleted:true}}]:[])]});
  }
});
