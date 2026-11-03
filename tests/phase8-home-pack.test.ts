import {it,expect} from 'vitest';
import raw from '../templates/tcg-pack.json';
import {toBundled,planPackUpgrade,type AuthorTemplate} from '../shared/bundled';
import {planTemplateInstantiation,installRecordId} from '../shared/templates';
import {evalFilter,type Filter} from '../shared/views';
const pack=toBundled('tcg-pack',raw as unknown as AuthorTemplate);
it('authors the four ordered Home sections using generic blocks and all four calendar sources',()=>{
 const home=Object.values(pack.snapshot.blocks!).filter(b=>b.pageId==='pg_command_center');
 expect(home.filter(b=>b.type==='h2').map(b=>b.text)).toEqual(['Needs attention','My execution','Coming up','What changed']);
 expect(home[1]).toMatchObject({type:'attention',minimumSeverity:1,limit:10});
 expect(home.find(b=>b.type==='mywork')).toMatchObject({heading:'My open work'});
 expect(pack.snapshot.views!.v_home_my_projects).toMatchObject({databaseId:'db_projects',type:'list',config:{filters:[{key:'p_f_owner',op:'me'}]}});
 expect(home.find(b=>b.type==='calendar')!.sources).toHaveLength(4);
 expect(['alice','bob'].map(owner=>evalFilter({p_f_owner:owner},{key:'p_f_owner',op:'me'},{meId:'alice'}))).toEqual([true,false]);
 expect(home.find(b=>b.heading==='Pending AI review')).toMatchObject({type:'attention',kinds:['ai_preview_pending','suggestion_pending'],limit:5,compact:true});
});
it('installs live Home references and preserves urgency when the page is copied',()=>{
 const p=planTemplateInstantiation(pack.snapshot,{templateId:pack.root,templateKey:pack.key,packInstall:true,stableIds:true},{id:()=>crypto.randomUUID(),now:1})!;
 const attention=p.writes.find(w=>w.patch.templateItemKey==='command_home_attention')!;
 expect(attention.patch.minimumSeverity).toBe(1);
 const projects=p.writes.find(w=>w.patch.templateItemKey==='command_home_my_projects')!;
 expect(projects.patch.databaseId).toBe(installRecordId(pack.key,'boards','db_projects'));
 expect(projects.patch.viewId).toBe(installRecordId(pack.key,'views','v_home_my_projects'));
 const calendar=p.writes.find(w=>w.patch.templateItemKey==='command_tpl_8')!;
 expect(JSON.stringify(calendar.patch.sources)).not.toContain('"db_');
});
it('uses one inclusive within range for the Home opportunity deadline metric',()=>{
 const metric=pack.snapshot.blocks!.command_tpl_6;
 expect(metric.filters).toEqual([{key:'p_f_deadline',op:'within',value:{from:'today',to:'today+30'}},{key:'status',op:'is_not',value:'won'},{key:'status',op:'is_not',value:'lost'}]);
 const range=(metric.filters as Filter[])[0];
 expect(['2026-11-02','2026-11-03','2026-12-03','2026-12-04'].map(date=>evalFilter({p_f_deadline:date},range,{today:'2026-11-03'}))).toEqual([false,true,true,false]);
});

it('adds a separate command center and preserves every customized, reordered or deleted Home block',()=>{
 const plan=planTemplateInstantiation(pack.snapshot,{templateId:pack.root,templateKey:pack.key,packInstall:true,stableIds:true},{id:()=>crypto.randomUUID(),now:1})!;
 const rows=plan.writes.filter(w=>w.patch.templateItemKey!=='pg_command_center'&&!String(w.patch.templateItemKey??'').startsWith('command_')).map(w=>({id:w.id,collection:w.collection,data:{...w.patch}}));
 const root=rows.find(r=>r.id===plan.rootPageId)!;root.data.templateVersion=10;
 const homeIds=new Set(rows.filter(r=>r.collection==='blocks'&&r.data.pageId===root.id).map(r=>r.id));
 for(const r of rows.filter(r=>homeIds.has(r.id))){r.data.heading='Team heading';r.data.order='custom-'+r.id;}
 rows.find(r=>homeIds.has(r.id))!.data.deleted=true;
 const upgrade=planPackUpgrade(pack,rows);expect(upgrade.warnings).toEqual([]);expect(upgrade.writes.some(w=>homeIds.has(w.id))).toBe(false);
 expect(upgrade.writes.filter(w=>w.collection==='pages'&&w.before===null).map(w=>w.patch.title)).toEqual(['Daily command center']);
 const after=[...rows];for(const w of upgrade.writes){const old=after.find(r=>r.id===w.id);if(old)Object.assign(old.data,w.patch);else after.push({id:w.id,collection:w.collection,data:w.patch});}
 expect(planPackUpgrade(pack,after).writes).toEqual([]);
});
