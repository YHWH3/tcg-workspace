import { z } from 'zod';

export const CRM_WORK_AREAS = [
  { id: 'experiences_learning', label: 'Experiences and learning', description: 'Workshops, residences, and learning cohorts' },
  { id: 'spaces_network', label: 'Spaces and network', description: 'Sites, land spaces, and associated venues' },
  { id: 'community_support', label: 'Community and support', description: 'Memberships, patrons, and volunteers' },
  { id: 'collaboration_work', label: 'Collaboration and work', description: 'Partnerships, consulting, and production' },
  { id: 'culture_making', label: 'Culture and making', description: 'Cultural publications, crafts, and making' },
] as const;

export type CrmWorkArea = (typeof CRM_WORK_AREAS)[number]['id'];
export const CrmWorkAreaSchema = z.enum([
  'experiences_learning',
  'spaces_network',
  'community_support',
  'collaboration_work',
  'culture_making',
]);

export const ProgrammeEnginesSchema = z.object({
  applications: z.boolean().default(false),
  bookings: z.boolean().default(false),
  membership: z.string().nullable().default(null),
  opportunities: z.array(z.string().min(1).max(64)).default([]),
  patrons: z.boolean().default(false),
}).strict();

export const ProgrammeStageSchema = z.object({
  id: z.string().min(1).max(48),
  label: z.string().min(1).max(64),
  color: z.enum(['clay', 'ochre', 'leaf', 'river', 'dusk', 'berry', 'stone', 'ember', 'teal']).default('stone'),
  kind: z.enum(['active', 'decision', 'done']).default('active'),
}).strict();

export const ProgrammeReviewGateSchema = z.object({
  stageId: z.string().min(1).max(48),
  requiresApproval: z.boolean().default(true),
}).strict();

export const ProgrammeBookingDefaultsSchema = z.object({
  holdMinutes: z.number().int().min(15).max(43_200).nullable().default(null),
  requiresScreening: z.boolean().default(false),
  confirmBeforePayment: z.boolean().default(false),
  pricePolicyNote: z.string().max(300).nullable().default(null),
}).strict();

/**
 * Policy-neutral v1 Programme Profile schema.
 * Unresolved pricing, eligibility, duration, capacity, and benefits fields default to null
 * and are configured explicitly by authorized admins or the owner.
 */
export const ProgrammeProfileV1Schema = z.object({
  version: z.literal(1),
  area: CrmWorkAreaSchema,
  engines: ProgrammeEnginesSchema,
  forms: z.array(z.string().min(1).max(64)).default([]),
  autoCreateApplications: z.boolean().default(false),
  applicationStages: z.array(ProgrammeStageSchema).default([
    { id: 'received', label: 'Received', color: 'ochre', kind: 'active' },
    { id: 'in_review', label: 'In review', color: 'river', kind: 'active' },
    { id: 'needs_info', label: 'Needs info', color: 'clay', kind: 'active' },
    { id: 'conversation', label: 'Conversation', color: 'dusk', kind: 'active' },
    { id: 'accepted', label: 'Accepted', color: 'leaf', kind: 'decision' },
    { id: 'declined', label: 'Declined', color: 'ember', kind: 'decision' },
    { id: 'withdrawn', label: 'Withdrawn', color: 'stone', kind: 'done' },
    { id: 'converted', label: 'Converted', color: 'teal', kind: 'done' },
  ]),
  reviewGate: ProgrammeReviewGateSchema.nullable().default(null),
  bookingDefaults: ProgrammeBookingDefaultsSchema.default({
    holdMinutes: null,
    requiresScreening: false,
    confirmBeforePayment: false,
    pricePolicyNote: null,
  }),
  responseTargetDays: z.number().int().min(1).max(180).nullable().default(null),
  restrictedFields: z.array(z.string().min(1).max(64)).default([]),
  policies: z.object({
    eligibilityCriteria: z.string().max(500).nullable().default(null),
    durationSummary: z.string().max(300).nullable().default(null),
    feeSummary: z.string().max(300).nullable().default(null),
    benefitsSummary: z.string().max(500).nullable().default(null),
  }).strict().default({
    eligibilityCriteria: null,
    durationSummary: null,
    feeSummary: null,
    benefitsSummary: null,
  }),
}).strict();

