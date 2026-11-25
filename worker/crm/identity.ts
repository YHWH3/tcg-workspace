import { z } from 'zod';
import {
  AddEndpointInputSchema,
  BackfillEndpointsInputSchema,
  DUPLICATES_PAGE_LIMIT,
  DismissDuplicateInputSchema,
  MAX_BACKFILL_BATCH,
  PersonDetailResponseSchema,
  RecordConsentInputSchema,
  RetireEndpointInputSchema,
  SetPrimaryEndpointInputSchema,
  canonicalPersonPair,
  computeNameCollisionPairs,
  normalizeEmail,
  normalizeEndpoint,
  normalizePhone,
  type AddEndpointInput,
  type BackfillEndpointsInput,
  type CrmConsentDto,
  type CrmEndpointDto,
  type CrmEndpointKind,
  type DismissDuplicateInput,
  type DuplicateCandidateDto,
  type DuplicatesPageResponse,
  type PersonDetailResponse,
  type RecordConsentInput,
  type RetireEndpointInput,
  type SetPrimaryEndpointInput,
} from '../../shared/crm/identity';
import { propKey, fieldsOf } from '../../shared/fields';
import type { Env } from '../auth';
import { createReadGate } from '../readAccess';
import { pokeLive } from '../sync';
import type { AnyCommandDefinition, CommandDefinition } from './commands';
import {
  crmActorFence,
  decodeTimeIdCursor,
  encodeTimeIdCursor,
  loadCrmReadContext,
  loadReadableTaskRecord,
} from './read';
import { canAccessCrmApi, evaluateCapability } from './rules';

interface EndpointRow {
  id: string;
  person_id: string;
  kind: CrmEndpointKind;
  value_raw: string;
  value_norm: string;
  is_primary: number;
  verified_at: number | null;
  retired_at: number | null;
  source: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface ConsentRow {
  id: string;
  person_id: string;
  channel: CrmConsentDto['channel'];
  scope: CrmConsentDto['scope'];
  status: CrmConsentDto['status'];
  source: string;
  evidence_ref: string | null;
  recorded_by: string;
  recorded_at: number;
}

interface DuplicateRow {
  id: string;
  person_a_id: string;
  person_b_id: string;
  reason: string;
  confidence: 'high' | 'medium';
  state: 'open' | 'dismissed' | 'merged';
  decided_by: string | null;
  decided_at: number | null;
  note: string | null;
  created_at: number;
  a_data?: string | null;
  b_data?: string | null;
}

function mapEndpoint(r: EndpointRow): CrmEndpointDto {
  return {
    id: r.id,
    personId: r.person_id,
    kind: r.kind,
    valueRaw: r.value_raw,
    valueNorm: r.value_norm,
    isPrimary: r.is_primary === 1,
    verifiedAt: r.verified_at,
    retiredAt: r.retired_at,
    source: r.source,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

function mapConsent(r: ConsentRow): CrmConsentDto {
  return {
    id: r.id,
    personId: r.person_id,
    channel: r.channel,
    scope: r.scope,
    status: r.status,
    source: r.source,
    evidenceRef: r.evidence_ref,
    recordedBy: r.recorded_by,
    recordedAt: r.recorded_at,
  };
}

function parseZodErrors(err: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const k = issue.path.length > 0 ? String(issue.path[0]) : '_root';
    if (!(k in fields)) fields[k] = issue.message;
  }
  return fields;
}

function extractTitle(rawJson: string | null | undefined): string | null {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson) as { title?: unknown; deleted?: unknown };
    if (parsed.deleted === true) return null;
    return typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title : 'Untitled';
  } catch {
    return null;
  }
}

export function computeConsentSummary(latest: readonly CrmConsentDto[]): string {
  if (latest.length === 0) return 'None recorded';
  const parts = [...latest]
    .sort((a, b) => `${a.channel}:${a.scope}`.localeCompare(`${b.channel}:${b.scope}`))
    .slice(0, 4)
    .map((c) => `${c.channel}:${c.status}`);
  return parts.join(', ');
}

function buildEndpointProjectionPatch(
  activeEndpoints: readonly Pick<EndpointRow, 'kind' | 'value_norm' | 'is_primary'>[],
  boardData?: Record<string, unknown> | null,
): Record<string, unknown> {
  const emails = activeEndpoints.filter((e) => e.kind === 'email');
  const phones = activeEndpoints.filter((e) => e.kind === 'phone');
  const primaryEmail = (emails.find((e) => e.is_primary === 1) ?? emails[0])?.value_norm ?? null;
  const primaryPhone = (phones.find((e) => e.is_primary === 1) ?? phones[0])?.value_norm ?? null;
  const patch: Record<string, unknown> = {
    _crm_primary_email: primaryEmail,
    _crm_primary_phone: primaryPhone,
    _crm_endpoint_count: activeEndpoints.length,
  };
  if (boardData) {
    const fields = fieldsOf(boardData);
    const emailField = fields.find((f) => /^e-?mail$/i.test(f.name.trim()));
    if (emailField && primaryEmail !== null) patch[propKey(emailField.id)] = primaryEmail;
    const phoneField = fields.find((f) => /^phone$/i.test(f.name.trim()));
    if (phoneField && primaryPhone !== null) patch[propKey(phoneField.id)] = primaryPhone;
  }
  return patch;
}

