import { z } from 'zod';
import type { FieldDef } from '../fields';
import { propKey } from '../fields';
import {
  CrmConsentChannelSchema,
  CrmConsentDtoSchema,
  CrmConsentScopeSchema,
  CrmEndpointKindSchema,
  type CrmConsentDto,
  type CrmEndpointKind,
} from './identity';
import { CRM_CURSOR_ID_PATTERN } from './contracts';
import { isCrmProjectionKey } from './projection';

/* ---------- Bounded S10 merge limits (45-call D1 budget safe) ---------- */

export const MAX_MERGE_SYNCED_RECORDS = 150;
export const MAX_MERGE_ENDPOINTS = 50;
export const MAX_MERGE_CONVERSATIONS = 100;
export const MAX_MERGE_DUPLICATES = 50;
export const MAX_MERGE_FORM_KEYS = 50;
export const MAX_MERGE_TRANSITIVE_ALIASES = 50;
export const MERGE_HISTORY_PAGE_LIMIT = 50;

export const MergeFieldChoiceSchema = z.enum(['survivor', 'loser', 'union', 'concat']);
export type MergeFieldChoice = z.infer<typeof MergeFieldChoiceSchema>;

export const MergeFieldComparisonDtoSchema = z.object({
  key: z.string().min(1).max(128),
  label: z.string().min(1).max(128),
  fieldType: z.string().min(1).max(32),
  survivorValue: z.unknown(),
  loserValue: z.unknown(),
  conflict: z.boolean(),
  suggestedChoice: MergeFieldChoiceSchema,
  allowedChoices: z.array(MergeFieldChoiceSchema).min(1),
}).strict();
export type MergeFieldComparisonDto = z.infer<typeof MergeFieldComparisonDtoSchema>;

export const MergeEndpointSummaryDtoSchema = z.object({
  id: z.string(),
  personId: z.string(),
  kind: CrmEndpointKindSchema,
  valueRaw: z.string(),
  valueNorm: z.string(),
  isPrimary: z.boolean(),
  retiredAt: z.number().int().nullable(),
}).strict();
export type MergeEndpointSummaryDto = z.infer<typeof MergeEndpointSummaryDtoSchema>;

export const MergeEndpointPlanDtoSchema = z.object({
  kind: CrmEndpointKindSchema,
  survivorEndpoints: z.array(MergeEndpointSummaryDtoSchema),
  loserEndpoints: z.array(MergeEndpointSummaryDtoSchema),
  collisionCount: z.number().int().nonnegative(),
  recommendedPrimaryId: z.string().nullable(),
}).strict();
export type MergeEndpointPlanDto = z.infer<typeof MergeEndpointPlanDtoSchema>;

export const MergeConsentPreviewDtoSchema = z.object({
  channel: CrmConsentChannelSchema,
  scope: CrmConsentScopeSchema,
  survivorStatus: z.enum(['granted', 'withdrawn', 'unrecorded']),
  loserStatus: z.enum(['granted', 'withdrawn', 'unrecorded']),
  effectiveStatus: z.enum(['granted', 'withdrawn']),
  strictestApplied: z.boolean(),
}).strict();
export type MergeConsentPreviewDto = z.infer<typeof MergeConsentPreviewDtoSchema>;

export const MergeReferenceCountsDtoSchema = z.object({
  syncedRecords: z.number().int().nonnegative(),
  links: z.number().int().nonnegative(),
  subRecords: z.number().int().nonnegative(),
  comments: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  loserBlocksPreserved: z.number().int().nonnegative(),
  endpoints: z.number().int().nonnegative(),
  consents: z.number().int().nonnegative(),
  conversations: z.number().int().nonnegative(),
  duplicateCandidates: z.number().int().nonnegative(),
  formPeopleKeys: z.number().int().nonnegative(),
  transitiveAliases: z.number().int().nonnegative(),
  approvalsAndSuggestions: z.number().int().nonnegative(),
}).strict();
export type MergeReferenceCountsDto = z.infer<typeof MergeReferenceCountsDtoSchema>;

