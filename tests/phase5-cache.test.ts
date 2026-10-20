import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDB } from '../src/core/db';
import { applyFeedPage, installManifest, rebackfill } from '../src/core/sync/accessCache';
import { ACCESS_MANIFEST_KEY, FEED_STATE_KEY, RECONCILE_REQUIRED_KEY } from '../src/core/sync/feedState';
import { feedOf, manifestFor, page, record, replyFor, requestFor } from './feed-cache-fixture';
import type { ManifestV3 } from '../shared/protocol';
let store: LocalDB, userId: string, manifest: ManifestV3;
beforeEach(async () => { userId = `cache-${crypto.randomUUID()}`; store = new LocalDB(`workspace-${userId}`); await store.open(); manifest = manifestFor(userId); });
afterEach(async () => { await store.delete(); });
const init = () => installManifest(store, userId, manifest, 0);
const fileRows = () => [record('a'), record('body', 'blocks', { pageId: 'a', type: 'image', fileId: 'file' }), record('file', 'files', { parentType: 'block', parentId: 'body', thumbId: 'filet' })];

describe('protocol-3 atomic account cache', () => {
  it('stages and resumes after store reopen; no partially populated space is published', async () => {
    await store.pages.put({ id: 'prior', title: 'Legacy', _ts: {} }); await init();
    await page(store, userId, [record('a')], true, 5);
    expect(await store.pages.get('a')).toBeUndefined(); expect(await store.meta.get(RECONCILE_REQUIRED_KEY)).toBeDefined();
    store.close(); await store.open(); expect((await feedOf(store, userId)).joining['space-core'].after).toBe(5);
    await page(store, userId, [record('b', 'pages', { title: 'B' }, 6)]);
    expect((await store.pages.toArray()).map(r => r.id).sort()).toEqual(['a', 'b']); expect(await store.syncStage.count()).toBe(0); expect(await store.meta.get(RECONCILE_REQUIRED_KEY)).toBeUndefined();
  });
  it('rejects a delayed manifest or response after another tab advances the version', async () => {
    const change = await init(), req = requestFor(change.feed), response = replyFor(req, [record('a')]);
    await page(store, userId, [record('newer')]);
    await expect(applyFeedPage(store, userId, change.feed, req, response)).rejects.toThrow('feed_state_changed');
    await expect(installManifest(store, userId, { ...manifest, etag: 'older-manifest' }, change.feed.version)).rejects.toThrow('feed_state_changed');
    expect(await store.pages.get('a')).toBeUndefined(); expect(await store.pages.get('newer')).toBeDefined();
  });
  it('quarantines revoked outbox, drafts and pending bytes without exposing held payloads', async () => {
    await store.pages.put({ id: 'secret', title: 'Secret', _ts: {}, _spaceId: 'private', _serverRev: 1 });
    await store.files.put({ id: 'attachment', parentType: 'block', parentId: 'missing', _ts: {}, _spaceId: 'private', _serverRev: 1 });
    await store.outbox.add({ id: 'secret', collection: 'pages', patch: { title: 'Offline confidential edit' }, ts: 100 });
    await store.meta.put({ key: `draft:${userId}:pages:secret`, value: { id: 'secret', values: { title: 'Private draft' } } });
    await store.blobs.put({ id: 'attachment', blob: new Blob(['private']), state: 'pending', uploadedChunks: 0 });
    await init(); await page(store, userId, [record('visible')]);
    expect(await store.pages.get('secret')).toBeUndefined(); expect(await store.files.count()).toBe(0); expect(await store.outbox.count()).toBe(0); expect(await store.blobs.count()).toBe(0);
    expect((await store.accessQuarantine.toArray()).map(r => r.kind).sort()).toEqual(['blob', 'draft', 'outbox']);
    expect(JSON.stringify(await store.accessQuarantineInfo.toArray())).not.toContain('confidential');
    store.close(); await store.open(); expect(await store.accessQuarantine.count()).toBe(3);
  });
  it('rebases allowed unsent edits and local child creations with pending media', async () => {
    await store.outbox.bulkAdd([{ id: 'a', collection: 'pages', patch: { title: 'Local' }, ts: 100 },
      { id: 'new', collection: 'pages', patch: { title: 'Offline', spaceId: 'space-core' }, ts: 100, createIntent: true },
      { id: 'child', collection: 'blocks', patch: { pageId: 'new', text: 'Body' }, ts: 100, createIntent: true }]);
    await store.blobs.put({ id: 'filet', blob: new Blob(['thumb']), state: 'pending', uploadedChunks: 0 });
    await init(); await page(store, userId, fileRows());
    expect((await store.pages.get('a'))!.title).toBe('Local'); expect((await store.pages.get('a'))!._serverRev).toBe(1);
    expect((await store.pages.get('new'))!.title).toBe('Offline'); expect(await store.blocks.get('child')).toBeDefined();
    expect(await store.outbox.count()).toBe(3); expect(await store.blobs.get('filet')).toBeDefined(); expect(await store.accessQuarantine.count()).toBe(0);
  });
  it('refreshes confirmed content after a downgrade and quarantines unsent edits', async () => {
    await init(); await page(store, userId, fileRows());
    await store.outbox.add({ id: 'a', collection: 'pages', patch: { title: 'No longer allowed' }, ts: 100 }); await store.pages.update('a', { title: 'No longer allowed' });
    await store.meta.put({ key: `draft:${userId}:pages:a`, value: { id: 'a', values: { title: 'Draft' } } });
    await store.blobs.put({ id: 'file', blob: new Blob(['pending']), state: 'pending', uploadedChunks: 0 });
    manifest = { ...manifest, etag: 'viewer-etag', spaces: [{ ...manifest.spaces[0], role: 'viewer' }] };
    await installManifest(store, userId, manifest, (await feedOf(store, userId)).version);
    expect(await store.outbox.count()).toBe(0); expect((await feedOf(store, userId)).joining['space-core'].refresh).toBe(true);
    await page(store, userId, fileRows()); expect((await store.pages.get('a'))!.title).toBe('Authorized'); expect(await store.accessQuarantine.count()).toBe(3);
  });
  it('preserves commenters own edits without granting ordinary editing', async () => {
    manifest.spaces[0].role = 'commenter';
    await store.outbox.bulkAdd([{ id: 'a', collection: 'pages', patch: { title: 'Denied' }, ts: 100 }, { id: 'comment', collection: 'comments', patch: { body: 'Edited' }, ts: 100 }]);
    await init(); await page(store, userId, [record('a'), record('comment', 'comments', { targetType: 'page', targetId: 'a', authorId: userId, body: 'Original' })]);
    expect((await store.pages.get('a'))!.title).toBe('Authorized'); expect((await store.comments.get('comment'))!.body).toBe('Edited');
    expect((await store.outbox.toArray()).map(e => e.id)).toEqual(['comment']);
  });
  it('evicts both staged and live rows when a refreshing space is revoked', async () => {
    await init(); await page(store, userId, [record('a')]);
    await rebackfill(store, userId, (await feedOf(store, userId)).version, ['space-core']);
    await page(store, userId, [record('b', 'pages', { title: 'Staged' }, 2)], true, 5);
    await installManifest(store, userId, { ...manifest, spaces: [], etag: 'no-spaces' }, (await feedOf(store, userId)).version);
    expect(await store.pages.count()).toBe(0); expect(await store.syncStage.count()).toBe(0);
  });
  it('does not sweep a legitimate link whose endpoint arrives on the next page', async () => {
    await init(); await page(store, userId, [record('a'), record('b')]);
    const feed = await feedOf(store, userId), req = requestFor(feed), response = replyFor(req);
    Object.assign(response, { highWater: 103, cursor: 101, hasMore: true, records: [record('link', 'links', { fromId: 'a', toId: 'later', kind: 'related' }, 101)] });
    await applyFeedPage(store, userId, feed, req, response); expect(await store.links.get('link')).toBeDefined();
  });
  it('rolls back rows, quarantine and cursor on interruption, and retries without duplication', async () => {
    await init(); const feed = await feedOf(store, userId), req = requestFor(feed), response = replyFor(req, [record('a')]);
    await expect(applyFeedPage(store, userId, feed, req, response, { beforeCommit: () => { throw new Error('crash'); } })).rejects.toThrow('crash');
    expect(await store.pages.count()).toBe(0); expect(await store.syncStage.count()).toBe(0); expect((await feedOf(store, userId)).version).toBe(feed.version);
    await applyFeedPage(store, userId, feed, req, response); expect(await store.pages.count()).toBe(1);
    await expect(applyFeedPage(store, userId, feed, req, response)).rejects.toThrow('feed_state_changed');
  });
  it.each(['page', 'record', 'duplicate', 'space', 'cursor', 'exhausted'])('rejects malformed %s evidence without advancing', async kind => {
    await init(); const feed = await feedOf(store, userId), req = requestFor(feed), response = replyFor(req, [record('a')]);
    if (kind === 'page') response.etag = 'wrong';
    if (kind === 'record') response.records[0].field_ts = { title: NaN };
    if (kind === 'duplicate') response.records.push(response.records[0]);
    if (kind === 'space') response.records[0].spaceId = 'ungranted';
    if (kind === 'cursor') response.joining[0].after = -1;
    if (kind === 'exhausted') response.cursor = 5;
    await expect(applyFeedPage(store, userId, feed, req, response)).rejects.toThrow(); expect((await feedOf(store, userId)).version).toBe(feed.version);
  });
  it('refuses invalid ancestry at activation without publishing the staged page', async () => {
    await init(); await expect(page(store, userId, [record('orphan', 'blocks', { pageId: 'missing' })])).rejects.toThrow('parent_unavailable'); expect(await store.blocks.count()).toBe(0);
  });
  it('preserves exact account binding', async () => { await expect(installManifest(store, 'wrong', manifest, 0)).rejects.toThrow(); });
  it('persists feed metadata without creating a legacy snapshot request', async () => {
    await init(); const feed = await feedOf(store, userId);
    // State carries no row-count capacity; a server backfill may continue as long as necessary.
    expect(feed).not.toHaveProperty('count'); expect(await store.meta.get('access_snapshot_staging')).toBeUndefined();
    expect(await store.meta.get(ACCESS_MANIFEST_KEY)).toBeDefined(); expect(await store.meta.get(FEED_STATE_KEY)).toBeDefined();
  });
  it('invalidates cached auxiliary bytes at activation but preserves pending owned bytes', async () => {
    await store.blobs.put({ id: 'filet', blob: new Blob(['cached']), state: 'cached', uploadedChunks: 0 });
    await init(); await page(store, userId, fileRows()); expect(await store.blobs.get('filet')).toBeUndefined();
    await store.blobs.put({ id: 'filet', blob: new Blob(['pending']), state: 'pending', uploadedChunks: 0 });
    await rebackfill(store, userId, (await feedOf(store, userId)).version, ['space-core']); await page(store, userId, fileRows()); expect(await store.blobs.get('filet')).toBeDefined();
  });
  it('keeps a newer revision when an older eviction fact arrives on the same page', async () => {
    await init(); await page(store, userId, [record('a')]); const feed = await feedOf(store, userId), req = requestFor(feed), response = replyFor(req);
    Object.assign(response, { highWater: 102, cursor: 102, records: [record('a', 'pages', { title: 'Moved back' }, 102)], evictions: [{ id: 'a', spaceId: 'space-core', rev: 101 }] });
    await applyFeedPage(store, userId, feed, req, response); expect((await store.pages.get('a'))!.title).toBe('Moved back');
  });
  it('activates more than twenty joining spaces as one group without publishing early spaces', async () => {
    manifest.spaces = Array.from({ length: 25 }, (_, i) => ({ ...manifest.spaces[0], id: `s${i}` })); await init();
    for (let i = 0; i < 2; i++) {
      const feed = await feedOf(store, userId), req = requestFor(feed), response = replyFor(req, req.joining.map(j => record(j.space, 'pages', { title: j.space }, 1, j.space)));
      expect(req.joining.length).toBeLessThanOrEqual(20); await applyFeedPage(store, userId, feed, req, response);
      if (!i) expect(await store.pages.count()).toBe(0);
    }
    expect(await store.pages.count()).toBe(25); expect((await feedOf(store, userId)).joining).toEqual({});
  });
  it('upgrades a protocol-2 cache atomically, without treating it as legacy offline access', async () => {
    await store.meta.put({ key: ACCESS_MANIFEST_KEY, value: { protocol: 2, userId, generation: 10 } }); await store.pages.put({ id: 'old', title: 'Old private', _ts: {} });
    await init(); expect(await store.meta.get(RECONCILE_REQUIRED_KEY)).toBeDefined();
    await page(store, userId, [record('a')], true, 5); expect(await store.pages.get('old')).toBeDefined(); expect(await store.pages.get('a')).toBeUndefined();
    await page(store, userId, []); expect(await store.pages.get('old')).toBeUndefined(); expect(await store.pages.get('a')).toBeDefined(); expect(await store.meta.get(RECONCILE_REQUIRED_KEY)).toBeUndefined();
  });

  it('treats space IDs as data, including object-property names', async () => {
    manifest.spaces = ['__proto__', 'constructor'].map(id => ({ ...manifest.spaces[0], id })); await init();
    await page(store, userId, manifest.spaces.map(s => record(s.id, 'pages', { title: s.id }, 1, s.id)));
    expect((await store.pages.toArray()).map(r => r.id).sort()).toEqual(['__proto__', 'constructor']);
  });

  it('quarantines pending binary bytes after a remote explicit file tombstone', async () => {
    await init(); await page(store, userId, fileRows());
    for (const id of ['file', 'filet']) await store.blobs.put({ id, blob: new Blob(['unsent bytes']), state: 'pending', uploadedChunks: 0 });
    const feed = await feedOf(store, userId), req = requestFor(feed), response = replyFor(req);
    Object.assign(response, { highWater: 101, cursor: 101, records: [record('file', 'files', { parentType: 'block', parentId: 'body', thumbId: 'filet', deleted: true }, 101)] });
    await applyFeedPage(store, userId, feed, req, response);
    expect(await store.blobs.count()).toBe(0); expect((await store.accessQuarantine.toArray()).map(r => r.kind)).toEqual(['blob', 'blob']);
  });

});
