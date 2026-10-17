/** Wire protocol of permission-aware sync.
 *
 * 1  legacy, Core-only, used while activation is off (byte-for-byte unchanged)
 * 2  the never-shipped generation + materialized-snapshot draft (removed)
 * 3  per-space feeds (docs/architecture/phase-5-per-space-feeds.md)
 *
 * Every client and server site that names the protocol imports this constant, so a
 * partial update cannot leave one module speaking another version (FD-20). */
export const LEGACY_PROTOCOL = 1;
export const PERMISSION_PROTOCOL = 3;

/** Smallest page the server accepts: an equal-revision group (a record row plus up to
 * two eviction facts) must never fill a page by itself. */
export const MIN_PULL_LIMIT = 8;
export const MAX_PULL_LIMIT = 500;
/** Spaces being backfilled in one request (each is an independent index scan). */
export const MAX_JOINING_SPACES = 20;

export interface PullJoining { space: string; after: number }
export interface PullRequestV3 {
  protocol: typeof PERMISSION_PROTOCOL;
  /** Etag of the manifest the client last verified. */
  etag: string;
  /** Shared cursor of every manifest space that is not listed in `joining`. */
  cursor: number;
  joining: PullJoining[];
  limit: number;
}
/** A record left `spaceId` at revision `rev`: delete the local copy iff its `_spaceId`
 * is `spaceId` and its `_serverRev` is lower than `rev`. */
export interface PulledEviction { id: string; rev: number; spaceId: string }

export interface ManifestSpaceV3 { id: string; name: string; role: 'owner' | 'admin' | 'editor' | 'commenter' | 'viewer'; exportPolicy: 'members' | 'disabled' }
export interface ManifestV3 {
  protocol: typeof PERMISSION_PROTOCOL;
  userId: string;
  workspaceRole: 'owner' | 'admin' | 'member' | 'guest';
  etag: string;
  spaces: ManifestSpaceV3[];
}
