import {useEffect,useRef,useState} from 'react';
import {Link,useNavigate} from 'react-router';
import {ideaHandoffs,type HandoffBoard,type HandoffLink,type HandoffRecord} from '../../../shared/ideaHandoff';
import {api,getToken,ApiError} from '../api';
import {authStore} from '../auth';
import {accessClientStore} from '../accessClient';
import {db,type LocalRow} from '../db';
import {syncNow,onlineStore} from '../sync/engine';
import {useStore} from '../store';
import {Button} from '../ui';
import {stableJson} from '../../../shared/stablejson';
interface Props {record:LocalRow;boards:readonly HandoffBoard[];records:readonly HandoffRecord[];links:readonly HandoffLink[]}
export function IdeaHandoff({record,boards,records,links}:Props){
 const navigate=useNavigate(),online=useStore(onlineStore),access=useStore(accessClientStore);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[newReview,setNewReview]=useState(false),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useEffect(()=>{setBusy(false);setError('');},[access.epoch]);
 const handoffs=ideaHandoffs(record,boards,records,links),board=boards.find(b=>b.id===record.boardId);
 const convertible=board?.templateDbKey==='ideas'&&!board.deleted&&!board.archived&&!record.deleted&&!record.archived&&record.status!=='converted'&&!handoffs.length;
 async function review(){
  const userId=authStore.get().user?.id,token=getToken(),epoch=accessClientStore.get().epoch;
  const current=()=>mounted.current&&!!userId&&!!token&&authStore.get().user?.id===userId&&getToken()===token&&accessClientStore.get().epoch===epoch;
  setBusy(true);setError('');
  try{
   if(!navigator.onLine||accessClientStore.get().status!=='ready')throw new Error('access_not_ready');
   await syncNow();if(!current())return;
   if(await db.outbox.where('id').equals(record.id).count())throw new Error('edits_pending');
   const source=await db.tasks.get(record.id);if(!source||source.deleted||!current())return;
   const key='idea-conversion:'+userId+':'+record.id,fields=stableJson(source._ts);
   const saved=sessionStorage.getItem(key);
   const requestId=!newReview&&saved?.startsWith(fields+'\n')?saved.slice(fields.length+1):'idea-ui-'+crypto.randomUUID();
   sessionStorage.setItem(key,fields+'\n'+requestId);setNewReview(false);
   const result=await api<{previewId?:string;status?:string;expiresAt?:number;alreadyConverted?:boolean;recordId?:string;databaseId?:string}>('/api/ideas/'+encodeURIComponent(record.id)+'/conversion',{method:'POST',body:{requestId,expectedFields:source._ts}});
   if(!current())return;
   if(result.status==='cancelled'||result.expiresAt!==undefined&&result.expiresAt<=Date.now()){setNewReview(true);setError('The previous proposal was cancelled or expired. Start a new conversion review when ready.');return;}
   if(result.previewId)navigate('/ai/review/'+encodeURIComponent(result.previewId));
   else if(result.alreadyConverted&&result.databaseId&&result.recordId)navigate('/boards/'+encodeURIComponent(result.databaseId)+'/tasks/'+encodeURIComponent(result.recordId));
   else throw new Error('invalid_conversion_response');
  }catch(cause){if(current())setError(cause instanceof ApiError&&cause.status===409?'The idea or conversion request changed. Sync and retry.':cause instanceof Error&&cause.message==='edits_pending'?'Save and sync this idea’s pending edits, then retry.':'Conversion review could not be prepared. Check your connection and access, then retry.');}
  finally{if(current())setBusy(false);}
 }
 if(!handoffs.length&&!convertible)return null;
 return <section aria-label="Idea conversion handoff" className="min-w-0 space-y-2 rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-700">
  {handoffs.map(handoff=><p key={handoff.id} className="min-w-0 break-words">{handoff.direction==='to_project'?'Converted to ':'From idea '}<Link className="inline-block max-w-full break-words py-2 font-medium underline underline-offset-4 [overflow-wrap:anywhere]" to={'/boards/'+encodeURIComponent(handoff.databaseId)+'/tasks/'+encodeURIComponent(handoff.id)}>{handoff.title}</Link></p>)}
  {convertible&&<><p className="text-neutral-600 dark:text-neutral-400">Create a project from this idea. Review the proposed changes before approving and executing them.</p><Button className="h-auto min-h-11 max-w-full whitespace-normal py-2" disabled={busy||!online||access.status!=='ready'} onClick={()=>void review()}>{busy?'Preparing review…':newReview?'Start a new conversion review':'Review conversion to project'}</Button>{(!online||access.status!=='ready')&&<p className="text-neutral-600 dark:text-neutral-400">Reconnect and check access to prepare a conversion.</p>}</>}
  {error&&<p role="alert" className="break-words text-red-700 dark:text-red-300">{error}</p>}
 </section>;
}
