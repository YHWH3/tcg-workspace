import {useCallback,useEffect,useRef,useState} from 'react';
import {api,getToken} from './api';
import {authStore} from './auth';
import {accessClientStore} from './accessClient';
import {createCurrentRead,type CurrentRead} from './aiReviewRead';
/** Mounted only inside the online/current-access keyed AI surface. */
export function useAiReviewRead<T>(path:string){
 const [state,setState]=useState<CurrentRead<T>>({value:null,loading:true,error:false});
 const loader=useRef<ReturnType<typeof createCurrentRead<T>>|null>(null);
 useEffect(()=>{
  const uid=authStore.get().user?.id,token=getToken(),epoch=accessClientStore.get().epoch;
  const current=()=>!!uid&&!!token&&navigator.onLine&&authStore.get().user?.id===uid&&getToken()===token&&accessClientStore.get().epoch===epoch&&accessClientStore.get().status==='ready';
  const read=createCurrentRead<T>({current,request:()=>api<T>(path),publish:setState});loader.current=read;
  void read.load();
  const wake=()=>{if(document.visibilityState==='visible')void read.load();};
  window.addEventListener('ws-records-changed',wake);window.addEventListener('focus',wake);document.addEventListener('visibilitychange',wake);
  return()=>{read.dispose();if(loader.current===read)loader.current=null;window.removeEventListener('ws-records-changed',wake);window.removeEventListener('focus',wake);document.removeEventListener('visibilitychange',wake);};
 },[path]);
 const reload=useCallback(()=>loader.current?.load()??Promise.resolve(),[]);
 return {...state,reload};
}
