import {test,expect,open,health,request} from './support.mjs';
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
    const input=page.getByRole('textbox',{name:'Filter value',exact:true});
    await expect(input).toHaveValue('today+30');
    await expect(input).toHaveAttribute('placeholder','yyyy-mm-dd or today±N');
    await expect(input).toHaveAccessibleDescription(/today\+30.*0 to 3650/);
    await readableDateSelectors(page,['Filter field','Filter operator']);
    await input.focus();await input.fill('today-7');
    await health(page,'relative date filter',info);
    await info.attach('relative date filter',{body:await page.screenshot(),contentType:'image/png'});
    await page.keyboard.press('Escape');await expect(input).toBeHidden();await expect(trigger).toBeFocused();
    await expect(page.getByText('No records',{exact:true})).toBeVisible();
    await open(page,{id:'relative-automation',path:'/automations/ux-records',ready:{role:'heading',name:/Automations/}});
    const condition=page.getByRole('textbox',{name:'Condition value',exact:true});
    await expect(condition).toHaveCount(1);await expect(condition).toHaveValue('today+30');
    await expect(condition).toHaveAttribute('placeholder','yyyy-mm-dd or today±N');
    await expect(condition).toHaveAccessibleDescription(/today\+30.*0 to 3650/);
    await readableDateSelectors(page,['Condition field','Condition operator']);
    await condition.focus();await condition.fill('today-7');await condition.press('Tab');
    await health(page,'relative automation condition',info);
    await info.attach('relative automation condition',{body:await page.screenshot(),contentType:'image/png'});
  }finally{
    await request('/api/sync/push',{protocol:3,changes:[{id:automationId,collection:'automations',ts:Date.now()+10,patch:{deleted:true}}]});
  }
});
