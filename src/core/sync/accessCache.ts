/** Atomic account-bound snapshot staging. No network or UI grants live here.
 * This module is integrated by the access reconciliation coordinator. */
import { COLLECTIONS, isCollection } from '../../../shared/collections';
import { canComment, canEdit, canEditComment, canRead, isSpaceRole, isWorkspaceRole, type SpaceAccess, type SpaceRole, type WorkspaceRole } from '../../../shared/access';
import { scopeParentIds, scopeResolver, ScopeError, type ScopeRecord } from '../../../shared/recordScope';
import { stableJson } from '../../../shared/stablejson';
import { thumbnailParentId } from '../../../shared/fileOwnership';
import type { PulledRecord } from '../../../shared/types';
import type { AccessQuarantineRow, LocalDB, LocalRow, OutboxEntry, SyncStageRow } from '../db';
import { rebaseRecord } from './rebase';

export interface ClientAccessManifest {
  protocol: 2; userId: string; workspaceRole: WorkspaceRole; generation: number;
  spaces: { id: string; name: string; role: SpaceRole; exportPolicy: 'members' | 'disabled' }[];
}
export interface SnapshotDescriptor { snapshotId: string; generation: number; cutoff: number; cursor: string; expiresAt: number }
interface StagingSession extends SnapshotDescriptor { userId: string; nextCursor: string | null; done: boolean; count: number; lastRequestCursor?: string; lastPageDigest?: string }
export interface SnapshotPage { snapshotId: string; generation: number; cutoff: number; records: PulledRecord[]; cursor: string | null; done: boolean }
export const ACCESS_MANIFEST_KEY = 'access_manifest';
export const SNAPSHOT_KEY = 'access_snapshot_staging';
export const RECONCILE_REQUIRED_KEY = 'access_reconciliation_required';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;
function account(store: LocalDB, userId: string) {
  if (!id(userId) || store.name !== `workspace-${userId}`) throw new Error('account_cache_mismatch');
}
export function validateAccessManifest(value: unknown, userId: string): ClientAccessManifest {
  if (!object(value) || value.protocol !== 2 || value.userId !== userId || !isWorkspaceRole(value.workspaceRole)
      || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1 || !Array.isArray(value.spaces) || value.spaces.length > 500) throw new Error('invalid_access_manifest');
  const ids = new Set<string>();
  for (const space of value.spaces) {
    if (!object(space) || !id(space.id) || ids.has(space.id) || typeof space.name !== 'string' || space.name.length > 120 || !isSpaceRole(space.role)
        || (space.exportPolicy !== 'members' && space.exportPolicy !== 'disabled') || (value.workspaceRole === 'guest' && ['owner', 'admin'].includes(space.role))) throw new Error('invalid_access_manifest');
    ids.add(space.id);
  }
  return value as unknown as ClientAccessManifest;
}
function sessionValid(session: StagingSession, userId: string, descriptor: SnapshotDescriptor) {
  if (session.userId !== userId || session.snapshotId !== descriptor.snapshotId || session.generation !== descriptor.generation || session.cutoff !== descriptor.cutoff) throw new Error('snapshot_session_mismatch');
}

/** Must be called within the same metadata transaction as the following
 * mutation. A delayed HTTP response in one tab cannot roll back a generation
 * already installed OR discovered by another tab sharing this database. */
export async function assertCacheGeneration(store: LocalDB, userId: string, generation: number): Promise<void> {
  const [installed, required] = await store.meta.bulkGet([ACCESS_MANIFEST_KEY, RECONCILE_REQUIRED_KEY]);
  if (installed?.value) {
    const value = installed.value as { protocol?: number; userId?: string; generation?: number };
    if (value.userId !== userId) throw new Error('account_cache_mismatch');
    if (value.protocol === 2 && validateAccessManifest(value, userId).generation > generation) throw new Error('stale_cache_generation');
  }
  if (required) {
    const value = required.value as { userId?: string; generation?: number } | null;
    if (!value || value.userId !== userId || !Number.isSafeInteger(value.generation)) throw new Error('invalid_reconciliation_marker');
    if (value.generation! > generation) throw new Error('stale_cache_generation');
  }
}

