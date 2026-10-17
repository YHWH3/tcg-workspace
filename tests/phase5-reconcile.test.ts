import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDB } from '../src/core/db';
import { ApiError } from '../src/core/api';
import { reconcileOnlineAccess, type AccessReconcileDeps } from '../src/core/sync/reconcileAccess';
import { readState, ACCESS_MANIFEST_KEY, RECONCILE_REQUIRED_KEY } from '../src/core/sync/feedState';
import { manifestFor, record, replyFor } from './feed-cache-fixture';
import type { ManifestV3, PullRequestV3 } from '../shared/protocol';
let store: LocalDB, userId: string, manifest: ManifestV3, calls: string[], deps: AccessReconcileDeps;
beforeEach(async () => {
  userId = `reconcile-${crypto.randomUUID()}`; store = new LocalDB(`workspace-${userId}`); await store.open(); manifest = manifestFor(userId); calls = [];
  deps = { store, assertCurrent: () => {}, lock: () => calls.push('lock'), activated: () => calls.push('changed'), request: async <T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> => {
    calls.push(`${opts?.method ?? 'GET'} ${path}`);
    if (path === '/api/access') return structuredClone(manifest) as T;
    return replyFor(opts!.body as PullRequestV3, (opts!.body as PullRequestV3).cursor < 100 ? [record('a')] : []) as T;
  } };
});
afterEach(async () => { await store.delete(); });
describe('access-first feed coordinator', () => {
  it('gates, verifies, pages, revalidates then returns; steady-state needs no snapshot', async () => {
    expect(await reconcileOnlineAccess(userId, deps)).toEqual(manifest); expect((await store.pages.get('a'))!.title).toBe('Authorized');
    expect(calls.indexOf('lock')).toBeLessThan(calls.indexOf('POST /api/sync/pull')); expect(calls.filter(c => c.startsWith('GET'))).toEqual(['GET /api/access', 'GET /api/access']);
    expect(calls).toContain('POST /api/sync/pull'); expect(calls.join()).not.toContain('snapshot');
    calls.length = 0; await reconcileOnlineAccess(userId, deps); expect(calls.filter(c => c.includes('/pull'))).toHaveLength(1);
  });
  it('resumes after losing a response without writing or duplicating the page', async () => {
    const original = deps.request; let fail = true;
    deps.request = async <T>(path: string, opts?: { method?: string; body?: unknown }) => { if (path.endsWith('/pull') && fail) { fail = false; throw new ApiError(0, 'offline'); } return original<T>(path, opts); };
    await expect(reconcileOnlineAccess(userId, deps)).rejects.toThrow('offline'); expect(await store.pages.count()).toBe(0); expect(await store.meta.get(RECONCILE_REQUIRED_KEY)).toBeDefined();
    store.close(); await store.open(); await reconcileOnlineAccess(userId, deps); expect(await store.pages.count()).toBe(1); expect(await store.meta.get(RECONCILE_REQUIRED_KEY)).toBeUndefined();
  });
  it('never maps an access-check failure to a successful empty cache', async () => {
    deps.request = async () => { throw new ApiError(503, 'budget'); };
    await expect(reconcileOnlineAccess(userId, deps)).rejects.toThrow('budget'); expect(await store.meta.get(ACCESS_MANIFEST_KEY)).toBeUndefined();
  });
  it('handles an inline manifest change before accepting any rows', async () => {
    const original = deps.request; let once = true;
    deps.request = async <T>(path: string, opts?: { method?: string; body?: unknown }) => {
      if (path.endsWith('/pull') && once) { once = false; manifest = { ...manifest, spaces: [], etag: 'revoked-etag' }; throw new ApiError(409, 'manifest_changed', { error: 'manifest_changed', manifest }); }
      if (path.endsWith('/pull')) return replyFor(opts!.body as PullRequestV3) as T;
      return original<T>(path, opts);
    };
    await reconcileOnlineAccess(userId, deps); expect(await store.pages.count()).toBe(0); expect((await readState(store, userId)).access).toEqual(manifest);
  });
  it.each(['rebackfill_required', 'cursor_ahead', 'access_changed_retry'])('recovers from %s with bounded retries', async code => {
    await reconcileOnlineAccess(userId, deps); const original = deps.request; let once = true;
    deps.request = async <T>(path: string, opts?: { method?: string; body?: unknown }) => {
      if (path.endsWith('/pull') && once) { once = false; throw new ApiError(409, code, { error: code, spaces: ['space-core'] }); }
      if (path.endsWith('/pull')) return replyFor(opts!.body as PullRequestV3, (opts!.body as PullRequestV3).joining.length ? [record('a')] : []) as T;
      return original<T>(path, opts);
    };
    await reconcileOnlineAccess(userId, deps); expect(await store.pages.get('a')).toBeDefined(); expect((await readState(store, userId)).feed!.joining).toEqual({});
  });
  it('rejects a legacy reply after permission-aware content was installed', async () => {
    await reconcileOnlineAccess(userId, deps); deps.request = async <T>() => ({ protocol: 1, userId } as T);
    await expect(reconcileOnlineAccess(userId, deps)).rejects.toThrow('permission_protocol_downgrade');
  });
  it('preserves legacy Core data while activation is off', async () => {
    await store.pages.put({ id: 'legacy', title: 'Keep', _ts: {} }); deps.request = async <T>() => ({ protocol: 1, userId } as T);
    expect(await reconcileOnlineAccess(userId, deps)).toEqual({ protocol: 1, userId }); expect(await store.pages.get('legacy')).toBeDefined();
  });
  it('does not accept a wrong-account response or an identity change during the request', async () => {
    deps.request = async <T>() => ({ ...manifest, userId: 'wrong' } as T); await expect(reconcileOnlineAccess(userId, deps)).rejects.toThrow('invalid_access_manifest');
    deps.assertCurrent = () => { throw new Error('account changed'); }; await expect(reconcileOnlineAccess(userId, deps)).rejects.toThrow('account changed');
    expect(await store.pages.count()).toBe(0);
  });
});
