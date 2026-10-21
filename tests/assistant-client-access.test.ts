// Real assistant store helpers with controlled transport/access stores. No model calls.
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({token:'token-a',api:vi.fn(),stream:vi.fn(),cancel:vi.fn()}));
vi.mock('../src/core/api',()=>({api:mocks.api,getToken:()=>mocks.token,ApiError:class extends Error{constructor(public status:number,message:string,public body?:unknown){super(message);}}}));
vi.mock('../src/core/auth',async()=>{const {createStore}=await import('../src/core/store');return {authStore:createStore({status:'authed',user:{id:'a',name:'A'}})};});
vi.mock('../src/core/accessClient',async()=>{const {createStore}=await import('../src/core/store');return {accessClientStore:createStore({status:'ready',epoch:1,manifest:{protocol:1,userId:'a'},reason:null})};});
vi.mock('../src/core/assistant/client',()=>({streamRun:mocks.stream,cancelRun:mocks.cancel}));
vi.mock('../src/core/assistant/applyPlan',()=>({canTargetSelection:()=>true}));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
let client:typeof import('../src/core/assistant/store');
let access:typeof import('../src/core/accessClient')['accessClientStore'];
let auth:typeof import('../src/core/auth')['authStore'];
beforeEach(async()=>{
 vi.resetModules();vi.clearAllMocks();mocks.token='token-a';vi.stubGlobal('navigator',{onLine:true});
 const saved=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(k:string)=>saved.get(k)??null,setItem:(k:string,v:string)=>saved.set(k,v),removeItem:(k:string)=>saved.delete(k)});
 auth=(await import('../src/core/auth')).authStore;access=(await import('../src/core/accessClient')).accessClientStore;
 client=await import('../src/core/assistant/store');
});
afterEach(()=>vi.unstubAllGlobals());
const message={id:'secret-reply',role:'assistant' as const,text:'CLIENT_PRIVATE_CANARY',createdAt:1};
const ready=()=>access.set(s=>({...s,status:'ready'}));
const revoke=()=>access.set(s=>({...s,status:'checking',epoch:s.epoch+1,reason:'permissions_changed'}));
describe('assistant access lifecycle',()=>{
 it('clears retained replies and sensitive controls before a permission barrier remount',()=>{
  client.assistantStore.set(s=>({...s,mode:'panel',conversationId:'private-chat',messages:[message],attached:[{kind:'selection',pageId:'secret',blockId:'secret-b',text:'CLIENT_PRIVATE_SELECTION'}],draft:'Derived rewrite',actionId:'selection_rewrite',approvals:{private:{phase:'executed',changesetId:'cs-secret'}},applyTargets:{[message.id]:{pageId:'secret',blockId:'secret-b',text:'CLIENT_PRIVATE_SELECTION',actionId:'selection_rewrite'}}}));
  client.setAssistantContext({kind:'page',id:'secret'});client.setAssistantSelection({kind:'selection',pageId:'secret',text:'CLIENT_PRIVATE_SELECTION'});
  revoke();ready();
  const state=client.assistantStore.get();expect(state.messages).toEqual([]);expect(state.attached).toEqual([]);expect(state.approvals).toEqual({});expect(state.applyTargets).toEqual({});expect(state.draft).toBe('');expect(client.assistantContextStore.get()).toBeNull();expect(client.assistantSelectionStore.get()).toBeNull();
 });
 it('cannot refill the cache with a conversation response from an earlier access epoch',async()=>{
  const response=deferred<unknown>();mocks.api.mockReturnValue(response.promise);
  const loading=client.openConversation('private-chat');revoke();ready();
  response.resolve({id:'private-chat',title:'Private title',messages:[message],activeRun:null});await loading;
  expect(client.assistantStore.get().messages).toEqual([]);expect(client.assistantStore.get().title).toBe('');
 });
 it('preserves only a plain owned composer draft while a permission check is pending',()=>{
  client.setDraft('My unsent original question');revoke();
  expect(client.assistantStore.get().draft).toBe('My unsent original question');expect(client.canSend()).toBe(false);
  ready();expect(client.assistantStore.get().draft).toBe('My unsent original question');
 });
 it('drops a stale conversation list when a session token changes without an account change',async()=>{
  const response=deferred<unknown>();mocks.api.mockReturnValue(response.promise);
  const loading=client.loadConversations();mocks.token='token-b';auth.set(s=>({...s}));
  response.resolve({conversations:[{id:'old',title:'CLIENT_PRIVATE_CANARY'}]});await loading;
  expect(client.assistantStore.get().conversations).toBeNull();
 });
 it('rejects old stream events and aborts the reader when access changes',async()=>{
  const stopped=deferred<import('../src/core/assistant/client').RunOutcome>();let opts!:import('../src/core/assistant/client').StreamOptions;
  mocks.stream.mockImplementation((_req,o)=>{opts=o;return stopped.promise;});
  client.assistantStore.set(s=>({...s,conversationId:'existing',draft:'Question',provider:'simulated',providers:[{id:'simulated',state:'available',models:[],billing:'none'} as never],providersState:'ready'}));
  const sent=client.sendMessage();expect(opts.signal.aborted).toBe(false);revoke();ready();expect(opts.signal.aborted).toBe(true);
  opts.onEvent({type:'text',messageId:'late',delta:'CLIENT_PRIVATE_CANARY'});stopped.resolve({kind:'done',runId:'old-run'});await sent;
  expect(client.assistantStore.get().messages).toEqual([]);expect(client.assistantStore.get().streaming).toBe(false);
 });
 it('does not execute an approval after the authorization fence changes while approval is in flight',async()=>{
  const response=deferred<unknown>();mocks.api.mockReturnValue(response.promise);
  const approval={previewId:'preview',argsHash:'a'.repeat(64),reviewUrl:'/ai/review/preview',tool:'create_page'};
  const pending=client.approveAndExecute(approval);revoke();ready();response.resolve({ok:true});await pending;
  expect(mocks.api).toHaveBeenCalledTimes(1);expect(client.assistantStore.get().approvals).toEqual({});
 });
 it('revalidates the same conversation after a permission epoch has discarded its cached messages',async()=>{
  client.assistantStore.set(s=>({...s,conversationId:'same',messages:[message]}));revoke();ready();
  mocks.api.mockResolvedValue({id:'same',title:'Current',messages:[{...message,text:'',redacted:true}],activeRun:null});
  await client.openConversation('same');expect(mocks.api).toHaveBeenCalledWith('/api/assistant/conversations/same');expect(client.assistantStore.get().messages[0].redacted).toBe(true);
 });

 it('finishes provider discovery when a new conversation cancels only the stream generation',async()=>{
  const response=deferred<unknown>();mocks.api.mockReturnValue(response.promise);
  const loading=client.ensureProviders();client.newConversation();response.resolve({providers:[{id:'simulated',state:'available',models:[],billing:'none'}],retentionDays:30});await loading;
  expect(client.assistantStore.get().providersState).toBe('ready');expect(client.assistantStore.get().provider).toBe('simulated');
 });

});
