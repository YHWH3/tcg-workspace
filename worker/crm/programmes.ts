import {
  CRM_PROGRAMMES,
  CRM_PROGRAMME_BY_SLUG,
  ProgrammeProfileV1Schema,
  UpdateProgrammeProfileInputSchema,
  isRegisteredProgrammeSlug,
  programmeScopeForSlug,
  type ProgrammeProfileV1,
  type ProgrammeSummaryDto,
  type ProgrammesListResponse,
  type UpdateProgrammeProfileInput,
} from '../../shared/crm/programmes';
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
  sessionAuthStmt,
  type CrmGrantRow,
  type CrmSessionRow,
} from './read';
import { canAccessCrmApi, evaluateCapability, isCrmEnabled } from './rules';

interface ProgrammeProfileRow {
  slug: string;
  programme_record_id: string | null;
  work_area: string;
  name: string;
  profile_json: string;
  rev: number;
  updated_by: string | null;
  updated_at: number;
}

interface RawRecordRow {
  id: string;
  data: string;
  seq: number;
}

function parseProfileSafe(raw: string | null | undefined, fallback: ProgrammeProfileV1): ProgrammeProfileV1 {
  if (!raw) return fallback;
  try {
    const parsed = ProgrammeProfileV1Schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

function parseJsonSafe(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function profileRevFence(db: D1Database, slug: string, expectedRev: number | null): D1PreparedStatement {
  if (expectedRev === null) {
    return db
      .prepare(
        `SELECT CASE WHEN NOT EXISTS (
           SELECT 1 FROM crm_programme_profiles WHERE slug = ?
         ) THEN 1 ELSE json_extract('{', '$') END`,
      )
      .bind(slug);
  }
  return db
    .prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM crm_programme_profiles WHERE slug = ? AND rev = ?
       ) THEN 1 ELSE json_extract('{', '$') END`,
    )
    .bind(slug, expectedRev);
}

function isProfileConfigured(p: ProgrammeProfileV1): 'configured' | 'default' {
  const hasPolicies = Boolean(
    p.policies.eligibilityCriteria ||
      p.policies.durationSummary ||
      p.policies.feeSummary ||
      p.policies.benefitsSummary ||
      p.responseTargetDays !== null ||
      p.bookingDefaults.holdMinutes !== null ||
      p.bookingDefaults.pricePolicyNote,
  );
  return hasPolicies ? 'configured' : 'default';
}

function updateProgrammeProfileCommand(): CommandDefinition<
  UpdateProgrammeProfileInput,
  { programme: ProgrammeSummaryDto; already: boolean }
> {
  return {
    name: 'programme.update_profile',
    projectionKeys: ['_crm_work_area', '_crm_profile_status', '_crm_programme_slug'],
    authorizeCoarse: (actor) => canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = UpdateProgrammeProfileInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false,
          error: 'invalid_input',
          detail: { reason: 'invalid_programme_profile' },
        };
      }
      if (!isRegisteredProgrammeSlug(parsed.data.slug)) {
        return {
          ok: false,
          error: 'invalid_input',
          detail: { reason: 'unknown_programme_slug', fields: { slug: 'Unknown programme slug' } },
        };
      }
      return { ok: true, input: parsed.data };
    },
    authorizeFine: (actor, input) =>
      evaluateCapability(actor, 'crm.configure', programmeScopeForSlug(input.slug)),
    authorizeReplay: (actor, input) =>
      evaluateCapability(actor, 'crm.configure', programmeScopeForSlug(input.slug)),
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const def = CRM_PROGRAMME_BY_SLUG.get(input.slug)!;
      const existing = await env.DB
        .prepare(
          `SELECT slug, programme_record_id, work_area, name, profile_json, rev, updated_by, updated_at
           FROM crm_programme_profiles WHERE slug = ?`,
        )
        .bind(input.slug)
        .first<ProgrammeProfileRow>();

      if (input.expectedRev !== undefined && existing && existing.rev !== input.expectedRev) {
        return { kind: 'refuse', error: 'stale' };
      }
      if (input.expectedRev !== undefined && !existing && input.expectedRev !== 1) {
        return { kind: 'refuse', error: 'stale' };
      }

      const targetRecordId = input.programmeRecordId ?? existing?.programme_record_id ?? null;
      let readableProgrammeRecord = null;
      if (targetRecordId) {
        readableProgrammeRecord = await loadReadableTaskRecord(env, actor.id, targetRecordId);
        if (input.programmeRecordId && !readableProgrammeRecord) {
          return { kind: 'refuse', error: 'not_found' };
        }
      }

      const nextRev = existing ? existing.rev + 1 : 1;
      const profileJson = JSON.stringify(input.profile);
      const scope = programmeScopeForSlug(input.slug);
      const summary: ProgrammeSummaryDto = {
        slug: def.slug,
        name: def.name,
        area: input.profile.area,
        recordId: readableProgrammeRecord?.id ?? targetRecordId,
        rev: nextRev,
        updatedAt: now,
        updatedBy: actor.id,
        canConfigure: true,
        profile: input.profile,
        counts: { applications: 0, opportunities: 0, events: 0, people: 0 },
      };

      const stmt = env.DB
        .prepare(
          `INSERT INTO crm_programme_profiles
             (slug, programme_record_id, work_area, name, profile_json, rev, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(slug) DO UPDATE SET
             programme_record_id = COALESCE(excluded.programme_record_id, crm_programme_profiles.programme_record_id),
             work_area = excluded.work_area,
             profile_json = excluded.profile_json,
             rev = crm_programme_profiles.rev + 1,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`,
        )
        .bind(
          def.slug,
          readableProgrammeRecord?.id ?? targetRecordId,
          input.profile.area,
          def.name,
          profileJson,
          actor.id,
          now,
        );

      const records = readableProgrammeRecord
        ? [
            {
              id: readableProgrammeRecord.id,
              collection: 'tasks' as const,
              patch: {
                _crm_work_area: input.profile.area,
                _crm_profile_status: isProfileConfigured(input.profile),
                _crm_programme_slug: def.slug,
              },
              ts: now,
            },
          ]
        : undefined;

      const recordExpect = readableProgrammeRecord
        ? new Map<string, number>([[readableProgrammeRecord.id, readableProgrammeRecord.seq]])
        : undefined;

      return {
        kind: 'commit',
        result: { programme: summary, already: false },
        fences: [
          () => crmActorFence(env.DB, actor, tokenHash, 'crm.configure', scope),
          profileRevFence(env.DB, def.slug, existing ? existing.rev : null),
        ],
        rows: [stmt],
        records,
        recordExpect,
      };
    },
    afterCommit: ({ env, executionCtx }) => {
      pokeLive(env, executionCtx);
    },
  };
}

export function createS2ProgrammeCommandDefs(): AnyCommandDefinition[] {
  return [updateProgrammeProfileCommand()];
}

const READ_TASK_CAP = 2000;

/**
 * GET /api/crm/read/programmes
 * Merges the 14 canonical TCG programmes with crm_programme_profiles and
 * ReadGate-filtered Workspace counts inside the 45-call D1 budget.
 */
export async function readProgrammes(
  env: Env,
  actorId: string,
  tokenHash: string,
): Promise<
  | { status: 200; body: ProgrammesListResponse }
  | { status: 401 | 403 | 404; body: { error: 'unauthenticated' | 'forbidden' | 'not_found' } }
> {
  if (!isCrmEnabled(env)) {
    return { status: 404, body: { error: 'not_found' } };
  }

  const batchNow = Date.now();
  const [sessionRes, grantsRes, profilesRes, boardsRes, tasksRes, linksRes] = await env.DB.batch([
    sessionAuthStmt(env.DB, actorId, tokenHash, batchNow),
    actorGrantsStmt(env.DB, actorId),
    env.DB.prepare(
      `SELECT slug, programme_record_id, work_area, name, profile_json, rev, updated_by, updated_at
       FROM crm_programme_profiles`,
    ),
    env.DB.prepare(`SELECT id, data FROM records WHERE collection = 'boards' LIMIT 200`),
    env.DB
      .prepare(`SELECT id, data, seq FROM records WHERE collection = 'tasks' LIMIT ?`)
      .bind(READ_TASK_CAP + 1),
    env.DB
      .prepare(`SELECT id, data, seq FROM records WHERE collection = 'links' LIMIT ?`)
      .bind(READ_TASK_CAP + 1),
  ]);

  const batchAuth = evaluateCrmReadAuthRows(
    sessionRes.results[0] as CrmSessionRow | undefined,
    grantsRes.results as unknown as CrmGrantRow[],
  );
  if (!batchAuth.ok) return { status: batchAuth.status, body: batchAuth.body };

  const rawTasks = tasksRes.results as unknown as RawRecordRow[];
  const rawLinks = linksRes.results as unknown as RawRecordRow[];
  const partial = rawTasks.length > READ_TASK_CAP || rawLinks.length > READ_TASK_CAP;

  const boardKeyById = new Map<string, string>();
  for (const b of boardsRes.results as unknown as { id: string; data: string }[]) {
    const parsed = parseJsonSafe(b.data);
    if (!parsed || parsed.deleted === true) continue;
    if (typeof parsed.templateDbKey === 'string') {
      boardKeyById.set(b.id, parsed.templateDbKey);
    } else if (typeof parsed.name === 'string') {
      const lower = parsed.name.trim().toLowerCase();
      if (['programs', 'programmes', 'applications', 'opportunities', 'events', 'people'].includes(lower)) {
        boardKeyById.set(b.id, lower === 'programmes' ? 'programs' : lower);
      }
    }
  }

  const gate = createReadGate(env.DB, actorId);
  const candidateTasks: { id: string; rev: number; boardKey: string; data: Record<string, unknown> }[] = [];
  for (const row of rawTasks.slice(0, READ_TASK_CAP)) {
    const data = parseJsonSafe(row.data);
    if (!data || data.deleted === true) continue;
    const bKey = typeof data.boardId === 'string' ? boardKeyById.get(data.boardId) : undefined;
    if (bKey && ['programs', 'applications', 'opportunities', 'events', 'people'].includes(bKey)) {
      candidateTasks.push({ id: row.id, rev: row.seq, boardKey: bKey, data });
    }
  }

  const keptTasks = await gate.filter(candidateTasks.map((t) => ({ id: t.id, rev: t.rev })));
  const readableIds = new Set(keptTasks.map((t) => t.id));

  const programRecordBySlug = new Map<string, string>();
  const slugByProgramRecordId = new Map<string, string>();
  const byTitleSlug = new Map<string, string>(
    CRM_PROGRAMMES.map((p) => [p.name.trim().toLowerCase(), p.slug]),
  );

  for (const t of candidateTasks) {
    if (!readableIds.has(t.id) || t.boardKey !== 'programs') continue;
    const explicitSlug =
      (typeof t.data._crm_programme_slug === 'string' && t.data._crm_programme_slug) ||
      (typeof t.data.p_f_slug === 'string' && t.data.p_f_slug.trim()) ||
      (typeof t.data.title === 'string' ? byTitleSlug.get(t.data.title.trim().toLowerCase()) : undefined);
    if (explicitSlug && CRM_PROGRAMME_BY_SLUG.has(explicitSlug)) {
      programRecordBySlug.set(explicitSlug, t.id);
      slugByProgramRecordId.set(t.id, explicitSlug);
    }
  }

  const storedProfiles = new Map<string, ProgrammeProfileRow>();
  for (const row of profilesRes.results as unknown as ProgrammeProfileRow[]) {
    storedProfiles.set(row.slug, row);
    if (row.programme_record_id && readableIds.has(row.programme_record_id)) {
      programRecordBySlug.set(row.slug, row.programme_record_id);
      slugByProgramRecordId.set(row.programme_record_id, row.slug);
    }
  }

  const taskBoardKeyById = new Map<string, string>();
  const countsBySlug = new Map<string, { applications: Set<string>; opportunities: Set<string>; events: Set<string>; people: Set<string> }>();
  const ensureCounts = (slug: string) => {
    let bucket = countsBySlug.get(slug);
    if (!bucket) {
      bucket = { applications: new Set(), opportunities: new Set(), events: new Set(), people: new Set() };
      countsBySlug.set(slug, bucket);
    }
    return bucket;
  };

  for (const t of candidateTasks) {
    if (!readableIds.has(t.id)) continue;
    taskBoardKeyById.set(t.id, t.boardKey);
    const projSlug = typeof t.data._crm_programme_slug === 'string' ? t.data._crm_programme_slug : null;
    if (projSlug && CRM_PROGRAMME_BY_SLUG.has(projSlug)) {
      const bucket = ensureCounts(projSlug);
      if (t.boardKey === 'applications') bucket.applications.add(t.id);
      else if (t.boardKey === 'opportunities') bucket.opportunities.add(t.id);
      else if (t.boardKey === 'events') bucket.events.add(t.id);
      else if (t.boardKey === 'people') bucket.people.add(t.id);
    }
  }

  for (const row of rawLinks.slice(0, READ_TASK_CAP)) {
    const linkData = parseJsonSafe(row.data);
    if (!linkData || linkData.deleted === true || linkData.kind !== 'relation') continue;
    const fromId = typeof linkData.fromId === 'string' ? linkData.fromId : '';
    const toId = typeof linkData.toId === 'string' ? linkData.toId : '';
    if (!readableIds.has(fromId) || !readableIds.has(toId)) continue;
    const targetSlug = slugByProgramRecordId.get(toId) ?? slugByProgramRecordId.get(fromId);
    if (!targetSlug) continue;
    const peerId = slugByProgramRecordId.has(toId) ? fromId : toId;
    const peerKind = taskBoardKeyById.get(peerId);
    if (!peerKind) continue;
    const bucket = ensureCounts(targetSlug);
    if (peerKind === 'applications') bucket.applications.add(peerId);
    else if (peerKind === 'opportunities') bucket.opportunities.add(peerId);
    else if (peerKind === 'events') bucket.events.add(peerId);
    else if (peerKind === 'people') bucket.people.add(peerId);
  }

  const finalAuth = await finalizeCrmReadAuth(env, actorId, tokenHash, { gate });
  if (!finalAuth.ok) return { status: finalAuth.status, body: finalAuth.body };

  const programmes: ProgrammeSummaryDto[] = CRM_PROGRAMMES.map((def) => {
    const stored = storedProfiles.get(def.slug);
    const profile = parseProfileSafe(stored?.profile_json, def.defaultProfile);
    const counts = countsBySlug.get(def.slug);
    return {
      slug: def.slug,
      name: def.name,
      area: profile.area,
      recordId: programRecordBySlug.get(def.slug) ?? null,
      rev: stored?.rev ?? 0,
      updatedAt: stored?.updated_at ?? null,
      updatedBy: stored?.updated_by ?? null,
      canConfigure: evaluateCapability(finalAuth.actor, 'crm.configure', programmeScopeForSlug(def.slug)),
      profile,
      counts: {
        applications: counts?.applications.size ?? 0,
        opportunities: counts?.opportunities.size ?? 0,
        events: counts?.events.size ?? 0,
        people: counts?.people.size ?? 0,
      },
    };
  });

  return { status: 200, body: { programmes, partial } };
}
