import { z } from 'zod';
import { PATRON_TIERS } from '../websiteInbox';

export const CRM_PIPELINES = [
  { id: 'partnership', label: 'Partnership / collaboration', description: 'Joint programmes, research, and long-term collaborations' },
  { id: 'consulting', label: 'Architecture / consulting', description: 'Spatial, ecological, and architectural advisory mandates' },
  { id: 'production', label: 'Production', description: 'Craft, garment, book, and film commissions and production runs' },
  { id: 'funding', label: 'Funding / institutional', description: 'Grants, fellowships, sponsorships, and institutional support' },
  { id: 'supply', label: 'Supply', description: 'Materials, Common Cupboard retail supply, and recurring sourcing' },
] as const;

export type CrmPipelineId = (typeof CRM_PIPELINES)[number]['id'];

export const HandoffOpportunityToProjectInputSchema = z.object({
  opportunityId: z.string().min(1).max(128),
  projectsBoardId: z.string().min(1).max(128),
  title: z.string().trim().min(1).max(200).optional(),
}).strict();
export type HandoffOpportunityToProjectInput = z.infer<typeof HandoffOpportunityToProjectInputSchema>;

export const PatronProjectionDtoSchema = z.object({
  submissionId: z.string().min(1),
  personId: z.string().nullable(),
  title: z.string().min(1),
  email: z.string().nullable(),
  tier: z.enum(PATRON_TIERS).nullable(),
  stage: z.string().nullable(),
  edition: z.string().nullable(),
  event: z.string().nullable(),
  received: z.string().nullable(),
  paid: z.string().nullable(),
  applicationCode: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  boardId: z.string().min(1),
}).strict();
export type PatronProjectionDto = z.infer<typeof PatronProjectionDtoSchema>;

export const PatronsReadResponseSchema = z.object({
  readOnly: z.literal(true),
  items: z.array(PatronProjectionDtoSchema),
  countsByTier: z.object({
    founding: z.number().int().nonnegative(),
    builder: z.number().int().nonnegative(),
    partner: z.number().int().nonnegative(),
    unspecified: z.number().int().nonnegative(),
  }).strict(),
  partial: z.boolean(),
}).strict();
export type PatronsReadResponse = z.infer<typeof PatronsReadResponseSchema>;
