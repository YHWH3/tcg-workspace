/** Phase 5 server authority loader. Activation stays off until every read/write
 * surface is integrated. There is no global consistency token: concurrent change is
 * caught by the caller's capability fence (capability.ts) and by record revisions. */
import type { ConnectorAuthority } from './connectorAccess';
import {
  canRead, isSpaceRole, isWorkspaceRole,
  type AccessSpace, type SpaceAccess, type SpaceMembership, type WorkspacePrincipal,
} from '../shared/access';

export const CORE_SPACE_ID = 'space-core';
export const MAX_ACCESS_SPACES = 500;

export interface AccessContext {
  readonly userId: string;
  readonly principal: WorkspacePrincipal | null;
  readonly enabled: boolean;
  readonly spaces: ReadonlyMap<string, SpaceAccess>;
  /** Optional read-graph revision fence, evaluated in the authority batch. */
  readonly recordsCurrent?: boolean;
  readonly connector?: ConnectorAuthority;
}

interface PrincipalRow { id: string; workspace_role: unknown; disabled_at: number | null }
interface SpaceRow {
  id: string; guest_directory_restricted:number; default_access: unknown; export_policy: unknown; deleted_at: number | null;
  member_user_id: string | null; member_role: unknown; member_access: unknown;
}

export class AccessError extends Error {
  constructor(public readonly code: 'invalid_access_request' | 'permission_schema_unavailable' | 'permission_context_invalid') {
    super(code); this.name = 'AccessError';
  }
}

/** A single D1 read batch gives one coherent principal/activation/membership view.
 * Call once for all candidate spaces, never once per candidate record. */
export async function loadAccessContext(db: D1Database, userId: string, spaceIds: readonly string[], recordRevisions?: ReadonlyMap<string, number>, connector?: ConnectorAuthority): Promise<AccessContext> {
  const ids = [...new Set(spaceIds)];
  if (typeof userId !== 'string' || !userId || userId.length > 64 || ids.length > MAX_ACCESS_SPACES
      || ids.some(id => typeof id !== 'string' || !id || id.length > 64)) throw new AccessError('invalid_access_request');
  const batch = await db.batch([
    db.prepare('SELECT id,COALESCE(workspace_role,role) workspace_role,disabled_at FROM users WHERE id=?').bind(userId),
    db.prepare('SELECT enabled FROM access_state WHERE id=1'),
    db.prepare(`SELECT s.id,s.default_access,s.export_policy,s.deleted_at,s.guest_directory_restricted,
      m.user_id member_user_id,m.role member_role,m.access member_access
      FROM spaces s LEFT JOIN space_members m ON m.space_id=s.id AND m.user_id=?
      WHERE s.id IN (SELECT value FROM json_each(?))`).bind(userId, JSON.stringify(ids)),
    ...(recordRevisions ? [db.prepare(`SELECT NOT EXISTS(
      SELECT 1 FROM json_each(?) e LEFT JOIN records r ON r.id=e.key WHERE r.seq IS NOT e.value
    ) AS valid`).bind(JSON.stringify(Object.fromEntries(recordRevisions)))] : []),
    ...(connector ? [db.prepare('SELECT spaces_json,version FROM ai_connections WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?').bind(connector.id,userId,Date.now())] : []),
  ]);
  const [principalResult,stateResult,spaceResult,revisionResult]=batch;
  const connectorResult=connector?batch[recordRevisions?4:3]:undefined;
  const state = stateResult.results[0] as { enabled: number } | undefined;
  if (!state || ![0, 1].includes(state.enabled)) throw new AccessError('permission_schema_unavailable');
  const row = principalResult.results[0] as PrincipalRow | undefined;
  const principal: WorkspacePrincipal | null = row && isWorkspaceRole(row.workspace_role)
    ? { id: row.id, workspaceRole: row.workspace_role, disabledAt: row.disabled_at } : null;
  const grant = connectorResult?.results[0] as {spaces_json:string;version:number}|undefined;
  const approved = connector ? new Set<string>(grant ? JSON.parse(grant.spaces_json) : []) : null;
  const spaces = new Map<string, SpaceAccess>();
  for (const s of spaceResult.results as unknown as SpaceRow[]) {
    // Invalid stored authority never falls back to a permissive default.
    let space: AccessSpace | null = null;
    if ((s.default_access === 'members' || s.default_access === 'private')
        && (s.export_policy === 'members' || s.export_policy === 'disabled')) {
      space = { id: s.id, defaultAccess: s.default_access, exportPolicy: s.export_policy, deletedAt: s.deleted_at,guestDirectoryRestricted:s.guest_directory_restricted===1 };
    }
    let membership: SpaceMembership | null = null;
    if (s.member_user_id !== null) {
      if (!isSpaceRole(s.member_role) || (s.member_access !== 'allow' && s.member_access !== 'deny')) space = null;
      else membership = { role: s.member_role, access: s.member_access };
    }
    spaces.set(s.id, { principal, space: approved && !approved.has(s.id) ? null : space, membership });
  }
  return { userId, principal, ...(connector ? {connector:{id:connector.id,version:grant?.version ?? -1}} : {}), enabled: state.enabled === 1, spaces, ...(recordRevisions ? {recordsCurrent:(revisionResult.results[0] as {valid?:number}|undefined)?.valid===1}: {}) };
}

export function spaceAccess(context: AccessContext, spaceId: string): SpaceAccess {
  return context.spaces.get(spaceId) ?? { principal: context.principal, space: null, membership: null };
}

export function readableSpaceIds(context: AccessContext): string[] {
  return [...context.spaces].filter(([, access]) => canRead(access)).map(([id]) => id);
}
