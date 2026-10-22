import {readFileSync,readdirSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {websiteIngestApi,websiteRecordId,IngestBody} from '../worker/websiteIngest';
import {applyChanges} from '../worker/sync';
import {blocksToMarkdown} from '../shared/markdown';
import {cmpOrder} from '../shared/order';
import {WEBSITE_INBOX_ID} from '../shared/websiteInbox';
import type {Env} from '../worker/auth';

vi.mock('../worker/events',async original=>({...await original<typeof import('../worker/events')>(),scheduleOutbox:vi.fn()}));

// Disposable fixture value: not a deployed secret.
const SECRET='test-only-website-ingest-key';
let mf:Miniflare,db:D1Database,env:Env;
const ctx={waitUntil:(_p:Promise<unknown>)=>{},passThroughOnException:()=>{}} as ExecutionContext;

beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'website-ingest',modules:true,script:'export default {fetch(){return new Response("local")}}',compatibilityDate:'2026-09-25',d1Databases:{DB:'disposable-website-ingest'}}]}));
  db=await mf.getD1Database('DB') as D1Database;
  const folder=fileURLToPath(new URL('../migrations/',import.meta.url));
  for(const file of readdirSync(folder).filter(f=>f.endsWith('.sql')).sort()) {
    const sql=readFileSync(`${folder}/${file}`,'utf8').replace(/--[^\n]*/g,'');
    const statements=sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi)??[];
    await db.batch(statements.map(s=>db.prepare(s.trim())));
  }
  env={DB:db,WEBSITE_INGEST_SECRET:SECRET,WEBSITE_INGEST_ENABLED:'1'} as Env;
  await db.batch([
    db.prepare("INSERT INTO users(id,username,name,role,prefs) VALUES('alice','alice','Alice','admin',NULL)"),
    db.prepare("INSERT INTO users(id,username,name,role,prefs) VALUES('bob','bob','Bob','member',NULL)"),
  ]);
});
afterEach(async()=>{vi.useRealTimers();await mf?.dispose();});

const now=()=>Math.floor(Date.now()/1000);
function sign(raw:string,ts=now(),secret=SECRET) {
  return {'Content-Type':'application/json','X-TCG-Timestamp':String(ts),'X-TCG-Signature':'sha256='+createHmac('sha256',secret).update(`${ts}.${raw}`).digest('hex')};
}
async function post(raw:string,headers:Record<string,string>=sign(raw),bindings:Env=env) {
  const response=await websiteIngestApi.request('http://localhost/',{method:'POST',headers,body:raw},bindings,ctx);
  const text=await response.text();
  return {status:response.status,body:(()=>{try{return JSON.parse(text) as Record<string,unknown>;}catch{return {error:text};}})()};
}
const send=(body:unknown,ts?:number)=>{const raw=JSON.stringify(body);return post(raw,sign(raw,ts));};

function formEvent(over:Record<string,unknown>={}) {
  return {id:'evt_form_1',event:'form.submitted',occurred_at:'2026-10-22T10:00:00Z',form_id:'contact',subject:'Contact',page:'https://thecommonground.living/contact/',reply_to:'ada@example.com',
    answers:[{name:'name',label:'Name',value:'Ada Lovelace'},{name:'email',label:'Email',value:'ada@example.com'},{name:'message',label:'Message',value:'Hello there.\n\n- one\n- two'}],...over};
}
function patronEvent(event:string,id:string,patron:Record<string,unknown>={},over:Record<string,unknown>={}) {
  return {id,event,occurred_at:'2026-10-22T10:00:00Z',form_id:'patron',subject:'Patron application',reply_to:'grace@example.com',answers:[],
    patron:{application_id:'pa_123',tier:'founding',currency:'inr',...patron},...over};
}
async function rec(id:string) {
  const row=await db.prepare('SELECT data FROM records WHERE id=?').bind(id).first<{data:string}>();
  return row?JSON.parse(row.data) as Record<string,unknown>:null;
}
async function tasks() {return (await db.prepare("SELECT id FROM records WHERE collection='tasks'").all<{id:string}>()).results;}
async function body(recordId:string) {
  const {results}=await db.prepare("SELECT data FROM records WHERE collection='blocks' AND json_extract(data,'$.pageId')=?").bind(recordId).all<{data:string}>();
  return results.map(r=>JSON.parse(r.data) as Record<string,unknown>).sort((a,b)=>cmpOrder(String(a.order),String(b.order)));
}

describe('configuration and size',()=>{
  it('answers 503 when ingest is off or has no secret',async()=>{
    expect((await post('{}',sign('{}'),{...env,WEBSITE_INGEST_ENABLED:'0'})).status).toBe(503);
    expect((await post('{}',sign('{}'),{...env,WEBSITE_INGEST_ENABLED:undefined})).status).toBe(503);
    expect((await post('{}',sign('{}'),{...env,WEBSITE_INGEST_SECRET:''})).status).toBe(503);
  });
  it('answers 413 over 64 KB before anything else',async()=>{
    const raw=JSON.stringify({...formEvent(),pad:'x'.repeat(65*1024)});
    expect((await post(raw)).status).toBe(413);
    expect(await db.prepare('SELECT COUNT(*) n FROM website_ingest').first<{n:number}>()).toEqual({n:0});
  });
});

