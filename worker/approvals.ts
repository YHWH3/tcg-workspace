// Phase 4 — approvals (Workstream D). The stage-gate guard is foundation code
// (live now — a gated transition is refused on every write pathway); the D
// agent extends THIS file with request/list/decide endpoints, UI helpers and
// MCP tools. Approvals live in the server-controlled `approvals` D1 table —
// generic sync can never mint one.

import { createReadGate } from './readAccess';
import { Hono } from 'hono';
import type { Mutation } from '../shared/types';
import { notify } from './notifications';
import { mergeRecord } from './merge';
import { healTimestamps } from '../shared/clock';
import { requireAuth, type Env, type AuthUser } from './auth';
import {
  MAX_APPROVAL_NOTE, fnv1a, gateTransition, isDecision,
  normalizeApprovalRequest, parseGate, requestKeyFor, requiredApproverId,
  type ApprovalDecision, type ApprovalGate,
} from '../shared/approvals';

// Pure helpers live in shared/approvals.ts — re-exported so MCP tools and
// tests keep importing one worker-side module.
export { fnv1a, requestKeyFor };
export type { ApprovalDecision, ApprovalGate };


async function fetchRecordData(db: D1Database, ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { results } = await db
      .prepare(`SELECT id, data FROM records WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<{ id: string; data: string }>();
    for (const r of results) {
      try {
        out.set(r.id, JSON.parse(r.data) as Record<string, unknown>);
      } catch {
        /* unparseable row — treat as absent for gate purposes */
      }
    }
  }
  return out;
}

/** Approved decision covering (record, targetStage)? When the gate pins an
 * approverField, the stored decision must have been made by the user currently
 * in that field — a stale approver (field changed since) does not count. */
export async function findApprovedApproval(
  db: D1Database,
  targetId: string,
  stageId: string,
  requiredApproverId?: string
): Promise<boolean> {
  const { results } = await db
    .prepare(
      `SELECT approver_id FROM approvals
       WHERE target_type = 'record' AND target_id = ? AND status = 'approved'
         AND (stage_id = ? OR stage_id IS NULL)`
    )
    .bind(targetId, stageId)
    .all<{ approver_id: string }>();
  if (!requiredApproverId) return results.length > 0;
  return results.some((r) => r.approver_id === requiredApproverId);
}

/** Enforce board `approvalGate` on every write pathway. Called from
 * applyChanges after mutation validation, BEFORE planning. A write that would
 * enter a gated stage (by status or by board) or re-pin its approver without a
 * matching approved decision has the offending keys stripped from its patch and
 * is reported as `approval_required`; other fields in the same change still
 * apply. The merge is folded exactly as the real merge will apply it (same
 * `mergeRecord`, stored field timestamps, request order), and an absent
 * `boardId` resolves to `board-default` — so this pre-check and the
 * transactional guard in `flushPlans` agree, and a policy refusal can only ever
 * be an item-wise rejection, never a batch abort.
 *
 * `existing` lets applyChanges share the rows it already read; direct callers
 * (unit tests) may omit it and the guard reads what it needs. */
export async function guardStageWrites(
  env: { DB: D1Database },
  incoming: Mutation[],
  reject: (id: unknown, collection: unknown, reason: string) => void,
  opts: {
    /** Stored rows the caller already read (applyChanges shares its one read). */
    existing?: Map<string, { data: string; field_ts?: string; updated_at?: number | null }>;
    /** Merged board configurations from this same write, including boards created
     * in it — persisted rows alone miss a gate introduced later in an atomic batch. */
    proposedBoards?: ReadonlyMap<string, Record<string, unknown>>;
    now?: number;
  } = {},
): Promise<void> {
  const { existing, proposedBoards, now = Date.now() } = opts;
  const touchesGate = (ch: Mutation) =>
    ch.collection === 'tasks' && !!ch.patch &&
    ('status' in ch.patch || 'boardId' in ch.patch || Object.keys(ch.patch).some((k) => k.startsWith('p_')));
  const relevant = incoming.filter(touchesGate);
  if (!relevant.length) return;

  const stored = new Map<string, { data: Record<string, unknown>; field_ts: Record<string, number> }>();
  const parse = (id: string, raw: { data: string; field_ts?: string; updated_at?: number | null }) => {
    try {
      // Same timestamp healing as the real merge, so the pre-check predicts
      // exactly which fields of this write will win.
      stored.set(id, {
        data: JSON.parse(raw.data) as Record<string, unknown>,
        field_ts: raw.field_ts ? healTimestamps(JSON.parse(raw.field_ts) as Record<string, number>, now, raw.updated_at) : {},
      });
    } catch {
      /* unparseable row — treated as absent for gate purposes */
    }
  };
  if (existing) {
    for (const ch of incoming) {
      const row = ch.collection === 'tasks' ? existing.get(ch.id) : undefined;
      if (row && !stored.has(ch.id)) parse(ch.id, row);
    }
  } else {
    for (const [id, data] of await fetchRecordData(env.DB, [...new Set(relevant.map((c) => c.id))])) stored.set(id, { data, field_ts: {} });
  }

  const boardIds = new Set<string>(['board-default']);
  for (const ch of relevant) {
    if (typeof ch.patch.boardId === 'string' && ch.patch.boardId) boardIds.add(ch.patch.boardId);
    const sb = stored.get(ch.id)?.data.boardId;
    if (typeof sb === 'string' && sb) boardIds.add(sb);
  }
  const boards = await fetchRecordData(env.DB, [...boardIds]);
  for (const [id, data] of proposedBoards ?? []) if (boardIds.has(id)) boards.set(id, data);

  const state = new Map<string, { data: Record<string, unknown>; field_ts: Record<string, number> }>();
  for (const ch of incoming) {
    if (ch.collection !== 'tasks' || !ch.patch) continue;
    const before = state.get(ch.id) ?? stored.get(ch.id) ?? { data: {}, field_ts: {} };
    let merged = mergeRecord(before, { patch: ch.patch, ts: ch.ts });
    if (touchesGate(ch)) {
      const boardId = typeof merged.data.boardId === 'string' && merged.data.boardId ? merged.data.boardId : 'board-default';
      const gate = parseGate(boards.get(boardId));
      const { required, strip } = gateTransition(gate, before.data, merged.data);
      if (required && gate) {
        const requiredApprover = gate.approverField ? requiredApproverId(gate, merged.data) : undefined;
        const ok = (!gate.approverField || !!requiredApprover) && (await findApprovedApproval(env.DB, ch.id, gate.stageId, requiredApprover));
        if (!ok) {
          reject(ch.id, ch.collection, 'approval_required');
          // Strip the forbidden transition; other fields in the patch still merge.
          for (const key of strip) delete ch.patch[key];
          merged = mergeRecord(before, { patch: ch.patch, ts: ch.ts });
        }
      }
    }
    state.set(ch.id, { data: merged.data, field_ts: merged.field_ts });
  }
}

// --- Workstream D: request/list/decide/cancel — REST + shared helpers ---
// Approvals are D1 rows, never records: generic sync cannot mint, read, or
// decide one. `request_key` (UNIQUE) makes request replay return the stored
// row; decide/cancel are single CAS UPDATEs so concurrent or repeated calls
// settle on exactly one outcome.

export interface ApprovalRow {
  id: string;
  target_type: string;
  target_id: string;
  stage_id: string | null;
  requested_by: string;
  approver_id: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  note: string | null;
  decided_note: string | null;
  request_key: string | null;
  decided_at: number | null;
  created_at: number;
}

/** Wire shape — rev is created_at ms so callers can CAS a decide on the row
 * they read (approvals have no records.seq). */
/** Phase 5: an approval's notes and its target's title are copies of record context. A
 * participant who can no longer read the target sees the request without them. */
export function restrictedApprovalJson(r: ApprovalRow) {
  return { ...approvalJson({ ...r, note: null, decided_note: null }), targetTitle: 'Restricted item', restricted: true };
}

/** Which approval targets the viewer may read now (legacy: all). */
export async function readableTargets(db: D1Database, viewerId: string, rows: readonly ApprovalRow[]): Promise<(r: ApprovalRow) => boolean> {
  const decision = await createReadGate(db, viewerId).decide(rows.map((r) => r.target_id));
  return (r) => !decision.enabled || decision.readable.has(r.target_id);
}

export function approvalJson(r: ApprovalRow, extra: { targetTitle?: string; url?: string } = {}) {
  return {
    id: r.id,
    targetType: r.target_type,
    targetId: r.target_id,
    stageId: r.stage_id,
    requestedBy: r.requested_by,
    approverId: r.approver_id,
    status: r.status,
    note: r.note,
    decidedNote: r.decided_note,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
    rev: r.created_at,
    ...(extra.targetTitle !== undefined ? { targetTitle: extra.targetTitle } : {}),
    ...(extra.url !== undefined ? { url: extra.url } : {}),
  };
}

/** target → title + app-relative deep link. record ⇒ live tasks row; page ⇒
 * live pages row. Returns null when the target is missing/deleted/other
 * collection — requests against ghosts are refused. */
export async function loadTargetMeta(
  db: D1Database,
  targetType: string,
  targetId: string,
): Promise<{ title: string; url: string; boardId?: string } | null> {
  const collection = targetType === 'page' ? 'pages' : targetType === 'record' ? 'tasks' : null;
  if (!collection) return null;
  const row = await db
    .prepare(`SELECT data FROM records WHERE id = ? AND collection = ? AND COALESCE(json_extract(data, '$.deleted'), 0) != 1`)
    .bind(targetId, collection)
    .first<{ data: string }>();
  if (!row) return null;
  const data = JSON.parse(row.data) as Record<string, unknown>;
  const title = String(data.title ?? data.name ?? targetId);
  if (targetType === 'page') return { title, url: `/pages/${targetId}` };
  const boardId = String(data.boardId ?? 'board-default');
  return { title, url: `/boards/${boardId}/tasks/${targetId}`, boardId };
}

export async function insertApproval(
  db: D1Database,
  input: { targetType: string; targetId: string; stageId?: string; requestedBy: string; approverId: string; note?: string; requestKey: string },
): Promise<{ row: ApprovalRow; replayed: boolean }> {
  const scopedKey=input.requestedBy+':'+input.requestKey;
  const id = 'ap_' + crypto.randomUUID();
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO approvals
         (id, target_type, target_id, stage_id, requested_by, approver_id, status, note, request_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .bind(id, input.targetType, input.targetId, input.stageId ?? null, input.requestedBy, input.approverId, input.note ?? null, scopedKey, Date.now())
    .run();
  if ((res.meta.changes ?? 0) === 0) {
    const existing = await db.prepare('SELECT * FROM approvals WHERE request_key = ?').bind(scopedKey).first<ApprovalRow>();
    if (existing) {
      if(existing.target_id!==input.targetId||existing.target_type!==input.targetType||existing.approver_id!==input.approverId||existing.stage_id!==(input.stageId??null)) throw new Error('approval requestId reused with different input');
      return { row: existing, replayed: true };
    }
  }
  const row = await db.prepare('SELECT * FROM approvals WHERE id = ?').bind(id).first<ApprovalRow>();
  return { row: row!, replayed: false };
}

export type DecideOutcome = 'ok' | 'not_found' | 'not_approver' | 'already_decided' | 'stale_rev';

/** One CAS UPDATE: only the named approver, only while pending. `expectedRev`
 * optionally pins the row's created_at (the `rev` list/read return). Replay of
 * an identical decision returns the stored row flagged replayed. */
export async function decideApproval(
  db: D1Database,
  input: { approvalId: string; approverId: string; decision: ApprovalDecision; note?: string; expectedRev?: number },
): Promise<{ outcome: DecideOutcome; row: ApprovalRow | null; replayed?: boolean }> {
  const res = await db
    .prepare(
      `UPDATE approvals SET status = ?, decided_note = ?, decided_at = ?
       WHERE id = ? AND approver_id = ? AND status = 'pending'${input.expectedRev !== undefined ? ' AND created_at = ?' : ''}`,
    )
    .bind(...[input.decision, input.note ?? null, Date.now(), input.approvalId, input.approverId, ...(input.expectedRev !== undefined ? [input.expectedRev] : [])])
    .run();
  if ((res.meta.changes ?? 0) > 0) {
    const row = await db.prepare('SELECT * FROM approvals WHERE id = ?').bind(input.approvalId).first<ApprovalRow>();
    return { outcome: 'ok', row };
  }
  const row = await db.prepare('SELECT * FROM approvals WHERE id = ?').bind(input.approvalId).first<ApprovalRow>();
  if (!row) return { outcome: 'not_found', row: null };
  if (input.expectedRev !== undefined && row.created_at !== input.expectedRev && row.status === 'pending') {
    return { outcome: 'stale_rev', row };
  }
  if (row.approver_id !== input.approverId) return { outcome: 'not_approver', row };
  // Same decision by the same approver — replay returns the stored row.
  if (row.status === input.decision) return { outcome: 'ok', row, replayed: true };
  return { outcome: 'already_decided', row };
}

/** Requester-only cancel, pending-only — same single-statement CAS shape. */
export async function cancelApproval(
  db: D1Database,
  input: { approvalId: string; requesterId: string },
): Promise<{ outcome: 'ok' | 'not_found' | 'not_requester' | 'not_pending'; row: ApprovalRow | null }> {
  const res = await db
    .prepare(`UPDATE approvals SET status = 'cancelled', decided_at = ? WHERE id = ? AND requested_by = ? AND status = 'pending'`)
    .bind(Date.now(), input.approvalId, input.requesterId)
    .run();
  const row = await db.prepare('SELECT * FROM approvals WHERE id = ?').bind(input.approvalId).first<ApprovalRow>();
  if ((res.meta.changes ?? 0) > 0) return { outcome: 'ok', row };
  if (!row) return { outcome: 'not_found', row: null };
  if (row.requested_by !== input.requesterId) return { outcome: 'not_requester', row };
  return { outcome: 'not_pending', row };
}

export interface ApprovalListQuery {
  userId: string;
  /** 'approver' = awaiting my decision; 'requested' = I asked; unset = both. */
  mine?: 'approver' | 'requested';
  targetId?: string;
  status?: string;
  limit?: number;
}

export async function listApprovals(db: D1Database, q: ApprovalListQuery): Promise<ApprovalRow[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q.mine === 'approver') {
    where.push('approver_id = ?');
    binds.push(q.userId);
  } else if (q.mine === 'requested') {
    where.push('requested_by = ?');
    binds.push(q.userId);
  } else {
    where.push('(approver_id = ? OR requested_by = ?)');
    binds.push(q.userId, q.userId);
  }
  if (q.targetId) {
    where.push('target_id = ?');
    binds.push(q.targetId);
  }
  if (q.status) {
    where.push('status = ?');
    binds.push(q.status);
  }
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const { results } = await db
    .prepare(`SELECT * FROM approvals WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
    .bind(...binds, limit)
    .all<ApprovalRow>();
  return results;
}

export async function userExists(db: D1Database, userId: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first<{ id: string }>();
  return !!row;
}

/** Shared request validation — REST + MCP agree on every refusal. The pure
 * shape checks live in shared/approvals.ts; this adds the DB existence checks
 * (target live, approver a real user). Returns the failure or normalized input. */
export async function validateApprovalRequest(
  db: D1Database,
  requestedBy: string,
  body: unknown,
): Promise<{ error: string } | { targetType: string; targetId: string; stageId?: string; approverId: string; note?: string; requestId?: string; meta: { title: string; url: string; boardId?: string } }> {
  const v = normalizeApprovalRequest(body as Parameters<typeof normalizeApprovalRequest>[0]);
  if ('error' in v) return v;
  const meta = await loadTargetMeta(db, v.targetType, v.targetId);
  // Unreadable and nonexistent targets are the same answer (permissions enabled).
  if (!meta || !(await createReadGate(db, requestedBy).canRead(v.targetId))) return { error: 'target not found' };
  if (!(await userExists(db, v.approverId))) return { error: 'approver not found' };
  return { ...v, meta };
}

/* ---------- REST (session auth — members only) ---------- */

export const approvalsApi = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
approvalsApi.use('*', requireAuth);

approvalsApi.get('/', async (c) => {
  const user = c.get('user');
  const mine = c.req.query('mine');
  const status = c.req.query('status');
  const rows = await listApprovals(c.env.DB, {
    userId: user.id,
    mine: mine === 'approver' || mine === 'requested' ? mine : undefined,
    targetId: c.req.query('targetId'),
    status: status && ['pending', 'approved', 'rejected', 'cancelled'].includes(status) ? status : undefined,
    limit: Number(c.req.query('limit')) || undefined,
  });
  const readable = await readableTargets(c.env.DB, user.id, rows);
  const metas = new Map<string, { title: string; url: string } | null>();
  for (const r of rows) {
    const k = `${r.target_type}:${r.target_id}`;
    if (readable(r) && !metas.has(k)) metas.set(k, await loadTargetMeta(c.env.DB, r.target_type, r.target_id));
  }
  return c.json({
    approvals: rows.map((r) => {
      if (!readable(r)) return restrictedApprovalJson(r);
      const m = metas.get(`${r.target_type}:${r.target_id}`);
      return approvalJson(r, { targetTitle: m?.title ?? r.target_id, url: m?.url });
    }),
  });
});

approvalsApi.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'invalid body' }, 400);
  const v = await validateApprovalRequest(c.env.DB, user.id, body);
  if ('error' in v) return c.json({ error: v.error }, 400);
  const requestKey = requestKeyFor({ requestedBy: user.id, ...v });
  const { row, replayed } = await insertApproval(c.env.DB, {
    targetType: v.targetType,
    targetId: v.targetId,
    stageId: v.stageId,
    requestedBy: user.id,
    approverId: v.approverId,
    note: v.note,
    requestKey,
  });
  {
    await notify(c.env, {
      userId: v.approverId,
      kind: 'approval_requested',
      actorId: user.id,
      targetType: v.targetType,
      targetId: v.targetId,
      title: `Approval requested: ${v.meta.title}`,
      body: v.note,
      url: v.meta.url,
      groupKey: `approval:${row.id}`,
      dedupeKey:`approval_requested:${row.id}`,
    });
  }
  return c.json({ approval: approvalJson(row, { targetTitle: v.meta.title, url: v.meta.url }), replayed }, replayed ? 200 : 201);
});

