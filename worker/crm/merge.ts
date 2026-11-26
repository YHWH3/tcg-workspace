import { z } from 'zod';
import { fieldsOf, propKey } from '../../shared/fields';
import { linkId } from '../../shared/linkid';
import { MAX_EXPECTED_ENTRIES } from '../../shared/crm/contracts';
import {
  canonicalPersonPair,
  type CrmConsentDto,
  type CrmEndpointDto,
  type CrmEndpointKind,
} from '../../shared/crm/identity';
import {
  MERGE_HISTORY_PAGE_LIMIT,
  MergePreviewResponseSchema,
  PersonMergeInputSchema,
  PersonUnmergeInputSchema,
  checkMergeBudget,
  comparePersonFields,
  computeEffectiveMergedConsents,
  computeMergedFieldPatch,
  resolveEffectiveConsentsWithAliases,
  validatePrimaryEndpointChoice,
  type MergeEndpointPlanDto,
  type MergeEndpointSummaryDto,
  type MergeHistoryItemDto,
  type MergeHistoryPageResponse,
  type MergeJournalMovedPayload,
  type MergeMovedCountsDto,
  type MergePreviewResponse,
  type MergeReferenceCountsDto,
  type PersonMergeInput,
  type PersonMergeOutput,
  type PersonUnmergeInput,
  type PersonUnmergeOutput,
  type UnmergeConflictDto,
} from '../../shared/crm/merge';
import { CRM_PROJECTION } from '../../shared/crm/projection';
import { WEBSITE_PEOPLE_ID } from '../../shared/websiteInbox';
import type { Mutation } from '../../shared/types';
import type { Env } from '../auth';
import { createReadGate } from '../readAccess';
import { pokeLive } from '../sync';
import type { AnyCommandDefinition, CommandDefinition } from './commands';
import {
  actorGrantsStmt,
  crmActorFence,
  decodeTimeIdCursor,
  encodeTimeIdCursor,
  evaluateCrmReadAuthRows,
  finalizeCrmReadAuth,
  loadCrmReadContext,
  loadReadableTaskRecords,
  sessionAuthStmt,
  type CrmGrantRow,
  type CrmSessionRow,
} from './read';
import { canAccessCrmApi, evaluateCapability, isCrmEnabled } from './rules';

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

interface ConversationSummaryRow {
  id: string;
  person_id: string | null;
  state: string;
  last_message_at: number;
  last_outbound_at: number | null;
  rev: number;
}

interface DuplicateCandidateRow {
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
}

interface FormPeopleKeyRow {
  database_id: string;
  field_key: string;
  email: string;
  record_id: string;
}

interface AliasRow {
  alias_id: string;
  survivor_id: string;
  merge_id: string;
  effective_at: number;
}

interface SyncedRow {
  id: string;
  collection: string;
  data: string;
  seq: number;
}

interface MergeJournalRow {
  id: string;
  survivor_id: string;
  merged_id: string;
  actor_id: string;
  command_id: string;
  moved_json: string;
  post_record_revs_json: string;
  note: string | null;
  created_at: number;
}

interface UnmergeRow {
  merge_id: string;
  unmerge_id: string;
  actor_id: string;
  command_id: string;
  reason: string | null;
  created_at: number;
}

const ALL_ENDPOINT_KINDS: readonly CrmEndpointKind[] = ['email', 'phone', 'whatsapp', 'instagram', 'facebook'];

function parseJsonSafe(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseZodErrors(err: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const k = issue.path.length > 0 ? String(issue.path[0]) : '_root';
    if (!(k in fields)) fields[k] = issue.message;
  }
  return fields;
}

function changesOneFence(db: D1Database): D1PreparedStatement {
  return db.prepare(`SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('{', '$') END`);
}

function isPeopleBoard(boardId: unknown, boardData: Record<string, unknown> | undefined): boolean {
  if (boardId === WEBSITE_PEOPLE_ID) return true;
  if (!boardData) return false;
  if (boardData.templateDbKey === 'people') return true;
  return typeof boardData.name === 'string' && boardData.name.trim().toLowerCase() === 'people';
}

function extractTitle(data: Record<string, unknown>): string {
  return typeof data.title === 'string' && data.title.trim() ? data.title.trim() : 'Untitled';
}

