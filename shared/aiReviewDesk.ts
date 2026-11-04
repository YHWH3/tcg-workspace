export interface PreviewSummary {id:string;tool:string;status:string;created_at:number;expires_at:number;workflow_id:string|null;changeset_id:string}
export function previewState(row:PreviewSummary,now:number){
 const expired=!Number.isFinite(row.expires_at)||row.expires_at<=now;
 const remaining=Math.max(0,Math.ceil((row.expires_at-now)/1000));
 const active=['pending','approved','executing'].includes(row.status);
 return {active,expired,label:expired?'Expired':`Expires in ${Math.floor(remaining/60)}m ${remaining%60}s`,action:expired?'Review expired proposal':row.status==='pending'?'Review proposed changes':['approved','executing'].includes(row.status)?'Resume / Review':'Review result'};
}
export function aiDeskLink(kind:'preview'|'suggestion',id:string){return `/ai?view=review#${kind}-${encodeURIComponent(id)}`;}
