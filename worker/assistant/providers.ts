/** Embedded-inference provider abstraction. Each provider separates: status /
 * eligibility, credentials, model discovery, streaming inference, tool-call
 * translation and error mapping. Policy:
 *  - Disabled unless explicitly configured by the operator (Env) and, for BYOK,
 *    the user's own key.
 *  - Exact provider hosts only, `redirect:'error'`, no fallback to any other
 *    provider or billing path on failure.
 *  - ChatGPT plan usage is NOT available to this hosted Worker (OpenAI requires
 *    approval for paid/remotely hosted apps); that adapter stays gated. Eligible
 *    local plan usage lives in companion/ (runs on the user's machine).
 *  - The simulated provider exists only when WORKSPACE_ENV === 'local-test'. */
import type {Env} from '../auth';
import type {AssistantErrorCode,ProviderId,ProviderStatus,ProviderModel} from '../../shared/assistantProtocol';
import type {ToolSpec} from './bridge';
import {reserveAi} from '../aiProvider';

export interface ChatTurn {role:'user'|'assistant'|'tool';text?:string;toolCalls?:{id:string;name:string;arguments:string}[];toolCallId?:string;name?:string}
export interface InferenceRequest {model:string;system:string;turns:ChatTurn[];tools:ToolSpec[];signal?:AbortSignal;userId:string}
export type ProviderEvent =
 | {type:'text';delta:string}
 | {type:'tool_call';id:string;name:string;arguments:string}
 | {type:'done'}
 | {type:'error';code:AssistantErrorCode;message:string;retryable:boolean;providerCode?:string;status?:number};

export interface Provider {
 id:ProviderId;
 status(env:Env,userId:string,cred:CredentialView|null):ProviderStatus;
 stream(env:Env,req:InferenceRequest,secret:string|null):AsyncGenerator<ProviderEvent>;
}
export interface CredentialView {configured:boolean;models:ProviderModel[]}

export const OPENAI_HOST='api.openai.com',ANTHROPIC_HOST='api.anthropic.com';
const OPENAI_RESPONSES='https://api.openai.com/v1/responses',OPENAI_MODELS='https://api.openai.com/v1/models';
const ANTHROPIC_MESSAGES='https://api.anthropic.com/v1/messages',ANTHROPIC_MODELS='https://api.anthropic.com/v1/models';

const byokEnabled=(env:Env,id:'openai'|'anthropic')=>!!env.AI_CREDENTIAL_KEY&&(env.AI_BYOK_PROVIDERS??'').split(',').map(s=>s.trim()).includes(id);
export const simulatedEnabled=(env:Env)=>env.WORKSPACE_ENV==='local-test';

/* ---------- SSE parsing (shared by OpenAI + Anthropic) ---------- */
export async function* sseEvents(body:ReadableStream<Uint8Array>,signal?:AbortSignal):AsyncGenerator<{event:string;data:string}>{
 const reader=body.getReader(),decoder=new TextDecoder();let buf='',event='',data:string[]=[];
 try{
  for(;;){
   if(signal?.aborted)throw new DOMException('aborted','AbortError');
   const {value,done}=await reader.read();if(done)break;
   buf+=decoder.decode(value,{stream:true});
   let nl:number;
   while((nl=buf.indexOf('\n'))>=0){
    const line=buf.slice(0,nl).replace(/\r$/,'');buf=buf.slice(nl+1);
    if(line===''){if(data.length)yield {event,data:data.join('\n')};event='';data=[];continue;}
    if(line.startsWith(':'))continue;
    const i=line.indexOf(':'),field=i<0?line:line.slice(0,i),val=i<0?'':line.slice(i+1).replace(/^ /,'');
    if(field==='event')event=val;else if(field==='data')data.push(val);
   }
  }
  if(data.length)yield {event,data:data.join('\n')};
 }finally{reader.releaseLock();}
}

