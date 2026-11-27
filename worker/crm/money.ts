import {
  ConfigureRefundPolicyInputSchema,
  CreatePaymentRequestInputSchema,
  CrmLedgerEntryDtoSchema,
  CrmPaymentRequestDtoSchema,
  CrmRefundPolicyDtoSchema,
  CrmRefundRequestDtoSchema,
  DecideRefundInputSchema,
  IssueRefundInputSchema,
  MoneyOverviewResponseSchema,
  RecordManualReceiptInputSchema,
  RequestRefundInputSchema,
  ReverseLedgerEntryInputSchema,
  allocatePaymentRequests,
  computeBookingAgreedDue,
  derivePaymentStatus,
  evaluateEffectiveMembershipState,
  evaluateMembershipPeriodCoverage,
  isForeignCurrencyBlocked,
  requiresIndependentRefundApproval,
  summarizeLedgerByCurrency,
  type ConfigureRefundPolicyInput,
  type CreatePaymentRequestInput,
  type CrmLedgerEntryDto,
  type CrmPaymentRequestDto,
  type CrmRefundPolicyDto,
  type CrmRefundRequestDto,
  type DecideRefundInput,
  type EvidenceKind,
  type IssueRefundInput,
  type LedgerKind,
  type MembershipState,
  type MoneyOverviewResponse,
  type PaymentRequestState,
  type PaymentStatus,
  type RecordManualReceiptInput,
  type RefundState,
  type RequestRefundInput,
  type ReverseLedgerEntryInput,
} from '../../shared/crm/operations';
import { CRM_PROJECTION } from '../../shared/crm/projection';
import type { Env } from '../auth';
import { createReadGate } from '../readAccess';
import { pokeLive } from '../sync';
import { effectiveBookingState, type BookingRow } from './bookings';
import type { AnyCommandDefinition, CommandDefinition } from './commands';
import {
  actorGrantsStmt,
  crmActorFence,
  evaluateCrmReadAuthRows,
  finalizeCrmReadAuth,
  loadReadableTaskRecord,
  loadReadableTaskRecords,
  sessionAuthStmt,
  type CrmGrantRow,
  type CrmSessionRow,
} from './read';
import { canAccessCrmApi, evaluateCapability, isCrmEnabled } from './rules';

const SQLITE_NOW_MS = `CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`;

type ReadableRecordRow = NonNullable<Awaited<ReturnType<typeof loadReadableTaskRecord>>>;

