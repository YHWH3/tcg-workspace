/* MCP change sets + undo (Phase 0 §7). One changesets row per write tool
 * call; changeset_items records every record mutation for safe undo. */

import { Hono } from 'hono';
import { planUndo, type ChangesetItem } from '../shared/undo';
import { applyChanges, type AppliedChange } from './sync';
import { getRecs } from './records';
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
  // Revoke recoverable work before reading the inverse snapshot. A crashed
  // operation must not resume after undo and recreate records/side effects.
  // Its transaction fence observes the cleared lease even if a worker already
  // acquired the old claim. Completed work remains a historical success.
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE automation_runs SET status='terminal_failure',error='cancelled by undo',lease_id=NULL,lease_until=NULL,updated_at=? WHERE changeset_id=? AND status NOT IN ('completed','terminal_failure')").bind(Date.now(),changesetId),
      env.DB.prepare("UPDATE form_submissions SET state='rejected',error=?,receipt=NULL,lease_id=NULL,lease_until=NULL,updated_at=? WHERE changeset_id=? AND state NOT IN ('accepted','rejected')").bind(JSON.stringify({error:'cancelled_by_undo',retryable:false}),Date.now(),changesetId),
    ]);
  } catch {
    return { ok:false,status:503,error:'undo could not fence pending work; retry',changesetId };
  }
  const { results } = await env.DB.prepare('SELECT collection, record_id, created, before, after, field_ts FROM changeset_items WHERE changeset_id = ? ORDER BY idx').bind(changesetId).all<{ collection: string; record_id: string; created: number; before: string; after: string; field_ts: string }>();
  const items: ChangesetItem[] = results.map((r) => ({ collection: r.collection, record_id: r.record_id, created: r.created, before: JSON.parse(r.before), after: JSON.parse(r.after), field_ts: JSON.parse(r.field_ts) }));
  const current = await getRecs(env, items.map((i) => i.record_id));
  const curMap = new Map([...current.entries()].map(([id, r]) => [id, { data: r.data, field_ts: r.fieldTs }]));
  const plan = planUndo(items, curMap);
  if (!plan.patches.length) {
    // Nothing restorable — still mark undone? Spec: undo writes a changeset.
    return { ok: true, changesetId, skipped: plan.skipped, restored: 0 };
  }
  const undoCs = beginChangeset({ userId: user.id, tool: 'undo_change', summary: `Undo ${cs.tool}`, source: 'undo', undoes: changesetId });
  // Review C1: every inverse write is CAS-guarded at the rev THIS undo read
  // (the same read planUndo planned from). A row written concurrently lands in
  // `conflicts` instead of being clobbered — plan-level field skips can't see
  // writes that arrive between the read and the apply.
  const expect = new Map<string, number>();
  for (const p of plan.patches) {
    const cur = current.get(p.id);
    if (cur) expect.set(p.id, cur.rev);
  }
  const res = await applyChanges(env, user.id, plan.patches.map((p) => ({ id: p.id, collection: p.collection, patch: p.patch, ts: Date.now() })), {
    serverTs:true,expect,atomic:false,journal:undoCs,
    event:{source:'undo',changesetId:undoCs.id,...(ectx?{ctx:ectx}:{})},
  });
  undoCs.items = res.applied;
  const conflicts = (res.conflicts ?? []).map((c) => ({ id: c.id, collection: c.collection, expectedRev: c.expectedRev, currentRev: c.currentRev }));
  if (res.partialError || res.rejectedItems?.length) return {
    ok:false,status:503,error:'undo interrupted; committed inverses are journalled; retry',changesetId,
    ...(res.applied.length?{undoChangesetId:undoCs.id}:{}),restored:res.applied.length,conflicts,skipped:plan.skipped,
  };
  if (!res.applied.length) {
    // Nothing landed under the guards — leave the change set undoable so the
    // caller can re-read and retry; report what raced.
    if (conflicts.length) return { ok: false, status: 409, error: 'undo raced with newer writes — nothing restored', changesetId, conflicts, skipped: plan.skipped };
    return { ok: true, changesetId, skipped: plan.skipped, restored: 0 };
  }
  // applyChanges commits the inverse, its event and audit item together. No
  // second journal transaction may strand an already-restored record.
  await env.DB.prepare('UPDATE changesets SET undone_by = ? WHERE id = ?').bind(undoCs.id, changesetId).run();
  return { ok: true, changesetId, undoChangesetId: undoCs.id, skipped: plan.skipped, restored: res.applied.length, ...(conflicts.length ? { conflicts } : {}) };
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
  const { results } = await c.env.DB.prepare(sql).bind(...(binds as (string | number)[])).all();
  return c.json({ changesets: results });
});

changesApi.get('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const cs = await c.env.DB.prepare('SELECT * FROM changesets WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!cs) return c.json({ error: 'not found' }, 404);
  if (user.role !== 'admin' && cs.user_id !== user.id) return c.json({ error: 'forbidden' }, 403);
  const { results } = await c.env.DB.prepare('SELECT idx, collection, record_id, created, before, after, field_ts FROM changeset_items WHERE changeset_id = ? ORDER BY idx').bind(id).all();
  return c.json({ changeset: cs, items: results });
});

changesApi.post('/:id/undo', async (c) => {
  const user = c.get('user');
  const out = await undoChangeset(c.env, user, c.req.param('id'), c.executionCtx);
  if (!out.ok) return c.json(out, (out.status ?? 409) as 403 | 404 | 409 | 503);
  return c.json(out);
});
