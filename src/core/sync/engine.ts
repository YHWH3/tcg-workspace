import { PERMISSION_PROTOCOL } from '../../../shared/protocol';
import { isCollection, type Collection } from '../../../shared/collections';
import type { Mutation, PulledRecord, PublicUser } from '../../../shared/types';
import { api, ApiError, getToken } from '../api';
import { db, getMeta, setMeta } from '../db';
import { hlc } from '../hlc';
import { createStore } from '../store';
import { rebaseRecord, type PendingChange } from './rebase';
import { authStore, dropSession } from '../auth';
import { assertSameAccount } from '../accountSwitch';
import type { OutboxEntry } from '../db';
import { liveConnected, startPresence, stopPresence } from '../live';
import { countDrafts, ensurePersistentStorage, reconcileDraft } from '../drafts';
import { accessClientStore, assertClientMutationReady, failClientAccess, lockClientAccess, prepareOfflineAccess, prepareOnlineAccess } from '../accessClient';
import type { ReconciledAccess } from './reconcileAccess';

export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'error' | 'idle' | 'rejected';

interface SyncState {
  status: SyncStatus;
  /** Unsent outbox record writes. */
  pending: number;
  /** Pending/failed blob uploads — separate so 'Synced' can't lie about media. */
  pendingMedia: number;
  /** Server- or locally-rejected outbox writes, retained until resolved. */
  rejected: number;
  quarantined: number;
  lastSyncedAt: number | null;
}

export const syncStore = createStore<SyncState>({ status: 'idle', pending: 0, pendingMedia: 0, rejected: 0, quarantined: 0, lastSyncedAt: null });
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

/** The identity this tab booted with. A sibling tab completing an account
 * switch flips ws_uid — writes after that must refuse, not ride the new
 * identity (§12.3 stale-tab rule, review B4). */
const TAB_UID: string | null = typeof localStorage === 'undefined' ? null : localStorage.getItem('ws_uid');

function sameAccount() {
  assertSameAccount(TAB_UID, localStorage.getItem('ws_uid'));
}