async function loadBoardData(db: D1Database, boardId: unknown): Promise<Record<string, unknown> | null> {
  if (typeof boardId !== 'string' || !boardId) return null;
  const row = await db
    .prepare(`SELECT data FROM records WHERE id = ? AND collection = 'boards'`)
    .bind(boardId)
    .first<{ data: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function latestConsentsFromHistory(rows: readonly ConsentRow[]): CrmConsentDto[] {
  const seen = new Set<string>();
  const latest: CrmConsentDto[] = [];
  for (const r of rows) {
    const k = `${r.channel}\0${r.scope}`;
    if (seen.has(k)) continue;
    seen.add(k);
    latest.push(mapConsent(r));
  }
  return latest;
}

function addEndpointCommand(): CommandDefinition<
  AddEndpointInput & { normalized: string },
  { endpoint: CrmEndpointDto; already: boolean }
> {
  return {
    name: 'person.add_endpoint',
    projectionKeys: ['_crm_primary_email', '_crm_primary_phone', '_crm_endpoint_count'],
    authorizeCoarse: (actor) => canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = AddEndpointInputSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: 'invalid_input', detail: { fields: parseZodErrors(parsed.error) } };
      }
      const norm = normalizeEndpoint(parsed.data.kind, parsed.data.value);
      if (!norm) {
        return {
          ok: false,
          error: 'invalid_input',
          detail: { reason: 'invalid_endpoint_format', fields: { value: `Invalid ${parsed.data.kind} format` } },
        };
      }
      return { ok: true, input: { ...parsed.data, normalized: norm } };
    },
    plan: async ({ env, actor, tokenHash, input, expected, now }) => {
      const person = await loadReadableTaskRecord(env, actor.id, input.personId);
      if (!person) return { kind: 'refuse', error: 'not_found' };

      const [existingRes, conflictRes, boardData] = await Promise.all([
        env.DB
          .prepare(
            `SELECT * FROM crm_endpoints WHERE person_id = ? AND retired_at IS NULL ORDER BY is_primary DESC, created_at ASC`,
          )
          .bind(person.id)
          .all<EndpointRow>(),
        env.DB
          .prepare(
            `SELECT * FROM crm_endpoints WHERE kind = ? AND value_norm = ? AND retired_at IS NULL LIMIT 1`,
          )
          .bind(input.kind, input.normalized)
          .first<EndpointRow>(),
        loadBoardData(env.DB, person.data.boardId),
      ]);

      const active = existingRes.results;
      const expectMap = new Map<string, number>([[person.id, expected?.get(person.id) ?? person.seq]]);

      if (conflictRes && conflictRes.person_id !== person.id) {
        return {
          kind: 'refuse',
          error: 'invalid_input',
          detail: {
            reason: 'endpoint_in_use',
            conflictingPersonId: conflictRes.person_id,
            fields: { value: `This ${input.kind} already belongs to another person.` },
          },
        };
      }

      if (conflictRes && conflictRes.person_id === person.id) {
        const alreadyPrimary = conflictRes.is_primary === 1;
        if (!input.makePrimary || alreadyPrimary) {
          return {
            kind: 'commit',
            result: { endpoint: mapEndpoint(conflictRes), already: true },
            fences: [() => crmActorFence(env.DB, actor, tokenHash)],
            recordExpect: expectMap,
            forceRecordsCommit: true,
          };
        }
        const updatedActive = active.map((e) =>
          e.kind !== conflictRes.kind ? e : { ...e, is_primary: e.id === conflictRes.id ? 1 : 0 },
        );
        const patch = buildEndpointProjectionPatch(updatedActive, boardData);
        const promoted: EndpointRow = { ...conflictRes, is_primary: 1, updated_at: now };
        return {
          kind: 'commit',
          result: { endpoint: mapEndpoint(promoted), already: false },
          fences: [() => crmActorFence(env.DB, actor, tokenHash)],
          rows: [
            env.DB
              .prepare(`UPDATE crm_endpoints SET is_primary = 0, updated_at = ? WHERE person_id = ? AND kind = ? AND retired_at IS NULL AND id != ?`)
              .bind(now, person.id, conflictRes.kind, conflictRes.id),
            env.DB
              .prepare(`UPDATE crm_endpoints SET is_primary = 1, updated_at = ? WHERE id = ?`)
              .bind(now, conflictRes.id),
          ],
          records: [{ id: person.id, collection: 'tasks', patch, ts: now }],
          recordExpect: expectMap,
        };
      }

      const sameKindActive = active.filter((e) => e.kind === input.kind);
      const isPrimary = sameKindActive.length === 0 || input.makePrimary === true;
      const endpointId = `ep_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const newRow: EndpointRow = {
        id: endpointId,
        person_id: person.id,
        kind: input.kind,
        value_raw: input.value.trim(),
        value_norm: input.normalized,
        is_primary: isPrimary ? 1 : 0,
        verified_at: input.verified ? now : null,
        retired_at: null,
        source: input.source?.trim() || 'manual',
        created_by: actor.id,
        created_at: now,
        updated_at: now,
      };
      const nextActive = [
        ...active.map((e) => (isPrimary && e.kind === input.kind ? { ...e, is_primary: 0 } : e)),
        newRow,
      ];
      const patch = buildEndpointProjectionPatch(nextActive, boardData);

      const rows: D1PreparedStatement[] = [];
      if (isPrimary && sameKindActive.length > 0) {
        rows.push(
          env.DB
            .prepare(`UPDATE crm_endpoints SET is_primary = 0, updated_at = ? WHERE person_id = ? AND kind = ? AND retired_at IS NULL`)
            .bind(now, person.id, input.kind),
        );
      }
      rows.push(
        env.DB
          .prepare(
            `INSERT INTO crm_endpoints (id, person_id, kind, value_raw, value_norm, is_primary, verified_at, retired_at, source, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
          )
          .bind(
            newRow.id,
            newRow.person_id,
            newRow.kind,
            newRow.value_raw,
            newRow.value_norm,
            newRow.is_primary,
            newRow.verified_at,
            newRow.source,
            newRow.created_by,
            newRow.created_at,
            newRow.updated_at,
          ),
      );

      return {
        kind: 'commit',
        result: { endpoint: mapEndpoint(newRow), already: false },
        fences: [() => crmActorFence(env.DB, actor, tokenHash)],
        rows,
        records: [{ id: person.id, collection: 'tasks', patch, ts: now }],
        recordExpect: expectMap,
      };
    },
    mapConstraintError: () => ({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'endpoint_in_use' },
      retryable: false,
    }),
    afterCommit: ({ env, executionCtx }) => {
      pokeLive(env, executionCtx);
    },
  };
}

