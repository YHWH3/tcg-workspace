import {readFileSync} from 'node:fs';
import {test,expect,open,health,request,readRecord,fixture,setOfflineForTest} from './support.mjs';
import {readAccountStore} from '../certification/browser-db.mjs';
const pack=JSON.parse(readFileSync(new URL('../../templates/tcg-pack.json',import.meta.url),'utf8'));
async function seed(info){
 const key=info.project.name.replaceAll('-','')+'-'+Date.now(),events='ce-'+key,people='cp-'+key,pageId='cd-'+key,block='cb-'+key,event='cr-'+key,person='cm-'+key,missing='cu-'+key,past='cx-'+key,attention='ca-'+key;
 const peopleSource=pack.databases.find(board=>board.id==='db_people'),personFields=peopleSource.fields.filter(field=>field.type!=='relation'),fields=[{id:'f_start',name:'Start date',type:'date'},{id:'f_capacity',name:'Capacity',type:'number'},...['facilitators','volunteers','participants'].map(role=>({id:'f_'+role,name:role[0].toUpperCase()+role.slice(1),type:'relation',relation:{target:people,primary:true}}))];
 const title='Community café 日本語 العربية 👩🏽‍💻 '+key,personTitle='Participant '+key,rows=[
  {id:events,collection:'boards',patch:{kind:'records',name:'Events '+key,templateDbKey:'events',columns:[{id:'planned',name:'Planned'},{id:'done',name:'Done'},{id:'reviewed',name:'Reviewed'}],fields}},
  {id:people,collection:'boards',patch:{kind:'records',name:'People '+key,columns:peopleSource.columns,fields:personFields,attention:peopleSource.attention}},
  {id:event,collection:'tasks',patch:{boardId:events,title,p_f_start:'2099-01-01',p_f_capacity:0,status:'planned'}},
  {id:missing,collection:'tasks',patch:{boardId:events,title:'Event needs date '+key,status:'planned'}},
  {id:past,collection:'tasks',patch:{boardId:events,title:'Past Event '+key,p_f_start:'2020-01-01',status:'planned'}},
  {id:person,collection:'tasks',patch:{boardId:people,title:personTitle,p_f_membership:['member','volunteer']}},
  ...['participants','facilitators'].map(role=>({id:event+'-'+role,collection:'links',patch:{kind:'relation',fieldId:'f_'+role,fromType:'record',toType:'record',fromId:event,toId:person,createdAt:Date.now()}})),
  {id:pageId,collection:'pages',patch:{title:'Community desk '+key,order:'a0'}},
  {id:block,collection:'blocks',patch:{pageId,type:'eventops',databaseId:events,heading:'Event relationship coverage',order:'a0'}},
  {id:attention,collection:'blocks',patch:{pageId,type:'attention',heading:'Conversation attention',limit:20,order:'a3'}},
  ...['member','volunteer'].flatMap((membership,index)=>{const viewId='cv-'+membership+'-'+key,source=peopleSource.views.find(view=>view.id==='v_people_relationship_'+membership);return [{id:viewId,collection:'views',patch:{databaseId:people,name:source.name,type:source.type,config:source.config,order:'a'+index}},{id:'cw-'+membership+'-'+key,collection:'blocks',patch:{pageId,type:'view',databaseId:people,viewId,heading:source.name,order:'a'+(index+1)}}];}),
 ];
 expect((await request('/api/sync/push',{protocol:3,changes:rows.map(row=>({...row,ts:Date.now()}))})).rejectedItems).toEqual([]);
 return {key,events,people,pageId,block,event,person,missing,past,title,personTitle,async cleanup(){await request('/api/sync/push',{protocol:3,changes:rows.map(row=>({id:row.id,collection:row.collection,patch:{deleted:true},ts:Date.now()}))});}};
}
async function desk(page,f){await open(page,{id:'community-desk',path:'/pages/'+f.pageId,ready:{role:'heading',name:'Event relationship coverage',exact:true}});const region=page.getByRole('region',{name:'Event roles and participants',exact:true});await expect(region.getByRole('link',{name:f.title,exact:true})).toBeVisible();return region;}
test('Community desk: role coverage, participant sources and intentional field correction',async({page},info)=>{
 const f=await seed(info);
 try{
  let region=await desk(page,f);await expect(region).toContainText('Capacity: 0. Participants: 1. 1 above capacity.');await expect(region).toContainText('not submission receipts or attendance proof');await expect(region.getByRole('link',{name:f.personTitle,exact:true})).toHaveAttribute('href','/boards/'+f.people+'/tasks/'+f.person);await expect(region.getByRole('link',{name:'Past Event '+f.key,exact:true})).toHaveCount(0);
  await region.getByRole('link',{name:'Review capacity',exact:true}).press('Enter');const capacity=page.locator('.ws-record-detail').getByRole('spinbutton',{name:'Capacity',exact:true});await expect(capacity).toBeFocused();await capacity.fill('2');await capacity.press('Tab');await expect.poll(async()=>(await readRecord(f.event)).data.p_f_capacity).toBe(2);
  region=await desk(page,f);await expect(region).toContainText('Capacity: 2. Participants: 1. 1 place remaining.');await region.getByRole('link',{name:'Event needs date '+f.key+': review start date',exact:true}).press('Enter');await expect(page.getByLabel('Start date',{exact:true})).toBeFocused();await page.getByLabel('Start date',{exact:true}).fill('2099-02-01');await page.getByLabel('Start date',{exact:true}).press('Tab');await expect.poll(async()=>(await readRecord(f.missing)).data.p_f_start).toBe('2099-02-01');
  region=await desk(page,f);await expect(region).not.toContainText('Events needing a start date');await expect(region.getByRole('link',{name:'Event needs date '+f.key,exact:true})).toBeVisible();await health(page,'Community corrected Event',info);await info.attach('community-role-coverage',{body:await page.screenshot(),contentType:'image/png'});
 }finally{await f.cleanup();}
});
test('Community desk: deleted People, selected Events and configuration recovery',async({page},info)=>{
 const f=await seed(info);
 try{
  const region=await desk(page,f);await request('/api/sync/push',{protocol:3,changes:[{id:f.person,collection:'tasks',patch:{deleted:true},ts:Date.now()}]});await region.getByRole('button',{name:'Refresh Events',exact:true}).click();await expect(region).toContainText('Capacity: 0. Participants: 0.');await expect(region.getByRole('link',{name:f.personTitle,exact:true})).toHaveCount(0);expect((await readRecord(f.person)).data.deleted).toBe(true);
  await page.getByRole('button',{name:'Configure Event roles',exact:true}).click();await page.getByRole('combobox',{name:'Event roles Event',exact:true}).selectOption(f.past);await page.keyboard.press('Escape');await expect(region.getByRole('link',{name:'Past Event '+f.key,exact:true})).toBeVisible();await expect(region.getByRole('link',{name:f.title,exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Configure Event roles',exact:true}).click();await page.getByRole('combobox',{name:'Event roles Participants field',exact:true}).selectOption('rel_f_facilitators');await page.keyboard.press('Escape');await expect(page.getByText('Choose an Events database and distinct role fields in Configure.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Configure Event roles',exact:true}).click();await page.getByRole('combobox',{name:'Event roles Participants field',exact:true}).selectOption('rel_f_participants');await page.keyboard.press('Escape');await expect(region.getByRole('link',{name:'Past Event '+f.key,exact:true})).toBeVisible();await health(page,'Community configured Event',info);
 }finally{await f.cleanup();}
});
test('Community desk: failed reads, device snapshot and enlarged controls recover',async({page,context},info)=>{
 const f=await seed(info);
 try{
  const region=await desk(page,f);await page.route('**/api/event-ops',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"disposable_outage"}'}));await region.getByRole('button',{name:'Refresh Events',exact:true}).click();await expect(region).toContainText('Event relationships could not be refreshed');await page.unroute('**/api/event-ops');await region.getByRole('button',{name:'Refresh Events',exact:true}).click();await expect(region.getByRole('alert')).toHaveCount(0);
  await setOfflineForTest(page,context,true);await expect(region).toContainText('Partial device snapshot');await expect(region).toContainText('Participants: 1');await setOfflineForTest(page,context,false);await expect(region).not.toContainText('Partial device snapshot');
  await request('/api/sync/push',{protocol:3,changes:[{id:f.person,collection:'tasks',patch:{title:'Participant'+('Longword'.repeat(40))},ts:Date.now()}]});await region.getByRole('button',{name:'Refresh Events',exact:true}).click();await page.addStyleTag({content:'html{font-size:200%!important}'});const fix=region.getByRole('link',{name:'Review participants',exact:true});await fix.scrollIntoViewIfNeeded();await expect(fix).toBeInViewport({ratio:1});const box=await fix.evaluate(element=>{const r=element.getBoundingClientRect(),card=element.closest('li').getBoundingClientRect();return {right:r.right,boundary:card.right,scroll:element.scrollWidth,width:element.clientWidth};});expect(box.right).toBeLessThanOrEqual(box.boundary+1);expect(box.scroll).toBeLessThanOrEqual(box.width+1);await health(page,'Community enlarged relationships',info);await info.attach('community-enlarged',{body:await page.screenshot(),contentType:'image/png'});
 }finally{if(!page.isClosed())await setOfflineForTest(page,context,false);await f.cleanup();}
});
test('Community desk: membership views and offline conversation ownership reach Attention',async({page,context},info)=>{
 const f=await seed(info);
 try{
  await desk(page,f);for(const name of ['Member relationships','Volunteer relationships']){const heading=page.getByRole('heading',{name,exact:true}),frame=heading.locator('..').locator('..');await expect(frame.getByText(f.personTitle,{exact:true})).toBeVisible();}
  await open(page,{id:'community-person',path:'/boards/'+f.people+'/tasks/'+f.person,ready:{role:'textbox',name:'Record title',exact:true}});await setOfflineForTest(page,context,true);await page.getByRole('combobox',{name:'Relationship owner',exact:true}).selectOption(fixture.admin.user.id);await page.getByLabel('Next conversation',{exact:true}).fill('2020-01-01');await page.getByLabel('Next conversation',{exact:true}).press('Tab');await expect.poll(async()=>(await readAccountStore(page,'tasks',{id:f.person})).p_f_relationship_owner).toBe(fixture.admin.user.id);await setOfflineForTest(page,context,false);await expect.poll(async()=>(await readRecord(f.person)).data.p_f_next_conversation).toBe('2020-01-01');
  await desk(page,f);const attention=page.getByRole('region',{name:'Needs attention',exact:true}),item=attention.getByRole('listitem').filter({hasText:f.personTitle});await expect(item).toContainText('Overdue');await expect(item.getByRole('link').first()).toHaveAttribute('href',new RegExp('/boards/'+f.people+'/tasks/'+f.person));await health(page,'Community conversation attention',info);
 }finally{if(!page.isClosed())await setOfflineForTest(page,context,false);await f.cleanup();}
});
