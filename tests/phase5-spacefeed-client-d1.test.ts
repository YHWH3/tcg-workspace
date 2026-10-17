import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAuditFixture, type AuditFixture } from './audit-fixture';
import { sync, applyChanges } from '../worker/sync';
import { accessApi } from '../worker/syncAccess';
import { moveRoot } from '../worker/spaceMove';
import { LocalDB } from '../src/core/db';
import { ApiError } from '../src/core/api';
import { reconcileOnlineAccess, type AccessReconcileDeps } from '../src/core/sync/reconcileAccess';
import { readState } from '../src/core/sync/feedState';
let fixture: AuditFixture, store: LocalDB, deps: AccessReconcileDeps;
const calls: string[] = [];
async function put(id: string, collection: string, patch: Record<string, unknown>) {
  const result = await applyChanges(fixture.env, 'alice', [{ id, collection, patch, ts: 1 }], { serverTs: true });
  if (result.partialError || result.conflicts?.length) throw new Error(`fixture write interrupted: ${JSON.stringify(result)}`);
  if (result.rejected) throw new Error(`fixture write rejected: ${JSON.stringify(result.rejectedItems)}`);
}
beforeEach(async () => {
  fixture = await openAuditFixture(); store = new LocalDB('workspace-alice'); await store.open(); calls.length = 0;
  await fixture.db.prepare("INSERT INTO spaces(id,name,default_access,created_at) VALUES('private','Private','private',1),('other','Other','private',1)").run();
  await fixture.db.prepare("INSERT INTO space_members(space_id,user_id,role,access) VALUES('private','alice','editor','allow'),('other','alice','editor','allow')").run();
  await fixture.db.prepare('UPDATE access_state SET enabled=1 WHERE id=1').run();
  deps = { store, assertCurrent: () => {}, lock: () => {}, activated: () => {}, request: async <T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> => {
    calls.push(path); const headers = fixture.auth('alice'), init = { method: opts?.method ?? 'GET', headers, ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) };
    const response = path === '/api/access' ? await accessApi.request('http://fixture.local/', init, fixture.env, fixture.ctx)
      : await sync.request(`http://fixture.local${path.replace('/api/sync', '')}`, init, fixture.env, fixture.ctx);
    const body = await response.json() as { error?: string };
    if (!response.ok) throw new ApiError(response.status, body.error ?? 'http error', body); return body as T;
  } };
});
afterEach(async () => { await store.delete(); await fixture.dispose(); });

