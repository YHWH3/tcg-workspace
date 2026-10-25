import {api,getToken} from './api';
import {db} from './db';
import {authStore} from './auth';
import {workspaceLocale,tickWorkspaceDay} from './workspaceLocale';
import {validTimeZone,validCurrency,type WorkspaceSettings} from '../../shared/workspaceSettings';
interface SettingsReply {settings:WorkspaceSettings;canEdit:boolean}
let generation=0;
let pending:{identity:string;promise:Promise<void>}|undefined;
function identity(){return `${authStore.get().user?.id??''}:${getToken()??''}`;}
function valid(value:SettingsReply|undefined):value is SettingsReply {const s=value?.settings;return !!s&&validTimeZone(s.timeZone)&&validCurrency(s.currency)&&Number.isInteger(s.weekStart)&&s.weekStart>=0&&s.weekStart<=6&&Number.isSafeInteger(s.version)&&s.version>0;}
async function cacheSettings(reply:SettingsReply,uid:string,current:()=>boolean){
 if(db.name!==`workspace-${uid}`||!current())return;
 try{await db.meta.put({key:'workspaceSettings',value:{...reply,accountId:uid}});if(current())workspaceLocale.set(s=>({...s,cacheError:false}));}
 catch{if(current())workspaceLocale.set(s=>({...s,cacheError:true}));}
}
/** Discard responses from a prior account/token or superseded lifecycle. */
export function refreshWorkspaceSettings():Promise<void>{
 const key=identity(),uid=authStore.get().user?.id,token=getToken(),epoch=generation;
 if(!uid||!token)return Promise.resolve();
 if(pending?.identity===key)return pending.promise;
 const current=()=>generation===epoch&&identity()===key;
 const promise=(async()=>{
  try{
   const reply=await api<SettingsReply>('/api/workspace/settings');if(!current())return;
   if(!valid(reply))throw new Error('Invalid workspace settings response');
   // A late cache/network read must not replace a newer settings revision.
   if((workspaceLocale.get().settings?.version??0)>reply.settings.version)return;
   workspaceLocale.set(s=>({...s,...reply,offline:false,loading:false,error:null}));tickWorkspaceDay();
   await cacheSettings(reply,uid,current);
  }catch(error){if(current())workspaceLocale.set(s=>({...s,offline:!navigator.onLine,loading:false,error:error instanceof Error?error.message:'Settings unavailable'}));}
 })().finally(()=>{if(pending?.promise===promise)pending=undefined;});
 pending={identity:key,promise};return promise;
}
export function startWorkspaceSettings(){
 const epoch=++generation,uid=authStore.get().user?.id,key=identity();
 pending=undefined;workspaceLocale.set(s=>({...s,settings:null,canEdit:false,loading:true,error:null,cacheError:false,offline:!navigator.onLine}));tickWorkspaceDay();
 if(uid&&db.name===`workspace-${uid}`)void db.meta.get('workspaceSettings').then(row=>{
  const cached=row?.value as SettingsReply&{accountId?:string};
  if(epoch!==generation||identity()!==key||cached?.accountId!==uid||!valid(cached)||workspaceLocale.get().settings)return;
  workspaceLocale.set(s=>({...s,settings:cached.settings,canEdit:cached.canEdit}));tickWorkspaceDay();
 }).catch(()=>{});
 void refreshWorkspaceSettings();
 const wake=()=>{tickWorkspaceDay();if(document.visibilityState!=='hidden')void refreshWorkspaceSettings();};
 const offline=()=>workspaceLocale.set(s=>({...s,offline:true}));
 const timer=setInterval(tickWorkspaceDay,1000);
 window.addEventListener('online',wake);window.addEventListener('offline',offline);window.addEventListener('pageshow',wake);document.addEventListener('visibilitychange',wake);
 return()=>{if(epoch===generation){generation++;pending=undefined;workspaceLocale.set(s=>({...s,settings:null,canEdit:false}));}clearInterval(timer);window.removeEventListener('online',wake);window.removeEventListener('offline',offline);window.removeEventListener('pageshow',wake);document.removeEventListener('visibilitychange',wake);};
}
export async function saveWorkspaceSettings(settings:WorkspaceSettings){
 const key=identity(),epoch=generation,uid=authStore.get().user?.id;
 const current=()=>identity()===key&&epoch===generation;
 const result=await api<{settings:WorkspaceSettings}>('/api/workspace/settings',{method:'PUT',body:settings});
 if(!current()||!uid)throw new Error('Account changed; reopen Workspace settings');
 const reply={settings:result.settings,canEdit:workspaceLocale.get().canEdit};
 if(!valid(reply))throw new Error('Invalid settings save response');
 if((workspaceLocale.get().settings?.version??0)<=result.settings.version){
  workspaceLocale.set(s=>({...s,settings:result.settings,offline:false,error:null}));tickWorkspaceDay();
  // Persist this accepted revision directly. An older in-flight GET may finish
  // later and correctly be discarded; it cannot be relied on to cache the save.
  await cacheSettings(reply,uid,current);
 }
 await refreshWorkspaceSettings();
}