function retireEndpointCommand(): CommandDefinition<RetireEndpointInput, { endpointId: string; retired: boolean }> {
  return {
    name: 'person.retire_endpoint',
    projectionKeys: ['_crm_primary_email', '_crm_primary_phone', '_crm_endpoint_count'],
    authorizeCoarse: (actor) => canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = RetireEndpointInputSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: 'invalid_input', detail: { fields: parseZodErrors(parsed.error) } };
      }
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, expected, now }) => {
      const targetEp = await env.DB
        .prepare(`SELECT * FROM crm_endpoints WHERE id = ?`)
        .bind(input.endpointId)
        .first<EndpointRow>();
      if (!targetEp) return { kind: 'refuse', error: 'not_found' };

      const person = await loadReadableTaskRecord(env, actor.id, targetEp.person_id);
      if (!person) return { kind: 'refuse', error: 'not_found' };

      const expectMap = new Map<string, number>([[person.id, expected?.get(person.id) ?? person.seq]]);
      if (targetEp.retired_at !== null) {
        return {
          kind: 'commit',
          result: { endpointId: targetEp.id, retired: true },
          fences: [() => crmActorFence(env.DB, actor, tokenHash)],
          recordExpect: expectMap,
          forceRecordsCommit: true,
        };
      }

      const [activeRes, boardData] = await Promise.all([
        env.DB
          .prepare(`SELECT * FROM crm_endpoints WHERE person_id = ? AND retired_at IS NULL ORDER BY is_primary DESC, created_at ASC`)
          .bind(person.id)
          .all<EndpointRow>(),
        loadBoardData(env.DB, person.data.boardId),
      ]);

      const remaining = activeRes.results.filter((e) => e.id !== targetEp.id);
      const sameKindRemaining = remaining.filter((e) => e.kind === targetEp.kind);
      const promoteId = targetEp.is_primary === 1 && sameKindRemaining.length > 0 ? sameKindRemaining[0]!.id : null;
      const nextActive = remaining.map((e) => (e.id === promoteId ? { ...e, is_primary: 1 } : e));
      const patch = buildEndpointProjectionPatch(nextActive, boardData);

      const rows: D1PreparedStatement[] = [
        env.DB
          .prepare(`UPDATE crm_endpoints SET is_primary = 0, retired_at = ?, updated_at = ? WHERE id = ? AND retired_at IS NULL`)
          .bind(now, now, targetEp.id),
      ];
      if (promoteId) {
        rows.push(
          env.DB
            .prepare(`UPDATE crm_endpoints SET is_primary = 1, updated_at = ? WHERE id = ? AND retired_at IS NULL`)
            .bind(now, promoteId),
        );
      }

      return {
        kind: 'commit',
        result: { endpointId: targetEp.id, retired: true },
        fences: [() => crmActorFence(env.DB, actor, tokenHash)],
        rows,
        records: [{ id: person.id, collection: 'tasks', patch, ts: now }],
        recordExpect: expectMap,
      };
    },
    afterCommit: ({ env, executionCtx }) => {
      pokeLive(env, executionCtx);
    },
  };
}

