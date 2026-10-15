import { describe, it, expect, beforeEach } from 'vitest';
import type { Mutation } from '../shared/types';
import type { Env } from '../worker/auth';
import { applyChanges } from '../worker/sync';
import {
  gateMatches, isDecision, isMine, needsMyDecision, normalizeApprovalRequest,
  parseGate, requestKeyFor, requiredApproverId, fnv1a,
} from '../shared/approvals';
import {
  cancelApproval, decideApproval, guardStageWrites, insertApproval,
  listApprovals, loadTargetMeta, userExists, validateApprovalRequest,
  type ApprovalRow,
} from '../worker/approvals';

/* ---------- shared/approvals.ts — pure helpers ---------- */

describe('shared approvals helpers', () => {
  it('requestKeyFor: caller requestId wins; else deterministic content hash', () => {
    const base = { requestedBy: 'u1', targetType: 'record', targetId: 't1', approverId: 'u2' };
    expect(requestKeyFor({ ...base, requestId: 'abc-1' })).toBe('req_abc-1');
    const a = requestKeyFor(base);
    const b = requestKeyFor({ ...base });
    expect(a).toBe(b);
    expect(a.startsWith('rk_')).toBe(true);
    expect(requestKeyFor({ ...base, note: 'x' })).not.toBe(a);
    expect(requestKeyFor({ ...base, stageId: 's1' })).not.toBe(a);
    expect(typeof fnv1a('')).toBe('string');
  });

  it('parseGate accepts a well-formed gate, rejects the rest', () => {
    expect(parseGate({ approvalGate: { stageId: 'done' } })).toEqual({ stageId: 'done', approverField: undefined });
    expect(parseGate({ approvalGate: { stageId: 'done', approverField: 'f1' } })).toEqual({ stageId: 'done', approverField: 'f1' });
    expect(parseGate({})).toBeNull();
    expect(parseGate(null)).toBeNull();
    expect(parseGate({ approvalGate: { stageId: '' } })).toBeNull();
    expect(parseGate({ approvalGate: 'done' })).toBeNull();
  });

  it('gateMatches narrows and only matches the gate stage', () => {
    const g = parseGate({ approvalGate: { stageId: 'done' } });
    expect(gateMatches(g, 'done')).toBe(true);
    expect(gateMatches(g, 'todo')).toBe(false);
    expect(gateMatches(null, 'done')).toBe(false);
  });

  it('requiredApproverId reads p_<field> off the record; no field → undefined', () => {
    const g = parseGate({ approvalGate: { stageId: 'done', approverField: 'owner' } })!;
    expect(requiredApproverId(g, { p_owner: 'u9' })).toBe('u9');
    expect(requiredApproverId(g, {})).toBeUndefined();
    expect(requiredApproverId(parseGate({ approvalGate: { stageId: 'done' } }), { p_owner: 'u9' })).toBeUndefined();
    expect(requiredApproverId(null, {})).toBeUndefined();
  });

  it('normalizeApprovalRequest validates shape; keeps optional fields', () => {
    expect(normalizeApprovalRequest(null)).toEqual({ error: 'invalid body' });
    expect(normalizeApprovalRequest({})).toEqual({ error: 'targetId required' });
    expect(normalizeApprovalRequest({ targetId: 't' })).toEqual({ error: 'approverId required' });
    expect(normalizeApprovalRequest({ targetType: 'weird', targetId: 't', approverId: 'u' })).toEqual({ error: 'targetType must be record or page' });
    expect(normalizeApprovalRequest({ targetId: 't', approverId: 'u', requestId: 'bad key!' })).toEqual({ error: 'requestId must be 1-64 chars of [A-Za-z0-9_-]' });
    const ok = normalizeApprovalRequest({ targetId: ' t ', approverId: ' u2 ', note: 'hi', stageId: 'done' });
    expect('error' in ok).toBe(false);
    if (!('error' in ok)) {
      expect(ok.targetType).toBe('record');
      expect(ok.targetId).toBe('t');
      expect(ok.approverId).toBe('u2');
      expect(ok.note).toBe('hi');
      expect(ok.stageId).toBe('done');
    }
  });

  it('isDecision / isMine / needsMyDecision', () => {
    expect(isDecision('approved')).toBe(true);
    expect(isDecision('rejected')).toBe(true);
    expect(isDecision('pending')).toBe(false);
    const row = { approver_id: 'u2', requested_by: 'u1', status: 'pending' };
    expect(isMine(row, 'u1')).toBe(true);
    expect(isMine(row, 'u2')).toBe(true);
    expect(isMine(row, 'u3')).toBe(false);
    expect(needsMyDecision(row, 'u2')).toBe(true);
    expect(needsMyDecision(row, 'u1')).toBe(false);
    expect(needsMyDecision({ ...row, status: 'approved' }, 'u2')).toBe(false);
  });
});

