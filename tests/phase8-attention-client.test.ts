import {describe,it,expect,vi} from 'vitest';
import {createAttentionCache,validAttentionPage,type AttentionContext} from '../src/core/attentionCache';
import type {AttentionPage} from '../shared/attention';
const page=(asOf=100):AttentionPage=>({items:[{key:'record_due_today:r',kind:'record_due_today',targetType:'record',targetId:'r',title:'Current source',url:'/boards/b/tasks/r',severity:1,actions:['open']}],nextCursor:null,partial:false,partialSources:[],asOf,today:'2026-10-27',urgentCount:0,quietDigest:false});
const deferred=<T,>()=>{let resolve!:(value:T)=>void,reject!:(value:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(){
 let ctx:AttentionContext|null={userId:'alice',token:'secret-a',access:'scoped:v1',epoch:1},online=true;
 const read=vi.fn().mockResolvedValue(undefined),save=vi.fn().mockResolvedValue(undefined),request=vi.fn().mockResolvedValue(page()),hash=vi.fn(async (t:string)=>`hash:${t}`);
 const cache=createAttentionCache({context:()=>ctx,online:()=>online,read,save,request,hash});
 const snapshot=(p=page())=>({version:1,userId:'alice',sessionHash:'hash:secret-a',access:'scoped:v1',page:p});
 return {...cache,read,save,request,snapshot,setContext:(v:AttentionContext|null)=>ctx=v,setOnline:(v:boolean)=>online=v};
}
describe('attention snapshot ownership and race fencing',()=>{
 it('caches online data using a session hash and reuses only its own offline snapshot',async()=>{
  const f=fixture();await f.refresh();expect(f.store.get()).toMatchObject({page:page(),stale:false,offline:false});expect(f.save).toHaveBeenCalledWith('alice',f.snapshot());
  f.clear();f.setOnline(false);f.read.mockResolvedValue(f.snapshot());await f.refresh();expect(f.store.get()).toMatchObject({page:page(),stale:true,offline:true});expect(f.request).toHaveBeenCalledTimes(1);
 });
 it.each(['account','token','access','epoch','locked'])('discards delayed network and cache results after %s changes',async change=>{
  const f=fixture(),network=deferred<unknown>(),local=deferred<unknown>();f.request.mockReturnValue(network.promise);f.read.mockReturnValue(local.promise);const pending=f.refresh();await Promise.resolve();await Promise.resolve();
  const c={userId:'alice',token:'secret-a',access:'scoped:v1',epoch:1};if(change==='account')c.userId='bob';if(change==='token')c.token='secret-b';if(change==='access')c.access='scoped:v2';if(change==='epoch')c.epoch=2;f.setContext(change==='locked'?null:c);
  local.resolve(f.snapshot());network.resolve(page());await pending;expect(f.store.get().page).toBeNull();expect(f.save).not.toHaveBeenCalled();
 });
 it.each(['userId','sessionHash','access','version'])('rejects a cached snapshot with another %s',async key=>{
  const f=fixture();f.setOnline(false);f.read.mockResolvedValue({...f.snapshot(),[key]:'other'});await f.refresh();expect(f.store.get().page).toBeNull();
 });
 it('prevents a slow old cache from replacing a newer online result',async()=>{
  const f=fixture(),local=deferred<unknown>();f.read.mockReturnValue(local.promise);f.request.mockResolvedValue(page(200));await f.refresh();local.resolve(f.snapshot(page(50)));await Promise.resolve();expect(f.store.get().page?.asOf).toBe(200);
 });
 it.each([401,403,409])('clears cached content on authority failure %s, including a delayed cache read',async status=>{
  const f=fixture(),local=deferred<unknown>();f.read.mockReturnValue(local.promise);f.request.mockRejectedValue({status});await f.refresh();local.resolve(f.snapshot());await Promise.resolve();expect(f.store.get().page).toBeNull();expect(f.store.get().error).toContain('Access changed');
 });
 it('retains a labelled snapshot on temporary server failure and refreshes after reconnect',async()=>{
  const f=fixture();f.read.mockResolvedValue(f.snapshot());f.request.mockRejectedValue(new Error('outage'));await f.refresh();expect(f.store.get()).toMatchObject({page:page(),stale:true,error:expect.any(String)});
  f.request.mockResolvedValue(page(200));await f.refresh();expect(f.store.get()).toMatchObject({page:page(200),stale:false,error:null});
 });
 it('keeps the online result when cache persistence fails',async()=>{
  const f=fixture();f.save.mockRejectedValue(new Error('quota'));await f.refresh();expect(f.store.get()).toMatchObject({page:page(),cacheError:true,error:null});
 });
 it('deduplicates active reads and discards cleared lifecycle work',async()=>{
  const f=fixture(),p=deferred<unknown>();f.request.mockReturnValue(p.promise);const a=f.refresh(),b=f.refresh();expect(a).toBe(b);await Promise.resolve();f.clear();p.resolve(page());await a;expect(f.store.get().page).toBeNull();expect(f.save).not.toHaveBeenCalled();
 });
 it('does not perform an offline request without a snapshot',async()=>{
  const f=fixture();f.setOnline(false);await f.refresh();expect(f.request).not.toHaveBeenCalled();expect(f.store.get()).toMatchObject({page:null,loading:false,offline:true});
 });
});
describe('bounded attention presentation',()=>{
 it.each(['//evil.test','https://evil.test','/\\evil.test','/bad path'])('refuses unsafe navigation %s',url=>{const p=page();p.items[0].url=url;expect(validAttentionPage(p)).toBe(false);});
 it('refuses duplicated, oversized, malformed and unredacted restricted snapshots',()=>{
  const p=page();expect(validAttentionPage(p)).toBe(true);expect(validAttentionPage({...p,items:[...p.items,...p.items]})).toBe(false);expect(validAttentionPage({...p,items:Array(51).fill(p.items[0])})).toBe(false);
  expect(validAttentionPage({...p,items:[{...p.items[0],restricted:true}]})).toBe(false);expect(validAttentionPage({...p,today:'2026-02-30'})).toBe(false);expect(validAttentionPage({...p,asOf:NaN})).toBe(false);
 });
});
