/** Source-derived snapshots carry no mutation authority. No session token is persisted. */
import {createStore} from './store';
import {isAttentionKind,type AttentionPage} from '../../shared/attention';
import {parseDateOnly} from '../../shared/dates';
import {safeInternalPath} from './assistant/contextPaths';
export interface AttentionContext {userId:string;token:string;access:string;epoch:number}
interface Snapshot {version:1;userId:string;sessionHash:string;access:string;page:AttentionPage}
export interface AttentionState {page:AttentionPage|null;loading:boolean;stale:boolean;offline:boolean;error:string|null;cacheError:boolean}
export interface AttentionCacheDeps {
 context:()=>AttentionContext|null;
 online:()=>boolean;
 request:()=>Promise<unknown>;
 read:(userId:string)=>Promise<unknown>;
 save:(userId:string,snapshot:Snapshot)=>Promise<unknown>;
 hash:(token:string)=>Promise<string>;
}
const initial=():AttentionState=>({page:null,loading:false,stale:true,offline:false,error:null,cacheError:false});
/** Bound both cached and network data before rendering; reject unsafe navigation. */
export function validAttentionPage(value:unknown):value is AttentionPage {
 if(!value||typeof value!=='object')return false;const p=value as AttentionPage;
 return Array.isArray(p.items)&&p.items.length<=50&&new Set(p.items.map(i=>i?.key)).size===p.items.length&&p.items.every(i=>
  i&&typeof i.key==='string'&&i.key.length<=256&&isAttentionKind(i.kind)&&typeof i.targetId==='string'&&typeof i.title==='string'&&i.title.length<=1000&&
  ['record','page','approval','preview','suggestion','automation'].includes(i.targetType)&&[0,1,2,3].includes(i.severity)&&
  (i.url===null||safeInternalPath(i.url)===i.url)&&Array.isArray(i.actions)&&i.actions.every(a=>['open','assign_me','decide','review','mark_done'].includes(a))&&
  (i.databaseName===undefined||typeof i.databaseName==='string'&&i.databaseName.length<=1000)&&
  (i.ownerId===undefined||i.ownerId===null||typeof i.ownerId==='string')&&
  (i.date===undefined||i.date===null||!!parseDateOnly(i.date))&&(i.ageDays===undefined||Number.isSafeInteger(i.ageDays)&&i.ageDays>=0)&&
  (!i.restricted||i.title===''&&i.url===null))&&
  typeof p.partial==='boolean'&&Array.isArray(p.partialSources)&&p.partialSources.length<=20&&p.partialSources.every(s=>typeof s==='string'&&s.length<=100)&&
  Number.isSafeInteger(p.asOf)&&p.asOf>0&&!!parseDateOnly(p.today)&&Number.isSafeInteger(p.urgentCount)&&p.urgentCount>=0&&typeof p.quietDigest==='boolean'&&
  (p.nextCursor===null||typeof p.nextCursor==='string'&&p.nextCursor.length<=2048);
}
const same=(a:AttentionContext|null,b:AttentionContext)=>!!a&&a.userId===b.userId&&a.token===b.token&&a.access===b.access&&a.epoch===b.epoch;
export function createAttentionCache(deps:AttentionCacheDeps){
 const store=createStore<AttentionState>(initial());let generation=0,pending:Promise<void>|null=null;
 const clear=()=>{generation++;pending=null;store.set(initial());};
 const refresh=():Promise<void>=>{
  if(pending)return pending;const ctx=deps.context();if(!ctx){clear();return Promise.resolve();}
  const epoch=generation,current=()=>epoch===generation&&same(deps.context(),ctx);
  const promise=(async()=>{
   store.set(s=>({...s,loading:deps.online(),offline:!deps.online(),error:null}));
   const sessionHash=await deps.hash(ctx.token);if(!current())return;
   // Cache load races the network deliberately; asOf prevents an older cache
   // from replacing a newly returned server snapshot.
   const cached=deps.read(ctx.userId).then(raw=>{
    if(!current())return;const s=raw as Snapshot|undefined;
    if(s?.version!==1||s.userId!==ctx.userId||s.sessionHash!==sessionHash||s.access!==ctx.access||!validAttentionPage(s.page))return;
    if(!store.get().page)store.set(state=>({...state,page:s.page,stale:true,offline:!deps.online()}));
   }).catch(()=>{});
   if(!deps.online()){await cached;if(current())store.set(s=>({...s,loading:false,offline:true}));return;}
   try{
    const result=await deps.request();if(!current())return;if(!validAttentionPage(result))throw new Error('Invalid attention response');
    const before=store.get().page;if(before&&before.asOf>result.asOf)return;
    store.set({page:result,loading:false,stale:false,offline:!deps.online(),error:null,cacheError:false});
    if(current())try{await deps.save(ctx.userId,{version:1,userId:ctx.userId,sessionHash,access:ctx.access,page:result});}catch{if(current())store.set(s=>({...s,cacheError:true}));}
   }catch(error){
    if(!current())return;
    const status=typeof error==='object'&&error!==null&&'status' in error?Number(error.status):0;
    // Authority failures must not leave a cached queue visible behind an error.
    if([401,403,409].includes(status)){generation++;store.set({...initial(),error:'Access changed. Reconnect and check access.'});return;}
    await cached;if(current())store.set(s=>({...s,loading:false,stale:true,offline:!deps.online(),error:'Attention could not refresh. Try again.'}));
   }
  })().catch(()=>{if(current())store.set(s=>({...s,loading:false,error:'Attention is unavailable.'}));}).finally(()=>{if(pending===promise)pending=null;});
  pending=promise;return promise;
 };
 return {store,refresh,clear,markStale:()=>store.set(s=>({...s,stale:true,offline:!deps.online()}))};
}
