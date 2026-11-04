/** What may still happen to work the user has not synced, once access changes.
 *
 * Pending edits (outbox), unsent drafts and pending upload bytes were authorized when they were
 * made. Whenever the cache's access changes — a space removed, a role reduced, a backfill
 * activated — each is re-judged against the NEW manifest and the server-confirmed rows it
 * depends on. Work that is no longer allowed is moved to the account quarantine (never rendered,
 * never exported, never pushed); the rest stays and is rebased. This module only decides; the
 * caller applies the decision inside its own transaction. */
import { COLLECTIONS, type Collection } from '../../../shared/collections';
import { canComment, canEdit, canEditComment, canRead, type SpaceAccess } from '../../../shared/access';
import { thumbnailParentId } from '../../../shared/fileOwnership';
import { ScopeError, scopeParentIds, scopeResolver, type RecordScope, type ScopeRecord } from '../../../shared/recordScope';
import { stableJson } from '../../../shared/stablejson';
import type { AccessQuarantineRow, BlobRow, LocalDB, LocalRow, OutboxEntry } from '../db';
import {storedBlobRow} from '../blobCodec';
import type { ClientAccessManifest } from './feedState';
import { rebaseRecord } from './rebase';

/** A row as the planner sees it: staged or local, with its owning spaces. */
export interface SourceRow {
  id: string;
  collection: Collection;
  data: Record<string, unknown>;
  field_ts: Record<string, number>;
  spaceId?: string;
  peerSpaceId?: string;
  /** Delivered by the server (as opposed to created locally and not yet confirmed). */
  confirmed: boolean;
}
export type RowSource = (ids: string[]) => Promise<Map<string, SourceRow>>;

/** Maximum rows pulled into one planning pass (pending records and their ancestors). */
const SCOPE_BUDGET = 20_000;

export const draftPrefix = (userId: string) => `draft:${userId}:`;

export function splitRow(row: LocalRow): { data: Record<string, unknown>; field_ts: Record<string, number> } {
  const { id: _id, _ts, _serverRev: _rev, _spaceId: _space, _peerSpaceId: _peer, ...data } = row;
  return { data, field_ts: (_ts as Record<string, number> | undefined) ?? {} };
}

export function clientAccess(manifest: ClientAccessManifest, spaceId: string): SpaceAccess {
  const space = manifest.spaces.find(s => s.id === spaceId);
  return { principal: { id: manifest.userId, workspaceRole: manifest.workspaceRole, disabledAt: null },
    space: space ? { id: space.id, defaultAccess: 'private', exportPolicy: space.exportPolicy, deletedAt: null } : null,
    membership: space ? { role: space.role, access: 'allow' } : null };
}

/** Rows of the live tables by id. */
export function liveSource(store: LocalDB, skip: ReadonlySet<string> = new Set()): RowSource {
  return async ids => {
    const out = new Map<string, SourceRow>();
    for (const collection of COLLECTIONS) {
      const missing = [...new Set(ids)].filter(id => !skip.has(id) && !out.has(id));
      if (!missing.length) break;
      const rows = await store.collection(collection).bulkGet(missing);
      rows.forEach((row, index) => {
        if (!row) return;
        const { data, field_ts } = splitRow(row);
        out.set(missing[index], { id: row.id, collection, data, field_ts,
          spaceId: typeof row._spaceId === 'string' ? row._spaceId : undefined,
          peerSpaceId: typeof row._peerSpaceId === 'string' ? row._peerSpaceId : undefined,
          confirmed: row._serverRev !== undefined });
      });
    }
    return out;
  };
}

/** Staged rows win over live rows: they are the newer server state of a space being rebuilt. */
export function stagedFirst(store: LocalDB, stageId: string, live: RowSource): RowSource {
  return async ids => {
    const unique = [...new Set(ids)], out = new Map<string, SourceRow>(), rest: string[] = [];
    const staged = await store.syncStage.bulkGet(unique.map(id => [stageId, id] as [string, string]));
    staged.forEach((row, index) => {
      if (row) out.set(unique[index], { id: row.id, collection: row.collection, data: row.data, field_ts: row.field_ts, spaceId: row.spaceId, peerSpaceId: row.peerSpaceId, confirmed: true });
      else rest.push(unique[index]);
    });
    for (const [id, row] of await live(rest)) out.set(id, row);
    return out;
  };
}

const toScope = (row: SourceRow): ScopeRecord => ({ id: row.id, collection: row.collection, data: row.data,
  rootSpaceId: row.spaceId ?? (typeof row.data.spaceId === 'string' ? row.data.spaceId : undefined) });

