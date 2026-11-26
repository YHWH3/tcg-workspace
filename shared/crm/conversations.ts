import { z } from 'zod';
import { CRM_CHANNELS } from './capabilities';
import { CrmTemplateDtoSchema } from './channels';
import { CrmConsentScopeSchema } from './identity';
import type { ProgrammeProfileV1 } from './programmes';

export const CONVERSATION_CHANNELS = [
  'email',
  'whatsapp',
  'instagram',
  'facebook',
  'call',
  'in_person',
] as const;
export type ConversationChannel = (typeof CONVERSATION_CHANNELS)[number];

export const CONVERSATION_STATES = ['open', 'snoozed', 'closed', 'spam'] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

export const CONVERSATION_FILTERS = [
  'all',
  'unassigned',
  'mine',
  'unmatched',
  'snoozed',
  'closed',
] as const;
export type ConversationFilter = (typeof CONVERSATION_FILTERS)[number];

export const FACT_STATUSES = ['draft', 'verified', 'retired'] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

export const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isChannelWindowOpen(
  channel: ConversationChannel,
  windowExpiresAt: number | null | undefined,
  now = Date.now(),
): boolean {
  if (channel === 'email' || channel === 'call' || channel === 'in_person') return true;
  return typeof windowExpiresAt === 'number' && Number.isFinite(windowExpiresAt) && windowExpiresAt > now;
}

export function isFactStale(
  fact: { status?: FactStatus; reviewBy: number | null },
  now = Date.now(),
): boolean {
  if (fact.status && fact.status !== 'verified') return false;
  return fact.reviewBy !== null && fact.reviewBy < now;
}

