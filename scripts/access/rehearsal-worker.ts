import { loadManifest, parsePullRequest, pullFeed } from '../../worker/spaceFeed';
import { MAX_JOINING_SPACES, PERMISSION_PROTOCOL } from '../../shared/protocol';

export default {
  async fetch(_request: Request, { DB }: { DB: D1Database }) {
    const { results } = await DB.prepare('SELECT id FROM users WHERE disabled_at IS NULL ORDER BY id LIMIT 8').all<{id: string}>();
    let joinedSpaces = 0;
    let batches = 0;
    for (const { id } of results) {
      const { manifest } = await loadManifest(DB, id);
      if (manifest.protocol !== PERMISSION_PROTOCOL) return new Response(null, { status: 409 });
      const scopes = manifest.spaces.map(space => space.id);
      for (let index = 0; index < scopes.length; index += MAX_JOINING_SPACES) {
        const group = scopes.slice(index, index + MAX_JOINING_SPACES);
        let joining = group.map(space => ({ space, after: 0, base: 0 }));
        let cursor = 0;
        const deferred = scopes.filter(space => !group.includes(space));
        for (let page = 0; ; page++) {
          const result = await pullFeed(DB, id, parsePullRequest({ protocol: PERMISSION_PROTOCOL, etag: manifest.etag, cursor, joining, deferred }));
          if (result.status !== 200 || result.body.etag !== manifest.etag ||
              result.body.records.some(record => !record.spaceId || !scopes.includes(record.spaceId))) return new Response(null, { status: 409 });
          batches += 1;
          if (!result.body.hasMore) break;
          if (page >= 99 || result.body.cursor <= cursor) return new Response(null, { status: 409 });
          ({ joining, cursor } = result.body);
        }
        joinedSpaces += group.length;
      }
    }
    return Response.json({ activeAccounts: results.length, joinedSpaces, batches });
  },
};
