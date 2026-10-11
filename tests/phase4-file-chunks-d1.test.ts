import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {publicFormsApi} from '../worker/forms';
import {D1_MAX_ROW_BYTES,FILE_CHUNK_BYTES,QUOTA_BYTES,concatRows,files} from '../worker/files';
import {sha256Hex} from '../worker/password';
import {applyChanges} from '../worker/sync';
import type {Env} from '../worker/auth';

let mf:Miniflare,db:D1Database,env:Env;
const ctx={waitUntil:()=>{},passThroughOnException:()=>{}} as unknown as ExecutionContext;
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'phase4-chunks',modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-09-25',d1Databases:{DB:'disposable-chunks'}}]}));
  db=await mf.getD1Database('DB') as D1Database;
  env={DB:db,WORKSPACE_ENV:'local-test',TURNSTILE_LOCAL_TEST:'1'} as Env;
  const folder=fileURLToPath(new URL('../migrations/',import.meta.url));
  for(const file of readdirSync(folder).filter(f=>f.endsWith('.sql')).sort()){
    const sql=readFileSync(`${folder}/${file}`,'utf8').replace(/--[^\n]*/g,'');
    await db.batch((sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi)??[]).map(s=>db.prepare(s.trim())));
  }
  await db.prepare("INSERT INTO users(id,username,name,role) VALUES('alice','alice','Alice','admin')").run();
  await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await sha256Hex('session-alice'),'alice',Date.now()+86_400_000,Date.now()).run();
  await applyChanges(env,'alice',[{id:'board',collection:'boards',patch:{name:'Board',columns:[{id:'open'}],fields:[]},ts:1},{id:'form',collection:'forms',patch:{databaseId:'board',title:'Upload',enabled:true,fields:[{fieldKey:'title',label:'Your name',required:true}],successMessage:'ok'},ts:1}]);
  await db.prepare("INSERT INTO form_tokens(token,form_id,created_at) VALUES('pub','form',1)").run();
});
afterEach(()=>mf.dispose());

function image(size:number){
  const bytes=new Uint8Array(size);
  bytes.set([137,80,78,71,13,10,26,10],0);
  for(let i=8;i<bytes.length;i++) bytes[i]=(i*17)&255;
  return bytes;
}
async function upload(bytes:Uint8Array,token='pub'){
  const data=new FormData();
  data.set('turnstileToken','pass');
  data.set('file',new File([Buffer.from(bytes)], 'shot.png', {type:'image/png'}));
  return publicFormsApi.request(`http://localhost/${token}/files`,{method:'POST',body:data},env,ctx);
}
async function stored(id:string){
  const rows=(await db.prepare('SELECT idx, data, LENGTH(data) AS n FROM file_chunks WHERE file_id=? ORDER BY idx').bind(id).all<{idx:number;data:Uint8Array;n:number}>()).results;
  return {rows, bytes:concatRows(rows)};
}

