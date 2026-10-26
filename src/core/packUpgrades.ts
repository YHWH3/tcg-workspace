import {db} from './db';
import {authStore} from './auth';
import {getToken} from './api';
import {mutate,syncNow} from './sync/engine';
import {planPackUpgrade,type BundledTemplate,type PackRecord,type PackUpgradePlan} from '../../shared/bundled';
import {installRecordId} from '../../shared/templates';
export async function localPackRecords(bundle:BundledTemplate):Promise<PackRecord[]>{
 const bags=['boards','pages','views','blocks'] as const;
 const result:PackRecord[]=[];
 // Exact authored ids plus database-key reuse. Do not scan every body in Dexie.
 const boards=await db.boards.toArray(),keys=new Set(Object.values(bundle.snapshot.boards).map(b=>b.key));
 for(const b of boards)if(keys.has(b.templateDbKey))result.push({id:b.id,collection:'boards',data:b});
 for(const collection of bags){
  const ids=Object.keys(bundle.snapshot[collection]??{}).map(id=>installRecordId(bundle.key,collection,id));
  const rows=await db.collection(collection).bulkGet(ids);
  for(const row of rows)if(row)result.push({id:row.id,collection,data:row});
 }
 const pageIds=[...new Set(result.filter(r=>r.collection==='pages').map(r=>r.id))];
 const boardIds=[...new Set(result.filter(r=>r.collection==='boards').map(r=>r.id))];
 for(const [collection,key,ids] of [['blocks','pageId',pageIds],['views','databaseId',boardIds]] as const){
  if(!ids.length)continue;
  const rows=await db.collection(collection).where(key).anyOf(ids).limit(2001).toArray();
  if(rows.length>2000)throw new Error('Pack inventory exceeds the bounded upgrade limit.');
  for(const row of rows)result.push({id:row.id,collection,data:row});
 }
 // Keys cover the legacy structural fallback only within known installed rows.
 const seen=new Set<string>();return result.filter(r=>!seen.has(r.id)&&!!seen.add(r.id));
}
export async function localPackUpgrade(bundle:BundledTemplate):Promise<PackUpgradePlan>{
 return planPackUpgrade(bundle,await localPackRecords(bundle),{now:Date.now(),actorId:authStore.get().user?.id});
}
async function settled(current:()=>void){
 const deadline=Date.now()+30000;
 while(Date.now()<deadline){
  current();if(!navigator.onLine)throw new Error('Connect to finish the pack update. Saved local changes remain available for retry.');
  const rows=await db.outbox.toArray();
  if(rows.some(r=>r.state==='rejected'))throw new Error('Some changes need review in sync recovery. Resolve them before updating the pack.');
  if(!rows.length)return;
  await syncNow();await new Promise(resolve=>setTimeout(resolve,150));
 }
 throw new Error('Changes are still syncing. Wait for sync, then preview the update again.');
}
export async function applyLocalPackUpgrade(bundle:BundledTemplate,preview:PackUpgradePlan):Promise<void>{
 const user=authStore.get().user?.id,token=getToken();
 const current=()=>{if(!user||authStore.get().user?.id!==user||getToken()!==token||db.name!==`workspace-${user}`)throw new Error('Account changed. Reopen the preview.');};
 current();if(!navigator.onLine)throw new Error('Connect to update this pack.');
 await syncNow();await settled(current);
 const fresh=await localPackUpgrade(bundle);
 // Compare the actual field guards and additive operations, ignoring generated
 // creation timestamps. A stale preview never changes its scope under the button.
 const signature=(p:PackUpgradePlan)=>JSON.stringify(p.writes.map(w=>({id:w.id,collection:w.collection,patch:{...w.patch,createdAt:undefined},before:w.before,reason:w.reason})));
 if(fresh.warnings.length||signature(fresh)!==signature(preview))throw new Error('Pack source changed. Refresh the preview before applying.');
 const marker=fresh.writes.find(w=>w.id===fresh.rootPageId&&Object.keys(w.patch).length===1&&w.patch.templateVersion!==undefined);
 const additions=fresh.writes.filter(w=>w!==marker);
 if(additions.length>450)throw new Error('This update exceeds the bounded client plan. Use a reviewed MCP upgrade.');
 const tables=[...new Set(additions.map(w=>db.collection(w.collection)))];
 // One local transaction keeps dependency rows together before the sync worker
 // can observe the outbox. Every write still uses mutate() and its guard.
 await db.transaction('rw',[...tables,db.outbox],async()=>{
  for(const w of additions){current();await mutate(w.collection,w.id,w.patch,w.before?{fields:w.before}:{absent:true});}
 });
 // Never mark the version complete while additions are rejected or unacknowledged.
 await syncNow();await settled(current);
 if(marker){current();await mutate(marker.collection,marker.id,marker.patch,{fields:marker.before!});await syncNow();await settled(current);}
}
