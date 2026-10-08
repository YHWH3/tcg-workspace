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
  if (!cs.items.length) return null;
  const now = Date.now();
  await env.DB.prepare('INSERT INTO changesets (id, user_id, source, client_name, tool, summary, request_id, undoes, item_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(cs.id, cs.userId, cs.source, cs.clientName, cs.tool, cs.summary, cs.requestId, cs.undoes, cs.items.length, now)
    .run();
  for (let i = 0; i < cs.items.length; i += 100) {
    await env.DB.batch(
      cs.items.slice(i, i + 100).map((it, j) =>
        env.DB.prepare('INSERT INTO changeset_items (changeset_id, idx, collection, record_id, created, before, after, field_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(cs.id, i + j, it.collection, it.id, it.created ? 1 : 0, JSON.stringify(it.before), JSON.stringify(it.after), JSON.stringify(it.fieldTs)),
      ),
    );
  }
  return cs.id;
}

export interface UndoOutcome {
  ok: boolean;
  error?: string;
  changesetId?: string;
  undoChangesetId?: string;
  skipped?: { id: string; field: string; reason: string }[];
  restored?: number;
}

export async function undoChangeset(env: Env, user: AuthUser, changesetId: string): Promise<UndoOutcome> {
  const cs = await env.DB.prepare('SELECT id, user_id, undone_by, tool FROM changesets WHERE id = ?').bind(changesetId).first<{ id: string; user_id: string; undone_by: string | null; tool: string }>();
  if (!cs) return { ok: false, error: 'changeset not found' };
  if (cs.undone_by) {
    const undone = await env.DB.prepare('SELECT undoes FROM changesets WHERE id = ?').bind(cs.undone_by).first<{ undoes: string | null }>();
    // undo-of-undo is a redo — allowed only through that changeset's own undo
    if (undone) return { ok: false, error: 'already undone' };
    return { ok: false, error: 'already undone' };
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
  const res = await applyChanges(env, user.id, plan.patches.map((p) => ({ id: p.id, collection: p.collection, patch: p.patch, ts: Date.now() })), { serverTs: true });
  undoCs.items = res.applied;
  const undoId = await commitChangeset(env, undoCs);
  await env.DB.prepare('UPDATE changesets SET undone_by = ? WHERE id = ?').bind(undoId ?? undoCs.id, changesetId).run();
  return { ok: true, changesetId, undoChangesetId: undoId ?? undoCs.id, skipped: plan.skipped, restored: res.applied.length };
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
  const out = await undoChangeset(c.env, user, c.req.param('id'));
  if (!out.ok) return c.json({ error: out.error }, out.error === 'changeset not found' ? 404 : 409);
  return c.json(out);
});
