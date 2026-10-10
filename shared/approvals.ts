// Phase 4 — approvals (Workstream D): pure helpers shared by the worker
// (gate guard, REST, MCP tools) and the client (gate UX, badges). No I/O —
// every function is deterministic and unit-tested in tests/approvals.test.ts.

export type ApprovalDecision = 'approved' | 'rejected';
export type ApprovalStatus = 'pending' | ApprovalDecision | 'cancelled';
export const APPROVAL_STATUSES: readonly ApprovalStatus[] = ['pending', 'approved', 'rejected', 'cancelled'];

export interface ApprovalGate {
  stageId: string;
  approverField?: string;
}

export const REQ_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_APPROVAL_NOTE = 2000;
export const MAX_STAGE_ID = 64;

export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Idempotency key for an approval request: caller requestId wins, else a
 * deterministic content hash so a lost-response retry dedupes by payload. */
export function requestKeyFor(input: {
  requestedBy: string;
  targetType: string;
  targetId: string;
  stageId?: string;
  approverId: string;
  note?: string;
  requestId?: string;
}): string {
  if (input.requestId) return `req_${input.requestId}`;
  return 'rk_' + fnv1a(JSON.stringify([input.requestedBy, input.targetType, input.targetId, input.stageId ?? null, input.approverId, input.note ?? null]));
}

/** board.data.approvalGate → typed gate (or null). Member config — set/clear
 * freely via normal boards writes; the gate only READS it. */
export function parseGate(boardData: Record<string, unknown> | undefined | null): ApprovalGate | null {
  const g = boardData?.approvalGate;
  if (!g || typeof g !== 'object') return null;
  const gate = g as { stageId?: unknown; approverField?: unknown };
  if (typeof gate.stageId !== 'string' || !gate.stageId) return null;
  return { stageId: gate.stageId, approverField: typeof gate.approverField === 'string' && gate.approverField ? gate.approverField : undefined };
}

/** A status write is gated iff it targets the gate's stage. Type predicate so
 * `if (!gateMatches(gate, to)) return` narrows gate for the caller. */
export function gateMatches(gate: ApprovalGate | null, toStatus: unknown): gate is ApprovalGate {
  return !!gate && gate.stageId === toStatus;
}

/** The user id the gate pins approval to — record.p_<approverField>. Returns
 * undefined when the gate has no approverField (any member's approval counts). */
export function requiredApproverId(gate: ApprovalGate | null, recordData: Record<string, unknown>): string | undefined {
  if (!gate?.approverField) return undefined;
  const v = recordData[`p_${gate.approverField}`];
  return typeof v === 'string' && v ? v : undefined;
}

export interface ApprovalRequestInput {
  targetType?: string;
  targetId?: string;
  approverId?: string;
  note?: string;
  stageId?: string;
  requestId?: string;
}

/** Shape/length validation of a request body — existence checks (target,
 * approver) live in the worker since they need the DB. Returns the error or a
 * normalized input. */
export function normalizeApprovalRequest(body: ApprovalRequestInput | null | undefined):
  | { error: string }
  | { targetType: 'record' | 'page'; targetId: string; approverId: string; note?: string; stageId?: string; requestId?: string } {
  if (!body || typeof body !== 'object') return { error: 'invalid body' };
  const targetType = body.targetType ?? 'record';
  if (targetType !== 'record' && targetType !== 'page') return { error: 'targetType must be record or page' };
  const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : '';
  if (!targetId) return { error: 'targetId required' };
  const approverId = typeof body.approverId === 'string' ? body.approverId.trim() : '';
  if (!approverId) return { error: 'approverId required' };
  if (body.requestId !== undefined && !REQ_KEY_RE.test(body.requestId)) return { error: 'requestId must be 1-64 chars of [A-Za-z0-9_-]' };
  const note = typeof body.note === 'string' ? body.note.slice(0, MAX_APPROVAL_NOTE) : undefined;
  const stageId = typeof body.stageId === 'string' && body.stageId ? body.stageId.slice(0, MAX_STAGE_ID) : undefined;
  return { targetType, targetId, approverId, note, stageId, requestId: body.requestId };
}

export function isDecision(v: unknown): v is ApprovalDecision {
  return v === 'approved' || v === 'rejected';
}

/** Row-level predicates (decision authority is enforced server-side; these
 * keep worker + client badge logic identical). */
export function isMine(row: { approver_id: string; requested_by: string }, userId: string): boolean {
  return row.approver_id === userId || row.requested_by === userId;
}
export function needsMyDecision(row: { approver_id: string; status: string }, userId: string): boolean {
  return row.approver_id === userId && row.status === 'pending';
}
