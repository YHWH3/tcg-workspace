import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {mintToken,publicFormsApi} from '../worker/forms';
import {runScheduled} from '../worker/reminders';
import {applyChanges} from '../worker/sync';
import type {Env} from '../worker/auth';

let mf:Miniflare,db:D1Database,env:Env;
const ctx={waitUntil:()=>{},passThroughOnException:()=>{}} as unknown as ExecutionContext;
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'phase4-residual',modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-09-25',d1Databases:{DB:'disposable-residual'}}]}));
  db=await mf.getD1Database('DB') as D1Database;
  env={DB:db,WORKSPACE_ENV:'local-test',TURNSTILE_LOCAL_TEST:'1'} as Env;
  const folder=fileURLToPath(new URL('../migrations/',import.meta.url));
  for(const file of readdirSync(folder).filter(f=>f.endsWith('.sql')).sort()){
    const sql=readFileSync(`${folder}/${file}`,'utf8').replace(/--[^\n]*/g,'');
    await db.batch((sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi)??[]).map(s=>db.prepare(s.trim())));
  }
  await db.prepare("INSERT INTO users(id,username,name,role) VALUES('alice','alice','Alice','admin')").run();
});
afterEach(()=>mf.dispose());

it('keeps a terminal outbox row instead of deleting it',async()=>{
  await db.prepare("INSERT INTO event_outbox(id,payload,created_at,attempts) VALUES('stuck','{\"source\":\"client\",\"applied\":[]}',?,8)").bind(Date.now()).run();
  await db.prepare("INSERT INTO event_outbox(id,payload,created_at,processed_at) VALUES('done','{\"source\":\"client\",\"applied\":[]}',1,1)").run();
  await runScheduled(env);
  const stuck=await db.prepare('SELECT terminal_at, processed_at FROM event_outbox WHERE id=?').bind('stuck').first<{terminal_at:number|null;processed_at:number|null}>();
  expect(stuck).not.toBeNull();
  expect(stuck!.terminal_at).toBeTruthy();
  expect(stuck!.processed_at).toBeNull();
  expect((await db.prepare("SELECT COUNT(*) n FROM event_outbox WHERE id='done'").first<{n:number}>())!.n).toBe(0);
});

it('mints form tokens with 22 unbiased base62 characters',()=>{
  const tokens=Array.from({length:40},()=>mintToken());
  expect(new Set(tokens).size).toBe(40);
  for(const token of tokens){
    expect(token).toMatch(/^tok_[0-9A-Za-z]{22}$/);
    expect(token.slice(4)).not.toBe('0'.repeat(22));
  }
});

it('does not serve a disabled form from an earlier enabled response',async()=>{
  await applyChanges(env,'alice',[{id:'board',collection:'boards',patch:{name:'Board',columns:[{id:'open'}],fields:[]},ts:1},{id:'form',collection:'forms',patch:{databaseId:'board',title:'Open form',enabled:true,fields:[{fieldKey:'title',label:'Your name',required:true}],successMessage:'ok'},ts:1}]);
  await db.prepare("INSERT INTO form_tokens(token,form_id,created_at) VALUES('live','form',1)").run();
  const enabled=await publicFormsApi.request('http://localhost/live',{},env,ctx);
  expect(enabled.status).toBe(200);
  expect(enabled.headers.get('cache-control')).toBe('no-store');
  expect(await enabled.json()).toMatchObject({title:'Open form'});
  await db.prepare("UPDATE records SET data=json_set(data,'$.enabled',json('false')) WHERE id='form'").run();
  const disabled=await publicFormsApi.request('http://localhost/live',{},env,ctx);
  expect(disabled.status).toBe(410);
  expect(disabled.headers.get('cache-control')).toBe('no-store');
  expect(await disabled.json()).toEqual({error:'unavailable'});
});
