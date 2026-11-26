import { describe, expect, it } from 'vitest';
import type { FieldDef } from '../shared/fields';
import type { CrmConsentDto } from '../shared/crm/identity';
import {
  MAX_MERGE_CONVERSATIONS,
  MAX_MERGE_SYNCED_RECORDS,
  MergePreviewResponseSchema,
  PersonMergeInputSchema,
  PersonUnmergeInputSchema,
  checkMergeBudget,
  comparePersonFields,
  computeEffectiveMergedConsents,
  computeMergedFieldPatch,
  resolveEffectiveConsentsWithAliases,
} from '../shared/crm/merge';
import { CRM_PROJECTION, isCrmProjectionKey } from '../shared/crm/projection';

const SAMPLE_FIELDS: FieldDef[] = [
  { id: 'f_role', name: 'Role', type: 'text' },
  { id: 'f_email', name: 'Email', type: 'text' },
  { id: 'f_tags', name: 'Tags', type: 'multi_select', options: [{ id: 't1', name: 'Artist', color: 'blue' }, { id: 't2', name: 'Mentor', color: 'green' }] },
  { id: 'f_pnotes', name: 'Notes', type: 'text' },
  { id: 'f_affiliations', name: 'Affiliations', type: 'relation', relation: { target: 'db_aff' } },
];

