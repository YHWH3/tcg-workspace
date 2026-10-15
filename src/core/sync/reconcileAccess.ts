/** Access-first network protocol coordinator. The engine owns presentation
 * gating and upload ordering; this service never treats an error as offline
 * permission or a successful empty snapshot. */
import type { LocalDB } from '../db';
import { ApiError } from '../api';
import { ACCESS_MANIFEST_KEY, SNAPSHOT_KEY, activateCacheSnapshot, beginCacheSnapshot, stageCachePage, validateAccessManifest,
  type ClientAccessManifest, type SnapshotDescriptor, type SnapshotPage } from './accessCache';

const REQUEST_KEY = 'access_snapshot_request';
interface RequestIntent { userId: string; generation: number; requestId: string }
interface ResumableSnapshot extends SnapshotDescriptor { userId: string; nextCursor: string | null; done: boolean }
export interface AccessReconcileDeps {
  store: LocalDB;
  request: <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;
  /** Throws if a sibling tab replaced the active account/session. */
  assertCurrent: () => void;
  lock: () => void;
  activated: (change: { quarantined: number; removedBlobs: string[] }) => void;
}
export type ReconciledAccess = ClientAccessManifest | { protocol: 1; userId: string };

export async function reconcileOnlineAccess(userId: string, deps: AccessReconcileDeps): Promise<ReconciledAccess> {
  const { store } = deps;
  const request = async <T>(path: string, options?: { method?: string; body?: unknown }) => {
    deps.assertCurrent(); const response = await deps.request<T>(path, options); deps.assertCurrent(); return response;
  };
  if (store.name !== `workspace-${userId}`) throw new Error('account_cache_mismatch');
  const response = await request<unknown>('/api/access');
  const prior = (await store.meta.get(ACCESS_MANIFEST_KEY))?.value as ReconciledAccess | undefined;
  if (response && typeof response === 'object' && 'protocol' in response && response.protocol === 1) {
    if (!('userId' in response) || response.userId !== userId || prior?.protocol === 2) throw new Error('permission_protocol_downgrade');
    const legacy = { protocol: 1 as const, userId };
    await store.meta.put({ key: ACCESS_MANIFEST_KEY, value: legacy }); deps.assertCurrent(); return legacy;
  }
  const manifest = validateAccessManifest(response, userId);
  if (prior?.protocol === 2 && prior.userId === userId && prior.generation === manifest.generation) return manifest;
  deps.lock();
  let staged = (await store.meta.get(SNAPSHOT_KEY))?.value as ResumableSnapshot | undefined;
  if (staged && (staged.userId !== userId || staged.generation !== manifest.generation || staged.expiresAt <= Date.now())) {
    if (staged.userId !== userId) throw new Error('account_cache_mismatch');
    try { await request(`/api/sync/snapshot/${staged.snapshotId}`, { method: 'DELETE' }); }
    catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
    await store.transaction('rw', store.meta, store.syncStage, async () => {
      await store.meta.bulkDelete([REQUEST_KEY, SNAPSHOT_KEY]); await store.syncStage.clear();
    });
    staged = undefined;
  }
  if (!staged) {
    let intent = (await store.meta.get(REQUEST_KEY))?.value as RequestIntent | undefined;
    if (!intent || intent.userId !== userId || intent.generation !== manifest.generation) {
      intent = { userId, generation: manifest.generation, requestId: crypto.randomUUID() };
      // Persist before requesting. A lost response/browser restart reuses the
      // same server snapshot, rather than exhausting active-copy capacity.
      await store.meta.put({ key: REQUEST_KEY, value: intent });
    }
    let descriptor: SnapshotDescriptor;
    try {
      descriptor = await request<SnapshotDescriptor>('/api/sync/snapshot', { method: 'POST', body: { protocol: 2, generation: manifest.generation, requestId: intent.requestId } });
    } catch (error) {
      if (error instanceof ApiError && (error.status === 410 || (error.status === 409 && error.message === 'request_id_reused'))) await store.meta.delete(REQUEST_KEY);
      throw error;
    }
    if (descriptor.generation !== manifest.generation) throw new Error('snapshot_manifest_mismatch');
    await beginCacheSnapshot(store, userId, descriptor);
    staged = (await store.meta.get(SNAPSHOT_KEY))!.value as ResumableSnapshot;
  }
  const descriptor = staged;
  for (let pages = 0; !staged.done; pages++) {
    if (pages >= 20_001 || !staged.nextCursor) throw new Error('snapshot_paging_incomplete');
    let page: SnapshotPage;
    try {
      page = await request<SnapshotPage>(`/api/sync/snapshot/${descriptor.snapshotId}?cursor=${encodeURIComponent(staged.nextCursor)}`);
    } catch (error) {
      if (error instanceof ApiError && [404, 410].includes(error.status)) {
        await store.transaction('rw', store.meta, store.syncStage, async () => {
          await store.meta.bulkDelete([REQUEST_KEY, SNAPSHOT_KEY]); await store.syncStage.clear();
        });
      }
      throw error;
    }
    await stageCachePage(store, userId, descriptor, staged.nextCursor, page);
    staged = (await store.meta.get(SNAPSHOT_KEY))!.value as ResumableSnapshot;
  }
  // Never activate a snapshot solely because its last HTTP page once succeeded.
  // Revalidate the current manifest after durable staging and before replacing
  // visible storage. A concurrent change keeps the old cache gated for retry.
  const current = validateAccessManifest(await request<unknown>('/api/access'), userId);
  if (current.generation !== manifest.generation) throw new ApiError(409, 'access_reset_required');
  deps.assertCurrent();
  const changed = await activateCacheSnapshot(store, current, descriptor);
  deps.assertCurrent(); deps.activated(changed);
  await store.meta.delete(REQUEST_KEY);
  // Best-effort deletion is scoped to the ephemeral snapshot only. Failure does
  // not invalidate the already-complete local activation; server expiry/pruning
  // still applies. This never deletes source records or media.
  try { await request(`/api/sync/snapshot/${descriptor.snapshotId}`, { method: 'DELETE' }); } catch { /* TTL cleanup */ }
  return current;
}
