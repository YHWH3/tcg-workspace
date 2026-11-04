import {afterEach,it,expect,vi} from 'vitest';
const handlers=vi.hoisted(()=>new Map<string,(args:unknown)=>Promise<{content:{text:string}[];isError?:boolean}>>());
vi.mock('@modelcontextprotocol/server',()=>({McpServer:class{registerTool(name:string,_meta:unknown,handler:(args:unknown)=>Promise<{content:{text:string}[]}>){handlers.set(name,handler);}registerPrompt(){}registerResource(){}},ResourceTemplate:class{}}));
vi.mock('agents/mcp/server',()=>({createMcpHandler:vi.fn()}));
import pack from '../templates/tcg-pack.json';
import {createWorkspaceServer} from '../worker/mcp';
import {openAuditFixture,type AuditFixture} from './audit-fixture';
import {applyChanges} from '../worker/sync';
import {withD1Budget,d1BudgetRemaining} from '../worker/d1budget';
let fixture:AuditFixture;
afterEach(async()=>{handlers.clear();await fixture?.dispose();});
for(const enabled of [false,true])it(`freezes the canonical Ideas project relation, permission mode ${enabled}`,async()=>{
 fixture=await openAuditFixture();const now=Date.now();
 const boards=pack.databases.filter(b=>['db_ideas','db_projects'].includes(b.id)).map(b=>({id:b.id,collection:'boards',patch:{...b,templateDbKey:b.key},ts:now}));
 await applyChanges(fixture.env,'alice',[{id:'aaa-other-projects',collection:'boards',patch:{kind:'records',name:'Other Projects',templateDbKey:'projects',columns:[],fields:[]},ts:now},...boards,{id:'idea',collection:'tasks',patch:{boardId:'db_ideas',title:'Synthetic idea',status:'approved'},ts:now}],{serverTs:true});
 await fixture.db.prepare('UPDATE access_state SET enabled=? WHERE id=1').bind(enabled?1:0).run();
 const env=withD1Budget(fixture.env);createWorkspaceServer({env,ectx:fixture.ctx,userId:'alice',userRole:'admin',origin:'https://workspace.test',userByKey:new Map(),userNameById:new Map(),pageTitleById:new Map(),recordTitleById:new Map(),recordIdByTitle:new Map(),cachesReady:false,warnings:[],cs:null,toolName:''} as never);
 const result=await handlers.get('convert_idea_to_project')!({ideaId:'idea',requestId:'synthetic-conversion'});const data=JSON.parse(result.content[0].text);expect(result.isError,JSON.stringify(data)).not.toBe(true);expect(data.humanApprovalRequired).toBe(true);
 const saved=await fixture.db.prepare('SELECT plan_json FROM ai_previews WHERE id=?').bind(data.previewId).first<{plan_json:string}>();
 const ops=JSON.parse(saved!.plan_json);expect(ops.find((o:{collection:string;id:string})=>o.collection==='tasks'&&o.id!=='idea').patch.boardId).toBe('db_projects');expect(ops.find((o:{collection:string;patch:Record<string,unknown>})=>o.collection==='links'&&o.patch.kind==='relation')?.patch).toMatchObject({fromId:'idea',toId:ops.find((o:{collection:string;id:string})=>o.collection==='tasks'&&o.id!=='idea').id,fieldId:'f_converted_project'});
 expect(await fixture.db.prepare("SELECT COUNT(*) n FROM records WHERE collection='tasks'").first<number>('n')).toBe(1);expect(45-d1BudgetRemaining(env.DB)).toBeLessThanOrEqual(45);
});

