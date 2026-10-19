/** Phase 5 public-capability authority (share links).
 *
 * A share token is a capability for ONE tree in ONE space. While permissions are enabled:
 *  - only an admin of the root's space may mint, list or revoke its token (design review §3);
 *  - the token is pinned to that space (`shares.space_id`, migration 0021); if the root has
 *    moved, the token stops serving;
 *  - nothing outside the pinned space is served through it (embedded databases, canvas cards
 *    and files resolving elsewhere are omitted).
 * Decisions use the kernel's ownership graph and capability SQL; nothing new is trusted.
 * With permissions disabled every function reproduces Phase 0–4 behavior. */
import { scopeResolver, ScopeError } from '../shared/recordScope';
import { loadAccessContext, spaceAccess } from './access';
import type { Env } from './auth';
import { capabilityFence, effectiveLevel, LEVEL_ADMIN } from './capability';
import { accessEnabled } from './readAccess';
import { loadScopeGraph } from './recordAccess';

/** Resolved home space of each existing id (absent: unresolvable, missing or service-only).
 * A relation resolves through both endpoints; it is in a space only if both are. */
export async function spacesOf(db: D1Database, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>(), unique = [...new Set(ids)].filter(id => typeof id === 'string' && id && id.length <= 64);
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500), graph = await loadScopeGraph(db, chunk), resolve = scopeResolver(graph.records);
    for (const id of chunk) {
      if (!graph.records.has(id)) continue;
      try {
        const scope = resolve(id);
        if (!scope.serviceOnly && scope.readSpaceIds.every(space => space === scope.spaceId)) out.set(id, scope.spaceId);
      } catch (error) { if (!(error instanceof ScopeError)) throw error; }
    }
  }
  return out;
}

export interface PublicScope { restrict: boolean; space: string | null }

/** Whether this token may serve at all, and in which space. `null` ⇒ inactive. */
export async function publicScope(db: D1Database, share: { page_id: string; space_id?: string | null }): Promise<PublicScope | null> {
  if (!(await accessEnabled(db))) return { restrict: false, space: null };
  const space = (await spacesOf(db, [share.page_id])).get(share.page_id);
  if (!space || !share.space_id || space !== share.space_id) return null;
  return { restrict: true, space };
}

/** Keep the ids that resolve to the pinned space (legacy: all). */
export async function inPinnedSpace(db: D1Database, scope: PublicScope, ids: readonly string[]): Promise<Set<string>> {
  if (!scope.restrict) return new Set(ids);
  const spaces = await spacesOf(db, ids);
  return new Set(ids.filter(id => spaces.get(id) === scope.space));
}

export type ShareAuthority = { ok: true; spaceId: string | null; fence: D1PreparedStatement | null } | { ok: false };

/** May `userId` manage the share of `targetId` (a page or a moodboard)? Denied and missing
 * are the same answer. The returned fence goes in the same batch as the share write. */
export async function shareAuthority(env: Pick<Env, 'DB'|'CONNECTOR'>, userId: string, collection: 'pages' | 'moodboards', targetId: string): Promise<ShareAuthority> {
  const db = env.DB;
  const row = await db.prepare('SELECT space_id, COALESCE(json_extract(data,\'$.deleted\'),0) AS deleted FROM records WHERE collection = ? AND id = ?').bind(collection, targetId).first<{ space_id: string | null; deleted: number }>();
  if (!(await accessEnabled(db))&&!env.CONNECTOR) return row ? { ok: true, spaceId: row.space_id, fence: null } : { ok: false };
  if (!row || row.deleted === 1) return { ok: false };
  const space = (await spacesOf(db, [targetId])).get(targetId);
  if (!space) return { ok: false };
  const context = await loadAccessContext(db, userId, [space],undefined,env.CONNECTOR);
  if ((!context.enabled&&!env.CONNECTOR) || !context.principal || effectiveLevel(spaceAccess(context, space)) < LEVEL_ADMIN) return { ok: false };
  return { ok: true, spaceId: space, fence: capabilityFence(db, { userId, needs: new Map([[space, LEVEL_ADMIN]]), workspaceRole: context.principal.workspaceRole, enabled: context.enabled,connector:context.connector }) };
}

/** Shares the caller may see in a listing (legacy: all). */
export async function visibleShares<T extends { page_id: string; target_type: string }>(env: Pick<Env, 'DB'|'CONNECTOR'>, userId: string, rows: T[]): Promise<T[]> {
  if (!(await accessEnabled(env.DB))) return rows;
  const out: T[] = [];
  const spaces = await spacesOf(env.DB, rows.map(r => r.page_id));
  const context = await loadAccessContext(env.DB, userId, [...new Set(spaces.values())]);
  for (const row of rows) {
    const space = spaces.get(row.page_id);
    if (space && context.enabled && effectiveLevel(spaceAccess(context, space)) >= LEVEL_ADMIN) out.push(row);
  }
  return out;
}
