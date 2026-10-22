/** /api/assistant — session-authenticated embedded assistant API (contract in
 * shared/assistantProtocol.ts). Streaming endpoints return SSE; every request is
 * one bounded runtime step. */
import {Hono} from 'hono';
import {streamSSE} from 'hono/streaming';
import {requireAuth,type Env,type AuthUser} from '../auth';
import type {AssistantEvent,ProviderId,ProviderStatus,CapabilityView} from '../../shared/assistantProtocol';
import {RETENTION_CHOICES} from '../../shared/assistantProtocol';
import {PROVIDERS,PROVIDER_ORDER,discoverModels,simulatedEnabled} from './providers';
import {credentialViews,deleteCredential,saveCredential} from './credentials';
import {activeRun,createConversation,deleteConversation,getConversation,listConversations,loadMessages,retentionDays,toView,visibleMessages} from './store';
import {cancelRun,continueRun,startRun,validateSend,type StepUser} from './runtime';
import {CAPABILITIES} from '../../shared/aiCapabilities';
import {hasWritableSpace} from '../capability';

type C={Bindings:Env;Variables:{user:AuthUser}};
export const assistantApi=new Hono<C>();
assistantApi.use('*',requireAuth);

async function stepUser(env:Env,u:AuthUser):Promise<StepUser>{
 const principal=await env.DB.prepare("SELECT COALESCE(workspace_role,role) principalRole,CASE WHEN COALESCE(workspace_role,role) IN('owner','admin') THEN 'admin' ELSE 'member' END r FROM users WHERE id=?").bind(u.id).first<{principalRole:string;r:string}>();
 return {id:u.id,role:principal?.r==='admin'?'admin':'member',principalRole:principal?.principalRole??'',tokenHash:u.tokenHash};
}
function sse(c:import('hono').Context<C>,run:(io:{emit(e:AssistantEvent):Promise<void>;signal:AbortSignal})=>Promise<unknown>){
 c.header('Cache-Control','no-store');
 return streamSSE(c,async stream=>{
  const ctrl=new AbortController();stream.onAbort(()=>ctrl.abort());
  const emit=async(e:AssistantEvent)=>{if(!ctrl.signal.aborted)await stream.writeSSE({data:JSON.stringify(e)});};
  try{await run({emit,signal:ctrl.signal});}
  catch(e){console.error(JSON.stringify({message:'assistant_step_failed',error:e instanceof Error?e.message:'unknown'}));await emit({type:'error',code:'internal',message:'The assistant step failed.',retryable:true});}
 });
}

assistantApi.get('/providers',async c=>{
 const u=c.get('user'),views=await credentialViews(c.env,u.id);
 const providers:ProviderStatus[]=PROVIDER_ORDER.filter(id=>id!=='simulated'||simulatedEnabled(c.env)).map(id=>PROVIDERS[id].status(c.env,u.id,views.get(id)??null));
 return c.json({providers,retentionDays:await retentionDays(c.env,u.id)});
});
assistantApi.put('/credentials/:provider',async c=>{
 const id=c.req.param('provider');if(id!=='openai'&&id!=='anthropic')return c.json({error:'unsupported provider'},400);
 const status=PROVIDERS[id].status(c.env,c.get('user').id,null);
 if(status.state==='disabled_by_operator')return c.json({error:status.reason},403);
 const body=await c.req.json<{apiKey?:unknown}>().catch(()=>null);
 const key=typeof body?.apiKey==='string'?body.apiKey.trim():'';
 if(key.length<20||key.length>400||/\s/.test(key))return c.json({error:'invalid key format'},400);
 const models=await discoverModels(id,key);
 if(!Array.isArray(models))return c.json({error:models.error==='provider_auth_failed'?'The provider rejected this key.':'The provider could not be reached.'},models.error==='provider_auth_failed'?400:502);
 if(!(await saveCredential(c.env,c.get('user').id,id,key,models)))return c.json({error:'credential storage is not configured'},503);
 return c.json({ok:true,models});
});
assistantApi.delete('/credentials/:provider',async c=>{await deleteCredential(c.env,c.get('user').id,c.req.param('provider'));return c.json({ok:true});});

assistantApi.get('/capabilities',async c=>{
 const writable=await hasWritableSpace(c.env.DB,c.get('user').id);
 const capabilities:CapabilityView[]=CAPABILITIES.map(x=>({id:x.id,module:x.module,kind:x.kind,description:`${x.kind}${x.embedded==='deny'?' · human-only':''}${x.kind!=='read'?' · requires your approval':''}`,available:x.embedded==='allow'&&(x.kind==='read'||writable)}));
 return c.json({capabilities});
});

