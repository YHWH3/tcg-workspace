import {it,expect,vi} from 'vitest';
import {createApprovalAttentionCache} from '../src/core/approvalAttentionCache';
import type {AttentionContext} from '../src/core/attentionCache';
import type {AttentionPage} from '../shared/attention';
const page=(databaseId='media'):AttentionPage=>({items:[{key:'approval_pending:a',kind:'approval_pending',targetType:'approval',targetId:'a',title:'Synthetic source',url:'/approvals',databaseId,severity:3,actions:['decide']}],nextCursor:null,partial:false,partialSources:[],asOf:100,today:'2026-10-31',urgentCount:1,quietDigest:false});
function fixture(databaseId='media'){
 let context:AttentionContext|null={userId:'alice',token:'test-session',access:'scope:v1',epoch:1},online=true;
 const read=vi.fn().mockResolvedValue(undefined),save=vi.fn().mockResolvedValue(undefined),request=vi.fn().mockResolvedValue(page(databaseId));
 const cache=createApprovalAttentionCache(databaseId,{context:()=>context,online:()=>online,read,save,request,hash:async()=> 'session-hash'});
 return {...cache,read,save,request,context:(next:AttentionContext|null)=>context=next,offline:()=>online=false};
}
it('persists a scope-bound session hash and reuses only its own approval database snapshot offline',async()=>{
 const media=fixture();await media.refresh();const snapshot=media.save.mock.calls[0][1];expect(snapshot).toMatchObject({userId:'alice',sessionHash:'session-hash',access:JSON.stringify(['scope:v1','approval_database','media'])});expect(JSON.stringify(snapshot)).not.toContain('test-session');
 media.clear();media.offline();media.read.mockResolvedValue(snapshot);await media.refresh();expect(media.store.get()).toMatchObject({page:page(),offline:true,stale:true});
 const other=fixture('other');other.offline();other.read.mockResolvedValue(snapshot);await other.refresh();expect(other.store.get().page).toBeNull();
});
it('rejects unrelated, restricted or nonapproval rows from cache and network even under a matching envelope',async()=>{
 for(const altered of [page('other'),{...page(),items:[{...page().items[0],restricted:true,title:'',url:null}]},{...page(),items:[{...page().items[0],kind:'mention_unread' as const}]}]){
  const f=fixture();await f.refresh();const snapshot=f.save.mock.calls[0][1];f.clear();f.offline();f.read.mockResolvedValue({...snapshot,page:altered});await f.refresh();expect(f.store.get().page).toBeNull();
  const network=fixture();network.request.mockResolvedValue(altered);await network.refresh();expect(network.store.get()).toMatchObject({page:null,error:expect.any(String)});expect(network.save).not.toHaveBeenCalled();
 }
});
it('discards a delayed approval read when account authority changes or its block is disposed',async()=>{
 for(const change of ['account','dispose']){
  const f=fixture();let resolve!:(value:AttentionPage)=>void;f.request.mockReturnValue(new Promise<AttentionPage>(done=>resolve=done));const pending=f.refresh();await Promise.resolve();await Promise.resolve();
  if(change==='account')f.context({userId:'bob',token:'new-session',access:'scope:v1',epoch:2});else f.clear();resolve(page());await pending;expect(f.store.get().page).toBeNull();expect(f.save).not.toHaveBeenCalled();
 }
});
