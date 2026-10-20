// Phase 4 — MCP approval tools (Workstream D).
// request_approval / list_approvals / decide_approval — registered inside
// createWorkspaceServer (worker/mcp.ts, delimited block). Approvals live in the
// server-controlled `approvals` table; these tools are the ONLY agent-facing
// path to mint or decide one — a gated stage write without an approved
// decision is rejected `approval_required` inside applyChanges itself.

import {connectorRecordFence} from './connectorAccess';
import { createReadGate } from './readAccess';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Env } from './auth';
import { getRec } from './records';
import { notify } from './notifications';
import {
  approvalJson,
  readableTargets,
  restrictedApprovalJson,
  decideApproval,
  insertApproval,
  listApprovals,
  loadTargetMeta,
  requestKeyFor,
  validateApprovalRequest,
  type ApprovalRow,
} from './approvals';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const txt = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const err = (message: string): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true });

type Reg = <S extends z.ZodRawShape>(
  name: string,
  meta: { description: string; inputSchema: z.ZodObject<S>; annotations?: Record<string, unknown> },
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>,
) => void;

/** Structural subset of the mcp.ts per-request Ctx. */
export interface ApprovalToolCtx {
  env: Env;
  userId: string;
  clientName?: string;
}

interface UserRow {
  id: string;
  username: string;
  name: string;
}

async function workspaceUsers(db: D1Database): Promise<UserRow[]> {
  const { results } = await db.prepare('SELECT id, username, name FROM users').all<UserRow>();
  return results;
}

/** user id / @handle / display name → user id. Ambiguous names fail loudly. */
async function resolveUserId(db: D1Database, key: string): Promise<{ id: string } | { error: string }> {
  const k = key.trim().replace(/^@/, '').toLowerCase();
  if (!k) return { error: 'approver required' };
  const all = await workspaceUsers(db);
  const byId = all.filter((u) => u.id === key.trim());
  if (byId.length === 1) return { id: byId[0].id };
  const matches = all.filter((u) => u.username.toLowerCase() === k || u.name.toLowerCase() === k);
  if (matches.length === 1) return { id: matches[0].id };
  if (matches.length > 1) return { error: `approver "${key}" is ambiguous — pass the user id` };
  return { error: `approver "${key}" not found` };
}

function withNames(db: D1Database) {
  let cache: Map<string, string> | null = null;
  return async (id: string): Promise<string> => {
    if (!cache) {
      cache = new Map((await workspaceUsers(db)).map((u) => [u.id, u.name]));
    }
    return cache.get(id) ?? id;
  };
}

