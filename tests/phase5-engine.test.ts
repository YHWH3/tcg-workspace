import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ userId: 'engine-user', calls: [] as string[], upload: vi.fn(), authed: true }));
vi.mock('../src/core/auth', () => ({ authStore: { get: () => ({ user: fixture.authed ? { id: fixture.userId } : null }), subscribe: vi.fn() }, dropSession: vi.fn() }));
vi.mock('../src/core/files', () => ({ uploadPendingBlobs: async () => { fixture.calls.push('upload'); await fixture.upload(); } }));
let engine: typeof import('../src/core/sync/engine'), db: typeof import('../src/core/db')['db'];
let generation: number, failAccess: boolean, pullCursor: number, pullOverride: Record<string, unknown> | null;
let pushOverride: unknown, replaceDuringAccess: boolean;
let accessFailure: number | 'network' | null;
beforeEach(async () => {
  vi.resetModules(); fixture.userId = `engine-${crypto.randomUUID()}`; fixture.calls = []; fixture.authed = true; fixture.upload.mockReset(); generation = 20; failAccess = false; pullCursor = 100; pullOverride = null;
  pushOverride = undefined; replaceDuringAccess = false; accessFailure = null;
  vi.mocked((await import('../src/core/auth')).dropSession).mockClear();
  const values = new Map([['ws_uid', fixture.userId], ['ws_token', 'fixture-only-token']]);
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const path = String(url), method = options?.method ?? 'GET'; fixture.calls.push(`${method} ${path}`);
    const manifest = { protocol: 3, userId: fixture.userId, workspaceRole: 'member', etag: `fixture-etag-${generation}`, spaces: [{ id: 'space-core', name: 'Core', role: 'editor', exportPolicy: 'members' }] };
    let body: unknown;
    if (path === '/api/access') {
      if (accessFailure === 'network') throw new TypeError('Transport unavailable with navigator.onLine true');
      if (typeof accessFailure === 'number') return Response.json({ error: 'denied' }, { status: accessFailure });
      if (replaceDuringAccess) {
        localStorage.setItem('ws_uid', 'replacement-user'); localStorage.setItem('ws_token', 'replacement-token');
        return Response.json({ error: 'expired_session' }, { status: 401 });
      }
      if (failAccess) return Response.json({ error: 'processing_budget' }, { status: 503 });
      body = manifest;
    } else if (path === '/api/sync/push') body = pushOverride === undefined ? { ok: true, rejected: 0, rejectedItems: [], accessEtag: manifest.etag } : pushOverride;
    else if (path === '/api/sync/pull') {
      const request = JSON.parse(String(options?.body));
      body = pullOverride && !request.joining.length ? pullOverride : { protocol: 3, etag: manifest.etag, highWater: pullCursor, records: request.joining.length ? [{ id: 'visible', collection: 'pages', data: { title: 'Visible' }, field_ts: { title: 1 }, seq: 1, spaceId: 'space-core' }] : [],
        cursor: pullCursor, hasMore: false, evictions: [], joining: request.joining.map((j: {space: string; base: number}) => ({ space: j.space, after: pullCursor, base: j.base || pullCursor })) };
    }
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

  it('uses validated offline cache after transport failure even when navigator reports online', async () => {
    await engine.syncNow(); fixture.calls = [];
    await db.outbox.add({ id: 'visible', collection: 'pages', patch: { title: 'Pending offline work' }, ts: 10 });
    accessFailure = 'network'; await engine.syncNow();
    expect((await import('../src/core/accessClient')).accessClientStore.get().status).toBe('offline');
    expect(engine.syncStore.get().status).toBe('offline');
    expect(fixture.calls).toEqual(['GET /api/access']); expect(await db.outbox.count()).toBe(1);
  });

  it('does not unlock known-stale permissions during a transport outage with online navigator', async () => {
    await engine.syncNow();
    await db.meta.put({ key: 'access_reconciliation_required', value: { userId: fixture.userId, generation: 21 } });
    accessFailure = 'network'; await engine.syncNow();
    expect((await import('../src/core/accessClient')).accessClientStore.get()).toMatchObject({ status: 'error', reason: 'reconnect_required' });
  });

  it.each([401, 403])('does not treat authoritative HTTP %i as an offline permission decision', async status => {
    await engine.syncNow(); accessFailure = status; await engine.syncNow();
    expect((await import('../src/core/accessClient')).accessClientStore.get().status).toBe('error');
    expect((await import('../src/core/auth')).dropSession).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  });

  it('locks a stale tab on storage account replacement without logging out the new account', async () => {
    localStorage.setItem('ws_uid', 'replacement-user'); localStorage.setItem('ws_token', 'replacement-token');
    engine.handleAccessStorageChange({ key: 'ws_uid', newValue: 'replacement-user' });
    expect((await import('../src/core/accessClient')).accessClientStore.get()).toMatchObject({ status: 'error', reason: 'account_changed' });
    expect((await import('../src/core/auth')).dropSession).not.toHaveBeenCalled(); expect(fixture.calls).toEqual([]);
  });

  it.each(['account', 'session', 'capability'])('does not let a delayed offline cache read reopen a newer %s barrier', async change => {
    await engine.syncNow();
    await db.outbox.add({ id: 'visible', collection: 'pages', patch: { title: 'Retained original work' }, ts: 10 });
    vi.stubGlobal('navigator', { onLine: false });
    const access = await import('../src/core/accessClient');
    const original = db.meta.bulkGet.bind(db.meta);
    let release!: () => void, entered = false;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const { default: Dexie } = await import('dexie');
    const read = vi.spyOn(db.meta, 'bulkGet').mockImplementationOnce(keys => {
      entered = true;
      return original(keys).then(rows => Dexie.Promise.resolve(barrier).then(() => rows));
    });
    const pending = engine.syncNow();
    await vi.waitFor(() => expect(entered).toBe(true));
    if (change === 'account') {
      localStorage.setItem('ws_uid', 'replacement-user'); localStorage.setItem('ws_token', 'replacement-token');
      access.failClientAccess('account_changed');
    } else if (change === 'session') {
      localStorage.setItem('ws_token', 'replacement-token'); access.lockClientAccess('session_changed');
    } else access.lockClientAccess('permissions_changed');
    const locked = access.accessClientStore.get();
    release(); await pending; read.mockRestore();
    expect(access.accessClientStore.get().status).not.toBe('offline');
    expect(access.accessClientStore.get().reason).toBe(locked.reason);
    expect(engine.syncStore.get().status).toBe('error');
    expect(await db.outbox.count()).toBe(1);
    expect((await import('../src/core/auth')).dropSession).not.toHaveBeenCalled();
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

  it('retains truthful pending counts when an asynchronous counter read loses its account database', async () => {
    await db.outbox.add({ id: 'retained-counter-work', collection: 'pages', patch: { title: 'Unsynced original' }, ts: 10 });
    engine.syncStore.set(s => ({ ...s, status: 'synced', pending: 1, rejected: 2, quarantined: 3 }));
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const original = db.outbox.toArray.bind(db.outbox);
    const { default: Dexie } = await import('dexie');
    const read = vi.spyOn(db.outbox, 'toArray').mockImplementationOnce(() => Dexie.Promise.resolve(barrier).then(() => original()));
    engine.refreshPending(); db.close(); release();
    await vi.waitFor(() => expect(engine.syncStore.get()).toMatchObject({ status: 'error', pending: 1, rejected: 2, quarantined: 3 }));
    read.mockRestore(); await db.open(); expect(await db.outbox.count()).toBe(1);
  });

  it('reports a failed background pending read without claiming zero work or successful synchronization', async () => {
    engine.syncStore.set(s => ({ ...s, status: 'synced', pending: 4 }));
    vi.spyOn(db.outbox, 'toArray').mockRejectedValueOnce(new DOMException('Fixture storage failure', 'UnknownError'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    engine.refreshPending();
    await vi.waitFor(() => expect(engine.syncStore.get()).toMatchObject({ status: 'error', pending: 4 }));
    expect(log).toHaveBeenCalled();
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
    expect(fixture.calls.indexOf('upload')).toBeGreaterThan(fixture.calls.findIndex(c => c === 'POST /api/sync/pull'));
    expect(fixture.calls).toContain('POST /api/sync/pull');
  });

  it('does not push, upload, acknowledge or expose a successful sync after access-check failure', async () => {
    await db.outbox.add({ id: 'secret', collection: 'pages', patch: { title: 'Pending' }, ts: 10 }); failAccess = true;
    await engine.syncNow();
    expect(fixture.calls).toEqual(['GET /api/access']); expect(await db.outbox.count()).toBe(1);
    expect(engine.syncStore.get().status).toBe('error');
  });

  it('sends protocol 3 with authorized pending writes and persists feed cursors', async () => {
    pullCursor = 200;
    await db.outbox.add({ id: 'visible', collection: 'pages', patch: { title: 'Local authorized edit' }, ts: 10 });
    await engine.syncNow();
    const calls = vi.mocked(fetch).mock.calls;
    const push = calls.find(([path]) => path === '/api/sync/push'); expect(push).toBeDefined();
    expect(JSON.parse(String(push![1]?.body))).toMatchObject({ protocol: 3, changes: [{ id: 'visible' }] });
    expect(((await db.meta.get('access_feed'))!.value as { cursor: number }).cursor).toBe(200);
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
    expect(((await db.meta.get('access_feed'))!.value as { cursor: number }).cursor).toBe(100);
  });
});