/* ---------- FakeD1 covering records + approvals + users ---------- */

interface RecRow { id: string; collection: string; data: string; field_ts: string; seq: number; updated_by: string | null; updated_at: number | null }

class FakeD1 {
  records = new Map<string, RecRow>();
  approvals = new Map<string, ApprovalRow>();
  users = new Set<string>();
  seq = 0;
  seen: string[] = [];

  putRec(id: string, collection: string, data: Record<string, unknown>) {
    const fieldTs = Object.fromEntries(Object.keys(data).map((k) => [k, 1]));
    this.records.set(id, { id, collection, data: JSON.stringify(data), field_ts: JSON.stringify(fieldTs), seq: ++this.seq, updated_by: 'seed', updated_at: 1 });
  }
  putUser(id: string) {
    this.users.add(id);
  }

  private filterApprovals(sql: string, binds: unknown[]): ApprovalRow[] {
    let i = 0;
    let rows = [...this.approvals.values()];
    const take = () => binds[i++];
    if (/\(approver_id = \? OR requested_by = \?\)/.test(sql)) {
      const u = String(take());
      take();
      rows = rows.filter((r) => r.approver_id === u || r.requested_by === u);
    } else if (/approver_id = \?/.test(sql)) {
      const v = take();
      rows = rows.filter((r) => r.approver_id === v);
    } else if (/requested_by = \?/.test(sql)) {
      const v = take();
      rows = rows.filter((r) => r.requested_by === v);
    }
    if (/target_id = \?/.test(sql)) {
      const v = take();
      rows = rows.filter((r) => r.target_id === v);
    }
    if (/status = \?/.test(sql)) {
      const v = take();
      rows = rows.filter((r) => r.status === v);
    }
    const limit = Number(binds[i] ?? 50);
    return rows.sort((a, b) => b.created_at - a.created_at).slice(0, limit);
  }