import {ideaConversionApi} from '../worker/ideaConversion';
import {aiPreviewApi} from '../worker/aiPreviews';
async function seedBrowser(enabled:boolean){
 fixture=await openAuditFixture();await applyChanges(fixture.env,'alice',[
 ...pack.databases.filter(b=>['db_ideas','db_projects'].includes(b.id)).map(b=>({id:b.id,collection:'boards',patch:{...b,templateDbKey:b.key},ts:Date.now()})),
 {id:'browser-idea',collection:'tasks',patch:{boardId:'db_ideas',title:'Synthetic browser conversion',status:'approved'},ts:Date.now()}],{serverTs:true});
 await fixture.db.prepare('UPDATE access_state SET enabled=? WHERE id=1').bind(enabled?1:0).run();
 return JSON.parse((await fixture.db.prepare('SELECT field_ts FROM records WHERE id=?').bind('browser-idea').first<{field_ts:string}>())!.field_ts);
}
async function browserRequest(path:string,body:unknown,user='alice'){
 const env=withD1Budget(fixture.env);const response=await ideaConversionApi.fetch(new Request('https://workspace.test'+path,{method:'POST',headers:{...fixture.auth(user),'Content-Type':'application/json'},body:JSON.stringify(body)}),env,fixture.ctx);
 const data=await response.json() as Record<string,unknown>;return {status:response.status,data,calls:45-d1BudgetRemaining(env.DB)};
}
for(const enabled of [false,true])it(`browser conversion retains a lost acknowledgement and requires labelled session approval, mode ${enabled}`,async()=>{
 const expectedFields=await seedBrowser(enabled),body={expectedFields,requestId:'browser-test-conversion'};
 const first=await browserRequest('/browser-idea/conversion',body);expect(first.status,JSON.stringify(first)).toBe(200);expect(first.calls).toBeLessThanOrEqual(45);
 const replay=await browserRequest('/browser-idea/conversion',body);expect(replay.data).toMatchObject({previewId:first.data.previewId,replayed:true});
 expect(await fixture.db.prepare('SELECT COUNT(*) n FROM ai_previews').first<number>('n')).toBe(1);
 expect((await browserRequest('/browser-idea/conversion',{...body,expectedFields:{}})).status).toBe(409);
 const preview=(await fixture.db.prepare('SELECT args_hash,plan_json FROM ai_previews WHERE id=?').bind(first.data.previewId).first<{args_hash:string;plan_json:string}>())!;
 const post=async(suffix:string)=>aiPreviewApi.fetch(new Request('https://workspace.test/'+first.data.previewId+suffix,{method:'POST',headers:{...fixture.auth('alice'),'Content-Type':'application/json'},body:JSON.stringify({argsHash:preview.args_hash,decision:'approve'})}),withD1Budget(fixture.env),fixture.ctx);
 expect((await post('/execute')).status).toBe(403);
 // Automated disposable authenticated session, not a genuine human decision.
 expect((await post('/decision')).status).toBe(200);
 const executed=await post('/execute');expect(executed.status,await executed.clone().text()).toBe(200);expect(await executed.json()).toMatchObject({completed:true});
 expect((await post('/execute')).status).toBe(200);
 expect(await fixture.db.prepare("SELECT COUNT(*) n FROM records WHERE collection='tasks' AND json_extract(data,'$.convertedFrom')='browser-idea'").first<number>('n')).toBe(1);
 expect(await fixture.db.prepare("SELECT COUNT(*) n FROM records WHERE collection='links' AND json_extract(data,'$.fieldId')='f_converted_project'").first<number>('n')).toBe(1);
});
it('rejects stale browser source, anonymous access, disabled actor and unavailable targets without creating records',async()=>{
 const expectedFields=await seedBrowser(true);
 expect((await browserRequest('/browser-idea/conversion',{expectedFields:{},requestId:'stale'})).status).toBe(409);
 const anonymous=await ideaConversionApi.fetch(new Request('https://workspace.test/browser-idea/conversion',{method:'POST',body:'{}'}),fixture.env,fixture.ctx);expect(anonymous.status).toBe(401);
 await applyChanges(fixture.env,'alice',[{id:'db_projects',collection:'boards',patch:{archived:true},ts:Date.now()}],{serverTs:true});
 expect((await browserRequest('/browser-idea/conversion',{expectedFields,requestId:'unavailable'})).status).toBe(404);
 await fixture.db.prepare('UPDATE users SET disabled_at=? WHERE id=?').bind(Date.now(),'alice').run();
 expect((await browserRequest('/browser-idea/conversion',{expectedFields,requestId:'disabled'})).status).toBe(401);
 expect(await fixture.db.prepare('SELECT COUNT(*) n FROM ai_previews').first<number>('n')).toBe(0);
});
it('never reconstructs a missing canonical relation on a historical conversion',async()=>{
 const expectedFields=await seedBrowser(false);
 await applyChanges(fixture.env,'alice',[{id:'legacy-project',collection:'tasks',patch:{boardId:'db_projects',title:'Older project',convertedFrom:'browser-idea'},ts:Date.now()}],{serverTs:true});
 const result=await browserRequest('/browser-idea/conversion',{expectedFields,requestId:'legacy'});expect(result.data).toMatchObject({alreadyConverted:true,recordId:'legacy-project'});
 expect(await fixture.db.prepare("SELECT COUNT(*) n FROM records WHERE collection='links'").first<number>('n')).toBe(0);
});

