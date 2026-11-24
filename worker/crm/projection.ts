import type { Mutation } from '../../shared/types';
import { isCrmProjectionKey, type ProjectionGrant } from '../../shared/crm/projection';

/** Allowed format for registered CRM projection field names on `tasks` records (SC-3). */
export const PROJECTION_KEY_RE = /^_crm_[a-z0-9_]{1,59}$/;

export function isValidProjectionKey(key: string): boolean {
  return PROJECTION_KEY_RE.test(key);
}

export interface ProjectionRejection {
  id: string;
  collection: string;
  reason: 'protected_field';
}

/**
 * Unconditional item-wise pre-check for `_crm_*` keys (SC-3.1).
 * Runs in `applyChanges` regardless of `access_state.enabled` or `CRM_ENABLED`.
 */
export function projectionRejections(
  changes: Mutation[],
  projection?: ProjectionGrant,
): { changes: Mutation[]; rejected: ProjectionRejection[] } {
  const accepted: Mutation[] = [];
  const rejected: ProjectionRejection[] = [];
  for (const ch of changes) {
    let blocked = false;
    for (const key of Object.keys(ch.patch)) {
      if (!isCrmProjectionKey(key)) continue;
      if (!projection || ch.collection !== 'tasks' || !projection.keys.has(key)) {
        blocked = true;
        break;
      }
    }
    if (blocked) {
      rejected.push({ id: ch.id, collection: ch.collection, reason: 'protected_field' });
    } else {
      accepted.push(ch);
    }
  }
  return { changes: accepted, rejected };
}
