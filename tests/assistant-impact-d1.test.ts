import {it,expect} from 'vitest';
import {openAuditFixture} from './audit-fixture';
import {proposePreview,aiPreviewApi} from '../worker/aiPreviews';
import {previewImpactText} from '../shared/previewImpact';
it('separates two content creations from one activity row without changing the frozen plan',async()=>{
 const f=await openAuditFixture();
 try {
 const p=await proposePreview(f.env,'alice','test',{},[
  {id:'impact-page',collection:'pages',patch:{title:'Page'}},
  {id:'impact-block',collection:'blocks',patch:{pageId:'impact-page',type:'p',text:'Body'}},
  {id:'impact-activity',collection:'activity',patch:{targetId:'impact-page',targetType:'page',verb:'created',actorId:'alice'}},
 ]);
 expect(p.impact).toMatchObject({create:3,content:{create:2,update:0,delete:0},audit:{create:1,update:0,delete:0}});
 const review=await aiPreviewApi.request('http://localhost/'+p.previewId,{headers:f.auth('alice')},f.env,f.ctx);
 expect(review.status).toBe(200);
 const body=await review.json() as {impact:typeof p.impact;changes:unknown[]};
 expect(body.changes).toHaveLength(3);
 expect(previewImpactText(body.impact)).toEqual(['Content items: 2 create · 0 update · 0 delete','Activity/audit rows: 1 create · 0 update · 0 delete','Total planned operations: 3 create · 0 update · 0 delete']);
 expect(await f.db.prepare("SELECT COUNT(*) n FROM records WHERE id LIKE 'impact-%'").first('n')).toBe(0);
 }finally {await f.dispose();}
});
it('labels older retained previews as total operations without inventing a content count',()=>{
 expect(previewImpactText({create:3,update:0,delete:0})).toEqual(['Total planned operations: 3 create · 0 update · 0 delete (includes content and activity/audit rows)']);
});