export type ProgrammeProfileV1 = z.infer<typeof ProgrammeProfileV1Schema>;

export interface RegisteredProgrammeDef {
  slug: string;
  name: string;
  area: CrmWorkArea;
  defaultProfile: ProgrammeProfileV1;
}

function makeDefaultProfile(
  area: CrmWorkArea,
  overrides?: Partial<Omit<ProgrammeProfileV1, 'version' | 'area' | 'engines'>> & {
    engines?: Partial<ProgrammeProfileV1['engines']>;
  },
): ProgrammeProfileV1 {
  return ProgrammeProfileV1Schema.parse({
    version: 1,
    area,
    engines: {
      applications: overrides?.engines?.applications ?? false,
      bookings: overrides?.engines?.bookings ?? false,
      membership: overrides?.engines?.membership ?? null,
      opportunities: overrides?.engines?.opportunities ?? [],
      patrons: overrides?.engines?.patrons ?? false,
    },
    forms: overrides?.forms ?? [],
    autoCreateApplications: overrides?.autoCreateApplications ?? false,
    reviewGate: overrides?.reviewGate ?? null,
    responseTargetDays: overrides?.responseTargetDays ?? null,
    restrictedFields: overrides?.restrictedFields ?? [],
  });
}

export const CRM_PROGRAMMES: readonly RegisteredProgrammeDef[] = [
  {
    slug: 'tribal-habitat-workshop',
    name: 'Tribal Habitat Workshop',
    area: 'experiences_learning',
    defaultProfile: makeDefaultProfile('experiences_learning', {
      engines: { applications: true, bookings: true },
      forms: ['ws', 'events'],
    }),
  },
  {
    slug: 'common-lab',
    name: 'Common Lab',
    area: 'experiences_learning',
    defaultProfile: makeDefaultProfile('experiences_learning', {
      engines: { applications: true, bookings: true, opportunities: ['partnership'] },
      forms: ['lab'],
    }),
  },
  {
    slug: 'dhaanyam-food-forest',
    name: 'Dhaanyam Food Forest',
    area: 'spaces_network',
    defaultProfile: makeDefaultProfile('spaces_network', {
      engines: { applications: true, bookings: true },
      forms: ['space'],
    }),
  },
  {
    slug: 'parambu-habitat',
    name: 'Parambu Habitat',
    area: 'spaces_network',
    defaultProfile: makeDefaultProfile('spaces_network', {
      engines: { applications: false, bookings: false },
    }),
  },
  {
    slug: 'common-spaces-network',
    name: 'Common Spaces network',
    area: 'spaces_network',
    defaultProfile: makeDefaultProfile('spaces_network', {
      engines: { applications: true },
      forms: ['space', 'community', 'collab'],
    }),
  },
  {
    slug: 'common-roots',
    name: 'Common Roots membership',
    area: 'community_support',
    defaultProfile: makeDefaultProfile('community_support', {
      engines: { applications: true, membership: 'common-roots' },
      forms: ['roots'],
    }),
  },
  {
    slug: 'patrons',
    name: 'Patrons',
    area: 'community_support',
    defaultProfile: makeDefaultProfile('community_support', {
      engines: { patrons: true },
      forms: ['patron'],
    }),
  },
  {
    slug: 'volunteering-internships',
    name: 'Volunteering and internships',
    area: 'community_support',
    defaultProfile: makeDefaultProfile('community_support', {
      engines: { applications: true },
      forms: ['intern'],
    }),
  },
  {
    slug: 'partnerships-collaborations',
    name: 'Partnerships and collaborations',
    area: 'collaboration_work',
    defaultProfile: makeDefaultProfile('collaboration_work', {
      engines: { applications: true, opportunities: ['partnership', 'funding'] },
      forms: ['collab'],
    }),
  },
  {
    slug: 'architecture-consulting',
    name: 'Architecture and consulting',
    area: 'collaboration_work',
    defaultProfile: makeDefaultProfile('collaboration_work', {
      engines: { opportunities: ['consulting'] },
      forms: ['consulting', 'arch'],
    }),
  },
  {
    slug: 'common-ground-production',
    name: 'Common Ground Production',
    area: 'collaboration_work',
    defaultProfile: makeDefaultProfile('collaboration_work', {
      engines: { applications: true, opportunities: ['production'] },
    }),
  },
  {
    slug: 'fashion-flow',
    name: 'Fashion Flow',
    area: 'culture_making',
    defaultProfile: makeDefaultProfile('culture_making', {
      engines: { applications: true, bookings: true },
      forms: ['ff'],
    }),
  },
  {
    slug: 'common-culture',
    name: 'Common Culture',
    area: 'culture_making',
    defaultProfile: makeDefaultProfile('culture_making', {
      engines: { applications: true, bookings: true },
      forms: ['book'],
    }),
  },
  {
    slug: 'common-cupboard',
    name: 'Common Cupboard',
    area: 'culture_making',
    defaultProfile: makeDefaultProfile('culture_making', {
      engines: { opportunities: ['supply'] },
    }),
  },
] as const;

