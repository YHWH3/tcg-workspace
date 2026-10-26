/** Atomic protocol-3 cache transitions. Network responses never write outside these
 * compare-and-swap transactions. Losing an access grant evicts before backfilling. */
import { COLLECTIONS, isCollection } from '../../../shared/collections';
import { canRead } from '../../../shared/access';
import { scopeParentIds, scopeResolver, type ScopeRecord } from '../../../shared/recordScope';
import { stableJson } from '../../../shared/stablejson';
import { PERMISSION_PROTOCOL, MAX_PULL_LIMIT, type PullRequestV3, type PullResponseV3 } from '../../../shared/protocol';
import type { PulledRecord } from '../../../shared/types';
import type { LocalDB, LocalRow, SyncStageRow } from '../db';
import { rebaseRecord } from './rebase';
import { applyAccessWork, clientAccess, liveSource, planAccessWork, stagedFirst, type AppliedWork } from './pendingWork';
import { FeedStateChanged, freshScan, readState, requestedScans, deferredSpaces, validateAccessManifest, writeState,
  type ClientAccessManifest, type FeedState, type ReadState } from './feedState';
export { ACCESS_MANIFEST_KEY, FEED_STATE_KEY, RECONCILE_REQUIRED_KEY, validateAccessManifest } from './feedState';
export type { ClientAccessManifest } from './feedState';

export interface CacheHooks { assertCurrent?: () => void; beforeCommit?: () => void }
export interface CacheChange { quarantined: number; removedBlobs: string[]; activated: boolean; feed: FeedState }
const emptyWork = (): AppliedWork => ({ quarantined: 0, removedBlobs: [], refreshSpaces: new Set() });
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const audience = (r: { spaceId?: unknown; peerSpaceId?: unknown }, spaces: Set<string>) =>
  (typeof r.spaceId === 'string' && spaces.has(r.spaceId)) || (typeof r.peerSpaceId === 'string' && spaces.has(r.peerSpaceId));
const localAudience = (r: LocalRow, spaces: Set<string>) => audience({ spaceId: r._spaceId, peerSpaceId: r._peerSpaceId }, spaces);
function assertVersion(state: ReadState, version: number) { if ((state.feed?.version ?? 0) !== version) throw new FeedStateChanged(); }
const tables = (store: LocalDB) => store.tables;
const cloneFeed = (feed: FeedState): FeedState => {
  const copy = structuredClone(feed); copy.joining = Object.assign(Object.create(null), copy.joining); return copy;
};

async function dropBytes(store: LocalDB, ids: string[], removed: string[]) {
  for (const fileId of ids) {
    const file = await store.files.get(fileId);
    const keys = [fileId, `${fileId}t`, ...(typeof file?.thumbId === 'string' && file.thumbId === `${fileId}t` ? [file.thumbId] : [])];
    for (const key of new Set(keys)) if (await store.blobs.get(key)) { await store.blobs.delete(key); removed.push(key); }
  }
}
/** Delete exact IDs and links to those IDs. Never sweep arbitrary dangling links:
 * an endpoint may be arriving on the next page of the same valid feed. */
async function evictIds(store: LocalDB, ids: Set<string>, removed: string[]) {
  if (!ids.size) return;
  for (const link of await store.links.toArray()) if (ids.has(String(link.fromId)) || ids.has(String(link.toId))) ids.add(link.id);
  await dropBytes(store, [...ids], removed);
  for (const collection of COLLECTIONS) await store.collection(collection).bulkDelete([...ids]);
}
async function evictSpaces(store: LocalDB, spaces: Set<string>, removed: string[]) {
  const ids = new Set<string>();
  for (const c of COLLECTIONS) for (const row of await store.collection(c).toArray()) if (localAudience(row, spaces)) ids.add(row.id);
  await evictIds(store, ids, removed);
  await store.syncStage.filter(row => audience(row, spaces)).delete();
}
async function addRefresh(store: LocalDB, feed: FeedState, spaces: Iterable<string>) {
  const reset = new Set(spaces);
  for (const space of reset) feed.joining[space] = freshScan(true);
  await store.syncStage.filter(row => row.snapshotId === feed.stageId && audience(row, reset)).delete();
}

/** Must use the version read BEFORE fetching a manifest. An old response from a
 * sibling tab cannot replace a newer manifest, even when both etags are valid. */