function setPrimaryEndpointCommand(): CommandDefinition<SetPrimaryEndpointInput, { endpointId: string; personId: string }> {
  return {
    name: 'person.set_primary_endpoint',
    projectionKeys: ['_crm_primary_email', '_crm_primary_phone'],
    authorizeCoarse: (actor) => canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = SetPrimaryEndpointInputSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: 'invalid_input', detail: { fields: parseZodErrors(parsed.error) } };
      }
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, expected, now }) => {
      const ep = await env.DB
        .prepare(`SELECT * FROM crm_endpoints WHERE id = ? AND retired_at IS NULL`)
        .bind(input.endpointId)
        .first<EndpointRow>();
      if (!ep) return { kind: 'refuse', error: 'not_found' };

      const person = await loadReadableTaskRecord(env, actor.id, ep.person_id);
      if (!person) return { kind: 'refuse', error: 'not_found' };

      const expectMap = new Map<string, number>([[person.id, expected?.get(person.id) ?? person.seq]]);
      if (ep.is_primary === 1) {
        return {
          kind: 'commit',
          result: { endpointId: ep.id, personId: person.id },
          fences: [() => crmActorFence(env.DB, actor, tokenHash)],
          recordExpect: expectMap,
          forceRecordsCommit: true,
        };
      }

      const [activeRes, boardData] = await Promise.all([
        env.DB
          .prepare(`SELECT * FROM crm_endpoints WHERE person_id = ? AND retired_at IS NULL`)
          .bind(person.id)
          .all<EndpointRow>(),
        loadBoardData(env.DB, person.data.boardId),
      ]);

      const updatedActive = activeRes.results.map((e) =>
        e.kind !== ep.kind ? e : { ...e, is_primary: e.id === ep.id ? 1 : 0 },
      );
      const fullPatch = buildEndpointProjectionPatch(updatedActive, boardData);
      const patch: Record<string, unknown> = {
        _crm_primary_email: fullPatch._crm_primary_email,
        _crm_primary_phone: fullPatch._crm_primary_phone,
      };
      for (const [k, v] of Object.entries(fullPatch)) {
        if (k.startsWith('p_')) patch[k] = v;
      }

      return {
        kind: 'commit',
        result: { endpointId: ep.id, personId: person.id },
        fences: [() => crmActorFence(env.DB, actor, tokenHash)],
        rows: [
          env.DB
            .prepare(`UPDATE crm_endpoints SET is_primary = 0, updated_at = ? WHERE person_id = ? AND kind = ? AND retired_at IS NULL AND id != ?`)
            .bind(now, person.id, ep.kind, ep.id),
          env.DB
            .prepare(`UPDATE crm_endpoints SET is_primary = 1, updated_at = ? WHERE id = ?`)
            .bind(now, ep.id),
        ],
        records: [{ id: person.id, collection: 'tasks', patch, ts: now }],
        recordExpect: expectMap,
      };
    },
    afterCommit: ({ env, executionCtx }) => {
      pokeLive(env, executionCtx);
    },
  };
}

function recordConsentCommand(): CommandDefinition<RecordConsentInput, { consent: CrmConsentDto }> {
  return {
    name: 'person.record_consent',
    projectionKeys: ['_crm_consent_summary'],
    authorizeCoarse: (actor) => canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = RecordConsentInputSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: 'invalid_input', detail: { fields: parseZodErrors(parsed.error) } };
      }
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, expected, now }) => {
      const person = await loadReadableTaskRecord(env, actor.id, input.personId);
      if (!person) return { kind: 'refuse', error: 'not_found' };

      const historyRes = await env.DB
        .prepare(`SELECT * FROM crm_consents WHERE person_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 100`)
        .bind(person.id)
        .all<ConsentRow>();

      const newRow: ConsentRow = {
        id: `con_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
        person_id: person.id,
        channel: input.channel,
        scope: input.scope,
        status: input.status,
        source: input.source.trim(),
        evidence_ref: input.evidenceRef?.trim() || null,
        recorded_by: actor.id,
        recorded_at: now,
      };
      const latest = latestConsentsFromHistory([newRow, ...historyRes.results]);
      const summary = computeConsentSummary(latest);
      const expectMap = new Map<string, number>([[person.id, expected?.get(person.id) ?? person.seq]]);

      return {
        kind: 'commit',
        result: { consent: mapConsent(newRow) },
        fences: [() => crmActorFence(env.DB, actor, tokenHash)],
        rows: [
          env.DB
            .prepare(
              `INSERT INTO crm_consents (id, person_id, channel, scope, status, source, evidence_ref, recorded_by, recorded_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              newRow.id,
              newRow.person_id,
              newRow.channel,
              newRow.scope,
              newRow.status,
              newRow.source,
              newRow.evidence_ref,
              newRow.recorded_by,
              newRow.recorded_at,
            ),
        ],
        records: [{ id: person.id, collection: 'tasks', patch: { _crm_consent_summary: summary }, ts: now }],
        recordExpect: expectMap,
      };
    },
    afterCommit: ({ env, executionCtx }) => {
      pokeLive(env, executionCtx);
    },
  };
}