export interface AccessWork {
  /** Record id → why its pending operations must not proceed. */
  denied: Map<string, string>;
  /** Pending operations grouped by record id, in outbox order. */
  entries: Map<string, OutboxEntry[]>;
  drafts: { key: string; value: unknown; reason: string }[];
  blobs: { blob: BlobRow; reason: string }[];
  /** The rows (staged/live) the decisions were based on. */
  rows: Map<string, SourceRow>;
}

/** Decide every unsynced operation's fate under `manifest`. `source` supplies server-confirmed
 * rows (and unconfirmed local ones); nothing is read from the network and nothing is written. */
export async function planAccessWork(store: LocalDB, userId: string, manifest: ClientAccessManifest, source: RowSource): Promise<AccessWork> {
  const pending = await store.outbox.orderBy('autoId').toArray();
  const entries = new Map<string, OutboxEntry[]>();
  for (const entry of pending) entries.set(entry.id, [...(entries.get(entry.id) ?? []), entry]);
  const draftRows = (await store.meta.toArray()).filter(row => row.key.startsWith(draftPrefix(userId)));
  const blobRows = await store.blobs.where('state').anyOf('pending', 'failed').toArray();

  // Everything the decisions depend on, loaded once: the records themselves and (below) their ancestors.
  const wanted = new Set<string>(entries.keys());
  for (const draft of draftRows) { const id = (draft.value as { id?: unknown } | null)?.id; if (typeof id === 'string') wanted.add(id); }
  for (const blob of blobRows) { wanted.add(blob.id); const parent = thumbnailParentId(blob.id); if (parent) wanted.add(parent); }
  const rows = await source([...wanted]);

  const denied = new Map<string, string>();
  const proposed = new Map<string, ScopeRecord>();
  for (const [recordId, group] of entries) {
    const base = rows.get(recordId)?.confirmed ? rows.get(recordId) : undefined, first = group[0];
    if (!base && !group.some(e => e.createIntent)) { denied.set(recordId, 'access_revoked_or_unconfirmed_creation'); continue; }
    if (group.some(e => e.collection !== first.collection || e.state === 'rejected')) { denied.set(recordId, 'access_review_required'); continue; }
    const rebased = rebaseRecord({ data: base?.data ?? {}, field_ts: base?.field_ts ?? {} }, group,!!base);
    proposed.set(recordId, { id: recordId, collection: first.collection, data: rebased.data,
      rootSpaceId: base?.spaceId ?? (typeof rebased.data.spaceId === 'string' ? rebased.data.spaceId : 'space-core') });
  }
  // Ancestors (and relation endpoints) of everything that will be judged.
  let frontier: ScopeRecord[] = [];
  for (const id of wanted) {
    if (proposed.has(id)) { frontier.push(proposed.get(id)!); continue; }
    const row = rows.get(id);
    if (row) { const record = toScope(row); proposed.set(id, record); frontier.push(record); }
  }
  const asked = new Set<string>(wanted);
  let budget = SCOPE_BUDGET;
  while (frontier.length) {
    const next = [...new Set(frontier.flatMap(scopeParentIds))].filter(id => !asked.has(id));
    frontier = [];
    if (!next.length) break;
    if ((budget -= next.length) < 0) throw new Error('pending_scope_budget');
    for (const id of next) asked.add(id);
    for (const [id, row] of await source(next)) { rows.set(id, row); if (!proposed.has(id)) { const record = toScope(row); proposed.set(id, record); frontier.push(record); } }
  }

  const resolve = scopeResolver(proposed);
  for (const [recordId, group] of entries) if (!denied.has(recordId)) {
    const record = proposed.get(recordId)!, base = rows.get(recordId)?.confirmed ? rows.get(recordId) : undefined;
    try {
      const scope = resolve(recordId), access = clientAccess(manifest, scope.spaceId);
      const readable = !scope.ancestorDeleted && !scope.serviceOnly && scope.readSpaceIds.every(s => canRead(clientAccess(manifest, s)));
      const allowed = record.collection === 'comments'
        ? (base ? canEditComment(access, String(base.data.authorId ?? '')) : canComment(access) && record.data.authorId === manifest.userId)
        : canEdit(access);
      if (!readable || !allowed) denied.set(recordId, 'access_revoked_or_read_only');
      if (base && base.spaceId !== undefined && scope.spaceId !== base.spaceId) denied.set(recordId, 'explicit_move_required');
      if (group.some(e => e.collection !== record.collection)) denied.set(recordId, 'invalid_outbox_entry');
    } catch (error) { if (!(error instanceof ScopeError)) throw error; denied.set(recordId, 'parent_unavailable'); }
  }
  // A refused parent operation takes its dependent children with it, to a fixed point.
  const parentPlanRequired = (parentId: string) => {
    if (!denied.has(parentId)) return false;
    const prior = rows.get(parentId), candidate = proposed.get(parentId);
    if (!prior?.confirmed || !candidate) return true;
    const previous: ScopeRecord = { id: prior.id, collection: prior.collection, data: prior.data, rootSpaceId: prior.spaceId };
    return candidate.rootSpaceId !== prior.spaceId || candidate.data.deleted !== prior.data.deleted
      || stableJson(scopeParentIds(candidate)) !== stableJson(scopeParentIds(previous));
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const recordId of entries.keys()) if (!denied.has(recordId) && scopeParentIds(proposed.get(recordId)!).some(parentPlanRequired)) { denied.set(recordId, 'parent_access_rejected'); changed = true; }
  }

  const editableRecord = (recordId: string): boolean => {
    const record = proposed.get(recordId);
    if (!record || record.data.deleted === true) return false;
    try {
      const access = clientAccess(manifest, resolve(recordId).spaceId);
      return record.collection === 'comments' ? canEditComment(access, String(record.data.authorId ?? '')) : canEdit(access);
    } catch (error) { if (!(error instanceof ScopeError)) throw error; return false; }
  };
  const visible = (recordId: string) => !!rows.get(recordId)?.confirmed || (entries.has(recordId) && !denied.has(recordId));
  const drafts: AccessWork['drafts'] = [];
  for (const row of draftRows) {
    const id = (row.value as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !visible(id) || denied.has(id) || !editableRecord(id)) drafts.push({ key: row.key, value: row.value, reason: 'access_revoked_or_read_only' });
  }
  const blobs: AccessWork['blobs'] = [];
  for (const blob of blobRows) {
    const parent = thumbnailParentId(blob.id);
    const fileId = rows.get(blob.id)?.collection === 'files' ? blob.id : parent && rows.get(parent)?.data.thumbId === blob.id ? parent : undefined;
    // Local camera bytes stay only while they belong to a file row the user may still edit.
    if (!fileId || denied.has(fileId) || !visible(fileId) || !editableRecord(fileId)) blobs.push({ blob, reason: 'file_access_revoked' });
  }
  return { denied, entries, drafts, blobs, rows };
}

