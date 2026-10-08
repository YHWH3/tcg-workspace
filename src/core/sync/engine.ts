import { isCollection, type Collection } from '../../../shared/collections';
import type { Mutation, PulledRecord, PublicUser } from '../../../shared/types';
import { api, ApiError, getToken } from '../api';
import { db, getMeta, setMeta } from '../db';
import { hlc } from '../hlc';
import { createStore } from '../store';
import { rebaseRecord, type PendingChange } from './rebase';
import { authStore, dropSession } from '../auth';
import { liveConnected, startPresence } from '../live';
import { countDrafts, ensurePersistentStorage, reconcileDraft } from '../drafts';

export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'error' | 'idle';

interface SyncState {
  status: SyncStatus;
  /** Unsent outbox record writes. */
  pending: number;
  /** Pending/failed blob uploads — separate so 'Synced' can't lie about media. */
  pendingMedia: number;
  lastSyncedAt: number | null;
}

export const syncStore = createStore<SyncState>({ status: 'idle', pending: 0, pendingMedia: 0, lastSyncedAt: null });
export const onlineStore = createStore(typeof navigator === 'undefined' ? true : navigator.onLine);

const PUSH_CHUNK = 500;
const PULL_LIMIT = 500;
const CURSOR_KEY = 'sync_cursor';

let running = false;
let queued = false;
let timer: ReturnType<typeof setInterval> | undefined;
let lastPeriod = 0;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let persistenceRequested = false;

async function updatePending() {
  const n = await db.outbox.count();
  const media = await db.blobs.where('state').anyOf('pending', 'failed').count();
  syncStore.set((s) => (s.pending === n && s.pendingMedia === media ? s : { ...s, pending: n, pendingMedia: media }));
}

/** Re-count pending work (records + media) — safe to call after any write path. */
export function refreshPending(): void {
  void updatePending();
}

/**
 * Seed a record with field timestamps = 1 — any real user edit (local or
 * remote) has a higher ts and therefore wins. No-ops if the row exists.
 * The seed goes through the outbox so it propagates to the server, where it
 * likewise loses to any existing version of the row.
 */
export async function seedRecord(collection: Collection, id: string, data: Record<string, unknown>): Promise<void> {
  const table = db.collection(collection);
  await db.transaction('rw', table, db.outbox, async () => {
    if (await table.get(id)) return;
    const fieldTs: Record<string, number> = {};
    for (const field of Object.keys(data)) fieldTs[field] = 1;
    await table.put({ id, ...data, _ts: fieldTs });
    await db.outbox.add({ id, collection, patch: data, ts: 1 });
  });
}

const SEEDS_DONE = 'seeds_v1';

