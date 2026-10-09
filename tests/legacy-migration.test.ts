import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { LocalDB } from '../src/core/db';
import { migrateLegacyStore, legacyRecoveryStore, LEGACY_NAME } from '../src/core/legacyMigration';
import { markStoreForDeletion, pendingStoreDrops, runDeferredDrops, clearAllMaint } from '../src/core/maintenance';

/* S1: seeded legacy 'workspace' store → per-account store, verified byte-for-
 * byte, then legacy retires via deferred drop. Ownership is proven by draft
 * envelopes; foreign/ambiguous ownership never auto-copies.
 * S2: deferred drops are the ONLY delete path — a blocked attempt leaves the
 * data AND the marker; it deletes only after the blocker is gone. */

async function seedLegacy(uid = 'user-A', withDrafts = true) {
  const legacy = new LocalDB(LEGACY_NAME);
  await legacy.open();
  await legacy.pages.put({ id: 'p1', title: 'offline page', _ts: { title: 5 } });
  await legacy.outbox.add({ id: 'o1', collection: 'tasks', patch: { title: 'p' }, ts: 3 });
  await legacy.outbox.add({ id: 'o2', collection: 'tasks', patch: { title: 'r' }, ts: 4, state: 'rejected', rejectReason: 'invalid_mutation' });
  if (withDrafts) await legacy.meta.put({ key: `draft:${uid}:tasks:o1`, value: { v: 1, userId: uid, collection: 'tasks', id: 'o1', values: { title: 'd' }, baseTs: {}, updatedAt: 1, source: 'edit' } });
  await legacy.meta.put({ key: 'sync_cursor', value: 4242 });
  await legacy.blobs.put({ id: 'bl', blob: new Blob([new Uint8Array([9, 8, 7, 6])], { type: 'image/png' }), state: 'pending', uploadedChunks: 0, mime: 'image/png' });
  legacy.close();
}

const freshTarget = async (uid: string) => new LocalDB(`workspace-${uid}`);

async function cleanup() {
  for (const n of await Dexie.getDatabaseNames()) {
    // Never touch workspace-maint (the marker store) or workspace-anon.
    if (n === LEGACY_NAME || (n.startsWith('workspace-') && n !== 'workspace-maint' && n !== 'workspace-anon')) await dropDatabaseFor2(n);
  }
  // Clear ALL maintenance markers (drops, migrated, legacy-confirm) — clean slate.
  await clearAllMaint();
}
function reopenedGet(conn: IDBDatabase, key: string): IDBRequest {
  return conn.transaction('meta').objectStore('meta').get(key);
}

async function dropDatabaseFor2(name: string) {
  await new Promise<void>((res, rej) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
    r.onblocked = () => res(); // best-effort cleanup
  });
}

describe('legacy store migration (S1)', () => {
  it('migrates records+meta+outbox(ALL states)+blob bytes with zero loss; legacy retires', async () => {
    await cleanup();
    await seedLegacy('user-A');
    const verdict = await migrateLegacyStore('user-A');
    expect(verdict).toBe('migrated');

    const target = await freshTarget('user-A');
    await target.open();
    expect((await target.pages.get('p1'))?.title).toBe('offline page');
    expect((await target.pages.get('p1'))?._ts).toEqual({ title: 5 });
    const out = await target.outbox.toArray();
    expect(out).toHaveLength(2);
    expect(out.find((e) => e.id === 'o2')?.state).toBe('rejected');
    expect((await target.meta.get('sync_cursor'))?.value).toBe(4242);
    expect(await target.meta.get('draft:user-A:tasks:o1')).toBeTruthy();
    const blob = await target.blobs.get('bl');
    expect(new Uint8Array(await blob!.blob.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7, 6]));
    // Old store kept on disk until the verified copy existed; now queued for
    // deferred deletion.
    expect(await pendingStoreDrops()).toContain(LEGACY_NAME);
    target.close();
  });

  it('no legacy store → verdict none, nothing copied', async () => {
    await cleanup();
    const legacy = new LocalDB(LEGACY_NAME); // creates it
    legacy.close();
    await dropDatabaseFor2(LEGACY_NAME);
    expect(await migrateLegacyStore('user-X')).toBe('none');
  });

  it('foreign-owned drafts → no copy, recovery surface offered', async () => {
    await cleanup();
    await seedLegacy('user-OTHER');
    expect(await migrateLegacyStore('user-A')).toBe('foreign');
    const r = legacyRecoveryStore.get();
    expect(r?.foreign).toBe(true);
    expect(r?.counts.records).toBe(1);
    const target = await freshTarget('user-A');
    await target.open();
    expect(await target.pages.count()).toBe(0); // nothing copied
    target.close();
    legacyRecoveryStore.set(null);
  });

  it('ambiguous owner (data, no drafts) → needs-confirm gate, no copy', async () => {
    await cleanup();
    await seedLegacy('user-A', false);
    expect(await migrateLegacyStore('user-A')).toBe('needs-confirm');
    const r = legacyRecoveryStore.get();
    expect(r?.foreign).toBe(false);
    const target = await freshTarget('user-A');
    await target.open();
    expect(await target.pages.count()).toBe(0);
    target.close();
    legacyRecoveryStore.set(null);
  });
});

describe('deferred deletion — the only delete path (S2)', () => {
  it('blocked drop attempt leaves data AND marker; deletes after unblock', async () => {
    await cleanup();
    const uid = `u${Math.random().toString(36).slice(2)}`;
    const name = `workspace-${uid}`;
    const store = new LocalDB(name);
    await store.open();
    await store.meta.put({ key: 'k', value: 'v' });
    store.close();

    // Switch-style destroy marks the store — nothing deleted yet.
    await markStoreForDeletion(uid);
    // Give any hypothetical pending request time — data must still exist.
    await new Promise((r) => setTimeout(r, 50));
    expect(await Dexie.exists(name)).toBe(true);

    // Blocking tab holds it: controlled pass cannot delete, marker survives,
    // and the DATA still exists — read it back through the holder itself
    // (a second open would queue behind the pending delete request).
    const holder = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const first = await runDeferredDrops('workspace-other');
    expect(first.dropped).not.toContain(name);
    expect(first.remaining).toContain(name);
    expect(await pendingStoreDrops()).toContain(name); // marker survives the block
    await new Promise((r) => setTimeout(r, 200)); // give any stray write time
    const got = await new Promise<unknown>((res) => {
      const tx = reopenedGet(holder, 'k');
      tx.onsuccess = () => res(tx.result);
    });
    expect(got).toEqual({ key: 'k', value: 'v' }); // STILL EXISTS — not just the name
    holder.close();

    // Next controlled pass deletes cleanly and clears the marker. (Any
    // abandoned request from the blocked attempt may also land on close —
    // either way deletion only completes via the controlled pass's intent,
    // never during a switch where an "abort" could have been reported.)
    const second = await runDeferredDrops('workspace-other');
    expect(second.dropped).toContain(name);
    expect(await pendingStoreDrops()).not.toContain(name);
  });

  it('never deletes the currently-active store even when marked', async () => {
    await cleanup();
    const uid = 'user-C';
    const store = new LocalDB(`workspace-${uid}`);
    await store.open();
    await store.meta.put({ key: 'k', value: 'v' });
    store.close();
    await markStoreForDeletion(uid);
    const res = await runDeferredDrops(`workspace-${uid}`); // active name
    expect(res.dropped).toEqual([]);
    expect(await Dexie.exists(`workspace-${uid}`)).toBe(true);
  });
});