function mapEndpointSummary(r: EndpointRow): MergeEndpointSummaryDto {
  return {
    id: r.id,
    personId: r.person_id,
    kind: r.kind,
    valueRaw: r.value_raw,
    valueNorm: r.value_norm,
    isPrimary: r.is_primary === 1,
    retiredAt: r.retired_at,
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

function formatConsentSummary(latest: readonly CrmConsentDto[]): string {
  if (latest.length === 0) return 'None recorded';
  return [...latest]
    .sort((a, b) => `${a.channel}:${a.scope}`.localeCompare(`${b.channel}:${b.scope}`))
    .slice(0, 4)
    .map((c) => `${c.channel}:${c.status}`)
    .join(', ');
}

function buildPersonProjectionPatch(args: {
  activeEndpoints: readonly Pick<EndpointRow, 'kind' | 'value_norm' | 'is_primary'>[];
  latestConsents: readonly CrmConsentDto[];
  conversations: readonly Pick<ConversationSummaryRow, 'state' | 'last_message_at' | 'last_outbound_at'>[];
  boardData?: Record<string, unknown> | null;
  includeEmailPhoneFields?: boolean;
}): Record<string, unknown> {
  const emails = args.activeEndpoints.filter((e) => e.kind === 'email');
  const phones = args.activeEndpoints.filter((e) => e.kind === 'phone');
  const primaryEmail = (emails.find((e) => e.is_primary === 1) ?? emails[0])?.value_norm ?? null;
  const primaryPhone = (phones.find((e) => e.is_primary === 1) ?? phones[0])?.value_norm ?? null;
  const openCount = args.conversations.filter((c) => c.state === 'open').length;
  const lastContact = args.conversations.reduce<number | null>(
    (max, c) => (max === null || c.last_message_at > max ? c.last_message_at : max),
    null,
  );
  const lastOutbound = args.conversations.reduce<number | null>(
    (max, c) =>
      c.last_outbound_at !== null && (max === null || c.last_outbound_at > max) ? c.last_outbound_at : max,
    null,
  );

  const patch: Record<string, unknown> = {
    [CRM_PROJECTION.primaryEmail]: primaryEmail,
    [CRM_PROJECTION.primaryPhone]: primaryPhone,
    [CRM_PROJECTION.endpointCount]: args.activeEndpoints.length,
    [CRM_PROJECTION.consentSummary]: formatConsentSummary(args.latestConsents),
    [CRM_PROJECTION.openConversations]: openCount,
    ...(lastContact !== null ? { [CRM_PROJECTION.lastContactAt]: lastContact } : { [CRM_PROJECTION.lastContactAt]: null }),
    ...(lastOutbound !== null ? { [CRM_PROJECTION.lastOutboundAt]: lastOutbound } : { [CRM_PROJECTION.lastOutboundAt]: null }),
  };

  if (args.includeEmailPhoneFields && args.boardData) {
    const fields = fieldsOf(args.boardData);
    const emailField = fields.find((f) => /^e-?mail$/i.test(f.name.trim()));
    if (emailField) patch[propKey(emailField.id)] = primaryEmail;
    const phoneField = fields.find((f) => /^phone$/i.test(f.name.trim()));
    if (phoneField) patch[propKey(phoneField.id)] = primaryPhone;
  }

  return patch;
}

/* ---------- Shared Alias & Non-Broadening Consent Helpers ---------- */

export async function resolveCanonicalPersonId(
  db: D1Database,
  personId: string,
): Promise<{ canonicalId: string; mergedInto: string | null }> {
  const alias = await db
    .prepare(`SELECT survivor_id FROM crm_person_aliases WHERE alias_id = ?`)
    .bind(personId)
    .first<{ survivor_id: string }>();
  if (alias?.survivor_id && alias.survivor_id !== personId) {
    return { canonicalId: alias.survivor_id, mergedInto: alias.survivor_id };
  }
  return { canonicalId: personId, mergedInto: null };
}

export async function loadAliasesForSurvivor(
  db: D1Database,
  survivorId: string,
): Promise<Map<string, number>> {
  const res = await db
    .prepare(`SELECT alias_id, effective_at FROM crm_person_aliases WHERE survivor_id = ?`)
    .bind(survivorId)
    .all<{ alias_id: string; effective_at: number }>();
  const out = new Map<string, number>();
  for (const row of res.results) {
    out.set(row.alias_id, row.effective_at);
  }
  return out;
}

export function latestConsentRowsPerTupleStmt(
  db: D1Database,
  personIds: readonly string[],
): D1PreparedStatement {
  const uniqueIds = [...new Set(personIds.filter((id) => id.length > 0))];
  return db
    .prepare(
      `SELECT id, person_id, channel, scope, status, source, evidence_ref, recorded_by, recorded_at
       FROM (
         SELECT c.*,
           ROW_NUMBER() OVER (
             PARTITION BY c.person_id, c.channel, c.scope
             ORDER BY c.recorded_at DESC, c.id DESC
           ) AS rn
         FROM crm_consents c
         WHERE c.person_id IN (SELECT value FROM json_each(?))
       )
       WHERE rn = 1`,
    )
    .bind(JSON.stringify(uniqueIds));
}

export async function assertNotArchivedAlias(
  db: D1Database,
  person: { id: string; data: Record<string, unknown> },
): Promise<{ archived: false } | { archived: true; mergedInto: string | null }> {
  const alias = await resolveCanonicalPersonId(db, person.id);
  const dataMergedInto =
    typeof person.data._crm_merged_into === 'string' && person.data._crm_merged_into.length > 0
      ? person.data._crm_merged_into
      : null;
  if (alias.mergedInto || dataMergedInto || person.data.archived === true) {
    return { archived: true, mergedInto: alias.mergedInto ?? dataMergedInto };
  }
  return { archived: false };
}

export function notArchivedAliasFence(db: D1Database, personId: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT CASE WHEN NOT EXISTS (
         SELECT 1 FROM crm_person_aliases WHERE alias_id = ?
       ) AND EXISTS (
         SELECT 1 FROM records
         WHERE id = ? AND collection = 'tasks'
           AND COALESCE(json_extract(data, '$.deleted'), 0) != 1
           AND COALESCE(json_extract(data, '$.archived'), 0) != 1
           AND json_extract(data, '$._crm_merged_into') IS NULL
       ) THEN 1 ELSE json_extract('{', '$') END`,
    )
    .bind(personId, personId);
}

export async function loadEffectiveConsentsForPerson(
  db: D1Database,
  personId: string,
): Promise<{ history: CrmConsentDto[]; latest: CrmConsentDto[]; aliases: Map<string, number> }> {
  const aliases = await loadAliasesForSurvivor(db, personId);
  const allIds = [personId, ...aliases.keys()];
  const [histRes, latestRes] = await db.batch([
    db
      .prepare(
        `SELECT * FROM crm_consents
         WHERE person_id IN (SELECT value FROM json_each(?))
         ORDER BY recorded_at DESC, id DESC
         LIMIT 150`,
      )
      .bind(JSON.stringify(allIds)),
    latestConsentRowsPerTupleStmt(db, allIds),
  ]);
  const history = (histRes.results as unknown as ConsentRow[]).map(mapConsent);
  const latestRows = (latestRes.results as unknown as ConsentRow[]).map(mapConsent);
  const latest = resolveEffectiveConsentsWithAliases(personId, latestRows, aliases);
  return { history, latest, aliases };
}

function buildEndpointPlans(
  survivorEps: readonly EndpointRow[],
  loserEps: readonly EndpointRow[],
): MergeEndpointPlanDto[] {
  const plans: MergeEndpointPlanDto[] = [];
  for (const kind of ALL_ENDPOINT_KINDS) {
    const sList = survivorEps.filter((e) => e.kind === kind);
    const lList = loserEps.filter((e) => e.kind === kind);
    if (sList.length === 0 && lList.length === 0) continue;

    const sActiveNorms = new Set(sList.filter((e) => e.retired_at === null).map((e) => e.value_norm));
    let collisionCount = 0;
    for (const ep of lList) {
      if (ep.retired_at === null && sActiveNorms.has(ep.value_norm)) {
        collisionCount += 1;
      }
    }

    const sPrimary = sList.find((e) => e.retired_at === null && e.is_primary === 1);
    const sFirstActive = sList.find((e) => e.retired_at === null);
    const lPrimary = lList.find((e) => e.retired_at === null && e.is_primary === 1);
    const lFirstActive = lList.find((e) => e.retired_at === null);

    plans.push({
      kind,
      survivorEndpoints: sList.map(mapEndpointSummary),
      loserEndpoints: lList.map(mapEndpointSummary),
      collisionCount,
      recommendedPrimaryId: (sPrimary ?? sFirstActive ?? lPrimary ?? lFirstActive)?.id ?? null,
    });
  }
  return plans;
}

/* ---------- GET /api/crm/read/merge-preview ---------- */

export async function readMergePreview(
  env: Env,
  actorId: string,
  tokenHash: string,
  survivorId: string,
  loserId: string,
): Promise<
  | { status: 200; body: MergePreviewResponse }
  | { status: 400 | 401 | 403 | 404; body: { error: string; detail?: Record<string, unknown> } }
> {
  const auth = await loadCrmReadContext(env, actorId, tokenHash, 'crm.merge', '*');
  if (!auth.ok) return { status: auth.status, body: auth.body };

  if (!survivorId || !loserId || survivorId === loserId || survivorId.length > 128 || loserId.length > 128) {
    return {
      status: 400,
      body: { error: 'invalid_input', detail: { reason: 'distinct_people_required' } },
    };
  }

  const gate = createReadGate(env.DB, actorId);
  const peopleMap = await loadReadableTaskRecords(env, gate, [survivorId, loserId]);
  const survivor = peopleMap.get(survivorId);
  const loser = peopleMap.get(loserId);
  if (!survivor || !loser) {
    return { status: 404, body: { error: 'not_found' } };
  }

  const boardIds = [
    ...new Set(
      [survivor.data.boardId, loser.data.boardId].filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];

  const batchNow = Date.now();
  const [
    sessionRes,
    grantsRes,
    boardsRes,
    aliasSelfRes,
    survivorAliasesRes,
    loserTransitiveRes,
    epRes,
    consRes,
    loserConvCountRes,
    dupRes,
    formKeysRes,
    linksRes,
    subRecsRes,
    commentsRes,
    filesRes,
    blocksCountRes,
    approvalsRes,
    suggestionsRes,
  ] = await env.DB.batch([
    sessionAuthStmt(env.DB, actorId, tokenHash, batchNow),
    actorGrantsStmt(env.DB, actorId),
    env.DB
      .prepare(`SELECT id, data FROM records WHERE collection = 'boards' AND id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(boardIds)),
    env.DB
      .prepare(`SELECT * FROM crm_person_aliases WHERE alias_id IN (?, ?)`)
      .bind(survivor.id, loser.id),
    env.DB
      .prepare(`SELECT * FROM crm_person_aliases WHERE survivor_id = ?`)
      .bind(survivor.id),
    env.DB
      .prepare(`SELECT * FROM crm_person_aliases WHERE survivor_id = ?`)
      .bind(loser.id),
    env.DB
      .prepare(`SELECT * FROM crm_endpoints WHERE person_id IN (?, ?) ORDER BY retired_at IS NOT NULL ASC, is_primary DESC, created_at ASC`)
      .bind(survivor.id, loser.id),
    env.DB
      .prepare(
        `SELECT id, person_id, channel, scope, status, source, evidence_ref, recorded_by, recorded_at
         FROM (
           SELECT c.*,
             ROW_NUMBER() OVER (
               PARTITION BY c.person_id, c.channel, c.scope
               ORDER BY c.recorded_at DESC, c.id DESC
             ) AS rn
           FROM crm_consents c
           WHERE c.person_id IN (?, ?)
              OR c.person_id IN (SELECT alias_id FROM crm_person_aliases WHERE survivor_id IN (?, ?))
         )
         WHERE rn = 1`,
      )
      .bind(survivor.id, loser.id, survivor.id, loser.id),
    env.DB
      .prepare(`SELECT COUNT(*) AS n FROM crm_conversations WHERE person_id = ?`)
      .bind(loser.id),
    env.DB
      .prepare(`SELECT * FROM crm_duplicate_candidates WHERE person_a_id = ? OR person_b_id = ?`)
      .bind(loser.id, loser.id),
    env.DB
      .prepare(`SELECT * FROM form_people_keys WHERE record_id = ?`)
      .bind(loser.id),
    env.DB
      .prepare(
        `SELECT id, data, seq FROM records
         WHERE collection = 'links'
           AND json_extract(data, '$.deleted') IS NOT 1
           AND (json_extract(data, '$.fromId') IN (?, ?) OR json_extract(data, '$.toId') IN (?, ?))`,
      )
      .bind(loser.id, survivor.id, loser.id, survivor.id),
    env.DB
      .prepare(
        `SELECT id FROM records
         WHERE collection = 'tasks'
           AND COALESCE(json_extract(data, '$.deleted'), 0) != 1
           AND json_extract(data, '$.parentId') = ?`,
      )
      .bind(loser.id),
    env.DB
      .prepare(
        `SELECT id FROM records
         WHERE collection = 'comments'
           AND COALESCE(json_extract(data, '$.deleted'), 0) != 1
           AND json_extract(data, '$.targetType') = 'task'
           AND json_extract(data, '$.targetId') = ?`,
      )
      .bind(loser.id),
    env.DB
      .prepare(
        `SELECT id FROM records
         WHERE collection = 'files'
           AND COALESCE(json_extract(data, '$.deleted'), 0) != 1
           AND json_extract(data, '$.parentType') = 'task'
           AND json_extract(data, '$.parentId') = ?`,
      )
      .bind(loser.id),
    env.DB
      .prepare(
        `SELECT COUNT(*) AS n FROM records
         WHERE collection = 'blocks'
           AND COALESCE(json_extract(data, '$.deleted'), 0) != 1
           AND json_extract(data, '$.pageId') = ?`,
      )
      .bind(loser.id),
    env.DB
      .prepare(`SELECT COUNT(*) AS n FROM approvals WHERE target_type = 'record' AND target_id = ? AND status = 'pending'`)
      .bind(loser.id),
    env.DB
      .prepare(`SELECT COUNT(*) AS n FROM ai_suggestions WHERE target_id = ? AND status = 'pending'`)
      .bind(loser.id),
  ]);

  const batchAuth = evaluateCrmReadAuthRows(
    sessionRes.results[0] as CrmSessionRow | undefined,
    grantsRes.results as unknown as CrmGrantRow[],
    'crm.merge',
    '*',
  );
  if (!batchAuth.ok) return { status: batchAuth.status, body: batchAuth.body };

  const finalAuth = await finalizeCrmReadAuth(env, actorId, tokenHash, {
    requiredCap: 'crm.merge',
    scope: '*',
    gate,
    deniedStatus: 404,
  });
  if (!finalAuth.ok) return { status: finalAuth.status, body: finalAuth.body };

  const boardsById = new Map<string, Record<string, unknown>>();
  for (const row of boardsRes.results as unknown as { id: string; data: string }[]) {
    const parsed = parseJsonSafe(row.data);
    if (parsed) boardsById.set(row.id, parsed);
  }
  const survivorBoard = typeof survivor.data.boardId === 'string' ? boardsById.get(survivor.data.boardId) : undefined;
  const loserBoard = typeof loser.data.boardId === 'string' ? boardsById.get(loser.data.boardId) : undefined;
  if (!isPeopleBoard(survivor.data.boardId, survivorBoard) || !isPeopleBoard(loser.data.boardId, loserBoard)) {
    return {
      status: 400,
      body: { error: 'invalid_input', detail: { reason: 'people_records_only' } },
    };
  }

  const allBoardFields = [...fieldsOf(survivorBoard), ...fieldsOf(loserBoard)];
  const fieldComparisons = comparePersonFields(allBoardFields, survivor.data, loser.data);

  const endpoints = epRes.results as unknown as EndpointRow[];
  const survivorEps = endpoints.filter((e) => e.person_id === survivor.id);
  const loserEps = endpoints.filter((e) => e.person_id === loser.id);
  const endpointPlans = buildEndpointPlans(survivorEps, loserEps);

  const consentRows = (consRes.results as unknown as ConsentRow[]).map(mapConsent);
  const sAliasMap = new Map<string, number>();
  for (const r of survivorAliasesRes.results as unknown as AliasRow[]) sAliasMap.set(r.alias_id, r.effective_at);
  const lAliasMap = new Map<string, number>();
  for (const r of loserTransitiveRes.results as unknown as AliasRow[]) lAliasMap.set(r.alias_id, r.effective_at);

  const sLatestConsents = resolveEffectiveConsentsWithAliases(survivor.id, consentRows, sAliasMap);
  const lLatestConsents = resolveEffectiveConsentsWithAliases(loser.id, consentRows, lAliasMap);
  const consentPreviews = computeEffectiveMergedConsents(sLatestConsents, lLatestConsents);

  const loserLinksCount = (linksRes.results as unknown as SyncedRow[]).filter((row) => {
    const d = parseJsonSafe(row.data);
    return d && (d.fromId === loser.id || d.toId === loser.id);
  }).length;
  const subCount = subRecsRes.results.length;
  const commentCount = commentsRes.results.length;
  const fileCount = filesRes.results.length;
  const blocksCount = Number((blocksCountRes.results[0] as { n: number } | undefined)?.n ?? 0);
  const convCount = Number((loserConvCountRes.results[0] as { n: number } | undefined)?.n ?? 0);
  const dupCount = dupRes.results.length;
  const formKeyCount = formKeysRes.results.length;
  const transCount = loserTransitiveRes.results.length;
  const pendingReviewCount =
    Number((approvalsRes.results[0] as { n: number } | undefined)?.n ?? 0) +
    Number((suggestionsRes.results[0] as { n: number } | undefined)?.n ?? 0);

  const referenceCounts: MergeReferenceCountsDto = {
    syncedRecords: 2 + loserLinksCount + subCount + fileCount,
    links: loserLinksCount,
    subRecords: subCount,
    comments: commentCount,
    files: fileCount,
    loserBlocksPreserved: blocksCount,
    endpoints: survivorEps.length + loserEps.length,
    consents: consentRows.length,
    conversations: convCount,
    duplicateCandidates: dupCount,
    formPeopleKeys: formKeyCount,
    transitiveAliases: transCount,
    approvalsAndSuggestions: pendingReviewCount,
  };

  const budget = checkMergeBudget(referenceCounts);
  const estBoundIds = 2 + subCount + fileCount + loserLinksCount * 2;
  const budgetReasons = [...budget.budgetReasons];
  if (estBoundIds > MAX_EXPECTED_ENTRIES) {
    budgetReasons.push(`atomic_commit_limit_exceeded:${estBoundIds}>${MAX_EXPECTED_ENTRIES}`);
  }

  const selfAliases = aliasSelfRes.results as unknown as AliasRow[];
  const alreadyMerged =
    selfAliases.length > 0 ||
    (typeof survivor.data._crm_merged_into === 'string' && survivor.data._crm_merged_into.length > 0) ||
    (typeof loser.data._crm_merged_into === 'string' && loser.data._crm_merged_into.length > 0) ||
    survivor.data.archived === true ||
    loser.data.archived === true;

  const warnings: string[] = [];
  if (alreadyMerged) {
    warnings.push('One of the selected records is already merged or archived.');
  }
  if (blocksCount > 0) {
    warnings.push(
      `The secondary person has ${blocksCount} page body block(s); these stay preserved on the archived alias record with a redirect banner.`,
    );
  }
  if (commentCount > 0) {
    warnings.push(
      `The secondary person has ${commentCount} comment(s); these stay preserved intact on the archived alias record for audit history.`,
    );
  }
  if (consentPreviews.some((c) => c.strictestApplied)) {
    warnings.push('A withdrawn consent on one record overrides granted consent on the other so consent is never broadened.');
  }
  if (pendingReviewCount > 0) {
    warnings.push(`${pendingReviewCount} pending approval/AI suggestion item(s) still reference the secondary record ID.`);
  }

  const sEmailEp = survivorEps.find((e) => e.kind === 'email' && e.retired_at === null && e.is_primary === 1) ?? survivorEps.find((e) => e.kind === 'email' && e.retired_at === null);
  const sPhoneEp = survivorEps.find((e) => e.kind === 'phone' && e.retired_at === null && e.is_primary === 1) ?? survivorEps.find((e) => e.kind === 'phone' && e.retired_at === null);
  const lEmailEp = loserEps.find((e) => e.kind === 'email' && e.retired_at === null && e.is_primary === 1) ?? loserEps.find((e) => e.kind === 'email' && e.retired_at === null);
  const lPhoneEp = loserEps.find((e) => e.kind === 'phone' && e.retired_at === null && e.is_primary === 1) ?? loserEps.find((e) => e.kind === 'phone' && e.retired_at === null);

  return {
    status: 200,
    body: MergePreviewResponseSchema.parse({
      survivor: {
        id: survivor.id,
        title: extractTitle(survivor.data),
        rev: survivor.seq,
        archived: survivor.data.archived === true,
        mergedInto: typeof survivor.data._crm_merged_into === 'string' ? survivor.data._crm_merged_into : null,
        primaryEmail:
          (typeof survivor.data._crm_primary_email === 'string' ? survivor.data._crm_primary_email : null) ??
          sEmailEp?.value_norm ??
          null,
        primaryPhone:
          (typeof survivor.data._crm_primary_phone === 'string' ? survivor.data._crm_primary_phone : null) ??
          sPhoneEp?.value_norm ??
          null,
      },
      loser: {
        id: loser.id,
        title: extractTitle(loser.data),
        rev: loser.seq,
        archived: loser.data.archived === true,
        mergedInto: typeof loser.data._crm_merged_into === 'string' ? loser.data._crm_merged_into : null,
        primaryEmail:
          (typeof loser.data._crm_primary_email === 'string' ? loser.data._crm_primary_email : null) ??
          lEmailEp?.value_norm ??
          null,
        primaryPhone:
          (typeof loser.data._crm_primary_phone === 'string' ? loser.data._crm_primary_phone : null) ??
          lPhoneEp?.value_norm ??
          null,
      },
      alreadyMerged,
      fieldComparisons,
      endpointPlans,
      consentPreviews,
      referenceCounts,
      withinBudget: budgetReasons.length === 0,
      budgetReasons,
      warnings,
    }),
  };
}

/* ---------- GET /api/crm/read/merges ---------- */

export async function readMergeHistory(
  env: Env,
  actorId: string,
  tokenHash: string,
  opts: { cursor?: string; personId?: string } = {},
): Promise<
  | { status: 200; body: MergeHistoryPageResponse }
  | { status: 400 | 401 | 403 | 404; body: { error: string } }
