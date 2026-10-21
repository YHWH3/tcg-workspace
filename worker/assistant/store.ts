/** Server-only conversation persistence (migration 0032). Every read path is
 * user-scoped; reopening a conversation re-checks each message's source IDs
 * against the caller's CURRENT read gate and redacts messages whose sources are
 * no longer readable (revocation, space moves, account switches). */
import type {Env} from '../auth';
import type {AssistantMessage,ConversationSummary,ContextRef,RunStatus,SourceRef} from '../../shared/assistantProtocol';
import {DEFAULT_RETENTION_DAYS} from '../../shared/assistantProtocol';
import {createReadGate} from '../readAccess';

// Dependency coverage is a bounded security contract, separate from visible citations.
export const MAX_ASSISTANT_SOURCES=1000;
export interface StoredContent {
 sourceCoverage?:1;sourceCoverageIncomplete?:boolean;
 /** Exact principal role captured BEFORE the content was consumed. */
 principalRole?:string;
 text:string;provider?:string;model?:string;context?:ContextRef[];
 /** Resolved, untrusted context payload sent to the model (user messages). */
 contextPayload?:string;
 toolCalls?:AssistantMessage['toolCalls'];
 /** Raw provider tool-call records needed to replay history to the model. */
 calls?:{id:string;name:string;arguments:string}[];
 toolCallId?:string;toolName?:string;
 sources?:SourceRef[];approval?:AssistantMessage['approval'];incomplete?:boolean;error?:string;
}
export interface MessageRow {id:string;role:'user'|'assistant'|'tool';seq:number;created_at:number;content:StoredContent;sourceIds:string[]}
export interface RunRow {id:string;conversation_id:string;user_id:string;session_hash:string;provider:string;model:string;status:RunStatus;step:number;pending:{id:string;name:string;arguments:string;sourceIds?:string[];sourceCoverage?:1;principalRole?:string}[];context:ContextRef[];action_id:string|null;cancel_requested:number;input_chars:number;output_chars:number}

const DAY=86_400_000;
export async function retentionDays(env:Env,userId:string){return (await env.DB.prepare('SELECT retention_days FROM assistant_settings WHERE user_id=?').bind(userId).first<number>('retention_days'))??DEFAULT_RETENTION_DAYS;}

export async function listConversations(env:Env,userId:string):Promise<ConversationSummary[]>{
 const rows=(await env.DB.prepare('SELECT id,title,provider,model,created_at,updated_at,expires_at FROM assistant_conversations WHERE user_id=? AND (expires_at IS NULL OR expires_at>?) ORDER BY updated_at DESC LIMIT 100').bind(userId,Date.now()).all<{id:string;title:string;provider:string|null;model:string|null;created_at:number;updated_at:number;expires_at:number|null}>()).results;
 return rows.map(r=>({id:r.id,title:r.title,provider:r.provider,model:r.model,createdAt:r.created_at,updatedAt:r.updated_at,expiresAt:r.expires_at}));
}
export async function getConversation(env:Env,userId:string,id:string){
 return env.DB.prepare('SELECT id,title,provider,model,created_at,updated_at,expires_at FROM assistant_conversations WHERE id=? AND user_id=? AND (expires_at IS NULL OR expires_at>?)').bind(id,userId,Date.now()).first<{id:string;title:string;provider:string|null;model:string|null;created_at:number;updated_at:number;expires_at:number|null}>();
}
export async function createConversation(env:Env,userId:string,title?:string):Promise<ConversationSummary>{
 const id=crypto.randomUUID(),now=Date.now(),expires=now+(await retentionDays(env,userId))*DAY,t=(title??'New conversation').trim().slice(0,120)||'New conversation';
 await env.DB.prepare('INSERT INTO assistant_conversations(id,user_id,title,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?)').bind(id,userId,t,now,now,expires).run();
 return {id,title:t,provider:null,model:null,createdAt:now,updatedAt:now,expiresAt:expires};
}
export async function loadMessages(env:Env,conversationId:string,userId:string):Promise<MessageRow[]>{
 const rows=(await env.DB.prepare('SELECT id,role,seq,content_json,source_ids,created_at FROM (SELECT * FROM assistant_messages WHERE conversation_id=? AND user_id=? ORDER BY seq DESC LIMIT 60) ORDER BY seq').bind(conversationId,userId).all<{id:string;role:'user'|'assistant'|'tool';seq:number;content_json:string;source_ids:string;created_at:number}>()).results;
 return rows.map(r=>({id:r.id,role:r.role,seq:r.seq,created_at:r.created_at,content:JSON.parse(r.content_json) as StoredContent,sourceIds:JSON.parse(r.source_ids) as string[]}));
}
/** Append messages atomically with the conversation touch (and optional run update). */
export function appendStatements(env:Env,conversationId:string,userId:string,messages:{id?:string;role:MessageRow['role'];content:StoredContent;sourceIds?:string[]}[],retention:number){
 const now=Date.now();
 return [
  ...messages.map(m=>env.DB.prepare(`INSERT INTO assistant_messages(id,conversation_id,user_id,seq,role,content_json,source_ids,created_at)
   SELECT ?,?,?,COALESCE((SELECT MAX(seq) FROM assistant_messages WHERE conversation_id=?),0)+1,?,?,?,? WHERE EXISTS(SELECT 1 FROM assistant_conversations WHERE id=? AND user_id=?)`)
   .bind(m.id??crypto.randomUUID(),conversationId,userId,conversationId,m.role,JSON.stringify({...m.content,sourceCoverage:1,sourceCoverageIncomplete:m.content.sourceCoverageIncomplete||new Set(m.sourceIds??[]).size>MAX_ASSISTANT_SOURCES||undefined}),JSON.stringify([...new Set(m.sourceIds??[])].slice(0,MAX_ASSISTANT_SOURCES)),now,conversationId,userId)),
  env.DB.prepare('UPDATE assistant_conversations SET updated_at=?,expires_at=? WHERE id=? AND user_id=?').bind(now,now+retention*DAY,conversationId,userId),
 ];
}

