import type {LocalDB} from './db';
import {deriveReliability,pendingEnqueuedAt,type SyncObservations} from '../../shared/reliability';
import {SYNC_OBSERVATIONS_KEY} from './sync/observations';
export interface UploadSummary {id:string;name:string;state:'pending'|'uploading'|'failed'}
/** Read names and queue metadata, never retain edits/held payloads or file bytes. */
export async function readReliability(store:LocalDB,userId:string,now:number,options:{uploading:readonly string[];connected:boolean;online:boolean},assertCurrent:()=>void){
 assertCurrent();if(store.name!==`workspace-${userId}`)throw new Error('account_changed');
 return store.transaction('r',store.outbox,store.blobs,store.files,store.accessQuarantineInfo,store.meta,async()=>{
  assertCurrent();let pending=0,rejected=0,oldestPendingAt:number|null=null,unknownPendingAge=false;
  const observe=(at:number|null)=>{if(at===null)unknownPendingAge=true;else oldestPendingAt=oldestPendingAt===null?at:Math.min(oldestPendingAt,at);};
  await store.outbox.each(entry=>{if((entry.state??'pending')==='pending'){pending++;observe(pendingEnqueuedAt(entry,now));}else rejected++;});
  const [pendingIds,failedIds,held,meta]=await Promise.all([
   store.blobs.where('state').equals('pending').primaryKeys(),store.blobs.where('state').equals('failed').primaryKeys(),
   store.accessQuarantineInfo.count(),store.meta.get(SYNC_OBSERVATIONS_KEY),
  ]);
  const ids=[...failedIds,...pendingIds].slice(0,20),files=await store.files.bulkGet(ids);
  const uploading=new Set(options.uploading),failed=new Set(failedIds);
  const uploads:UploadSummary[]=ids.map((id,i)=>({id,name:files[i]?.deleted?'Unavailable attachment':String(files[i]?.name??'Attachment').slice(0,200),state:failed.has(id)?'failed':uploading.has(id)?'uploading':'pending'}));
  pendingIds.forEach(id=>{const file=files[ids.indexOf(id)];observe(file?pendingEnqueuedAt({ts:file.createdAt},now):null);});
  const observations=meta?.value as SyncObservations|undefined;assertCurrent();
  return {...deriveReliability({pending,rejected,held,pendingUploads:pendingIds.length,failedUploads:failedIds.length,uploading:pendingIds.filter(id=>uploading.has(id)).length,oldestPendingAt,unknownPendingAge,observations:observations?.userId===userId?observations:null,connected:options.connected,online:options.online},now),uploads,uploadsPartial:pendingIds.length+failedIds.length>20,asOf:now};
 });
}
/** Retry is explicit and bounded. Missing bytes never become an empty upload. */
export async function retryFailedUploads(store:LocalDB,userId:string,assertCurrent:()=>void){
 assertCurrent();if(store.name!==`workspace-${userId}`)throw new Error('account_changed');
 return store.transaction('rw',store.blobs,store.files,async()=>{
  const ids=(await store.blobs.where('state').equals('failed').primaryKeys()).slice(0,20);let retried=0,unavailable=0;
  for(const id of ids){assertCurrent();const row=await store.blobs.get(id),file=await store.files.get(id);assertCurrent();
   if(!row||row.state!=='failed')continue;
   if(!file||file.deleted||row.blob.size!==file.size||row.blob.size===0&&row.error==='Browser could not store the attachment'){unavailable++;continue;}
   await store.blobs.update(id,{state:'pending',error:undefined,pendingSince:row.pendingSince??Date.now()});retried++;
  }
  assertCurrent();return {retried,unavailable,more:(await store.blobs.where('state').equals('failed').count())>unavailable};
 });
}
