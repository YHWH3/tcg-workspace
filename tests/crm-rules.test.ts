import { describe, expect, it } from 'vitest';
import { CRM_CAPABILITIES } from '../shared/crm/capabilities';
import {
  canAccessCrmApi,
  canManageCapabilities,
  canTouchCapability,
  effectiveCapabilitiesForUser,
  evaluateCapability,
  hasEffectiveAccess,
  isCrmEnabled,
  parseCapabilityChangeInput,
  planCapabilityChange,
  type CrmActor,
} from '../worker/crm/rules';

const grant = (capability: CrmActor['grants'][number]['capability'], scope = '*') => ({
  capability,
  scope,
  grantedBy: 'owner-1',
  grantedAt: 1000,
});

describe('CRM capability rules (SC-2, SC-5, SC-9)', () => {
  it('parses CRM_ENABLED strictly per SC-9', () => {
    expect(isCrmEnabled({})).toBe(false);
    expect(isCrmEnabled({ CRM_ENABLED: '' })).toBe(false);
    expect(isCrmEnabled({ CRM_ENABLED: '0' })).toBe(false);
    expect(isCrmEnabled({ CRM_ENABLED: 'false' })).toBe(false);
    expect(isCrmEnabled({ CRM_ENABLED: 'yes' })).toBe(false);
    expect(isCrmEnabled({ CRM_ENABLED: '1' })).toBe(true);
    expect(isCrmEnabled({ CRM_ENABLED: ' 1 ' })).toBe(true);
    expect(isCrmEnabled({ CRM_ENABLED: 'true' })).toBe(true);
    expect(isCrmEnabled({ CRM_ENABLED: 'TRUE' })).toBe(true);
  });

  it('enforces owner implicit all, guest zero, and non-implication of admin/member roles (SC-2.1)', () => {
    const owner: CrmActor = { id: 'owner', role: 'owner', disabled: false, grants: [] };
    expect(hasEffectiveAccess(owner)).toBe(true);
    expect(canAccessCrmApi(owner)).toBe(true);
    expect(canManageCapabilities(owner)).toBe(true);
    expect(canTouchCapability(owner, 'crm.capabilities.manage')).toBe(true);
    for (const cap of CRM_CAPABILITIES) {
      expect(evaluateCapability(owner, cap, '*')).toBe(true);
      expect(evaluateCapability(owner, cap, 'prog-1')).toBe(true);
    }
    expect(effectiveCapabilitiesForUser(owner, true)).toHaveLength(13);
    expect(effectiveCapabilitiesForUser(owner, false)).toEqual([]);

    const disabledOwner: CrmActor = { ...owner, disabled: true };
    expect(hasEffectiveAccess(disabledOwner)).toBe(false);
    expect(evaluateCapability(disabledOwner, 'crm.access')).toBe(false);
    expect(effectiveCapabilitiesForUser(disabledOwner, true)).toEqual([]);

    const guestWithRow: CrmActor = {
      id: 'guest',
      role: 'guest',
      disabled: false,
      grants: [grant('crm.access'), grant('crm.finance.read')],
    };
    expect(hasEffectiveAccess(guestWithRow)).toBe(false);
    expect(evaluateCapability(guestWithRow, 'crm.access')).toBe(false);
    expect(evaluateCapability(guestWithRow, 'crm.finance.read')).toBe(false);
    expect(effectiveCapabilitiesForUser(guestWithRow, true)).toEqual([]);

    const plainAdmin: CrmActor = { id: 'admin', role: 'admin', disabled: false, grants: [] };
    expect(hasEffectiveAccess(plainAdmin)).toBe(false);
    expect(canManageCapabilities(plainAdmin)).toBe(false);
    expect(effectiveCapabilitiesForUser(plainAdmin, true)).toEqual([]);
  });

  it('enforces crm.access prerequisite over all specialised capabilities and admin requirement for manage (CR-03)', () => {
    // Admin with crm.capabilities.manage + crm.finance.read WITHOUT crm.access gets zero effective capabilities.
    const adminNoAccess: CrmActor = {
      id: 'admin1',
      role: 'admin',
      disabled: false,
      grants: [grant('crm.capabilities.manage'), grant('crm.finance.read')],
    };
    expect(hasEffectiveAccess(adminNoAccess)).toBe(false);
    expect(evaluateCapability(adminNoAccess, 'crm.capabilities.manage')).toBe(false);
    expect(evaluateCapability(adminNoAccess, 'crm.finance.read')).toBe(false);
    expect(canManageCapabilities(adminNoAccess)).toBe(false);
    expect(effectiveCapabilitiesForUser(adminNoAccess, true)).toEqual([]);

    // Adding crm.access activates specialised grants; manage still cannot touch crm.capabilities.manage.
    const adminWithAccess: CrmActor = {
      ...adminNoAccess,
      grants: [grant('crm.access'), ...adminNoAccess.grants],
    };
    expect(hasEffectiveAccess(adminWithAccess)).toBe(true);
    expect(canManageCapabilities(adminWithAccess)).toBe(true);
    expect(canTouchCapability(adminWithAccess, 'crm.finance.read')).toBe(true);
    expect(canTouchCapability(adminWithAccess, 'crm.capabilities.manage')).toBe(false);
    expect(effectiveCapabilitiesForUser(adminWithAccess, true).map((c) => c.capability)).toEqual([
      'crm.access',
      'crm.capabilities.manage',
      'crm.finance.read',
    ]);

    // Demoting that admin to member immediately disables crm.capabilities.manage while preserving other grants.
    const demoted: CrmActor = { ...adminWithAccess, role: 'member' };
    expect(hasEffectiveAccess(demoted)).toBe(true);
    expect(evaluateCapability(demoted, 'crm.finance.read')).toBe(true);
    expect(evaluateCapability(demoted, 'crm.capabilities.manage')).toBe(false);
    expect(canManageCapabilities(demoted)).toBe(false);
    expect(effectiveCapabilitiesForUser(demoted, true).map((c) => c.capability)).toEqual([
      'crm.access',
      'crm.finance.read',
    ]);
  });

  it('parses capability change wire inputs in exact SC-5.1 steps 3-5 order', () => {
    // Step 3: structural & trimmed reason > 500 chars
    expect(parseCapabilityChangeInput({ userId: '', capability: 'crm.access', scope: '*' })).toMatchObject({
      ok: false,
      error: 'invalid_input',
    });
    expect(
      parseCapabilityChangeInput({
        userId: 'bob',
        capability: 'crm.access',
        scope: '*',
        reason: 'a'.repeat(501),
      }),
    ).toMatchObject({ ok: false, error: 'invalid_input' });
    // Padded whitespace whose trimmed length <= 500 passes and trims
    expect(
      parseCapabilityChangeInput({
        userId: 'bob',
        capability: 'crm.access',
        scope: '*',
        reason: `  ${'a'.repeat(500)}  `,
      }),
    ).toEqual({
      ok: true,
      input: { userId: 'bob', capability: 'crm.access', scope: '*', reason: 'a'.repeat(500) },
    });
    // Blank reason omitted
    expect(
      parseCapabilityChangeInput({
        userId: 'bob',
        capability: 'crm.access',
        scope: '*',
        reason: '   ',
      }),
    ).toEqual({
      ok: true,
      input: { userId: 'bob', capability: 'crm.access', scope: '*' },
    });

    // Step 4 before Step 5: unknown capability wins over unknown scope
    expect(
      parseCapabilityChangeInput({
        userId: 'bob',
        capability: 'crm.nope',
        scope: 'prog-1',
      }),
    ).toEqual({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'unknown_capability', fields: { capability: 'unknown_capability' } },
    });

    // Step 5: known capability with non-'*' scope returns unknown_scope
    expect(
      parseCapabilityChangeInput({
        userId: 'bob',
        capability: 'crm.restricted.read',
        scope: 'prog-1',
      }),
    ).toEqual({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'unknown_scope', fields: { scope: 'unknown_scope' } },
    });
  });

  it('evaluates planCapabilityChange steps 8-15 deterministically (incl. not_admin grant-only)', () => {
    const owner: CrmActor = { id: 'owner', role: 'owner', disabled: false, grants: [] };
    const input = { userId: 'target', capability: 'crm.capabilities.manage' as const, scope: '*' as const };

    // 8: missing target
    expect(planCapabilityChange('grant', owner, input, null, null)).toEqual({
      ok: false,
      error: 'not_found',
    });
    // 9: owner_implicit takes precedence over self_grant when owner targets self
    expect(
      planCapabilityChange('grant', owner, { ...input, userId: 'owner' }, { id: 'owner', role: 'owner', disabled: false }, null),
    ).toEqual({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'owner_implicit' },
    });
    // 10: self_grant
    const admin: CrmActor = {
      id: 'admin',
      role: 'admin',
      disabled: false,
      grants: [grant('crm.access'), grant('crm.capabilities.manage')],
    };
    expect(
      planCapabilityChange(
        'grant',
        admin,
        { userId: 'admin', capability: 'crm.finance.read', scope: '*' },
        { id: 'admin', role: 'admin', disabled: false },
        null,
      ),
    ).toEqual({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'self_grant' },
    });
    // 11: guest_not_eligible beats account_disabled
    expect(
      planCapabilityChange('grant', owner, input, { id: 'g1', role: 'guest', disabled: true }, null),
    ).toEqual({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'guest_not_eligible' },
    });
    // 12: account_disabled on grant, allowed on revoke
    expect(
      planCapabilityChange('grant', owner, input, { id: 'u1', role: 'member', disabled: true }, null),
    ).toEqual({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'account_disabled' },
    });
    expect(
      planCapabilityChange('revoke', owner, input, { id: 'u1', role: 'member', disabled: true }, grant('crm.capabilities.manage')),
    ).toEqual({ ok: true, already: false, held: false });
    // 13: not_admin on grant, NOT on revoke (owner can clean up dormant manage grant on demoted member)
    expect(
      planCapabilityChange('grant', owner, input, { id: 'u1', role: 'member', disabled: false }, null),
    ).toEqual({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'not_admin' },
    });
    expect(
      planCapabilityChange('revoke', owner, input, { id: 'u1', role: 'member', disabled: false }, grant('crm.capabilities.manage')),
    ).toEqual({ ok: true, already: false, held: false });
    // 14: already
    expect(
      planCapabilityChange('grant', owner, input, { id: 'a1', role: 'admin', disabled: false }, grant('crm.capabilities.manage')),
    ).toEqual({ ok: true, already: true, held: true });
    expect(
      planCapabilityChange('revoke', owner, input, { id: 'a1', role: 'admin', disabled: false }, null),
    ).toEqual({ ok: true, already: true, held: false });
  });
});
