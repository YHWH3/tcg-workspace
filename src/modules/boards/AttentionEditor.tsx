import {useId,useState} from 'react';
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
 const [before,setBefore]=useState<Record<string,unknown>>(()=>structuredClone({attention:board.attention??null,fields:board.fields??null}));
 const [draft,setDraft]=useState<AttentionConfig>(current??{enabled:false,personKey:'assigneeId',soonDays:3,triage:false,triagers:'admins'});
 const [error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const fields=fieldsOf(board),daysId=useId(),daysErrorId=useId();
 const [days,setDays]=useState(String(current?.soonDays??3));
 const daysValid=days.trim()!==''&&Number.isInteger(Number(days))&&Number(days)>=0&&Number(days)<=30;
 const save=async()=>{
  setError('');setMessage('');
  if(!daysValid){setError('Enter a whole number from 0 to 30.');document.getElementById(daysId)?.focus();return;}
  setBusy(true);
  try{
   const latest=await db.boards.get(board.id);if(!latest||latest.deleted)throw new Error('Database is unavailable.');
   const attention=validateAttentionConfig({...draft,soonDays:Number(days)},latest);
   await mutate('boards',board.id,{attention},{fields:before});
   setBefore(structuredClone({attention,fields:latest.fields??null}));
   setMessage('Saved on this device. Sync will confirm the server change.');void refreshAttention();
  }catch(e){setError(e instanceof Error&&e.message.startsWith('invalid_attention_')?'These fields changed. Choose current person and date fields.':e instanceof Error&&e.message.startsWith('Pack source changed')?'Database settings changed. Close and reopen this sheet before saving.':e instanceof Error?e.message:'Attention settings could not be saved.');}finally{setBusy(false);}
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
  <Field label="Upcoming window (days)"><Input aria-label="Upcoming window (days)" id={daysId} aria-invalid={!!error&&!daysValid} aria-describedby={error&&!daysValid?daysErrorId:undefined} type="number" step={1} min={0} max={30} value={days} onChange={e=>setDays(e.target.value)}/></Field>
  <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={draft.triage===true} onChange={e=>setDraft(s=>({...s,triage:e.target.checked}))}/> Include unassigned work for triage</label>
  {draft.triage&&<>
   <Field label="Triagers"><Select aria-label="Attention triagers" value={Array.isArray(draft.triagers)?'selected':'admins'} onChange={e=>setDraft(s=>({...s,triagers:e.target.value==='admins'?'admins':[]}))}><option value="admins">All admins</option><option value="selected">Selected members</option></Select></Field>
   {Array.isArray(draft.triagers)&&<fieldset className="space-y-1"><legend className="text-sm font-medium">Selected triagers</legend>{users.map(u=><label key={u.id} className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={(draft.triagers as string[]).includes(u.id)} disabled={u.disabled&&!(draft.triagers as string[]).includes(u.id)} onChange={e=>setDraft(s=>({...s,triagers:e.target.checked?[...(Array.isArray(s.triagers)?s.triagers:[]),u.id]:(s.triagers as string[]).filter(id=>id!==u.id)}))}/>{u.name}{u.disabled?' (disabled)':''}</label>)}{draft.triagers.filter(id=>!users.some(u=>u.id===id)).map(id=><label key={id} className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked onChange={()=>setDraft(s=>({...s,triagers:(s.triagers as string[]).filter(v=>v!==id)}))}/>Unavailable member (remove from triage)</label>)}</fieldset>}
  </>}
  <p role="status" className="text-sm">{message}</p>{error&&<p id={daysErrorId} role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
  <Button className="h-auto min-h-11 py-2" disabled={busy} onClick={()=>void save()}>{busy?'Saving…':'Save attention settings'}</Button>
 </div>;
}
