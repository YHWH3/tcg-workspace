import {
  AcceptWaitlistOfferInputSchema,
  BookingDetailResponseSchema,
  BookingScreeningResponseSchema,
  CancelBookingInputSchema,
  CompleteEditionInputSchema,
  ConfirmBookingInputSchema,
  CrmAttendanceDtoSchema,
  CrmBookingDtoSchema,
  CrmEditionDtoSchema,
  CrmParticipantDtoSchema,
  CrmScreeningDtoSchema,
  EditionDetailResponseSchema,
  EditionsListResponseSchema,
  HoldBookingInputSchema,
  OfferWaitlistInputSchema,
  PriceOptionSchema,
  RecordAttendanceInputSchema,
  RequestBookingInputSchema,
  ReviewScreeningInputSchema,
  TransferBookingInputSchema,
  UpdateParticipantInputSchema,
  UpsertEditionInputSchema,
  UpsertScreeningInputSchema,
  type AcceptWaitlistOfferInput,
  type AttendanceState,
  type BookingDetailResponse,
  type BookingScreeningResponse,
  type BookingState,
  type CancelBookingInput,
  type CompleteEditionInput,
  type ConfirmBookingInput,
  type CrmAttendanceDto,
  type CrmBookingDto,
  type CrmEditionDto,
  type CrmParticipantDto,
  type CrmScreeningDto,
  type EditionDetailResponse,
  type EditionState,
  type EditionsListResponse,
  type HoldBookingInput,
  type OfferWaitlistInput,
  type ParticipantState,
  type PaymentStatus,
  type PriceOption,
  type RecordAttendanceInput,
  type RequestBookingInput,
  type ReviewScreeningInput,
  type ScreeningState,
  type TransferBookingInput,
  type UpdateParticipantInput,
  type UpsertEditionInput,
  type UpsertScreeningInput,
} from '../../shared/crm/operations';
import { isRegisteredProgrammeSlug } from '../../shared/crm/programmes';
import { CRM_PROJECTION } from '../../shared/crm/projection';
import type { Env } from '../auth';
import { createReadGate } from '../readAccess';
import { pokeLive } from '../sync';
import type { AnyCommandDefinition, CommandDefinition } from './commands';
import { assertNotArchivedAlias, notArchivedAliasFence } from './merge';
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

