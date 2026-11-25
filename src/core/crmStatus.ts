import { useEffect } from 'react';
import { CrmStatusSchema, type CrmStatus } from '../../shared/crm/contracts';
import type { CrmCapability } from '../../shared/crm/capabilities';
import { api, ApiError, getToken } from './api';
import { accessClientStore } from './accessClient';
import { authStore, dropSession } from './auth';
import { liveStore } from './live';
import { createStore, useStore } from './store';

export const CRM_STATUS_STORAGE_HINT_KEY = 'ws_crm_status_update';
export const LAST_APP_STORAGE_KEY = 'ws_last_app';

export type CrmStatusPhase = 'idle' | 'loading' | 'ready' | 'unauthed' | 'offline' | 'error';

export interface CrmStatusState {
  status: CrmStatusPhase;
  data: CrmStatus | null;
  offline: boolean;
  error: string | null;
  revision: number;
}

const initialState = (): CrmStatusState => ({
  status: 'idle',
  data: null,
  offline: typeof navigator !== 'undefined' ? !navigator.onLine : false,
  error: null,
  revision: 0,
});

export const crmStatusStore = createStore<CrmStatusState>(initialState());

let generation = 0;
let activeIdentityKey = '';
let inflight: { key: string; gen: number; promise: Promise<CrmStatus | null> } | null = null;
let stopListeners: (() => void) | null = null;

export function currentCrmIdentityKey(): string {
  const auth = authStore.get();
  if (auth.status !== 'authed') return '';
  const uid = auth.user?.id ?? (typeof localStorage !== 'undefined' ? localStorage.getItem('ws_uid') : null);
  const token = getToken();
  if (!uid || !token) return '';
  const epoch = accessClientStore.get().epoch;
  return `${uid}:${token}:${epoch}`;
}

function statusDataEqual(a: CrmStatus | null, b: CrmStatus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.enabled !== b.enabled || a.access !== b.access || a.owner !== b.owner) return false;
  if (a.capabilities.length !== b.capabilities.length) return false;
  for (let i = 0; i < a.capabilities.length; i++) {
    if (
      a.capabilities[i].capability !== b.capabilities[i].capability ||
      a.capabilities[i].scope !== b.capabilities[i].scope
    ) {
      return false;
    }
  }
  return true;
}

function resetForIdentityChange(nextKey: string): void {
  generation += 1;
  activeIdentityKey = nextKey;
  inflight = null;
  const offline = typeof navigator !== 'undefined' ? !navigator.onLine : false;
  const authStatus = authStore.get().status;
  crmStatusStore.set((prev) => ({
    status: !nextKey ? (authStatus === 'unauthed' ? 'unauthed' : 'idle') : offline ? 'offline' : 'idle',
    data: null,
    offline,
    error: null,
    revision: prev.revision + 1,
  }));
}

export function hasCrmAccess(state: CrmStatusState): boolean {
  return Boolean(state.data?.enabled && state.data?.access);
}

export function hasCrmCapability(data: CrmStatus | null, cap: CrmCapability, scope = '*'): boolean {
  if (!data?.enabled || !data.access) return false;
  if (data.owner) return true;
  return data.capabilities.some((c) => c.capability === cap && (c.scope === '*' || c.scope === scope));
}

export function canManageCrmAccess(data: CrmStatus | null): boolean {
  return hasCrmCapability(data, 'crm.capabilities.manage');
}

export async function refreshCrmStatus(opts?: { force?: boolean }): Promise<CrmStatus | null> {
  const key = currentCrmIdentityKey();
  if (key !== activeIdentityKey) {
    resetForIdentityChange(key);
  }
  if (!key) {
    return null;
  }

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    crmStatusStore.set((prev) => ({
      ...prev,
      status: 'offline',
      offline: true,
      error: null,
    }));
    return crmStatusStore.get().data;
  }

  if (!opts?.force && inflight && inflight.key === key) {
    return inflight.promise;
  }

  const gen = ++generation;
  const current = () => generation === gen && currentCrmIdentityKey() === key;
  crmStatusStore.set((prev) => ({
    ...prev,
    status: prev.data ? prev.status : 'loading',
    offline: false,
    error: null,
  }));

  const promise = (async (): Promise<CrmStatus | null> => {
    try {
      const raw = await api<unknown>('/api/crm/status');
      if (!current()) return null;
      const parsed = CrmStatusSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error('Invalid CRM status payload');
      }
      const next = parsed.data;
      crmStatusStore.set((prev) => ({
        status: 'ready',
        data: next,
        offline: false,
        error: null,
        revision: statusDataEqual(prev.data, next) ? prev.revision : prev.revision + 1,
      }));
      return next;
    } catch (err) {
      if (!current()) return null;
      if (err instanceof ApiError && err.status === 401) {
        generation += 1;
        activeIdentityKey = '';
        crmStatusStore.set((prev) => ({
          status: 'unauthed',
          data: null,
          offline: false,
          error: null,
          revision: prev.revision + 1,
        }));
        dropSession();
        return null;
      }
      const isOffline = (err instanceof ApiError && err.status === 0) || (typeof navigator !== 'undefined' && !navigator.onLine);
      if (isOffline) {
        crmStatusStore.set((prev) => ({
          ...prev,
          status: 'offline',
          offline: true,
          error: null,
        }));
        return crmStatusStore.get().data;
      }
      crmStatusStore.set((prev) => ({
        ...prev,
        status: prev.data ? 'ready' : 'error',
        offline: false,
        error: prev.data ? 'Unable to refresh CRM access right now.' : 'Unable to check CRM access right now.',
      }));
      return crmStatusStore.get().data;
    } finally {
      if (inflight?.gen === gen) {
        inflight = null;
      }
    }
  })();

  inflight = { key, gen, promise };
  return promise;
}