> {
  if (!isCrmEnabled(env)) {
    return { status: 404, body: { error: 'not_found' } };
  }

  const cursor = opts.cursor !== undefined ? decodeTimeIdCursor(opts.cursor) : null;
  if (opts.cursor !== undefined && !cursor) {
    return { status: 400, body: { error: 'invalid_cursor' } };
  }

  const personFilter = opts.personId?.trim() || null;
  const batchNow = Date.now();
  const sql = `SELECT
      m.id, m.survivor_id, m.merged_id, m.actor_id, m.command_id, m.moved_json, m.note, m.created_at,
      rs.data AS survivor_data, rs.seq AS survivor_seq, rm.data AS merged_data, rm.seq AS merged_seq,
      ua.name AS actor_name,
      mu.unmerge_id, mu.actor_id AS unmerge_actor_id, uu.name AS unmerge_actor_name, mu.reason AS unmerge_reason, mu.created_at AS unmerged_at
    FROM crm_merges m
    LEFT JOIN crm_merge_unmerges mu ON mu.merge_id = m.id
    LEFT JOIN users ua ON ua.id = m.actor_id
    LEFT JOIN users uu ON uu.id = mu.actor_id
    LEFT JOIN records rs ON rs.id = m.survivor_id
    LEFT JOIN records rm ON rm.id = m.merged_id
    WHERE (?1 IS NULL OR m.survivor_id = ?1 OR m.merged_id = ?1)
      AND (?2 IS NULL OR m.created_at < ?2 OR (m.created_at = ?2 AND m.id < ?3))
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ?4`;

  const [sessionRes, grantsRes, res] = await env.DB.batch([
    sessionAuthStmt(env.DB, actorId, tokenHash, batchNow),
    actorGrantsStmt(env.DB, actorId),
    env.DB
      .prepare(sql)
      .bind(personFilter, cursor?.ts ?? null, cursor?.id ?? null, MERGE_HISTORY_PAGE_LIMIT + 1),
  ]);

  const batchAuth = evaluateCrmReadAuthRows(
    sessionRes.results[0] as CrmSessionRow | undefined,
    grantsRes.results as unknown as CrmGrantRow[],
    'crm.merge',
    '*',
  );
  if (!batchAuth.ok) return { status: batchAuth.status, body: batchAuth.body };

  interface HistoryRow {
    id: string;
    survivor_id: string;
    merged_id: string;
    actor_id: string;
    command_id: string;
    moved_json: string;
    note: string | null;
    created_at: number;
    survivor_data: string | null;
    survivor_seq: number | null;
    merged_data: string | null;
    merged_seq: number | null;
    actor_name: string | null;
    unmerge_id: string | null;
    unmerge_actor_id: string | null;
    unmerge_actor_name: string | null;
    unmerge_reason: string | null;
    unmerged_at: number | null;
  }

  const rows = res.results as unknown as HistoryRow[];
  const hasMore = rows.length > MERGE_HISTORY_PAGE_LIMIT;
  const page = hasMore ? rows.slice(0, MERGE_HISTORY_PAGE_LIMIT) : rows;
  const gate = createReadGate(env.DB, actorId);
  const allPersonIds = [...new Set(page.flatMap((r) => [r.survivor_id, r.merged_id]))];
  const readableSet = allPersonIds.length
    ? new Set((await gate.filter(allPersonIds.map((id) => ({ id })))).map((r) => r.id))
    : new Set<string>();

  const finalAuth = await finalizeCrmReadAuth(env, actorId, tokenHash, {
    requiredCap: 'crm.merge',
    scope: '*',
    gate,
  });
  if (!finalAuth.ok) return { status: finalAuth.status, body: finalAuth.body };

  let partial = hasMore;
  const items: MergeHistoryItemDto[] = [];
  for (const r of page) {
    if (!readableSet.has(r.survivor_id) || !readableSet.has(r.merged_id)) {
      partial = true;
      continue;
    }
    const moved = parseJsonSafe(r.moved_json) as Partial<MergeJournalMovedPayload> | null;
    const sData = parseJsonSafe(r.survivor_data);
    const mData = parseJsonSafe(r.merged_data);
    const fallbackCounts: MergeMovedCountsDto = {
      fieldsCopied: 0,
      linksMoved: 0,
      linksDeduplicated: 0,
      selfLinksRemoved: 0,
      subRecordsMoved: 0,
      commentsMoved: 0,
      filesMoved: 0,
      endpointsMoved: 0,
      endpointsRetiredDuplicate: 0,
      conversationsMoved: 0,
      duplicateCandidatesUpdated: 0,
      formPeopleKeysMoved: 0,
      transitiveAliasesUpdated: 0,
    };

    items.push({
      id: r.id,
      survivorId: r.survivor_id,
      survivorTitle: sData && sData.deleted !== true ? extractTitle(sData) : null,
      survivorRev: typeof r.survivor_seq === 'number' && sData && sData.deleted !== true ? r.survivor_seq : null,
      mergedId: r.merged_id,
      mergedTitle: mData && mData.deleted !== true ? extractTitle(mData) : null,
      mergedRev: typeof r.merged_seq === 'number' && mData && mData.deleted !== true ? r.merged_seq : null,
      actorId: r.actor_id,
      actorName: r.actor_name,
      commandId: r.command_id,
      note: r.note,
      movedCounts: moved?.movedCounts ?? fallbackCounts,
      createdAt: r.created_at,
      unmerged: r.unmerge_id
        ? {
            unmergeId: r.unmerge_id,
            actorId: r.unmerge_actor_id!,
            actorName: r.unmerge_actor_name,
            reason: r.unmerge_reason,
            createdAt: r.unmerged_at!,
          }
        : null,
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

/* ---------- Command: person.merge ---------- */

function mergePersonCommand(): CommandDefinition<PersonMergeInput, PersonMergeOutput> {
  return {
    name: 'person.merge',
    projectionKeys: [
      CRM_PROJECTION.mergedInto,
      CRM_PROJECTION.primaryEmail,
      CRM_PROJECTION.primaryPhone,
      CRM_PROJECTION.endpointCount,
      CRM_PROJECTION.consentSummary,
      CRM_PROJECTION.openConversations,
      CRM_PROJECTION.lastContactAt,
      CRM_PROJECTION.lastOutboundAt,
    ],
    authorizeCoarse: (actor, via) =>
      via === 'ui' && canAccessCrmApi(actor) && evaluateCapability(actor, 'crm.merge', '*'),
    parseInput: (raw) => {
      const parsed = PersonMergeInputSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: 'invalid_input', detail: { fields: parseZodErrors(parsed.error) } };
      }
      if (parsed.data.survivorId === parsed.data.loserId) {
        return { ok: false, error: 'invalid_input', detail: { reason: 'cannot_merge_same_person' } };
      }
      return { ok: true, input: parsed.data };
    },
    authorizeReplay: async (actor, input, stored, { env, via }) => {
      if (via !== 'ui' || !canAccessCrmApi(actor) || !evaluateCapability(actor, 'crm.merge', '*')) {
        return false;
      }
      const gate = createReadGate(env.DB, actor.id);
      const projIds =
        stored && stored.ok === true && Array.isArray(stored.projections)
          ? stored.projections.map((p) => p.recordId).filter((id): id is string => typeof id === 'string' && id.length > 0)
          : [];
      const allIds = [...new Set([input.survivorId, input.loserId, ...projIds])];
      const decision = await gate.decideEditable(allIds);
      if (!decision.principalActive) return false;
      if (!decision.readable.has(input.survivorId) || !decision.readable.has(input.loserId)) return false;
      if (!decision.editable.has(input.survivorId) || !decision.editable.has(input.loserId)) return false;
      for (const pid of projIds) {
        if (!decision.readable.has(pid)) return false;
      }
      return true;
    },
    plan: async ({ env, actor, tokenHash, input, expected, commandId, now }) => {
      const gate = createReadGate(env.DB, actor.id);
      const peopleMap = await loadReadableTaskRecords(env, gate, [input.survivorId, input.loserId]);
      const survivor = peopleMap.get(input.survivorId);
      const loser = peopleMap.get(input.loserId);
      if (!survivor || !loser) {
        return { kind: 'refuse', error: 'not_found' };
      }

      const expectedSurvivorRev = expected?.get(survivor.id);
      const expectedLoserRev = expected?.get(loser.id);
      if (
        expectedSurvivorRev === undefined ||
        expectedLoserRev === undefined ||
        !Number.isSafeInteger(expectedSurvivorRev) ||
        !Number.isSafeInteger(expectedLoserRev) ||
        expectedSurvivorRev < 0 ||
        expectedLoserRev < 0
      ) {
        return {
          kind: 'refuse',
          error: 'invalid_input',
          detail: { reason: 'expected_revisions_required', requiredIds: [survivor.id, loser.id] },
        };
      }
      if (expectedSurvivorRev !== survivor.seq) {
        return { kind: 'refuse', error: 'stale', detail: { reason: 'survivor_revision_changed' } };
      }
      if (expectedLoserRev !== loser.seq) {
        return { kind: 'refuse', error: 'stale', detail: { reason: 'loser_revision_changed' } };
      }

      const boardIds = [
        ...new Set(
          [survivor.data.boardId, loser.data.boardId].filter((id): id is string => typeof id === 'string' && id.length > 0),
        ),
      ];

      const [
        boardsRes,
        selfAliasesRes,
        survivorAliasesRes,
        loserTransitiveRes,
        epRes,
        consRes,
        consCountRes,
        convsRes,
        dupRes,
        formKeysRes,
        linksRes,
        subRecsRes,
        commentsRes,
        filesRes,
      ] = await env.DB.batch([
        env.DB
          .prepare(`SELECT id, data FROM records WHERE collection = 'boards' AND id IN (SELECT value FROM json_each(?))`)
          .bind(JSON.stringify(boardIds)),
        env.DB
          .prepare(`SELECT * FROM crm_person_aliases WHERE alias_id IN (?, ?)`)
          .bind(survivor.id, loser.id),
        env.DB
          .prepare(`SELECT * FROM crm_person_aliases WHERE survivor_id = ?`)
          .bind(survivor.id),
        env.DB
          .prepare(`SELECT * FROM crm_person_aliases WHERE survivor_id = ?`)
          .bind(loser.id),
        env.DB
          .prepare(`SELECT * FROM crm_endpoints WHERE person_id IN (?, ?) ORDER BY retired_at IS NOT NULL ASC, is_primary DESC, created_at ASC, id ASC`)
          .bind(survivor.id, loser.id),
        env.DB
          .prepare(
            `SELECT id, person_id, channel, scope, status, source, evidence_ref, recorded_by, recorded_at
             FROM (
               SELECT c.*,
                 ROW_NUMBER() OVER (
                   PARTITION BY c.person_id, c.channel, c.scope
                   ORDER BY c.recorded_at DESC, c.id DESC
                 ) AS rn
               FROM crm_consents c
               WHERE c.person_id IN (?, ?)
                  OR c.person_id IN (SELECT alias_id FROM crm_person_aliases WHERE survivor_id IN (?, ?))
             )
             WHERE rn = 1`,
          )
          .bind(survivor.id, loser.id, survivor.id, loser.id),
        env.DB
          .prepare(
            `SELECT COUNT(*) AS n FROM crm_consents c
             WHERE c.person_id IN (?, ?)
                OR c.person_id IN (SELECT alias_id FROM crm_person_aliases WHERE survivor_id IN (?, ?))`,
          )
          .bind(survivor.id, loser.id, survivor.id, loser.id),
        env.DB
          .prepare(`SELECT id, person_id, state, last_message_at, last_outbound_at, rev FROM crm_conversations WHERE person_id IN (?, ?)`)
          .bind(survivor.id, loser.id),
        env.DB
          .prepare(`SELECT * FROM crm_duplicate_candidates WHERE person_a_id IN (?, ?) OR person_b_id IN (?, ?)`)
          .bind(survivor.id, loser.id, survivor.id, loser.id),
        env.DB
          .prepare(`SELECT * FROM form_people_keys WHERE record_id = ?`)
          .bind(loser.id),
        env.DB
          .prepare(
            `SELECT id, collection, data, seq FROM records
             WHERE collection = 'links'
               AND json_extract(data, '$.deleted') IS NOT 1
               AND (json_extract(data, '$.fromId') IN (?, ?) OR json_extract(data, '$.toId') IN (?, ?))`,
          )
          .bind(survivor.id, loser.id, survivor.id, loser.id),
        env.DB
          .prepare(
            `SELECT id, collection, data, seq FROM records
             WHERE collection = 'tasks'
               AND COALESCE(json_extract(data, '$.deleted'), 0) != 1
               AND json_extract(data, '$.parentId') = ?`,
          )
          .bind(loser.id),
        env.DB
          .prepare(
            `SELECT id, collection, data, seq FROM records
             WHERE collection = 'comments'
               AND COALESCE(json_extract(data, '$.deleted'), 0) != 1
               AND json_extract(data, '$.targetType') = 'task'
               AND json_extract(data, '$.targetId') = ?`,
          )
          .bind(loser.id),
        env.DB
          .prepare(
            `SELECT id, collection, data, seq FROM records
             WHERE collection = 'files'
               AND COALESCE(json_extract(data, '$.deleted'), 0) != 1
               AND json_extract(data, '$.parentType') = 'task'
               AND json_extract(data, '$.parentId') = ?`,
          )
          .bind(loser.id),
      ]);

      const boardsById = new Map<string, Record<string, unknown>>();
      for (const row of boardsRes.results as unknown as { id: string; data: string }[]) {
        const parsed = parseJsonSafe(row.data);
        if (parsed) boardsById.set(row.id, parsed);
      }
      const survivorBoard = typeof survivor.data.boardId === 'string' ? boardsById.get(survivor.data.boardId) : undefined;
      const loserBoard = typeof loser.data.boardId === 'string' ? boardsById.get(loser.data.boardId) : undefined;
      if (!isPeopleBoard(survivor.data.boardId, survivorBoard) || !isPeopleBoard(loser.data.boardId, loserBoard)) {
        return {
          kind: 'refuse',
          error: 'invalid_input',
          detail: { reason: 'people_records_only' },
        };
      }

      const selfAliases = selfAliasesRes.results as unknown as AliasRow[];
      if (
        selfAliases.length > 0 ||
        (typeof survivor.data._crm_merged_into === 'string' && survivor.data._crm_merged_into.length > 0) ||
        (typeof loser.data._crm_merged_into === 'string' && loser.data._crm_merged_into.length > 0)
      ) {
        return { kind: 'refuse', error: 'stale', detail: { reason: 'already_merged' } };
      }
      if (survivor.data.archived === true || loser.data.archived === true) {
        return { kind: 'refuse', error: 'invalid_input', detail: { reason: 'record_archived' } };
      }

      const allEndpoints = epRes.results as unknown as EndpointRow[];
      const survivorEps = allEndpoints.filter((e) => e.person_id === survivor.id);
      const loserEps = allEndpoints.filter((e) => e.person_id === loser.id);
      const allConvs = convsRes.results as unknown as ConversationSummaryRow[];
      const survivorConvs = allConvs.filter((c) => c.person_id === survivor.id);
      const loserConvs = allConvs.filter((c) => c.person_id === loser.id);
      const allDups = dupRes.results as unknown as DuplicateCandidateRow[];
      const loserDups = allDups.filter((d) => d.person_a_id === loser.id || d.person_b_id === loser.id);
      const formKeys = formKeysRes.results as unknown as FormPeopleKeyRow[];
      const transitiveAliases = loserTransitiveRes.results as unknown as AliasRow[];
      const allLinks = linksRes.results as unknown as SyncedRow[];
      const loserLinks = allLinks.filter((l) => {
        const d = parseJsonSafe(l.data);
        return d && (d.fromId === loser.id || d.toId === loser.id);
      });
      const subRecs = subRecsRes.results as unknown as SyncedRow[];
      const commentCount = commentsRes.results.length;
      const files = filesRes.results as unknown as SyncedRow[];

      const refCounts: MergeReferenceCountsDto = {
        syncedRecords: 2 + loserLinks.length + subRecs.length + files.length,
        links: loserLinks.length,
        subRecords: subRecs.length,
        comments: commentCount,
        files: files.length,
        loserBlocksPreserved: 0,
        endpoints: survivorEps.length + loserEps.length,
        consents: consRes.results.length,
        conversations: loserConvs.length,
        duplicateCandidates: loserDups.length,
        formPeopleKeys: formKeys.length,
        transitiveAliases: transitiveAliases.length,
        approvalsAndSuggestions: 0,
      };
      const budget = checkMergeBudget(refCounts);
      if (!budget.withinBudget) {
        return {
          kind: 'refuse',
          error: 'budget_exceeded',
          detail: { budgetReasons: budget.budgetReasons, referenceCounts: refCounts },
        };
      }

      // Field comparison & resolution
      const comparisons = comparePersonFields([...fieldsOf(survivorBoard), ...fieldsOf(loserBoard)], survivor.data, loser.data);
      const fieldPlan = computeMergedFieldPatch(comparisons, survivor.data, loser.data, input.fieldResolutions);
      if (!fieldPlan.ok) {
        return {
          kind: 'refuse',
          error: 'invalid_input',
          detail: { reason: fieldPlan.reason, key: fieldPlan.key },
        };
      }

      // Validate explicit primary endpoint selections if provided
      if (input.primaryEndpoints) {
        for (const [kind, epId] of Object.entries(input.primaryEndpoints) as [CrmEndpointKind, string][]) {
          if (!epId) continue;
          const candidates = [...survivorEps, ...loserEps].map(mapEndpointSummary);
          if (!validatePrimaryEndpointChoice(kind, epId, candidates)) {
            return {
              kind: 'refuse',
              error: 'invalid_input',
              detail: { reason: 'invalid_primary_endpoint', kind, endpointId: epId },
            };
          }
        }
      }

      // Plan endpoints reconciliation (at most 1 active primary per (survivor, kind); exact duplicate active norms retired)
      const movedEndpoints: MergeJournalMovedPayload['movedEndpoints'] = [];
      const demoteStmts: D1PreparedStatement[] = [];
      const repointEndpointStmts: D1PreparedStatement[] = [];
      const finalActiveEndpoints: Pick<EndpointRow, 'kind' | 'value_norm' | 'is_primary'>[] = [];
      let endpointsMovedCount = 0;
      let endpointsRetiredDuplicateCount = 0;

      for (const kind of ALL_ENDPOINT_KINDS) {
        const sKind = survivorEps.filter((e) => e.kind === kind);
        const lKind = loserEps.filter((e) => e.kind === kind);
        const sActive = sKind.filter((e) => e.retired_at === null);
        const lActive = lKind.filter((e) => e.retired_at === null);
        const sNorms = new Set(sActive.map((e) => e.value_norm));

        const lDuplicates: EndpointRow[] = [];
        const lMoveActive: EndpointRow[] = [];
        for (const ep of lActive) {
          if (sNorms.has(ep.value_norm)) {
            lDuplicates.push(ep);
          } else {
            lMoveActive.push(ep);
          }
        }

        const requestedPrimaryId = input.primaryEndpoints?.[kind];
        const duplicateSet = new Set(lDuplicates.map((e) => e.id));
        const survivingPool = [...sActive, ...lMoveActive];
        let winnerPrimaryId: string | null = null;
        if (requestedPrimaryId && survivingPool.some((e) => e.id === requestedPrimaryId)) {
          winnerPrimaryId = requestedPrimaryId;
        } else {
          winnerPrimaryId =
            (
              sActive.find((e) => e.is_primary === 1) ??
              sActive[0] ??
              lMoveActive.find((e) => e.is_primary === 1) ??
              lMoveActive[0]
            )?.id ?? null;
        }

        // First retire loser duplicate active endpoints & demote displaced primaries so unique index stays satisfied!
        for (const ep of lDuplicates) {
          endpointsRetiredDuplicateCount += 1;
          movedEndpoints.push({
            id: ep.id,
            priorPersonId: loser.id,
            priorIsPrimary: ep.is_primary,
            priorRetiredAt: null,
            postIsPrimary: 0,
            postRetiredAt: now,
            postUpdatedAt: now,
            action: 'retired_duplicate',
          });
          demoteStmts.push(
            env.DB
              .prepare(
                `UPDATE crm_endpoints SET person_id = ?, is_primary = 0, retired_at = ?, updated_at = ?
                 WHERE id = ? AND person_id = ? AND retired_at IS NULL AND updated_at = ?`,
              )
              .bind(survivor.id, now, now, ep.id, loser.id, ep.updated_at),
            changesOneFence(env.DB),
          );
        }

        // Demote any active survivor endpoint if it was primary and is no longer winner
        for (const ep of sActive) {
          const nextPrimary = ep.id === winnerPrimaryId ? 1 : 0;
          if (ep.is_primary !== nextPrimary) {
            movedEndpoints.push({
              id: ep.id,
              priorPersonId: survivor.id,
              priorIsPrimary: ep.is_primary,
              priorRetiredAt: null,
              postIsPrimary: nextPrimary,
              postRetiredAt: null,
              postUpdatedAt: now,
              action: 'demoted_primary',
            });
            demoteStmts.push(
              env.DB
                .prepare(
                  `UPDATE crm_endpoints SET is_primary = ?, updated_at = ?
                   WHERE id = ? AND person_id = ? AND retired_at IS NULL AND updated_at = ?`,
                )
                .bind(nextPrimary, now, ep.id, survivor.id, ep.updated_at),
              changesOneFence(env.DB),
            );
          }
          finalActiveEndpoints.push({ kind: ep.kind, value_norm: ep.value_norm, is_primary: nextPrimary });
        }

        // Demote displaced active loser primary BEFORE repointing if another endpoint is becoming primary
        for (const ep of [...lKind]) {
          if (duplicateSet.has(ep.id)) continue;
          const nextPrimary = ep.retired_at === null && ep.id === winnerPrimaryId ? 1 : 0;
          if (ep.retired_at === null) {
            finalActiveEndpoints.push({ kind: ep.kind, value_norm: ep.value_norm, is_primary: nextPrimary });
          }
          endpointsMovedCount += 1;
          movedEndpoints.push({
            id: ep.id,
            priorPersonId: loser.id,
            priorIsPrimary: ep.is_primary,
            priorRetiredAt: ep.retired_at,
            postIsPrimary: nextPrimary,
            postRetiredAt: ep.retired_at,
            postUpdatedAt: now,
            action: 'repointed',
          });
          repointEndpointStmts.push(
            env.DB
              .prepare(
                `UPDATE crm_endpoints SET person_id = ?, is_primary = ?, updated_at = ?
                 WHERE id = ? AND person_id = ? AND updated_at = ?`,
              )
              .bind(survivor.id, nextPrimary, now, ep.id, loser.id, ep.updated_at),
            changesOneFence(env.DB),
          );
        }
      }

      // Compute links changes + detect collisions and self-links
      const activeSurvivorLinkSeqById = new Map<string, number>();
      for (const l of allLinks) {
        const d = parseJsonSafe(l.data);
        if (!d) continue;
        if (d.fromId === survivor.id || d.toId === survivor.id) {
          activeSurvivorLinkSeqById.set(l.id, l.seq);
        }
      }

      const candidateNewLinkIds: string[] = [];
      const linkPlans: {
        oldRow: SyncedRow;
        oldData: Record<string, unknown>;
        newLinkId: string | null;
        existedActiveOnSurvivor: boolean;
      }[] = [];

      for (const row of loserLinks) {
        const d = parseJsonSafe(row.data);
        if (!d) continue;
        const kind = typeof d.kind === 'string' ? d.kind : 'related';
        const fieldId = typeof d.fieldId === 'string' ? d.fieldId : null;
        const nextFrom = d.fromId === loser.id ? survivor.id : String(d.fromId ?? '');
        const nextTo = d.toId === loser.id ? survivor.id : String(d.toId ?? '');
        if (!nextFrom || !nextTo || nextFrom === nextTo) {
          linkPlans.push({ oldRow: row, oldData: d, newLinkId: null, existedActiveOnSurvivor: false });
          continue;
        }
        const computedId = linkId(kind, fieldId, nextFrom, nextTo);
        const existedActiveOnSurvivor = activeSurvivorLinkSeqById.has(computedId);
        if (!existedActiveOnSurvivor) {
          candidateNewLinkIds.push(computedId);
          activeSurvivorLinkSeqById.set(computedId, -1);
        }
        linkPlans.push({
          oldRow: row,
          oldData: d,
          newLinkId: computedId,
          existedActiveOnSurvivor,
        });
      }

      // Fetch any pre-existing soft-deleted rows for candidateNewLinkIds so recordExpect has exact seq (-1 if absent)
      const existingTargetLinks = new Map<string, { seq: number; data: Record<string, unknown> }>();
      const uniqueNewLinkIds = [...new Set(candidateNewLinkIds)];
      if (uniqueNewLinkIds.length > 0) {
        const targetRes = await env.DB
          .prepare(`SELECT id, data, seq FROM records WHERE id IN (SELECT value FROM json_each(?))`)
          .bind(JSON.stringify(uniqueNewLinkIds))
          .all<SyncedRow>();
        for (const tr of targetRes.results) {
          const td = parseJsonSafe(tr.data) ?? {};
          existingTargetLinks.set(tr.id, { seq: tr.seq, data: td });
        }
      }

      const records: Mutation[] = [];
      const recordExpect = new Map<string, number>([
        [survivor.id, survivor.seq],
        [loser.id, loser.seq],
      ]);
      const movedLinksJournal: MergeJournalMovedPayload['movedLinks'] = [];
      let linksMovedCount = 0;
      let linksDeduplicatedCount = 0;
      let selfLinksRemovedCount = 0;

      for (const lp of linkPlans) {
        recordExpect.set(lp.oldRow.id, lp.oldRow.seq);
        records.push({
          id: lp.oldRow.id,
          collection: 'links',
          patch: { deleted: true },
          ts: now,
        });
        if (!lp.newLinkId) {
          selfLinksRemovedCount += 1;
          movedLinksJournal.push({
            oldLinkId: lp.oldRow.id,
            oldData: lp.oldData,
            newLinkId: null,
            existedOnSurvivorBefore: false,
          });
        } else if (lp.existedActiveOnSurvivor) {
          linksDeduplicatedCount += 1;
          const survSeq = activeSurvivorLinkSeqById.get(lp.newLinkId);
          if (survSeq !== undefined && survSeq >= 0) {
            recordExpect.set(lp.newLinkId, survSeq);
          }
          movedLinksJournal.push({
            oldLinkId: lp.oldRow.id,
            oldData: lp.oldData,
            newLinkId: lp.newLinkId,
            existedOnSurvivorBefore: true,
          });
        } else {
          linksMovedCount += 1;
          const prevTarget = existingTargetLinks.get(lp.newLinkId);
          if (prevTarget) {
            recordExpect.set(lp.newLinkId, prevTarget.seq);
          }
          const nextFrom = lp.oldData.fromId === loser.id ? survivor.id : String(lp.oldData.fromId);
          const nextTo = lp.oldData.toId === loser.id ? survivor.id : String(lp.oldData.toId);
          records.push({
            id: lp.newLinkId,
            collection: 'links',
            patch: {
              fromType: (lp.oldData.fromType as string | undefined) ?? 'record',
              fromId: nextFrom,
              toType: (lp.oldData.toType as string | undefined) ?? 'record',
              toId: nextTo,
              kind: (lp.oldData.kind as string | undefined) ?? 'related',
              fieldId: lp.oldData.fieldId ?? null,
              createdBy: actor.id,
              createdAt: now,
              deleted: false,
            },
            ts: now,
          });
          movedLinksJournal.push({
            oldLinkId: lp.oldRow.id,
            oldData: lp.oldData,
            newLinkId: lp.newLinkId,
            existedOnSurvivorBefore: false,
          });
        }
      }

      const movedSubRecordIds: { id: string; preRev: number }[] = [];
      for (const sr of subRecs) {
        const d = parseJsonSafe(sr.data);
        recordExpect.set(sr.id, sr.seq);
        movedSubRecordIds.push({ id: sr.id, preRev: sr.seq });
        records.push({
          id: sr.id,
          collection: 'tasks',
          patch: {
            parentId: survivor.id,
            ...(d && typeof survivor.data.boardId === 'string' && d.boardId !== survivor.data.boardId
              ? { boardId: survivor.data.boardId }
              : {}),
          },
          ts: now,
        });
      }

      // Comments remain immutable & preserved intact on the archived loser record (Phase 5 targetId protection)
      const movedCommentIds: { id: string; preRev: number }[] = [];

      const movedFileIds: { id: string; preRev: number }[] = [];
      for (const fl of files) {
        recordExpect.set(fl.id, fl.seq);
        movedFileIds.push({ id: fl.id, preRev: fl.seq });
        records.push({
          id: fl.id,
          collection: 'files',
          patch: { parentId: survivor.id },
          ts: now,
        });
      }

      // Enforce Workspace single-batch limit (`<= MAX_EXPECTED_ENTRIES = 100`) cleanly with `budget_exceeded`
      const uniqueRecordIds = new Set([...recordExpect.keys(), ...records.map((r) => r.id)]);
      if (uniqueRecordIds.size + 2 > MAX_EXPECTED_ENTRIES) {
        return {
          kind: 'refuse',
          error: 'budget_exceeded',
          detail: {
            budgetReasons: [`atomic_commit_limit_exceeded:${uniqueRecordIds.size + 2}>${MAX_EXPECTED_ENTRIES}`],
            referenceCounts: refCounts,
          },
        };
      }

      // Compute alias-aware consents with loser added at effective_at = now (non-broadening!)
      const consentRows = (consRes.results as unknown as ConsentRow[]).map(mapConsent);
      const nextSurvivorAliases = new Map<string, number>();
      for (const a of survivorAliasesRes.results as unknown as AliasRow[]) nextSurvivorAliases.set(a.alias_id, a.effective_at);
      nextSurvivorAliases.set(loser.id, now);
      for (const a of transitiveAliases) nextSurvivorAliases.set(a.alias_id, now);
      const effectiveLatestConsents = resolveEffectiveConsentsWithAliases(survivor.id, consentRows, nextSurvivorAliases);

      const mergedConvs = [...survivorConvs, ...loserConvs];
      const survivorProjection = buildPersonProjectionPatch({
        activeEndpoints: finalActiveEndpoints,
        latestConsents: effectiveLatestConsents,
        conversations: mergedConvs,
        boardData: survivorBoard,
        includeEmailPhoneFields: true,
      });

      const mergedSurvivorPatch: Record<string, unknown> = {
        ...fieldPlan.survivorPatch,
        ...survivorProjection,
      };
      // Track any overwritten primary Email/Phone field keys in priorSurvivorValues too
      const priorSurvivorValues = { ...fieldPlan.priorSurvivorValues };
      for (const k of Object.keys(survivorProjection)) {
        if (k.startsWith('p_') && !(k in priorSurvivorValues)) {
          priorSurvivorValues[k] = k in survivor.data ? survivor.data[k] : null;
        }
      }

      records.push(
        {
          id: survivor.id,
          collection: 'tasks',
          patch: mergedSurvivorPatch,
          ts: now,
        },
        {
          id: loser.id,
          collection: 'tasks',
          patch: {
            archived: true,
            [CRM_PROJECTION.mergedInto]: survivor.id,
            [CRM_PROJECTION.primaryEmail]: null,
            [CRM_PROJECTION.primaryPhone]: null,
            [CRM_PROJECTION.endpointCount]: 0,
            [CRM_PROJECTION.openConversations]: 0,
          },
          ts: now,
        },
      );

      // Duplicate candidates updates
      const dupStmts: D1PreparedStatement[] = [];
      const dupJournal: MergeJournalMovedPayload['duplicateUpdates'] = [];
      const [directA, directB] = canonicalPersonPair(survivor.id, loser.id);
      const existingSurvivorPairs = new Set<string>();
      for (const d of allDups) {
        if (d.person_a_id === survivor.id || d.person_b_id === survivor.id) {
          existingSurvivorPairs.add(`${d.person_a_id}\0${d.person_b_id}`);
        }
      }

      for (const d of loserDups) {
        if (d.person_a_id === directA && d.person_b_id === directB) {
          const postNote = input.note?.trim() || d.note;
          dupJournal.push({
            id: d.id,
            priorPersonAId: d.person_a_id,
            priorPersonBId: d.person_b_id,
            priorState: d.state,
            priorDecidedBy: d.decided_by,
            priorDecidedAt: d.decided_at,
            priorNote: d.note,
            postPersonAId: d.person_a_id,
            postPersonBId: d.person_b_id,
            postState: 'merged',
            postDecidedBy: actor.id,
            postDecidedAt: now,
            postNote,
            action: 'marked_merged',
          });
          dupStmts.push(
            env.DB
              .prepare(
                `UPDATE crm_duplicate_candidates
                 SET state = 'merged', decided_by = ?, decided_at = ?, note = COALESCE(?, note)
                 WHERE id = ? AND person_a_id = ? AND person_b_id = ? AND state = ?
                   AND COALESCE(decided_by, '') = ? AND COALESCE(decided_at, -1) = ?`,
              )
              .bind(
                actor.id,
                now,
                input.note?.trim() || null,
                d.id,
                d.person_a_id,
                d.person_b_id,
                d.state,
                d.decided_by ?? '',
                d.decided_at ?? -1,
              ),
            changesOneFence(env.DB),
          );
          continue;
        }

        const otherId = d.person_a_id === loser.id ? d.person_b_id : d.person_a_id;
        const [nextA, nextB] = canonicalPersonPair(survivor.id, otherId);
        const pairKey = `${nextA}\0${nextB}`;
        if (existingSurvivorPairs.has(pairKey)) {
          dupJournal.push({
            id: d.id,
            priorPersonAId: d.person_a_id,
            priorPersonBId: d.person_b_id,
            priorState: d.state,
            priorDecidedBy: d.decided_by,
            priorDecidedAt: d.decided_at,
            priorNote: d.note,
            postPersonAId: d.person_a_id,
            postPersonBId: d.person_b_id,
            postState: 'merged',
            postDecidedBy: actor.id,
            postDecidedAt: now,
            postNote: d.note,
            action: 'marked_merged',
          });
          dupStmts.push(
            env.DB
              .prepare(
                `UPDATE crm_duplicate_candidates
                 SET state = 'merged', decided_by = ?, decided_at = ?
                 WHERE id = ? AND person_a_id = ? AND person_b_id = ? AND state = ?
                   AND COALESCE(decided_by, '') = ? AND COALESCE(decided_at, -1) = ?`,
              )
              .bind(
                actor.id,
                now,
                d.id,
                d.person_a_id,
                d.person_b_id,
                d.state,
                d.decided_by ?? '',
                d.decided_at ?? -1,
              ),
            changesOneFence(env.DB),
          );
        } else {
          existingSurvivorPairs.add(pairKey);
          dupJournal.push({
            id: d.id,
            priorPersonAId: d.person_a_id,
            priorPersonBId: d.person_b_id,
            priorState: d.state,
            priorDecidedBy: d.decided_by,
            priorDecidedAt: d.decided_at,
            priorNote: d.note,
            postPersonAId: nextA,
            postPersonBId: nextB,
            postState: d.state,
            postDecidedBy: d.decided_by,
            postDecidedAt: d.decided_at,
            postNote: d.note,
            action: 'repointed',
          });
          dupStmts.push(
            env.DB
              .prepare(
                `UPDATE crm_duplicate_candidates
                 SET person_a_id = ?, person_b_id = ?
                 WHERE id = ? AND person_a_id = ? AND person_b_id = ? AND state = ?
                   AND COALESCE(decided_by, '') = ? AND COALESCE(decided_at, -1) = ?`,
              )
              .bind(
                nextA,
                nextB,
                d.id,
                d.person_a_id,
                d.person_b_id,
                d.state,
                d.decided_by ?? '',
                d.decided_at ?? -1,
              ),
            changesOneFence(env.DB),
          );
        }
      }

      // Conversations repoint
      const convStmts: D1PreparedStatement[] = [];
      const movedConversationIds: { id: string; preRev: number }[] = [];
      for (const c of loserConvs) {
        movedConversationIds.push({ id: c.id, preRev: c.rev });
        convStmts.push(
          env.DB
            .prepare(
              `UPDATE crm_conversations
               SET person_id = ?, rev = rev + 1, updated_at = ?
               WHERE id = ? AND person_id = ? AND rev = ?`,
            )
            .bind(survivor.id, now, c.id, loser.id, c.rev),
          changesOneFence(env.DB),
        );
      }

      // form_people_keys repoint
      const fkStmts: D1PreparedStatement[] = [];
      const movedFormPeopleKeys: MergeJournalMovedPayload['movedFormPeopleKeys'] = [];
      for (const fk of formKeys) {
        movedFormPeopleKeys.push({
          databaseId: fk.database_id,
          fieldKey: fk.field_key,
          email: fk.email,
          priorRecordId: fk.record_id,
        });
        fkStmts.push(
          env.DB
            .prepare(
              `UPDATE form_people_keys
               SET record_id = ?
               WHERE database_id = ? AND field_key = ? AND email = ? AND record_id = ?`,
            )
            .bind(survivor.id, fk.database_id, fk.field_key, fk.email, loser.id),
          changesOneFence(env.DB),
        );
      }

      // Transitive aliases repoint
      const aliasStmts: D1PreparedStatement[] = [];
      const transitiveJournal: MergeJournalMovedPayload['transitiveAliases'] = [];
      for (const ta of transitiveAliases) {
        transitiveJournal.push({
          aliasId: ta.alias_id,
          priorSurvivorId: ta.survivor_id,
          priorMergeId: ta.merge_id,
          priorEffectiveAt: ta.effective_at,
        });
        aliasStmts.push(
          env.DB
            .prepare(
              `UPDATE crm_person_aliases
               SET survivor_id = ?, effective_at = ?
               WHERE alias_id = ? AND survivor_id = ?`,
            )
            .bind(survivor.id, now, ta.alias_id, loser.id),
          changesOneFence(env.DB),
        );
      }

      const mergeId = `mrg_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const movedCounts: MergeMovedCountsDto = {
        fieldsCopied: fieldPlan.fieldsCopied,
        linksMoved: linksMovedCount,
        linksDeduplicated: linksDeduplicatedCount,
        selfLinksRemoved: selfLinksRemovedCount,
        subRecordsMoved: movedSubRecordIds.length,
        commentsMoved: movedCommentIds.length,
        filesMoved: movedFileIds.length,
        endpointsMoved: endpointsMovedCount,
        endpointsRetiredDuplicate: endpointsRetiredDuplicateCount,
        conversationsMoved: movedConversationIds.length,
        duplicateCandidatesUpdated: dupJournal.length,
        formPeopleKeysMoved: movedFormPeopleKeys.length,
        transitiveAliasesUpdated: transitiveJournal.length,
      };

      const journalPayload: MergeJournalMovedPayload = {
        version: 1,
        preSurvivorRev: survivor.seq,
        preLoserRev: loser.seq,
        survivorPatchedKeys: Object.keys(mergedSurvivorPatch).sort(),
        priorSurvivorValues,
        priorLoserArchived: loser.data.archived === true ? true : null,
        priorLoserMergedInto: typeof loser.data._crm_merged_into === 'string' ? loser.data._crm_merged_into : null,
        movedLinks: movedLinksJournal,
        movedSubRecordIds,
        movedCommentIds,
        movedFileIds,
        movedEndpoints,
        movedConversationIds,
        duplicateUpdates: dupJournal,
        movedFormPeopleKeys,
        transitiveAliases: transitiveJournal,
        movedCounts,
      };

      const allTouchedRecordIds = [...new Set([...records.map((r) => r.id)])].sort();

      const rows: D1PreparedStatement[] = [
        ...demoteStmts,
        ...repointEndpointStmts,
        ...convStmts,
        ...dupStmts,
        ...fkStmts,
        ...aliasStmts,
        env.DB
          .prepare(
            `INSERT INTO crm_person_aliases (alias_id, survivor_id, merge_id, effective_at, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(loser.id, survivor.id, mergeId, now, actor.id, now),
        env.DB
          .prepare(
            `INSERT INTO crm_merges (id, survivor_id, merged_id, actor_id, command_id, moved_json, post_record_revs_json, note, created_at)
             VALUES (
               ?, ?, ?, ?, ?, ?,
               COALESCE(
                 (SELECT json_group_object(id, seq) FROM records WHERE id IN (SELECT value FROM json_each(?))),
                 json('{}')
               ),
               ?, ?
             )`,
          )
          .bind(
            mergeId,
            survivor.id,
            loser.id,
            actor.id,
            commandId,
            JSON.stringify(journalPayload),
            JSON.stringify(allTouchedRecordIds),
            input.note?.trim() || null,
            now,
          ),
      ];

      const totalConsentCount = Number((consCountRes.results[0] as { n: number } | undefined)?.n ?? 0);
      const maxEpUpdatedAt = allEndpoints.reduce((max, e) => (e.updated_at > max ? e.updated_at : max), 0);
      const activeEpCount = allEndpoints.filter((e) => e.retired_at === null).length;
      const openConvCount = allConvs.filter((c) => c.state === 'open').length;
      const loserLinkIds = loserLinks.map((l) => l.id);
      const subRecIds = subRecs.map((s) => s.id);
      const fileIds = files.map((f) => f.id);
      const brandNewLinkIds = uniqueNewLinkIds.filter((id) => !existingTargetLinks.has(id));
      const survivorAliasCount = (survivorAliasesRes.results as unknown as AliasRow[]).length;

      // Fence the COMPLETE affected reference set (synced + operational) against concurrent additions and changes!
      const fences = [
        () => crmActorFence(env.DB, actor, tokenHash, 'crm.merge', '*'),
        () =>
          env.DB
            .prepare(
              `SELECT CASE WHEN NOT EXISTS (
                 SELECT 1 FROM crm_person_aliases WHERE alias_id IN (?, ?)
               ) THEN 1 ELSE json_extract('{', '$') END`,
            )
            .bind(survivor.id, loser.id),
        () =>
          env.DB
            .prepare(
              `SELECT CASE WHEN
                 (SELECT COUNT(*) FROM crm_endpoints WHERE person_id IN (?1, ?2)) = ?3
                 AND (SELECT COALESCE(SUM(CASE WHEN retired_at IS NULL THEN 1 ELSE 0 END), 0) FROM crm_endpoints WHERE person_id IN (?1, ?2)) = ?4
                 AND (SELECT COALESCE(MAX(updated_at), 0) FROM crm_endpoints WHERE person_id IN (?1, ?2)) = ?5
                 AND (SELECT COUNT(*) FROM crm_conversations WHERE person_id = ?2) = ?6
                 AND (SELECT COUNT(*) FROM crm_conversations WHERE person_id IN (?1, ?2)) = ?7
                 AND (SELECT COALESCE(SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END), 0) FROM crm_conversations WHERE person_id IN (?1, ?2)) = ?8
                 AND (SELECT COUNT(*) FROM crm_duplicate_candidates WHERE person_a_id IN (?1, ?2) OR person_b_id IN (?1, ?2)) = ?9
                 AND (SELECT COUNT(*) FROM form_people_keys WHERE record_id = ?2) = ?10
                 AND (SELECT COUNT(*) FROM crm_person_aliases WHERE survivor_id = ?1) = ?11
                 AND (SELECT COUNT(*) FROM crm_person_aliases WHERE survivor_id = ?2) = ?12
                 AND (SELECT COUNT(*) FROM crm_consents c
                      WHERE c.person_id IN (?1, ?2)
                         OR c.person_id IN (SELECT alias_id FROM crm_person_aliases WHERE survivor_id IN (?1, ?2))) = ?13
               THEN 1 ELSE json_extract('{', '$') END`,
            )
            .bind(
              survivor.id,
              loser.id,
              allEndpoints.length,
              activeEpCount,
              maxEpUpdatedAt,
              loserConvs.length,
              allConvs.length,
              openConvCount,
              allDups.length,
              formKeys.length,
              survivorAliasCount,
              transitiveAliases.length,
              totalConsentCount,
            ),
        () =>
          env.DB
            .prepare(
              `SELECT CASE WHEN
                 (SELECT COUNT(*) FROM records
                  WHERE collection = 'links'
                    AND json_extract(data, '$.deleted') IS NOT 1
                    AND (json_extract(data, '$.fromId') = ?1 OR json_extract(data, '$.toId') = ?1)) = ?2
                 AND NOT EXISTS (
                   SELECT 1 FROM records
                   WHERE collection = 'links'
                     AND json_extract(data, '$.deleted') IS NOT 1
                     AND (json_extract(data, '$.fromId') = ?1 OR json_extract(data, '$.toId') = ?1)
                     AND id NOT IN (SELECT value FROM json_each(?3))
                 )
                 AND (SELECT COUNT(*) FROM records
                      WHERE collection = 'tasks'
                        AND COALESCE(json_extract(data, '$.deleted'), 0) != 1
                        AND json_extract(data, '$.parentId') = ?1) = ?4
                 AND NOT EXISTS (
                   SELECT 1 FROM records
                   WHERE collection = 'tasks'
                     AND COALESCE(json_extract(data, '$.deleted'), 0) != 1
                     AND json_extract(data, '$.parentId') = ?1
                     AND id NOT IN (SELECT value FROM json_each(?5))
                 )
                 AND (SELECT COUNT(*) FROM records
                      WHERE collection = 'files'
                        AND COALESCE(json_extract(data, '$.deleted'), 0) != 1
                        AND json_extract(data, '$.parentType') = 'task'
                        AND json_extract(data, '$.parentId') = ?1) = ?6
                 AND NOT EXISTS (
                   SELECT 1 FROM records
                   WHERE collection = 'files'
                     AND COALESCE(json_extract(data, '$.deleted'), 0) != 1
                     AND json_extract(data, '$.parentType') = 'task'
                     AND json_extract(data, '$.parentId') = ?1
                     AND id NOT IN (SELECT value FROM json_each(?7))
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM records
                   WHERE id IN (SELECT value FROM json_each(?8))
                 )
               THEN 1 ELSE json_extract('{', '$') END`,
            )
            .bind(
              loser.id,
              loserLinks.length,
              JSON.stringify(loserLinkIds),
              subRecs.length,
              JSON.stringify(subRecIds),
              files.length,
              JSON.stringify(fileIds),
              JSON.stringify(brandNewLinkIds),
            ),
      ];

      return {
        kind: 'commit',
        result: {
          mergeId,
          survivorId: survivor.id,
          mergedId: loser.id,
          movedCounts,
        },
        fences,
        rows,
        records,
        recordExpect,
        serverTs: true,
      };
    },
    mapConstraintError: () => ({
      ok: false,
      error: 'stale',
      retryable: true,
    }),
    afterCommit: ({ env, executionCtx }) => {
      pokeLive(env, executionCtx);
    },
  };
}

/* ---------- Command: person.unmerge ---------- */

function unmergePersonCommand(): CommandDefinition<PersonUnmergeInput, PersonUnmergeOutput> {
  return {
    name: 'person.unmerge',
    projectionKeys: [
      CRM_PROJECTION.mergedInto,
      CRM_PROJECTION.primaryEmail,
      CRM_PROJECTION.primaryPhone,
      CRM_PROJECTION.endpointCount,
      CRM_PROJECTION.consentSummary,
      CRM_PROJECTION.openConversations,
      CRM_PROJECTION.lastContactAt,
      CRM_PROJECTION.lastOutboundAt,
    ],
    // Contract docs/crm/07-CONTRACTS.md §129: crm.merge + admin (owner | admin)
    authorizeCoarse: (actor, via) =>
      via === 'ui' &&
      canAccessCrmApi(actor) &&
      (actor.role === 'owner' || actor.role === 'admin') &&
      evaluateCapability(actor, 'crm.merge', '*'),
    parseInput: (raw) => {
      const parsed = PersonUnmergeInputSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: 'invalid_input', detail: { fields: parseZodErrors(parsed.error) } };
      }
      return { ok: true, input: parsed.data };
    },
    authorizeReplay: async (actor, input, stored, { env, via }) => {
      if (
        via !== 'ui' ||
        !canAccessCrmApi(actor) ||
        (actor.role !== 'owner' && actor.role !== 'admin') ||
        !evaluateCapability(actor, 'crm.merge', '*')
      ) {
        return false;
      }
      const merge = await env.DB
        .prepare(`SELECT survivor_id, merged_id FROM crm_merges WHERE id = ?`)
        .bind(input.mergeId)
        .first<{ survivor_id: string; merged_id: string }>();
      if (!merge) return false;
      const projIds =
        stored && stored.ok === true && Array.isArray(stored.projections)
          ? stored.projections.map((p) => p.recordId).filter((id): id is string => typeof id === 'string' && id.length > 0)
          : [];
      const gate = createReadGate(env.DB, actor.id);
      const allIds = [...new Set([merge.survivor_id, merge.merged_id, ...projIds])];
      const decision = await gate.decideEditable(allIds);
      if (!decision.principalActive) return false;
      if (!decision.readable.has(merge.survivor_id) || !decision.readable.has(merge.merged_id)) return false;
      if (!decision.editable.has(merge.survivor_id) || !decision.editable.has(merge.merged_id)) return false;
      for (const pid of projIds) {
        if (!decision.readable.has(pid)) return false;
      }
      return true;
    },
    plan: async ({ env, actor, tokenHash, input, expected, commandId, now }) => {
      const [mergeRow, existingUnmerge] = await env.DB.batch([
        env.DB.prepare(`SELECT * FROM crm_merges WHERE id = ?`).bind(input.mergeId),
        env.DB.prepare(`SELECT * FROM crm_merge_unmerges WHERE merge_id = ?`).bind(input.mergeId),
      ]);
      const merge = mergeRow.results[0] as unknown as MergeJournalRow | undefined;
      if (!merge) return { kind: 'refuse', error: 'not_found' };

      const alreadyUnmerged = existingUnmerge.results[0] as unknown as UnmergeRow | undefined;
      if (alreadyUnmerged) {
        return {
          kind: 'refuse',
          error: 'stale',
          detail: {
            reason: 'already_unmerged',
            conflicts: [
              {
                code: 'already_unmerged',
                entityId: merge.id,
                message: 'This merge has already been reversed.',
              },
            ],
          },
        };
      }

      const gate = createReadGate(env.DB, actor.id);
      const peopleMap = await loadReadableTaskRecords(env, gate, [merge.survivor_id, merge.merged_id]);
      const survivor = peopleMap.get(merge.survivor_id);
      const loser = peopleMap.get(merge.merged_id);
      if (!survivor || !loser) {
        return { kind: 'refuse', error: 'not_found' };
      }

      const expectedSurvivorRev = expected?.get(survivor.id);
      const expectedLoserRev = expected?.get(loser.id);
      if (
        expectedSurvivorRev === undefined ||
        expectedLoserRev === undefined ||
        !Number.isSafeInteger(expectedSurvivorRev) ||
        !Number.isSafeInteger(expectedLoserRev) ||
        expectedSurvivorRev < 0 ||
        expectedLoserRev < 0
      ) {
        return {
          kind: 'refuse',
          error: 'invalid_input',
          detail: { reason: 'expected_revisions_required', requiredIds: [survivor.id, loser.id] },
        };
      }
      if (expectedSurvivorRev !== survivor.seq) {
        return { kind: 'refuse', error: 'stale', detail: { reason: 'survivor_revision_changed' } };
      }
      if (expectedLoserRev !== loser.seq) {
        return { kind: 'refuse', error: 'stale', detail: { reason: 'loser_revision_changed' } };
      }

      const moved = parseJsonSafe(merge.moved_json) as MergeJournalMovedPayload | null;
      const postRevsRaw = parseJsonSafe(merge.post_record_revs_json);
      if (!moved || moved.version !== 1 || !postRevsRaw) {
        return { kind: 'refuse', error: 'invalid_input', detail: { reason: 'corrupt_merge_journal' } };
      }

      const postRevs = new Map<string, number>();
      for (const [k, v] of Object.entries(postRevsRaw)) {
        if (typeof v === 'number' && Number.isSafeInteger(v)) postRevs.set(k, v);
      }

      const watchedRecordIds = [...new Set([survivor.id, loser.id, ...postRevs.keys()])];
      const movedEndpointIds = moved.movedEndpoints.map((e) => e.id);
      const movedConvIds = moved.movedConversationIds.map((c) => c.id);
      const movedDupIds = moved.duplicateUpdates.map((d) => d.id);
      const movedFkEmails = [...new Set(moved.movedFormPeopleKeys.map((fk) => fk.email))];
      const boardIds = [
        ...new Set(
          [survivor.data.boardId, loser.data.boardId].filter((id): id is string => typeof id === 'string' && id.length > 0),
        ),
      ];

      const [
        boardsRes,
        laterMergesRes,
        aliasesCheckRes,
        watchedRecsRes,
        currentEpsRes,
        bothPeopleEpsRes,
        survivorAllAliasesRes,
        consRes,
        postMergeConsRes,
        currentConvsRes,
        survivorAndLoserConvsRes,
        currentDupsRes,
        allRelatedDupsRes,
        currentFormKeysRes,
      ] = await env.DB.batch([
        env.DB
          .prepare(`SELECT id, data FROM records WHERE collection = 'boards' AND id IN (SELECT value FROM json_each(?))`)
          .bind(JSON.stringify(boardIds)),
        env.DB
          .prepare(
            `SELECT m.id, m.created_at, m.post_record_revs_json FROM crm_merges m
             LEFT JOIN crm_merge_unmerges u ON u.merge_id = m.id
             WHERE u.merge_id IS NULL
               AND m.id != ?
               AND (m.survivor_id IN (?, ?) OR m.merged_id IN (?, ?))`,
          )
          .bind(merge.id, survivor.id, loser.id, survivor.id, loser.id),
        env.DB
          .prepare(`SELECT * FROM crm_person_aliases WHERE alias_id = ? OR survivor_id IN (?, ?)`)
          .bind(loser.id, survivor.id, loser.id),
        env.DB
          .prepare(`SELECT id, collection, data, seq FROM records WHERE id IN (SELECT value FROM json_each(?))`)
          .bind(JSON.stringify(watchedRecordIds)),
        env.DB
          .prepare(`SELECT * FROM crm_endpoints WHERE id IN (SELECT value FROM json_each(?))`)
          .bind(JSON.stringify(movedEndpointIds)),
        env.DB
          .prepare(`SELECT * FROM crm_endpoints WHERE person_id IN (?, ?)`)
          .bind(survivor.id, loser.id),
        env.DB
          .prepare(`SELECT * FROM crm_person_aliases WHERE survivor_id = ? AND merge_id != ?`)
          .bind(survivor.id, merge.id),
        env.DB
          .prepare(
            `SELECT id, person_id, channel, scope, status, source, evidence_ref, recorded_by, recorded_at
             FROM (
               SELECT c.*,
                 ROW_NUMBER() OVER (
                   PARTITION BY c.person_id, c.channel, c.scope
                   ORDER BY c.recorded_at DESC, c.id DESC
                 ) AS rn
               FROM crm_consents c
               WHERE c.person_id IN (?, ?)
                  OR c.person_id IN (SELECT alias_id FROM crm_person_aliases WHERE survivor_id IN (?, ?) AND merge_id != ?)
             )
             WHERE rn = 1`,
          )
          .bind(survivor.id, loser.id, survivor.id, loser.id, merge.id),
        env.DB
          .prepare(
            `SELECT id, person_id, channel, scope, status, recorded_at FROM crm_consents
             WHERE person_id IN (?, ?) AND recorded_at > ?`,
          )
          .bind(survivor.id, loser.id, merge.created_at),
        env.DB
          .prepare(`SELECT id, person_id, state, last_message_at, last_outbound_at, rev FROM crm_conversations WHERE id IN (SELECT value FROM json_each(?))`)
          .bind(JSON.stringify(movedConvIds)),
        env.DB
          .prepare(`SELECT id, person_id, state, last_message_at, last_outbound_at, rev FROM crm_conversations WHERE person_id IN (?, ?)`)
          .bind(survivor.id, loser.id),
        env.DB
          .prepare(`SELECT * FROM crm_duplicate_candidates WHERE id IN (SELECT value FROM json_each(?))`)
          .bind(JSON.stringify(movedDupIds)),
        env.DB
          .prepare(`SELECT * FROM crm_duplicate_candidates WHERE person_a_id IN (?, ?) OR person_b_id IN (?, ?)`)
          .bind(survivor.id, loser.id, survivor.id, loser.id),
        env.DB
          .prepare(`SELECT * FROM form_people_keys WHERE email IN (SELECT value FROM json_each(?))`)
          .bind(JSON.stringify(movedFkEmails)),
      ]);

      // Revision-aware conflict detection
      const conflicts: UnmergeConflictDto[] = [];
      const myMaxPostRev = Math.max(0, ...postRevs.values());
      for (const lm of laterMergesRes.results as unknown as { id: string; created_at: number; post_record_revs_json: string }[]) {
        const lmPostRevs = parseJsonSafe(lm.post_record_revs_json) ?? {};
        const lmMaxPostRev = Math.max(
          0,
          ...Object.values(lmPostRevs).filter((v): v is number => typeof v === 'number'),
        );
        if (lm.created_at > merge.created_at || (lm.created_at === merge.created_at && lmMaxPostRev > myMaxPostRev)) {
          conflicts.push({
            code: 'later_merge_depends_on_record',
            entityId: lm.id,
            message: 'A subsequent un-reversed merge involves one of these contacts; reverse the newer merge first.',
          });
          break;
        }
      }

      const aliasRows = aliasesCheckRes.results as unknown as AliasRow[];
      const loserAlias = aliasRows.find((a) => a.alias_id === loser.id);
      if (!loserAlias || loserAlias.merge_id !== merge.id || loserAlias.survivor_id !== survivor.id) {
        conflicts.push({
          code: 'later_merge_depends_on_record',
          entityId: loser.id,
          message: 'Alias mapping changed after this merge.',
        });
      }
      for (const ta of moved.transitiveAliases) {
        const curTa = aliasRows.find((a) => a.alias_id === ta.aliasId);
        if (!curTa || curTa.survivor_id !== survivor.id || curTa.effective_at !== merge.created_at) {
          conflicts.push({
            code: 'later_merge_depends_on_record',
            entityId: ta.aliasId,
            message: `Transitive alias ${ta.aliasId} changed after merge.`,
          });
        }
      }

      const currentRecsById = new Map<string, SyncedRow>();
      for (const r of watchedRecsRes.results as unknown as SyncedRow[]) {
        currentRecsById.set(r.id, r);
      }

      for (const [recId, expectedPostRev] of postRevs) {
        const cur = currentRecsById.get(recId);
        if (!cur) {
          conflicts.push({
            code: 'missing_record',
            entityId: recId,
            message: `Referenced record ${recId} no longer exists.`,
          });
        } else if (cur.seq !== expectedPostRev) {
          if (recId === survivor.id) {
            conflicts.push({
              code: 'survivor_edited',
              entityId: survivor.id,
              message: `Survivor record changed independently (rev ${expectedPostRev} -> ${cur.seq}).`,
            });
          } else if (recId === loser.id) {
            conflicts.push({
              code: 'loser_edited',
              entityId: loser.id,
              message: `Archived record changed independently (rev ${expectedPostRev} -> ${cur.seq}).`,
            });
          } else {
            conflicts.push({
              code: 'link_modified',
              entityId: recId,
              message: `Linked record or attachment ${recId} changed independently (rev ${expectedPostRev} -> ${cur.seq}).`,
            });
          }
        }
      }

      // Check operational endpoint state changes (including primary flag, retirement, updated_at, new endpoints on loser, or collisions)
      const currentEpById = new Map<string, EndpointRow>();
      for (const ep of currentEpsRes.results as unknown as EndpointRow[]) {
        currentEpById.set(ep.id, ep);
      }
      const bothPeopleEps = bothPeopleEpsRes.results as unknown as EndpointRow[];
      const movedEpIdSet = new Set(movedEndpointIds);

      for (const ep of bothPeopleEps) {
        if (ep.person_id === loser.id) {
          conflicts.push({
            code: 'endpoint_reassigned',
            entityId: ep.id,
            message: `Archived record gained endpoint ${ep.value_norm} after merge.`,
          });
        } else if (!movedEpIdSet.has(ep.id) && ep.updated_at > merge.created_at) {
          conflicts.push({
            code: 'endpoint_reassigned',
            entityId: ep.id,
            message: `Survivor endpoint ${ep.value_norm} was added or modified after merge.`,
          });
        }
      }

      const unretiringNorms: { id: string; kind: CrmEndpointKind; valueNorm: string }[] = [];
      for (const me of moved.movedEndpoints) {
        const cur = currentEpById.get(me.id);
        if (!cur) {
          conflicts.push({
            code: 'endpoint_reassigned',
            entityId: me.id,
            message: `Contact endpoint ${me.id} no longer exists.`,
          });
          continue;
        }
        const expectedPostRetiredAt =
          me.postRetiredAt !== undefined
            ? me.postRetiredAt
            : me.action === 'retired_duplicate'
              ? merge.created_at
              : me.priorRetiredAt;
        const expectedPostUpdatedAt = me.postUpdatedAt ?? merge.created_at;
        if (cur.person_id !== survivor.id) {
          conflicts.push({
            code: 'endpoint_reassigned',
            entityId: me.id,
            message: `Contact endpoint ${cur.value_norm} was reassigned to another person.`,
          });
        } else if (cur.retired_at !== expectedPostRetiredAt) {
          conflicts.push({
            code: 'endpoint_reassigned',
            entityId: me.id,
            message: `Contact endpoint ${cur.value_norm} retirement state changed after merge.`,
          });
        } else if (me.postIsPrimary !== undefined && cur.is_primary !== me.postIsPrimary) {
          conflicts.push({
            code: 'endpoint_reassigned',
            entityId: me.id,
            message: `Contact endpoint ${cur.value_norm} primary selection changed after merge.`,
          });
        } else if (cur.updated_at !== expectedPostUpdatedAt) {
          conflicts.push({
            code: 'endpoint_reassigned',
            entityId: me.id,
            message: `Contact endpoint ${cur.value_norm} was modified after merge.`,
          });
        }
        if (me.action === 'retired_duplicate' && me.priorRetiredAt === null) {
          unretiringNorms.push({ id: me.id, kind: cur.kind, valueNorm: cur.value_norm });
        }
      }

      if (unretiringNorms.length > 0) {
        const collisionRes = await env.DB
          .prepare(
            `SELECT id, kind, value_norm FROM crm_endpoints
             WHERE retired_at IS NULL AND value_norm IN (SELECT value FROM json_each(?))`,
          )
          .bind(JSON.stringify([...new Set(unretiringNorms.map((u) => u.valueNorm))]))
          .all<{ id: string; kind: string; value_norm: string }>();
        for (const u of unretiringNorms) {
          const collider = collisionRes.results.find((c) => c.kind === u.kind && c.value_norm === u.valueNorm && c.id !== u.id);
          if (collider) {
            conflicts.push({
              code: 'endpoint_reassigned',
              entityId: u.id,
              message: `Cannot un-retire duplicate endpoint ${u.valueNorm}; active endpoint ${collider.id} already holds this value.`,
            });
          }
        }
      }

      // Check operational conversation state changes
      const currentConvById = new Map<string, ConversationSummaryRow>();
      for (const c of currentConvsRes.results as unknown as ConversationSummaryRow[]) {
        currentConvById.set(c.id, c);
      }
      for (const mc of moved.movedConversationIds) {
        const cur = currentConvById.get(mc.id);
        if (!cur || cur.person_id !== survivor.id || cur.rev !== mc.preRev + 1) {
          conflicts.push({
            code: 'conversation_edited',
            entityId: mc.id,
            message: `Conversation ${mc.id} was modified after the merge.`,
          });
        }
      }
      for (const c of survivorAndLoserConvsRes.results as unknown as ConversationSummaryRow[]) {
        if (c.person_id === loser.id) {
          conflicts.push({
            code: 'conversation_edited',
            entityId: c.id,
            message: `Archived record gained conversation ${c.id} after merge.`,
          });
        }
      }

      // Check operational duplicate candidate decision/state changes
      const currentDupById = new Map<string, DuplicateCandidateRow>();
      for (const d of currentDupsRes.results as unknown as DuplicateCandidateRow[]) {
        currentDupById.set(d.id, d);
      }
      const allRelatedDups = allRelatedDupsRes.results as unknown as DuplicateCandidateRow[];
      const expectedDupPostById = new Map<
        string,
        { a: string; b: string; state: string; decidedBy: string | null; decidedAt: number | null; note: string | null }
      >();
      for (const du of moved.duplicateUpdates) {
        const cur = currentDupById.get(du.id);
        if (!cur) {
          conflicts.push({
            code: 'duplicate_changed',
            entityId: du.id,
            message: `Duplicate candidate ${du.id} no longer exists.`,
          });
          continue;
        }
        const otherId = du.priorPersonAId === loser.id ? du.priorPersonBId : du.priorPersonAId;
        const [fallbackRepointA, fallbackRepointB] = canonicalPersonPair(survivor.id, otherId);
        const expA = du.postPersonAId ?? (du.action === 'repointed' ? fallbackRepointA : du.priorPersonAId);
        const expB = du.postPersonBId ?? (du.action === 'repointed' ? fallbackRepointB : du.priorPersonBId);
        const expState = du.postState ?? (du.action === 'marked_merged' ? 'merged' : du.priorState);
        const expDecidedBy = du.postDecidedBy !== undefined ? du.postDecidedBy : du.action === 'marked_merged' ? merge.actor_id : du.priorDecidedBy;
        const expDecidedAt = du.postDecidedAt !== undefined ? du.postDecidedAt : du.action === 'marked_merged' ? merge.created_at : du.priorDecidedAt;
        const expNote = du.postNote !== undefined ? du.postNote : du.priorNote;
        expectedDupPostById.set(du.id, {
          a: expA,
          b: expB,
          state: expState,
          decidedBy: expDecidedBy,
          decidedAt: expDecidedAt,
          note: expNote,
        });

        if (
          cur.person_a_id !== expA ||
          cur.person_b_id !== expB ||
          cur.state !== expState ||
          cur.decided_by !== expDecidedBy ||
          cur.decided_at !== expDecidedAt ||
          (du.postNote !== undefined && cur.note !== expNote)
        ) {
          conflicts.push({
            code: 'duplicate_changed',
            entityId: du.id,
            message: `Duplicate decision for ${du.id} changed after merge.`,
          });
        } else if (du.action === 'repointed') {
          const colliding = allRelatedDups.find(
            (other) => other.id !== du.id && other.person_a_id === du.priorPersonAId && other.person_b_id === du.priorPersonBId,
          );
          if (colliding) {
            conflicts.push({
              code: 'duplicate_changed',
              entityId: du.id,
              message: `Restoring duplicate pair collides with existing candidate ${colliding.id}.`,
            });
          }
        }
      }

      // Check operational form_people_keys identity mappings
      const currentFks = currentFormKeysRes.results as unknown as FormPeopleKeyRow[];
      for (const fk of moved.movedFormPeopleKeys) {
        const cur = currentFks.find(
          (row) => row.database_id === fk.databaseId && row.field_key === fk.fieldKey && row.email === fk.email,
        );
        if (!cur || cur.record_id !== survivor.id) {
          conflicts.push({
            code: 'form_identity_changed',
            entityId: `${fk.databaseId}:${fk.fieldKey}:${fk.email}`,
            message: `Website form identity mapping for ${fk.email} changed after merge.`,
          });
        }
      }

      // Check post-merge consent rows recorded on survivor or loser
      for (const pc of postMergeConsRes.results as unknown as { id: string; person_id: string }[]) {
        conflicts.push({
          code: 'consent_changed',
          entityId: pc.id,
          message: `Consent ${pc.id} was recorded on ${pc.person_id} after merge.`,
        });
      }

      if (conflicts.length > 0) {
        return {
          kind: 'refuse',
          error: 'stale',
          detail: {
            reason: 'unmerge_conflicts',
            conflicts,
          },
        };
      }

      // Clean state: plan lossless atomic reversal!
      const boardsById = new Map<string, Record<string, unknown>>();
      for (const row of boardsRes.results as unknown as { id: string; data: string }[]) {
        const parsed = parseJsonSafe(row.data);
        if (parsed) boardsById.set(row.id, parsed);
      }
      const survivorBoard = typeof survivor.data.boardId === 'string' ? boardsById.get(survivor.data.boardId) : undefined;
      const loserBoard = typeof loser.data.boardId === 'string' ? boardsById.get(loser.data.boardId) : undefined;

      // Recompute survivor & loser restored active endpoints + consents + conversations
      const movedEpMap = new Map(moved.movedEndpoints.map((m) => [m.id, m]));
      const survivorCurrentActiveEps = bothPeopleEps.filter((e) => e.person_id === survivor.id && e.retired_at === null);
      const restoredSurvivorActiveEps: Pick<EndpointRow, 'kind' | 'value_norm' | 'is_primary'>[] = [];
      const restoredLoserActiveEps: Pick<EndpointRow, 'kind' | 'value_norm' | 'is_primary'>[] = [];

      for (const ep of survivorCurrentActiveEps) {
        const m = movedEpMap.get(ep.id);
        if (!m) {
          restoredSurvivorActiveEps.push({ kind: ep.kind, value_norm: ep.value_norm, is_primary: ep.is_primary });
        } else if (m.priorPersonId === survivor.id) {
          restoredSurvivorActiveEps.push({ kind: ep.kind, value_norm: ep.value_norm, is_primary: m.priorIsPrimary });
        }
      }
      for (const m of moved.movedEndpoints) {
        const cur = currentEpById.get(m.id);
        if (!cur) continue;
        if (m.priorPersonId === loser.id && m.priorRetiredAt === null) {
          restoredLoserActiveEps.push({ kind: cur.kind, value_norm: cur.value_norm, is_primary: m.priorIsPrimary });
        }
      }

      const consentRows = (consRes.results as unknown as ConsentRow[]).map(mapConsent);
      const remainingSurvivorAliases = new Map<string, number>();
      for (const a of survivorAllAliasesRes.results as unknown as AliasRow[]) {
        remainingSurvivorAliases.set(a.alias_id, a.effective_at);
      }
      const loserRestoredAliases = new Map<string, number>();
      for (const ta of moved.transitiveAliases) {
        loserRestoredAliases.set(ta.aliasId, ta.priorEffectiveAt);
      }

      const sRestoredConsents = resolveEffectiveConsentsWithAliases(survivor.id, consentRows, remainingSurvivorAliases);
      const lRestoredConsents = resolveEffectiveConsentsWithAliases(loser.id, consentRows, loserRestoredAliases);

      const movedConvSet = new Set(movedConvIds);
      const remainingSurvivorConvs = (survivorAndLoserConvsRes.results as unknown as ConversationSummaryRow[]).filter(
        (c) => c.person_id === survivor.id && !movedConvSet.has(c.id),
      );
      const restoredLoserConvs = (currentConvsRes.results as unknown as ConversationSummaryRow[]);

      const sRestoredProj = buildPersonProjectionPatch({
        activeEndpoints: restoredSurvivorActiveEps,
        latestConsents: sRestoredConsents,
        conversations: remainingSurvivorConvs,
        boardData: survivorBoard,
        includeEmailPhoneFields: false,
      });
      const lRestoredProj = buildPersonProjectionPatch({
        activeEndpoints: restoredLoserActiveEps,
        latestConsents: lRestoredConsents,
        conversations: restoredLoserConvs,
        boardData: loserBoard,
        includeEmailPhoneFields: false,
      });

      const survivorRevertPatch: Record<string, unknown> = {
        ...moved.priorSurvivorValues,
        ...sRestoredProj,
      };
      const loserRestorePatch: Record<string, unknown> = {
        archived: moved.priorLoserArchived ?? false,
        [CRM_PROJECTION.mergedInto]: moved.priorLoserMergedInto ?? null,
        ...lRestoredProj,
      };

      const records: Mutation[] = [
        { id: survivor.id, collection: 'tasks', patch: survivorRevertPatch, ts: now },
        { id: loser.id, collection: 'tasks', patch: loserRestorePatch, ts: now },
      ];
      const recordExpect = new Map<string, number>();
      for (const [id, seq] of postRevs) recordExpect.set(id, seq);

      // Restore links: revive oldLinkId, soft-delete newly created newLinkId
      for (const ml of moved.movedLinks) {
        records.push({
          id: ml.oldLinkId,
          collection: 'links',
          patch: { deleted: false },
          ts: now,
        });
        if (ml.newLinkId && !ml.existedOnSurvivorBefore) {
          records.push({
            id: ml.newLinkId,
            collection: 'links',
            patch: { deleted: true },
            ts: now,
          });
        }
      }

      for (const sr of moved.movedSubRecordIds) {
        const cur = currentRecsById.get(sr.id);
        const curData = cur ? parseJsonSafe(cur.data) : null;
        records.push({
          id: sr.id,
          collection: 'tasks',
          patch: {
            parentId: loser.id,
            ...(curData && typeof loser.data.boardId === 'string' && curData.boardId !== loser.data.boardId
              ? { boardId: loser.data.boardId }
              : {}),
          },
          ts: now,
        });
      }
      for (const cm of moved.movedCommentIds) {
        records.push({ id: cm.id, collection: 'comments', patch: { targetId: loser.id }, ts: now });
      }
      for (const fl of moved.movedFileIds) {
        records.push({ id: fl.id, collection: 'files', patch: { parentId: loser.id }, ts: now });
      }

      // Restore endpoints: demote primary flags on survivor FIRST so unique index never collides while unretiring/restoring!
      const epRestoreDemoteStmts: D1PreparedStatement[] = [];
      const epRestoreMainStmts: D1PreparedStatement[] = [];
      for (const me of moved.movedEndpoints) {
        const curEp = currentEpById.get(me.id)!;
        if (me.action === 'demoted_primary') {
          epRestoreMainStmts.push(
            env.DB
              .prepare(
                `UPDATE crm_endpoints SET is_primary = ?, updated_at = ?
                 WHERE id = ? AND person_id = ? AND updated_at = ?`,
              )
              .bind(me.priorIsPrimary, now, me.id, survivor.id, curEp.updated_at),
            changesOneFence(env.DB),
          );
        } else {
          epRestoreDemoteStmts.push(
            env.DB
              .prepare(`UPDATE crm_endpoints SET is_primary = 0, updated_at = ? WHERE id = ? AND person_id = ? AND updated_at = ?`)
              .bind(now, me.id, survivor.id, curEp.updated_at),
            changesOneFence(env.DB),
          );
          epRestoreMainStmts.push(
            env.DB
              .prepare(
                `UPDATE crm_endpoints
                 SET person_id = ?, is_primary = ?, retired_at = ?, updated_at = ?
                 WHERE id = ? AND person_id = ? AND updated_at = ?`,
              )
              .bind(me.priorPersonId, me.priorIsPrimary, me.priorRetiredAt, now, me.id, survivor.id, now),
            changesOneFence(env.DB),
          );
        }
      }

      const convRestoreStmts: D1PreparedStatement[] = [];
      for (const mc of moved.movedConversationIds) {
        convRestoreStmts.push(
          env.DB
            .prepare(
              `UPDATE crm_conversations
               SET person_id = ?, rev = rev + 1, updated_at = ?
               WHERE id = ? AND person_id = ? AND rev = ?`,
            )
            .bind(loser.id, now, mc.id, survivor.id, mc.preRev + 1),
          changesOneFence(env.DB),
        );
      }

      const dupRestoreStmts: D1PreparedStatement[] = [];
      for (const d of moved.duplicateUpdates) {
        const exp = expectedDupPostById.get(d.id)!;
        dupRestoreStmts.push(
          env.DB
            .prepare(
              `UPDATE crm_duplicate_candidates
               SET person_a_id = ?, person_b_id = ?, state = ?, decided_by = ?, decided_at = ?, note = ?
               WHERE id = ? AND person_a_id = ? AND person_b_id = ? AND state = ?
                 AND COALESCE(decided_by, '') = ? AND COALESCE(decided_at, -1) = ?`,
            )
            .bind(
              d.priorPersonAId,
              d.priorPersonBId,
              d.priorState,
              d.priorDecidedBy,
              d.priorDecidedAt,
              d.priorNote,
              d.id,
              exp.a,
              exp.b,
              exp.state,
              exp.decidedBy ?? '',
              exp.decidedAt ?? -1,
            ),
          changesOneFence(env.DB),
        );
      }

      const fkRestoreStmts: D1PreparedStatement[] = [];
      for (const fk of moved.movedFormPeopleKeys) {
        fkRestoreStmts.push(
          env.DB
            .prepare(
              `UPDATE form_people_keys
               SET record_id = ?
               WHERE database_id = ? AND field_key = ? AND email = ? AND record_id = ?`,
            )
            .bind(fk.priorRecordId, fk.databaseId, fk.fieldKey, fk.email, survivor.id),
          changesOneFence(env.DB),
        );
      }

      const aliasRestoreStmts: D1PreparedStatement[] = [
        env.DB
          .prepare(`DELETE FROM crm_person_aliases WHERE alias_id = ? AND survivor_id = ? AND merge_id = ?`)
          .bind(loser.id, survivor.id, merge.id),
        changesOneFence(env.DB),
      ];
      for (const ta of moved.transitiveAliases) {
        aliasRestoreStmts.push(
          env.DB
            .prepare(
              `UPDATE crm_person_aliases
               SET survivor_id = ?, effective_at = ?
               WHERE alias_id = ? AND survivor_id = ? AND effective_at = ?`,
            )
            .bind(ta.priorSurvivorId, ta.priorEffectiveAt, ta.aliasId, survivor.id, merge.created_at),
          changesOneFence(env.DB),
        );
      }

      const unmergeId = `umg_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

      const rows: D1PreparedStatement[] = [
        ...epRestoreDemoteStmts,
        ...epRestoreMainStmts,
        ...convRestoreStmts,
        ...dupRestoreStmts,
        ...fkRestoreStmts,
        ...aliasRestoreStmts,
        env.DB
          .prepare(
            `INSERT INTO crm_merge_unmerges (merge_id, unmerge_id, actor_id, command_id, reason, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(merge.id, unmergeId, actor.id, commandId, input.reason?.trim() || null, now),
      ];

      const fences = [
        () => crmActorFence(env.DB, actor, tokenHash, 'crm.merge', '*'),
        () =>
          env.DB
            .prepare(
              `SELECT CASE WHEN EXISTS (
                 SELECT 1 FROM users WHERE id = ?1 AND COALESCE(workspace_role, role) IN ('owner', 'admin')
               ) AND NOT EXISTS (
                 SELECT 1 FROM crm_merge_unmerges WHERE merge_id = ?2
               ) AND EXISTS (
                 SELECT 1 FROM crm_person_aliases WHERE alias_id = ?3 AND survivor_id = ?4 AND merge_id = ?2
               ) AND NOT EXISTS (
                 SELECT 1 FROM crm_endpoints WHERE person_id = ?3
               ) AND NOT EXISTS (
                 SELECT 1 FROM crm_endpoints WHERE person_id = ?4 AND updated_at > ?5
               ) AND NOT EXISTS (
                 SELECT 1 FROM crm_conversations WHERE person_id = ?3
               ) AND NOT EXISTS (
                 SELECT 1 FROM crm_consents WHERE person_id IN (?3, ?4) AND recorded_at > ?5
               ) THEN 1 ELSE json_extract('{', '$') END`,
            )
            .bind(actor.id, merge.id, loser.id, survivor.id, merge.created_at),
      ];

      return {
        kind: 'commit',
        result: {
          mergeId: merge.id,
          unmergeId,
          survivorId: survivor.id,
          restoredId: loser.id,
        },
        fences,
        rows,
        records,
        recordExpect,
        serverTs: true,
      };
    },
    mapConstraintError: () => ({
      ok: false,
      error: 'stale',
      retryable: true,
    }),
    afterCommit: ({ env, executionCtx }) => {
      pokeLive(env, executionCtx);
    },
  };
}

export function createS10MergeCommandDefs(): AnyCommandDefinition[] {
  return [mergePersonCommand(), unmergePersonCommand()];
}

export type { CrmEndpointDto };