async function updatePending() {
  const all = await db.outbox.toArray();
  const n = all.filter((e) => (e.state ?? 'pending') === 'pending').length;
  const rej = all.length - n;
  const media = await db.blobs.where('state').anyOf('pending', 'failed').count();
  const quarantined = await db.accessQuarantine.count();
  syncStore.set((s) => {
    // Rejected rows are unsynced work — never allow 'synced' while any
    // remain; clear the flag once they're retried/exported (review S3).
    const status = (rej + quarantined) > 0 && s.status === 'synced' ? 'rejected' : (rej + quarantined) === 0 && s.status === 'rejected' ? 'synced' : s.status;
    return s.pending === n && s.pendingMedia === media && s.rejected === rej && s.quarantined === quarantined && s.status === status ? s : { ...s, status, pending: n, pendingMedia: media, rejected: rej, quarantined };
  });
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
    await db.outbox.add({ id, collection, patch: data, ts: 1, createIntent: true });
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
  sameAccount();
  assertClientMutationReady();
  const table = db.collection(collection);
  const ts = hlc.next();
  await db.transaction('rw', table, db.outbox, async () => {
    const existing = await table.get(id);
    const row = { ...(existing ?? { id, _ts: {} }), ...patch };
    const fieldTs = { ...((existing?._ts as Record<string, number> | undefined) ?? {}) };
    for (const field of Object.keys(patch)) fieldTs[field] = ts;
    row._ts = fieldTs;
    await table.put(row);
    await db.outbox.add({ id, collection, patch, ts, createIntent: !existing });
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

/** Pure partition of a pushed chunk: acknowledged deletions vs entries that
 * must be retained as rejected (server disposition or local poison). Unit-
 * tested — review B5's 'nothing claimed synced that wasn't' invariant. */
export function planPushOutcome(entries: OutboxEntry[], rejectedItems: { id: string; collection: string; reason: string }[]): { acked: OutboxEntry[]; refused: OutboxEntry[] } {
  const reasons = new Map<string, string>();
  for (const r of rejectedItems) reasons.set(`${r.collection}:${r.id}`, r.reason);
  const acked: OutboxEntry[] = [];
  const refused: OutboxEntry[] = [];
  for (const e of entries) {
    const reason = reasons.get(`${e.collection}:${e.id}`);
    if (reason) refused.push({ ...e, state: 'rejected', rejectReason: reason });
    else acked.push(e);
  }
  return { acked, refused };
}

/** An HTTP 200 alone never acknowledges pending work. Require a complete,
 * internally consistent disposition for exactly this submitted chunk. */
function validatePushReply(value: unknown, entries: OutboxEntry[]): { id: string; collection: string; reason: string }[] {
  if (!value || typeof value !== 'object') throw new Error('invalid_push_reply');
  const reply = value as { ok?: unknown; rejected?: unknown; rejectedItems?: unknown };
  if (reply.ok !== true || !Number.isSafeInteger(reply.rejected) || (reply.rejected as number) < 0
      || !Array.isArray(reply.rejectedItems) || reply.rejectedItems.length !== reply.rejected
      || reply.rejectedItems.length > entries.length) throw new Error('invalid_push_reply');
  const available = new Map<string, number>();
  for (const entry of entries) { const key = `${entry.collection}:${entry.id}`; available.set(key, (available.get(key) ?? 0) + 1); }
  for (const item of reply.rejectedItems) {
    if (!item || typeof item.id !== 'string' || typeof item.collection !== 'string' || typeof item.reason !== 'string' || !item.reason) throw new Error('invalid_push_reply');
    const key = `${item.collection}:${item.id}`, remaining = available.get(key) ?? 0;
    if (!remaining) throw new Error('invalid_push_reply');
    available.set(key, remaining - 1);
  }
  return reply.rejectedItems;
}

/** Entries retained as rejected (never pushed, never dropped silently). */
export async function rejectedEntries(): Promise<OutboxEntry[]> {
  return (await db.outbox.toArray()).filter((e) => e.state === 'rejected');
}

/** Flip every rejected entry back to pending and re-sync. */
export async function retryRejected(): Promise<void> {
  const rej = await rejectedEntries();
  if (rej.length) {
    await db.outbox.bulkPut(rej.map((e) => ({ ...e, state: 'pending' as const, rejectReason: undefined })));
    await updatePending();
    scheduleSync();
  }
}

/** Serialize rejected entries for the durable surface's export path. */
export async function serializeRejected(): Promise<{ exportedAt: number; entries: Omit<OutboxEntry, 'autoId'>[] }> {
  const rej = await rejectedEntries();
  return { exportedAt: Date.now(), entries: rej.map(({ autoId: _autoId, ...e }) => e) };
}

async function pushOutbox(access: ReconciledAccess, assertCurrent: () => void): Promise<boolean> {
  for (;;) {
    assertCurrent();
    // Pending only — rejected rows stay retained until retried/exported.
    const entries = (await db.outbox.orderBy('autoId').toArray()).filter((e) => (e.state ?? 'pending') === 'pending').slice(0, PUSH_CHUNK);
    if (entries.length === 0) return true;
    // Poison entries the server would reject are RETAINED as rejected
    // (previously deleted — unrecoverable; review B5).
    const poison = entries.filter((e) => !validOutboxEntry(e));
    if (poison.length > 0) {
      console.warn('sync: retaining invalid outbox entries as rejected', poison.map((e) => e.id));
      await db.outbox.bulkPut(poison.map((e) => ({ ...e, state: 'rejected' as const, rejectReason: 'invalid_outbox_entry' })));
      await updatePending();
    }
    const good = entries.filter(validOutboxEntry);
    if (good.length === 0) continue;
    const changes: Mutation[] = good.map((e) => ({ id: e.id, collection: e.collection, patch: e.patch, ts: e.ts }));
    const res = await api<{ ok: boolean; accessEtag?: string; rejected: number; rejectedItems?: { id: string; collection: string; reason: string }[] }>('/api/sync/push', { method: 'POST', body: { changes, ...(access.protocol === PERMISSION_PROTOCOL ? { protocol: PERMISSION_PROTOCOL } : {}) } });
    assertCurrent();
    // Only acknowledged entries are deleted — server-rejected items stay
    // recoverable locally (they were never claimed as synced).
    const { acked, refused } = planPushOutcome(good, validatePushReply(res, good));
    if (access.protocol === PERMISSION_PROTOCOL && (typeof res.accessEtag !== 'string' || !res.accessEtag)) throw new Error('invalid_push_reply');
    await db.transaction('rw', db.outbox, async () => {
      assertCurrent();
      await db.outbox.bulkDelete(acked.map((e) => e.autoId!).filter((n) => n !== undefined));
      if (refused.length) await db.outbox.bulkPut(refused);
      assertCurrent();
    });
    await updatePending();
    if (access.protocol === PERMISSION_PROTOCOL && res.accessEtag !== access.etag) throw new Error('reauthorization_required');
    if (entries.length < PUSH_CHUNK) return true;
  }
}

async function pullRemote(access: ReconciledAccess, assertCurrent: () => void): Promise<boolean> {
  if (access.protocol === PERMISSION_PROTOCOL) return true;
  let cursor = (await getMeta<number>(CURSOR_KEY)) ?? 0;
  for (;;) {
    assertCurrent();
    const res = await api<{ protocol?: number; generation?: number; records: PulledRecord[]; cursor: number; hasMore: boolean }>(
      `/api/sync/pull?since=${cursor}&limit=${PULL_LIMIT}`,
    );
    assertCurrent();
    if (!res || !Array.isArray(res.records) || res.records.length > PULL_LIMIT || typeof res.hasMore !== 'boolean'
        || !Number.isSafeInteger(res.cursor) || res.cursor < cursor || (res.hasMore && res.cursor <= cursor)) throw new Error('invalid_sync_page');
    const seen = new Set<string>();
    for (const record of res.records) {
      if (!record || typeof record.id !== 'string' || !record.id || record.id.length > 64 || seen.has(record.id)
          || !isCollection(record.collection) || !record.data || typeof record.data !== 'object' || Array.isArray(record.data)
          || !record.field_ts || typeof record.field_ts !== 'object' || Array.isArray(record.field_ts)
          || Object.values(record.field_ts).some(value => typeof value !== 'number' || !Number.isFinite(value))
          || !Number.isSafeInteger(record.seq) || record.seq <= cursor || record.seq > res.cursor) throw new Error('invalid_sync_record');
      seen.add(record.id);
    }
    await db.transaction('rw', db.tables, async () => {
        assertCurrent();
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
          const row = { ...rebased.data, id: rec.id, _ts: rebased.field_ts, _serverRev: rec.seq, ...(rec.spaceId ? { _spaceId: rec.spaceId } : {}) };
          await db.collection(rec.collection).put(row);
          // Settle draft candidates against the reconciled value: matching
          // fields are confirmed and dropped; fields a remote write won keep
          // their candidate for review (§7 'recoverable local candidate').
          await reconcileDraft(rec.collection, rec.id, rebased.data, rebased.field_ts);
          for (const ts of Object.values(rec.field_ts)) hlc.observe(ts);
        }
        // Invisible gaps advance too. Cursor and records commit atomically.
        await setMeta(CURSOR_KEY, res.cursor);
        assertCurrent();
    });
    cursor = res.cursor;
    if (!res.hasMore) return true;
  }
}

async function refreshUsers(): Promise<void> {
  try {
    const uid=authStore.get().user?.id,token=getToken(),epoch=accessClientStore.get().epoch;
    const current=()=>{sameAccount();if(authStore.get().user?.id!==uid||getToken()!==token||accessClientStore.get().epoch!==epoch)throw new Error('directory_access_changed');};
    const { users } = await api<{ users: PublicUser[] }>('/api/users');
    await db.transaction('rw',db.users,async()=>{current();await db.users.clear();await db.users.bulkPut(users);current();});
  } catch {
    /* non-fatal */
  }
}

export async function syncNow(): Promise<void> {
  if (running) {
    queued = true;
    return;
  }
  try {
    sameAccount();
  } catch {
    // Stale tab under a replaced identity: stop syncing entirely.
    syncStore.set((s) => ({ ...s, status: 'error' }));
    failClientAccess('account_changed');
    return;
  }
  if (!getToken() || !navigator.onLine) {
    const userId = authStore.get().user?.id;
    if (getToken() && !navigator.onLine && userId) await prepareOfflineAccess(userId);
    syncStore.set((s) => ({ ...s, status: getToken() && !navigator.onLine ? 'offline' : s.status }));
    return;
  }
  running = true;
  syncStore.set((s) => ({ ...s, status: 'syncing' }));
  const token = getToken();
  let epoch: number | null = null;
  const assertCurrent = () => {
    sameAccount(); if (getToken() !== token) throw new Error('session_changed');
    if (epoch !== null && accessClientStore.get().epoch !== epoch) throw new Error('reauthorization_required');
  };
  try {
    const userId = authStore.get().user?.id;
    if (!userId) throw new Error('unauthenticated');
    const access = await prepareOnlineAccess(userId, assertCurrent);
    epoch = accessClientStore.get().epoch;
    if (access.protocol === 1) startPresence();
    else stopPresence(); // scoped presence waits for the server ACL integration
    await pushOutbox(access, assertCurrent);
    if (access.protocol === PERMISSION_PROTOCOL) {
      epoch = null; await prepareOnlineAccess(userId, assertCurrent); epoch = accessClientStore.get().epoch;
    } else await pullRemote(access, assertCurrent);
    // Guest/read-only clients must never manufacture Core seed writes. The
    // server bootstrap will provision built-ins for scoped workspaces.
    if (access.protocol === 1) { await seedBuiltins(); await refreshUsers(); }
    // Chunked blob uploads run after metadata sync (dynamic import avoids a cycle).
    const { uploadPendingBlobs } = await import('../files');
    assertCurrent(); await uploadPendingBlobs(assertCurrent); assertCurrent();
    await updatePending();
    // Rejected rows mean work was NOT accepted — 'synced' must never be
    // reported while any remain (review S3).
    syncStore.set((s) => ({ ...s, status: s.rejected + s.quarantined > 0 ? 'rejected' : 'synced', lastSyncedAt: Date.now() }));
    if (!persistenceRequested) {
      persistenceRequested = true;
      // Best-effort durability hint after real storage use (platform §3).
      void ensurePersistentStorage();
    }
  } catch (e) {
    // An old request may fail after another tab signs in. Its 401 applies to
    // the captured session, never the replacement credentials in localStorage.
    if (localStorage.getItem('ws_uid') !== TAB_UID || getToken() !== token) {
      stopPresence(); failClientAccess(localStorage.getItem('ws_uid') !== TAB_UID ? 'account_changed' : 'session_changed');
      syncStore.set(s => ({ ...s, status: 'error' })); return;
    }
    // navigator.onLine only describes a network interface, not reachability of
    // this server. A transport failure may use the SAME validated offline path
    // as airplane mode. HTTP denials/conflicts must never take this fallback.
    if (e instanceof ApiError && e.status === 0) {
      stopPresence();
      const userId = authStore.get().user?.id;
      if (userId) await prepareOfflineAccess(userId);
      if (localStorage.getItem('ws_uid') !== TAB_UID || getToken() !== token) {
        failClientAccess('session_changed'); syncStore.set(s => ({ ...s, status: 'error' })); return;
      }
      syncStore.set(s => ({ ...s, status: accessClientStore.get().status === 'offline' ? 'offline' : 'error' }));
      return;
    }
    failClientAccess(e instanceof Error && e.message === 'session_changed' ? 'session_changed' : 'access_check_failed');
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
  return (await db.outbox.count()) + (await db.blobs.where('state').anyOf('pending', 'failed').count()) + (await db.accessQuarantine.count());
}

/**
 * Everything locally owned that a sign-out/account switch could strand:
 * unsent record writes, pending/failed uploads, and unsent draft envelopes.
 */
export async function countLocalPending(): Promise<{ records: number; rejected: number; media: number; drafts: number }> {
  const [all, media, drafts, quarantined] = await Promise.all([
    db.outbox.toArray(),
    db.blobs.where('state').anyOf('pending', 'failed').count(),
    countDrafts(),
    db.accessQuarantine.count(),
  ]);
  // EVERY outbox row is unacknowledged server-side (pending, rejected, any
  // future state) — sign-out and account-switch protection must count them
  // all, not just 'pending' (review R2: rejected-only users were wiped).
  const rejected = all.filter((e) => (e.state ?? 'pending') === 'rejected').length;
  return { records: all.length + quarantined, rejected: rejected + quarantined, media, drafts };
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
  window.addEventListener('storage', handleAccessStorageChange);
  window.addEventListener('online', () => {
    onlineStore.set(true);
    lockClientAccess('reconnecting');
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

/** Storage events never confer permission and never clear another account's
 * token. They immediately gate this tab, then request current server authority. */
export function handleAccessStorageChange(event: Pick<StorageEvent, 'key' | 'newValue'>): void {
  if (!event.key || ['ws_uid', 'ws_token', 'ws_user'].includes(event.key)) {
    try { sameAccount(); } catch { stopPresence(); failClientAccess('account_changed'); return; }
    stopPresence(); lockClientAccess('session_changed');
    if (!getToken()) { dropSession(); failClientAccess('session_changed'); return; }
    void syncNow(); return;
  }
  if (event.key === 'ws_access_update') {
    try {
      const hint = JSON.parse(event.newValue ?? 'null') as { userId?: string } | null;
      if (hint?.userId !== TAB_UID) return;
      sameAccount(); stopPresence(); lockClientAccess('permissions_changed'); void syncNow();
    } catch { /* invalid hints are ignored, never permissions */ }
  }
}
