import {useEffect,useState} from 'react';
import {Link} from 'react-router';
import {useStore} from '../../core/store';
import {authStore} from '../../core/auth';
import {getToken} from '../../core/api';
import {db,type LocalRow} from '../../core/db';
import {mutate} from '../../core/sync/engine';
import {accessClientStore,assertClientMutationReady} from '../../core/accessClient';
import {useUsers} from '../../core/users';
import {useWorkspaceLocale,workspaceTimeZone} from '../../core/workspaceLocale';
import {Button,Select,Input} from '../../core/ui';
import {AskAiMenu} from '../../core/assistant/AskAiMenu';
import {parseGate,gateMatches} from '../../../shared/approvals';
import {WEBSITE_FAMILIES,WEBSITE_INBOX_ID,WI_FIELD,wiKey} from '../../../shared/websiteInbox';
import {responseAge,websiteQueue,type WebsiteDashboard,type WebsiteQueue} from '../../../shared/websiteStats';
import {planWebsiteChange} from '../../../shared/websiteActions';
import type {MutationGuard} from '../../../shared/mutationGuard';
import {Slot} from '../slots';
import {modules} from '..';
import {logActivity} from '../../core/activity';

const choices:[WebsiteQueue,string][]=[['unassigned','Unassigned'],['mine','Mine'],['open','All open'],['followup_due','Follow-up due']];
type Saved={id:string;before:Record<string,unknown>;guard:MutationGuard};
export function ResponseDesk({rows,board,stats}:{rows:LocalRow[];board:LocalRow;stats:WebsiteDashboard}){
 const auth=useStore(authStore),access=useStore(accessClientStore);
 return <ResponseDeskContent key={`${auth.user?.id}:${getToken()}:${access.epoch}`} rows={rows} board={board} stats={stats}/>;
}
function ResponseDeskContent({rows,board,stats}:{rows:LocalRow[];board:LocalRow;stats:WebsiteDashboard}){
 const me=useStore(authStore).user,users=useUsers(),locale=useWorkspaceLocale();
 const [queue,setQueue]=useState<WebsiteQueue>('unassigned'),[family,setFamily]=useState(''),[band,setBand]=useState<number|null>(null),[page,setPage]=useState(0),[selected,setSelected]=useState<string[]>([]),[owner,setOwner]=useState(''),[status,setStatus]=useState('in_review'),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(''),[undo,setUndo]=useState<Saved[]>([]);
 const [approval,setApproval]=useState<{taskId:string;boardId:string;stageId:string}|null>(null);
 const activeUsers=users.filter(u=>!u.disabled),today=locale.today,zone=workspaceTimeZone();
 const filtered=websiteQueue(rows,queue,me?.id??'',today).filter(r=>(!family||r[wiKey(WI_FIELD.family)]===family)&&(band===null||stats.responseBands.bands[band]?.ids.includes(r.id))).sort((a,b)=>(responseAge(b,today,zone)??-1)-(responseAge(a,today,zone)??-1)||a.id.localeCompare(b.id));
 const shown=filtered.slice(page*25,page*25+25),unassigned=stats.ownerQueues.find(q=>q.ownerId===null)?.count??0;
 useEffect(()=>{setPage(0);setSelected([]);},[queue,family,band]);
 useEffect(()=>{if(page>0&&!shown.length)setPage(0);},[page,shown.length]);
 const current=()=>({uid:authStore.get().user?.id,token:getToken(),epoch:accessClientStore.get().epoch});
 const apply=async(ids:string[],patch:Record<string,unknown>)=>{
  if(!ids.length)return;setBusy(true);setError('');setMessage('');setUndo([]);const identity=current(),saved:Saved[]=[];
  try{
   if(!identity.uid||!identity.token)throw new Error('Sign in again before editing.');
   if(patch.assigneeId&&!activeUsers.some(u=>u.id===patch.assigneeId)&&patch.assigneeId!==identity.uid)throw new Error('Choose an active owner.');
   const gate=parseGate(board),gated=gateMatches(gate,patch.status);
   if(gated&&ids.length>1)throw new Error('This status requires individual approval. Use each submission’s status action to review its request.');
   for(const id of ids.slice(0,50)){
    assertClientMutationReady();if(JSON.stringify(current())!==JSON.stringify(identity))throw new Error('Account or access changed. Reopen the response desk.');
    const row=await db.tasks.get(id);if(JSON.stringify(current())!==JSON.stringify(identity))throw new Error('Account or access changed. Reopen the response desk.');if(!row)throw new Error('A selected submission is unavailable.');
    const plan=planWebsiteChange(row,patch);await mutate('tasks',id,plan.patch,plan.guard);saved.push({id,before:plan.before,guard:plan.undoGuard});
    logActivity('updated','task',id,String(row.title??'Website submission'),{source:'website_response_desk',fields:Object.keys(patch)});
    if(gated&&gate)setApproval({taskId:id,boardId:board.id,stageId:gate.stageId});
   }
   setSelected([]);setMessage(`${saved.length} response${saved.length===1?'':'s'} saved on this device. Sync confirms server acceptance.`);
  }catch(e){setError((e instanceof Error?e.message:'The change could not be saved.')+(saved.length?` ${saved.length} already saved on this device; Undo remains available.`:''));}
  finally{if(JSON.stringify(current())===JSON.stringify(identity)){setUndo(saved);setBusy(false);}window.dispatchEvent(new Event('ws-records-changed'));}
 };
 const undoLast=async()=>{
  const identity=current();setBusy(true);setError('');let restored=0;const failed:Saved[]=[];
  for(const item of undo){try{if(JSON.stringify(identity)!==JSON.stringify(current()))throw new Error('Access changed');await mutate('tasks',item.id,item.before,item.guard);restored++;}catch{failed.push(item);}}
  if(JSON.stringify(identity)===JSON.stringify(current())){setUndo(failed);setBusy(false);setMessage(`${restored} response changes restored on this device. Sync confirms acceptance.`);if(failed.length)setError(`${failed.length} could not be restored. A submission may have changed; open it to review.`);}
 };
 const choose=(q:WebsiteQueue)=>{setQueue(q);setBand(null);};
 return <section aria-labelledby="response-desk-heading" className="mb-6 min-w-0 space-y-4 rounded-xl border border-neutral-200 p-2 sm:p-4 dark:border-neutral-800">
  <h2 id="response-desk-heading" className="text-lg font-semibold">Response desk</h2>
  <div className="flex flex-wrap gap-3 text-sm">
   <Button className="h-auto min-h-11 py-2" onClick={()=>choose('open')}>{stats.open} open</Button>
   {stats.responseBands.bands.map((g,i)=><Button key={g.label} className="h-auto min-h-11 py-2" aria-pressed={band===i} onClick={()=>{setQueue('open');setBand(band===i?null:i);}}>{g.label}: {g.count}</Button>)}
   <Button className="h-auto min-h-11 py-2" onClick={()=>choose('unassigned')}>{unassigned} unassigned</Button>
  </div>
  <p className="text-sm text-neutral-600 dark:text-neutral-400">First reply target: {stats.targetDays} days. Median: {stats.medianFirstReplyDays===null?'no replies recorded':`${stats.medianFirstReplyDays} days`}. {stats.targetBreaches.length} past target.{stats.responseBands.unknownIds.length?` ${stats.responseBands.unknownIds.length} have no valid received date.`:''}</p>
  <nav aria-label="Response queues" className="flex flex-wrap gap-2">{choices.map(([key,label])=><Button key={key} className="h-auto min-h-11 py-2" aria-pressed={queue===key&&band===null} onClick={()=>choose(key)}>{label}</Button>)}</nav>
  <label className="flex flex-wrap items-center gap-2 text-sm">Form family<Select aria-label="Response form family" className="h-auto min-h-11 min-w-0 max-w-full" value={family} onChange={e=>setFamily(e.target.value)}><option value="">All families</option>{WEBSITE_FAMILIES.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</Select></label>
  <p role="status" className="text-sm text-neutral-600 dark:text-neutral-400">{filtered.length} in this queue. {message}</p>
  {error&&<p role="alert" className="break-words text-sm text-red-700 dark:text-red-300">{error}</p>}
  {!!undo.length&&<Button className="h-auto min-h-11 py-2" onClick={()=>void undoLast()} disabled={busy}>Undo last response changes</Button>}
  <fieldset disabled={busy} className="min-w-0 space-y-3"><legend className="font-medium">Bulk response actions</legend>
   <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={!!shown.length&&shown.every(r=>selected.includes(r.id))} onChange={e=>setSelected(e.target.checked?shown.map(r=>r.id):[])}/>Select this page ({shown.length})</label>
   <div className="flex min-w-0 flex-wrap items-end gap-3">
    <label className="min-w-0 text-sm">Owner<Select aria-label="Bulk response owner" className="h-auto min-h-11 max-w-full" value={owner} onChange={e=>setOwner(e.target.value)}><option value="">Unassigned</option>{activeUsers.map(u=><option key={u.id} value={u.id}>{u.name||u.username}</option>)}</Select></label><Button className="h-auto min-h-11 py-2" disabled={!selected.length} onClick={()=>void apply(selected,{assigneeId:owner||null})}>Assign selected ({selected.length})</Button>
    <label className="min-w-0 text-sm">Status<Select aria-label="Bulk response status" className="h-auto min-h-11 max-w-full" value={status} onChange={e=>setStatus(e.target.value)}><option value="new">New</option><option value="in_review">In review</option><option value="replied">Replied</option><option value="done">Done</option></Select></label><Button className="h-auto min-h-11 py-2" disabled={!selected.length} onClick={()=>void apply(selected,{status})}>Set selected status</Button>
   </div>
  </fieldset>
  {!shown.length?<p className="py-3 text-sm">No open submissions in this queue.</p>:<ul className="space-y-3">{shown.map(r=><li key={r.id}><ResponseRow row={r} selected={selected.includes(r.id)} onSelect={v=>setSelected(s=>v?[...new Set([...s,r.id])].slice(0,50):s.filter(id=>id!==r.id))} users={activeUsers} me={me?.id??''} busy={busy} apply={patch=>apply([r.id],patch)}/></li>)}</ul>}
  <div className="flex flex-wrap items-center gap-3"><Button className="h-auto min-h-11 py-2" disabled={page===0} onClick={()=>{setPage(p=>p-1);setSelected([]);}}>Previous page</Button><span className="text-sm">Page {page+1} of {Math.max(1,Math.ceil(filtered.length/25))}</span><Button className="h-auto min-h-11 py-2" disabled={(page+1)*25>=filtered.length} onClick={()=>{setPage(p=>p+1);setSelected([]);}}>Next page</Button></div>
  {approval&&<Slot modules={modules} kind="stageApproval" props={{...approval,onClose:()=>setApproval(null)}}/>}
 </section>;
}
function ResponseRow({row,selected,onSelect,users,me,busy,apply}:{row:LocalRow;selected:boolean;onSelect:(v:boolean)=>void;users:ReturnType<typeof useUsers>;me:string;busy:boolean;apply:(p:Record<string,unknown>)=>Promise<void>}){
 const [owner,setOwner]=useState(String(row.assigneeId??'')),[date,setDate]=useState(String(row.dueDate??'')),[draft,setDraft]=useState(''),[copyError,setCopyError]=useState('');
 useEffect(()=>setOwner(String(row.assigneeId??'')),[row.assigneeId]);useEffect(()=>setDate(String(row.dueDate??'')),[row.dueDate]);
 return <article className="min-w-0 space-y-3 rounded-lg border border-neutral-200 p-2 sm:p-3 dark:border-neutral-700">
  <label className="flex min-h-11 min-w-0 items-start gap-3"><input type="checkbox" className="mt-1 shrink-0" checked={selected} disabled={busy} onChange={e=>onSelect(e.target.checked)}/><span className="min-w-0 break-words font-medium">{String(row.title??'Untitled submission')}</span></label>
  <p className="break-words text-sm text-neutral-600 dark:text-neutral-400">Owner: {users.find(u=>u.id===row.assigneeId)?.name||(row.assigneeId?'Unavailable user':'Unassigned')} · Follow-up: {String(row.dueDate||'None')}</p>
  <div className="flex flex-wrap gap-3"><Link className="inline-flex min-h-11 items-center underline" to={`/boards/${WEBSITE_INBOX_ID}/tasks/${encodeURIComponent(row.id)}`}>Open answers</Link><Button className="h-auto min-h-11 py-2" disabled={busy||!me} onClick={()=>void apply({assigneeId:me})}>Assign to me</Button><Button className="h-auto min-h-11 py-2" disabled={busy} onClick={()=>void apply({status:'replied'})}>Mark replied</Button><Button className="h-auto min-h-11 py-2" disabled={busy} onClick={()=>void apply({status:'done'})}>Done</Button></div>
  <details><summary className="min-h-11 cursor-pointer py-2 font-medium">Owner, follow-up and reply draft</summary><fieldset disabled={busy} className="mt-2 min-w-0 space-y-3">
   <label className="block text-sm">Assign owner<Select aria-label="Response owner" className="h-auto min-h-11 w-full min-w-0" value={owner} onChange={e=>setOwner(e.target.value)}><option value="">Unassigned</option>{users.map(u=><option key={u.id} value={u.id}>{u.name||u.username}</option>)}{!!owner&&!users.some(u=>u.id===owner)&&<option value={owner}>Unavailable user</option>}</Select></label><Button className="h-auto min-h-11 py-2" onClick={()=>void apply({assigneeId:owner||null})}>Save owner</Button>
   <label className="block text-sm">Follow-up date<Input aria-label="Response follow-up date" type="date" className="h-auto min-h-11 w-full min-w-0" value={date} onChange={e=>setDate(e.target.value)}/></label><Button className="h-auto min-h-11 py-2" onClick={()=>void apply({dueDate:date||null})}>Save follow-up</Button>
   <label className="block text-sm">Reply draft<textarea className="mt-1 min-h-28 w-full min-w-0 rounded-lg border border-neutral-300 bg-transparent p-3 text-base dark:border-neutral-600" value={draft} onChange={e=>setDraft(e.target.value)} /></label>
   <p className="text-xs text-neutral-600 dark:text-neutral-400">Read the full answers first. You can request a draft with your assistant’s draft_reply prompt; paste and review it here. Copying does not send email or mark a reply.</p>
   <AskAiMenu modules={['inbox']} refs={{record:{kind:'record',id:row.id}}} label="Reply assistant"/>
   <Button className="h-auto min-h-11 py-2" disabled={!draft} onClick={()=>{setCopyError('');void navigator.clipboard.writeText(draft).then(()=>setCopyError('Draft copied. Nothing was sent.')).catch(()=>setCopyError('Copy is unavailable. Select the draft text and copy it with your device controls.'));}}>Copy draft</Button>{copyError&&<p role="status" className="text-sm">{copyError}</p>}
  </fieldset></details>
 </article>;
}
