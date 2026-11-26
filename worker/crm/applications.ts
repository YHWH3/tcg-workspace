import {
  ConvertApplicationInputSchema,
  CreateApplicationFromSubmissionInputSchema,
  CRM_PROGRAMME_BY_SLUG,
  CRM_PROGRAMMES,
  ProgrammeProfileV1Schema,
  programmeForWebsiteForm,
  type ConvertApplicationInput,
  type CreateApplicationFromSubmissionInput,
  type HomeSummaryResponse,
  type HomeWorkItemDto,
  type TimelineEntryDto,
  type TimelineResponse,
} from '../../shared/crm/programmes';
import { addDays, daysBetween, parseDateOnly, toDateOnlyInZone, dateOnlyStartInZone, workspaceToday } from '../../shared/dates';
import { normalizeEmail } from '../../shared/crm/identity';
import { CRM_PROJECTION } from '../../shared/crm/projection';
import { linkId } from '../../shared/linkid';
import type { Mutation } from '../../shared/types';
import { WEBSITE_INBOX_ID, WI_FIELD } from '../../shared/websiteInbox';
import type { Env } from '../auth';
import { listApprovals, readableTargets } from '../approvals';
import { createReadGate } from '../readAccess';
import { pokeLive } from '../sync';
import { readWorkspaceSettings } from '../workspaceSettings';
import type { AnyCommandDefinition, CommandDefinition } from './commands';
import { resolveCanonicalPersonId } from './merge';
import {
  actorGrantsStmt,
  crmActorFence,
  decodeTimeIdCursor,
  encodeTimeIdCursor,
  evaluateCrmReadAuthRows,
  finalizeCrmReadAuth,
  loadCrmReadContext,
  loadReadableTaskRecord,
  loadReadableTaskRecords,
  sessionAuthStmt,
  type CrmGrantRow,
  type CrmSessionRow,
} from './read';
import { canAccessCrmApi } from './rules';

interface RawRow {
  id: string;
  data: string;
  seq: number;
  updated_at?: number | null;
}

