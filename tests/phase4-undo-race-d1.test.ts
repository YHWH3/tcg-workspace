import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {applyChanges} from '../worker/sync';
import {beginChangeset,commitChangeset,undoChangeset} from '../worker/changesets';
import {sha256Hex} from '../worker/password';
import type {Env,AuthUser} from '../worker/auth';
vi.mock('../worker/events',async original=>({...await original<typeof import('../worker/events')>(),scheduleOutbox:vi.fn()}));
let mf:Miniflare,db:D1Database,env:Env;
const user={id:'alice',role:'admin'} as AuthUser;
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

it('C1 commitChangeset replays neither header nor journal items',async()=>{
 const cs=beginChangeset({userId:'alice',tool:'update'});cs.items=[{id:'A',collection:'tasks',created:false,fields:['title'],before:{title:'A0'},after:{title:'A1'},fieldTs:{title:10},rev:5}];
 await commitChangeset(env,cs);await commitChangeset(env,cs);
 expect((await db.prepare('SELECT item_count FROM changesets WHERE id=?').bind(cs.id).first<{item_count:number}>())!.item_count).toBe(1);
});
async function seed(){await applyChanges(env,'alice',[change('A',{title:'A0'},'tasks'),change('B',{title:'B0'},'tasks')],{serverTs:true});const cs=beginChangeset({userId:'alice',tool:'update'});await applyChanges(env,'alice',[change('A',{title:'A1'},'tasks'),change('B',{title:'B1'},'tasks')],{serverTs:true,journal:cs});return cs;}
it.each(['one','all','none'])('C1 actual D1 inverse revision guards: %s race',async race=>{
 const cs=await seed();let raced=false;const proxy=new Proxy(db,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{
  if(!raced&&statements.some(st=>String((st as unknown as {statement:string}).statement).includes("UPDATE undo_items SET state='applied'"))){raced=true;const ids=race==='all'?['A','B']:race==='one'?['B']:[];await applyChanges(env,'alice',ids.map(id=>change(id,{title:'human '+id},'tasks')),{serverTs:true});}
  return target.batch(statements);
 };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const out=await undoChangeset({...env,DB:proxy},user,cs.id);expect(out.restored).toBe(race==='all'?0:race==='one'?1:2);
 expect(out.ok).toBe(race==='none');expect(out.conflicts).toHaveLength(race==='all'?2:race==='one'?1:0);
 const records=(await db.prepare("SELECT id,data FROM records WHERE id IN ('A','B') ORDER BY id").all<{id:string;data:string}>()).results.map(r=>JSON.parse(r.data).title);
 expect(records).toEqual(race==='all'?['human A','human B']:race==='one'?['A0','human B']:['A0','B0']);
 const source=await db.prepare('SELECT undone_by FROM changesets WHERE id=?').bind(cs.id).first<{undone_by:string|null}>();
 if(race==='all'){expect(source!.undone_by).toBeNull();expect(out.status).toBe(409);}else{expect(source!.undone_by).toBe(out.undoChangesetId);expect((await db.prepare('SELECT item_count FROM changesets WHERE id=?').bind(out.undoChangesetId).first<{item_count:number}>())!.item_count).toBe(out.restored);}
 expect((await db.prepare("SELECT COUNT(*) n FROM event_outbox WHERE json_extract(payload,'$.source')='undo'").first<{n:number}>())!.n).toBe(out.restored);
});