export const CRM_PROGRAMME_BY_SLUG = new Map<string, RegisteredProgrammeDef>(
  CRM_PROGRAMMES.map((p) => [p.slug, p]),
);

export function isRegisteredProgrammeSlug(slug: string): boolean {
  return CRM_PROGRAMME_BY_SLUG.has(slug);
}

export function parseProgrammeScope(scope: string): { ok: true; slug: string | '*' } | { ok: false } {
  if (scope === '*') return { ok: true, slug: '*' };
  if (!scope.startsWith('programme:')) return { ok: false };
  const slug = scope.slice('programme:'.length);
  return isRegisteredProgrammeSlug(slug) ? { ok: true, slug } : { ok: false };
}

export function programmeScopeForSlug(slug: string): string {
  return `programme:${slug}`;
}

export function programmeForWebsiteForm(formId: string | null | undefined): RegisteredProgrammeDef | undefined {
  if (!formId) return undefined;
  if (formId.startsWith('vol-')) return CRM_PROGRAMME_BY_SLUG.get('volunteering-internships');
  return CRM_PROGRAMMES.find((p) => p.defaultProfile.forms.includes(formId));
}

// ---------------------------------------------------------------------------
// S2 / S3 Wire Contracts (Programmes, Applications, Timeline, Home My Work)
// ---------------------------------------------------------------------------

export const UpdateProgrammeProfileInputSchema = z.object({
  slug: z.string().min(1).max(64),
  profile: ProgrammeProfileV1Schema,
  expectedRev: z.number().int().min(1).optional(),
  programmeRecordId: z.string().min(1).max(128).optional(),
}).strict();
export type UpdateProgrammeProfileInput = z.infer<typeof UpdateProgrammeProfileInputSchema>;

export const ProgrammeSummaryDtoSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  area: CrmWorkAreaSchema,
  recordId: z.string().nullable(),
  rev: z.number().int().min(0),
  updatedAt: z.number().int().nullable(),
  updatedBy: z.string().nullable(),
  canConfigure: z.boolean(),
  profile: ProgrammeProfileV1Schema,
  counts: z.object({
    applications: z.number().int().nonnegative(),
    opportunities: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
    people: z.number().int().nonnegative(),
  }).strict(),
}).strict();
export type ProgrammeSummaryDto = z.infer<typeof ProgrammeSummaryDtoSchema>;

export const ProgrammesListResponseSchema = z.object({
  programmes: z.array(ProgrammeSummaryDtoSchema),
  partial: z.boolean(),
}).strict();
export type ProgrammesListResponse = z.infer<typeof ProgrammesListResponseSchema>;