it('keeps every bound chunk under the D1 row ceiling and round-trips the original bytes',async()=>{
  expect(FILE_CHUNK_BYTES).toBeLessThan(D1_MAX_ROW_BYTES);
  const cases=[100*1024, 1_900_000, 2_100_000, 4_900_000];
  for(const size of cases){
    const bytes=image(size);
    const response=await upload(bytes);
    expect(response.status, `size ${size}`).toBe(200);
    const {id}=await response.json() as {id:string};
    const file=await stored(id);
    expect(file.rows.length).toBe(Math.ceil(size/FILE_CHUNK_BYTES));
    expect(file.rows.every(row=>row.n<D1_MAX_ROW_BYTES && row.n<=FILE_CHUNK_BYTES)).toBe(true);
    expect(file.rows.map(row=>row.idx)).toEqual(file.rows.map((_,i)=>i));
    expect(Buffer.from(file.bytes).equals(Buffer.from(bytes))).toBe(true);
    const downloaded=await files.request(`http://localhost/${id}`,{headers:{authorization:'Bearer session-alice'}},env,ctx);
    expect(downloaded.status, `download ${size}`).toBe(200);
    expect(Buffer.from(await downloaded.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    const meta=await db.prepare('SELECT size, chunks, complete FROM files WHERE id=?').bind(id).first<{size:number;chunks:number;complete:number}>();
    expect(meta).toMatchObject({size, chunks:file.rows.length, complete:1});
  }
},120_000);

it('rejects an image over 5 MiB and a failed chunk write leaves no file rows',async()=>{
  expect((await upload(image(5*1024*1024+1))).status).toBe(413);
  expect((await db.prepare('SELECT COUNT(*) n FROM files').first<{n:number}>())!.n).toBe(0);
  await db.prepare("CREATE TRIGGER chunk_fault BEFORE INSERT ON file_chunks WHEN NEW.idx>=1 BEGIN SELECT RAISE(ABORT,'chunk fault'); END").run();
  expect((await upload(image(2_100_000))).status).toBe(503);
  expect((await db.prepare('SELECT COUNT(*) n FROM files').first<{n:number}>())!.n).toBe(0);
  expect((await db.prepare('SELECT COUNT(*) n FROM file_chunks').first<{n:number}>())!.n).toBe(0);
});

it('rejects quota exhaustion, a foreign form claim, and an oversized authenticated chunk',async()=>{
  await db.prepare('INSERT INTO files(id,size,complete,created_at) VALUES(?,?,1,?)').bind('pad',QUOTA_BYTES,1).run();
  expect((await upload(image(100))).status).toBe(507);
  expect((await db.prepare("SELECT COUNT(*) n FROM file_chunks").first<{n:number}>())!.n).toBe(0);
  await db.prepare('DELETE FROM files WHERE id=?').bind('pad').run();
  const first=await upload(image(32));
  const body=await first.json() as {id:string;claim:string};
  await applyChanges(env,'alice',[{id:'other',collection:'forms',patch:{databaseId:'board',title:'Other',enabled:true,fields:[{fieldKey:'title',label:'Your name',required:true}],successMessage:'ok'},ts:1}]);
  await db.prepare("INSERT INTO form_tokens(token,form_id,created_at) VALUES('other','other',1)").run();
  const stolen=await publicFormsApi.request('http://localhost/other',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({submissionId:'steal',values:{title:'Visitor'},turnstileToken:'pass',fileIds:[body.id],fileClaims:{[body.id]:body.claim}})},env,ctx);
  expect(stolen.status).toBe(422);
  const guessed=await publicFormsApi.request('http://localhost/pub',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({submissionId:'guess',values:{title:'Visitor'},turnstileToken:'pass',fileIds:[body.id],fileClaims:{[body.id]:'not-the-claim'}})},env,ctx);
  expect(guessed.status).toBe(422);
  const huge=new Uint8Array(FILE_CHUNK_BYTES+1);
  const rejected=await files.request('http://localhost/file_big/chunks/0',{method:'PUT',headers:{authorization:'Bearer session-alice'},body:huge},env,ctx);
  expect(rejected.status).toBe(413);
});

it('downloads an existing multi-chunk file and still rejects an unsafe SVG',async()=>{
  const legacy=image(1_500_000);
  const head=legacy.subarray(0,1_000_000), tail=legacy.subarray(1_000_000);
  await db.batch([
    db.prepare('INSERT INTO files(id,mime,size,chunks,complete,uploaded_by,created_at) VALUES(?,?,?,?,1,?,?)').bind('legacy','image/png',legacy.byteLength,2,'alice',1),
    db.prepare('INSERT INTO file_chunks(file_id,idx,data) VALUES(?,?,?)').bind('legacy',0,head),
    db.prepare('INSERT INTO file_chunks(file_id,idx,data) VALUES(?,?,?)').bind('legacy',1,tail),
  ]);
  const downloaded=await files.request('http://localhost/legacy',{headers:{authorization:'Bearer session-alice'}},env,ctx);
  expect(downloaded.status).toBe(200);
  expect(Buffer.from(await downloaded.arrayBuffer()).equals(Buffer.from(legacy))).toBe(true);
  await db.prepare('DELETE FROM file_chunks WHERE file_id=? AND idx=1').bind('legacy').run();
  expect((await files.request('http://localhost/legacy',{headers:{authorization:'Bearer session-alice'}},env,ctx)).status).toBe(404);
  const svg=new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  expect((await files.request('http://localhost/svg1/chunks/0',{method:'PUT',headers:{authorization:'Bearer session-alice'},body:svg},env,ctx)).status).toBe(200);
  const complete=await files.request('http://localhost/svg1/complete',{method:'POST',headers:{authorization:'Bearer session-alice','content-type':'application/json'},body:JSON.stringify({mime:'image/svg+xml',size:svg.byteLength,chunks:1})},env,ctx);
  expect(complete.status).toBe(200);
  const saved=await files.request('http://localhost/svg1',{headers:{authorization:'Bearer session-alice'}},env,ctx);
  expect(await saved.text()).not.toContain('<script');
});