export const MergeMovedCountsDtoSchema = z.object({
  fieldsCopied: z.number().int().nonnegative(),
  linksMoved: z.number().int().nonnegative(),
  linksDeduplicated: z.number().int().nonnegative(),
  selfLinksRemoved: z.number().int().nonnegative(),
  subRecordsMoved: z.number().int().nonnegative(),
  commentsMoved: z.number().int().nonnegative(),
  filesMoved: z.number().int().nonnegative(),
  endpointsMoved: z.number().int().nonnegative(),
  endpointsRetiredDuplicate: z.number().int().nonnegative(),
  conversationsMoved: z.number().int().nonnegative(),
  duplicateCandidatesUpdated: z.number().int().nonnegative(),
  formPeopleKeysMoved: z.number().int().nonnegative(),
  transitiveAliasesUpdated: z.number().int().nonnegative(),
}).strict();
export type MergeMovedCountsDto = z.infer<typeof MergeMovedCountsDtoSchema>;

export const MergePersonSnapshotDtoSchema = z.object({
  id: z.string(),
  title: z.string(),
  rev: z.number().int().nonnegative(),
  archived: z.boolean(),
  mergedInto: z.string().nullable(),
  primaryEmail: z.string().nullable(),
  primaryPhone: z.string().nullable(),
}).strict();
export type MergePersonSnapshotDto = z.infer<typeof MergePersonSnapshotDtoSchema>;

export const MergePreviewResponseSchema = z.object({
  survivor: MergePersonSnapshotDtoSchema,
  loser: MergePersonSnapshotDtoSchema,
  alreadyMerged: z.boolean(),
  fieldComparisons: z.array(MergeFieldComparisonDtoSchema),
  endpointPlans: z.array(MergeEndpointPlanDtoSchema),
  consentPreviews: z.array(MergeConsentPreviewDtoSchema),
  referenceCounts: MergeReferenceCountsDtoSchema,
  withinBudget: z.boolean(),
  budgetReasons: z.array(z.string()),
  warnings: z.array(z.string()),
}).strict();
export type MergePreviewResponse = z.infer<typeof MergePreviewResponseSchema>;

export const PersonMergeInputSchema = z.object({
  survivorId: z.string().min(1).max(128),
  loserId: z.string().min(1).max(128),
  confirm: z.literal(true),
  fieldResolutions: z.record(z.string().min(1).max(128), MergeFieldChoiceSchema).optional(),
  primaryEndpoints: z
    .object({
      email: z.string().min(1).max(64),
      phone: z.string().min(1).max(64),
      whatsapp: z.string().min(1).max(64),
      instagram: z.string().min(1).max(64),
      facebook: z.string().min(1).max(64),
    })
    .partial()
    .strict()
    .optional(),
  note: z.string().max(500).optional(),
}).strict();
export type PersonMergeInput = z.infer<typeof PersonMergeInputSchema>;

export const PersonMergeOutputSchema = z.object({
  mergeId: z.string().min(1).max(64),
  survivorId: z.string(),
  mergedId: z.string(),
  movedCounts: MergeMovedCountsDtoSchema,
}).strict();
export type PersonMergeOutput = z.infer<typeof PersonMergeOutputSchema>;

export const PersonUnmergeInputSchema = z.object({
  mergeId: z.string().min(1).max(64),
  confirm: z.literal(true),
  reason: z.string().max(500).optional(),
}).strict();
export type PersonUnmergeInput = z.infer<typeof PersonUnmergeInputSchema>;

export const PersonUnmergeOutputSchema = z.object({
  mergeId: z.string().min(1).max(64),
  unmergeId: z.string().min(1).max(64),
  survivorId: z.string(),
  restoredId: z.string(),
}).strict();
export type PersonUnmergeOutput = z.infer<typeof PersonUnmergeOutputSchema>;