function parseJsonSafe(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractTitle(data: Record<string, unknown> | null | undefined, fallback = 'Untitled'): string {
  return typeof data?.title === 'string' && data.title.trim() ? data.title.trim() : fallback;
}

async function resolveBoardsMap(db: D1Database): Promise<Map<string, { id: string; key?: string; data: Record<string, unknown> }>> {
  const { results } = await db
    .prepare(`SELECT id, data FROM records WHERE collection = 'boards' LIMIT 200`)
    .all<{ id: string; data: string }>();
  const map = new Map<string, { id: string; key?: string; data: Record<string, unknown> }>();
  for (const r of results) {
    const parsed = parseJsonSafe(r.data);
    if (!parsed || parsed.deleted === true) continue;
    const key = typeof parsed.templateDbKey === 'string' ? parsed.templateDbKey : undefined;
    map.set(r.id, { id: r.id, key, data: parsed });
  }
  return map;
}

function findBoardIdByKey(
  boards: ReadonlyMap<string, { id: string; key?: string; data: Record<string, unknown> }>,
  key: string,
  preferredId?: string,
): string | null {
  if (preferredId && boards.has(preferredId)) return preferredId;
  for (const b of boards.values()) {
    if (b.key === key) return b.id;
  }
  for (const b of boards.values()) {
    if (String(b.data.name ?? '').trim().toLowerCase() === key) return b.id;
  }
  return null;
}

function makeOrderKey(now: number): string {
  return `a${now.toString(36)}`;
}

function createApplicationFromSubmissionCommand(): CommandDefinition<
  CreateApplicationFromSubmissionInput,
  { applicationId: string; already: boolean; personId: string | null; programmeSlug: string | null }
> {
  return {
    name: 'application.create_from_submission',
    projectionKeys: [
      CRM_PROJECTION.sourceSubmissionId,
      CRM_PROJECTION.programmeSlug,
      CRM_PROJECTION.submissionEmail,
    ],
    authorizeCoarse: (actor) => canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = CreateApplicationFromSubmissionInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false,
          error: 'invalid_input',
          detail: { reason: 'invalid_application_input' },
        };
      }
      if (parsed.data.programmeSlug && !CRM_PROGRAMME_BY_SLUG.has(parsed.data.programmeSlug)) {
        return {
          ok: false,
          error: 'invalid_input',
          detail: { reason: 'unknown_programme_slug', fields: { programmeSlug: 'Unknown programme slug' } },
        };
      }
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const submission = await loadReadableTaskRecord(env, actor.id, input.submissionId);
      if (!submission) {
        return { kind: 'refuse', error: 'not_found' };
      }

      const boards = await resolveBoardsMap(env.DB);
      const appsBoardId = findBoardIdByKey(boards, 'applications', input.applicationsBoardId);
      if (!appsBoardId) {
        return {
          kind: 'refuse',
          error: 'invalid_input',
          detail: { reason: 'applications_board_missing' },
        };
      }

      // Check idempotent existing application for this submission
      const existingAppRow = await env.DB
        .prepare(
          `SELECT id, data, seq FROM records
           WHERE collection = 'tasks'
             AND json_extract(data, '$.deleted') IS NOT 1
             AND json_extract(data, '$._crm_source_submission_id') = ?
           LIMIT 1`,
        )
        .bind(submission.id)
        .first<RawRow>();
      if (existingAppRow) {
        const existingApp = await loadReadableTaskRecord(env, actor.id, existingAppRow.id);
        if (existingApp) {
          return {
            kind: 'commit',
            result: {
              applicationId: existingApp.id,
              already: true,
              personId: input.personId ?? null,
              programmeSlug:
                typeof existingApp.data._crm_programme_slug === 'string'
                  ? existingApp.data._crm_programme_slug
                  : null,
            },
            fences: [() => crmActorFence(env.DB, actor, tokenHash)],
          };
        }
      }

      const rawFamily =
        typeof submission.data[`p_${WI_FIELD.family}`] === 'string'
          ? String(submission.data[`p_${WI_FIELD.family}`])
          : null;
      const inferredProgramme = input.programmeSlug
        ? CRM_PROGRAMME_BY_SLUG.get(input.programmeSlug)
        : programmeForWebsiteForm(rawFamily);
      const programmeSlug = inferredProgramme?.slug ?? input.programmeSlug ?? null;

      const rawEmail =
        typeof submission.data[`p_${WI_FIELD.email}`] === 'string'
          ? String(submission.data[`p_${WI_FIELD.email}`])
          : '';
      const emailNorm = rawEmail ? normalizeEmail(rawEmail) : null;

      // Resolve matched person record (explicit or endpoint match or people email match)
      let matchedPersonId: string | null = null;
      if (input.personId) {
        const explicitPerson = await loadReadableTaskRecord(env, actor.id, input.personId);
        if (!explicitPerson) return { kind: 'refuse', error: 'not_found' };
        matchedPersonId = explicitPerson.id;
      } else if (emailNorm) {
        const epMatch = await env.DB
          .prepare(
            `SELECT person_id FROM crm_endpoints
             WHERE kind = 'email' AND value_norm = ? AND retired_at IS NULL
             LIMIT 1`,
          )
          .bind(emailNorm)
          .first<{ person_id: string }>();
        if (epMatch) {
          const { canonicalId } = await resolveCanonicalPersonId(env.DB, epMatch.person_id);
          const readablePerson = await loadReadableTaskRecord(env, actor.id, canonicalId);
          if (readablePerson) matchedPersonId = readablePerson.id;
        }
      }

      // Resolve linked program record in db_programs (best effort)
      let matchedProgramRecordId: string | null = null;
      if (programmeSlug) {
        const programsBoardId = findBoardIdByKey(boards, 'programs');
        if (programsBoardId) {
          const progRes = await env.DB
            .prepare(
              `SELECT id, data, seq FROM records
               WHERE collection = 'tasks'
                 AND json_extract(data, '$.boardId') = ?
                 AND json_extract(data, '$.deleted') IS NOT 1
               LIMIT 100`,
            )
            .bind(programsBoardId)
            .all<RawRow>();
          const progTitle = inferredProgramme?.name.trim().toLowerCase();
          for (const pr of progRes.results) {
            const pdata = parseJsonSafe(pr.data);
            if (!pdata) continue;
            const slugMatch =
              pdata._crm_programme_slug === programmeSlug ||
              String(pdata.p_f_slug ?? '').trim() === programmeSlug ||
              (progTitle && String(pdata.title ?? '').trim().toLowerCase() === progTitle);
            if (slugMatch) {
              const readableProg = await loadReadableTaskRecord(env, actor.id, pr.id);
              if (readableProg) {
                matchedProgramRecordId = readableProg.id;
                break;
              }
            }
          }
        }
      }

      const appId = `app_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const appTitle = inferredProgramme
        ? `${extractTitle(submission.data, 'Applicant')} — ${inferredProgramme.name}`
        : extractTitle(submission.data, 'Application');

      // Submission record itself is NEVER modified (visitor's words remain immutable).
      const records: Mutation[] = [
        {
          id: appId,
          collection: 'tasks',
          patch: {
            boardId: appsBoardId,
            title: appTitle,
            status: 'received',
            order: makeOrderKey(now),
            createdBy: actor.id,
            createdAt: now,
            ...(rawFamily ? { p_f_form: rawFamily } : {}),
            ...(input.reviewerId ? { p_f_reviewer: input.reviewerId } : {}),
            ...(input.note?.trim() ? { p_f_decision_reason: input.note.trim() } : {}),
            [CRM_PROJECTION.sourceSubmissionId]: submission.id,
            [CRM_PROJECTION.programmeSlug]: programmeSlug,
            [CRM_PROJECTION.submissionEmail]: emailNorm,
          },
          ts: now,
        },
        // Non-mutating 'related' link connecting new application -> immutable source submission
        {
          id: linkId('related', '', appId, submission.id),
          collection: 'links',
          patch: {
            fromType: 'record',
            fromId: appId,
            toType: 'record',
            toId: submission.id,
            kind: 'related',
            fieldId: null,
            createdBy: actor.id,
            createdAt: now,
            deleted: false,
          },
          ts: now,
        },
      ];

      if (matchedPersonId) {
        records.push({
          id: linkId('relation', 'f_applicant', appId, matchedPersonId),
          collection: 'links',
          patch: {
            fromType: 'record',
            fromId: appId,
            toType: 'record',
            toId: matchedPersonId,
            kind: 'relation',
            fieldId: 'f_applicant',
            createdBy: actor.id,
            createdAt: now,
            deleted: false,
          },
          ts: now,
        });
      }

      if (matchedProgramRecordId) {
        records.push({
          id: linkId('relation', 'f_programme', appId, matchedProgramRecordId),
          collection: 'links',
          patch: {
            fromType: 'record',
            fromId: appId,
            toType: 'record',
            toId: matchedProgramRecordId,
            kind: 'relation',
            fieldId: 'f_programme',
            createdBy: actor.id,
            createdAt: now,
            deleted: false,
          },
          ts: now,
        });
      }

      return {
        kind: 'commit',
        result: {
          applicationId: appId,
          already: false,
          personId: matchedPersonId,
          programmeSlug,
        },
        fences: [() => crmActorFence(env.DB, actor, tokenHash)],
        records,
        recordExpect: new Map([[submission.id, submission.seq]]),
      };
    },
    afterCommit: ({ env, executionCtx }) => {
      pokeLive(env, executionCtx);
    },
  };
}

function convertApplicationCommand(): CommandDefinition<
  ConvertApplicationInput,
  { applicationId: string; convertedRecordId: string; targetKind: ConvertApplicationInput['targetKind']; already: boolean }
> {
  return {
    name: 'application.convert',
    projectionKeys: [CRM_PROJECTION.convertedRecordId, CRM_PROJECTION.convertedKind],
    authorizeCoarse: (actor) => canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = ConvertApplicationInputSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: 'invalid_input', detail: { reason: 'invalid_convert_input' } };
      }
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, expected, now }) => {
      const app = await loadReadableTaskRecord(env, actor.id, input.applicationId);
      if (!app) return { kind: 'refuse', error: 'not_found' };

      const boards = await resolveBoardsMap(env.DB);
      const targetBoard = boards.get(input.targetBoardId);
      if (!targetBoard) {
        return {
          kind: 'refuse',
          error: 'invalid_input',
          detail: { reason: 'target_board_not_found', fields: { targetBoardId: 'Target board not found' } },
        };
      }

      const existingConvertedId =
        typeof app.data._crm_converted_record_id === 'string' && app.data._crm_converted_record_id
          ? app.data._crm_converted_record_id
          : null;
      if (existingConvertedId) {
        const existingTarget = await loadReadableTaskRecord(env, actor.id, existingConvertedId);
        if (existingTarget) {
          return {
            kind: 'commit',
            result: {
              applicationId: app.id,
              convertedRecordId: existingConvertedId,
              targetKind:
                (app.data._crm_converted_kind as ConvertApplicationInput['targetKind'] | undefined) ??
                input.targetKind,
              already: true,
            },
            fences: [() => crmActorFence(env.DB, actor, tokenHash)],
            recordExpect: new Map([[app.id, expected?.get(app.id) ?? app.seq]]),
            forceRecordsCommit: true,
          };
        }
      }

      // Copy primary applicant / programme links onto the converted target record
      const linksRes = await env.DB
        .prepare(
          `SELECT id, data FROM records
           WHERE collection = 'links'
             AND json_extract(data, '$.fromId') = ?
             AND json_extract(data, '$.deleted') IS NOT 1
             AND json_extract(data, '$.kind') = 'relation'`,
        )
        .bind(app.id)
        .all<{ id: string; data: string }>();
      let applicantId: string | null = null;
      let programmeRecordId: string | null = null;
      for (const l of linksRes.results) {
        const ld = parseJsonSafe(l.data);
        if (!ld) continue;
        if (ld.fieldId === 'f_applicant' && typeof ld.toId === 'string') applicantId = ld.toId;
        if (ld.fieldId === 'f_programme' && typeof ld.toId === 'string') programmeRecordId = ld.toId;
      }

      const prefix =
        input.targetKind === 'project' ? 'proj' : input.targetKind === 'opportunity' ? 'opp' : 'evt';
      const targetId = `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const cols = Array.isArray(targetBoard.data.columns)
        ? (targetBoard.data.columns as { id?: unknown }[])
        : [];
      const firstStatus = typeof cols[0]?.id === 'string' ? cols[0].id : undefined;

      const targetPatch: Record<string, unknown> = {
        boardId: targetBoard.id,
        title: input.title ?? extractTitle(app.data, `Converted ${input.targetKind}`),
        ...(firstStatus ? { status: firstStatus } : {}),
        order: makeOrderKey(now),
        createdBy: actor.id,
        createdAt: now,
        ...(input.targetKind === 'opportunity' && input.pipelineId ? { p_f_pipeline: input.pipelineId } : {}),
      };

      const records: Mutation[] = [
        {
          id: targetId,
          collection: 'tasks',
          patch: targetPatch,
          ts: now,
        },
        {
          id: app.id,
          collection: 'tasks',
          patch: {
            status: 'converted',
            [CRM_PROJECTION.convertedRecordId]: targetId,
            [CRM_PROJECTION.convertedKind]: input.targetKind,
          },
          ts: now,
        },
        {
          id: linkId('related', '', app.id, targetId),
          collection: 'links',
          patch: {
            fromType: 'record',
            fromId: app.id,
            toType: 'record',
            toId: targetId,
            kind: 'related',
            fieldId: null,
            createdBy: actor.id,
            createdAt: now,
            deleted: false,
          },
          ts: now,
        },
      ];

      if (applicantId) {
        const applicantField =
          input.targetKind === 'event' ? 'f_participants' : 'f_people';
        records.push({
          id: linkId('relation', applicantField, targetId, applicantId),
          collection: 'links',
          patch: {
            fromType: 'record',
            fromId: targetId,
            toType: 'record',
            toId: applicantId,
            kind: 'relation',
            fieldId: applicantField,
            createdBy: actor.id,
            createdAt: now,
            deleted: false,
          },
          ts: now,
        });
      }

      if (programmeRecordId) {
        const progField = input.targetKind === 'project' ? 'f_program' : 'f_programme';
        records.push({
          id: linkId('relation', progField, targetId, programmeRecordId),
          collection: 'links',
          patch: {
            fromType: 'record',
            fromId: targetId,
            toType: 'record',
            toId: programmeRecordId,
            kind: 'relation',
            fieldId: progField,
            createdBy: actor.id,
            createdAt: now,
            deleted: false,
          },
          ts: now,
        });
      }

      return {
        kind: 'commit',
        result: {
          applicationId: app.id,
          convertedRecordId: targetId,
          targetKind: input.targetKind,
          already: false,
        },
        fences: [() => crmActorFence(env.DB, actor, tokenHash)],
        records,
        recordExpect: new Map([[app.id, expected?.get(app.id) ?? app.seq]]),
      };
    },
    afterCommit: ({ env, executionCtx }) => {
      pokeLive(env, executionCtx);
    },
  };
}

