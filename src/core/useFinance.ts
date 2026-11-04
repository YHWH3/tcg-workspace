import {useCallback,useEffect,useRef,useState} from 'react';
import {getToken} from './api';
import {readServerFinance} from './financeRead';
import {authStore} from './auth';
import {accessClientStore} from './accessClient';
import {db} from './db';
import {createCurrentRead,type CurrentRead} from './aiReviewRead';
import {readLocalFinance} from './financeLocal';
import {useWorkspaceLocale,workspaceTimeZone,workspaceCurrency} from './workspaceLocale';
import type {FinanceConfig} from '../../shared/financeConfig';
import type {FinancePage} from '../../shared/financePage';
/** Owner keys the mounted generation by identity, access, config and connectivity. */
export function useFinance(config:FinanceConfig,offline:boolean){
 const locale=useWorkspaceLocale(),zone=workspaceTimeZone(),currency=workspaceCurrency(),key=JSON.stringify(config);
 const [state,setState]=useState<CurrentRead<FinancePage>>({value:null,loading:true,error:false}),loader=useRef<ReturnType<typeof createCurrentRead<FinancePage>>|null>(null);
 useEffect(()=>{
  const userId=authStore.get().user?.id,token=getToken(),epoch=accessClientStore.get().epoch;
  const current=()=>!!userId&&!!token&&db.name===`workspace-${userId}`&&authStore.get().user?.id===userId&&getToken()===token&&accessClientStore.get().epoch===epoch&&accessClientStore.get().manifest?.userId===userId&&(offline?['ready','offline'].includes(accessClientStore.get().status):navigator.onLine&&accessClientStore.get().status==='ready');
  const request=async()=>{
   if(offline)return readLocalFinance(db,config,{userId:userId!,today:locale.today,timeZone:zone,currency,now:Date.now()});
   return readServerFinance(config,current);
  };
  const read=createCurrentRead<FinancePage>({current,request,publish:next=>setState(previous=>({...next,value:next.loading?previous.value:next.value}))});loader.current=read;void read.load();
  let timer:ReturnType<typeof setTimeout>|undefined;
  const wake=()=>{if(document.visibilityState!=='visible')return;clearTimeout(timer);timer=setTimeout(()=>void read.load(),150);};
  window.addEventListener('ws-records-changed',wake);window.addEventListener('focus',wake);document.addEventListener('visibilitychange',wake);
  return()=>{clearTimeout(timer);read.dispose();if(loader.current===read)loader.current=null;window.removeEventListener('ws-records-changed',wake);window.removeEventListener('focus',wake);document.removeEventListener('visibilitychange',wake);};
 },[key,offline,locale.today,zone,currency]);
 return {...state,reload:useCallback(()=>loader.current?.load()??Promise.resolve(),[])};
}
