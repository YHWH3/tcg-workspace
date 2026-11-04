import {readFileSync} from 'node:fs';
import {test,expect,open,health,request,readRecord,fixture,setOfflineForTest} from './support.mjs';
const pack=JSON.parse(readFileSync(new URL('../../templates/tcg-pack.json',import.meta.url),'utf8'));
async function seed(info){
 const key=info.project.name.replaceAll('-','').slice(0,8)+'-'+Date.now(),ideas='ideas-'+key,projects='projects-'+key,pageId='ideas-desk-'+key,user=fixture.admin.user.id;
 const ids=Object.fromEntries(['review','approved','old','recent','linked','legacy','project','legacyProject'].map(id=>[id,id+'-'+key]));
 const title=id=>({review:'Review café 日本語 العربية 👩🏽‍💻 ',approved:'Approved rain garden ',old:'Old parked ',recent:'Recent parked ',linked:'Approved with project ',legacy:'Older conversion ',project:'Linked project ',legacyProject:'Historical project '}[id]+key);
 const boards=['db_ideas','db_projects'].map(id=>{const source=pack.databases.find(b=>b.id===id);return {id:id==='db_ideas'?ideas:projects,collection:'boards',patch:{kind:'records',templateDbKey:source.key,name:source.name+' '+key,recordNoun:source.recordNoun,showBuiltins:source.showBuiltins,columns:source.columns,fields:source.fields.filter(f=>id==='db_ideas'&&['f_creator','f_converted_project'].includes(f.id)).map(f=>({...f,...(f.relation?{relation:{...f.relation,target:projects}}:{})})),...(id==='db_ideas'?{attention:source.attention}:{})}};});
 const views=pack.databases.find(b=>b.id==='db_ideas').views.filter(v=>['v_ideas_review','v_ideas_parked_old','v_ideas_approved'].includes(v.id)).map(v=>({id:v.id+'-'+key,collection:'views',patch:{databaseId:ideas,name:v.name,type:v.type,config:v.config}}));
 const blocks=pack.pages.find(p=>p.id==='pg_ideas').blocks.filter(b=>b.key.startsWith('ideas_')).map((b,index)=>({id:b.key+'-'+key,collection:'blocks',patch:{...b,pageId,order:'a'+index,...(b.databaseId?{databaseId:ideas}:{}),...(b.viewId?{viewId:b.viewId+'-'+key}:{})}}));
 const rows=[...boards,...views,{id:pageId,collection:'pages',patch:{title:'Ideas review '+key}},...blocks,
 ...['review','approved','old','recent','linked','legacy'].map(id=>({id:ids[id],collection:'tasks',patch:{boardId:ideas,title:title(id),status:{review:'review',approved:'approved',old:'parked',recent:'parked',linked:'approved',legacy:'converted'}[id],p_f_creator:user,createdAt:id==='old'?Date.now()-40*86400000:Date.now()}})),
 ...['project','legacyProject'].map(id=>({id:ids[id],collection:'tasks',patch:{boardId:projects,title:title(id),status:'active',...(id==='legacyProject'?{convertedFrom:ids.legacy}:{})}})),
 {id:'ideas-link-'+key,collection:'links',patch:{kind:'relation',fieldId:'f_converted_project',fromType:'record',toType:'record',fromId:ids.linked,toId:ids.project}}];
 expect((await request('/api/sync/push',{protocol:3,changes:rows.map(row=>({...row,ts:Date.now()}))})).rejectedItems).toEqual([]);
 const previews=[],extra=[];
 return {key,ids,ideas,projects,pageId,title,previews,extra,async cleanup(){for(const id of previews){const p=await request('/api/ai/previews/'+id,undefined,'GET');if(['pending','approved'].includes(p.status))await request('/api/ai/previews/'+id+'/decision',{argsHash:p.argsHash,decision:'cancel'});}await request('/api/sync/push',{protocol:3,changes:[...rows,...extra].map(row=>({id:row.id,collection:row.collection,patch:{deleted:true},ts:Date.now()}))});}};
}
async function desk(page,f){await open(page,{id:'ideas-desk',path:'/pages/'+f.pageId,ready:{role:'heading',name:'Waiting for review',exact:true}});}
async function detail(page,f,id){await open(page,{id:'ideas-record',path:'/boards/'+f.ideas+'/tasks/'+f.ids[id],ready:{role:'textbox',name:'Idea title',exact:true}});return page.locator('.ws-record-detail');}
function section(page,heading){return page.getByRole('heading',{name:heading,exact:true}).locator('..').locator('..');}
async function propose(page,f){const response=page.waitForResponse(r=>r.url().includes('/api/ideas/')&&r.request().method()==='POST');await page.getByRole('button',{name:'Review conversion to project',exact:true}).press('Enter');const result=await (await response).json();expect(result.previewId).toBeTruthy();if(!f.previews.includes(result.previewId))f.previews.push(result.previewId);await expect(page.getByRole('heading',{name:'Review proposed changes',exact:true})).toBeVisible();return result;}

