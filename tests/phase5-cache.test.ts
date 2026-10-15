import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDB } from '../src/core/db';
import { activateCacheSnapshot, beginCacheSnapshot, stageCachePage, ACCESS_MANIFEST_KEY, SNAPSHOT_KEY, type ClientAccessManifest, type SnapshotDescriptor, type SnapshotPage } from '../src/core/sync/accessCache';
import type { PulledRecord } from '../shared/types';

let store: LocalDB, userId: string, manifest: ClientAccessManifest, descriptor: SnapshotDescriptor;
const record = (id: string, collection = 'pages', data: Record<string, unknown> = { title: 'Authorized' }): PulledRecord => ({ id, collection, data, field_ts: Object.fromEntries(Object.keys(data).map(k => [k, 1])), seq: 1, spaceId: 'space-core' });
const page = (records: PulledRecord[], done = true): SnapshotPage => ({ snapshotId: descriptor.snapshotId, generation: descriptor.generation, cutoff: descriptor.cutoff, records, cursor: done ? null : 'next', done });
beforeEach(async () => {
  userId = `cache-${crypto.randomUUID()}`; store = new LocalDB(`workspace-${userId}`); await store.open();
  manifest = { protocol: 2, userId, workspaceRole: 'member', generation: 20, spaces: [{ id: 'space-core', name: 'Core', role: 'editor', exportPolicy: 'members' }] };
  descriptor = { snapshotId: crypto.randomUUID(), generation: 20, cutoff: 100, cursor: 'first', expiresAt: Date.now() + 60_000 };
});
afterEach(async () => { await store.delete(); });

