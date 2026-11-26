import { z } from 'zod';
import { CRM_CHANNELS, type CrmChannel } from './capabilities';
import { CrmConsentScopeSchema } from './identity';

export const CHANNEL_PROVIDERS = [
  'email_zoho',
  'whatsapp_cloud',
  'instagram_meta',
  'facebook_meta',
  'simulated',
] as const;
export type ChannelProvider = (typeof CHANNEL_PROVIDERS)[number];
export const ChannelProviderSchema = z.enum(CHANNEL_PROVIDERS);

export const CHANNEL_ACCOUNT_MODES = ['simulated', 'production', 'disabled'] as const;
export type ChannelAccountMode = (typeof CHANNEL_ACCOUNT_MODES)[number];
export const ChannelAccountModeSchema = z.enum(CHANNEL_ACCOUNT_MODES);

export const CHANNEL_HEALTH_STATES = ['disconnected', 'connected', 'degraded', 'error'] as const;
export type ChannelHealthState = (typeof CHANNEL_HEALTH_STATES)[number];
export const ChannelHealthStateSchema = z.enum(CHANNEL_HEALTH_STATES);

export const TEMPLATE_CATEGORIES = ['utility', 'marketing', 'authentication', 'service'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];
export const TemplateCategorySchema = z.enum(TEMPLATE_CATEGORIES);

export const TEMPLATE_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'paused', 'retired'] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];
export const TemplateStatusSchema = z.enum(TEMPLATE_STATUSES);

export const OUTBOX_STATUSES = ['queued', 'sending', 'sent', 'failed', 'review_required', 'cancelled'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];
export const OutboxStatusSchema = z.enum(OUTBOX_STATUSES);

export const ADAPTER_ERROR_CLASSES = [
  'auth',
  'rate_limited',
  'window_closed',
  'recipient_invalid',
  'blocked',
  'content_rejected',
  'transient',
  'unknown',
] as const;
export type AdapterErrorClass = (typeof ADAPTER_ERROR_CLASSES)[number];
export const AdapterErrorClassSchema = z.enum(ADAPTER_ERROR_CLASSES);

export const ZOHO_DATA_CENTERS = ['com', 'in', 'eu', 'com.au', 'jp', 'ca'] as const;
export type ZohoDataCenter = (typeof ZOHO_DATA_CENTERS)[number];
export const ZohoDataCenterSchema = z.enum(ZOHO_DATA_CENTERS);

/** Exact official Zoho Mail REST API host allowlist per regional data centre. */
export const ZOHO_API_HOSTS: Readonly<Record<ZohoDataCenter, string>> = {
  com: 'mail.zoho.com',
  in: 'mail.zoho.in',
  eu: 'mail.zoho.eu',
  'com.au': 'mail.zoho.com.au',
  jp: 'mail.zoho.jp',
  ca: 'mail.zoho.ca',
};

/** Exact official Zoho OAuth token host allowlist per regional data centre. */
export const ZOHO_ACCOUNTS_HOSTS: Readonly<Record<ZohoDataCenter, string>> = {
  com: 'accounts.zoho.com',
  in: 'accounts.zoho.in',
  eu: 'accounts.zoho.eu',
  'com.au': 'accounts.zoho.com.au',
  jp: 'accounts.zoho.jp',
  ca: 'accounts.zoho.ca',
};

/** Exact official Meta Graph API host (WhatsApp Cloud, Instagram Messaging, Facebook Messenger). */
export const META_GRAPH_HOST = 'graph.facebook.com';
export const META_DEFAULT_GRAPH_VERSION = 'v21.0';

/** Standard Meta 24-hour customer service / messaging window. */
export const STANDARD_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Meta HUMAN_AGENT tag extended window (7 days, human-only UI replies). */
export const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Default outbox retry backoff schedule: 30s -> 2m -> 10m. */
export const OUTBOX_BACKOFF_SCHEDULE_MS = [30_000, 120_000, 600_000] as const;
export const OUTBOX_LEASE_MS = 60_000;
export const POLL_LEASE_MS = 60_000;

