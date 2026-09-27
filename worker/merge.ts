import type { StoredRecord } from '../shared/types';

export interface MergeResult extends StoredRecord {
  changed: boolean;
}

export function mergeRecord(
  existing: StoredRecord | null,
  change: { patch: Record<string, unknown>; ts: number },
): MergeResult {
  const data: Record<string, unknown> = { ...(existing?.data ?? {}) };
  const field_ts: Record<string, number> = { ...(existing?.field_ts ?? {}) };
  let changed = false;

  for (const [field, value] of Object.entries(change.patch)) {
    const existingTs = field_ts[field];
    if (existingTs === undefined || change.ts >= existingTs) {
      if (!changed && (existingTs === undefined || data[field] !== value)) changed = true;
      data[field] = value;
      field_ts[field] = change.ts;
    }
  }

  return { data, field_ts, changed };
}
