import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ userId: 'phase9-engine-user' }));
vi.mock('../src/core/auth', () => ({
  authStore: { get: () => ({ user: { id: fixture.userId } }), subscribe: vi.fn() },
  dropSession: vi.fn(),
}));
vi.mock('../src/core/files', () => ({ uploadPendingBlobs: vi.fn() }));

let db: typeof import('../src/core/db').db;
let engine: typeof import('../src/core/sync/engine');

beforeEach(async () => {
  vi.resetModules();
  fixture.userId = `phase9-${crypto.randomUUID()}`;
  const values = new Map([['ws_uid', fixture.userId], ['ws_token', 'phase9-token']]);
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  vi.stubGlobal('navigator', { onLine: false });
  ({ db } = await import('../src/core/db'));
  await db.open();
  engine = await import('../src/core/sync/engine');
});

afterEach(async () => {
  // mutate() schedules the normal debounce. Let it settle while offline so
  // the test database is not deleted underneath an owned sync callback.
  await new Promise(resolve => setTimeout(resolve, 850));
  await db.delete();
  vi.unstubAllGlobals();
});

describe('Phase 9 mutateMany', () => {
  it('caps one batch at the existing push chunk size', async () => {
    expect(engine.PUSH_CHUNK).toBe(500);
    await expect(engine.mutateMany('pages', Array.from({ length: 501 }, (_, i) => ({ id: `too-many-${i}`, patch: { title: String(i) } })))).rejects.toThrow('at most 500');
    expect(await db.pages.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });

  it('writes rows, field timestamps and outbox entries atomically', async () => {
    await engine.mutateMany('pages', [
      { id: 'a', patch: { title: 'A', order: 'a0' } },
      { id: 'b', patch: { title: 'B' } },
    ]);
    expect(await db.pages.get('a')).toMatchObject({ id: 'a', title: 'A', order: 'a0' });
    expect(await db.pages.get('b')).toMatchObject({ id: 'b', title: 'B' });
    const entries = await db.outbox.orderBy('autoId').toArray();
    expect(entries).toHaveLength(2);
    expect(entries.map(entry => ({ id: entry.id, patch: entry.patch, createIntent: entry.createIntent }))).toEqual([
      { id: 'a', patch: { title: 'A', order: 'a0' }, createIntent: true },
      { id: 'b', patch: { title: 'B' }, createIntent: true },
    ]);
    expect((await db.pages.get('a'))!._ts.title).toBe(entries[0].ts);
    expect((await db.pages.get('a'))!._ts.order).toBe(entries[0].ts);
    expect((await db.pages.get('b'))!._ts.title).toBe(entries[1].ts);
    expect(entries[1].ts).toBeGreaterThanOrEqual(entries[0].ts);
  });

  it('rolls back every row and outbox entry when a later write fails', async () => {
    const outbox = db.outbox;
    const originalAdd = outbox.add.bind(outbox);
    let calls = 0;
    const add = vi.spyOn(outbox, 'add').mockImplementation((...args) => {
      if (++calls === 2) throw new Error('injected batch failure');
      return originalAdd(...args);
    });
    await expect(engine.mutateMany('pages', [
      { id: 'first', patch: { title: 'First' } },
      { id: 'second', patch: { title: 'Second' } },
    ])).rejects.toThrow('injected batch failure');
    add.mockRestore();
    expect(await db.pages.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
  });

  it('matches sequential mutate semantics for row values and queued patches', async () => {
    const items = [
      { id: 'one', patch: { title: 'One', status: 'todo' } },
      { id: 'two', patch: { title: 'Two' } },
      { id: 'one', patch: { status: 'done' } },
    ];
    await engine.mutateMany('pages', items);
    const batchedRows = await db.pages.toArray();
    const batchedOutbox = await db.outbox.orderBy('autoId').toArray();
    const normalize = (rows: typeof batchedRows) => rows.map(({ _ts, ...row }) => row).sort((a, b) => a.id.localeCompare(b.id));
    const normalizeOutbox = (rows: typeof batchedOutbox) => rows.map(({ autoId: _autoId, ts: _ts, enqueuedAt: _enqueuedAt, ...row }) => row);
    await db.pages.clear();
    await db.outbox.clear();
    for (const item of items) await engine.mutate('pages', item.id, item.patch);
    expect(normalize(await db.pages.toArray())).toEqual(normalize(batchedRows));
    expect(normalizeOutbox(await db.outbox.orderBy('autoId').toArray())).toEqual(normalizeOutbox(batchedOutbox));
  });
});
