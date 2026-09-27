import { isCollection, type Collection } from '../../../shared/collections';
import type { Mutation, PulledRecord, PublicUser } from '../../../shared/types';
import { api, ApiError, getToken } from '../api';
import { db, getMeta, setMeta } from '../db';
import { hlc } from '../hlc';
import { createStore } from '../store';
import { rebaseRecord, type PendingChange } from './rebase';
import { dropSession } from '../auth';

export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'error' | 'idle';

interface SyncState {
  status: SyncStatus;
  pending: number;
  lastSyncedAt: number | null;
}

export const syncStore = createStore<SyncState>({ status: 'idle', pending: 0, lastSyncedAt: null });

const PUSH_CHUNK = 500;
const PULL_LIMIT = 500;
const CURSOR_KEY = 'sync_cursor';

let running = false;
let queued = false;
let timer: ReturnType<typeof setInterval> | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

async function updatePending() {
  const n = await db.outbox.count();
  syncStore.set((s) => (s.pending === n ? s : { ...s, pending: n }));
}

/** Local write API: apply patch to the local row + enqueue for sync, in one tx. */
export async function mutate(collection: Collection, id: string, patch: Record<string, unknown>): Promise<void> {
  const table = db.collection(collection);
  const ts = hlc.next();
  await db.transaction('rw', table, db.outbox, async () => {
    const existing = await table.get(id);
    const row = { ...(existing ?? { id, _ts: {} }), ...patch };
    const fieldTs = { ...((existing?._ts as Record<string, number> | undefined) ?? {}) };
    for (const field of Object.keys(patch)) fieldTs[field] = ts;
    row._ts = fieldTs;
    await table.put(row);
    await db.outbox.add({ id, collection, patch, ts });
  });
  void updatePending();
  scheduleSync();
}

async function pushOutbox(): Promise<boolean> {
  for (;;) {
    const entries = await db.outbox.orderBy('autoId').limit(PUSH_CHUNK).toArray();
    if (entries.length === 0) return true;
    const changes: Mutation[] = entries.map((e) => ({ id: e.id, collection: e.collection, patch: e.patch, ts: e.ts }));
    await api('/api/sync/push', { method: 'POST', body: { changes } });
    await db.outbox.bulkDelete(entries.map((e) => e.autoId!).filter((n) => n !== undefined));
    await updatePending();
    if (entries.length < PUSH_CHUNK) return true;
  }
}

async function pullRemote(): Promise<boolean> {
  let cursor = (await getMeta<number>(CURSOR_KEY)) ?? 0;
  for (;;) {
    const res = await api<{ records: PulledRecord[]; cursor: number; hasMore: boolean }>(
      `/api/sync/pull?since=${cursor}&limit=${PULL_LIMIT}`,
    );
    if (res.records.length > 0) {
      const byId = new Map<string, PendingChange[]>();
      for (const rec of res.records) {
        if (!byId.has(rec.id)) {
          const pending = await db.outbox.where('id').equals(rec.id).sortBy('autoId');
          byId.set(rec.id, pending);
        }
      }
      await db.transaction('rw', db.tables, async () => {
        for (const rec of res.records) {
          if (!isCollection(rec.collection)) continue;
          const rebased = rebaseRecord({ data: rec.data, field_ts: rec.field_ts }, byId.get(rec.id) ?? []);
          const row = { id: rec.id, ...rebased.data, _ts: rebased.field_ts };
          await db.collection(rec.collection).put(row);
          for (const ts of Object.values(rec.field_ts)) hlc.observe(ts);
        }
      });
      cursor = res.cursor;
      await setMeta(CURSOR_KEY, cursor);
    }
    if (!res.hasMore) return true;
  }
}

async function refreshUsers(): Promise<void> {
  try {
    const { users } = await api<{ users: PublicUser[] }>('/api/users');
    await db.users.clear();
    await db.users.bulkPut(users);
  } catch {
    /* non-fatal */
  }
}

export async function syncNow(): Promise<void> {
  if (running) {
    queued = true;
    return;
  }
  if (!getToken() || !navigator.onLine) {
    syncStore.set((s) => ({ ...s, status: getToken() && !navigator.onLine ? 'offline' : s.status }));
    return;
  }
  running = true;
  syncStore.set((s) => ({ ...s, status: 'syncing' }));
  try {
    await pushOutbox();
    await pullRemote();
    await refreshUsers();
    syncStore.set((s) => ({ ...s, status: 'synced', lastSyncedAt: Date.now() }));
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      // Signed out server-side: keep outbox + local data, drop the session.
      dropSession();
      running = false;
      return;
    }
    syncStore.set((s) => ({ ...s, status: navigator.onLine ? 'error' : 'offline' }));
  } finally {
    running = false;
    if (queued) {
      queued = false;
      void syncNow();
    }
  }
}

export function scheduleSync() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void syncNow(), 800);
}

export function startSyncEngine() {
  void updatePending();
  void syncNow();
  window.addEventListener('online', () => void syncNow());
  window.addEventListener('focus', () => void syncNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncNow();
  });
  timer = setInterval(() => {
    if (document.visibilityState === 'visible' && navigator.onLine) void syncNow();
  }, 15000);
  void timer;
}