/** Revalidate stored messages against current access. Unreadable → redacted. */
export async function visibleMessages(env:Env,userId:string,rows:MessageRow[]):Promise<{rows:MessageRow[];readable:Set<string>}>{
 // Record IDs do not cover identity-directory data. Bind retained copies to
 // the principal role under which they were read, including member→guest.
 const principalRole=await env.DB.prepare('SELECT COALESCE(workspace_role,role) r FROM users WHERE id=? AND disabled_at IS NULL').bind(userId).first<string>('r');
 const covered=rows.filter(r=>r.content.sourceCoverage===1&&!r.content.sourceCoverageIncomplete&&r.content.principalRole===principalRole);
 const ids=[...new Set(covered.flatMap(r=>r.sourceIds))];
 // Never truncate a security decision. Excessive retained dependencies fail
 // closed without unbounded graph queries; users can start a narrower thread.
 const overflow=ids.length>MAX_ASSISTANT_SOURCES;
 const decision=!overflow&&ids.length?await createReadGate(env.DB,userId).decide(ids):{readable:new Set<string>()};
 const readable=new Set([...decision.readable]);
 return {readable,rows:rows.map(r=>{
  // Pre-fix model/tool payloads did not have complete dependency coverage.
  // Retain the original data, but do not disclose or resend unprovable copies.
  const legacy=(r.content.sourceCoverage!==1||!r.content.principalRole)&&(r.role!=='user'||!!r.content.contextPayload);
  const hidden=legacy||r.content.sourceCoverageIncomplete||(!!r.content.principalRole&&r.content.principalRole!==principalRole)||(overflow&&r.sourceIds.length>0)||r.sourceIds.some(id=>!readable.has(id));
  return hidden?{...r,content:{text:'',redacted:true} as StoredContent&{redacted:true}}:r;
 })};
}
export function toView(r:MessageRow):AssistantMessage{
 const c=r.content as StoredContent&{redacted?:boolean};
 return {id:r.id,role:r.role,text:c.redacted||r.role==='tool'?'':c.text,createdAt:r.created_at,provider:c.provider,model:c.model,context:c.context,toolCalls:c.toolCalls,sources:c.redacted?[]:c.sources,approval:c.redacted?undefined:c.approval,redacted:c.redacted||undefined,incomplete:c.incomplete||undefined};
}

export async function activeRun(env:Env,conversationId:string,userId:string){
 return env.DB.prepare("SELECT id,step,status FROM assistant_runs WHERE conversation_id=? AND user_id=? AND status IN('running','awaiting_continue') LIMIT 1").bind(conversationId,userId).first<{id:string;step:number;status:RunStatus}>();
}
export async function loadRun(env:Env,runId:string,userId:string):Promise<RunRow|null>{
 const r=await env.DB.prepare('SELECT * FROM assistant_runs WHERE id=? AND user_id=?').bind(runId,userId).first<Record<string,unknown>>();
 if(!r)return null;
 return {...(r as unknown as RunRow),pending:JSON.parse(String(r.pending_json)),context:JSON.parse(String(r.context_json))};
}
export async function deleteConversation(env:Env,userId:string,id?:string){
 const where=id?'id=? AND user_id=?':'user_id=?',binds=id?[id,userId]:[userId];
 const res=await env.DB.batch([
  env.DB.prepare(`DELETE FROM assistant_messages WHERE conversation_id IN(SELECT id FROM assistant_conversations WHERE ${where})`).bind(...binds),
  env.DB.prepare(`DELETE FROM assistant_runs WHERE conversation_id IN(SELECT id FROM assistant_conversations WHERE ${where})`).bind(...binds),
  env.DB.prepare(`DELETE FROM assistant_conversations WHERE ${where}`).bind(...binds),
 ]);
 return res[2].meta.changes??0;
}
/** Bounded retention sweep, called from the existing scheduler retention phase. */
export function retentionStatements(db:D1Database,now:number){
 const expired='SELECT id FROM assistant_conversations WHERE expires_at IS NOT NULL AND expires_at<? ORDER BY id LIMIT 200';
 return [
  db.prepare(`DELETE FROM assistant_messages WHERE conversation_id IN(${expired})`).bind(now),
  db.prepare(`DELETE FROM assistant_runs WHERE conversation_id IN(${expired})`).bind(now),
  db.prepare(`DELETE FROM assistant_conversations WHERE id IN(${expired})`).bind(now),
 ];
}
