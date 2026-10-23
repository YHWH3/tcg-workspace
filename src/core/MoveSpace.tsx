import {useState} from 'react';
import {useStore} from './store';
import {accessClientStore} from './accessClient';
import {api} from './api';
import {syncNow} from './sync/engine';
import type {LocalRow} from './db';
import {AdaptiveDialog,Button} from './ui';
/** Uses the existing atomic closure move; generic mutations cannot change scope. */
export function MoveSpaceButton({root}:{root:LocalRow}){
 const access=useStore(accessClientStore),[open,setOpen]=useState(false),[destination,setDestination]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 if(access.manifest?.protocol!==3||access.status!=='ready'||['board-default','board-inbox','board-website-inbox'].includes(root.id))return null;
 const spaces=access.manifest.spaces.filter(s=>['editor','admin','owner'].includes(s.role)),source=spaces.find(s=>s.id===root._spaceId);
 if(!source||spaces.length<2)return null;
 async function move(){setBusy(true);setMessage('');try{await api('/api/spaces/move',{method:'POST',body:{recordId:root.id,toSpaceId:destination,expectedRev:root._serverRev,requestId:crypto.randomUUID()}});await syncNow();setOpen(false);}catch(e){setMessage(e instanceof Error?e.message:'Move interrupted. Refresh the record before retrying.');}finally{setBusy(false);}}
 return <><Button size="sm" onClick={()=>{setDestination('');setMessage('');setOpen(true);}}>Move space</Button>{open&&<AdaptiveDialog title="Move to another space" onClose={()=>!busy&&setOpen(false)}><div className="space-y-3 p-4"><p>Move {String(root.title??root.name??'this item')} and its owned content from {source.name}. Access will follow the destination; relations require access to both endpoints.</p><label>Destination space<select aria-label="Destination space" className="block w-full rounded border p-2 dark:bg-neutral-900" value={destination} onChange={e=>setDestination(e.target.value)}><option value="">Choose a destination</option>{spaces.filter(s=>s.id!==source.id).map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label><p role="status">{message}</p><div className="flex flex-wrap gap-2"><Button disabled={busy||!destination||!root._serverRev} onClick={()=>void move()}>Confirm space move</Button><Button disabled={busy} onClick={()=>setOpen(false)}>Cancel</Button></div></div></AdaptiveDialog>}</>;
}