export async function beginCacheSnapshot(store: LocalDB, userId: string, descriptor: SnapshotDescriptor): Promise<void> {
  account(store, userId);
  if (!id(descriptor.snapshotId) || !Number.isSafeInteger(descriptor.generation) || descriptor.generation < 1
      || !Number.isSafeInteger(descriptor.cutoff) || descriptor.cutoff < 0 || typeof descriptor.cursor !== 'string' || !descriptor.cursor
      || descriptor.expiresAt <= Date.now()) throw new Error('invalid_snapshot_descriptor');
  await store.transaction('rw', store.syncStage, store.meta, async () => {
    await assertCacheGeneration(store, userId, descriptor.generation);
    const prior = (await store.meta.get(SNAPSHOT_KEY))?.value as StagingSession | undefined;
    if (prior && prior.generation > descriptor.generation) throw new Error('stale_cache_generation');
    if (prior?.snapshotId === descriptor.snapshotId) { sessionValid(prior, userId, descriptor); return; }
    await store.syncStage.clear();
    const session: StagingSession = { ...descriptor, userId, nextCursor: descriptor.cursor, done: false, count: 0 };
    await store.meta.put({ key: SNAPSHOT_KEY, value: session });
  });
}

export async function stageCachePage(store: LocalDB, userId: string, descriptor: SnapshotDescriptor, requestCursor: string, page: SnapshotPage): Promise<void> {
  account(store, userId);
  if (page.snapshotId !== descriptor.snapshotId || page.generation !== descriptor.generation || page.cutoff !== descriptor.cutoff
      || !Array.isArray(page.records) || page.records.length > 500 || typeof page.done !== 'boolean'
      || (page.done ? page.cursor !== null : typeof page.cursor !== 'string' || !page.cursor || page.cursor === requestCursor)) throw new Error('invalid_snapshot_page');
  const ids = new Set<string>(), rows: SyncStageRow[] = [];
  for (const record of page.records) {
    if (!id(record.id) || ids.has(record.id) || !isCollection(record.collection) || !object(record.data) || !object(record.field_ts)
        || Object.values(record.field_ts).some(v => typeof v !== 'number' || !Number.isFinite(v))
        || !id(record.spaceId) || !Number.isSafeInteger(record.seq) || record.seq < 1 || record.seq > descriptor.cutoff) throw new Error('invalid_snapshot_record');
    ids.add(record.id); rows.push({ ...record, snapshotId: descriptor.snapshotId, collection: record.collection, spaceId: record.spaceId });
  }
  const lastPageDigest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(page))))].map(b => b.toString(16).padStart(2, '0')).join('');
  await store.transaction('rw', store.syncStage, store.meta, async () => {
    await assertCacheGeneration(store, userId, descriptor.generation);
    const session = (await store.meta.get(SNAPSHOT_KEY))?.value as StagingSession | undefined;
    if (!session) throw new Error('snapshot_session_missing');
    sessionValid(session, userId, descriptor);
    if (session.lastRequestCursor === requestCursor) {
      if (session.lastPageDigest !== lastPageDigest) throw new Error('snapshot_replay_mismatch');
      return; // exact committed-page response retry
    }
    if (session.done || session.nextCursor !== requestCursor) throw new Error('snapshot_cursor_mismatch');
    if (session.count + rows.length > 20_000) throw new Error('snapshot_capacity');
    if ((await store.syncStage.bulkGet(rows.map(r => [descriptor.snapshotId, r.id]))).some(Boolean)) throw new Error('duplicate_snapshot_record');
    await store.syncStage.bulkPut(rows.map(r => ({ ...r, snapshotId: descriptor.snapshotId })));
    await store.meta.put({ key: SNAPSHOT_KEY, value: { ...session, nextCursor: page.cursor, done: page.done, count: session.count + rows.length, lastRequestCursor: requestCursor, lastPageDigest } });
  });
}

function clientAccess(manifest: ClientAccessManifest, spaceId: string): SpaceAccess {
  const space = manifest.spaces.find(s => s.id === spaceId);
  return { principal: { id: manifest.userId, workspaceRole: manifest.workspaceRole, disabledAt: null },
    space: space ? { id: space.id, defaultAccess: 'private', exportPolicy: space.exportPolicy, deletedAt: null } : null,
    membership: space ? { role: space.role, access: 'allow' } : null };
}

/** Replaces synchronized rows and cursor/epoch in ONE IndexedDB transaction.
 * Sensitive refused work is retained in a non-rendered, non-exported account
 * quarantine. Recovery/export stays disabled pending the owner privacy policy. */