export const UnmergeConflictDtoSchema = z.object({
  code: z.enum([
    'already_unmerged',
    'survivor_edited',
    'loser_edited',
    'later_merge_depends_on_record',
    'endpoint_reassigned',
    'conversation_edited',
    'link_modified',
    'missing_record',
  ]),
  entityId: z.string(),
  message: z.string(),
}).strict();
export type UnmergeConflictDto = z.infer<typeof UnmergeConflictDtoSchema>;

export const MergeHistoryItemDtoSchema = z.object({
  id: z.string(),
  survivorId: z.string(),
  survivorTitle: z.string().nullable(),
  mergedId: z.string(),
  mergedTitle: z.string().nullable(),
  actorId: z.string(),
  actorName: z.string().nullable(),
  commandId: z.string(),
  note: z.string().nullable(),
  movedCounts: MergeMovedCountsDtoSchema,
  createdAt: z.number().int().nonnegative(),
  unmerged: z.object({
    unmergeId: z.string(),
    actorId: z.string(),
    actorName: z.string().nullable(),
    reason: z.string().nullable(),
    createdAt: z.number().int().nonnegative(),
  }).strict().nullable(),
}).strict();
export type MergeHistoryItemDto = z.infer<typeof MergeHistoryItemDtoSchema>;

export const MergeHistoryPageResponseSchema = z.object({
  items: z.array(MergeHistoryItemDtoSchema).max(MERGE_HISTORY_PAGE_LIMIT),
  next: z.string().regex(CRM_CURSOR_ID_PATTERN).or(z.string().max(256)).nullable(),
  partial: z.boolean(),
}).strict();
export type MergeHistoryPageResponse = z.infer<typeof MergeHistoryPageResponseSchema>;

export interface MergeJournalMovedPayload {
  version: 1;
  preSurvivorRev: number;
  preLoserRev: number;
  survivorPatchedKeys: string[];
  priorSurvivorValues: Record<string, unknown>;
  priorLoserArchived: boolean | null;
  priorLoserMergedInto: string | null;
  movedLinks: {
    oldLinkId: string;
    oldData: Record<string, unknown>;
    newLinkId: string | null;
    existedOnSurvivorBefore: boolean;
  }[];
  movedSubRecordIds: { id: string; preRev: number }[];
  movedCommentIds: { id: string; preRev: number }[];
  movedFileIds: { id: string; preRev: number }[];
  movedEndpoints: {
    id: string;
    priorPersonId: string;
    priorIsPrimary: number;
    priorRetiredAt: number | null;
    action: 'repointed' | 'retired_duplicate' | 'demoted_primary';
  }[];
  movedConversationIds: { id: string; preRev: number }[];
  duplicateUpdates: {
    id: string;
    priorPersonAId: string;
    priorPersonBId: string;
    priorState: string;
    priorDecidedBy: string | null;
    priorDecidedAt: number | null;
    priorNote: string | null;
    action: 'marked_merged' | 'repointed' | 'kept_existing';
  }[];
  movedFormPeopleKeys: {
    databaseId: string;
    fieldKey: string;
    email: string;
    priorRecordId: string;
  }[];
  transitiveAliases: {
    aliasId: string;
    priorSurvivorId: string;
    priorMergeId: string;
    priorEffectiveAt: number;
  }[];
  movedCounts: MergeMovedCountsDto;
}

/* ---------- Pure helpers ---------- */

function isEmptyMergeValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function stableMergeValueKey(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    return JSON.stringify([...value].map((v) => String(v)).sort());
  }
  if (typeof value === 'string') return JSON.stringify(value.trim());
  return JSON.stringify(value);
}

function isNotesField(key: string, label: string): boolean {
  return key === 'p_f_pnotes' || key === 'p_notes' || /\bnotes?\b/i.test(label);
}

/**
 * Compares non-relation, non-projection properties between survivor and loser Person records.
 */
