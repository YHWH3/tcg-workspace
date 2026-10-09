import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import { planPushOutcome, refreshPending, syncStore } from '../src/core/sync/engine';
import type { OutboxEntry } from '../src/core/db';

/* Review B5 — the client must only delete server-ACKNOWLEDGED outbox entries.
 * Partial rejection keeps rejected items locally (marked, payload preserved)
 * instead of claiming them synced. */

const e = (autoId: number, id: string, collection = 'tasks', ts = 1): OutboxEntry => ({ autoId, id, collection: collection as OutboxEntry['collection'], patch: { title: `t${autoId}` }, ts });

describe('pushOutbox server-rejection handling (review B5)', () => {
  it('partial rejection: only acknowledged entries are deleted', () => {
    const entries = [e(1, 'a'), e(2, 'b'), e(3, 'c')];
    const { acked, refused } = planPushOutcome(entries, [{ id: 'b', collection: 'tasks', reason: 'invalid_mutation' }]);
    expect(acked.map((x) => x.autoId)).toEqual([1, 3]); // only these get deleted
    expect(refused).toHaveLength(1);
    expect(refused[0].autoId).toBe(2);
    expect(refused[0].state).toBe('rejected');
    expect(refused[0].rejectReason).toBe('invalid_mutation');
    expect(refused[0].patch).toEqual({ title: 't2' }); // full payload preserved
  });

  it('no rejections → every entry acknowledged', () => {
    const entries = [e(1, 'a'), e(2, 'b')];
    const { acked, refused } = planPushOutcome(entries, []);
    expect(acked).toHaveLength(2);
    expect(refused).toHaveLength(0);
  });

  it('all rejected → nothing deleted, everything retained', () => {
    const entries = [e(1, 'a'), e(2, 'b')];
    const { acked, refused } = planPushOutcome(entries, [
      { id: 'a', collection: 'tasks', reason: 'r1' },
      { id: 'b', collection: 'tasks', reason: 'r2' },
    ]);
    expect(acked).toHaveLength(0);
    expect(refused).toHaveLength(2);
    expect(refused.every((x) => x.state === 'rejected')).toBe(true);
  });

  it('rejection keyed by collection:id — same id in another collection unaffected', () => {
    const entries = [e(1, 'a', 'tasks'), e(2, 'a', 'boards')];
    const { acked, refused } = planPushOutcome(entries, [{ id: 'a', collection: 'tasks', reason: 'x' }]);
    expect(acked.map((x) => x.collection)).toEqual(['boards']);
    expect(refused.map((x) => x.collection)).toEqual(['tasks']);
  });
});

describe('rejected-only queue surfaces as unsynced (review S3)', () => {
  it('a queue with ONLY rejected rows must not report synced', async () => {
    const { db } = await import('../src/core/db');
    await db.open();
    // Only rejected entries — zero pending, zero media.
    await db.outbox.add({ id: 'rej1', collection: 'tasks', patch: { title: 'x' }, ts: 1, state: 'rejected', rejectReason: 'invalid_mutation' });
    syncStore.set((s) => ({ ...s, status: 'synced' }));
    refreshPending();
    await new Promise((r) => setTimeout(r, 30)); // let updatePending land
    const s1 = syncStore.get();
    expect(s1.rejected).toBe(1);
    expect(s1.pending).toBe(0);
    expect(s1.status).toBe('rejected'); // never 'synced' with rejected rows
    // Clearing the queue restores 'synced'.
    await db.outbox.clear();
    refreshPending();
    await new Promise((r) => setTimeout(r, 30));
    expect(syncStore.get().status).toBe('synced');
    expect(syncStore.get().rejected).toBe(0);
  });
});