  exec(sql: string, binds: unknown[]): { results: unknown[]; changes: number } {
    this.seen.push(sql.slice(0, 70));
    if (/SELECT CASE WHEN NOT EXISTS/.test(sql) && /approvalGate/.test(sql)) {
      const next = JSON.parse(String(binds[0]));
      const previous = JSON.parse(String(binds[3]));
      const board = this.records.get(next.boardId ?? 'board-default');
      const gate = board?.collection === 'boards' ? parseGate(JSON.parse(board.data)) : null;
      const pinned = gate?.approverField ? `p_${gate.approverField}` : null;
      if (gate && next.status === gate.stageId && (next.status !== previous.status || next.boardId !== previous.boardId || (pinned && next[pinned] !== previous[pinned]))) {
        const approved = [...this.approvals.values()].some(row => row.target_type === 'record' && row.target_id === binds[8]
          && row.status === 'approved' && (row.stage_id === gate.stageId || row.stage_id === null)
          && (!gate.approverField || row.approver_id === next[`p_${gate.approverField}`]));
        if (!approved) throw new Error('malformed JSON');
      }
      return { results: [{ allowed: 1 }], changes: 0 };
    }
    // applyChanges readRows: full record projection.
    if (/SELECT id, collection, data, field_ts, seq, updated_by, updated_at FROM records WHERE id IN/.test(sql)) {
      const results = binds.map((id) => this.records.get(String(id))).filter((r): r is RecRow => !!r);
      return { results, changes: 0 };
    }
    // applyChanges CAS upsert (INSERT ... ON CONFLICT ... WHERE records.seq = ?).
    if (/INSERT INTO records/.test(sql)) {
      const [id, collection, data, fieldTs, userId, now, baseSeq] = binds as [string, string, string, string, string, number, number];
      const row = this.records.get(id);
      if (row && row.seq !== baseSeq) return { results: [], changes: 0 };
      this.seq += 1;
      this.records.set(id, { id, collection, data, field_ts: fieldTs, seq: this.seq, updated_by: userId, updated_at: now });
      return { results: [{ seq: this.seq }], changes: 1 };
    }
    if (/SELECT id, data FROM records WHERE id IN/.test(sql)) {
      const results = binds.map((id) => this.records.get(String(id))).filter((r): r is RecRow => !!r).map((r) => ({ id: r.id, data: r.data }));
      return { results, changes: 0 };
    }
    if (/SELECT data FROM records WHERE id = \? AND collection = \?/.test(sql)) {
      const r = this.records.get(String(binds[0]));
      if (!r || r.collection !== binds[1]) return { results: [], changes: 0 };
      const d = JSON.parse(r.data) as Record<string, unknown>;
      if (d.deleted === true) return { results: [], changes: 0 };
      return { results: [{ data: r.data }], changes: 0 };
    }
    if (/FROM approvals\n?\s+WHERE target_type = 'record'/.test(sql) || /SELECT approver_id FROM approvals/.test(sql)) {
      const results = [...this.approvals.values()]
        .filter((r) => r.target_type === 'record' && r.target_id === binds[0] && r.status === 'approved' && (r.stage_id === binds[1] || r.stage_id === null))
        .map((r) => ({ approver_id: r.approver_id }));
      return { results, changes: 0 };
    }
    if (/INSERT OR IGNORE INTO approvals/.test(sql)) {
      const [id, targetType, targetId, stageId, requestedBy, approverId, note, requestKey, createdAt] = binds as [string, string, string, string | null, string, string, string | null, string, number];
      const dup = [...this.approvals.values()].find((r) => r.request_key === requestKey);
      if (dup) return { results: [], changes: 0 };
      this.approvals.set(id, {
        id, target_type: targetType, target_id: targetId, stage_id: stageId, requested_by: requestedBy,
        approver_id: approverId, status: 'pending', note, decided_note: null, request_key: requestKey, decided_at: null, created_at: createdAt,
      });
      return { results: [], changes: 1 };
    }
    if (/SELECT \* FROM approvals WHERE request_key = \?/.test(sql)) {
      const found = [...this.approvals.values()].filter((r) => r.request_key === binds[0]);
      return { results: found, changes: 0 };
    }
    if (/UPDATE approvals SET status = \?, decided_note = \?, decided_at = \?/.test(sql)) {
      const [decision, note, decidedAt, id, approverId] = binds as [string, string | null, number, string, string];
      const row = this.approvals.get(id);
      const extra = /AND created_at = \?/.test(sql) ? Number(binds[5]) : undefined;
      if (row && row.approver_id === approverId && row.status === 'pending' && (extra === undefined || row.created_at === extra)) {
        this.approvals.set(id, { ...row, status: decision as ApprovalRow['status'], decided_note: note, decided_at: decidedAt });
        return { results: [], changes: 1 };
      }
      return { results: [], changes: 0 };
    }
    if (/UPDATE approvals SET status = 'cancelled', decided_at = \?/.test(sql)) {
      const [decidedAt, id, requesterId] = binds as [number, string, string];
      const row = this.approvals.get(id);
      if (row && row.requested_by === requesterId && row.status === 'pending') {
        this.approvals.set(id, { ...row, status: 'cancelled', decided_at: decidedAt });
        return { results: [], changes: 1 };
      }
      return { results: [], changes: 0 };
    }
    if (/SELECT \* FROM approvals WHERE \bid = \?/.test(sql)) {
      const row = this.approvals.get(String(binds[0]));
      return { results: row ? [row] : [], changes: 0 };
    }
    if (/SELECT \* FROM approvals WHERE/.test(sql) && /ORDER BY created_at DESC LIMIT/.test(sql)) {
      return { results: this.filterApprovals(sql, binds), changes: 0 };
    }
    if (/SELECT id FROM users WHERE id = \?/.test(sql)) {
      return { results: this.users.has(String(binds[0])) ? [{ id: binds[0] }] : [], changes: 0 };
    }
    throw new Error(`FakeD1 unhandled SQL: ${sql.slice(0, 90)}`);
  }

