import {
  HandoffOpportunityToProjectInputSchema,
  type HandoffOpportunityToProjectInput,
  type PatronProjectionDto,
  type PatronsReadResponse,
} from '../../shared/crm/pipelines';
import { normalizeEmail } from '../../shared/crm/identity';
import { CRM_PROJECTION } from '../../shared/crm/projection';
import { linkId } from '../../shared/linkid';
import type { Mutation } from '../../shared/types';
import { PATRON_TIERS, WEBSITE_INBOX_ID, WI_FIELD } from '../../shared/websiteInbox';
import type { Env } from '../auth';
import { createReadGate } from '../readAccess';
import { pokeLive } from '../sync';
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
import { canAccessCrmApi, isCrmEnabled } from './rules';

function parseJsonSafe(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function handoffOpportunityToProjectCommand(): CommandDefinition<
  HandoffOpportunityToProjectInput,
  { opportunityId: string; projectId: string; already: boolean }
> {
  return {
    name: 'opportunity.handoff_project',
    projectionKeys: [CRM_PROJECTION.projectId],
    authorizeCoarse: (actor) => canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = HandoffOpportunityToProjectInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input', detail: { reason: 'invalid_handoff_input' } };
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, expected, now }) => {
      const opp = await loadReadableTaskRecord(env, actor.id, input.opportunityId);
      if (!opp) return { kind: 'refuse', error: 'not_found' };

      const existingProjectId =
        typeof opp.data[CRM_PROJECTION.projectId] === 'string' && opp.data[CRM_PROJECTION.projectId]
          ? String(opp.data[CRM_PROJECTION.projectId])
          : null;
      if (existingProjectId) {
        const existingProject = await loadReadableTaskRecord(env, actor.id, existingProjectId);
        if (existingProject) {
          return {
            kind: 'commit',
            result: { opportunityId: opp.id, projectId: existingProject.id, already: true },
            fences: [() => crmActorFence(env.DB, actor, tokenHash)],
            recordExpect: new Map([[opp.id, expected?.get(opp.id) ?? opp.seq]]),
            forceRecordsCommit: true,
          };
        }
      }

      const targetBoardRow = await env.DB
        .prepare(`SELECT id, data FROM records WHERE id = ? AND collection = 'boards'`)
        .bind(input.projectsBoardId)
        .first<{ id: string; data: string }>();
      const boardData = parseJsonSafe(targetBoardRow?.data);
      if (!targetBoardRow || !boardData || boardData.deleted === true) {
        return {
          kind: 'refuse',
          error: 'invalid_input',
          detail: { reason: 'target_board_not_found', fields: { projectsBoardId: 'Projects database not found' } },
        };
      }

      // Collect primary links on the opportunity (programme, people, organisation) to mirror onto new Project
      const linksRes = await env.DB
        .prepare(
          `SELECT id, data FROM records
           WHERE collection = 'links'
             AND json_extract(data, '$.fromId') = ?
             AND json_extract(data, '$.deleted') IS NOT 1
             AND json_extract(data, '$.kind') = 'relation'`,
        )
        .bind(opp.id)
        .all<{ id: string; data: string }>();

      const projectId = `proj_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const cols = Array.isArray(boardData.columns) ? (boardData.columns as { id?: unknown }[]) : [];
      const firstStatus = typeof cols[0]?.id === 'string' ? cols[0].id : 'planning';
      const title =
        input.title ??
        (typeof opp.data.title === 'string' && opp.data.title.trim() ? opp.data.title.trim() : 'Handed-off project');

      const records: Mutation[] = [
        {
          id: projectId,
          collection: 'tasks',
          patch: {
            boardId: targetBoardRow.id,
            title,
            status: firstStatus,
            order: `a${now.toString(36)}`,
            createdBy: actor.id,
            createdAt: now,
            ...(typeof opp.data.p_f_amount === 'number' ? { p_f_budget: opp.data.p_f_amount } : {}),
            ...(typeof opp.data.p_f_owner === 'string' ? { p_f_owner: opp.data.p_f_owner } : {}),
            ...(typeof opp.data.p_f_next_action === 'string' ? { p_f_objective: opp.data.p_f_next_action } : {}),
          },
          ts: now,
        },
        {
          id: opp.id,
          collection: 'tasks',
          patch: {
            [CRM_PROJECTION.projectId]: projectId,
          },
          ts: now,
        },
        // Primary Opportunity -> Projects link + related bi-directional metadata
        {
          id: linkId('relation', 'f_projects', opp.id, projectId),
          collection: 'links',
          patch: {
            fromType: 'record',
            fromId: opp.id,
            toType: 'record',
            toId: projectId,
            kind: 'relation',
            fieldId: 'f_projects',
            createdBy: actor.id,
            createdAt: now,
            deleted: false,
          },
          ts: now,
        },
        {
          id: linkId('related', '', opp.id, projectId),
          collection: 'links',
          patch: {
            fromType: 'record',
            fromId: opp.id,
            toType: 'record',
            toId: projectId,
            kind: 'related',
            fieldId: null,
            createdBy: actor.id,
            createdAt: now,
            deleted: false,
          },
          ts: now,
        },
      ];

      for (const lr of linksRes.results) {
        const ld = parseJsonSafe(lr.data);
        if (!ld || typeof ld.toId !== 'string' || typeof ld.fieldId !== 'string') continue;
        let targetField: string | null = null;
        if (ld.fieldId === 'f_programme') targetField = 'f_program';
        else if (ld.fieldId === 'f_people') targetField = 'f_people';
        else if (ld.fieldId === 'f_org') targetField = 'f_orgs';
        if (targetField) {
          records.push({
            id: linkId('relation', targetField, projectId, ld.toId),
            collection: 'links',
            patch: {
              fromType: 'record',
              fromId: projectId,
              toType: 'record',
              toId: ld.toId,
              kind: 'relation',
              fieldId: targetField,
              createdBy: actor.id,
              createdAt: now,
              deleted: false,
            },
            ts: now,
          });
        }
      }

      return {
        kind: 'commit',
        result: { opportunityId: opp.id, projectId, already: false },
        fences: [() => crmActorFence(env.DB, actor, tokenHash)],
        records,
        recordExpect: new Map([[opp.id, expected?.get(opp.id) ?? opp.seq]]),
      };
    },
    afterCommit: ({ env, executionCtx }) => {
      pokeLive(env, executionCtx);
    },
  };
}

export function createS9PipelineCommandDefs(): AnyCommandDefinition[] {
  return [handoffOpportunityToProjectCommand()];
}

const PATRONS_SCAN_LIMIT = 500;

/**
 * GET /api/crm/read/patrons
 * Strictly read-only projection mirroring website Patron relay events in `board-website-inbox`.
 * Zero CRM Patron mutations exist in P1.
 */
export async function readPatrons(
  env: Env,
  actorId: string,
  tokenHash: string,
): Promise<
  | { status: 200; body: PatronsReadResponse }
  | { status: 401 | 403 | 404; body: { error: 'unauthenticated' | 'forbidden' | 'not_found' } }
> {
  if (!isCrmEnabled(env)) {
    return { status: 404, body: { error: 'not_found' } };
  }

  const batchNow = Date.now();
  const [sessionRes, grantsRes, inboxRes] = await env.DB.batch([
    sessionAuthStmt(env.DB, actorId, tokenHash, batchNow),
    actorGrantsStmt(env.DB, actorId),
    env.DB
      .prepare(
        `SELECT id, data, seq, updated_at
         FROM records
         WHERE collection = 'tasks'
           AND json_extract(data, '$.boardId') = ?
           AND json_extract(data, '$.deleted') IS NOT 1
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
      )
      .bind(WEBSITE_INBOX_ID, PATRONS_SCAN_LIMIT + 1),
  ]);

  const batchAuth = evaluateCrmReadAuthRows(
    sessionRes.results[0] as CrmSessionRow | undefined,
    grantsRes.results as unknown as CrmGrantRow[],
  );
  if (!batchAuth.ok) return { status: batchAuth.status, body: batchAuth.body };

  const results = inboxRes.results as unknown as { id: string; data: string; seq: number; updated_at: number | null }[];
  const partial = results.length > PATRONS_SCAN_LIMIT;
  const patronCandidates: { id: string; rev: number; updatedAt: number; data: Record<string, unknown> }[] = [];
  for (const row of results.slice(0, PATRONS_SCAN_LIMIT)) {
    const d = parseJsonSafe(row.data);
    if (!d) continue;
    const family = d[`p_${WI_FIELD.family}`];
    const event = d[`p_${WI_FIELD.event}`];
    const tier = d[`p_${WI_FIELD.tier}`];
    const isPatron =
      family === 'patron' ||
      family === 'patrons' ||
      (typeof event === 'string' && event.startsWith('patron.')) ||
      (typeof tier === 'string' && (PATRON_TIERS as readonly string[]).includes(tier));
    if (isPatron) {
      patronCandidates.push({
        id: row.id,
        rev: row.seq,
        updatedAt: Number(d.createdAt ?? row.updated_at ?? 0),
        data: d,
      });
    }
  }

  const gate = createReadGate(env.DB, actorId);
  const kept = await gate.filter(patronCandidates.map((c) => ({ id: c.id, rev: c.rev })));
  const allowed = new Set(kept.map((k) => k.id));

  // Best-effort email -> matched Person lookup via active crm_endpoints
  const emails = [
    ...new Set(
      patronCandidates
        .filter((c) => allowed.has(c.id))
        .map((c) => {
          const raw = c.data[`p_${WI_FIELD.email}`];
          return typeof raw === 'string' ? normalizeEmail(raw) : null;
        })
        .filter((e): e is string => Boolean(e)),
    ),
  ];

  const personByEmail = new Map<string, string>();
  if (emails.length > 0) {
    const epRes = await env.DB
      .prepare(
        `SELECT person_id, value_norm FROM crm_endpoints
         WHERE kind = 'email' AND retired_at IS NULL
           AND value_norm IN (SELECT value FROM json_each(?))`,
      )
      .bind(JSON.stringify(emails))
      .all<{ person_id: string; value_norm: string }>();
    const matchedIds = [...new Set(epRes.results.map((r) => r.person_id))];
    const readablePeople = await loadReadableTaskRecords(env, gate, matchedIds);
    for (const r of epRes.results) {
      if (readablePeople.has(r.person_id)) {
        personByEmail.set(r.value_norm, r.person_id);
      }
    }
  }

  const finalAuth = await finalizeCrmReadAuth(env, actorId, tokenHash, { gate });
  if (!finalAuth.ok) return { status: finalAuth.status, body: finalAuth.body };

  const countsByTier = { founding: 0, builder: 0, partner: 0, unspecified: 0 };
  const items: PatronProjectionDto[] = [];
  for (const c of patronCandidates) {
    if (!allowed.has(c.id)) continue;
    const rawTier = c.data[`p_${WI_FIELD.tier}`];
    const tier =
      typeof rawTier === 'string' && (PATRON_TIERS as readonly string[]).includes(rawTier)
        ? (rawTier as (typeof PATRON_TIERS)[number])
        : null;
    if (tier) countsByTier[tier] += 1;
    else countsByTier.unspecified += 1;

    const rawEmail = c.data[`p_${WI_FIELD.email}`];
    const emailNorm = typeof rawEmail === 'string' ? normalizeEmail(rawEmail) : null;

    items.push({
      submissionId: c.id,
      personId: emailNorm ? personByEmail.get(emailNorm) ?? null : null,
      title: typeof c.data.title === 'string' && c.data.title.trim() ? c.data.title.trim() : 'Patron',
      email: typeof rawEmail === 'string' && rawEmail.trim() ? rawEmail.trim() : null,
      tier,
      stage: typeof c.data[`p_${WI_FIELD.stage}`] === 'string' ? String(c.data[`p_${WI_FIELD.stage}`]) : null,
      edition: typeof c.data[`p_${WI_FIELD.edition}`] === 'string' ? String(c.data[`p_${WI_FIELD.edition}`]) : null,
      event: typeof c.data[`p_${WI_FIELD.event}`] === 'string' ? String(c.data[`p_${WI_FIELD.event}`]) : null,
      received: typeof c.data[`p_${WI_FIELD.received}`] === 'string' ? String(c.data[`p_${WI_FIELD.received}`]) : null,
      paid: typeof c.data[`p_${WI_FIELD.paid}`] === 'string' ? String(c.data[`p_${WI_FIELD.paid}`]) : null,
      applicationCode: typeof c.data[`p_${WI_FIELD.application}`] === 'string' ? String(c.data[`p_${WI_FIELD.application}`]) : null,
      createdAt: c.updatedAt,
      boardId: WEBSITE_INBOX_ID,
    });
  }

  return {
    status: 200,
    body: {
      readOnly: true,
      items,
      countsByTier,
      partial,
    },
  };
}
