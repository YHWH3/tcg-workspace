import {it,expect} from 'vitest';
import {toBundled,planPackUpgrade,type AuthorTemplate} from '../shared/bundled';
import {planTemplateInstantiation,boardRefsOf} from '../shared/templates';
import raw from '../templates/tcg-pack.json';
it('adds stable field-evidence and Field Visit blocks against the existing typed Field Log',()=>{
 const pack=toBundled('tcg-pack',raw as unknown as AuthorTemplate);expect(pack.version).toBeGreaterThanOrEqual(6);
 expect(pack.snapshot.blocks!.field_evidence_sessions).toMatchObject({type:'fieldsessions',pageId:'pg_field_evidence',databaseId:'db_fieldlog',limit:10});expect(pack.snapshot.blocks!.field_evidence_measurements).toMatchObject({type:'measurechart',databaseId:'db_fieldlog',unit:''});expect(pack.snapshot.blocks!.field_visit_sessions).toMatchObject({missingOnly:true,limit:5});expect(pack.snapshot.pages!.pg_field_evidence.parentId).toBe('pg_commonlab');
});
it('copies field configuration without pulling live source databases or dropping references',()=>{
 const pack=toBundled('tcg-pack',raw as unknown as AuthorTemplate),block={...pack.snapshot.blocks!.field_evidence_measurements,placeId:'place-old',experimentId:'experiment-old',unit:'kg',dateKey:'p_other',measurementKey:'p_value'};expect(boardRefsOf(block)).toEqual([]);
 const plan=planTemplateInstantiation({...pack.snapshot,blocks:{field_evidence_measurements:block}},{templateId:'pg_field_evidence'},{id:()=>crypto.randomUUID(),now:1})!;
 expect(plan.writes.filter(w=>['boards','tasks'].includes(w.collection))).toEqual([]);expect(plan.writes.find(w=>w.collection==='blocks')?.patch).toMatchObject({type:'measurechart',databaseId:'db_fieldlog',placeId:'place-old',experimentId:'experiment-old',unit:'kg',dateKey:'p_other',measurementKey:'p_value'});
});
it('preserves team edits and deleted block reservations on additive upgrade',()=>{
 const pack=toBundled('tcg-pack',raw as unknown as AuthorTemplate),plan=planTemplateInstantiation(pack.snapshot,{templateId:pack.root,templateKey:pack.key,packInstall:true,stableIds:true},{id:()=>crypto.randomUUID(),now:1})!,rows=plan.writes.map(w=>({id:w.id,collection:w.collection,data:{...w.patch}})),block=rows.find(r=>r.data.templateItemKey==='field_evidence_sessions')!;
 block.data.deleted=true;block.data.heading='Team visit review';rows.find(r=>r.data.templateKey==='tcg-pack')!.data.templateVersion=5;expect(planPackUpgrade(pack,rows).writes.some(w=>w.id===block.id)).toBe(false);expect(block.data).toMatchObject({deleted:true,heading:'Team visit review'});
});