export const CrmFactDtoSchema = z.object({
  id: z.string().min(1),
  scope: z.string().min(1),
  programmeSlug: z.string().nullable(),
  category: z.string().min(1),
  title: z.string().min(1),
  statement: z.string().min(1),
  sourceRef: z.string().nullable(),
  status: z.enum(FACT_STATUSES),
  reviewBy: z.number().int().nullable(),
  isStale: z.boolean(),
  verifiedBy: z.string().nullable(),
  verifiedAt: z.number().int().nullable(),
  rev: z.number().int().min(1),
  createdBy: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict();
export type CrmFactDto = z.infer<typeof CrmFactDtoSchema>;

export const ProposeFactInputSchema = z.object({
  programmeSlug: z.string().min(1).max(64).nullable().optional(),
  category: z.string().trim().min(1).max(64).default('general'),
  title: z.string().trim().min(1).max(200),
  statement: z.string().trim().min(1).max(2000),
  sourceRef: z.string().trim().max(300).nullable().optional(),
  reviewBy: z.number().int().positive().nullable().optional(),
}).strict();
export type ProposeFactInput = z.infer<typeof ProposeFactInputSchema>;

export const VerifyFactInputSchema = z.object({
  factId: z.string().min(1).max(128),
  reviewBy: z.number().int().positive().nullable().optional(),
  expectedRev: z.number().int().min(1).optional(),
}).strict();
export type VerifyFactInput = z.infer<typeof VerifyFactInputSchema>;

export const RetireFactInputSchema = z.object({
  factId: z.string().min(1).max(128),
  expectedRev: z.number().int().min(1).optional(),
}).strict();
export type RetireFactInput = z.infer<typeof RetireFactInputSchema>;

export const FactsListResponseSchema = z.object({
  facts: z.array(CrmFactDtoSchema),
  partial: z.boolean(),
}).strict();
export type FactsListResponse = z.infer<typeof FactsListResponseSchema>;

export const LogManualConversationInputSchema = z.object({
  channel: z.enum(CONVERSATION_CHANNELS),
  personId: z.string().min(1).max(128).nullable().optional(),
  programmeSlug: z.string().min(1).max(64).nullable().optional(),
  subject: z.string().trim().min(1).max(200),
  direction: z.enum(['inbound', 'outbound']).default('inbound'),
  bodyText: z.string().trim().min(1).max(8000),
}).strict();
export type LogManualConversationInput = z.infer<typeof LogManualConversationInputSchema>;

export const SimulateInboundInputSchema = z.object({
  channel: z.enum(CRM_CHANNELS),
  externalEventId: z.string().trim().min(1).max(128),
  externalThreadId: z.string().trim().min(1).max(128).optional(),
  fromValue: z.string().trim().min(1).max(320),
  subject: z.string().trim().max(200).optional(),
  bodyText: z.string().trim().min(1).max(8000),
  programmeSlug: z.string().min(1).max(64).nullable().optional(),
}).strict();
export type SimulateInboundInput = z.infer<typeof SimulateInboundInputSchema>;

export const LinkConversationPersonInputSchema = z.object({
  conversationId: z.string().min(1).max(128),
  personId: z.string().min(1).max(128),
  expectedRev: z.number().int().min(1).optional(),
}).strict();
export type LinkConversationPersonInput = z.infer<typeof LinkConversationPersonInputSchema>;

export const AssignConversationInputSchema = z.object({
  conversationId: z.string().min(1).max(128),
  assigneeId: z.string().min(1).max(128).nullable(),
  expectedRev: z.number().int().min(1).optional(),
}).strict();
export type AssignConversationInput = z.infer<typeof AssignConversationInputSchema>;

export const SetConversationStateInputSchema = z.object({
  conversationId: z.string().min(1).max(128),
  state: z.enum(CONVERSATION_STATES),
  expectedRev: z.number().int().min(1).optional(),
}).strict();
export type SetConversationStateInput = z.infer<typeof SetConversationStateInputSchema>;

export const AddMessageNoteInputSchema = z.object({
  conversationId: z.string().min(1).max(128),
  bodyText: z.string().trim().min(1).max(8000),
}).strict();
export type AddMessageNoteInput = z.infer<typeof AddMessageNoteInputSchema>;

export const SaveMessageDraftInputSchema = z.object({
  conversationId: z.string().min(1).max(128),
  messageId: z.string().min(1).max(128).optional(),
  bodyText: z.string().trim().min(1).max(8000),
  aiMetadata: z.object({
    citedFactIds: z.array(z.string().max(64)).max(50),
    unconfirmedItems: z.array(z.string().max(300)).max(50),
    staleFactWarnings: z.array(z.string().max(300)).max(50).optional(),
  }).strict().optional(),
}).strict();
export type SaveMessageDraftInput = z.infer<typeof SaveMessageDraftInputSchema>;

export const SendMessageInputSchema = z.object({
  conversationId: z.string().min(1).max(128),
  messageId: z.string().min(1).max(128).optional(),
  bodyText: z.string().trim().min(1).max(8000),
  templateId: z.string().min(1).max(128).optional(),
  templateParams: z.array(z.string().max(500)).max(12).optional(),
  purpose: CrmConsentScopeSchema.optional(),
  useHumanAgentTag: z.boolean().optional(),
  deliveryMode: z.enum(['immediate', 'queued']).optional(),
}).strict();
export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

export const RetryMessageInputSchema = z.object({
  messageId: z.string().min(1).max(128),
}).strict();
export type RetryMessageInput = z.infer<typeof RetryMessageInputSchema>;

export const GenerateAiDraftInputSchema = z.object({
  conversationId: z.string().min(1).max(128),
  prompt: z.string().trim().max(500).optional(),
}).strict();
export type GenerateAiDraftInput = z.infer<typeof GenerateAiDraftInputSchema>;

export const CrmMessageDtoSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  direction: z.enum(['inbound', 'outbound', 'note']),
  status: z.enum(['received', 'draft', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'review_required', 'cancelled', 'note']),
  channel: z.string().min(1),
  senderEndpoint: z.string().nullable(),
  recipientEndpoint: z.string().nullable(),
  authorUserId: z.string().nullable(),
  authorName: z.string().nullable(),
  bodyText: z.string(),
  rfcMessageId: z.string().nullable().optional(),
  inReplyTo: z.string().nullable().optional(),
  templateId: z.string().nullable().optional(),
  messageTag: z.string().nullable().optional(),
  aiMetadata: z.object({
    citedFactIds: z.array(z.string()).default([]),
    unconfirmedItems: z.array(z.string()).default([]),
    staleFactWarnings: z.array(z.string()).default([]),
  }).nullable(),
  errorCode: z.string().nullable(),
  errorDetail: z.string().nullable(),
  sentAt: z.number().int().nullable(),
  deliveredAt: z.number().int().nullable().optional(),
  readAt: z.number().int().nullable().optional(),
  createdAt: z.number().int().nonnegative(),
}).strict();
export type CrmMessageDto = z.infer<typeof CrmMessageDtoSchema>;

export const CrmConversationDtoSchema = z.object({
  id: z.string().min(1),
  channel: z.enum(CONVERSATION_CHANNELS),
  channelAccountId: z.string().nullable().optional(),
  externalThreadId: z.string().nullable(),
  personId: z.string().nullable(),
  personName: z.string().nullable(),
  programmeSlug: z.string().nullable(),
  applicationId: z.string().nullable(),
  subject: z.string(),
  state: z.enum(CONVERSATION_STATES),
  assigneeId: z.string().nullable(),
  assigneeName: z.string().nullable(),
  windowExpiresAt: z.number().int().nullable(),
  windowOpen: z.boolean(),
  humanAgentWindowExpiresAt: z.number().int().nullable().optional(),
  humanAgentEligible: z.boolean().optional(),
  requiresTemplate: z.boolean().optional(),
  lastMessageAt: z.number().int().nonnegative(),
  lastInboundAt: z.number().int().nullable(),
  lastOutboundAt: z.number().int().nullable(),
  unreadCount: z.number().int().nonnegative(),
  rev: z.number().int().min(1),
  createdAt: z.number().int().nonnegative(),
}).strict();
export type CrmConversationDto = z.infer<typeof CrmConversationDtoSchema>;

