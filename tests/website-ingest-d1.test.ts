import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {websiteRecordId,IngestBody,choosePeopleDatabase} from '../worker/websiteIngest';
import {applyChanges} from '../worker/sync';
import {blocksToMarkdown} from '../shared/markdown';
import {cmpOrder} from '../shared/order';
import {fieldsOf} from '../shared/fields';
import {WEBSITE_INBOX_ID,WEBSITE_PEOPLE_ID,typedFieldId,splitChoices,familyForForm,mergeFieldDefs,WEBSITE_BUILTIN_FIELDS} from '../shared/websiteInbox';
import {website,send,post,sign,nowS,drainOutbox,rec,consultingEvent,patronEvent,type Fixture} from './website-fixture';

vi.mock('../worker/events',async original=>({...await original<typeof import('../worker/events')>(),scheduleOutbox:vi.fn()}));

let f:Fixture;
beforeEach(async()=>{f=await website('website-ingest');});
afterEach(async()=>{vi.useRealTimers();expect(f.maxBudgetUsed).toBeLessThanOrEqual(40);await f.mf?.dispose();});

/** v1 body: no `v`, no `form` (still accepted). */
function v1Form(over:Record<string,unknown>={}) {
  return {id:'evt_form_1',event:'form.submitted',occurred_at:'2026-10-22T10:00:00Z',form_id:'contact',subject:'Contact',page:'https://thecommonground.living/contact/',reply_to:'ada@example.com',
    answers:[{name:'name',label:'Name',value:'Ada Lovelace'},{name:'email',label:'Email',value:'ada@example.com'},{name:'message',label:'Message',value:'Hello there.\n\n- one\n- two'}],...over};
}
const tasks=async()=>(await f.db.prepare("SELECT id FROM records WHERE collection='tasks' AND json_extract(data,'$.boardId')=?").bind(WEBSITE_INBOX_ID).all<{id:string}>()).results;
async function body(recordId:string) {
  const {results}=await f.db.prepare("SELECT data FROM records WHERE collection='blocks' AND json_extract(data,'$.pageId')=?").bind(recordId).all<{data:string}>();
  return results.map(r=>JSON.parse(r.data) as Record<string,unknown>).sort((a,b)=>cmpOrder(String(a.order),String(b.order)));
}

describe('configuration and size',()=>{
  it('answers 503 when ingest is off or has no secret',async()=>{
    expect((await post(f,'{}',sign('{}'),{...f.env,WEBSITE_INGEST_ENABLED:'0'})).status).toBe(503);
    expect((await post(f,'{}',sign('{}'),{...f.env,WEBSITE_INGEST_ENABLED:undefined})).status).toBe(503);
    expect((await post(f,'{}',sign('{}'),{...f.env,WEBSITE_INGEST_SECRET:''})).status).toBe(503);
  });
  it('answers 413 over 64 KB before anything else',async()=>{
    const raw=JSON.stringify({...v1Form(),pad:'x'.repeat(65*1024)});
    expect((await post(f,raw)).status).toBe(413);
    expect(await f.db.prepare('SELECT COUNT(*) n FROM website_ingest').first<{n:number}>()).toEqual({n:0});
  });
});

describe('signature',()=>{
  it('accepts a valid signature',async()=>{
    const res=await send(f,v1Form());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ok:true,id:'evt_form_1',action:'created',family:'general'});
  });
  it('rejects a tampered body, wrong secret, missing or malformed headers',async()=>{
    const raw=JSON.stringify(v1Form());
    const good=sign(raw);
    expect((await post(f,raw.replace('Ada','Eve'),good)).status).toBe(401);
    expect((await post(f,raw,sign(raw,nowS(),'another-test-key'))).status).toBe(401);
    expect((await post(f,raw,{'Content-Type':'application/json'})).status).toBe(401);
    expect((await post(f,raw,{...good,'X-TCG-Signature':good['X-TCG-Signature'].slice(7)})).status).toBe(401);
    expect((await post(f,raw,{...good,'X-TCG-Signature':'sha256=zz'})).status).toBe(401);
    expect((await post(f,raw,{...good,'X-TCG-Timestamp':'12.5'})).status).toBe(401);
    expect(await tasks()).toHaveLength(0);
  });
  it('rejects timestamps outside ±300 s',async()=>{
    expect((await send(f,v1Form(),nowS()-301)).status).toBe(401);
    expect((await send(f,v1Form(),nowS()+301)).status).toBe(401);
    expect((await send(f,v1Form(),nowS()-290)).status).toBe(200);
  });
  it('a replay inside the window returns the first result; after the window it is refused',async()=>{
    const raw=JSON.stringify(v1Form());
    const headers=sign(raw);
    const first=await post(f,raw,headers);
    expect(await post(f,raw,headers)).toEqual(first);
    expect(await tasks()).toHaveLength(1);
    vi.useFakeTimers({toFake:['Date']});
    vi.setSystemTime(Date.now()+301_000);
    expect((await post(f,raw,headers)).status).toBe(401);
  });
});