  prepare(sql: string) {
    const self = this;
    let binds: unknown[] = [];
    const stmt = {
      bind: (...b: unknown[]) => {
        binds = b;
        return stmt;
      },
      run: async () => {
        const r = self.exec(sql, binds);
        return { success: true, results: r.results, meta: { changes: r.changes } };
      },
      all: async () => {
        const r = self.exec(sql, binds);
        return { success: true, results: r.results, meta: { changes: r.changes } };
      },
      first: async () => {
        const r = self.exec(sql, binds);
        return (r.results[0] ?? null) as unknown;
      },
    };
    return stmt as unknown as D1PreparedStatement;
  }

  async batch(stmts: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
    const snapshot = new Map([...this.records].map(([k, v]) => [k, { ...v }]));
    const approvals = new Map([...this.approvals].map(([k, v]) => [k, { ...v }]));
    const seq0 = this.seq;
    const out: D1Result<unknown>[] = [];
    try {
      for (const s of stmts) out.push((await s.run()) as D1Result<unknown>);
    } catch (e) {
      this.records = snapshot;
      this.approvals = approvals;
      this.seq = seq0;
      throw e;
    }
    return out;
  }
}

const env = (db: FakeD1) => ({ DB: db as unknown as D1Database });

/* ---------- worker helpers ---------- */

function seedBoardTask(db: FakeD1, opts: { gate?: object; taskData?: Record<string, unknown>; boardId?: string; taskId?: string }) {
  const boardId = opts.boardId ?? 'b1';
  const taskId = opts.taskId ?? 't1';
  db.putRec(boardId, 'boards', { name: 'Board', ...(opts.gate ? { approvalGate: opts.gate } : {}) });
  db.putRec(taskId, 'tasks', { title: 'Task', boardId, status: 'todo', ...(opts.taskData ?? {}) });
  return { boardId, taskId };
}

const stageChange = (taskId: string, status: string, extra?: Record<string, unknown>): Mutation => ({
  id: taskId,
  collection: 'tasks',
  patch: { status, ...(extra ?? {}) },
  ts: 10,
});

