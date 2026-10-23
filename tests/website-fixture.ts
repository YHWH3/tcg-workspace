// Shared disposable D1 fixture for the Website inbox tests (ingest, AI, MCP).
// Each request runs under the production invocation budget (withD1Budget) so
// tests catch a path that would exhaust it.
import {readFileSync,readdirSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {websiteIngestApi} from '../worker/websiteIngest';
import {processOutbox} from '../worker/events';
import {withD1Budget,d1BudgetRemaining} from '../worker/d1budget';
import type {Env} from '../worker/auth';

// Disposable fixture value: not a deployed secret.
export const SECRET='test-only-website-ingest-key';
export const ctx={waitUntil:(_p:Promise<unknown>)=>{},passThroughOnException:()=>{}} as ExecutionContext;

export interface Fixture {mf:Miniflare;db:D1Database;env:Env;maxBudgetUsed:number}

export async function website(name:string,admins=['alice','carol','dave']):Promise<Fixture> {
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name,modules:true,script:'export default {fetch(){return new Response("local")}}',compatibilityDate:'2026-09-25',d1Databases:{DB:`disposable-${name}`}}]}));
  const db=await mf.getD1Database('DB') as D1Database;
  const folder=fileURLToPath(new URL('../migrations/',import.meta.url));
  for(const file of readdirSync(folder).filter(f=>f.endsWith('.sql')).sort()) {
    const sql=readFileSync(`${folder}/${file}`,'utf8').replace(/--[^\n]*/g,'');
    const statements=sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi)??[];
    await db.batch(statements.map(s=>db.prepare(s.trim())));
  }
  const env={DB:db,WEBSITE_INGEST_SECRET:SECRET,WEBSITE_INGEST_ENABLED:'true'} as Env;
  await db.batch([
    ...admins.map(id=>db.prepare("INSERT INTO users(id,username,name,role,prefs) VALUES(?,?,?,'admin',NULL)").bind(id,id,id[0]!.toUpperCase()+id.slice(1))),
    db.prepare("INSERT INTO users(id,username,name,role,prefs) VALUES('bob','bob','Bob','member',NULL)"),
  ]);
  await db.prepare("INSERT INTO website_ingest_grant(id,sponsor_id,space_id,inbox_id,people_id,updated_at) VALUES(1,?,'space-core','board-website-inbox','board-website-people',?)").bind(admins[0]??'bob',Date.now()).run();
  return {mf,db,env,maxBudgetUsed:0};
}

export const nowS=()=>Math.floor(Date.now()/1000);
export function sign(raw:string,ts=nowS(),secret=SECRET) {
  return {'Content-Type':'application/json','X-TCG-Timestamp':String(ts),'X-TCG-Signature':'sha256='+createHmac('sha256',secret).update(`${ts}.${raw}`).digest('hex')};
}

/** POST through the route under a fresh production-sized D1 budget. */
export async function post(f:Fixture,raw:string,headers:Record<string,string>=sign(raw),bindings:Env=f.env) {
  const budgeted=withD1Budget({...bindings});
  const response=await websiteIngestApi.request('http://localhost/',{method:'POST',headers,body:raw},budgeted,ctx);
  f.maxBudgetUsed=Math.max(f.maxBudgetUsed,45-d1BudgetRemaining(budgeted.DB));
  const text=await response.text();
  return {status:response.status,body:(()=>{try{return JSON.parse(text) as Record<string,unknown>;}catch{return {error:text};}})()};
}
export const send=(f:Fixture,body:unknown,ts?:number)=>{const raw=JSON.stringify(body);return post(f,raw,sign(raw,ts));};

/** Deliver what scheduleOutbox would have (it is mocked in tests). */
export async function drainOutbox(f:Fixture) {
  const {results}=await f.db.prepare('SELECT id FROM event_outbox WHERE processed_at IS NULL ORDER BY created_at,id').all<{id:string}>();
  for(const r of results) await processOutbox(f.env,r.id);
}

