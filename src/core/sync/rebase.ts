import type { StoredRecord } from '../../../shared/types';

export interface PendingChange {
  id: string;
  patch: Record<string, unknown>;
  ts: number;
}

/**
 * Re-apply pending (unpushed) local fields on top of a server record.
 * A local field wins when its HLC ts is >= the server's ts for that field,
 * mirroring the server's per-field LWW rule.
 */
export function rebaseRecord(server: StoredRecord, pending: PendingChange[]): StoredRecord {
  const data = { ...server.data };
  const field_ts = { ...server.field_ts };
  for (const change of pending) {
    for (const [field, value] of Object.entries(change.patch)) {
      if (change.ts >= (field_ts[field] ?? -Infinity)) {
        data[field] = value;
        field_ts[field] = change.ts;
      }
    }
  }
  return { data, field_ts };
}
