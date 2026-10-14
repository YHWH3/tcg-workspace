import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {applyChanges} from '../worker/sync';
import {getRec} from '../worker/records';
import type {Env} from '../worker/auth';
// Capture registration only. All tool handlers, writes, CAS, journal, parsing
// and D1 are the production implementations. The full MCP gate covers wire/OAuth.
const tools=vi.hoisted(()=>new Map<string,(args:Record<string,unknown>)=>Promise<{content:{text:string}[];isError?:boolean}>>());
vi.mock('@modelcontextprotocol/server',()=>({McpServer:class{registerTool(name:string,_meta:unknown,fn:never){tools.set(name,fn);}registerPrompt(){}}}));
vi.mock('agents/mcp/server',()=>({createMcpHandler:vi.fn()}));
vi.mock('../worker/events',async original=>({...await original<typeof import('../worker/events')>(),scheduleOutbox:vi.fn()}));
import {beginChangeset} from '../worker/changesets';
import {createWorkspaceServer,write} from '../worker/mcp';
let mf:Miniflare,db:D1Database,env:Env;
function context(){return {env,ectx:{waitUntil:()=>{}} as unknown as ExecutionContext,userId:'alice',userRole:'admin',origin:'http://localhost',userByKey:new Map(),userNameById:new Map(),pageTitleById:new Map(),recordTitleById:new Map(),recordIdByTitle:new Map(),pageIdByTitle:new Map(),cachesReady:false,warnings:[],cs:null,toolName:''} as Parameters<typeof createWorkspaceServer>[0];}
function register(){createWorkspaceServer(context());}
async function call(name:string,args:Record<string,unknown>){register();const r=await tools.get(name)!(args);return {...JSON.parse(r.content[0].text),isError:r.isError};}
beforeEach(async()=>{
 mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'integrity-mcp',modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-09-25',d1Databases:{DB:'integrity-mcp-disposable'}}]}));db=await mf.getD1Database('DB') as D1Database;env={DB:db} as Env;
 const dir=fileURLToPath(new URL('../migrations/',import.meta.url));for(const f of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())await db.batch((readFileSync(`${dir}/${f}`,'utf8').replace(/--[^\n]*/g,'').match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi)??[]).map(s=>db.prepare(s.trim())));
 await db.prepare("INSERT INTO users(id,username,name,role) VALUES('alice','alice','Alice','admin')").run();
 await applyChanges(env,'alice',[{id:'page',collection:'pages',patch:{title:'Notes'},ts:1},{id:'funding',collection:'tasks',patch:{title:'Funding Opportunity',boardId:'board'},ts:1},{id:'old',collection:'blocks',patch:{pageId:'page',type:'p',text:'old',order:'a0'},ts:1}]);
});
afterEach(()=>mf.dispose());
it('INT-04 reachable edit_page multi-chunk guarded split succeeds',async()=>{
 const old=(await getRec(env,'old'))!;
 const out=await call('edit_page',{pageId:'page',replaceBlocks:[{blockId:'old',expectedRev:old.rev,markdown:Array.from({length:501},(_,i)=>`line ${i}`).join('\n\n')}],requestId:'split-501'});
 expect(out.isError,JSON.stringify(out)).not.toBe(true);expect(out.updated).toBe(501);
 expect((await db.prepare('SELECT item_count FROM changesets WHERE id=?').bind(out.changesetId).first<{item_count:number}>())!.item_count).toBe(501);
},60000);
it('INT-05 record mention is stored and hydrated through page and record body tools',async()=>{
 const out=await call('edit_page',{pageId:'page',appendMarkdown:'[[Funding Opportunity]]'});expect(out.isError).not.toBe(true);
 const rows=(await db.prepare("SELECT data FROM records WHERE collection='blocks'").all<{data:string}>()).results.map(r=>JSON.parse(r.data));
 expect(rows.some(r=>r.text==='@[rec:funding]')).toBe(true);
 expect(JSON.stringify(await call('get_page',{pageId:'page'}))).toContain('Funding Opportunity');
 await call('edit_record_body',{recordId:'funding',appendMarkdown:'[[Funding Opportunity]]'});
 expect((await call('get_record',{recordId:'funding'})).record.body).toBe('[[Funding Opportunity]]');
});
it.each(['https://docs.google.com/document/d/demo/edit','https://drive.google.com/file/d/demo/view','https://drive.google.com/drive/folders/demo'])('INT-06 persists %s through append, replacement and record body',async url=>{
 await call('edit_page',{pageId:'page',appendMarkdown:url});
 const embeds=(await db.prepare("SELECT data FROM records WHERE collection='blocks' AND json_extract(data,'$.type')='embed'").all<{data:string}>()).results.map(r=>JSON.parse(r.data));
 expect(embeds).toContainEqual(expect.objectContaining({url,provider:'gdrive'}));
 const old=(await getRec(env,'old'))!;await call('edit_page',{pageId:'page',replaceBlocks:[{blockId:'old',expectedRev:old.rev,markdown:url}]});expect((await getRec(env,'old'))!.data.url).toBe(url);
 await call('edit_record_body',{recordId:'funding',appendMarkdown:url});expect((await call('get_record',{recordId:'funding'})).record.body).toBe(url);
});

