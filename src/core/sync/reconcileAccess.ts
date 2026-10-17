/** Access-first coordinator. A cached grant never replaces a successful online
 * check; errors keep the presentation barrier locked and unsent work intact. */
import type { LocalDB } from '../db';
import { PERMISSION_PROTOCOL } from '../../../shared/protocol';
import { installManifest } from './accessCache';
import { pullSpaceFeed } from './feedPull';
import { ACCESS_MANIFEST_KEY, FeedStateChanged, readState, validateAccessManifest, type ReconciledAccess } from './feedState';
export { RECONCILE_REQUIRED_KEY } from './feedState';
export type { ReconciledAccess } from './feedState';
export interface AccessReconcileDeps {
  store: LocalDB;
  request: <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;
  assertCurrent: () => void;
  lock: () => void;
  activated: (change: { quarantined: number; removedBlobs: string[] }) => void;
}

export async function reconcileOnlineAccess(userId: string, deps: AccessReconcileDeps): Promise<ReconciledAccess> {
  const { store } = deps;
  const request: AccessReconcileDeps['request'] = async <T>(path: string, opts?: { method?: string; body?: unknown }) => {
    deps.assertCurrent(); const reply = await deps.request<T>(path, opts); deps.assertCurrent(); return reply;
  };
  for (let attempts = 0; attempts < 20; attempts++) {
    const before = await readState(store, userId), version = before.feed?.version ?? 0;
    const response = await request<unknown>('/api/access');
    if (response && typeof response === 'object' && 'protocol' in response && response.protocol === 1) {
      if (!('userId' in response) || response.userId !== userId) throw new Error('account_cache_mismatch');
      return store.transaction('rw', store.meta, async () => {
        const state = await readState(store, userId);
        if (state.feed || state.required || !state.consistent || state.access?.protocol === PERMISSION_PROTOCOL) throw new Error('permission_protocol_downgrade');
        deps.assertCurrent(); const legacy = { protocol: 1 as const, userId };
        await store.meta.put({ key: ACCESS_MANIFEST_KEY, value: legacy }); return legacy;
      });
    }
    const manifest = validateAccessManifest(response, userId);
    if (!before.consistent || before.access?.protocol !== PERMISSION_PROTOCOL || before.access.etag !== manifest.etag || before.required || Object.keys(before.feed?.joining ?? {}).length) deps.lock();
    try {
      const changed = await installManifest(store, userId, manifest, version, { assertCurrent: deps.assertCurrent });
      if (changed.feed.version !== version) deps.activated(changed);
      await pullSpaceFeed(userId, { store, request, assertCurrent: deps.assertCurrent, changed: deps.activated, lock: deps.lock });
      // Current-server revalidation before exposing the group that just activated.
      const finalState = await readState(store, userId), checkVersion = finalState.feed?.version ?? 0;
      const current = validateAccessManifest(await request('/api/access'), userId);
      if (finalState.access?.protocol !== PERMISSION_PROTOCOL || current.etag !== finalState.access.etag) continue;
      const latest = await readState(store, userId);
      if (latest.feed?.version !== checkVersion || latest.required || !latest.consistent || Object.keys(latest.feed.joining).length) continue;
      deps.assertCurrent(); return current;
    } catch (error) { if (!(error instanceof FeedStateChanged)) throw error; }
  }
  throw new Error('access_reconciliation_busy');
}
