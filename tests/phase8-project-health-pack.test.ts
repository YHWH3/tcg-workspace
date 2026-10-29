import {it,expect} from 'vitest';
import {toBundled,planPackUpgrade,type AuthorTemplate} from '../shared/bundled';
import {planTemplateInstantiation,boardRefsOf} from '../shared/templates';
import raw from '../templates/tcg-pack.json';
it('adds a stable self-health block to Project Review and remaps the configured database on install',()=>{
 const pack=toBundled('tcg-pack',raw as unknown as AuthorTemplate);expect(pack.version).toBe(4);
 const health=pack.snapshot.blocks!.project_review_health;expect(health).toMatchObject({projectId:'self',databaseId:'db_projects',type:'projecthealth',staleDays:14,limit:1});
 const plan=planTemplateInstantiation(pack.snapshot,{templateId:pack.root,templateKey:pack.key,packInstall:true,stableIds:true},{id:()=>crypto.randomUUID(),now:1})!;
 const projects=plan.writes.find(w=>w.collection==='boards'&&w.patch.templateDbKey==='projects')!;
 expect(plan.writes.find(w=>w.collection==='blocks'&&w.patch.type==='projecthealth')?.patch).toMatchObject({databaseId:projects.id,projectId:'self',ownerKey:'p_f_owner',startKey:'p_f_start',endKey:'p_f_end'});
 const rows=plan.writes.map(w=>({id:w.id,collection:w.collection,data:{...w.patch}})),saved=rows.find(w=>w.collection==='blocks'&&w.data.type==='projecthealth')!;saved.data.deleted=true;saved.data.staleDays=30;
 const root=rows.find(w=>w.collection==='pages'&&w.data.templateKey==='tcg-pack')!;root.data.templateVersion=3;
 expect(planPackUpgrade(pack,rows).writes.some(w=>w.id===saved.id)).toBe(false);expect(saved.data).toMatchObject({deleted:true,staleDays:30});
});
it('copies health configuration without pulling its live Projects database into a page copy',()=>{
 const pack=toBundled('tcg-pack',raw as unknown as AuthorTemplate),health=pack.snapshot.blocks!.project_review_health;
 expect(boardRefsOf(health)).toEqual([]);
 // Isolate this new block: the existing review template deliberately includes
 // other embeds, whose established copy behavior remains covered elsewhere.
 const plan=planTemplateInstantiation({...pack.snapshot,blocks:{project_review_health:health}},{templateId:'pg_tpl_project_review'},{id:()=>crypto.randomUUID(),now:1})!;
 expect(plan.writes.filter(w=>w.collection==='boards'||w.collection==='tasks')).toEqual([]);
 expect(plan.writes.find(w=>w.collection==='blocks'&&w.patch.type==='projecthealth')?.patch).toMatchObject({projectId:'self',databaseId:'db_projects',staleDays:14});
});
