import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {openAuditFixture,type AuditFixture} from './audit-fixture';
import {finalize,readBytes,stageBytes,recoverFileStorage,quotaBytes,type FileRow} from '../worker/fileStore';
import {files} from '../worker/files';
import {admin} from '../worker/admin';
import {applyChanges} from '../worker/sync';
import {publicApi} from '../worker/public';
import {publicFormsApi} from '../worker/forms';
import {withD1Budget,d1BudgetRemaining} from '../worker/d1budget';
let f:AuditFixture,bucket:R2Bucket;
const bytes=new TextEncoder().encode('original file bytes');
beforeEach(async()=>{f=await openAuditFixture(undefined,{FILE_STORAGE:'r2',WORKSPACE_ENV:'local-test',TURNSTILE_LOCAL_TEST:'1'},undefined,true);bucket=f.env.FILES!;});
afterEach(async()=>{vi.restoreAllMocks();await f?.dispose();});
const meta=(id:string)=>f.db.prepare('SELECT * FROM files WHERE id=?').bind(id).first<FileRow>();
async function seed(id='asset',data=bytes,mime='image/png'){
  expect(await stageBytes(f.env,id,mime,data,'alice')).toBe(true);
  await applyChanges(f.env,'alice',[
    {id:'page',collection:'pages',patch:{title:'Shared page'},ts:1},
    {id:'block',collection:'blocks',patch:{pageId:'page',type:'file',fileId:id,order:'a0'},ts:1},
    {id,collection:'files',patch:{name:'Attachment',mime,parentType:'block',parentId:'block'},ts:1},
  ]);
}
function intercept(method:'put'|'get'|'delete',fn:(...args:unknown[])=>Promise<unknown>):R2Bucket{
  return new Proxy(bucket,{get(target,key){if(key===method)return fn;const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
}

it('verifies R2 bytes before atomically changing location and removing chunks',async()=>{
  await seed();const env=withD1Budget(f.env);
  expect(await finalize(env,'asset')).toBe('r2');
  const row=(await meta('asset'))!;
  expect(row).toMatchObject({storage:'r2',r2_key:'files/asset',size:bytes.length});
  expect(row.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(await f.db.prepare("SELECT COUNT(*) FROM file_chunks WHERE file_id='asset'").first('COUNT(*)')).toBe(0);
  expect(await readBytes(env,row)).toEqual(bytes);
  expect(await readBytes(env,{...row,storage:'d1',r2_key:null,sha256:null})).toEqual(bytes);
  expect(d1BudgetRemaining(env.DB)).toBeGreaterThanOrEqual(0);
  const response=await files.request('/asset',{headers:f.auth('alice')},env,f.ctx);
  expect(response.status).toBe(200);expect(response.headers.get('content-type')).toBe('image/png');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
});
it('retains usable D1 bytes and durable retry after R2 fails or its acknowledgement is lost',async()=>{
  await seed();
  const fault={...f.env,FILES:intercept('put',async(...args)=>{await bucket.put(...args as Parameters<R2Bucket['put']>);throw new Error('simulated lost acknowledgement');})};
  expect(await finalize(fault,'asset')).toBe('d1');
  expect((await meta('asset'))?.storage).toBe('d1');
  expect(await readBytes(f.env,(await meta('asset'))!)).toEqual(bytes);
  expect(await f.db.prepare("SELECT operation FROM file_storage_jobs WHERE file_id='asset'").first('operation')).toBe('copy');
  await recoverFileStorage(withD1Budget(f.env),Date.now()+16*60_000);
  expect((await meta('asset'))?.storage).toBe('r2');
  expect(await f.db.prepare('SELECT COUNT(*) FROM file_storage_jobs').first('COUNT(*)')).toBe(0);
});
it('never drops D1 chunks if read-back verification fails',async()=>{
  await seed();
  const fault={...f.env,FILES:intercept('put',async(...args)=>bucket.put(args[0] as string,'incorrect',{customMetadata:{workspaceFile:'asset'}}))};
  expect(await finalize(fault,'asset')).toBe('d1');
  expect(await readBytes(f.env,(await meta('asset'))!)).toEqual(bytes);
});
it('preserves deletion intent through immediate metadata reclamation and retries a lost delete acknowledgement',async()=>{
  await seed();await finalize(f.env,'asset');
  await applyChanges(f.env,'alice',[{id:'block',collection:'blocks',patch:{deleted:true},ts:2},{id:'asset',collection:'files',patch:{deleted:true},ts:2}]);
  expect(await meta('asset')).toBeNull();
  expect(await f.db.prepare("SELECT operation FROM file_storage_jobs WHERE file_id='asset'").first('operation')).toBe('delete');
  await recoverFileStorage({...withD1Budget(f.env),FILES:intercept('delete',async(...args)=>{await bucket.delete(args[0] as string);throw new Error('lost delete acknowledgement');})});
  expect(await f.db.prepare("SELECT operation FROM file_storage_jobs WHERE file_id='asset'").first('operation')).toBe('delete');
  await recoverFileStorage(withD1Budget(f.env),Date.now()+16*60_000);
  expect(await bucket.get('files/asset')).toBeNull();
  expect(await f.db.prepare('SELECT COUNT(*) FROM file_storage_jobs').first('COUNT(*)')).toBe(0);
});
it('reconciles a put completed after deletion and its recovery had already finished',async()=>{
  await seed();
  const fault={...f.env,FILES:intercept('put',async(...args)=>{
    await f.db.prepare("DELETE FROM files WHERE id='asset'").run();
    await recoverFileStorage(withD1Budget(f.env));
    return bucket.put(...args as Parameters<R2Bucket['put']>);
  })};
  expect(await finalize(fault,'asset')).toBe('missing');
  expect(await bucket.get('files/asset')).not.toBeNull();
  await expect(stageBytes(f.env,'asset','image/png',bytes,'alice')).rejects.toThrow('file deleted');
  await recoverFileStorage(withD1Budget(f.env));
  expect(await bucket.get('files/asset')).toBeNull();
});
it('keeps foreign bucket objects, makes missing bytes explicit and fails closed on corrupted R2 content',async()=>{
  await seed();await finalize(f.env,'asset');
  await bucket.put('files/owner-document','leave intact');
  await recoverFileStorage(withD1Budget(f.env));
  expect(await bucket.get('files/owner-document')).not.toBeNull();
  await bucket.put('files/asset','corrupted');
  await expect(readBytes(f.env,(await meta('asset'))!)).rejects.toThrow('integrity');
  await bucket.delete('files/asset');
  expect(await readBytes(f.env,(await meta('asset'))!)).toBeNull();
});
it('keeps D1 mode unchanged and exposes a validated shared quota',async()=>{
  await seed();expect(await finalize({...f.env,FILE_STORAGE:'d1'},'asset')).toBe('d1');
  expect(await bucket.get('files/asset')).toBeNull();
  expect(quotaBytes({})).toBe(450*1024*1024);expect(()=>quotaBytes({FILE_QUOTA_MB:'bad'})).toThrow('invalid');
  const response=await files.request('/usage',{headers:f.auth('alice')},{...f.env,FILE_QUOTA_MB:'900'},f.ctx);
  expect(await response.json()).toMatchObject({used:bytes.length,limit:900*1024*1024});
});
it('pages admin backfill at five files, supports dry run and rejects other users',async()=>{
  for(let i=0;i<7;i++)await seed(`a${i}`);
  const request=(query='',user='alice')=>admin.request(`/admin/files/migrate${query}`,{method:'POST',headers:f.auth(user)},withD1Budget(f.env),f.ctx);
  expect((await request('','bob')).status).toBe(403);
  const dry=await request('?dryRun=1');expect(dry.status).toBe(200);
  const preview=await dry.json() as {files:unknown[];next:number};expect(preview.files).toHaveLength(5);expect(preview.next).toBe(5);
  expect((await bucket.list()).objects).toHaveLength(0);
  let cursor = 0;
  const migrated: string[] = [];
  for (let i = 0; i < 7; i++) {
    const response = await request(cursor ? `?after=${cursor}` : '');
    expect(response.status).toBe(200);
    const page = await response.json() as {files: {id: string; storage: string}[]; next: number | null};
    expect(page.files.length).toBeGreaterThan(0);
    expect(page.files.length).toBeLessThanOrEqual(5);
    for (const file of page.files) {
      expect(file.storage).toBe('r2');
      migrated.push(file.id);
    }
    if (!page.next) break;
    expect(page.next > cursor).toBe(true);
    cursor = page.next;
  }
  expect(migrated).toEqual(['a0','a1','a2','a3','a4','a5','a6']);
  expect((await bucket.list()).objects).toHaveLength(7);
});
it('serves only shared files with the same SVG sanitization and rechecks a revoked share after external I/O',async()=>{
  await seed('asset',new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1"/></svg>'),'image/svg+xml');
  await finalize(f.env,'asset');
  await f.db.prepare("INSERT INTO shares(token,target_type,page_id,created_by,created_at) VALUES('pub','page','page','alice',1)").run();
  const good=await publicApi.request('/pub/files/asset',{},f.env,f.ctx);
  expect(good.status).toBe(200);expect(good.headers.get('content-security-policy')).toContain('sandbox');
  expect((await publicApi.request('/pub/files/unshared',{},f.env,f.ctx)).status).toBe(404);
  const env={...f.env,FILES:intercept('get',async(...args)=>{const object=await bucket.get(args[0] as string);await f.db.prepare("DELETE FROM shares WHERE token='pub'").run();return object;})};
  expect((await publicApi.request('/pub/files/asset',{},env,f.ctx)).status).toBe(404);
});
it('promotes public form uploads and preserves owner-only activation defaults',async()=>{
  await applyChanges(f.env,'alice',[
    {id:'board',collection:'boards',patch:{name:'Board',columns:[{id:'open'}],fields:[]},ts:1},
    {id:'form',collection:'forms',patch:{databaseId:'board',title:'Upload',enabled:true,fields:[{fieldKey:'title',label:'Name',required:true}]},ts:1},
  ]);
  await f.db.prepare("INSERT INTO form_tokens(token,form_id,created_at) VALUES('public-form','form',1)").run();
  const data=new FormData();data.set('turnstileToken','pass');data.set('file',new File([bytes],'image.png',{type:'image/png'}));
  const response=await publicFormsApi.request('http://localhost/public-form/files',{method:'POST',body:data},withD1Budget(f.env),f.ctx);
  expect(response.status).toBe(200);const {id}=await response.json() as {id:string};
  expect((await meta(id))?.storage).toBe('r2');expect(await readBytes(f.env,(await meta(id))!)).toEqual(bytes);
});

it('rechecks the current admin session before promotion commits', async () => {
  await seed();
  const env = {...f.env, FILES: intercept('get', async (...args) => {
    const stored = await bucket.get(args[0] as string);
    await f.db.prepare("DELETE FROM sessions WHERE user_id='alice'").run();
    return stored;
  })};
  const response = await admin.request('/admin/files/migrate', {method:'POST', headers:f.auth('alice')}, withD1Budget(env), f.ctx);
  expect([401, 409]).toContain(response.status);
  expect((await meta('asset'))?.storage).toBe('d1');
  expect(await readBytes(f.env, (await meta('asset'))!)).toEqual(bytes);
});

it('reads exact R2 bytes for transcription through a simulated provider', async () => {
  await seed('asset', bytes, 'audio/webm');
  await finalize(f.env, 'asset');
  const run = vi.fn(async (_model: string, input: {audio:string}) => {
    expect(Buffer.from(input.audio, 'base64')).toEqual(Buffer.from(bytes));
    return {text:'Fixture transcript'};
  });
  const env = {...f.env, AUDIO_TRANSCRIPTION: 'on' as const, AI:{run} as unknown as typeof f.env.AI};
  const response = await files.request('/asset/transcribe', {method:'POST', headers:f.auth('alice')}, withD1Budget(env), f.ctx);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({text:'Fixture transcript'});
  expect(run).toHaveBeenCalledTimes(1);
});

it('restores byte-identical reads from synchronized metadata and private object copies', async () => {
  await seed();
  await finalize(f.env, 'asset');
  const metadata = (await meta('asset'))!;
  const object = (await bucket.get(metadata.r2_key!))!;
  const backup = await object.arrayBuffer();
  const restored = await openAuditFixture(undefined, {FILE_STORAGE:'d1'}, undefined, true);
  try {
    await restored.db.prepare(`INSERT INTO files(id,mime,size,chunks,complete,storage,r2_key,sha256)
      VALUES(?,?,?,?,1,'r2',?,?)`).bind(metadata.id, metadata.mime, metadata.size, metadata.chunks, metadata.r2_key, metadata.sha256).run();
    expect(await readBytes(restored.env, metadata)).toBeNull();
    await restored.env.FILES!.put(metadata.r2_key!, backup, {
      sha256: metadata.sha256!,
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
    });
    expect(await readBytes(restored.env, metadata)).toEqual(bytes);
  } finally {
    await restored.dispose();
  }
});

it('withholds R2 bytes after an enabled-mode membership changes during the read', async () => {
  await seed();
  await finalize(f.env, 'asset');
  await f.db.batch([
    f.db.prepare("UPDATE access_state SET enabled=1"),
    f.db.prepare("UPDATE users SET workspace_role='guest' WHERE id='bob'"),
    f.db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('space-core','bob','viewer')"),
  ]);
  const request = (env: typeof f.env) => files.request('/asset', {headers:f.auth('bob')}, withD1Budget(env), f.ctx);
  const visible = await request(f.env);
  expect(visible.status).toBe(200);
  expect(await visible.text()).toBe('original file bytes');
  const env = {...f.env, FILES: intercept('get', async (...args) => {
    const stored = await bucket.get(args[0] as string);
    await f.db.prepare("DELETE FROM space_members WHERE user_id='bob'").run();
    return stored;
  })};
  const revoked = await request(env);
  expect(revoked.status).toBe(409);
  expect(await revoked.text()).not.toContain('original file bytes');
  expect((await request(f.env)).status).toBe(404);
});
