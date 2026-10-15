/** Phase 5 capability contract. Inputs must describe CURRENT server authority.
 * The client may use the same decisions for presentation, never as a grant. */
export const WORKSPACE_ROLES = ['owner', 'admin', 'member', 'guest'] as const;
export const SPACE_ROLES = ['owner', 'admin', 'editor', 'commenter', 'viewer'] as const;
export type WorkspaceRole = typeof WORKSPACE_ROLES[number];
export type SpaceRole = typeof SPACE_ROLES[number];
export type ExportPolicy = 'members' | 'disabled';

export interface WorkspacePrincipal {
  id: string;
  workspaceRole: WorkspaceRole;
  disabledAt: number | null;
}

export interface AccessSpace {
  id: string;
  defaultAccess: 'members' | 'private';
  exportPolicy: ExportPolicy;
  deletedAt: number | null;
}

export interface SpaceMembership {
  role: SpaceRole;
  access: 'allow' | 'deny';
}

export interface SpaceAccess {
  principal: WorkspacePrincipal | null;
  space: AccessSpace | null;
  membership: SpaceMembership | null;
}

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === 'string' && (WORKSPACE_ROLES as readonly string[]).includes(value);
}

export function isSpaceRole(value: unknown): value is SpaceRole {
  return typeof value === 'string' && (SPACE_ROLES as readonly string[]).includes(value);
}

export function isActivePrincipal(principal: WorkspacePrincipal | null): principal is WorkspacePrincipal {
  return !!principal && typeof principal.id === 'string' && principal.id.length > 0
    && isWorkspaceRole(principal.workspaceRole) && principal.disabledAt === null;
}

/** Explicit membership (including deny/downgrade) precedes default access.
 * Workspace administration never implies access to a private space. */
export function effectiveSpaceRole({ principal, space, membership }: SpaceAccess): SpaceRole | null {
  if (!isActivePrincipal(principal) || !space || !space.id || space.deletedAt !== null) return null;
  if (space.defaultAccess !== 'members' && space.defaultAccess !== 'private') return null;
  if (membership !== null) {
    if (!membership || membership.access !== 'allow' || !isSpaceRole(membership.role)) return null;
    if (principal.workspaceRole === 'guest' && (membership.role === 'owner' || membership.role === 'admin')) return null;
    return membership.role;
  }
  return principal.workspaceRole !== 'guest' && space.defaultAccess === 'members' ? 'editor' : null;
}

export function canRead(access: SpaceAccess): boolean {
  return effectiveSpaceRole(access) !== null;
}

export function canComment(access: SpaceAccess): boolean {
  const role = effectiveSpaceRole(access);
  return role !== null && role !== 'viewer';
}

export function canEdit(access: SpaceAccess): boolean {
  const role = effectiveSpaceRole(access);
  return role === 'owner' || role === 'admin' || role === 'editor';
}

export function canManageMembers(access: SpaceAccess): boolean {
  const role = effectiveSpaceRole(access);
  return role === 'owner' || role === 'admin';
}

export const canManageSpace = canManageMembers;
/** Content soft deletion/restoration. Space deletion is a separate capability. */
export const canDelete = canEdit;
export const canRestore = canEdit;

export function canDeleteSpace(access: SpaceAccess): boolean {
  return effectiveSpaceRole(access) === 'owner';
}

export function canRestoreSpace(access: SpaceAccess): boolean {
  if (!access.space || access.space.deletedAt === null) return false;
  return effectiveSpaceRole({ ...access, space: { ...access.space, deletedAt: null } }) === 'owner';
}

export function canExport(access: SpaceAccess): boolean {
  return canRead(access) && access.principal?.workspaceRole !== 'guest'
    && access.space?.exportPolicy === 'members';
}

/** Editing/deleting comments is author-restricted even for content editors.
 * Callers still allowlist comment fields; this does not permit changing author
 * or target IDs and is not a grant to write another collection. */
export function canEditComment(access: SpaceAccess, authorId: string): boolean {
  const role = effectiveSpaceRole(access);
  return role === 'owner' || role === 'admin'
    || (canComment(access) && authorId === access.principal?.id);
}

export function canMove(source: SpaceAccess, destination: SpaceAccess): boolean {
  return source.principal?.id === destination.principal?.id && canEdit(source) && canEdit(destination);
}

export function canManageWorkspace(principal: WorkspacePrincipal | null): boolean {
  return isActivePrincipal(principal) && (principal.workspaceRole === 'owner' || principal.workspaceRole === 'admin');
}

export function canCreateSpace(principal: WorkspacePrincipal | null): boolean {
  return isActivePrincipal(principal) && principal.workspaceRole !== 'guest';
}

/** Owner transfer requires a dedicated last-owner-safe transaction. */
export function canGrantSpaceRole(access: SpaceAccess, targetRole: WorkspaceRole, grant: SpaceRole): boolean {
  if (!canManageMembers(access) || !isWorkspaceRole(targetRole) || !isSpaceRole(grant) || grant === 'owner') return false;
  if (targetRole === 'guest' && grant === 'admin') return false;
  return grant !== 'admin' || effectiveSpaceRole(access) === 'owner';
}
