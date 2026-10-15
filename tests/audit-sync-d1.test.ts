// Cross-phase audit regressions — synchronization (Phase 0/1 sync × Phase 4
// approval gates). Each test names the invariant the earlier suites did NOT
// establish: that one record's policy rejection, bad timestamp or oversize
// payload cannot abort a whole client batch and jam the offline outbox.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyChanges, sync, MAX_FUTURE_SKEW_MS, MAX_RECORD_BYTES } from '../worker/sync';
import type { Mutation } from '../shared/types';
import { openAuditFixture, ctx, type AuditFixture } from './audit-fixture';

vi.mock('../worker/events', async (original) => ({
  ...(await original<typeof import('../worker/events')>()),
  scheduleOutbox: vi.fn(),
}));

let fx: AuditFixture;
const change = (id: string, collection: string, patch: Record<string, unknown>, ts = Date.now()): Mutation => ({ id, collection, patch, ts } as Mutation);

beforeEach(async () => { fx = await openAuditFixture(); });
afterEach(async () => { vi.restoreAllMocks(); await fx.dispose(); });

async function push(user: string, changes: Mutation[]) {
  const res = await sync.request('http://localhost/push', { method: 'POST', headers: fx.auth(user), body: JSON.stringify({ changes }) }, fx.env, ctx);
  return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string; rejected?: number; rejectedItems?: { id: string; reason: string }[]; committed?: string[] } };
}
async function row(id: string) {
  const r = await fx.db.prepare('SELECT data, field_ts FROM records WHERE id=?').bind(id).first<{ data: string; field_ts: string }>();
  return r ? { data: JSON.parse(r.data) as Record<string, unknown>, ts: JSON.parse(r.field_ts) as Record<string, number> } : null;
}

describe('approval gate refusals are per-item, never batch-aborting', () => {
  it('a boardId-only move into a gated stage is refused item-wise; unrelated edits in the same push land', async () => {
    await applyChanges(fx.env, 'alice', [
      change('intake', 'boards', { name: 'Intake', columns: [{ id: 'todo' }, { id: 'done' }], approvalGate: { stageId: 'done' } }, 1),
      change('other', 'boards', { name: 'Other', columns: [{ id: 'todo' }, { id: 'done' }] }, 1),
      change('moving', 'tasks', { title: 'Moving', boardId: 'other', status: 'done' }, 1),
      change('notes', 'pages', { title: 'Before' }, 1),
    ]);
    const out = await push('bob', [change('notes', 'pages', { title: 'After' }), change('moving', 'tasks', { boardId: 'intake' })]);
    expect(out.status).toBe(200);
    expect(out.body.rejectedItems).toEqual([expect.objectContaining({ id: 'moving', reason: 'approval_required' })]);
    expect((await row('notes'))!.data.title).toBe('After');
    expect((await row('moving'))!.data.boardId).toBe('other');
  });

  it('an unrelated edit to a record already inside a stage that later became gated (approver-pinned) is accepted', async () => {
    await applyChanges(fx.env, 'alice', [
      change('review', 'boards', { name: 'Review', columns: [{ id: 'todo' }, { id: 'done' }], fields: [{ id: 'owner', name: 'Approver', type: 'person' }] }, 1),
      change('sitting', 'tasks', { title: 'Sitting', boardId: 'review', status: 'done', p_owner: 'bob' }, 1),
      change('notes', 'pages', { title: 'Before' }, 1),
    ]);
    // The gate is configured AFTER the record is in the gated stage: no
    // approval row can exist for it. The gate controls entry, not editing.
    await applyChanges(fx.env, 'alice', [change('review', 'boards', { approvalGate: { stageId: 'done', approverField: 'owner' } })]);
    const out = await push('bob', [change('notes', 'pages', { title: 'After' }), change('sitting', 'tasks', { title: 'Renamed' })]);
    expect(out.status).toBe(200);
    expect(out.body.rejected ?? 0).toBe(0);
    expect((await row('sitting'))!.data.title).toBe('Renamed');
    expect((await row('notes'))!.data.title).toBe('After');
  });

  it('changing the pinned approver on a gated-stage record is refused item-wise, not as a 503 batch failure', async () => {
    await applyChanges(fx.env, 'alice', [
      change('review', 'boards', { name: 'Review', columns: [{ id: 'todo' }, { id: 'done' }], fields: [{ id: 'owner', name: 'Approver', type: 'person' }] }, 1),
      change('sitting', 'tasks', { title: 'Sitting', boardId: 'review', status: 'done', p_owner: 'bob' }, 1),
      change('notes', 'pages', { title: 'Before' }, 1),
    ]);
    await applyChanges(fx.env, 'alice', [change('review', 'boards', { approvalGate: { stageId: 'done', approverField: 'owner' } })]);
    const out = await push('carol', [change('notes', 'pages', { title: 'After' }), change('sitting', 'tasks', { p_owner: 'carol' })]);
    expect(out.status).toBe(200);
    expect(out.body.rejectedItems).toEqual([expect.objectContaining({ id: 'sitting', reason: 'approval_required' })]);
    expect((await row('sitting'))!.data.p_owner).toBe('bob');
    expect((await row('notes'))!.data.title).toBe('After');
  });

  it('a legacy record with no boardId resolves to board-default for the gate and is refused item-wise', async () => {
    await applyChanges(fx.env, 'alice', [
      change('board-default', 'boards', { name: 'Tasks', columns: [{ id: 'todo' }, { id: 'done' }] }, 1),
      change('legacy', 'tasks', { title: 'Legacy', status: 'todo' }, 1),
      change('notes', 'pages', { title: 'Before' }, 1),
    ]);
    await applyChanges(fx.env, 'alice', [change('board-default', 'boards', { approvalGate: { stageId: 'done' } })]);
    const out = await push('bob', [change('notes', 'pages', { title: 'After' }), change('legacy', 'tasks', { status: 'done' })]);
    expect(out.status).toBe(200);
    expect(out.body.rejectedItems).toEqual([expect.objectContaining({ id: 'legacy', reason: 'approval_required' })]);
    expect((await row('legacy'))!.data.status).toBe('todo');
    expect((await row('notes'))!.data.title).toBe('After');
  });
});