describe('Phase 5 durable account snapshot cache on Dexie/fake IndexedDB', () => {
  it('stages without changing live records and resumes the page cursor after browser-store reopen', async () => {
    await store.pages.put({ id: 'private', title: 'Old private title', _ts: {} });
    await beginCacheSnapshot(store, userId, descriptor);
    const first = page([record('a')], false);
    await stageCachePage(store, userId, descriptor, 'first', first);
    expect(await store.pages.get('a')).toBeUndefined(); expect((await store.pages.get('private'))!.title).toBe('Old private title');
    store.close(); await store.open();
    expect((await store.meta.get(SNAPSHOT_KEY))!.value).toMatchObject({ nextCursor: 'next', count: 1, done: false });
    await stageCachePage(store, userId, descriptor, 'first', first); // exact replay
    expect(await store.syncStage.count()).toBe(1);
    await expect(activateCacheSnapshot(store, manifest, descriptor)).rejects.toThrow('snapshot_incomplete_or_expired');
    await stageCachePage(store, userId, descriptor, 'next', page([record('b')]));
    await activateCacheSnapshot(store, manifest, descriptor);
    expect((await store.pages.toArray()).map(r => r.id).sort()).toEqual(['a', 'b']);
    expect(await store.syncStage.count()).toBe(0); expect(await store.meta.get(SNAPSHOT_KEY)).toBeUndefined();
    expect((await store.meta.get('sync_cursor'))!.value).toBe(100);
  });

  it('quarantines revoked outbox, drafts and pending bytes while deleting cached thumbnails', async () => {
    await store.pages.put({ id: 'secret', title: 'Revoked title', _ts: {} });
    await store.files.put({ id: 'attachment', parentId: 'secret', thumbId: 'thumb', _ts: {} });
    await store.outbox.add({ id: 'secret', collection: 'pages', patch: { title: 'Offline confidential edit' }, ts: 100 });
    await store.meta.put({ key: `draft:${userId}:pages:secret`, value: { userId, id: 'secret', values: { title: 'Private draft' } } });
    await store.blobs.bulkPut([{ id: 'attachment', blob: new Blob(['pending bytes']), state: 'pending', uploadedChunks: 0 }, { id: 'thumb', blob: new Blob(['thumb']), state: 'cached', uploadedChunks: 0 }]);
    await store.users.put({ id: 'old-user', username: 'private', name: 'Old directory', role: 'member', color: '' });
    await beginCacheSnapshot(store, userId, descriptor); await stageCachePage(store, userId, descriptor, 'first', page([record('visible')]));
    const result = await activateCacheSnapshot(store, manifest, descriptor);
    expect(result.quarantined).toBe(3); expect(result.removedBlobs.sort()).toEqual(['attachment', 'thumb']);
    expect(await store.outbox.count()).toBe(0); expect(await store.blobs.count()).toBe(0); expect(await store.files.count()).toBe(0); expect(await store.users.count()).toBe(0);
    expect(await store.meta.get(`draft:${userId}:pages:secret`)).toBeUndefined();
    expect(JSON.stringify(await store.pages.toArray())).not.toMatch(/Revoked|confidential|Private/);
    const quarantined = await store.accessQuarantine.toArray();
    expect(quarantined.map(r => r.kind).sort()).toEqual(['blob', 'draft', 'outbox']);
    expect(JSON.stringify(quarantined)).toContain('Offline confidential edit');
    store.close(); await store.open(); expect(await store.accessQuarantine.count()).toBe(3);
  });

  it('preserves and rebases authorized unsynced edits, local creations and media', async () => {
    await store.outbox.bulkAdd([
      { id: 'a', collection: 'pages', patch: { title: 'Local edit' }, ts: 100 },
      { id: 'new', collection: 'pages', patch: { title: 'Created offline', spaceId: 'space-core' }, ts: 101, createIntent: true },
      { id: 'new-body', collection: 'blocks', patch: { pageId: 'new', text: 'Body' }, ts: 102, createIntent: true },
    ]);
    await store.blobs.put({ id: 'authorized-file', blob: new Blob(['pending']), state: 'pending', uploadedChunks: 0 });
    await beginCacheSnapshot(store, userId, descriptor);
    await stageCachePage(store, userId, descriptor, 'first', page([record('a'), record('existing-body', 'blocks', { pageId: 'a', text: 'Existing' }), record('authorized-file', 'files', { parentType: 'block', parentId: 'existing-body' })]));
    const result = await activateCacheSnapshot(store, manifest, descriptor);
    expect(result.quarantined).toBe(0); expect(await store.outbox.count()).toBe(3);
    expect((await store.pages.get('a'))!.title).toBe('Local edit'); expect((await store.pages.get('a'))!._serverRev).toBe(1);
    expect((await store.pages.get('new'))!.title).toBe('Created offline'); expect((await store.blocks.get('new-body'))!._spaceId).toBe('space-core');
    expect(await store.blobs.get('authorized-file')).toBeDefined();
  });

  it('keeps canonical viewer content while quarantining edits, drafts and pending uploads after downgrade', async () => {
    manifest.spaces[0].role = 'viewer';
    await store.outbox.add({ id: 'a', collection: 'pages', patch: { title: 'Cannot edit now' }, ts: 100 });
    await store.meta.put({ key: `draft:${userId}:pages:a`, value: { id: 'a', values: { title: 'Unsent draft' } } });
    await store.blobs.put({ id: 'file', blob: new Blob(['pending']), state: 'pending', uploadedChunks: 0 });
    await beginCacheSnapshot(store, userId, descriptor);
    await stageCachePage(store, userId, descriptor, 'first', page([record('a'), record('file', 'files', { parentType: 'block', parentId: 'body' }), record('body', 'blocks', { pageId: 'a', text: 'Body' })]));
    expect((await activateCacheSnapshot(store, manifest, descriptor)).quarantined).toBe(3);
    expect((await store.pages.get('a'))!.title).toBe('Authorized'); expect(await store.files.get('file')).toBeDefined();
    expect(await store.blobs.get('file')).toBeUndefined(); expect(await store.outbox.count()).toBe(0);
  });

  it('rejects account/generation mismatch and malformed, duplicate or conflicting replay pages', async () => {
    await expect(beginCacheSnapshot(store, 'another-account', descriptor)).rejects.toThrow('account_cache_mismatch');
    await beginCacheSnapshot(store, userId, descriptor);
    await expect(stageCachePage(store, userId, descriptor, 'first', page([{ ...record('a'), spaceId: undefined }]))).rejects.toThrow('invalid_snapshot_record');
    await expect(stageCachePage(store, userId, descriptor, 'first', page([record('a'), record('a')]))).rejects.toThrow('invalid_snapshot_record');
    await stageCachePage(store, userId, descriptor, 'first', page([record('a')], false));
    await expect(stageCachePage(store, userId, descriptor, 'first', page([record('changed')], false))).rejects.toThrow('snapshot_replay_mismatch');
    await expect(stageCachePage(store, userId, descriptor, 'next', page([record('a')]))).rejects.toThrow('duplicate_snapshot_record');
    await stageCachePage(store, userId, descriptor, 'next', page([]));
    await expect(activateCacheSnapshot(store, { ...manifest, generation: 21 }, descriptor)).rejects.toThrow('snapshot_manifest_mismatch');
    expect(await store.pages.count()).toBe(0); expect(await store.syncStage.count()).toBe(1);
  });

  it('refuses a staged record from an ungranted space and preserves the old cache for a safe retry', async () => {
    await store.pages.put({ id: 'prior', title: 'Old cache remains gated', _ts: {} });
    await beginCacheSnapshot(store, userId, descriptor);
    await stageCachePage(store, userId, descriptor, 'first', page([{ ...record('bad'), spaceId: 'not-granted' }]));
    await expect(activateCacheSnapshot(store, manifest, descriptor)).rejects.toThrow('invalid_authorized_snapshot');
    expect(await store.pages.get('bad')).toBeUndefined(); expect(await store.pages.get('prior')).toBeDefined();
    expect(await store.meta.get(ACCESS_MANIFEST_KEY)).toBeUndefined();
  });

  it('preserves commenter edits to their own comment while refusing ordinary content edits', async () => {
    manifest.spaces[0].role = 'commenter';
    await store.outbox.bulkAdd([
      { id: 'a', collection: 'pages', patch: { title: 'Denied' }, ts: 100 },
      { id: 'comment', collection: 'comments', patch: { body: 'Edited comment' }, ts: 100 },
    ]);
    await beginCacheSnapshot(store, userId, descriptor);
    await stageCachePage(store, userId, descriptor, 'first', page([record('a'), record('comment', 'comments', { targetType: 'page', targetId: 'a', authorId: userId, body: 'Original' })]));
    await activateCacheSnapshot(store, manifest, descriptor);
    expect((await store.pages.get('a'))!.title).toBe('Authorized');
    // The page edit's rejection does not revoke read access to its canonical
    // row; a comment referring to that existing canonical row is independent.
    expect((await store.comments.get('comment'))!.body).toBe('Edited comment');
    expect((await store.outbox.toArray()).map(e => e.id)).toEqual(['comment']);
  });

  it('rolls back all eviction, quarantine, metadata and cursor changes when activation crashes', async () => {
    await store.pages.put({ id: 'secret', title: 'Prior cache', _ts: {} });
    await store.outbox.add({ id: 'secret', collection: 'pages', patch: { title: 'Pending' }, ts: 10 });
    await store.meta.put({ key: 'sync_cursor', value: 1 });
    await beginCacheSnapshot(store, userId, descriptor); await stageCachePage(store, userId, descriptor, 'first', page([record('a')]));
    const crash = (_changes: unknown, key: string) => { if (key === 'sync_cursor') throw new Error('injected cache activation crash'); };
    store.meta.hook('updating', crash);
    await expect(activateCacheSnapshot(store, manifest, descriptor)).rejects.toThrow('injected cache activation crash');
    store.meta.hook('updating').unsubscribe(crash);
    store.close(); await store.open();
    expect((await store.pages.get('secret'))!.title).toBe('Prior cache'); expect(await store.pages.get('a')).toBeUndefined();
    expect(await store.outbox.count()).toBe(1); expect(await store.accessQuarantine.count()).toBe(0);
    expect((await store.meta.get('sync_cursor'))!.value).toBe(1); expect(await store.meta.get(ACCESS_MANIFEST_KEY)).toBeUndefined();
    expect(await store.syncStage.count()).toBe(1);
    await activateCacheSnapshot(store, manifest, descriptor);
    expect(await store.pages.get('secret')).toBeUndefined(); expect(await store.outbox.count()).toBe(0); expect(await store.accessQuarantine.count()).toBe(1);
  });
});
