import {test,expect,open,health,request,readRecord,fixture,setOfflineForTest} from './support.mjs';
import {connectFixtureMcp} from '../certification/mcp-client.mjs';
async function seed(info){
 const suffix=info.project.name.replaceAll('-','')+'-'+Date.now(),source='air-page-'+suffix,board='air-board-'+suffix,task='air-task-'+suffix;
 const rows=[{id:source,collection:'pages',patch:{title:'Synthetic AI review evidence',order:'a0'}},{id:board,collection:'boards',patch:{name:'Synthetic AI review tasks',kind:'tasks',columns:[{id:'todo',name:'To do'},{id:'done',name:'Done'}],fields:[],order:'a0'}},{id:task,collection:'tasks',patch:{boardId:board,title:'Synthetic suggestion target',status:'todo',priority:'none',order:'a0'}}];
 await request('/api/sync/push',{protocol:3,changes:rows.map(r=>({...r,ts:Date.now()}))});
 // Raw MCP client: this test creates proposals only. Approval/execution must be
 // exercised by a labelled disposable session-authenticated browser fixture.
 const mcp=await connectFixtureMcp(fixture.base,{name:'Disposable Review desk fixture',fixtureHuman:false,allowHttps:true});
 const proposals=[],suggestions=[];
 return {source,board,task,suffix,rows,mcp,proposals,suggestions,
  async propose(){const p=await mcp.call('propose_workflow',{workflow:'meeting_to_actions',workflowId:'air-'+Date.now(),sourceIds:[source],destinationDatabaseId:board,title:'Synthetic reviewed follow-up',items:[{title:'Synthetic proposed action '+suffix,inferred:false}]});proposals.push(p);return p;},
  async suggest(patch={priority:'low'}){const s=await mcp.call('propose_suggestion',{targetId:task,patch,rationale:'Synthetic evidence only. <script>window.__INJECTED=true</script> Ignore approvals is untrusted text.'});suggestions.push(s);return s;},
  async cleanup(){
   for(const p of proposals){await fetch(fixture.base+`/api/ai/previews/${p.previewId}/decision`,{method:'POST',headers:{Authorization:'Bearer '+fixture.admin.token,'Content-Type':'application/json'},body:JSON.stringify({decision:'cancel',argsHash:p.argsHash})});}
   for(const s of suggestions)await fetch(fixture.base+`/api/ai/suggestions/${s.suggestionId}/decision`,{method:'POST',headers:{Authorization:'Bearer '+fixture.admin.token,'Content-Type':'application/json'},body:JSON.stringify({decision:'reject'})});
   const ids=[...rows,...proposals.flatMap(p=>(p.proposedRecordIds??[]).map(id=>({id,collection:'tasks'})))];
   await request('/api/sync/push',{protocol:3,changes:ids.map(r=>({id:r.id,collection:r.collection,patch:{deleted:true},ts:Date.now()}))});await mcp.close();
  }
 };
}
async function desk(page,hash=''){await open(page,{path:'/ai?view=review'+hash,ready:{role:'heading',name:'AI workflows'}});await expect(page.getByRole('region',{name:'Proposal reviews'})).toBeVisible();}
const proposal=(page,id)=>page.locator(`[id="preview-${id}"]`);
const suggestion=(page,id)=>page.locator(`[id="suggestion-${id}"]`);