export async function activateCacheSnapshot(store: LocalDB, manifest: ClientAccessManifest, descriptor: SnapshotDescriptor): Promise<{ quarantined: number; removedBlobs: string[] }> {
  account(store, manifest.userId);
  validateAccessManifest(manifest, manifest.userId);
  if (manifest.protocol !== 2 || manifest.generation !== descriptor.generation) throw new Error('snapshot_manifest_mismatch');
  return store.transaction('rw', store.tables, async () => {
    await assertCacheGeneration(store, manifest.userId, manifest.generation);
    const session = (await store.meta.get(SNAPSHOT_KEY))?.value as StagingSession | undefined;
    if (!session) throw new Error('snapshot_session_missing');
    sessionValid(session, manifest.userId, descriptor);
    if (!session.done || session.expiresAt <= Date.now()) throw new Error('snapshot_incomplete_or_expired');
    const staged = await store.syncStage.where('snapshotId').equals(descriptor.snapshotId).toArray();
    if (staged.length !== session.count) throw new Error('snapshot_incomplete');
    const canonical = new Map(staged.map(r => [r.id, r])), proposed = new Map<string, ScopeRecord>(staged.map(r => [r.id, { id: r.id, collection: r.collection, data: r.data, rootSpaceId: r.spaceId }]));
    // Treat malformed/incomplete server snapshots as failures, never partial
    // cache success. All current ancestors/endpoints must be present and agree
    // with the server-resolved scope before any retained work is overlaid.
    const canonicalScope = scopeResolver(proposed);
    for (const row of staged) {
      const scope = canonicalScope(row.id);
      if (scope.spaceId !== row.spaceId || scope.serviceOnly || scope.ancestorDeleted || !scope.readSpaceIds.every(s => canRead(clientAccess(manifest, s)))) throw new Error('invalid_authorized_snapshot');
    }
    const pending = await store.outbox.orderBy('autoId').toArray(), byId = new Map<string, OutboxEntry[]>(), denied = new Map<string, string>();
    for (const entry of pending) byId.set(entry.id, [...(byId.get(entry.id) ?? []), entry]);
    for (const [recordId, entries] of byId) {
      const base = canonical.get(recordId), first = entries[0];
      if (!base && !entries.some(e => e.createIntent)) { denied.set(recordId, 'access_revoked_or_unconfirmed_creation'); continue; }
      if (entries.some(e => e.collection !== first.collection || e.state === 'rejected')) { denied.set(recordId, 'access_review_required'); continue; }
      const rebased = rebaseRecord({ data: base?.data ?? {}, field_ts: base?.field_ts ?? {} }, entries);
      proposed.set(recordId, { id: recordId, collection: first.collection, data: rebased.data,
        rootSpaceId: base?.spaceId ?? (typeof rebased.data.spaceId === 'string' ? rebased.data.spaceId : 'space-core') });
    }
    const resolve = scopeResolver(proposed);
    for (const [recordId, entries] of byId) if (!denied.has(recordId)) {
      const record = proposed.get(recordId)!;
      try {
        const scope = resolve(recordId), access = clientAccess(manifest, scope.spaceId);
        const readable = !scope.ancestorDeleted && !scope.serviceOnly && scope.readSpaceIds.every(s => canRead(clientAccess(manifest, s)));
        const allowed = record.collection === 'comments'
          ? (canonical.has(recordId) ? canEditComment(access, String(canonical.get(recordId)!.data.authorId ?? '')) : canComment(access) && record.data.authorId === manifest.userId)
          : canEdit(access);
        if (!readable || !allowed) denied.set(recordId, 'access_revoked_or_read_only');
        if (canonical.has(recordId) && scope.spaceId !== canonical.get(recordId)!.spaceId) denied.set(recordId, 'explicit_move_required');
        if (entries.some(e => e.collection !== record.collection)) denied.set(recordId, 'invalid_outbox_entry');
      } catch (error) { if (!(error instanceof ScopeError)) throw error; denied.set(recordId, 'parent_unavailable'); }
    }
    let changed = true;
    const parentPlanRequired = (parentId: string) => {
      if (!denied.has(parentId)) return false;
      const prior = canonical.get(parentId), candidate = proposed.get(parentId);
      if (!prior || !candidate) return true;
      const previous = { id: prior.id, collection: prior.collection, data: prior.data, rootSpaceId: prior.spaceId };
      return candidate.rootSpaceId !== prior.spaceId || candidate.data.deleted !== prior.data.deleted
        || stableJson(scopeParentIds(candidate)) !== stableJson(scopeParentIds(previous));
    };
    while (changed) {
      changed = false;
      for (const [recordId, entries] of byId) if (!denied.has(recordId)) {
        const record = proposed.get(recordId)!;
        if (scopeParentIds(record).some(parentPlanRequired)) { denied.set(recordId, 'parent_access_rejected'); changed = true; }
        if (!entries.length) throw new Error('invalid_outbox_entry');
      }
    }
    const now = Date.now(), quarantine: AccessQuarantineRow[] = [];
    const retain = (kind: AccessQuarantineRow['kind'], recordId: string, payload: unknown, reason: string) => quarantine.push({ id: recordId, kind, payload, reason, generation: manifest.generation, quarantinedAt: now });
    for (const entry of pending) if (denied.has(entry.id)) retain('outbox', entry.id, entry, denied.get(entry.id)!);
    await store.outbox.bulkDelete(pending.filter(e => denied.has(e.id)).map(e => e.autoId!));
    for (const collection of COLLECTIONS) await store.collection(collection).clear();
    for (const row of staged) {
      const changes = denied.has(row.id) ? [] : byId.get(row.id) ?? [];
      const record = rebaseRecord({ data: row.data, field_ts: row.field_ts }, changes);
      await store.collection(row.collection).put({ ...record.data, id: row.id, _ts: record.field_ts, _serverRev: row.seq, _spaceId: row.spaceId });
    }
    for (const [recordId, entries] of byId) if (!denied.has(recordId) && !canonical.has(recordId)) {
      const record = proposed.get(recordId)!, local = rebaseRecord({ data: {}, field_ts: {} }, entries);
      await store.collection(entries[0].collection).put({ ...local.data, id: recordId, _ts: local.field_ts, _spaceId: resolve(recordId).spaceId } as LocalRow);
      if (!record) throw new Error('pending_record_missing');
    }
    const visible = new Set([...canonical.keys(), ...[...byId.keys()].filter(recordId => !denied.has(recordId))]);
    const metadata = await store.meta.toArray();
    for (const row of metadata) if (row.key.startsWith(`draft:${manifest.userId}:`)) {
      const draft = row.value as { id?: string };
      const record = draft.id ? proposed.get(draft.id) : undefined;
      let editable = false;
      try {
        if (record) {
          const access = clientAccess(manifest, resolve(record.id).spaceId);
          editable = record.collection === 'comments' ? canEditComment(access, String(record.data.authorId ?? '')) : canEdit(access);
        }
      } catch (error) { if (!(error instanceof ScopeError)) throw error; }
      if (!draft.id || !visible.has(draft.id) || denied.has(draft.id) || !editable) { retain('draft', draft.id ?? 'unknown', row.value, 'access_revoked_or_read_only'); await store.meta.delete(row.key); }
    }
    const files = new Map((await store.files.toArray()).filter(f => !f.deleted).map(f => [f.id, f])), removedBlobs: string[] = [];
    for (const blob of await store.blobs.toArray()) {
      const parentId = thumbnailParentId(blob.id), parent = parentId ? files.get(parentId) : undefined;
      const file = files.get(blob.id) ?? (parent?.thumbId === blob.id ? parent : undefined), pendingBytes = blob.state === 'pending' || blob.state === 'failed';
      // The snapshot contains canonical file rows, not an assertion that an
      // auxiliary ID is still unclaimed. Discard downloaded/uploaded thumbnail
      // cache and obtain fresh server authorization before displaying it. Keep
      // local pending camera bytes attached to an editable canonical parent.
      if (file && (files.has(blob.id) || pendingBytes) && (!pendingBytes || canEdit(clientAccess(manifest, String(file._spaceId ?? ''))))) continue;
      if (blob.state === 'pending' || blob.state === 'failed') retain('blob', blob.id, blob, 'file_access_revoked');
      await store.blobs.delete(blob.id); removedBlobs.push(blob.id);
    }
    await store.users.clear(); // directory is reloaded with current authorization
    if (quarantine.length) {
      const keys = await store.accessQuarantine.bulkAdd(quarantine, { allKeys: true });
      await store.accessQuarantineInfo.bulkPut(quarantine.map(({ payload, ...info }, index) => ({ ...info, autoId: keys[index],
        collection: info.kind === 'outbox' && object(payload) ? String(payload.collection ?? '') : undefined,
      })));
    }
    await store.meta.put({ key: ACCESS_MANIFEST_KEY, value: manifest });
    await store.meta.put({ key: 'sync_cursor', value: descriptor.cutoff });
    await store.meta.delete(SNAPSHOT_KEY); await store.syncStage.clear();
    return { quarantined: quarantine.length, removedBlobs };
  });
}