export const CreateApplicationFromSubmissionInputSchema = z.object({
  submissionId: z.string().min(1).max(128),
  programmeSlug: z.string().min(1).max(64).optional(),
  personId: z.string().min(1).max(128).optional(),
  applicationsBoardId: z.string().min(1).max(128).optional(),
  reviewerId: z.string().min(1).max(128).optional(),
  note: z.string().max(1000).optional(),
}).strict();
export type CreateApplicationFromSubmissionInput = z.infer<typeof CreateApplicationFromSubmissionInputSchema>;

export const APPLICATION_CONVERT_TARGETS = ['project', 'opportunity', 'event'] as const;
export type ApplicationConvertTarget = typeof APPLICATION_CONVERT_TARGETS[number];

export const ConvertApplicationInputSchema = z.object({
  applicationId: z.string().min(1).max(128),
  targetKind: z.enum(APPLICATION_CONVERT_TARGETS),
  targetBoardId: z.string().min(1).max(128),
  title: z.string().trim().min(1).max(200).optional(),
  pipelineId: z.string().min(1).max(64).optional(),
}).strict();
export type ConvertApplicationInput = z.infer<typeof ConvertApplicationInputSchema>;

export const TIMELINE_ENTRY_KINDS = [
  'submission',
  'application',
  'activity',
  'conversation',
  'approval',
  'conversion',
  'consent',
  'workspace_activity',
  'booking',
  'membership',
] as const;
export type TimelineEntryKind = typeof TIMELINE_ENTRY_KINDS[number];

export const TimelineEntryDtoSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(TIMELINE_ENTRY_KINDS),
  ts: z.number().int().nonnegative(),
  title: z.string().min(1),
  subtitle: z.string().nullable(),
  actorName: z.string().nullable(),
  linkToRecordId: z.string().nullable().optional(),
  boardId: z.string().nullable().optional(),
  conversationId: z.string().nullable().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type TimelineEntryDto = z.infer<typeof TimelineEntryDtoSchema>;

export const TimelineResponseSchema = z.object({
  subjectId: z.string().min(1),
  items: z.array(TimelineEntryDtoSchema),
  next: z.string().nullable(),
  partial: z.boolean(),
}).strict();
export type TimelineResponse = z.infer<typeof TimelineResponseSchema>;

export const HOME_ITEM_KINDS = [
  'followup_overdue',
  'followup_due',
  'approval_pending',
  'application_ageing',
  'conversation_unanswered',
  'recent_record',
  'hold_expiring',
  'paid_without_seat',
  'membership_renewal_due',
] as const;
export type HomeItemKind = typeof HOME_ITEM_KINDS[number];

export const HomeWorkItemDtoSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(HOME_ITEM_KINDS),
  title: z.string().min(1),
  subtitle: z.string(),
  dueTs: z.number().int().nullable(),
  updatedTs: z.number().int().nonnegative(),
  route: z.string().min(1),
  urgency: z.enum(['high', 'normal', 'low']),
  recordId: z.string().nullable().optional(),
  boardId: z.string().nullable().optional(),
  conversationId: z.string().nullable().optional(),
}).strict();
export type HomeWorkItemDto = z.infer<typeof HomeWorkItemDtoSchema>;

export const HomeSummaryResponseSchema = z.object({
  today: z.array(HomeWorkItemDtoSchema),
  shared: z.array(HomeWorkItemDtoSchema),
  thisWeek: z.array(HomeWorkItemDtoSchema),
  recently: z.array(HomeWorkItemDtoSchema),
  counts: z.object({
    ageingApplications: z.number().int().nonnegative(),
    pendingApprovals: z.number().int().nonnegative(),
    dueFollowUps: z.number().int().nonnegative(),
    unansweredConversations: z.number().int().nonnegative(),
    unassignedFollowUps: z.number().int().nonnegative(),
    unassignedConversations: z.number().int().nonnegative(),
  }).strict(),
  partial: z.boolean(),
}).strict();
export type HomeSummaryResponse = z.infer<typeof HomeSummaryResponseSchema>;
