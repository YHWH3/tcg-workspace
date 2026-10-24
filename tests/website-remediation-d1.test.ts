import {afterEach,expect,it,vi} from 'vitest';
vi.mock('../worker/events',async o=>({...await o<typeof import('../worker/events')>(),scheduleOutbox:vi.fn()}));
import {website,send,rec,consultingEvent,ctx,type Fixture} from './website-fixture';
import {applyChanges} from '../worker/sync';
import {websiteQuery,websiteReadAnswers} from '../worker/website';
import {withReadGate} from '../worker/readAccess';
import {classifyForAutomation} from '../worker/aiClassification';
import {aiSuggestionsApi} from '../worker/aiSuggestions';
import {websiteAutomations} from '../shared/websiteInbox';
import {sha256Hex} from '../worker/password';
import {admin} from '../worker/admin';
import {bodyVersions} from '../worker/bodySources';
import {proposePreview,aiPreviewApi,executePreview} from '../worker/aiPreviews';
let f:Fixture;
afterEach(async()=>{await f?.mf.dispose();});
async function session(){const token='fixture-human-alice';await f.db.prepare('INSERT OR IGNORE INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await sha256Hex(token),'alice',Date.now()+86400000,Date.now()).run();return {Authorization:'Bearer '+token,'Content-Type':'application/json'};}
async function block(id:string){return (await f.db.prepare("SELECT id FROM records WHERE collection='blocks' AND json_extract(data,'$.pageId')=? ORDER BY id LIMIT 1").bind(id).first<{id:string}>())!.id;}

it('W02 ingests with permissions on, and fails closed after sponsor/grant revocation',async()=>{
 f=await website('remediation-permissions');await f.db.prepare('UPDATE access_state SET enabled=1').run();
 const first=await send(f,consultingEvent('enabled'));expect(first.status,JSON.stringify(first.body)).toBe(200);
 expect(await rec(f,String(first.body.recordId))).toBeTruthy();
 await f.db.prepare('UPDATE website_ingest_grant SET revoked_at=?,version=version+1').bind(Date.now()).run();
 expect((await send(f,consultingEvent('revoked'))).status).toBe(503);
 // Accepted-event replay also requires current authority.
 expect((await send(f,consultingEvent('enabled'))).status).toBe(503);
});
it('W02 an explicit private-space deny overrides an admin sponsor',async()=>{
 f=await website('remediation-private');await f.db.batch([
 f.db.prepare('UPDATE access_state SET enabled=1'),
 f.db.prepare("INSERT INTO space_members(space_id,user_id,role,access) VALUES('space-core','alice','viewer','deny')")]);
 expect((await send(f,consultingEvent('denied'))).status).toBe(503);
});
it('W05 retrieves complete Unicode answers, reports omissions and invalidates changed continuations',async()=>{
 f=await website('remediation-answers');const ending='FinalAnswerMarker';
 const event=consultingEvent('long',{answers:[{name:'Why',label:'Why',value:'a'.repeat(5000)},{name:'More',label:'More',value:('👩🏽‍💻e\u0301مرحبا').repeat(400)+ending}]});
 const res=await send(f,event);expect(res.status).toBe(200);const id=String(res.body.recordId);
 const query=await websiteQuery(withReadGate(f.env,'alice'),'https://workspace.test',{});
 if(!query.records)throw Error('missing query');const row=query.records[0]!;
 expect(row.answerCompleteness?.truncated).toBe(true);let cursor=row.answerCompleteness!.nextCursor,text=row.answers!;
 const old=cursor;
 while(cursor){const chunk=await websiteReadAnswers(withReadGate(f.env,'alice'),{recordId:id,cursor});if('error' in chunk)throw Error(chunk.error);text+=chunk.answers;cursor=chunk.answerCompleteness.nextCursor;}
 expect(text.includes(ending),JSON.stringify({tail:text.slice(-180),length:text.length,metadata:row.answerCompleteness})).toBe(true);
 await applyChanges(f.env,'alice',[{id:await block(id),collection:'blocks',patch:{text:'changed'},ts:0}],{serverTs:true});
 expect(await websiteReadAnswers(f.env,{recordId:id,cursor:old!})).toMatchObject({error:'source_changed'});
 await f.db.prepare('UPDATE access_state SET enabled=1').run();
 await f.db.prepare("INSERT INTO space_members(space_id,user_id,role,access) VALUES('space-core','bob','viewer','deny')").run();
 expect(await websiteReadAnswers(withReadGate(f.env,'bob'),{recordId:id,cursor:old!})).toMatchObject({error:'not_found'});
});
it('W06 skips tombstones and archived People, then matches an explicitly restored identity',async()=>{
 f=await website('remediation-people');const first=await send(f,consultingEvent('person1')),person=String(first.body.personId);
 await applyChanges(f.env,'alice',[{id:person,collection:'tasks',patch:{deleted:true},ts:0}],{serverTs:true});
 const second=await send(f,consultingEvent('person2'));expect(second.status).toBe(200);expect(second.body.matchingStatus).toBe('unusable_identity');expect(second.body.personId).toBeUndefined();
 expect((await rec(f,person))?.deleted).toBe(true);
 await applyChanges(f.env,'alice',[{id:person,collection:'tasks',patch:{deleted:false,archived:true},ts:0}],{serverTs:true});
 expect((await send(f,consultingEvent('person3'))).body.matchingStatus).toBe('unusable_identity');
 await applyChanges(f.env,'alice',[{id:person,collection:'tasks',patch:{archived:false},ts:0}],{serverTs:true});
 expect((await send(f,consultingEvent('person4'))).body.personId).toBe(person);
});
it('W07 refuses a classifier result when answer blocks change during inference',async()=>{
 f=await website('remediation-inference');const sent=await send(f,consultingEvent('classify')),id=String(sent.body.recordId),b=await block(id),auto=websiteAutomations('alice')[0]!;
 await applyChanges(f.env,'alice',[{id:auto.id,collection:'automations',patch:auto.data,ts:0}],{serverTs:true});
 f.env={...f.env,AI_PROVIDER:'workers-ai',AI_CLASSIFICATION:'1',AI_DAILY_UNITS:'100000',AI:{run:async()=>{await applyChanges(f.env,'alice',[{id:b,collection:'blocks',patch:{text:'new answer'},ts:0}],{serverTs:true});return {response:'{"label":"high"}'};}} as unknown as Ai};
 await expect(classifyForAutomation(f.env,auto.id,id,'priority',['low','medium','high','urgent'],'stale')).rejects.toThrow('classification_source_changed');
 expect(await f.db.prepare('SELECT COUNT(*) n FROM ai_suggestions').first<number>('n')).toBe(0);
});
it('W07 fences later answer edits at suggestion acceptance and at preview execution',async()=>{
 f=await website('remediation-accept');const sent=await send(f,consultingEvent('classify')),id=String(sent.body.recordId),auto=websiteAutomations('alice')[0]!;
 await applyChanges(f.env,'alice',[{id:auto.id,collection:'automations',patch:auto.data,ts:0}],{serverTs:true});
 f.env={...f.env,AI_PROVIDER:'workers-ai',AI_CLASSIFICATION:'1',AI_DAILY_UNITS:'100000',AI:{run:async()=>({response:'{"label":"high"}'})} as unknown as Ai};
 expect((await classifyForAutomation(f.env,auto.id,id,'priority',['low','medium','high','urgent'],'fresh')).status).toBe('pending');
 const preview=await proposePreview(f.env,'alice','propose_website_triage',{},[{id,collection:'tasks',patch:{status:'in_review'}}]);
 const headers=await session();expect((await aiPreviewApi.request(`http://localhost/${preview.previewId}/decision`,{method:'POST',headers,body:JSON.stringify({decision:'approve',argsHash:preview.argsHash})},f.env,ctx)).status).toBe(200);
 await applyChanges(f.env,'alice',[{id:await block(id),collection:'blocks',patch:{text:'edited after approval'},ts:0}],{serverTs:true});
 const revision=await f.db.prepare('SELECT seq FROM records WHERE id=?').bind(id).first<number>('seq');
 const decision=await aiSuggestionsApi.request('http://localhost/fresh/decision',{method:'POST',headers,body:JSON.stringify({decision:'accept',expectedRev:revision})},f.env,ctx);
 expect(decision.status).toBe(409);await expect(executePreview(f.env,'alice',preview.previewId,preview.argsHash)).rejects.toThrow('source_body_changed');
 expect((await rec(f,id))?.priority).toBeUndefined();
});
it('W07 generations cover added, moved, deleted and physically removed answer blocks',async()=>{
 f=await website('remediation-generations');await send(f,consultingEvent('generation'));const id='web_generation';
 const before=await bodyVersions(f.env,[id]);
 await applyChanges(f.env,'alice',[{id:'extra_answer',collection:'blocks',patch:{pageId:id,type:'p',text:'added',order:'z'},ts:0}],{serverTs:true});
 const added=await bodyVersions(f.env,[id]);expect(added[id]).toBeGreaterThan(before[id]!);
 await applyChanges(f.env,'alice',[{id:'extra_answer',collection:'blocks',patch:{pageId:'other'},ts:0}],{serverTs:true});
 expect((await bodyVersions(f.env,[id]))[id]).toBeGreaterThan(added[id]!);
 const moved=await bodyVersions(f.env,['other']);await f.db.prepare("DELETE FROM records WHERE id='extra_answer'").run();
 expect((await bodyVersions(f.env,['other'])).other).toBeGreaterThan(moved.other!);
});

it('W02 administrator configuration binds canonical space and session identity in SQL order',async()=>{
 f=await website('remediation-admin');await f.db.prepare('UPDATE access_state SET enabled=1').run();
 const headers=await session();
 const configured=await admin.request('http://localhost/admin/website-ingest',{method:'PUT',headers,body:JSON.stringify({spaceId:'space-core'})},f.env,ctx);
 expect(configured.status,await configured.clone().text()).toBe(200);
 const grant=await configured.json() as {grant:{sponsor_id:string;space_id:string}};
 expect(grant.grant).toMatchObject({sponsor_id:'alice',space_id:'space-core'});
 expect((await admin.request('http://localhost/admin/website-ingest',{method:'DELETE',headers},f.env,ctx)).status).toBe(200);
 expect((await send(f,consultingEvent('after-admin-revoke'))).status).toBe(503);
});

it('W06 explicitly rebinds a changed-email reservation only to an active authorized Person',async()=>{
 f=await website('remediation-rebind');const first=await send(f,consultingEvent('old-person')),oldId=String(first.body.personId);
 const old=await rec(f,oldId);const emailKey=Object.keys(old!).find(k=>old![k]===consultingEvent('x').reply_to)!;
 await applyChanges(f.env,'alice',[{id:oldId,collection:'tasks',patch:{[emailKey]:'changed@example.org'},ts:0},{id:'replacement',collection:'tasks',patch:{boardId:'board-website-people',title:'Explicit operator choice',[emailKey]:consultingEvent('x').reply_to,deleted:false},ts:0}],{serverTs:true});
 expect((await send(f,consultingEvent('before-rebind'))).body.matchingStatus).toBe('unusable_identity');
 await f.db.prepare('UPDATE access_state SET enabled=1').run();const headers=await session();
 const call=(personId:string)=>admin.request('http://localhost/admin/website-ingest/people-rebind',{method:'POST',headers,body:JSON.stringify({email:consultingEvent('x').reply_to,personId})},f.env,ctx);
 expect((await call(oldId)).status).toBe(409);expect((await call('replacement')).status).toBe(200);
 expect((await send(f,consultingEvent('after-rebind'))).body.personId).toBe('replacement');
 expect(await f.db.prepare("SELECT COUNT(*) n FROM access_audit WHERE action='website_people_rebind'").first<number>('n')).toBe(1);
});
