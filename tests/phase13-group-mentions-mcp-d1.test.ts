import {afterEach,expect,it,vi} from 'vitest';
import {openAuditFixture,type AuditFixture} from './audit-fixture';
const tools=vi.hoisted(()=>new Map<string,(args:Record<string,unknown>)=>Promise<{content:{text:string}[]}>>());
vi.mock('@modelcontextprotocol/server',()=>({McpServer:class{registerTool(name:string,_meta:unknown,fn:never){tools.set(name,fn);}registerPrompt(){}registerResource(){}},ResourceTemplate:class{}}));
vi.mock('agents/mcp/server',()=>({createMcpHandler:vi.fn()}));
import {createWorkspaceServer} from '../worker/mcp';
let f:AuditFixture;afterEach(async()=>f?.dispose());
async function setup(){
 f=await openAuditFixture();await f.db.batch([
  f.db.prepare('UPDATE access_state SET enabled=1'),
  f.db.prepare("INSERT INTO spaces(id,name,default_access,created_at) VALUES('vault','CONFIDENTIAL NAME','private',1)"),
  f.db.prepare("INSERT INTO records(id,collection,data,field_ts,seq) VALUES('p','pages','{\"title\":\"Probe\"}','{}',1)"),
  f.db.prepare("INSERT INTO records(id,collection,data,field_ts,seq) VALUES('b','blocks',?,'{}',2)").bind(JSON.stringify({pageId:'p',type:'p',order:'a0',text:'@[group:space-core] @[group:vault]'})),
 ]);
}
async function read(connector=false){
 createWorkspaceServer({env:connector?{...f.env,CONNECTOR:{id:'grant',version:1}}:f.env,ectx:f.ctx,userId:'bob',userRole:'member',origin:'http://localhost',userByKey:new Map(),userNameById:new Map(),pageTitleById:new Map(),recordTitleById:new Map(),recordIdByTitle:new Map(),pageIdByTitle:new Map(),cachesReady:false,warnings:[],cs:null,toolName:''} as never);
 return JSON.parse((await tools.get('get_page')!({pageId:'p'})).content[0].text);
}
it('MCP renders only authorized Space names and reacts to current membership changes',async()=>{
 await setup();const first=await read();expect(first.markdown).toContain('@space(Core)');expect(first.markdown).toContain('@[group:vault]');expect(JSON.stringify(first)).not.toContain('CONFIDENTIAL NAME');
 await f.db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('vault','bob','viewer')").run();expect((await read()).markdown).toContain('@space(CONFIDENTIAL NAME)');
 await f.db.prepare("DELETE FROM space_members WHERE space_id='vault' AND user_id='bob'").run();expect(JSON.stringify(await read())).not.toContain('CONFIDENTIAL NAME');
});
it('MCP intersects Space name resolution with the connector current approved scope',async()=>{
 await setup();await f.db.batch([f.db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('vault','bob','viewer')"),f.db.prepare("INSERT INTO ai_connections(id,user_id,client_id,spaces_json,version,created_at,expires_at) VALUES('grant','bob','fixture','[\"space-core\"]',1,1,?)").bind(Date.now()+60000)]);
 const result=await read(true);expect(result.markdown).toContain('@space(Core)');expect(JSON.stringify(result)).not.toContain('CONFIDENTIAL NAME');
});