approvalsApi.post('/:id/decide', async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ decision?: string; note?: string; expectedRev?: number }>().catch(() => null);
  if (!body || !isDecision(body.decision)) {
    return c.json({ error: 'decision must be approved or rejected' }, 400);
  }
  const out = await decideApproval(c.env.DB, {
    approvalId: c.req.param('id'),
    approverId: user.id,
    decision: body.decision,
    note: typeof body.note === 'string' ? body.note.slice(0, MAX_APPROVAL_NOTE) : undefined,
    expectedRev: typeof body.expectedRev === 'number' ? body.expectedRev : undefined,
  });
  if (out.outcome === 'not_found') return c.json({ error: 'approval not found' }, 404);
  if (out.outcome === 'not_approver') return c.json({ error: 'not your approval to decide' }, 403);
  if (out.outcome === 'stale_rev') return c.json({ error: 'conflict', approval: approvalJson(out.row!) }, 409);
  if (out.outcome === 'already_decided') return c.json({ error: 'already decided', approval: approvalJson(out.row!) }, 409);
  // The approver sees the target's title only while they can read it.
  const visible = await createReadGate(c.env.DB, user.id).canRead(out.row!.target_id);
  const meta = visible ? await loadTargetMeta(c.env.DB, out.row!.target_type, out.row!.target_id) : null;
  {
    await notify(c.env, {
      userId: out.row!.requested_by,
      kind: 'approval_decided',
      actorId: user.id,
      targetType: out.row!.target_type,
      targetId: out.row!.target_id,
      title: `Approval ${body.decision}: ${meta?.title ?? out.row!.target_id}`,
      body: body.note,
      url: meta?.url,
      groupKey: `approval:${out.row!.id}`,
      dedupeKey:`approval_decided:${out.row!.id}`,
    });
  }
  return c.json({ approval: visible ? approvalJson(out.row!, { targetTitle: meta?.title, url: meta?.url }) : restrictedApprovalJson(out.row!), replayed: out.replayed === true });
});

approvalsApi.post('/:id/cancel', async (c) => {
  const user = c.get('user');
  const out = await cancelApproval(c.env.DB, { approvalId: c.req.param('id'), requesterId: user.id });
  if (out.outcome === 'not_found') return c.json({ error: 'approval not found' }, 404);
  if (out.outcome === 'not_requester') return c.json({ error: 'not your request to cancel' }, 403);
  if (out.outcome === 'not_pending') return c.json({ error: 'not pending', approval: approvalJson(out.row!) }, 409);
  return c.json({ approval: approvalJson(out.row!) });
});
