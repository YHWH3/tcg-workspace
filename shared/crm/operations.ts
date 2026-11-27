import { z } from 'zod';

/* ---------- ISO 4217 Currency & Integer Minor-Unit Helpers ---------- */

export const ISO_CURRENCY_RE = /^[A-Z]{3}$/;

export const CurrencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(ISO_CURRENCY_RE, 'Must be a 3-letter ISO 4217 currency code');

export const IsoDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

/** Default domestic currency for TCG (India). Foreign currencies/contributors remain blocked pending O-14/C-03. */
export const DOMESTIC_ALLOWED_CURRENCIES = new Set<string>(['INR']);

export function isForeignCurrencyBlocked(currency: string): boolean {
  return !DOMESTIC_ALLOWED_CURRENCIES.has(currency.trim().toUpperCase());
}

/** Returns minor-unit decimal exponent for an ISO 4217 currency (e.g. INR -> 2, JPY -> 0). */
export function currencyMinorExponent(currency: string): number {
  try {
    const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() });
    return fmt.resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** Formats an integer minor-unit amount with its explicit ISO 4217 currency. Never mixes currencies. */
export function formatMinorMoney(amountMinor: number, currency: string): string {
  const code = currency.toUpperCase();
  const exp = currencyMinorExponent(code);
  const divisor = 10 ** exp;
  const major = amountMinor / divisor;
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: exp,
      maximumFractionDigits: exp,
    }).format(major);
  } catch {
    return `${code} ${major.toFixed(exp)}`;
  }
}

export interface CurrencyTotal {
  currency: string;
  receiptsMinor: number;
  reversalsMinor: number;
  refundsMinor: number;
  adjustmentsMinor: number;
  netMinor: number;
}

export interface LedgerEntryLike {
  kind: 'receipt' | 'reversal' | 'refund' | 'adjustment';
  amountMinor: number;
  currency: string;
}

/**
 * Computes strictly currency-isolated totals from append-only ledger entries.
 * NEVER sums two different currencies together.
 */