export interface EditionRow {
  id: string;
  event_record_id: string;
  programme_slug: string;
  title: string;
  capacity: number | null;
  hold_minutes: number | null;
  max_group_size: number | null;
  confirm_before_payment: number | null;
  requires_screening: number;
  screening_questions_json: string | null;
  cancellation_policy_text: string | null;
  price_options_json: string;
  session_dates_json: string;
  state: EditionState;
  rev: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface BookingRow {
  id: string;
  edition_id: string;
  booker_person_id: string;
  application_id: string | null;
  state: BookingState;
  seats: number;
  price_option_id: string | null;
  unit_amount_minor: number | null;
  currency: string | null;
  hold_expires_at: number | null;
  offer_expires_at: number | null;
  payment_status: PaymentStatus;
  cancel_reason: string | null;
  source: string;
  notes: string | null;
  rev: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface ParticipantRow {
  id: string;
  booking_id: string;
  edition_id: string;
  person_id: string | null;
  display_name: string;
  placeholder_index: number | null;
  state: ParticipantState;
  notes: string | null;
  rev: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface AttendanceRow {
  id: string;
  participant_id: string;
  edition_id: string;
  session_date: string;
  state: AttendanceState;
  notes: string | null;
  recorded_by: string;
  recorded_at: number;
  updated_at: number;
}

interface ScreeningRow {
  participant_id: string;
  booking_id: string;
  edition_id: string;
  programme_slug: string;
  answers_json: string;
  evidence_note: string | null;
  state: ScreeningState;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: number | null;
  rev: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface SeatCountRow {
  edition_id: string;
  confirmed_seats: number;
  held_seats: number;
}

function changesOneFence(db: D1Database): D1PreparedStatement {
  return db.prepare(`SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('{', '$') END`);
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function parsePriceOptions(raw: string | null | undefined): PriceOption[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: PriceOption[] = [];
    for (const item of parsed) {
      const ok = PriceOptionSchema.safeParse(item);
      if (ok.success) out.push(ok.data);
    }
    return out;
  } catch {
    return [];
  }
}

function parseAnswersRecord(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function effectiveBookingState(row: Pick<BookingRow, 'state' | 'hold_expires_at' | 'offer_expires_at'>, now: number): BookingState {
  if ((row.state === 'held' || row.state === 'awaiting_payment') && row.hold_expires_at !== null && row.hold_expires_at <= now) {
    return 'expired';
  }
  if (row.state === 'offered' && row.offer_expires_at !== null && row.offer_expires_at <= now) {
    return 'waitlisted';
  }
  return row.state;
}

async function computeEditionSeatStats(
  db: D1Database,
  editionIds: readonly string[],
  now: number,
): Promise<Map<string, { confirmed: number; held: number; waitlisted: number }>> {
  const map = new Map<string, { confirmed: number; held: number; waitlisted: number }>();
  if (editionIds.length === 0) return map;
  const idsJson = JSON.stringify(editionIds);
  const [allocRes, waitRes] = await db.batch([
    db
      .prepare(
        `SELECT edition_id,
                COALESCE(SUM(CASE WHEN kind = 'confirmed' THEN seats ELSE 0 END), 0) AS confirmed_seats,
                COALESCE(SUM(CASE WHEN kind = 'hold' AND expires_at > ? THEN seats ELSE 0 END), 0) AS held_seats
         FROM crm_allocations
         WHERE released_at IS NULL AND edition_id IN (SELECT value FROM json_each(?))
         GROUP BY edition_id`,
      )
      .bind(now, idsJson),
    db
      .prepare(
        `SELECT edition_id, COUNT(*) AS n
         FROM crm_bookings
         WHERE edition_id IN (SELECT value FROM json_each(?))
           AND (state = 'waitlisted' OR (state = 'offered' AND offer_expires_at IS NOT NULL AND offer_expires_at <= ?))
         GROUP BY edition_id`,
      )
      .bind(idsJson, now),
  ]);
  for (const r of allocRes.results as unknown as SeatCountRow[]) {
    map.set(r.edition_id, {
      confirmed: Number(r.confirmed_seats ?? 0),
      held: Number(r.held_seats ?? 0),
      waitlisted: 0,
    });
  }
  for (const r of waitRes.results as unknown as { edition_id: string; n: number }[]) {
    const cur = map.get(r.edition_id) ?? { confirmed: 0, held: 0, waitlisted: 0 };
    cur.waitlisted = Number(r.n ?? 0);
    map.set(r.edition_id, cur);
  }
  return map;
}

function mapEditionRow(
  row: EditionRow,
  stats: { confirmed: number; held: number; waitlisted: number } = { confirmed: 0, held: 0, waitlisted: 0 },
): CrmEditionDto {
  const availableSeats =
    row.capacity === null ? null : Math.max(0, row.capacity - (stats.confirmed + stats.held));
  return CrmEditionDtoSchema.parse({
    id: row.id,
    eventRecordId: row.event_record_id,
    programmeSlug: row.programme_slug,
    title: row.title,
    capacity: row.capacity,
    holdMinutes: row.hold_minutes,
    maxGroupSize: row.max_group_size,
    confirmBeforePayment: row.confirm_before_payment === null ? null : row.confirm_before_payment === 1,
    requiresScreening: row.requires_screening === 1,
    screeningQuestions: parseStringArray(row.screening_questions_json),
    cancellationPolicyText: row.cancellation_policy_text,
    priceOptions: parsePriceOptions(row.price_options_json),
    sessionDates: parseStringArray(row.session_dates_json),
    state: row.state,
    confirmedSeats: stats.confirmed,
    heldSeats: stats.held,
    availableSeats,
    waitlistedCount: stats.waitlisted,
    rev: row.rev,
    updatedAt: row.updated_at,
  });
}

function mapBookingRow(
  row: BookingRow,
  editionTitle: string,
  programmeSlug: string,
  bookerName: string | null,
  now: number,
): CrmBookingDto {
  return CrmBookingDtoSchema.parse({
    id: row.id,
    editionId: row.edition_id,
    editionTitle,
    programmeSlug,
    bookerPersonId: row.booker_person_id,
    bookerName,
    applicationId: row.application_id,
    state: row.state,
    effectiveState: effectiveBookingState(row, now),
    seats: row.seats,
    priceOptionId: row.price_option_id,
    unitAmountMinor: row.unit_amount_minor,
    currency: row.currency,
    holdExpiresAt: row.hold_expires_at,
    offerExpiresAt: row.offer_expires_at,
    paymentStatus: row.payment_status,
    cancelReason: row.cancel_reason,
    source: row.source,
    notes: row.notes,
    rev: row.rev,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapParticipantRow(row: ParticipantRow): CrmParticipantDto {
  return CrmParticipantDtoSchema.parse({
    id: row.id,
    bookingId: row.booking_id,
    editionId: row.edition_id,
    personId: row.person_id,
    displayName: row.display_name,
    placeholderIndex: row.placeholder_index,
    state: row.state,
    notes: row.notes,
    rev: row.rev,
    updatedAt: row.updated_at,
  });
}

function mapAttendanceRow(row: AttendanceRow): CrmAttendanceDto {
  return CrmAttendanceDtoSchema.parse({
    id: row.id,
    participantId: row.participant_id,
    editionId: row.edition_id,
    sessionDate: row.session_date,
    state: row.state,
    notes: row.notes,
    recordedBy: row.recorded_by,
    recordedAt: row.recorded_at,
  });
}

function mapScreeningRow(row: ScreeningRow): CrmScreeningDto {
  return CrmScreeningDtoSchema.parse({
    participantId: row.participant_id,
    bookingId: row.booking_id,
    editionId: row.edition_id,
    programmeSlug: row.programme_slug,
    answers: parseAnswersRecord(row.answers_json),
    evidenceNote: row.evidence_note,
    state: row.state,
    reviewNote: row.review_note,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    rev: row.rev,
    updatedAt: row.updated_at,
  });
}

/**
 * Conditional SQL INSERT for atomic seat allocation (ADR-08).
 * Computes seats in use inline (`kind = 'confirmed' OR expires_at > now`) so expired holds
 * ALWAYS release capacity regardless of whether a background sweep has run!
 */
export function buildConditionalAllocationInsert(
  db: D1Database,
  args: {
    allocationId: string;
    editionId: string;
    bookingId: string;
    seats: number;
    kind: 'hold' | 'confirmed';
    expiresAt: number | null;
    now: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO crm_allocations (id, edition_id, booking_id, seats, kind, expires_at, released_at, release_reason, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?
       WHERE COALESCE(
         (SELECT SUM(seats) FROM crm_allocations
          WHERE edition_id = ? AND released_at IS NULL
            AND (kind = 'confirmed' OR (kind = 'hold' AND expires_at > ?))),
         0
       ) + ? <= (
         SELECT capacity FROM crm_editions
         WHERE id = ? AND state = 'open' AND capacity IS NOT NULL
       )`,
    )
    .bind(
      args.allocationId,
      args.editionId,
      args.bookingId,
      args.seats,
      args.kind,
      args.expiresAt,
      args.now,
      args.now,
      args.editionId,
      args.now,
      args.seats,
      args.editionId,
    );
}

/**
 * Periodic cleanup sweep for expired holds (optional hygiene; capacity release NEVER depends on this!).
 */
export async function sweepExpiredBookingHolds(db: D1Database, now = Date.now(), limit = 20): Promise<number> {
  const expiredRes = await db
    .prepare(
      `SELECT id, state FROM crm_bookings
       WHERE (state IN ('held', 'awaiting_payment') AND hold_expires_at IS NOT NULL AND hold_expires_at <= ?)
          OR (state = 'offered' AND offer_expires_at IS NOT NULL AND offer_expires_at <= ?)
       LIMIT ?`,
    )
    .bind(now, now, limit)
    .all<{ id: string; state: BookingState }>();

  let count = 0;
  for (const b of expiredRes.results) {
    const nextState: BookingState = b.state === 'offered' ? 'waitlisted' : 'expired';
    await db.batch([
      db
        .prepare(
          `UPDATE crm_allocations
           SET released_at = ?, release_reason = 'hold_expired', updated_at = ?
           WHERE booking_id = ? AND kind = 'hold' AND released_at IS NULL AND expires_at <= ?`,
        )
        .bind(now, now, b.id, now),
      db
        .prepare(
          `UPDATE crm_bookings
           SET state = ?, hold_expires_at = NULL, offer_expires_at = NULL, rev = rev + 1, updated_at = ?
           WHERE id = ? AND state = ?`,
        )
        .bind(nextState, now, b.id, b.state),
    ]);
    count += 1;
  }
  return count;
}

/* ---------- S6 Commands ---------- */

function upsertEditionCommand(): CommandDefinition<UpsertEditionInput, { edition: CrmEditionDto }> {
  return {
    name: 'edition.upsert',
    projectionKeys: [CRM_PROJECTION.editionBookedSeats, CRM_PROJECTION.editionHeldSeats],
    authorizeCoarse: (actor, via) => via === 'ui' && canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = UpsertEditionInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      if (!isRegisteredProgrammeSlug(parsed.data.programmeSlug)) {
        return { ok: false, error: 'invalid_input', detail: { reason: 'unknown_programme_slug' } };
      }
      return { ok: true, input: parsed.data };
    },
    authorizeFine: (actor, input) =>
      evaluateCapability(actor, 'crm.configure', `programme:${input.programmeSlug}`),
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const eventRec = await loadReadableTaskRecord(env, actor.id, input.eventRecordId);
      if (!eventRec) return { kind: 'refuse', error: 'not_found' };

      const existing = input.editionId
        ? await env.DB.prepare(`SELECT * FROM crm_editions WHERE id = ?`).bind(input.editionId).first<EditionRow>()
        : await env.DB
            .prepare(`SELECT * FROM crm_editions WHERE event_record_id = ?`)
            .bind(input.eventRecordId)
            .first<EditionRow>();

      if (input.editionId && !existing) return { kind: 'refuse', error: 'not_found' };
      if (existing && input.expectedRev !== undefined && existing.rev !== input.expectedRev) {
        return { kind: 'refuse', error: 'stale' };
      }

      const capacity = input.capacity !== undefined ? input.capacity : (existing?.capacity ?? null);
      const holdMinutes = input.holdMinutes !== undefined ? input.holdMinutes : (existing?.hold_minutes ?? null);
      const maxGroupSize = input.maxGroupSize !== undefined ? input.maxGroupSize : (existing?.max_group_size ?? null);
      const confirmBeforePayment =
        input.confirmBeforePayment !== undefined
          ? input.confirmBeforePayment === null
            ? null
            : input.confirmBeforePayment
              ? 1
              : 0
          : (existing?.confirm_before_payment ?? null);
      const requiresScreening =
        input.requiresScreening !== undefined
          ? input.requiresScreening
            ? 1
            : 0
          : (existing?.requires_screening ?? 0);
      const screeningQuestions =
        input.screeningQuestions !== undefined
          ? input.screeningQuestions
          : parseStringArray(existing?.screening_questions_json);
      const cancellationPolicyText =
        input.cancellationPolicyText !== undefined
          ? input.cancellationPolicyText
          : (existing?.cancellation_policy_text ?? null);
      const priceOptions =
        input.priceOptions !== undefined ? input.priceOptions : parsePriceOptions(existing?.price_options_json);
      const sessionDates =
        input.sessionDates !== undefined ? [...new Set(input.sessionDates)].sort() : parseStringArray(existing?.session_dates_json);
      const nextState: EditionState = input.state ?? existing?.state ?? 'draft';

      // Fail closed: opening an edition requires configured booking policies!
      if (nextState === 'open') {
        if (capacity === null || holdMinutes === null || maxGroupSize === null || confirmBeforePayment === null) {
          return {
            kind: 'refuse',
            error: 'invalid_input',
            detail: { reason: 'edition_policy_unconfigured_pending_O05' },
          };
        }
        if (requiresScreening === 1 && screeningQuestions.length === 0) {
          return {
            kind: 'refuse',
            error: 'invalid_input',
            detail: { reason: 'screening_questions_unconfigured_pending_O06' },
          };
        }
      }

      const id = existing?.id ?? `ed_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const statsMap = existing ? await computeEditionSeatStats(env.DB, [existing.id], now) : new Map();
      const stats = statsMap.get(id) ?? { confirmed: 0, held: 0, waitlisted: 0 };

      if (capacity !== null && capacity < stats.confirmed) {
        return {
          kind: 'refuse',
          error: 'capacity_exceeded',
          detail: { reason: 'capacity_below_confirmed_seats', confirmedSeats: stats.confirmed },
        };
      }

      const nextRow: EditionRow = {
        id,
        event_record_id: input.eventRecordId,
        programme_slug: input.programmeSlug,
        title: input.title,
        capacity,
        hold_minutes: holdMinutes,
        max_group_size: maxGroupSize,
        confirm_before_payment: confirmBeforePayment,
        requires_screening: requiresScreening,
        screening_questions_json: screeningQuestions.length > 0 ? JSON.stringify(screeningQuestions) : null,
        cancellation_policy_text: cancellationPolicyText,
        price_options_json: JSON.stringify(priceOptions),
        session_dates_json: JSON.stringify(sessionDates),
        state: nextState,
        rev: existing ? existing.rev + 1 : 1,
        created_by: existing?.created_by ?? actor.id,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };

      const stmt = existing
        ? env.DB
            .prepare(
              `UPDATE crm_editions
               SET programme_slug = ?, title = ?, capacity = ?, hold_minutes = ?, max_group_size = ?,
                   confirm_before_payment = ?, requires_screening = ?, screening_questions_json = ?,
                   cancellation_policy_text = ?, price_options_json = ?, session_dates_json = ?,
                   state = ?, rev = rev + 1, updated_at = ?
               WHERE id = ? AND rev = ?`,
            )
            .bind(
              nextRow.programme_slug,
              nextRow.title,
              nextRow.capacity,
              nextRow.hold_minutes,
              nextRow.max_group_size,
              nextRow.confirm_before_payment,
              nextRow.requires_screening,
              nextRow.screening_questions_json,
              nextRow.cancellation_policy_text,
              nextRow.price_options_json,
              nextRow.session_dates_json,
              nextRow.state,
              now,
              existing.id,
              existing.rev,
            )
        : env.DB
            .prepare(
              `INSERT INTO crm_editions
                 (id, event_record_id, programme_slug, title, capacity, hold_minutes, max_group_size, confirm_before_payment, requires_screening, screening_questions_json, cancellation_policy_text, price_options_json, session_dates_json, state, rev, created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
            )
            .bind(
              nextRow.id,
              nextRow.event_record_id,
              nextRow.programme_slug,
              nextRow.title,
              nextRow.capacity,
              nextRow.hold_minutes,
              nextRow.max_group_size,
              nextRow.confirm_before_payment,
              nextRow.requires_screening,
              nextRow.screening_questions_json,
              nextRow.cancellation_policy_text,
              nextRow.price_options_json,
              nextRow.session_dates_json,
              nextRow.state,
              actor.id,
              now,
              now,
            );

      const capFence =
        capacity !== null && existing
          ? env.DB
              .prepare(
                `SELECT CASE WHEN COALESCE(
                   (SELECT SUM(seats) FROM crm_allocations WHERE edition_id = ? AND released_at IS NULL AND kind = 'confirmed'),
                   0
                 ) <= ? THEN 1 ELSE json_extract('{', '$') END`,
              )
              .bind(existing.id, capacity)
          : null;

      return {
        kind: 'commit',
        result: { edition: mapEditionRow(nextRow, stats) },
        fences: [
          () => crmActorFence(env.DB, actor, tokenHash, 'crm.configure', `programme:${input.programmeSlug}`),
          ...(capFence ? [capFence] : []),
        ],
        rows: existing ? [stmt, changesOneFence(env.DB)] : [stmt],
        records: [
          {
            id: eventRec.id,
            collection: 'tasks',
            patch: {
              [CRM_PROJECTION.editionBookedSeats]: stats.confirmed,
              [CRM_PROJECTION.editionHeldSeats]: stats.held,
            },
            ts: now,
          },
        ],
        recordExpect: new Map([[eventRec.id, eventRec.seq]]),
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function requestBookingCommand(): CommandDefinition<
  RequestBookingInput,
  { booking: CrmBookingDto; participants: CrmParticipantDto[] }
> {
  return {
    name: 'booking.request',
    projectionKeys: [CRM_PROJECTION.bookingStatus],
    authorizeCoarse: (actor, via) => via === 'ui' && canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = RequestBookingInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const edition = await env.DB
        .prepare(`SELECT * FROM crm_editions WHERE id = ?`)
        .bind(input.editionId)
        .first<EditionRow>();
      if (!edition) return { kind: 'refuse', error: 'not_found' };
      if (edition.state !== 'open') {
        return { kind: 'refuse', error: 'invalid_input', detail: { reason: 'edition_not_open', state: edition.state } };
      }
      if (edition.capacity === null || edition.max_group_size === null || edition.hold_minutes === null) {
        return { kind: 'refuse', error: 'invalid_input', detail: { reason: 'edition_policy_unconfigured_pending_O05' } };
      }
      if (input.seats > edition.max_group_size) {
        return {
          kind: 'refuse',
          error: 'invalid_input',
          detail: { reason: 'group_size_exceeds_policy', maxGroupSize: edition.max_group_size },
        };
      }

      const [eventRec, bookerRec] = await Promise.all([
        loadReadableTaskRecord(env, actor.id, edition.event_record_id),
        loadReadableTaskRecord(env, actor.id, input.bookerPersonId),
      ]);
      if (!eventRec || !bookerRec) return { kind: 'refuse', error: 'not_found' };

      const aliasState = await assertNotArchivedAlias(env.DB, bookerRec);
      if (aliasState.archived) {
        return {
          kind: 'refuse',
          error: 'invalid_input',
          detail: { reason: 'person_merged_or_archived', mergedInto: aliasState.mergedInto },
        };
      }

      if (input.applicationId) {
        const appRec = await loadReadableTaskRecord(env, actor.id, input.applicationId);
        if (!appRec) return { kind: 'refuse', error: 'not_found' };
      }

      const priceOptions = parsePriceOptions(edition.price_options_json);
      let chosenOption: PriceOption | null = null;
      if (input.priceOptionId) {
        chosenOption = priceOptions.find((o) => o.id === input.priceOptionId && o.active) ?? null;
        if (!chosenOption) {
          return { kind: 'refuse', error: 'invalid_input', detail: { reason: 'unknown_price_option' } };
        }
      }

      const statsMap = await computeEditionSeatStats(env.DB, [edition.id], now);
      const stats = statsMap.get(edition.id) ?? { confirmed: 0, held: 0, waitlisted: 0 };
      const available = Math.max(0, edition.capacity - (stats.confirmed + stats.held));
      const initialState: BookingState = input.preferWaitlist || available < input.seats ? 'waitlisted' : 'request';

      const bookingId = `bk_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const bookerTitle =
        typeof bookerRec.data.title === 'string' && bookerRec.data.title.trim()
          ? bookerRec.data.title.trim()
          : 'Booker';

      const bookingRow: BookingRow = {
        id: bookingId,
        edition_id: edition.id,
        booker_person_id: bookerRec.id,
        application_id: input.applicationId ?? null,
        state: initialState,
        seats: input.seats,
        price_option_id: chosenOption?.id ?? null,
        unit_amount_minor: chosenOption?.amountMinor ?? null,
        currency: chosenOption?.currency ?? null,
        hold_expires_at: null,
        offer_expires_at: null,
        payment_status: 'unpaid',
        cancel_reason: null,
        source: input.source,
        notes: input.notes ?? null,
        rev: 1,
        created_by: actor.id,
        created_at: now,
        updated_at: now,
      };

      const rows: D1PreparedStatement[] = [
        env.DB
          .prepare(
            `INSERT INTO crm_bookings
               (id, edition_id, booker_person_id, application_id, state, seats, price_option_id, unit_amount_minor, currency, hold_expires_at, offer_expires_at, payment_status, cancel_reason, source, notes, rev, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'unpaid', NULL, ?, ?, 1, ?, ?, ?)`,
          )
          .bind(
            bookingRow.id,
            bookingRow.edition_id,
            bookingRow.booker_person_id,
            bookingRow.application_id,
            bookingRow.state,
            bookingRow.seats,
            bookingRow.price_option_id,
            bookingRow.unit_amount_minor,
            bookingRow.currency,
            bookingRow.source,
            bookingRow.notes,
            actor.id,
            now,
            now,
          ),
      ];

      const participants: ParticipantRow[] = [];
      for (let i = 0; i < input.seats; i += 1) {
        const pid = `pt_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
        const suppliedName = input.participantNames?.[i]?.trim() || null;
        const isFirst = i === 0;
        const pPersonId = isFirst ? bookerRec.id : null;
        const displayName = suppliedName ?? (isFirst ? bookerTitle : `Participant ${i + 1} (placeholder)`);
        const pState: ParticipantState = isFirst || suppliedName ? 'named' : 'placeholder';
        const pRow: ParticipantRow = {
          id: pid,
          booking_id: bookingId,
          edition_id: edition.id,
          person_id: pPersonId,
          display_name: displayName,
          placeholder_index: i + 1,
          state: pState,
          notes: null,
          rev: 1,
          created_by: actor.id,
          created_at: now,
          updated_at: now,
        };
        participants.push(pRow);
        rows.push(
          env.DB
            .prepare(
              `INSERT INTO crm_participants (id, booking_id, edition_id, person_id, display_name, placeholder_index, state, notes, rev, created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?)`,
            )
            .bind(pid, bookingId, edition.id, pPersonId, displayName, i + 1, pState, actor.id, now, now),
        );
      }

      return {
        kind: 'commit',
        result: {
          booking: mapBookingRow(bookingRow, edition.title, edition.programme_slug, bookerTitle, now),
          participants: participants.map(mapParticipantRow),
        },
        fences: [
          () => crmActorFence(env.DB, actor, tokenHash),
          () => notArchivedAliasFence(env.DB, bookerRec.id),
        ],
        rows,
        records: [
          {
            id: bookerRec.id,
            collection: 'tasks',
            patch: { [CRM_PROJECTION.bookingStatus]: initialState },
            ts: now,
          },
        ],
        recordExpect: new Map([[bookerRec.id, bookerRec.seq]]),
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function holdBookingCommand(): CommandDefinition<HoldBookingInput, { booking: CrmBookingDto }> {
  return {
    name: 'booking.hold',
    projectionKeys: [CRM_PROJECTION.bookingStatus, CRM_PROJECTION.editionBookedSeats, CRM_PROJECTION.editionHeldSeats],
    authorizeCoarse: (actor, via) => via === 'ui' && canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = HoldBookingInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    classifyFenceError: async ({ env, input }) => {
      const bk = await env.DB
        .prepare(`SELECT id, edition_id, seats, rev, state FROM crm_bookings WHERE id = ?`)
        .bind(input.bookingId)
        .first<Pick<BookingRow, 'id' | 'edition_id' | 'seats' | 'rev' | 'state'>>();
      if (!bk) return { ok: false, error: 'not_found', retryable: false };
      const ed = await env.DB
        .prepare(`SELECT id, capacity, state FROM crm_editions WHERE id = ?`)
        .bind(bk.edition_id)
        .first<Pick<EditionRow, 'id' | 'capacity' | 'state'>>();
      if (!ed || ed.state !== 'open' || ed.capacity === null) {
        return { ok: false, error: 'stale', detail: { reason: 'edition_not_open' }, retryable: false };
      }
      const statsMap = await computeEditionSeatStats(env.DB, [ed.id], Date.now());
      const st = statsMap.get(ed.id) ?? { confirmed: 0, held: 0, waitlisted: 0 };
      const availableSeats = Math.max(0, ed.capacity - (st.confirmed + st.held));
      if (availableSeats < bk.seats) {
        return {
          ok: false,
          error: 'capacity_exceeded',
          detail: {
            requestedSeats: bk.seats,
            confirmedSeats: st.confirmed,
            heldSeats: st.held,
            availableSeats,
            options: ['waitlist', 'fewer_seats'],
          },
          retryable: false,
        };
      }
      return null;
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const bk = await env.DB.prepare(`SELECT * FROM crm_bookings WHERE id = ?`).bind(input.bookingId).first<BookingRow>();
      if (!bk) return { kind: 'refuse', error: 'not_found' };
      if (input.expectedRev !== undefined && bk.rev !== input.expectedRev) {
        return { kind: 'refuse', error: 'stale' };
      }
      const eff = effectiveBookingState(bk, now);
      if (eff !== 'request' && eff !== 'expired' && eff !== 'waitlisted') {
        return { kind: 'refuse', error: 'stale', detail: { reason: 'booking_cannot_hold', state: eff } };
      }

      const edition = await env.DB.prepare(`SELECT * FROM crm_editions WHERE id = ?`).bind(bk.edition_id).first<EditionRow>();
      if (!edition || edition.state !== 'open') {
        return { kind: 'refuse', error: 'invalid_input', detail: { reason: 'edition_not_open' } };
      }
      if (edition.capacity === null || edition.hold_minutes === null) {
        return { kind: 'refuse', error: 'invalid_input', detail: { reason: 'edition_policy_unconfigured_pending_O05' } };
      }

      const [eventRec, bookerRec] = await Promise.all([
        loadReadableTaskRecord(env, actor.id, edition.event_record_id),
        loadReadableTaskRecord(env, actor.id, bk.booker_person_id),
      ]);
      if (!eventRec || !bookerRec) return { kind: 'refuse', error: 'not_found' };

      const holdExpiresAt = now + edition.hold_minutes * 60_000;
      const allocId = `al_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const statsMap = await computeEditionSeatStats(env.DB, [edition.id], now);
      const stats = statsMap.get(edition.id) ?? { confirmed: 0, held: 0, waitlisted: 0 };
      const updatedBooking: BookingRow = {
        ...bk,
        state: 'held',
        hold_expires_at: holdExpiresAt,
        offer_expires_at: null,
        rev: bk.rev + 1,
        updated_at: now,
      };
      const bookerTitle = typeof bookerRec.data.title === 'string' ? bookerRec.data.title : null;

      return {
        kind: 'commit',
        result: { booking: mapBookingRow(updatedBooking, edition.title, edition.programme_slug, bookerTitle, now) },
        fences: [() => crmActorFence(env.DB, actor, tokenHash)],
        rows: [
          env.DB
            .prepare(
              `UPDATE crm_allocations
               SET released_at = ?, release_reason = 'superseded', updated_at = ?
               WHERE booking_id = ? AND released_at IS NULL`,
            )
            .bind(now, now, bk.id),
          buildConditionalAllocationInsert(env.DB, {
            allocationId: allocId,
            editionId: edition.id,
            bookingId: bk.id,
            seats: bk.seats,
            kind: 'hold',
            expiresAt: holdExpiresAt,
            now,
          }),
          changesOneFence(env.DB),
          env.DB
            .prepare(
              `UPDATE crm_bookings
               SET state = 'held', hold_expires_at = ?, offer_expires_at = NULL, rev = rev + 1, updated_at = ?
               WHERE id = ? AND rev = ?`,
            )
            .bind(holdExpiresAt, now, bk.id, bk.rev),
          changesOneFence(env.DB),
        ],
        records: [
          {
            id: bookerRec.id,
            collection: 'tasks',
            patch: { [CRM_PROJECTION.bookingStatus]: 'held' },
            ts: now,
          },
          {
            id: eventRec.id,
            collection: 'tasks',
            patch: {
              [CRM_PROJECTION.editionBookedSeats]: stats.confirmed,
              [CRM_PROJECTION.editionHeldSeats]: stats.held + bk.seats,
            },
            ts: now,
          },
        ],
        recordExpect: new Map([
          [bookerRec.id, bookerRec.seq],
          [eventRec.id, eventRec.seq],
        ]),
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function confirmBookingCommand(): CommandDefinition<ConfirmBookingInput, { booking: CrmBookingDto }> {
  return {
    name: 'booking.confirm',
    projectionKeys: [CRM_PROJECTION.bookingStatus, CRM_PROJECTION.editionBookedSeats, CRM_PROJECTION.editionHeldSeats],
    authorizeCoarse: (actor, via) => via === 'ui' && canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = ConfirmBookingInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    classifyFenceError: async ({ env, input }) => {
      const bk = await env.DB
        .prepare(`SELECT id, edition_id, seats, state, hold_expires_at FROM crm_bookings WHERE id = ?`)
        .bind(input.bookingId)
        .first<Pick<BookingRow, 'id' | 'edition_id' | 'seats' | 'state' | 'hold_expires_at'>>();
      if (!bk) return { ok: false, error: 'not_found', retryable: false };
      if ((bk.state === 'held' || bk.state === 'awaiting_payment') && bk.hold_expires_at !== null && bk.hold_expires_at <= Date.now()) {
        return { ok: false, error: 'hold_expired', retryable: false };
      }
      const ed = await env.DB
        .prepare(`SELECT id, capacity FROM crm_editions WHERE id = ?`)
        .bind(bk.edition_id)
        .first<Pick<EditionRow, 'id' | 'capacity'>>();
      if (ed && ed.capacity !== null) {
        const statsMap = await computeEditionSeatStats(env.DB, [ed.id], Date.now());
        const st = statsMap.get(ed.id) ?? { confirmed: 0, held: 0, waitlisted: 0 };
        const availableSeats = Math.max(0, ed.capacity - (st.confirmed + st.held));
        if (availableSeats < bk.seats) {
          return {
            ok: false,
            error: 'capacity_exceeded',
            detail: { confirmedSeats: st.confirmed, heldSeats: st.held, availableSeats },
            retryable: false,
          };
        }
      }
      return null;
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const bk = await env.DB.prepare(`SELECT * FROM crm_bookings WHERE id = ?`).bind(input.bookingId).first<BookingRow>();
      if (!bk) return { kind: 'refuse', error: 'not_found' };
      if (input.expectedRev !== undefined && bk.rev !== input.expectedRev) {
        return { kind: 'refuse', error: 'stale' };
      }

      const edition = await env.DB.prepare(`SELECT * FROM crm_editions WHERE id = ?`).bind(bk.edition_id).first<EditionRow>();
      if (!edition || edition.state !== 'open') {
        return { kind: 'refuse', error: 'invalid_input', detail: { reason: 'edition_not_open' } };
      }
      if (edition.capacity === null || edition.confirm_before_payment === null) {
        return { kind: 'refuse', error: 'invalid_input', detail: { reason: 'edition_policy_unconfigured_pending_O05' } };
      }

      const [eventRec, bookerRec] = await Promise.all([
        loadReadableTaskRecord(env, actor.id, edition.event_record_id),
        loadReadableTaskRecord(env, actor.id, bk.booker_person_id),
      ]);
      if (!eventRec || !bookerRec) return { kind: 'refuse', error: 'not_found' };

      const eff = effectiveBookingState(bk, now);
      if (eff === 'expired') {
        return { kind: 'refuse', error: 'hold_expired', detail: { reason: 'hold_expired_rebook_required' } };
      }
      if (eff !== 'held' && eff !== 'awaiting_payment' && eff !== 'request' && eff !== 'paid_without_seat') {
        return { kind: 'refuse', error: 'stale', detail: { reason: 'booking_cannot_confirm', state: eff } };
      }

      // Payment policy gate (never allow stage edit to bypass authoritative ledger payment status)
      if (edition.confirm_before_payment === 0 && bk.payment_status !== 'paid' && bk.payment_status !== 'overpaid') {
        return {
          kind: 'refuse',
          error: 'invalid_input',
          detail: { reason: 'payment_required_before_confirm', paymentStatus: bk.payment_status },
        };
      }

      const activeHold = await env.DB
        .prepare(
          `SELECT id FROM crm_allocations
           WHERE booking_id = ? AND edition_id = ? AND kind = 'hold' AND released_at IS NULL AND expires_at > ?
           LIMIT 1`,
        )
        .bind(bk.id, edition.id, now)
        .first<{ id: string }>();

      const statsMap = await computeEditionSeatStats(env.DB, [edition.id], now);
      const stats = statsMap.get(edition.id) ?? { confirmed: 0, held: 0, waitlisted: 0 };

      const allocRows: D1PreparedStatement[] = [];
      if (activeHold) {
        // Atomically convert the existing unexpired hold to confirmed (no extra seats needed)
        allocRows.push(
          env.DB
            .prepare(
              `UPDATE crm_allocations
               SET kind = 'confirmed', expires_at = NULL, updated_at = ?
               WHERE id = ? AND released_at IS NULL AND kind = 'hold' AND expires_at > ?`,
            )
            .bind(now, activeHold.id, now),
          changesOneFence(env.DB),
        );
      } else {
        // Must atomically allocate confirmed seats inside capacity!
        const allocId = `al_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
        allocRows.push(
          buildConditionalAllocationInsert(env.DB, {
            allocationId: allocId,
            editionId: edition.id,
            bookingId: bk.id,
            seats: bk.seats,
            kind: 'confirmed',
            expiresAt: null,
            now,
          }),
          changesOneFence(env.DB),
        );
      }

      const updatedBooking: BookingRow = {
        ...bk,
        state: 'confirmed',
        hold_expires_at: null,
        offer_expires_at: null,
        rev: bk.rev + 1,
        updated_at: now,
      };
      const bookerTitle = typeof bookerRec.data.title === 'string' ? bookerRec.data.title : null;

      return {
        kind: 'commit',
        result: { booking: mapBookingRow(updatedBooking, edition.title, edition.programme_slug, bookerTitle, now) },
        fences: [() => crmActorFence(env.DB, actor, tokenHash)],
        rows: [
          ...allocRows,
          env.DB
            .prepare(
              `UPDATE crm_bookings
               SET state = 'confirmed', hold_expires_at = NULL, offer_expires_at = NULL, rev = rev + 1, updated_at = ?
               WHERE id = ? AND rev = ?`,
            )
            .bind(now, bk.id, bk.rev),
          changesOneFence(env.DB),
        ],
        records: [
          {
            id: bookerRec.id,
            collection: 'tasks',
            patch: { [CRM_PROJECTION.bookingStatus]: 'confirmed' },
            ts: now,
          },
          {
            id: eventRec.id,
            collection: 'tasks',
            patch: {
              [CRM_PROJECTION.editionBookedSeats]: stats.confirmed + bk.seats,
              [CRM_PROJECTION.editionHeldSeats]: activeHold ? Math.max(0, stats.held - bk.seats) : stats.held,
            },
            ts: now,
          },
        ],
        recordExpect: new Map([
          [bookerRec.id, bookerRec.seq],
          [eventRec.id, eventRec.seq],
        ]),
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function cancelBookingCommand(): CommandDefinition<CancelBookingInput, { booking: CrmBookingDto }> {
  return {
    name: 'booking.cancel',
    projectionKeys: [CRM_PROJECTION.bookingStatus],
    authorizeCoarse: (actor, via) => via === 'ui' && canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = CancelBookingInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const bk = await env.DB.prepare(`SELECT * FROM crm_bookings WHERE id = ?`).bind(input.bookingId).first<BookingRow>();
      if (!bk) return { kind: 'refuse', error: 'not_found' };
      if (input.expectedRev !== undefined && bk.rev !== input.expectedRev) {
        return { kind: 'refuse', error: 'stale' };
      }
      if (bk.state === 'cancelled' || bk.state === 'completed') {
        return { kind: 'refuse', error: 'stale', detail: { reason: 'booking_already_final', state: bk.state } };
      }
      const edition = await env.DB.prepare(`SELECT * FROM crm_editions WHERE id = ?`).bind(bk.edition_id).first<EditionRow>();
      if (!edition) return { kind: 'refuse', error: 'not_found' };
      const [eventRec, bookerRec] = await Promise.all([
        loadReadableTaskRecord(env, actor.id, edition.event_record_id),
        loadReadableTaskRecord(env, actor.id, bk.booker_person_id),
      ]);
      if (!eventRec || !bookerRec) return { kind: 'refuse', error: 'not_found' };

      const updated: BookingRow = {
        ...bk,
        state: 'cancelled',
        hold_expires_at: null,
        offer_expires_at: null,
        cancel_reason: input.reason,
        rev: bk.rev + 1,
        updated_at: now,
      };
      const bookerTitle = typeof bookerRec.data.title === 'string' ? bookerRec.data.title : null;

      return {
        kind: 'commit',
        result: { booking: mapBookingRow(updated, edition.title, edition.programme_slug, bookerTitle, now) },
        fences: [() => crmActorFence(env.DB, actor, tokenHash)],
        rows: [
          env.DB
            .prepare(
              `UPDATE crm_allocations
               SET released_at = ?, release_reason = 'cancelled', updated_at = ?
               WHERE booking_id = ? AND released_at IS NULL`,
            )
            .bind(now, now, bk.id),
          env.DB
            .prepare(
              `UPDATE crm_participants
               SET state = 'cancelled', rev = rev + 1, updated_at = ?
               WHERE booking_id = ? AND state != 'cancelled'`,
            )
            .bind(now, bk.id),
          env.DB
            .prepare(
              `UPDATE crm_bookings
               SET state = 'cancelled', hold_expires_at = NULL, offer_expires_at = NULL, cancel_reason = ?, rev = rev + 1, updated_at = ?
               WHERE id = ? AND rev = ?`,
            )
            .bind(input.reason, now, bk.id, bk.rev),
          changesOneFence(env.DB),
        ],
        records: [
          {
            id: bookerRec.id,
            collection: 'tasks',
            patch: { [CRM_PROJECTION.bookingStatus]: 'cancelled' },
            ts: now,
          },
        ],
        recordExpect: new Map([[bookerRec.id, bookerRec.seq]]),
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function transferBookingCommand(): CommandDefinition<TransferBookingInput, { booking: CrmBookingDto }> {
  return {
    name: 'booking.transfer',
    authorizeCoarse: (actor, via) => via === 'ui' && canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = TransferBookingInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    classifyFenceError: async ({ env, input }) => {
      const bk = await env.DB.prepare(`SELECT seats FROM crm_bookings WHERE id = ?`).bind(input.bookingId).first<{ seats: number }>();
      const target = await env.DB
        .prepare(`SELECT id, capacity FROM crm_editions WHERE id = ?`)
        .bind(input.targetEditionId)
        .first<Pick<EditionRow, 'id' | 'capacity'>>();
      if (bk && target && target.capacity !== null) {
        const stMap = await computeEditionSeatStats(env.DB, [target.id], Date.now());
        const st = stMap.get(target.id) ?? { confirmed: 0, held: 0, waitlisted: 0 };
        const avail = Math.max(0, target.capacity - (st.confirmed + st.held));
        if (avail < bk.seats) {
          return {
            ok: false,
            error: 'capacity_exceeded',
            detail: { targetEditionId: target.id, availableSeats: avail, requestedSeats: bk.seats },
            retryable: false,
          };
        }
      }
      return null;
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const bk = await env.DB.prepare(`SELECT * FROM crm_bookings WHERE id = ?`).bind(input.bookingId).first<BookingRow>();
      if (!bk) return { kind: 'refuse', error: 'not_found' };
      if (input.expectedRev !== undefined && bk.rev !== input.expectedRev) {
        return { kind: 'refuse', error: 'stale' };
      }
      if (bk.edition_id === input.targetEditionId) {
        return { kind: 'refuse', error: 'invalid_input', detail: { reason: 'same_edition' } };
      }
      const eff = effectiveBookingState(bk, now);
      if (eff !== 'confirmed' && eff !== 'held' && eff !== 'awaiting_payment' && eff !== 'paid_without_seat') {
        return { kind: 'refuse', error: 'stale', detail: { reason: 'booking_not_transferable', state: eff } };
      }

      const [sourceEd, targetEd] = await Promise.all([
        env.DB.prepare(`SELECT * FROM crm_editions WHERE id = ?`).bind(bk.edition_id).first<EditionRow>(),
        env.DB.prepare(`SELECT * FROM crm_editions WHERE id = ?`).bind(input.targetEditionId).first<EditionRow>(),
      ]);
      if (!sourceEd || !targetEd) return { kind: 'refuse', error: 'not_found' };
      if (targetEd.state !== 'open' || targetEd.capacity === null || targetEd.hold_minutes === null) {
        return { kind: 'refuse', error: 'invalid_input', detail: { reason: 'target_edition_not_open_or_unconfigured' } };
      }

      const [srcEvent, tgtEvent, bookerRec] = await Promise.all([
        loadReadableTaskRecord(env, actor.id, sourceEd.event_record_id),
        loadReadableTaskRecord(env, actor.id, targetEd.event_record_id),
        loadReadableTaskRecord(env, actor.id, bk.booker_person_id),
      ]);
      if (!srcEvent || !tgtEvent || !bookerRec) return { kind: 'refuse', error: 'not_found' };

      const targetKind: 'confirmed' | 'hold' = eff === 'confirmed' ? 'confirmed' : 'hold';
      const targetExpiresAt = targetKind === 'hold' ? now + targetEd.hold_minutes * 60_000 : null;
      const nextState: BookingState = targetKind === 'confirmed' ? 'confirmed' : 'held';
      const newAllocId = `al_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

      const updated: BookingRow = {
        ...bk,
        edition_id: targetEd.id,
        state: nextState,
        hold_expires_at: targetExpiresAt,
        offer_expires_at: null,
        rev: bk.rev + 1,
        updated_at: now,
      };
      const bookerTitle = typeof bookerRec.data.title === 'string' ? bookerRec.data.title : null;

      return {
        kind: 'commit',
        result: { booking: mapBookingRow(updated, targetEd.title, targetEd.programme_slug, bookerTitle, now) },
        fences: [() => crmActorFence(env.DB, actor, tokenHash)],
        rows: [
          // 1. Atomically allocate seats in TARGET edition first (aborts entire batch if full!)
          buildConditionalAllocationInsert(env.DB, {
            allocationId: newAllocId,
            editionId: targetEd.id,
            bookingId: bk.id,
            seats: bk.seats,
            kind: targetKind,
            expiresAt: targetExpiresAt,
            now,
          }),
          changesOneFence(env.DB),
          // 2. Atomically release allocation in SOURCE edition in the SAME batch!
          env.DB
            .prepare(
              `UPDATE crm_allocations
               SET released_at = ?, release_reason = 'transferred', updated_at = ?
               WHERE booking_id = ? AND edition_id = ? AND released_at IS NULL`,
            )
            .bind(now, now, bk.id, sourceEd.id),
          env.DB
            .prepare(
              `UPDATE crm_bookings
               SET edition_id = ?, state = ?, hold_expires_at = ?, offer_expires_at = NULL, rev = rev + 1, updated_at = ?
               WHERE id = ? AND rev = ?`,
            )
            .bind(targetEd.id, nextState, targetExpiresAt, now, bk.id, bk.rev),
          changesOneFence(env.DB),
          env.DB
            .prepare(`UPDATE crm_participants SET edition_id = ?, rev = rev + 1, updated_at = ? WHERE booking_id = ?`)
            .bind(targetEd.id, now, bk.id),
          env.DB
            .prepare(`UPDATE crm_screenings SET edition_id = ?, programme_slug = ?, rev = rev + 1, updated_at = ? WHERE booking_id = ?`)
            .bind(targetEd.id, targetEd.programme_slug, now, bk.id),
        ],
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function offerWaitlistCommand(): CommandDefinition<OfferWaitlistInput, { booking: CrmBookingDto }> {
  return {
    name: 'waitlist.offer',
    authorizeCoarse: (actor, via) => via === 'ui' && canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = OfferWaitlistInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    classifyFenceError: async ({ env, input }) => {
      const bk = await env.DB.prepare(`SELECT edition_id, seats FROM crm_bookings WHERE id = ?`).bind(input.bookingId).first<{ edition_id: string; seats: number }>();
      if (!bk) return null;
      const ed = await env.DB.prepare(`SELECT id, capacity FROM crm_editions WHERE id = ?`).bind(bk.edition_id).first<{ id: string; capacity: number | null }>();
      if (ed && ed.capacity !== null) {
        const stMap = await computeEditionSeatStats(env.DB, [ed.id], Date.now());
        const st = stMap.get(ed.id) ?? { confirmed: 0, held: 0, waitlisted: 0 };
        if (Math.max(0, ed.capacity - (st.confirmed + st.held)) < bk.seats) {
          return { ok: false, error: 'capacity_exceeded', retryable: false };
        }
      }
      return null;
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const bk = await env.DB.prepare(`SELECT * FROM crm_bookings WHERE id = ?`).bind(input.bookingId).first<BookingRow>();
      if (!bk) return { kind: 'refuse', error: 'not_found' };
      if (input.expectedRev !== undefined && bk.rev !== input.expectedRev) {
        return { kind: 'refuse', error: 'stale' };
      }
      const eff = effectiveBookingState(bk, now);
      if (eff !== 'waitlisted') {
        return { kind: 'refuse', error: 'stale', detail: { reason: 'booking_not_waitlisted', state: eff } };
      }
      const edition = await env.DB.prepare(`SELECT * FROM crm_editions WHERE id = ?`).bind(bk.edition_id).first<EditionRow>();
      if (!edition || edition.state !== 'open' || edition.capacity === null || edition.hold_minutes === null) {
        return { kind: 'refuse', error: 'invalid_input', detail: { reason: 'edition_not_open_or_unconfigured' } };
      }
      const [eventRec, bookerRec] = await Promise.all([
        loadReadableTaskRecord(env, actor.id, edition.event_record_id),
        loadReadableTaskRecord(env, actor.id, bk.booker_person_id),
      ]);
      if (!eventRec || !bookerRec) return { kind: 'refuse', error: 'not_found' };

      const expiresAt = now + edition.hold_minutes * 60_000;
      const allocId = `al_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const updated: BookingRow = {
        ...bk,
        state: 'offered',
        hold_expires_at: expiresAt,
        offer_expires_at: expiresAt,
        rev: bk.rev + 1,
        updated_at: now,
      };
      const bookerTitle = typeof bookerRec.data.title === 'string' ? bookerRec.data.title : null;

      return {
        kind: 'commit',
        result: { booking: mapBookingRow(updated, edition.title, edition.programme_slug, bookerTitle, now) },
        fences: [() => crmActorFence(env.DB, actor, tokenHash)],
        rows: [
          env.DB
            .prepare(`UPDATE crm_allocations SET released_at = ?, release_reason = 'superseded', updated_at = ? WHERE booking_id = ? AND released_at IS NULL`)
            .bind(now, now, bk.id),
          buildConditionalAllocationInsert(env.DB, {
            allocationId: allocId,
            editionId: edition.id,
            bookingId: bk.id,
            seats: bk.seats,
            kind: 'hold',
            expiresAt,
            now,
          }),
          changesOneFence(env.DB),
          env.DB
            .prepare(
              `UPDATE crm_bookings
               SET state = 'offered', hold_expires_at = ?, offer_expires_at = ?, rev = rev + 1, updated_at = ?
               WHERE id = ? AND rev = ?`,
            )
            .bind(expiresAt, expiresAt, now, bk.id, bk.rev),
          changesOneFence(env.DB),
        ],
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function acceptWaitlistOfferCommand(): CommandDefinition<AcceptWaitlistOfferInput, { booking: CrmBookingDto }> {
  return {
    name: 'waitlist.accept',
    authorizeCoarse: (actor, via) => via === 'ui' && canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = AcceptWaitlistOfferInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const bk = await env.DB.prepare(`SELECT * FROM crm_bookings WHERE id = ?`).bind(input.bookingId).first<BookingRow>();
      if (!bk) return { kind: 'refuse', error: 'not_found' };
      if (input.expectedRev !== undefined && bk.rev !== input.expectedRev) {
        return { kind: 'refuse', error: 'stale' };
      }
      if (bk.state !== 'offered') {
        return { kind: 'refuse', error: 'stale', detail: { reason: 'booking_not_offered', state: bk.state } };
      }
      if (bk.offer_expires_at === null || bk.offer_expires_at <= now) {
        return { kind: 'refuse', error: 'hold_expired', detail: { reason: 'waitlist_offer_expired' } };
      }
      const edition = await env.DB.prepare(`SELECT * FROM crm_editions WHERE id = ?`).bind(bk.edition_id).first<EditionRow>();
      if (!edition) return { kind: 'refuse', error: 'not_found' };
      const [eventRec, bookerRec] = await Promise.all([
        loadReadableTaskRecord(env, actor.id, edition.event_record_id),
        loadReadableTaskRecord(env, actor.id, bk.booker_person_id),
      ]);
      if (!eventRec || !bookerRec) return { kind: 'refuse', error: 'not_found' };

      const updated: BookingRow = {
        ...bk,
        state: 'held',
        offer_expires_at: null,
        rev: bk.rev + 1,
        updated_at: now,
      };
      const bookerTitle = typeof bookerRec.data.title === 'string' ? bookerRec.data.title : null;

      return {
        kind: 'commit',
        result: { booking: mapBookingRow(updated, edition.title, edition.programme_slug, bookerTitle, now) },
        fences: [
          () => crmActorFence(env.DB, actor, tokenHash),
          env.DB
            .prepare(
              `SELECT CASE WHEN EXISTS (
                 SELECT 1 FROM crm_allocations
                 WHERE booking_id = ? AND kind = 'hold' AND released_at IS NULL AND expires_at > ?
               ) THEN 1 ELSE json_extract('{', '$') END`,
            )
            .bind(bk.id, now),
        ],
        rows: [
          env.DB
            .prepare(
              `UPDATE crm_bookings
               SET state = 'held', offer_expires_at = NULL, rev = rev + 1, updated_at = ?
               WHERE id = ? AND rev = ? AND state = 'offered' AND offer_expires_at > ?`,
            )
            .bind(now, bk.id, bk.rev, now),
          changesOneFence(env.DB),
        ],
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function updateParticipantCommand(): CommandDefinition<UpdateParticipantInput, { participant: CrmParticipantDto }> {
  return {
    name: 'participant.update',
    authorizeCoarse: (actor, via) => via === 'ui' && canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = UpdateParticipantInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const pt = await env.DB
        .prepare(`SELECT * FROM crm_participants WHERE id = ?`)
        .bind(input.participantId)
        .first<ParticipantRow>();
      if (!pt) return { kind: 'refuse', error: 'not_found' };
      if (input.expectedRev !== undefined && pt.rev !== input.expectedRev) {
        return { kind: 'refuse', error: 'stale' };
      }
      const ed = await env.DB.prepare(`SELECT event_record_id FROM crm_editions WHERE id = ?`).bind(pt.edition_id).first<{ event_record_id: string }>();
      if (!ed || !(await loadReadableTaskRecord(env, actor.id, ed.event_record_id))) {
        return { kind: 'refuse', error: 'not_found' };
      }

      const nextPersonId = input.personId !== undefined ? input.personId : pt.person_id;
      if (nextPersonId) {
        const pRec = await loadReadableTaskRecord(env, actor.id, nextPersonId);
        if (!pRec) return { kind: 'refuse', error: 'not_found' };
        const aliasState = await assertNotArchivedAlias(env.DB, pRec);
        if (aliasState.archived) {
          return {
            kind: 'refuse',
            error: 'invalid_input',
            detail: { reason: 'person_merged_or_archived', mergedInto: aliasState.mergedInto },
          };
        }
      }

      const updated: ParticipantRow = {
        ...pt,
        person_id: nextPersonId,
        display_name: input.displayName,
        state: pt.state === 'cancelled' ? 'cancelled' : 'named',
        notes: input.notes !== undefined ? input.notes : pt.notes,
        rev: pt.rev + 1,
        updated_at: now,
      };
      return {
        kind: 'commit',
        result: { participant: mapParticipantRow(updated) },
        fences: [
          () => crmActorFence(env.DB, actor, tokenHash),
          ...(nextPersonId ? [() => notArchivedAliasFence(env.DB, nextPersonId)] : []),
        ],
        rows: [
          env.DB
            .prepare(
              `UPDATE crm_participants
               SET person_id = ?, display_name = ?, state = ?, notes = ?, rev = rev + 1, updated_at = ?
               WHERE id = ? AND rev = ?`,
            )
            .bind(updated.person_id, updated.display_name, updated.state, updated.notes, now, pt.id, pt.rev),
          changesOneFence(env.DB),
        ],
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function recordAttendanceCommand(): CommandDefinition<RecordAttendanceInput, { attendance: CrmAttendanceDto }> {
  return {
    name: 'attendance.record',
    authorizeCoarse: (actor, via) => via === 'ui' && canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = RecordAttendanceInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const pt = await env.DB
        .prepare(`SELECT * FROM crm_participants WHERE id = ?`)
        .bind(input.participantId)
        .first<ParticipantRow>();
      if (!pt || pt.state === 'cancelled') return { kind: 'refuse', error: 'not_found' };
      const ed = await env.DB.prepare(`SELECT * FROM crm_editions WHERE id = ?`).bind(pt.edition_id).first<EditionRow>();
      if (!ed || !(await loadReadableTaskRecord(env, actor.id, ed.event_record_id))) {
        return { kind: 'refuse', error: 'not_found' };
      }
      const sessionDates = parseStringArray(ed.session_dates_json);
      if (sessionDates.length > 0 && !sessionDates.includes(input.sessionDate)) {
        return { kind: 'refuse', error: 'invalid_input', detail: { reason: 'session_date_not_in_edition' } };
      }

      const existing = await env.DB
        .prepare(`SELECT * FROM crm_attendance WHERE participant_id = ? AND session_date = ?`)
        .bind(pt.id, input.sessionDate)
        .first<AttendanceRow>();

      const id = existing?.id ?? `att_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const nextRow: AttendanceRow = {
        id,
        participant_id: pt.id,
        edition_id: pt.edition_id,
        session_date: input.sessionDate,
        state: input.state,
        notes: input.notes ?? null,
        recorded_by: actor.id,
        recorded_at: now,
        updated_at: now,
      };

      const stmt = existing
        ? env.DB
            .prepare(
              `UPDATE crm_attendance
               SET state = ?, notes = ?, recorded_by = ?, recorded_at = ?, updated_at = ?
               WHERE id = ?`,
            )
            .bind(nextRow.state, nextRow.notes, actor.id, now, now, existing.id)
        : env.DB
            .prepare(
              `INSERT INTO crm_attendance (id, participant_id, edition_id, session_date, state, notes, recorded_by, recorded_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(id, pt.id, pt.edition_id, input.sessionDate, input.state, nextRow.notes, actor.id, now, now);

      return {
        kind: 'commit',
        result: { attendance: mapAttendanceRow(nextRow) },
        fences: [() => crmActorFence(env.DB, actor, tokenHash)],
        rows: [stmt],
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function upsertScreeningCommand(): CommandDefinition<UpsertScreeningInput, { screening: CrmScreeningDto }> {
  return {
    name: 'screening.upsert',
    authorizeCoarse: (actor, via) => via === 'ui' && canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = UpsertScreeningInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const pt = await env.DB.prepare(`SELECT * FROM crm_participants WHERE id = ?`).bind(input.participantId).first<ParticipantRow>();
      if (!pt) return { kind: 'refuse', error: 'not_found' };
      const ed = await env.DB.prepare(`SELECT * FROM crm_editions WHERE id = ?`).bind(pt.edition_id).first<EditionRow>();
      if (!ed) return { kind: 'refuse', error: 'not_found' };

      const scope = `programme:${ed.programme_slug}`;
      if (!evaluateCapability(actor, 'crm.restricted.read', scope)) {
        return { kind: 'refuse', error: 'forbidden' };
      }
      if (!(await loadReadableTaskRecord(env, actor.id, ed.event_record_id))) {
        return { kind: 'refuse', error: 'not_found' };
      }

      const existing = await env.DB
        .prepare(`SELECT * FROM crm_screenings WHERE participant_id = ?`)
        .bind(pt.id)
        .first<ScreeningRow>();

      const nextRow: ScreeningRow = {
        participant_id: pt.id,
        booking_id: pt.booking_id,
        edition_id: ed.id,
        programme_slug: ed.programme_slug,
        answers_json: JSON.stringify(input.answers),
        evidence_note: input.evidenceNote ?? existing?.evidence_note ?? null,
        state: input.state,
        review_note: existing?.review_note ?? null,
        reviewed_by: existing?.reviewed_by ?? null,
        reviewed_at: existing?.reviewed_at ?? null,
        rev: existing ? existing.rev + 1 : 1,
        created_by: existing?.created_by ?? actor.id,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };

      const stmt = existing
        ? env.DB
            .prepare(
              `UPDATE crm_screenings
               SET answers_json = ?, evidence_note = ?, state = ?, rev = rev + 1, updated_at = ?
               WHERE participant_id = ? AND rev = ?`,
            )
            .bind(nextRow.answers_json, nextRow.evidence_note, nextRow.state, now, pt.id, existing.rev)
        : env.DB
            .prepare(
              `INSERT INTO crm_screenings
                 (participant_id, booking_id, edition_id, programme_slug, answers_json, evidence_note, state, review_note, reviewed_by, reviewed_at, rev, created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 1, ?, ?, ?)`,
            )
            .bind(
              pt.id,
              pt.booking_id,
              ed.id,
              ed.programme_slug,
              nextRow.answers_json,
              nextRow.evidence_note,
              nextRow.state,
              actor.id,
              now,
              now,
            );

      return {
        kind: 'commit',
        result: { screening: mapScreeningRow(nextRow) },
        fences: [() => crmActorFence(env.DB, actor, tokenHash, 'crm.restricted.read', scope)],
        rows: existing ? [stmt, changesOneFence(env.DB)] : [stmt],
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function reviewScreeningCommand(): CommandDefinition<ReviewScreeningInput, { screening: CrmScreeningDto }> {
  return {
    name: 'screening.review',
    // Strictly human-reviewed UI decision; NEVER automated medical or suitability decision!
    authorizeCoarse: (actor, via) => via === 'ui' && canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = ReviewScreeningInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const existing = await env.DB
        .prepare(`SELECT * FROM crm_screenings WHERE participant_id = ?`)
        .bind(input.participantId)
        .first<ScreeningRow>();
      if (!existing) return { kind: 'refuse', error: 'not_found' };
      if (input.expectedRev !== undefined && existing.rev !== input.expectedRev) {
        return { kind: 'refuse', error: 'stale' };
      }

      const scope = `programme:${existing.programme_slug}`;
      if (!evaluateCapability(actor, 'crm.restricted.read', scope)) {
        return { kind: 'refuse', error: 'forbidden' };
      }

      const updated: ScreeningRow = {
        ...existing,
        state: input.state,
        review_note: input.reviewNote,
        reviewed_by: actor.id,
        reviewed_at: now,
        rev: existing.rev + 1,
        updated_at: now,
      };
      return {
        kind: 'commit',
        result: { screening: mapScreeningRow(updated) },
        fences: [() => crmActorFence(env.DB, actor, tokenHash, 'crm.restricted.read', scope)],
        rows: [
          env.DB
            .prepare(
              `UPDATE crm_screenings
               SET state = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?, rev = rev + 1, updated_at = ?
               WHERE participant_id = ? AND rev = ?`,
            )
            .bind(updated.state, updated.review_note, actor.id, now, now, existing.participant_id, existing.rev),
          changesOneFence(env.DB),
        ],
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function completeEditionCommand(): CommandDefinition<CompleteEditionInput, { editionId: string; completedBookings: number }> {
  return {
    name: 'edition.complete',
    authorizeCoarse: (actor, via) => via === 'ui' && canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = CompleteEditionInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const ed = await env.DB.prepare(`SELECT * FROM crm_editions WHERE id = ?`).bind(input.editionId).first<EditionRow>();
      if (!ed) return { kind: 'refuse', error: 'not_found' };
      if (input.expectedRev !== undefined && ed.rev !== input.expectedRev) {
        return { kind: 'refuse', error: 'stale' };
      }
      const scope = `programme:${ed.programme_slug}`;
      if (!evaluateCapability(actor, 'crm.configure', scope)) {
        return { kind: 'refuse', error: 'forbidden' };
      }
      if (!(await loadReadableTaskRecord(env, actor.id, ed.event_record_id))) {
        return { kind: 'refuse', error: 'not_found' };
      }

      const [confirmedBookingsRes, participantsRes] = await env.DB.batch([
        env.DB.prepare(`SELECT id FROM crm_bookings WHERE edition_id = ? AND state = 'confirmed'`).bind(ed.id),
        env.DB
          .prepare(
            `SELECT p.id FROM crm_participants p
             JOIN crm_bookings b ON b.id = p.booking_id
             WHERE p.edition_id = ? AND b.state = 'confirmed' AND p.state != 'cancelled'
             LIMIT 200`,
          )
          .bind(ed.id),
      ]);
      const confirmedCount = confirmedBookingsRes.results.length;
      const sessionDates = parseStringArray(ed.session_dates_json);

      const rows: D1PreparedStatement[] = [
        env.DB
          .prepare(`UPDATE crm_editions SET state = 'completed', rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?`)
          .bind(now, ed.id, ed.rev),
        changesOneFence(env.DB),
        env.DB
          .prepare(`UPDATE crm_bookings SET state = 'completed', rev = rev + 1, updated_at = ? WHERE edition_id = ? AND state = 'confirmed'`)
          .bind(now, ed.id),
        env.DB
          .prepare(
            `UPDATE crm_allocations SET released_at = ?, release_reason = 'edition_completed', updated_at = ?
             WHERE edition_id = ? AND kind = 'hold' AND released_at IS NULL`,
          )
          .bind(now, now, ed.id),
      ];

      // Mark unrecorded attendance slots as 'not_recorded' (NEVER 'absent')!
      if (sessionDates.length > 0 && participantsRes.results.length > 0) {
        for (const p of participantsRes.results as unknown as { id: string }[]) {
          for (const d of sessionDates) {
            rows.push(
              env.DB
                .prepare(
                  `INSERT OR IGNORE INTO crm_attendance (id, participant_id, edition_id, session_date, state, notes, recorded_by, recorded_at, updated_at)
                   VALUES (?, ?, ?, ?, 'not_recorded', NULL, ?, ?, ?)`,
                )
                .bind(`att_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`, p.id, ed.id, d, actor.id, now, now),
            );
          }
        }
      }

      return {
        kind: 'commit',
        result: { editionId: ed.id, completedBookings: confirmedCount },
        fences: [() => crmActorFence(env.DB, actor, tokenHash, 'crm.configure', scope)],
        rows,
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

export function createS6BookingCommandDefs(): AnyCommandDefinition[] {
  return [
    upsertEditionCommand(),
    requestBookingCommand(),
    holdBookingCommand(),
    confirmBookingCommand(),
    cancelBookingCommand(),
    transferBookingCommand(),
    offerWaitlistCommand(),
    acceptWaitlistOfferCommand(),
    updateParticipantCommand(),
    recordAttendanceCommand(),
    upsertScreeningCommand(),
    reviewScreeningCommand(),
    completeEditionCommand(),
  ];
}

/* ---------- S6 Read APIs ---------- */

export async function readEditions(
  env: Env,
  actorId: string,
  tokenHash: string,
): Promise<
  | { status: 200; body: EditionsListResponse }
  | { status: 401 | 403 | 404; body: { error: string } }
> {
  if (!isCrmEnabled(env)) return { status: 404, body: { error: 'not_found' } };
  const now = Date.now();
  const [sessionRes, grantsRes, edRes] = await env.DB.batch([
    sessionAuthStmt(env.DB, actorId, tokenHash, now),
    actorGrantsStmt(env.DB, actorId),
    env.DB.prepare(`SELECT * FROM crm_editions ORDER BY updated_at DESC LIMIT 100`),
  ]);
  const batchAuth = evaluateCrmReadAuthRows(
    sessionRes.results[0] as CrmSessionRow | undefined,
    grantsRes.results as unknown as CrmGrantRow[],
  );
  if (!batchAuth.ok) return { status: batchAuth.status, body: batchAuth.body };

  const edRows = edRes.results as unknown as EditionRow[];
  const gate = createReadGate(env.DB, actorId);
  const eventIds = [...new Set(edRows.map((e) => e.event_record_id))];
  const readableEvents = await loadReadableTaskRecords(env, gate, eventIds);
  const visibleRows = edRows.filter((e) => readableEvents.has(e.event_record_id));
  const statsMap = await computeEditionSeatStats(env.DB, visibleRows.map((e) => e.id), now);

  const finalAuth = await finalizeCrmReadAuth(env, actorId, tokenHash, { gate });
  if (!finalAuth.ok) return { status: finalAuth.status, body: finalAuth.body };

  return {
    status: 200,
    body: EditionsListResponseSchema.parse({
      items: visibleRows.map((r) => mapEditionRow(r, statsMap.get(r.id))),
      partial: visibleRows.length < edRows.length || edRows.length >= 100,
    }),
  };
}

export async function readEditionDetail(
  env: Env,
  actorId: string,
  tokenHash: string,
  editionId: string,
): Promise<
  | { status: 200; body: EditionDetailResponse }
  | { status: 401 | 403 | 404; body: { error: string } }
> {
  if (!isCrmEnabled(env)) return { status: 404, body: { error: 'not_found' } };
  const now = Date.now();
  const [sessionRes, grantsRes, edRes, bkRes, ptRes, attRes] = await env.DB.batch([
    sessionAuthStmt(env.DB, actorId, tokenHash, now),
    actorGrantsStmt(env.DB, actorId),
    env.DB.prepare(`SELECT * FROM crm_editions WHERE id = ?`).bind(editionId),
    env.DB.prepare(`SELECT * FROM crm_bookings WHERE edition_id = ? ORDER BY created_at ASC LIMIT 200`).bind(editionId),
    env.DB.prepare(`SELECT * FROM crm_participants WHERE edition_id = ? ORDER BY booking_id ASC, placeholder_index ASC LIMIT 400`).bind(editionId),
    env.DB.prepare(`SELECT * FROM crm_attendance WHERE edition_id = ? ORDER BY session_date ASC LIMIT 1000`).bind(editionId),
  ]);
  const batchAuth = evaluateCrmReadAuthRows(
    sessionRes.results[0] as CrmSessionRow | undefined,
    grantsRes.results as unknown as CrmGrantRow[],
  );
  if (!batchAuth.ok) return { status: batchAuth.status, body: batchAuth.body };

  const edRow = edRes.results[0] as EditionRow | undefined;
  if (!edRow) return { status: 404, body: { error: 'not_found' } };

  const gate = createReadGate(env.DB, actorId);
  const bkRows = bkRes.results as unknown as BookingRow[];
  const recordIds = [...new Set([edRow.event_record_id, ...bkRows.map((b) => b.booker_person_id)])];
  const readable = await loadReadableTaskRecords(env, gate, recordIds);
  if (!readable.has(edRow.event_record_id)) return { status: 404, body: { error: 'not_found' } };

  const statsMap = await computeEditionSeatStats(env.DB, [edRow.id], now);
  const finalAuth = await finalizeCrmReadAuth(env, actorId, tokenHash, { gate });
  if (!finalAuth.ok) return { status: finalAuth.status, body: finalAuth.body };

  const visibleBookings = bkRows.filter((b) => readable.has(b.booker_person_id));
  const visibleBookingIds = new Set(visibleBookings.map((b) => b.id));
  const ptRows = (ptRes.results as unknown as ParticipantRow[]).filter((p) => visibleBookingIds.has(p.booking_id));
  const visibleParticipantIds = new Set(ptRows.map((p) => p.id));
  const attRows = (attRes.results as unknown as AttendanceRow[]).filter((a) => visibleParticipantIds.has(a.participant_id));

  const canReadScreening = evaluateCapability(finalAuth.actor, 'crm.restricted.read', `programme:${edRow.programme_slug}`);

  return {
    status: 200,
    body: EditionDetailResponseSchema.parse({
      edition: mapEditionRow(edRow, statsMap.get(edRow.id)),
      bookings: visibleBookings.map((b) => {
        const rec = readable.get(b.booker_person_id);
        const name = typeof rec?.data.title === 'string' ? rec.data.title : null;
        return mapBookingRow(b, edRow.title, edRow.programme_slug, name, now);
      }),
      participants: ptRows.map(mapParticipantRow),
      attendance: attRows.map(mapAttendanceRow),
      canReadScreening,
      partial: visibleBookings.length < bkRows.length,
    }),
  };
}

export async function readBookingDetail(
  env: Env,
  actorId: string,
  tokenHash: string,
  bookingId: string,
): Promise<
  | { status: 200; body: BookingDetailResponse }
  | { status: 401 | 403 | 404; body: { error: string } }
> {
  if (!isCrmEnabled(env)) return { status: 404, body: { error: 'not_found' } };
  const now = Date.now();
  const [sessionRes, grantsRes, bkRes, ptRes, prRes, ledRes] = await env.DB.batch([
    sessionAuthStmt(env.DB, actorId, tokenHash, now),
    actorGrantsStmt(env.DB, actorId),
    env.DB.prepare(`SELECT * FROM crm_bookings WHERE id = ?`).bind(bookingId),
    env.DB.prepare(`SELECT * FROM crm_participants WHERE booking_id = ? ORDER BY placeholder_index ASC, id ASC`).bind(bookingId),
    env.DB.prepare(`SELECT currency, amount_minor, state FROM crm_payment_requests WHERE object_type = 'booking' AND object_id = ? AND state NOT IN ('cancelled', 'expired')`).bind(bookingId),
    env.DB.prepare(`SELECT currency, amount_minor FROM crm_ledger_entries WHERE object_type = 'booking' AND object_id = ?`).bind(bookingId),
  ]);
  const batchAuth = evaluateCrmReadAuthRows(
    sessionRes.results[0] as CrmSessionRow | undefined,
    grantsRes.results as unknown as CrmGrantRow[],
  );
  if (!batchAuth.ok) return { status: batchAuth.status, body: batchAuth.body };

  const bkRow = bkRes.results[0] as BookingRow | undefined;
  if (!bkRow) return { status: 404, body: { error: 'not_found' } };
  const edRow = await env.DB.prepare(`SELECT * FROM crm_editions WHERE id = ?`).bind(bkRow.edition_id).first<EditionRow>();
  if (!edRow) return { status: 404, body: { error: 'not_found' } };

  const gate = createReadGate(env.DB, actorId);
  const readable = await loadReadableTaskRecords(env, gate, [edRow.event_record_id, bkRow.booker_person_id]);
  if (!readable.has(edRow.event_record_id) || !readable.has(bkRow.booker_person_id)) {
    return { status: 404, body: { error: 'not_found' } };
  }

  const ptRows = ptRes.results as unknown as ParticipantRow[];
  const attRes =
    ptRows.length > 0
      ? await env.DB
          .prepare(`SELECT * FROM crm_attendance WHERE participant_id IN (SELECT value FROM json_each(?)) ORDER BY session_date ASC`)
          .bind(JSON.stringify(ptRows.map((p) => p.id)))
          .all<AttendanceRow>()
      : { results: [] as AttendanceRow[] };
  const statsMap = await computeEditionSeatStats(env.DB, [edRow.id], now);

  const finalAuth = await finalizeCrmReadAuth(env, actorId, tokenHash, { gate });
  if (!finalAuth.ok) return { status: finalAuth.status, body: finalAuth.body };

  const canReadScreening = evaluateCapability(finalAuth.actor, 'crm.restricted.read', `programme:${edRow.programme_slug}`);
  const canReadMoney = evaluateCapability(finalAuth.actor, 'crm.finance.read', '*');

  const paymentSummaryByCurrency: { currency: string; dueMinor: number; netPaidMinor: number; balanceMinor: number }[] = [];
  if (canReadMoney) {
    const byCur = new Map<string, { due: number; paid: number }>();
    for (const r of prRes.results as unknown as { currency: string; amount_minor: number }[]) {
      const cur = byCur.get(r.currency) ?? { due: 0, paid: 0 };
      cur.due += r.amount_minor;
      byCur.set(r.currency, cur);
    }
    for (const l of ledRes.results as unknown as { currency: string; amount_minor: number }[]) {
      const cur = byCur.get(l.currency) ?? { due: 0, paid: 0 };
      cur.paid += l.amount_minor;
      byCur.set(l.currency, cur);
    }
    for (const [currency, v] of [...byCur.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      paymentSummaryByCurrency.push({
        currency,
        dueMinor: v.due,
        netPaidMinor: v.paid,
        balanceMinor: v.due - v.paid,
      });
    }
  }

  const bookerRec = readable.get(bkRow.booker_person_id);
  const bookerName = typeof bookerRec?.data.title === 'string' ? bookerRec.data.title : null;

  return {
    status: 200,
    body: BookingDetailResponseSchema.parse({
      booking: mapBookingRow(bkRow, edRow.title, edRow.programme_slug, bookerName, now),
      edition: mapEditionRow(edRow, statsMap.get(edRow.id)),
      participants: ptRows.map(mapParticipantRow),
      attendance: attRes.results.map(mapAttendanceRow),
      canReadScreening,
      canReadMoney,
      paymentSummaryByCurrency,
    }),
  };
}

/**
 * Programme-scoped RESTRICTED screening read endpoint.
 * Strictly requires `crm.restricted.read` for `programme:<slug>` or `*`.
 * Screening data NEVER appears in ordinary sync, search, notifications, projections, or unauthorized reads.
 */
export async function readBookingScreening(
  env: Env,
  actorId: string,
  tokenHash: string,
  bookingId: string,
): Promise<
  | { status: 200; body: BookingScreeningResponse }
  | { status: 401 | 403 | 404; body: { error: string } }
> {
  if (!isCrmEnabled(env)) return { status: 404, body: { error: 'not_found' } };
  const now = Date.now();
  const [sessionRes, grantsRes, bkRes, scrRes] = await env.DB.batch([
    sessionAuthStmt(env.DB, actorId, tokenHash, now),
    actorGrantsStmt(env.DB, actorId),
    env.DB.prepare(`SELECT id, edition_id, booker_person_id FROM crm_bookings WHERE id = ?`).bind(bookingId),
    env.DB.prepare(`SELECT * FROM crm_screenings WHERE booking_id = ? ORDER BY created_at ASC`).bind(bookingId),
  ]);
  const batchAuth = evaluateCrmReadAuthRows(
    sessionRes.results[0] as CrmSessionRow | undefined,
    grantsRes.results as unknown as CrmGrantRow[],
  );
  if (!batchAuth.ok) return { status: batchAuth.status, body: batchAuth.body };

  const bkRow = bkRes.results[0] as { id: string; edition_id: string; booker_person_id: string } | undefined;
  if (!bkRow) return { status: 404, body: { error: 'not_found' } };

  const edRow = await env.DB.prepare(`SELECT * FROM crm_editions WHERE id = ?`).bind(bkRow.edition_id).first<EditionRow>();
  if (!edRow) return { status: 404, body: { error: 'not_found' } };

  const scope = `programme:${edRow.programme_slug}`;
  if (!evaluateCapability(batchAuth.actor, 'crm.restricted.read', scope)) {
    return { status: 403, body: { error: 'forbidden' } };
  }

  const gate = createReadGate(env.DB, actorId);
  const readable = await loadReadableTaskRecords(env, gate, [edRow.event_record_id, bkRow.booker_person_id]);
  if (!readable.has(edRow.event_record_id) || !readable.has(bkRow.booker_person_id)) {
    return { status: 404, body: { error: 'not_found' } };
  }

  // Re-verify restricted capability AFTER all reads (SC-2.2)!
  const finalAuth = await finalizeCrmReadAuth(env, actorId, tokenHash, { gate });
  if (!finalAuth.ok) return { status: finalAuth.status, body: finalAuth.body };
  if (!evaluateCapability(finalAuth.actor, 'crm.restricted.read', scope)) {
    return { status: 403, body: { error: 'forbidden' } };
  }

  return {
    status: 200,
    body: BookingScreeningResponseSchema.parse({
      bookingId: bkRow.id,
      programmeSlug: edRow.programme_slug,
      questions: parseStringArray(edRow.screening_questions_json),
      items: (scrRes.results as unknown as ScreeningRow[]).map(mapScreeningRow),
    }),
  };
}
