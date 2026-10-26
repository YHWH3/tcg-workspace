import {expect,it} from 'vitest';
import * as bundled from '../shared/bundled';
import {planTemplateInstantiation} from '../shared/templates';
const author:bundled.AuthorTemplate={name:'Pack',description:'Fixture',icon:'P',databases:[{id:'db',key:'projects',name:'Projects',fields:[{id:'budget',name:'Budget',type:'number',format:'currency'}],views:[{id:'all',name:'All',type:'table',config:{filters:[]}}]}],pages:[{id:'home',title:'Home',blocks:[{type:'metric',label:'Budget',databaseId:'db',fieldKey:'p_budget',agg:'sum'}]}]};
function setup(){const pack=bundled.toBundled('test-pack',author);const installed=planTemplateInstantiation(pack.snapshot,{templateId:pack.root,templateKey:pack.key,packInstall:true,stableIds:true},{id:()=>crypto.randomUUID(),now:1})!;return {pack,rows:installed.writes.map(w=>({id:w.id,collection:w.collection,data:{...w.patch}}))};}
const planner=()=> (bundled as unknown as {planPackUpgrade:(bundle:bundled.BundledTemplate,existing:any[])=>{writes:any[];warnings:string[];rootPageId:string}}).planPackUpgrade;
it('preserves renamed views, edited filters, explicit currency, stages and tombstoned blocks',()=>{
 const {pack,rows}=setup();const board=rows.find(r=>r.collection==='boards')!,view=rows.find(r=>r.collection==='views')!,block=rows.find(r=>r.collection==='blocks')!;
 board.data.fields=[{id:'budget',name:'Edited budget',type:'number',format:'currency',currency:'USD'}];board.data.columns=[{id:'mine',name:'My stage'}];view.data.name='My own view';view.data.config={filters:[{key:'title',op:'contains',value:'mine'}]};block.data.deleted=true;
 const before=structuredClone(rows),plan=planner()(pack,rows);expect(rows).toEqual(before);expect(plan.writes.every(w=>!['tasks','links'].includes(w.collection))).toBe(true);
 expect(plan.writes.filter(w=>[view.id,block.id,board.id].includes(w.id))).toEqual([]);
});
it('adds only missing fields/options/formats and missing items, then produces an empty second plan',()=>{
 const {pack,rows}=setup();const board=rows.find(r=>r.collection==='boards')!;board.data.fields=[{id:'budget',name:'My budget',type:'number'}];
 const view=rows.find(r=>r.collection==='views')!;rows.splice(rows.indexOf(view),1);
 const plan=planner()(pack,rows);expect(plan.writes.some(w=>w.id===board.id&&w.patch.fields[0].format==='currency')).toBe(true);expect(plan.writes.some(w=>w.collection==='views')).toBe(true);expect(plan.writes.every(w=>typeof w.reason==='string'&&w.reason.length>0)).toBe(true);
 for(const w of plan.writes){const old=rows.find(r=>r.id===w.id);if(old)Object.assign(old.data,w.patch);else rows.push({id:w.id,collection:w.collection,data:{...w.patch}});}
 expect(planner()(pack,rows).writes).toEqual([]);
});
it('holds ambiguous legacy identities, preserves archived parents and never adds under deleted ancestors',()=>{
 const {pack,rows}=setup();const root=rows.find(r=>r.collection==='pages')!;
 root.data.archived=true;expect(planner()(pack,rows).writes).toEqual([]);
 root.data.archived=false;
 const board=rows.find(r=>r.collection==='boards')!;rows.splice(rows.indexOf(board),1);
 rows.push({id:'legacy1',collection:'boards',data:{templateDbKey:'projects'}},{id:'legacy2',collection:'boards',data:{templateDbKey:'projects'}});
 const plan=planner()(pack,rows);expect(plan.warnings.join(' ')).toContain('Ambiguous');expect(plan.writes.some(w=>w.collection==='boards'||w.patch.templateVersion!==undefined)).toBe(false);
});
it('appends missing options without renaming existing options or fields',()=>{
 const changed=structuredClone(author);changed.databases[0].fields!.push({id:'kind',name:'Kind',type:'select',options:[{id:'a',name:'Authored A',color:'gray'},{id:'b',name:'B',color:'blue'}]});
 const {rows}=setup(),board=rows.find(r=>r.collection==='boards')!;
 (board.data.fields as any[]).push({id:'kind',name:'Our kind',type:'select',options:[{id:'a',name:'Our A'}]});
 const plan=planner()(bundled.toBundled('test-pack',changed),rows),fields=plan.writes.find(w=>w.id===board.id).patch.fields;
 expect(fields.find((f:any)=>f.id==='kind')).toMatchObject({name:'Our kind',options:[{id:'a',name:'Our A'},{id:'b',name:'B',color:'blue'}]});
});
it('holds an installation newer than the application bundle',()=>{
 const {pack,rows}=setup();rows.find(r=>r.collection==='pages')!.data.templateVersion=100;
 expect(planner()(pack,rows)).toMatchObject({writes:[],warnings:[expect.stringContaining('newer pack version')]});
});
