import {accessClientStore,assertClientMutationReady} from './accessClient';
import {serializeRejected} from './sync/engine';
import {authStore} from './auth';
import {getToken} from './api';
/** Reuse the retained-rejection serializer without exporting any held payload. */
export async function downloadRejected(){
 assertClientMutationReady();const epoch=accessClientStore.get().epoch;
 const uid=authStore.get().user?.id,token=getToken();const payload=await serializeRejected();
 if(!uid||authStore.get().user?.id!==uid||getToken()!==token||accessClientStore.get().epoch!==epoch)throw new Error('Account changed. Reopen export.');
 const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));
 try{const a=document.createElement('a');a.href=url;a.download=`workspace-rejected-${new Date().toISOString().slice(0,10)}.json`;a.click();}finally{URL.revokeObjectURL(url);}
}
