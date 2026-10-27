import {useState} from 'react';
import {attentionConfig,validateAttentionConfig,type AttentionConfig} from '../../../shared/attention';
import {fieldsOf} from '../../../shared/fields';
import {Button,Field,Input,Select} from '../../core/ui';
import {mutate} from '../../core/sync/engine';
import {db} from '../../core/db';
import {refreshAttention} from '../../core/attention';
import {useUsers} from '../../core/users';
import type {BoardRow} from './api';
export function AttentionEditor({board}:{board:BoardRow}){
 const current=attentionConfig(board),users=useUsers();
 const [draft,setDraft]=useState<AttentionConfig>(current??{enabled:false,personKey:'assigneeId',soonDays:3,triage:false,triagers:'admins'});
 const [error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const fields=fieldsOf(board);
 const save=async()=>{
  setError('');setMessage('');setBusy(true);
  try{
   const latest=await db.boards.get(board.id);if(!latest||latest.deleted)throw new Error('Database is unavailable.');
   const attention=validateAttentionConfig(draft,latest);
   await mutate('boards',board.id,{attention},{fields:{attention:board.attention??null,fields:board.fields??null}});
   setMessage('Saved on this device. Sync will confirm the server change.');void refreshAttention();
  }catch(e){setError(e instanceof Error?e.message:'Attention settings could not be saved.');}finally{setBusy(false);}
 };
 return <div className="space-y-4 overflow-y-auto p-4">
  <h2 className="text-base font-semibold">Attention</h2>
  <p className="text-sm text-neutral-600 dark:text-neutral-400">Choose whose work appears in attention and which dates need a response. Access permissions still apply.</p>
  {!current&&<p role="status" className="text-sm">The saved configuration refers to unavailable fields. Choose current fields and save to repair it.</p>}
  <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={draft.enabled} onChange={e=>setDraft(s=>({...s,enabled:e.target.checked}))}/> Include this database</label>
  <Field label="Person field"><Select aria-label="Attention person field" value={draft.personKey} onChange={e=>setDraft(s=>({...s,personKey:e.target.value as AttentionConfig['personKey']}))}>
   <option value="assigneeId">Assignee</option>{fields.filter(f=>f.type==='person').map(f=><option key={f.id} value={`p_${f.id}`}>{f.name}</option>)}
  </Select></Field>
  <Field label="Date field"><Select aria-label="Attention date field" value={draft.dateKey??''} onChange={e=>setDraft(s=>({...s,dateKey:e.target.value?e.target.value as AttentionConfig['dateKey']:undefined}))}>
   <option value="">No dated items</option><option value="dueDate">Due date</option>{fields.filter(f=>f.type==='date').map(f=><option key={f.id} value={`p_${f.id}`}>{f.name}</option>)}
  </Select></Field>
  <Field label="Upcoming window (days)"><Input aria-label="Upcoming window (days)" type="number" min={0} max={30} value={draft.soonDays??3} onChange={e=>setDraft(s=>({...s,soonDays:Number(e.target.value)}))}/></Field>
  <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={draft.triage===true} onChange={e=>setDraft(s=>({...s,triage:e.target.checked}))}/> Include unassigned work for triage</label>
  {draft.triage&&<>
   <Field label="Triagers"><Select aria-label="Attention triagers" value={Array.isArray(draft.triagers)?'selected':'admins'} onChange={e=>setDraft(s=>({...s,triagers:e.target.value==='admins'?'admins':[]}))}><option value="admins">All admins</option><option value="selected">Selected members</option></Select></Field>
   {Array.isArray(draft.triagers)&&<fieldset className="space-y-1"><legend className="text-sm font-medium">Selected triagers</legend>{users.filter(u=>!u.disabled).map(u=><label key={u.id} className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={(draft.triagers as string[]).includes(u.id)} onChange={e=>setDraft(s=>({...s,triagers:e.target.checked?[...(Array.isArray(s.triagers)?s.triagers:[]),u.id]:(s.triagers as string[]).filter(id=>id!==u.id)}))}/>{u.name}</label>)}</fieldset>}
  </>}
  <p role="status" className="text-sm">{message}</p>{error&&<p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
  <Button className="h-auto min-h-11 py-2" disabled={busy} onClick={()=>void save()}>{busy?'Saving…':'Save attention settings'}</Button>
 </div>;
}
