import {it,expect} from 'vitest';
import {toBundled,planPackUpgrade,type AuthorTemplate} from '../shared/bundled';
import {planTemplateInstantiation,boardRefsOf} from '../shared/templates';
import {applyView,type ViewConfig} from '../shared/views';
import {AI_ACTIONS} from '../shared/aiActions';
import raw from '../templates/tcg-pack.json';
it('adds stable finance blocks and a bounded stale-action view without changing text Margin',()=>{
 const pack=toBundled('tcg-pack',raw as unknown as AuthorTemplate);expect(pack.version).toBeGreaterThanOrEqual(5);
 expect(pack.snapshot.blocks!.finance_project_budgets).toMatchObject({type:'budget',databaseId:'db_projects',mode:'project'});expect(pack.snapshot.blocks!.project_review_budget).toMatchObject({recordId:'self',limit:1});
 expect(pack.snapshot.blocks!.finance_product_economics).toMatchObject({type:'budget',databaseId:'db_products',mode:'product'});
 expect((pack.snapshot.boards!.db_products.fields as {id:string;type:string}[]).find(f=>f.id==='f_margin')?.type).toBe('text');
 const stale=pack.snapshot.blocks!.funding_stale_next_actions.inline as ViewConfig;
 const rows=[{id:'stale',status:'dormant',p_f_next_action_date:'2026-10-28'},{id:'won',status:'won',p_f_next_action_date:'2026-10-28'},{id:'lost',status:'lost',p_f_next_action_date:'2026-10-28'},{id:'today',status:'proposal',p_f_next_action_date:'2026-10-29'},{id:'empty',status:'target'},{id:'old',status:'target',p_f_next_action_date:'1999-01-01'}];
 expect(applyView(rows,stale,{today:'2026-10-29'}).rows.map(r=>r.id)).toEqual(['stale']);
 expect(AI_ACTIONS.find(a=>a.id==='explain_budget')).toMatchObject({output:'answer',module:'dashboards'});
});
it('remaps configured record/database references without copying unrelated live finance sources',()=>{
 const pack=toBundled('tcg-pack',raw as unknown as AuthorTemplate),budget=pack.snapshot.blocks!.project_review_budget;expect(boardRefsOf(budget)).toEqual([]);
 const plan=planTemplateInstantiation({...pack.snapshot,blocks:{project_review_budget:budget}},{templateId:'pg_tpl_project_review'},{id:()=>crypto.randomUUID(),now:1})!;
 expect(plan.writes.filter(w=>['boards','tasks'].includes(w.collection))).toEqual([]);expect(plan.writes.find(w=>w.collection==='blocks'&&w.patch.type==='budget')?.patch).toMatchObject({recordId:'self',databaseId:'db_projects',mode:'project'});
});
it('upgrades additively while preserving a renamed heading, text Margin and deleted budget reservations',()=>{
 const pack=toBundled('tcg-pack',raw as unknown as AuthorTemplate),plan=planTemplateInstantiation(pack.snapshot,{templateId:pack.root,templateKey:pack.key,packInstall:true,stableIds:true},{id:()=>crypto.randomUUID(),now:1})!;
 const rows=plan.writes.map(w=>({id:w.id,collection:w.collection,data:{...w.patch}})),budget=rows.find(r=>r.data.templateItemKey==='finance_project_budgets')!;expect(budget).toBeDefined();budget.data.deleted=true;budget.data.heading='Our own heading';rows.find(r=>r.data.templateKey==='tcg-pack')!.data.templateVersion=4;
 expect(planPackUpgrade(pack,rows).writes.some(w=>w.id===budget.id)).toBe(false);expect(budget.data).toMatchObject({deleted:true,heading:'Our own heading'});
});