export function createS2ApplicationCommandDefs(): AnyCommandDefinition[] {
  return [createApplicationFromSubmissionCommand(), convertApplicationCommand()];
}

const TIMELINE_DEFAULT_LIMIT = 30;
const TIMELINE_MAX_LIMIT = 50;

/**
 * GET /api/crm/read/timeline?subject=<id>&cursor=&limit=
 * Unified, keyset-paginated, ReadGate-filtered relationship timeline.
 */
export async function readTimeline(
  env: Env,
  actorId: string,
  tokenHash: string,
  opts: { subjectId: string; cursor?: string; limit?: number },
): Promise<
  | { status: 200; body: TimelineResponse }
  | { status: 400; body: { error: 'invalid_cursor' | 'invalid_input' } }
  | { status: 401 | 403 | 404; body: { error: 'unauthenticated' | 'forbidden' | 'not_found' } }
> {
  const auth = await loadCrmReadContext(env, actorId, tokenHash);
  if (!auth.ok) return { status: auth.status, body: auth.body };

  if (!opts.subjectId || opts.subjectId.length > 128) {
    return { status: 400, body: { error: 'invalid_input' } };
  }

  let parsedCursor: { ts: number; id: string } | null = null;
  if (opts.cursor !== undefined) {
    parsedCursor = decodeTimeIdCursor(opts.cursor);
    if (!parsedCursor) return { status: 400, body: { error: 'invalid_cursor' } };
  }

  const limit = Math.min(TIMELINE_MAX_LIMIT, Math.max(1, opts.limit ?? TIMELINE_DEFAULT_LIMIT));

  const gate = createReadGate(env.DB, actorId);
  const subjectMap = await loadReadableTaskRecords(env, gate, [opts.subjectId]);
  const subject = subjectMap.get(opts.subjectId);
  if (!subject) return { status: 404, body: { error: 'not_found' } };

  const batchNow = Date.now();
  const [sessionRes, grantsRes, linksRes, convsRes, consentsRes, actRes, boardsRes] = await env.DB.batch([
    sessionAuthStmt(env.DB, actorId, tokenHash, batchNow),
    actorGrantsStmt(env.DB, actorId),
    env.DB
      .prepare(
        `SELECT id, data FROM records
         WHERE collection = 'links'
           AND json_extract(data, '$.deleted') IS NOT 1
           AND (json_extract(data, '$.fromId') = ? OR json_extract(data, '$.toId') = ?)
         LIMIT 200`,
      )
      .bind(subject.id, subject.id),
    env.DB
      .prepare(
        `SELECT id, channel, person_id, organisation_id, application_id, subject, state, last_message_at, created_at
         FROM crm_conversations
         WHERE person_id = ? OR organisation_id = ? OR application_id = ?
         ORDER BY last_message_at DESC, id DESC
         LIMIT 60`,
      )
      .bind(subject.id, subject.id, subject.id),
    env.DB
      .prepare(
        `SELECT c.id, c.channel, c.scope, c.status, c.source, c.recorded_at, u.name AS actor_name
         FROM crm_consents c
         LEFT JOIN users u ON u.id = c.recorded_by
         WHERE c.person_id = ?
         ORDER BY c.recorded_at DESC, c.id DESC
         LIMIT 50`,
      )
      .bind(subject.id),
    env.DB
      .prepare(
        `SELECT id, data FROM records
         WHERE collection = 'activity'
           AND json_extract(data, '$.deleted') IS NOT 1
           AND json_extract(data, '$.targetId') = ?
         LIMIT 100`,
      )
      .bind(subject.id),
    env.DB.prepare(`SELECT id, data FROM records WHERE collection = 'boards' LIMIT 200`),
  ]);

  const batchAuth = evaluateCrmReadAuthRows(
    sessionRes.results[0] as CrmSessionRow | undefined,
    grantsRes.results as unknown as CrmGrantRow[],
  );
  if (!batchAuth.ok) return { status: batchAuth.status, body: batchAuth.body };

  const boardKeyById = new Map<string, string>();
  for (const b of boardsRes.results as unknown as { id: string; data: string }[]) {
    const pd = parseJsonSafe(b.data);
    if (!pd || pd.deleted === true) continue;
    if (typeof pd.templateDbKey === 'string') boardKeyById.set(b.id, pd.templateDbKey);
    else if (b.id === WEBSITE_INBOX_ID) boardKeyById.set(b.id, 'website_inbox');
  }

  const linkedIds = new Set<string>([subject.id]);
  const convRows = convsRes.results as unknown as {
    id: string;
    channel: string;
    person_id: string | null;
    organisation_id: string | null;
    application_id: string | null;
    subject: string;
    state: string;
    last_message_at: number;
  }[];
  for (const conv of convRows) {
    if (conv.person_id) linkedIds.add(conv.person_id);
    if (conv.organisation_id) linkedIds.add(conv.organisation_id);
    if (conv.application_id) linkedIds.add(conv.application_id);
  }
  if (typeof subject.data._crm_source_submission_id === 'string') {
    linkedIds.add(subject.data._crm_source_submission_id);
  }
  if (typeof subject.data._crm_converted_record_id === 'string') {
    linkedIds.add(subject.data._crm_converted_record_id);
  }
  for (const l of linksRes.results as unknown as { id: string; data: string }[]) {
    const ld = parseJsonSafe(l.data);
    if (!ld) continue;
    if (typeof ld.fromId === 'string') linkedIds.add(ld.fromId);
    if (typeof ld.toId === 'string') linkedIds.add(ld.toId);
  }

  const candidateIds = [...linkedIds].slice(0, 120);
  const partial = linkedIds.size > 120;

  const [relatedRecordsRes, approvalsList] = await Promise.all([
    candidateIds.length > 0
      ? env.DB
          .prepare(
            `SELECT id, data, seq, updated_at FROM records
             WHERE collection = 'tasks'
               AND id IN (SELECT value FROM json_each(?))`,
          )
          .bind(JSON.stringify(candidateIds))
          .all<RawRow>()
      : Promise.resolve({ results: [] as RawRow[] }),
    listApprovals(env.DB, { userId: actorId, targetId: subject.id, limit: 40 }),
  ]);

  const parsedRelated: { id: string; rev: number; updatedAt: number; data: Record<string, unknown> }[] = [];
  for (const r of relatedRecordsRes.results) {
    const data = parseJsonSafe(r.data);
    if (!data || data.deleted === true) continue;
    parsedRelated.push({
      id: r.id,
      rev: r.seq,
      updatedAt: Number(data.createdAt ?? r.updated_at ?? 0),
      data,
    });
  }

  const [keptRelated, canReadApproval] = await Promise.all([
    gate.filter(parsedRelated.map((r) => ({ id: r.id, rev: r.rev }))),
    readableTargets(env.DB, actorId, approvalsList, gate),
  ]);
  const allowedIds = new Set(keptRelated.map((r) => r.id));

  const finalAuth = await finalizeCrmReadAuth(env, actorId, tokenHash, { gate, deniedStatus: 404 });
  if (!finalAuth.ok) return { status: finalAuth.status, body: finalAuth.body };

  const entries: TimelineEntryDto[] = [];

  for (const rec of parsedRelated) {
    if (!allowedIds.has(rec.id)) continue;
    if (rec.id === subject.id) continue;
    const bId = typeof rec.data.boardId === 'string' ? rec.data.boardId : null;
    const bKey = bId ? boardKeyById.get(bId) : undefined;
    let kind: TimelineEntryDto['kind'] = 'conversion';
    if (bId === WEBSITE_INBOX_ID || bKey === 'website_inbox') kind = 'submission';
    else if (bKey === 'applications') kind = 'application';
    else if (bKey === 'activities') kind = 'activity';
    const ts =
      typeof rec.data.p_f_when === 'string' && Number.isFinite(Date.parse(rec.data.p_f_when))
        ? Date.parse(rec.data.p_f_when)
        : Number(rec.data.createdAt ?? rec.updatedAt ?? 0);
    entries.push({
      id: `rec:${rec.id}`,
      kind,
      ts: Math.max(0, Math.round(ts)),
      title: extractTitle(rec.data),
      subtitle:
        typeof rec.data.p_f_summary === 'string'
          ? rec.data.p_f_summary
          : typeof rec.data.status === 'string'
            ? `Stage: ${rec.data.status}`
            : bKey ?? 'Related item',
      actorName: null,
      linkToRecordId: rec.id,
      boardId: bId,
    });
  }

  for (const ap of approvalsList) {
    if (!canReadApproval(ap)) continue;
    entries.push({
      id: `appr:${ap.id}`,
      kind: 'approval',
      ts: ap.decided_at ?? ap.created_at,
      title: `Approval ${ap.status}`,
      subtitle: ap.note ?? (ap.stage_id ? `Stage: ${ap.stage_id}` : null),
      actorName: null,
      linkToRecordId: ap.target_id,
    });
  }

  for (const conv of convRows) {
    if (
      (conv.person_id && !allowedIds.has(conv.person_id)) ||
      (conv.organisation_id && !allowedIds.has(conv.organisation_id)) ||
      (conv.application_id && !allowedIds.has(conv.application_id))
    ) {
      continue;
    }
    entries.push({
      id: `conv:${conv.id}`,
      kind: 'conversation',
      ts: conv.last_message_at,
      title: conv.subject || `${conv.channel} conversation`,
      subtitle: `${conv.channel} · ${conv.state}`,
      actorName: null,
      conversationId: conv.id,
    });
  }

  for (const c of consentsRes.results as unknown as {
    id: string;
    channel: string;
    scope: string;
    status: string;
    source: string;
    recorded_at: number;
    actor_name: string | null;
  }[]) {
    entries.push({
      id: `cons:${c.id}`,
      kind: 'consent',
      ts: c.recorded_at,
      title: `Consent ${c.status}: ${c.channel} (${c.scope})`,
      subtitle: `Source: ${c.source}`,
      actorName: c.actor_name,
    });
  }

  for (const act of actRes.results as unknown as { id: string; data: string }[]) {
    const ad = parseJsonSafe(act.data);
    if (!ad) continue;
    entries.push({
      id: `act:${act.id}`,
      kind: 'workspace_activity',
      ts: Number(ad.ts ?? ad.createdAt ?? 0),
      title: typeof ad.verb === 'string' ? ad.verb : 'Workspace update',
      subtitle: typeof ad.targetTitle === 'string' ? ad.targetTitle : null,
      actorName: typeof ad.actorName === 'string' ? ad.actorName : null,
    });
  }

  entries.sort((a, b) => (b.ts !== a.ts ? b.ts - a.ts : b.id.localeCompare(a.id)));

  const filtered = parsedCursor
    ? entries.filter(
        (e) => e.ts < parsedCursor!.ts || (e.ts === parsedCursor!.ts && e.id < parsedCursor!.id),
      )
    : entries;

  const hasMore = filtered.length > limit;
  const page = filtered.slice(0, limit);
  const last = page[page.length - 1];
  const next = hasMore && last ? encodeTimeIdCursor(last.ts, last.id) : null;

  return {
    status: 200,
    body: {
      subjectId: subject.id,
      items: page,
      next,
      partial,
    },
  };
}

