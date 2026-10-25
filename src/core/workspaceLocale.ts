import {createStore,useStore} from './store';
import {workspaceToday} from '../../shared/dates';
import type {WorkspaceSettings} from '../../shared/workspaceSettings';
export interface LocaleState {settings:WorkspaceSettings|null;canEdit:boolean;offline:boolean;loading:boolean;error:string|null;cacheError:boolean;today:string}
const deviceZone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
export const workspaceLocale=createStore<LocaleState>({settings:null,canEdit:false,offline:false,loading:true,error:null,cacheError:false,today:workspaceToday(Date.now(),deviceZone())});
export function workspaceTimeZone(){return workspaceLocale.get().settings?.timeZone??deviceZone();}
export function workspaceCurrency(){return workspaceLocale.get().settings?.currency??'INR';}
export function tickWorkspaceDay(){const s=workspaceLocale.get(),today=workspaceToday(Date.now(),workspaceTimeZone());if(s.today!==today)workspaceLocale.set({...s,today});}
export function useWorkspaceLocale(){return useStore(workspaceLocale);}
