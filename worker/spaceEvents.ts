/** Retention of per-space eviction facts (docs/architecture/phase-5-per-space-feeds.md §3.4).
 *
 * A fact older than the retention window is deleted and the space's `events_floor` is
 * raised to the highest deleted revision IN THE SAME BATCH, so a client whose cursor is
 * older than the floor is told to re-backfill that space (it can no longer prove it saw
 * every eviction) instead of silently keeping a row that left. Bounded per call. */
export const EVENT_RETENTION_MS = 30 * 86_400_000;
export const PRUNE_BATCH = 500;

export async function pruneSpaceEvents(env: { DB: D1Database }, now = Date.now(), olderThanMs = EVENT_RETENTION_MS, limit = PRUNE_BATCH): Promise<number> {
  const db = env.DB, cutoff = now - olderThanMs;
  // The same bounded set drives both statements; the batch is one transaction, so the
  // floor can never be raised for facts that were not deleted, nor facts deleted unraised.
  const bounded = 'SELECT space_id, seq FROM space_events WHERE created_at < ? ORDER BY created_at, space_id, seq LIMIT ?';
  const [, deleted] = await db.batch([
    db.prepare(`UPDATE spaces SET events_floor = MAX(events_floor, (
        SELECT MAX(e.seq) FROM space_events e WHERE e.space_id = spaces.id AND (e.space_id, e.seq) IN (${bounded})))
      WHERE id IN (SELECT space_id FROM (${bounded}))`).bind(cutoff, limit, cutoff, limit),
    db.prepare(`DELETE FROM space_events WHERE (space_id, seq) IN (${bounded})`).bind(cutoff, limit),
  ]);
  return deleted.meta.changes ?? 0;
}
