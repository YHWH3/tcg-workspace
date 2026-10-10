// Phase 4 — approvals (Workstream D). The stage-gate guard is foundation code
// (live now — a gated transition is refused on every write pathway); the D
// agent extends THIS file with request/list/decide endpoints, UI helpers and
// MCP tools. Approvals live in the server-controlled `approvals` D1 table —
// generic sync can never mint one.

import { Hono } from 'hono';
import type { Mutation } from '../shared/types';
import { requireAuth, type Env, type AuthUser } from './auth';

export interface ApprovalGate {
  stageId: string;
  approverField?: string;
}


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
 * applyChanges after mutation validation. A status write into a gated stage
 * without a matching approved decision is stripped from the patch and reported
 * as `approval_required`; other fields in the same change still apply. */
export async function guardStageWrites(
  env: { DB: D1Database },
  incoming: Mutation[],
  reject: (id: unknown, collection: unknown, reason: string) => void
): Promise<void> {
  const stageWrites = incoming.filter(
    (ch) => ch.collection === 'tasks' && ch.patch && typeof ch.patch.status === 'string'
  );
  if (!stageWrites.length) return;

  const ids = [...new Set(stageWrites.map((c) => c.id))];
  const rows = await fetchRecordData(env.DB, ids);

  const boardIds = new Set<string>();
  const boardOf = new Map<string, string>();
  for (const ch of stageWrites) {
    const bid =
      typeof ch.patch.boardId === 'string'
        ? ch.patch.boardId
        : (rows.get(ch.id)?.boardId as string | undefined);
    if (bid) {
      boardOf.set(ch.id, bid);
      boardIds.add(bid);
    }
  }
  const boards = await fetchRecordData(env.DB, [...boardIds]);

  for (const ch of stageWrites) {
    const to = ch.patch.status as string;
    const board = boards.get(boardOf.get(ch.id) ?? '');
    const gate = board?.approvalGate as ApprovalGate | undefined;
    if (!gate || gate.stageId !== to) continue;

    const merged = rows.get(ch.id) ?? {};
    const approverKey = gate.approverField ? `p_${gate.approverField}` : '';
    const requiredApprover = approverKey
      ? ((ch.patch[approverKey] ?? merged[approverKey]) as string | undefined)
      : undefined;

    const ok = await findApprovedApproval(env.DB, ch.id, to, requiredApprover);
    if (!ok) {
      reject(ch.id, ch.collection, 'approval_required');
      // Strip the forbidden transition; other fields in the patch still merge.
      delete ch.patch.status;
    }
  }
}

// --- D agent extends below: request/list/decide endpoints, MCP tools ---
export const approvalsApi = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
approvalsApi.use('*', requireAuth);

approvalsApi.get('/', async (c) => {
  return c.json({ error: 'not implemented — Workstream D' }, 501);
});
