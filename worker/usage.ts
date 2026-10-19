import {Hono} from 'hono';
import {requireAuth,type AuthUser,type Env} from './auth';
/** Explicit administration measurement. Aggregates are never returned to guests. */
export const usageApi=new Hono<{Bindings:Env;Variables:{user:AuthUser}}>();usageApi.use('*',requireAuth);
usageApi.get('/',async c=>{const u=c.get('user');const authorized=()=>c.env.DB.prepare("SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL AND COALESCE(workspace_role,role) IN ('owner','admin')").bind(u.id).first();if(!await authorized())return c.json({error:'not found'},404);const started=Date.now();
 const results=await c.env.DB.batch<Record<string,unknown>>([
 c.env.DB.prepare(`SELECT collection,COUNT(*) rows,SUM(length(CAST(data AS BLOB))) json_bytes,SUM(COALESCE(json_extract(data,'$.archived'),0)=1) archived,SUM(COALESCE(json_extract(data,'$.deleted'),0)=1) tombstones FROM records GROUP BY collection`),
 c.env.DB.prepare('SELECT COUNT(*) rows,COALESCE(SUM(length(CAST(before_json AS BLOB))+length(CAST(after_json AS BLOB))+length(CAST(omitted_json AS BLOB))),0) payload_bytes FROM record_history'),
 c.env.DB.prepare('SELECT COUNT(*) rows,COALESCE(SUM(length(CAST(title AS BLOB))+length(CAST(body AS BLOB))),0) payload_bytes,(SELECT COUNT(*) FROM search_dirty) pending FROM search_documents'),
 c.env.DB.prepare('SELECT COUNT(*) spaces FROM spaces WHERE deleted_at IS NULL'),
 c.env.DB.prepare('SELECT COALESCE(SUM(size),0) bytes,COUNT(*) files FROM files'),
 ]);if(!await authorized())return c.json({error:'not found'},404);
 return c.json({measuredAt:Date.now(),durationMs:Date.now()-started,bindingCalls:3,sqlStatements:7,rowsRead:results.reduce((n,r)=>n+(r.meta.rows_read??0),0),rowsWritten:results.reduce((n,r)=>n+(r.meta.rows_written??0),0),d1AllocatedBytes:results[0].meta.size_after??null,records:results[0].results,history:results[1].results[0],search:results[2].results[0],spaces:results[3].results[0],files:results[4].results[0],retention:{automaticPurge:false,history:'Retained; no automatic purge',quarantine:'Account-local; explicit review required'},metricsCoverage:'Endpoint queries; session middleware excluded. Row metadata covers aggregate queries only.',limitations:['D1 allocation uses binding meta.size_after when available; it is not Cloudflare billing or regional latency','Payload bytes exclude index overhead; allocated size includes free pages','Administration-only aggregates scan retained rows; refresh explicitly']});});
