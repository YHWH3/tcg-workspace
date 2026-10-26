import {useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {type BundledTemplate,type PackUpgradePlan} from '../../shared/bundled';
import {localPackUpgrade,applyLocalPackUpgrade} from './packUpgrades';
import {AdaptiveDialog,Button} from './ui';
export function PackUpgradeControl({bundle}:{bundle:BundledTemplate}){
 const [retry,setRetry]=useState(0);
 const loaded=useLiveQuery(async()=>{try{return {plan:await localPackUpgrade(bundle),error:null};}catch(e){return {plan:null,error:e instanceof Error?e.message:'Pack preview could not be loaded.'};}},[bundle,retry]);
 const available=loaded?.plan;
 const [preview,setPreview]=useState<PackUpgradePlan|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState(false);
 if(loaded?.error)return <div className="space-y-2 text-sm"><p role="alert">{loaded.error}</p><Button variant="secondary" onClick={()=>setRetry(n=>n+1)}>Retry pack preview</Button></div>;
 if(!available?.rootPageId)return null;
 const refresh=async()=>{setError('');setDone(false);setPreview(await localPackUpgrade(bundle));};
 return <>
  {(available.writes.length>0||available.warnings.length>0)&&<Button variant="secondary" onClick={()=>void refresh().catch(e=>setError(String(e)))}>Update available ({available.writes.length} changes)</Button>}
  {error&&!preview&&<p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
  {done&&<p role="status" className="text-sm">Pack update synced.</p>}
  {preview&&<AdaptiveDialog title={`Update ${bundle.name}`} onClose={()=>{if(!busy)setPreview(null);}} guard={()=>!busy}>
   <div className="space-y-4 text-sm">
    <p>Additions preserve existing names, filters, stage columns, records and deleted items. Connect to apply this update.</p>
    <p>Version {preview.version} · {preview.writes.length} changes</p>
    {preview.warnings.map(w=><p key={w} role="alert">{w}</p>)}
    <ol className="list-decimal space-y-2 pl-5">{preview.writes.map(w=><li key={w.collection+':'+w.id}>{w.reason}</li>)}</ol>
    {error&&<p role="alert" className="text-red-700 dark:text-red-400">{error} Applied additions remain saved; preview again to continue.</p>}
    <div className="flex flex-wrap justify-end gap-2">
     <Button variant="secondary" disabled={busy} onClick={()=>setPreview(null)}>Cancel</Button>
     <Button variant="secondary" disabled={busy} onClick={()=>void refresh().catch(e=>setError(String(e)))}>Refresh preview</Button>
     <Button disabled={busy||!preview.writes.length||!!preview.warnings.length} onClick={async()=>{setBusy(true);setError('');try{await applyLocalPackUpgrade(bundle,preview);setPreview(null);setDone(true);}catch(e){setError(e instanceof Error?e.message:'Update interrupted. Retry when connected.');}finally{setBusy(false);}}}>{busy?'Applying and syncing…':'Apply update'}</Button>
    </div>
   </div>
  </AdaptiveDialog>}
 </>;
}
