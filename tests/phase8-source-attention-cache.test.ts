import {it,expect,vi} from 'vitest';
import {createSourceAttentionCache} from '../src/core/sourceAttentionCache';
import type {AttentionPage} from '../shared/attention';
const page:AttentionPage={items:[{key:'suggestion_pending:s',kind:'suggestion_pending',targetType:'suggestion',targetId:'s',title:'Review source',url:'/ai?view=review#suggestion-s',severity:1,actions:['review']}],nextCursor:null,partial:false,partialSources:[],asOf:100,today:'2026-11-03',urgentCount:0,quietDigest:false};
it('separates source-selected snapshots from the general queue and other sources',async()=>{
 let saved:unknown,online=true;
 const deps={context:()=>({userId:'alice',token:'local',access:'scoped:v1',epoch:1}),online:()=>online,request:vi.fn(async()=>page),read:async()=>saved,save:async(_uid:string,snapshot:unknown)=>{saved=snapshot;},hash:async()=>'hash'};
 const review=createSourceAttentionCache(['suggestion_pending','ai_preview_pending'],deps);await review.refresh();expect(review.store.get().page).toEqual(page);
 expect(JSON.stringify(saved)).not.toContain('"token"');review.clear();online=false;await review.refresh();expect(review.store.get()).toMatchObject({page,offline:true,stale:true});
 const other=createSourceAttentionCache(['record_overdue'],deps);await other.refresh();expect(other.store.get().page).toBeNull();
});
it('rejects an unrelated network item and discards a delayed result after access changes',async()=>{
 let access='v1',resolve!:(page:AttentionPage)=>void;
 const deps={context:()=>({userId:'alice',token:'local',access,epoch:1}),online:()=>true,request:()=>new Promise<AttentionPage>(r=>resolve=r),read:async()=>undefined,save:vi.fn(async()=>{}),hash:async()=>'hash'};
 const cache=createSourceAttentionCache(['suggestion_pending'],deps),pending=cache.refresh();await Promise.resolve();await Promise.resolve();access='v2';resolve(page);await pending;expect(cache.store.get().page).toBeNull();expect(deps.save).not.toHaveBeenCalled();
 const other=createSourceAttentionCache(['record_overdue'],{...deps,request:async()=>page});await other.refresh();expect(other.store.get().page).toBeNull();expect(other.store.get().error).toContain('could not refresh');
});