interface PaymentRequestRow {
  id: string;
  object_type: 'booking' | 'membership';
  object_id: string;
  person_id: string;
  programme_slug: string | null;
  amount_minor: number;
  currency: string;
  state: PaymentRequestState;
  due_at: number | null;
  label: string | null;
  rev: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface LedgerEntryRow {
  id: string;
  kind: LedgerKind;
  amount_minor: number;
  currency: string;
  object_type: 'booking' | 'membership';
  object_id: string;
  payment_request_id: string | null;
  person_id: string;
  programme_slug: string | null;
  evidence_kind: EvidenceKind;
  evidence_ref: string;
  evidence_note: string | null;
  contributor_residency: 'domestic';
  reverses_entry_id: string | null;
  refund_request_id: string | null;
  idempotency_key: string;
  recorded_by: string;
  recorded_at: number;
}

interface RefundPolicyRow {
  currency: string;
  dual_approval_threshold_minor: number | null;
  allow_foreign_contributions: number;
  rev: number;
  updated_by: string;
  updated_at: number;
}

interface RefundRequestRow {
  id: string;
  object_type: 'booking' | 'membership';
  object_id: string;
  person_id: string;
  programme_slug: string | null;
  amount_minor: number;
  currency: string;
  reason: string;
  state: RefundState;
  requires_independent_approval: number;
  requested_by: string;
  requested_at: number;
  approved_by: string | null;
  approved_at: number | null;
  decision_note: string | null;
  issued_entry_id: string | null;
  issued_by: string | null;
  issued_at: number | null;
  rev: number;
  updated_at: number;
}

interface MembershipPeriodRow {
  id: string;
  membership_id: string;
  period_number: number;
  required_amount_minor: number;
  currency: string;
  valid_from: number;
  valid_until: number;
  status: 'active' | 'invalidated';
}

interface TargetObjectContext {
  objectType: 'booking' | 'membership';
  objectId: string;
  personId: string;
  programmeSlug: string | null;
  expectedCurrency: string | null;
  authoritativeDueMinor: number | null;
  personRec: ReadableRecordRow;
  eventRec?: ReadableRecordRow;
  booking?: BookingRow;
  membership?: {
    id: string;
    scheme_id: string;
    person_id: string;
    state: MembershipState;
    valid_from: number | null;
    valid_until: number | null;
    period_count: number;
    rev: number;
    contribution_amount_minor: number | null;
    currency: string | null;
    renewal_notice_days: number | null;
    activePeriods: MembershipPeriodRow[];
  };
}

interface ObjectFinancialSnapshot {
  dueMinor: number;
  netPaidMinor: number;
  ledgerCount: number;
  requestsCount: number;
  requestsTotalMinor: number;
  refundTotalCount: number;
  pendingRefundMinor: number;
  issuedRefundCount: number;
  openRequests: PaymentRequestRow[];
  entries: { payment_request_id: string | null; amount_minor: number }[];
}

function changesOneFence(db: D1Database): D1PreparedStatement {
  return db.prepare(`SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('{', '$') END`);
}

function mapPaymentRequestRow(r: PaymentRequestRow): CrmPaymentRequestDto {
  return CrmPaymentRequestDtoSchema.parse({
    id: r.id,
    objectType: r.object_type,
    objectId: r.object_id,
    personId: r.person_id,
    programmeSlug: r.programme_slug,
    amountMinor: r.amount_minor,
    currency: r.currency,
    state: r.state,
    dueAt: r.due_at,
    label: r.label,
    rev: r.rev,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

function mapLedgerEntryRow(r: LedgerEntryRow): CrmLedgerEntryDto {
  return CrmLedgerEntryDtoSchema.parse({
    id: r.id,
    kind: r.kind,
    amountMinor: r.amount_minor,
    currency: r.currency,
    objectType: r.object_type,
    objectId: r.object_id,
    paymentRequestId: r.payment_request_id,
    personId: r.person_id,
    programmeSlug: r.programme_slug,
    evidenceKind: r.evidence_kind,
    evidenceRef: r.evidence_ref,
    evidenceNote: r.evidence_note,
    reversesEntryId: r.reverses_entry_id,
    refundRequestId: r.refund_request_id,
    recordedBy: r.recorded_by,
    recordedAt: r.recorded_at,
  });
}

function mapRefundPolicyRow(r: RefundPolicyRow): CrmRefundPolicyDto {
  return CrmRefundPolicyDtoSchema.parse({
    currency: r.currency,
    dualApprovalThresholdMinor: r.dual_approval_threshold_minor,
    allowForeignContributions: false,
    rev: r.rev,
    updatedAt: r.updated_at,
  });
}

function mapRefundRequestRow(r: RefundRequestRow): CrmRefundRequestDto {
  return CrmRefundRequestDtoSchema.parse({
    id: r.id,
    objectType: r.object_type,
    objectId: r.object_id,
    personId: r.person_id,
    programmeSlug: r.programme_slug,
    amountMinor: r.amount_minor,
    currency: r.currency,
    reason: r.reason,
    state: r.state,
    requiresIndependentApproval: r.requires_independent_approval === 1,
    requestedBy: r.requested_by,
    requestedAt: r.requested_at,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    decisionNote: r.decision_note,
    issuedEntryId: r.issued_entry_id,
    issuedBy: r.issued_by,
    issuedAt: r.issued_at,
    rev: r.rev,
    updatedAt: r.updated_at,
  });
}

function linkedRecordExpect(target: TargetObjectContext): Map<string, number> {
  const map = new Map<string, number>([[target.personRec.id, target.personRec.seq]]);
  if (target.eventRec) map.set(target.eventRec.id, target.eventRec.seq);
  return map;
}

async function resolveFinancialTarget(
  env: Env,
  actorId: string,
  objectType: 'booking' | 'membership',
  objectId: string,
): Promise<TargetObjectContext | null> {
  if (objectType === 'booking') {
    const bk = await env.DB
      .prepare(`SELECT * FROM crm_bookings WHERE id = ?`)
      .bind(objectId)
      .first<BookingRow>();
    if (!bk) return null;
    const ed = await env.DB
      .prepare(`SELECT event_record_id, programme_slug FROM crm_editions WHERE id = ?`)
      .bind(bk.edition_id)
      .first<{ event_record_id: string; programme_slug: string }>();
    if (!ed) return null;
    const [evRec, personRec] = await Promise.all([
      loadReadableTaskRecord(env, actorId, ed.event_record_id),
      loadReadableTaskRecord(env, actorId, bk.booker_person_id),
    ]);
    if (!evRec || !personRec) return null;
    const agreed = computeBookingAgreedDue({
      unitAmountMinor: bk.unit_amount_minor,
      seats: bk.seats,
      currency: bk.currency,
    });
    return {
      objectType: 'booking',
      objectId: bk.id,
      personId: bk.booker_person_id,
      programmeSlug: ed.programme_slug,
      expectedCurrency: agreed?.currency ?? bk.currency,
      authoritativeDueMinor: agreed?.dueMinor ?? null,
      personRec,
      eventRec: evRec,
      booking: bk,
    };
  }

  const [mem, periodsRes] = await Promise.all([
    env.DB
      .prepare(
        `SELECT m.id, m.scheme_id, m.person_id, m.state, m.valid_from, m.valid_until, m.period_count, m.rev,
                s.programme_slug, s.contribution_amount_minor, s.currency, s.renewal_notice_days
         FROM crm_memberships m
         JOIN crm_membership_schemes s ON s.id = m.scheme_id
         WHERE m.id = ?`,
      )
      .bind(objectId)
      .first<{
        id: string;
        scheme_id: string;
        person_id: string;
        state: MembershipState;
        valid_from: number | null;
        valid_until: number | null;
        period_count: number;
        rev: number;
        programme_slug: string;
        contribution_amount_minor: number | null;
        currency: string | null;
        renewal_notice_days: number | null;
      }>(),
    env.DB
      .prepare(
        `SELECT id, membership_id, period_number, required_amount_minor, currency, valid_from, valid_until, status
         FROM crm_membership_periods
         WHERE membership_id = ? AND status = 'active'
         ORDER BY period_number ASC`,
      )
      .bind(objectId)
      .all<MembershipPeriodRow>(),
  ]);
  if (!mem) return null;
  const personRec = await loadReadableTaskRecord(env, actorId, mem.person_id);
  if (!personRec) return null;

  const activePeriods = periodsRes.results;
  const activePeriodsSum = activePeriods.reduce((sum, p) => sum + p.required_amount_minor, 0);
  // Authoritative membership due preserves frozen historical periods; when awaiting contribution for next period,
  // includes current scheme contribution so a smaller manual request can never falsely mark it 'paid'.
  let authoritativeDueMinor: number | null = null;
  if (activePeriods.length > 0) {
    authoritativeDueMinor =
      mem.state === 'awaiting_contribution' || mem.state === 'approved'
        ? activePeriodsSum + (mem.contribution_amount_minor ?? 0)
        : activePeriodsSum;
  } else if (mem.contribution_amount_minor !== null) {
    const periodsExpected = Math.max(1, mem.period_count);
    authoritativeDueMinor = mem.contribution_amount_minor * periodsExpected;
  }

  return {
    objectType: 'membership',
    objectId: mem.id,
    personId: mem.person_id,
    programmeSlug: mem.programme_slug,
    expectedCurrency: activePeriods[0]?.currency ?? mem.currency,
    authoritativeDueMinor,
    personRec,
    membership: {
      ...mem,
      activePeriods,
    },
  };
}

async function computeObjectFinancialSnapshot(
  db: D1Database,
  target: TargetObjectContext,
  currency: string,
): Promise<ObjectFinancialSnapshot> {
  const [reqRes, ledRes, refRes] = await db.batch([
    db
      .prepare(
        `SELECT * FROM crm_payment_requests
         WHERE object_type = ? AND object_id = ? AND currency = ? AND state NOT IN ('cancelled', 'expired')
         ORDER BY created_at ASC, id ASC`,
      )
      .bind(target.objectType, target.objectId, currency),
    db
      .prepare(
        `SELECT payment_request_id, amount_minor
         FROM crm_ledger_entries
         WHERE object_type = ? AND object_id = ? AND currency = ?
         ORDER BY recorded_at ASC, id ASC`,
      )
      .bind(target.objectType, target.objectId, currency),
    db
      .prepare(
        `SELECT
           COUNT(*) AS total_count,
           COALESCE(SUM(CASE WHEN state IN ('requested', 'approved') THEN amount_minor ELSE 0 END), 0) AS pending_minor,
           COALESCE(SUM(CASE WHEN state = 'issued' THEN 1 ELSE 0 END), 0) AS issued_count
         FROM crm_refund_requests
         WHERE object_type = ? AND object_id = ? AND currency = ?`,
      )
      .bind(target.objectType, target.objectId, currency),
  ]);
  const openRequests = reqRes.results as unknown as PaymentRequestRow[];
  const entries = ledRes.results as unknown as { payment_request_id: string | null; amount_minor: number }[];
  const requestsTotalMinor = openRequests.reduce((sum, r) => sum + r.amount_minor, 0);
  const netPaidMinor = entries.reduce((sum, e) => sum + e.amount_minor, 0);
  const refRow = refRes.results[0] as { total_count: number; pending_minor: number; issued_count: number } | undefined;

  // Authoritative due:
  // - Booking with agreed price: ALWAYS unit_amount_minor * seats (never bypassed by a smaller payment request).
  // - Membership: max of authoritative historical/active requirement and open requests.
  // - Unpriced fallback: open requests sum.
  let dueMinor = requestsTotalMinor;
  if (target.objectType === 'booking' && target.authoritativeDueMinor !== null && target.expectedCurrency === currency) {
    dueMinor = target.authoritativeDueMinor;
  } else if (
    target.objectType === 'membership' &&
    target.authoritativeDueMinor !== null &&
    target.authoritativeDueMinor > 0 &&
    target.expectedCurrency === currency
  ) {
    dueMinor = Math.max(target.authoritativeDueMinor, requestsTotalMinor);
  }

  return {
    dueMinor,
    netPaidMinor,
    ledgerCount: entries.length,
    requestsCount: openRequests.length,
    requestsTotalMinor,
    refundTotalCount: Number(refRow?.total_count ?? 0),
    pendingRefundMinor: Number(refRow?.pending_minor ?? 0),
    issuedRefundCount: Number(refRow?.issued_count ?? 0),
    openRequests,
    entries,
  };
}

/**
 * Atomic SQL fence verifying no concurrent receipt, reversal, payment request, or refund request
 * mutated this object's currency ledger/request state between plan() and commit().
 */
function buildFinancialSnapshotFence(
  db: D1Database,
  objectType: 'booking' | 'membership',
  objectId: string,
  currency: string,
  snap: ObjectFinancialSnapshot,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT CASE WHEN
         (SELECT COUNT(*) FROM crm_ledger_entries WHERE object_type = ? AND object_id = ? AND currency = ?) = ?
         AND COALESCE((SELECT SUM(amount_minor) FROM crm_ledger_entries WHERE object_type = ? AND object_id = ? AND currency = ?), 0) = ?
         AND (SELECT COUNT(*) FROM crm_payment_requests WHERE object_type = ? AND object_id = ? AND currency = ? AND state NOT IN ('cancelled', 'expired')) = ?
         AND COALESCE((SELECT SUM(amount_minor) FROM crm_payment_requests WHERE object_type = ? AND object_id = ? AND currency = ? AND state NOT IN ('cancelled', 'expired')), 0) = ?
         AND (SELECT COUNT(*) FROM crm_refund_requests WHERE object_type = ? AND object_id = ? AND currency = ?) = ?
         AND COALESCE((SELECT SUM(CASE WHEN state IN ('requested', 'approved') THEN amount_minor ELSE 0 END) FROM crm_refund_requests WHERE object_type = ? AND object_id = ? AND currency = ?), 0) = ?
       THEN 1 ELSE json_extract('{', '$') END`,
    )
    .bind(
      objectType, objectId, currency, snap.ledgerCount,
      objectType, objectId, currency, snap.netPaidMinor,
      objectType, objectId, currency, snap.requestsCount,
      objectType, objectId, currency, snap.requestsTotalMinor,
      objectType, objectId, currency, snap.refundTotalCount,
      objectType, objectId, currency, snap.pendingRefundMinor,
    );
}

function buildMembershipPeriodsFence(
  db: D1Database,
  membershipId: string,
  activePeriods: readonly MembershipPeriodRow[],
): D1PreparedStatement {
  const sum = activePeriods.reduce((acc, p) => acc + p.required_amount_minor, 0);
  return db
    .prepare(
      `SELECT CASE WHEN
         (SELECT COUNT(*) FROM crm_membership_periods WHERE membership_id = ? AND status = 'active') = ?
         AND COALESCE((SELECT SUM(required_amount_minor) FROM crm_membership_periods WHERE membership_id = ? AND status = 'active'), 0) = ?
       THEN 1 ELSE json_extract('{', '$') END`,
    )
    .bind(membershipId, activePeriods.length, membershipId, sum);
}

function buildPerRequestAllocationUpdates(
  db: D1Database,
  openRequests: readonly PaymentRequestRow[],
  entriesAfter: readonly { paymentRequestId: string | null; amountMinor: number }[],
  now: number,
): D1PreparedStatement[] {
  if (openRequests.length === 0) return [];
  const allocated = allocatePaymentRequests(
    openRequests.map((r) => ({ id: r.id, amountMinor: r.amount_minor, createdAt: r.created_at })),
    entriesAfter,
  );
  const byId = new Map(openRequests.map((r) => [r.id, r]));
  const stmts: D1PreparedStatement[] = [];
  for (const res of allocated) {
    const existing = byId.get(res.id);
    if (!existing || existing.state === res.state) continue;
    stmts.push(
      db
        .prepare(
          `UPDATE crm_payment_requests
           SET state = ?, rev = rev + 1, updated_at = ?
           WHERE id = ? AND rev = ?`,
        )
        .bind(res.state, now, existing.id, existing.rev),
      changesOneFence(db),
    );
  }
  return stmts;
}

/**
 * Re-evaluates historical membership period support after a reversal or refund.
 * Never leaves an unsupported active period: invalidates uncovered periods from latest backwards,
 * restores valid_until / period_count to the last supported period, or demotes to awaiting_contribution.
 */
function buildMembershipPostLedgerUpdates(args: {
  db: D1Database;
  target: TargetObjectContext;
  nextNetPaidMinor: number;
  nextPaymentStatus: PaymentStatus;
  reason: string;
  now: number;
  personPatch: Record<string, unknown>;
}): D1PreparedStatement[] {
  const { db, target, nextNetPaidMinor, nextPaymentStatus, reason, now, personPatch } = args;
  const mem = target.membership!;
  const stmts: D1PreparedStatement[] = [];
  const isTerminal = mem.state === 'cancelled' || mem.state === 'declined';

  if (mem.activePeriods.length > 0 && !isTerminal) {
    const coverage = evaluateMembershipPeriodCoverage(
      mem.activePeriods.map((p) => ({
        id: p.id,
        periodNumber: p.period_number,
        requiredAmountMinor: p.required_amount_minor,
        validFrom: p.valid_from,
        validUntil: p.valid_until,
      })),
      nextNetPaidMinor,
    );

    if (coverage.unsupportedPeriods.length > 0) {
      for (const up of coverage.unsupportedPeriods) {
        stmts.push(
          db
            .prepare(
              `UPDATE crm_membership_periods
               SET status = 'invalidated', invalidated_at = ?, invalidated_reason = ?
               WHERE id = ? AND status = 'active'`,
            )
            .bind(now, reason, up.id),
          changesOneFence(db),
        );
      }

      if (coverage.supportedPeriods.length === 0) {
        stmts.push(
          db
            .prepare(
              `UPDATE crm_memberships
               SET state = 'awaiting_contribution', valid_from = NULL, valid_until = NULL, period_count = 0, payment_status = ?, rev = rev + 1, updated_at = ?
               WHERE id = ? AND rev = ?`,
            )
            .bind(nextPaymentStatus, now, mem.id, mem.rev),
          changesOneFence(db),
        );
        personPatch[CRM_PROJECTION.membershipStatus] = 'awaiting_contribution';
        personPatch[CRM_PROJECTION.membershipValidUntil] = null;
        return stmts;
      }

      const firstSupported = coverage.supportedPeriods[0]!;
      const lastSupported = coverage.supportedPeriods[coverage.supportedPeriods.length - 1]!;
      const effNext = evaluateEffectiveMembershipState({
        storedState: 'active',
        validUntil: lastSupported.validUntil,
        renewalNoticeDays: mem.renewal_notice_days,
        now,
      });
      const storedNext: MembershipState = effNext === 'lapsed' ? 'lapsed' : 'active';
      stmts.push(
        db
          .prepare(
            `UPDATE crm_memberships
             SET state = ?, valid_from = ?, valid_until = ?, period_count = ?, payment_status = ?, rev = rev + 1, updated_at = ?
             WHERE id = ? AND rev = ?`,
          )
          .bind(
            storedNext,
            firstSupported.validFrom,
            lastSupported.validUntil,
            coverage.supportedPeriods.length,
            nextPaymentStatus,
            now,
            mem.id,
            mem.rev,
          ),
        changesOneFence(db),
      );
      personPatch[CRM_PROJECTION.membershipStatus] = storedNext;
      personPatch[CRM_PROJECTION.membershipValidUntil] = lastSupported.validUntil;
      return stmts;
    }
  } else if (!isTerminal && (mem.state === 'active' || mem.state === 'renewal_due')) {
    // Legacy fallback when no crm_membership_periods rows exist
    const reqPerPeriod = mem.contribution_amount_minor ?? 0;
    const requiredForPeriods = reqPerPeriod * Math.max(1, mem.period_count);
    if (requiredForPeriods <= 0 || nextNetPaidMinor < requiredForPeriods) {
      stmts.push(
        db
          .prepare(
            `UPDATE crm_memberships
             SET state = 'awaiting_contribution', valid_from = NULL, valid_until = NULL, period_count = 0, payment_status = ?, rev = rev + 1, updated_at = ?
             WHERE id = ? AND rev = ?`,
          )
          .bind(nextPaymentStatus, now, mem.id, mem.rev),
        changesOneFence(db),
      );
      personPatch[CRM_PROJECTION.membershipStatus] = 'awaiting_contribution';
      personPatch[CRM_PROJECTION.membershipValidUntil] = null;
      return stmts;
    }
  }

  stmts.push(
    db
      .prepare(`UPDATE crm_memberships SET payment_status = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?`)
      .bind(nextPaymentStatus, now, mem.id, mem.rev),
    changesOneFence(db),
  );
  return stmts;
}

/* ---------- S7 Commands ---------- */

function createPaymentRequestCommand(): CommandDefinition<
  CreatePaymentRequestInput,
  { paymentRequest: CrmPaymentRequestDto }
> {
  return {
    name: 'payment_request.create',
    authorizeCoarse: (actor, via) =>
      via === 'ui' && canAccessCrmApi(actor) && evaluateCapability(actor, 'crm.finance.record', '*'),
    parseInput: (raw) => {
      const parsed = CreatePaymentRequestInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    authorizeReplay: async (actor, input, _stored, { env }) => {
      if (!evaluateCapability(actor, 'crm.finance.record', '*')) return false;
      const target = await resolveFinancialTarget(env, actor.id, input.objectType, input.objectId);
      return target !== null;
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      if (isForeignCurrencyBlocked(input.currency)) {
        return {
          kind: 'refuse',
          error: 'invalid_input',
          detail: { reason: 'foreign_contribution_blocked_pending_policy', currency: input.currency },
        };
      }
      const target = await resolveFinancialTarget(env, actor.id, input.objectType, input.objectId);
      if (!target) return { kind: 'refuse', error: 'not_found' };
      if (target.expectedCurrency && target.expectedCurrency !== input.currency) {
        return {
          kind: 'refuse',
          error: 'currency_mismatch',
          detail: { expected: target.expectedCurrency, provided: input.currency },
        };
      }
      if (target.booking && (target.booking.state === 'cancelled' || target.booking.state === 'completed')) {
        return {
          kind: 'refuse',
          error: 'stale',
          detail: { reason: 'booking_already_final', state: target.booking.state },
        };
      }
      if (target.membership && (target.membership.state === 'cancelled' || target.membership.state === 'declined')) {
        return {
          kind: 'refuse',
          error: 'stale',
          detail: { reason: 'membership_already_final', state: target.membership.state },
        };
      }

      const id = `pr_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const row: PaymentRequestRow = {
        id,
        object_type: input.objectType,
        object_id: input.objectId,
        person_id: target.personId,
        programme_slug: target.programmeSlug,
        amount_minor: input.amountMinor,
        currency: input.currency,
        state: 'issued',
        due_at: input.dueAt ?? null,
        label: input.label ?? null,
        rev: 1,
        created_by: actor.id,
        created_at: now,
        updated_at: now,
      };

      const rows: D1PreparedStatement[] = [
        env.DB
          .prepare(
            `INSERT INTO crm_payment_requests
               (id, object_type, object_id, person_id, programme_slug, amount_minor, currency, state, due_at, label, rev, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?, 1, ?, ?, ?)`,
          )
          .bind(
            row.id,
            row.object_type,
            row.object_id,
            row.person_id,
            row.programme_slug,
            row.amount_minor,
            row.currency,
            row.due_at,
            row.label,
            actor.id,
            now,
            now,
          ),
      ];

      const fences: (D1PreparedStatement | (() => D1PreparedStatement))[] = [
        () => crmActorFence(env.DB, actor, tokenHash, 'crm.finance.record', '*'),
      ];

      if (target.booking) {
        if (target.booking.state === 'held') {
          rows.push(
            env.DB
              .prepare(
                `UPDATE crm_bookings SET state = 'awaiting_payment', rev = rev + 1, updated_at = ?
                 WHERE id = ? AND rev = ? AND state = 'held'`,
              )
              .bind(now, target.booking.id, target.booking.rev),
            changesOneFence(env.DB),
          );
        } else {
          fences.push(
            env.DB
              .prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM crm_bookings WHERE id = ? AND rev = ?) THEN 1 ELSE json_extract('{', '$') END`)
              .bind(target.booking.id, target.booking.rev),
          );
        }
      } else if (target.membership) {
        fences.push(
          env.DB
            .prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM crm_memberships WHERE id = ? AND rev = ?) THEN 1 ELSE json_extract('{', '$') END`)
            .bind(target.membership.id, target.membership.rev),
        );
      }

      return {
        kind: 'commit',
        result: { paymentRequest: mapPaymentRequestRow(row) },
        fences,
        rows,
        recordExpect: linkedRecordExpect(target),
        forceRecordsCommit: true,
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function recordManualReceiptCommand(): CommandDefinition<
  RecordManualReceiptInput,
  {
    entry: CrmLedgerEntryDto;
    paymentStatus: PaymentStatus;
    netPaidMinor: number;
    dueMinor: number;
    currency: string;
    bookingStateAfter: string | null;
  }
> {
  return {
    name: 'ledger.record_receipt',
    projectionKeys: [CRM_PROJECTION.paymentStatus, CRM_PROJECTION.bookingStatus],
    authorizeCoarse: (actor, via) =>
      via === 'ui' && canAccessCrmApi(actor) && evaluateCapability(actor, 'crm.finance.record', '*'),
    parseInput: (raw) => {
      const parsed = RecordManualReceiptInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    authorizeReplay: async (actor, input, _stored, { env }) => {
      if (!evaluateCapability(actor, 'crm.finance.record', '*')) return false;
      const target = await resolveFinancialTarget(env, actor.id, input.objectType, input.objectId);
      return target !== null;
    },
    plan: async ({ env, actor, tokenHash, input, requestId, now }) => {
      if (input.contributorResidency === 'foreign' || isForeignCurrencyBlocked(input.currency)) {
        return {
          kind: 'refuse',
          error: 'invalid_input',
          detail: { reason: 'foreign_contribution_blocked_pending_policy', currency: input.currency },
        };
      }

      const target = await resolveFinancialTarget(env, actor.id, input.objectType, input.objectId);
      if (!target) return { kind: 'refuse', error: 'not_found' };
      if (target.expectedCurrency && target.expectedCurrency !== input.currency) {
        return {
          kind: 'refuse',
          error: 'currency_mismatch',
          detail: { expected: target.expectedCurrency, provided: input.currency },
        };
      }

      let payReq: PaymentRequestRow | null = null;
      if (input.paymentRequestId) {
        payReq =
          (await env.DB
            .prepare(`SELECT * FROM crm_payment_requests WHERE id = ? AND object_type = ? AND object_id = ?`)
            .bind(input.paymentRequestId, input.objectType, input.objectId)
            .first<PaymentRequestRow>()) ?? null;
        if (!payReq) return { kind: 'refuse', error: 'not_found' };
        if (payReq.state === 'cancelled' || payReq.state === 'expired') {
          return { kind: 'refuse', error: 'stale', detail: { reason: 'payment_request_closed', state: payReq.state } };
        }
        if (payReq.currency !== input.currency) {
          return {
            kind: 'refuse',
            error: 'currency_mismatch',
            detail: { expected: payReq.currency, provided: input.currency },
          };
        }
      }

      const snap = await computeObjectFinancialSnapshot(env.DB, target, input.currency);
      const nextNetPaidMinor = snap.netPaidMinor + input.amountMinor;
      const nextPaymentStatus = derivePaymentStatus({
        dueMinor: snap.dueMinor,
        netPaidMinor: nextNetPaidMinor,
        hasPendingRefund: snap.pendingRefundMinor > 0,
        hasIssuedRefund: snap.issuedRefundCount > 0,
      });

      const entryId = `le_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const idemKey = input.receiptIdempotencyKey ?? `rcpt:${actor.id}:${requestId}`;
      const entryRow: LedgerEntryRow = {
        id: entryId,
        kind: 'receipt',
        amount_minor: input.amountMinor,
        currency: input.currency,
        object_type: input.objectType,
        object_id: input.objectId,
        payment_request_id: payReq?.id ?? null,
        person_id: target.personId,
        programme_slug: target.programmeSlug,
        evidence_kind: input.evidenceKind,
        evidence_ref: input.evidenceRef,
        evidence_note: input.evidenceNote ?? null,
        contributor_residency: 'domestic',
        reverses_entry_id: null,
        refund_request_id: null,
        idempotency_key: idemKey,
        recorded_by: actor.id,
        recorded_at: now,
      };

      const rows: D1PreparedStatement[] = [
        env.DB
          .prepare(
            `INSERT INTO crm_ledger_entries
               (id, kind, amount_minor, currency, object_type, object_id, payment_request_id, person_id, programme_slug, evidence_kind, evidence_ref, evidence_note, contributor_residency, reverses_entry_id, refund_request_id, idempotency_key, recorded_by, recorded_at)
             VALUES (?, 'receipt', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'domestic', NULL, NULL, ?, ?, ?)`,
          )
          .bind(
            entryRow.id,
            entryRow.amount_minor,
            entryRow.currency,
            entryRow.object_type,
            entryRow.object_id,
            entryRow.payment_request_id,
            entryRow.person_id,
            entryRow.programme_slug,
            entryRow.evidence_kind,
            entryRow.evidence_ref,
            entryRow.evidence_note,
            entryRow.idempotency_key,
            actor.id,
            now,
          ),
        ...buildPerRequestAllocationUpdates(
          env.DB,
          snap.openRequests,
          [
            ...snap.entries.map((e) => ({ paymentRequestId: e.payment_request_id, amountMinor: e.amount_minor })),
            { paymentRequestId: entryRow.payment_request_id, amountMinor: entryRow.amount_minor },
          ],
          now,
        ),
      ];

      const fences: (D1PreparedStatement | (() => D1PreparedStatement))[] = [
        () => crmActorFence(env.DB, actor, tokenHash, 'crm.finance.record', '*'),
        buildFinancialSnapshotFence(env.DB, input.objectType, input.objectId, input.currency, snap),
      ];

      let bookingStateAfter: string | null = null;
      const personPatch: Record<string, unknown> = {
        [CRM_PROJECTION.paymentStatus]: nextPaymentStatus,
      };

      if (target.booking) {
        const effState = effectiveBookingState(target.booking, now);
        // Payment received AFTER hold expiry -> MUST move to `paid_without_seat` review state!
        // Uses current database time (SQLITE_NOW_MS) atomically so a hold expiring mid-flight cannot bypass review.
        if (effState === 'expired') {
          bookingStateAfter = 'paid_without_seat';
          personPatch[CRM_PROJECTION.bookingStatus] = 'paid_without_seat';
          if (target.booking.state === 'held' || target.booking.state === 'awaiting_payment') {
            fences.push(
              env.DB
                .prepare(
                  `SELECT CASE WHEN EXISTS (
                     SELECT 1 FROM crm_bookings
                     WHERE id = ? AND rev = ? AND hold_expires_at IS NOT NULL AND hold_expires_at <= MAX(?, ${SQLITE_NOW_MS})
                   ) THEN 1 ELSE json_extract('{', '$') END`,
                )
                .bind(target.booking.id, target.booking.rev, now),
            );
          }
          rows.push(
            env.DB
              .prepare(
                `UPDATE crm_allocations
                 SET released_at = ?, release_reason = 'hold_expired', updated_at = ?
                 WHERE booking_id = ? AND kind = 'hold' AND released_at IS NULL AND expires_at <= MAX(?, ${SQLITE_NOW_MS})`,
              )
              .bind(now, now, target.booking.id, now),
            env.DB
              .prepare(
                `UPDATE crm_bookings
                 SET state = 'paid_without_seat', hold_expires_at = NULL, payment_status = ?, rev = rev + 1, updated_at = ?
                 WHERE id = ? AND rev = ?`,
              )
              .bind(nextPaymentStatus, now, target.booking.id, target.booking.rev),
            changesOneFence(env.DB),
          );
        } else {
          bookingStateAfter = effState;
          if (
            (target.booking.state === 'held' || target.booking.state === 'awaiting_payment') &&
            target.booking.hold_expires_at !== null
          ) {
            fences.push(
              env.DB
                .prepare(
                  `SELECT CASE WHEN EXISTS (
                     SELECT 1 FROM crm_bookings
                     WHERE id = ? AND rev = ? AND hold_expires_at > MAX(?, ${SQLITE_NOW_MS})
                   ) THEN 1 ELSE json_extract('{', '$') END`,
                )
                .bind(target.booking.id, target.booking.rev, now),
            );
          }
          rows.push(
            env.DB
              .prepare(
                `UPDATE crm_bookings
                 SET payment_status = ?, rev = rev + 1, updated_at = ?
                 WHERE id = ? AND rev = ?`,
              )
              .bind(nextPaymentStatus, now, target.booking.id, target.booking.rev),
            changesOneFence(env.DB),
          );
        }
      } else if (target.membership) {
        fences.push(buildMembershipPeriodsFence(env.DB, target.membership.id, target.membership.activePeriods));
        rows.push(
          env.DB
            .prepare(
              `UPDATE crm_memberships
               SET payment_status = ?, rev = rev + 1, updated_at = ?
               WHERE id = ? AND rev = ?`,
            )
            .bind(nextPaymentStatus, now, target.membership.id, target.membership.rev),
          changesOneFence(env.DB),
        );
      }

      return {
        kind: 'commit',
        result: {
          entry: mapLedgerEntryRow(entryRow),
          paymentStatus: nextPaymentStatus,
          netPaidMinor: nextNetPaidMinor,
          dueMinor: snap.dueMinor,
          currency: input.currency,
          bookingStateAfter,
        },
        fences,
        rows,
        records: [{ id: target.personRec.id, collection: 'tasks', patch: personPatch, ts: now }],
        recordExpect: linkedRecordExpect(target),
      };
    },
    mapConstraintError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (/idempotency_key/i.test(msg)) {
        return { ok: false, error: 'idempotency_conflict', detail: { reason: 'duplicate_receipt' }, retryable: false };
      }
      return null;
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function reverseLedgerEntryCommand(): CommandDefinition<
  ReverseLedgerEntryInput,
  { reversalEntry: CrmLedgerEntryDto; paymentStatus: PaymentStatus; netPaidMinor: number }
> {
  return {
    name: 'ledger.reverse_entry',
    projectionKeys: [CRM_PROJECTION.paymentStatus, CRM_PROJECTION.membershipStatus, CRM_PROJECTION.membershipValidUntil],
    authorizeCoarse: (actor, via) =>
      via === 'ui' && canAccessCrmApi(actor) && evaluateCapability(actor, 'crm.finance.record', '*'),
    parseInput: (raw) => {
      const parsed = ReverseLedgerEntryInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    authorizeReplay: async (actor, input, _stored, { env }) => {
      if (!evaluateCapability(actor, 'crm.finance.record', '*')) return false;
      const orig = await env.DB
        .prepare(`SELECT object_type, object_id FROM crm_ledger_entries WHERE id = ?`)
        .bind(input.entryId)
        .first<{ object_type: 'booking' | 'membership'; object_id: string }>();
      if (!orig) return false;
      const target = await resolveFinancialTarget(env, actor.id, orig.object_type, orig.object_id);
      return target !== null;
    },
    plan: async ({ env, actor, tokenHash, input, requestId, now }) => {
      const orig = await env.DB
        .prepare(`SELECT * FROM crm_ledger_entries WHERE id = ?`)
        .bind(input.entryId)
        .first<LedgerEntryRow>();
      if (!orig) return { kind: 'refuse', error: 'not_found' };
      if (orig.kind === 'reversal') {
        return { kind: 'refuse', error: 'invalid_input', detail: { reason: 'cannot_reverse_a_reversal' } };
      }

      const alreadyRev = await env.DB
        .prepare(`SELECT id FROM crm_ledger_entries WHERE reverses_entry_id = ? LIMIT 1`)
        .bind(orig.id)
        .first();
      if (alreadyRev) {
        return { kind: 'refuse', error: 'stale', detail: { reason: 'entry_already_reversed' } };
      }

      const target = await resolveFinancialTarget(env, actor.id, orig.object_type, orig.object_id);
      if (!target) return { kind: 'refuse', error: 'not_found' };

      const snap = await computeObjectFinancialSnapshot(env.DB, target, orig.currency);
      const revAmount = -orig.amount_minor;
      const nextNetPaidMinor = snap.netPaidMinor + revAmount;
      const nextPaymentStatus = derivePaymentStatus({
        dueMinor: snap.dueMinor,
        netPaidMinor: nextNetPaidMinor,
        hasPendingRefund: snap.pendingRefundMinor > 0,
        hasIssuedRefund: snap.issuedRefundCount > 0,
      });

      const revId = `le_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const revRow: LedgerEntryRow = {
        id: revId,
        kind: 'reversal',
        amount_minor: revAmount,
        currency: orig.currency,
        object_type: orig.object_type,
        object_id: orig.object_id,
        payment_request_id: orig.payment_request_id,
        person_id: orig.person_id,
        programme_slug: orig.programme_slug,
        evidence_kind: 'reversal_reason',
        evidence_ref: `reverses:${orig.id}`,
        evidence_note: input.reason,
        contributor_residency: 'domestic',
        reverses_entry_id: orig.id,
        refund_request_id: null,
        idempotency_key: `rev:${orig.id}:${requestId}`,
        recorded_by: actor.id,
        recorded_at: now,
      };

      const rows: D1PreparedStatement[] = [
        env.DB
          .prepare(
            `INSERT INTO crm_ledger_entries
               (id, kind, amount_minor, currency, object_type, object_id, payment_request_id, person_id, programme_slug, evidence_kind, evidence_ref, evidence_note, contributor_residency, reverses_entry_id, refund_request_id, idempotency_key, recorded_by, recorded_at)
             VALUES (?, 'reversal', ?, ?, ?, ?, ?, ?, ?, 'reversal_reason', ?, ?, 'domestic', ?, NULL, ?, ?, ?)`,
          )
          .bind(
            revRow.id,
            revRow.amount_minor,
            revRow.currency,
            revRow.object_type,
            revRow.object_id,
            revRow.payment_request_id,
            revRow.person_id,
            revRow.programme_slug,
            revRow.evidence_ref,
            revRow.evidence_note,
            revRow.reverses_entry_id,
            revRow.idempotency_key,
            actor.id,
            now,
          ),
        ...buildPerRequestAllocationUpdates(
          env.DB,
          snap.openRequests,
          [
            ...snap.entries.map((e) => ({ paymentRequestId: e.payment_request_id, amountMinor: e.amount_minor })),
            { paymentRequestId: revRow.payment_request_id, amountMinor: revRow.amount_minor },
          ],
          now,
        ),
      ];

      const fences: (D1PreparedStatement | (() => D1PreparedStatement))[] = [
        () => crmActorFence(env.DB, actor, tokenHash, 'crm.finance.record', '*'),
        buildFinancialSnapshotFence(env.DB, orig.object_type, orig.object_id, orig.currency, snap),
      ];

      const personPatch: Record<string, unknown> = {
        [CRM_PROJECTION.paymentStatus]: nextPaymentStatus,
      };

      if (target.booking) {
        rows.push(
          env.DB
            .prepare(`UPDATE crm_bookings SET payment_status = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?`)
            .bind(nextPaymentStatus, now, target.booking.id, target.booking.rev),
          changesOneFence(env.DB),
        );
      } else if (target.membership) {
        fences.push(buildMembershipPeriodsFence(env.DB, target.membership.id, target.membership.activePeriods));
        rows.push(
          ...buildMembershipPostLedgerUpdates({
            db: env.DB,
            target,
            nextNetPaidMinor,
            nextPaymentStatus,
            reason: `reversal:${revRow.id}`,
            now,
            personPatch,
          }),
        );
      }

      return {
        kind: 'commit',
        result: {
          reversalEntry: mapLedgerEntryRow(revRow),
          paymentStatus: nextPaymentStatus,
          netPaidMinor: nextNetPaidMinor,
        },
        fences,
        rows,
        records: [{ id: target.personRec.id, collection: 'tasks', patch: personPatch, ts: now }],
        recordExpect: linkedRecordExpect(target),
      };
    },
    mapConstraintError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (/reverses_entry_id/i.test(msg)) {
        return { ok: false, error: 'stale', detail: { reason: 'entry_already_reversed' }, retryable: false };
      }
      return null;
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function configureRefundPolicyCommand(): CommandDefinition<
  ConfigureRefundPolicyInput,
  { policy: CrmRefundPolicyDto }
> {
  return {
    name: 'refund_policy.configure',
    authorizeCoarse: (actor, via) =>
      via === 'ui' &&
      canAccessCrmApi(actor) &&
      (actor.role === 'owner' || actor.role === 'admin') &&
      evaluateCapability(actor, 'crm.configure', '*'),
    parseInput: (raw) => {
      const parsed = ConfigureRefundPolicyInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    authorizeReplay: (actor) =>
      (actor.role === 'owner' || actor.role === 'admin') && evaluateCapability(actor, 'crm.configure', '*'),
    plan: async ({ env, actor, tokenHash, input, now }) => {
      if (isForeignCurrencyBlocked(input.currency)) {
        return {
          kind: 'refuse',
          error: 'invalid_input',
          detail: { reason: 'foreign_contribution_blocked_pending_policy', currency: input.currency },
        };
      }
      const existing = await env.DB
        .prepare(`SELECT * FROM crm_refund_policies WHERE currency = ?`)
        .bind(input.currency)
        .first<RefundPolicyRow>();

      const nextRow: RefundPolicyRow = {
        currency: input.currency,
        dual_approval_threshold_minor: input.dualApprovalThresholdMinor,
        allow_foreign_contributions: 0,
        rev: existing ? existing.rev + 1 : 1,
        updated_by: actor.id,
        updated_at: now,
      };
      const stmt = existing
        ? env.DB
            .prepare(
              `UPDATE crm_refund_policies
               SET dual_approval_threshold_minor = ?, rev = rev + 1, updated_by = ?, updated_at = ?
               WHERE currency = ? AND rev = ?`,
            )
            .bind(input.dualApprovalThresholdMinor, actor.id, now, input.currency, existing.rev)
        : env.DB
            .prepare(
              `INSERT INTO crm_refund_policies (currency, dual_approval_threshold_minor, allow_foreign_contributions, rev, updated_by, updated_at)
               VALUES (?, ?, 0, 1, ?, ?)`,
            )
            .bind(input.currency, input.dualApprovalThresholdMinor, actor.id, now);

      return {
        kind: 'commit',
        result: { policy: mapRefundPolicyRow(nextRow) },
        fences: [() => crmActorFence(env.DB, actor, tokenHash, 'crm.configure', '*')],
        rows: existing ? [stmt, changesOneFence(env.DB)] : [stmt],
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function requestRefundCommand(): CommandDefinition<RequestRefundInput, { refundRequest: CrmRefundRequestDto }> {
  return {
    name: 'refund.request',
    authorizeCoarse: (actor, via) =>
      via === 'ui' && canAccessCrmApi(actor) && evaluateCapability(actor, 'crm.finance.record', '*'),
    parseInput: (raw) => {
      const parsed = RequestRefundInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    authorizeReplay: async (actor, input, _stored, { env }) => {
      if (!evaluateCapability(actor, 'crm.finance.record', '*')) return false;
      const target = await resolveFinancialTarget(env, actor.id, input.objectType, input.objectId);
      return target !== null;
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const target = await resolveFinancialTarget(env, actor.id, input.objectType, input.objectId);
      if (!target) return { kind: 'refuse', error: 'not_found' };

      const [snap, policy] = await Promise.all([
        computeObjectFinancialSnapshot(env.DB, target, input.currency),
        env.DB.prepare(`SELECT * FROM crm_refund_policies WHERE currency = ?`).bind(input.currency).first<RefundPolicyRow>(),
      ]);
      const refundableMinor = Math.max(0, snap.netPaidMinor - snap.pendingRefundMinor);
      if (input.amountMinor > refundableMinor) {
        return {
          kind: 'refuse',
          error: 'invalid_input',
          detail: { reason: 'excessive_refund', refundableMinor, requestedMinor: input.amountMinor },
        };
      }

      // Unconfigured policy threshold -> ALWAYS requires independent approval (fail closed)!
      const needsIndependent = requiresIndependentRefundApproval(
        input.amountMinor,
        policy?.dual_approval_threshold_minor ?? null,
      );
      const initialState: RefundState = needsIndependent ? 'requested' : 'approved';
      const id = `rf_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

      const row: RefundRequestRow = {
        id,
        object_type: input.objectType,
        object_id: input.objectId,
        person_id: target.personId,
        programme_slug: target.programmeSlug,
        amount_minor: input.amountMinor,
        currency: input.currency,
        reason: input.reason,
        state: initialState,
        requires_independent_approval: needsIndependent ? 1 : 0,
        requested_by: actor.id,
        requested_at: now,
        approved_by: needsIndependent ? null : actor.id,
        approved_at: needsIndependent ? null : now,
        decision_note: needsIndependent ? null : 'Within configured threshold',
        issued_entry_id: null,
        issued_by: null,
        issued_at: null,
        rev: 1,
        updated_at: now,
      };

      const refundableFence = env.DB
        .prepare(
          `SELECT CASE WHEN (
             COALESCE((SELECT SUM(amount_minor) FROM crm_ledger_entries WHERE object_type = ? AND object_id = ? AND currency = ?), 0)
             - COALESCE((SELECT SUM(amount_minor) FROM crm_refund_requests WHERE object_type = ? AND object_id = ? AND currency = ? AND state IN ('requested', 'approved')), 0)
           ) >= ? THEN 1 ELSE json_extract('{', '$') END`,
        )
        .bind(input.objectType, input.objectId, input.currency, input.objectType, input.objectId, input.currency, input.amountMinor);

      const policyFence = policy
        ? env.DB
            .prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM crm_refund_policies WHERE currency = ? AND rev = ?) THEN 1 ELSE json_extract('{', '$') END`)
            .bind(input.currency, policy.rev)
        : env.DB
            .prepare(`SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM crm_refund_policies WHERE currency = ?) THEN 1 ELSE json_extract('{', '$') END`)
            .bind(input.currency);

      const rows: D1PreparedStatement[] = [
        env.DB
          .prepare(
            `INSERT INTO crm_refund_requests
               (id, object_type, object_id, person_id, programme_slug, amount_minor, currency, reason, state, requires_independent_approval, requested_by, requested_at, approved_by, approved_at, decision_note, issued_entry_id, issued_by, issued_at, rev, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 1, ?)`,
          )
          .bind(
            row.id,
            row.object_type,
            row.object_id,
            row.person_id,
            row.programme_slug,
            row.amount_minor,
            row.currency,
            row.reason,
            row.state,
            row.requires_independent_approval,
            actor.id,
            now,
            row.approved_by,
            row.approved_at,
            row.decision_note,
            now,
          ),
      ];
      if (target.booking) {
        rows.push(
          env.DB
            .prepare(`UPDATE crm_bookings SET payment_status = 'refund_pending', rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?`)
            .bind(now, target.booking.id, target.booking.rev),
          changesOneFence(env.DB),
        );
      } else if (target.membership) {
        rows.push(
          env.DB
            .prepare(`UPDATE crm_memberships SET payment_status = 'refund_pending', rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?`)
            .bind(now, target.membership.id, target.membership.rev),
          changesOneFence(env.DB),
        );
      }

      return {
        kind: 'commit',
        result: { refundRequest: mapRefundRequestRow(row) },
        fences: [
          () => crmActorFence(env.DB, actor, tokenHash, 'crm.finance.record', '*'),
          buildFinancialSnapshotFence(env.DB, input.objectType, input.objectId, input.currency, snap),
          refundableFence,
          policyFence,
        ],
        rows,
        recordExpect: linkedRecordExpect(target),
        forceRecordsCommit: true,
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function decideRefundCommand(): CommandDefinition<DecideRefundInput, { refundRequest: CrmRefundRequestDto }> {
  return {
    name: 'refund.decide',
    authorizeCoarse: (actor, via) =>
      via === 'ui' && canAccessCrmApi(actor) && evaluateCapability(actor, 'crm.refund.approve', '*'),
    parseInput: (raw) => {
      const parsed = DecideRefundInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    authorizeReplay: async (actor, input, _stored, { env }) => {
      if (!evaluateCapability(actor, 'crm.refund.approve', '*')) return false;
      const req = await env.DB
        .prepare(`SELECT object_type, object_id FROM crm_refund_requests WHERE id = ?`)
        .bind(input.refundRequestId)
        .first<{ object_type: 'booking' | 'membership'; object_id: string }>();
      if (!req) return false;
      const target = await resolveFinancialTarget(env, actor.id, req.object_type, req.object_id);
      return target !== null;
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const req = await env.DB
        .prepare(`SELECT * FROM crm_refund_requests WHERE id = ?`)
        .bind(input.refundRequestId)
        .first<RefundRequestRow>();
      if (!req) return { kind: 'refuse', error: 'not_found' };
      if (input.expectedRev !== undefined && req.rev !== input.expectedRev) {
        return { kind: 'refuse', error: 'stale' };
      }
      if (req.state !== 'requested') {
        return { kind: 'refuse', error: 'stale', detail: { reason: 'refund_not_awaiting_approval', state: req.state } };
      }
      if (req.requested_by === actor.id) {
        return { kind: 'refuse', error: 'forbidden', detail: { reason: 'self_approval_forbidden' } };
      }
      const target = await resolveFinancialTarget(env, actor.id, req.object_type, req.object_id);
      if (!target) return { kind: 'refuse', error: 'not_found' };

      const nextState: RefundState = input.decision === 'approve' ? 'approved' : 'rejected';
      const updated: RefundRequestRow = {
        ...req,
        state: nextState,
        approved_by: actor.id,
        approved_at: now,
        decision_note: input.note,
        rev: req.rev + 1,
        updated_at: now,
      };

      const fences: (D1PreparedStatement | (() => D1PreparedStatement))[] = [
        () => crmActorFence(env.DB, actor, tokenHash, 'crm.refund.approve', '*'),
      ];
      const rows: D1PreparedStatement[] = [
        env.DB
          .prepare(
            `UPDATE crm_refund_requests
             SET state = ?, approved_by = ?, approved_at = ?, decision_note = ?, rev = rev + 1, updated_at = ?
             WHERE id = ? AND rev = ? AND state = 'requested' AND requested_by != ?`,
          )
          .bind(nextState, actor.id, now, input.note, now, req.id, req.rev, actor.id),
        changesOneFence(env.DB),
      ];

      if (nextState === 'rejected') {
        const snap = await computeObjectFinancialSnapshot(env.DB, target, req.currency);
        fences.push(buildFinancialSnapshotFence(env.DB, req.object_type, req.object_id, req.currency, snap));
        const remainingPending = Math.max(0, snap.pendingRefundMinor - req.amount_minor);
        const ps = derivePaymentStatus({
          dueMinor: snap.dueMinor,
          netPaidMinor: snap.netPaidMinor,
          hasPendingRefund: remainingPending > 0,
          hasIssuedRefund: snap.issuedRefundCount > 0,
        });
        if (target.booking) {
          rows.push(
            env.DB
              .prepare(`UPDATE crm_bookings SET payment_status = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?`)
              .bind(ps, now, target.booking.id, target.booking.rev),
            changesOneFence(env.DB),
          );
        } else if (target.membership) {
          rows.push(
            env.DB
              .prepare(`UPDATE crm_memberships SET payment_status = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?`)
              .bind(ps, now, target.membership.id, target.membership.rev),
            changesOneFence(env.DB),
          );
        }
      }

      return {
        kind: 'commit',
        result: { refundRequest: mapRefundRequestRow(updated) },
        fences,
        rows,
        recordExpect: linkedRecordExpect(target),
        forceRecordsCommit: true,
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function issueRefundCommand(): CommandDefinition<
  IssueRefundInput,
  { refundRequest: CrmRefundRequestDto; entry: CrmLedgerEntryDto; paymentStatus: PaymentStatus }
> {
  return {
    name: 'refund.issue',
    projectionKeys: [CRM_PROJECTION.paymentStatus, CRM_PROJECTION.membershipStatus, CRM_PROJECTION.membershipValidUntil],
    authorizeCoarse: (actor, via) =>
      via === 'ui' && canAccessCrmApi(actor) && evaluateCapability(actor, 'crm.finance.record', '*'),
    parseInput: (raw) => {
      const parsed = IssueRefundInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    authorizeReplay: async (actor, input, _stored, { env }) => {
      if (!evaluateCapability(actor, 'crm.finance.record', '*')) return false;
      const req = await env.DB
        .prepare(`SELECT object_type, object_id FROM crm_refund_requests WHERE id = ?`)
        .bind(input.refundRequestId)
        .first<{ object_type: 'booking' | 'membership'; object_id: string }>();
      if (!req) return false;
      const target = await resolveFinancialTarget(env, actor.id, req.object_type, req.object_id);
      return target !== null;
    },
    plan: async ({ env, actor, tokenHash, input, requestId, now }) => {
      const req = await env.DB
        .prepare(`SELECT * FROM crm_refund_requests WHERE id = ?`)
        .bind(input.refundRequestId)
        .first<RefundRequestRow>();
      if (!req) return { kind: 'refuse', error: 'not_found' };
      if (input.expectedRev !== undefined && req.rev !== input.expectedRev) {
        return { kind: 'refuse', error: 'stale' };
      }
      if (req.state === 'requested') {
        return { kind: 'refuse', error: 'approval_required', detail: { reason: 'independent_approval_required' } };
      }
      if (req.state !== 'approved') {
        return { kind: 'refuse', error: 'stale', detail: { reason: 'refund_not_approved', state: req.state } };
      }
      if (req.requires_independent_approval === 1 && (!req.approved_by || req.approved_by === req.requested_by)) {
        return { kind: 'refuse', error: 'approval_required', detail: { reason: 'independent_approval_missing' } };
      }

      const target = await resolveFinancialTarget(env, actor.id, req.object_type, req.object_id);
      if (!target) return { kind: 'refuse', error: 'not_found' };

      const snap = await computeObjectFinancialSnapshot(env.DB, target, req.currency);
      if (req.amount_minor > snap.netPaidMinor) {
        return {
          kind: 'refuse',
          error: 'invalid_input',
          detail: { reason: 'excessive_refund', netPaidMinor: snap.netPaidMinor, requestedMinor: req.amount_minor },
        };
      }

      const nextNetPaidMinor = snap.netPaidMinor - req.amount_minor;
      const remainingPending = Math.max(0, snap.pendingRefundMinor - req.amount_minor);
      const nextPaymentStatus = derivePaymentStatus({
        dueMinor: snap.dueMinor,
        netPaidMinor: nextNetPaidMinor,
        hasPendingRefund: remainingPending > 0,
        hasIssuedRefund: true,
      });

      const entryId = `le_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const entryRow: LedgerEntryRow = {
        id: entryId,
        kind: 'refund',
        amount_minor: -req.amount_minor,
        currency: req.currency,
        object_type: req.object_type,
        object_id: req.object_id,
        payment_request_id: null,
        person_id: req.person_id,
        programme_slug: req.programme_slug,
        evidence_kind: 'refund_reference',
        evidence_ref: input.evidenceRef,
        evidence_note: input.evidenceNote ?? req.reason,
        contributor_residency: 'domestic',
        reverses_entry_id: null,
        refund_request_id: req.id,
        idempotency_key: `refund:${req.id}:${requestId}`,
        recorded_by: actor.id,
        recorded_at: now,
      };
      const updatedReq: RefundRequestRow = {
        ...req,
        state: 'issued',
        issued_entry_id: entryId,
        issued_by: actor.id,
        issued_at: now,
        rev: req.rev + 1,
        updated_at: now,
      };

      const netPaidFence = env.DB
        .prepare(
          `SELECT CASE WHEN COALESCE(
             (SELECT SUM(amount_minor) FROM crm_ledger_entries WHERE object_type = ? AND object_id = ? AND currency = ?),
             0
           ) >= ? THEN 1 ELSE json_extract('{', '$') END`,
        )
        .bind(req.object_type, req.object_id, req.currency, req.amount_minor);

      const fences: (D1PreparedStatement | (() => D1PreparedStatement))[] = [
        () => crmActorFence(env.DB, actor, tokenHash, 'crm.finance.record', '*'),
        buildFinancialSnapshotFence(env.DB, req.object_type, req.object_id, req.currency, snap),
        netPaidFence,
      ];

      const rows: D1PreparedStatement[] = [
        env.DB
          .prepare(
            `INSERT INTO crm_ledger_entries
               (id, kind, amount_minor, currency, object_type, object_id, payment_request_id, person_id, programme_slug, evidence_kind, evidence_ref, evidence_note, contributor_residency, reverses_entry_id, refund_request_id, idempotency_key, recorded_by, recorded_at)
             VALUES (?, 'refund', ?, ?, ?, ?, NULL, ?, ?, 'refund_reference', ?, ?, 'domestic', NULL, ?, ?, ?, ?)`,
          )
          .bind(
            entryRow.id,
            entryRow.amount_minor,
            entryRow.currency,
            entryRow.object_type,
            entryRow.object_id,
            entryRow.person_id,
            entryRow.programme_slug,
            entryRow.evidence_ref,
            entryRow.evidence_note,
            entryRow.refund_request_id,
            entryRow.idempotency_key,
            actor.id,
            now,
          ),
        env.DB
          .prepare(
            `UPDATE crm_refund_requests
             SET state = 'issued', issued_entry_id = ?, issued_by = ?, issued_at = ?, rev = rev + 1, updated_at = ?
             WHERE id = ? AND rev = ? AND state = 'approved'`,
          )
          .bind(entryId, actor.id, now, now, req.id, req.rev),
        changesOneFence(env.DB),
        ...buildPerRequestAllocationUpdates(
          env.DB,
          snap.openRequests,
          [
            ...snap.entries.map((e) => ({ paymentRequestId: e.payment_request_id, amountMinor: e.amount_minor })),
            { paymentRequestId: null, amountMinor: entryRow.amount_minor },
          ],
          now,
        ),
      ];

      const personPatch: Record<string, unknown> = {
        [CRM_PROJECTION.paymentStatus]: nextPaymentStatus,
      };
      if (target.booking) {
        rows.push(
          env.DB
            .prepare(`UPDATE crm_bookings SET payment_status = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?`)
            .bind(nextPaymentStatus, now, target.booking.id, target.booking.rev),
          changesOneFence(env.DB),
        );
      } else if (target.membership) {
        fences.push(buildMembershipPeriodsFence(env.DB, target.membership.id, target.membership.activePeriods));
        rows.push(
          ...buildMembershipPostLedgerUpdates({
            db: env.DB,
            target,
            nextNetPaidMinor,
            nextPaymentStatus,
            reason: `refund:${req.id}`,
            now,
            personPatch,
          }),
        );
      }

      return {
        kind: 'commit',
        result: {
          refundRequest: mapRefundRequestRow(updatedReq),
          entry: mapLedgerEntryRow(entryRow),
          paymentStatus: nextPaymentStatus,
        },
        fences,
        rows,
        records: [{ id: target.personRec.id, collection: 'tasks', patch: personPatch, ts: now }],
        recordExpect: linkedRecordExpect(target),
      };
    },
    mapConstraintError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (/refund_request_id/i.test(msg)) {
        return { ok: false, error: 'stale', detail: { reason: 'refund_already_issued' }, retryable: false };
      }
      return null;
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

export function createS7MoneyCommandDefs(): AnyCommandDefinition[] {
  return [
    createPaymentRequestCommand(),
    recordManualReceiptCommand(),
    reverseLedgerEntryCommand(),
    configureRefundPolicyCommand(),
    requestRefundCommand(),
    decideRefundCommand(),
    issueRefundCommand(),
  ];
}

/* ---------- S7 Read API ---------- */

export async function readMoneyOverview(
  env: Env,
  actorId: string,
  tokenHash: string,
): Promise<
  | { status: 200; body: MoneyOverviewResponse }
  | { status: 401 | 403 | 404; body: { error: string } }
> {
  if (!isCrmEnabled(env)) return { status: 404, body: { error: 'not_found' } };
  const now = Date.now();
  const [sessionRes, grantsRes, prRes, ledRes, refRes, polRes] = await env.DB.batch([
    sessionAuthStmt(env.DB, actorId, tokenHash, now),
    actorGrantsStmt(env.DB, actorId),
    env.DB.prepare(`SELECT * FROM crm_payment_requests ORDER BY created_at DESC LIMIT 200`),
    env.DB.prepare(`SELECT * FROM crm_ledger_entries ORDER BY recorded_at DESC LIMIT 300`),
    env.DB.prepare(`SELECT * FROM crm_refund_requests ORDER BY requested_at DESC LIMIT 200`),
    env.DB.prepare(`SELECT * FROM crm_refund_policies ORDER BY currency ASC LIMIT 20`),
  ]);

  const batchAuth = evaluateCrmReadAuthRows(
    sessionRes.results[0] as CrmSessionRow | undefined,
    grantsRes.results as unknown as CrmGrantRow[],
  );
  if (!batchAuth.ok) return { status: batchAuth.status, body: batchAuth.body };

  const hasFinanceRead = evaluateCapability(batchAuth.actor, 'crm.finance.read', '*');
  const hasRefundApprove = evaluateCapability(batchAuth.actor, 'crm.refund.approve', '*');
  if (!hasFinanceRead && !hasRefundApprove) {
    return { status: 403, body: { error: 'forbidden' } };
  }

  const prRows = prRes.results as unknown as PaymentRequestRow[];
  const ledRows = ledRes.results as unknown as LedgerEntryRow[];
  const refRows = refRes.results as unknown as RefundRequestRow[];
  const polRows = polRes.results as unknown as RefundPolicyRow[];

  // Resolve linked Event record IDs for all booking-backed financial rows so ReadGate checks BOTH Person AND Event!
  const bookingIds = [
    ...new Set([
      ...prRows.filter((r) => r.object_type === 'booking').map((r) => r.object_id),
      ...ledRows.filter((r) => r.object_type === 'booking').map((r) => r.object_id),
      ...refRows.filter((r) => r.object_type === 'booking').map((r) => r.object_id),
    ]),
  ];
  const bookingEventById = new Map<string, string>();
  if (bookingIds.length > 0) {
    const bkEvRes = await env.DB
      .prepare(
        `SELECT b.id AS booking_id, e.event_record_id
         FROM crm_bookings b
         JOIN crm_editions e ON e.id = b.edition_id
         WHERE b.id IN (SELECT value FROM json_each(?))`,
      )
      .bind(JSON.stringify(bookingIds))
      .all<{ booking_id: string; event_record_id: string }>();
    for (const r of bkEvRes.results) {
      bookingEventById.set(r.booking_id, r.event_record_id);
    }
  }

  const gate = createReadGate(env.DB, actorId);
  const recordIdsToCheck = [
    ...new Set([
      ...prRows.map((r) => r.person_id),
      ...ledRows.map((r) => r.person_id),
      ...refRows.map((r) => r.person_id),
      ...bookingEventById.values(),
    ]),
  ];
  const readableRecords = await loadReadableTaskRecords(env, gate, recordIdsToCheck);

  const finalAuth = await finalizeCrmReadAuth(env, actorId, tokenHash, { gate });
  if (!finalAuth.ok) return { status: finalAuth.status, body: finalAuth.body };

  const finalCanReadFinance = evaluateCapability(finalAuth.actor, 'crm.finance.read', '*');
  const finalCanApproveRefunds = evaluateCapability(finalAuth.actor, 'crm.refund.approve', '*');
  if (!finalCanReadFinance && !finalCanApproveRefunds) {
    return { status: 403, body: { error: 'forbidden' } };
  }

  const canSeeFinancialRow = (r: { object_type: 'booking' | 'membership'; object_id: string; person_id: string }): boolean => {
    if (!readableRecords.has(r.person_id)) return false;
    if (r.object_type === 'booking') {
      const evId = bookingEventById.get(r.object_id);
      if (!evId || !readableRecords.has(evId)) return false;
    }
    return true;
  };

  // Payment evidence & raw ledger entries are strictly protected behind `crm.finance.read`.
  // Approvers holding ONLY `crm.refund.approve` receive refund requests without exposing ledger payment evidence.
  const visPr = finalCanReadFinance ? prRows.filter(canSeeFinancialRow) : [];
  const visLed = finalCanReadFinance ? ledRows.filter(canSeeFinancialRow) : [];
  const visRef = refRows.filter(canSeeFinancialRow);

  const totalsByCurrency = summarizeLedgerByCurrency(
    visLed.map((e) => ({ kind: e.kind, amountMinor: e.amount_minor, currency: e.currency })),
  );

  const progMap = new Map<string, { programmeSlug: string; currency: string; receiptsMinor: number; refundsMinor: number; netMinor: number }>();
  for (const e of visLed) {
    const slug = e.programme_slug ?? 'unassigned';
    const key = `${slug}|${e.currency}`;
    const cur = progMap.get(key) ?? {
      programmeSlug: slug,
      currency: e.currency,
      receiptsMinor: 0,
      refundsMinor: 0,
      netMinor: 0,
    };
    if (e.kind === 'receipt') cur.receiptsMinor += e.amount_minor;
    else if (e.kind === 'refund') cur.refundsMinor += e.amount_minor;
    cur.netMinor += e.amount_minor;
    progMap.set(key, cur);
  }
  const programmeIncomeByCurrency = [...progMap.values()].sort((a, b) =>
    a.programmeSlug === b.programmeSlug ? a.currency.localeCompare(b.currency) : a.programmeSlug.localeCompare(b.programmeSlug),
  );

  return {
    status: 200,
    body: MoneyOverviewResponseSchema.parse({
      paymentRequests: visPr.map(mapPaymentRequestRow),
      ledgerEntries: visLed.map(mapLedgerEntryRow),
      refundRequests: visRef.map(mapRefundRequestRow),
      refundPolicies: polRows.map(mapRefundPolicyRow),
      totalsByCurrency,
      programmeIncomeByCurrency,
      canRecordFinance: evaluateCapability(finalAuth.actor, 'crm.finance.record', '*'),
      canApproveRefunds: finalCanApproveRefunds,
      partial:
        visPr.length < prRows.length ||
        visLed.length < ledRows.length ||
        visRef.length < refRows.length ||
        ledRows.length >= 300,
    }),
  };
}
