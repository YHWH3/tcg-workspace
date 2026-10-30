import {useCallback,useEffect,useRef,useState} from 'react';
import {getToken} from './api';
import {readServerFieldEvidence} from './fieldEvidenceRead';
import {authStore} from './auth';
import {accessClientStore} from './accessClient';
import {db} from './db';
import {createCurrentRead,type CurrentRead} from './aiReviewRead';
import {readLocalFieldEvidence} from './fieldEvidenceLocal';
import type {FieldEvidenceConfig} from '../../shared/fieldEvidenceConfig';
import type {FieldEvidencePage} from '../../shared/fieldEvidence';
/** Owner keys this generation by account/session/access/config/connectivity. */
export function useFieldEvidence(config:FieldEvidenceConfig,offline:boolean){
 const key=JSON.stringify(config),[state,setState]=useState<CurrentRead<FieldEvidencePage>>({value:null,loading:true,error:false}),loader=useRef<ReturnType<typeof createCurrentRead<FieldEvidencePage>>|null>(null);
 useEffect(()=>{
  const userId=authStore.get().user?.id,token=getToken(),epoch=accessClientStore.get().epoch;
  const current=()=>!!userId&&!!token&&db.name===`workspace-${userId}`&&authStore.get().user?.id===userId&&getToken()===token&&accessClientStore.get().epoch===epoch&&accessClientStore.get().manifest?.userId===userId&&(offline?['ready','offline'].includes(accessClientStore.get().status):navigator.onLine&&accessClientStore.get().status==='ready');
  const request=()=>offline?readLocalFieldEvidence(db,config,Date.now()):readServerFieldEvidence(config,current);
  const read=createCurrentRead<FieldEvidencePage>({current,request,publish:next=>setState(previous=>({...next,value:next.loading?previous.value:next.value}))});loader.current=read;void read.load();
  let timer:ReturnType<typeof setTimeout>|undefined;const wake=()=>{if(document.visibilityState!=='visible')return;clearTimeout(timer);timer=setTimeout(()=>void read.load(),150);};
  window.addEventListener('ws-records-changed',wake);window.addEventListener('focus',wake);document.addEventListener('visibilitychange',wake);
  return()=>{clearTimeout(timer);read.dispose();if(loader.current===read)loader.current=null;window.removeEventListener('ws-records-changed',wake);window.removeEventListener('focus',wake);document.removeEventListener('visibilitychange',wake);};
 },[key,offline]);
 return {...state,reload:useCallback(()=>loader.current?.load()??Promise.resolve(),[])};
}
