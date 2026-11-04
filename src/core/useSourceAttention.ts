import {useEffect,useMemo} from 'react';
import type {AttentionKind} from '../../shared/attention';
import {api} from './api';
import {db} from './db';
import {useStore} from './store';
import {attentionContext,attentionSessionHash,watchAttention} from './attention';
import {createSourceAttentionCache} from './sourceAttentionCache';
export function useSourceAttention(kinds:AttentionKind[]){
 const sourceKey=[...new Set(kinds)].sort().join(',');
 const cache=useMemo(()=>{
  const sources=sourceKey.split(',') as AttentionKind[];
  const key=(userId:string)=>`attention:sources:${JSON.stringify([userId,sourceKey])}`;
  return createSourceAttentionCache(sources,{
   context:attentionContext,online:()=>navigator.onLine,
   request:()=>api('/api/attention?limit=50&kinds='+encodeURIComponent(sourceKey)),
   read:async userId=>db.name===`workspace-${userId}`?(await db.meta.get(key(userId)))?.value:undefined,
   save:async(userId,snapshot)=>{if(db.name===`workspace-${userId}`)await db.meta.put({key:key(userId),value:snapshot});},
   hash:attentionSessionHash,
  });
 },[sourceKey]);
 useEffect(()=>watchAttention(cache),[cache]);
 return {...useStore(cache.store),refresh:cache.refresh};
}
