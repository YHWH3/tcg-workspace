/* Archive helpers (Phase 3 §1.1, §2): `archived` is a schemaless flag on
 * pages, boards and tasks — distinct from `deleted`, never cascades. Sidebar
 * and default views hide archived rows (applyView drops them unless
 * ViewConfig.includeArchived); ⌘K search keeps them badged ARCHIVED_LABEL. */

/** Display label for archived rows (search badges, banners). */
export const ARCHIVED_LABEL = 'Archived';

/**
 * True when the row is archived. Accepts a flat record row or a stored
 * `{data}` wrapper (worker Rec / StoredRecord) so both sides share the check.
 */
export function isArchived(row: unknown): boolean {
  if (!row || typeof row !== 'object') return false;
  const r = row as Record<string, unknown>;
  if (r.archived === true) return true;
  const d = r.data;
  return !!d && typeof d === 'object' && (d as Record<string, unknown>).archived === true;
}

/** Patch written by archive_item / unarchive_item and the client menu. */
export function archivePatch(archived: boolean): { archived: boolean } {
  return { archived: archived === true };
}
