// Reference implementation of the protocol-3 client algorithm, in the smallest form that
// is still a faithful model: manifest diff -> evict first -> join -> page -> activate.
// Server tests drive it against the real pullFeed so that every protocol property is
// checked end to end; the real client (src/core/sync) implements the same rules over
// IndexedDB and is tested against the real server in tests/phase5-spacefeed-client.test.ts.
import type { ManifestV3, PullRequestV3 } from '../shared/protocol';

export interface FeedRow { id: string; collection: string; data: Record<string, unknown>; seq: number; spaceId: string; peerSpaceId?: string }
export interface Eviction { id: string; rev: number; spaceId: string }
export interface PullReply { status: number; body: any }
export type PullFn = (request: PullRequestV3) => Promise<PullReply>;

export class RefClient {
  settled = new Set<string>();
  joining = new Map<string, { after: number; base: number; staged: Map<string, FeedRow>; refresh: boolean }>();
  cursor = 0;
  etag = '';
  live = new Map<string, FeedRow>();
  pages = 0;
  log: string[] = [];
  constructor(private readonly pull: PullFn) {}

  /** Adopt a manifest: evict removed spaces FIRST, then start joining added ones. */
  reconcile(manifest: ManifestV3): void {
    const next = new Set(manifest.spaces.map(space => space.id));
    for (const space of [...this.settled]) if (!next.has(space)) { this.evictSpace(space); this.settled.delete(space); }
    for (const space of [...this.joining.keys()]) if (!next.has(space)) this.joining.delete(space);
    for (const space of next) if (!this.settled.has(space) && !this.joining.has(space)) this.joining.set(space, { after: 0, base: 0, staged: new Map(), refresh: false });
    this.etag = manifest.etag;
    this.collectGarbage();
  }

  private evictSpace(space: string): void {
    for (const [id, row] of this.live) if (row.spaceId === space) this.live.delete(id);
  }

  /** A relation is held only while both endpoints are held. */
  collectGarbage(): void {
    for (const [id, row] of this.live) {
      if (row.collection !== 'links') continue;
      const from = this.live.get(String(row.data.fromId)), to = this.live.get(String(row.data.toId));
      if (!from || !to) this.live.delete(id);
    }
  }

  private upsert(into: Map<string, FeedRow>, row: FeedRow): void {
    const known = into.get(row.id);
    if (!known || known.seq <= row.seq) into.set(row.id, row);
  }

  private applyEviction(event: Eviction): void {
    const staging = this.joining.get(event.spaceId)?.staged;
    if (staging) { const staged = staging.get(event.id); if (staged && staged.seq < event.rev) staging.delete(event.id); }
    const row = this.live.get(event.id);
    if (row && row.spaceId === event.spaceId && row.seq < event.rev) this.live.delete(event.id);
  }

  /** A joining space activates only once its backfill is COMPLETE: the feed is
   * exhausted (no partially populated space is ever shown) and its cursor caught up. */
  private activateCaughtUp(exhausted: boolean): void {
    if (!exhausted) return;
    for (const [space, state] of [...this.joining]) {
      if (state.after < this.cursor) continue;
      if (state.refresh) for (const [id, row] of this.live) if (row.spaceId === space && !state.staged.has(id)) this.live.delete(id);
      for (const row of state.staged.values()) if (row.spaceId === space || this.settled.has(row.spaceId) || row.peerSpaceId === space) this.upsert(this.live, row);
      this.settled.add(space); this.joining.delete(space);
    }
    this.collectGarbage();
  }

  /** One request/response round trip. Returns the reply status. */
  async step(limit = 500): Promise<PullReply> {
    const request: PullRequestV3 = { protocol: 3, etag: this.etag, cursor: this.cursor, limit,
      joining: [...this.joining].map(([space, state]) => ({ space, after: state.after, base: state.base })) };
    const reply = await this.pull(request);
    this.pages++;
    if (reply.status === 200) {
      const body = reply.body as { records: FeedRow[]; evictions: Eviction[]; cursor: number; joining: { space: string; after: number; base: number }[]; hasMore: boolean; etag: string; highWater: number };
      for (const record of body.records) {
        const targets = [record.spaceId, record.peerSpaceId].filter((space): space is string => !!space && this.joining.has(space));
        if (targets.length) for (const space of targets) this.upsert(this.joining.get(space)!.staged, record);
        else this.upsert(this.live, record);
      }
      for (const event of body.evictions) this.applyEviction(event);
      this.collectGarbage();
      this.cursor = body.cursor;
      for (const entry of body.joining) { const state = this.joining.get(entry.space); if (state) { state.after = entry.after; state.base = entry.base; } }
      this.activateCaughtUp(!body.hasMore);
      return reply;
    }
    const error = reply.body?.error as string | undefined;
    this.log.push(`${reply.status} ${error}`);
    if (error === 'manifest_changed') this.reconcile(reply.body.manifest as ManifestV3);
    else if (error === 'rebackfill_required') {
      for (const space of reply.body.spaces as string[]) {
        if (this.settled.delete(space)) this.joining.set(space, { after: 0, base: 0, staged: new Map(), refresh: true });
        else if (this.joining.has(space)) this.joining.set(space, { after: 0, base: 0, staged: new Map(), refresh: true });
      }
    } else if (error === 'cursor_ahead') {
      this.cursor = 0;
      for (const space of [...this.settled]) { this.settled.delete(space); this.joining.set(space, { after: 0, base: 0, staged: new Map(), refresh: true }); }
      for (const [space] of this.joining) this.joining.set(space, { after: 0, base: 0, staged: new Map(), refresh: true });
    } else if (error !== 'access_changed_retry') throw new Error(`unexpected feed reply ${reply.status} ${JSON.stringify(reply.body)}`);
    return reply;
  }

  /** Page until the feed is exhausted and nothing is left to join. */
  async sync(limit = 500, maxSteps = 500): Promise<void> {
    for (let i = 0; i < maxSteps; i++) {
      const reply = await this.step(limit);
      if (reply.status === 200 && !reply.body.hasMore && this.joining.size === 0) return;
    }
    throw new Error(`feed did not settle in ${maxSteps} steps: ${this.log.slice(-5).join(', ')}`);
  }

  ids(): string[] { return [...this.live.keys()].sort(); }
}
