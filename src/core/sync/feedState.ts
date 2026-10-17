/** Persisted client state of the protocol-3 per-space feed
 * (docs/architecture/phase-5-per-space-feeds.md §3.7).
 *
 * Three meta rows describe what the local cache is allowed to show:
 *  - `access_manifest`  the manifest the cache is consistent with (or the legacy marker);
 *  - `access_feed`      the feed cursors, the backfills in progress and the compare-and-swap token;
 *  - `access_reconciliation_required`  the cache holds rows that may not be shown yet.
 * They are only ever written together, inside the one IndexedDB transaction that changes the cache. */
import { isSpaceRole, isWorkspaceRole } from '../../../shared/access';
import { MAX_JOINING_SPACES, PERMISSION_PROTOCOL, type ManifestV3 } from '../../../shared/protocol';
import type { LocalDB } from '../db';

export type ClientAccessManifest = ManifestV3;
export interface LegacyAccess { protocol: 1; userId: string }
export type ReconciledAccess = ClientAccessManifest | LegacyAccess;

export const ACCESS_MANIFEST_KEY = 'access_manifest';
export const FEED_STATE_KEY = 'access_feed';
export const RECONCILE_REQUIRED_KEY = 'access_reconciliation_required';
export const MAX_MANIFEST_SPACES = 500;

/** One space that is being (re)built locally. Its rows are staged, not shown, until the whole
 * group completes; a `refresh` keeps showing the previous rows meanwhile and sweeps afterwards. */
export interface JoiningScan {
  /** Everything of this space up to `after` has been staged. */
  after: number;
  /** The server's high-water mark at the scan's first response (0 until then); echoed back verbatim. */
  base: number;
  /** The space was already visible: rows the scan does not return are removed on activation. */
  refresh: boolean;
  /** The scan reached the end of the feed and waits for the rest of its group. */
  complete: boolean;
}

export interface FeedState {
  v: 1;
  userId: string;
  /** Compare-and-swap token. A transaction applying a response computed from an older value aborts,
   * so a delayed response in one tab can never roll back what another tab already installed. */
  version: number;
  /** Etag of the installed manifest. */
  etag: string;
  /** Shared cursor of every settled space. */
  cursor: number;
  /** Staging area of the backfills in progress (`syncStage.snapshotId`). */
  stageId: string;
  joining: Record<string, JoiningScan>;
  /** The cache still holds synced rows from before spaces existed (no `_spaceId`): the next
   * activation replaces them all in one transaction or not at all (FD-10). */
  legacyUpgrade: boolean;
}

export interface ReconcileMarker { userId: string; reason: 'legacy_upgrade' | 'cache_inconsistent' }

export class FeedStateChanged extends Error { constructor() { super('feed_state_changed'); this.name = 'FeedStateChanged'; } }

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const spaceId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

export function validateAccessManifest(value: unknown, userId: string): ClientAccessManifest {
  if (!object(value) || value.protocol !== PERMISSION_PROTOCOL || value.userId !== userId || !isWorkspaceRole(value.workspaceRole)
      || typeof value.etag !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(value.etag)
      || !Array.isArray(value.spaces) || value.spaces.length > MAX_MANIFEST_SPACES) throw new Error('invalid_access_manifest');
  const ids = new Set<string>();
  for (const space of value.spaces) {
    if (!object(space) || !spaceId(space.id) || ids.has(space.id) || typeof space.name !== 'string' || space.name.length > 120 || !isSpaceRole(space.role)
        || (space.exportPolicy !== 'members' && space.exportPolicy !== 'disabled') || (value.workspaceRole === 'guest' && ['owner', 'admin'].includes(space.role))) throw new Error('invalid_access_manifest');
    ids.add(space.id);
  }
  return value as unknown as ClientAccessManifest;
}

