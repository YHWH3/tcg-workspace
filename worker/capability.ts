/** Per-caller capability evaluation in SQL, plus the fence built from it.
 *
 * A fence must fail exactly when THIS caller's authority for a space it relied on
 * dropped, and never because someone else's membership, a session or an unrelated
 * record changed. The pure specification stays `shared/access.ts#effectiveSpaceRole`;
 * `levelSql` is the same decision written for SQLite, and
 * tests/phase5-capability-d1.test.ts enumerates every input combination through both.
 *
 * Levels: 0 none, 1 viewer, 2 commenter, 3 editor, 4 admin, 5 owner. */
import { effectiveSpaceRole, type SpaceAccess, type SpaceRole, type WorkspaceRole } from '../shared/access';

export const ROLE_LEVELS: readonly SpaceRole[] = ['viewer', 'commenter', 'editor', 'admin', 'owner'];
export const LEVEL_NONE = 0, LEVEL_READ = 1, LEVEL_COMMENT = 2, LEVEL_EDIT = 3, LEVEL_ADMIN = 4;

export const roleLevel = (role: SpaceRole | null): number => (role === null ? 0 : ROLE_LEVELS.indexOf(role) + 1);
export const levelRole = (level: number): SpaceRole | null => (Number.isInteger(level) && level >= 1 && level <= 5 ? ROLE_LEVELS[level - 1] : null);
export const effectiveLevel = (access: SpaceAccess): number => roleLevel(effectiveSpaceRole(access));

/** Smallest level at which `allowed` holds for this principal, or 6 when no role
 * satisfies it (a guest can never be admin/owner). The decision functions in
 * shared/access.ts are monotone in role order, so the minimum is the requirement. */
export function minLevel(principal: SpaceAccess['principal'], allowed: (access: SpaceAccess) => boolean): number {
  for (let level = 1; level <= ROLE_LEVELS.length; level++) {
    const access: SpaceAccess = {
      principal,
      space: { id: '_', defaultAccess: 'private', exportPolicy: 'members', deletedAt: null },
      membership: { role: ROLE_LEVELS[level - 1], access: 'allow' },
    };
    if (allowed(access)) return level;
  }
  return ROLE_LEVELS.length + 1;
}

/** Scalar SQL expression: the caller's current level on one space. `userExpr` and
 * `spaceExpr` are SQL expressions (usually `?` and a column). Evaluated against live
 * rows, inside whatever batch it is placed in. */
export function levelSql(userExpr: string, spaceExpr: string): string {
  return `COALESCE((SELECT CASE
      WHEN cu.disabled_at IS NOT NULL THEN 0
      WHEN COALESCE(cu.workspace_role,cu.role,'') NOT IN ('owner','admin','member','guest') THEN 0
      WHEN cs.id IS NULL OR cs.deleted_at IS NOT NULL THEN 0
      WHEN COALESCE(cu.workspace_role,cu.role)='guest' AND cs.guest_directory_restricted=1 THEN 0
      WHEN cm.user_id IS NOT NULL THEN CASE
        WHEN cm.access <> 'allow' THEN 0
        WHEN COALESCE(cu.workspace_role,cu.role) = 'guest' AND cm.role IN ('owner','admin') THEN 0
        ELSE CASE cm.role WHEN 'viewer' THEN 1 WHEN 'commenter' THEN 2 WHEN 'editor' THEN 3 WHEN 'admin' THEN 4 WHEN 'owner' THEN 5 ELSE 0 END END
      WHEN COALESCE(cu.workspace_role,cu.role) <> 'guest' AND cs.default_access = 'members' THEN 3
      ELSE 0 END
    FROM users cu LEFT JOIN spaces cs ON cs.id = ${spaceExpr}
      LEFT JOIN space_members cm ON cm.space_id = cs.id AND cm.user_id = cu.id
    WHERE cu.id = ${userExpr}), 0)`;
}

export type Needs = Map<string, number>;
/** Raise (never lower) the level a plan relied on for a space. */
export function need(needs: Needs, spaceId: string, level: number): void {
  if (level > (needs.get(spaceId) ?? 0)) needs.set(spaceId, level);
}

