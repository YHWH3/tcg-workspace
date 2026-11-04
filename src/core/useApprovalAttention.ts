import {useEffect,useMemo} from 'react';
import {api} from './api';
import {db} from './db';
import {useStore} from './store';
import {attentionContext,attentionSessionHash,watchAttention} from './attention';
import {createApprovalAttentionCache} from './approvalAttentionCache';
export function useApprovalAttention(approvalDatabaseId:string){
 const cache=useMemo(()=>{
  const key=(userId:string)=>`attention:approvals:${JSON.stringify([userId,approvalDatabaseId])}`;
  return createApprovalAttentionCache(approvalDatabaseId,{
   context:attentionContext,online:()=>navigator.onLine,
   request:()=>api('/api/attention?limit=50&kinds=approval_pending&approvalDatabaseId='+encodeURIComponent(approvalDatabaseId)),
   read:async userId=>db.name===`workspace-${userId}`?(await db.meta.get(key(userId)))?.value:undefined,
   save:async(userId,snapshot)=>{if(db.name===`workspace-${userId}`)await db.meta.put({key:key(userId),value:snapshot});},
   hash:attentionSessionHash,
  });
 },[approvalDatabaseId]);
 useEffect(()=>watchAttention(cache),[cache]);
 return {...useStore(cache.store),refresh:cache.refresh};
}
