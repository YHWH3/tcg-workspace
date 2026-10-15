import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_ROLES, SPACE_ROLES, canComment, canCreateSpace, canDelete,
  canDeleteSpace, canEdit, canEditComment, canExport, canGrantSpaceRole,
  canManageMembers, canManageSpace, canManageWorkspace, canMove, canRead,
  canRestore, canRestoreSpace, effectiveSpaceRole, isSpaceRole, isWorkspaceRole,
  type SpaceAccess, type SpaceRole, type WorkspaceRole,
} from '../shared/access';

const access = (workspaceRole: WorkspaceRole = 'member', role: SpaceRole | null = null): SpaceAccess => ({
  principal: { id: 'alice', workspaceRole, disabledAt: null },
  space: { id: 'core', defaultAccess: 'members', exportPolicy: 'members', deletedAt: null },
  membership: role === null ? null : { role, access: 'allow' },
});

describe('Phase 5 server capability matrix', () => {
  it.each(WORKSPACE_ROLES)('%s: private space has no implicit workspace-role bypass', workspaceRole => {
    const a = access(workspaceRole); a.space!.defaultAccess = 'private';
    expect(effectiveSpaceRole(a)).toBeNull();
    for (const check of [canRead, canComment, canEdit, canDelete, canRestore, canManageMembers, canManageSpace, canExport]) expect(check(a)).toBe(false);
  });

  it.each(WORKSPACE_ROLES)('%s: Core default access preserves only non-guest editing', workspaceRole => {
    const a = access(workspaceRole);
    expect(effectiveSpaceRole(a)).toBe(workspaceRole === 'guest' ? null : 'editor');
    expect(canEdit(a)).toBe(workspaceRole !== 'guest');
    expect(canManageMembers(a)).toBe(false);
  });

  for (const workspaceRole of WORKSPACE_ROLES) {
    it.each(SPACE_ROLES)(`${workspaceRole}/%s: explicit capability matrix`, role => {
      const a = access(workspaceRole, role);
      const invalidGuest = workspaceRole === 'guest' && (role === 'owner' || role === 'admin');
      expect(effectiveSpaceRole(a)).toBe(invalidGuest ? null : role);
      expect(canRead(a)).toBe(!invalidGuest);
      expect(canComment(a)).toBe(!invalidGuest && role !== 'viewer');
      expect(canEdit(a)).toBe(!invalidGuest && ['owner', 'admin', 'editor'].includes(role));
      expect(canDelete(a)).toBe(canEdit(a)); expect(canRestore(a)).toBe(canEdit(a));
      expect(canManageMembers(a)).toBe(!invalidGuest && ['owner', 'admin'].includes(role));
      expect(canDeleteSpace(a)).toBe(!invalidGuest && role === 'owner');
      expect(canExport(a)).toBe(!invalidGuest && workspaceRole !== 'guest');
    });
  }

  it.each(WORKSPACE_ROLES)('%s: explicit deny and viewer downgrade override defaults', workspaceRole => {
    const a = access(workspaceRole, 'viewer');
    expect(canRead(a)).toBe(true); expect(canEdit(a)).toBe(false);
    a.membership!.access = 'deny';
    expect(canRead(a)).toBe(false); expect(canEdit(a)).toBe(false);
  });

  it('rejects missing, disabled or invalid identity and malformed stored grants', () => {
    const cases: SpaceAccess[] = [
      { ...access(), principal: null }, { ...access(), space: null },
      { ...access(), principal: { ...access().principal!, id: '' } },
      { ...access(), principal: { ...access().principal!, disabledAt: 0 } },
      { ...access(), space: { ...access().space!, deletedAt: 0 } },
    ];
    const malformed: SpaceAccess = JSON.parse(JSON.stringify(access()));
    Object.assign(malformed.principal!, { workspaceRole: 'superadmin' }); cases.push(malformed);
    const malformedRole: SpaceAccess = JSON.parse(JSON.stringify(access('member', 'viewer')));
    Object.assign(malformedRole.membership!, { role: 'superadmin' }); cases.push(malformedRole);
    const malformedDefault: SpaceAccess = JSON.parse(JSON.stringify(access()));
    Object.assign(malformedDefault.space!, { defaultAccess: 'everyone' }); cases.push(malformedDefault);
    for (const a of cases) {
      for (const check of [canRead, canComment, canEdit, canManageMembers, canExport]) expect(check(a)).toBe(false);
    }
    expect(isWorkspaceRole(null)).toBe(false); expect(isSpaceRole('superadmin')).toBe(false);
  });

  it('restricts comment updates to the author or space administrators', () => {
    for (const role of SPACE_ROLES) {
      const a = access('member', role);
      expect(canEditComment(a, 'alice')).toBe(role !== 'viewer');
      expect(canEditComment(a, 'bob')).toBe(role === 'owner' || role === 'admin');
    }
  });

  it('requires both editable spaces and the same identity for moves', () => {
    const source = access('member', 'editor'); const destination = access('member', 'editor');
    destination.space!.id = 'destination';
    expect(canMove(source, destination)).toBe(true);
    destination.membership!.role = 'viewer'; expect(canMove(source, destination)).toBe(false);
    destination.membership!.role = 'editor'; destination.principal!.id = 'bob';
    expect(canMove(source, destination)).toBe(false);
  });

  it('keeps workspace management distinct and refuses guest space creation', () => {
    for (const role of WORKSPACE_ROLES) {
      expect(canManageWorkspace(access(role).principal)).toBe(role === 'admin' || role === 'owner');
      expect(canCreateSpace(access(role).principal)).toBe(role !== 'guest');
    }
    expect(canManageWorkspace(null)).toBe(false); expect(canCreateSpace(null)).toBe(false);
  });

  it('does not grant owner via ordinary membership or let space admins grant admin', () => {
    for (const actor of SPACE_ROLES) for (const target of WORKSPACE_ROLES) for (const grant of SPACE_ROLES) {
      const expected = ['owner', 'admin'].includes(actor) && grant !== 'owner'
        && !(grant === 'admin' && (target === 'guest' || actor !== 'owner'));
      expect(canGrantSpaceRole(access('member', actor), target, grant)).toBe(expected);
    }
  });

  it('allows only an explicit owner to restore a deleted space', () => {
    for (const role of SPACE_ROLES) {
      const a = access('member', role); a.space!.deletedAt = 12;
      expect(canRead(a)).toBe(false); expect(canRestoreSpace(a)).toBe(role === 'owner');
    }
    expect(canRestoreSpace(access('owner', 'owner'))).toBe(false);
  });

  it('requires explicit export policy and never exports as a guest', () => {
    const a = access('member', 'editor'); a.space!.exportPolicy = 'disabled';
    expect(canExport(a)).toBe(false);
    expect(canExport(access('guest', 'editor'))).toBe(false);
    expect(canExport(access('member', 'viewer'))).toBe(true);
  });
});