function dismissDuplicateCommand(): CommandDefinition<DismissDuplicateInput, { candidateId: string; state: 'dismissed' }> {
  return {
    name: 'duplicates.dismiss',
    authorizeCoarse: (actor) => canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = DismissDuplicateInputSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: 'invalid_input', detail: { fields: parseZodErrors(parsed.error) } };
      }
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const row = await env.DB
        .prepare(`SELECT * FROM crm_duplicate_candidates WHERE id = ?`)
        .bind(input.candidateId)
        .first<DuplicateRow>();
      if (!row) return { kind: 'refuse', error: 'not_found' };
      const kept = await createReadGate(env.DB, actor.id).filter([
        { id: row.person_a_id },
        { id: row.person_b_id },
      ]);
      if (kept.length === 0) return { kind: 'refuse', error: 'not_found' };

      if (row.state === 'dismissed') {
        return {
          kind: 'commit',
          result: { candidateId: row.id, state: 'dismissed' },
          fences: [() => crmActorFence(env.DB, actor, tokenHash)],
          rows: [],
        };
      }

      return {
        kind: 'commit',
        result: { candidateId: row.id, state: 'dismissed' },
        fences: [() => crmActorFence(env.DB, actor, tokenHash)],
        rows: [
          env.DB
            .prepare(
              `UPDATE crm_duplicate_candidates
               SET state = 'dismissed', decided_by = ?, decided_at = ?, note = ?
               WHERE id = ? AND state = 'open'`,
            )
            .bind(actor.id, now, input.note?.trim() || null, row.id),
        ],
      };
    },
    afterCommit: ({ env, executionCtx }) => {
      pokeLive(env, executionCtx);
    },
  };
}

interface BackfillOutput {
  dryRun: boolean;
  scanned: number;
  wouldCreate: number;
  created: number;
  alreadyPresent: number;
  skippedInvalid: number;
  conflicts: { personId: string; kind: 'email' | 'phone'; valueNorm: string; existingPersonId: string }[];
  candidatesCreated: number;
  next: string | null;
}

