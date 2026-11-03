import type {AttentionKind} from '../../shared/attention';
import {createAttentionCache,type AttentionCacheDeps} from './attentionCache';
/** Source-selected queues have their own cache identity, including offline reads. */
export function createSourceAttentionCache(kinds:readonly AttentionKind[],deps:Omit<AttentionCacheDeps,'acceptPage'>){
 const sources=[...new Set(kinds)].sort();
 return createAttentionCache({...deps,
  context:()=>{const context=deps.context();return context?{...context,access:JSON.stringify([context.access,'sources',sources])}:null;},
  acceptPage:page=>page.items.every(item=>sources.includes(item.kind)),
 });
}
