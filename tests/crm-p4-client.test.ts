import { describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k),
});

const {
  describeCommandError,
  listOfflineBookingIntents,
  removeOfflineBookingIntent,
  saveOfflineBookingIntent,
} = await import('../src/apps/crm/api');

describe('CRM P4 client helpers: error clarity and account-scoped offline booking intents', () => {
  it('describes P4 policy, dual-control, foreign-block, and merge-ledger errors clearly', () => {
    expect(
      describeCommandError({
        ok: false,
        requestId: 'req_p4_001',
        error: 'invalid_input',
        detail: { reason: 'edition_policy_unconfigured_pending_O05' },
      }),
    ).toContain('O-05');

    expect(
      describeCommandError({
        ok: false,
        requestId: 'req_p4_002',
        error: 'invalid_input',
        detail: { reason: 'foreign_contribution_blocked_pending_policy' },
      }),
    ).toContain('O-14');

    expect(
      describeCommandError({
        ok: false,
        requestId: 'req_p4_003',
        error: 'invalid_input',
        detail: { reason: 'self_approval_forbidden' },
      }),
    ).toContain('cannot approve');

    expect(
      describeCommandError({
        ok: false,
        requestId: 'req_p4_004',
        error: 'invalid_input',
        detail: { reason: 'loser_has_financial_history_cannot_rewrite_ledger' },
      }),
    ).toContain('append-only');

    expect(
      describeCommandError({
        ok: false,
        requestId: 'req_p4_005',
        error: 'forbidden',
        detail: { reason: 'restricted_screening_authority_required' },
      }),
    ).toContain('crm.restricted.read');

    expect(
      describeCommandError({
        ok: false,
        requestId: 'req_p4_006',
        error: 'approval_required',
        detail: { reason: 'independent_refund_approval_required' },
      }),
    ).toContain('Independent refund approval');
  });

  it('stores offline booking intents strictly per account as visibly unconfirmed local requests', () => {
    storage.clear();
    const savedA = saveOfflineBookingIntent('user_a', {
      editionId: 'ed_1',
      editionTitle: 'Autumn Cohort',
      bookerPersonId: 'p_1',
      bookerName: 'Asha Rao',
      seats: 2,
      priceOptionId: 'standard',
      participantNames: ['Asha Rao'],
      notes: 'Draft while offline',
    });
    expect(savedA).not.toBeNull();
    expect(savedA?.state).toBe('unconfirmed_local_request');

    expect(listOfflineBookingIntents('user_a')).toHaveLength(1);
    expect(listOfflineBookingIntents('user_b')).toHaveLength(0);
    expect(listOfflineBookingIntents(null)).toHaveLength(0);

    removeOfflineBookingIntent('user_a', savedA!.id);
    expect(listOfflineBookingIntents('user_a')).toHaveLength(0);
  });
});