export interface AppliedWork { quarantined: number; removedBlobs: string[]; /** Spaces whose confirmed rows lost an unauthorized optimistic edit and must be re-read. */ refreshSpaces: Set<string> }

/** Carry out a plan inside the caller's transaction. */
export async function applyAccessWork(store: LocalDB, work: AccessWork, quarantineVersion: number): Promise<AppliedWork> {
  const now = Date.now(), quarantine: AccessQuarantineRow[] = [], refreshSpaces = new Set<string>(), removedBlobs: string[] = [];
  const retain = (kind: AccessQuarantineRow['kind'], id: string, payload: unknown, reason: string) => quarantine.push({ id, kind, payload, reason, generation: quarantineVersion, quarantinedAt: now });
  const refused: number[] = [];
  for (const [recordId, group] of work.entries) {
    const reason = work.denied.get(recordId);
    if (!reason) continue;
    for (const entry of group) { retain('outbox', recordId, entry, reason); if (entry.autoId !== undefined) refused.push(entry.autoId); }
    const row = work.rows.get(recordId);
    if (row?.confirmed) { if (row.spaceId) refreshSpaces.add(row.spaceId); }
    else if (row) await store.collection(row.collection).delete(recordId); // a local creation that may no longer exist
  }
  await store.outbox.bulkDelete(refused);
  for (const draft of work.drafts) { retain('draft', ((draft.value as { id?: string } | null)?.id) ?? 'unknown', draft.value, draft.reason); await store.meta.delete(draft.key); }
  for (const { blob, reason } of work.blobs) { retain('blob', blob.id, storedBlobRow(blob), reason); await store.blobs.delete(blob.id); removedBlobs.push(blob.id); }
  if (quarantine.length) {
    const keys = await store.accessQuarantine.bulkAdd(quarantine, { allKeys: true });
    await store.accessQuarantineInfo.bulkPut(quarantine.map(({ payload, ...info }, index) => ({ ...info, autoId: keys[index],
      collection: info.kind === 'outbox' && payload && typeof payload === 'object' ? String((payload as { collection?: unknown }).collection ?? '') : undefined })));
  }
  return { quarantined: quarantine.length, removedBlobs, refreshSpaces };
}

export type { RecordScope };