test('Ideas desk: review, creation-age parked and approved relationship queues',async({page},info)=>{
 const f=await seed(info);try{
  await desk(page,f);await expect(section(page,'Waiting for review')).toContainText(f.title('review'));await expect(section(page,'Waiting for review')).not.toContainText(f.title('approved'));
  await expect(section(page,'Parked, created over 30 days ago')).toContainText(f.title('old'));await expect(section(page,'Parked, created over 30 days ago')).not.toContainText(f.title('recent'));
  await expect(section(page,'Approved, not converted')).toContainText(f.title('approved'));await expect(section(page,'Approved, not converted')).not.toContainText(f.title('linked'));await expect(page.getByText(/creation age, not time spent parked/)).toBeVisible();await health(page,'Ideas review queues',info);await info.attach('ideas-queues',{body:await page.screenshot(),contentType:'image/png'});
 }finally{await f.cleanup();}
});
test('Ideas desk: labelled fixture approval, reload-safe proposal and canonical handoff both ways',async({page},info)=>{
 const f=await seed(info);try{
  await detail(page,f,'approved');const first=await propose(page,f);expect((await readRecord(f.ids.approved)).data.status).toBe('approved');
  const preview=await request('/api/ai/previews/'+first.previewId,undefined,'GET');f.extra.push(...preview.changes.filter(c=>c.before===null).map(c=>({id:c.id,collection:c.collection})));
  const dest=preview.changes.find(c=>c.collection==='tasks'&&c.id!==f.ids.approved).id;
  await detail(page,f,'approved');const replay=await propose(page,f);expect(replay.previewId).toBe(first.previewId);await health(page,'Ideas conversion frozen review',info);
  // Automated disposable session approval. This is not a genuine human decision.
  await page.getByRole('button',{name:'Approve exact changes',exact:true}).press('Enter');await expect(page.getByRole('status')).toContainText('Approved.');await page.getByRole('button',{name:'Resume execution',exact:true}).press('Enter');await expect(page.getByRole('status')).toContainText('Completed.');
  const original=await detail(page,f,'approved'),banner=original.getByRole('region',{name:'Idea conversion handoff',exact:true});await expect(banner).toContainText('Converted to ');await health(page,'Ideas converted handoff',info);await info.attach('ideas-converted',{body:await page.screenshot(),contentType:'image/png'});
  await banner.getByRole('link',{name:f.title('approved'),exact:true}).press('Enter');await expect(page).toHaveURL(new RegExp('/boards/'+f.projects+'/tasks/'+dest));const back=page.getByRole('region',{name:'Idea conversion handoff',exact:true});await expect(back).toContainText('From idea ');await back.getByRole('link',{name:f.title('approved'),exact:true}).press('Enter');await expect(page).toHaveURL(new RegExp('/tasks/'+f.ids.approved));
  await desk(page,f);await expect(section(page,'Approved, not converted')).not.toContainText(f.title('approved'));await health(page,'Ideas handoff round trip',info);
 }finally{await f.cleanup();}
});
test('Ideas desk: offline conversion refusal and failed proposal recovery',async({page,context},info)=>{
 const f=await seed(info);try{
  const panel=await detail(page,f,'approved');await setOfflineForTest(page,context,true);await expect(panel.getByRole('button',{name:'Review conversion to project',exact:true})).toBeDisabled();await expect(panel).toContainText('Reconnect and check access');expect((await readRecord(f.ids.approved)).data.status).toBe('approved');await setOfflineForTest(page,context,false);
  await page.route('**/api/ideas/*/conversion',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"disposable_outage"}'}));await panel.getByRole('button',{name:'Review conversion to project',exact:true}).press('Enter');await expect(panel.getByRole('alert')).toContainText('Conversion review could not be prepared');await page.unroute('**/api/ideas/*/conversion');const p=await propose(page,f);await health(page,'Ideas conversion recovered',info);
  await page.getByRole('button',{name:'Cancel proposal',exact:true}).press('Enter');await expect(page.getByRole('status')).toContainText('Cancelled.');await detail(page,f,'approved');await page.getByRole('button',{name:'Review conversion to project',exact:true}).press('Enter');await expect(page.getByRole('alert')).toContainText('previous proposal was cancelled');
  const response=page.waitForResponse(r=>r.url().includes('/api/ideas/')&&r.request().method()==='POST');await page.getByRole('button',{name:'Start a new conversion review',exact:true}).press('Enter');const fresh=await (await response).json();f.previews.push(fresh.previewId);expect(fresh.previewId).not.toBe(p.previewId);await expect(page.getByRole('heading',{name:'Review proposed changes',exact:true})).toBeVisible();
 }finally{await setOfflineForTest(page,context,false);await f.cleanup();}
});
test('Ideas desk: enlarged handoff labels, keyboard links and missing historical relationship',async({page},info)=>{
 const f=await seed(info);try{
  const long='Project with multilingual evidence café 日本語 العربية 👩🏽‍💻 '+('long source reference '.repeat(8));await request('/api/sync/push',{protocol:3,changes:[{id:f.ids.project,collection:'tasks',patch:{title:long},ts:Date.now()}]});
  await detail(page,f,'linked');await page.addStyleTag({content:'html{font-size:200%!important}'});const banner=page.getByRole('region',{name:'Idea conversion handoff',exact:true});await expect(banner.getByRole('link',{name:long,exact:true})).toBeVisible();await health(page,'Ideas enlarged handoff',info);await info.attach('ideas-enlarged-handoff',{body:await page.screenshot(),contentType:'image/png'});await banner.getByRole('link').press('Enter');await expect(page.getByRole('region',{name:'Idea conversion handoff',exact:true})).toContainText('From idea ');
  await detail(page,f,'legacy');await expect(page.getByRole('region',{name:'Idea conversion handoff',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Review conversion to project',exact:true})).toHaveCount(0);await health(page,'Ideas historical relation absent',info);
 }finally{await f.cleanup();}
});
