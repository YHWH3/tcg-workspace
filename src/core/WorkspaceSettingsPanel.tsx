import {useEffect,useId,useState} from 'react';
import {useWorkspaceLocale} from './workspaceLocale';
import {refreshWorkspaceSettings,saveWorkspaceSettings} from './workspaceSettings';
import {validTimeZone,validCurrency,type WorkspaceSettings} from '../../shared/workspaceSettings';
import {Button,Input,Select} from './ui';
const weekdays=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
export function WorkspaceSettingsPanel(){
 const state=useWorkspaceLocale(),id=useId();
 const [draft,setDraft]=useState<WorkspaceSettings|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[dirty,setDirty]=useState(false);
 useEffect(()=>{if(!dirty)setDraft(state.settings);},[state.settings,dirty]);
 if(!draft)return <div className="space-y-3"><p role="status">{state.loading?'Loading workspace settings…':'Workspace settings unavailable.'}</p>{!state.loading&&<Button onClick={()=>void refreshWorkspaceSettings()}>Retry settings</Button>}</div>;
 const valid=validTimeZone(draft.timeZone)&&validCurrency(draft.currency);
 const set=(patch:Partial<WorkspaceSettings>)=>{setDirty(true);setMessage('');setDraft({...draft,...patch});};
 const preview=validTimeZone(draft.timeZone)?new Intl.DateTimeFormat('en-GB',{timeZone:draft.timeZone,weekday:'long',day:'numeric',month:'long',year:'numeric'}).format(Date.now()):null;
 const zones=[...new Set(['UTC','Asia/Kolkata',...Intl.supportedValuesOf('timeZone')])];
 return <form className="space-y-4" onSubmit={async e=>{e.preventDefault();if(!valid||!state.canEdit||busy)return;setBusy(true);setMessage('');try{await saveWorkspaceSettings(draft);setDirty(false);setMessage('Workspace settings saved.');}catch(error){setMessage(error instanceof Error?error.message:'Could not save settings.');}finally{setBusy(false);}}}>
  <p className="text-sm text-neutral-600 dark:text-neutral-300">Dates, reminders and money displays use these workspace settings. Currency settings do not convert amounts.</p>
  {!state.canEdit&&<p className="text-sm">Only a workspace administrator can change these settings.</p>}
  <div><label htmlFor={id+'-tz'} className="mb-1 block text-sm">Timezone</label><Input id={id+'-tz'} list={id+'-zones'} value={draft.timeZone} disabled={!state.canEdit||busy} aria-invalid={!validTimeZone(draft.timeZone)} onChange={e=>set({timeZone:e.target.value})}/><datalist id={id+'-zones'}>{zones.map(z=><option key={z} value={z}/>)}</datalist></div>
  <div><label htmlFor={id+'-currency'} className="mb-1 block text-sm">Currency</label><Input id={id+'-currency'} list={id+'-currencies'} value={draft.currency} maxLength={3} disabled={!state.canEdit||busy} aria-invalid={!validCurrency(draft.currency)} onChange={e=>set({currency:e.target.value.toUpperCase()})}/><datalist id={id+'-currencies'}>{['INR','USD','EUR','GBP','AED','SGD','JPY','AUD','CAD'].map(code=><option key={code} value={code}/>)}</datalist><p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">Choose a common code or enter a valid three-letter ISO currency code.</p></div>
  <div><label htmlFor={id+'-week'} className="mb-1 block text-sm">Week starts on</label><Select id={id+'-week'} value={draft.weekStart} disabled={!state.canEdit||busy} onChange={e=>set({weekStart:Number(e.target.value)})}>{weekdays.map((day,i)=><option key={day} value={i}>{day}</option>)}</Select></div>
  {preview&&<p className="text-sm" data-testid="workspace-date-preview">Today in this workspace is {preview}.</p>}
  {dirty&&state.settings&&state.settings.version!==draft.version&&<p role="alert">Settings changed elsewhere. Reload the latest version before saving.<Button type="button" onClick={()=>{setDirty(false);setDraft(state.settings);}}>Reload latest settings</Button></p>}
  {state.canEdit&&<Button type="submit" variant="primary" disabled={!dirty||!valid||busy||state.offline}>{busy?'Saving…':'Save workspace settings'}</Button>}
  {!valid&&<p role="alert">Enter a valid timezone and ISO currency code.</p>}
  {state.cacheError&&<p role="status">Saved online. This device could not cache workspace settings for offline use.</p>}
  {state.offline&&<p role="status">Offline. Cached settings remain in use; reconnect to save.</p>}
  {state.error&&!state.offline&&<div role="status">Workspace settings could not be refreshed. Cached settings remain in use.<Button type="button" onClick={()=>void refreshWorkspaceSettings()}>Retry settings</Button></div>}
  {message&&<p role="status">{message}</p>}
 </form>;
}
export function WorkspaceDateNotice(){const s=useWorkspaceLocale();return !s.settings&&(s.offline||s.error)?<p role="status" className="px-4 py-2 text-sm">{s.offline?"Offline: using this device's date. Workspace settings have not been fetched.":"Workspace settings unavailable: using this device's date until settings can be fetched."}</p>:null;}