export async function installManifest(store: LocalDB, userId: string, value: unknown, expectedVersion: number, hooks: CacheHooks = {}): Promise<CacheChange> {
  const manifest = validateAccessManifest(value, userId);
  return store.transaction('rw', tables(store), async () => {
    hooks.assertCurrent?.(); const state = await readState(store, userId); assertVersion(state, expectedVersion);
    if (state.consistent && state.access?.protocol === PERMISSION_PROTOCOL && state.access.etag === manifest.etag && state.feed) {
      if (stableJson(state.access) !== stableJson(manifest)) throw new Error('manifest_etag_collision');
      return { ...emptyWork(), activated: false, feed: state.feed };
    }
    const previous = state.access?.protocol === PERMISSION_PROTOCOL ? state.access : undefined;
    const legacyUpgrade = !state.consistent || !previous || state.feed?.legacyUpgrade === true;
    const feed: FeedState = state.feed ? cloneFeed(state.feed) : {
      v: 1, userId, version: 0, etag: manifest.etag, cursor: 0, stageId: crypto.randomUUID(), joining: Object.create(null), legacyUpgrade,
    };
    const known = new Set(manifest.spaces.map(s => s.id));
    const removed = new Set(previous?.spaces.filter(s => !known.has(s.id)).map(s => s.id) ?? []);
    for (const s of Object.keys(feed.joining)) if (!known.has(s)) { removed.add(s); delete feed.joining[s]; }
    if (legacyUpgrade && !state.feed?.legacyUpgrade) {
      await store.syncStage.clear(); feed.joining = Object.create(null); feed.stageId = crypto.randomUUID(); feed.cursor = 0;
    }
    for (const s of manifest.spaces) if (legacyUpgrade || !previous?.spaces.some(p => p.id === s.id)) feed.joining[s.id] ??= freshScan();
    feed.legacyUpgrade = legacyUpgrade; feed.etag = manifest.etag; feed.version++;
    // Judge pending work while its old ancestry is still available, but using NEW rights.
    const applied = previous && !legacyUpgrade
      ? await applyAccessWork(store, await planAccessWork(store, userId, manifest, liveSource(store)), feed.version)
      : emptyWork();
    await evictSpaces(store, removed, applied.removedBlobs);
    const refresh = [...applied.refreshSpaces].filter(s => known.has(s) && !feed.joining[s]);
    await addRefresh(store, feed, refresh);
    // The old directory had workspace-wide metadata; it is never an access grant.
    await store.users.clear();
    await store.meta.bulkDelete(['access_snapshot_staging', 'access_snapshot_request']);
    await writeState(store, { manifest, feed, ...(legacyUpgrade ? { required: { userId, reason: 'legacy_upgrade' as const } } : {}) });
    hooks.assertCurrent?.(); hooks.beforeCommit?.();
    return { ...applied, activated: false, feed };
  });
}

function validatePage(manifest: ClientAccessManifest, feed: FeedState, req: PullRequestV3, page: PullResponseV3) {
  if (req.protocol !== PERMISSION_PROTOCOL || req.etag !== feed.etag || req.cursor !== feed.cursor || (stableJson(req.joining) !== stableJson(requestedScans(feed)) || stableJson(req.deferred ?? []) !== stableJson(deferredSpaces(feed)))) throw new Error('invalid_feed_request');
  if (!page || page.protocol !== PERMISSION_PROTOCOL || page.etag !== manifest.etag || !count(page.highWater) || !count(page.cursor)
      || page.cursor < req.cursor || page.cursor > page.highWater || (page.hasMore === false && page.cursor !== page.highWater) || typeof page.hasMore !== 'boolean' || !Array.isArray(page.records) || !Array.isArray(page.evictions)
      || page.records.length + page.evictions.length > req.limit || req.limit > MAX_PULL_LIMIT || !Array.isArray(page.joining) || page.joining.length !== req.joining.length) throw new Error('invalid_feed_page');
  const spaces = new Set(manifest.spaces.map(s => s.id)), seen = new Set<string>();
  for (let i = 0; i < req.joining.length; i++) {
    const q = req.joining[i], p = page.joining[i];
    if (!p || p.space !== q.space || !count(p.after) || p.after < q.after || p.after > page.highWater || !count(p.base)
        || p.base !== (q.base > 0 ? q.base : page.highWater) || (!page.hasMore && p.after !== page.highWater)) throw new Error('invalid_feed_cursor');
  }
  for (const row of page.records) {
    if (!row || !id(row.id) || seen.has(row.id) || !isCollection(row.collection) || !object(row.data) || !object(row.field_ts)
        || Object.values(row.field_ts).some(t => typeof t !== 'number' || !Number.isFinite(t)) || !count(row.seq) || row.seq === 0 || row.seq > page.highWater
        || !id(row.spaceId) || !spaces.has(row.spaceId) || (row.peerSpaceId !== undefined && (!id(row.peerSpaceId) || !spaces.has(row.peerSpaceId)))) throw new Error('invalid_feed_record');
    seen.add(row.id);
    const scans = req.joining.filter(j => j.space === row.spaceId || j.space === row.peerSpaceId);
    const lower = scans.length ? Math.min(...scans.map(s => s.after)) : req.cursor;
    if (row.seq <= lower || row.seq > Math.max(page.cursor, ...page.joining.map(s => s.after))) throw new Error('invalid_feed_record');
  }
  for (const event of page.evictions) if (!event || !id(event.id) || !spaces.has(event.spaceId) || !count(event.rev) || event.rev <= 0 || event.rev > page.highWater
      || event.rev <= (req.joining.find(j => j.space === event.spaceId)?.after ?? req.cursor)) throw new Error('invalid_feed_eviction');
  if (page.hasMore && page.cursor === req.cursor && page.joining.every((j, i) => j.after === req.joining[i].after)) throw new Error('feed_made_no_progress');
}