async function egress(url:string,init:RequestInit,expectedHost:string):Promise<Response>{
 const u=new URL(url);if(u.protocol!=='https:'||u.hostname!==expectedHost)throw new Error('provider_host_not_allowed');
 return fetch(url,{...init,redirect:'error'});
}

/* ---------- OpenAI Responses API (BYOK; also the gated hosted ChatGPT adapter) ---------- */
export function toResponsesInput(turns:ChatTurn[]){
 const input:Record<string,unknown>[]=[];
 for(const t of turns){
  if(t.role==='user')input.push({role:'user',content:t.text??''});
  else if(t.role==='assistant'){if(t.text)input.push({role:'assistant',content:t.text});for(const c of t.toolCalls??[])input.push({type:'function_call',call_id:c.id,name:c.name,arguments:c.arguments});}
  else input.push({type:'function_call_output',call_id:t.toolCallId,output:t.text??''});
 }
 return input;
}
/** ChatGPT-plan route forbids these fields; BYOK simply does not need them. */
export const RESPONSES_FORBIDDEN=['background','conversation','max_output_tokens','max_tool_calls','metadata','moderation','multi_agent','prompt','prompt_cache_retention','safety_identifier','temperature','top_logprobs','top_p','truncation','user','previous_response_id'];
export function responsesBody(req:InferenceRequest){
 return {model:req.model,instructions:req.system,input:toResponsesInput(req.turns),tools:req.tools.map(t=>({type:'function',name:t.name,description:t.description,parameters:t.parameters,strict:false})),store:false,stream:true};
}
const PLAN_CODES:Record<string,{code:AssistantErrorCode;retryable:boolean}>={
 subscription_sharing_usage_limit_exceeded:{code:'provider_usage_limit',retryable:false},
 subscription_sharing_user_not_eligible:{code:'provider_not_eligible',retryable:false},
 subscription_sharing_usage_unavailable:{code:'provider_unavailable',retryable:true},
 subscription_sharing_user_unavailable:{code:'provider_unavailable',retryable:true},
 subscription_sharing_unsupported_capability:{code:'provider_unsupported_capability',retryable:false},
 subscription_sharing_route_not_supported:{code:'provider_unsupported_capability',retryable:false},
 subscription_sharing_invalid_user:{code:'provider_auth_failed',retryable:false},
 chatpass_v2_scope_not_authorized:{code:'provider_auth_failed',retryable:false},
 chatpass_v2_invalid_authorization_context:{code:'provider_auth_failed',retryable:false},
 insufficient_quota:{code:'provider_usage_limit',retryable:false},
 invalid_api_key:{code:'provider_auth_failed',retryable:false},
};
export function mapProviderError(status:number,providerCode:string|undefined,message:string):ProviderEvent{
 const known=providerCode?PLAN_CODES[providerCode]:undefined;
 if(known)return {type:'error',...known,message:message.slice(0,300),providerCode,status};
 const code:AssistantErrorCode=status===401||status===403?'provider_auth_failed':status===429?'provider_usage_limit':status>=500?'provider_unavailable':'provider_failed';
 return {type:'error',code,retryable:status===429||status>=500,message:message.slice(0,300),providerCode,status};
}
async function errorFrom(res:Response):Promise<ProviderEvent>{
 const body=await res.text().catch(()=>'');let code:string|undefined,message=body;
 try{const j=JSON.parse(body) as {error?:{code?:string;type?:string;message?:string};detail?:string};code=j.error?.code??j.error?.type;message=j.error?.message??j.detail??body;}catch{/* opaque */}
 return mapProviderError(res.status,code,message||`HTTP ${res.status}`);
}
export async function* streamResponses(res:Response,signal?:AbortSignal):AsyncGenerator<ProviderEvent>{
 if(!res.ok||!res.body){yield await errorFrom(res);return;}
 let completed=false;
 try{
  for await(const ev of sseEvents(res.body,signal)){
   let j:Record<string,unknown>;try{j=JSON.parse(ev.data);}catch{continue;}
   const type=String(j.type??ev.event);
   if(type==='response.output_text.delta'&&typeof j.delta==='string')yield {type:'text',delta:j.delta};
   else if(type==='response.output_item.done'){const item=j.item as {type?:string;call_id?:string;name?:string;arguments?:string}|undefined;if(item?.type==='function_call'&&item.name)yield {type:'tool_call',id:item.call_id??crypto.randomUUID(),name:item.name,arguments:item.arguments??'{}'};}
   else if(type==='response.completed'){completed=true;break;}
   else if(type==='response.failed'||type==='error'){const e=((j.response as {error?:{code?:string;message?:string}}|undefined)?.error)??(j.error as {code?:string;message?:string}|undefined)??{code:j.code as string|undefined,message:j.message as string|undefined};yield mapProviderError(200,e?.code,e?.message??'response failed');return;}
   else if(type==='response.incomplete'){yield {type:'error',code:'provider_failed',retryable:false,message:'The provider returned an incomplete response.'};return;}
  }
 }catch(e){if((e as Error)?.name==='AbortError'){yield {type:'error',code:'provider_stream_interrupted',retryable:true,message:'Generation stopped.'};return;}yield {type:'error',code:'provider_stream_interrupted',retryable:true,message:'The provider stream was interrupted.'};return;}
 if(!completed){yield {type:'error',code:'provider_stream_interrupted',retryable:true,message:'The provider stream ended before completion.'};return;}
 yield {type:'done'};
}

