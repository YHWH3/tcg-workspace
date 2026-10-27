/** Device-local observations only. No queue state proves server receipt. */
export interface SyncObservations {userId:string;lastPushAt:number|null;lastPullAt:number|null}
export interface ReliabilityInput {
 pending:number;rejected:number;held:number;pendingUploads:number;failedUploads:number;uploading:number;
 oldestPendingAt:number|null;unknownPendingAge:boolean;observations:SyncObservations|null;connected:boolean;online:boolean;
}
export function deriveReliability(input:ReliabilityInput,now:number){
 const count=(v:number)=>Number.isSafeInteger(v)&&v>=0?v:0;
 const validTime=(v:number|null|undefined)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v<=now?v:null;
 const pending=count(input.pending),rejected=count(input.rejected),held=count(input.held),pendingUploads=count(input.pendingUploads),failedUploads=count(input.failedUploads),uploading=Math.min(count(input.uploading),pendingUploads);
 const oldest=validTime(input.oldestPendingAt),oldestAgeMs=oldest===null?null:Math.max(0,now-oldest);
 const attention=rejected>0||held>0||failedUploads>0||(pending+pendingUploads>0&&(oldestAgeMs!==null&&oldestAgeMs>=120000||input.unknownPendingAge));
 return {pending,rejected,held,pendingUploads:pendingUploads-uploading,uploading,failedUploads,oldestAgeMs,unknownPendingAge:input.unknownPendingAge,
 lastPushAt:validTime(input.observations?.lastPushAt),lastPullAt:validTime(input.observations?.lastPullAt),connected:input.connected,online:input.online,attention,
 state:rejected+held+failedUploads>0?'needs_review':pending+pendingUploads>0?'pending':input.online?'up_to_date':'offline' as string};
}
export function pendingEnqueuedAt(entry:{enqueuedAt?:unknown;ts?:unknown},now:number):number|null{
 const value=entry.enqueuedAt??entry.ts;return typeof value==='number'&&Number.isSafeInteger(value)&&value>0&&value<=now?value:null;
}