function backfillEndpointsCommand(): CommandDefinition<BackfillEndpointsInput, BackfillOutput> {
  return {
    name: 'endpoints.backfill',
    projectionKeys: ['_crm_primary_email', '_crm_primary_phone', '_crm_endpoint_count'],
    authorizeCoarse: (actor) => evaluateCapability(actor, 'crm.configure', '*'),
    parseInput: (raw) => {
      const parsed = BackfillEndpointsInputSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: 'invalid_input', detail: { fields: parseZodErrors(parsed.error) } };
      }
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const limit = Math.min(input.limit ?? 25, MAX_BACKFILL_BATCH);
      const dryRun = input.dryRun ?? true;

      // Identify People boards + candidate people records (bounded page).
      const peopleBoardsRes = await env.DB
        .prepare(
          `SELECT id, data FROM records
           WHERE collection = 'boards'
             AND COALESCE(json_extract(data, '$.deleted'), 0) != 1
             AND (json_extract(data, '$.templateDbKey') = 'people' OR id = 'board-website-people' OR lower(COALESCE(json_extract(data, '$.name'), '')) = 'people')
           LIMIT 20`,
        )
        .all<{ id: string; data: string }>();

      const boardMap = new Map<string, { emailKey?: string; phoneKey?: string }>();
      const boardIds: string[] = [];
      for (const b of peopleBoardsRes.results) {
        try {
          const parsed = JSON.parse(b.data) as Record<string, unknown>;
          const fields = fieldsOf(parsed);
          const ef = fields.find((f) => /^e-?mail$/i.test(f.name.trim()));
          const pf = fields.find((f) => /^phone$/i.test(f.name.trim()));
          boardIds.push(b.id);
          boardMap.set(b.id, { emailKey: ef ? propKey(ef.id) : undefined, phoneKey: pf ? propKey(pf.id) : undefined });
        } catch {
          /* ignore */
        }
      }

      if (boardIds.length === 0) {
        return {
          kind: 'commit',
          result: {
            dryRun,
            scanned: 0,
            wouldCreate: 0,
            created: 0,
            alreadyPresent: 0,
            skippedInvalid: 0,
            conflicts: [],
            candidatesCreated: 0,
            next: null,
          },
          fences: [() => crmActorFence(env.DB, actor, tokenHash, 'crm.configure', '*')],
        };
      }

      const rawPeopleRes = input.personIds?.length
        ? await env.DB
            .prepare(
              `SELECT id, data, seq FROM records
               WHERE collection = 'tasks'
                 AND id IN (SELECT value FROM json_each(?))
                 AND json_extract(data, '$.boardId') IN (SELECT value FROM json_each(?))
                 AND COALESCE(json_extract(data, '$.deleted'), 0) != 1
               ORDER BY id`,
            )
            .bind(JSON.stringify(input.personIds), JSON.stringify(boardIds))
            .all<{ id: string; data: string; seq: number }>()
        : await env.DB
            .prepare(
              `SELECT id, data, seq FROM records
               WHERE collection = 'tasks'
                 AND json_extract(data, '$.boardId') IN (SELECT value FROM json_each(?))
                 AND COALESCE(json_extract(data, '$.deleted'), 0) != 1
                 AND id > ?
               ORDER BY id
               LIMIT ?`,
            )
            .bind(JSON.stringify(boardIds), input.after ?? '', limit + 1)
            .all<{ id: string; data: string; seq: number }>();

      const hasMore = !input.personIds?.length && rawPeopleRes.results.length > limit;
      const pageRows = hasMore ? rawPeopleRes.results.slice(0, limit) : rawPeopleRes.results;
      const gate = createReadGate(env.DB, actor.id);
      const readableIds = new Set(
        (await gate.filter(pageRows.map((r) => ({ id: r.id, rev: r.seq })))).map((r) => r.id),
      );
      const peopleRows = pageRows.filter((r) => readableIds.has(r.id));

      // Extract normalized email/phone values from People records
      const wantedValues: { kind: 'email' | 'phone'; norm: string }[] = [];
      const extracted = peopleRows.map((row) => {
        const data = JSON.parse(row.data) as Record<string, unknown>;
        const cfg = boardMap.get(String(data.boardId ?? ''));
        const rawEmail = cfg?.emailKey && typeof data[cfg.emailKey] === 'string' ? (data[cfg.emailKey] as string) : '';
        const rawPhone = cfg?.phoneKey && typeof data[cfg.phoneKey] === 'string' ? (data[cfg.phoneKey] as string) : '';
        const normEmail = rawEmail.trim() ? normalizeEmail(rawEmail) : null;
        const normPhone = rawPhone.trim() ? normalizePhone(rawPhone) : null;
        if (normEmail) wantedValues.push({ kind: 'email', norm: normEmail });
        if (normPhone) wantedValues.push({ kind: 'phone', norm: normPhone });
        return {
          id: row.id,
          seq: row.seq,
          title: typeof data.title === 'string' ? data.title : null,
          rawEmail: rawEmail.trim(),
          rawPhone: rawPhone.trim(),
          normEmail,
          normPhone,
        };
      });

      const normKeys = [...new Set(wantedValues.map((v) => v.norm))];
      const personIdList = extracted.map((p) => p.id);
      const [existingEpRes, existingByNormRes] = await Promise.all([
        env.DB
          .prepare(`SELECT * FROM crm_endpoints WHERE retired_at IS NULL AND person_id IN (SELECT value FROM json_each(?))`)
          .bind(JSON.stringify(personIdList))
          .all<EndpointRow>(),
        normKeys.length > 0
          ? env.DB
              .prepare(`SELECT * FROM crm_endpoints WHERE retired_at IS NULL AND value_norm IN (SELECT value FROM json_each(?))`)
              .bind(JSON.stringify(normKeys))
              .all<EndpointRow>()
          : Promise.resolve({ results: [] as EndpointRow[] }),
      ]);

      const epsByPerson = new Map<string, EndpointRow[]>();
      for (const ep of existingEpRes.results) {
        const list = epsByPerson.get(ep.person_id) ?? [];
        list.push(ep);
        epsByPerson.set(ep.person_id, list);
      }

      const activeOwner = new Map<string, string>();
      for (const ep of [...existingEpRes.results, ...existingByNormRes.results]) {
        activeOwner.set(`${ep.kind}\0${ep.value_norm}`, ep.person_id);
      }

      let wouldCreate = 0;
      let alreadyPresent = 0;
      let skippedInvalid = 0;
      const conflicts: BackfillOutput['conflicts'] = [];
      const rows: D1PreparedStatement[] = [];
      const records: { id: string; collection: 'tasks'; patch: Record<string, unknown>; ts: number }[] = [];
      const expectMap = new Map<string, number>();

      for (const p of extracted) {
        const currentEps = [...(epsByPerson.get(p.id) ?? [])];
        let personChanged = false;

        const processKind = (kind: 'email' | 'phone', rawVal: string, normVal: string | null) => {
          if (!rawVal) return;
          if (!normVal) {
            skippedInvalid += 1;
            return;
          }
          const key = `${kind}\0${normVal}`;
          const existingPid = activeOwner.get(key);
          if (existingPid === p.id) {
            alreadyPresent += 1;
            return;
          }
          if (existingPid && existingPid !== p.id) {
            conflicts.push({ personId: p.id, kind, valueNorm: normVal, existingPersonId: existingPid });
            return;
          }
          wouldCreate += 1;
          activeOwner.set(key, p.id);
          const hasPrimary = currentEps.some((e) => e.kind === kind && e.is_primary === 1);
          const epRow: EndpointRow = {
            id: `ep_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
            person_id: p.id,
            kind,
            value_raw: rawVal,
            value_norm: normVal,
            is_primary: hasPrimary ? 0 : 1,
            verified_at: null,
            retired_at: null,
            source: 'backfill',
            created_by: actor.id,
            created_at: now,
            updated_at: now,
          };
          currentEps.push(epRow);
          personChanged = true;
          if (!dryRun) {
            rows.push(
              env.DB
                .prepare(
                  `INSERT INTO crm_endpoints (id, person_id, kind, value_raw, value_norm, is_primary, verified_at, retired_at, source, created_by, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'backfill', ?, ?, ?)`,
                )
                .bind(
                  epRow.id,
                  epRow.person_id,
                  epRow.kind,
                  epRow.value_raw,
                  epRow.value_norm,
                  epRow.is_primary,
                  actor.id,
                  now,
                  now,
                ),
            );
          }
        };

        processKind('email', p.rawEmail, p.normEmail);
        processKind('phone', p.rawPhone, p.normPhone);

        if (!dryRun && personChanged) {
          expectMap.set(p.id, p.seq);
          records.push({
            id: p.id,
            collection: 'tasks',
            patch: buildEndpointProjectionPatch(currentEps, null),
            ts: now,
          });
        }
      }

      // Compute duplicate signals across the scanned batch + endpoint conflicts
      const dupSignals = new Map<string, { a: string; b: string; reason: string; confidence: 'high' | 'medium' }>();
      for (const c of conflicts) {
        const [a, b] = canonicalPersonPair(c.personId, c.existingPersonId);
        dupSignals.set(`${a}\0${b}`, {
          a,
          b,
          reason: `Matching ${c.kind}: ${c.valueNorm}`,
          confidence: 'high',
        });
      }
      for (const sig of computeNameCollisionPairs(
        extracted.map((x) => ({ id: x.id, title: x.title, email: x.normEmail, phone: x.normPhone })),
      )) {
        const k = `${sig.personAId}\0${sig.personBId}`;
        if (!dupSignals.has(k)) {
          dupSignals.set(k, {
            a: sig.personAId,
            b: sig.personBId,
            reason: sig.reason,
            confidence: sig.confidence,
          });
        }
      }

      let candidatesCreated = 0;
      if (!dryRun && dupSignals.size > 0) {
        for (const sig of dupSignals.values()) {
          candidatesCreated += 1;
          rows.push(
            env.DB
              .prepare(
                `INSERT OR IGNORE INTO crm_duplicate_candidates (id, person_a_id, person_b_id, reason, confidence, state, created_at)
                 VALUES (?, ?, ?, ?, ?, 'open', ?)`,
              )
              .bind(
                `dup_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
                sig.a,
                sig.b,
                sig.reason,
                sig.confidence,
                now,
              ),
          );
        }
      }

      const nextCursor = hasMore && pageRows.length > 0 ? pageRows[pageRows.length - 1]!.id : null;

      return {
        kind: 'commit',
        result: {
          dryRun,
          scanned: extracted.length,
          wouldCreate,
          created: dryRun ? 0 : wouldCreate,
          alreadyPresent,
          skippedInvalid,
          conflicts,
          candidatesCreated: dryRun ? dupSignals.size : candidatesCreated,
          next: nextCursor,
        },
        fences: [() => crmActorFence(env.DB, actor, tokenHash, 'crm.configure', '*')],
        rows: dryRun ? [] : rows,
        records: dryRun ? [] : records,
        recordExpect: dryRun ? undefined : expectMap,
      };
    },
    mapConstraintError: () => ({
      ok: false,
      error: 'stale',
      retryable: true,
    }),
    afterCommit: ({ env, executionCtx, result }) => {
      if (!result.dryRun && (result.created > 0 || result.candidatesCreated > 0)) {
        pokeLive(env, executionCtx);
      }
    },
  };
}