export function isRetryableAdapterError(errClass: AdapterErrorClass): boolean {
  return errClass === 'transient' || errClass === 'rate_limited';
}

export function computeOutboxBackoffMs(attemptNumber: number): number {
  const idx = Math.max(0, Math.min(OUTBOX_BACKOFF_SCHEDULE_MS.length - 1, attemptNumber - 1));
  return OUTBOX_BACKOFF_SCHEDULE_MS[idx]!;
}

/** Monotonic progression rank for provider message delivery status receipts. */
export const MESSAGE_STATUS_RANK: Readonly<Record<string, number>> = {
  draft: 0,
  queued: 1,
  sending: 2,
  sent: 3,
  delivered: 4,
  read: 5,
};

export function canAdvanceMessageStatus(current: string, next: 'sent' | 'delivered' | 'read' | 'failed'): boolean {
  if (next === 'failed') {
    return current === 'queued' || current === 'sending' || current === 'sent';
  }
  const curRank = MESSAGE_STATUS_RANK[current];
  const nextRank = MESSAGE_STATUS_RANK[next];
  if (curRank === undefined || nextRank === undefined) return false;
  return nextRank > curRank;
}

/** Provider-specific allowed channel mapping. */
export function isProviderCompatibleWithChannel(provider: ChannelProvider, channel: CrmChannel): boolean {
  if (provider === 'simulated') return true;
  if (provider === 'email_zoho') return channel === 'email';
  if (provider === 'whatsapp_cloud') return channel === 'whatsapp';
  if (provider === 'instagram_meta') return channel === 'instagram';
  if (provider === 'facebook_meta') return channel === 'facebook';
  return false;
}

/* ---------- Messaging Window Evaluation ---------- */

export interface ChannelWindowEvaluation {
  open: boolean;
  standardOpen: boolean;
  humanAgentEligible: boolean;
  requiresTemplate: boolean;
  requiresHumanAgentTag: boolean;
  closesAt: number | null;
  humanAgentClosesAt: number | null;
}

/**
 * Evaluates messaging window eligibility per official channel rules:
 * - Email / manual channels: always open, never requires template or tag.
 * - WhatsApp Cloud API: 24h customer service window; closed window requires an approved template.
 * - Instagram / Facebook Messaging: 24h standard window; between 24h and 7d, human UI replies
 *   are eligible ONLY when `humanAgentApproved` is true and `via === 'ui'` (tag = HUMAN_AGENT).
 */
export function evaluateChannelWindow(args: {
  channel: string;
  windowExpiresAt: number | null;
  humanAgentWindowExpiresAt?: number | null;
  humanAgentApproved?: boolean;
  via?: 'ui' | 'mcp' | 'automation' | 'ingest';
  now: number;
}): ChannelWindowEvaluation {
  const { channel, windowExpiresAt, humanAgentWindowExpiresAt = null, humanAgentApproved = false, via = 'ui', now } = args;
  if (channel === 'email' || channel === 'call' || channel === 'in_person') {
    return {
      open: true,
      standardOpen: true,
      humanAgentEligible: false,
      requiresTemplate: false,
      requiresHumanAgentTag: false,
      closesAt: null,
      humanAgentClosesAt: null,
    };
  }

  const standardOpen = typeof windowExpiresAt === 'number' && windowExpiresAt > now;
  if (channel === 'whatsapp') {
    return {
      open: standardOpen,
      standardOpen,
      humanAgentEligible: false,
      requiresTemplate: !standardOpen,
      requiresHumanAgentTag: false,
      closesAt: windowExpiresAt,
      humanAgentClosesAt: null,
    };
  }

  // Instagram & Facebook Messenger
  const humanAgentOpen =
    via === 'ui' &&
    humanAgentApproved &&
    typeof humanAgentWindowExpiresAt === 'number' &&
    humanAgentWindowExpiresAt > now;

  return {
    open: standardOpen || humanAgentOpen,
    standardOpen,
    humanAgentEligible: !standardOpen && humanAgentOpen,
    requiresTemplate: false,
    requiresHumanAgentTag: !standardOpen && humanAgentOpen,
    closesAt: windowExpiresAt,
    humanAgentClosesAt: humanAgentWindowExpiresAt,
  };
}

