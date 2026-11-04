import {afterEach,describe,it,expect,vi} from 'vitest';
const handlers=vi.hoisted(()=>new Map<string,(args:unknown)=>Promise<{content:{text:string}[];isError?:boolean}>>());
vi.mock('@modelcontextprotocol/server',()=>({McpServer:class{registerTool(name:string,_meta:unknown,handler:(args:unknown)=>Promise<{content:{text:string}[]}>){handlers.set(name,handler);}registerPrompt(){}registerResource(){}},ResourceTemplate:class{}}));
vi.mock('agents/mcp/server',()=>({createMcpHandler:vi.fn()}));
import pack from '../templates/tcg-pack.json';
import {createWorkspaceServer} from '../worker/mcp';
import {openAuditFixture,type AuditFixture} from './audit-fixture';
import {applyChanges} from '../worker/sync';
import {collectAttention,attentionApi} from '../worker/attention';
import {withD1Budget,d1BudgetRemaining} from '../worker/d1budget';
import {withWorkspaceContext} from '../worker/workspaceSettings';
let fixture:AuditFixture;const now=Date.parse('2026-10-31T12:00Z');
afterEach(async()=>{vi.restoreAllMocks();handlers.clear();await fixture?.dispose();});
async function call(name:string,args:Record<string,unknown>){
 const env=withWorkspaceContext(withD1Budget(fixture.env));createWorkspaceServer({env,ectx:fixture.ctx,userId:'alice',userRole:'admin',origin:'https://workspace.test',userByKey:new Map(),userNameById:new Map(),pageTitleById:new Map(),recordTitleById:new Map(),recordIdByTitle:new Map(),cachesReady:false,warnings:[],cs:null,toolName:''} as never);
 const result=await handlers.get(name)!(args);return {error:result.isError,data:JSON.parse(result.content[0].text),calls:45-d1BudgetRemaining(env.DB)};
}
async function seed(enabled:boolean){
 vi.spyOn(Date,'now').mockReturnValue(now);fixture=await openAuditFixture();
 await applyChanges(fixture.env,'alice',[...['media','other'].map(id=>({id,collection:'boards',patch:{kind:'records',name:id,columns:[],fields:[]},ts:now})),...['media','other'].map(id=>({id:id+'-record',collection:'tasks',patch:{boardId:id,title:'Synthetic '+id},ts:now}))],{serverTs:true});
 await fixture.db.batch([...Array.from({length:105},(_,index)=>fixture.db.prepare("INSERT INTO approvals(id,target_type,target_id,requested_by,approver_id,status,created_at) VALUES(?,'record','other-record','bob','alice','pending',?)").bind('other-approval-'+String(index).padStart(3,'0'),now-1000+index)),...['a','b'].map(id=>fixture.db.prepare("INSERT INTO approvals(id,target_type,target_id,requested_by,approver_id,status,created_at) VALUES(?,'record','media-record','bob','alice','pending',?)").bind('media-approval-'+id,now))]);
 await fixture.db.prepare('UPDATE access_state SET enabled=? WHERE id=1').bind(enabled?1:0).run();
}
for(const enabled of [false,true])describe(`Editorial approvals permission mode ${enabled}`,()=>{
 it('shares scoped approval results through MCP and reports malformed block scope without widening it',async()=>{
  await seed(enabled);await applyChanges(fixture.env,'alice',[{id:'editorial',collection:'pages',patch:{title:'Editorial desk'},ts:now},{id:'a-media-queue',collection:'blocks',patch:{pageId:'editorial',type:'attention',approvalDatabaseId:'media',kinds:['approval_pending'],limit:10,order:'a0'},ts:now},{id:'b-invalid-queue',collection:'blocks',patch:{pageId:'editorial',type:'attention',approvalDatabaseId:true,kinds:['approval_pending'],order:'a1'},ts:now}],{serverTs:true});
  const tool=await call('attention_queue',{approvalDatabaseId:'media',kinds:['approval_pending']});expect(tool.error,JSON.stringify(tool.data)).not.toBe(true);expect(tool.data.items.map((item:{targetId:string})=>item.targetId)).toEqual(['media-approval-a','media-approval-b']);
  const snapshot=await call('dashboard_snapshot',{pageId:'editorial'});expect(snapshot.error,JSON.stringify(snapshot.data)).not.toBe(true);expect(snapshot.calls).toBeLessThanOrEqual(45);expect(snapshot.data.blocks.find((block:{id:string})=>block.id==='a-media-queue').items).toEqual(tool.data.items);expect(snapshot.data.blocks.find((block:{id:string})=>block.id==='b-invalid-queue')).toMatchObject({items:[],partial:true,partialSources:['configuration']});expect(snapshot.data.truncated).toBe(true);
 });
 it('filters the approval database before its source cap and binds pagination to that database',async()=>{
  await seed(enabled);const env=withWorkspaceContext(withD1Budget(fixture.env)),query={approvalDatabaseId:'media',kinds:['approval_pending'],limit:1};
  const first=await collectAttention(env,'alice',query as never,now);expect(first.items.map(item=>item.targetId)).toEqual(['media-approval-a']);expect(first.partial).toBe(false);expect(first.nextCursor).toBeTruthy();expect(45-d1BudgetRemaining(env.DB)).toBeLessThanOrEqual(18);
  const read=(args:Record<string,unknown>)=>collectAttention(withWorkspaceContext(withD1Budget(fixture.env)),'alice',args as never,now);
  expect((await read({...query,cursor:first.nextCursor})).items.map(item=>item.targetId)).toEqual(['media-approval-b']);await expect(read({...query,approvalDatabaseId:'other',cursor:first.nextCursor})).rejects.toThrow('invalid_cursor');await expect(read({kinds:query.kinds,cursor:first.nextCursor})).rejects.toThrow('invalid_cursor');
 });
 it('uses the same scope through HTTP without changing unrelated global approval behavior',async()=>{
  await seed(enabled);const response=await attentionApi.request('/?approvalDatabaseId=media&kinds=approval_pending',{headers:fixture.auth('alice')},withWorkspaceContext(withD1Budget(fixture.env)));
  expect(response.status).toBe(200);expect((await response.json() as {items:{targetId:string}[]}).items.map(item=>item.targetId)).toEqual(['media-approval-a','media-approval-b']);
  const global=await collectAttention(withWorkspaceContext(withD1Budget(fixture.env)),'alice',{kinds:['approval_pending']},now);expect(global.items).toHaveLength(50);expect(global.partialSources).toContain('approval_pending');
 });
 it('fails closed if the caller is disabled during the scoped read',async()=>{
  await seed(enabled);let disabled=false;
  const database=new Proxy(fixture.db,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{const result=await target.batch(statements);if(!disabled){disabled=true;await fixture.db.prepare("UPDATE users SET disabled_at=? WHERE id='alice'").bind(now).run();}return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  await expect(collectAttention(withWorkspaceContext(withD1Budget({...fixture.env,DB:database})),'alice',{approvalDatabaseId:'media',kinds:['approval_pending']},now)).rejects.toThrow('unauthenticated');expect(disabled).toBe(true);
 });
});
it('treats private and missing approval databases alike and preserves global restricted placeholders',async()=>{
 await seed(true);await fixture.db.batch([fixture.db.prepare("INSERT INTO spaces(id,name,default_access,created_at) VALUES('vault','Private Media','private',1)"),fixture.db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('vault','alice','owner')"),fixture.db.prepare("UPDATE records SET space_id='vault' WHERE id IN('media','media-record')"),fixture.db.prepare("INSERT INTO approvals(id,target_type,target_id,requested_by,approver_id,status,created_at) VALUES('private-approval','record','media-record','alice','bob','pending',1)")]);
 const read=(approvalDatabaseId?:string)=>collectAttention(withWorkspaceContext(withD1Budget(fixture.env)),'bob',{approvalDatabaseId,kinds:['approval_pending']},now);
 const hidden=await read('media'),missing=await read('missing');expect(hidden).toEqual(missing);expect(hidden).toMatchObject({items:[],partial:true,partialSources:['approval_database_unavailable']});expect(JSON.stringify(hidden)).not.toMatch(/Synthetic|media-record|private-approval/);expect((await read()).items).toMatchObject([{restricted:true,title:'',url:null}]);
});
it('exposes unavailable/deleted/archived database recovery and rejects malformed scope at the HTTP boundary',async()=>{
 await seed(false);const read=()=>collectAttention(withWorkspaceContext(withD1Budget(fixture.env)),'alice',{approvalDatabaseId:'media',kinds:['approval_pending']},now);
 for(const patch of [{deleted:true},{deleted:false,archived:true}]){await applyChanges(fixture.env,'alice',[{id:'media',collection:'boards',patch,ts:now}],{serverTs:true});expect(await read()).toMatchObject({items:[],partialSources:['approval_database_unavailable']});}
 await applyChanges(fixture.env,'alice',[{id:'media',collection:'boards',patch:{archived:false},ts:now}],{serverTs:true});expect((await read()).items).toHaveLength(2);
 const invalid=await attentionApi.request('/?approvalDatabaseId='+('x'.repeat(65)),{headers:fixture.auth('alice')},withWorkspaceContext(withD1Budget(fixture.env)));expect(invalid.status).toBe(400);
});

for(const enabled of [false,true])it(`keeps reverse linked Media out of missing-source snapshot (permissions ${enabled})`,async()=>{
 await seed(enabled);
 const writes=[
  {id:'media',collection:'boards',patch:{fields:[{id:'f_experiments',name:'Experiments',type:'relation',relation:{target:'experiments',primary:false,pairedFieldId:'f_media'}}]}},
  {id:'experiments',collection:'boards',patch:{kind:'records',name:'Experiments',fields:[{id:'f_media',name:'Media',type:'relation',relation:{target:'media',primary:true,pairedFieldId:'f_experiments'}}]}},
  {id:'experiment',collection:'tasks',patch:{boardId:'experiments',title:'Synthetic source'}},
  {id:'source-link',collection:'links',patch:{kind:'relation',fromType:'record',toType:'record',fieldId:'f_media',fromId:'experiment',toId:'media-record'}},
  {id:'editorial',collection:'pages',patch:{title:'Editorial desk'}},
  {id:'missing-source',collection:'blocks',patch:{pageId:'editorial',type:'view',databaseId:'media',inline:{filters:[{key:'rel_f_experiments',op:'empty'}]},order:'a0'}}
 ];
 expect((await applyChanges(fixture.env,'alice',writes.map(write=>({...write,ts:now})),{serverTs:true})).rejectedItems??[]).toEqual([]);
 const snapshot=await call('dashboard_snapshot',{pageId:'editorial'});expect(snapshot.error,JSON.stringify(snapshot.data)).not.toBe(true);expect(snapshot.calls).toBeLessThanOrEqual(45);expect(snapshot.data.blocks[0].records).toEqual([]);
 // Another database may reuse the same primary field id. It is not an Experiment.
 await applyChanges(fixture.env,'alice',[{id:'courses',collection:'boards',patch:{name:'Courses',kind:'records'},ts:now},{id:'course',collection:'tasks',patch:{boardId:'courses',title:'Unrelated course'},ts:now},{id:'course-link',collection:'links',patch:{kind:'relation',fromType:'record',toType:'record',fromId:'course',toId:'media-record',fieldId:'f_media'},ts:now}],{serverTs:true});
 for(const patch of [{deleted:true},{deleted:false,archived:true}]){
  await applyChanges(fixture.env,'alice',[{id:'experiment',collection:'tasks',patch,ts:now}],{serverTs:true});
  const missing=await call('dashboard_snapshot',{pageId:'editorial'});expect(missing.data.blocks[0].records.map((row:{id:string})=>row.id)).toEqual(['media-record']);expect(JSON.stringify(missing.data)).not.toContain('Unrelated course');
 }
 await applyChanges(fixture.env,'alice',[{id:'experiment',collection:'tasks',patch:{archived:false},ts:now}],{serverTs:true});expect((await call('dashboard_snapshot',{pageId:'editorial'})).data.blocks[0].records).toEqual([]);
 if(enabled){
  await fixture.db.batch([fixture.db.prepare("INSERT INTO spaces(id,name,default_access,created_at) VALUES('source-vault','Private sources','private',1)"),fixture.db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('source-vault','bob','owner')"),fixture.db.prepare("UPDATE records SET space_id='source-vault' WHERE id IN('experiment','experiments')")]);
  const hidden=await call('dashboard_snapshot',{pageId:'editorial'});expect(hidden.data.blocks[0].records).toHaveLength(1);expect(JSON.stringify(hidden.data)).not.toContain('Synthetic source');
 }
});

for(const enabled of [false,true])it(`reads all Editorial data blocks together within the D1 budget (permissions ${enabled})`,async()=>{
 await seed(enabled);
 const page=pack.pages.find(page=>page.id==='pg_editorial')!,boards=pack.databases.filter(board=>['db_media','db_fieldlog','db_experiments'].includes(board.id));
 const writes=[...boards.map(board=>({id:board.id,collection:'boards',patch:{kind:'records',name:board.name,fields:board.fields,columns:board.columns}})),
 ...boards.flatMap(board=>board.views.map(view=>({id:view.id,collection:'views',patch:{databaseId:board.id,name:view.name,type:view.type,config:view.config}}))),
 {id:'editorial-all',collection:'pages',patch:{title:'Editorial combined snapshot'}},
 ...page.blocks.filter(block=>['attention','view','calendar'].includes(block.type)).map((block,index)=>({id:block.key,collection:'blocks',patch:{...block,pageId:'editorial-all',order:'a'+index}})),
 {id:'media-complete',collection:'tasks',patch:{boardId:'db_media',title:'Complete Media',status:'review',p_f_owner:'alice',p_f_publish_date:'2026-10-31'}},
 {id:'media-gap',collection:'tasks',patch:{boardId:'db_media',title:'Missing owner',status:'editing',p_f_publish_date:'2026-10-31'}},
 {id:'field-gap',collection:'tasks',patch:{boardId:'db_fieldlog',title:'Unlinked Field Log'}},
 {id:'experiment-complete',collection:'tasks',patch:{boardId:'db_experiments',title:'Available source'}},
 {id:'combined-link',collection:'links',patch:{kind:'relation',fromType:'record',toType:'record',fromId:'experiment-complete',toId:'media-complete',fieldId:'f_media'}}];
 expect((await applyChanges(fixture.env,'alice',writes.map(write=>({...write,ts:now})),{serverTs:true})).rejectedItems??[]).toEqual([]);
 await fixture.db.prepare("INSERT INTO approvals(id,target_type,target_id,requested_by,approver_id,status,created_at) VALUES('combined-approval','record','media-complete','bob','alice','pending',?)").bind(now).run();
 const snapshot=await call('dashboard_snapshot',{pageId:'editorial-all'});expect(snapshot.error,JSON.stringify(snapshot.data)).not.toBe(true);expect(snapshot.calls).toBeLessThanOrEqual(45);expect(snapshot.data.truncated).toBe(false);
 const blocks=new Map(snapshot.data.blocks.map((block:{id:string})=>[block.id,block]));
 expect(blocks.get('editorial_approvals')).toMatchObject({items:[{targetId:'combined-approval',databaseId:'db_media'}],partial:false});
 expect(blocks.get('editorial_review')).toMatchObject({records:[{id:'media-complete'}]});expect(blocks.get('editorial_missing_owner')).toMatchObject({records:[{id:'media-gap'}]});expect(blocks.get('editorial_missing_date')).toMatchObject({records:[]});
 expect(blocks.get('editorial_media_sources')).toMatchObject({records:[{id:'media-gap'}]});expect(blocks.get('editorial_fieldlog_sources')).toMatchObject({records:[{id:'field-gap'}]});expect(blocks.get('editorial_calendar')).toMatchObject({dates:{'2026-10-31':expect.any(Array)}});
});
it('returns an explicit incomplete relational result when the relation window is capped',async()=>{
 await seed(false);await applyChanges(fixture.env,'alice',[{id:'editorial-cap',collection:'pages',patch:{title:'Capped relation check'},ts:now},{id:'capped-view',collection:'blocks',patch:{pageId:'editorial-cap',type:'view',databaseId:'media',inline:{filters:[{key:'rel_sources',op:'empty'}]}},ts:now}],{serverTs:true});
 await fixture.db.batch(Array.from({length:1001},(_,index)=>fixture.db.prepare("INSERT INTO records(id,collection,data,field_ts,updated_at,updated_by,seq) VALUES(?,'links',?,'{}',?,'alice',?)").bind('capped-link-'+index,JSON.stringify({kind:'relation',fromId:'media-record',toId:'other-record',fieldId:'sources'}),now,10000+index)));
 const snapshot=await call('dashboard_snapshot',{pageId:'editorial-cap'});expect(snapshot.error,JSON.stringify(snapshot.data)).not.toBe(true);expect(snapshot.data.truncated).toBe(true);expect(snapshot.data.blocks[0]).toMatchObject({records:[],status:'partial',partialSources:['relations']});
});

it('bounds multiple dashboard approval scopes without starving common reads or widening skipped scopes',async()=>{
 await seed(true);await applyChanges(fixture.env,'alice',[{id:'multi-scope',collection:'pages',patch:{title:'Multiple approval scopes'},ts:now},...['media','other'].map((id,index)=>({id:'scoped-'+id,collection:'blocks',patch:{pageId:'multi-scope',type:'attention',approvalDatabaseId:id,kinds:['approval_pending'],order:'a'+index},ts:now}))],{serverTs:true});
 const snapshot=await call('dashboard_snapshot',{pageId:'multi-scope'});expect(snapshot.error,JSON.stringify(snapshot.data)).not.toBe(true);expect(snapshot.calls).toBeLessThanOrEqual(45);
 for(const block of snapshot.data.blocks){expect(block.items.every((item:{databaseId:string})=>item.databaseId===block.id.slice(7))).toBe(true);if(block.partialSources.includes('processing_budget'))expect(block.items).toEqual([]);}
});
