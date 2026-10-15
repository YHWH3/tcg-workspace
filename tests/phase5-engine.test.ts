import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ userId: 'engine-user', calls: [] as string[], upload: vi.fn(), authed: true }));
vi.mock('../src/core/auth', () => ({ authStore: { get: () => ({ user: fixture.authed ? { id: fixture.userId } : null }), subscribe: vi.fn() }, dropSession: vi.fn() }));
vi.mock('../src/core/files', () => ({ uploadPendingBlobs: async () => { fixture.calls.push('upload'); await fixture.upload(); } }));
let engine: typeof import('../src/core/sync/engine'), db: typeof import('../src/core/db')['db'];
let generation: number, failAccess: boolean, pullCursor: number, pullOverride: Record<string, unknown> | null;
let pushOverride: unknown, replaceDuringAccess: boolean;
beforeEach(async () => {
  vi.resetModules(); fixture.userId = `engine-${crypto.randomUUID()}`; fixture.calls = []; fixture.authed = true; fixture.upload.mockReset(); generation = 20; failAccess = false; pullCursor = 100; pullOverride = null;
  pushOverride = undefined; replaceDuringAccess = false;
  vi.mocked((await import('../src/core/auth')).dropSession).mockClear();
  const values = new Map([['ws_uid', fixture.userId], ['ws_token', 'fixture-only-token']]);
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const path = String(url), method = options?.method ?? 'GET'; fixture.calls.push(`${method} ${path}`);
    const manifest = { protocol: 2, userId: fixture.userId, workspaceRole: 'member', generation, spaces: [{ id: 'space-core', name: 'Core', role: 'editor', exportPolicy: 'members' }] };
    let body: unknown;
    if (path === '/api/access') {
      if (replaceDuringAccess) {
        localStorage.setItem('ws_uid', 'replacement-user'); localStorage.setItem('ws_token', 'replacement-token');
        return Response.json({ error: 'expired_session' }, { status: 401 });
      }
      if (failAccess) return Response.json({ error: 'processing_budget' }, { status: 503 });
      body = manifest;
    } else if (path === '/api/sync/snapshot' && method === 'POST') body = { snapshotId: 'fixture-snapshot', generation, cutoff: 100, cursor: 'first', expiresAt: Date.now() + 60_000 };
    else if (path.includes('/api/sync/snapshot/') && method === 'DELETE') body = { ok: true };
    else if (path.includes('/api/sync/snapshot/')) body = { protocol: 2, snapshotId: 'fixture-snapshot', generation, cutoff: 100, records: [{ id: 'visible', collection: 'pages', data: { title: 'Visible' }, field_ts: { title: 1 }, seq: 1, spaceId: 'space-core' }], done: true, cursor: null };
    else if (path === '/api/sync/push') body = pushOverride === undefined ? { ok: true, rejected: 0, rejectedItems: [] } : pushOverride;
    else if (path.startsWith('/api/sync/pull')) body = pullOverride ?? { protocol: 2, generation, records: [], cursor: pullCursor, hasMore: false };
    else if (path === '/api/users') body = { users: [] };
    else throw new Error(`unexpected fixture request ${path}`);
    return Response.json(body);
  }));
  ({ db } = await import('../src/core/db')); await db.open(); engine = await import('../src/core/sync/engine');
  await db.meta.put({ key: 'seeds_v1', value: 1 });
});
afterEach(async () => { await db.delete(); vi.unstubAllGlobals(); });

