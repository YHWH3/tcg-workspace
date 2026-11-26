import { describe, expect, it } from 'vitest';
import {
  derivePaymentStatus,
  evaluateEffectiveMembershipState,
  formatMemberIdentifier,
  formatMinorMoney,
  isForeignCurrencyBlocked,
  requiresIndependentRefundApproval,
  summarizeLedgerByCurrency,
} from '../shared/crm/operations';

describe('P4 shared operational & money helpers', () => {
  it('computes integer minor-unit totals isolated strictly by ISO 4217 currency (never mixes currencies)', () => {
    const totals = summarizeLedgerByCurrency([
      { kind: 'receipt', amountMinor: 150000, currency: 'INR' },
      { kind: 'receipt', amountMinor: 50000, currency: 'INR' },
      { kind: 'refund', amountMinor: -25000, currency: 'INR' },
      { kind: 'receipt', amountMinor: 10000, currency: 'USD' },
      { kind: 'reversal', amountMinor: -10000, currency: 'USD' },
    ]);
    expect(totals).toEqual([
      {
        currency: 'INR',
        receiptsMinor: 200000,
        reversalsMinor: 0,
        refundsMinor: -25000,
        adjustmentsMinor: 0,
        netMinor: 175000,
      },
      {
        currency: 'USD',
        receiptsMinor: 10000,
        reversalsMinor: -10000,
        refundsMinor: 0,
        adjustmentsMinor: 0,
        netMinor: 0,
      },
    ]);
    expect(isForeignCurrencyBlocked('INR')).toBe(false);
    expect(isForeignCurrencyBlocked('USD')).toBe(true);
    expect(formatMinorMoney(175000, 'INR')).toContain('1,750.00');
  });

  it('derives authoritative payment status from ledger net vs due', () => {
    expect(derivePaymentStatus({ dueMinor: 50000, netPaidMinor: 0 })).toBe('unpaid');
    expect(derivePaymentStatus({ dueMinor: 50000, netPaidMinor: 20000 })).toBe('part_paid');
    expect(derivePaymentStatus({ dueMinor: 50000, netPaidMinor: 50000 })).toBe('paid');
    expect(derivePaymentStatus({ dueMinor: 50000, netPaidMinor: 65000 })).toBe('overpaid');
    expect(derivePaymentStatus({ dueMinor: 50000, netPaidMinor: 50000, hasPendingRefund: true })).toBe('refund_pending');
    expect(derivePaymentStatus({ dueMinor: 50000, netPaidMinor: 0, hasIssuedRefund: true })).toBe('refunded');
  });

  it('fails closed on unconfigured refund approval thresholds (always requires independent approval)', () => {
    expect(requiresIndependentRefundApproval(100, null)).toBe(true);
    expect(requiresIndependentRefundApproval(100, undefined)).toBe(true);
    expect(requiresIndependentRefundApproval(50000, 50000)).toBe(false);
    expect(requiresIndependentRefundApproval(50001, 50000)).toBe(true);
  });

  it('formats configurable member identifiers without assuming historical defaults and computes renewal/lapse states', () => {
    expect(formatMemberIdentifier(null, 4, 1)).toBeNull();
    expect(formatMemberIdentifier('CR', null, 1)).toBeNull();
    expect(formatMemberIdentifier('CR', 4, 7)).toBe('CR-0007');

    const now = 1_760_000_000_000;
    const day = 86_400_000;
    expect(
      evaluateEffectiveMembershipState({
        storedState: 'active',
        validUntil: now + 60 * day,
        renewalNoticeDays: 30,
        now,
      }),
    ).toBe('active');
    expect(
      evaluateEffectiveMembershipState({
        storedState: 'active',
        validUntil: now + 10 * day,
        renewalNoticeDays: 30,
        now,
      }),
    ).toBe('renewal_due');
    expect(
      evaluateEffectiveMembershipState({
        storedState: 'active',
        validUntil: now - 1000,
        renewalNoticeDays: 30,
        now,
      }),
    ).toBe('lapsed');
  });
});