async function seedBuiltins(): Promise<void> {
  if (await getMeta(SEEDS_DONE)) return;
  await seedRecord('boards', 'board-default', {
    name: 'Tasks',
    icon: '✅',
    columns: [
      { id: 'todo', name: 'To do', color: '#8a8a8a' },
      { id: 'in_progress', name: 'In progress', color: '#0091ff' },
      { id: 'done', name: 'Done', color: '#30a46c' },
    ],
    order: 'a0',
    createdAt: Date.now(),
  });
  await seedRecord('boards', 'board-inbox', {
    name: 'Inbox',
    icon: '📥',
    columns: [
      { id: 'new', name: 'New', color: '#e5a000' },
      { id: 'sorted', name: 'Sorted', color: '#30a46c' },
    ],
    order: 'a1',
    createdAt: Date.now(),
  });
  await setMeta(SEEDS_DONE, 1);
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

function validOutboxEntry(e: { id: unknown; collection: unknown; patch: unknown; ts: unknown }): boolean {
  return (
    typeof e.id === 'string' &&
    e.id.length > 0 &&
    e.id.length <= 64 &&
    typeof e.collection === 'string' &&
    isCollection(e.collection) &&
    typeof e.patch === 'object' &&
    e.patch !== null &&
    !Array.isArray(e.patch) &&
    typeof e.ts === 'number' &&
    Number.isFinite(e.ts)
  );
}

async function pushOutbox(): Promise<boolean> {
  for (;;) {
    const entries = await db.outbox.orderBy('autoId').limit(PUSH_CHUNK).toArray();
    if (entries.length === 0) return true;
    // Drop poison entries the server would reject (e.g. a collection removed
    // when a module is uninstalled) so they can't jam the queue forever.
    const poison = entries.filter((e) => !validOutboxEntry(e));
    if (poison.length > 0) {
      console.warn('sync: dropping invalid outbox entries', poison.map((e) => e.id));
      await db.outbox.bulkDelete(poison.map((e) => e.autoId!).filter((n) => n !== undefined));
    }
    const good = entries.filter(validOutboxEntry);
    if (good.length === 0) continue;
    const changes: Mutation[] = good.map((e) => ({ id: e.id, collection: e.collection, patch: e.patch, ts: e.ts }));
    await api('/api/sync/push', { method: 'POST', body: { changes } });
    await db.outbox.bulkDelete(good.map((e) => e.autoId!).filter((n) => n !== undefined));
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
      await db.transaction('rw', db.tables, async () => {
        // Read pending entries inside the tx: a mutate() that lands between the
        // read and the write must not be clobbered by stale server data.
        const byId = new Map<string, PendingChange[]>();
        for (const rec of res.records) {
          if (!byId.has(rec.id)) {
            byId.set(rec.id, await db.outbox.where('id').equals(rec.id).sortBy('autoId'));
          }
        }
        for (const rec of res.records) {
          if (!isCollection(rec.collection)) continue;
          const rebased = rebaseRecord({ data: rec.data, field_ts: rec.field_ts }, byId.get(rec.id) ?? []);
          const row = { id: rec.id, ...rebased.data, _ts: rebased.field_ts };
          await db.collection(rec.collection).put(row);
          // Settle draft candidates against the reconciled value: matching
          // fields are confirmed and dropped; fields a remote write won keep
          // their candidate for review (§7 'recoverable local candidate').
          await reconcileDraft(rec.collection, rec.id, rebased.data, rebased.field_ts);
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
    await seedBuiltins();
    await refreshUsers();
    // Chunked blob uploads run after metadata sync (dynamic import avoids a cycle).
    const { uploadPendingBlobs } = await import('../files');
    await uploadPendingBlobs();
    await updatePending();
    syncStore.set((s) => ({ ...s, status: 'synced', lastSyncedAt: Date.now() }));
    if (!persistenceRequested) {
      persistenceRequested = true;
      // Best-effort durability hint after real storage use (platform §3).
      void ensurePersistentStorage();
    }
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

/** Flush the outbox, then report remaining pending work incl. media (for sign-out warning). */
export async function flushAndCountPending(): Promise<number> {
  try {
    await syncNow();
  } catch {
    /* best effort */
  }
  return (await db.outbox.count()) + (await db.blobs.where('state').anyOf('pending', 'failed').count());
}

/**
 * Everything locally owned that a sign-out/account switch could strand:
 * unsent record writes, pending/failed uploads, and unsent draft envelopes.
 */
export async function countLocalPending(): Promise<{ records: number; media: number; drafts: number }> {
  const [records, media, drafts] = await Promise.all([
    db.outbox.count(),
    db.blobs.where('state').anyOf('pending', 'failed').count(),
    countDrafts(),
  ]);
  return { records, media, drafts };
}

export function startSyncEngine() {
  void updatePending();
  void syncNow();
  // Re-kick sync whenever auth state flips to authed (e.g. right after login:
  // the engine's first run happens while unauthenticated and early-returns).
  let wasAuthed = !!authStore.get().user;
  authStore.subscribe(() => {
    const authed = !!authStore.get().user;
    if (authed && !wasAuthed) void syncNow();
    wasAuthed = authed;
  });
  void startPresence();
  window.addEventListener('online', () => {
    onlineStore.set(true);
    void syncNow();
  });
  window.addEventListener('offline', () => onlineStore.set(false));
  window.addEventListener('focus', () => void syncNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncNow();
  });
  const pollTick = () => {
    if (document.visibilityState === 'visible' && navigator.onLine) void syncNow();
  };
  timer = setInterval(pollTick, liveConnected() ? 60000 : 15000);
  // Poll every 60s while the live socket is up (pokes give instant updates);
  // drop back to 15s as the fallback when it isn't.
  setInterval(() => {
    const period = liveConnected() ? 60000 : 15000;
    if (period !== lastPeriod) {
      lastPeriod = period;
      clearInterval(timer);
      timer = setInterval(pollTick, period);
    }
  }, 5000);
  void timer;
}
