import type { LocalDB } from '../src/core/db';
import { readState, requestedScans, deferredSpaces, type FeedState } from '../src/core/sync/feedState';
import { applyFeedPage } from '../src/core/sync/accessCache';
import type { ManifestV3, PullRequestV3, PullResponseV3 } from '../shared/protocol';
import type { PulledRecord } from '../shared/types';
export const manifestFor = (userId: string, etag = 'fixture-etag'): ManifestV3 => ({ protocol: 3, userId, workspaceRole: 'member', etag,
  spaces: [{ id: 'space-core', name: 'Core', role: 'editor', exportPolicy: 'members' }] });
export const record = (id: string, collection = 'pages', data: Record<string, unknown> = { title: 'Authorized' }, seq = 1, spaceId = 'space-core'): PulledRecord => ({ id, collection, data, field_ts: Object.fromEntries(Object.keys(data).map(k => [k, 1])), seq, spaceId });
export const requestFor = (feed: FeedState): PullRequestV3 => ({ protocol: 3, etag: feed.etag, cursor: feed.cursor, joining: requestedScans(feed), deferred: deferredSpaces(feed), limit: 500 });
export const replyFor = (request: PullRequestV3, records: PulledRecord[] = [], hasMore = false, cursor = 100): PullResponseV3 => ({ protocol: 3, etag: request.etag, records, evictions: [], cursor: Math.max(request.cursor, cursor), highWater: 100,
  joining: request.joining.map(j => ({ space: j.space, after: Math.max(j.after, cursor), base: j.base || 100 })), hasMore });
export async function feedOf(store: LocalDB, userId: string): Promise<FeedState> { const state = await readState(store, userId); if (!state.feed) throw new Error('missing test feed'); return state.feed; }
export async function page(store: LocalDB, userId: string, records: PulledRecord[] = [], more = false, cursor = 100) {
  const feed = await feedOf(store, userId), req = requestFor(feed); return applyFeedPage(store, userId, feed, req, replyFor(req, records, more, cursor));
}
