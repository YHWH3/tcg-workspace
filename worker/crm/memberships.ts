import {
  ActivateOrRenewMembershipInputSchema,
  ApplyMembershipInputSchema,
  CancelMembershipInputSchema,
  CrmMembershipDtoSchema,
  CrmMembershipSchemeDtoSchema,
  DecideMembershipInputSchema,
  MembershipsOverviewResponseSchema,
  UpsertMembershipSchemeInputSchema,
  derivePaymentStatus,
  evaluateEffectiveMembershipState,
  formatMemberIdentifier,
  isForeignCurrencyBlocked,
  type ActivateOrRenewMembershipInput,
  type ApplyMembershipInput,
  type CancelMembershipInput,
  type CrmMembershipDto,
  type CrmMembershipSchemeDto,
  type DecideMembershipInput,
  type MembershipState,
  type MembershipsOverviewResponse,
  type PaymentStatus,
  type UpsertMembershipSchemeInput,
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

interface SchemeRow {
  id: string;
  slug: string;
  name: string;
  programme_slug: string;
  contribution_amount_minor: number | null;
  currency: string | null;
  validity_days: number | null;
  renewal_notice_days: number | null;
  identifier_prefix: string | null;
  identifier_digits: number | null;
  next_identifier_seq: number;
  benefits_enabled: number;
  active: number;
  rev: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface MembershipRow {
  id: string;
  scheme_id: string;
  person_id: string;
  application_id: string | null;
  state: MembershipState;
  member_identifier: string | null;
  valid_from: number | null;
  valid_until: number | null;
  payment_status: PaymentStatus;
  period_count: number;
  notes: string | null;
  decision_reason: string | null;
  rev: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface ActivePeriodRow {
  id: string;
  period_number: number;
  required_amount_minor: number;
  currency: string;
  valid_from: number;
  valid_until: number;
}

function changesOneFence(db: D1Database): D1PreparedStatement {
  return db.prepare(`SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('{', '$') END`);
}

function schemeRevFence(db: D1Database, schemeId: string, rev: number): D1PreparedStatement {
  return db
    .prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM crm_membership_schemes WHERE id = ? AND rev = ?) THEN 1 ELSE json_extract('{', '$') END`)
    .bind(schemeId, rev);
}

function activePeriodsFence(db: D1Database, membershipId: string, periods: readonly ActivePeriodRow[]): D1PreparedStatement {
  const sum = periods.reduce((acc, p) => acc + p.required_amount_minor, 0);
  return db
    .prepare(
      `SELECT CASE WHEN
         (SELECT COUNT(*) FROM crm_membership_periods WHERE membership_id = ? AND status = 'active') = ?
         AND COALESCE((SELECT SUM(required_amount_minor) FROM crm_membership_periods WHERE membership_id = ? AND status = 'active'), 0) = ?
       THEN 1 ELSE json_extract('{', '$') END`,
    )
    .bind(membershipId, periods.length, membershipId, sum);
}

function mapSchemeRow(r: SchemeRow): CrmMembershipSchemeDto {
  return CrmMembershipSchemeDtoSchema.parse({
    id: r.id,
    slug: r.slug,
    name: r.name,
    programmeSlug: r.programme_slug,
    contributionAmountMinor: r.contribution_amount_minor,
    currency: r.currency,
    validityDays: r.validity_days,
    renewalNoticeDays: r.renewal_notice_days,
    identifierPrefix: r.identifier_prefix,
    identifierDigits: r.identifier_digits,
    nextIdentifierSeq: r.next_identifier_seq,
    benefitsEnabled: false,
    active: r.active === 1,
    rev: r.rev,
    updatedAt: r.updated_at,
  });
}

function mapMembershipRow(
  r: MembershipRow,
  scheme: Pick<SchemeRow, 'name' | 'renewal_notice_days'>,
  personName: string | null,
  now: number,
): CrmMembershipDto {
  return CrmMembershipDtoSchema.parse({
    id: r.id,
    schemeId: r.scheme_id,
    schemeName: scheme.name,
    personId: r.person_id,
    personName,
    applicationId: r.application_id,
    state: r.state,
    effectiveState: evaluateEffectiveMembershipState({
      storedState: r.state,
      validUntil: r.valid_until,
      renewalNoticeDays: scheme.renewal_notice_days,
      now,
    }),
    memberIdentifier: r.member_identifier,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
    paymentStatus: r.payment_status,
    periodCount: r.period_count,
    notes: r.notes,
    decisionReason: r.decision_reason,
    rev: r.rev,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

function schemePolicyError(s: SchemeRow): string | null {
  if (s.contribution_amount_minor === null || !s.currency) return 'scheme_contribution_unconfigured_pending_O07';
  if (isForeignCurrencyBlocked(s.currency)) return 'foreign_contribution_blocked_pending_policy';
  if (s.validity_days === null || s.validity_days <= 0) return 'scheme_validity_unconfigured_pending_O07';
  if (!s.identifier_prefix || !s.identifier_digits) return 'scheme_identifier_unconfigured_pending_O07';
  return null;
}

async function loadMembershipLedgerSummary(
  db: D1Database,
  membershipId: string,
  currency: string,
): Promise<{ netPaidMinor: number; pendingRefundMinor: number; issuedRefundCount: number; activePeriods: ActivePeriodRow[] }> {
  const [ledRes, refRes, perRes] = await db.batch([
    db
      .prepare(
        `SELECT COALESCE(SUM(amount_minor), 0) AS net_minor
         FROM crm_ledger_entries
         WHERE object_type = 'membership' AND object_id = ? AND currency = ?`,
      )
      .bind(membershipId, currency),
    db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN state IN ('requested', 'approved') THEN amount_minor ELSE 0 END), 0) AS pending_minor,
           COALESCE(SUM(CASE WHEN state = 'issued' THEN 1 ELSE 0 END), 0) AS issued_count
         FROM crm_refund_requests
         WHERE object_type = 'membership' AND object_id = ? AND currency = ?`,
      )
      .bind(membershipId, currency),
    db
      .prepare(
        `SELECT id, period_number, required_amount_minor, currency, valid_from, valid_until
         FROM crm_membership_periods
         WHERE membership_id = ? AND status = 'active'
         ORDER BY period_number ASC`,
      )
      .bind(membershipId),
  ]);
  const netPaidMinor = Number((ledRes.results[0] as { net_minor: number } | undefined)?.net_minor ?? 0);
  const refRow = refRes.results[0] as { pending_minor: number; issued_count: number } | undefined;
  return {
    netPaidMinor,
    pendingRefundMinor: Number(refRow?.pending_minor ?? 0),
    issuedRefundCount: Number(refRow?.issued_count ?? 0),
    activePeriods: perRes.results as unknown as ActivePeriodRow[],
  };
}