describe('signature',()=>{
  it('accepts a valid signature',async()=>{
    const res=await send(formEvent());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ok:true,id:'evt_form_1',action:'created'});
  });
  it('rejects a tampered body, wrong secret, missing or malformed headers',async()=>{
    const raw=JSON.stringify(formEvent());
    const good=sign(raw);
    expect((await post(raw.replace('Ada','Eve'),good)).status).toBe(401);
    expect((await post(raw,sign(raw,now(),'another-test-key'))).status).toBe(401);
    expect((await post(raw,{'Content-Type':'application/json'})).status).toBe(401);
    expect((await post(raw,{...good,'X-TCG-Signature':good['X-TCG-Signature'].slice(7)})).status).toBe(401);
    expect((await post(raw,{...good,'X-TCG-Signature':'sha256=zz'})).status).toBe(401);
    expect((await post(raw,{...good,'X-TCG-Timestamp':'12.5'})).status).toBe(401);
    expect(await tasks()).toHaveLength(0);
  });
  it('rejects timestamps outside ±300 s',async()=>{
    expect((await send(formEvent(),now()-301)).status).toBe(401);
    expect((await send(formEvent(),now()+301)).status).toBe(401);
    expect((await send(formEvent(),now()-290)).status).toBe(200);
  });
  it('a replay inside the window returns the first result; after the window it is refused',async()=>{
    const raw=JSON.stringify(formEvent());
    const headers=sign(raw);
    const first=await post(raw,headers);
    const again=await post(raw,headers);
    expect(again).toEqual(first);
    expect(await tasks()).toHaveLength(1);
    vi.useFakeTimers({toFake:['Date']});
    vi.setSystemTime(Date.now()+301_000);
    expect((await post(raw,headers)).status).toBe(401);
  });
});

describe('schema',()=>{
  it.each([
    ['bad event',formEvent({event:'form.deleted'})],
    ['non-string value',formEvent({answers:[{name:'n',label:'N',value:5}]})],
    ['41 answers',formEvent({answers:Array.from({length:41},(_,i)=>({name:'a'+i,label:'A',value:'v'}))})],
    ['value over 5000 chars',formEvent({answers:[{name:'n',label:'N',value:'x'.repeat(5001)}]})],
    ['missing id',formEvent({id:''})],
    ['bad date',formEvent({occurred_at:'yesterday'})],
    ['patron event without patron',patronEvent('patron.paid','evt_p',{},{patron:undefined})],
  ])('rejects %s with 400 and writes nothing',async(_name,bad)=>{
    const res=await send(bad);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_body');
    expect(JSON.stringify(res.body)).not.toContain('xxxxx');
    expect(await tasks()).toHaveLength(0);
    expect(await db.prepare('SELECT COUNT(*) n FROM website_ingest').first<{n:number}>()).toEqual({n:0});
  });
  it('rejects invalid JSON with 400',async()=>{
    expect((await post('{nope')).status).toBe(400);
  });
});

describe('idempotency',()=>{
  it('the same id and body re-signed later returns the first result once',async()=>{
    const first=await send(formEvent(),now()-100);
    const retry=await send(formEvent(),now());
    expect(retry).toEqual(first);
    expect(await tasks()).toHaveLength(1);
  });
  it('the same id with a different body is a 409 conflict',async()=>{
    await send(formEvent());
    const res=await send(formEvent({subject:'Changed'}));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ingest_conflict');
    expect(await tasks()).toHaveLength(1);
  });
  it('a failed write leaves the event pending so the relay retry completes it',async()=>{
    await db.prepare("UPDATE access_state SET enabled=1 WHERE id=1").run();
    const blocked=await send(formEvent());
    expect(blocked.status).toBe(503);
    expect(blocked.body.retryable).toBe(true);
    expect((await db.prepare("SELECT state FROM website_ingest WHERE event_id='evt_form_1'").first<{state:string}>())?.state).toBe('pending');
    await db.prepare("UPDATE access_state SET enabled=0 WHERE id=1").run();
    expect((await send(formEvent())).status).toBe(200);
    expect((await db.prepare("SELECT state FROM website_ingest WHERE event_id='evt_form_1'").first<{state:string}>())?.state).toBe('accepted');
  });
});

