// The capability registry must classify exactly the tools the MCP server registers.
import {describe,expect,it,vi} from 'vitest';
const reg=vi.hoisted(()=>({tools:new Map<string,{readOnly:boolean;disabled:boolean}>(),prompts:[] as string[],resources:[] as string[]}));
vi.mock('@modelcontextprotocol/server',()=>({
 McpServer:class{registerTool(n:string,m:{annotations?:{readOnlyHint?:boolean}}){const t={readOnly:m.annotations?.readOnlyHint===true,disabled:false};reg.tools.set(n,t);return {disable(){t.disabled=true;}};}registerPrompt(n:string){reg.prompts.push(n);}registerResource(n:string){reg.resources.push(n);}},
 ResourceTemplate:class{constructor(public uri:string){}},
}));
vi.mock('agents/mcp/server',()=>({createMcpHandler:vi.fn()}));
import {createWorkspaceServer} from '../worker/mcp';
import {CAPABILITIES,capabilityOf,isEmbeddedAllowed} from '../shared/aiCapabilities';
import {AI_ACTIONS} from '../shared/aiActions';
import {AI_WORKFLOWS} from '../shared/aiWorkflows';

const db={prepare(){return {bind(){return this;},first:async()=>null,all:async()=>({results:[]}),run:async()=>({meta:{}})};},batch:async()=>[]};
function build(writable?:boolean){
 reg.tools.clear();reg.prompts.length=0;reg.resources.length=0;
 createWorkspaceServer({env:{DB:db} as never,ectx:{waitUntil(){}} as never,userId:'u',userRole:'admin',origin:'http://x',userByKey:new Map(),userNameById:new Map(),pageTitleById:new Map(),recordTitleById:new Map(),recordIdByTitle:new Map(),pageIdByTitle:new Map(),cachesReady:false,warnings:[],cs:null,toolName:'',writable} as never);
}
describe('shared capability registry',()=>{
 it('classifies every registered tool and nothing else',()=>{
  build();
  expect([...reg.tools.keys()].sort()).toEqual(CAPABILITIES.map(c=>c.id).sort());
 });
 it('read classification matches readOnlyHint in both directions',()=>{
  build();
  for(const [name,t] of reg.tools)expect([name,capabilityOf(name).kind==='read']).toEqual([name,t.readOnly]);
 });
 it('treats unknown tools as human-only writes',()=>{expect(capabilityOf('mystery')).toMatchObject({kind:'write',embedded:'deny'});expect(isEmbeddedAllowed('mystery')).toBe(false);});
 it('keeps approval, execution, undo and publication human-only',()=>{
  for(const id of ['execute_preview','decide_approval','request_approval','undo_change','publish_page','share_moodboard'])expect(isEmbeddedAllowed(id)).toBe(false);
 });
 it('hides every non-read tool from discovery when the caller can write nowhere, and none otherwise',()=>{
  build(false);for(const [name,t] of reg.tools)expect([name,t.disabled]).toEqual([name,capabilityOf(name).kind!=='read']);
  build(true);expect([...reg.tools.values()].some(t=>t.disabled)).toBe(false);
 });
 it('registers resources plus workflow and contextual-action prompts from the shared catalogs',()=>{
  build();
  expect(reg.resources).toEqual(expect.arrayContaining(['workspace-overview','workspace-capabilities','workspace-page','workspace-record','workspace-database','workspace-moodboard']));
  for(const w of AI_WORKFLOWS)expect(reg.prompts).toContain(w.id);
  for(const a of AI_ACTIONS)expect(reg.prompts).toContain('action_'+a.id);
 });
});