export async function rec(f:Fixture,id:string) {
  const row=await f.db.prepare('SELECT data FROM records WHERE id=?').bind(id).first<{data:string}>();
  return row?JSON.parse(row.data) as Record<string,unknown>:null;
}
export async function inboxRecords(f:Fixture) {
  return (await f.db.prepare("SELECT id,data FROM records WHERE collection='tasks' AND json_extract(data,'$.boardId')='board-website-inbox'").all<{id:string;data:string}>()).results.map(r=>({id:r.id,...JSON.parse(r.data) as Record<string,unknown>}));
}

/* ---------- event builders (contract v2, docs/integrations/the-common-ground.md) ---------- */

export const PATRON_FORM={id:'patron',title:'Patron application',family:'patrons',fields:[
  {name:'Name',label:'Your name',type:'text',required:true},
  {name:'Email',label:'Email',type:'email',required:true},
  {name:'Country',label:'Country',type:'text'},
  {name:'Edition',label:'The edition you are interested in',type:'choice',required:true,options:['Founding Patron','Builder Patron','Partner Patron']},
  {name:'Currency',label:'Currency',type:'choice',options:['INR','USD','Another currency']},
  {name:'Why',label:'Why',type:'textarea'},
]};
export const CONSULTING_FORM={id:'consulting',title:'Project application',family:'consulting',fields:[
  {name:'Name',label:'Your name',type:'text',required:true},
  {name:'Email',label:'Email',type:'email',required:true},
  {name:'Building',label:'What are you building?',type:'choices',options:['Primary home','Farmstead or homestead','Community education or arts space','Retreat or studio','Adaptive reuse or restoration','Other']},
  {name:'Built area',label:'Built area',type:'choice',options:['Under 800 sq.ft. (75 m²)','800 to 1500 sq.ft. (75 to 140 m²)']},
  {name:'Site',label:'A link to the site',type:'url'},
  {name:'Phone',label:'Phone',type:'tel'},
  {name:'Why',label:'Why',type:'textarea'},
]};

export function consultingEvent(id:string,over:Record<string,unknown>={}) {
  return {v:2,id,event:'form.submitted',occurred_at:'2026-10-22T10:26:41.204Z',form_id:'consulting',subject:'Project application',page:'/consulting/',reply_to:'ada@example.com',form:CONSULTING_FORM,
    answers:[{name:'Name',label:'Your name',value:'Ada Lovelace'},{name:'Email',label:'Email',value:'ada@example.com'},
      {name:'Building',label:'What are you building?',value:'Community education or arts space, Retreat or studio'},
      {name:'Built area',label:'Built area',value:'800 to 1500 sq.ft. (75 to 140 m²)'},
      {name:'Site',label:'A link to the site',value:'https://maps.example.com/site'},{name:'Phone',label:'Phone',value:'+91 98000 00000'},
      {name:'Why',label:'Why',value:'A place to teach earth building.'}],...over};
}
export function patronEvent(event:string,application='pa_123',patron:Record<string,unknown>={},over:Record<string,unknown>={}) {
  const applied=event==='patron.applied';
  return {v:2,id:`${application}:${event}`,event,occurred_at:'2026-10-22T10:00:00.000Z',form_id:'patron',subject:'Patron application',page:'/patron/',reply_to:'grace@example.com',
    ...(applied?{form:PATRON_FORM}:{}),
    answers:applied?[{name:'Name',label:'Your name',value:'Grace Hopper'},{name:'Email',label:'Email',value:'grace@example.com'},{name:'Edition',label:'The edition you are interested in',value:'Founding Patron'},{name:'Currency',label:'Currency',value:'INR'},{name:'Why',label:'Why',value:'Build together.'}]:[],
    patron:{application_id:application,tier:'founding',currency:'inr',amount_display:'₹85,000',edition:null,tx:null,token_id:null,...patron},...over};
}
