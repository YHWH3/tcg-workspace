import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {applyChanges} from '../worker/sync';
import {beginChangeset,undoChangeset} from '../worker/changesets';
import {files} from '../worker/files';
import {sha256Hex} from '../worker/password';
import type {Env,AuthUser} from '../worker/auth';
vi.mock('../worker/events',async original=>({...await original<typeof import('../worker/events')>(),scheduleOutbox:vi.fn()}));
let mf:Miniflare,db:D1Database,env:Env;
const user={id:'alice',role:'admin'} as AuthUser;
const ctx={waitUntil:()=>{},passThroughOnException:()=>{}} as unknown as ExecutionContext;
beforeEach(async()=>{
 mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'integrity',modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-09-25',d1Databases:{DB:'integrity-disposable'}}]}));
 db=await mf.getD1Database('DB') as D1Database;env={DB:db} as Env;
 const dir=fileURLToPath(new URL('../migrations/',import.meta.url));
 for(const f of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())await db.batch((readFileSync(`${dir}/${f}`,'utf8').replace(/--[^\n]*/g,'').match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi)??[]).map(s=>db.prepare(s.trim())));
 await db.prepare("INSERT INTO users(id,username,name,role) VALUES('alice','alice','Alice','admin')").run();
 await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await sha256Hex('integrity-session'),'alice',Date.now()+86400000,1).run();
});
afterEach(()=>mf.dispose());
const change=(id:string,patch:Record<string,unknown>,collection='pages')=>({id,collection,patch,ts:Date.now()});
async function binary(id:string){await db.batch([db.prepare('INSERT INTO files(id,uploaded_by,created_at,size,chunks,complete) VALUES(?,?,1,3,1,1)').bind(id,'alice'),db.prepare('INSERT INTO file_chunks(file_id,idx,data) VALUES(?,0,?)').bind(id,new Uint8Array([1,2,3]))]);}
async function count(table:string){return (await db.prepare(`SELECT COUNT(*) n FROM ${table}`).first<{n:number}>())!.n;}
it('INT-01 committed offline tombstone reclaims file and thumbnail without a DELETE request',async()=>{
 await applyChanges(env,'alice',[change('photo',{thumbId:'thumb'},'files'),change('thumb',{parentId:'photo'},'files')]);await binary('photo');await binary('thumb');
 await applyChanges(env,'alice',[change('photo',{deleted:true},'files')],{serverTs:true});
 expect(await count('files')).toBe(0);expect(await count('file_chunks')).toBe(0);
 const r=await files.request('http://localhost/photo/chunks/0',{method:'PUT',headers:{authorization:'Bearer integrity-session'},body:new Uint8Array([9])},env,ctx);
 expect(r.status).toBe(410);expect(await count('files')).toBe(0);
});
it.each([1,99,100,101,150,500])('INT-03 undo %i records journals every inverse',async n=>{
 const cs=beginChangeset({userId:'alice',tool:'integrity'});
 await applyChanges(env,'alice',Array.from({length:n},(_,i)=>change(`p${i}`,{title:`Page ${i}`})),{serverTs:true,journal:cs});
 const out=await undoChangeset(env,user,cs.id);expect(out.ok).toBe(true);expect(out.restored).toBe(n);
 expect((await db.prepare("SELECT COUNT(*) n FROM records WHERE json_extract(data,'$.deleted')=1").first<{n:number}>())!.n).toBe(n);
 expect((await db.prepare('SELECT item_count FROM changesets WHERE id=?').bind(out.undoChangesetId).first<{item_count:number}>())!.item_count).toBe(n);
},60000);

