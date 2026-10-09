import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { runAccountSwitch, assertSameAccount, accountSwitchStore, type SwitchDecision, type SwitchDeps } from '../src/core/accountSwitch';
import { dropDatabaseFor } from '../src/core/db';
import { buildLocalBackup, importLocalBackup, parseBackup } from '../src/core/localBackup';
import type { DraftEnvelope } from '../src/core/drafts';

/* Reviews B4/R1/R2/R3 — protocol ordering asserted on injected deps, and the
 * backup/restore path exercised end-to-end against real Dexie stores on
 * fake-indexeddb (blob bytes round-trip, blocked deletes abort the switch). */

const decision: SwitchDecision = {
  prevId: 'user-A',
  newUser: { id: 'user-B', username: 'b', name: 'B', color: '#000', role: 'member', createdAt: 0 } as SwitchDecision['newUser'],
  token: 'tok-B',
  pending: { records: 3, rejected: 1, media: 1, drafts: 1 },
};

function makeDeps(): { deps: SwitchDeps; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      exportBackup: vi.fn(async () => (calls.push('export'), 'verified' as const)),
      closeLocal: vi.fn(async () => void calls.push('close')),
      dropLocal: vi.fn(async () => void calls.push('drop')),
      commitIdentity: vi.fn(() => void calls.push('commit')),
      revokeToken: vi.fn(async () => void calls.push('revoke')),
      reload: vi.fn(() => void calls.push('reload')),
    },
  };
}

describe('account-switch protocol ordering (R3)', () => {
  it('cancel: identity and local data untouched, new token revoked', async () => {
    const { deps, calls } = makeDeps();
    accountSwitchStore.set(decision);
    expect(await runAccountSwitch('cancel', decision, deps)).toBe('cancel');
    expect(calls).toEqual(['revoke']);
    expect(accountSwitchStore.get()).toBeNull();
  });

  it('keep verified: export → close → commit → reload, A store never deleted', async () => {
    const { deps, calls } = makeDeps();
    accountSwitchStore.set(decision);
    await runAccountSwitch('keep', decision, deps);
    expect(calls).toEqual(['export', 'close', 'commit', 'reload']);
    expect(deps.dropLocal).not.toHaveBeenCalled(); // quarantined, not wiped
    expect(deps.commitIdentity).toHaveBeenCalledWith('user-B', 'tok-B', decision.newUser);
  });

  it('keep with unverified download: pauses for explicit confirm before switching', async () => {
    const { deps, calls } = makeDeps();
    deps.exportBackup = vi.fn(async () => (calls.push('export'), 'clicked' as const));
    accountSwitchStore.set(decision);
    await runAccountSwitch('keep', decision, deps);
    expect(calls).toEqual(['export']); // nothing committed — awaiting confirm
    expect(accountSwitchStore.get()?.backup).toBe('downloaded-unconfirmed');
    const d2 = accountSwitchStore.get()!;
    await runAccountSwitch('keep-confirmed', d2, deps);
    expect(calls).toEqual(['export', 'close', 'commit', 'reload']);
  });

  it('destroy: close → drop(A) → commit → reload; drop failure aborts with B uncommitted', async () => {
    const { deps, calls } = makeDeps();
    accountSwitchStore.set(decision);
    await runAccountSwitch('destroy', decision, deps);
    expect(calls).toEqual(['close', 'drop', 'commit', 'reload']);

    // Blocked delete → propagation: identity NOT committed, nothing reloaded.
    const { deps: d2, calls: c2 } = makeDeps();
    d2.dropLocal = vi.fn(async () => {
      c2.push('drop');
      throw new Error('deleting workspace-user-A is blocked by another tab');
    });
    accountSwitchStore.set(decision);
    await expect(runAccountSwitch('destroy', decision, d2)).rejects.toThrow(/blocked by another tab/);
    expect(c2).toEqual(['close', 'drop']);
    expect(d2.commitIdentity).not.toHaveBeenCalled();
    expect(d2.reload).not.toHaveBeenCalled();
  });

  it('stale-tab guard: writes refuse once the device identity moved', () => {
    expect(() => assertSameAccount('user-A', 'user-B')).toThrow(/reload this tab/);
    expect(() => assertSameAccount('user-A', null)).toThrow(/reload this tab/);
    expect(() => assertSameAccount('user-A', 'user-A')).not.toThrow();
    expect(() => assertSameAccount(null, 'user-B')).not.toThrow();
  });
});

describe('full backup + restore against real Dexie stores (R1)', () => {
  it('archives outbox (all states), drafts and blob BYTES; import restores them', async () => {
    const { db } = await import('../src/core/db');
    await db.open();

    const bytes = new Uint8Array([1, 2, 3, 4, 5, 250, 200, 100]);
    await db.outbox.add({ id: 'r1', collection: 'tasks', patch: { title: 'x' }, ts: 7, state: 'pending' });
    await db.outbox.add({ id: 'r2', collection: 'tasks', patch: { title: 'y' }, ts: 8, state: 'rejected', rejectReason: 'invalid_mutation' });
    await db.blobs.add({ id: 'bl1', blob: new Blob([bytes], { type: 'image/png' }), state: 'pending', uploadedChunks: 0, mime: 'image/png' });
    const draft: DraftEnvelope = { v: 1, userId: 'user-A', collection: 'tasks', id: 'r1', values: { title: 'unsent title' }, baseTs: { title: 7 }, updatedAt: 1, source: 'edit' };
    await db.meta.put({ key: 'draft:user-A:tasks:r1', value: draft });

    const listDrafts = async () => [draft];
    const backup = await buildLocalBackup(db, 'user-A', listDrafts);
    expect(backup.outbox).toHaveLength(2); // rejected row INCLUDED
    expect(backup.blobs).toHaveLength(1);
    expect(backup.blobs[0].dataUrl.startsWith('data:image/png;base64,')).toBe(true);

    // JSON round-trip (as it would land on disk), then restore into an EMPTY db.
    const parsed = parseBackup(JSON.stringify(backup));
    await db.outbox.clear();
    await db.blobs.clear();
    await db.meta.clear();
    expect(await db.outbox.count()).toBe(0);

    const res = await importLocalBackup(db, parsed);
    expect(res).toEqual({ outbox: 2, drafts: 1, blobs: 1 });
    const restored = await db.outbox.toArray();
    expect(restored.find((e) => e.id === 'r2')?.state).toBe('rejected');
    expect(restored.find((e) => e.id === 'r2')?.rejectReason).toBe('invalid_mutation');
    const restoredBlob = await db.blobs.get('bl1');
    expect(new Uint8Array(await restoredBlob!.blob.arrayBuffer())).toEqual(bytes);
    const restoredDraft = (await db.meta.get('draft:user-A:tasks:r1'))?.value as DraftEnvelope;
    expect(restoredDraft.values).toEqual({ title: 'unsent title' });
  });

  it('dropDatabaseFor rejects when another connection blocks the delete', async () => {
    const uid = `u${Math.random().toString(36).slice(2)}`;
    const name = `workspace-${uid}`;
    // A RAW indexedDB connection models the sibling tab — unlike a Dexie
    // instance it does not auto-close on a blocked delete request.
    const holder = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('meta', { keyPath: 'key' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await expect(dropDatabaseFor(uid, 300)).rejects.toThrow(/blocked by another tab/);
    holder.close();
    await dropDatabaseFor(uid, 3000); // unblocked → succeeds
    await expect(Dexie.exists(name)).resolves.toBe(false);
  });
});