const HOME_SCAN_LIMIT = 1500;

function extractTitleSlugMap(): Map<string, string> {
  return new Map(CRM_PROGRAMMES.map((p) => [p.name.trim().toLowerCase(), p.slug]));
}

/**
 * GET /api/crm/read/home
 * My Work summary (today, shared, thisWeek, recently) covering owner-assigned
 * follow-ups, shared unassigned items, ReadGate-filtered conversations, pending
 * approvals waiting on actor, and programme-target ageing applications using
 * configured workspace timezone boundaries.
 */
export async function readCrmHome(
  env: Env,
  actorId: string,
  tokenHash: string,
): Promise<
  | { status: 200; body: HomeSummaryResponse }
  | { status: 401 | 403 | 404; body: { error: 'unauthenticated' | 'forbidden' | 'not_found' } }
> {
  const auth = await loadCrmReadContext(env, actorId, tokenHash);
  if (!auth.ok) return { status: auth.status, body: auth.body };

  let timeZone = 'UTC';
  try {
    timeZone = (await readWorkspaceSettings(env)).timeZone;
  } catch {
    timeZone = 'UTC';
  }

  const now = Date.now();
  const todayKey = workspaceToday(now, timeZone);
  const weekEndKey = addDays(todayKey, 7) ?? todayKey;

  const [batchRes, pendingApprovals] = await Promise.all([
    env.DB.batch([
      sessionAuthStmt(env.DB, actorId, tokenHash, now),
      actorGrantsStmt(env.DB, actorId),
      env.DB.prepare(`SELECT id, data FROM records WHERE collection = 'boards' LIMIT 200`),
      env.DB
        .prepare(`SELECT id, data, seq, updated_at FROM records WHERE collection = 'tasks' ORDER BY updated_at DESC LIMIT ?`)
        .bind(HOME_SCAN_LIMIT + 1),
      env.DB.prepare(
        `SELECT id, data FROM records
         WHERE collection = 'links'
           AND json_extract(data, '$.deleted') IS NOT 1
           AND json_extract(data, '$.kind') = 'relation'
           AND json_extract(data, '$.fieldId') = 'f_programme'
         LIMIT 1000`,
      ),
      env.DB.prepare(
        `SELECT id, channel, person_id, organisation_id, application_id, subject, last_inbound_at, last_outbound_at, last_message_at, assignee_id
         FROM crm_conversations
         WHERE state = 'open'
           AND last_inbound_at IS NOT NULL
           AND (last_outbound_at IS NULL OR last_inbound_at > last_outbound_at)
         ORDER BY last_inbound_at DESC, id DESC
         LIMIT 60`,
      ),
      env.DB.prepare(`SELECT slug, programme_record_id, profile_json FROM crm_programme_profiles`),
    ]),
    listApprovals(env.DB, { userId: actorId, mine: 'approver', status: 'pending', limit: 30 }),
  ]);

  const [sessionRes, grantsRes, boardsRes, tasksRes, progLinksRes, convsRes, progProfilesRes] = batchRes;
  const batchAuth = evaluateCrmReadAuthRows(
    sessionRes.results[0] as CrmSessionRow | undefined,
    grantsRes.results as unknown as CrmGrantRow[],
  );
  if (!batchAuth.ok) return { status: batchAuth.status, body: batchAuth.body };

  const taskRows = tasksRes.results as unknown as RawRow[];
  let partial = taskRows.length > HOME_SCAN_LIMIT;
  const boardKeyById = new Map<string, string>();
  for (const b of boardsRes.results as unknown as { id: string; data: string }[]) {
    const pd = parseJsonSafe(b.data);
    if (!pd || pd.deleted === true) continue;
    if (typeof pd.templateDbKey === 'string') boardKeyById.set(b.id, pd.templateDbKey);
  }

  const gate = createReadGate(env.DB, actorId);
  const parsedTasks: { id: string; rev: number; updatedAt: number; boardKey?: string; boardId: string; data: Record<string, unknown> }[] = [];
  for (const row of taskRows.slice(0, HOME_SCAN_LIMIT)) {
    const data = parseJsonSafe(row.data);
    if (!data || data.deleted === true || data.archived === true) continue;
    const bId = typeof data.boardId === 'string' ? data.boardId : '';
    const bKey = boardKeyById.get(bId);
    if (bKey && ['people', 'organizations', 'programs', 'applications', 'activities', 'opportunities'].includes(bKey)) {
      parsedTasks.push({
        id: row.id,
        rev: row.seq,
        updatedAt: Number(row.updated_at ?? data.createdAt ?? 0),
        boardKey: bKey,
        boardId: bId,
        data,
      });
    }
  }

  const convRows = convsRes.results as unknown as {
    id: string;
    channel: string;
    person_id: string | null;
    organisation_id: string | null;
    application_id: string | null;
    subject: string;
    last_inbound_at: number;
    last_outbound_at: number | null;
    last_message_at: number;
    assignee_id: string | null;
  }[];
  const convLinkedIds = [
    ...new Set(
      convRows.flatMap((c) => [c.person_id, c.organisation_id, c.application_id]).filter((id): id is string => Boolean(id)),
    ),
  ];

  const [keptTasks, readableConvLinked, canReadAppr] = await Promise.all([
    gate.filter(parsedTasks.map((t) => ({ id: t.id, rev: t.rev }))),
    loadReadableTaskRecords(env, gate, convLinkedIds),
    readableTargets(env.DB, actorId, pendingApprovals, gate),
  ]);
  const readableIds = new Set(keptTasks.map((t) => t.id));

  const targetDaysBySlug = new Map<string, number | null>();
  for (const p of CRM_PROGRAMMES) {
    targetDaysBySlug.set(p.slug, p.defaultProfile.responseTargetDays);
  }
  const slugByProgRecordId = new Map<string, string>();
  const progByTitle = extractTitleSlugMap();

  for (const rec of parsedTasks) {
    if (!readableIds.has(rec.id) || rec.boardKey !== 'programs') continue;
    const slug =
      (typeof rec.data._crm_programme_slug === 'string' && rec.data._crm_programme_slug) ||
      (typeof rec.data.p_f_slug === 'string' && rec.data.p_f_slug.trim()) ||
      (typeof rec.data.title === 'string' ? progByTitle.get(rec.data.title.trim().toLowerCase()) : undefined);
    if (slug && CRM_PROGRAMME_BY_SLUG.has(slug)) {
      slugByProgRecordId.set(rec.id, slug);
    }
  }

  for (const row of progProfilesRes.results as unknown as { slug: string; programme_record_id: string | null; profile_json: string }[]) {
    if (row.programme_record_id && !slugByProgRecordId.has(row.programme_record_id) && CRM_PROGRAMME_BY_SLUG.has(row.slug)) {
      slugByProgRecordId.set(row.programme_record_id, row.slug);
    }
    try {
      const parsed = ProgrammeProfileV1Schema.safeParse(JSON.parse(row.profile_json));
      if (parsed.success) {
        targetDaysBySlug.set(row.slug, parsed.data.responseTargetDays);
      }
    } catch {
      /* retain canonical default */
    }
  }

  const progSlugByAppId = new Map<string, string>();
  for (const linkRow of progLinksRes.results as unknown as { id: string; data: string }[]) {
    const ld = parseJsonSafe(linkRow.data);
    if (!ld || ld.deleted === true) continue;
    const fromId = typeof ld.fromId === 'string' ? ld.fromId : '';
    const toId = typeof ld.toId === 'string' ? ld.toId : '';
    const slug = slugByProgRecordId.get(toId) ?? slugByProgRecordId.get(fromId);
    if (!slug) continue;
    const appId = slugByProgRecordId.has(toId) ? fromId : toId;
    if (!progSlugByAppId.has(appId)) progSlugByAppId.set(appId, slug);
  }

  const today: HomeWorkItemDto[] = [];
  const shared: HomeWorkItemDto[] = [];
  const thisWeek: HomeWorkItemDto[] = [];
  const recently: HomeWorkItemDto[] = [];
  let ageingApplications = 0;
  let dueFollowUps = 0;
  let unansweredConversations = 0;
  let unassignedFollowUps = 0;
  let unassignedConversations = 0;
  let pendingApprovalsCount = 0;

  for (const ap of pendingApprovals) {
    if (!canReadAppr(ap)) continue;
    pendingApprovalsCount += 1;
    today.push({
      id: `appr:${ap.id}`,
      kind: 'approval_pending',
      title: `Approval waiting: ${ap.stage_id ?? 'review'}`,
      subtitle: ap.note ?? `Target ${ap.target_id}`,
      dueTs: ap.created_at,
      updatedTs: ap.created_at,
      route: '/crm/applications',
      urgency: 'high',
      recordId: ap.target_id,
    });
  }

  for (const conv of convRows) {
    const linkedOk =
      (!conv.person_id || readableConvLinked.has(conv.person_id)) &&
      (!conv.organisation_id || readableConvLinked.has(conv.organisation_id)) &&
      (!conv.application_id || readableConvLinked.has(conv.application_id));
    if (!linkedOk) {
      partial = true;
      continue;
    }
    if (conv.assignee_id === actorId) {
      unansweredConversations += 1;
      today.push({
        id: `conv:${conv.id}`,
        kind: 'conversation_unanswered',
        title: conv.subject || `Unanswered ${conv.channel} thread`,
        subtitle: `${conv.channel} · assigned to you`,
        dueTs: conv.last_inbound_at,
        updatedTs: conv.last_message_at,
        route: `/crm/conversations/${conv.id}`,
        urgency: 'high',
        conversationId: conv.id,
      });
    } else if (!conv.assignee_id) {
      unansweredConversations += 1;
      unassignedConversations += 1;
      shared.push({
        id: `conv:${conv.id}`,
        kind: 'conversation_unanswered',
        title: conv.subject || `Unassigned ${conv.channel} thread`,
        subtitle: `${conv.channel} · unassigned awaiting reply`,
        dueTs: conv.last_inbound_at,
        updatedTs: conv.last_message_at,
        route: `/crm/conversations/${conv.id}`,
        urgency: 'normal',
        conversationId: conv.id,
      });
    }
  }

  for (const rec of parsedTasks) {
    if (!readableIds.has(rec.id)) continue;
    const title = extractTitle(rec.data);

    if (rec.boardKey === 'activities') {
      const done = rec.data.status === 'done' || rec.data.p_f_done === true;
      if (!done) {
        const ownerId =
          (typeof rec.data.p_f_owner === 'string' && rec.data.p_f_owner.trim()) ||
          (typeof rec.data.assigneeId === 'string' && rec.data.assigneeId.trim()) ||
          null;
        const rawDue = typeof rec.data.p_f_due === 'string' ? rec.data.p_f_due.trim() : '';
        const rawWhen = typeof rec.data.p_f_when === 'string' ? rec.data.p_f_when.trim() : '';
        let dueKey: string | null = null;
        let dueTs: number | null = null;
        if (parseDateOnly(rawDue)) {
          dueKey = rawDue;
          dueTs =
            (rawWhen && Number.isFinite(Date.parse(rawWhen)) ? Date.parse(rawWhen) : null) ??
            dateOnlyStartInZone(dueKey, timeZone);
        } else if (rawWhen && Number.isFinite(Date.parse(rawWhen))) {
          dueTs = Date.parse(rawWhen);
          dueKey = toDateOnlyInZone(dueTs, timeZone);
        }

        if (dueKey) {
          if (ownerId === actorId) {
            if (dueKey < todayKey) {
              dueFollowUps += 1;
              today.push({
                id: `act:${rec.id}`,
                kind: 'followup_overdue',
                title,
                subtitle: 'Overdue follow-up',
                dueTs,
                updatedTs: rec.updatedAt,
                route: '/crm/activities',
                urgency: 'high',
                recordId: rec.id,
                boardId: rec.boardId,
              });
            } else if (dueKey === todayKey) {
              dueFollowUps += 1;
              today.push({
                id: `act:${rec.id}`,
                kind: 'followup_due',
                title,
                subtitle: 'Due today',
                dueTs,
                updatedTs: rec.updatedAt,
                route: '/crm/activities',
                urgency: 'normal',
                recordId: rec.id,
                boardId: rec.boardId,
              });
            } else if (dueKey > todayKey && dueKey <= weekEndKey) {
              thisWeek.push({
                id: `act:${rec.id}`,
                kind: 'followup_due',
                title,
                subtitle: `Scheduled ${dueKey}`,
                dueTs,
                updatedTs: rec.updatedAt,
                route: '/crm/activities',
                urgency: 'low',
                recordId: rec.id,
                boardId: rec.boardId,
              });
            }
          } else if (ownerId === null && dueKey <= todayKey) {
            unassignedFollowUps += 1;
            shared.push({
              id: `act:${rec.id}`,
              kind: dueKey < todayKey ? 'followup_overdue' : 'followup_due',
              title,
              subtitle: dueKey < todayKey ? `Unassigned · overdue (${dueKey})` : `Unassigned · due ${dueKey}`,
              dueTs,
              updatedTs: rec.updatedAt,
              route: '/crm/activities',
              urgency: dueKey < todayKey ? 'high' : 'normal',
              recordId: rec.id,
              boardId: rec.boardId,
            });
          }
        }
      }
    }

    if (rec.boardKey === 'applications') {
      const status = typeof rec.data.status === 'string' ? rec.data.status : 'received';
      const terminal = ['accepted', 'declined', 'withdrawn', 'not_now', 'converted'].includes(status);
      if (!terminal) {
        const formId = typeof rec.data.p_f_form === 'string' ? rec.data.p_f_form : undefined;
        const progSlug =
          (typeof rec.data._crm_programme_slug === 'string' && rec.data._crm_programme_slug) ||
          progSlugByAppId.get(rec.id) ||
          programmeForWebsiteForm(formId)?.slug ||
          null;
        const targetDays = progSlug ? (targetDaysBySlug.get(progSlug) ?? null) : null;
        if (targetDays !== null) {
          const createdAt = Number(rec.data.createdAt ?? rec.updatedAt ?? now);
          const createdKey = toDateOnlyInZone(createdAt, timeZone) ?? todayKey;
          const ageDays = Math.max(0, daysBetween(createdKey, todayKey) ?? 0);
          if (ageDays >= targetDays) {
            ageingApplications += 1;
            const progName = CRM_PROGRAMME_BY_SLUG.get(progSlug!)?.name ?? progSlug ?? 'Programme';
            thisWeek.push({
              id: `app:${rec.id}`,
              kind: 'application_ageing',
              title,
              subtitle: `${progName} · ${ageDays}d (target ${targetDays}d)`,
              dueTs: createdAt,
              updatedTs: rec.updatedAt,
              route: `/crm/applications/${rec.id}`,
              urgency: 'normal',
              recordId: rec.id,
              boardId: rec.boardId,
            });
          }
        }
      }
    }

    if (recently.length < 15) {
      const route =
        rec.boardKey === 'people'
          ? `/crm/people/${rec.id}`
          : rec.boardKey === 'organizations'
            ? `/crm/organisations/${rec.id}`
            : rec.boardKey === 'applications'
              ? `/crm/applications/${rec.id}`
              : rec.boardKey === 'activities'
                ? '/crm/activities'
                : rec.boardKey === 'opportunities'
                  ? '/crm/pipelines'
                  : '/crm/programmes';
      recently.push({
        id: `recent:${rec.id}`,
        kind: 'recent_record',
        title,
        subtitle: `${rec.boardKey ?? 'CRM'} update`,
        dueTs: null,
        updatedTs: rec.updatedAt,
        route,
        urgency: 'low',
        recordId: rec.id,
        boardId: rec.boardId,
      });
    }
  }

  const finalAuth = await finalizeCrmReadAuth(env, actorId, tokenHash, { gate });
  if (!finalAuth.ok) return { status: finalAuth.status, body: finalAuth.body };

  return {
    status: 200,
    body: {
      today: today.slice(0, 25),
      shared: shared.slice(0, 25),
      thisWeek: thisWeek.slice(0, 25),
      recently: recently.slice(0, 15),
      counts: {
        ageingApplications,
        pendingApprovals: pendingApprovalsCount,
        dueFollowUps,
        unansweredConversations,
        unassignedFollowUps,
        unassignedConversations,
      },
      partial,
    },
  };
}
