import type {AppliedChange} from './sync';
/** Structural authority/ownership fields cannot be restored as ordinary fields. */
export const historyField=(k:string)=>/^(title|name|text|body|description|caption|checked|archived|deleted|status|priority|dueDate|assigneeId|url|provider|p_[A-Za-z0-9_-]+)$/.test(k);
/** Capture the delta in the record's own atomic transaction. Bound individual
 * payloads; omitted fields remain explicit and cannot be restored from this entry. */
export function historyStatement(db:D1Database,it:AppliedChange,userId:string,source:string,changesetId:string|null,now:number){
 const before:Record<string,unknown>={},after:Record<string,unknown>={},omitted:string[]=[];let size=0;
 for(const k of it.fields){if(!historyField(k))continue;const a=it.after[k]??null,b=it.before[k]??null;const n=new TextEncoder().encode(JSON.stringify([k,a,b])).length;if(size+n>128000){omitted.push(k);continue;}size+=n;before[k]=b;after[k]=a;}
 return db.prepare(`INSERT INTO record_history(record_id,revision,collection,actor_id,source,changeset_id,space_id,peer_space_id,created_at,before_json,after_json,omitted_json)
 SELECT id,seq,collection,?,?,?,space_id,peer_space_id,?,?,?,? FROM records WHERE id=? AND changes()=1`)
 .bind(userId,source,changesetId,now,JSON.stringify(before),JSON.stringify(after),JSON.stringify(omitted),it.id);
}
