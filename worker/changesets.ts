/* MCP change sets + undo (Phase 0 §7). One changesets row per write tool
 * call; changeset_items records every record mutation for safe undo. */

import { Hono } from 'hono';
import { planUndo, type ChangesetItem } from '../shared/undo';
import { applyChanges, type AppliedChange } from './sync';
import { getRecs } from './records';
import { visibleItems, visibleSummaries } from './historyAccess';
import { serviceEnv } from './readAccess';
import { requireAuth, type Env, type AuthUser } from './auth';

export interface ChangesetCtx {
  id: string;
  userId: string;
  clientName: string | null;
  tool: string;
  summary: string;
  source: 'mcp' | 'automation' | 'form' | 'undo';
  requestId: string | null;
  undoes: string | null;
  items: AppliedChange[];
}

export function beginChangeset(init: { userId: string; clientName?: string | null; tool: string; summary?: string; source?: ChangesetCtx['source']; requestId?: string | null; undoes?: string | null }): ChangesetCtx {
  return {
    id: crypto.randomUUID(),
    userId: init.userId,
    clientName: init.clientName ?? null,
    tool: init.tool,
    summary: (init.summary ?? init.tool).slice(0, 200),
    source: init.source ?? 'mcp',
    requestId: init.requestId ?? null,
    undoes: init.undoes ?? null,
    items: [],
  };
}

/** No items → no row. Items are chunked at 100 per batch. */
export async function commitChangeset(env: Env, cs: ChangesetCtx): Promise<string | null> {
  if(!cs.items.length) {
    const existing=await env.DB.prepare('SELECT id FROM changesets WHERE id=?').bind(cs.id).first();
    return existing?cs.id:null;
  }
  const now=Date.now();
  for(let i=0;i<cs.items.length;i+=100) {
    const statements:D1PreparedStatement[]=[env.DB.prepare('INSERT OR IGNORE INTO changesets (id,user_id,source,client_name,tool,summary,request_id,undoes,item_count,created_at) VALUES (?,?,?,?,?,?,?,?,0,?)')
      .bind(cs.id,cs.userId,cs.source,cs.clientName,cs.tool,cs.summary,cs.requestId,cs.undoes,now)];
    for(const it of cs.items.slice(i,i+100)) statements.push(env.DB.prepare(`INSERT INTO changeset_items(changeset_id,idx,collection,record_id,created,before,after,field_ts)
      SELECT ?,(SELECT COALESCE(MAX(idx),-1)+1 FROM changeset_items WHERE changeset_id=?),?,?,?,?,?,?
      WHERE NOT EXISTS(SELECT 1 FROM changeset_items WHERE changeset_id=? AND record_id=? AND field_ts=?)`)
      .bind(cs.id,cs.id,it.collection,it.id,it.created?1:0,JSON.stringify(it.before),JSON.stringify(it.after),JSON.stringify(it.fieldTs),cs.id,it.id,JSON.stringify(it.fieldTs)));
    statements.push(env.DB.prepare('UPDATE changesets SET item_count=(SELECT COUNT(*) FROM changeset_items WHERE changeset_id=?) WHERE id=?').bind(cs.id,cs.id));
    await env.DB.batch(statements);
  }
  return cs.id;
}

export interface UndoOutcome {
  ok: boolean;
  error?: string;
  /** HTTP status the error maps to — callers must not guess. */
  status?: number;
  changesetId?: string;
  undoChangesetId?: string;
  skipped?: { id: string; field: string; reason: string }[];
  restored?: number;
  conflicts?: { id: string; collection: string; expectedRev: number; currentRev: number | null }[];
}

