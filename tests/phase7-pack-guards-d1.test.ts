import {afterEach,describe,it,expect} from 'vitest';
import {openAuditFixture,type AuditFixture} from './audit-fixture';
import {applyChanges} from '../worker/sync';
import {interceptRecordWrites} from './d1WriteBoundary';
import {withD1Budget,d1BudgetRemaining} from '../worker/d1budget';
let f:AuditFixture;
afterEach(async()=>f?.dispose());
const fields=[{id:'money',name:'Budget',type:'number'}],upgraded=[{...fields[0],format:'currency'}];
async function setup(enabled:boolean){f=await openAuditFixture();await f.db.prepare('UPDATE access_state SET enabled=?').bind(enabled?1:0).run();await applyChanges(f.env,'alice',[{id:'pack-board',collection:'boards',ts:0,patch:{name:'Projects',fields}}],{serverTs:true});}
const data=async()=>JSON.parse((await f.db.prepare("SELECT data FROM records WHERE id='pack-board'").first<string>('data'))!);
describe.each([false,true])('guarded additive upgrade permissions=%s',enabled=>{
 it('accepts the exact baseline and acknowledges a lost-response replay without rewriting',async()=>{
  await setup(enabled);const mutation={id:'pack-board',collection:'boards',patch:{fields:upgraded},ts:Date.now()+1,ifUnchanged:{fields:{fields}}};
  const env=withD1Budget(f.env);expect(await applyChanges(env,'alice',[mutation])).toMatchObject({changed:1,rejected:0});
  const seq=await f.db.prepare("SELECT seq FROM records WHERE id='pack-board'").first('seq');
  expect(await applyChanges(f.env,'alice',[mutation])).toMatchObject({changed:0,rejected:0});expect(await f.db.prepare("SELECT seq FROM records WHERE id='pack-board'").first('seq')).toBe(seq);
  expect(45-d1BudgetRemaining(env.DB)).toBeLessThanOrEqual(45);
 });
 it('refuses stale fields and preserves a concurrent human currency or option edit',async()=>{
  await setup(enabled);const human=[{...fields[0],name:'Human budget',format:'currency',currency:'USD'}];
  await applyChanges(f.env,'alice',[{id:'pack-board',collection:'boards',patch:{fields:human},ts:0}],{serverTs:true});
  const result=await applyChanges(f.env,'alice',[{id:'pack-board',collection:'boards',patch:{fields:upgraded},ts:Date.now()+2,ifUnchanged:{fields:{fields}}}]);
  expect(result.rejectedItems).toContainEqual({id:'pack-board',collection:'boards',reason:'source_changed_refresh_preview'});expect((await data()).fields).toEqual(human);
 });
 it('cannot overwrite a human edit racing the actual commit',async()=>{
  await setup(enabled);let injected=false;const human=[{...fields[0],name:'Racing budget'}];
  const db=interceptRecordWrites(f.db,async(t,statements)=>{if(!injected){injected=true;await applyChanges(f.env,'alice',[{id:'pack-board',collection:'boards',patch:{fields:human},ts:0}],{serverTs:true});}return t.batch(statements);});
  await applyChanges({...f.env,DB:db},'alice',[{id:'pack-board',collection:'boards',patch:{fields:upgraded},ts:Date.now()+2,ifUnchanged:{fields:{fields}}}]);
  expect(injected).toBe(true);expect((await data()).fields).toEqual(human);
 });
 it('does not revive tombstones or treat a changed later value as an exact replay',async()=>{
  await setup(enabled);await applyChanges(f.env,'alice',[{id:'reserved',collection:'pages',patch:{title:'Deleted page',deleted:true},ts:0}],{serverTs:true});
  const result=await applyChanges(f.env,'alice',[{id:'reserved',collection:'pages',patch:{title:'New page'},ts:Date.now()+1,ifUnchanged:{absent:true}}]);
  expect(result.rejected).toBe(1);expect(await f.db.prepare("SELECT json_extract(data,'$.deleted') FROM records WHERE id='reserved'").first("json_extract(data,'$.deleted')")).toBe(1);
 });
});