export function createS1IdentityCommandDefs(): AnyCommandDefinition[] {
  return [
    addEndpointCommand(),
    retireEndpointCommand(),
    setPrimaryEndpointCommand(),
    recordConsentCommand(),
    dismissDuplicateCommand(),
    backfillEndpointsCommand(),
  ];
}

export async function readPersonDetail(
  env: Env,
  actorId: string,
  tokenHash: string,
  personId: string,
): Promise<
  | { status: 200; body: PersonDetailResponse }
  | { status: 401 | 403 | 404; body: { error: string } }
> {
  const auth = await loadCrmReadContext(env, actorId, tokenHash);
  if (!auth.ok) return auth;

  const person = await loadReadableTaskRecord(env, actorId, personId);
  if (!person) return { status: 404, body: { error: 'not_found' } };

  const [epRes, consentRes, dupRes] = await env.DB.batch([
    env.DB
      .prepare(`SELECT * FROM crm_endpoints WHERE person_id = ? ORDER BY retired_at IS NOT NULL ASC, is_primary DESC, created_at ASC`)
      .bind(person.id),
    env.DB
      .prepare(`SELECT * FROM crm_consents WHERE person_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 50`)
      .bind(person.id),
    env.DB
      .prepare(
        `SELECT d.*, ra.data AS a_data, rb.data AS b_data
         FROM crm_duplicate_candidates d
         LEFT JOIN records ra ON ra.id = d.person_a_id
         LEFT JOIN records rb ON rb.id = d.person_b_id
         WHERE (d.person_a_id = ? OR d.person_b_id = ?) AND d.state = 'open'
         ORDER BY d.created_at DESC
         LIMIT 20`,
      )
      .bind(person.id, person.id),
  ]);

  const endpoints = (epRes.results as unknown as EndpointRow[]).map(mapEndpoint);
  const consentHistory = (consentRes.results as unknown as ConsentRow[]).map(mapConsent);
  const latestConsents = latestConsentsFromHistory(consentRes.results as unknown as ConsentRow[]);

  const dupRows = dupRes.results as unknown as DuplicateRow[];
  const gate = createReadGate(env.DB, actorId);
  const peerIds = dupRows.map((d) => (d.person_a_id === person.id ? d.person_b_id : d.person_a_id));
  const readablePeers = new Set((await gate.filter(peerIds.map((id) => ({ id })))).map((r) => r.id));

  const duplicateCandidates: DuplicateCandidateDto[] = dupRows
    .filter((d) => readablePeers.has(d.person_a_id === person.id ? d.person_b_id : d.person_a_id))
    .map((d) => ({
      id: d.id,
      personAId: d.person_a_id,
      personBId: d.person_b_id,
      personATitle: extractTitle(d.a_data),
      personBTitle: extractTitle(d.b_data),
      reason: d.reason,
      confidence: d.confidence,
      state: d.state,
      note: d.note,
      decidedBy: d.decided_by,
      decidedAt: d.decided_at,
      createdAt: d.created_at,
    }));

  return {
    status: 200,
    body: PersonDetailResponseSchema.parse({
      personId: person.id,
      rev: person.seq,
      endpoints,
      latestConsents,
      consentHistory,
      duplicateCandidates,
    }),
  };
}