describe('schema and contract versions',()=>{
  it.each([
    ['bad event',v1Form({event:'form.deleted'})],
    ['non-string value',v1Form({answers:[{name:'n',label:'N',value:5}]})],
    ['41 answers',v1Form({answers:Array.from({length:41},(_,i)=>({name:'a'+i,label:'A',value:'v'}))})],
    ['value over 5000 chars',v1Form({answers:[{name:'n',label:'N',value:'x'.repeat(5001)}]})],
    ['missing id',v1Form({id:''})],
    ['bad date',v1Form({occurred_at:'yesterday'})],
    ['patron event without patron',patronEvent('patron.paid','pa_1',{},{patron:undefined})],
    ['unknown contract version',consultingEvent('evt_v3',{v:3})],
    ['family that is not an id',consultingEvent('evt_fam',{form:{id:'consulting',title:'x',family:'Consulting Team',fields:[]}})],
  ])('rejects %s with 400 and writes nothing',async(_name,bad)=>{
    const res=await send(f,bad);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_body');
    expect(JSON.stringify(res.body)).not.toContain('xxxxx');
    expect(await tasks()).toHaveLength(0);
    expect(await f.db.prepare('SELECT COUNT(*) n FROM website_ingest').first<{n:number}>()).toEqual({n:0});
  });
  it('rejects invalid JSON with 400',async()=>{
    expect((await post(f,'{nope')).status).toBe(400);
  });
  it('accepts v1 (family derived from the form id), v2 with millisecond timestamps and the relay truncated flag',async()=>{
    expect((await send(f,v1Form({id:'v1_vol',form_id:'vol-short-term'}))).body.family).toBe('join');
    expect((await send(f,consultingEvent('v2_ms',{truncated:true}))).status).toBe(200);
    expect(familyForForm('arch')).toBe('consulting');
    expect(familyForForm('unknown-form')).toBe('general');
  });
});

describe('idempotency',()=>{
  it('the same id and body re-signed later returns the first result once',async()=>{
    const first=await send(f,v1Form(),nowS()-100);
    expect(await send(f,v1Form(),nowS())).toEqual(first);
    expect(await tasks()).toHaveLength(1);
  });
  it('the same id with a different body is a 409 conflict',async()=>{
    await send(f,v1Form());
    const res=await send(f,v1Form({subject:'Changed'}));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ingest_conflict');
    expect(await tasks()).toHaveLength(1);
  });
  it('a failed write leaves the event pending so the relay retry completes it',async()=>{
    await f.db.prepare('UPDATE access_state SET enabled=1 WHERE id=1').run();
    await f.db.prepare("CREATE TRIGGER fixture_write_outage BEFORE INSERT ON records WHEN NEW.collection='tasks' BEGIN SELECT RAISE(ABORT,'fixture storage unavailable'); END").run();
    const blocked=await send(f,v1Form());
    expect(blocked.status).toBe(503);
    expect(blocked.body.retryable).toBe(true);
    expect((await f.db.prepare("SELECT state FROM website_ingest WHERE event_id='evt_form_1'").first<{state:string}>())?.state).toBe('pending');
    await f.db.prepare('DROP TRIGGER fixture_write_outage').run();
    expect((await send(f,v1Form())).status).toBe(200);
    expect((await f.db.prepare("SELECT state FROM website_ingest WHERE event_id='evt_form_1'").first<{state:string}>())?.state).toBe('accepted');
  });
});

