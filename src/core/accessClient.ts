/** Client presentation/cache barrier. Server authorization remains mandatory. */
import { api } from './api';
import { db } from './db';
import { createStore } from './store';
import { ACCESS_MANIFEST_KEY, validateAccessManifest } from './sync/accessCache';
import { reconcileOnlineAccess, RECONCILE_REQUIRED_KEY, type ReconciledAccess } from './sync/reconcileAccess';

interface ClientAccessState {
  status: 'checking' | 'ready' | 'offline' | 'error';
  manifest: ReconciledAccess | null;
  reason: string | null;
  /** Invalidates pending media work even before new rows are installed. */
  epoch: number;
}
export const accessClientStore = createStore<ClientAccessState>({ status: 'checking', manifest: null, reason: null, epoch: 0 });

export function lockClientAccess(reason = 'checking_access'): void {
  accessClientStore.set(s => ({ ...s, status: 'checking', reason, epoch: s.epoch + 1 }));
}
export function failClientAccess(reason = 'access_check_failed'): void {
  accessClientStore.set(s => ({ ...s, status: 'error', reason, epoch: s.epoch + 1 }));
}

export async function prepareOnlineAccess(userId: string, assertCurrent: () => void): Promise<ReconciledAccess> {
  try {
    const manifest = await reconcileOnlineAccess(userId, { store: db, request: api, assertCurrent,
      lock: () => lockClientAccess('permissions_changed'),
      activated: () => {
        accessClientStore.set(s => ({ ...s, epoch: s.epoch + 1 }));
        // Hint only: other tabs revalidate with the server before rendering.
        try { localStorage.setItem('ws_access_update', JSON.stringify({ userId, nonce: crypto.randomUUID() })); } catch { /* periodic access checks remain authoritative */ }
      },
    });
    assertCurrent(); accessClientStore.set(s => ({ ...s, status: 'ready', manifest, reason: null }));
    return manifest;
  } catch (error) { failClientAccess(); throw error; }
}

export async function prepareOfflineAccess(userId: string): Promise<void> {
  if (db.name !== `workspace-${userId}`) { failClientAccess('account_changed'); return; }
  try {
    const [cached, required] = await Promise.all([db.meta.get(ACCESS_MANIFEST_KEY), db.meta.get(RECONCILE_REQUIRED_KEY)]);
    if (required) { failClientAccess('reconnect_required'); return; }
    const value = cached?.value as ReconciledAccess | undefined;
    // An existing Phase 4 cache without a manifest predates scoped permissions.
    // It remains available offline, as documented; no instant revocation claim.
    const manifest = value?.protocol === 2 ? validateAccessManifest(value, userId) : { protocol: 1 as const, userId };
    if (value && value.userId !== userId) throw new Error('account_cache_mismatch');
    accessClientStore.set(s => ({ ...s, status: 'offline', manifest, reason: 'offline_access_may_be_stale' }));
  } catch { failClientAccess('reconnect_required'); }
}

export function assertClientMutationReady(): void {
  const state = accessClientStore.get();
  if (state.manifest?.protocol === 2 && state.status !== 'ready' && state.status !== 'offline') throw new Error('Check access before editing. Reconnect and retry.');
}
