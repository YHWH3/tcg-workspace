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
  derivePaymentStatus,
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

interface TargetObjectContext {
  objectType: 'booking' | 'membership';
  objectId: string;
  personId: string;
  programmeSlug: string | null;
  expectedCurrency: string | null;
  booking?: BookingRow;
  membership?: {
    id: string;
    scheme_id: string;
    person_id: string;
    state: string;
    valid_until: number | null;
    period_count: number;
    rev: number;
    contribution_amount_minor: number | null;
    currency: string | null;
  };
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
    return {
      objectType: 'booking',
      objectId: bk.id,
      personId: bk.booker_person_id,
      programmeSlug: ed.programme_slug,
      expectedCurrency: bk.currency,
      booking: bk,
    };
  }

  const mem = await env.DB
    .prepare(
      `SELECT m.id, m.scheme_id, m.person_id, m.state, m.valid_until, m.period_count, m.rev,
              s.programme_slug, s.contribution_amount_minor, s.currency
       FROM crm_memberships m
       JOIN crm_membership_schemes s ON s.id = m.scheme_id
       WHERE m.id = ?`,
    )
    .bind(objectId)
    .first<{
      id: string;
      scheme_id: string;
      person_id: string;
      state: string;
      valid_until: number | null;
      period_count: number;
      rev: number;
      programme_slug: string;
      contribution_amount_minor: number | null;
      currency: string | null;
    }>();
  if (!mem) return null;
  const personRec = await loadReadableTaskRecord(env, actorId, mem.person_id);
  if (!personRec) return null;
  return {
    objectType: 'membership',
    objectId: mem.id,
    personId: mem.person_id,
    programmeSlug: mem.programme_slug,
    expectedCurrency: mem.currency,
    membership: mem,
  };
}

