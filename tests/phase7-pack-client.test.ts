import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {toBundled,planPackUpgrade,type AuthorTemplate,type PackRecord} from '../shared/bundled';
import {planTemplateInstantiation} from '../shared/templates';
const mock=vi.hoisted(()=>({uid:'alice',token:'token-a',rows:new Map<string,any[]>(),pending:[] as any[],writes:[] as any[],failure:false,switchAccount:false}));
vi.mock('../src/core/auth',()=>({authStore:{get:()=>({user:{id:mock.uid}})}}));
vi.mock('../src/core/api',()=>({getToken:()=>mock.token}));
vi.mock('../src/core/db',()=>{
 const table=(c:string)=>({toArray:async()=>mock.rows.get(c)??[],bulkGet:async(ids:string[])=>ids.map(id=>(mock.rows.get(c)??[]).find(r=>r.id===id)),where:(key:string)=>({anyOf:(ids:string[])=>({limit:()=>({toArray:async()=>(mock.rows.get(c)??[]).filter(r=>ids.includes(r[key]))})})})});
 return {db:{get name(){return 'workspace-'+mock.uid;},boards:table('boards'),collection:table,outbox:{toArray:async()=>mock.pending},transaction:async(_mode:unknown,_tables:unknown,fn:()=>unknown)=>fn()}};
});
vi.mock('../src/core/sync/engine',()=>({mutate:async(collection:string,id:string,patch:any,guard:any)=>{mock.writes.push({collection,id,patch,guard});const rows=mock.rows.get(collection)??[],old=rows.find(r=>r.id===id);if(old)Object.assign(old,patch);else rows.push({id,...patch});mock.rows.set(collection,rows);mock.pending.push({id,state:'pending'});},syncNow:async()=>{if(mock.switchAccount){mock.uid='bob';return;}if(mock.failure&&mock.pending.length)mock.pending=mock.pending.map(r=>({...r,state:'rejected'}));else mock.pending=[];}}));
import {applyLocalPackUpgrade} from '../src/core/packUpgrades';
const author:AuthorTemplate={version:2,name:'Pack',description:'Fixture',icon:'P',databases:[{id:'db',key:'project',name:'Projects',fields:[{id:'money',name:'Amount',type:'number',format:'currency'}]}],pages:[{id:'root',title:'Home'}]};
const bundle=toBundled('fixture',author);
let records:PackRecord[];
beforeEach(()=>{
 mock.uid='alice';mock.token='token-a';mock.rows.clear();mock.pending=[];mock.writes=[];mock.failure=false;mock.switchAccount=false;vi.stubGlobal('navigator',{onLine:true});
 const installed=planTemplateInstantiation(bundle.snapshot,{templateId:bundle.root,templateKey:bundle.key,stableIds:true,packInstall:true,actorId:'alice'},{id:()=>crypto.randomUUID(),now:1})!;
 records=installed.writes.map(w=>({id:w.id,collection:w.collection,data:{...w.patch}}));
 records.find(r=>r.collection==='boards')!.data.fields=[{id:'money',name:'Our amount',type:'number'}];records.find(r=>r.collection==='pages')!.data.templateVersion=1;
 for(const r of records)mock.rows.set(r.collection,[...(mock.rows.get(r.collection)??[]),{id:r.id,...structuredClone(r.data)}]);
});
afterEach(()=>vi.unstubAllGlobals());
it('enqueues the version marker only after additions are acknowledged',async()=>{
 const preview=planPackUpgrade(bundle,records,{actorId:'alice'});await applyLocalPackUpgrade(bundle,preview);
 expect(mock.writes.map(w=>w.collection)).toEqual(['boards','pages']);expect(mock.writes[0].guard.fields.fields[0].format).toBeUndefined();expect(mock.writes[1].patch.templateVersion).toBe(2);
});
it('retains version 1 when an addition is refused and exposes recovery',async()=>{
 mock.failure=true;const preview=planPackUpgrade(bundle,records,{actorId:'alice'});
 await expect(applyLocalPackUpgrade(bundle,preview)).rejects.toThrow('review in sync recovery');
 expect(mock.writes).toHaveLength(1);expect(mock.rows.get('pages')![0].templateVersion).toBe(1);expect(mock.pending[0].state).toBe('rejected');
});
it('refuses a changed preview and a replaced account before writing',async()=>{
 const preview=planPackUpgrade(bundle,records,{actorId:'alice'});mock.rows.get('boards')![0].fields[0].currency='USD';
 await expect(applyLocalPackUpgrade(bundle,preview)).rejects.toThrow('Pack source changed');expect(mock.writes).toEqual([]);
 mock.switchAccount=true;await expect(applyLocalPackUpgrade(bundle,preview)).rejects.toThrow('Account changed');expect(mock.writes).toEqual([]);
});
it('requires connectivity and preserves the existing local installation',async()=>{
 vi.stubGlobal('navigator',{onLine:false});await expect(applyLocalPackUpgrade(bundle,planPackUpgrade(bundle,records))).rejects.toThrow('Connect to update');expect(mock.writes).toEqual([]);
});