assistantApi.get('/conversations',async c=>c.json({conversations:await listConversations(c.env,c.get('user').id)}));
assistantApi.post('/conversations',async c=>{const b=await c.req.json<{title?:unknown}>().catch(()=>({}));return c.json(await createConversation(c.env,c.get('user').id,typeof (b as {title?:unknown}).title==='string'?(b as {title:string}).title:undefined));});
assistantApi.delete('/conversations',async c=>c.json({ok:true,deleted:await deleteConversation(c.env,c.get('user').id)}));
assistantApi.get('/conversations/:id',async c=>{
 const u=c.get('user'),conv=await getConversation(c.env,u.id,c.req.param('id'));if(!conv)return c.json({error:'not found'},404);
 const {rows}=await visibleMessages(c.env,u.id,await loadMessages(c.env,conv.id,u.id));
 return c.json({id:conv.id,title:conv.title,provider:conv.provider,model:conv.model,createdAt:conv.created_at,updatedAt:conv.updated_at,expiresAt:conv.expires_at,messages:rows.map(toView),activeRun:await activeRun(c.env,conv.id,u.id)});
});
assistantApi.patch('/conversations/:id',async c=>{
 const b=await c.req.json<{title?:unknown}>().catch(()=>null);const t=typeof b?.title==='string'?b.title.trim().slice(0,120):'';if(!t)return c.json({error:'title required'},400);
 const r=await c.env.DB.prepare('UPDATE assistant_conversations SET title=? WHERE id=? AND user_id=?').bind(t,c.req.param('id'),c.get('user').id).run();
 return (r.meta.changes??0)?c.json({ok:true}):c.json({error:'not found'},404);
});
assistantApi.delete('/conversations/:id',async c=>(await deleteConversation(c.env,c.get('user').id,c.req.param('id')))?c.json({ok:true}):c.json({error:'not found'},404));

assistantApi.post('/conversations/:id/messages',async c=>{
 const body=validateSend(await c.req.json().catch(()=>null));if(typeof body==='string')return c.json({error:body},400);
 const user=await stepUser(c.env,c.get('user')),origin=new URL(c.req.url).origin;
 return sse(c,io=>startRun(c.env,user,c.req.param('id'),body,{...io,origin,ectx:c.executionCtx as unknown as ExecutionContext}));
});
assistantApi.post('/conversations/:id/regenerate',async c=>{
 const b=await c.req.json<{provider?:unknown;model?:unknown}>().catch(()=>null);
 if(typeof b?.provider!=='string'||!(b.provider in PROVIDERS))return c.json({error:'unknown provider'},400);
 const u=c.get('user'),id=c.req.param('id');if(!(await getConversation(c.env,u.id,id)))return c.json({error:'not found'},404);
 if(await activeRun(c.env,id,u.id))return c.json({error:'a reply is already in progress'},409);
 const last=await c.env.DB.prepare("SELECT MAX(seq) s,(SELECT content_json FROM assistant_messages WHERE conversation_id=? AND user_id=? AND role='user' ORDER BY seq DESC LIMIT 1) c FROM assistant_messages WHERE conversation_id=? AND user_id=? AND role='user'").bind(id,u.id,id,u.id).first<{s:number|null;c:string|null}>();
 if(!last?.s||!last.c)return c.json({error:'nothing to regenerate'},400);
 await c.env.DB.prepare('DELETE FROM assistant_messages WHERE conversation_id=? AND user_id=? AND seq>?').bind(id,u.id,last.s).run();
 const prior=JSON.parse(last.c) as {text:string;context?:unknown};
 const user=await stepUser(c.env,u),origin=new URL(c.req.url).origin;
 return sse(c,io=>startRun(c.env,user,id,{text:prior.text,provider:b.provider as ProviderId,model:typeof b.model==='string'?b.model:undefined},{...io,origin,ectx:c.executionCtx as unknown as ExecutionContext},{regenerate:true}));
});
assistantApi.post('/runs/:runId/continue',async c=>{
 const b=await c.req.json<{step?:unknown}>().catch(()=>null);
 const user=await stepUser(c.env,c.get('user')),origin=new URL(c.req.url).origin;
 return sse(c,io=>continueRun(c.env,user,c.req.param('runId'),Number(b?.step),{...io,origin,ectx:c.executionCtx as unknown as ExecutionContext}));
});
assistantApi.post('/runs/:runId/cancel',async c=>c.json({ok:await cancelRun(c.env,await stepUser(c.env,c.get('user')),c.req.param('runId'))}));
assistantApi.put('/settings',async c=>{
 const b=await c.req.json<{retentionDays?:unknown}>().catch(()=>null);const d=Number(b?.retentionDays);
 if(!(RETENTION_CHOICES as readonly number[]).includes(d))return c.json({error:'retentionDays must be 7, 30 or 90'},400);
 const u=c.get('user'),now=Date.now();
 await c.env.DB.batch([c.env.DB.prepare('INSERT INTO assistant_settings(user_id,retention_days,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET retention_days=excluded.retention_days,updated_at=excluded.updated_at').bind(u.id,d,now),
  c.env.DB.prepare('UPDATE assistant_conversations SET expires_at=updated_at+? WHERE user_id=?').bind(d*86_400_000,u.id)]);
 return c.json({ok:true});
});