async function putRow(store: LocalDB, row: PulledRecord, userId: string) {
  const table = store.collection(row.collection as import('../../../shared/collections').Collection), prior = await table.get(row.id);
  if (Number(prior?._serverRev ?? 0) > row.seq) return;
  if (row.collection === 'files' && prior && prior.thumbId !== row.data.thumbId) {
    const old = await store.blobs.get(`${row.id}t`);
    if (old && old.state !== 'pending' && old.state !== 'failed') await store.blobs.delete(old.id);
  }
  const pending = await store.outbox.where('id').equals(row.id).sortBy('autoId');
  const record = rebaseRecord({ data: row.data, field_ts: row.field_ts }, pending);
  await table.put({ ...record.data, id: row.id, _ts: record.field_ts, _serverRev: row.seq, _spaceId: row.spaceId, ...(row.peerSpaceId ? { _peerSpaceId: row.peerSpaceId } : {}) });
  const key = `draft:${userId}:${row.collection}:${row.id}`;
  const draft = (await store.meta.get(key))?.value as import('../drafts').DraftEnvelope | undefined;
  if (draft?.userId === userId && object(draft.values)) {
    const values = { ...draft.values }, baseTs = { ...draft.baseTs };
    for (const field of Object.keys(values)) if (stableJson(values[field]) === stableJson(record.data[field])) { delete values[field]; delete baseTs[field]; }
    if (Object.keys(values).length) await store.meta.put({ key, value: { ...draft, values, baseTs } });
    else await store.meta.delete(key);
  }
}

async function activate(store: LocalDB, manifest: ClientAccessManifest, feed: FeedState): Promise<AppliedWork> {
  const staged = await store.syncStage.where('snapshotId').equals(feed.stageId).toArray();
  const refresh = new Set(Object.keys(feed.joining)), discarded = new Set<string>();
  for (const c of COLLECTIONS) for (const row of await store.collection(c).toArray()) if (feed.legacyUpgrade || localAudience(row, refresh)) discarded.add(row.id);
  const source = stagedFirst(store, feed.stageId, liveSource(store, discarded));
  // Verify the complete staged graph, with settled ancestors included, before publishing it.
  const graph = new Map<string, ScopeRecord>(), pending = [...staged.map(r => r.id)], asked = new Set<string>();
  while (pending.length) {
    const ids = pending.splice(0).filter(i => !asked.has(i)); if (!ids.length) break;
    for (const id of ids) asked.add(id);
    const rows = await source(ids);
    for (const [id, row] of rows) { graph.set(id, { id, collection: row.collection, data: row.data, rootSpaceId: row.spaceId });
      pending.push(...scopeParentIds(graph.get(id)!)); }
    if (asked.size > 100_000) throw new Error('client_scope_budget');
  }
  const resolve = scopeResolver(graph);
  for (const row of staged) {
    const scope = resolve(row.id), peer = scope.readSpaceIds.find(s => s !== scope.spaceId);
    if (scope.spaceId !== row.spaceId || peer !== row.peerSpaceId || scope.serviceOnly || !scope.readSpaceIds.every(s => canRead(clientAccess(manifest, s)))) throw new Error('invalid_authorized_feed');
  }
  const plan = await planAccessWork(store, manifest.userId, manifest, source), applied = await applyAccessWork(store, plan, feed.version);
  const delivered = new Set(staged.map(r => r.id));
  await evictIds(store, new Set([...discarded].filter(id => !delivered.has(id))), applied.removedBlobs);
  for (const row of staged) {
    if (row.collection === 'files') {
      const key = `${row.id}t`, blob = await store.blobs.get(key);
      if (blob && blob.state !== 'pending' && blob.state !== 'failed') { await store.blobs.delete(key); applied.removedBlobs.push(key); }
    }
    await putRow(store, row, manifest.userId);
  }
  await store.syncStage.where('snapshotId').equals(feed.stageId).delete();
  // Accepted offline creations were not part of the server feed. Recreate/rebase them.
  for (const [id, entries] of plan.entries) if (!plan.denied.has(id) && !delivered.has(id)) {
    const row = plan.rows.get(id); if (row?.confirmed) continue;
    const record = rebaseRecord({ data: {}, field_ts: {} }, entries,false);
    await store.collection(entries[0].collection).put({ ...record.data, id, _ts: record.field_ts });
  }
  feed.joining = Object.create(null); feed.legacyUpgrade = false;
  return applied;
}