import {proposePreview} from '../worker/aiPreviews';
import {getRec} from '../worker/records';
it('preserves captured destination revisions instead of adopting a schema change during proposal persistence',async()=>{
 await seedBrowser(false);const target=(await getRec(fixture.env,'db_projects'))!;
 await applyChanges(fixture.env,'alice',[{id:'db_projects',collection:'boards',patch:{name:'Changed after planning'},ts:Date.now()}],{serverTs:true});
 await expect(proposePreview(fixture.env,'alice','idea_conversion',{},[{id:'not-created',collection:'tasks',patch:{boardId:'db_projects',title:'Never created'}}],undefined,['db_projects'],undefined,{},new Map([['not-created',-1],['db_projects',target.rev]]))).rejects.toThrow('records_changed_during_planning');
 expect(await fixture.db.prepare('SELECT COUNT(*) n FROM ai_previews').first<number>('n')).toBe(0);
});
it('makes a private conversion destination indistinguishable from missing for another member',async()=>{
 const expectedFields=await seedBrowser(true);
 await fixture.db.batch([fixture.db.prepare("INSERT INTO spaces(id,name,default_access,export_policy,created_at) VALUES('private-projects','Private Projects','private','disabled',?)").bind(Date.now()),fixture.db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('private-projects','alice','owner')")]);
 // Disposable fixture sets the canonical server-owned scope; ordinary patches cannot move roots.
 await fixture.db.prepare("UPDATE records SET space_id='private-projects' WHERE id='db_projects'").run();
 const result=await browserRequest('/browser-idea/conversion',{expectedFields,requestId:'private-target'},'bob');expect(result.status,JSON.stringify(result.data)).toBe(404);expect(result.data).toEqual({error:'project_database_unavailable'});
 expect(await fixture.db.prepare('SELECT COUNT(*) n FROM ai_previews').first<number>('n')).toBe(0);
});

it('refuses a new conversion of an already converted idea with no surviving destination',async()=>{
 await seedBrowser(false);await applyChanges(fixture.env,'alice',[{id:'browser-idea',collection:'tasks',patch:{status:'converted'},ts:Date.now()}],{serverTs:true});
 const expectedFields=JSON.parse((await fixture.db.prepare('SELECT field_ts FROM records WHERE id=?').bind('browser-idea').first<{field_ts:string}>())!.field_ts);
 const result=await browserRequest('/browser-idea/conversion',{expectedFields,requestId:'already-converted'});expect(result.status).toBe(409);expect(result.data).toEqual({error:'converted_idea_requires_relationship_review'});
 expect(await fixture.db.prepare('SELECT COUNT(*) n FROM ai_previews').first<number>('n')).toBe(0);
});
it('returns the archived original Project without proposing a replacement',async()=>{
 const expectedFields=await seedBrowser(false);
 await applyChanges(fixture.env,'alice',[{id:'archived-project',collection:'tasks',patch:{boardId:'db_projects',title:'Archived original',convertedFrom:'browser-idea',archived:true},ts:Date.now()}],{serverTs:true});
 const result=await browserRequest('/browser-idea/conversion',{expectedFields,requestId:'archived-original'});expect(result.data).toMatchObject({alreadyConverted:true,recordId:'archived-project'});
 expect(await fixture.db.prepare('SELECT COUNT(*) n FROM ai_previews').first<number>('n')).toBe(0);
 expect((await getRec(fixture.env,'archived-project'))!.data.archived).toBe(true);
});