describe('guardStageWrites', () => {
  let db: FakeD1;
  let rejected: { id: unknown; collection: unknown; reason: string }[];
  const reject = (id: unknown, collection: unknown, reason: string) => rejected.push({ id, collection, reason });

  beforeEach(() => {
    db = new FakeD1();
    rejected = [];
  });

  it('ungated stage write passes untouched', async () => {
    seedBoardTask(db, {});
    const ch = stageChange('t1', 'done');
    await guardStageWrites(env(db), [ch], reject);
    expect(rejected).toEqual([]);
    expect(ch.patch.status).toBe('done');
  });

  it('gated stage write is stripped + rejected approval_required; other fields merge', async () => {
    seedBoardTask(db, { gate: { stageId: 'done' } });
    const ch = stageChange('t1', 'done', { title: 'renamed' });
    await guardStageWrites(env(db), [ch], reject);
    expect(rejected).toEqual([{ id: 't1', collection: 'tasks', reason: 'approval_required' }]);
    expect(ch.patch.status).toBeUndefined();
    expect(ch.patch.title).toBe('renamed');
  });

  it('approved decision covering the stage allows the write', async () => {
    seedBoardTask(db, { gate: { stageId: 'done' } });
    db.approvals.set('a1', { id: 'a1', target_type: 'record', target_id: 't1', stage_id: 'done', requested_by: 'u1', approver_id: 'u2', status: 'approved', note: null, decided_note: null, request_key: 'k1', decided_at: 1, created_at: 1 });
    const ch = stageChange('t1', 'done');
    await guardStageWrites(env(db), [ch], reject);
    expect(rejected).toEqual([]);
  });

  it('approval for a DIFFERENT stage does not satisfy the gate', async () => {
    seedBoardTask(db, { gate: { stageId: 'done' } });
    db.approvals.set('a1', { id: 'a1', target_type: 'record', target_id: 't1', stage_id: 'review', requested_by: 'u1', approver_id: 'u2', status: 'approved', note: null, decided_note: null, request_key: 'k1', decided_at: 1, created_at: 1 });
    const ch = stageChange('t1', 'done');
    await guardStageWrites(env(db), [ch], reject);
    expect(rejected[0]?.reason).toBe('approval_required');
  });

  it('approverField pins the gate to the member in the record person field', async () => {
    seedBoardTask(db, { gate: { stageId: 'done', approverField: 'owner' }, taskData: { p_owner: 'u9' } });
    db.approvals.set('a1', { id: 'a1', target_type: 'record', target_id: 't1', stage_id: 'done', requested_by: 'u1', approver_id: 'u2', status: 'approved', note: null, decided_note: null, request_key: 'k1', decided_at: 1, created_at: 1 });
    const ch = stageChange('t1', 'done');
    await guardStageWrites(env(db), [ch], reject);
    expect(rejected[0]?.reason).toBe('approval_required'); // approver was u2, field wants u9

    rejected = [];
    db.approvals.set('a2', { id: 'a2', target_type: 'record', target_id: 't1', stage_id: 'done', requested_by: 'u1', approver_id: 'u9', status: 'approved', note: null, decided_note: null, request_key: 'k2', decided_at: 1, created_at: 1 });
    const ch2 = stageChange('t1', 'done');
    await guardStageWrites(env(db), [ch2], reject);
    expect(rejected).toEqual([]);
  });

  it('patch-supplied approverField value wins for the pin check', async () => {
    seedBoardTask(db, { gate: { stageId: 'done', approverField: 'owner' }, taskData: { p_owner: 'u2' } });
    db.approvals.set('a1', { id: 'a1', target_type: 'record', target_id: 't1', stage_id: 'done', requested_by: 'u1', approver_id: 'u9', status: 'approved', note: null, decided_note: null, request_key: 'k1', decided_at: 1, created_at: 1 });
    // patch moves the owner to u9 in the same change → the u9 approval counts
    const ch = stageChange('t1', 'done', { p_owner: 'u9' });
    await guardStageWrites(env(db), [ch], reject);
    expect(rejected).toEqual([]);
  });
});