const openai:Provider={
 id:'openai',
 status(env,_u,cred){
  const base={id:'openai' as const,label:'OpenAI API (your key)',mode:'byok' as const,billing:'user_api_account' as const,egressHost:OPENAI_HOST,supportsImages:false,models:cred?.models??[],credentialConfigured:!!cred?.configured};
  if(!byokEnabled(env,'openai'))return {...base,state:'disabled_by_operator',reason:'The workspace operator has not enabled bring-your-own-key OpenAI access.'};
  return cred?.configured?{...base,state:'available',defaultModel:cred.models[0]?.id}:{...base,state:'needs_credentials',reason:'Add your own OpenAI API key. Usage is billed to your OpenAI API account, not a ChatGPT plan.'};
 },
 async *stream(_env,req,secret){
  if(!secret){yield {type:'error',code:'provider_auth_failed',retryable:false,message:'No API key configured.'};return;}
  let res:Response;try{res=await egress(OPENAI_RESPONSES,{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify(responsesBody(req)),signal:req.signal},OPENAI_HOST);}
  catch{yield {type:'error',code:'provider_unavailable',retryable:true,message:'Could not reach the provider.'};return;}
  yield* streamResponses(res,req.signal);
 },
};

/* Hosted ChatGPT plan usage: requires OpenAI approval for paid or remotely hosted
 * apps. No documented hosted token flow is implemented; the adapter reuses the
 * Responses contract (store:false, stream:true, plan error codes) only so that an
 * approved deployment has a reviewed seam. It reports requires_provider_approval. */
const chatgptHosted:Provider={
 id:'chatgpt-hosted',
 status(env){
  const base={id:'chatgpt-hosted' as const,label:'ChatGPT plan (hosted)',mode:'chatgpt-hosted' as const,billing:'chatgpt_plan' as const,egressHost:OPENAI_HOST,supportsImages:false,models:[],manageUsageUrl:'https://chatgpt.com/#settings'};
  if(env.OPENAI_CHATGPT_HOSTED_APPROVAL!=='approved')return {...base,state:'requires_provider_approval',reason:'Using ChatGPT plans from a hosted app requires OpenAI approval. Use the local TCG Workspace Companion with your ChatGPT plan instead, or connect ChatGPT/Claude through MCP.'};
  return {...base,state:'unavailable',reason:'Approved hosted sign-in has not been configured for this deployment.'};
 },
 async *stream(){yield {type:'error',code:'provider_not_eligible',retryable:false,message:'ChatGPT plan usage is not available in hosted Workspace.'};},
};

