/* Pure undo planner for MCP change sets (Phase 0 §7.2).
 *
 * For each recorded item, a field is restored only when nobody changed it
 * since the change set ran — detected by comparing the field's CURRENT
 * timestamp to the timestamp the change set actually wrote (item.field_ts).
 * Anything touched since is skipped, so undo never clobbers a later edit.
 */

export interface ChangesetItem {
  collection: string;
  record_id: string;
  /** 1 when the record did not exist before the change set. */
  created: number | boolean;
  /** JSON: touched fields' previous values ({} when created). */
  before: Record<string, unknown>;
  /** JSON: touched fields' new values. */
  after: Record<string, unknown>;
  /** JSON {field: ts} — the timestamp actually written per field. */
  field_ts: Record<string, number>;
}

export interface UndoPlan {
  patches: { collection: string; id: string; patch: Record<string, unknown> }[];
  skipped: { id: string; field: string; reason: string }[];
}

export function planUndo(items: ChangesetItem[], current: Map<string, { data: Record<string, unknown>; field_ts: Record<string, number> }>): UndoPlan {
  const patches: UndoPlan['patches'] = [];
  const skipped: UndoPlan['skipped'] = [];
  const deletedIds = new Set<string>();

  for (const item of items) {
    const cur = current.get(item.record_id);
    if (item.created) {
      // A created record is deleted only when NO field changed since the
      // change set ran — otherwise the whole record is skipped.
      const touched = Object.keys(item.field_ts);
      const anyChanged = cur
        ? touched.some((f) => cur.field_ts[f] !== item.field_ts[f]) || Object.keys(cur.field_ts).some((f) => !touched.includes(f))
        : false;
      if (!cur) {
        // Record already gone — nothing to delete (also fine: re-check below).
        if (cur === undefined) {
          patches.push({ collection: item.collection, id: item.record_id, patch: { deleted: true } });
          deletedIds.add(item.record_id);
        }
        continue;
      }
      if (anyChanged) {
        skipped.push({ id: item.record_id, field: '*', reason: 'record changed since; kept' });
      } else if (!deletedIds.has(item.record_id)) {
        patches.push({ collection: item.collection, id: item.record_id, patch: { deleted: true } });
        deletedIds.add(item.record_id);
      }
      continue;
    }
    if (!cur) {
      // Record deleted since — restore via patch of its recorded fields.
      const patch: Record<string, unknown> = { deleted: false };
      for (const f of Object.keys(item.after)) patch[f] = item.before[f] ?? null;
      patches.push({ collection: item.collection, id: item.record_id, patch });
      continue;
    }
    const patch: Record<string, unknown> = {};
    for (const f of Object.keys(item.after)) {
      if (cur.field_ts[f] === item.field_ts[f]) {
        // Untouched since: restore previous value (absent in `before` → null).
        patch[f] = item.before[f] ?? null;
      } else {
        skipped.push({ id: item.record_id, field: f, reason: 'changed since by someone else' });
      }
    }
    if (Object.keys(patch).length) patches.push({ collection: item.collection, id: item.record_id, patch });
  }
  return { patches, skipped };
}
