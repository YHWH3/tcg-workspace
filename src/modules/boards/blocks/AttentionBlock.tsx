import {useState} from 'react';
import {Link} from 'react-router';
import {Bell,CheckCircle,Clock,ShieldCheck,UserPlus} from 'lucide-react';
import {ATTENTION_KINDS,isAttentionKind,type AttentionItem,type AttentionKind} from '../../../../shared/attention';
import {planAttentionAction} from '../../../../shared/attentionActions';
import {useAttention,refreshAttention} from '../../../core/attention';
import {authStore} from '../../../core/auth';
import {getToken} from '../../../core/api';
import {db} from '../../../core/db';
import {accessClientStore,assertClientMutationReady} from '../../../core/accessClient';
import {workspaceLocale} from '../../../core/workspaceLocale';
import {mutate} from '../../../core/sync/engine';
import {logActivity} from '../../../core/activity';
import {useUsers,resolveUser} from '../../../core/users';
import {useStore} from '../../../core/store';
import {Button,Field,Select} from '../../../core/ui';
import {safeInternalPath} from '../../../core/assistant/contextPaths';
import {registerBlockType,type MediaBlockProps} from '../../pages/blocks/registry';
import {GateMoveDialog,type GateAttempt} from '../GateMove';
import {DashBlock,HeadingField,saveBlockCfg,str} from './shared';
export const ATTENTION_LABELS:Record<AttentionKind,string>={approval_pending:'Approval needed',ai_preview_pending:'AI changes to review',suggestion_pending:'Suggestion to review',record_overdue:'Overdue',record_due_today:'Due today',record_due_soon:'Due soon',record_unassigned:'Unassigned',website_aging:'Awaiting a reply',mention_unread:'Unread mention',automation_failed:'Automation failed'};
const actionClass='inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 dark:text-neutral-200 dark:hover:bg-neutral-800';
export function AttentionContent({limit=10,kinds=[],compact=false}:{limit?:number;kinds?:AttentionKind[];compact?:boolean}){
 const state=useAttention(),me=useStore(authStore).user,users=useUsers();
 const [busy,setBusy]=useState<string|null>(null),[message,setMessage]=useState(''),[error,setError]=useState(''),[attempt,setAttempt]=useState<GateAttempt|null>(null),[savedKeys,setSavedKeys]=useState<Set<string>>(new Set());
 const items=(state.page?.items??[]).filter(i=>!kinds.length||kinds.includes(i.kind)),shown=items.slice(0,limit);
 const act=async(item:AttentionItem,action:'assign_me'|'mark_done')=>{
  setBusy(item.key);setError('');setMessage('');
  const uid=me?.id,token=getToken(),epoch=accessClientStore.get().epoch;
  try{
   assertClientMutationReady();if(!uid||!token)throw new Error('Sign in again before editing.');
   const [record,board]=await Promise.all([db.tasks.get(item.targetId),db.boards.get(item.databaseId??'')]);
   if(authStore.get().user?.id!==uid||getToken()!==token||accessClientStore.get().epoch!==epoch)throw new Error('Access changed. Refresh attention.');
   if(!record||!board)throw new Error('Open the record to load its current details before editing.');
   const plan=planAttentionAction(item,action,record,board,uid,workspaceLocale.get().today);
   await mutate('tasks',record.id,plan.patch,plan.guard);
   logActivity(action==='assign_me'?'assigned':'completed','task',record.id,String(record.title??'Record'),action==='assign_me'?{personKey:Object.keys(plan.patch)[0],assigneeId:uid}:{status:plan.patch.status});
   if(plan.gateStage)setAttempt({taskId:record.id,boardId:board.id,stageId:plan.gateStage});
   setSavedKeys(s=>new Set([...s,item.key]));
   setMessage(plan.gateStage?'Saved on this device. This move needs approval before the server can accept it.':'Saved on this device. Sync will confirm the server change.');
   window.dispatchEvent(new Event('ws-records-changed'));
  }catch(e){setError(e instanceof Error?e.message:'This change could not be saved.');}finally{setBusy(null);}
 };
 return <section aria-label="Needs attention" className="min-w-0 space-y-3 text-neutral-900 dark:text-neutral-100">
  <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Needs attention</h3><Button className="h-auto min-h-11 py-2" onClick={()=>void refreshAttention()} disabled={state.loading||state.offline}>{state.loading?'Refreshing…':'Refresh'}</Button></div>
  <div role="status" className="space-y-1 text-xs text-neutral-600 dark:text-neutral-400">
   {state.page&&<p>As of {new Date(state.page.asOf).toLocaleString()}{state.offline?' (offline)':state.stale?' (saved snapshot)':''}</p>}
   {state.offline&&<p>Reconnect to refresh. Record changes can still save on this device.</p>}
   {!state.page&&state.loading&&<p>Loading attention…</p>}
   {state.cacheError&&<p>This result could not be saved for offline use.</p>}
   {(state.page?.partial||state.page?.nextCursor)&&<p>Some items may be missing. Refresh to check for updates.</p>}
   {message&&<p>{message}</p>}
  </div>
  {(error||state.error)&&<p role="alert" className="text-sm text-red-700 dark:text-red-300">{error||state.error}</p>}
  {!state.loading&&!state.page&&!state.error&&<p className="text-sm text-neutral-600 dark:text-neutral-400">{state.offline?'No saved attention snapshot is available. Reconnect to load it.':'Attention is unavailable until access is checked.'}</p>}
  {state.page&&!shown.length&&<p className="py-3 text-sm text-neutral-600 dark:text-neutral-400">No items in this snapshot need your attention{ kinds.length?' for these sources':''}.</p>}
  <ul className="space-y-2">{shown.map(item=>{
   const href=safeInternalPath(item.url),owner=resolveUser(item.ownerId,users,me),Icon=item.kind==='approval_pending'?ShieldCheck:item.kind==='record_unassigned'?UserPlus:item.severity>=1?Clock:Bell;
   const primary=item.actions.includes('decide')?'Decide':item.actions.includes('review')?'Review':'Open';
   const saved=savedKeys.has(item.key);
   return <li key={item.key} className="flex min-w-0 flex-wrap items-start gap-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-700">
    <Icon size={16} aria-hidden className="mt-1 shrink-0"/>
    <div className="min-w-0 flex-1 basis-40 space-y-1">
     <p className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{ATTENTION_LABELS[item.kind]}</p>
     {href?<Link className="block min-h-11 break-words py-2 text-sm font-medium underline decoration-neutral-300 underline-offset-4 focus-visible:outline-2 dark:decoration-neutral-600" to={href}>{item.title||'Untitled'}</Link>:<p className="break-words text-sm">{item.restricted?'Restricted item':item.title||'Untitled'}</p>}
     {!compact&&<p className="break-words text-xs text-neutral-600 dark:text-neutral-400">{[item.databaseName,item.date,item.ageDays?`${item.ageDays} days old`:null,owner?.name??(item.ownerId?'Member':item.kind==='record_unassigned'?'Unassigned':null)].filter(Boolean).join(' · ')}</p>}
     {saved&&<p className="flex items-center gap-1 text-xs text-neutral-600 dark:text-neutral-400"><CheckCircle size={13} aria-hidden/>Change saved locally; awaiting refreshed server state</p>}
    </div>
    <div className="flex max-w-full flex-wrap gap-2">
     {href&&(item.actions.includes('review')||item.actions.includes('decide'))&&(state.offline?<span className="py-3 text-xs text-neutral-600 dark:text-neutral-400">Reconnect to {primary.toLowerCase()}</span>:<Link className={actionClass} to={href}>{primary}</Link>)}
     {(['assign_me','mark_done'] as const).filter(action=>item.actions.includes(action)).map(action=><Button key={action} className="h-auto min-h-11 py-2" disabled={busy!==null||saved} onClick={()=>void act(item,action)}>{busy===item.key?'Saving…':action==='assign_me'?'Assign to me':'Mark done'}</Button>)}
    </div>
   </li>;
  })}</ul>
  {items.length>shown.length&&<p className="text-xs text-neutral-600 dark:text-neutral-400">Showing {shown.length} of {items.length} loaded items. Increase the block limit to see more.</p>}
  {attempt&&<GateMoveDialog attempt={attempt} onClose={()=>setAttempt(null)}/>}
 </section>;
}
function AttentionConfigure({block}:Pick<MediaBlockProps,'block'>){
 const [draft,setDraft]=useState(()=>({limit:[5,10,20].includes(Number(block.limit))?Number(block.limit):10,compact:block.compact===true,kinds:Array.isArray(block.kinds)?block.kinds.filter(isAttentionKind):[]}));
 const [error,setError]=useState('');
 const save=(patch:Partial<typeof draft>)=>{
  setDraft(s=>({...s,...patch}));setError('');
  void mutate('blocks',block.id,patch).catch(()=>setError('These settings could not be saved. Close and reopen configuration to retry.'));
 };
 return <>
  <HeadingField value={str(block.heading)} onChange={v=>saveBlockCfg(block,{heading:v??null})}/>
  <Field label="Maximum items"><Select aria-label="Attention item limit" value={draft.limit} onChange={e=>save({limit:Number(e.target.value)})}>{[5,10,20].map(n=><option key={n} value={n}>{n}</option>)}</Select></Field>
  <Field label="Density"><Select aria-label="Attention density" value={draft.compact?'compact':'full'} onChange={e=>save({compact:e.target.value==='compact'})}><option value="full">Full</option><option value="compact">Compact</option></Select></Field>
  <fieldset><legend className="font-medium">Sources (none selected means all)</legend>{ATTENTION_KINDS.map(kind=><label key={kind} className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={draft.kinds.includes(kind)} onChange={e=>save({kinds:e.target.checked?[...draft.kinds,kind]:draft.kinds.filter(k=>k!==kind)})}/>{ATTENTION_LABELS[kind]}</label>)}</fieldset>
  {error&&<p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
 </>;
}
export function AttentionBlock({block}:MediaBlockProps){
 const limit=[5,10,20].includes(Number(block.limit))?Number(block.limit):10,kinds=Array.isArray(block.kinds)?block.kinds.filter(isAttentionKind):[];
 return <DashBlock block={block} icon={Bell} label="Attention" config={<AttentionConfigure block={block}/>}>
  {()=> <AttentionContent limit={limit} kinds={kinds} compact={block.compact===true}/>}
 </DashBlock>;
}
registerBlockType('attention','Attention',AttentionBlock);
export default AttentionBlock;
