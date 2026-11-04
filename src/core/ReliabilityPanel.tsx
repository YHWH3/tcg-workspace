import {useEffect,useRef,useState} from 'react';
import {Link} from 'react-router';
import {AlertTriangle,CloudOff} from 'lucide-react';
import {useReliability} from './reliability';
import {retryFailedUploads} from './reliabilityData';
import {db} from './db';
import {authStore} from './auth';
import {getToken} from './api';
import {accessClientStore,assertClientMutationReady} from './accessClient';
import {syncNow} from './sync/engine';
import {downloadRejected} from './rejectedExport';
import {QuarantineReview} from './QuarantineReview';
import {Button} from './ui';
const time=(value:number|null)=>value===null?'Not observed on this device':new Date(value).toLocaleString();
export function ReliabilityPanel(){
 const heading=useRef<HTMLHeadingElement>(null);
 useEffect(()=>{if(location.hash==='#reliability'){heading.current?.scrollIntoView({block:'start'});heading.current?.focus({preventScroll:true});}},[]);
 const {data,error,loading,refresh}=useReliability(),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[failure,setFailure]=useState(''),[held,setHeld]=useState(false);
 const run=async(fn:()=>Promise<void>)=>{setBusy(true);setFailure('');setMessage('');try{await fn();refresh();}catch(e){setFailure(e instanceof Error?e.message:'This action could not finish.');}finally{setBusy(false);}};
 const retry=async()=>{
  const uid=authStore.get().user?.id,token=getToken(),epoch=accessClientStore.get().epoch;
  const current=()=>{assertClientMutationReady();if(!uid||!token||authStore.get().user?.id!==uid||getToken()!==token||accessClientStore.get().epoch!==epoch)throw new Error('Access changed. Reopen reliability.');};
  current();const result=await retryFailedUploads(db,uid!,current);setMessage(`${result.retried} upload${result.retried===1?'':'s'} queued on this device. ${result.unavailable?`${result.unavailable} need the original file or current access. `:''}${result.more?'More failed uploads remain; review and retry again.':''}`);await syncNow();
 };
 return <section id="reliability" aria-label="Reliability on this device" className="min-w-0 scroll-mt-4 space-y-3">
  <h3 ref={heading} tabIndex={-1} className="text-base font-semibold">Reliability</h3><p className="text-sm text-neutral-600 dark:text-neutral-400">On this device. A local save, server acknowledgement and completed upload are separate states.</p>
  <div className="space-y-1 text-sm"><p>{loading?'Reading local state…':data?`Checked ${new Date(data.asOf).toLocaleTimeString()}`:'Check access to read this device’s state.'}</p><p role="status">{message}</p></div>
  {(failure||error)&&<p role="alert" className="text-sm text-red-700 dark:text-red-300">{failure||error}</p>}
  {data&&<>
   <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
    <Datum label="Pending record changes" value={data.pending}/><Datum label="Rejected changes (retained)" value={data.rejected}/><Datum label="Held operations" value={data.held}/>
    <Datum label="Oldest pending work" value={data.oldestAgeMs===null?(data.unknownPendingAge?'Age unavailable':'None'):`${Math.floor(data.oldestAgeMs/60000)} minutes${data.unknownPendingAge?' (some ages unavailable)':''}`}/>
    <Datum label="Pending uploads" value={data.pendingUploads}/><Datum label="Uploading now" value={data.uploading}/><Datum label="Failed uploads" value={data.failedUploads}/>
    <Datum label="Last acknowledged record push" value={data.lastPushAt?`Synced at ${time(data.lastPushAt)}`:time(null)}/><Datum label="Last successful pull" value={time(data.lastPullAt)}/>
    <Datum label="Live connection" value={data.connected?'Connected':'Not connected; foreground sync is still available'}/><Datum label="Network interface" value={data.online?'Online (server reachability checked by sync)':'Offline'}/>
   </dl>
   {data.uploads.length>0&&<><h4 className="text-sm font-semibold">Uploads on this device</h4><ul aria-label="Device uploads" className="space-y-2 text-sm">{data.uploads.map(u=><li key={u.id} className="flex min-w-0 flex-wrap justify-between gap-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-700"><span className="min-w-0 break-words">{u.name}</span><span>{u.state==='uploading'?'Uploading':u.state==='failed'?'Failed':'Waiting to upload'}</span></li>)}</ul>{data.uploadsPartial&&<p className="text-xs">Showing the first 20 uploads. Counts include all local uploads.</p>}</>}
   <div className="flex flex-wrap gap-2">
    <Button className="h-auto min-h-11 py-2" disabled={busy} onClick={()=>void run(async()=>{await syncNow();setMessage('Sync attempted. Check the observed times and remaining work below.');})}>Sync now</Button>
    <Button className="h-auto min-h-11 py-2" disabled={busy||!data.failedUploads} onClick={()=>void run(retry)}>Retry failed uploads</Button>
    <Button className="h-auto min-h-11 py-2" disabled={busy||!data.held} onClick={()=>setHeld(true)}>Review held work</Button>
    <Button className="h-auto min-h-11 py-2" disabled={busy||!data.rejected} onClick={()=>void run(downloadRejected)}>Export rejected items</Button>
   </div>
  </>}
  {!data&&<Button className="h-auto min-h-11 py-2" onClick={refresh}>Retry local check</Button>}
  {held&&<QuarantineReview onClose={()=>setHeld(false)}/>}
 </section>;
}
function Datum({label,value}:{label:string;value:string|number}){return <div className="min-w-0"><dt className="text-neutral-600 dark:text-neutral-400">{label}</dt><dd className="break-words font-medium">{value}</dd></div>;}
export function ReliabilityChip(){
 const {data}=useReliability();if(!data?.attention)return null;
 return <Link to="/settings#reliability" className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-sm text-amber-800 underline underline-offset-4 dark:text-amber-300"><AlertTriangle size={15} aria-hidden/><span className="break-words">{data.online?null:<CloudOff className="inline" size={14} aria-hidden/>}Review work on this device</span></Link>;
}