/* ---------- S8 Commands ---------- */

function upsertMembershipSchemeCommand(): CommandDefinition<
  UpsertMembershipSchemeInput,
  { scheme: CrmMembershipSchemeDto }
> {
  return {
    name: 'membership_scheme.upsert',
    authorizeCoarse: (actor, via) => via === 'ui' && canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = UpsertMembershipSchemeInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      if (!isRegisteredProgrammeSlug(parsed.data.programmeSlug)) {
        return { ok: false, error: 'invalid_input', detail: { reason: 'unknown_programme_slug' } };
      }
      return { ok: true, input: parsed.data };
    },
    authorizeFine: (actor, input) =>
      evaluateCapability(actor, 'crm.configure', `programme:${input.programmeSlug}`),
    authorizeReplay: (actor, input) =>
      evaluateCapability(actor, 'crm.configure', `programme:${input.programmeSlug}`),
    plan: async ({ env, actor, tokenHash, input, now }) => {
      if (input.currency && isForeignCurrencyBlocked(input.currency)) {
        return {
          kind: 'refuse',
          error: 'invalid_input',
          detail: { reason: 'foreign_contribution_blocked_pending_policy', currency: input.currency },
        };
      }
      const existing = input.schemeId
        ? await env.DB.prepare(`SELECT * FROM crm_membership_schemes WHERE id = ?`).bind(input.schemeId).first<SchemeRow>()
        : await env.DB.prepare(`SELECT * FROM crm_membership_schemes WHERE slug = ?`).bind(input.slug).first<SchemeRow>();
      if (input.schemeId && !existing) return { kind: 'refuse', error: 'not_found' };
      if (existing && input.expectedRev !== undefined && existing.rev !== input.expectedRev) {
        return { kind: 'refuse', error: 'stale' };
      }

      const id = existing?.id ?? `ms_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const nextRow: SchemeRow = {
        id,
        slug: input.slug,
        name: input.name,
        programme_slug: input.programmeSlug,
        contribution_amount_minor:
          input.contributionAmountMinor !== undefined
            ? input.contributionAmountMinor
            : (existing?.contribution_amount_minor ?? null),
        currency: input.currency !== undefined ? input.currency : (existing?.currency ?? null),
        validity_days: input.validityDays !== undefined ? input.validityDays : (existing?.validity_days ?? null),
        renewal_notice_days:
          input.renewalNoticeDays !== undefined ? input.renewalNoticeDays : (existing?.renewal_notice_days ?? null),
        identifier_prefix:
          input.identifierPrefix !== undefined ? input.identifierPrefix : (existing?.identifier_prefix ?? null),
        identifier_digits:
          input.identifierDigits !== undefined ? input.identifierDigits : (existing?.identifier_digits ?? null),
        next_identifier_seq: existing?.next_identifier_seq ?? 1,
        benefits_enabled: 0, // Permanently disabled until owner confirms O-07 rules!
        active: input.active !== undefined ? (input.active ? 1 : 0) : (existing?.active ?? 0),
        rev: existing ? existing.rev + 1 : 1,
        created_by: existing?.created_by ?? actor.id,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };

      if (nextRow.active === 1) {
        const err = schemePolicyError(nextRow);
        if (err) {
          return { kind: 'refuse', error: 'invalid_input', detail: { reason: err } };
        }
      }

      const stmt = existing
        ? env.DB
            .prepare(
              `UPDATE crm_membership_schemes
               SET slug = ?, name = ?, programme_slug = ?, contribution_amount_minor = ?, currency = ?,
                   validity_days = ?, renewal_notice_days = ?, identifier_prefix = ?, identifier_digits = ?,
                   active = ?, rev = rev + 1, updated_at = ?
               WHERE id = ? AND rev = ?`,
            )
            .bind(
              nextRow.slug,
              nextRow.name,
              nextRow.programme_slug,
              nextRow.contribution_amount_minor,
              nextRow.currency,
              nextRow.validity_days,
              nextRow.renewal_notice_days,
              nextRow.identifier_prefix,
              nextRow.identifier_digits,
              nextRow.active,
              now,
              existing.id,
              existing.rev,
            )
        : env.DB
            .prepare(
              `INSERT INTO crm_membership_schemes
                 (id, slug, name, programme_slug, contribution_amount_minor, currency, validity_days, renewal_notice_days, identifier_prefix, identifier_digits, next_identifier_seq, benefits_enabled, active, rev, created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, 1, ?, ?, ?)`,
            )
            .bind(
              nextRow.id,
              nextRow.slug,
              nextRow.name,
              nextRow.programme_slug,
              nextRow.contribution_amount_minor,
              nextRow.currency,
              nextRow.validity_days,
              nextRow.renewal_notice_days,
              nextRow.identifier_prefix,
              nextRow.identifier_digits,
              nextRow.active,
              actor.id,
              now,
              now,
            );

      return {
        kind: 'commit',
        result: { scheme: mapSchemeRow(nextRow) },
        fences: [() => crmActorFence(env.DB, actor, tokenHash, 'crm.configure', `programme:${input.programmeSlug}`)],
        rows: existing ? [stmt, changesOneFence(env.DB)] : [stmt],
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function applyMembershipCommand(): CommandDefinition<ApplyMembershipInput, { membership: CrmMembershipDto }> {
  return {
    name: 'membership.apply',
    projectionKeys: [CRM_PROJECTION.membershipStatus],
    authorizeCoarse: (actor, via) => via === 'ui' && canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = ApplyMembershipInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    authorizeReplay: async (actor, input, _stored, { env }) => {
      const personRec = await loadReadableTaskRecord(env, actor.id, input.personId);
      if (!personRec) return false;
      if (input.applicationId && !(await loadReadableTaskRecord(env, actor.id, input.applicationId))) {
        return false;
      }
      return true;
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const [scheme, personRec] = await Promise.all([
        env.DB.prepare(`SELECT * FROM crm_membership_schemes WHERE id = ?`).bind(input.schemeId).first<SchemeRow>(),
        loadReadableTaskRecord(env, actor.id, input.personId),
      ]);
      if (!scheme || !personRec) return { kind: 'refuse', error: 'not_found' };
      if (scheme.active !== 1) {
        return { kind: 'refuse', error: 'invalid_input', detail: { reason: 'membership_scheme_inactive' } };
      }
      const aliasState = await assertNotArchivedAlias(env.DB, personRec);
      if (aliasState.archived) {
        return {
          kind: 'refuse',
          error: 'invalid_input',
          detail: { reason: 'person_merged_or_archived', mergedInto: aliasState.mergedInto },
        };
      }
      const expectMap = new Map<string, number>([[personRec.id, personRec.seq]]);
      if (input.applicationId) {
        const appRec = await loadReadableTaskRecord(env, actor.id, input.applicationId);
        if (!appRec) return { kind: 'refuse', error: 'not_found' };
        expectMap.set(appRec.id, appRec.seq);
      }

      const id = `mem_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const row: MembershipRow = {
        id,
        scheme_id: scheme.id,
        person_id: personRec.id,
        application_id: input.applicationId ?? null,
        state: 'applied',
        member_identifier: null,
        valid_from: null,
        valid_until: null,
        payment_status: 'unpaid',
        period_count: 0,
        notes: input.notes ?? null,
        decision_reason: null,
        rev: 1,
        created_by: actor.id,
        created_at: now,
        updated_at: now,
      };
      const personTitle = typeof personRec.data.title === 'string' ? personRec.data.title : null;

      return {
        kind: 'commit',
        result: { membership: mapMembershipRow(row, scheme, personTitle, now) },
        fences: [
          () => crmActorFence(env.DB, actor, tokenHash),
          () => notArchivedAliasFence(env.DB, personRec.id),
          schemeRevFence(env.DB, scheme.id, scheme.rev),
        ],
        rows: [
          env.DB
            .prepare(
              `INSERT INTO crm_memberships
                 (id, scheme_id, person_id, application_id, state, member_identifier, valid_from, valid_until, payment_status, period_count, notes, decision_reason, rev, created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'applied', NULL, NULL, NULL, 'unpaid', 0, ?, NULL, 1, ?, ?, ?)`,
            )
            .bind(id, scheme.id, personRec.id, row.application_id, row.notes, actor.id, now, now),
        ],
        records: [
          {
            id: personRec.id,
            collection: 'tasks',
            patch: { [CRM_PROJECTION.membershipStatus]: 'applied' },
            ts: now,
          },
        ],
        recordExpect: expectMap,
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function decideMembershipCommand(): CommandDefinition<DecideMembershipInput, { membership: CrmMembershipDto }> {
  return {
    name: 'membership.decide',
    projectionKeys: [CRM_PROJECTION.membershipStatus],
    authorizeCoarse: (actor, via) => via === 'ui' && canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = DecideMembershipInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    authorizeReplay: async (actor, input, _stored, { env }) => {
      const row = await env.DB
        .prepare(
          `SELECT m.person_id, s.programme_slug
           FROM crm_memberships m JOIN crm_membership_schemes s ON s.id = m.scheme_id
           WHERE m.id = ?`,
        )
        .bind(input.membershipId)
        .first<{ person_id: string; programme_slug: string }>();
      if (!row) return false;
      if (!evaluateCapability(actor, 'crm.configure', `programme:${row.programme_slug}`)) return false;
      return (await loadReadableTaskRecord(env, actor.id, row.person_id)) !== null;
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const mem = await env.DB.prepare(`SELECT * FROM crm_memberships WHERE id = ?`).bind(input.membershipId).first<MembershipRow>();
      if (!mem) return { kind: 'refuse', error: 'not_found' };
      if (input.expectedRev !== undefined && mem.rev !== input.expectedRev) {
        return { kind: 'refuse', error: 'stale' };
      }
      if (mem.state !== 'applied') {
        return { kind: 'refuse', error: 'stale', detail: { reason: 'membership_not_applied', state: mem.state } };
      }
      const [scheme, personRec] = await Promise.all([
        env.DB.prepare(`SELECT * FROM crm_membership_schemes WHERE id = ?`).bind(mem.scheme_id).first<SchemeRow>(),
        loadReadableTaskRecord(env, actor.id, mem.person_id),
      ]);
      if (!scheme || !personRec) return { kind: 'refuse', error: 'not_found' };

      const scope = `programme:${scheme.programme_slug}`;
      if (!evaluateCapability(actor, 'crm.configure', scope)) {
        return { kind: 'refuse', error: 'forbidden' };
      }

      const nextState: MembershipState = input.decision === 'approve' ? 'approved' : 'declined';
      const updated: MembershipRow = {
        ...mem,
        state: nextState,
        decision_reason: input.reason,
        rev: mem.rev + 1,
        updated_at: now,
      };
      const personTitle = typeof personRec.data.title === 'string' ? personRec.data.title : null;

      return {
        kind: 'commit',
        result: { membership: mapMembershipRow(updated, scheme, personTitle, now) },
        fences: [() => crmActorFence(env.DB, actor, tokenHash, 'crm.configure', scope)],
        rows: [
          env.DB
            .prepare(
              `UPDATE crm_memberships
               SET state = ?, decision_reason = ?, rev = rev + 1, updated_at = ?
               WHERE id = ? AND rev = ? AND state = 'applied'`,
            )
            .bind(nextState, input.reason, now, mem.id, mem.rev),
          changesOneFence(env.DB),
        ],
        records: [
          {
            id: personRec.id,
            collection: 'tasks',
            patch: { [CRM_PROJECTION.membershipStatus]: nextState },
            ts: now,
          },
        ],
        recordExpect: new Map([[personRec.id, personRec.seq]]),
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function issueMembershipContributionRequestCommand(): CommandDefinition<
  ActivateOrRenewMembershipInput,
  { membership: CrmMembershipDto; paymentRequestId: string }
> {
  return {
    name: 'membership.issue_request',
    projectionKeys: [CRM_PROJECTION.membershipStatus],
    authorizeCoarse: (actor, via) =>
      via === 'ui' && canAccessCrmApi(actor) && evaluateCapability(actor, 'crm.finance.record', '*'),
    parseInput: (raw) => {
      const parsed = ActivateOrRenewMembershipInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    authorizeReplay: async (actor, input, _stored, { env }) => {
      if (!evaluateCapability(actor, 'crm.finance.record', '*')) return false;
      const mem = await env.DB
        .prepare(`SELECT person_id FROM crm_memberships WHERE id = ?`)
        .bind(input.membershipId)
        .first<{ person_id: string }>();
      if (!mem) return false;
      return (await loadReadableTaskRecord(env, actor.id, mem.person_id)) !== null;
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const mem = await env.DB.prepare(`SELECT * FROM crm_memberships WHERE id = ?`).bind(input.membershipId).first<MembershipRow>();
      if (!mem) return { kind: 'refuse', error: 'not_found' };
      if (input.expectedRev !== undefined && mem.rev !== input.expectedRev) {
        return { kind: 'refuse', error: 'stale' };
      }
      const [scheme, personRec] = await Promise.all([
        env.DB.prepare(`SELECT * FROM crm_membership_schemes WHERE id = ?`).bind(mem.scheme_id).first<SchemeRow>(),
        loadReadableTaskRecord(env, actor.id, mem.person_id),
      ]);
      if (!scheme || !personRec) return { kind: 'refuse', error: 'not_found' };
      const err = schemePolicyError(scheme);
      if (err) return { kind: 'refuse', error: 'invalid_input', detail: { reason: err } };

      const eff = evaluateEffectiveMembershipState({
        storedState: mem.state,
        validUntil: mem.valid_until,
        renewalNoticeDays: scheme.renewal_notice_days,
        now,
      });
      if (eff !== 'approved' && eff !== 'renewal_due' && eff !== 'lapsed') {
        return { kind: 'refuse', error: 'stale', detail: { reason: 'membership_not_eligible_for_request', state: eff } };
      }

      const prId = `pr_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const nextState: MembershipState = eff === 'approved' ? 'awaiting_contribution' : mem.state;
      const updated: MembershipRow = {
        ...mem,
        state: nextState,
        rev: mem.rev + 1,
        updated_at: now,
      };
      const personTitle = typeof personRec.data.title === 'string' ? personRec.data.title : null;

      return {
        kind: 'commit',
        result: {
          membership: mapMembershipRow(updated, scheme, personTitle, now),
          paymentRequestId: prId,
        },
        fences: [
          () => crmActorFence(env.DB, actor, tokenHash, 'crm.finance.record', '*'),
          schemeRevFence(env.DB, scheme.id, scheme.rev),
        ],
        rows: [
          env.DB
            .prepare(
              `INSERT INTO crm_payment_requests
                 (id, object_type, object_id, person_id, programme_slug, amount_minor, currency, state, due_at, label, rev, created_by, created_at, updated_at)
               VALUES (?, 'membership', ?, ?, ?, ?, ?, 'issued', NULL, ?, 1, ?, ?, ?)`,
            )
            .bind(
              prId,
              mem.id,
              mem.person_id,
              scheme.programme_slug,
              scheme.contribution_amount_minor!,
              scheme.currency!,
              eff === 'approved' ? `${scheme.name} contribution` : `${scheme.name} renewal contribution`,
              actor.id,
              now,
              now,
            ),
          env.DB
            .prepare(`UPDATE crm_memberships SET state = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?`)
            .bind(nextState, now, mem.id, mem.rev),
          changesOneFence(env.DB),
        ],
        records: [
          {
            id: personRec.id,
            collection: 'tasks',
            patch: { [CRM_PROJECTION.membershipStatus]: nextState },
            ts: now,
          },
        ],
        recordExpect: new Map([[personRec.id, personRec.seq]]),
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function activateMembershipCommand(): CommandDefinition<
  ActivateOrRenewMembershipInput,
  { membership: CrmMembershipDto }
> {
  return {
    name: 'membership.activate',
    projectionKeys: [CRM_PROJECTION.membershipStatus, CRM_PROJECTION.membershipValidUntil, CRM_PROJECTION.paymentStatus],
    authorizeCoarse: (actor, via) =>
      via === 'ui' && canAccessCrmApi(actor) && evaluateCapability(actor, 'crm.finance.record', '*'),
    parseInput: (raw) => {
      const parsed = ActivateOrRenewMembershipInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    authorizeReplay: async (actor, input, _stored, { env }) => {
      if (!evaluateCapability(actor, 'crm.finance.record', '*')) return false;
      const mem = await env.DB
        .prepare(`SELECT person_id FROM crm_memberships WHERE id = ?`)
        .bind(input.membershipId)
        .first<{ person_id: string }>();
      if (!mem) return false;
      return (await loadReadableTaskRecord(env, actor.id, mem.person_id)) !== null;
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const mem = await env.DB.prepare(`SELECT * FROM crm_memberships WHERE id = ?`).bind(input.membershipId).first<MembershipRow>();
      if (!mem) return { kind: 'refuse', error: 'not_found' };
      if (input.expectedRev !== undefined && mem.rev !== input.expectedRev) {
        return { kind: 'refuse', error: 'stale' };
      }
      if (mem.state !== 'awaiting_contribution') {
        return { kind: 'refuse', error: 'stale', detail: { reason: 'membership_not_awaiting_contribution', state: mem.state } };
      }
      const [scheme, personRec] = await Promise.all([
        env.DB.prepare(`SELECT * FROM crm_membership_schemes WHERE id = ?`).bind(mem.scheme_id).first<SchemeRow>(),
        loadReadableTaskRecord(env, actor.id, mem.person_id),
      ]);
      if (!scheme || !personRec) return { kind: 'refuse', error: 'not_found' };
      const err = schemePolicyError(scheme);
      if (err) return { kind: 'refuse', error: 'invalid_input', detail: { reason: err } };

      const ledger = await loadMembershipLedgerSummary(env.DB, mem.id, scheme.currency!);
      const historicalRequiredMinor = ledger.activePeriods.reduce((sum, p) => sum + p.required_amount_minor, 0);
      const newPeriodRequiredMinor = scheme.contribution_amount_minor!;
      const requiredTotalMinor = historicalRequiredMinor + newPeriodRequiredMinor;
      const availableNetMinor = ledger.netPaidMinor - ledger.pendingRefundMinor;

      if (availableNetMinor < requiredTotalMinor) {
        return {
          kind: 'refuse',
          error: 'invalid_input',
          detail: {
            reason: 'contribution_receipt_required',
            requiredMinor: requiredTotalMinor,
            netPaidMinor: ledger.netPaidMinor,
            pendingRefundMinor: ledger.pendingRefundMinor,
            currency: scheme.currency,
          },
        };
      }

      const memberIdentifier =
        mem.member_identifier ??
        formatMemberIdentifier(scheme.identifier_prefix, scheme.identifier_digits, scheme.next_identifier_seq);
      const validFrom = now;
      const validUntil = now + scheme.validity_days! * 86_400_000;
      const nextPeriodNumber = ledger.activePeriods.length + 1;
      const nextPaymentStatus = derivePaymentStatus({
        dueMinor: requiredTotalMinor,
        netPaidMinor: ledger.netPaidMinor,
        hasPendingRefund: ledger.pendingRefundMinor > 0,
        hasIssuedRefund: ledger.issuedRefundCount > 0,
      });

      const updated: MembershipRow = {
        ...mem,
        state: 'active',
        member_identifier: memberIdentifier,
        valid_from: validFrom,
        valid_until: validUntil,
        payment_status: nextPaymentStatus,
        period_count: nextPeriodNumber,
        rev: mem.rev + 1,
        updated_at: now,
      };
      const personTitle = typeof personRec.data.title === 'string' ? personRec.data.title : null;

      // Atomic SQL fence verifying ledger minus pending refunds covers all active periods + new period!
      const ledgerCoverageFence = env.DB
        .prepare(
          `SELECT CASE WHEN (
             COALESCE((SELECT SUM(amount_minor) FROM crm_ledger_entries WHERE object_type = 'membership' AND object_id = ? AND currency = ?), 0)
             - COALESCE((SELECT SUM(amount_minor) FROM crm_refund_requests WHERE object_type = 'membership' AND object_id = ? AND currency = ? AND state IN ('requested', 'approved')), 0)
           ) >= ? THEN 1 ELSE json_extract('{', '$') END`,
        )
        .bind(mem.id, scheme.currency!, mem.id, scheme.currency!, requiredTotalMinor);

      const periodId = `mp_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const rows: D1PreparedStatement[] = [];
      if (!mem.member_identifier) {
        rows.push(
          env.DB
            .prepare(
              `UPDATE crm_membership_schemes SET next_identifier_seq = next_identifier_seq + 1, rev = rev + 1, updated_at = ?
               WHERE id = ? AND rev = ?`,
            )
            .bind(now, scheme.id, scheme.rev),
          changesOneFence(env.DB),
        );
      }
      rows.push(
        env.DB
          .prepare(
            `INSERT INTO crm_membership_periods
               (id, membership_id, period_number, required_amount_minor, currency, valid_from, valid_until, status, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
          )
          .bind(periodId, mem.id, nextPeriodNumber, newPeriodRequiredMinor, scheme.currency!, validFrom, validUntil, actor.id, now),
        env.DB
          .prepare(
            `UPDATE crm_memberships
             SET state = 'active', member_identifier = ?, valid_from = ?, valid_until = ?, payment_status = ?, period_count = ?, rev = rev + 1, updated_at = ?
             WHERE id = ? AND rev = ? AND state = 'awaiting_contribution'`,
          )
          .bind(memberIdentifier, validFrom, validUntil, nextPaymentStatus, nextPeriodNumber, now, mem.id, mem.rev),
        changesOneFence(env.DB),
      );

      return {
        kind: 'commit',
        result: { membership: mapMembershipRow(updated, scheme, personTitle, now) },
        fences: [
          () => crmActorFence(env.DB, actor, tokenHash, 'crm.finance.record', '*'),
          schemeRevFence(env.DB, scheme.id, scheme.rev),
          activePeriodsFence(env.DB, mem.id, ledger.activePeriods),
          ledgerCoverageFence,
        ],
        rows,
        records: [
          {
            id: personRec.id,
            collection: 'tasks',
            patch: {
              [CRM_PROJECTION.membershipStatus]: 'active',
              [CRM_PROJECTION.membershipValidUntil]: validUntil,
              [CRM_PROJECTION.paymentStatus]: nextPaymentStatus,
            },
            ts: now,
          },
        ],
        recordExpect: new Map([[personRec.id, personRec.seq]]),
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function renewMembershipCommand(): CommandDefinition<
  ActivateOrRenewMembershipInput,
  { membership: CrmMembershipDto }
> {
  return {
    name: 'membership.renew',
    projectionKeys: [CRM_PROJECTION.membershipStatus, CRM_PROJECTION.membershipValidUntil, CRM_PROJECTION.paymentStatus],
    authorizeCoarse: (actor, via) =>
      via === 'ui' && canAccessCrmApi(actor) && evaluateCapability(actor, 'crm.finance.record', '*'),
    parseInput: (raw) => {
      const parsed = ActivateOrRenewMembershipInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    authorizeReplay: async (actor, input, _stored, { env }) => {
      if (!evaluateCapability(actor, 'crm.finance.record', '*')) return false;
      const mem = await env.DB
        .prepare(`SELECT person_id FROM crm_memberships WHERE id = ?`)
        .bind(input.membershipId)
        .first<{ person_id: string }>();
      if (!mem) return false;
      return (await loadReadableTaskRecord(env, actor.id, mem.person_id)) !== null;
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const mem = await env.DB.prepare(`SELECT * FROM crm_memberships WHERE id = ?`).bind(input.membershipId).first<MembershipRow>();
      if (!mem) return { kind: 'refuse', error: 'not_found' };
      if (input.expectedRev !== undefined && mem.rev !== input.expectedRev) {
        return { kind: 'refuse', error: 'stale' };
      }
      const [scheme, personRec] = await Promise.all([
        env.DB.prepare(`SELECT * FROM crm_membership_schemes WHERE id = ?`).bind(mem.scheme_id).first<SchemeRow>(),
        loadReadableTaskRecord(env, actor.id, mem.person_id),
      ]);
      if (!scheme || !personRec) return { kind: 'refuse', error: 'not_found' };
      const err = schemePolicyError(scheme);
      if (err) return { kind: 'refuse', error: 'invalid_input', detail: { reason: err } };

      const eff = evaluateEffectiveMembershipState({
        storedState: mem.state,
        validUntil: mem.valid_until,
        renewalNoticeDays: scheme.renewal_notice_days,
        now,
      });
      if (eff !== 'active' && eff !== 'renewal_due' && eff !== 'lapsed') {
        return { kind: 'refuse', error: 'stale', detail: { reason: 'membership_not_renewable', state: eff } };
      }

      const ledger = await loadMembershipLedgerSummary(env.DB, mem.id, scheme.currency!);
      // Preserve frozen historical period contributions instead of multiplying current scheme price across past periods!
      const historicalRequiredMinor =
        ledger.activePeriods.length > 0
          ? ledger.activePeriods.reduce((sum, p) => sum + p.required_amount_minor, 0)
          : scheme.contribution_amount_minor! * mem.period_count;
      const newPeriodRequiredMinor = scheme.contribution_amount_minor!;
      const requiredTotalMinor = historicalRequiredMinor + newPeriodRequiredMinor;
      const availableNetMinor = ledger.netPaidMinor - ledger.pendingRefundMinor;

      if (availableNetMinor < requiredTotalMinor) {
        return {
          kind: 'refuse',
          error: 'invalid_input',
          detail: {
            reason: 'renewal_contribution_receipt_required',
            requiredMinor: requiredTotalMinor,
            netPaidMinor: ledger.netPaidMinor,
            pendingRefundMinor: ledger.pendingRefundMinor,
            currency: scheme.currency,
          },
        };
      }

      const baseStart = mem.valid_until && mem.valid_until > now ? mem.valid_until : now;
      const nextValidUntil = baseStart + scheme.validity_days! * 86_400_000;
      const nextPeriodNumber =
        ledger.activePeriods.length > 0 ? ledger.activePeriods.length + 1 : mem.period_count + 1;
      const nextPaymentStatus = derivePaymentStatus({
        dueMinor: requiredTotalMinor,
        netPaidMinor: ledger.netPaidMinor,
        hasPendingRefund: ledger.pendingRefundMinor > 0,
        hasIssuedRefund: ledger.issuedRefundCount > 0,
      });

      const updated: MembershipRow = {
        ...mem,
        state: 'active',
        valid_from: mem.valid_from ?? now,
        valid_until: nextValidUntil,
        payment_status: nextPaymentStatus,
        period_count: nextPeriodNumber,
        rev: mem.rev + 1,
        updated_at: now,
      };
      const personTitle = typeof personRec.data.title === 'string' ? personRec.data.title : null;

      const ledgerCoverageFence = env.DB
        .prepare(
          `SELECT CASE WHEN (
             COALESCE((SELECT SUM(amount_minor) FROM crm_ledger_entries WHERE object_type = 'membership' AND object_id = ? AND currency = ?), 0)
             - COALESCE((SELECT SUM(amount_minor) FROM crm_refund_requests WHERE object_type = 'membership' AND object_id = ? AND currency = ? AND state IN ('requested', 'approved')), 0)
           ) >= ? THEN 1 ELSE json_extract('{', '$') END`,
        )
        .bind(mem.id, scheme.currency!, mem.id, scheme.currency!, requiredTotalMinor);

      const periodId = `mp_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

      return {
        kind: 'commit',
        result: { membership: mapMembershipRow(updated, scheme, personTitle, now) },
        fences: [
          () => crmActorFence(env.DB, actor, tokenHash, 'crm.finance.record', '*'),
          schemeRevFence(env.DB, scheme.id, scheme.rev),
          activePeriodsFence(env.DB, mem.id, ledger.activePeriods),
          ledgerCoverageFence,
        ],
        rows: [
          env.DB
            .prepare(
              `INSERT INTO crm_membership_periods
                 (id, membership_id, period_number, required_amount_minor, currency, valid_from, valid_until, status, created_by, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
            )
            .bind(periodId, mem.id, nextPeriodNumber, newPeriodRequiredMinor, scheme.currency!, baseStart, nextValidUntil, actor.id, now),
          env.DB
            .prepare(
              `UPDATE crm_memberships
               SET state = 'active', valid_until = ?, payment_status = ?, period_count = ?, rev = rev + 1, updated_at = ?
               WHERE id = ? AND rev = ?`,
            )
            .bind(nextValidUntil, nextPaymentStatus, nextPeriodNumber, now, mem.id, mem.rev),
          changesOneFence(env.DB),
        ],
        records: [
          {
            id: personRec.id,
            collection: 'tasks',
            patch: {
              [CRM_PROJECTION.membershipStatus]: 'active',
              [CRM_PROJECTION.membershipValidUntil]: nextValidUntil,
              [CRM_PROJECTION.paymentStatus]: nextPaymentStatus,
            },
            ts: now,
          },
        ],
        recordExpect: new Map([[personRec.id, personRec.seq]]),
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function cancelMembershipCommand(): CommandDefinition<CancelMembershipInput, { membership: CrmMembershipDto }> {
  return {
    name: 'membership.cancel',
    projectionKeys: [CRM_PROJECTION.membershipStatus],
    authorizeCoarse: (actor, via) => via === 'ui' && canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = CancelMembershipInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    authorizeReplay: async (actor, input, _stored, { env }) => {
      const mem = await env.DB
        .prepare(`SELECT person_id FROM crm_memberships WHERE id = ?`)
        .bind(input.membershipId)
        .first<{ person_id: string }>();
      if (!mem) return false;
      return (await loadReadableTaskRecord(env, actor.id, mem.person_id)) !== null;
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const mem = await env.DB.prepare(`SELECT * FROM crm_memberships WHERE id = ?`).bind(input.membershipId).first<MembershipRow>();
      if (!mem) return { kind: 'refuse', error: 'not_found' };
      if (input.expectedRev !== undefined && mem.rev !== input.expectedRev) {
        return { kind: 'refuse', error: 'stale' };
      }
      if (mem.state === 'cancelled') {
        return { kind: 'refuse', error: 'stale', detail: { reason: 'already_cancelled' } };
      }
      const [scheme, personRec] = await Promise.all([
        env.DB.prepare(`SELECT * FROM crm_membership_schemes WHERE id = ?`).bind(mem.scheme_id).first<SchemeRow>(),
        loadReadableTaskRecord(env, actor.id, mem.person_id),
      ]);
      if (!scheme || !personRec) return { kind: 'refuse', error: 'not_found' };

      const updated: MembershipRow = {
        ...mem,
        state: 'cancelled',
        decision_reason: input.reason,
        rev: mem.rev + 1,
        updated_at: now,
      };
      const personTitle = typeof personRec.data.title === 'string' ? personRec.data.title : null;

      return {
        kind: 'commit',
        result: { membership: mapMembershipRow(updated, scheme, personTitle, now) },
        fences: [() => crmActorFence(env.DB, actor, tokenHash)],
        rows: [
          env.DB
            .prepare(
              `UPDATE crm_memberships
               SET state = 'cancelled', decision_reason = ?, rev = rev + 1, updated_at = ?
               WHERE id = ? AND rev = ?`,
            )
            .bind(input.reason, now, mem.id, mem.rev),
          changesOneFence(env.DB),
        ],
        records: [
          {
            id: personRec.id,
            collection: 'tasks',
            patch: { [CRM_PROJECTION.membershipStatus]: 'cancelled' },
            ts: now,
          },
        ],
        recordExpect: new Map([[personRec.id, personRec.seq]]),
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

export function createS8MembershipCommandDefs(): AnyCommandDefinition[] {
  return [
    upsertMembershipSchemeCommand(),
    applyMembershipCommand(),
    decideMembershipCommand(),
    issueMembershipContributionRequestCommand(),
    activateMembershipCommand(),
    renewMembershipCommand(),
    cancelMembershipCommand(),
  ];
}

/* ---------- S8 Read API ---------- */

export async function readMembershipsOverview(
  env: Env,
  actorId: string,
  tokenHash: string,
): Promise<
  | { status: 200; body: MembershipsOverviewResponse }
  | { status: 401 | 403 | 404; body: { error: string } }
> {
  if (!isCrmEnabled(env)) return { status: 404, body: { error: 'not_found' } };
  const now = Date.now();
  const [sessionRes, grantsRes, schemesRes, memRes] = await env.DB.batch([
    sessionAuthStmt(env.DB, actorId, tokenHash, now),
    actorGrantsStmt(env.DB, actorId),
    env.DB.prepare(`SELECT * FROM crm_membership_schemes ORDER BY created_at ASC LIMIT 50`),
    env.DB.prepare(`SELECT * FROM crm_memberships ORDER BY updated_at DESC LIMIT 200`),
  ]);
  const batchAuth = evaluateCrmReadAuthRows(
    sessionRes.results[0] as CrmSessionRow | undefined,
    grantsRes.results as unknown as CrmGrantRow[],
  );
  if (!batchAuth.ok) return { status: batchAuth.status, body: batchAuth.body };

  const schemes = schemesRes.results as unknown as SchemeRow[];
  const memRows = memRes.results as unknown as MembershipRow[];
  const schemeById = new Map(schemes.map((s) => [s.id, s]));

  const gate = createReadGate(env.DB, actorId);
  const readablePeople = await loadReadableTaskRecords(
    env,
    gate,
    [...new Set(memRows.map((m) => m.person_id))],
  );

  const finalAuth = await finalizeCrmReadAuth(env, actorId, tokenHash, { gate });
  if (!finalAuth.ok) return { status: finalAuth.status, body: finalAuth.body };

  const visibleMemberships = memRows.filter((m) => readablePeople.has(m.person_id));
  const mapped = visibleMemberships.map((m) => {
    const scheme = schemeById.get(m.scheme_id) ?? { name: 'Membership', renewal_notice_days: null };
    const rec = readablePeople.get(m.person_id);
    const name = typeof rec?.data.title === 'string' ? rec.data.title : null;
    return mapMembershipRow(m, scheme, name, now);
  });

  const renewalsDueCount = mapped.filter((m) => m.effectiveState === 'renewal_due').length;
  const lapsedCount = mapped.filter((m) => m.effectiveState === 'lapsed').length;

  return {
    status: 200,
    body: MembershipsOverviewResponseSchema.parse({
      schemes: schemes.map(mapSchemeRow),
      memberships: mapped,
      renewalsDueCount,
      lapsedCount,
      canConfigure: evaluateCapability(finalAuth.actor, 'crm.configure', 'programme:common-roots'),
      canRecordFinance: evaluateCapability(finalAuth.actor, 'crm.finance.record', '*'),
      partial: visibleMemberships.length < memRows.length || memRows.length >= 200,
    }),
  };
}
