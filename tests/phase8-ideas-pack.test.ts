import {it,expect} from 'vitest';
import raw from '../templates/tcg-pack.json';
import {toBundled,planPackUpgrade,type AuthorTemplate} from '../shared/bundled';
import {planTemplateInstantiation,installRecordId} from '../shared/templates';
import {applyView,type ViewConfig} from '../shared/views';
const pack=toBundled('tcg-pack',raw as unknown as AuthorTemplate);
it('adds honest review queues and Creator attention without a date',()=>{
 expect(pack.version).toBeGreaterThanOrEqual(9);expect(pack.snapshot.boards!.db_ideas.attention).toMatchObject({enabled:true,personKey:'p_f_creator'});expect(pack.snapshot.boards!.db_ideas.attention).not.toHaveProperty('dateKey');
 const rows=[{id:'review',status:'review'},{id:'approved',status:'approved'},{id:'linked',status:'approved'},{id:'old',status:'parked',createdAt:Date.parse('2026-09-01')},{id:'new',status:'parked',createdAt:Date.parse('2026-11-01')},{id:'missing',status:'parked'},{id:'archived',status:'review',archived:true}];
 const context={today:'2026-11-02',relationTitles:(id:string)=>id==='linked'?['Project']:[]};
 const ids=(key:string)=>applyView(rows,pack.snapshot.views![key].config as ViewConfig,context).rows.map(r=>r.id);
 expect(ids('v_ideas_review')).toEqual(['review']);expect(ids('v_ideas_approved')).toEqual(['approved']);expect(ids('v_ideas_parked_old')).toEqual(['old']);
 expect(JSON.stringify(raw.pages.find(p=>p.id==='pg_ideas'))).toContain('creation age, not time spent parked');
});
it('adds v9 queues without replacing edited or intentionally deleted v8 content',()=>{
 const plan=planTemplateInstantiation(pack.snapshot,{templateId:pack.root,templateKey:pack.key,packInstall:true,stableIds:true},{id:()=>crypto.randomUUID(),now:1})!;
 const additions=new Set(['v_ideas_review','v_ideas_parked_old','v_ideas_approved','ideas_review_heading','ideas_review_note','ideas_review_desk','ideas_parked_old_desk','ideas_approved_desk']);
 const rows=plan.writes.filter(w=>!additions.has(String(w.patch.templateItemKey))).map(w=>({id:w.id,collection:w.collection,data:{...w.patch}}));
 const ideas=rows.find(r=>r.data.templateDbKey==='ideas')!;ideas.data.name='Team Ideas';ideas.data.attention={enabled:false,personKey:'p_f_creator'};
 const page=rows.find(r=>r.data.templateItemKey==='pg_ideas')!;page.data.title='Our Ideas';
 const deleted={id:installRecordId(pack.key,'blocks','ideas_review_note'),collection:'blocks' as const,data:{deleted:true,templateItemKey:'ideas_review_note'}};rows.push(deleted);
 const upgrade=planPackUpgrade(pack,rows);
 expect(upgrade.writes.some(w=>[ideas.id,page.id,deleted.id].includes(w.id))).toBe(false);expect(upgrade.writes.some(w=>w.patch.templateItemKey==='v_ideas_review')).toBe(true);
});