export function summarizeLedgerByCurrency(entries: readonly LedgerEntryLike[]): CurrencyTotal[] {
  const map = new Map<string, CurrencyTotal>();
  for (const e of entries) {
    const code = e.currency.toUpperCase();
    const cur = map.get(code) ?? {
      currency: code,
      receiptsMinor: 0,
      reversalsMinor: 0,
      refundsMinor: 0,
      adjustmentsMinor: 0,
      netMinor: 0,
    };
    if (e.kind === 'receipt') cur.receiptsMinor += e.amountMinor;
    else if (e.kind === 'reversal') cur.reversalsMinor += e.amountMinor;
    else if (e.kind === 'refund') cur.refundsMinor += e.amountMinor;
    else if (e.kind === 'adjustment') cur.adjustmentsMinor += e.amountMinor;
    cur.netMinor += e.amountMinor;
    map.set(code, cur);
  }
  return [...map.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

export type PaymentStatus = 'unpaid' | 'part_paid' | 'paid' | 'overpaid' | 'refund_pending' | 'refunded';

/**
 * Derives authoritative payment status purely from integer minor-unit ledger net vs total due
 * for a single currency. Never accepts floating point or cross-currency totals.
 */
export function derivePaymentStatus(args: {
  dueMinor: number;
  netPaidMinor: number;
  hasPendingRefund?: boolean;
  hasIssuedRefund?: boolean;
}): PaymentStatus {
  const { dueMinor, netPaidMinor, hasPendingRefund = false, hasIssuedRefund = false } = args;
  if (hasPendingRefund) return 'refund_pending';
  if (netPaidMinor <= 0) {
    return hasIssuedRefund ? 'refunded' : 'unpaid';
  }
  if (dueMinor <= 0) {
    return netPaidMinor > 0 ? 'overpaid' : 'unpaid';
  }
  if (netPaidMinor < dueMinor) return 'part_paid';
  if (netPaidMinor === dueMinor) return 'paid';
  return 'overpaid';
}

/**
 * Authoritative booking due derived strictly from agreed price option (`unitAmountMinor * seats`) and currency.
 * Returns null when the booking has no configured agreed price/currency.
 */
export function computeBookingAgreedDue(args: {
  unitAmountMinor: number | null;
  seats: number;
  currency: string | null;
}): { dueMinor: number; currency: string } | null {
  if (args.unitAmountMinor === null || !args.currency) return null;
  if (!Number.isInteger(args.unitAmountMinor) || args.unitAmountMinor < 0) return null;
  if (!Number.isInteger(args.seats) || args.seats <= 0) return null;
  return {
    dueMinor: args.unitAmountMinor * args.seats,
    currency: args.currency.trim().toUpperCase(),
  };
}

export interface PaymentRequestAllocationInput {
  id: string;
  amountMinor: number;
  createdAt: number;
}

export interface PaymentLedgerAllocationInput {
  paymentRequestId: string | null;
  amountMinor: number;
}

export interface PaymentRequestAllocationResult {
  id: string;
  allocatedMinor: number;
  state: PaymentRequestState;
}

/**
 * Deterministically allocates append-only ledger entries across open payment requests of a single object & currency:
 * 1. Entries explicitly referencing a `paymentRequestId` apply directly to that request.
 * 2. Remaining positive unlinked entries apply FIFO (`createdAt ASC, id ASC`) up to each request's due amount
 *    (any surplus beyond the final open request stays on the final request -> `overpaid`).
 * 3. Remaining negative unlinked entries (e.g., refunds) reduce allocated balances LIFO so refunded requests
 *    accurately transition back from `paid` -> `part_paid` / `issued`.
 */
export function allocatePaymentRequests(
  openRequests: readonly PaymentRequestAllocationInput[],
  entries: readonly PaymentLedgerAllocationInput[],
): PaymentRequestAllocationResult[] {
  if (openRequests.length === 0) return [];
  const ordered = [...openRequests].sort((a, b) =>
    a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt - b.createdAt,
  );
  const byId = new Map<string, number>();
  for (const req of ordered) byId.set(req.id, 0);

  let unlinkedPool = 0;
  for (const e of entries) {
    if (e.paymentRequestId && byId.has(e.paymentRequestId)) {
      byId.set(e.paymentRequestId, (byId.get(e.paymentRequestId) ?? 0) + e.amountMinor);
    } else {
      unlinkedPool += e.amountMinor;
    }
  }

  if (unlinkedPool > 0) {
    for (let i = 0; i < ordered.length && unlinkedPool > 0; i += 1) {
      const req = ordered[i]!;
      const cur = byId.get(req.id) ?? 0;
      const needed = Math.max(0, req.amountMinor - cur);
      if (needed > 0) {
        const take = Math.min(needed, unlinkedPool);
        byId.set(req.id, cur + take);
        unlinkedPool -= take;
      }
    }
    if (unlinkedPool > 0) {
      const last = ordered[ordered.length - 1]!;
      byId.set(last.id, (byId.get(last.id) ?? 0) + unlinkedPool);
      unlinkedPool = 0;
    }
  } else if (unlinkedPool < 0) {
    let deficit = -unlinkedPool;
    for (let i = ordered.length - 1; i >= 0 && deficit > 0; i -= 1) {
      const req = ordered[i]!;
      const cur = byId.get(req.id) ?? 0;
      if (cur > 0) {
        const deduct = Math.min(cur, deficit);
        byId.set(req.id, cur - deduct);
        deficit -= deduct;
      }
    }
  }

  return ordered.map((req) => {
    const allocatedMinor = byId.get(req.id) ?? 0;
    let state: PaymentRequestState;
    if (allocatedMinor <= 0) state = 'issued';
    else if (allocatedMinor < req.amountMinor) state = 'part_paid';
    else if (allocatedMinor === req.amountMinor) state = 'paid';
    else state = 'overpaid';
    return { id: req.id, allocatedMinor, state };
  });
}

export interface MembershipPeriodLike {
  id: string;
  periodNumber: number;
  requiredAmountMinor: number;
  validFrom: number;
  validUntil: number;
}

/**
 * Evaluates which active historical membership periods remain supported by `netPaidMinor`.
 * Historical periods are consumed in ascending order using each period's frozen `requiredAmountMinor`,
 * ensuring later scheme price changes never retroactively alter historical period requirements and
 * refunds/reversals never leave unsupported active periods.
 */
export function evaluateMembershipPeriodCoverage(
  activePeriods: readonly MembershipPeriodLike[],
  netPaidMinor: number,
): {
  supportedPeriods: MembershipPeriodLike[];
  unsupportedPeriods: MembershipPeriodLike[];
  requiredActiveMinor: number;
} {
  const ordered = [...activePeriods].sort((a, b) => a.periodNumber - b.periodNumber);
  const requiredActiveMinor = ordered.reduce((sum, p) => sum + p.requiredAmountMinor, 0);
  let remaining = Math.max(0, netPaidMinor);
  const supportedPeriods: MembershipPeriodLike[] = [];
  const unsupportedPeriods: MembershipPeriodLike[] = [];
  for (const p of ordered) {
    if (remaining >= p.requiredAmountMinor) {
      remaining -= p.requiredAmountMinor;
      supportedPeriods.push(p);
    } else {
      unsupportedPeriods.push(p);
    }
  }
  return { supportedPeriods, unsupportedPeriods, requiredActiveMinor };
}

/**
 * Evaluates whether a refund requires independent approval from a second person with `crm.refund.approve`.
 * Fail-closed: if policy threshold is null/undefined (unconfigured), independent approval is ALWAYS required!
 */
export function requiresIndependentRefundApproval(
  amountMinor: number,
  thresholdMinor: number | null | undefined,
): boolean {
  if (thresholdMinor === null || thresholdMinor === undefined) return true;
  return amountMinor > thresholdMinor;
}

/**
 * Formats a configurable member identifier using scheme prefix & zero-padded digits.
 * Returns null when the scheme has not configured an identifier format (never assumes historical format).
 */
export function formatMemberIdentifier(
  prefix: string | null | undefined,
  digits: number | null | undefined,
  seq: number,
): string | null {
  const cleanPrefix = prefix?.trim();
  if (!cleanPrefix || !digits || digits < 2 || digits > 10 || !Number.isInteger(seq) || seq <= 0) {
    return null;
  }
  return `${cleanPrefix}-${String(seq).padStart(digits, '0')}`;
}

/**
 * Computes effective membership display state taking `valid_until` and `renewal_notice_days` into account.
 */
export function evaluateEffectiveMembershipState(args: {
  storedState: MembershipState;
  validUntil: number | null;
  renewalNoticeDays: number | null;
  now: number;
}): MembershipState {
  const { storedState, validUntil, renewalNoticeDays, now } = args;
  if (storedState !== 'active' && storedState !== 'renewal_due') {
    return storedState;
  }
  if (validUntil === null) return storedState;
  if (validUntil <= now) return 'lapsed';
  const noticeMs = (renewalNoticeDays ?? 0) > 0 ? (renewalNoticeDays as number) * 86_400_000 : 0;
  if (noticeMs > 0 && validUntil - now <= noticeMs) {
    return 'renewal_due';
  }
  return 'active';
}

/* ---------- S6 Editions & Bookings Schemas ---------- */

export const EDITION_STATES = ['draft', 'open', 'closed', 'cancelled', 'completed'] as const;
export type EditionState = (typeof EDITION_STATES)[number];

export const BOOKING_STATES = [
  'request',
  'held',
  'awaiting_payment',
  'confirmed',
  'waitlisted',
  'offered',
  'paid_without_seat',
  'cancelled',
  'expired',
  'completed',
] as const;
export type BookingState = (typeof BOOKING_STATES)[number];

export const PARTICIPANT_STATES = ['placeholder', 'named', 'cancelled'] as const;
export type ParticipantState = (typeof PARTICIPANT_STATES)[number];

export const ATTENDANCE_STATES = ['present', 'absent', 'partial', 'not_recorded'] as const;
export type AttendanceState = (typeof ATTENDANCE_STATES)[number];

export const SCREENING_STATES = ['requested', 'received', 'reviewed', 'cleared', 'not_suitable'] as const;
export type ScreeningState = (typeof SCREENING_STATES)[number];

export const PriceOptionSchema = z.object({
  id: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(120),
  amountMinor: z.number().int().nonnegative(),
  currency: CurrencyCodeSchema,
  active: z.boolean().default(true),
}).strict();
export type PriceOption = z.infer<typeof PriceOptionSchema>;

export const CrmEditionDtoSchema = z.object({
  id: z.string(),
  eventRecordId: z.string(),
  programmeSlug: z.string(),
  title: z.string(),
  capacity: z.number().int().positive().nullable(),
  holdMinutes: z.number().int().positive().nullable(),
  maxGroupSize: z.number().int().positive().nullable(),
  confirmBeforePayment: z.boolean().nullable(),
  requiresScreening: z.boolean(),
  screeningQuestions: z.array(z.string()),
  cancellationPolicyText: z.string().nullable(),
  priceOptions: z.array(PriceOptionSchema),
  sessionDates: z.array(IsoDateSchema),
  state: z.enum(EDITION_STATES),
  confirmedSeats: z.number().int().nonnegative(),
  heldSeats: z.number().int().nonnegative(),
  availableSeats: z.number().int().nonnegative().nullable(),
  waitlistedCount: z.number().int().nonnegative(),
  rev: z.number().int().positive(),
  updatedAt: z.number().int(),
}).strict();
export type CrmEditionDto = z.infer<typeof CrmEditionDtoSchema>;

export const CrmParticipantDtoSchema = z.object({
  id: z.string(),
  bookingId: z.string(),
  editionId: z.string(),
  personId: z.string().nullable(),
  displayName: z.string(),
  placeholderIndex: z.number().int().nullable(),
  state: z.enum(PARTICIPANT_STATES),
  notes: z.string().nullable(),
  rev: z.number().int().positive(),
  updatedAt: z.number().int(),
}).strict();
export type CrmParticipantDto = z.infer<typeof CrmParticipantDtoSchema>;

export const CrmAttendanceDtoSchema = z.object({
  id: z.string(),
  participantId: z.string(),
  editionId: z.string(),
  sessionDate: IsoDateSchema,
  state: z.enum(ATTENDANCE_STATES),
  notes: z.string().nullable(),
  recordedBy: z.string(),
  recordedAt: z.number().int(),
}).strict();
export type CrmAttendanceDto = z.infer<typeof CrmAttendanceDtoSchema>;

export const CrmScreeningDtoSchema = z.object({
  participantId: z.string(),
  bookingId: z.string(),
  editionId: z.string(),
  programmeSlug: z.string(),
  answers: z.record(z.string(), z.string()),
  evidenceNote: z.string().nullable(),
  state: z.enum(SCREENING_STATES),
  reviewNote: z.string().nullable(),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.number().int().nullable(),
  rev: z.number().int().positive(),
  updatedAt: z.number().int(),
}).strict();
export type CrmScreeningDto = z.infer<typeof CrmScreeningDtoSchema>;

export const CrmBookingDtoSchema = z.object({
  id: z.string(),
  editionId: z.string(),
  editionTitle: z.string(),
  programmeSlug: z.string(),
  bookerPersonId: z.string(),
  bookerName: z.string().nullable(),
  applicationId: z.string().nullable(),
  state: z.enum(BOOKING_STATES),
  effectiveState: z.enum(BOOKING_STATES),
  seats: z.number().int().positive(),
  priceOptionId: z.string().nullable(),
  unitAmountMinor: z.number().int().nonnegative().nullable(),
  currency: z.string().nullable(),
  holdExpiresAt: z.number().int().nullable(),
  offerExpiresAt: z.number().int().nullable(),
  paymentStatus: z.enum(['unpaid', 'part_paid', 'paid', 'overpaid', 'refund_pending', 'refunded']),
  cancelReason: z.string().nullable(),
  source: z.string(),
  notes: z.string().nullable(),
  rev: z.number().int().positive(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
}).strict();
export type CrmBookingDto = z.infer<typeof CrmBookingDtoSchema>;

/* ---------- S7 Money Schemas ---------- */

export const PAYMENT_REQUEST_STATES = [
  'draft',
  'issued',
  'part_paid',
  'paid',
  'overpaid',
  'cancelled',
  'expired',
] as const;
export type PaymentRequestState = (typeof PAYMENT_REQUEST_STATES)[number];

export const LEDGER_KINDS = ['receipt', 'reversal', 'refund', 'adjustment'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export const EVIDENCE_KINDS = [
  'bank_reference',
  'proof_file',
  'cash_voucher',
  'provider_event',
  'reversal_reason',
  'refund_reference',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const REFUND_STATES = ['requested', 'approved', 'rejected', 'issued', 'cancelled'] as const;
export type RefundState = (typeof REFUND_STATES)[number];

export const CrmPaymentRequestDtoSchema = z.object({
  id: z.string(),
  objectType: z.enum(['booking', 'membership']),
  objectId: z.string(),
  personId: z.string(),
  programmeSlug: z.string().nullable(),
  amountMinor: z.number().int().positive(),
  currency: CurrencyCodeSchema,
  state: z.enum(PAYMENT_REQUEST_STATES),
  dueAt: z.number().int().nullable(),
  label: z.string().nullable(),
  rev: z.number().int().positive(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
}).strict();
export type CrmPaymentRequestDto = z.infer<typeof CrmPaymentRequestDtoSchema>;

export const CrmLedgerEntryDtoSchema = z.object({
  id: z.string(),
  kind: z.enum(LEDGER_KINDS),
  amountMinor: z.number().int(),
  currency: CurrencyCodeSchema,
  objectType: z.enum(['booking', 'membership']),
  objectId: z.string(),
  paymentRequestId: z.string().nullable(),
  personId: z.string(),
  programmeSlug: z.string().nullable(),
  evidenceKind: z.enum(EVIDENCE_KINDS),
  evidenceRef: z.string(),
  evidenceNote: z.string().nullable(),
  reversesEntryId: z.string().nullable(),
  refundRequestId: z.string().nullable(),
  recordedBy: z.string(),
  recordedAt: z.number().int(),
}).strict();
export type CrmLedgerEntryDto = z.infer<typeof CrmLedgerEntryDtoSchema>;

export const CrmRefundPolicyDtoSchema = z.object({
  currency: CurrencyCodeSchema,
  dualApprovalThresholdMinor: z.number().int().nonnegative().nullable(),
  allowForeignContributions: z.literal(false),
  rev: z.number().int().positive(),
  updatedAt: z.number().int(),
}).strict();
export type CrmRefundPolicyDto = z.infer<typeof CrmRefundPolicyDtoSchema>;

export const CrmRefundRequestDtoSchema = z.object({
  id: z.string(),
  objectType: z.enum(['booking', 'membership']),
  objectId: z.string(),
  personId: z.string(),
  programmeSlug: z.string().nullable(),
  amountMinor: z.number().int().positive(),
  currency: CurrencyCodeSchema,
  reason: z.string(),
  state: z.enum(REFUND_STATES),
  requiresIndependentApproval: z.boolean(),
  requestedBy: z.string(),
  requestedAt: z.number().int(),
  approvedBy: z.string().nullable(),
  approvedAt: z.number().int().nullable(),
  decisionNote: z.string().nullable(),
  issuedEntryId: z.string().nullable(),
  issuedBy: z.string().nullable(),
  issuedAt: z.number().int().nullable(),
  rev: z.number().int().positive(),
  updatedAt: z.number().int(),
}).strict();
export type CrmRefundRequestDto = z.infer<typeof CrmRefundRequestDtoSchema>;

/* ---------- S8 Membership Schemas ---------- */

export const MEMBERSHIP_STATES = [
  'applied',
  'approved',
  'declined',
  'awaiting_contribution',
  'active',
  'renewal_due',
  'lapsed',
  'cancelled',
] as const;
export type MembershipState = (typeof MEMBERSHIP_STATES)[number];

export const CrmMembershipSchemeDtoSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  programmeSlug: z.string(),
  contributionAmountMinor: z.number().int().positive().nullable(),
  currency: CurrencyCodeSchema.nullable(),
  validityDays: z.number().int().positive().nullable(),
  renewalNoticeDays: z.number().int().positive().nullable(),
  identifierPrefix: z.string().nullable(),
  identifierDigits: z.number().int().min(2).max(10).nullable(),
  nextIdentifierSeq: z.number().int().positive(),
  benefitsEnabled: z.literal(false),
  active: z.boolean(),
  rev: z.number().int().positive(),
  updatedAt: z.number().int(),
}).strict();
export type CrmMembershipSchemeDto = z.infer<typeof CrmMembershipSchemeDtoSchema>;

export const CrmMembershipDtoSchema = z.object({
  id: z.string(),
  schemeId: z.string(),
  schemeName: z.string(),
  personId: z.string(),
  personName: z.string().nullable(),
  applicationId: z.string().nullable(),
  state: z.enum(MEMBERSHIP_STATES),
  effectiveState: z.enum(MEMBERSHIP_STATES),
  memberIdentifier: z.string().nullable(),
  validFrom: z.number().int().nullable(),
  validUntil: z.number().int().nullable(),
  paymentStatus: z.enum(['unpaid', 'part_paid', 'paid', 'overpaid', 'refund_pending', 'refunded']),
  periodCount: z.number().int().nonnegative(),
  notes: z.string().nullable(),
  decisionReason: z.string().nullable(),
  rev: z.number().int().positive(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
}).strict();
export type CrmMembershipDto = z.infer<typeof CrmMembershipDtoSchema>;

/* ---------- Command Input Schemas (S6, S7, S8) ---------- */

export const UpsertEditionInputSchema = z.object({
  editionId: z.string().min(1).max(64).optional(),
  eventRecordId: z.string().min(1).max(64),
  programmeSlug: z.string().min(1).max(64),
  title: z.string().trim().min(1).max(160),
  capacity: z.number().int().positive().nullable().optional(),
  holdMinutes: z.number().int().positive().max(43_200).nullable().optional(),
  maxGroupSize: z.number().int().positive().max(100).nullable().optional(),
  confirmBeforePayment: z.boolean().nullable().optional(),
  requiresScreening: z.boolean().optional(),
  screeningQuestions: z.array(z.string().trim().min(1).max(240)).max(20).optional(),
  cancellationPolicyText: z.string().trim().max(2000).nullable().optional(),
  priceOptions: z.array(PriceOptionSchema).max(20).optional(),
  sessionDates: z.array(IsoDateSchema).max(60).optional(),
  state: z.enum(EDITION_STATES).optional(),
  expectedRev: z.number().int().positive().optional(),
}).strict();
export type UpsertEditionInput = z.infer<typeof UpsertEditionInputSchema>;

export const RequestBookingInputSchema = z.object({
  editionId: z.string().min(1).max(64),
  bookerPersonId: z.string().min(1).max(64),
  applicationId: z.string().min(1).max(64).nullable().optional(),
  seats: z.number().int().positive().max(50).default(1),
  priceOptionId: z.string().min(1).max(64).nullable().optional(),
  participantNames: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  preferWaitlist: z.boolean().optional(),
  source: z.string().trim().min(1).max(40).default('crm'),
  notes: z.string().trim().max(1000).nullable().optional(),
}).strict();
export type RequestBookingInput = z.infer<typeof RequestBookingInputSchema>;

export const HoldBookingInputSchema = z.object({
  bookingId: z.string().min(1).max(64),
  expectedRev: z.number().int().positive().optional(),
}).strict();
export type HoldBookingInput = z.infer<typeof HoldBookingInputSchema>;

export const ConfirmBookingInputSchema = z.object({
  bookingId: z.string().min(1).max(64),
  expectedRev: z.number().int().positive().optional(),
}).strict();
export type ConfirmBookingInput = z.infer<typeof ConfirmBookingInputSchema>;

export const CancelBookingInputSchema = z.object({
  bookingId: z.string().min(1).max(64),
  reason: z.string().trim().min(1).max(500),
  expectedRev: z.number().int().positive().optional(),
}).strict();
export type CancelBookingInput = z.infer<typeof CancelBookingInputSchema>;

export const TransferBookingInputSchema = z.object({
  bookingId: z.string().min(1).max(64),
  targetEditionId: z.string().min(1).max(64),
  expectedRev: z.number().int().positive().optional(),
}).strict();
export type TransferBookingInput = z.infer<typeof TransferBookingInputSchema>;

export const OfferWaitlistInputSchema = z.object({
  bookingId: z.string().min(1).max(64),
  expectedRev: z.number().int().positive().optional(),
}).strict();
export type OfferWaitlistInput = z.infer<typeof OfferWaitlistInputSchema>;

export const AcceptWaitlistOfferInputSchema = z.object({
  bookingId: z.string().min(1).max(64),
  expectedRev: z.number().int().positive().optional(),
}).strict();
export type AcceptWaitlistOfferInput = z.infer<typeof AcceptWaitlistOfferInputSchema>;

export const UpdateParticipantInputSchema = z.object({
  participantId: z.string().min(1).max(64),
  personId: z.string().min(1).max(64).nullable().optional(),
  displayName: z.string().trim().min(1).max(120),
  notes: z.string().trim().max(1000).nullable().optional(),
  expectedRev: z.number().int().positive().optional(),
}).strict();
export type UpdateParticipantInput = z.infer<typeof UpdateParticipantInputSchema>;

export const RecordAttendanceInputSchema = z.object({
  participantId: z.string().min(1).max(64),
  sessionDate: IsoDateSchema,
  state: z.enum(['present', 'absent', 'partial']),
  notes: z.string().trim().max(500).nullable().optional(),
}).strict();
export type RecordAttendanceInput = z.infer<typeof RecordAttendanceInputSchema>;

export const UpsertScreeningInputSchema = z.object({
  participantId: z.string().min(1).max(64),
  answers: z.record(z.string().min(1).max(120), z.string().max(1000)),
  evidenceNote: z.string().trim().max(1000).nullable().optional(),
  state: z.enum(['requested', 'received']).default('received'),
}).strict();
export type UpsertScreeningInput = z.infer<typeof UpsertScreeningInputSchema>;

export const ReviewScreeningInputSchema = z.object({
  participantId: z.string().min(1).max(64),
  state: z.enum(['reviewed', 'cleared', 'not_suitable']),
  reviewNote: z.string().trim().min(1).max(1000),
  expectedRev: z.number().int().positive().optional(),
}).strict();
export type ReviewScreeningInput = z.infer<typeof ReviewScreeningInputSchema>;

export const CompleteEditionInputSchema = z.object({
  editionId: z.string().min(1).max(64),
  expectedRev: z.number().int().positive().optional(),
}).strict();
export type CompleteEditionInput = z.infer<typeof CompleteEditionInputSchema>;

/* S7 Money Command Inputs */

export const CreatePaymentRequestInputSchema = z.object({
  objectType: z.enum(['booking', 'membership']),
  objectId: z.string().min(1).max(64),
  amountMinor: z.number().int().positive(),
  currency: CurrencyCodeSchema,
  dueAt: z.number().int().positive().nullable().optional(),
  label: z.string().trim().min(1).max(160).optional(),
}).strict();
export type CreatePaymentRequestInput = z.infer<typeof CreatePaymentRequestInputSchema>;

export const RecordManualReceiptInputSchema = z.object({
  objectType: z.enum(['booking', 'membership']),
  objectId: z.string().min(1).max(64),
  paymentRequestId: z.string().min(1).max(64).nullable().optional(),
  amountMinor: z.number().int().positive(),
  currency: CurrencyCodeSchema,
  evidenceKind: z.enum(['bank_reference', 'proof_file', 'cash_voucher']),
  evidenceRef: z.string().trim().min(2).max(200),
  evidenceNote: z.string().trim().max(1000).nullable().optional(),
  contributorResidency: z.enum(['domestic', 'foreign']).default('domestic'),
  receiptIdempotencyKey: z.string().trim().min(4).max(120).optional(),
}).strict();
export type RecordManualReceiptInput = z.infer<typeof RecordManualReceiptInputSchema>;

export const ReverseLedgerEntryInputSchema = z.object({
  entryId: z.string().min(1).max(64),
  reason: z.string().trim().min(3).max(500),
}).strict();
export type ReverseLedgerEntryInput = z.infer<typeof ReverseLedgerEntryInputSchema>;

export const ConfigureRefundPolicyInputSchema = z.object({
  currency: CurrencyCodeSchema,
  dualApprovalThresholdMinor: z.number().int().nonnegative().nullable(),
}).strict();
export type ConfigureRefundPolicyInput = z.infer<typeof ConfigureRefundPolicyInputSchema>;

export const RequestRefundInputSchema = z.object({
  objectType: z.enum(['booking', 'membership']),
  objectId: z.string().min(1).max(64),
  amountMinor: z.number().int().positive(),
  currency: CurrencyCodeSchema,
  reason: z.string().trim().min(3).max(500),
}).strict();
export type RequestRefundInput = z.infer<typeof RequestRefundInputSchema>;

export const DecideRefundInputSchema = z.object({
  refundRequestId: z.string().min(1).max(64),
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().min(1).max(500),
  expectedRev: z.number().int().positive().optional(),
}).strict();
export type DecideRefundInput = z.infer<typeof DecideRefundInputSchema>;

export const IssueRefundInputSchema = z.object({
  refundRequestId: z.string().min(1).max(64),
  evidenceRef: z.string().trim().min(2).max(200),
  evidenceNote: z.string().trim().max(1000).nullable().optional(),
  expectedRev: z.number().int().positive().optional(),
}).strict();
export type IssueRefundInput = z.infer<typeof IssueRefundInputSchema>;

/* S8 Membership Command Inputs */

export const UpsertMembershipSchemeInputSchema = z.object({
  schemeId: z.string().min(1).max(64).optional(),
  slug: z.string().trim().min(2).max(64).regex(/^[a-z0-9-]+$/),
  name: z.string().trim().min(2).max(120),
  programmeSlug: z.string().trim().min(1).max(64).default('common-roots'),
  contributionAmountMinor: z.number().int().positive().nullable().optional(),
  currency: CurrencyCodeSchema.nullable().optional(),
  validityDays: z.number().int().positive().max(3650).nullable().optional(),
  renewalNoticeDays: z.number().int().positive().max(365).nullable().optional(),
  identifierPrefix: z.string().trim().min(1).max(16).nullable().optional(),
  identifierDigits: z.number().int().min(2).max(10).nullable().optional(),
  active: z.boolean().optional(),
  expectedRev: z.number().int().positive().optional(),
}).strict();
export type UpsertMembershipSchemeInput = z.infer<typeof UpsertMembershipSchemeInputSchema>;

export const ApplyMembershipInputSchema = z.object({
  schemeId: z.string().min(1).max(64),
  personId: z.string().min(1).max(64),
  applicationId: z.string().min(1).max(64).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
}).strict();
export type ApplyMembershipInput = z.infer<typeof ApplyMembershipInputSchema>;

export const DecideMembershipInputSchema = z.object({
  membershipId: z.string().min(1).max(64),
  decision: z.enum(['approve', 'decline']),
  reason: z.string().trim().min(2).max(500),
  expectedRev: z.number().int().positive().optional(),
}).strict();
export type DecideMembershipInput = z.infer<typeof DecideMembershipInputSchema>;

export const ActivateOrRenewMembershipInputSchema = z.object({
  membershipId: z.string().min(1).max(64),
  expectedRev: z.number().int().positive().optional(),
}).strict();
export type ActivateOrRenewMembershipInput = z.infer<typeof ActivateOrRenewMembershipInputSchema>;

export const CancelMembershipInputSchema = z.object({
  membershipId: z.string().min(1).max(64),
  reason: z.string().trim().min(2).max(500),
  expectedRev: z.number().int().positive().optional(),
}).strict();
export type CancelMembershipInput = z.infer<typeof CancelMembershipInputSchema>;

/* ---------- Read Response Schemas ---------- */

export const EditionsListResponseSchema = z.object({
  items: z.array(CrmEditionDtoSchema),
  partial: z.boolean(),
}).strict();
export type EditionsListResponse = z.infer<typeof EditionsListResponseSchema>;

export const EditionDetailResponseSchema = z.object({
  edition: CrmEditionDtoSchema,
  bookings: z.array(CrmBookingDtoSchema),
  participants: z.array(CrmParticipantDtoSchema),
  attendance: z.array(CrmAttendanceDtoSchema),
  canReadScreening: z.boolean(),
  partial: z.boolean(),
}).strict();
export type EditionDetailResponse = z.infer<typeof EditionDetailResponseSchema>;

export const BookingDetailResponseSchema = z.object({
  booking: CrmBookingDtoSchema,
  edition: CrmEditionDtoSchema,
  participants: z.array(CrmParticipantDtoSchema),
  attendance: z.array(CrmAttendanceDtoSchema),
  canReadScreening: z.boolean(),
  canReadMoney: z.boolean(),
  paymentSummaryByCurrency: z.array(
    z.object({
      currency: CurrencyCodeSchema,
      dueMinor: z.number().int().nonnegative(),
      netPaidMinor: z.number().int(),
      balanceMinor: z.number().int(),
    }).strict(),
  ),
}).strict();
export type BookingDetailResponse = z.infer<typeof BookingDetailResponseSchema>;

export const BookingScreeningResponseSchema = z.object({
  bookingId: z.string(),
  programmeSlug: z.string(),
  questions: z.array(z.string()),
  items: z.array(CrmScreeningDtoSchema),
}).strict();
export type BookingScreeningResponse = z.infer<typeof BookingScreeningResponseSchema>;

export const MoneyOverviewResponseSchema = z.object({
  paymentRequests: z.array(CrmPaymentRequestDtoSchema),
  ledgerEntries: z.array(CrmLedgerEntryDtoSchema),
  refundRequests: z.array(CrmRefundRequestDtoSchema),
  refundPolicies: z.array(CrmRefundPolicyDtoSchema),
  totalsByCurrency: z.array(
    z.object({
      currency: CurrencyCodeSchema,
      receiptsMinor: z.number().int(),
      reversalsMinor: z.number().int(),
      refundsMinor: z.number().int(),
      adjustmentsMinor: z.number().int(),
      netMinor: z.number().int(),
    }).strict(),
  ),
  programmeIncomeByCurrency: z.array(
    z.object({
      programmeSlug: z.string(),
      currency: CurrencyCodeSchema,
      receiptsMinor: z.number().int(),
      refundsMinor: z.number().int(),
      netMinor: z.number().int(),
    }).strict(),
  ),
  canRecordFinance: z.boolean(),
  canApproveRefunds: z.boolean(),
  partial: z.boolean(),
}).strict();
export type MoneyOverviewResponse = z.infer<typeof MoneyOverviewResponseSchema>;

export const MembershipsOverviewResponseSchema = z.object({
  schemes: z.array(CrmMembershipSchemeDtoSchema),
  memberships: z.array(CrmMembershipDtoSchema),
  renewalsDueCount: z.number().int().nonnegative(),
  lapsedCount: z.number().int().nonnegative(),
  canConfigure: z.boolean(),
  canRecordFinance: z.boolean(),
  partial: z.boolean(),
}).strict();
export type MembershipsOverviewResponse = z.infer<typeof MembershipsOverviewResponseSchema>;
