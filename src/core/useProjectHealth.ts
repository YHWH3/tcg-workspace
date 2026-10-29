import {useCallback,useEffect,useRef,useState} from 'react';
import {api,getToken} from './api';
import {authStore} from './auth';
import {accessClientStore} from './accessClient';
import {db} from './db';
import {createCurrentRead,type CurrentRead} from './aiReviewRead';
import {readLocalProjectHealth} from './projectHealthLocal';
import {useWorkspaceLocale,workspaceTimeZone} from './workspaceLocale';
import type {ProjectHealthConfig} from '../../shared/projectHealthConfig';
import type {ProjectHealthPage} from '../../shared/projectHealth';

/** Caller keys the mounted reader by account, token, access epoch and mode. */
export function useProjectHealth(config:ProjectHealthConfig,offline:boolean){
 const locale=useWorkspaceLocale(),key=JSON.stringify(config),zone=workspaceTimeZone();
 const [state,setState]=useState<CurrentRead<ProjectHealthPage>>({value:null,loading:true,error:false});
 const loader=useRef<ReturnType<typeof createCurrentRead<ProjectHealthPage>>|null>(null);
 useEffect(()=>{
  const uid=authStore.get().user?.id,token=getToken(),epoch=accessClientStore.get().epoch;
  const current=()=>!!uid&&!!token&&db.name===`workspace-${uid}`&&authStore.get().user?.id===uid&&getToken()===token&&accessClientStore.get().epoch===epoch&&accessClientStore.get().manifest?.userId===uid&&(offline?['ready','offline'].includes(accessClientStore.get().status):navigator.onLine&&accessClientStore.get().status==='ready');
  const request=()=>offline?readLocalProjectHealth(db,config,{userId:uid!,today:locale.today,timeZone:zone,now:Date.now()}):api<{pages:[ProjectHealthPage]}>('/api/project-health',{method:'POST',body:[config]}).then(r=>r.pages[0]);
  const read=createCurrentRead<ProjectHealthPage>({current,request,publish:next=>setState(previous=>({...next,value:next.loading?previous.value:next.value}))});loader.current=read;
  void read.load();let timer:ReturnType<typeof setTimeout>|undefined;
  const wake=()=>{if(document.visibilityState!=='visible')return;clearTimeout(timer);timer=setTimeout(()=>void read.load(),150);};
  window.addEventListener('ws-records-changed',wake);window.addEventListener('focus',wake);document.addEventListener('visibilitychange',wake);
  return()=>{clearTimeout(timer);read.dispose();if(loader.current===read)loader.current=null;window.removeEventListener('ws-records-changed',wake);window.removeEventListener('focus',wake);document.removeEventListener('visibilitychange',wake);};
 // Config, locale and identity are frozen for each mounted generation.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[key,offline,locale.today,zone]);
 const reload=useCallback(()=>loader.current?.load()??Promise.resolve(),[]);
 return {...state,reload};
}