export async function undoChangeset(env: Env, user: AuthUser, changesetId: string, ectx?: { waitUntil(p: Promise<unknown>): void }): Promise<UndoOutcome> {
  const cs = await env.DB.prepare('SELECT id, user_id, undone_by, tool FROM changesets WHERE id = ?').bind(changesetId).first<{ id: string; user_id: string; undone_by: string | null; tool: string }>();
  if (!cs) return { ok: false, status: 404, error: 'changeset not found' };
  // Authorization lives here, not in callers: every path (HTTP route, MCP
  // undo_change) enforces owner-or-admin. Phase 0 §7 — members undo own only.
  if (user.role !== 'admin' && cs.user_id !== user.id) return { ok: false, status: 403, error: 'forbidden' };
  if (cs.undone_by) {
    const undone = await env.DB.prepare('SELECT undoes FROM changesets WHERE id = ?').bind(cs.undone_by).first<{ undoes: string | null }>();
    // undo-of-undo is a redo — allowed only through that changeset's own undo
    if (undone) return { ok: false, status: 409, error: 'already undone' };
    return { ok: false, status: 409, error: 'already undone' };
  }
  // Reserve the inverse identity before fencing recovery. A retry always
  // resumes this same journal, including after a lost commit acknowledgement.
  await env.DB.prepare(`INSERT OR IGNORE INTO undo_jobs(changeset_id,inverse_id,user_id,created_at) VALUES(?,?,?,?)`)
    .bind(changesetId,crypto.randomUUID(),user.id,Date.now()).run();
  const lease=crypto.randomUUID();
  const claim=await env.DB.prepare(`UPDATE undo_jobs SET lease_id=?,lease_until=? WHERE changeset_id=? AND COALESCE(lease_until,0)<=?`)
    .bind(lease,Date.now()+120_000,changesetId,Date.now()).run();
  if(!claim.meta.changes) return {ok:false,status:503,error:'undo is running; retry',changesetId};
  const guard=()=>env.DB.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM undo_jobs WHERE changeset_id=? AND lease_id=? AND lease_until>?) THEN 1 ELSE json_extract('{','$') END`)
    .bind(changesetId,lease,Date.now());
  try {
    const job=await env.DB.prepare('SELECT inverse_id,state,skipped FROM undo_jobs WHERE changeset_id=?').bind(changesetId).first<{inverse_id:string;state:string;skipped:string}>();
    if(!job) throw new Error('undo reservation missing');
    if(job.state==='pending') {
      // A crash before/after fencing is recoverable from the reserved job.
      await env.DB.batch([guard(),
        env.DB.prepare("UPDATE ai_previews SET status='cancelled',lease_id=NULL,lease_until=NULL WHERE changeset_id=? AND status<>'completed'").bind(changesetId),
        env.DB.prepare("UPDATE mcp_write_jobs SET cancelled=1,lease_id=NULL,lease_until=NULL WHERE id=?").bind(changesetId),
        env.DB.prepare("UPDATE automation_runs SET status='terminal_failure',error='cancelled by undo',lease_id=NULL,lease_until=NULL,updated_at=? WHERE changeset_id=? AND status NOT IN ('completed','terminal_failure')").bind(Date.now(),changesetId),
        env.DB.prepare("UPDATE form_submissions SET state='rejected',error=?,receipt=NULL,lease_id=NULL,lease_until=NULL,updated_at=? WHERE changeset_id=? AND state NOT IN ('accepted','rejected')").bind(JSON.stringify({error:'cancelled_by_undo',retryable:false}),Date.now(),changesetId),
      ]);
      const {results}=await env.DB.prepare('SELECT collection,record_id,created,before,after,field_ts FROM changeset_items WHERE changeset_id=? ORDER BY idx').bind(changesetId).all<{collection:string;record_id:string;created:number;before:string;after:string;field_ts:string}>();
      // Collapse multiple writes to the same field: first before, last after
      // and timestamp. Undo restores the state before the entire operation.
      const collapsed=new Map<string,ChangesetItem>();
      for(const r of results) {
        const item={...r,before:JSON.parse(r.before),after:JSON.parse(r.after),field_ts:JSON.parse(r.field_ts)} as ChangesetItem;
        const prev=collapsed.get(r.record_id);
        if(!prev) collapsed.set(r.record_id,item);
        else {for(const f of Object.keys(item.after)) if(!(f in prev.after)) prev.before[f]=item.before[f];Object.assign(prev.after,item.after);Object.assign(prev.field_ts,item.field_ts);}
      }
      // Integrity-only inverse planning: current CAS revisions are required even
      // for hidden tombstoned descendants. applyChanges reauthorizes every patch.
      const current=await getRecs(serviceEnv(env),[...collapsed.keys()]);
      const plan=planUndo([...collapsed.values()],new Map([...current].map(([id,r])=>[id,{data:r.data,field_ts:r.fieldTs}])));
      // Store the frozen plan atomically; no inverse may precede this commit.
      const statements=[guard(),...plan.patches.map(p=>env.DB.prepare('INSERT OR IGNORE INTO undo_items(changeset_id,record_id,collection,patch,expected_rev) VALUES(?,?,?,?,?)').bind(changesetId,p.id,p.collection,JSON.stringify(p.patch),current.get(p.id)?.rev??-1)),
        env.DB.prepare("UPDATE undo_jobs SET state='running',skipped=? WHERE changeset_id=?").bind(JSON.stringify(plan.skipped),changesetId)];
      await env.DB.batch(statements);
      job.skipped=JSON.stringify(plan.skipped);
    }
    const inverse=beginChangeset({userId:user.id,tool:'undo_change',summary:`Undo ${cs.tool}`,source:'undo',undoes:changesetId});
    inverse.id=job.inverse_id;
    for(;;) {
      const {results:items}=await env.DB.prepare("SELECT record_id,collection,patch,expected_rev FROM undo_items WHERE changeset_id=? AND state='pending' ORDER BY record_id LIMIT 100").bind(changesetId).all<{record_id:string;collection:string;patch:string;expected_rev:number}>();
      if(!items.length) break;
      await env.DB.prepare('UPDATE undo_jobs SET lease_until=? WHERE changeset_id=? AND lease_id=?').bind(Date.now()+120_000,changesetId,lease).run();
      const res=await applyChanges(env,user.id,items.map(i=>({id:i.record_id,collection:i.collection,patch:JSON.parse(i.patch),ts:0})),{
        serverTs:true,expect:new Map(items.map(i=>[i.record_id,i.expected_rev])),atomic:true,journal:inverse,
        event:{source:'undo',changesetId:inverse.id,...(ectx?{ctx:ectx}:{})},
        execution:{guard,checkpoint:id=>env.DB.prepare("UPDATE undo_items SET state='applied' WHERE changeset_id=? AND record_id=? AND state='pending'").bind(changesetId,id)},
      });
      if(res.conflicts?.length) {
        await env.DB.batch([guard(),...res.conflicts.map(c=>env.DB.prepare("UPDATE undo_items SET state='conflict',conflict=? WHERE changeset_id=? AND record_id=? AND state='pending'").bind(JSON.stringify({id:c.id,collection:c.collection,expectedRev:c.expectedRev,currentRev:c.currentRev}),changesetId,c.id))]);
        continue;
      }
      if(res.partialError||res.rejected||res.conflict||res.applied.length!==items.length) throw new Error(res.partialError??`inverse batch did not complete${res.rejectedItems?.length ? ': '+res.rejectedItems.map(item=>item.reason).join('; ') : ''}`);
    }
    const conflicts=(await env.DB.prepare("SELECT conflict FROM undo_items WHERE changeset_id=? AND state='conflict'").bind(changesetId).all<{conflict:string}>()).results.map(r=>JSON.parse(r.conflict));
    const restored=(await env.DB.prepare("SELECT COUNT(*) n FROM undo_items WHERE changeset_id=? AND state='applied'").bind(changesetId).first<{n:number}>())!.n;
    await env.DB.batch([guard(),env.DB.prepare('UPDATE changesets SET undone_by=? WHERE id=?').bind(restored?inverse.id:null,changesetId),env.DB.prepare('UPDATE undo_jobs SET state=? WHERE changeset_id=?').bind(conflicts.length?'partial':'completed',changesetId)]);
    return {ok:conflicts.length===0,status:conflicts.length?409:undefined,error:conflicts.length?'undo completed with conflicts; review partial inverse journal':undefined,changesetId,undoChangesetId:restored?inverse.id:undefined,restored,conflicts,skipped:JSON.parse(job.skipped)};
  } catch(error) {
    const job=await env.DB.prepare('SELECT inverse_id FROM undo_jobs WHERE changeset_id=?').bind(changesetId).first<{inverse_id:string}>().catch(()=>null);
    return {ok:false,status:503,error:`undo interrupted; retry resumes committed inverses: ${error instanceof Error?error.message:String(error)}`,changesetId,undoChangesetId:job?.inverse_id};
  } finally {
    await env.DB.prepare('UPDATE undo_jobs SET lease_id=NULL,lease_until=NULL WHERE changeset_id=? AND lease_id=?').bind(changesetId,lease).run().catch(()=>{});
  }
}

/* ---- HTTP API (session auth; members undo own, admins any) ---- */

export const changesApi = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
changesApi.use('*', requireAuth);

changesApi.get('/', async (c) => {
  const user = c.get('user');
  const mine = c.req.query('mine') === '1';
  const before = c.req.query('before');
  let sql = 'SELECT id, user_id, source, client_name, tool, summary, request_id, undoes, undone_by, item_count, created_at FROM changesets';
  const conds: string[] = [];
  const binds: unknown[] = [];
  if (mine || user.role !== 'admin') {
    conds.push('user_id = ?');
    binds.push(user.id);
  }
  if (before) {
    conds.push('created_at < ?');
    binds.push(Number(before));
  }
  if (conds.length) sql += ` WHERE ${conds.join(' AND ')}`;
  sql += ' ORDER BY created_at DESC LIMIT 50';
  const { results } = await c.env.DB.prepare(sql).bind(...(binds as (string | number)[])).all<{ id: string; summary: string }>();
  return c.json({ changesets: await visibleSummaries(c.env.DB, user.id, results) });
});

changesApi.get('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const cs = await c.env.DB.prepare('SELECT * FROM changesets WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!cs) return c.json({ error: 'not found' }, 404);
  if (user.role !== 'admin' && cs.user_id !== user.id) return c.json({ error: 'forbidden' }, 403);
  const { results } = await c.env.DB.prepare('SELECT idx, collection, record_id, created, before, after, field_ts FROM changeset_items WHERE changeset_id = ? ORDER BY idx').bind(id).all<{ record_id: string }>();
  const [summary] = await visibleSummaries(c.env.DB, user.id, [cs as { id: unknown; summary?: unknown }]);
  const shown = await visibleItems(c.env.DB, user.id, results);
  const changeset = shown.restricted ? {...summary,summary:'Restricted change',restricted:true} : summary;
  return c.json({ changeset, items: shown.items, ...(shown.restricted ? { restricted: shown.restricted } : {}) });
});

changesApi.post('/:id/undo', async (c) => {
  const user = c.get('user');
  const out = await undoChangeset(c.env, user, c.req.param('id'), c.executionCtx);
  if (!out.ok) return c.json(out, (out.status ?? 409) as 403 | 404 | 409 | 503);
  return c.json(out);
});