/** Apply records, eviction facts, staging, quarantine and cursors in ONE transaction. */
export async function applyFeedPage(store: LocalDB, userId: string, expectedFeed: FeedState, req: PullRequestV3, page: PullResponseV3, hooks: CacheHooks = {}): Promise<CacheChange> {
  return store.transaction('rw', tables(store), async () => {
    hooks.assertCurrent?.(); const state = await readState(store, userId); assertVersion(state, expectedFeed.version);
    if (!state.consistent || state.access?.protocol !== PERMISSION_PROTOCOL || !state.feed) throw new Error('invalid_feed_state');
    validatePage(state.access, state.feed, req, page);
    const feed = cloneFeed(state.feed), removedBlobs: string[] = [], evicted = new Set<string>(); feed.version++;
    for (const row of page.records) {
      const joining = feed.joining[row.spaceId!] || (row.peerSpaceId && feed.joining[row.peerSpaceId]);
      if (joining) {
        const prior = await store.syncStage.get([feed.stageId, row.id]);
        if (!prior || prior.seq <= row.seq) await store.syncStage.put({ ...row, collection: row.collection as SyncStageRow['collection'], spaceId: row.spaceId!, snapshotId: feed.stageId });
      } else await putRow(store, row, userId);
    }
    for (const event of page.evictions) {
      const spaces = new Set([event.spaceId]);
      const staged = await store.syncStage.get([feed.stageId, event.id]);
      if (staged && audience(staged, spaces) && staged.seq < event.rev) await store.syncStage.delete([feed.stageId, event.id]);
      for (const c of COLLECTIONS) {
        const row = await store.collection(c).get(event.id);
        if (row && localAudience(row, spaces) && Number(row._serverRev ?? 0) < event.rev) evicted.add(row.id);
      }
    }
    let applied = emptyWork();
    if (evicted.size) {
      const work = await planAccessWork(store, userId, state.access, liveSource(store, evicted));
      for (const id of evicted) if (work.entries.has(id)) work.denied.set(id, 'record_evicted');
      applied = await applyAccessWork(store, work, feed.version);
      await evictIds(store, evicted, removedBlobs);
    }
    if (!Object.keys(feed.joining).length && page.records.some(r => r.collection === 'files' || r.data.deleted === true)) {
      const updated = await applyAccessWork(store, await planAccessWork(store, userId, state.access, liveSource(store)), feed.version);
      applied.quarantined += updated.quarantined; removedBlobs.push(...updated.removedBlobs);
      for (const row of page.records) if (row.collection === 'files' && row.data.deleted === true) await dropBytes(store, [row.id], removedBlobs);
    }
    for (const scan of page.joining) { const current = feed.joining[scan.space];
      current.after = scan.after; current.base = scan.base; current.complete = !page.hasMore && scan.after >= page.cursor; }
    feed.cursor = page.cursor;
    let activated = false;
    if ((Object.keys(feed.joining).length || feed.legacyUpgrade) && Object.values(feed.joining).every(s => s.complete)) {
      const activatedWork = await activate(store, state.access, feed); applied.quarantined += activatedWork.quarantined; removedBlobs.push(...activatedWork.removedBlobs); activated = true;
    }
    await writeState(store, { manifest: state.access, feed, ...(feed.legacyUpgrade ? { required: { userId, reason: 'legacy_upgrade' as const } } : {}) });
    hooks.assertCurrent?.(); hooks.beforeCommit?.();
    return { quarantined: applied.quarantined, removedBlobs: [...new Set([...removedBlobs, ...applied.removedBlobs])], activated, feed };
  });
}

export async function rebackfill(store: LocalDB, userId: string, expectedVersion: number, spaces?: string[], hooks: CacheHooks = {}): Promise<FeedState> {
  return store.transaction('rw', tables(store), async () => {
    hooks.assertCurrent?.(); const state = await readState(store, userId); assertVersion(state, expectedVersion);
    if (!state.consistent || state.access?.protocol !== PERMISSION_PROTOCOL || !state.feed) throw new Error('invalid_feed_state');
    const known = new Set(state.access.spaces.map(s => s.id));
    if (spaces && (!Array.isArray(spaces) || spaces.some(s => !known.has(s)))) throw new Error('invalid_rebackfill');
    const feed = cloneFeed(state.feed); feed.version++;
    if (!spaces) feed.cursor = 0;
    await addRefresh(store, feed, spaces ?? [...known]);
    await writeState(store, { manifest: state.access, feed, ...(state.required ? { required: state.required } : {}) });
    hooks.assertCurrent?.(); hooks.beforeCommit?.(); return feed;
  });
}