async function computeObjectFinancialSnapshot(
  db: D1Database,
  objectType: 'booking' | 'membership',
  objectId: string,
  currency: string,
): Promise<{
  dueMinor: number;
  netPaidMinor: number;
  pendingRefundMinor: number;
  issuedRefundCount: number;
  openRequests: PaymentRequestRow[];
}> {
  const [reqRes, ledRes, refRes] = await db.batch([
    db
      .prepare(
        `SELECT * FROM crm_payment_requests
         WHERE object_type = ? AND object_id = ? AND currency = ? AND state NOT IN ('cancelled', 'expired')
         ORDER BY created_at ASC`,
      )
      .bind(objectType, objectId, currency),
    db
      .prepare(
        `SELECT COALESCE(SUM(amount_minor), 0) AS net_minor
         FROM crm_ledger_entries
         WHERE object_type = ? AND object_id = ? AND currency = ?`,
      )
      .bind(objectType, objectId, currency),
    db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN state IN ('requested', 'approved') THEN amount_minor ELSE 0 END), 0) AS pending_minor,
           COALESCE(SUM(CASE WHEN state = 'issued' THEN 1 ELSE 0 END), 0) AS issued_count
         FROM crm_refund_requests
         WHERE object_type = ? AND object_id = ? AND currency = ?`,
      )
      .bind(objectType, objectId, currency),
  ]);
  const openRequests = reqRes.results as unknown as PaymentRequestRow[];
  const dueMinor = openRequests.reduce((sum, r) => sum + r.amount_minor, 0);
  const netPaidMinor = Number((ledRes.results[0] as { net_minor: number } | undefined)?.net_minor ?? 0);
  const refRow = refRes.results[0] as { pending_minor: number; issued_count: number } | undefined;
  return {
    dueMinor,
    netPaidMinor,
    pendingRefundMinor: Number(refRow?.pending_minor ?? 0),
    issuedRefundCount: Number(refRow?.issued_count ?? 0),
    openRequests,
  };
}

function deriveRequestState(dueMinor: number, netPaidMinor: number): PaymentRequestState {
  if (netPaidMinor <= 0) return 'issued';
  if (netPaidMinor < dueMinor) return 'part_paid';
  if (netPaidMinor === dueMinor) return 'paid';
  return 'overpaid';
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

      // Transition held booking -> awaiting_payment while preserving hold_expires_at
      if (target.booking && target.booking.state === 'held') {
        rows.push(
          env.DB
            .prepare(
              `UPDATE crm_bookings SET state = 'awaiting_payment', rev = rev + 1, updated_at = ?
               WHERE id = ? AND state = 'held'`,
            )
            .bind(now, target.booking.id),
        );
      }

      return {
        kind: 'commit',
        result: { paymentRequest: mapPaymentRequestRow(row) },
        fences: [() => crmActorFence(env.DB, actor, tokenHash, 'crm.finance.record', '*')],
        rows,
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
        if (payReq.currency !== input.currency) {
          return {
            kind: 'refuse',
            error: 'currency_mismatch',
            detail: { expected: payReq.currency, provided: input.currency },
          };
        }
      }

      const snap = await computeObjectFinancialSnapshot(env.DB, input.objectType, input.objectId, input.currency);
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
        payment_request_id: payReq?.id ?? snap.openRequests[0]?.id ?? null,
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
      ];

      // Update payment requests state based on authoritative ledger net
      if (snap.openRequests.length > 0) {
        const reqState = deriveRequestState(snap.dueMinor, nextNetPaidMinor);
        rows.push(
          env.DB
            .prepare(
              `UPDATE crm_payment_requests
               SET state = ?, rev = rev + 1, updated_at = ?
               WHERE object_type = ? AND object_id = ? AND currency = ? AND state NOT IN ('cancelled', 'expired')`,
            )
            .bind(reqState, now, input.objectType, input.objectId, input.currency),
        );
      }

      let bookingStateAfter: string | null = null;
      const personRec = await loadReadableTaskRecord(env, actor.id, target.personId);
      if (!personRec) return { kind: 'refuse', error: 'not_found' };

      const personPatch: Record<string, unknown> = {
        [CRM_PROJECTION.paymentStatus]: nextPaymentStatus,
      };

      if (target.booking) {
        const effState = effectiveBookingState(target.booking, now);
        // Payment received AFTER hold expiry -> MUST move to `paid_without_seat` review state!
        // NEVER auto-oversell, NEVER auto-confirm, NEVER auto-refund!
        if (effState === 'expired') {
          bookingStateAfter = 'paid_without_seat';
          personPatch[CRM_PROJECTION.bookingStatus] = 'paid_without_seat';
          rows.push(
            env.DB
              .prepare(
                `UPDATE crm_allocations
                 SET released_at = ?, release_reason = 'hold_expired', updated_at = ?
                 WHERE booking_id = ? AND kind = 'hold' AND released_at IS NULL AND expires_at <= ?`,
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
        fences: [() => crmActorFence(env.DB, actor, tokenHash, 'crm.finance.record', '*')],
        rows,
        records: [{ id: personRec.id, collection: 'tasks', patch: personPatch, ts: now }],
        recordExpect: new Map([[personRec.id, personRec.seq]]),
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
    projectionKeys: [CRM_PROJECTION.paymentStatus, CRM_PROJECTION.membershipStatus],
    authorizeCoarse: (actor, via) =>
      via === 'ui' && canAccessCrmApi(actor) && evaluateCapability(actor, 'crm.finance.record', '*'),
    parseInput: (raw) => {
      const parsed = ReverseLedgerEntryInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
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
      const personRec = await loadReadableTaskRecord(env, actor.id, orig.person_id);
      if (!personRec) return { kind: 'refuse', error: 'not_found' };

      const snap = await computeObjectFinancialSnapshot(env.DB, orig.object_type, orig.object_id, orig.currency);
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
      ];

      if (snap.openRequests.length > 0) {
        const reqState = deriveRequestState(snap.dueMinor, nextNetPaidMinor);
        rows.push(
          env.DB
            .prepare(
              `UPDATE crm_payment_requests
               SET state = ?, rev = rev + 1, updated_at = ?
               WHERE object_type = ? AND object_id = ? AND currency = ? AND state NOT IN ('cancelled', 'expired')`,
            )
            .bind(reqState, now, orig.object_type, orig.object_id, orig.currency),
        );
      }

      const personPatch: Record<string, unknown> = {
        [CRM_PROJECTION.paymentStatus]: nextPaymentStatus,
      };

      if (target.booking) {
        rows.push(
          env.DB
            .prepare(`UPDATE crm_bookings SET payment_status = ?, rev = rev + 1, updated_at = ? WHERE id = ?`)
            .bind(nextPaymentStatus, now, target.booking.id),
        );
      } else if (target.membership) {
        // S8 financial consistency: NEVER leave an unsupported 'active' membership when contribution receipt is reversed!
        const reqPerPeriod = target.membership.contribution_amount_minor ?? 0;
        const requiredForPeriods = reqPerPeriod * Math.max(1, target.membership.period_count);
        const unsupportedActive =
          (target.membership.state === 'active' || target.membership.state === 'renewal_due') &&
          (requiredForPeriods <= 0 || nextNetPaidMinor < requiredForPeriods);
        if (unsupportedActive) {
          rows.push(
            env.DB
              .prepare(
                `UPDATE crm_memberships
                 SET state = 'awaiting_contribution', payment_status = ?, rev = rev + 1, updated_at = ?
                 WHERE id = ? AND rev = ?`,
              )
              .bind(nextPaymentStatus, now, target.membership.id, target.membership.rev),
            changesOneFence(env.DB),
          );
          personPatch[CRM_PROJECTION.membershipStatus] = 'awaiting_contribution';
        } else {
          rows.push(
            env.DB
              .prepare(`UPDATE crm_memberships SET payment_status = ?, rev = rev + 1, updated_at = ? WHERE id = ?`)
              .bind(nextPaymentStatus, now, target.membership.id),
          );
        }
      }

      return {
        kind: 'commit',
        result: {
          reversalEntry: mapLedgerEntryRow(revRow),
          paymentStatus: nextPaymentStatus,
          netPaidMinor: nextNetPaidMinor,
        },
        fences: [() => crmActorFence(env.DB, actor, tokenHash, 'crm.finance.record', '*')],
        rows,
        records: [{ id: personRec.id, collection: 'tasks', patch: personPatch, ts: now }],
        recordExpect: new Map([[personRec.id, personRec.seq]]),
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
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const target = await resolveFinancialTarget(env, actor.id, input.objectType, input.objectId);
      if (!target) return { kind: 'refuse', error: 'not_found' };

      const [snap, policy] = await Promise.all([
        computeObjectFinancialSnapshot(env.DB, input.objectType, input.objectId, input.currency),
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

      // SQL fence rechecks netPaid - pendingRefunds >= amountMinor atomically!
      const refundableFence = env.DB
        .prepare(
          `SELECT CASE WHEN (
             COALESCE((SELECT SUM(amount_minor) FROM crm_ledger_entries WHERE object_type = ? AND object_id = ? AND currency = ?), 0)
             - COALESCE((SELECT SUM(amount_minor) FROM crm_refund_requests WHERE object_type = ? AND object_id = ? AND currency = ? AND state IN ('requested', 'approved')), 0)
           ) >= ? THEN 1 ELSE json_extract('{', '$') END`,
        )
        .bind(input.objectType, input.objectId, input.currency, input.objectType, input.objectId, input.currency, input.amountMinor);

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
            .prepare(`UPDATE crm_bookings SET payment_status = 'refund_pending', rev = rev + 1, updated_at = ? WHERE id = ?`)
            .bind(now, target.booking.id),
        );
      } else if (target.membership) {
        rows.push(
          env.DB
            .prepare(`UPDATE crm_memberships SET payment_status = 'refund_pending', rev = rev + 1, updated_at = ? WHERE id = ?`)
            .bind(now, target.membership.id),
        );
      }

      return {
        kind: 'commit',
        result: { refundRequest: mapRefundRequestRow(row) },
        fences: [() => crmActorFence(env.DB, actor, tokenHash, 'crm.finance.record', '*'), refundableFence],
        rows,
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
      // Dual control: NEVER allow self-approval!
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
        const snap = await computeObjectFinancialSnapshot(env.DB, req.object_type, req.object_id, req.currency);
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
              .prepare(`UPDATE crm_bookings SET payment_status = ?, rev = rev + 1, updated_at = ? WHERE id = ?`)
              .bind(ps, now, target.booking.id),
          );
        } else if (target.membership) {
          rows.push(
            env.DB
              .prepare(`UPDATE crm_memberships SET payment_status = ?, rev = rev + 1, updated_at = ? WHERE id = ?`)
              .bind(ps, now, target.membership.id),
          );
        }
      }

      return {
        kind: 'commit',
        result: { refundRequest: mapRefundRequestRow(updated) },
        fences: [() => crmActorFence(env.DB, actor, tokenHash, 'crm.refund.approve', '*')],
        rows,
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
    projectionKeys: [CRM_PROJECTION.paymentStatus, CRM_PROJECTION.membershipStatus],
    authorizeCoarse: (actor, via) =>
      via === 'ui' && canAccessCrmApi(actor) && evaluateCapability(actor, 'crm.finance.record', '*'),
    parseInput: (raw) => {
      const parsed = IssueRefundInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
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
      const personRec = await loadReadableTaskRecord(env, actor.id, req.person_id);
      if (!personRec) return { kind: 'refuse', error: 'not_found' };

      const snap = await computeObjectFinancialSnapshot(env.DB, req.object_type, req.object_id, req.currency);
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
      ];

      if (snap.openRequests.length > 0) {
        const reqState = deriveRequestState(snap.dueMinor, nextNetPaidMinor);
        rows.push(
          env.DB
            .prepare(
              `UPDATE crm_payment_requests
               SET state = ?, rev = rev + 1, updated_at = ?
               WHERE object_type = ? AND object_id = ? AND currency = ? AND state NOT IN ('cancelled', 'expired')`,
            )
            .bind(reqState, now, req.object_type, req.object_id, req.currency),
        );
      }

      const personPatch: Record<string, unknown> = {
        [CRM_PROJECTION.paymentStatus]: nextPaymentStatus,
      };
      if (target.booking) {
        rows.push(
          env.DB
            .prepare(`UPDATE crm_bookings SET payment_status = ?, rev = rev + 1, updated_at = ? WHERE id = ?`)
            .bind(nextPaymentStatus, now, target.booking.id),
        );
      } else if (target.membership) {
        const reqPerPeriod = target.membership.contribution_amount_minor ?? 0;
        const requiredForPeriods = reqPerPeriod * Math.max(1, target.membership.period_count);
        const unsupportedActive =
          (target.membership.state === 'active' || target.membership.state === 'renewal_due') &&
          (requiredForPeriods <= 0 || nextNetPaidMinor < requiredForPeriods);
        if (unsupportedActive) {
          rows.push(
            env.DB
              .prepare(
                `UPDATE crm_memberships SET state = 'awaiting_contribution', payment_status = ?, rev = rev + 1, updated_at = ? WHERE id = ?`,
              )
              .bind(nextPaymentStatus, now, target.membership.id),
          );
          personPatch[CRM_PROJECTION.membershipStatus] = 'awaiting_contribution';
        } else {
          rows.push(
            env.DB
              .prepare(`UPDATE crm_memberships SET payment_status = ?, rev = rev + 1, updated_at = ? WHERE id = ?`)
              .bind(nextPaymentStatus, now, target.membership.id),
          );
        }
      }

      return {
        kind: 'commit',
        result: {
          refundRequest: mapRefundRequestRow(updatedReq),
          entry: mapLedgerEntryRow(entryRow),
          paymentStatus: nextPaymentStatus,
        },
        fences: [() => crmActorFence(env.DB, actor, tokenHash, 'crm.finance.record', '*'), netPaidFence],
        rows,
        records: [{ id: personRec.id, collection: 'tasks', patch: personPatch, ts: now }],
        recordExpect: new Map([[personRec.id, personRec.seq]]),
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

  const canReadFinance =
    evaluateCapability(batchAuth.actor, 'crm.finance.read', '*') ||
    evaluateCapability(batchAuth.actor, 'crm.refund.approve', '*');
  if (!canReadFinance) {
    return { status: 403, body: { error: 'forbidden' } };
  }

  const prRows = prRes.results as unknown as PaymentRequestRow[];
  const ledRows = ledRes.results as unknown as LedgerEntryRow[];
  const refRows = refRes.results as unknown as RefundRequestRow[];
  const polRows = polRes.results as unknown as RefundPolicyRow[];

  const gate = createReadGate(env.DB, actorId);
  const personIds = [
    ...new Set([
      ...prRows.map((r) => r.person_id),
      ...ledRows.map((r) => r.person_id),
      ...refRows.map((r) => r.person_id),
    ]),
  ];
  const readablePeople = await loadReadableTaskRecords(env, gate, personIds);

  const finalAuth = await finalizeCrmReadAuth(env, actorId, tokenHash, { gate });
  if (!finalAuth.ok) return { status: finalAuth.status, body: finalAuth.body };
  const stillAllowed =
    evaluateCapability(finalAuth.actor, 'crm.finance.read', '*') ||
    evaluateCapability(finalAuth.actor, 'crm.refund.approve', '*');
  if (!stillAllowed) return { status: 403, body: { error: 'forbidden' } };

  const visPr = prRows.filter((r) => readablePeople.has(r.person_id));
  const visLed = ledRows.filter((r) => readablePeople.has(r.person_id));
  const visRef = refRows.filter((r) => readablePeople.has(r.person_id));

  const totalsByCurrency = summarizeLedgerByCurrency(
    visLed.map((e) => ({ kind: e.kind, amountMinor: e.amount_minor, currency: e.currency })),
  );

  // Programme income strictly isolated per (programmeSlug, currency) — NEVER mixes currencies!
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
      canApproveRefunds: evaluateCapability(finalAuth.actor, 'crm.refund.approve', '*'),
      partial:
        visPr.length < prRows.length ||
        visLed.length < ledRows.length ||
        visRef.length < refRows.length ||
        ledRows.length >= 300,
    }),
  };
}
