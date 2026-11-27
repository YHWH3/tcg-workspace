import { describe, expect, it } from 'vitest';
import {
  allocatePaymentRequests,
  computeBookingAgreedDue,
  derivePaymentStatus,
  evaluateEffectiveMembershipState,
  evaluateMembershipPeriodCoverage,
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

  it('computes authoritative booking due, per-request payment allocation, and historical membership period coverage', () => {
    expect(computeBookingAgreedDue({ unitAmountMinor: 100000, seats: 2, currency: 'INR' })).toEqual({
      dueMinor: 200000,
      currency: 'INR',
    });
    expect(computeBookingAgreedDue({ unitAmountMinor: null, seats: 2, currency: 'INR' })).toBeNull();
    expect(computeBookingAgreedDue({ unitAmountMinor: 0, seats: 2, currency: 'INR' })).toEqual({
      dueMinor: 0,
      currency: 'INR',
    });
    expect(computeBookingAgreedDue({ unitAmountMinor: 100000, seats: 0, currency: 'INR' })).toBeNull();

    // Direct receipt against request 1 leaves request 2 issued; unlinked receipt allocates FIFO
    const alloc1 = allocatePaymentRequests(
      [
        { id: 'pr1', amountMinor: 10000, createdAt: 1 },
        { id: 'pr2', amountMinor: 190000, createdAt: 2 },
      ],
      [{ amountMinor: 10000, paymentRequestId: 'pr1' }],
    );
    expect(alloc1.map((r) => ({ id: r.id, state: r.state }))).toEqual([
      { id: 'pr1', state: 'paid' },
      { id: 'pr2', state: 'issued' },
    ]);

    const alloc2 = allocatePaymentRequests(
      [
        { id: 'pr1', amountMinor: 10000, createdAt: 1 },
        { id: 'pr2', amountMinor: 190000, createdAt: 2 },
      ],
      [
        { amountMinor: 10000, paymentRequestId: 'pr1' },
        { amountMinor: 200000, paymentRequestId: null },
      ],
    );
    expect(alloc2.map((r) => ({ id: r.id, state: r.state }))).toEqual([
      { id: 'pr1', state: 'paid' },
      { id: 'pr2', state: 'overpaid' },
    ]);

    // Historical periods preserve frozen contribution requirements (50k + 75k = 125k)
    const covFull = evaluateMembershipPeriodCoverage(
      [
        { id: 'mp1', periodNumber: 1, requiredAmountMinor: 50000, validFrom: 0, validUntil: 1000 },
        { id: 'mp2', periodNumber: 2, requiredAmountMinor: 75000, validFrom: 1000, validUntil: 2000 },
      ],
      125000,
    );
    expect(covFull.supportedPeriods.map((p) => p.id)).toEqual(['mp1', 'mp2']);
    expect(covFull.unsupportedPeriods).toEqual([]);
    expect(covFull.requiredActiveMinor).toBe(125000);

    // Refund of 30k leaves 95k -> Period 2 (needs 75k after 50k) is unsupported, Period 1 stays supported!
    const covPartial = evaluateMembershipPeriodCoverage(
      [
        { id: 'mp1', periodNumber: 1, requiredAmountMinor: 50000, validFrom: 0, validUntil: 1000 },
        { id: 'mp2', periodNumber: 2, requiredAmountMinor: 75000, validFrom: 1000, validUntil: 2000 },
      ],
      95000,
    );
    expect(covPartial.supportedPeriods.map((p) => p.id)).toEqual(['mp1']);
    expect(covPartial.unsupportedPeriods.map((p) => p.id)).toEqual(['mp2']);
    expect(covPartial.supportedPeriods[0]?.validUntil).toBe(1000);
  });
});
