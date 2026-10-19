import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {openAuditFixture,type AuditFixture} from './audit-fixture';
import {proposePreview,executePreview,aiPreviewApi} from '../worker/aiPreviews';
import {withReadGate} from '../worker/readAccess';
import {applyChanges} from '../worker/sync';
import {withD1Budget} from '../worker/d1budget';
vi.mock('../worker/events',async original=>({...await original<typeof import('../worker/events')>(),scheduleOutbox:vi.fn()}));
let f:AuditFixture;
beforeEach(async()=>{f=await openAuditFixture();await f.db.batch([
 f.db.prepare('UPDATE access_state SET enabled=1'),
 f.db.prepare("INSERT INTO ai_connections(id,user_id,client_id,spaces_json,created_at,expires_at) VALUES('c','alice','x','[\"space-core\"]',1,?)").bind(Date.now()+1000000),
 f.db.prepare(`INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES('p','pages','{"title":"Before"}','{}',1,'space-core')`),
]);});
afterEach(async()=>f.dispose());
const env=()=>withReadGate({...f.env,CONNECTOR:{id:'c',version:1}},'alice');
async function propose(){return proposePreview(env(),'alice','edit_page',{title:'After'},[{id:'p',collection:'pages',patch:{title:'After'}}],'weekly');}
async function decision(id:string,hash:string,user='alice',kind='approve'){return aiPreviewApi.request(`http://localhost/${id}/decision`,{method:'POST',headers:f.auth(user),body:JSON.stringify({decision:kind,argsHash:hash})},f.env,f.ctx);}
describe('Human-reviewed frozen plans — real D1, permissions ENABLED',()=>{
 it('requires a real session decision and preserves exactly-once journal on replay',async()=>{
  const p=await propose();await expect(executePreview(env(),'alice',p.previewId,p.argsHash)).rejects.toThrow('human_approval_required');
  expect((await decision(p.previewId,p.argsHash,'bob')).status).toBe(404);
  expect((await decision(p.previewId,p.argsHash)).status).toBe(200);
  const r=await executePreview(env(),'alice',p.previewId,p.argsHash);expect(r.completed).toBe(true);
  expect(await executePreview(env(),'alice',p.previewId,p.argsHash)).toMatchObject({completed:true,replayed:true,changesetId:r.changesetId});
  expect((await f.db.prepare('SELECT COUNT(*) n FROM changeset_items WHERE changeset_id=?').bind(r.changesetId).first<{n:number}>())?.n).toBe(1);
  expect((await f.db.prepare('SELECT COUNT(*) n FROM ai_workflow_changesets').first<{n:number}>())?.n).toBe(1);
 });
 it('does not accept changed args, another connection or approval by the MCP bearer',async()=>{
  const p=await propose();await decision(p.previewId,p.argsHash);
  await expect(executePreview(env(),'alice',p.previewId,'forged')).rejects.toThrow('preview_arguments_changed');
  await expect(executePreview({...env(),CONNECTOR:{id:'other',version:1}},'alice',p.previewId,p.argsHash)).rejects.toThrow('preview_connection_changed');
  const r=await aiPreviewApi.request(`http://localhost/${p.previewId}/decision`,{method:'POST',headers:{authorization:'Bearer fake-oauth', 'content-type':'application/json'},body:JSON.stringify({decision:'approve',argsHash:p.argsHash})},f.env,f.ctx);expect(r.status).toBe(401);
 });
 it('refuses changed revisions rather than overwriting a human edit',async()=>{
  const p=await propose();await decision(p.previewId,p.argsHash);
  await applyChanges(f.env,'alice',[{id:'p',collection:'pages',patch:{title:'Human'},ts:0}],{serverTs:true});
  await expect(executePreview(env(),'alice',p.previewId,p.argsHash)).rejects.toThrow();
  expect((await f.db.prepare("SELECT json_extract(data,'$.title') title FROM records WHERE id='p'").first<{title:string}>())?.title).toBe('Human');
 });
 it.each(['expired','cancelled','revoked','session-ended'])('refuses %s approval execution',async mode=>{
  const p=await propose();await decision(p.previewId,p.argsHash,'alice',mode==='cancelled'?'cancel':'approve');
  if(mode==='expired')await f.db.prepare('UPDATE ai_previews SET expires_at=1').run();
  if(mode==='revoked')await f.db.prepare('UPDATE ai_connections SET revoked_at=1').run();
  if(mode==='session-ended')await f.db.prepare("DELETE FROM sessions WHERE user_id='alice'").run();
  await expect(executePreview(env(),'alice',p.previewId,p.argsHash)).rejects.toThrow();
  expect((await f.db.prepare("SELECT seq FROM records WHERE id='p'").first<{seq:number}>())?.seq).toBe(1);
 });
 it('permits one concurrent decision and one executor',async()=>{
  const p=await propose();const decisions=await Promise.all([decision(p.previewId,p.argsHash),decision(p.previewId,p.argsHash)]);expect(decisions.map(r=>r.status).sort()).toEqual([200,409]);
  const outcomes=await Promise.allSettled([executePreview(env(),'alice',p.previewId,p.argsHash),executePreview(env(),'alice',p.previewId,p.argsHash)]);expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 });
 it('resumes bounded batches after losing a response without repeating inverse-sensitive writes',async()=>{
  const ops=Array.from({length:150},(_,i)=>({id:'new'+i,collection:'pages' as const,patch:{title:'New '+i}}));
  const p=await proposePreview(env(),'alice','meeting_to_actions',{meeting:'m'},ops);await decision(p.previewId,p.argsHash);
  let r=await executePreview(withD1Budget(env(),25),'alice',p.previewId,p.argsHash);expect(r.completed).toBe(false);expect(r.processed).toBeGreaterThan(0);
  r=await executePreview(env(),'alice',p.previewId,p.argsHash);expect(r.completed).toBe(true);
  expect((await f.db.prepare('SELECT COUNT(*) n FROM changeset_items WHERE changeset_id=?').bind(r.changesetId).first<{n:number}>())?.n).toBe(150);
 });
});

