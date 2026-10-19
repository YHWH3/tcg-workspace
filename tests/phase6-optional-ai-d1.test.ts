// Provider injection is simulated only. No real Workers AI binding or paid calls.
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {openAuditFixture,type AuditFixture} from './audit-fixture';
import {reserveAi,embeddingProvider,reciprocalRank,type EmbeddingProvider} from '../worker/aiProvider';
import {processEmbeddings,hybridSearch} from '../worker/aiSemantic';
import {processSearchBacklog} from '../worker/search';
import {withReadGate} from '../worker/readAccess';
import {createSuggestion,aiSuggestionsApi} from '../worker/aiSuggestions';
import {applyChanges} from '../worker/sync';
import {runWeeklyDigests,buildDigest} from '../worker/aiDigest';
vi.mock('../worker/events',async o=>({...await o<typeof import('../worker/events')>(),scheduleOutbox:vi.fn()}));
let f:AuditFixture;let fake:EmbeddingProvider;
beforeEach(async()=>{f=await openAuditFixture();await f.db.batch([
 f.db.prepare('UPDATE access_state SET enabled=1'),f.db.prepare("INSERT INTO spaces(id,name,default_access,created_at) VALUES('vault','Vault','private',1)"),
 f.db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('vault','alice','admin')"),
 f.db.prepare(`INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES('b','boards','{"name":"Tasks"}','{}',1,'space-core'),('t','tasks','{"title":"Needle public","boardId":"b","dueDate":"2026-01-01"}','{}',2,'space-core'),('s','pages','{"title":"SECRET needle"}','{}',3,'vault')`),
 ]);await processSearchBacklog(f.env);fake={id:'simulated',modelId:'test-model',dimensions:2,embed:vi.fn(async texts=>texts.map(()=>[1,0]))};});