/* ---------- RFC 5322 Email Header Threading Helpers ---------- */

const RFC_MSG_ID_RE = /<[^<>\s@]+@[^<>\s@]+>/g;

/** Normalizes a single RFC 5322 Message-ID into canonical `<local@domain>` form (case-preserved, trimmed). */
export function normalizeRfcMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 512) return null;
  const match = trimmed.match(RFC_MSG_ID_RE);
  if (match && match[0]) return match[0];
  if (/^[^\s<>@]+@[^\s<>@]+$/.test(trimmed)) return `<${trimmed}>`;
  return null;
}

/** Parses an RFC 5322 References / In-Reply-To header string or array into ordered unique canonical Message-IDs. */
export function parseRfcReferences(raw: string | readonly string[] | null | undefined): string[] {
  if (!raw) return [];
  const joined: string = typeof raw === 'string' ? raw : raw.join(' ');
  const matches = joined.match(RFC_MSG_ID_RE) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    if (m.length > 512 || seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  if (out.length === 0 && typeof raw === 'string') {
    const single = normalizeRfcMessageId(raw);
    if (single) out.push(single);
  }
  return out.slice(-30);
}

/** Builds an outbound RFC 5322 References chain from prior references + parent Message-ID (bounded to 30 IDs). */
export function buildRfcReferences(priorRefs: readonly string[], parentMsgId: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of priorRefs) {
    const n = normalizeRfcMessageId(r);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  const p = normalizeRfcMessageId(parentMsgId);
  if (p && !seen.has(p)) {
    out.push(p);
  }
  return out.slice(-30);
}

/** Display-only subject normalization (NEVER used for email threading). */
export function normalizeEmailSubject(subject: string | null | undefined): string {
  if (!subject) return '';
  return subject
    .replace(/^(\s*(re|fwd|fw)\s*:\s*)+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/* ---------- Opt-Out Detection & Provider-Scoped Identity Normalization ---------- */

const OPT_OUT_PATTERNS = [
  /^stop$/i,
  /^stop\s+all$/i,
  /^unsubscribe$/i,
  /^opt[\s-]?out$/i,
  /^cancel$/i,
  /^end$/i,
  /^quit$/i,
  /^do\s+not\s+(message|contact|email|text)(\s+me)?$/i,
];

/** Recognizes unambiguous customer opt-out commands on WhatsApp/IG/FB/Email replies. */
export function isOptOutMessageText(bodyText: string | null | undefined): boolean {
  if (!bodyText) return false;
  const cleaned = bodyText.trim().replace(/[.!?]+$/g, '').trim();
  if (!cleaned || cleaned.length > 64) return false;
  return OPT_OUT_PATTERNS.some((re) => re.test(cleaned));
}

/** Normalizes Instagram (IGSID) or Facebook (PSID) provider-scoped recipient identifier cleanly. */
export function normalizeMetaScopedId(channel: 'instagram' | 'facebook', rawId: string): string | null {
  const trimmed = rawId.trim();
  if (!trimmed || trimmed.length > 128) return null;
  const prefix = channel === 'instagram' ? 'igsid:' : 'psid:';
  const bare = trimmed.replace(/^(igsid:|psid:)/i, '').trim();
  if (!/^[a-zA-Z0-9._-]{3,100}$/.test(bare)) return null;
  return `${prefix}${bare}`;
}

/* ---------- Channel Account, Template & Delivery DTOs ---------- */

export const ChannelAccountConfigSchema = z.object({
  // Zoho Mail (O-20 pending before production enablement)
  dataCenter: ZohoDataCenterSchema.optional(),
  zohoAccountId: z.string().trim().min(1).max(128).optional(),
  fromAddress: z.string().trim().email().max(254).optional(),
  folderId: z.string().trim().min(1).max(128).optional(),
  pollSentCopies: z.boolean().optional(),
  fallbackProtocol: z.enum(['none', 'imap_smtp']).optional(),
  // Meta WhatsApp / Instagram / Facebook (O-04 pending before production enablement)
  graphVersion: z.string().regex(/^v\d+\.\d+$/).optional(),
  phoneNumberId: z.string().trim().min(1).max(64).optional(),
  wabaId: z.string().trim().min(1).max(64).optional(),
  pageId: z.string().trim().min(1).max(64).optional(),
  instagramAccountId: z.string().trim().min(1).max(64).optional(),
  humanAgentApproved: z.boolean().optional(),
  // Local-test simulated behavior knobs (ignored outside local-test)
  simulatedBehavior: z
    .enum(['succeed', 'transient_fail', 'rate_limited', 'auth_error', 'ambiguous', 'recipient_invalid', 'blocked'])
    .optional(),
}).strict();
export type ChannelAccountConfig = z.infer<typeof ChannelAccountConfigSchema>;

export const CrmChannelAccountDtoSchema = z.object({
  id: z.string(),
  channel: z.enum(CRM_CHANNELS),
  provider: ChannelProviderSchema,
  label: z.string(),
  externalId: z.string(),
  mode: ChannelAccountModeSchema,
  active: z.boolean(),
  secretName: z.string().nullable(),
  secretBound: z.boolean(),
  config: ChannelAccountConfigSchema,
  pollCursor: z.string().nullable(),
  lastPollAt: z.number().int().nullable(),
  healthState: ChannelHealthStateSchema,
  lastError: z.string().nullable(),
  lastErrorAt: z.number().int().nullable(),
  rev: z.number().int().positive(),
  updatedAt: z.number().int(),
}).strict();
export type CrmChannelAccountDto = z.infer<typeof CrmChannelAccountDtoSchema>;

export const CrmTemplateDtoSchema = z.object({
  id: z.string(),
  channel: z.enum(CRM_CHANNELS),
  channelAccountId: z.string().nullable(),
  name: z.string(),
  language: z.string(),
  category: TemplateCategorySchema,
  providerTemplateId: z.string().nullable(),
  status: TemplateStatusSchema,
  bodyText: z.string(),
  variables: z.array(z.string()),
  rejectionReason: z.string().nullable(),
  submittedAt: z.number().int().nullable(),
  approvedAt: z.number().int().nullable(),
  rev: z.number().int().positive(),
  updatedAt: z.number().int(),
}).strict();
export type CrmTemplateDto = z.infer<typeof CrmTemplateDtoSchema>;

export const CrmOutboxDeliveryDtoSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  conversationId: z.string(),
  conversationSubject: z.string(),
  channel: z.string(),
  channelAccountId: z.string().nullable(),
  recipientEndpoint: z.string().nullable(),
  bodyPreview: z.string(),
  status: OutboxStatusSchema,
  purpose: CrmConsentScopeSchema,
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  nextAttemptAt: z.number().int().nullable(),
  lastErrorClass: AdapterErrorClassSchema.nullable(),
  lastError: z.string().nullable(),
  providerReceipt: z.string().nullable(),
  messageTag: z.string().nullable(),
  templateId: z.string().nullable(),
  resolutionNote: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  resolvedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
}).strict();
export type CrmOutboxDeliveryDto = z.infer<typeof CrmOutboxDeliveryDtoSchema>;

export const ChannelsOverviewResponseSchema = z.object({
  accounts: z.array(CrmChannelAccountDtoSchema),
  templates: z.array(CrmTemplateDtoSchema),
  deliveries: z.array(CrmOutboxDeliveryDtoSchema),
  counts: z.object({
    queued: z.number().int().nonnegative(),
    sending: z.number().int().nonnegative(),
    sent: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    reviewRequired: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }).strict(),
  simulatedMode: z.boolean(),
  canManageChannels: z.boolean(),
  partial: z.boolean(),
}).strict();
export type ChannelsOverviewResponse = z.infer<typeof ChannelsOverviewResponseSchema>;

export const TemplatesListResponseSchema = z.object({
  items: z.array(CrmTemplateDtoSchema),
}).strict();
export type TemplatesListResponse = z.infer<typeof TemplatesListResponseSchema>;

/* ---------- Command Input Schemas ---------- */

export const ConfigureChannelAccountInputSchema = z.object({
  accountId: z.string().min(1).max(64).optional(),
  channel: z.enum(CRM_CHANNELS),
  provider: ChannelProviderSchema,
  label: z.string().trim().min(1).max(120),
  externalId: z.string().trim().min(1).max(200),
  mode: ChannelAccountModeSchema.default('disabled'),
  active: z.boolean().default(false),
  secretName: z.string().trim().regex(/^[A-Z0-9_]{3,64}$/).nullable().optional(),
  config: ChannelAccountConfigSchema.default({}),
}).strict();
export type ConfigureChannelAccountInput = z.infer<typeof ConfigureChannelAccountInputSchema>;

export const SetChannelAccountModeInputSchema = z.object({
  accountId: z.string().min(1).max(64),
  mode: ChannelAccountModeSchema,
  active: z.boolean(),
  expectedRev: z.number().int().positive().optional(),
}).strict();
export type SetChannelAccountModeInput = z.infer<typeof SetChannelAccountModeInputSchema>;

export const PollChannelNowInputSchema = z.object({
  accountId: z.string().min(1).max(64),
  limit: z.number().int().min(1).max(25).optional(),
  /** Local-test simulated inbound batch (ignored outside local-test). */
  simulatedMessages: z
    .array(
      z.object({
        externalEventId: z.string().min(1).max(160),
        rfcMessageId: z.string().min(1).max(256).optional(),
        inReplyTo: z.string().max(256).optional(),
        references: z.array(z.string().max(256)).max(20).optional(),
        externalThreadId: z.string().max(160).optional(),
        fromAddress: z.string().min(1).max(254),
        subject: z.string().max(200).optional(),
        bodyText: z.string().min(1).max(4000),
        receivedAt: z.number().int().positive().optional(),
      }).strict(),
    )
    .max(20)
    .optional(),
}).strict();
export type PollChannelNowInput = z.infer<typeof PollChannelNowInputSchema>;

export const UpsertTemplateInputSchema = z.object({
  templateId: z.string().min(1).max(64).optional(),
  channel: z.enum(CRM_CHANNELS),
  channelAccountId: z.string().min(1).max(64).nullable().optional(),
  name: z.string().trim().min(1).max(120),
  language: z.string().trim().min(2).max(16).default('en'),
  category: TemplateCategorySchema.default('utility'),
  bodyText: z.string().trim().min(1).max(2000),
  variables: z.array(z.string().trim().min(1).max(64)).max(12).default([]),
}).strict();
export type UpsertTemplateInput = z.infer<typeof UpsertTemplateInputSchema>;

export const SubmitTemplateInputSchema = z.object({
  templateId: z.string().min(1).max(64),
}).strict();
export type SubmitTemplateInput = z.infer<typeof SubmitTemplateInputSchema>;

export const SyncTemplateStatusInputSchema = z.object({
  templateId: z.string().min(1).max(64),
  status: TemplateStatusSchema,
  providerTemplateId: z.string().trim().min(1).max(128).nullable().optional(),
  rejectionReason: z.string().trim().max(500).nullable().optional(),
}).strict();
export type SyncTemplateStatusInput = z.infer<typeof SyncTemplateStatusInputSchema>;

export const ResolveMessageReviewInputSchema = z.object({
  messageId: z.string().min(1).max(64),
  resolution: z.enum(['confirm_sent', 'mark_failed', 'cancel']),
  providerReceipt: z.string().trim().min(1).max(200).optional(),
  note: z.string().trim().max(500).optional(),
}).strict();
export type ResolveMessageReviewInput = z.infer<typeof ResolveMessageReviewInputSchema>;

export const ProcessOutboxNowInputSchema = z.object({
  limit: z.number().int().min(1).max(20).optional(),
}).strict();
export type ProcessOutboxNowInput = z.infer<typeof ProcessOutboxNowInputSchema>;
