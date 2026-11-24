import { describe, expect, it } from 'vitest';
import {
  ALL_SCOPE,
  CRM_CAPABILITIES,
  CRM_CAPABILITY_LABELS,
  CRM_CHANNELS,
  PROGRAMME_SCOPED,
  isCrmCapability,
} from '../shared/crm/capabilities';
import {
  CRM_PROJECTION_PREFIX,
  isCrmProjectionKey,
} from '../shared/crm/projection';
import {
  AUDIT_PAGE_LIMIT,
  CAPABILITY_INVALID_REASONS,
  CRM_COMMAND_CHANNELS,
  CRM_CONTRACT_VERSION,
  CRM_CURSOR_ID_PATTERN,
  CRM_ERROR_CODES,
  CRM_ERROR_RETRYABLE,
  CapabilityAuditPageSchema,
  CapabilityChangeInputSchema,
  CapabilityChangeOutputSchema,
  CapabilityChangeRequestInputSchema,
  CapabilityChangeResultSchema,
  CapabilityOverviewSchema,
  CommandErrorSchema,
  CommandRequestEnvelopeSchema,
  CrmHttpErrorSchema,
  CrmRetryableHttpErrorSchema,
  CrmStatusSchema,
  MAX_CAPABILITY_REASON_CHARS,
  MAX_COMMAND_BODY_BYTES,
  MAX_COMMAND_RESULT_BYTES,
  MAX_EXPECTED_ENTRIES,
  OWNER_PROTECTED_ERROR,
  REQUEST_ID_PATTERN,
  S0ScopeSchema,
  commandResultSchema,
} from '../shared/crm/contracts';
import { z } from 'zod';

