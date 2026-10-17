import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ userId: 'media-user' }));
vi.mock('../src/core/auth', () => ({ authStore: { get: () => ({ user: { id: state.userId } }), subscribe: vi.fn() }, dropSession: vi.fn() }));
let db: typeof import('../src/core/db')['db'], media: typeof import('../src/core/files'), access: typeof import('../src/core/accessClient');
beforeEach(async () => {
  vi.resetModules(); state.userId = `media-${crypto.randomUUID()}`;
  const storage = new Map([['ws_uid', state.userId], ['ws_token', 'fixture-media-token']]);
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  ({ db } = await import('../src/core/db')); await db.open(); media = await import('../src/core/files'); access = await import('../src/core/accessClient');
  await db.files.put({ id: 'file', parentId: 'record', _ts: {} });
});
afterEach(async () => { await db.delete(); vi.unstubAllGlobals(); });

describe('Phase 5 interrupted media and late response guards', () => {
  it.each([1, 3] as const)('queues truthful thumbnail deletion metadata for protocol %s', async protocol => {
    // fake-indexeddb uses setImmediate to settle real IDB transactions. Keep
    // that queue live while controlling only the sync debounce timers.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      access.accessClientStore.set(s => ({ ...s, status: 'offline', manifest: protocol === 1 ? { protocol, userId: state.userId } : {
        protocol, userId: state.userId, workspaceRole: 'member', etag: 'fixture-etag',
        spaces: [{ id: 'space-core', name: 'Core', role: 'editor', exportPolicy: 'members' }],
      } }));
      await db.files.update('file', { thumbId: 'filet' });
      for (const id of ['file', 'filet']) await db.blobs.put({ id, blob: new Blob(['pending camera bytes']), state: 'pending', uploadedChunks: 0 });
      await media.deleteFile('file');
      expect((await db.outbox.toArray()).map(row => row.id)).toEqual(protocol === 1 ? ['file', 'filet'] : ['file']);
      expect((await db.files.get('file'))?.deleted).toBe(true); expect(await db.blobs.count()).toBe(0);
      const { syncStore } = await import('../src/core/sync/engine');
      await vi.waitFor(() => expect(syncStore.get().pending).toBe(protocol === 1 ? 2 : 1));
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });
  it('caches an existing deterministic thumbnail through its main attachment metadata', async () => {
    await db.files.update('file', { thumbId: 'filet' });
    expect(await media.cacheDownloadedFile('filet', new Blob(['thumbnail']), media.captureMediaAccess(), () => true)).toBe(true);
    expect(await db.blobs.get('filet')).toBeDefined();
  });
  it('does not complete an upload using replacement credentials after its last chunk progress write', async () => {
    await db.blobs.put({ id: 'file', blob: new Blob(['upload']), state: 'pending', uploadedChunks: 0 });
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string) => { calls.push(path); return new Response('', { status: 200 }); }));
    const replace = () => { localStorage.setItem('ws_uid', 'account-B'); localStorage.setItem('ws_token', 'account-B-token'); };
    db.blobs.hook('updating', replace);
    try { await expect(media.uploadPendingBlobs()).rejects.toThrow('media_access_changed'); }
    finally { db.blobs.hook('updating').unsubscribe(replace); }
    expect(calls).toEqual(['/api/files/file/chunks/0']); expect((await db.blobs.get('file'))!.state).toBe('pending');
  });
  it('caches a still-authorized mounted response but refuses a cancelled or removed file', async () => {
    const permission = media.captureMediaAccess(), bytes = new Blob(['fixture']);
    expect(await media.cacheDownloadedFile('file', bytes, permission, () => true)).toBe(true);
    await db.blobs.clear();
    expect(await media.cacheDownloadedFile('file', bytes, permission, () => false)).toBe(false);
    await db.files.delete('file');
    expect(await media.cacheDownloadedFile('file', bytes, permission, () => true)).toBe(false);
    expect(await db.blobs.count()).toBe(0);
  });

  it.each(['account', 'session', 'epoch'])('never caches a response after a %s change', async change => {
    const permission = media.captureMediaAccess();
    if (change === 'account') localStorage.setItem('ws_uid', 'another-account');
    if (change === 'session') localStorage.setItem('ws_token', 'replacement-fixture-token');
    if (change === 'epoch') access.lockClientAccess('permissions_changed');
    expect(await media.cacheDownloadedFile('file', new Blob(['private bytes']), permission, () => true)).toBe(false);
    expect(await db.blobs.count()).toBe(0);
  });

  it('rolls back a cache write if access changes during the IndexedDB transaction', async () => {
    const permission = media.captureMediaAccess();
    const invalidate = () => { access.lockClientAccess('permissions_changed'); };
    db.blobs.hook('creating', invalidate);
    expect(await media.cacheDownloadedFile('file', new Blob(['private']), permission, () => true)).toBe(false);
    db.blobs.hook('creating').unsubscribe(invalidate);
    expect(await db.blobs.count()).toBe(0);
  });

  it('stops an upload after account replacement without completing or acknowledging its chunks', async () => {
    await db.blobs.put({ id: 'file', blob: new Blob(['upload']), state: 'pending', uploadedChunks: 0 });
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      calls.push(path); localStorage.setItem('ws_uid', 'account-B'); localStorage.setItem('ws_token', 'account-B-fixture-token');
      return new Response('', { status: 200 });
    }));
    await expect(media.uploadPendingBlobs()).rejects.toThrow('media_access_changed');
    expect(calls).toEqual(['/api/files/file/chunks/0']);
    expect((await db.blobs.get('file'))!).toMatchObject({ state: 'pending', uploadedChunks: 0 });
    expect(localStorage.getItem('ws_token')).toBe('account-B-fixture-token');
  });
});
