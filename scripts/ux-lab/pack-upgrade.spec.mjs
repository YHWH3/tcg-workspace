import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {test,expect,open,health,request,readRecord,fixture} from './support.mjs';
import {surfaces} from './catalog.mjs';
import {toBundled} from '../../shared/bundled.ts';
import {planTemplateInstantiation,installRecordId} from '../../shared/templates.ts';
import {reloadReady} from '../navigation-ready.mjs';
const raw=JSON.parse(readFileSync(new URL('../../templates/tcg-pack.json',import.meta.url),'utf8'));
const bundle=toBundled('tcg-pack',raw);

test('pack upgrade: preview, preserve edits and apply',async({page},info)=>{
 const plan=planTemplateInstantiation(bundle.snapshot,{templateId:bundle.root,templateKey:bundle.key,stableIds:true,packInstall:true,preserveTemplates:true,actorId:fixture.admin.user.id},{id:()=>{throw new Error('stable fixture required');},now:Date.now()});
 // Represent an existing pre-key install. No fixture records or automation/form
 // configuration is necessary to test additive database/page upgrades.
 const rows=plan.writes.filter(w=>['boards','pages','views','blocks'].includes(w.collection)&&w.patch.parentType!=='record');
 const boardId=installRecordId(bundle.key,'boards','db_projects'),view=rows.find(w=>w.collection==='views'&&w.patch.databaseId===boardId),block=rows.find(w=>w.collection==='blocks'&&w.id!==plan.rootPageId);
 for(const row of rows){delete row.patch.templateItemKey;if(row.id===plan.rootPageId)row.patch.templateVersion=1;if(row.collection==='boards'&&Array.isArray(row.patch.fields))for(const f of row.patch.fields)if(f.format==='currency')delete f.format;}
 const board=rows.find(w=>w.id===boardId);board.patch.name='Our projects';const budget=board.patch.fields.find(f=>f.name==='Budget');budget.name='Our budget';
 view.patch.name='Our renamed view';view.patch.config={...view.patch.config,filters:[{key:'title',op:'contains',value:'keep-team-filter'}]};block.patch.deleted=true;
 const newView=rows.find(w=>w.collection==='views'&&w.id!==view.id&&!rows.some(r=>r.patch.viewId===w.id||r.patch.defaultViewId===w.id));expect(newView).toBeTruthy();rows.splice(rows.indexOf(newView),1);
 try{
  for(const collection of ['boards','pages','views','blocks']){const group=rows.filter(w=>w.collection===collection);for(let i=0;i<group.length;i+=400){const seeded=await request('/api/sync/push',{protocol:3,changes:group.slice(i,i+400).map(w=>({...w,ts:Date.now()}))});expect(seeded.rejectedItems).toEqual([]);}}
  await open(page,surfaces.find(s=>s.id==='settings'));
  const gallery=page.locator('section').filter({has:page.getByRole('heading',{name:'Template gallery',exact:true})}),item=gallery.locator('li').filter({hasText:bundle.name}).first();
  const update=item.getByRole('button',{name:/Update available/});await expect(update).toBeVisible();await update.scrollIntoViewIfNeeded();await update.focus();await update.press('Enter');
  const dialog=page.getByRole('dialog',{name:'Update '+bundle.name,exact:true});await expect(dialog).toContainText('Show Our budget as currency');await expect(dialog).toContainText('Add missing view');await health(page,'pack upgrade preview',info);
  await info.attach('pack-upgrade-preview',{body:await page.screenshot(),contentType:'image/png'});
  const apply=dialog.getByRole('button',{name:'Apply update',exact:true});await apply.scrollIntoViewIfNeeded();await apply.click();await expect(dialog).toBeHidden({timeout:45000});await expect(item.getByRole('status')).toHaveText('Pack update synced.');
  const record=await readRecord(boardId);expect(record.data.name).toBe('Our projects');expect(record.data.fields.find(f=>f.id===budget.id)).toMatchObject({name:'Our budget',format:'currency'});
  expect((await readRecord(view.id)).data).toMatchObject({name:'Our renamed view',config:{filters:[{key:'title',op:'contains',value:'keep-team-filter'}]}});
  expect((await readRecord(plan.rootPageId)).data.templateVersion).toBe(bundle.version);
  expect((await readRecord(block.id))?.data.deleted).toBe(true);
  expect((await readRecord(newView.id))?.data.name).toBe(newView.patch.name);
  await reloadReady(page);await expect(page.getByRole('heading',{name:'Settings',exact:true})).toBeVisible();await expect(gallery.getByRole('button',{name:/Update available/})).toHaveCount(0);
 }finally{
  // Stable pack ids are deliberately reused by each project. Reset only this
  // owned disposable fixture's exact synthetic ids; never add a reset API.
  const owner=fixture.owner,proof=JSON.parse(readFileSync(resolve(owner.directory,'fixture-provenance.json'),'utf8'));
  expect(proof.fixtureId).toBe(owner.fixtureId);expect(proof.base).toBe(fixture.base);expect(proof.disposable).toBe(true);expect(proof.config).toBe(owner.config);expect(proof.state).toBe(owner.state);
  const ids=[...new Set([...rows,newView].map(w=>w.id))];expect(ids.every(id=>/^inst_[a-f0-9]{16}$/.test(id))).toBe(true);
  execFileSync(resolve('node_modules/.bin/wrangler'),['d1','execute','DB','--local','--config',owner.config,'--persist-to',owner.state,'--command',`DELETE FROM records WHERE id IN(SELECT value FROM json_each('${JSON.stringify(ids)}'))`,'--json'],{stdio:'pipe',timeout:30000});
 }
});