export function registerApprovalTools(server: McpServer, reg: Reg, ctx: ApprovalToolCtx): void {
  const db = ctx.env.DB;
  const nameOf = withNames(db);
  const decorate = async (r: ApprovalRow) => ({
    ...approvalJson(r),
    requestedByName: await nameOf(r.requested_by),
    approverName: await nameOf(r.approver_id),
  });

  reg(
    'request_approval',
    {
      description:
        "Request a member's approval on a record or page. Gated stages (board approvalGate) refuse status writes until an approved decision exists for that record+stage — use this, then decide_approval by the approver. Idempotent: same requestId (or identical payload) returns the existing approval.",
      inputSchema: z.object({
        targetType: z.enum(['record', 'page']).optional().describe('Default record'),
        targetId: z.string().describe('Record or page id'),
        approverId: z.string().describe('Approver: user id, @username or display name'),
        note: z.string().max(2000).optional(),
        stageId: z.string().optional().describe("Stage this approval unlocks — defaults to the target board's approvalGate stage"),
        dryRun: z.boolean().optional().describe('Preview the request without writing'),
      }),
      annotations: { idempotentHint: true },
    },
    async (a) => {
      const authority=await connectorRecordFence(ctx.env,ctx.userId,[a.targetId]);
      const resolved = await resolveUserId(db, a.approverId);
      if ('error' in resolved) return err(resolved.error);
      let stageId = a.stageId;
      if (!stageId && (a.targetType ?? 'record') === 'record') {
        const target = await getRec(ctx.env, a.targetId);
        const board = target ? await getRec(ctx.env, String(target.data.boardId ?? 'board-default')) : null;
        const gate = board?.data.approvalGate as { stageId?: string } | undefined;
        if (gate?.stageId) stageId = gate.stageId;
      }
      const v = await validateApprovalRequest(db, ctx.userId, {
        targetType: a.targetType,
        targetId: a.targetId,
        approverId: resolved.id,
        note: a.note,
        stageId,
      });
      if ('error' in v) return err(v.error);
      if (a.dryRun) {
        return txt({ dryRun: true, summary: `request approval of ${v.meta.title} from ${await nameOf(v.approverId)}`, request: { targetType: v.targetType, targetId: v.targetId, stageId: v.stageId ?? null, approverId: v.approverId, note: v.note ?? null } });
      }
      // reg() already replays an identical requestId at tool level; carrying
      // it into request_key also dedupes a retry after the idem row ages out.
      const requestKey = requestKeyFor({ requestedBy: ctx.userId, ...v, requestId: (a as { requestId?: string }).requestId });
      const { row, replayed } = await insertApproval(db, {
        targetType: v.targetType,
        targetId: v.targetId,
        stageId: v.stageId,
        requestedBy: ctx.userId,
        approverId: v.approverId,
        note: v.note,
        requestKey,guard:authority??undefined,
      });
      {
        await notify(ctx.env, {
          userId: v.approverId,
          kind: 'approval_requested',
          actorId: ctx.userId,
          targetType: v.targetType,
          targetId: v.targetId,
          title: `Approval requested: ${v.meta.title}`,
          body: v.note,
          url: v.meta.url,
          groupKey: `approval:${row.id}`,
          dedupeKey:`approval_requested:${row.id}`,
        });
      }
      return txt({ approval: await decorate(row), url: v.meta.url, replayed });
    },
  );

  server.registerTool(
    'list_approvals',
    {
      description: 'List approvals: pending awaiting your decision, ones you requested, or all on a target. Returns rev for decide_approval expectedRev.',
      inputSchema: z.object({
        mine: z.enum(['approver', 'requested']).optional().describe("approver = awaiting your decision; requested = you asked. Omit = both"),
        targetId: z.string().optional(),
        status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      const rows = await listApprovals(db, { userId: ctx.userId, mine: a.mine, targetId: a.targetId, status: a.status });
      const readable = await readableTargets(db, ctx.userId, rows,ctx.env.READ_GATE);
      const metas = new Map<string, { title: string; url: string } | null>();
      for (const r of rows) {
        const k = `${r.target_type}:${r.target_id}`;
        if (readable(r) && !metas.has(k)) metas.set(k, await loadTargetMeta(db, r.target_type, r.target_id));
      }
      return txt({
        approvals: await Promise.all(
          rows.map(async (r) => !readable(r) ? { ...restrictedApprovalJson(r), requestedByName: await nameOf(r.requested_by), approverName: await nameOf(r.approver_id) } : ({
            ...(await decorate(r)),
            targetTitle: metas.get(`${r.target_type}:${r.target_id}`)?.title ?? r.target_id,
            url: metas.get(`${r.target_type}:${r.target_id}`)?.url,
          })),
        ),
        count: rows.length,
      });
    },
  );

  reg(
    'decide_approval',
    {
      description:
        'Approve or reject a pending approval — only the named approver, only while pending (one CAS update; replay of the same decision returns the stored row). Pass expectedRev (rev from list_approvals) to refuse deciding a row that changed since you read it.',
      inputSchema: z.object({
        approvalId: z.string(),
        decision: z.enum(['approved', 'rejected']),
        note: z.string().max(2000).optional(),
        expectedRev: z.number().optional(),
      }),
      annotations: { idempotentHint: true },
    },
    async (a) => {
      const target=await db.prepare('SELECT target_id FROM approvals WHERE id=?').bind(a.approvalId).first<{target_id:string}>();
      if(!target)return err('approval not found');
      const authority=await connectorRecordFence(ctx.env,ctx.userId,[target.target_id]);
      const out = await decideApproval(db, {
        approvalId: a.approvalId,
        approverId: ctx.userId,
        decision: a.decision,
        note: a.note,
        expectedRev: a.expectedRev,guard:authority??undefined,
      });
      if (out.outcome === 'not_found') return err('approval not found');
      if (out.outcome === 'not_approver') return err('not your approval to decide');
      if (out.outcome === 'stale_rev') return txt({ error: 'conflict', conflicts: [{ type: 'stale_rev', id: a.approvalId, current: await decorate(out.row!) }] });
      if (out.outcome === 'already_decided') return txt({ error: 'already_decided', approval: await decorate(out.row!) });
      const visible = await (ctx.env.READ_GATE??createReadGate(db, ctx.userId)).canRead(out.row!.target_id);
      const meta = visible ? await loadTargetMeta(db, out.row!.target_type, out.row!.target_id) : null;
      {
        await notify(ctx.env, {
          userId: out.row!.requested_by,
          kind: 'approval_decided',
          actorId: ctx.userId,
          targetType: out.row!.target_type,
          targetId: out.row!.target_id,
          title: `Approval ${a.decision}: ${meta?.title ?? out.row!.target_id}`,
          body: a.note,
          url: meta?.url,
          groupKey: `approval:${out.row!.id}`,
          dedupeKey:`approval_decided:${out.row!.id}`,
        });
      }
      return txt({ approval: visible ? { ...(await decorate(out.row!)), targetTitle: meta?.title, url: meta?.url } : restrictedApprovalJson(out.row!), replayed: out.replayed === true });
    },
  );
}