export function comparePersonFields(
  boardFields: readonly FieldDef[],
  survivorData: Record<string, unknown>,
  loserData: Record<string, unknown>,
): MergeFieldComparisonDto[] {
  const specs: { key: string; label: string; fieldType: string }[] = [
    { key: 'title', label: 'Name', fieldType: 'text' },
  ];
  const seenKeys = new Set<string>(['title']);

  for (const field of boardFields) {
    if (field.type === 'relation') continue;
    const key = propKey(field.id);
    if (seenKeys.has(key) || isCrmProjectionKey(key)) continue;
    seenKeys.add(key);
    specs.push({ key, label: field.name || field.id, fieldType: field.type });
  }

  const allExtraKeys = [...new Set([...Object.keys(survivorData), ...Object.keys(loserData)])]
    .filter((k) => k.startsWith('p_') && !seenKeys.has(k) && !isCrmProjectionKey(k))
    .sort();
  for (const key of allExtraKeys) {
    seenKeys.add(key);
    specs.push({ key, label: key.slice(2), fieldType: 'text' });
  }

  const out: MergeFieldComparisonDto[] = [];
  for (const spec of specs) {
    const sVal = survivorData[spec.key] ?? null;
    const lVal = loserData[spec.key] ?? null;
    const sEmpty = isEmptyMergeValue(sVal);
    const lEmpty = isEmptyMergeValue(lVal);
    if (sEmpty && lEmpty) continue;

    const equal = !sEmpty && !lEmpty && stableMergeValueKey(sVal) === stableMergeValueKey(lVal);
    const conflict = !sEmpty && !lEmpty && !equal;
    const isArrayLike =
      spec.fieldType === 'multi_select' || Array.isArray(sVal) || Array.isArray(lVal);
    const canConcat =
      conflict &&
      typeof sVal === 'string' &&
      typeof lVal === 'string' &&
      isNotesField(spec.key, spec.label);

    const allowedChoices: MergeFieldChoice[] = isArrayLike
      ? ['survivor', 'loser', 'union']
      : canConcat
        ? ['survivor', 'loser', 'concat']
        : ['survivor', 'loser'];

    const suggestedChoice: MergeFieldChoice = !conflict
      ? sEmpty
        ? 'loser'
        : 'survivor'
      : isArrayLike
        ? 'union'
        : canConcat
          ? 'concat'
          : 'survivor';

    out.push({
      key: spec.key,
      label: spec.label,
      fieldType: spec.fieldType,
      survivorValue: sEmpty ? null : sVal,
      loserValue: lEmpty ? null : lVal,
      conflict,
      suggestedChoice,
      allowedChoices,
    });
  }

  return out;
}

/**
 * Produces the survivor patch and pre-merge rollback values from resolved field choices.
 */
export function computeMergedFieldPatch(
  comparisons: readonly MergeFieldComparisonDto[],
  survivorData: Record<string, unknown>,
  loserData: Record<string, unknown>,
  fieldResolutions?: Readonly<Record<string, MergeFieldChoice>>,
):
  | {
      ok: true;
      survivorPatch: Record<string, unknown>;
      priorSurvivorValues: Record<string, unknown>;
      fieldsCopied: number;
    }
  | { ok: false; reason: string; key?: string } {
  const compByKey = new Map(comparisons.map((c) => [c.key, c]));
  if (fieldResolutions) {
    for (const [k, choice] of Object.entries(fieldResolutions)) {
      if (isCrmProjectionKey(k)) {
        return { ok: false, reason: 'protected_field_resolution', key: k };
      }
      const comp = compByKey.get(k);
      if (comp && !comp.allowedChoices.includes(choice)) {
        return { ok: false, reason: 'invalid_field_choice', key: k };
      }
    }
  }

  const survivorPatch: Record<string, unknown> = {};
  const priorSurvivorValues: Record<string, unknown> = {};
  let fieldsCopied = 0;

  for (const comp of comparisons) {
    if (isCrmProjectionKey(comp.key)) continue;
    const choice = fieldResolutions?.[comp.key] ?? comp.suggestedChoice;
    if (!comp.allowedChoices.includes(choice)) {
      return { ok: false, reason: 'invalid_field_choice', key: comp.key };
    }

    const sVal = survivorData[comp.key];
    const lVal = loserData[comp.key];
    const sEmpty = isEmptyMergeValue(sVal);
    const lEmpty = isEmptyMergeValue(lVal);
    if (choice === 'survivor') continue;

    let nextValue: unknown = sVal;
    if (choice === 'loser') {
      if (lEmpty && !comp.conflict) continue;
      nextValue = lEmpty ? null : lVal;
    } else if (choice === 'union') {
      const sArr = Array.isArray(sVal) ? sVal.map((v) => String(v)) : [];
      const lArr = Array.isArray(lVal) ? lVal.map((v) => String(v)) : [];
      nextValue = [...new Set([...sArr, ...lArr])];
    } else if (choice === 'concat') {
      const sStr = typeof sVal === 'string' ? sVal.trim() : '';
      const lStr = typeof lVal === 'string' ? lVal.trim() : '';
      if (!lStr) continue;
      nextValue = !sStr ? lStr : sStr === lStr ? sStr : `${sStr}\n\n---\n${lStr}`;
    }

    if (!sEmpty && stableMergeValueKey(nextValue) === stableMergeValueKey(sVal)) continue;
    priorSurvivorValues[comp.key] = comp.key in survivorData ? survivorData[comp.key] : null;
    survivorPatch[comp.key] = nextValue;
    fieldsCopied += 1;
  }

  return { ok: true, survivorPatch, priorSurvivorValues, fieldsCopied };
}

