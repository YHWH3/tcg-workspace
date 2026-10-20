import type {LocalDB} from './db';
export const DOWNLOAD_CACHE_BUDGET=100*1024*1024;
const KEY='download-cache-bytes';
/** Called inside a transaction including blobs, mediaCache, meta and outbox.
 * Revocation may already have removed a blob: stale accounting only overstates
 * usage and is repaired here. Original and unsent bytes never become victims. */
export async function reclaimCache(store:LocalDB,budget:number,pageSize=50,except?:string){
 let bytes=Number((await store.meta.get(KEY))?.value??0),removed=0,removedBytes=0;
 const rows=await store.mediaCache.orderBy('lastUsed').limit(pageSize).toArray();
 for(const m of rows){if(bytes<=budget)break;if(m.id===except)continue;const b=await store.blobs.get(m.id);if(b&&b.state!=='cached'){await store.mediaCache.delete(m.id);bytes=Math.max(0,bytes-m.bytes);continue;}if(await store.outbox.where('id').equals(m.id).count())continue;if(b){await store.blobs.delete(m.id);removed++;removedBytes+=m.bytes;}await store.mediaCache.delete(m.id);bytes=Math.max(0,bytes-m.bytes);}
 await store.meta.put({key:KEY,value:bytes});return{retainedBytes:bytes,removedBytes,removed,more:bytes>budget,scanned:rows.length};
}
export async function trimDownloadedCache(store:LocalDB,userId:string,budgetBytes=DOWNLOAD_CACHE_BUDGET,pageSize=50){
 if(store.name!==`workspace-${userId}`)throw new Error('account_cache_mismatch');
 if(!Number.isFinite(budgetBytes)||budgetBytes<0||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>200)throw new Error('invalid_cache_budget');
 return store.transaction('rw',[store.blobs,store.mediaCache,store.meta,store.outbox],()=>reclaimCache(store,budgetBytes,pageSize));
}
/** Reserve before writing; refuse caching if a bounded pass cannot make room.
 * The downloaded response still renders; another request can retry caching. */
export async function reserveDownloadedCache(store:LocalDB,id:string,size:number){
 if(size>DOWNLOAD_CACHE_BUDGET)return false;
 const previous=await store.mediaCache.get(id);
 const r=await reclaimCache(store,DOWNLOAD_CACHE_BUDGET-size+(previous?.bytes??0),50,id);
 const remaining=previous?Math.max(0,r.retainedBytes-previous.bytes):r.retainedBytes;
 if(remaining+size>DOWNLOAD_CACHE_BUDGET)return false;
 await store.mediaCache.put({id,bytes:size,lastUsed:Date.now()});await store.meta.put({key:KEY,value:remaining+size});return true;
}
