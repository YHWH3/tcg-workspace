import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDB } from '../src/core/db';
import { ApiError } from '../src/core/api';
import { reconcileOnlineAccess, RECONCILE_REQUIRED_KEY, type AccessReconcileDeps } from '../src/core/sync/reconcileAccess';
import { SNAPSHOT_KEY, ACCESS_MANIFEST_KEY, type ClientAccessManifest } from '../src/core/sync/accessCache';

let store: LocalDB, userId: string, manifest: ClientAccessManifest, calls: string[], deps: AccessReconcileDeps;
const snapshot = { snapshotId: 'frozen', generation: 20, cutoff: 100, cursor: 'first', expiresAt: Date.now() + 600_000 };
beforeEach(async () => {
  userId = `reconcile-${crypto.randomUUID()}`; store = new LocalDB(`workspace-${userId}`); await store.open(); calls = [];
  manifest = { protocol: 2, userId, workspaceRole: 'member', generation: 20, spaces: [{ id: 'space-core', name: 'Core', role: 'editor', exportPolicy: 'members' }] };
  await store.pages.put({ id: 'prior', title: 'Prior private cache', _ts: {} });
  deps = { store, assertCurrent: () => {}, lock: () => { calls.push('lock'); }, activated: () => { calls.push('activated'); },
    request: async <T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> => {
      calls.push(`${opts?.method ?? 'GET'} ${path}`);
      if (path === '/api/access') return structuredClone(manifest) as T;
      if (opts?.method === 'POST') return structuredClone(snapshot) as T;
      if (opts?.method === 'DELETE') return { ok: true } as T;
      return { protocol: 2, snapshotId: snapshot.snapshotId, generation: snapshot.generation, cutoff: snapshot.cutoff,
        records: [{ id: 'a', collection: 'pages', data: { title: 'Authorized' }, field_ts: { title: 1 }, seq: 1, spaceId: 'space-core' }], cursor: null, done: true } as T;
    } };
});
afterEach(async () => { await store.delete(); });

