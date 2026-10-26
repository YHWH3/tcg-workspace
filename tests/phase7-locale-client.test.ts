import {afterEach,beforeEach,it,expect,vi} from 'vitest';
const mock=vi.hoisted(()=>({uid:'alice',token:'token-a',name:'workspace-alice',read:vi.fn(),put:vi.fn(),fetch:vi.fn()}));
vi.mock('../src/core/auth',()=>({authStore:{get:()=>({user:{id:mock.uid}})}}));
vi.mock('../src/core/api',()=>({getToken:()=>mock.token,api:(...a:unknown[])=>mock.fetch(...a)}));
vi.mock('../src/core/db',()=>({db:{get name(){return mock.name;},meta:{get:(...a:unknown[])=>mock.read(...a),put:(...a:unknown[])=>mock.put(...a)}}}));
import {startWorkspaceSettings,refreshWorkspaceSettings,saveWorkspaceSettings} from '../src/core/workspaceSettings';
import {workspaceLocale,tickWorkspaceDay} from '../src/core/workspaceLocale';
const settings={timeZone:'Asia/Kolkata',currency:'INR',weekStart:1,version:2,updatedAt:1};
const deferred=()=>{let resolve!:(value:any)=>void;const promise=new Promise<any>(r=>resolve=r);return {promise,resolve};};
let cleanups:(()=>void)[]=[];
beforeEach(()=>{mock.uid='alice';mock.token='token-a';mock.name='workspace-alice';mock.read.mockReset();mock.put.mockReset();mock.fetch.mockReset();vi.stubGlobal('window',new EventTarget());vi.stubGlobal('document',Object.assign(new EventTarget(),{visibilityState:'visible'}));vi.stubGlobal('navigator',{onLine:true});});
afterEach(()=>{for(const c of cleanups)c();cleanups=[];vi.unstubAllGlobals();vi.restoreAllMocks();});
it('rejects a delayed response and cached preferences from another account',async()=>{
 const a=deferred(),b=deferred(),cacheA=deferred();mock.fetch.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);mock.read.mockReturnValueOnce(cacheA.promise).mockResolvedValueOnce(undefined);
 cleanups.push(startWorkspaceSettings());
 mock.uid='bob';mock.token='token-b';mock.name='workspace-bob';cleanups.push(startWorkspaceSettings());
 a.resolve({settings:{...settings,currency:'USD'},canEdit:true});cacheA.resolve({value:{accountId:'alice',settings,canEdit:true}});await Promise.resolve();await Promise.resolve();
 expect(workspaceLocale.get().settings).toBeNull();expect(mock.put).not.toHaveBeenCalled();
 b.resolve({settings,canEdit:false});await refreshWorkspaceSettings();
 expect(workspaceLocale.get()).toMatchObject({settings,canEdit:false,offline:false});expect(mock.put).toHaveBeenCalledWith({key:'workspaceSettings',value:{accountId:'bob',settings,canEdit:false}});
});
it('opens with its own cached settings offline and refreshes after reconnect',async()=>{
 vi.stubGlobal('navigator',{onLine:false});mock.read.mockResolvedValue({value:{accountId:'alice',settings,canEdit:true}});mock.fetch.mockRejectedValue(new Error('offline'));
 cleanups.push(startWorkspaceSettings());await refreshWorkspaceSettings();await Promise.resolve();
 expect(workspaceLocale.get()).toMatchObject({settings,offline:true,loading:false});
 vi.stubGlobal('navigator',{onLine:true});mock.fetch.mockResolvedValue({settings:{...settings,version:3,currency:'EUR'},canEdit:true});await refreshWorkspaceSettings();
 expect(workspaceLocale.get()).toMatchObject({settings:{version:3,currency:'EUR'},offline:false});
});
it('discards a late response after the session token changes',async()=>{
 const response=deferred();mock.read.mockResolvedValue(undefined);mock.fetch.mockReturnValue(response.promise);cleanups.push(startWorkspaceSettings());
 mock.token='new-token';response.resolve({settings,canEdit:true});await response.promise;await Promise.resolve();
 expect(workspaceLocale.get().settings).toBeNull();expect(mock.put).not.toHaveBeenCalled();
});

it('updates its reactive civil day across midnight and a timezone change',()=>{
 workspaceLocale.set(s=>({...s,settings,today:'2026-10-24'}));
 const now=vi.spyOn(Date,'now').mockReturnValue(Date.parse('2026-10-24T18:29:59Z'));tickWorkspaceDay();expect(workspaceLocale.get().today).toBe('2026-10-24');
 now.mockReturnValue(Date.parse('2026-10-24T18:30:00Z'));tickWorkspaceDay();expect(workspaceLocale.get().today).toBe('2026-10-25');
 workspaceLocale.set(s=>({...s,settings:{...settings,timeZone:'UTC'}}));tickWorkspaceDay();expect(workspaceLocale.get().today).toBe('2026-10-24');
});

it('persists the successful save even when an older settings read is still pending',async()=>{
 const oldRead=deferred(),saved={...settings,version:3,currency:'EUR'};
 mock.read.mockResolvedValue({value:{accountId:'alice',settings,canEdit:true}});
 mock.fetch.mockImplementation((_path:string,options?:{method?:string})=>options?.method==='PUT'?Promise.resolve({settings:saved}):oldRead.promise);
 cleanups.push(startWorkspaceSettings());await Promise.resolve();await Promise.resolve();
 const save=saveWorkspaceSettings({...settings,currency:'EUR'});await Promise.resolve();await Promise.resolve();
 oldRead.resolve({settings,canEdit:true});await save;
 expect(workspaceLocale.get().settings).toEqual(saved);
 expect(mock.put).toHaveBeenCalledWith({key:'workspaceSettings',value:{accountId:'alice',settings:saved,canEdit:true}});
});
it('keeps the online server result when local cache persistence fails',async()=>{
 mock.read.mockResolvedValue(undefined);mock.put.mockRejectedValue(new Error('quota'));mock.fetch.mockResolvedValue({settings,canEdit:true});
 cleanups.push(startWorkspaceSettings());await refreshWorkspaceSettings();
 expect(workspaceLocale.get()).toMatchObject({settings,offline:false,error:null,cacheError:true});
});