describe('insertApproval / decideApproval / cancelApproval / listApprovals', () => {
  let db: FakeD1;
  beforeEach(() => {
    db = new FakeD1();
    db.putUser('u1');
    db.putUser('u2');
    db.putRec('t1', 'tasks', { title: 'Task', boardId: 'b1' });
    db.putRec('p1', 'pages', { title: 'Page' });
  });

  const req = { targetType: 'record', targetId: 't1', requestedBy: 'u1', approverId: 'u2' };

  it('request_key dedupes: second insert with same key replays the stored row', async () => {
    const k = requestKeyFor(req);
    const a = await insertApproval(db as unknown as D1Database, { ...req, requestKey: k });
    const b = await insertApproval(db as unknown as D1Database, { ...req, requestKey: k });
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(b.row.id).toBe(a.row.id);
    expect(db.approvals.size).toBe(1);
  });

  it('decide: only the approver, only while pending; replay of same decision is replayed', async () => {
    const { row } = await insertApproval(db as unknown as D1Database, { ...req, requestKey: 'k1' });
    const wrong = await decideApproval(db as unknown as D1Database, { approvalId: row.id, approverId: 'u1', decision: 'approved' });
    expect(wrong.outcome).toBe('not_approver');

    const ok = await decideApproval(db as unknown as D1Database, { approvalId: row.id, approverId: 'u2', decision: 'approved', note: 'lgtm' });
    expect(ok.outcome).toBe('ok');
    expect(ok.row!.status).toBe('approved');
    expect(ok.row!.decided_note).toBe('lgtm');

    const replay = await decideApproval(db as unknown as D1Database, { approvalId: row.id, approverId: 'u2', decision: 'approved' });
    expect(replay.replayed).toBe(true);

    const flip = await decideApproval(db as unknown as D1Database, { approvalId: row.id, approverId: 'u2', decision: 'rejected' });
    expect(flip.outcome).toBe('already_decided');

    const ghost = await decideApproval(db as unknown as D1Database, { approvalId: 'ap_none', approverId: 'u2', decision: 'approved' });
    expect(ghost.outcome).toBe('not_found');
  });

  it('decide with expectedRev: stale rev refuses before the CAS', async () => {
    const { row } = await insertApproval(db as unknown as D1Database, { ...req, requestKey: 'k2' });
    const stale = await decideApproval(db as unknown as D1Database, { approvalId: row.id, approverId: 'u2', decision: 'approved', expectedRev: row.created_at - 1 });
    expect(stale.outcome).toBe('stale_rev');
    const ok = await decideApproval(db as unknown as D1Database, { approvalId: row.id, approverId: 'u2', decision: 'approved', expectedRev: row.created_at });
    expect(ok.outcome).toBe('ok');
  });

  it('cancel: requester only, pending only', async () => {
    const { row } = await insertApproval(db as unknown as D1Database, { ...req, requestKey: 'k3' });
    expect((await cancelApproval(db as unknown as D1Database, { approvalId: row.id, requesterId: 'u2' })).outcome).toBe('not_requester');
    expect((await cancelApproval(db as unknown as D1Database, { approvalId: row.id, requesterId: 'u1' })).outcome).toBe('ok');
    expect((await cancelApproval(db as unknown as D1Database, { approvalId: row.id, requesterId: 'u1' })).outcome).toBe('not_pending');
  });

  it('listApprovals: mine scoping + targetId/status filters', async () => {
    const mk = async (key: string, over: Partial<typeof req> = {}) =>
      (await insertApproval(db as unknown as D1Database, { ...req, ...over, requestKey: key })).row;
    const a1 = await mk('l1');
    const a2 = await mk('l2', { approverId: 'u1', requestedBy: 'u2' });
    const a3 = await mk('l3', { targetId: 'p1', targetType: 'page' });
    await decideApproval(db as unknown as D1Database, { approvalId: a3.id, approverId: 'u2', decision: 'approved' });

    const all = await listApprovals(db as unknown as D1Database, { userId: 'u1' });
    expect(all.map((r) => r.id).sort()).toEqual([a1.id, a2.id, a3.id].sort());
    const awaiting = await listApprovals(db as unknown as D1Database, { userId: 'u1', mine: 'approver' });
    expect(awaiting.map((r) => r.id)).toEqual([a2.id]);
    const requested = await listApprovals(db as unknown as D1Database, { userId: 'u1', mine: 'requested' });
    expect(requested.map((r) => r.id).sort()).toEqual([a1.id, a3.id].sort());
    const pending = await listApprovals(db as unknown as D1Database, { userId: 'u1', status: 'pending' });
    expect(pending.map((r) => r.id).sort()).toEqual([a1.id, a2.id].sort());
    const byTarget = await listApprovals(db as unknown as D1Database, { userId: 'u1', targetId: 'p1' });
    expect(byTarget.map((r) => r.id)).toEqual([a3.id]);
    // Other members never see rows that don't involve them.
    expect(await listApprovals(db as unknown as D1Database, { userId: 'u9' })).toEqual([]);
  });
});

