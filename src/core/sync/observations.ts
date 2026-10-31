import type {LocalDB} from '../db';
import type {SyncObservations} from '../../../shared/reliability';
export const SYNC_OBSERVATIONS_KEY='sync-observations-v1';
/** An identity-fenced, monotonic observation. Never manufactures a push receipt. */
export async function recordSyncObservation(store:LocalDB,userId:string,kind:'push'|'pull',at:number,assertCurrent:()=>void){
 assertCurrent();if(store.name!==`workspace-${userId}`)throw new Error('account_changed');
 if(!Number.isSafeInteger(at)||at<=0)throw new Error('invalid_sync_observation');
 await store.transaction('rw',store.meta,async()=>{
  assertCurrent();const previous=(await store.meta.get(SYNC_OBSERVATIONS_KEY))?.value as SyncObservations|undefined;assertCurrent();
  const valid=(v:unknown):number|null=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0?v:null;
  const next:SyncObservations={userId,lastPushAt:previous?.userId===userId?valid(previous.lastPushAt):null,lastPullAt:previous?.userId===userId?valid(previous.lastPullAt):null};
  const key=kind==='push'?'lastPushAt':'lastPullAt';next[key]=Math.max(next[key]??0,at);
  await store.meta.put({key:SYNC_OBSERVATIONS_KEY,value:next});assertCurrent();
 });
}