describe('access-first snapshot reconciliation coordinator', () => {
  it('never overwrites a newer generation discovered by another tab with a delayed manifest', async () => {
    await store.meta.put({ key: ACCESS_MANIFEST_KEY, value: manifest });
    await store.meta.put({ key: RECONCILE_REQUIRED_KEY, value: { userId, generation: 21 } });
    await expect(reconcileOnlineAccess(userId, deps)).rejects.toThrow('stale_cache_generation');
    expect((await store.meta.get(RECONCILE_REQUIRED_KEY))!.value).toMatchObject({ generation: 21 });
    expect(calls).not.toContain('POST /api/sync/snapshot');
  });
  it('cleans a crash marker after online confirmation of the atomically installed generation', async () => {
    await store.meta.put({ key: ACCESS_MANIFEST_KEY, value: manifest });
    await store.meta.put({ key: RECONCILE_REQUIRED_KEY, value: { userId, generation: manifest.generation } });
    await reconcileOnlineAccess(userId, deps);
    expect(calls).toEqual(['GET /api/access']); expect(await store.meta.get(RECONCILE_REQUIRED_KEY)).toBeUndefined();
  });
  it('checks access, stages, revalidates, activates, then cancels only the temporary server snapshot', async () => {
    expect(await reconcileOnlineAccess(userId, deps)).toEqual(manifest);
    expect(calls).toEqual(['GET /api/access', 'lock', 'POST /api/sync/snapshot', 'GET /api/sync/snapshot/frozen?cursor=first', 'GET /api/access', 'activated', 'DELETE /api/sync/snapshot/frozen']);
    expect(await store.pages.get('prior')).toBeUndefined(); expect((await store.pages.get('a'))!.title).toBe('Authorized');
    expect((await store.meta.get(ACCESS_MANIFEST_KEY))!.value).toEqual(manifest);
    calls.length = 0;
    await reconcileOnlineAccess(userId, deps); expect(calls).toEqual(['GET /api/access']);
  });

  it('persists and reuses request identity after losing the snapshot-start response', async () => {
    const original = deps.request, requestIds: unknown[] = []; let failed = false;
    deps.request = async <T>(path: string, opts?: { method?: string; body?: unknown }) => {
      if (opts?.method === 'POST') {
        requestIds.push((opts.body as { requestId: string }).requestId);
        if (!failed) { failed = true; throw new ApiError(0, 'offline'); }
      }
      return original<T>(path, opts);
    };
    await expect(reconcileOnlineAccess(userId, deps)).rejects.toThrow('offline');
    expect(await store.pages.get('prior')).toBeDefined(); expect(await store.meta.get(ACCESS_MANIFEST_KEY)).toBeUndefined();
    store.close(); await store.open();
    await reconcileOnlineAccess(userId, deps);
    expect(requestIds).toHaveLength(2); expect(requestIds[0]).toBe(requestIds[1]);
    expect(await store.pages.get('prior')).toBeUndefined();
  });

  it('resumes a committed page after reload without restarting the snapshot or activating a partial cache', async () => {
    const original = deps.request; let fail = true;
    deps.request = async <T>(path: string, opts?: { method?: string; body?: unknown }) => {
      if (path.endsWith('cursor=first')) {
        const result = await original<Record<string, unknown>>(path, opts);
        return { ...result, cursor: 'second', done: false } as T;
      }
      if (path.endsWith('cursor=second')) {
        calls.push('second'); if (fail) throw new ApiError(0, 'offline');
        return { ...snapshot, records: [], cursor: null, done: true } as T;
      }
      return original<T>(path, opts);
    };
    await expect(reconcileOnlineAccess(userId, deps)).rejects.toThrow('offline');
    expect(await store.pages.get('prior')).toBeDefined(); expect(await store.pages.get('a')).toBeUndefined();
    expect((await store.meta.get(SNAPSHOT_KEY))!.value).toMatchObject({ nextCursor: 'second', done: false });
    store.close(); await store.open(); fail = false; calls.length = 0;
    await reconcileOnlineAccess(userId, deps);
    expect(calls).not.toContain('POST /api/sync/snapshot'); expect(calls).not.toContain('GET /api/sync/snapshot/frozen?cursor=first');
    expect(await store.pages.get('a')).toBeDefined(); expect(await store.pages.get('prior')).toBeUndefined();
  });

  it('keeps the cache gated when access changes after the last snapshot page', async () => {
    const original = deps.request; let manifests = 0;
    deps.request = async <T>(path: string, opts?: { method?: string; body?: unknown }) => {
      const response = await original<T>(path, opts);
      return path === '/api/access' && ++manifests === 2 ? { ...manifest, generation: 21 } as T : response;
    };
    await expect(reconcileOnlineAccess(userId, deps)).rejects.toMatchObject({ status: 409 });
    expect(calls).not.toContain('activated'); expect(await store.pages.get('prior')).toBeDefined();
    expect(await store.meta.get(ACCESS_MANIFEST_KEY)).toBeUndefined();
    expect((await store.meta.get(SNAPSHOT_KEY))!.value).toMatchObject({ done: true });
    // A later reconciliation cancels the obsolete copy before creating the
    // next one, so repeated revocations do not exhaust active-copy capacity.
    manifest.generation = 21; const replacement = { ...snapshot, generation: 21, snapshotId: 'replacement' };
    deps.request = async <T>(path: string, opts?: { method?: string; body?: unknown }) => {
      calls.push(`${opts?.method ?? 'GET'} ${path}`);
      if (path === '/api/access') return structuredClone(manifest) as T;
      if (opts?.method === 'POST') return replacement as T;
      if (opts?.method === 'DELETE') return { ok: true } as T;
      return { ...replacement, records: [], cursor: null, done: true } as T;
    };
    calls.length = 0; await reconcileOnlineAccess(userId, deps);
    expect(calls.indexOf('DELETE /api/sync/snapshot/frozen')).toBeLessThan(calls.indexOf('POST /api/sync/snapshot'));
    expect((await store.meta.get(ACCESS_MANIFEST_KEY))!.value).toMatchObject({ generation: 21 });
  });

  it('clears an expired server continuation for a fresh retry while retaining the live cache', async () => {
    const original = deps.request;
    deps.request = async <T>(path: string, opts?: { method?: string; body?: unknown }) => {
      if (path.includes('?cursor=')) throw new ApiError(410, 'snapshot_expired');
      return original<T>(path, opts);
    };
    await expect(reconcileOnlineAccess(userId, deps)).rejects.toMatchObject({ status: 410 });
    expect(await store.meta.get(SNAPSHOT_KEY)).toBeUndefined(); expect(await store.syncStage.count()).toBe(0);
    expect(await store.pages.get('prior')).toBeDefined(); expect(await store.meta.get(ACCESS_MANIFEST_KEY)).toBeUndefined();
    deps.request = original; await reconcileOnlineAccess(userId, deps);
    expect(await store.pages.get('prior')).toBeUndefined();
  });

  it('cannot write or activate under a replaced account after an awaited request', async () => {
    let switched = false; const original = deps.request;
    deps.request = async <T>(path: string, opts?: { method?: string; body?: unknown }) => { const result = await original<T>(path, opts); switched = true; return result; };
    deps.assertCurrent = () => { if (switched) throw new Error('account changed'); };
    await expect(reconcileOnlineAccess(userId, deps)).rejects.toThrow('account changed');
    expect(calls).toEqual(['GET /api/access']); expect(await store.pages.get('prior')).toBeDefined(); expect(await store.syncStage.count()).toBe(0);
  });

  it('preserves legacy compatibility but rejects a protocol downgrade after private-space activation', async () => {
    const original = deps.request;
    deps.request = async <T>(path: string, opts?: { method?: string; body?: unknown }) => path === '/api/access' ? { protocol: 1, userId } as T : original<T>(path, opts);
    expect(await reconcileOnlineAccess(userId, deps)).toEqual({ protocol: 1, userId });
    expect(await store.pages.get('prior')).toBeDefined(); expect(calls).toEqual([]);
    await store.meta.put({ key: ACCESS_MANIFEST_KEY, value: manifest });
    await expect(reconcileOnlineAccess(userId, deps)).rejects.toThrow('permission_protocol_downgrade');
    expect((await store.meta.get(ACCESS_MANIFEST_KEY))!.value).toEqual(manifest);
  });
});