describe('CRM S10 shared merge helpers & schemas', () => {
  it('registers _crm_merged_into projection key', () => {
    expect(CRM_PROJECTION.mergedInto).toBe('_crm_merged_into');
    expect(isCrmProjectionKey(CRM_PROJECTION.mergedInto)).toBe(true);
  });

  it('compares fields, resolves conflicts safely, unions multi-selects, concats notes & excludes relations/_crm_* keys', () => {
    const survivor = {
      title: 'Asha Rao',
      p_f_role: 'Ceramicist',
      p_f_tags: ['t1'],
      p_f_pnotes: 'Met at Clay Lab.',
      _crm_primary_email: 'asha@old.org',
    };
    const loser = {
      title: 'Asha R.',
      p_f_email: 'asha@studio.org',
      p_f_tags: ['t1', 't2'],
      p_f_pnotes: 'Also joined Habitat workshop.',
      _crm_primary_email: 'loser@hack.org',
    };

    const comps = comparePersonFields(SAMPLE_FIELDS, survivor, loser);
    expect(comps.some((c) => c.key === 'p_f_affiliations')).toBe(false);
    expect(comps.some((c) => c.key.startsWith('_crm_'))).toBe(false);

    const titleComp = comps.find((c) => c.key === 'title')!;
    expect(titleComp.conflict).toBe(true);
    expect(titleComp.suggestedChoice).toBe('survivor');

    const emailComp = comps.find((c) => c.key === 'p_f_email')!;
    expect(emailComp.conflict).toBe(false);
    expect(emailComp.suggestedChoice).toBe('loser');

    const tagsComp = comps.find((c) => c.key === 'p_f_tags')!;
    expect(tagsComp.conflict).toBe(true);
    expect(tagsComp.allowedChoices).toContain('union');
    expect(tagsComp.suggestedChoice).toBe('union');

    const notesComp = comps.find((c) => c.key === 'p_f_pnotes')!;
    expect(notesComp.conflict).toBe(true);
    expect(notesComp.allowedChoices).toContain('concat');
    expect(notesComp.suggestedChoice).toBe('concat');

    const planned = computeMergedFieldPatch(comps, survivor, loser, { title: 'loser' });
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error('expected ok');
    expect(planned.survivorPatch).toEqual({
      title: 'Asha R.',
      p_f_email: 'asha@studio.org',
      p_f_tags: ['t1', 't2'],
      p_f_pnotes: 'Met at Clay Lab.\n\n---\nAlso joined Habitat workshop.',
    });
    expect(planned.priorSurvivorValues).toEqual({
      title: 'Asha Rao',
      p_f_email: null,
      p_f_tags: ['t1'],
      p_f_pnotes: 'Met at Clay Lab.',
    });
    expect(planned.fieldsCopied).toBe(4);

    // Invalid choice & _crm_* injection must refuse
    expect(computeMergedFieldPatch(comps, survivor, loser, { _crm_merged_into: 'loser' }).ok).toBe(false);
    expect(computeMergedFieldPatch(comps, survivor, loser, { title: 'concat' }).ok).toBe(false);
  });

  it('never broadens consent across pre-merge histories while honoring post-merge explicit survivor consent', () => {
    const preview = computeEffectiveMergedConsents(
      [
        { channel: 'whatsapp', scope: 'transactional', status: 'granted' },
        { channel: 'email', scope: 'updates', status: 'withdrawn' },
      ],
      [
        { channel: 'whatsapp', scope: 'transactional', status: 'withdrawn' },
        { channel: 'instagram', scope: 'transactional', status: 'granted' },
      ],
    );
    expect(preview).toEqual([
      { channel: 'email', scope: 'updates', survivorStatus: 'withdrawn', loserStatus: 'unrecorded', effectiveStatus: 'withdrawn', strictestApplied: false },
      { channel: 'instagram', scope: 'transactional', survivorStatus: 'unrecorded', loserStatus: 'granted', effectiveStatus: 'granted', strictestApplied: false },
      { channel: 'whatsapp', scope: 'transactional', survivorStatus: 'granted', loserStatus: 'withdrawn', effectiveStatus: 'withdrawn', strictestApplied: true },
    ]);

    const rows: CrmConsentDto[] = [
      { id: 'c1', personId: 'p-surv', channel: 'whatsapp', scope: 'transactional', status: 'granted', source: 'manual', evidenceRef: null, recordedBy: 'u1', recordedAt: 200 },
      { id: 'c2', personId: 'p-lose', channel: 'whatsapp', scope: 'transactional', status: 'withdrawn', source: 'optout', evidenceRef: null, recordedBy: 'u1', recordedAt: 100 },
      { id: 'c3', personId: 'p-lose', channel: 'instagram', scope: 'transactional', status: 'granted', source: 'manual', evidenceRef: null, recordedBy: 'u1', recordedAt: 150 },
    ];
    const aliases = new Map([['p-lose', 300]]);

    const resolvedPrePost = resolveEffectiveConsentsWithAliases('p-surv', rows, aliases);
    expect(resolvedPrePost.find((r) => r.channel === 'whatsapp')?.status).toBe('withdrawn');
    expect(resolvedPrePost.find((r) => r.channel === 'instagram')?.status).toBe('granted');

    // Explicit post-merge grant recorded AFTER merge effective_at (400 > 300) supersedes pre-merge alias opt-out
    const afterRegrant = resolveEffectiveConsentsWithAliases(
      'p-surv',
      [
        ...rows,
        { id: 'c4', personId: 'p-surv', channel: 'whatsapp', scope: 'transactional', status: 'granted', source: 'manual', evidenceRef: null, recordedBy: 'u1', recordedAt: 400 },
      ],
      aliases,
    );
    expect(afterRegrant.find((r) => r.channel === 'whatsapp')?.id).toBe('c4');
    expect(afterRegrant.find((r) => r.channel === 'whatsapp')?.status).toBe('granted');

    // Second merge with another withdrawn alias at 500 blocks the 400 grant (400 <= 500)
    const afterSecondMerge = resolveEffectiveConsentsWithAliases(
      'p-surv',
      [
        ...rows,
        { id: 'c4', personId: 'p-surv', channel: 'whatsapp', scope: 'transactional', status: 'granted', source: 'manual', evidenceRef: null, recordedBy: 'u1', recordedAt: 400 },
        { id: 'c5', personId: 'p-lose2', channel: 'whatsapp', scope: 'transactional', status: 'withdrawn', source: 'optout', evidenceRef: null, recordedBy: 'u1', recordedAt: 120 },
      ],
      new Map([['p-lose', 300], ['p-lose2', 500]]),
    );
    expect(afterSecondMerge.find((r) => r.channel === 'whatsapp')?.status).toBe('withdrawn');
  });

  it('enforces bounded merge budgets and confirmation schemas', () => {
    const base = {
      syncedRecords: 10,
      links: 5,
      subRecords: 1,
      comments: 2,
      files: 2,
      loserBlocksPreserved: 1,
      endpoints: 4,
      consents: 2,
      conversations: 3,
      duplicateCandidates: 1,
      formPeopleKeys: 1,
      transitiveAliases: 0,
      approvalsAndSuggestions: 0,
    };
    expect(checkMergeBudget(base)).toEqual({ withinBudget: true, budgetReasons: [] });
    const over = checkMergeBudget({
      ...base,
      syncedRecords: MAX_MERGE_SYNCED_RECORDS + 1,
      conversations: MAX_MERGE_CONVERSATIONS + 1,
    });
    expect(over.withinBudget).toBe(false);
    expect(over.budgetReasons).toHaveLength(2);

    expect(PersonMergeInputSchema.safeParse({ survivorId: 'p1', loserId: 'p2', confirm: false }).success).toBe(false);
    expect(PersonMergeInputSchema.safeParse({ survivorId: 'p1', loserId: 'p2', confirm: true }).success).toBe(true);
    expect(PersonUnmergeInputSchema.safeParse({ mergeId: 'm1', confirm: false }).success).toBe(false);
    expect(PersonUnmergeInputSchema.safeParse({ mergeId: 'm1', confirm: true }).success).toBe(true);

    expect(
      MergePreviewResponseSchema.safeParse({
        survivor: { id: 'p1', title: 'Asha', rev: 2, archived: false, mergedInto: null, primaryEmail: null, primaryPhone: null },
        loser: { id: 'p2', title: 'Asha R', rev: 1, archived: false, mergedInto: null, primaryEmail: null, primaryPhone: null },
        alreadyMerged: false,
        fieldComparisons: [],
        endpointPlans: [],
        consentPreviews: [],
        referenceCounts: base,
        withinBudget: true,
        budgetReasons: [],
        warnings: [],
      }).success,
    ).toBe(true);
  });
});