describe('loadTargetMeta / userExists / validateApprovalRequest', () => {
  let db: FakeD1;
  beforeEach(() => {
    db = new FakeD1();
    db.putUser('u2');
    db.putRec('t1', 'tasks', { title: 'Ship it', boardId: 'b7' });
    db.putRec('p1', 'pages', { title: 'Doc' });
    db.putRec('gone', 'tasks', { title: 'old', deleted: true });
  });

  it('loadTargetMeta resolves record/page deep links; ghosts return null', async () => {
    const rec = await loadTargetMeta(db as unknown as D1Database, 'record', 't1');
    expect(rec).toEqual({ title: 'Ship it', url: '/boards/b7/tasks/t1', boardId: 'b7' });
    expect(await loadTargetMeta(db as unknown as D1Database, 'page', 'p1')).toEqual({ title: 'Doc', url: '/pages/p1' });
    expect(await loadTargetMeta(db as unknown as D1Database, 'record', 'gone')).toBeNull();
    expect(await loadTargetMeta(db as unknown as D1Database, 'record', 'nope')).toBeNull();
    expect(await loadTargetMeta(db as unknown as D1Database, 'weird', 't1')).toBeNull();
  });

  it('userExists / validation refuses ghost approver + ghost target', async () => {
    expect(await userExists(db as unknown as D1Database, 'u2')).toBe(true);
    expect(await userExists(db as unknown as D1Database, 'u9')).toBe(false);
    const bad = await validateApprovalRequest(db as unknown as D1Database, 'u1', { targetId: 't1', approverId: 'u9' });
    expect(bad).toEqual({ error: 'approver not found' });
    const bad2 = await validateApprovalRequest(db as unknown as D1Database, 'u1', { targetId: 'gone', approverId: 'u2' });
    expect(bad2).toEqual({ error: 'target not found' });
    const ok = await validateApprovalRequest(db as unknown as D1Database, 'u1', { targetId: 't1', approverId: 'u2', stageId: 'done' });
    expect('error' in ok).toBe(false);
  });
});

/* ---------- applyChanges-level: the gate binds EVERY write pathway ----------
 * Client push, MCP update_records, automations and undo all funnel through
 * applyChanges in worker/sync.ts. These fake-backed tests cover that shared
 * function's control flow; actual REST/MCP paths and SQLite transactions have
 * separate integration coverage. */
describe('applyChanges approval gate (covers MCP update_records pathway)', () => {
  let db: FakeD1;
  beforeEach(() => {
    db = new FakeD1();
  });

  const gatedWrite = (extra?: Record<string, unknown>): Mutation => ({
    id: 't1',
    collection: 'tasks',
    patch: { status: 'done', ...(extra ?? {}) },
    ts: Date.now(),
  });

  it('stage write into a gated stage rejects approval_required; other fields still merge', async () => {
    seedBoardTask(db, { gate: { stageId: 'done' } });
    const res = await applyChanges(env(db) as unknown as Env, 'u1', [gatedWrite({ title: 'renamed' })], { serverTs: true });
    expect(res.rejected).toBe(1);
    expect(res.rejectedItems?.[0]).toEqual({ id: 't1', collection: 'tasks', reason: 'approval_required' });
    const row = db.records.get('t1')!;
    const data = JSON.parse(row.data) as Record<string, unknown>;
    expect(data.status).toBe('todo'); // gated field stripped before merge
    expect(data.title).toBe('renamed'); // non-gated fields still applied
  });

  it('the same write applies once a matching approved approval exists', async () => {
    seedBoardTask(db, { gate: { stageId: 'done' } });
    db.approvals.set('a1', { id: 'a1', target_type: 'record', target_id: 't1', stage_id: 'done', requested_by: 'u1', approver_id: 'u2', status: 'approved', note: null, decided_note: null, request_key: 'k1', decided_at: 1, created_at: 1 });
    const res = await applyChanges(env(db) as unknown as Env, 'u1', [gatedWrite()], { serverTs: true });
    expect(res.rejected).toBe(0);
    expect(res.applied.map((a) => a.id)).toEqual(['t1']);
    expect((JSON.parse(db.records.get('t1')!.data) as Record<string, unknown>).status).toBe('done');
  });
});

describe('guardStageWrites proposedBoards (gate introduced in the same write)', () => {
  it('a gate that arrives with the status write is honoured, not only persisted board rows', async () => {
    const db = new FakeD1();
    seedBoardTask(db, {}); // the persisted board has NO gate
    const rejected: { id: unknown; reason: string }[] = [];
    const ch = stageChange('t1', 'done');
    await guardStageWrites(env(db), [ch], (id, _collection, reason) => rejected.push({ id, reason }), {
      proposedBoards: new Map([['b1', { name: 'Board', approvalGate: { stageId: 'done' } }]]),
    });
    expect(rejected).toEqual([{ id: 't1', reason: 'approval_required' }]);
    expect(ch.patch.status).toBeUndefined();
  });
});
