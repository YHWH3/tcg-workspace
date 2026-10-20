/** Network driver for the durable feed state. Retries resume from committed cursors;
 * no server-side snapshot, no disposable request identity, no full-cache replay. */
import { PERMISSION_PROTOCOL, MAX_PULL_LIMIT, type PullRequestV3, type PullResponseV3 } from '../../../shared/protocol';
import { ApiError } from '../api';
import type { LocalDB } from '../db';
import { applyFeedPage, installManifest, rebackfill, type CacheChange } from './accessCache';
import { FeedStateChanged, readState, requestedScans, deferredSpaces, type ClientAccessManifest } from './feedState';

export interface FeedDeps {
  store: LocalDB;
  request: <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;
  assertCurrent: () => void;
  changed: (change: CacheChange) => void;
  lock?: () => void;
}

export async function pullSpaceFeed(userId: string, deps: FeedDeps): Promise<ClientAccessManifest> {
  for (let pages = 0, retries = 0; pages < 100_000; pages++) {
    deps.assertCurrent();
    const state = await readState(deps.store, userId);
    if (!state.consistent || state.access?.protocol !== PERMISSION_PROTOCOL || !state.feed) throw new Error('invalid_feed_state');
    const feed = state.feed;
    const req: PullRequestV3 = { protocol: PERMISSION_PROTOCOL, etag: feed.etag, cursor: feed.cursor, joining: requestedScans(feed), deferred: deferredSpaces(feed), limit: MAX_PULL_LIMIT };
    try {
      const reply = await deps.request<PullResponseV3>('/api/sync/pull', { method: 'POST', body: req });
      deps.assertCurrent();
      if (reply.evictions?.length) deps.lock?.();
      const change = await applyFeedPage(deps.store, userId, feed, req, reply, { assertCurrent: deps.assertCurrent });
      if (change.activated || change.quarantined || change.removedBlobs.length) deps.changed(change);
      retries = 0;
      if (!reply.hasMore && !Object.keys(change.feed.joining).length) return state.access;
    } catch (error) {
      deps.assertCurrent();
      if (error instanceof FeedStateChanged) { if (++retries > 20) throw error; continue; }
      if (!(error instanceof ApiError) || error.status !== 409 || ++retries > 20) throw error;
      deps.lock?.();
      const body = error.body as { error?: unknown; manifest?: unknown; spaces?: unknown } | undefined;
      try {
        if (body?.error === 'manifest_changed') deps.changed(await installManifest(deps.store, userId, body.manifest, feed.version, { assertCurrent: deps.assertCurrent }));
        else if (body?.error === 'rebackfill_required' && Array.isArray(body.spaces) && body.spaces.every(s => typeof s === 'string')) await rebackfill(deps.store, userId, feed.version, body.spaces, { assertCurrent: deps.assertCurrent });
        else if (body?.error === 'cursor_ahead') await rebackfill(deps.store, userId, feed.version, undefined, { assertCurrent: deps.assertCurrent });
        else if (body?.error !== 'access_changed_retry') throw error;
      } catch (conflict) { if (!(conflict instanceof FeedStateChanged)) throw conflict; }
    }
  }
  throw new Error('feed_paging_incomplete');
}