describe('client timestamps are bounded (HLC poisoning)', () => {
  it('clamps a far-future client timestamp instead of letting one field win every later merge', async () => {
    const before = Date.now();
    await applyChanges(fx.env, 'bob', [change('t1', 'tasks', { title: 'poison' }, 1e300)]);
    const stored = await row('t1');
    expect(stored!.data.title).toBe('poison');
    expect(stored!.ts.title).toBeLessThanOrEqual(Date.now() + MAX_FUTURE_SKEW_MS);
    expect(stored!.ts.title).toBeGreaterThanOrEqual(before);
  });

  it('a normally stamped edit made after the clamp window wins; a server-stamped edit always wins', async () => {
    await applyChanges(fx.env, 'bob', [change('t1', 'tasks', { title: 'poison' }, Number.MAX_VALUE)]);
    const server = await applyChanges(fx.env, 'alice', [change('t1', 'tasks', { title: 'curated' }, 0)], { serverTs: true });
    expect(server.changed).toBe(1);
    expect((await row('t1'))!.data.title).toBe('curated');
    // The stored timestamps remain finite, ordinary integers a later +1 can advance.
    const ts = (await row('t1'))!.ts.title;
    expect(Number.isSafeInteger(ts)).toBe(true);
  });

  it('negative and non-integer timestamps are accepted without poisoning ordering', async () => {
    await applyChanges(fx.env, 'bob', [change('t2', 'tasks', { title: 'a' }, -5)]);
    await applyChanges(fx.env, 'bob', [change('t2', 'tasks', { title: 'b' }, 10.5)]);
    expect((await row('t2'))!.data.title).toBe('b');
  });
});

