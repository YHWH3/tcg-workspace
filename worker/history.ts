import {Hono} from 'hono';
import {requireAuth,type AuthUser,type Env} from './auth';
import {createReadGate,editableBy,type ReadGate} from './readAccess';
import {levelSql} from './capability';
import {applyChanges} from './sync';
import {beginChangeset} from './changesets';
import {historyField} from './historyPersistence';
import {sha256Hex} from './password';
import {stableJson} from '../shared/stablejson';
export const historyApi=new Hono<{Bindings:Env;Variables:{user:AuthUser}}>();historyApi.use('*',requireAuth);
const visible=()=>`((SELECT enabled FROM access_state WHERE id=1)=0 OR (${levelSql('viewer.id','h.space_id')}>=1 AND (h.peer_space_id IS NULL OR ${levelSql('viewer.id','h.peer_space_id')}>=1)))`;
async function allowed(db:D1Database,uid:string,id:string){const d=await createReadGate(db,uid).decide([id]);return !d.enabled||d.readable.has(id);}
export class HistoryError extends Error {constructor(public code:string,public status:400|404|409){super(code);}}
export async function loadHistoryPage(db:D1Database,uid:string,id:string,before=Number.MAX_SAFE_INTEGER,limit=20,gate?:ReadGate,connector?:Env['CONNECTOR']){
 if(!Number.isSafeInteger(before)||before<1||!Number.isSafeInteger(limit)||limit<1||limit>50)throw new HistoryError('invalid_cursor',400);
 if(!await (gate?gate.canRead(id):allowed(db,uid,id)))throw new HistoryError('not_found',404);
 const connectorFilter=connector?` AND h.space_id IN(SELECT value FROM ai_connections g,json_each(g.spaces_json) WHERE g.id=? AND g.user_id=? AND g.revoked_at IS NULL AND g.expires_at>?) AND (h.peer_space_id IS NULL OR h.peer_space_id IN(SELECT value FROM ai_connections g,json_each(g.spaces_json) WHERE g.id=? AND g.user_id=? AND g.revoked_at IS NULL AND g.expires_at>?))`:'';
 const connectorBind=connector?[connector.id,uid,Date.now(),connector.id,uid,Date.now()]:[];
 const {results}=await db.prepare(`SELECT h.*,(SELECT name FROM users WHERE id=h.actor_id) actor_name FROM record_history h CROSS JOIN (SELECT ? AS id) viewer WHERE h.record_id=? AND h.revision<? AND ${visible()}${connectorFilter} ORDER BY revision DESC LIMIT ?`).bind(uid,id,before,...connectorBind,limit+1).all<{revision:number;before_json:string;after_json:string;omitted_json:string}>();
 const current=await db.prepare('SELECT seq FROM records WHERE id=?').bind(id).first<{seq:number}>();if(!current||!await (gate?gate.canRead(id):allowed(db,uid,id)))throw new HistoryError('not_found',404);
 return {revision:current.seq,entries:results.slice(0,limit).map(r=>({...r,before:JSON.parse(r.before_json),after:JSON.parse(r.after_json),omitted:JSON.parse(r.omitted_json),before_json:undefined,after_json:undefined,omitted_json:undefined})),nextBefore:results.length>limit?results[limit-1].revision:null};
}
export async function historicalPatch(db:D1Database,uid:string,id:string,revision:number,fields:string[],side:'before'|'after'){
 if(!Number.isSafeInteger(revision)||!Array.isArray(fields)||!fields.length||fields.length>100||!fields.every(k=>typeof k==='string'&&historyField(k))||!['before','after'].includes(side))throw new HistoryError('invalid_request',400);
 if(!await allowed(db,uid,id))throw new HistoryError('not_found',404);
 if(!await editableBy(db,uid,id))throw new HistoryError('restore_conflict_or_access_changed',409);
 const row=await db.prepare(`SELECT h.collection,h.before_json,h.after_json FROM record_history h CROSS JOIN (SELECT ? AS id) viewer WHERE h.record_id=? AND h.revision=? AND ${visible()}`).bind(uid,id,revision).first<{collection:string;before_json:string;after_json:string}>();if(!row)throw new HistoryError('not_found',404);
 const values=JSON.parse(side==='before'?row.before_json:row.after_json),patch:Record<string,unknown>={};for(const k of fields){if(!Object.hasOwn(values,k))throw new HistoryError('field_not_retained',400);if(k==='deleted')throw new HistoryError('use_existing_restore_or_undo_for_deletions',400);patch[k]=values[k];}return {collection:row.collection,patch};
}
historyApi.onError((error,c)=>{if(error instanceof HistoryError)return c.json({error:error.code},error.status);throw error;});
historyApi.get('/:id',async c=>c.json(await loadHistoryPage(c.env.DB,c.get('user').id,c.req.param('id'),Number(c.req.query('before')??Number.MAX_SAFE_INTEGER),Math.min(50,Math.max(1,Number(c.req.query('limit'))||20)))));
historyApi.post('/:id/restore',async c=>{const u=c.get('user'),id=c.req.param('id'),b=await c.req.json().catch(()=>null);if(!b||!Number.isSafeInteger(b.revision)||!Number.isSafeInteger(b.expectedRev)||typeof b.requestId!=='string'||!b.requestId.length||b.requestId.length>64||!Array.isArray(b.fields)||!b.fields.length||b.fields.length>100||!b.fields.every((k:unknown)=>typeof k==='string'&&historyField(k))||!['before','after'].includes(b.side))return c.json({error:'invalid_request'},400);
 const h=await historicalPatch(c.env.DB,u.id,id,b.revision,b.fields,b.side);const patch=h.patch;
 const hash=await sha256Hex(stableJson({id,revision:b.revision,expectedRev:b.expectedRev,side:b.side,fields:b.fields}));
 const journal=beginChangeset({userId:u.id,source:'undo',tool:'restore_record_fields',requestId:b.requestId,summary:'Restore selected historical fields'});
 await c.env.DB.prepare(`INSERT OR IGNORE INTO history_restore_jobs(user_id,request_id,args_hash,record_id,changeset_id,created_at) VALUES(?,?,?,?,?,?)`).bind(u.id,b.requestId,hash,id,journal.id,Date.now()).run();
 const job=await c.env.DB.prepare('SELECT args_hash,changeset_id,status FROM history_restore_jobs WHERE user_id=? AND request_id=?').bind(u.id,b.requestId).first<{args_hash:string;changeset_id:string;status:string}>();if(!job||job.args_hash!==hash)return c.json({error:'request_id_reused'},409);if(job.status==='completed')return c.json({ok:true,replayed:true,changesetId:job.changeset_id});journal.id=job.changeset_id;
 const guard=()=>c.env.DB.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM history_restore_jobs WHERE user_id=? AND request_id=? AND status='pending' AND args_hash=?) THEN 1 ELSE json_extract('{','$') END`).bind(u.id,b.requestId,hash);
 const r=await applyChanges(c.env,u.id,[{id,collection:h.collection,patch,ts:Date.now()}],{serverTs:true,atomic:true,session:{tokenHash:u.tokenHash},expect:new Map([[id,b.expectedRev]]),journal,event:{source:'undo',ctx:c.executionCtx},execution:{guard,checkpoint:()=>c.env.DB.prepare("UPDATE history_restore_jobs SET status='completed' WHERE user_id=? AND request_id=?").bind(u.id,b.requestId)}});
 if(!r.changed){const done=await c.env.DB.prepare("SELECT 1 FROM history_restore_jobs WHERE user_id=? AND request_id=? AND status='completed'").bind(u.id,b.requestId).first();if(done&&await editableBy(c.env.DB,u.id,id))return c.json({ok:true,replayed:true,changesetId:job.changeset_id});}
 if(r.conflicts?.length||r.rejected||r.partialError)return c.json({error:'restore_conflict_or_access_changed',conflicts:r.conflicts?.map(v=>({id:v.id,currentRev:v.currentRev}))},409);
 if(!r.changed)return c.json({error:'no_change',revision:b.expectedRev},409);
 return c.json({ok:true,changesetId:journal.id});});