describe('Phase 5 real client sync engine ordering with simulated HTTP', () => {
  it('keeps a known-stale cache locked after an offline browser restart', async () => {
    const access = await import('../src/core/accessClient');
    await engine.syncNow();
    await db.meta.put({ key: 'access_reconciliation_required', value: { userId: fixture.userId, generation: 21 } });
    db.close(); await db.open();
    vi.stubGlobal('navigator', { onLine: false });
    await engine.syncNow();
    expect(access.accessClientStore.get()).toMatchObject({ status: 'error', reason: 'reconnect_required' });
  });

  it('locks a stale tab on storage account replacement without logging out the new account', async () => {
    localStorage.setItem('ws_uid', 'replacement-user'); localStorage.setItem('ws_token', 'replacement-token');
    engine.handleAccessStorageChange({ key: 'ws_uid', newValue: 'replacement-user' });
    expect((await import('../src/core/accessClient')).accessClientStore.get()).toMatchObject({ status: 'error', reason: 'account_changed' });
    expect((await import('../src/core/auth')).dropSession).not.toHaveBeenCalled(); expect(fixture.calls).toEqual([]);
  });

  it.each([null, {}, { ok: true, rejected: 0 }, { ok: true, rejected: 1, rejectedItems: [] },
    { ok: true, rejected: 1, rejectedItems: [{ id: 'unrelated', collection: 'pages', reason: 'forbidden' }] },
  ])('retains unacknowledged work when the push reply is incomplete: %j', async malformed => {
    pushOverride = malformed;
    await db.outbox.add({ id: 'visible', collection: 'pages', patch: { title: 'Retain me' }, ts: 10 });
    await engine.syncNow();
    expect(await db.outbox.count()).toBe(1); expect(engine.syncStore.get().status).toBe('error');
    expect(fixture.calls).not.toContain('upload');
  });

  it('does not drop replacement credentials when the previous session returns a late 401', async () => {
    replaceDuringAccess = true; await engine.syncNow();
    expect((await import('../src/core/auth')).dropSession).not.toHaveBeenCalled();
    expect(localStorage.getItem('ws_token')).toBe('replacement-token');
    expect((await import('../src/core/accessClient')).accessClientStore.get().reason).toBe('account_changed');
  });
  it('reconciles access and evicts revoked work before any push or upload', async () => {
    await db.pages.put({ id: 'secret', title: 'Private cached title', _ts: {} });
    await db.outbox.add({ id: 'secret', collection: 'pages', patch: { title: 'Offline private edit' }, ts: 10 });
    await engine.syncNow();
    expect(fixture.calls[0]).toBe('GET /api/access');
    expect(fixture.calls).not.toContain('POST /api/sync/push');
    expect(await db.pages.get('secret')).toBeUndefined(); expect(await db.accessQuarantine.count()).toBe(1);
    expect(fixture.calls.indexOf('upload')).toBeGreaterThan(fixture.calls.findIndex(c => c.startsWith('GET /api/sync/snapshot/')));
    expect(fixture.calls).toContain('GET /api/sync/pull?since=100&limit=500&protocol=2&generation=20');
  });

  it('does not push, upload, acknowledge or expose a successful sync after access-check failure', async () => {
    await db.outbox.add({ id: 'secret', collection: 'pages', patch: { title: 'Pending' }, ts: 10 }); failAccess = true;
    await engine.syncNow();
    expect(fixture.calls).toEqual(['GET /api/access']); expect(await db.outbox.count()).toBe(1);
    expect(engine.syncStore.get().status).toBe('error');
  });

  it('sends the validated generation with authorized pending writes and persists empty-page cursors', async () => {
    pullCursor = 200;
    await db.outbox.add({ id: 'visible', collection: 'pages', patch: { title: 'Local authorized edit' }, ts: 10 });
    await engine.syncNow();
    const calls = vi.mocked(fetch).mock.calls;
    const push = calls.find(([path]) => path === '/api/sync/push'); expect(push).toBeDefined();
    expect(JSON.parse(String(push![1]?.body))).toMatchObject({ protocol: 2, generation: 20, changes: [{ id: 'visible' }] });
    expect((await db.meta.get('sync_cursor'))!.value).toBe(200);
  });

  it.each([
    { protocol: 2, generation: 19, records: [], cursor: 101, hasMore: false },
    { protocol: 2, generation: 20, records: [], cursor: 100, hasMore: true },
    { protocol: 2, generation: 20, records: [], cursor: -1, hasMore: false },
    { protocol: 2, generation: 20, cursor: 100, hasMore: false },
  ])('refuses an incomplete or stale pull reply: %j', async malformed => {
    pullOverride = malformed;
    await engine.syncNow();
    expect(engine.syncStore.get().status).toBe('error'); expect(fixture.calls).not.toContain('upload');
    expect((await db.meta.get('sync_cursor'))!.value).toBe(100);
  });
});