export const ConversationsPageResponseSchema = z.object({
  items: z.array(CrmConversationDtoSchema),
  next: z.string().nullable(),
  counts: z.object({
    all: z.number().int().nonnegative(),
    unassigned: z.number().int().nonnegative(),
    mine: z.number().int().nonnegative(),
    unmatched: z.number().int().nonnegative(),
    snoozed: z.number().int().nonnegative(),
    closed: z.number().int().nonnegative(),
  }).strict(),
  simulatedMode: z.boolean(),
  partial: z.boolean(),
}).strict();
export type ConversationsPageResponse = z.infer<typeof ConversationsPageResponseSchema>;

export const ConversationDetailResponseSchema = z.object({
  conversation: CrmConversationDtoSchema,
  messages: z.array(CrmMessageDtoSchema),
  personEndpoints: z.array(z.object({
    id: z.string(),
    kind: z.string(),
    valueNorm: z.string(),
    isPrimary: z.boolean(),
  }).strict()),
  consentStatus: z.enum(['granted', 'withdrawn', 'unrecorded']),
  verifiedFacts: z.array(CrmFactDtoSchema),
  staleFacts: z.array(CrmFactDtoSchema),
  approvedTemplates: z.array(CrmTemplateDtoSchema).optional(),
  channelAccountMode: z.enum(['simulated', 'production', 'disabled']).optional(),
  canSend: z.boolean(),
  simulatedMode: z.boolean(),
}).strict();
export type ConversationDetailResponse = z.infer<typeof ConversationDetailResponseSchema>;

/**
 * Deterministic AI draft composer strictly grounded in verified, non-stale `crm_facts`.
 * Never invents prices, capacities, durations, or dates; flags unconfigured/stale items explicitly.
 */
export function composeGroundedAiDraft(opts: {
  personName: string | null;
  subject: string;
  verifiedFacts: readonly CrmFactDto[];
  staleFacts: readonly CrmFactDto[];
  programmeProfile?: ProgrammeProfileV1 | null;
  prompt?: string | null;
  now?: number;
}): {
  bodyText: string;
  citedFactIds: string[];
  unconfirmedItems: string[];
  staleFactWarnings: string[];
} {
  const now = opts.now ?? Date.now();
  const eligible = opts.verifiedFacts.filter((f) => f.status === 'verified' && !isFactStale(f, now));
  const staleWarnings = opts.staleFacts.map((f) => `${f.title} (stale — review before citing)`);

  const greetingName = opts.personName?.trim() || 'there';
  const lines: string[] = [`Hi ${greetingName},`, '', `Thank you for your note regarding ${opts.subject || 'your enquiry'}.`];

  const citedFactIds: string[] = [];
  if (eligible.length > 0) {
    lines.push('');
    for (const fact of eligible.slice(0, 4)) {
      citedFactIds.push(fact.id);
      lines.push(`- ${fact.statement} [fact:${fact.id}]`);
    }
  } else {
    lines.push('', 'We have received your message and our team is reviewing the details carefully.');
  }

  const unconfirmedItems: string[] = [];
  if (opts.programmeProfile) {
    if (!opts.programmeProfile.policies.feeSummary) unconfirmedItems.push('Fee / pricing policy');
    if (!opts.programmeProfile.policies.durationSummary) unconfirmedItems.push('Schedule / duration details');
    if (!opts.programmeProfile.policies.eligibilityCriteria) unconfirmedItems.push('Eligibility criteria');
  }
  if (eligible.length === 0) {
    unconfirmedItems.push('Verified programme facts for this enquiry');
  }
  if (opts.staleFacts.length > 0) {
    unconfirmedItems.push(`Stale facts awaiting re-verification (${opts.staleFacts.length})`);
  }

  if (unconfirmedItems.length > 0) {
    lines.push('', 'To be confirmed by staff before sending:');
    for (const item of unconfirmedItems) {
      lines.push(`- ${item} (To be confirmed)`);
    }
  }

  if (opts.prompt?.trim()) {
    lines.push('', `[Staff guidance noted: ${opts.prompt.trim().slice(0, 160)}]`);
  }

  lines.push('', 'Warm regards,', 'The Common Ground team');

  return {
    bodyText: lines.join('\n'),
    citedFactIds,
    unconfirmedItems,
    staleFactWarnings: staleWarnings,
  };
}