describe('records',()=>{
  it('bootstraps the inbox, views and one record with fields, a "Subject · Name" title, body and admin notifications',async()=>{
    const res=await send(f,v1Form());
    const recordId=String(res.body.recordId);
    expect(recordId).toBe(websiteRecordId(IngestBody.parse(v1Form())));
    expect(await rec(f,WEBSITE_INBOX_ID)).toMatchObject({name:'Website inbox',kind:'records'});
    for(const id of ['view-wi-all','view-wi-new','view-wi-pipeline','view-wi-fam-patrons','view-wi-fam-general']) expect(await rec(f,id)).toMatchObject({databaseId:WEBSITE_INBOX_ID});
    const r=await rec(f,recordId);
    expect(r).toMatchObject({boardId:WEBSITE_INBOX_ID,title:'Contact · Ada Lovelace',status:'new',p_wi_source:'contact',p_wi_family:'general',p_wi_received:'2026-10-22',p_wi_email:'ada@example.com',p_wi_page:'https://thecommonground.living/contact/',p_wi_event:'form.submitted',deleted:false});
    expect(String(r!.title)).not.toContain('—');
    const md=blocksToMarkdown(await body(recordId));
    expect(md).toContain('### Name\n\nAda Lovelace');
    expect(md).toMatch(/- one\n+- two/);
    expect(md).toContain('Form submitted · 2026-10-22');
    expect((await f.db.prepare('SELECT COUNT(*) n FROM notifications').first<{n:number}>())!.n).toBe(0);
    await drainOutbox(f);
    const notes=(await f.db.prepare('SELECT user_id,kind,target_id,url FROM notifications ORDER BY user_id').all<Record<string,unknown>>()).results;
    expect(notes).toEqual(['alice','carol','dave'].map(user_id=>({user_id,kind:'form_submission',target_id:recordId,url:`/tasks/${recordId}`})));
  });
  it('neutralizes hostile answers: no mention tokens, no image or embed blocks',async()=>{
    const res=await send(f,v1Form({answers:[
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
    expect((await rec(f,String(res.body.recordId)))!.title).not.toMatch(/@\[user:/);
  });
  it('patron events with one application id merge into one record, move the pipeline forward and keep team edits',async()=>{
    const applied=await send(f,patronEvent('patron.applied'));
    expect(applied.body).toMatchObject({action:'created',family:'patrons'});
    const recordId=String(applied.body.recordId);
    await applyChanges(f.env,'alice',[{id:recordId,collection:'tasks',patch:{status:'in_review',title:'Grace (founding)'},ts:Date.now()}]);
    await send(f,patronEvent('patron.approved','pa_123',{},{occurred_at:'2026-10-23T09:00:00.000Z'}));
    const paid=await send(f,patronEvent('patron.paid','pa_123',{},{occurred_at:'2026-10-23T10:00:00.000Z'}));
    const minted=await send(f,patronEvent('patron.minted','pa_123',{edition:12,token_id:'1000012',tx:'0xabc'},{occurred_at:'2026-10-24T10:00:00.000Z'}));
    expect(paid.body).toMatchObject({action:'updated',recordId});
    expect(minted.body).toMatchObject({action:'updated',recordId});
    expect(await tasks()).toHaveLength(1);
    expect(await rec(f,recordId)).toMatchObject({status:'in_review',title:'Grace (founding)',p_wi_event:'patron.minted',p_wi_stage:'minted',p_wi_edition:'12',p_wi_tier:'founding',p_wi_application:'pa_123',p_wi_paid:'₹85,000 INR',p_wi_token:'1000012',p_wi_page:'https://thecommonground.living/patron/'});
    const md=blocksToMarkdown(await body(recordId));
    expect(md).toContain('### Why\n\nBuild together.');
    expect(md.indexOf('Patron applied')).toBeLessThan(md.indexOf('Patron paid'));
    expect(md.indexOf('Patron paid')).toBeLessThan(md.indexOf('Patron minted'));
    expect(md).toContain('edition 12 · token 1000012 · tx 0xabc');
    expect(await send(f,patronEvent('patron.minted','pa_123',{edition:12,token_id:'1000012',tx:'0xabc'},{occurred_at:'2026-10-24T10:00:00.000Z'}))).toEqual(minted);
    expect(blocksToMarkdown(await body(recordId)).match(/Patron minted/g)).toHaveLength(1);
  });
  it('an out-of-order patron event creates the record and a late applied fills it in without rolling the stage back',async()=>{
    const minted=await send(f,patronEvent('patron.minted','pa_9',{edition:'7'},{occurred_at:'2026-10-24T10:00:00.000Z'}));
    const recordId=String(minted.body.recordId);
    expect((await rec(f,recordId))!.title).toBe('Patron application');
    const applied=await send(f,patronEvent('patron.applied','pa_9',{},{occurred_at:'2026-10-22T10:00:00.000Z'}));
    expect(applied.body).toMatchObject({action:'updated',recordId});
    expect(await tasks()).toHaveLength(1);
    expect(await rec(f,recordId)).toMatchObject({title:'Patron application · Grace Hopper',p_wi_event:'patron.minted',p_wi_stage:'minted',p_wi_edition:'7'});
    expect(blocksToMarkdown(await body(recordId))).toContain('### Your name\n\nGrace Hopper');
  });
});

describe('typed fields and views from the v2 form block',()=>{
  it('creates typed fields once per field name per family, with select and multi-select values',async()=>{
    const res=await send(f,consultingEvent('c1'));
    const board=(await rec(f,WEBSITE_INBOX_ID))!;
    const defs=fieldsOf(board);
    const id=(name:string)=>typedFieldId('consulting',name);
    const building=defs.find(d=>d.id===id('Building'))!,area=defs.find(d=>d.id===id('Built area'))!;
    expect(building).toMatchObject({name:'Building (Consulting)',type:'multi_select'});
    expect(area).toMatchObject({name:'Built area (Consulting)',type:'select'});
    expect(defs.find(d=>d.id===id('Site'))).toMatchObject({type:'url'});
    expect(defs.find(d=>d.id===id('Phone'))).toMatchObject({type:'text'});
    expect(defs.find(d=>d.id===id('Name'))).toMatchObject({type:'text'});
    // textarea stays in the body; Email is the built-in field
    expect(defs.find(d=>d.id===id('Why'))).toBeUndefined();
    expect(defs.find(d=>d.id===id('Email'))).toBeUndefined();
    const r=(await rec(f,String(res.body.recordId)))!;
    const optionId=(def:typeof building,name:string)=>def.options!.find(o=>o.name===name)!.id;
    expect(r[`p_${id('Building')}`]).toEqual([optionId(building,'Community education or arts space'),optionId(building,'Retreat or studio')]);
    expect(r[`p_${id('Built area')}`]).toBe(optionId(area,'800 to 1500 sq.ft. (75 to 140 m²)'));
    expect(r[`p_${id('Site')}`]).toBe('https://maps.example.com/site');
    expect(r).toMatchObject({p_wi_family:'consulting',p_wi_page:'https://thecommonground.living/consulting/'});
    const count=fieldsOf(board).length;
    await send(f,consultingEvent('c2',{answers:[{name:'Name',label:'Your name',value:'Bea'},{name:'Building',label:'b',value:'A tiny library'}]}));
    const after=fieldsOf((await rec(f,WEBSITE_INBOX_ID))!);
    expect(after).toHaveLength(count);
    expect(after.find(d=>d.id===id('Building'))!.options!.map(o=>o.name)).toContain('A tiny library');
    const view=(await rec(f,'view-wi-fam-consulting'))!;
    expect((view.config as {visible:string[]}).visible).toEqual(expect.arrayContaining([`p_${id('Building')}`,`p_${id('Site')}`]));
    await send(f,patronEvent('patron.applied'));
    const all=fieldsOf((await rec(f,WEBSITE_INBOX_ID))!);
    expect(all.filter(d=>d.name.startsWith('Name ('))).toHaveLength(2);
    expect(new Set(all.map(d=>d.name)).size).toBe(all.length);
  });
  it('stores a url answer only when it is an absolute http(s) link',async()=>{
    const id=`p_${typedFieldId('consulting','Site')}`;
    for(const [n,value] of [['u1','javascript:alert(1)'],['u2','/relative/path'],['u3','data:text/html,x']] as const){
      const res=await send(f,consultingEvent(n,{answers:[{name:'Name',label:'Your name',value:'X'},{name:'Site',label:'Site',value}]}));
      expect((await rec(f,String(res.body.recordId)))![id]).toBeUndefined();
    }
  });
  it('keeps team edits to field names and option colours when merging',()=>{
    const team=WEBSITE_BUILTIN_FIELDS.map(d=>d.id==='wi_topic'?{...d,name:'Theme',options:d.options!.map(o=>({...o,color:'#000000'}))}:d);
    expect(mergeFieldDefs(team,WEBSITE_BUILTIN_FIELDS)).toBeNull();
    const merged=mergeFieldDefs(team,[...WEBSITE_BUILTIN_FIELDS,{id:'wf_x',name:'X (General)',type:'text'}])!;
    expect(merged.find(d=>d.id==='wi_topic')).toMatchObject({name:'Theme'});
    expect(merged.at(-1)!.id).toBe('wf_x');
  });
  it('splits joined choices without breaking options that contain ", "',()=>{
    expect(splitChoices('Retreat, with studio, Other',['Retreat, with studio','Other'])).toEqual(['Retreat, with studio','Other']);
    expect(splitChoices('Something new',['Other'])).toEqual(['Something new']);
  });
  it('a concurrent board change makes the field merge retryable instead of losing a field',async()=>{
    await send(f,consultingEvent('c1'));
    // Simulate another writer landing between this ingest's state read and its write.
    let bumped=false;
    const racing=new Proxy(f.db,{get(target,key){
      if(key==='batch')return async(stmts:D1PreparedStatement[])=>{
        const out=await target.batch(stmts);
        if(!bumped&&out.length===7){bumped=true;await applyChanges(f.env,'alice',[{id:WEBSITE_INBOX_ID,collection:'boards',patch:{description:'Edited'},ts:Date.now()}]);}
        return out;
      };
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    const raw=JSON.stringify(patronEvent('patron.applied'));
    const res=await post(f,raw,sign(raw),{...f.env,DB:racing});
    expect(bumped).toBe(true);
    expect(res.status).toBe(503);
    const retry=await send(f,patronEvent('patron.applied'));
    expect(retry.status).toBe(200);
    expect(fieldsOf((await rec(f,WEBSITE_INBOX_ID))!).some(d=>d.id===typedFieldId('patrons','Edition'))).toBe(true);
    expect((await rec(f,WEBSITE_INBOX_ID))!.description).toBe('Edited');
  });
});

describe('People',()=>{
  it('one sender with several forms is one person, linked to each submission',async()=>{
    const a=await send(f,consultingEvent('p1'));
    const b=await send(f,consultingEvent('p2',{reply_to:'  ADA@Example.com '}));
    const c=await send(f,v1Form({id:'p3'}));
    expect(a.body.personId).toBeDefined();
    expect(b.body.personId).toBe(a.body.personId);
    expect(c.body.personId).toBe(a.body.personId);
    const person=(await rec(f,String(a.body.personId)))!;
    expect(person).toMatchObject({boardId:WEBSITE_PEOPLE_ID,title:'Ada Lovelace',p_wp_email:'ada@example.com'});
    expect((await rec(f,WEBSITE_INBOX_ID))!.peopleDatabaseId).toBe(WEBSITE_PEOPLE_ID);
    const links=(await f.db.prepare("SELECT json_extract(data,'$.fromId') AS fromId FROM records WHERE collection='links' AND json_extract(data,'$.toId')=?").bind(a.body.personId).all<{fromId:string}>()).results.map(l=>l.fromId).sort();
    expect(links).toEqual([a.body.recordId,b.body.recordId,c.body.recordId].map(String).sort());
    expect((await f.db.prepare("SELECT COUNT(*) n FROM records WHERE collection='tasks' AND json_extract(data,'$.boardId')=?").bind(WEBSITE_PEOPLE_ID).first<{n:number}>())!.n).toBe(1);
  });
  it('uses the team People database when there is one, matches an existing person and pins the choice',async()=>{
    await applyChanges(f.env,'alice',[
      {id:'db_people_team',collection:'boards',patch:{name:'People',kind:'records',columns:[{id:'c',name:'All'}],fields:[{id:'f_email',name:'Email',type:'text'}]},ts:Date.now()},
      {id:'person_existing',collection:'tasks',patch:{boardId:'db_people_team',title:'Ada (team)',p_f_email:'Ada@Example.com',status:'c'},ts:Date.now()},
    ]);
    await f.db.prepare("UPDATE website_ingest_grant SET people_id='db_people_team',version=version+1 WHERE id=1").run();
    const res=await send(f,consultingEvent('p1'));
    expect(res.body.personId).toBe('person_existing');
    expect((await rec(f,WEBSITE_INBOX_ID))!.peopleDatabaseId).toBe('db_people_team');
    expect(await rec(f,WEBSITE_PEOPLE_ID)).toBeNull();
    // A second People board appearing later does not move the pin.
    await applyChanges(f.env,'alice',[{id:'db_aaa_people',collection:'boards',patch:{name:'People',kind:'records',columns:[],fields:[{id:'e',name:'Email',type:'text'}]},ts:Date.now()}]);
    expect((await send(f,consultingEvent('p2'))).body.personId).toBe('person_existing');
  });
  it('chooses the pinned, then a team, then the built-in People database',()=>{
    const email={fields:[{id:'e',name:'Email',type:'text'}]};
    expect(choosePeopleDatabase({peopleDatabaseId:'b'},[{id:'a',data:email},{id:'b',data:email}])).toEqual({id:'b',create:false});
    expect(choosePeopleDatabase(null,[{id:WEBSITE_PEOPLE_ID,data:email},{id:'z',data:email}])).toEqual({id:'z',create:false});
    expect(choosePeopleDatabase(null,[{id:'n',data:{fields:[]}}])).toEqual({id:WEBSITE_PEOPLE_ID,create:true});
  });
  it('an event without a usable email links no person',async()=>{
    const res=await send(f,v1Form({id:'nomail',reply_to:'not an email'}));
    expect(res.status).toBe(200);
    expect(res.body.personId).toBeUndefined();
  });
});
