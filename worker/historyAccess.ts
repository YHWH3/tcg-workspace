/** Phase 5 history reads (change sets, undo previews). `changeset_items.before/after` and a
 * change set's `summary` are historical copies of record content: while permissions are
 * enabled they are shown only for records the viewer can read NOW. An item for a record
 * the viewer cannot read (or that no longer exists) is withheld; a change set touching
 * any such record is listed with a neutral summary. Legacy: unchanged. Undo itself is
 * re-authorized write by write in applyChanges. */
import { createReadGate, type ReadGate } from './readAccess';
import { RecordAccessError } from './recordAccess';
import { D1BudgetExhausted } from './d1budget';

export async function visibleItems<T extends { record_id: string }>(db: D1Database, viewerId: string, items: T[], gate = createReadGate(db, viewerId)): Promise<{ items: T[]; restricted: number }> {
  const decision = await gate.decide(items.map((i) => i.record_id));
  if (!decision.enabled) return { items, restricted: 0 };
  const shown = items.filter((i) => decision.readable.has(i.record_id));
  return { items: shown, restricted: items.length - shown.length };
}

export async function visibleSummaries<T extends { id: unknown; summary?: unknown }>(db: D1Database, viewerId: string, changesets: T[], gate:ReadGate = createReadGate(db, viewerId)): Promise<T[]> {
  if (!changesets.length || !(await gate.enabled())) return changesets;
  // The sentinel proves complete coverage. An incomplete window never authorizes
  // ANY content-derived summary in that window, even if its sampled rows are public.
  // Keep ownership-graph evaluation within one 500-seed chunk / invocation budget.
  const { results } = await db.prepare('SELECT changeset_id, record_id FROM changeset_items WHERE changeset_id IN (SELECT value FROM json_each(?)) ORDER BY changeset_id,idx LIMIT 501')
    .bind(JSON.stringify(changesets.map((c) => String(c.id)))).all<{ changeset_id: string; record_id: string }>();
  const neutral = (c:T, incomplete=false):T => ({ ...c, summary: 'Restricted change', restricted: true, ...(incomplete?{visibilityIncomplete:true}:{}) });
  if (results.length > 500) return changesets.map(c=>neutral(c,true));
  let decision;
  try { decision = await gate.decide(results.map((r) => r.record_id)); }
  catch (error) {
    if (error instanceof RecordAccessError || error instanceof D1BudgetExhausted) return changesets.map(c=>neutral(c,true));
    throw error;
  }
  const covered = new Set(results.map(r=>r.changeset_id));
  const hidden = new Set(results.filter((r) => !decision.readable.has(r.record_id)).map((r) => r.changeset_id));
  return changesets.map(c => !covered.has(String(c.id)) || hidden.has(String(c.id)) ? neutral(c) : c);
}
