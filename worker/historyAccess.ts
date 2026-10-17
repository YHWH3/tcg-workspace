/** Phase 5 history reads (change sets, undo previews). `changeset_items.before/after` and a
 * change set's `summary` are historical copies of record content: while permissions are
 * enabled they are shown only for records the viewer can read NOW. An item for a record
 * the viewer cannot read (or that no longer exists) is withheld; a change set touching
 * any such record is listed with a neutral summary. Legacy: unchanged. Undo itself is
 * re-authorized write by write in applyChanges. */
import { createReadGate } from './readAccess';

export async function visibleItems<T extends { record_id: string }>(db: D1Database, viewerId: string, items: T[]): Promise<{ items: T[]; restricted: number }> {
  const decision = await createReadGate(db, viewerId).decide(items.map((i) => i.record_id));
  if (!decision.enabled) return { items, restricted: 0 };
  const shown = items.filter((i) => decision.readable.has(i.record_id));
  return { items: shown, restricted: items.length - shown.length };
}

export async function visibleSummaries<T extends { id: unknown; summary?: unknown }>(db: D1Database, viewerId: string, changesets: T[]): Promise<T[]> {
  const gate = createReadGate(db, viewerId);
  if (!changesets.length || !(await gate.enabled())) return changesets;
  const { results } = await db.prepare('SELECT changeset_id, record_id FROM changeset_items WHERE changeset_id IN (SELECT value FROM json_each(?)) LIMIT 10000')
    .bind(JSON.stringify(changesets.map((c) => String(c.id)))).all<{ changeset_id: string; record_id: string }>();
  const decision = await gate.decide(results.map((r) => r.record_id));
  const hidden = new Set(results.filter((r) => !decision.readable.has(r.record_id)).map((r) => r.changeset_id));
  return changesets.map((c) => (hidden.has(String(c.id)) ? { ...c, summary: 'Restricted change', restricted: true } : c));
}