/**
 * Previews effective consents after merging two people WITHOUT broadening consent:
 * if either pre-merge state is `withdrawn`, the merged state MUST stay `withdrawn`.
 */
export function computeEffectiveMergedConsents(
  survivorLatest: readonly Pick<CrmConsentDto, 'channel' | 'scope' | 'status'>[],
  loserLatest: readonly Pick<CrmConsentDto, 'channel' | 'scope' | 'status'>[],
): MergeConsentPreviewDto[] {
  const sMap = new Map<string, 'granted' | 'withdrawn'>();
  for (const r of survivorLatest) sMap.set(`${r.channel}:${r.scope}`, r.status);
  const lMap = new Map<string, 'granted' | 'withdrawn'>();
  for (const r of loserLatest) lMap.set(`${r.channel}:${r.scope}`, r.status);

  const keys = [...new Set([...sMap.keys(), ...lMap.keys()])].sort();
  return keys.map((key) => {
    const [channel, scope] = key.split(':') as [CrmConsentDto['channel'], CrmConsentDto['scope']];
    const sStatus = sMap.get(key) ?? 'unrecorded';
    const lStatus = lMap.get(key) ?? 'unrecorded';
    const effectiveStatus: 'granted' | 'withdrawn' =
      sStatus === 'withdrawn' || lStatus === 'withdrawn' ? 'withdrawn' : 'granted';
    return {
      channel,
      scope,
      survivorStatus: sStatus,
      loserStatus: lStatus,
      effectiveStatus,
      strictestApplied: effectiveStatus === 'withdrawn' && (sStatus === 'granted' || lStatus === 'granted'),
    };
  });
}

function compareConsentRecencyDesc(a: Pick<CrmConsentDto, 'recordedAt' | 'id'>, b: Pick<CrmConsentDto, 'recordedAt' | 'id'>): number {
  if (b.recordedAt !== a.recordedAt) return b.recordedAt - a.recordedAt;
  return a.id === b.id ? 0 : b.id > a.id ? 1 : -1;
}

/**
 * Resolves effective per-(channel, scope) latest consent rows across a canonical person
 * and any merged aliases (`crm_consents` stays strictly append-only).
 * Never broadens consent: a pre-merge alias withdrawal blocks pre-merge grants on the survivor
 * until a strictly newer consent row is explicitly recorded on the canonical person AFTER `effectiveAt`.
 */
