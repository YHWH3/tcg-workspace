import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fixtureEnvironment} from '../phase4-fixture.mjs';
import {test,expect,open,health,request,fixture,setOfflineForTest} from './support.mjs';
const pack=JSON.parse(readFileSync(new URL('../../templates/tcg-pack.json',import.meta.url),'utf8'));
const user=fixture.admin.user.id,q=value=>"'"+String(value).replaceAll("'","''")+"'";
function sql(value){execFileSync(resolve('node_modules/.bin/wrangler'),['d1','execute','DB','--local','--config',fixture.owner.config,'--persist-to',fixture.owner.state,'--command',value,'--json'],{env:fixtureEnvironment(),stdio:['ignore','pipe','pipe'],timeout:30_000});}
async function seed(info,{crowded=false}={}){
 const key=info.project.name.replaceAll('-','').slice(0,8)+'-'+Date.now(),pageId='command-'+key;
 const ids=Object.fromEntries(['db_projects','db_events','db_meetings','db_opportunities'].map(id=>[id,id+'-'+key]));
 const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const title=name=>name+' café 日本語 العربية 👩🏽‍💻 '+key;
 const boards=Object.entries(ids).map(([id,liveId])=>{const source=pack.databases.find(d=>d.id===id);return {id:liveId,collection:'boards',patch:{name:source.name+' '+key,kind:'records',columns:source.columns,fields:source.fields.filter(f=>['f_owner','f_start','f_date','f_deadline'].includes(f.id)),showBuiltins:source.showBuiltins,recordNoun:source.recordNoun,attention:{enabled:true,personKey:'assigneeId',dateKey:'dueDate'}}};});
 const projectStatus=boards[0].patch.columns[0].id;
 const tasks=[
  {id:'mine-'+key,collection:'tasks',patch:{boardId:ids.db_projects,title:title('Owned project'),status:projectStatus,p_f_owner:user,p_f_start:date}},
  {id:'other-'+key,collection:'tasks',patch:{boardId:ids.db_projects,title:title('Other project'),status:projectStatus,p_f_owner:'someone-else'}},
  {id:'work-'+key,collection:'tasks',patch:{boardId:ids.db_projects,title:title('My overdue work'),status:projectStatus,assigneeId:user,dueDate:'2020-01-01'}},
  ...[['db_events','p_f_start','Event'],['db_meetings','p_f_date','Meeting'],['db_opportunities','p_f_deadline','Opportunity']].map(([db,dateKey,name])=>({id:db+'-record-'+key,collection:'tasks',patch:{boardId:ids[db],title:title(name),status:boards.find(b=>b.id===ids[db]).patch.columns?.[0]?.id??null,[dateKey]:date}})),
 ];
 const view=pack.databases.find(d=>d.id==='db_projects').views.find(v=>v.id==='v_home_my_projects');
 const blocks=pack.pages.find(p=>p.id==='pg_command_center').blocks.map((b,n)=>({id:b.key+'-'+key,collection:'blocks',patch:{...b,pageId,order:'a'+String(n).padStart(2,'0'),...(b.databaseId?{databaseId:ids[b.databaseId]}:{}),...(b.viewId?{viewId:b.viewId+'-'+key}:{}),...(b.sources?{sources:b.sources.map(s=>({...s,databaseId:ids[s.databaseId]}))}:{})}}));
 const rows=[...boards,...tasks,{id:view.id+'-'+key,collection:'views',patch:{databaseId:ids.db_projects,name:view.name,type:view.type,config:view.config}},{id:pageId,collection:'pages',patch:{title:'Daily command center',order:'z'+key}},...blocks];
 expect((await request('/api/sync/push',{protocol:3,changes:rows.map(r=>({...r,ts:Date.now()}))})).rejectedItems).toEqual([]);
 const suggestion='command-suggestion-'+key,approvals=Array.from({length:crowded?55:0},(_,n)=>'command-approval-'+key+'-'+n),now=Date.now();
 sql(`INSERT INTO ai_suggestions(id,user_id,target_id,source_hash,source_rev,patch_json,rationale,provider,model,created_at) VALUES(${q(suggestion)},${q(user)},${q(tasks[0].id)},'fixture',1,'{}','Disposable contract fixture, no inference','simulated','fixture',${now});`+(approvals.length?`INSERT INTO approvals(id,target_type,target_id,requested_by,approver_id,status,created_at) VALUES ${approvals.map((id,n)=>`(${q(id)},'record',${q(tasks[0].id)},${q(user)},${q(user)},'pending',${now-n})`).join(',')};`:''));
 return {key,pageId,ids,tasks,title,async cleanup(){sql(`DELETE FROM approvals WHERE id IN (${approvals.length?approvals.map(q).join(','):"''"}); DELETE FROM ai_suggestions WHERE id=${q(suggestion)};`);await request('/api/sync/push',{protocol:3,changes:rows.map(r=>({id:r.id,collection:r.collection,patch:{deleted:true},ts:Date.now()}))});}};
}
async function center(page,f){await open(page,{id:'command-center',path:'/pages/'+f.pageId,ready:{role:'heading',name:'Needs attention'}});await expect(page.getByRole('region',{name:'Needs attention',exact:true}).getByRole('link',{name:f.title('My overdue work'),exact:true})).toBeVisible();}
test('Command center: four sections, owned projects, merged dates and keyboard source navigation',async({page},info)=>{
 const f=await seed(info);try{
  await center(page,f);
  expect((await page.locator('[contenteditable=true]').allTextContents()).filter(text=>['Needs attention','My execution','Coming up','What changed'].includes(text))).toEqual(['Needs attention','My execution','Coming up','What changed']);
  const projects=page.getByRole('heading',{name:'Projects I own',exact:true}).locator('..').locator('..');await expect(projects).toContainText(f.title('Owned project'));await expect(projects).not.toContainText(f.title('Other project'));
  if(!await page.getByRole('button',{name:f.title('Event'),exact:true}).count())await page.getByRole('button',{name:/4 records$/}).press('Enter');
  for(const name of ['Owned project','Event','Meeting','Opportunity'])await expect(page.getByRole('button',{name:f.title(name),exact:true}).last()).toBeAttached();
  await expect(page.getByRole('region',{name:'Pending AI review',exact:true})).toContainText(f.title('Owned project'));await page.getByRole('heading',{name:'My open work',exact:true}).scrollIntoViewIfNeeded();await health(page,'Command center populated sections',info);await info.attach('command-center-populated',{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
  const link=page.getByRole('region',{name:'Needs attention',exact:true}).getByRole('link',{name:f.title('My overdue work'),exact:true});await link.press('Enter');await expect(page.getByRole('textbox',{name:'Project title',exact:true})).toHaveValue(f.title('My overdue work'));
 }finally{await f.cleanup();}
});
test('Command center: AI review survives a crowded queue, failed reads and offline snapshots',async({page,context},info)=>{
 const f=await seed(info,{crowded:true});try{
  await open(page,{id:'command-center',path:'/pages/'+f.pageId,ready:{role:'heading',name:'Pending AI review'}});
  const review=page.getByRole('region',{name:'Pending AI review',exact:true});await expect(review.getByRole('link',{name:f.title('Owned project'),exact:true})).toBeVisible();
  await page.route('**/api/attention?*',route=>route.request().url().includes('kinds=')?route.fulfill({status:503,contentType:'application/json',body:'{"error":"synthetic_outage"}'}):route.continue());await review.getByRole('button',{name:'Refresh',exact:true}).press('Enter');await expect(review.getByRole('alert')).toContainText('could not refresh');await page.unroute('**/api/attention?*');await review.getByRole('button',{name:'Refresh',exact:true}).press('Enter');await expect(review.getByRole('alert')).toHaveCount(0);
  await setOfflineForTest(page,context,true);await expect(review).toContainText('Reconnect to review');await expect(review.getByRole('link',{name:'Review',exact:true})).toHaveCount(0);await health(page,'Command center separate offline review snapshot',info);await setOfflineForTest(page,context,false);await expect(review.getByRole('link',{name:'Review',exact:true})).toBeVisible();await health(page,'Command center review recovery',info);
 }finally{await setOfflineForTest(page,context,false);await f.cleanup();}
});
test('Command center: enlarged text, urgency configuration and explicit empty states',async({page},info)=>{
 const f=await seed(info);try{
  await center(page,f);await page.addStyleTag({content:'html{font-size:200%!important}'});await page.getByRole('heading',{name:'Pending AI review',exact:true}).scrollIntoViewIfNeeded();await health(page,'Command center enlarged',info);await info.attach('command-center-enlarged',{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
  const attention=page.getByRole('region',{name:'Needs attention',exact:true}),block=attention.locator('..');await block.getByRole('button',{name:'Configure Attention',exact:true}).press('Enter');await page.getByRole('combobox',{name:'Attention minimum urgency',exact:true}).selectOption('3');await page.keyboard.press('Escape');await expect(attention).toContainText('No items in this snapshot');await health(page,'Command center urgency configuration',info);
 }finally{await f.cleanup();}
});
