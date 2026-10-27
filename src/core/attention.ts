import {useEffect} from 'react';
import {api,getToken} from './api';
import {authStore} from './auth';
import {db} from './db';
import {accessClientStore} from './accessClient';
import {workspaceLocale} from './workspaceLocale';
import {useStore} from './store';
import {createAttentionCache,type AttentionContext} from './attentionCache';
function context():AttentionContext|null {
 const userId=authStore.get().user?.id,token=getToken(),state=accessClientStore.get(),manifest=state.manifest;
 if(!userId||!token||db.name!==`workspace-${userId}`||!manifest||manifest.userId!==userId||!['ready','offline'].includes(state.status))return null;
 return {userId,token,epoch:state.epoch,access:manifest.protocol===1?'legacy:1':`scoped:${manifest.etag}`};
}
const cache=createAttentionCache({context,online:()=>navigator.onLine,
 request:()=>api('/api/attention?limit=50'),
 read:async uid=>db.name===`workspace-${uid}`?(await db.meta.get(`attention:${uid}`))?.value:undefined,
 save:async(uid,snapshot)=>{if(db.name===`workspace-${uid}`)await db.meta.put({key:`attention:${uid}`,value:snapshot});},
 hash:async token=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))).map(n=>n.toString(16).padStart(2,'0')).join(''),
});
let consumers=0,stop:(()=>void)|undefined;
export const refreshAttention=cache.refresh;
export function useAttention(){
 useEffect(()=>{
  if(++consumers===1){
   let timer:ReturnType<typeof setTimeout>|undefined;
   const refresh=()=>{if(document.visibilityState!=='hidden')void cache.refresh();};
   const hint=()=>{clearTimeout(timer);timer=setTimeout(refresh,2000);};
   let previous=context(),previousStatus=accessClientStore.get().status;
   const access=()=>{
    const next=context(),status=accessClientStore.get().status;
    const changed=JSON.stringify(next)!==JSON.stringify(previous);
    previous=next;const wasOffline=previousStatus==='offline';previousStatus=status;
    if(changed){cache.clear();refresh();}
    else if(status==='offline')cache.markStale();
    else if(wasOffline)refresh();
    else hint();
   };
   const offline=()=>cache.markStale();
   const unsubAccess=accessClientStore.subscribe(access),unsubAuth=authStore.subscribe(access);
   let day=workspaceLocale.get().today;
   const unsubLocale=workspaceLocale.subscribe(()=>{const next=workspaceLocale.get().today;if(next!==day){day=next;cache.clear();refresh();}});
   window.addEventListener('ws-records-changed',hint);window.addEventListener('online',refresh);window.addEventListener('offline',offline);window.addEventListener('pageshow',refresh);document.addEventListener('visibilitychange',refresh);
   refresh();
   stop=()=>{clearTimeout(timer);unsubAccess();unsubAuth();unsubLocale();window.removeEventListener('ws-records-changed',hint);window.removeEventListener('online',refresh);window.removeEventListener('offline',offline);window.removeEventListener('pageshow',refresh);document.removeEventListener('visibilitychange',refresh);cache.clear();};
  }
  return()=>{if(--consumers===0){stop?.();stop=undefined;}};
 },[]);
 return useStore(cache.store);
}
