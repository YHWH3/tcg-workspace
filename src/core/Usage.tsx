import {useState} from 'react';
import {api} from './api';
import {db} from './db';
import {authStore} from './auth';
import {trimDownloadedCache} from './cacheBudget';
import {Button} from './ui';
export function Usage(){const [data,setData]=useState<unknown>(null),[local,setLocal]=useState<unknown>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 async function run(fn:()=>Promise<void>){setBusy(true);setMessage('');try{await fn();}catch(e){setMessage(e instanceof Error?e.message:'Usage unavailable');}finally{setBusy(false);}}
 return <div className="space-y-3"><p>Archives and soft-deleted records remain recoverable. Attachment byte reclamation is irreversible. History and held offline work are retained; automatic permanent purge is disabled.</p><Button disabled={busy} onClick={()=>void run(async()=>{const estimate=await navigator.storage?.estimate();setLocal({originStorage:estimate,pendingWrites:await db.outbox.count(),heldWork:await db.accessQuarantineInfo.count(),cachedDownloads:await db.blobs.where('state').equals('cached').count()});})}>Measure this device</Button><Button disabled={busy} onClick={()=>void run(async()=>{const uid=authStore.get().user?.id;if(!uid)throw new Error('Sign in first');const r=await trimDownloadedCache(db,uid,0);setMessage(`Cleared ${r.removed} downloaded cache files (${r.removedBytes} bytes). ${r.more?'More remain; run again.':'Pending and original files are preserved.'}`);})}>Clear downloaded cache (up to 50 files)</Button><Button disabled={busy} onClick={()=>void run(async()=>setData(await api('/api/admin/usage')))}>Measure server usage (administrators)</Button>{local!==null&&<pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(local,null,2)}</pre>}{data!==null&&<pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(data,null,2)}</pre>}<p role="status">{message}</p></div>;
}
