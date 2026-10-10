import { api } from '../../core/api';
import { parseGate } from '../../../shared/approvals';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export type ApprovalTargetType = 'record' | 'page';

export interface Approval {
  id: string;
  targetType: ApprovalTargetType;
  targetId: string;
  stageId: string | null;
  requestedBy: string;
  approverId: string;
  status: ApprovalStatus;
  note: string | null;
  decidedNote: string | null;
  decidedAt: number | null;
  createdAt: number;
  /** created_at ms — pass back as expectedRev to CAS a decide. */
  rev: number;
  targetTitle?: string;
  url?: string;
}

export interface ApprovalGateConfig {
  stageId: string;
  approverField?: string;
}

export function gateOf(board: unknown): ApprovalGateConfig | null {
  return parseGate(board as Record<string, unknown> | undefined | null);
}

export const approvalsApi = {
  list(targetId: string) {
    return api<{ approvals: Approval[] }>(`/api/approvals?targetId=${encodeURIComponent(targetId)}`);
  },
  /** All approvals involving me — 'approver' = awaiting my decision,
   * 'requested' = I asked, undefined = both. */
  listAll(mine?: 'approver' | 'requested', status?: ApprovalStatus) {
    const q = new URLSearchParams();
    if (mine) q.set('mine', mine);
    if (status) q.set('status', status);
    return api<{ approvals: Approval[] }>(`/api/approvals?${q.toString()}`);
  },
  request(input: { targetType: ApprovalTargetType; targetId: string; approverId: string; note?: string; stageId?: string }) {
    return api<{ approval: Approval; replayed?: boolean }>('/api/approvals', { method: 'POST', body: input });
  },
  decide(id: string, decision: 'approved' | 'rejected', note?: string, expectedRev?: number) {
    return api<{ approval: Approval }>(`/api/approvals/${encodeURIComponent(id)}/decide`, { method: 'POST', body: { decision, note, expectedRev } });
  },
  cancel(id: string) {
    return api<{ approval: Approval }>(`/api/approvals/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  },
};