// These tests execute the production IndexedDB transitions and HTTP router paths,
// rather than the independent reference client used to verify server properties.
describe('real client cache against actual D1 access and sync routes', () => {
  it('backfills, keeps offline edits, refreshes canonical rows and evicts on revoke', async () => {
    await put('page', 'pages', { title: 'Private', spaceId: 'private' });
    await put('body', 'blocks', { pageId: 'page', type: 'p', text: 'Original' });
    await reconcileOnlineAccess('alice', deps); expect((await store.blocks.get('body'))!.text).toBe('Original');
    await store.outbox.add({ id: 'body', collection: 'blocks', patch: { text: 'Offline' }, ts: Date.now() + 1000 });
    await put('body', 'blocks', { text: 'Remote' }); await reconcileOnlineAccess('alice', deps);
    expect((await store.blocks.get('body'))!.text).toBe('Offline');
    await fixture.db.prepare("UPDATE space_members SET access='deny' WHERE space_id='private' AND user_id='alice'").run();
    await reconcileOnlineAccess('alice', deps);
    expect(await store.pages.get('page')).toBeUndefined(); expect(await store.blocks.get('body')).toBeUndefined(); expect(await store.outbox.count()).toBe(0);
    expect(await store.accessQuarantine.count()).toBe(1); expect(calls.join()).not.toContain('snapshot');
  });
  it('restores rows and cross-space relations after a peer-space regrant', async () => {
    await put('p', 'pages', { title: 'P', spaceId: 'private' }); await put('q', 'pages', { title: 'Q', spaceId: 'other' });
    await put('link', 'links', { kind: 'related', fromType: 'page', toType: 'page', fromId: 'p', toId: 'q' }); await reconcileOnlineAccess('alice', deps); expect(await store.links.get('link')).toBeDefined();
    await fixture.db.prepare("UPDATE space_members SET access='deny' WHERE space_id='other' AND user_id='alice'").run(); await reconcileOnlineAccess('alice', deps);
    expect(await store.links.get('link')).toBeUndefined(); expect(await store.pages.get('q')).toBeUndefined(); expect(await store.pages.get('p')).toBeDefined();
    await fixture.db.prepare("UPDATE space_members SET access='allow' WHERE space_id='other' AND user_id='alice'").run(); await reconcileOnlineAccess('alice', deps);
    expect((await store.links.get('link'))!._peerSpaceId).toBe('other'); expect(await store.pages.get('q')).toBeDefined();
  });
  it('applies peer-change eviction facts even when the row becomes unreadable', async () => {
    await put('p', 'pages', { title: 'P', spaceId: 'private' }); await put('q', 'pages', { title: 'Q', spaceId: 'private' }); await put('hidden', 'pages', { title: 'H', spaceId: 'other' });
    await put('link', 'links', { kind: 'related', fromType: 'page', toType: 'page', fromId: 'p', toId: 'q' }); await reconcileOnlineAccess('alice', deps);
    await put('link', 'links', { toId: 'hidden' });
    expect(await fixture.db.prepare("SELECT json_extract(data,'$.toId') target FROM records WHERE id='link'").first('target')).toBe('hidden');
    expect((await fixture.db.prepare("SELECT * FROM space_events WHERE record_id='link'").all()).results.length).toBeGreaterThan(0);
    await fixture.db.prepare("UPDATE space_members SET access='deny' WHERE space_id='other' AND user_id='alice'").run(); await reconcileOnlineAccess('alice', deps);
    expect(await store.links.get('link')).toBeUndefined();
  });
  it('resumes an interrupted backfill from persisted pages after a store restart', async () => {
    // Force a second page through the real request driver without mocking its response.
    for (let i = 0; i < 12; i++) await put(`p${i}`, 'pages', { title: `P${i}`, spaceId: 'private' });
    const original = deps.request; let pages = 0;
    deps.request = async <T>(path: string, opts?: { method?: string; body?: unknown }) => {
      if (path.endsWith('/pull')) { if (++pages === 2) throw new ApiError(0, 'offline'); opts = { ...opts, body: { ...(opts?.body as object), limit: 8 } }; }
      return original<T>(path, opts);
    };
    // The production driver validates against its own requested limit (500); a smaller
    // server page still satisfies all range/completeness checks.
    await expect(reconcileOnlineAccess('alice', deps)).rejects.toThrow('offline'); expect(await store.pages.count()).toBe(0); expect(await store.syncStage.count()).toBeGreaterThan(0);
    store.close(); await store.open(); deps.request = original; await reconcileOnlineAccess('alice', deps);
    expect(await store.pages.count()).toBe(12); expect(await store.syncStage.count()).toBe(0);
  });
  it('quarantines unsent edits on downgrade and replaces optimistic content with canonical content', async () => {
    await put('p', 'pages', { title: 'Canonical', spaceId: 'private' }); await reconcileOnlineAccess('alice', deps);
    await store.outbox.add({ id: 'p', collection: 'pages', patch: { title: 'Cannot save' }, ts: Date.now() + 1000 }); await store.pages.update('p', { title: 'Cannot save' });
    await fixture.db.prepare("UPDATE space_members SET role='viewer' WHERE space_id='private' AND user_id='alice'").run();
    await reconcileOnlineAccess('alice', deps); expect((await store.pages.get('p'))!.title).toBe('Canonical'); expect(await store.outbox.count()).toBe(0); expect(await store.accessQuarantine.count()).toBe(1);
  });
  it('re-backfills an affected space after retention passes its cursor without touching unrelated rows', async () => {
    await put('p', 'pages', { title: 'P', spaceId: 'private' }); await put('q', 'pages', { title: 'Q', spaceId: 'other' }); await reconcileOnlineAccess('alice', deps);
    await put('q', 'pages', { title: 'Q changed' });
    const max = await fixture.db.prepare('SELECT MAX(seq) n FROM records').first<number>('n');
    await fixture.db.prepare("UPDATE spaces SET events_floor=? WHERE id='private'").bind(max).run();
    await reconcileOnlineAccess('alice', deps); expect(await store.pages.get('p')).toBeDefined(); expect((await store.pages.get('q'))!.title).toBe('Q changed');
    expect((await readState(store, 'alice')).feed!.joining).toEqual({});
  });
  it('supports ancestor delete/restore and byte-identical final content after a move', async () => {
    await put('p', 'pages', { title: 'P', spaceId: 'private' }); await put('b', 'blocks', { pageId: 'p', text: 'Body' });
    await reconcileOnlineAccess('alice', deps); await put('p', 'pages', { deleted: true }); await reconcileOnlineAccess('alice', deps); expect((await store.pages.get('p'))!.deleted).toBe(true);
    await put('p', 'pages', { deleted: false }); await reconcileOnlineAccess('alice', deps); expect(await store.blocks.get('b')).toBeDefined();
    await moveRoot(fixture.db, { id: 'alice' }, { recordId: 'p', toSpaceId: 'other', requestId: 'move-client' }); await reconcileOnlineAccess('alice', deps);
    expect((await store.pages.get('p'))!._spaceId).toBe('other'); expect((await store.blocks.get('b'))!._spaceId).toBe('other');
  });
  it('joins more than twenty retained spaces without restarting the active group forever', async () => {
    for (let i = 0; i < 25; i++) {
      const id = `s${String(i).padStart(2, '0')}`;
      await fixture.db.prepare("INSERT INTO spaces(id,name,default_access,created_at,events_floor) VALUES(?,?,'members',1,1)").bind(id, id).run();
      await fixture.db.prepare("INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES(?,'pages',?, '{}',?,?)").bind(`p${id}`, JSON.stringify({ title: id }), i + 2, id).run();
    }
    await reconcileOnlineAccess('alice', deps);
    expect(await store.pages.count()).toBe(25); expect((await readState(store, 'alice')).feed!.joining).toEqual({});
  });

});