describe('CRM S0 shared contracts (crm-s0-v2)', () => {
  it('pins contract constants and capability catalogue (SC-1, SC-2, SC-3, SC-6)', () => {
    expect(CRM_CONTRACT_VERSION).toBe('crm-s0-v2');
    expect(MAX_COMMAND_BODY_BYTES).toBe(65_536);
    expect(MAX_COMMAND_RESULT_BYTES).toBe(16_384);
    expect(MAX_EXPECTED_ENTRIES).toBe(100);
    expect(AUDIT_PAGE_LIMIT).toBe(50);
    expect(MAX_CAPABILITY_REASON_CHARS).toBe(500);
    expect(OWNER_PROTECTED_ERROR).toBe('owner_protected');
    expect(ALL_SCOPE).toBe('*');
    expect(CRM_PROJECTION_PREFIX).toBe('_crm_');
    expect(CRM_CHANNELS).toEqual(['email', 'whatsapp', 'instagram', 'facebook']);
    expect(CRM_COMMAND_CHANNELS).toEqual(['ui', 'mcp', 'automation', 'ingest']);

    expect(CRM_CAPABILITIES).toHaveLength(13);
    expect(new Set(CRM_CAPABILITIES).size).toBe(13);
    expect(Object.keys(CRM_CAPABILITY_LABELS).sort()).toEqual([...CRM_CAPABILITIES].sort());
    for (const cap of CRM_CAPABILITIES) {
      expect(isCrmCapability(cap)).toBe(true);
      expect(CRM_CAPABILITY_LABELS[cap].label.length).toBeGreaterThan(0);
      expect(CRM_CAPABILITY_LABELS[cap].description.length).toBeGreaterThan(0);
    }
    expect(isCrmCapability('crm.unknown')).toBe(false);
    expect([...PROGRAMME_SCOPED].sort()).toEqual(['crm.configure', 'crm.restricted.read']);

    expect(isCrmProjectionKey('_crm_stage')).toBe(true);
    expect(isCrmProjectionKey('_crm_')).toBe(true);
    expect(isCrmProjectionKey('_other')).toBe(false);
    expect(isCrmProjectionKey('crm_stage')).toBe(false);
  });

  it('validates requestId and command envelope bounds (SC-1, SC-4)', () => {
    expect(REQUEST_ID_PATTERN.test('abc12345')).toBe(true);
    expect(REQUEST_ID_PATTERN.test('a'.repeat(64))).toBe(true);
    expect(REQUEST_ID_PATTERN.test('short77')).toBe(false);
    expect(REQUEST_ID_PATTERN.test('a'.repeat(65))).toBe(false);
    expect(REQUEST_ID_PATTERN.test('bad:colon123')).toBe(false);
    expect(CRM_CURSOR_ID_PATTERN.test('audit_id-1234')).toBe(true);
    expect(CRM_CURSOR_ID_PATTERN.test('bad')).toBe(false);

    expect(CommandRequestEnvelopeSchema.safeParse({
      requestId: 'req_12345678',
      input: { userId: 'bob' },
      expected: { rec1: 0, rec2: 42 },
    }).success).toBe(true);

    // Rejects > 100 expected entries, negative or non-integer expected values, extra keys
    const tooMany = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`r${i}`, i]));
    expect(CommandRequestEnvelopeSchema.safeParse({
      requestId: 'req_12345678',
      input: {},
      expected: tooMany,
    }).success).toBe(false);
    expect(CommandRequestEnvelopeSchema.safeParse({
      requestId: 'req_12345678',
      input: {},
      expected: { r1: -1 },
    }).success).toBe(false);
    expect(CommandRequestEnvelopeSchema.safeParse({
      requestId: 'req_12345678',
      input: {},
      expected: { r1: 1.5 },
    }).success).toBe(false);
    expect(CommandRequestEnvelopeSchema.safeParse({
      requestId: 'req_12345678',
      input: {},
      extra: true,
    }).success).toBe(false);
  });

  it('enforces exact retryable mapping on CommandErrorSchema (SC-1)', () => {
    expect(CRM_ERROR_CODES).toHaveLength(15);
    for (const code of CRM_ERROR_CODES) {
      const expected = CRM_ERROR_RETRYABLE[code];
      expect(CommandErrorSchema.safeParse({ ok: false, error: code, retryable: expected }).success).toBe(true);
      expect(CommandErrorSchema.safeParse({ ok: false, error: code, retryable: !expected }).success).toBe(false);
    }
    expect(CRM_ERROR_RETRYABLE.stale).toBe(true);
    expect(CRM_ERROR_RETRYABLE.provider_unavailable).toBe(true);
    expect(CRM_ERROR_RETRYABLE.source_changed).toBe(true);
    expect(CRM_ERROR_RETRYABLE.forbidden).toBe(false);
    expect(CRM_ERROR_RETRYABLE.idempotency_conflict).toBe(false);
    expect(CRM_ERROR_RETRYABLE.budget_exceeded).toBe(false);
  });

  it('validates HTTP error, result, status, overview, audit, and capability change schemas (SC-4, SC-5)', () => {
    expect(CrmHttpErrorSchema.safeParse({ error: 'not_found' }).success).toBe(true);
    expect(CrmHttpErrorSchema.safeParse({ error: '' }).success).toBe(false);
    expect(CrmRetryableHttpErrorSchema.safeParse({ error: 'processing_budget', retryable: true }).success).toBe(true);
    expect(CrmRetryableHttpErrorSchema.safeParse({ error: 'write_interrupted', retryable: true }).success).toBe(true);
    expect(CrmRetryableHttpErrorSchema.safeParse({ error: 'other', retryable: true }).success).toBe(false);

    const genericResult = commandResultSchema(z.object({ okFlag: z.boolean() }).strict());
    expect(genericResult.safeParse({
      ok: true,
      commandId: 'cmd_123',
      result: { okFlag: true },
      projections: [{ recordId: 'task-1', rev: 3 }],
    }).success).toBe(true);
    expect(genericResult.safeParse({
      ok: true,
      commandId: 'cmd_123',
      result: { okFlag: true },
      projections: [{ recordId: 'task-1', rev: 0 }],
    }).success).toBe(false);

    expect(CrmStatusSchema.safeParse({
      contract: 'crm-s0-v2',
      enabled: true,
      access: true,
      owner: true,
      capabilities: CRM_CAPABILITIES.map((capability) => ({ capability, scope: '*' })),
    }).success).toBe(true);
    expect(CrmStatusSchema.safeParse({
      contract: 'crm-s0-v1',
      enabled: false,
      access: false,
      owner: false,
      capabilities: [],
    }).success).toBe(false);

    expect(CapabilityOverviewSchema.safeParse({
      accounts: [{
        userId: 'u1',
        name: 'Alice',
        username: 'alice',
        role: 'owner',
        disabled: false,
        eligible: true,
        implicitAll: true,
        effectiveAccess: true,
        grants: [],
      }],
    }).success).toBe(true);

    expect(CapabilityAuditPageSchema.safeParse({
      items: [{
        id: 'audit_12345678',
        createdAt: 1700000000000,
        actorId: 'u1',
        actorName: null,
        targetUserId: 'u2',
        targetName: 'Bob',
        action: 'revoke',
        capability: 'crm.access',
        scope: '*',
        reason: 'account_disabled',
      }],
      next: null,
    }).success).toBe(true);

    // Wire schema accepts unknown capability & scope strings so command handler returns business invalid_input
    expect(CapabilityChangeRequestInputSchema.safeParse({
      userId: 'bob',
      capability: 'crm.future',
      scope: 'prog-1',
      reason: '   padded   ',
    }).success).toBe(true);

    // Strict schema enforces known capability and '*' scope
    expect(CapabilityChangeInputSchema.safeParse({
      userId: 'bob',
      capability: 'crm.access',
      scope: '*',
      reason: 'onboard',
    }).success).toBe(true);
    expect(CapabilityChangeInputSchema.safeParse({
      userId: 'bob',
      capability: 'crm.future',
      scope: '*',
    }).success).toBe(false);
    expect(S0ScopeSchema.safeParse('*').success).toBe(true);
    expect(S0ScopeSchema.safeParse('prog-1').success).toBe(false);

    expect(CapabilityChangeOutputSchema.safeParse({
      already: false,
      grant: { userId: 'bob', capability: 'crm.access', scope: '*', held: true },
    }).success).toBe(true);
    expect(CapabilityChangeResultSchema.safeParse({
      ok: true,
      commandId: 'cmd_1234',
      result: { already: true, grant: { userId: 'bob', capability: 'crm.access', scope: '*', held: true } },
      projections: [],
    }).success).toBe(true);

    expect(CAPABILITY_INVALID_REASONS).toEqual([
      'guest_not_eligible',
      'self_grant',
      'owner_implicit',
      'unknown_capability',
      'unknown_scope',
      'account_disabled',
      'not_admin',
    ]);
  });
});