/* ---------- Anthropic Messages API (BYOK) ---------- */
export function toAnthropicMessages(turns:ChatTurn[]){
 const out:{role:'user'|'assistant';content:unknown[]}[]=[];
 const push=(role:'user'|'assistant',block:unknown)=>{const last=out[out.length-1];if(last&&last.role===role)last.content.push(block);else out.push({role,content:[block]});};
 for(const t of turns){
  if(t.role==='user')push('user',{type:'text',text:t.text??''});
  else if(t.role==='assistant'){if(t.text)push('assistant',{type:'text',text:t.text});for(const c of t.toolCalls??[]){let input:unknown={};try{input=JSON.parse(c.arguments||'{}');}catch{/* model sent invalid JSON */}push('assistant',{type:'tool_use',id:c.id,name:c.name,input});}}
  else push('user',{type:'tool_result',tool_use_id:t.toolCallId,content:t.text??''});
 }
 return out;
}
export function anthropicBody(req:InferenceRequest){
 return {model:req.model,max_tokens:4096,system:req.system,messages:toAnthropicMessages(req.turns),tools:req.tools.map(t=>({name:t.name,description:t.description,input_schema:t.parameters})),stream:true};
}
export async function* streamAnthropic(res:Response,signal?:AbortSignal):AsyncGenerator<ProviderEvent>{
 if(!res.ok||!res.body){yield await errorFrom(res);return;}
 const tools=new Map<number,{id:string;name:string;json:string}>();let stopped=false;
 try{
  for await(const ev of sseEvents(res.body,signal)){
   let j:Record<string,unknown>;try{j=JSON.parse(ev.data);}catch{continue;}
   const type=String(j.type??ev.event),index=Number(j.index??-1);
   if(type==='content_block_start'){const b=j.content_block as {type?:string;id?:string;name?:string};if(b?.type==='tool_use')tools.set(index,{id:b.id??crypto.randomUUID(),name:b.name??'',json:''});}
   else if(type==='content_block_delta'){const d=j.delta as {type?:string;text?:string;partial_json?:string};if(d?.type==='text_delta'&&d.text)yield {type:'text',delta:d.text};else if(d?.type==='input_json_delta'&&tools.has(index))tools.get(index)!.json+=d.partial_json??'';}
   else if(type==='content_block_stop'&&tools.has(index)){const t=tools.get(index)!;tools.delete(index);yield {type:'tool_call',id:t.id,name:t.name,arguments:t.json||'{}'};}
   else if(type==='message_stop'){stopped=true;break;}
   else if(type==='error'){const e=j.error as {type?:string;message?:string};yield mapProviderError(e?.type==='overloaded_error'?529:e?.type==='rate_limit_error'?429:500,e?.type,e?.message??'provider error');return;}
  }
 }catch{yield {type:'error',code:'provider_stream_interrupted',retryable:true,message:'The provider stream was interrupted.'};return;}
 if(!stopped){yield {type:'error',code:'provider_stream_interrupted',retryable:true,message:'The provider stream ended before completion.'};return;}
 yield {type:'done'};
}
const anthropic:Provider={
 id:'anthropic',
 status(env,_u,cred){
  const base={id:'anthropic' as const,label:'Anthropic API (your key)',mode:'byok' as const,billing:'user_api_account' as const,egressHost:ANTHROPIC_HOST,supportsImages:false,models:cred?.models??[],credentialConfigured:!!cred?.configured};
  if(!byokEnabled(env,'anthropic'))return {...base,state:'disabled_by_operator',reason:'The workspace operator has not enabled bring-your-own-key Anthropic access.'};
  return cred?.configured?{...base,state:'available',defaultModel:cred.models[0]?.id}:{...base,state:'needs_credentials',reason:'Add your own Anthropic API key. Usage is billed to your Anthropic API account. A Claude subscription is used through Claude’s own apps connected via MCP, not here.'};
 },
 async *stream(_env,req,secret){
  if(!secret){yield {type:'error',code:'provider_auth_failed',retryable:false,message:'No API key configured.'};return;}
  let res:Response;try{res=await egress(ANTHROPIC_MESSAGES,{method:'POST',headers:{'x-api-key':secret,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify(anthropicBody(req)),signal:req.signal},ANTHROPIC_HOST);}
  catch{yield {type:'error',code:'provider_unavailable',retryable:true,message:'Could not reach the provider.'};return;}
  yield* streamAnthropic(res,req.signal);
 },
};

/** Validate a BYOK key by listing models (the only call made at save time). */
export async function discoverModels(id:'openai'|'anthropic',secret:string):Promise<ProviderModel[]|{error:AssistantErrorCode;status:number}>{
 const res=id==='openai'
  ?await egress(OPENAI_MODELS,{headers:{authorization:`Bearer ${secret}`}},OPENAI_HOST).catch(()=>null)
  :await egress(ANTHROPIC_MODELS,{headers:{'x-api-key':secret,'anthropic-version':'2023-06-01'}},ANTHROPIC_HOST).catch(()=>null);
 if(!res)return {error:'provider_unavailable',status:0};
 if(!res.ok)return {error:res.status===401||res.status===403?'provider_auth_failed':'provider_unavailable',status:res.status};
 const j=await res.json().catch(()=>({})) as {data?:{id:string;display_name?:string}[]};
 const rows=(j.data??[]).filter(m=>typeof m.id==='string');
 const usable=id==='openai'?rows.filter(m=>/^(gpt|o\d|chatgpt)/i.test(m.id)&&!/(embedding|audio|realtime|tts|transcribe|image|moderation|search)/i.test(m.id)):rows;
 return usable.slice(0,40).map(m=>({id:m.id,label:m.display_name??m.id}));
}

/* ---------- Cloudflare Workers AI (operator budget) ---------- */
const workersAi:Provider={
 id:'workers-ai',
 status(env){
  const base={id:'workers-ai' as const,label:'Cloudflare Workers AI',mode:'workers-ai' as const,billing:'operator_budget' as const,egressHost:'Cloudflare Workers AI (this account)',supportsImages:false,models:env.AI_CHAT_MODEL?[{id:env.AI_CHAT_MODEL,label:env.AI_CHAT_MODEL}]:[]};
  if(env.AI_PROVIDER!=='workers-ai'||!env.AI_CHAT_MODEL||!(Number(env.AI_DAILY_UNITS)>0)||!env.AI)return {...base,state:'disabled_by_operator',reason:'Built-in AI is off. The operator must set AI_PROVIDER=workers-ai, AI_CHAT_MODEL and a daily budget.'};
  return {...base,state:'available',defaultModel:env.AI_CHAT_MODEL};
 },
 async *stream(env,req){
  const prompt=JSON.stringify(req.turns).length+req.system.length,units=Math.ceil(prompt*1.1)+2048;
  if(!(await reserveAi(env,'chat',units,false,req.userId))){yield {type:'error',code:'budget_exhausted',retryable:false,message:'The workspace AI budget for today is used up. No other provider was used.'};return;}
  const messages=[{role:'system',content:req.system},...req.turns.map(t=>t.role==='tool'?{role:'tool',content:t.text??'',tool_call_id:t.toolCallId,name:t.name}:t.role==='assistant'?{role:'assistant',content:t.text??'',...(t.toolCalls?.length?{tool_calls:t.toolCalls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:c.arguments}}))}:{})}:{role:'user',content:t.text??''})];
  let out:{response?:string;tool_calls?:{id?:string;name?:string;arguments?:unknown;function?:{name?:string;arguments?:unknown}}[]};
  try{out=await (env.AI as unknown as {run(m:string,i:unknown):Promise<typeof out>}).run(env.AI_CHAT_MODEL!,{messages,tools:req.tools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}}))});}
  catch{yield {type:'error',code:'provider_unavailable',retryable:true,message:'Workers AI request failed.'};return;}
  if(typeof out?.response==='string'&&out.response)yield {type:'text',delta:out.response};
  for(const c of out?.tool_calls??[]){const name=c.name??c.function?.name;const args=c.arguments??c.function?.arguments;if(name)yield {type:'tool_call',id:c.id??crypto.randomUUID(),name,arguments:typeof args==='string'?args:JSON.stringify(args??{})};}
  yield {type:'done'};
 },
};

