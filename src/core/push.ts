import {readPushDevice,writePushDevice} from '../../shared/pushDevice';
import {api,getToken} from './api';

export async function pushSession(token:string) {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

export async function enableDevicePush(publicKey:string) {
  const token=getToken(),userId=localStorage.getItem('ws_uid');
  if(!token||!userId)throw new Error('session_changed');
  const current=()=>getToken()===token&&localStorage.getItem('ws_uid')===userId;
  const permission=await Notification.requestPermission();
  if(permission!=='granted')throw new Error('push_permission_denied');
  const registration=await navigator.serviceWorker.getRegistration();
  if(!registration)throw new Error('push_worker_unavailable');
  const key=Uint8Array.from(atob(publicKey.replace(/-/g,'+').replace(/_/g,'/')),char=>char.charCodeAt(0));
  const session=await pushSession(token);
  const device=await readPushDevice();
  let subscription=await registration.pushManager.getSubscription();
  if(!current())throw new Error('session_changed');
  if(subscription&&(device?.userId!==userId||device?.session!==session)){
    // An interrupted cleanup can leave another account's browser endpoint.
    // Replace it before registering this session with the server.
    if(device)await writePushDevice(null,device.session);
    const endpoint=subscription.endpoint;
    await subscription.unsubscribe();
    if(!current())throw new Error('session_changed');
    await api('/api/push/subscriptions',{method:'DELETE',body:{endpoint}});
    subscription=null;
  }
  subscription??=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
  if(!current())throw new Error('session_changed');
  await api('/api/push/subscriptions',{method:'POST',body:subscription.toJSON()});
  if(!current())throw new Error('session_changed');
  await writePushDevice({userId,session});
}

export async function clearDevicePush(token=getToken()) {
  if(!token||!('serviceWorker' in navigator)||!('indexedDB' in globalThis))return;
  const removed=await writePushDevice(null,await pushSession(token));
  if(!removed)return;
  const registration=await navigator.serviceWorker.getRegistration();
  const subscription=await registration?.pushManager?.getSubscription();
  for(const notification of await registration?.getNotifications()??[])notification.close();
  if(!subscription)return;
  await subscription.unsubscribe();
  const response=await fetch('/api/push/subscriptions',{
    method:'DELETE',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:JSON.stringify({endpoint:subscription.endpoint}),signal:AbortSignal.timeout(5000),
  });
  if(!response.ok&&response.status!==401)throw new Error('push_cleanup_failed');
}