export function parseFeedState(value: unknown, userId: string): FeedState {
  if (!object(value) || value.v !== 1 || value.userId !== userId || !count(value.version) || typeof value.etag !== 'string'
      || !count(value.cursor) || typeof value.stageId !== 'string' || !value.stageId || typeof value.legacyUpgrade !== 'boolean' || !object(value.joining)) throw new Error('invalid_feed_state');
  const joining: Record<string, JoiningScan> = Object.create(null);
  for (const [space, scan] of Object.entries(value.joining)) {
    if (!spaceId(space) || !object(scan) || !count(scan.after) || !count(scan.base) || typeof scan.refresh !== 'boolean' || typeof scan.complete !== 'boolean') throw new Error('invalid_feed_state');
    joining[space] = { after: scan.after, base: scan.base, refresh: scan.refresh, complete: scan.complete };
  }
  return { v: 1, userId, version: value.version, etag: value.etag, cursor: value.cursor, stageId: value.stageId, joining, legacyUpgrade: value.legacyUpgrade };
}

export interface ReadState {
  access: ReconciledAccess | undefined;
  feed: FeedState | undefined;
  required: ReconcileMarker | undefined;
  /** A v3 manifest is installed together with a feed state of the same etag, or neither is. */
  consistent: boolean;
}

/** Read the three rows. Call inside the transaction that will act on them. */
export async function readState(store: LocalDB, userId: string): Promise<ReadState> {
  if (store.name !== `workspace-${userId}`) throw new Error('account_cache_mismatch');
  const [manifestRow, feedRow, requiredRow] = await store.meta.bulkGet([ACCESS_MANIFEST_KEY, FEED_STATE_KEY, RECONCILE_REQUIRED_KEY]);
  const stored = manifestRow?.value as { protocol?: number; userId?: string } | undefined;
  if (stored && stored.userId !== userId) throw new Error('account_cache_mismatch');
  let access: ReconciledAccess | undefined, feed: FeedState | undefined, consistent = true;
  if (stored?.protocol === PERMISSION_PROTOCOL) {
    try { access = validateAccessManifest(stored, userId); } catch { consistent = false; }
  } else if (stored?.protocol === 1) access = { protocol: 1, userId };
  else if (stored) consistent = false;
  if (feedRow) { try { feed = parseFeedState(feedRow.value, userId); } catch { consistent = false; } }
  if (access?.protocol === PERMISSION_PROTOCOL && (!feed || feed.etag !== access.etag)) consistent = false;
  if (access?.protocol !== PERMISSION_PROTOCOL && feed) consistent = false;
  const marker = requiredRow?.value as Partial<ReconcileMarker> | undefined;
  const required = marker && marker.userId === userId && (marker.reason === 'legacy_upgrade' || marker.reason === 'cache_inconsistent') ? { userId, reason: marker.reason } : marker ? { userId, reason: 'cache_inconsistent' as const } : undefined;
  return { access, feed, required, consistent };
}

/** Write the cache's access state. The three rows change together or not at all. */
export async function writeState(store: LocalDB, next: { manifest: ClientAccessManifest; feed: FeedState; required?: ReconcileMarker }): Promise<void> {
  await store.meta.put({ key: ACCESS_MANIFEST_KEY, value: next.manifest });
  await store.meta.put({ key: FEED_STATE_KEY, value: next.feed });
  if (next.required) await store.meta.put({ key: RECONCILE_REQUIRED_KEY, value: next.required });
  else await store.meta.delete(RECONCILE_REQUIRED_KEY);
}

/** Spaces whose local copy is complete and shown. */
export function settledSpaces(manifest: ClientAccessManifest, feed: FeedState): string[] {
  return manifest.spaces.map(space => space.id).filter(id => !Object.hasOwn(feed.joining, id));
}

/** Scans to name in the next request: the unfinished ones, a bounded number at a time. */
export function requestedScans(feed: FeedState): { space: string; after: number; base: number }[] {
  return Object.entries(feed.joining).filter(([, scan]) => !scan.complete).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_JOINING_SPACES).map(([space, scan]) => ({ space, after: scan.after, base: scan.base }));
}

export const freshScan = (refresh = false): JoiningScan => ({ after: 0, base: 0, refresh, complete: false });

/** Joins waiting for a scan slot; completed scans stay in the steady stream so
 * changes arriving while other spaces catch up are still staged before activation. */
export function deferredSpaces(feed: FeedState): string[] {
  const active = new Set(requestedScans(feed).map(s => s.space));
  return Object.keys(feed.joining).filter(s => !feed.joining[s].complete && !active.has(s)).sort();
}
