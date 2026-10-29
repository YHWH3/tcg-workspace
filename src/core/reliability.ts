import {useEffect,useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {db} from './db';
import {authStore} from './auth';
import {getToken} from './api';
import {accessClientStore} from './accessClient';
import {liveStore} from './live';
import {uploadActivity} from './uploadState';
import {useStore} from './store';
import {readReliability} from './reliabilityData';
export function useReliability(){
 const auth=useStore(authStore),access=useStore(accessClientStore),live=useStore(liveStore),uploads=useStore(uploadActivity);
 const [now,setNow]=useState(Date.now()),userId=auth.user?.id,token=getToken();
 useEffect(()=>{const tick=()=>setNow(Date.now()),timer=setInterval(tick,10000);window.addEventListener('online',tick);window.addEventListener('offline',tick);return()=>{clearInterval(timer);window.removeEventListener('online',tick);window.removeEventListener('offline',tick);};},[]);
 const ready=!!userId&&!!token&&db.name===`workspace-${userId}`&&!!access.manifest&&['ready','offline'].includes(access.status);
 const identity=`${userId}:${token}:${access.epoch}:${access.status}`;
 const result=useLiveQuery(async()=>{
  if(!ready||!userId)return {identity,data:null,error:null};
  const current=()=>{const a=accessClientStore.get();if(authStore.get().user?.id!==userId||getToken()!==token||a.epoch!==access.epoch||!['ready','offline'].includes(a.status)||db.name!==`workspace-${userId}`)throw new Error('access_changed');};
  // Dexie can rerun between age-refresh ticks; observe new entries against the current clock.
  try{return {identity,data:await readReliability(db,userId,Date.now(),{uploading:uploads.userId===userId?uploads.ids:[],connected:live.connected,online:navigator.onLine},current),error:null};}
  catch{return {identity,data:null,error:'Device reliability could not be read. Retry after checking access.'};}
 },[identity,ready,now,uploads,live.connected]);
 return {data:ready&&result?.identity===identity?result.data:null,error:ready&&result?.identity===identity?result.error:null,loading:ready&&result===undefined,refresh:()=>setNow(Date.now())};
}