describe('records',()=>{
  it('form.submitted bootstraps the inbox and creates one record with fields, body and an admin notification',async()=>{
    const res=await send(formEvent());
    const recordId=String(res.body.recordId);
    expect(recordId).toBe(websiteRecordId(IngestBody.parse(formEvent())));
    const board=await rec(WEBSITE_INBOX_ID);
    expect(board).toMatchObject({name:'Website inbox',kind:'records'});
    const r=await rec(recordId);
    expect(r).toMatchObject({boardId:WEBSITE_INBOX_ID,title:'Contact — Ada Lovelace',status:'new',p_wi_source:'contact',p_wi_email:'ada@example.com',p_wi_page:'https://thecommonground.living/contact/',p_wi_event:'form.submitted',deleted:false});
    const md=blocksToMarkdown(await body(recordId));
    expect(md).toContain('### Name\n\nAda Lovelace');
    expect(md).toContain('### Message\n\nHello there.');
    expect(md).toMatch(/- one\n+- two/);
    expect(md).toContain('Form submitted · 2026-10-22');
    const notes=(await db.prepare('SELECT user_id,kind,target_id,url FROM notifications').all<Record<string,unknown>>()).results;
    expect(notes).toEqual([{user_id:'alice',kind:'form_submission',target_id:recordId,url:`/tasks/${recordId}`}]);
  });
  it('neutralizes hostile answers: no mention tokens, no image or embed blocks',async()=>{
    const res=await send(formEvent({answers:[
      {name:'name',label:'Name @[user:alice]',value:'Mallory @[user:alice] [[Secret page]]'},
      {name:'pic',label:'Picture',value:'![x](https://evil.example/pixel.png)'},
      {name:'doc',label:'Doc',value:'https://drive.google.com/file/d/abc123/view'},
      {name:'fence',label:'Code',value:'```\nunterminated'},
      {name:'after',label:'After fence',value:'still its own answer'},
    ]}));
    expect(res.status).toBe(200);
    const blocks=await body(String(res.body.recordId));
    const text=JSON.stringify(blocks);
    expect(text).not.toMatch(/@\[user:/);
    expect(text).not.toContain('[[');
    expect(blocks.map(b=>b.type)).not.toContain('image');
    expect(blocks.map(b=>b.type)).not.toContain('embed');
    expect(blocks.some(b=>b.src)).toBe(false);
    expect(blocks.some(b=>b.type==='h3'&&b.text==='After fence')).toBe(true);
    expect((await rec(String(res.body.recordId)))!.title).not.toMatch(/@\[user:/);
  });
  it('patron events with one application id merge into one record and keep team edits',async()=>{
    const applied=await send(patronEvent('patron.applied','evt_a',{},{answers:[{name:'name',label:'Name',value:'Grace Hopper'},{name:'motivation',label:'Motivation',value:'Build together.'}]}));
    expect(applied.body.action).toBe('created');
    const recordId=String(applied.body.recordId);
    // The team moves it on and renames it.
    await applyChanges(env,'alice',[{id:recordId,collection:'tasks',patch:{status:'in_review',title:'Grace (founding)'},ts:Date.now()}]);
    const paid=await send(patronEvent('patron.paid','evt_b',{amount_display:'₹50,000'},{occurred_at:'2026-10-23T10:00:00Z'}));
    const minted=await send(patronEvent('patron.minted','evt_c',{edition:7,token_id:'1000007',tx:'0xabc'},{occurred_at:'2026-10-24T10:00:00Z'}));
    expect(paid.body).toMatchObject({action:'updated',recordId});
    expect(minted.body).toMatchObject({action:'updated',recordId});
    expect(await tasks()).toHaveLength(1);
    const r=await rec(recordId);
    expect(r).toMatchObject({status:'in_review',title:'Grace (founding)',p_wi_event:'patron.minted',p_wi_edition:'7',p_wi_tier:'founding',p_wi_application:'pa_123'});
    const md=blocksToMarkdown(await body(recordId));
    expect(md).toContain('### Motivation\n\nBuild together.');
    expect(md.indexOf('Patron applied')).toBeLessThan(md.indexOf('Patron paid'));
    expect(md.indexOf('Patron paid')).toBeLessThan(md.indexOf('Patron minted'));
    expect(md).toContain('edition 7 · token 1000007 · tx 0xabc');
    // A retried update appends nothing twice.
    expect(await send(patronEvent('patron.minted','evt_c',{edition:7,token_id:'1000007',tx:'0xabc'},{occurred_at:'2026-10-24T10:00:00Z'}))).toEqual(minted);
    expect(blocksToMarkdown(await body(recordId)).match(/Patron minted/g)).toHaveLength(1);
  });
  it('an out-of-order patron event creates the record and a late applied fills it in without rolling Event back',async()=>{
    const minted=await send(patronEvent('patron.minted','evt_m',{edition:'007'},{occurred_at:'2026-10-24T10:00:00Z'}));
    const recordId=String(minted.body.recordId);
    expect((await rec(recordId))!.title).toBe('Patron application');
    const applied=await send(patronEvent('patron.applied','evt_a',{},{occurred_at:'2026-10-22T10:00:00Z',answers:[{name:'name',label:'Name',value:'Grace Hopper'}]}));
    expect(applied.body).toMatchObject({action:'updated',recordId});
    expect(await tasks()).toHaveLength(1);
    expect(await rec(recordId)).toMatchObject({title:'Patron application — Grace Hopper',p_wi_event:'patron.minted',p_wi_edition:'007'});
    expect(blocksToMarkdown(await body(recordId))).toContain('### Name\n\nGrace Hopper');
  });
});