it.each([499,500,501,1000].flatMap(n=>['first','second','mixed'].map(mode=>({n,mode}))))('INT-04 $n writes, $mode expectations journal once',async ({n,mode})=>{
 const ops=Array.from({length:n},(_,i)=>({id:`block${i}`,collection:'blocks' as const,patch:{pageId:'page',type:'p',text:`line ${i}`}}));
 await applyChanges(env,'alice',ops.map(o=>({...o,ts:1})),{serverTs:true});
 const ids=mode==='first'?[ops[0].id]:mode==='second'?[ops[n-1].id]:[ops[0].id,ops[n-1].id];const expectMap=new Map<string,number>();for(const id of ids)expectMap.set(id,(await getRec(env,id))!.rev);
 const c=context();c.cs=beginChangeset({userId:'alice',tool:'edit_page',requestId:`boundary-${n}`});
 await write(c,ops.map(o=>({...o,patch:{text:'Updated'}})),{expect:expectMap});
 expect((await db.prepare('SELECT item_count FROM changesets WHERE id=?').bind(c.cs.id).first<{item_count:number}>())!.item_count).toBe(n);
 expect((await getRec(env,ops[n-1].id))!.data.text).toBe('Updated');
},60000);
it('INT-04 stale guard in second chunk fails before any writes',async()=>{
 const c=context();c.cs=beginChangeset({userId:'alice',tool:'edit_page',requestId:'stale-second'});
 const ops=Array.from({length:501},(_,i)=>({id:`b${i}`,collection:'blocks' as const,patch:{text:'Never committed'}}));
 await expect(write(c,ops,{expect:new Map([['b500',12]])})).rejects.toThrow('conflict');
 expect((await db.prepare("SELECT COUNT(*) n FROM records WHERE id LIKE 'b%'").first<{n:number}>())!.n).toBe(0);
});
it('INT-04 interrupted 1000-block MCP edit retries its frozen IDs and keeps one audit',async()=>{
 let n=0;const original=env;
 const fault=new Proxy(db,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{
  if(statements.some(st=>String((st as unknown as {statement:string}).statement).includes('INSERT OR IGNORE INTO mcp_write_done'))&&++n===7)throw new Error('interrupted after chunk 1');return target.batch(statements);
 };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 env={...env,DB:fault};const args={pageId:'page',replaceBlocks:[{blockId:'old',expectedRev:(await getRec(original,'old'))!.rev,markdown:Array.from({length:1000},(_,i)=>`line ${i}`).join('\n\n')}],requestId:'retry-1000'};
 const first=await call('edit_page',args);expect(first.isError).toBe(true);expect(n).toBe(7);
 env=original;const next=await call('edit_page',args);expect(next.isError,JSON.stringify(next)).not.toBe(true);expect(next.changesetId).toBe(first.changesetId);
 const repeat=await call('edit_page',args);expect(repeat.replayed).toBe(true);
 expect((await db.prepare("SELECT COUNT(*) n FROM records WHERE collection='blocks'").first<{n:number}>())!.n).toBe(1000);
 expect((await db.prepare('SELECT item_count FROM changesets WHERE id=?').bind(next.changesetId).first<{item_count:number}>())!.item_count).toBe(1000);
},60000);
it('INT-05 ambiguity, page-first, explicit IDs, live rename and deleted/archived records',async()=>{
 await applyChanges(env,'alice',[{id:'duplicate',collection:'tasks',patch:{title:'Funding Opportunity',boardId:'other'},ts:1}]);
 let out=await call('edit_page',{pageId:'page',appendMarkdown:'[[Funding Opportunity]]'});expect(out.warnings.join(' ')).toContain('ambiguous record');
 expect((await call('get_page',{pageId:'page'})).markdown).toContain('[[Funding Opportunity]]');
 await call('edit_page',{pageId:'page',appendMarkdown:'[[rec:funding]]'});
 await applyChanges(env,'alice',[{id:'funding',collection:'tasks',patch:{title:'Renamed funding',archived:true},ts:2}]);
 expect((await call('get_page',{pageId:'page'})).markdown).toContain('[[Renamed funding]]');
 await applyChanges(env,'alice',[{id:'same-name',collection:'pages',patch:{title:'Funding Opportunity'},ts:2}]);
 await call('edit_page',{pageId:'page',appendMarkdown:'[[Funding Opportunity]] and [[rec:funding]]'});
 const texts=(await db.prepare("SELECT json_extract(data,'$.text') text FROM records WHERE collection='blocks'").all<{text:string}>()).results.map(r=>r.text);
 expect(texts).toContain('@[page:same-name] and @[rec:funding]');
 await applyChanges(env,'alice',[{id:'funding',collection:'tasks',patch:{deleted:true},ts:3}]);
 expect((await call('get_page',{pageId:'page'})).markdown).not.toContain('Renamed funding');
});
it('INT-06 unrelated edits retain embed, read/write and undo/redo preserve URL',async()=>{
 const url='https://docs.google.com/document/d/roundtrip/edit';
 const made=await call('create_page',{title:'Embed page',markdown:url});expect(made.isError,JSON.stringify(made)).not.toBe(true);
 const read=await call('get_page',{pageId:made.id});expect(read.markdown).toBe(url);
 await call('edit_page',{pageId:made.id,title:'Renamed only'});expect((await call('get_page',{pageId:made.id})).markdown).toBe(url);
 const old=(await getRec(env,'old'))!;const replaced=await call('edit_page',{pageId:'page',replaceBlocks:[{blockId:'old',expectedRev:old.rev,markdown:url}]});
 const inverse=await call('undo_change',{changesetId:replaced.changesetId});expect(inverse.isError,JSON.stringify(inverse)).not.toBe(true);expect((await getRec(env,'old'))!.data.type).toBe('p');
 const redo=await call('undo_change',{changesetId:inverse.undoChangesetId});expect(redo.isError,JSON.stringify(redo)).not.toBe(true);expect((await getRec(env,'old'))!.data).toMatchObject({type:'embed',url,provider:'gdrive'});
 await call('edit_record_body',{recordId:'funding',appendMarkdown:'javascript:alert(1)'});
 expect((await call('get_record',{recordId:'funding'})).record.body).toBe('javascript:alert(1)');
});
it('INT-04 undo fences a partial bulk edit so retry cannot recreate pending blocks',async()=>{
 const c=context();c.cs=beginChangeset({userId:'alice',tool:'edit_page',requestId:'cancel-partial'});
 const ops=Array.from({length:501},(_,i)=>({id:`cancel${i}`,collection:'blocks' as const,patch:{text:'Bulk'}}));let n=0;
 const original=env;const faulty=new Proxy(db,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(statements.some(st=>String((st as unknown as {statement:string}).statement).includes('INSERT OR IGNORE INTO mcp_write_done'))&&++n===2)throw new Error('stop');return target.batch(statements);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 c.env={...env,DB:faulty};await expect(write(c,ops)).rejects.toThrow('interrupted');
 const {undoChangeset}=await import('../worker/changesets');const undone=await undoChangeset(original,{id:'alice',role:'admin'} as import('../worker/auth').AuthUser,c.cs.id);expect(undone.ok).toBe(true);expect(undone.restored).toBe(100);
 c.env=original;await expect(write(c,ops)).rejects.toThrow();
 expect((await db.prepare("SELECT COUNT(*) n FROM records WHERE id LIKE 'cancel%' AND COALESCE(json_extract(data,'$.deleted'),0)=0").first<{n:number}>())!.n).toBe(0);
},60000);
it('INT-02 MCP database deletion archives generic records and restores in place',async()=>{
 await applyChanges(env,'alice',[{id:'people',collection:'boards',patch:{kind:'records',name:'People'},ts:1},{id:'funding',collection:'tasks',patch:{boardId:'people',p_email:'keep@example.invalid'},ts:2}]);
 const board=(await getRec(env,'people'))!;const result=await call('delete_item',{type:'board',id:'people',expectedRev:board.rev});
 expect(result.isError,JSON.stringify(result)).not.toBe(true);expect((await getRec(env,'funding'))!.data.boardId).toBe('people');expect((await getRec(env,'people'))!.data).toMatchObject({archived:true});
 const archived=(await getRec(env,'people'))!;const restored=await call('restore_item',{type:'board',id:'people',expectedRev:archived.rev});expect(restored.isError,JSON.stringify(restored)).not.toBe(true);expect((await getRec(env,'people'))!.data).toMatchObject({archived:false});expect((await getRec(env,'funding'))!.data.p_email).toBe('keep@example.invalid');
});