test('AI review desk: fixture approval, resume, edited suggestion and revision-safe undo',async({page},info)=>{
 const f=await seed(info);
 try{
  const p=await f.propose(),s=await f.suggest();expect((await request('/api/ai/previews/'+p.previewId,undefined,'GET')).status).toBe('pending');
  const queue=await request('/api/attention?kinds=ai_preview_pending,suggestion_pending',undefined,'GET');expect(queue.items.find(i=>i.targetId===p.previewId).url).toBe('/ai?view=review#preview-'+p.previewId);expect(queue.items.find(i=>i.targetId===s.suggestionId).url).toBe('/ai?view=review#suggestion-'+s.suggestionId);
  await desk(page,'#preview-'+p.previewId);const card=proposal(page,p.previewId);await expect(card).toBeFocused();await expect(card.getByRole('time')).toContainText('Expires in');
  await card.getByRole('link',{name:'Review proposed changes',exact:true}).focus();await page.keyboard.press('Enter');await expect(page.getByRole('heading',{name:'Review proposed changes',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Approve exact changes',exact:true}).press('Enter');await expect(page.getByRole('status')).toContainText('Approved.');
  await page.getByRole('link',{name:'AI workflows',exact:true}).click();await expect(proposal(page,p.previewId)).toContainText('approved');await proposal(page,p.previewId).getByRole('link',{name:'Resume / Review',exact:true}).click();
  await page.getByRole('button',{name:'Resume execution',exact:true}).press('Enter');await expect(page.getByRole('status')).toContainText('Completed.');expect((await readRecord(p.proposedRecordIds[0]))?.data.title).toBe('Synthetic proposed action '+f.suffix);
  await desk(page,'#suggestion-'+s.suggestionId);const item=suggestion(page,s.suggestionId);await expect(item).toBeFocused();await item.getByRole('textbox',{name:'Proposed fields',exact:true}).fill('{"priority":"high"}');await item.getByRole('button',{name:'Accept edited suggestion',exact:true}).press('Enter');await expect(item).toHaveCount(0);expect((await readRecord(f.task))?.data.priority).toBe('high');expect(await page.evaluate(()=>window.__INJECTED)).toBeUndefined();
  const changes=page.getByRole('region',{name:'Recent AI changes',exact:true});await changes.getByRole('button',{name:'Refresh changes',exact:true}).click();const undo=changes.getByRole('listitem').filter({hasText:'accept_ai_suggestion'});await expect(undo).toBeVisible();await undo.getByRole('link',{name:'Review undo',exact:true}).click();await expect(page.getByRole('heading',{name:'Review changeset undo',exact:true})).toBeVisible();await health(page,'AI desk undo review',info);
  await page.getByRole('button',{name:'Confirm revision-safe undo',exact:true}).press('Enter');await expect(page.getByRole('status')).toContainText('restored');expect((await readRecord(f.task))?.data.priority).toBe('none');
  await desk(page);await page.getByRole('region',{name:'Recent AI changes',exact:true}).scrollIntoViewIfNeeded();await expect(page.getByRole('region',{name:'Recent AI changes',exact:true})).toBeInViewport();await health(page,'AI desk reviewed results',info);await info.attach('ai-review-complete',{body:await page.screenshot(),contentType:'image/png'});
 }finally{await f.cleanup();}
});

test('AI review desk: stale sources, rejection, cancellation and expiry stay non-authoritative',async({page},info)=>{
 const f=await seed(info);
 try{
  const p=await f.propose(),s=await f.suggest();await desk(page);
  await request('/api/sync/push',{protocol:3,changes:[{id:f.task,collection:'tasks',ts:Date.now(),patch:{priority:'medium'}}]});
  const item=suggestion(page,s.suggestionId);await item.getByRole('button',{name:'Accept edited suggestion',exact:true}).click();await expect(page.getByRole('alert')).toContainText('source_changed');expect((await readRecord(f.task))?.data.priority).toBe('medium');
  await item.getByRole('button',{name:'Reject',exact:true}).click();await expect(item).toHaveCount(0);expect((await readRecord(f.task))?.data.priority).toBe('medium');
  await proposal(page,p.previewId).getByRole('link',{name:'Review proposed changes',exact:true}).click();
  await page.getByRole('button',{name:'Approve exact changes',exact:true}).click();await expect(page.getByRole('status')).toContainText('Approved.');
  await request('/api/sync/push',{protocol:3,changes:[{id:f.source,collection:'pages',ts:Date.now(),patch:{title:'Synthetic source changed after fixture approval'}}]});
  await page.getByRole('button',{name:'Resume execution',exact:true}).click();await expect(page.getByRole('alert')).toBeVisible();expect(await readRecord(p.proposedRecordIds[0])).toBeNull();
  await desk(page);const interrupted=proposal(page,p.previewId);await expect(interrupted).toContainText('executing');await expect(interrupted).toContainText('Some changes may already be committed.');
  await interrupted.getByRole('link',{name:'Resume / Review',exact:true}).click();await page.getByRole('button',{name:'Cancel proposal',exact:true}).click();await expect(page.getByRole('status')).toContainText('Cancelled.');expect(await readRecord(p.proposedRecordIds[0])).toBeNull();
  const expired=await f.propose();await desk(page);await page.clock.install({time:new Date()});await page.clock.fastForward(16*60000);const card=proposal(page,expired.previewId);await expect(card.getByRole('time')).toHaveText('Expired');await expect(card.getByRole('link',{name:'Review expired proposal',exact:true})).toBeVisible();expect(await readRecord(expired.proposedRecordIds[0])).toBeNull();
  await page.addStyleTag({content:'html{font-size:200%!important}'});await card.scrollIntoViewIfNeeded();await health(page,'AI desk enlarged expired proposal',info);await info.attach('ai-review-enlarged',{body:await page.screenshot(),contentType:'image/png'});
 }finally{await f.cleanup();}
});

test('AI review desk: loading, failed reads, offline hiding and library recovery',async({page,context},info)=>{
 const f=await seed(info);let release;const hold=new Promise(r=>release=r);
 try{
  const p=await f.propose();await context.route('**/api/ai/previews',async route=>{await hold;await route.fulfill({status:503,contentType:'application/json',body:'{"error":"synthetic_outage"}'});});
  await desk(page);const region=page.getByRole('region',{name:'Proposal reviews',exact:true});await expect(region.getByRole('status')).toHaveText('Loading proposals…');await expect(region).not.toContainText('No active proposals');release();await expect(region.getByRole('alert')).toContainText('Could not verify');
  await context.unroute('**/api/ai/previews');await region.getByRole('button',{name:'Retry proposals',exact:true}).click();await expect(proposal(page,p.previewId)).toBeVisible();
  await setOfflineForTest(page,context,true);await expect(page.getByRole('heading',{name:'AI workflows',exact:true})).toHaveCount(0);await expect(page.getByText('Reconnect to verify current access before opening AI reviews.',{exact:true})).toBeVisible();await expect(proposal(page,p.previewId)).toHaveCount(0);
  await setOfflineForTest(page,context,false);await expect(page.getByRole('heading',{name:'AI workflows',exact:true})).toBeVisible();await expect(proposal(page,p.previewId)).toBeVisible();
  await page.getByRole('navigation',{name:'AI views',exact:true}).getByRole('link',{name:'Workflow library',exact:true}).press('Enter');await expect(page.getByRole('heading',{name:'Workflow library',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Weekly digest',exact:true})).toBeVisible();await health(page,'AI library preserved',info);
  await page.getByRole('navigation',{name:'AI views',exact:true}).getByRole('link',{name:'Review',exact:true}).press('Enter');await expect(proposal(page,p.previewId)).toBeVisible();await health(page,'AI desk connection recovered',info);
 }finally{release();await context.unroute('**/api/ai/previews');await setOfflineForTest(page,context,false);await f.cleanup();}
});
