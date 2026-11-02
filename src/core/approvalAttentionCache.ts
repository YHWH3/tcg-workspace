import {createAttentionCache,type AttentionCacheDeps} from './attentionCache';
/** An approval-only snapshot cannot be reused as another database's queue. */
export function createApprovalAttentionCache(approvalDatabaseId:string,deps:Omit<AttentionCacheDeps,'acceptPage'>){
 return createAttentionCache({...deps,
  context:()=>{const context=deps.context();return context?{...context,access:JSON.stringify([context.access,'approval_database',approvalDatabaseId])}:null;},
  acceptPage:page=>page.items.every(item=>item.kind==='approval_pending'&&item.databaseId===approvalDatabaseId&&!item.restricted),
 });
}