afterEach(async()=>f.dispose());
const configured=()=>({...f.env,AI_DAILY_UNITS:'100000'});
describe('Phase 6 optional AI, actual D1; permissions ENABLED; provider SIMULATED',()=>{
 it('makes no provider call in default disabled mode and preserves keyword results',async()=>{
  expect(embeddingProvider(f.env)).toBeNull();expect(await processEmbeddings(f.env)).toEqual({status:'disabled',processed:0});
  const r=await hybridSearch(withReadGate(f.env,'bob'),'bob',{q:'needle'},'hybrid');expect(r.semantic).toBe('disabled');expect(r.results.map(r=>r.docId)).toEqual(['t']);
 });
 it('reserves a shared daily budget atomically and stops background work at 80%',async()=>{
  const env={...f.env,AI_DAILY_UNITS:'100'};
  const results=await Promise.all([reserveAi(env,'a',60),reserveAi(env,'b',60)]);expect(results.filter(Boolean)).toHaveLength(1);
  expect(await reserveAi(env,'background',21,true)).toBe(false);expect(await reserveAi(env,'query',40)).toBe(true);expect(await reserveAi(env,'overflow',1)).toBe(false);
 });
 it('indexes through existing FTS changes and permission-filters vectors before returning titles',async()=>{
  expect((await processEmbeddings(configured(),fake)).processed).toBeGreaterThan(0);
  const r=await hybridSearch(withReadGate(configured(),'bob'),'bob',{q:'needle'},'hybrid',fake);
  expect(r.semantic).toBe('available');expect(JSON.stringify(r)).not.toContain('SECRET');expect(r.results.some(r=>r.docId==='t')).toBe(true);
 });
 it('falls back truthfully on provider failure and keeps dirty work retryable',async()=>{
  fake.embed=vi.fn(async()=>{throw new Error('down');});
  expect((await processEmbeddings(configured(),fake)).status).toBe('provider_unavailable');
  expect(await f.db.prepare('SELECT MAX(attempts) n FROM ai_embedding_dirty').first('n')).toBe(1);
  const r=await hybridSearch(withReadGate(configured(),'bob'),'bob',{q:'needle'},'semantic',fake);expect(r.semantic).toBe('unavailable');expect(r.results.map(r=>r.docId)).toEqual(['t']);
 });
 it('rejects wrong vector dimensions without persisting invalid vectors',async()=>{
  fake.embed=async texts=>texts.map(()=>[1]);expect((await processEmbeddings(configured(),fake)).status).toBe('provider_unavailable');expect(await f.db.prepare('SELECT COUNT(*) n FROM ai_embeddings').first('n')).toBe(0);
 });
 it('never resurrects a document changed while the embedding request was running',async()=>{
  fake.embed=async texts=>{await applyChanges(f.env,'alice',[{id:'t',collection:'tasks',patch:{deleted:true},ts:0}],{serverTs:true});return texts.map(()=>[1,0]);};
  await processEmbeddings(configured(),fake);expect(await f.db.prepare("SELECT COUNT(*) n FROM ai_embeddings WHERE doc_id='t'").first('n')).toBe(0);
 });
 it('fuses only explicit ranked lists and uses deterministic ties',()=>expect(reciprocalRank([['a','b'],['b','c']])[0]).toBe('b'));
 it('keeps suggestions separate, requires current revision, and accepts via the human session only',async()=>{
  const p=await createSuggestion(f.env,'alice','t',{priority:'high'},'Suggested priority');
  expect((await f.db.prepare("SELECT json_extract(data,'$.priority') p FROM records WHERE id='t'").first())?.p).toBeNull();
  const body=JSON.stringify({decision:'accept',expectedRev:2});
  expect((await aiSuggestionsApi.request(`/${p.suggestionId}/decision`,{method:'POST',headers:{authorization:'Bearer fake-oauth','content-type':'application/json'},body},f.env,f.ctx)).status).toBe(401);
  const r=await aiSuggestionsApi.request(`/${p.suggestionId}/decision`,{method:'POST',headers:f.auth('alice'),body},f.env,f.ctx);expect(r.status).toBe(200);const data=await r.json() as {changesetId:string};expect(data.changesetId).toBeTruthy();
  expect((await f.db.prepare("SELECT json_extract(data,'$.priority') p FROM records WHERE id='t'").first())?.p).toBe('high');
 });
 it('does not accept a suggestion after source content changes',async()=>{
  const p=await createSuggestion(f.env,'alice','t',{priority:'high'},'Suggested priority');await applyChanges(f.env,'alice',[{id:'t',collection:'tasks',patch:{title:'New title'},ts:0}],{serverTs:true});
  const r=await aiSuggestionsApi.request(`/${p.suggestionId}/decision`,{method:'POST',headers:f.auth('alice'),body:JSON.stringify({decision:'accept',expectedRev:2})},f.env,f.ctx);expect(r.status).toBe(409);
 });
 it('rejects structural/identity suggestions',async()=>{await expect(createSuggestion(f.env,'alice','t',{createdBy:'bob'},'Forged')).rejects.toThrow('invalid_suggestion');});
 it('builds digest from currently readable work and deduplicates scheduled delivery',async()=>{
  const digest=await buildDigest(f.env,'bob');expect(JSON.stringify(digest)).not.toContain('SECRET');expect(digest.records.map(r=>r.id)).toContain('t');
  await runWeeklyDigests(f.env);await runWeeklyDigests(f.env);expect(await f.db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id='alice' AND group_key LIKE 'weekly-digest:%'").first('n')).toBe(1);
 });
});
it('reserves per-user quota independently inside the shared provider cap',async()=>{
 const env={...f.env,AI_DAILY_UNITS:'100'};expect(await reserveAi(env,'semantic',50,false,'bob')).toBe(true);expect(await reserveAi(env,'semantic',1,false,'bob')).toBe(false);expect(await reserveAi(env,'semantic',50,false,'alice')).toBe(true);expect(await reserveAi(env,'semantic',1,false,'carol')).toBe(false);
});
it('redacts keyword fallback if provider failure races membership revocation',async()=>{
 fake.embed=async()=>{await f.db.prepare("INSERT INTO space_members(space_id,user_id,role,access) VALUES('space-core','bob','viewer','deny') ON CONFLICT(space_id,user_id) DO UPDATE SET access='deny'").run();throw new Error('provider down');};
 const result=await hybridSearch(withReadGate(configured(),'bob'),'bob',{q:'needle'},'semantic',fake);expect(result.semantic).toBe('access_changed');expect(result.results).toEqual([]);
});
it('classification is optional, validates labels, records provenance and never applies model output',async()=>{
 const {classifyForAutomation}=await import('../worker/aiClassification');
 await f.db.prepare(`INSERT INTO records(id,collection,data,field_ts,seq,space_id,updated_by) VALUES('auto','automations',?,'{}',10,'space-core','alice')`).bind(JSON.stringify({databaseId:'b',createdBy:'alice',enabled:true,actions:[{type:'ai_classify',fieldKey:'priority',options:['high','low']}]})).run();
 expect(await classifyForAutomation(f.env,'auto','t','priority',['high','low'],'classify1')).toEqual({status:'disabled'});
 const env={...configured(),AI_PROVIDER:'workers-ai' as const,AI_CLASSIFICATION:'1',AI:{run:vi.fn(async()=>({response:'{"label":"high"}'}))} as unknown as Ai};
 const result=await classifyForAutomation(env,'auto','t','priority',['high','low'],'classify1');expect(result).toMatchObject({status:'pending'});expect(await f.db.prepare("SELECT json_extract(data,'$.priority') p FROM records WHERE id='t'").first('p')).toBeNull();
 const row=await f.db.prepare("SELECT provider,model FROM ai_suggestions WHERE id='classify1'").first();expect(row?.provider).toBe('workers-ai');expect(await classifyForAutomation(env,'auto','t','priority',['high','low'],'classify1')).toEqual({status:'already_suggested'});
 env.AI.run=vi.fn(async()=>({response:'{"label":"https://attacker.invalid/"}'})) as unknown as typeof env.AI.run;await expect(classifyForAutomation(env,'auto','t','priority',['high','low'],'classify2')).rejects.toThrow('invalid_label');
});
it('retains failed digest delivery, backs off, and resumes without duplicate notification',async()=>{
 await f.db.prepare("CREATE TRIGGER fail_digest BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'injected digest failure'); END").run();await runWeeklyDigests(f.env);expect(await f.db.prepare("SELECT attempts FROM ai_digest_runs WHERE user_id='alice'").first('attempts')).toBe(1);
 await f.db.prepare('DROP TRIGGER fail_digest').run();await f.db.prepare('UPDATE ai_digest_runs SET retry_at=0').run();await runWeeklyDigests(f.env);expect(await f.db.prepare("SELECT delivered FROM ai_digest_runs WHERE user_id='alice'").first('delivered')).toBe(1);await runWeeklyDigests(f.env);expect(await f.db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id='alice' AND group_key LIKE 'weekly-digest:%'").first('n')).toBe(1);
});
it('leases embeddings against concurrent jobs and reuses unchanged text hashes',async()=>{
 let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});fake.embed=vi.fn(async texts=>{entered();await blocked;return texts.map(()=>[1,0]);});
 const first=processEmbeddings(configured(),fake);await ready;expect((await processEmbeddings(configured(),fake)).processed).toBe(0);release();await first;expect(fake.embed).toHaveBeenCalledTimes(1);
 await applyChanges(f.env,'alice',[{id:'t',collection:'tasks',patch:{priority:'high'},ts:0}],{serverTs:true});await processSearchBacklog(f.env);const before=vi.mocked(fake.embed).mock.calls.length;expect((await processEmbeddings(configured(),fake)).status).toBe('unchanged');expect(vi.mocked(fake.embed).mock.calls.length).toBe(before);
});