it.each(['before-first','after-batch','lost-response'])('INT-03 resumes a 150-item undo after %s without duplicate inverses',async fault=>{
 const cs=beginChangeset({userId:'alice',tool:'integrity-recovery'});await applyChanges(env,'alice',Array.from({length:150},(_,i)=>change(`p${String(i).padStart(3,'0')}`,{title:'Keep'})),{serverTs:true,journal:cs});
 await db.prepare("INSERT INTO automation_runs(id,automation_id,event_key,status,created_at,changeset_id,lease_id,lease_until) VALUES('recover','a','event','running',1,?,'old-lease',9999999999999)").bind(cs.id).run();
 let batches=0;
 const failing=new Proxy(db,{get(target,key){if(key==='batch')return async (statements:D1PreparedStatement[])=>{
   // Identify inverse batches from the durable item checkpoint SQL.
   const inverse=statements.some(st=>String((st as unknown as {statement:string}).statement).includes("UPDATE undo_items SET state='applied'"));
   if(inverse){batches++;if((fault==='before-first'&&batches===1)||(fault==='after-batch'&&batches===2))throw new Error('injected Worker crash');}
   const result=await target.batch(statements);if(inverse&&fault==='lost-response'&&batches===1)throw new Error('injected lost response');return result;
 };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const first=await undoChangeset({...env,DB:failing},user,cs.id);
 expect(first.ok).toBe(false);expect(first.status).toBe(503);
 expect((await db.prepare("SELECT status,lease_id FROM automation_runs WHERE id='recover'").first())).toMatchObject({status:'terminal_failure',lease_id:null});
 const next=await undoChangeset(env,user,cs.id);expect(next.ok).toBe(true);expect(next.restored).toBe(150);
 expect((await db.prepare('SELECT item_count FROM changesets WHERE id=?').bind(next.undoChangesetId).first<{item_count:number}>())!.item_count).toBe(150);
 expect((await undoChangeset(env,user,cs.id)).status).toBe(409);
 const redo=await undoChangeset(env,user,next.undoChangesetId!);expect(redo.ok).toBe(true);expect(redo.restored).toBe(150);
 expect((await db.prepare("SELECT COUNT(*) n FROM records WHERE json_extract(data,'$.deleted')=1").first<{n:number}>())!.n).toBe(0);
},60000);

it.each([0,119])('INT-03 concurrent conflict at item %i preserves the new value and records partial progress',async position=>{
 const cs=beginChangeset({userId:'alice',tool:'integrity-conflict'});await applyChanges(env,'alice',Array.from({length:150},(_,i)=>change(`p${String(i).padStart(3,'0')}`,{title:'Before'})),{serverTs:true,journal:cs});
 let raced=false;const racing=new Proxy(db,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{
  if(!raced&&statements.some(st=>String((st as unknown as {statement:string}).statement).includes("UPDATE undo_items SET state='applied'"))){raced=true;await applyChanges(env,'alice',[change(`p${String(position).padStart(3,'0')}`,{title:'Concurrent edit'})],{serverTs:true});}
  return target.batch(statements);
 };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const out=await undoChangeset({...env,DB:racing},user,cs.id);expect(raced).toBe(true);expect(out.status,JSON.stringify(out)).toBe(409);expect(out.restored).toBe(149);expect(out.conflicts).toHaveLength(1);
 expect((await db.prepare('SELECT state FROM undo_jobs WHERE changeset_id=?').bind(cs.id).first())).toMatchObject({state:'partial'});
 expect((await db.prepare('SELECT item_count FROM changesets WHERE id=?').bind(out.undoChangesetId).first<{item_count:number}>())!.item_count).toBe(149);
},60000);
it('INT-03 unauthorized undo creates neither a job nor a recovery fence',async()=>{
 const cs=beginChangeset({userId:'alice',tool:'private'});await applyChanges(env,'alice',[change('private',{title:'Private'})],{serverTs:true,journal:cs});
 expect((await undoChangeset(env,{id:'bob',role:'member'} as AuthUser,cs.id)).status).toBe(403);expect(await count('undo_jobs')).toBe(0);
});
it('INT-01 cleanup failure rolls back the tombstone and retries atomically',async()=>{
 await applyChanges(env,'alice',[change('photo',{},'files')]);await binary('photo');
 await db.prepare("CREATE TRIGGER cleanup_fault BEFORE DELETE ON file_chunks BEGIN SELECT RAISE(ABORT,'cleanup interrupted'); END").run();
 const failed=await applyChanges(env,'alice',[change('photo',{deleted:true},'files')],{serverTs:true});expect(failed.partialError).toContain('cleanup interrupted');expect(await count('files')).toBe(1);
 expect(await db.prepare("SELECT id FROM records WHERE id='photo' AND json_extract(data,'$.deleted')=1").first()).toBeNull();
 await db.prepare('DROP TRIGGER cleanup_fault').run();await applyChanges(env,'alice',[change('photo',{deleted:true},'files')],{serverTs:true});await applyChanges(env,'alice',[change('photo',{deleted:true},'files')],{serverTs:true});
 expect(await count('files')).toBe(0);expect(await count('file_chunks')).toBe(0);
 const usage=await files.request('http://localhost/usage',{headers:{authorization:'Bearer integrity-session'}},env,ctx);expect(await usage.json()).toMatchObject({used:0});
});
it('INT-01 shared template reference holds bytes until its own tombstone; unknown identity cannot delete',async()=>{
 await applyChanges(env,'alice',[change('photo',{},'files'),change('shared-block',{fileId:'photo',pageId:'template'},'blocks')]);await binary('photo');
 await applyChanges(env,'alice',[change('photo',{deleted:true},'files')],{serverTs:true});expect(await count('files')).toBe(1);
 expect((await files.request('http://localhost/photo',{method:'DELETE'},env,ctx)).status).toBe(401);expect(await count('files')).toBe(1);
 await applyChanges(env,'alice',[change('shared-block',{deleted:true},'blocks')],{serverTs:true});expect(await count('files')).toBe(0);
});
it('INT-01 client queues parent and thumbnail tombstones in the same sync batch',async()=>{
 await applyChanges(env,'alice',[change('photo',{thumbId:'thumb'},'files'),change('thumb',{parentId:'photo'},'files')]);await binary('photo');await binary('thumb');
 const result=await applyChanges(env,'alice',[change('photo',{deleted:true},'files'),change('thumb',{deleted:true},'files')],{serverTs:true,event:{source:'client'}});
 expect(result.partialError,JSON.stringify(result)).toBeUndefined();expect(await count('files')).toBe(0);
});
it('INT-01 legacy DELETE preserves shared references and retires an incomplete owned upload',async()=>{
 await applyChanges(env,'alice',[change('photo',{},'files'),change('shared',{fileId:'photo',pageId:'p'},'blocks')]);await binary('photo');
 const deleted=await files.request('http://localhost/photo',{method:'DELETE',headers:{authorization:'Bearer integrity-session'}},env,ctx);expect(deleted.status).toBe(200);expect(await count('files')).toBe(1);
 await applyChanges(env,'alice',[change('shared',{deleted:true},'blocks')],{serverTs:true});expect(await count('files')).toBe(0);
 await binary('incomplete');expect((await files.request('http://localhost/incomplete',{method:'DELETE',headers:{authorization:'Bearer integrity-session'}},env,ctx)).status).toBe(200);expect(await count('files')).toBe(0);
 expect((await files.request('http://localhost/incomplete/chunks/0',{method:'PUT',headers:{authorization:'Bearer integrity-session'},body:new Uint8Array([1])},env,ctx)).status).toBe(410);
});
it('INT-01 cleanup uses indexed file references instead of scanning record collections',async()=>{
 const plan=(await db.prepare("EXPLAIN QUERY PLAN SELECT id FROM reclaimable_files WHERE id='photo'").all<{detail:string}>()).results.map(r=>r.detail).join('\n');
 for(const index of ['idx_block_file_ref','idx_task_cover_ref','idx_file_thumb_ref'])expect(plan.split('\n').some(line=>line.includes('SEARCH r USING INDEX '+index)&&line.includes('<expr>=?')),plan).toBe(true);
});
