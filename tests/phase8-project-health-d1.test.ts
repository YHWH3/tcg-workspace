import {afterEach,describe,it,expect,vi} from 'vitest';
const handlers=vi.hoisted(()=>new Map<string,(args:unknown)=>Promise<{content:{text:string}[];isError?:boolean}>>());
vi.mock('@modelcontextprotocol/server',()=>({McpServer:class{registerTool(name:string,_meta:unknown,handler:(a:unknown)=>Promise<{content:{text:string}[]}>){handlers.set(name,handler);}registerPrompt(){}registerResource(){}},ResourceTemplate:class{}}));
vi.mock('agents/mcp/server',()=>({createMcpHandler:vi.fn()}));
import {openAuditFixture,type AuditFixture} from './audit-fixture';
import {applyChanges} from '../worker/sync';
import {withD1Budget,d1BudgetRemaining} from '../worker/d1budget';
import {withWorkspaceContext} from '../worker/workspaceSettings';
import {collectProjectHealth,projectHealthApi} from '../worker/projectHealth';
import {projectHealthConfigSchema} from '../shared/projectHealthConfig';
import {linkId} from '../shared/linkid';
import {createWorkspaceServer} from '../worker/mcp';
import {aiPreviewApi,executePreview,type PreviewOp} from '../worker/aiPreviews';
let f:AuditFixture;
const now=Date.parse('2026-10-29T12:00:00Z');
afterEach(async()=>{vi.restoreAllMocks();await f?.dispose();handlers.clear();});
const cfg=()=>projectHealthConfigSchema.parse({databaseId:'projects'});
async function call(name:string,args:Record<string,unknown>){
 const env=withWorkspaceContext(withD1Budget(f.env));
 createWorkspaceServer({env,ectx:f.ctx,userId:'alice',userRole:'admin',origin:'https://workspace.test',userByKey:new Map(),userNameById:new Map(),pageTitleById:new Map(),recordTitleById:new Map(),recordIdByTitle:new Map(),pageIdByTitle:new Map(),cachesReady:false,warnings:[],cs:null,toolName:''} as never);
 const out=await handlers.get(name)!(args);return {data:JSON.parse(out.content[0].text),error:out.isError,used:45-d1BudgetRemaining(env.DB)};
}
async function seed(enabled:boolean){
 vi.spyOn(Date,'now').mockReturnValue(now);f=await openAuditFixture();
 const relation=(fromId:string,toId:string,fieldId:string)=>({id:linkId('relation',fieldId,fromId,toId),collection:'links',patch:{kind:'relation',fromType:'record',toType:'record',fromId,toId,fieldId}});
 const changes=[
  {id:'projects',collection:'boards',patch:{name:'Projects',kind:'records',templateDbKey:'projects',columns:[{id:'active',name:'Active'},{id:'blocked',name:'Blocked'},{id:'completed',name:'Completed'},{id:'cancelled',name:'Cancelled'}],fields:[{id:'f_owner',name:'Owner',type:'person'},{id:'f_start',name:'Start',type:'date'},{id:'f_end',name:'End',type:'date'},{id:'f_decisions',name:'Decisions',type:'relation',relation:{target:'decisions',primary:true}}]}},
  {id:'tasks',collection:'boards',patch:{name:'Tasks',kind:'tasks',templateDbKey:'tasks',columns:[{id:'todo',name:'To do'},{id:'done',name:'Done'}],fields:[{id:'f_project',name:'Project',type:'relation',relation:{target:'projects',primary:true}}]}},
  {id:'decisions',collection:'boards',patch:{name:'Decisions',kind:'records',templateDbKey:'decisions',columns:[{id:'open',name:'Open'},{id:'decided',name:'Decided'},{id:'superseded',name:'Superseded'}],fields:[]}},
  {id:'project',collection:'tasks',patch:{boardId:'projects',title:'Review project',status:'active',p_f_owner:'alice',p_f_start:'2026-10-01',p_f_end:'2026-11-01',createdAt:now,description:'NEVER_INCLUDE_BODY'}},
  {id:'task',collection:'tasks',patch:{boardId:'tasks',title:'Overdue linked work',status:'todo',dueDate:'2026-10-28',createdAt:now,description:'NEVER_INCLUDE_BODY'}},
  {id:'blocker',collection:'tasks',patch:{boardId:'tasks',title:'Incoming prerequisite',status:'todo',createdAt:now}},
  {id:'decision',collection:'tasks',patch:{boardId:'decisions',title:'Decide the plan',status:'open',createdAt:now}},
  relation('task','project','f_project'),relation('project','decision','f_decisions'),
  {id:linkId('blocks',null,'blocker','task'),collection:'links',patch:{kind:'blocks',fromType:'record',toType:'record',fromId:'blocker',toId:'task'}},
  {id:'event',collection:'activity',patch:{verb:'updated',actorId:'alice',targetType:'task',targetId:'task',targetTitle:'NEVER_INCLUDE_BODY',createdAt:now}},
 ];
 const applied=await applyChanges(f.env,'alice',changes.map(c=>({...c,ts:now})),{serverTs:true});expect(applied.rejected).toBe(0);expect(applied.applied).toHaveLength(changes.length);
 await f.db.batch([
  f.db.prepare("INSERT INTO approvals(id,target_type,target_id,requested_by,approver_id,status,created_at,note) VALUES('mine','record','task','bob','alice','pending',?,'NEVER_INCLUDE_APPROVAL_NOTE')").bind(now),
  f.db.prepare("INSERT INTO approvals(id,target_type,target_id,requested_by,approver_id,status,created_at,note) VALUES('others','record','project','bob','carol','pending',?,'NEVER_INCLUDE_APPROVAL_NOTE')").bind(now),
  f.db.prepare('UPDATE access_state SET enabled=? WHERE id=1').bind(enabled?1:0),
 ]);
}
for(const enabled of [false,true])describe(`project health actual D1 permissions ${enabled?'ENABLED':'DISABLED'}`,()=>{
 it('collects precise named sources within45 calls, retaining approval visibility',async()=>{
  await seed(enabled);const env=withWorkspaceContext(withD1Budget(f.env)),[page]=await collectProjectHealth(env,'alice',[cfg()],now);
  expect(page.status).toBe('ready');expect(page.projects).toHaveLength(1);expect(page.projects[0].health.status,JSON.stringify(page)).toBe('blocked');
  expect(page.projects[0].health.signals.map(s=>s.rule)).toEqual(['dependency_blocked','overdue_tasks','open_decisions','pending_approvals']);
  expect(page.projects[0].health.signals.find(s=>s.rule==='pending_approvals')?.approvalIds).toEqual(['mine']);
  expect(page.records.map(r=>r.id).sort()).toEqual(['blocker','decision','project','task']);expect(JSON.stringify(page)).not.toContain('NEVER_INCLUDE');
  expect(45-d1BudgetRemaining(env.DB)).toBeLessThanOrEqual(45);expect(page.partial).toBe(false);
 });
 it('supports relation filters after loading relation values and validates HTTP configuration',async()=>{
  await seed(enabled);const config=projectHealthConfigSchema.parse({databaseId:'projects',filters:[{key:'rel_f_decisions',op:'contains',value:'plan'}]});
  const direct=(await collectProjectHealth(withWorkspaceContext(withD1Budget(f.env)),'alice',[config],now))[0];expect(direct.projects.map(r=>r.id)).toEqual(['project']);
  const response=await projectHealthApi.request('https://local.test/',{method:'POST',headers:f.auth('alice'),body:JSON.stringify([config])},withWorkspaceContext(withD1Budget(f.env)));expect(response.status).toBe(200);expect((await response.json() as {pages:unknown[]}).pages[0]).toEqual(direct);
  const bad=await projectHealthApi.request('https://local.test/',{method:'POST',headers:f.auth('alice'),body:JSON.stringify([{databaseId:'projects',limit:999}])},f.env);expect(bad.status).toBe(400);
 });
 it('keeps missing/archived projects distinct from healthy empty databases',async()=>{
  await seed(enabled);await applyChanges(f.env,'alice',[{id:'project',collection:'tasks',patch:{archived:true},ts:now}],{serverTs:true});
  const [empty,missing]=await collectProjectHealth(withWorkspaceContext(withD1Budget(f.env)),'alice',[cfg(),projectHealthConfigSchema.parse({projectId:'project'})],now);
  expect(empty).toMatchObject({status:'ready',projects:[]});expect(missing).toMatchObject({status:'source_unavailable',projects:[]});
 });
 it('treats a configured page id as an unavailable database, not a healthy empty source',async()=>{
  await seed(enabled);await applyChanges(f.env,'alice',[{id:'not-a-database',collection:'pages',patch:{title:'A page'},ts:now}],{serverTs:true});
  const [page]=await collectProjectHealth(withWorkspaceContext(withD1Budget(f.env)),'alice',[projectHealthConfigSchema.parse({databaseId:'not-a-database'})],now);expect(page).toMatchObject({status:'source_unavailable',projects:[]});
 });
 it('shares health evidence with dashboard and operating-review MCP reads',async()=>{
  await seed(enabled);await applyChanges(f.env,'alice',[{id:'review',collection:'pages',patch:{title:'Project review'},ts:now},{id:'health',collection:'blocks',patch:{pageId:'review',type:'projecthealth',databaseId:'projects',order:'a0'},ts:now}],{serverTs:true});
  const [direct]=await collectProjectHealth(withWorkspaceContext(withD1Budget(f.env)),'alice',[cfg()],now);
  const dashboard=await call('dashboard_snapshot',{pageId:'review'});expect(dashboard.error,JSON.stringify(dashboard.data)).not.toBe(true);expect(dashboard.data.blocks[0].projects[0].health).toEqual(direct.projects[0].health);expect(dashboard.data.blocks[0].projects[0].url).toBe('https://workspace.test/boards/projects/tasks/project');expect(dashboard.used).toBeLessThanOrEqual(45);
  const review=await call('operating_review_context',{});expect(review.error,JSON.stringify(review.data)).not.toBe(true);expect(review.data.projectHealth.pages,JSON.stringify({health:review.data.projectHealth,used:review.used})).not.toHaveLength(0);expect(review.data.projectHealth.pages[0].projects[0].health).toEqual(direct.projects[0].health);expect(review.used).toBeLessThanOrEqual(45);expect(JSON.stringify(review.data)).not.toContain('NEVER_INCLUDE_APPROVAL_NOTE');
 });
 it('derives current-record health and respects a deleted body-block reservation',async()=>{
  await seed(enabled);const snapshot=await call('dashboard_snapshot',{pageId:'project'});expect(snapshot.error,JSON.stringify(snapshot.data)).not.toBe(true);expect(snapshot.data.blocks[0]).toMatchObject({type:'projecthealth',status:'ready',projects:[{id:'project'}]});expect(snapshot.used).toBeLessThanOrEqual(45);
  await applyChanges(f.env,'alice',[{id:'saved-health',collection:'blocks',patch:{pageId:'project',parentType:'record',type:'projecthealth',projectId:'self',databaseId:'projects',deleted:true},ts:now}],{serverTs:true});
  const hidden=await call('dashboard_snapshot',{pageId:'project'});expect(hidden.data.blocks).toEqual([]);
 });
 it('does not call unchanged fields healthy after the configured schema changes',async()=>{
  await seed(enabled);await applyChanges(f.env,'alice',[{id:'projects',collection:'boards',patch:{fields:[]},ts:now}],{serverTs:true});
  const [page]=await collectProjectHealth(withWorkspaceContext(withD1Budget(f.env)),'alice',[cfg()],now);expect(page.projects[0].health.status).toBe('unknown');expect(page.projects[0].health.partialSources).toContain('field_configuration');
 });
 it('copies a validated self-health template only through frozen session-approved conversion',async()=>{
  await seed(enabled);expect((await applyChanges(f.env,'alice',[
   {id:'review-template',collection:'pages',patch:{title:'Project Review',isTemplate:true},ts:now},
   {id:'template-health',collection:'blocks',patch:{pageId:'review-template',type:'projecthealth',projectId:'self',databaseId:'unrelated-author-id',heading:'Our health',staleDays:30,order:'a0'},ts:now},
   {id:'template-named',collection:'blocks',patch:{pageId:'review-template',type:'projecthealth',projectId:'project',databaseId:'projects',order:'a1'},ts:now},
   {id:'template-note',collection:'blocks',patch:{pageId:'review-template',type:'p',text:'Keep the project notes',order:'a2'},ts:now},
  ],{serverTs:true})).rejected).toBe(0);
  const result=await call('convert_record',{recordId:'task',toDatabaseId:'projects',templateId:'review-template'});expect(result.error,JSON.stringify(result.data)).not.toBe(true);expect(result.data.humanApprovalRequired).toBe(true);
  const saved=await f.db.prepare('SELECT plan_json FROM ai_previews WHERE id=?').bind(result.data.previewId).first<{plan_json:string}>();const plan=JSON.parse(saved!.plan_json) as PreviewOp[];
  expect(plan.filter(op=>op.collection==='boards')).toEqual([]);const health=plan.filter(op=>op.collection==='blocks'&&op.patch.type==='projecthealth');expect(health).toHaveLength(1);expect(health[0].patch).toMatchObject({databaseId:'projects',projectId:'self',heading:'Our health',staleDays:30,parentType:'record'});expect(plan.some(op=>op.collection==='blocks'&&op.patch.text==='Keep the project notes')).toBe(true);
  const env=()=>withWorkspaceContext(withD1Budget(f.env));await expect(executePreview(env(),'alice',result.data.previewId,result.data.argsHash)).rejects.toThrow('human_approval_required');
  // Disposable authenticated fixture decision, never genuine human acceptance.
  const decision=await aiPreviewApi.request(`https://local.test/${result.data.previewId}/decision`,{method:'POST',headers:f.auth('alice'),body:JSON.stringify({decision:'approve',argsHash:result.data.argsHash})},f.env,f.ctx);expect(decision.status).toBe(200);
  expect(await executePreview(env(),'alice',result.data.previewId,result.data.argsHash)).toMatchObject({completed:true});
  expect(await executePreview(env(),'alice',result.data.previewId,result.data.argsHash)).toMatchObject({completed:true,replayed:true});
  const dashboard=await call('dashboard_snapshot',{pageId:health[0].patch.pageId});expect(dashboard.error,JSON.stringify(dashboard.data)).not.toBe(true);expect(dashboard.data.blocks.filter((b:{type:string})=>b.type==='projecthealth')).toHaveLength(1);expect(dashboard.data.blocks[0].projects[0].id).toBe(health[0].patch.pageId);
 });
});
it('fails closed for private sources and disabled principals without leaking copied data',async()=>{
 await seed(true);await f.db.batch([f.db.prepare("UPDATE spaces SET default_access='private' WHERE id='space-core'"),f.db.prepare("INSERT OR REPLACE INTO space_members(space_id,user_id,role) VALUES('space-core','alice','owner')")]);
 const [page]=await collectProjectHealth(withWorkspaceContext(withD1Budget(f.env)),'bob',[cfg()],now);expect(page).toMatchObject({status:'source_unavailable',projects:[],records:[]});expect(JSON.stringify(page)).not.toContain('Review project');
 await f.db.prepare("UPDATE users SET disabled_at=? WHERE id='alice'").bind(now).run();await expect(collectProjectHealth(withWorkspaceContext(withD1Budget(f.env)),'alice',[cfg()],now)).rejects.toThrow('unauthenticated');
});
it('does not let subrecords displace project roots and marks a capped project tree unknown',async()=>{
 await seed(true);
 for(let offset=0;offset<520;offset+=100){
  const changes=Array.from({length:Math.min(100,520-offset)},(_,i)=>({id:'child-'+String(offset+i).padStart(4,'0'),collection:'tasks',patch:{boardId:'projects',parentId:'project',title:'Bounded child '+(offset+i),status:'active',createdAt:now},ts:now}));
  expect((await applyChanges(f.env,'alice',changes,{serverTs:true})).rejected).toBe(0);
 }
 const env=withWorkspaceContext(withD1Budget(f.env)),[page]=await collectProjectHealth(env,'alice',[cfg()],now);
 expect(page.projects).toHaveLength(1);expect(page.partialSources).toContain('project_tree');expect(page.projects[0].health.status).toBe('unknown');expect(45-d1BudgetRemaining(env.DB)).toBeLessThanOrEqual(45);
});
it('withholds a completed snapshot when the principal is disabled during its final source read',async()=>{
 await seed(true);const sqlByStatement=new WeakMap<object,string>();let revoked=false;
 const database=new Proxy(f.db,{get(target,key){
  if(key==='prepare')return(sql:string)=>new Proxy(target.prepare(sql),{get(statement,property){
   if(property==='bind')return(...values:Parameters<D1PreparedStatement['bind']>)=>{const bound=statement.bind(...values);sqlByStatement.set(bound,sql);return bound;};
   const value=Reflect.get(statement,property);return typeof value==='function'?value.bind(statement):value;
  }});
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{
   const result=await target.batch(statements);
   if(!revoked&&statements.some(s=>sqlByStatement.get(s)?.includes('WITH ranked AS'))){revoked=true;await f.db.prepare("UPDATE users SET disabled_at=? WHERE id='alice'").bind(now).run();}
   return result;
  };
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 await expect(collectProjectHealth(withWorkspaceContext(withD1Budget({...f.env,DB:database})),'alice',[cfg()],now)).rejects.toThrow('access_reset_required');expect(revoked).toBe(true);
});
it('reports source changes when a root revision changes between selection and authorization',async()=>{
 await seed(true);let changed=false;
 const wrap=(statement:D1PreparedStatement,sql:string):D1PreparedStatement=>new Proxy(statement,{get(target,key){
  if(key==='bind')return(...values:Parameters<D1PreparedStatement['bind']>)=>wrap(target.bind(...values),sql);
  if(key==='all')return async()=>{const result=await target.all();if(!changed&&sql.includes("'root' bucket")){changed=true;await applyChanges(f.env,'alice',[{id:'project',collection:'tasks',patch:{p_f_end:'2026-12-01'},ts:now}],{serverTs:true});}return result;};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 const database=new Proxy(f.db,{get(target,key){if(key==='prepare')return(sql:string)=>wrap(target.prepare(sql),sql);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 await expect(collectProjectHealth(withWorkspaceContext(withD1Budget({...f.env,DB:database})),'alice',[cfg()],now)).rejects.toThrow('project_sources_changed');expect(changed).toBe(true);
 const [fresh]=await collectProjectHealth(withWorkspaceContext(withD1Budget(f.env)),'alice',[cfg()],now);expect(fresh.projects.map(p=>p.id)).toEqual(['project']);
 changed=false;await applyChanges(f.env,'alice',[{id:'project',collection:'tasks',patch:{p_f_end:'2026-11-01'},ts:now}],{serverTs:true});
 const response=await projectHealthApi.request('https://local.test/',{method:'POST',headers:f.auth('alice'),body:JSON.stringify([cfg()])},withWorkspaceContext(withD1Budget({...f.env,DB:database})));expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'project_sources_changed'});
});
