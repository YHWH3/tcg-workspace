import {it,expect} from 'vitest';
import {toBundled,planPackUpgrade,type AuthorTemplate} from '../shared/bundled';
import {planTemplateInstantiation} from '../shared/templates';
import {attentionConfig} from '../shared/attention';
import {WEBSITE_INBOX_BOARD} from '../shared/websiteInbox';
import raw from '../templates/tcg-pack.json';
const author:AuthorTemplate={version:3,name:'Attention fixture',description:'Synthetic',icon:'A',databases:[{id:'db',key:'example',name:'Example',kind:'records',fields:[{id:'owner',name:'Owner',type:'person'},{id:'date',name:'Date',type:'date'}],attention:{enabled:true,personKey:'p_owner',dateKey:'p_date'}}],pages:[{id:'home',title:'Home',blocks:[{type:'attention',limit:5,kinds:['record_overdue'],compact:true}]}]};
function setup(){const pack=toBundled('attention-fixture',author),plan=planTemplateInstantiation(pack.snapshot,{templateId:pack.root,templateKey:pack.key,packInstall:true,stableIds:true},{id:()=>crypto.randomUUID(),now:1})!;return {pack,rows:plan.writes.map(w=>({id:w.id,collection:w.collection,data:{...w.patch}}))};}
it('compiles configured fields and attention block options',()=>{const {pack,rows}=setup();expect(rows.find(r=>r.collection==='blocks'&&r.data.type==='attention')?.data).toMatchObject({limit:5,kinds:['record_overdue'],compact:true});expect(pack.snapshot.boards?.db.attention).toMatchObject(author.databases[0].attention!);expect(Object.values(pack.snapshot.blocks??{}).find(b=>b.type==='attention')).toMatchObject({limit:5,kinds:['record_overdue'],compact:true});});
it('adds missing attention configuration with a guard and leaves every team setting intact',()=>{
 const {pack,rows}=setup(),board=rows.find(r=>r.collection==='boards')!;delete board.data.attention;const p=planPackUpgrade(pack,rows);expect(p.writes.find(w=>w.id===board.id)).toMatchObject({patch:{attention:author.databases[0].attention},before:{attention:null}});
 for(const own of [null,{enabled:false,personKey:'assigneeId'},{enabled:true,personKey:'p_owner',dateKey:'dueDate',soonDays:20}]){board.data.attention=own;expect(planPackUpgrade(pack,rows).writes.some(w=>w.id===board.id)).toBe(false);expect(board.data.attention).toEqual(own);}
});
it('holds invalid changed field types instead of adding a broken config or claiming the pack version complete',()=>{
 const {pack,rows}=setup(),board=rows.find(r=>r.collection==='boards')!,root=rows.find(r=>r.collection==='pages')!;delete board.data.attention;root.data.templateVersion=2;board.data.fields=[{id:'owner',name:'Our owner',type:'text'},{id:'date',name:'Date',type:'date'}];
 const plan=planPackUpgrade(pack,rows);expect(plan.warnings.join(' ')).toContain('Attention fields changed');expect(plan.writes.some(w=>w.patch.attention||w.patch.templateVersion)).toBe(false);
});
it('uses verified TCG field ids and the admin Website triage default',()=>{
 const pack=toBundled('tcg-pack',raw as unknown as AuthorTemplate);expect(pack.version).toBeGreaterThanOrEqual(3);
 for(const id of ['db_opportunities','db_decisions','db_media'])expect(attentionConfig(pack.snapshot.boards![id])).toMatchObject({enabled:true});
 expect(attentionConfig(WEBSITE_INBOX_BOARD)).toMatchObject({enabled:true,personKey:'assigneeId',dateKey:'dueDate',triage:true,triagers:'admins'});
});