describe('oversized records are refused per item', () => {
  it('rejects a write that would exceed the D1 row budget while the rest of the batch applies', async () => {
    await applyChanges(fx.env, 'alice', [change('notes', 'pages', { title: 'Before' }, 1)]);
    const big = 'x'.repeat(MAX_RECORD_BYTES + 1000);
    const out = await push('bob', [change('notes', 'pages', { title: 'After' }), change('blk', 'blocks', { pageId: 'notes', type: 'p', text: big })]);
    expect(out.status).toBe(200);
    expect(out.body.rejectedItems).toEqual([expect.objectContaining({ id: 'blk', reason: 'record_too_large' })]);
    expect(await row('blk')).toBeNull();
    expect((await row('notes'))!.data.title).toBe('After');
  });

  it('never traps data: an already-large record can still be shrunk or soft-deleted', async () => {
    const big = 'y'.repeat(MAX_RECORD_BYTES + 5000);
    // Simulate a legacy row written before the limit existed.
    await fx.db.prepare('INSERT INTO records(id,collection,data,field_ts,seq,updated_by,updated_at) VALUES(?,?,?,?,?,?,?)')
      .bind('legacy-big', 'blocks', JSON.stringify({ pageId: 'p', type: 'p', text: big }), JSON.stringify({ pageId: 1, type: 1, text: 1 }), 900, 'alice', 1).run();
    const out = await push('bob', [change('legacy-big', 'blocks', { deleted: true })]);
    expect(out.status).toBe(200);
    expect(out.body.rejected ?? 0).toBe(0);
    expect((await row('legacy-big'))!.data.deleted).toBe(true);
  });
});

describe('date index maintenance is bounded by batches, not by record count', () => {
  it('reindexing every task of a board after a field change fits the per-invocation D1 budget', async () => {
    const { withD1Budget } = await import('../worker/d1budget');
    const { maintainDateIndex } = await import('../worker/events');
    await applyChanges(fx.env, 'alice', [
      change('plan', 'boards', { name: 'Plan', columns: [{ id: 'todo' }, { id: 'done' }], fields: [{ id: 'due2', name: 'Review by', type: 'date' }] }, 1),
    ]);
    // 120 tasks carrying a date in the newly added field.
    await fx.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<120)
      INSERT INTO records(id,collection,data,field_ts,seq,updated_by,updated_at)
      SELECT 'job'||i,'tasks','{"title":"job","boardId":"plan","status":"todo","p_due2":"2031-01-15"}','{}',5000+i,'alice',1 FROM n`).run();
    const budgeted = withD1Budget(fx.env);
    await maintainDateIndex(budgeted, [{ id: 'plan', collection: 'boards', created: false, fields: ['fields'], before: {}, after: {} }]);
    const indexed = (await fx.db.prepare("SELECT COUNT(*) n FROM date_index WHERE field_key='p_due2'").first<{ n: number }>())!.n;
    expect(indexed).toBe(120);
  });
});

describe('legacy poisoned timestamps heal on the next write', () => {
  it('a field stored with an absurd timestamp accepts an ordinary edit and is repaired', async () => {
    // Written by an earlier release that did not bound client timestamps.
    await fx.db.prepare('INSERT INTO records(id,collection,data,field_ts,seq,updated_by,updated_at) VALUES(?,?,?,?,?,?,?)')
      .bind('legacy', 'tasks', JSON.stringify({ title: 'old', status: 'todo' }), JSON.stringify({ title: 1e300, status: 5 }), 800, 'bob', 1_000).run();
    const out = await push('carol', [change('legacy', 'tasks', { title: 'fixed' })]);
    expect(out.status).toBe(200);
    const stored = await row('legacy');
    expect(stored!.data.title).toBe('fixed');
    expect(stored!.ts.title).toBeLessThanOrEqual(Date.now() + MAX_FUTURE_SKEW_MS);
    expect(Number.isSafeInteger(stored!.ts.title)).toBe(true);
  });

  it('an untouched poisoned sibling field is healed by the same write', async () => {
    await fx.db.prepare('INSERT INTO records(id,collection,data,field_ts,seq,updated_by,updated_at) VALUES(?,?,?,?,?,?,?)')
      .bind('legacy2', 'tasks', JSON.stringify({ title: 'old', description: 'd' }), JSON.stringify({ title: 10, description: 1e300 }), 801, 'bob', 2_000).run();
    await push('carol', [change('legacy2', 'tasks', { title: 'renamed' })]);
    const stored = await row('legacy2');
    expect(stored!.ts.description).toBeLessThanOrEqual(Date.now() + MAX_FUTURE_SKEW_MS);
    expect(stored!.data.description).toBe('d');
  });
});
