/** Embedded assistant ⇄ Workspace MCP server, in process.
 *
 * The assistant is a genuine MCP client of the SAME `createWorkspaceServer` that
 * external hosts reach over HTTP, connected through an in-memory transport (no
 * self-HTTP loop, no privileged D1 shortcut). The server is built per step with
 * the session user's identity and a fresh read gate, `assistant` mode (every
 * write → frozen preview, human-only tools refused) and the writable-space
 * discovery hint. */
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/server';
import type {Env} from '../auth';
import {createWorkspaceServer} from '../mcp';
import {hasWritableSpace} from '../capability';
import {capabilityOf,isEmbeddedAllowed} from '../../shared/aiCapabilities';

export interface BridgeIdentity {userId:string;userRole:'admin'|'member';origin:string;provider:string;model:string}
export interface ToolSpec {name:string;description:string;parameters:Record<string,unknown>}
export interface ToolOutcome {ok:boolean;text:string;json:Record<string,unknown>|null}

export interface Bridge {
 listTools():Promise<ToolSpec[]>;
 call(name:string,args:Record<string,unknown>):Promise<ToolOutcome>;
 close():Promise<void>;
}

export async function openBridge(env:Env,ectx:ExecutionContext,id:BridgeIdentity):Promise<Bridge>{
 const writable=await hasWritableSpace(env.DB,id.userId);
 const server=createWorkspaceServer({env,ectx,userId:id.userId,userRole:id.userRole,clientName:`Workspace Assistant (${id.provider}/${id.model})`.slice(0,120),origin:id.origin,userByKey:new Map(),userNameById:new Map(),pageTitleById:new Map(),recordTitleById:new Map(),recordIdByTitle:new Map(),pageIdByTitle:new Map(),cachesReady:false,warnings:[],cs:null,toolName:'',assistant:{provider:id.provider,model:id.model},writable});
 const [clientSide,serverSide]=InMemoryTransport.createLinkedPair();
 await server.connect(serverSide);
 const client=new Client({name:'workspace-assistant',version:'1.0.0'});
 await client.connect(clientSide);
 return {
  async listTools(){
   const out:ToolSpec[]=[];let cursor:string|undefined;
   do{const page=await client.listTools(cursor?{cursor}:undefined);for(const t of page.tools)if(isEmbeddedAllowed(t.name))out.push({name:t.name,description:(t.description??'').slice(0,600),parameters:(t.inputSchema??{type:'object'}) as Record<string,unknown>});cursor=page.nextCursor;}while(cursor);
   return out;
  },
  async call(name,args){
   // Fail closed before reaching the server too (defence in depth).
   if(!isEmbeddedAllowed(name))return {ok:false,text:JSON.stringify({error:'assistant_requires_human_workspace_action'}),json:{error:'assistant_requires_human_workspace_action'}};
   const clean=Object.fromEntries(Object.entries(args??{}).filter(([k])=>k!=='previewId'));
   const result=await client.callTool({name,arguments:clean});
   const text=(result.content as {type:string;text?:string}[]|undefined)?.filter(c=>c.type==='text').map(c=>c.text??'').join('\n')??'';
   let json:Record<string,unknown>|null=null;try{const v=JSON.parse(text);if(v&&typeof v==='object'&&!Array.isArray(v))json=v as Record<string,unknown>;}catch{/* plain text */}
   return {ok:result.isError!==true&&!(json&&typeof json.error==='string'),text,json};
  },
  async close(){await client.close().catch(()=>{});await server.close().catch(()=>{});},
 };
}

/** Bounded tool selection: a stable core plus module-relevant capabilities, so
 * small models are not flooded and every listed tool is embedded-allowed. */
const CORE=new Set(['search','get_page','get_record','get_board','get_task','query_records','neighbors','activity_for','recent_activity','list_attachments','list_comments','get_record_history','workspace_overview','dashboard_snapshot','operating_review_context','find_collaborators','list_automations','get_moodboard','list_approvals','propose_workflow','propose_suggestion','create_page','edit_page','create_tasks','update_tasks','create_records','update_records','edit_record_body','add_comment','link_items']);
const MODULE_EXTRA:Record<string,string[]>={moodboards:['add_mood_items','update_mood_items','connect_items','layout_moodboard','add_frame'],databases:['add_view','update_view','add_field','update_field','add_stage'],projects:['create_project','add_dependency','set_parent'],tasks:['add_dependency','set_parent'],notes:['find_or_create_page']};
export function selectTools(all:ToolSpec[],modules:string[]):ToolSpec[]{
 const wanted=new Set([...CORE,...modules.flatMap(m=>MODULE_EXTRA[m]??[])]);
 return all.filter(t=>wanted.has(t.name)&&isEmbeddedAllowed(t.name));
}
export const toolKind=(name:string)=>capabilityOf(name).kind;
