// Provider protocol adapters against recorded-shape streams (no network).
// These are contract tests, not real-provider acceptance.
import {afterEach,describe,expect,it,vi} from 'vitest';
import {sseEvents,streamResponses,streamAnthropic,responsesBody,RESPONSES_FORBIDDEN,mapProviderError,toAnthropicMessages,PROVIDERS,discoverModels,type ProviderEvent} from '../worker/assistant/providers';

afterEach(()=>vi.restoreAllMocks());
const stream=(chunks:string[])=>new ReadableStream<Uint8Array>({start(c){for(const s of chunks)c.enqueue(new TextEncoder().encode(s));c.close();}});
const sse=(events:object[])=>events.map(e=>`event: ${(e as {type:string}).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const collect=async(g:AsyncGenerator<ProviderEvent>)=>{const out:ProviderEvent[]=[];for await(const e of g)out.push(e);return out;};
const res=(body:string,status=200)=>new Response(stream([body.slice(0,7),body.slice(7,40),body.slice(40)]),{status,headers:{'content-type':'text/event-stream'}});

describe('SSE parsing',()=>{
 it('reassembles events split across arbitrary chunk boundaries and ignores comments',async()=>{
  const out=[];for await(const e of sseEvents(stream([': ping\nev','ent: a\nda','ta: {"x":1}\n','\ndata: two\ndata: lines\n\n'])))out.push(e);
  expect(out).toEqual([{event:'a',data:'{"x":1}'},{event:'',data:'two\nlines'}]);
 });
});
describe('OpenAI Responses adapter',()=>{
 const req={model:'m',system:'sys',turns:[{role:'user' as const,text:'hi'},{role:'assistant' as const,text:'',toolCalls:[{id:'c1',name:'search',arguments:'{}'}]},{role:'tool' as const,toolCallId:'c1',text:'r'}],tools:[{name:'search',description:'d',parameters:{type:'object'}}],userId:'u'};
 it('sends store:false, stream:true, explicit history and none of the plan-route forbidden fields',()=>{
  const b=responsesBody(req) as Record<string,unknown>;
  expect(b).toMatchObject({store:false,stream:true,instructions:'sys'});
  for(const f of RESPONSES_FORBIDDEN)expect(b).not.toHaveProperty(f);
  expect(JSON.stringify(b.input)).not.toContain('"role":"system"');
  expect(b.input).toEqual([{role:'user',content:'hi'},{type:'function_call',call_id:'c1',name:'search',arguments:'{}'},{type:'function_call_output',call_id:'c1',output:'r'}]);
 });
 it('streams text and function calls and succeeds only on response.completed',async()=>{
  const ok=await collect(streamResponses(res(sse([{type:'response.output_text.delta',delta:'Hel'},{type:'response.output_text.delta',delta:'lo'},{type:'response.output_item.done',item:{type:'function_call',call_id:'c9',name:'search',arguments:'{"q":"x"}'}},{type:'response.completed'}]))));
  expect(ok).toEqual([{type:'text',delta:'Hel'},{type:'text',delta:'lo'},{type:'tool_call',id:'c9',name:'search',arguments:'{"q":"x"}'},{type:'done'}]);
  const cut=await collect(streamResponses(res(sse([{type:'response.output_text.delta',delta:'Hel'}]))));
  expect(cut.at(-1)).toMatchObject({type:'error',code:'provider_stream_interrupted'});
 });
 it('maps ChatGPT-plan usage exhaustion arriving mid-stream to a non-retryable usage-limit error',async()=>{
  const out=await collect(streamResponses(res(sse([{type:'response.output_text.delta',delta:'a'},{type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded',message:'limit'}}}]))));
  expect(out.at(-1)).toMatchObject({type:'error',code:'provider_usage_limit',retryable:false,providerCode:'subscription_sharing_usage_limit_exceeded'});
 });
 it.each([[403,'subscription_sharing_user_not_eligible','provider_not_eligible',false],[503,'subscription_sharing_usage_unavailable','provider_unavailable',true],[400,'subscription_sharing_unsupported_capability','provider_unsupported_capability',false],[401,'subscription_sharing_invalid_user','provider_auth_failed',false],[429,'insufficient_quota','provider_usage_limit',false],[503,undefined,'provider_unavailable',true]])('maps %i %s',(status,code,expected,retryable)=>{
  expect(mapProviderError(status,code,'m')).toMatchObject({code:expected,retryable});
 });
 it('treats response.incomplete as failure and pre-stream {detail} bodies as errors',async()=>{
  expect((await collect(streamResponses(res(sse([{type:'response.incomplete'}]))))).at(-1)).toMatchObject({code:'provider_failed'});
  expect(await collect(streamResponses(new Response('{"detail":"region"}',{status:403})))).toEqual([expect.objectContaining({code:'provider_auth_failed',status:403})]);
 });
 it('only egresses to api.openai.com with redirects refused',async()=>{
  const spy=vi.spyOn(globalThis,'fetch').mockResolvedValue(res(sse([{type:'response.completed'}])));
  await collect(PROVIDERS.openai.stream({} as never,req,'sk-test'));
  const [url,init]=spy.mock.calls[0];expect(String(url)).toBe('https://api.openai.com/v1/responses');expect((init as RequestInit).redirect).toBe('error');
 });
});
describe('Anthropic Messages adapter',()=>{
 it('assembles streamed tool_use input JSON and requires message_stop',async()=>{
  const ok=await collect(streamAnthropic(res(sse([{type:'content_block_start',index:0,content_block:{type:'text'}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Hi'}},{type:'content_block_start',index:1,content_block:{type:'tool_use',id:'t1',name:'search'}},{type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"q":'}},{type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'"x"}'}},{type:'content_block_stop',index:1},{type:'message_stop'}]))));
  expect(ok).toEqual([{type:'text',delta:'Hi'},{type:'tool_call',id:'t1',name:'search',arguments:'{"q":"x"}'},{type:'done'}]);
  expect((await collect(streamAnthropic(res(sse([{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'x'}}]))))).at(-1)).toMatchObject({code:'provider_stream_interrupted'});
 });
 it('pairs tool results with tool_use ids in alternating turns',()=>{
  expect(toAnthropicMessages([{role:'user',text:'q'},{role:'assistant',text:'t',toolCalls:[{id:'a',name:'s',arguments:'{"x":1}'}]},{role:'tool',toolCallId:'a',text:'r'}])).toEqual([{role:'user',content:[{type:'text',text:'q'}]},{role:'assistant',content:[{type:'text',text:'t'},{type:'tool_use',id:'a',name:'s',input:{x:1}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'a',content:'r'}]}]);
 });
});
describe('provider eligibility',()=>{
 it('keeps every provider off by default and hosted ChatGPT behind OpenAI approval',()=>{
  const env={} as never;
  expect(PROVIDERS['workers-ai'].status(env,'u',null).state).toBe('disabled_by_operator');
  expect(PROVIDERS.openai.status(env,'u',null).state).toBe('disabled_by_operator');
  expect(PROVIDERS.anthropic.status(env,'u',null).state).toBe('disabled_by_operator');
  expect(PROVIDERS['chatgpt-hosted'].status(env,'u',null).state).toBe('requires_provider_approval');
  expect(PROVIDERS.simulated.status(env,'u',null).state).toBe('unavailable');
  expect(PROVIDERS.simulated.status({WORKSPACE_ENV:'production'} as never,'u',null).state).toBe('unavailable');
 });
 it('validates a BYOK key only by listing models and keeps chat models',async()=>{
  vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({data:[{id:'gpt-x'},{id:'text-embedding-3'},{id:'whisper-1'}]})));
  expect(await discoverModels('openai','sk-abc')).toEqual([{id:'gpt-x',label:'gpt-x'}]);
  vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}',{status:401}));
  expect(await discoverModels('anthropic','bad')).toMatchObject({error:'provider_auth_failed'});
 });
});