/**
 * Synchronously clear protected UI state and revalidate with the server on
 * any auth/authority failure (`401`, `403`, `404`, or `CommandError('forbidden')`).
 */
export function handleCrmAuthFailure(
  kind: 'unauthenticated' | 'forbidden' | 'not_found',
  expectedIdentityKey?: string,
): void {
  const currentKey = currentCrmIdentityKey();
  if (expectedIdentityKey && currentKey !== expectedIdentityKey) return;

  generation += 1;
  inflight = null;

  if (kind === 'unauthenticated') {
    activeIdentityKey = '';
    crmStatusStore.set((prev) => ({
      status: 'unauthed',
      data: null,
      offline: false,
      error: null,
      revision: prev.revision + 1,
    }));
    dropSession();
    return;
  }

  crmStatusStore.set((prev) => ({
    ...prev,
    status: 'loading',
    data: null,
    offline: false,
    error: null,
    revision: prev.revision + 1,
  }));
  void refreshCrmStatus({ force: true });
}

export async function notifyCrmStatusUpdated(userId?: string): Promise<CrmStatus | null> {
  try {
    if (typeof localStorage !== 'undefined') {
      const targetId = userId ?? authStore.get().user?.id ?? '';
      const nonce = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now());
      localStorage.setItem(CRM_STATUS_STORAGE_HINT_KEY, JSON.stringify({ userId: targetId, nonce }));
    }
  } catch {
    /* localStorage is hint-only; server status refresh remains authoritative */
  }
  return refreshCrmStatus({ force: true });
}

export function startCrmStatus(): () => void {
  if (stopListeners) return stopListeners;

  const initialKey = currentCrmIdentityKey();
  activeIdentityKey = initialKey;
  if (initialKey) {
    void refreshCrmStatus();
  } else {
    resetForIdentityChange('');
  }

  let wasLive = liveStore.get().connected;

  const syncIdentity = () => {
    const nextKey = currentCrmIdentityKey();
    if (nextKey !== activeIdentityKey) {
      resetForIdentityChange(nextKey);
      if (nextKey) void refreshCrmStatus({ force: true });
    }
  };

  const unsubAuth = authStore.subscribe(syncIdentity);
  const unsubAccess = accessClientStore.subscribe(syncIdentity);
  const unsubLive = liveStore.subscribe(() => {
    const connected = liveStore.get().connected;
    if (connected && !wasLive && currentCrmIdentityKey()) {
      void refreshCrmStatus({ force: true });
    }
    wasLive = connected;
  });

  const onRecordsChanged = () => {
    if (currentCrmIdentityKey()) void refreshCrmStatus({ force: true });
  };
  const onFocus = () => {
    if (currentCrmIdentityKey()) void refreshCrmStatus({ force: true });
  };
  const onPageShow = () => {
    if (currentCrmIdentityKey()) void refreshCrmStatus({ force: true });
  };
  const onVisibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible' && currentCrmIdentityKey()) {
      void refreshCrmStatus({ force: true });
    }
  };
  const onOnline = () => {
    crmStatusStore.set((prev) => ({ ...prev, offline: false }));
    if (currentCrmIdentityKey()) void refreshCrmStatus({ force: true });
  };
  const onOffline = () => {
    crmStatusStore.set((prev) => ({ ...prev, status: 'offline', offline: true }));
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === CRM_STATUS_STORAGE_HINT_KEY) {
      if (currentCrmIdentityKey()) void refreshCrmStatus({ force: true });
      return;
    }
    if (e.key === null || e.key === 'ws_uid' || e.key === 'ws_token' || e.key === 'ws_user') {
      syncIdentity();
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('ws-records-changed', onRecordsChanged);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('storage', onStorage);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  const cleanup = () => {
    unsubAuth();
    unsubAccess();
    unsubLive();
    if (typeof window !== 'undefined') {
      window.removeEventListener('ws-records-changed', onRecordsChanged);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('storage', onStorage);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
    if (stopListeners === cleanup) {
      stopListeners = null;
    }
  };

  stopListeners = cleanup;
  return cleanup;
}

export function ensureCrmStatusStarted(): void {
  if (!stopListeners) {
    startCrmStatus();
  }
}

export function useCrmStatus(): CrmStatusState {
  useEffect(() => {
    ensureCrmStatusStarted();
  }, []);
  return useStore(crmStatusStore);
}

export function resetCrmStatusForTest(): void {
  stopListeners?.();
  stopListeners = null;
  generation += 1;
  activeIdentityKey = '';
  inflight = null;
  crmStatusStore.set(initialState());
}
