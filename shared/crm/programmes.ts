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
