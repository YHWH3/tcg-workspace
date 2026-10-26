import {mutationGuardMatches,type MutationGuard} from '../../../shared/mutationGuard';
import type { StoredRecord } from '../../../shared/types';

export interface PendingChange {
  id: string;
  patch: Record<string, unknown>;
  ts: number;
  ifUnchanged?:MutationGuard;
  state?:'pending'|'rejected';
}

/**
 * Re-apply pending (unpushed) local fields on top of a server record.
 * A local field wins when its HLC ts is >= the server's ts for that field,
 * mirroring the server's per-field LWW rule.
 */
export function rebaseRecord(server: StoredRecord, pending: PendingChange[],serverExists=true): StoredRecord {
  const data = { ...server.data };
  const field_ts = { ...server.field_ts };
  for (const change of pending) {
    if(change.ifUnchanged&&(change.state==='rejected'||!mutationGuardMatches(change.ifUnchanged,serverExists?data:null)))continue;
    serverExists=true;
    for (const [field, value] of Object.entries(change.patch)) {
      if (change.ts >= (field_ts[field] ?? -Infinity)) {
        data[field] = value;
        field_ts[field] = change.ts;
      }
    }
  }
  return { data, field_ts };
}