export function resolveEffectiveConsentsWithAliases(
  canonicalPersonId: string,
  rows: readonly CrmConsentDto[],
  aliasEffectiveAtById: ReadonlyMap<string, number>,
): CrmConsentDto[] {
  const byKey = new Map<string, CrmConsentDto[]>();
  for (const r of rows) {
    if (r.personId !== canonicalPersonId && !aliasEffectiveAtById.has(r.personId)) continue;
    const key = `${r.channel}:${r.scope}`;
    const list = byKey.get(key) ?? [];
    list.push(r);
    byKey.set(key, list);
  }

  const resolved: CrmConsentDto[] = [];
  for (const groupRows of byKey.values()) {
    const latestByPerson = new Map<string, CrmConsentDto>();
    for (const r of groupRows) {
      const cur = latestByPerson.get(r.personId);
      if (!cur || compareConsentRecencyDesc(r, cur) < 0) {
        latestByPerson.set(r.personId, r);
      }
    }

    const canonicalLatest = latestByPerson.get(canonicalPersonId);
    if (canonicalLatest?.status === 'withdrawn') {
      resolved.push(canonicalLatest);
      continue;
    }

    const blockingWithdrawals: CrmConsentDto[] = [];
    for (const [personId, row] of latestByPerson) {
      if (personId === canonicalPersonId || row.status !== 'withdrawn') continue;
      const mergedAt = aliasEffectiveAtById.get(personId) ?? Number.MAX_SAFE_INTEGER;
      const threshold = Math.max(mergedAt, row.recordedAt);
      if (!canonicalLatest || canonicalLatest.recordedAt <= threshold) {
        blockingWithdrawals.push(row);
      }
    }

    if (blockingWithdrawals.length > 0) {
      blockingWithdrawals.sort(compareConsentRecencyDesc);
      resolved.push(blockingWithdrawals[0]!);
      continue;
    }

    if (canonicalLatest) {
      resolved.push(canonicalLatest);
      continue;
    }

    const allLatest = [...latestByPerson.values()].sort(compareConsentRecencyDesc);
    if (allLatest[0]) resolved.push(allLatest[0]);
  }

  return resolved.sort((a, b) => `${a.channel}:${a.scope}`.localeCompare(`${b.channel}:${b.scope}`));
}

/**
 * Checks whether a planned merge stays safely inside single-transaction & 45-call D1 budget limits.
 */
export function checkMergeBudget(counts: MergeReferenceCountsDto): {
  withinBudget: boolean;
  budgetReasons: string[];
} {
  const budgetReasons: string[] = [];
  if (counts.syncedRecords > MAX_MERGE_SYNCED_RECORDS) {
    budgetReasons.push(`synced_records_exceeded:${counts.syncedRecords}>${MAX_MERGE_SYNCED_RECORDS}`);
  }
  if (counts.endpoints > MAX_MERGE_ENDPOINTS) {
    budgetReasons.push(`endpoints_exceeded:${counts.endpoints}>${MAX_MERGE_ENDPOINTS}`);
  }
  if (counts.conversations > MAX_MERGE_CONVERSATIONS) {
    budgetReasons.push(`conversations_exceeded:${counts.conversations}>${MAX_MERGE_CONVERSATIONS}`);
  }
  if (counts.duplicateCandidates > MAX_MERGE_DUPLICATES) {
    budgetReasons.push(`duplicates_exceeded:${counts.duplicateCandidates}>${MAX_MERGE_DUPLICATES}`);
  }
  if (counts.formPeopleKeys > MAX_MERGE_FORM_KEYS) {
    budgetReasons.push(`form_people_keys_exceeded:${counts.formPeopleKeys}>${MAX_MERGE_FORM_KEYS}`);
  }
  if (counts.transitiveAliases > MAX_MERGE_TRANSITIVE_ALIASES) {
    budgetReasons.push(`transitive_aliases_exceeded:${counts.transitiveAliases}>${MAX_MERGE_TRANSITIVE_ALIASES}`);
  }
  return {
    withinBudget: budgetReasons.length === 0,
    budgetReasons,
  };
}

export function validatePrimaryEndpointChoice(
  kind: CrmEndpointKind,
  endpointId: string,
  candidates: readonly MergeEndpointSummaryDto[],
): boolean {
  return candidates.some((e) => e.id === endpointId && e.kind === kind && e.retiredAt === null);
}

export { CrmConsentDtoSchema };