it('fences source revision and membership in the same commit as derived writes',async()=>{
 const p=await proposePreview(env(),'alice','meeting_to_actions',{source:'p'},[{id:'derived',collection:'pages',patch:{title:'Derived confidential notes'}}],'race',['p']);await decision(p.previewId,p.argsHash);
 const original=f.db;let injected=false;
 const faulty=new Proxy(original,{get(t,k){if(k==='batch')return async(statements:D1PreparedStatement[])=>{if(!injected&&statements.some(s=>String((s as unknown as {statement:string}).statement).includes('INSERT OR IGNORE INTO ai_preview_done'))){injected=true;await original.prepare("INSERT INTO space_members(space_id,user_id,role,access) VALUES('space-core','alice','viewer','deny') ON CONFLICT(space_id,user_id) DO UPDATE SET access='deny'").run();}return t.batch(statements);};const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;}});
 await expect(executePreview({...env(),DB:faulty,READ_GATE:undefined},'alice',p.previewId,p.argsHash)).rejects.toThrow();expect(injected).toBe(true);expect(await f.db.prepare("SELECT COUNT(*) n FROM records WHERE id='derived'").first('n')).toBe(0);
});
it('requires a new preview after source content changes, even with unchanged membership',async()=>{
 const p=await proposePreview(env(),'alice','draft_case_study',{source:'p'},[{id:'draft',collection:'pages',patch:{title:'Draft'}}],undefined,['p']);await decision(p.previewId,p.argsHash);await applyChanges(f.env,'alice',[{id:'p',collection:'pages',patch:{title:'New evidence'},ts:0}],{serverTs:true});
 await expect(executePreview(env(),'alice',p.previewId,p.argsHash)).rejects.toThrow();expect(await f.db.prepare("SELECT COUNT(*) n FROM records WHERE id='draft'").first('n')).toBe(0);
});
it('keeps unmodified source children valid across its own multi-batch parent update',async()=>{
 await f.db.prepare(`INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES('source-child','blocks','{"pageId":"p","type":"p","text":"Evidence"}','{}',2,'space-core')`).run();
 const ops=[{id:'p',collection:'pages' as const,patch:{title:'Updated parent'}},...Array.from({length:100},(_,i)=>({id:'body'+i,collection:'blocks' as const,patch:{pageId:'p',type:'p',text:'Planned '+i}}))];const p=await proposePreview(env(),'alice','edit_page',{},ops,undefined,['source-child']);await decision(p.previewId,p.argsHash);expect((await executePreview(env(),'alice',p.previewId,p.argsHash)).completed).toBe(true);
});
it('does not claim completion if undo cancels the lease after the final committed record',async()=>{
 const p=await propose();await decision(p.previewId,p.argsHash);const original=f.db;let injected=false;
 const faulty=new Proxy(original,{get(t,k){if(k==='batch')return async(stmts:D1PreparedStatement[])=>{if(!injected&&stmts.some(s=>String((s as unknown as {statement:string}).statement).includes("SET status='completed'"))){injected=true;await original.prepare("UPDATE ai_previews SET status='cancelled',lease_id=NULL WHERE id=?").bind(p.previewId).run();}return t.batch(stmts);};const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;}});
 await expect(executePreview({...env(),DB:faulty,READ_GATE:undefined},'alice',p.previewId,p.argsHash)).rejects.toThrow();expect(injected).toBe(true);expect(await original.prepare('SELECT status FROM ai_previews WHERE id=?').bind(p.previewId).first('status')).toBe('cancelled');
});
it('group recovery includes committed partial previews and fences their continuation',async()=>{
 const p=await proposePreview(env(),'alice','meeting_to_actions',{},Array.from({length:150},(_,i)=>({id:'partial'+i,collection:'pages' as const,patch:{title:'Partial '+i}})),'partial-workflow');await decision(p.previewId,p.argsHash);
 const first=await executePreview(withD1Budget(env(),25),'alice',p.previewId,p.argsHash);expect(first.completed).toBe(false);expect(first.processed).toBeGreaterThan(0);
 const response=await aiPreviewApi.request('/workflows/partial-workflow/undo',{method:'POST',headers:f.auth('alice')},f.env,f.ctx);expect(response.status).toBe(200);const body=await response.json() as {results:{ok:boolean}[]};expect(body.results).toHaveLength(1);expect(body.results[0].ok).toBe(true);await expect(executePreview(env(),'alice',p.previewId,p.argsHash)).rejects.toThrow();expect(await f.db.prepare("SELECT COUNT(*) n FROM records WHERE id LIKE 'partial%' AND COALESCE(json_extract(data,'$.deleted'),0)!=1").first('n')).toBe(0);
});