it('drops chunks when the file record write is interrupted after the blob batch commits',async()=>{
  await db.prepare("CREATE TRIGGER file_record_fault BEFORE INSERT ON records WHEN NEW.collection='files' BEGIN SELECT RAISE(ABORT,'record fault'); END").run();
  expect((await upload(image(2_100_000))).status).toBe(503);
  expect((await db.prepare('SELECT COUNT(*) n FROM files').first<{n:number}>())!.n).toBe(0);
  expect((await db.prepare('SELECT COUNT(*) n FROM file_chunks').first<{n:number}>())!.n).toBe(0);
  expect((await db.prepare("SELECT COUNT(*) n FROM records WHERE collection='files'").first<{n:number}>())!.n).toBe(0);
},30_000);

it('stores an authenticated multi-chunk file and downloads the same bytes',async()=>{
  const bytes=image(2_100_000);
  const id='auth_big';
  const parts=Math.ceil(bytes.byteLength/FILE_CHUNK_BYTES);
  for(let idx=0;idx<parts;idx++){
    const part=bytes.subarray(idx*FILE_CHUNK_BYTES,Math.min(bytes.byteLength,(idx+1)*FILE_CHUNK_BYTES));
    expect(part.byteLength).toBeLessThan(D1_MAX_ROW_BYTES);
    const put=await files.request(`http://localhost/${id}/chunks/${idx}`,{method:'PUT',headers:{authorization:'Bearer session-alice'},body:part},env,ctx);
    expect(put.status).toBe(200);
  }
  const complete=await files.request(`http://localhost/${id}/complete`,{method:'POST',headers:{authorization:'Bearer session-alice','content-type':'application/json'},body:JSON.stringify({mime:'image/png',size:bytes.byteLength,chunks:parts})},env,ctx);
  expect(complete.status).toBe(200);
  const rows=(await db.prepare('SELECT idx, LENGTH(data) AS n FROM file_chunks WHERE file_id=? ORDER BY idx').bind(id).all<{idx:number;n:number}>()).results;
  expect(rows.map(row=>row.idx)).toEqual(rows.map((_,i)=>i));
  expect(rows.every(row=>row.n<D1_MAX_ROW_BYTES && row.n<=FILE_CHUNK_BYTES)).toBe(true);
  const downloaded=await files.request(`http://localhost/${id}`,{headers:{authorization:'Bearer session-alice'}},env,ctx);
  expect(Buffer.from(await downloaded.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
},30_000);

it('keeps the first upload intact when the acknowledgement is retried',async()=>{
  const bytes=image(1200);
  const first=await upload(bytes);
  expect(first.status).toBe(200);
  const {id}=await first.json() as {id:string};
  const again=await upload(bytes);
  expect(again.status).toBe(200);
  const second=await again.json() as {id:string};
  expect(second.id).not.toBe(id);
  expect(Buffer.from((await stored(id)).bytes).equals(Buffer.from(bytes))).toBe(true);
  const pair=await Promise.all([upload(image(64)),upload(image(65))]);
  expect(pair.map(r=>r.status)).toEqual([200,200]);
});