/* ---------- Simulated (deterministic tests only) ---------- */
const simulated:Provider={
 id:'simulated',
 status(env){
  const base={id:'simulated' as const,label:'Simulated provider (test fixture)',mode:'simulated' as const,billing:'none' as const,supportsImages:false,models:[{id:'sim-1',label:'Simulated model'}]};
  return simulatedEnabled(env)?{...base,state:'available',defaultModel:'sim-1'}:{...base,state:'unavailable',reason:'Test fixture only.'};
 },
 async *stream(env,req){
  if(!simulatedEnabled(env)){yield {type:'error',code:'provider_unavailable',retryable:false,message:'Simulated provider is disabled.'};return;}
  yield* simulate(req);
 },
};
/** Deterministic script. Directives in the latest user text:
 *  `/tool <name> <json>`  → one tool call; `/fail <code>` → provider error;
 *  `/interrupt` → partial text then interruption. Otherwise it answers from
 *  the context/tool results it was given, citing source IDs in [brackets]. */
export async function* simulate(req:InferenceRequest):AsyncGenerator<ProviderEvent>{
 const last=req.turns[req.turns.length-1],lastUser=[...req.turns].reverse().find(t=>t.role==='user')?.text??'';
 if(last?.role==='user'){
  const tool=/^\/tool\s+([a-z_]+)[ \t]*([^\n]*)$/m.exec(lastUser);
  if(tool){yield {type:'text',delta:`Using ${tool[1]}.`};yield {type:'tool_call',id:'sim_'+crypto.randomUUID().slice(0,8),name:tool[1],arguments:tool[2].trim()||'{}'};yield {type:'done'};return;}
  const fail=/^\/fail\s+([a-z_]+)/m.exec(lastUser);
  if(fail){yield mapProviderError(fail[1]==='subscription_sharing_usage_limit_exceeded'||fail[1]==='insufficient_quota'?429:500,fail[1],'Simulated provider failure');return;}
  if(/^\/interrupt/m.test(lastUser)){yield {type:'text',delta:'Partial answer'};yield {type:'error',code:'provider_stream_interrupted',retryable:true,message:'Simulated interruption.'};return;}
 }
 const evidence=req.turns.filter(t=>t.role==='tool'||(t.role==='user'&&t.text?.includes('<workspace_context'))).map(t=>t.text??'').join('\n');
 const ids=[...new Set([...evidence.matchAll(/"(?:id|recordId|pageId|docId)":"([A-Za-z0-9_-]{2,64})"/g)].map(m=>m[1]))].slice(0,5);
 const rewrite=/<selection>([\s\S]*?)<\/selection>/.exec(evidence);
 const text=rewrite&&/rewrite|shorten|expand|tone|translate|summarize/i.test(lastUser)
  ?`Rewritten: ${rewrite[1].trim()}`
  :ids.length?`Based on the authorized sources ${ids.map(i=>`[${i}]`).join(' ')}, here is a summary of what I found.`:'I could not find authorized sources for that. Attach a page or record, or ask me to search.';
 for(const part of text.match(/.{1,24}/gs)??[])yield {type:'text',delta:part};
 yield {type:'done'};
}

export const PROVIDERS:Record<ProviderId,Provider>={simulated,'workers-ai':workersAi,openai,anthropic,'chatgpt-hosted':chatgptHosted};
export const PROVIDER_ORDER:ProviderId[]=['workers-ai','openai','anthropic','chatgpt-hosted','simulated'];
