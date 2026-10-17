/** Activation state and protocol validation: a leaf module (no feed or route imports). */
import { PERMISSION_PROTOCOL } from '../shared/protocol';
import { AccessError } from './access';

export interface AccessState { enabled: number }
export async function loadAccessState(db: D1Database): Promise<AccessState> {
  const state = await db.prepare('SELECT enabled FROM access_state WHERE id=1').first<AccessState>();
  if (!state || ![0, 1].includes(state.enabled)) throw new AccessError('permission_schema_unavailable');
  return state;
}

export class SyncProtocolError extends Error {
  constructor(public readonly code: 'permission_protocol_required' | 'invalid_sync_request' | 'unauthenticated', public readonly status: 400 | 401 | 426) {
    super(code); this.name = 'SyncProtocolError';
  }
}

/** While permissions are active only protocol 3 may sync; every older protocol (the
 * legacy Core-only one and the never-shipped generation + snapshot draft) is refused. */
export function validateSyncProtocol(state: AccessState, protocol: unknown): void {
  if (!state.enabled) return;
  if (protocol !== PERMISSION_PROTOCOL && protocol !== String(PERMISSION_PROTOCOL)) throw new SyncProtocolError('permission_protocol_required', 426);
}