export async function readDuplicates(
  env: Env,
  actorId: string,
  tokenHash: string,
  stateParam = 'open',
  rawCursor?: string,
): Promise<
  | { status: 200; body: DuplicatesPageResponse }
  | { status: 400 | 401 | 403 | 404; body: { error: string } }
> {
  const auth = await loadCrmReadContext(env, actorId, tokenHash);
  if (!auth.ok) return auth;

  const state = stateParam === 'dismissed' || stateParam === 'merged' ? stateParam : 'open';
  const cursor = rawCursor !== undefined ? decodeTimeIdCursor(rawCursor) : null;
  if (rawCursor !== undefined && !cursor) {
    return { status: 400, body: { error: 'invalid_cursor' } };
  }

  const res = cursor
    ? await env.DB
        .prepare(
          `SELECT d.*, ra.data AS a_data, rb.data AS b_data
           FROM crm_duplicate_candidates d
           LEFT JOIN records ra ON ra.id = d.person_a_id
           LEFT JOIN records rb ON rb.id = d.person_b_id
           WHERE d.state = ? AND (d.created_at < ? OR (d.created_at = ? AND d.id < ?))
           ORDER BY d.created_at DESC, d.id DESC
           LIMIT ?`,
        )
        .bind(state, cursor.ts, cursor.ts, cursor.id, DUPLICATES_PAGE_LIMIT + 1)
        .all<DuplicateRow>()
    : await env.DB
        .prepare(
          `SELECT d.*, ra.data AS a_data, rb.data AS b_data
           FROM crm_duplicate_candidates d
           LEFT JOIN records ra ON ra.id = d.person_a_id
           LEFT JOIN records rb ON rb.id = d.person_b_id
           WHERE d.state = ?
           ORDER BY d.created_at DESC, d.id DESC
           LIMIT ?`,
        )
        .bind(state, DUPLICATES_PAGE_LIMIT + 1)
        .all<DuplicateRow>();

  const rows = res.results;
  const hasMore = rows.length > DUPLICATES_PAGE_LIMIT;
  const page = hasMore ? rows.slice(0, DUPLICATES_PAGE_LIMIT) : rows;
  const gate = createReadGate(env.DB, actorId);
  const allPersonIds = [...new Set(page.flatMap((r) => [r.person_a_id, r.person_b_id]))];
  const readableSet = new Set((await gate.filter(allPersonIds.map((id) => ({ id })))).map((r) => r.id));

  let partial = hasMore;
  const items: DuplicateCandidateDto[] = [];
  for (const r of page) {
    if (!readableSet.has(r.person_a_id) || !readableSet.has(r.person_b_id)) {
      partial = true;
      continue;
    }
    items.push({
      id: r.id,
      personAId: r.person_a_id,
      personBId: r.person_b_id,
      personATitle: extractTitle(r.a_data),
      personBTitle: extractTitle(r.b_data),
      reason: r.reason,
      confidence: r.confidence,
      state: r.state,
      note: r.note,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at,
      createdAt: r.created_at,
    });
  }
  const last = page[page.length - 1];
  return {
    status: 200,
    body: {
      items,
      next: hasMore && last ? encodeTimeIdCursor(last.created_at, last.id) : null,
      partial,
    },
  };
}