export interface CapabilityFenceInput {
  userId: string;
  needs: ReadonlyMap<string, number>;
  workspaceRole: WorkspaceRole;
  /** The activation flag the plan was made under (both directions abort). */
  enabled: boolean;
  /** Request-bound writes: the credential (sessions.token_hash) that authenticated the
   * request must still be valid at commit. Logout, password change and admin removal
   * of THIS session abort its own in-flight write; they never touch anyone else's. */
  session?: string | null;
  recordRevisions?:ReadonlyMap<string,number>;
  connector?: import('./connectorAccess').ConnectorAuthority;
}

/** Include in the SAME batch as the protected statements. Fails (SQLite error) iff
 * the activation flag changed, the principal was disabled or changed workspace
 * role, the request's own session ended, or the caller's current level on any named
 * space fell below the level the plan relied on. Another user's access, sessions and record changes never trip it. */
export function capabilityFence(db: D1Database, input: CapabilityFenceInput): D1PreparedStatement {
  const session = input.session ?? null;
  const connector = input.connector;
  return db.prepare(`SELECT CASE WHEN
      (SELECT enabled FROM access_state WHERE id=1) = ?
      AND EXISTS(SELECT 1 FROM users u WHERE u.id = ? AND u.disabled_at IS NULL AND COALESCE(u.workspace_role,u.role) = ?)
      AND (? IS NULL OR EXISTS(SELECT 1 FROM sessions x WHERE x.token_hash = ? AND x.user_id = ? AND x.expires_at > ?))
      ${connector ? `AND EXISTS(SELECT 1 FROM ai_connections g WHERE g.id=? AND g.user_id=? AND g.version=? AND g.revoked_at IS NULL AND g.expires_at>? AND NOT EXISTS(SELECT 1 FROM json_each(?) n WHERE n.key NOT IN(SELECT value FROM json_each(g.spaces_json))))` : ''}
      ${input.recordRevisions ? 'AND NOT EXISTS(SELECT 1 FROM json_each(?) r LEFT JOIN records x ON x.id=r.key WHERE x.seq IS NOT r.value)' : ''}
      AND NOT EXISTS(SELECT 1 FROM json_each(?) n WHERE ${levelSql('?', 'n.key')} < n.value)
    THEN 1 ELSE json_extract('{','$') END`)
    .bind(input.enabled ? 1 : 0, input.userId, input.workspaceRole, session, session, input.userId, Date.now(),
      ...(connector ? [connector.id, input.userId, connector.version, Date.now(), JSON.stringify(Object.fromEntries(input.needs))] : []),
      ...(input.recordRevisions?[JSON.stringify(Object.fromEntries(input.recordRevisions))]:[]),JSON.stringify(Object.fromEntries(input.needs)), input.userId);
}

/** True when the fence for `input` would fail right now (used to translate a batch
 * rollback into a recoverable "authority changed" instead of a generic error). */
export async function capabilityViolated(db: D1Database, input: CapabilityFenceInput): Promise<boolean> {
  try { await capabilityFence(db, input).first(); return false; }
  catch { return true; }
}

/** Discovery hint only: can this caller (optionally through a connector grant)
 * currently write to at least one space? Permissions disabled → legacy broad
 * access. Hiding tools is never an authorization decision; handlers revalidate. */
export async function hasWritableSpace(db: D1Database, userId: string, connectorId?: string): Promise<boolean> {
  const enabled = await db.prepare('SELECT enabled FROM access_state WHERE id=1').first<number>('enabled').catch(() => 0);
  if (enabled !== 1) return true;
  const row = await db.prepare(`SELECT 1 FROM spaces s WHERE s.deleted_at IS NULL AND ${levelSql('?', 's.id')} >= 3
      AND (? IS NULL OR s.id IN (SELECT a.value FROM ai_connections g, json_each(g.spaces_json) a WHERE g.id=? AND g.user_id=? AND g.revoked_at IS NULL AND g.expires_at>?)) LIMIT 1`)
    .bind(userId, connectorId ?? null, connectorId ?? null, userId, Date.now()).first();
  return !!row;
}
