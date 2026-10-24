// Phase 5: built-in AI over the Website inbox. Provider calls are SIMULATED:
// no real Workers AI binding and no paid calls. AI output only ever becomes a
// pending suggestion; a person accepts it.
import {afterEach,describe,expect,it,vi} from 'vitest';
vi.mock('../worker/events',async o=>({...await o<typeof import('../worker/events')>(),scheduleOutbox:vi.fn()}));
import {applyChanges} from '../worker/sync';
import {buildDigest} from '../worker/aiDigest';
import {processSearchBacklog,searchRecords} from '../worker/search';
import {processEmbeddings,hybridSearch} from '../worker/aiSemantic';
import {withReadGate} from '../worker/readAccess';
import type {EmbeddingProvider} from '../worker/aiProvider';
import {websiteAutomations,WEBSITE_INBOX_ID} from '../shared/websiteInbox';
import {website,send,drainOutbox,rec,consultingEvent,patronEvent,type Fixture} from './website-fixture';

let f:Fixture;
afterEach(async()=>{await f?.mf.dispose();});

describe('ai_classify on new Website inbox records',()=>{
  it('suggests Priority, Topic and Spam from the answers, labelled as AI, without changing the record',async()=>{
    f=await website('website-ai-classify');
    const inputs:string[]=[];
    const run=vi.fn(async(_model:string,req:{messages:{content:string}[]})=>{const user=JSON.parse(req.messages[1]!.content) as {options:string[];data:string};inputs.push(user.data);return {response:JSON.stringify({label:user.options.at(-1)})};});
    f.env={...f.env,AI_PROVIDER:'workers-ai',AI_CLASSIFICATION:'1',AI_DAILY_UNITS:'100000',AI:{run} as unknown as Ai};
    await send(f,consultingEvent('first'));
    await applyChanges(f.env,'alice',websiteAutomations('alice').map(a=>({id:a.id,collection:'automations',patch:a.data,ts:Date.now()})));
    await drainOutbox(f);
    const res=await send(f,consultingEvent('second',{reply_to:'bea@example.com'}));
    await drainOutbox(f);
    const recordId=String(res.body.recordId);
    const rows=(await f.db.prepare('SELECT patch_json,rationale,provider,status FROM ai_suggestions WHERE target_id=? ORDER BY patch_json').bind(recordId).all<{patch_json:string;rationale:string;provider:string;status:string}>()).results;
    expect(rows.map(r=>JSON.parse(r.patch_json))).toEqual(expect.arrayContaining([{priority:'urgent'},{p_wi_topic:'Other'},{p_wi_spam:'Not spam'}]));
    expect(rows.every(r=>r.status==='pending'&&r.provider==='workers-ai'&&/suggestion/i.test(r.rationale))).toBe(true);
    // The model saw the answers (body excerpt), and nothing was applied.
    expect(inputs.some(t=>t.includes('A place to teach earth building.'))).toBe(true);
    const r=(await rec(f,recordId))!;
    expect(r.priority).toBeUndefined();
    expect(r.p_wi_topic).toBeUndefined();
  });
  it('is off unless AI classification is configured, and the first-reply automation records the reply date',async()=>{
    f=await website('website-ai-off');
    const res=await send(f,consultingEvent('one'));
    await applyChanges(f.env,'alice',websiteAutomations('alice').map(a=>({id:a.id,collection:'automations',patch:a.data,ts:Date.now()})));
    await drainOutbox(f);
    const recordId=String(res.body.recordId);
    await applyChanges(f.env,'alice',[{id:recordId,collection:'tasks',patch:{status:'replied'},ts:Date.now()}],{event:{source:'client'}});
    await drainOutbox(f);
    expect((await f.db.prepare('SELECT COUNT(*) n FROM ai_suggestions').first<{n:number}>())!.n).toBe(0);
    expect((await rec(f,recordId))!.p_wi_replied).toBe(new Date().toISOString().slice(0,10));
  });
});

describe('weekly digest and search',()=>{
  it('the weekly digest has a Website part with family counts, patron movement and the oldest open',async()=>{
    f=await website('website-ai-digest');
    await send(f,consultingEvent('w1',{occurred_at:new Date().toISOString()}));
    await send(f,patronEvent('patron.applied','pa_w',{},{occurred_at:new Date().toISOString()}));
    const digest=await buildDigest(f.env,'alice');
    expect(digest.website).toMatchObject({received:2,byFamily:expect.arrayContaining([{label:'Consulting',count:1},{label:'Patrons',count:1}]),patronMovement:[{label:'Applied',count:1}]});
    expect(digest.website!.oldestOpen).toHaveLength(2);
  });
  it('keyword and semantic search cover the inbox answers through the existing search documents',async()=>{
    f=await website('website-ai-search');
    const res=await send(f,consultingEvent('s1'));
    await processSearchBacklog(f.env);
    const keyword=await searchRecords(withReadGate(f.env,'alice'),'alice',{q:'earth building',databaseId:WEBSITE_INBOX_ID});
    expect(keyword.results.map(r=>r.docId)).toContain(res.body.recordId);
    const fake:EmbeddingProvider={id:'simulated',modelId:'test-model',dimensions:2,embed:vi.fn(async(texts:string[])=>texts.map(t=>t.includes('earth')?[1,0]:[0,1]))};
    const configured={...f.env,AI_DAILY_UNITS:'100000'};
    expect((await processEmbeddings(configured,fake)).processed).toBeGreaterThan(0);
    const semantic=await hybridSearch(withReadGate(configured,'alice'),'alice',{q:'earth',databaseId:WEBSITE_INBOX_ID},'semantic',fake);
    expect(semantic.semantic).toBe('available');
    expect(semantic.results.map(r=>r.docId)).toContain(res.body.recordId);
  });
});
