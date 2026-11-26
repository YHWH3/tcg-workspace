import { CRM_CHANNELS, isCrmCapability, type CrmCapability, type CrmChannel } from '../../shared/crm/capabilities';
import {
  ChannelAccountConfigSchema,
  ChannelsOverviewResponseSchema,
  ConfigureChannelAccountInputSchema,
  HUMAN_AGENT_WINDOW_MS,
  OUTBOX_LEASE_MS,
  POLL_LEASE_MS,
  PollChannelNowInputSchema,
  ProcessOutboxNowInputSchema,
  ResolveMessageReviewInputSchema,
  STANDARD_WINDOW_MS,
  SetChannelAccountModeInputSchema,
  SubmitTemplateInputSchema,
  SyncTemplateStatusInputSchema,
  TemplatesListResponseSchema,
  UpsertTemplateInputSchema,
  buildRfcReferences,
  canAdvanceMessageStatus,
  computeOutboxBackoffMs,
  evaluateChannelWindow,
  formatZohoPollCursor,
  isOptOutMessageText,
  isProviderCompatibleWithChannel,
  isRetryableAdapterError,
  normalizeEmailSubject,
  normalizeMetaScopedId,
  normalizeRfcMessageId,
  parseRfcReferences,
  parseZohoPollCursor,
  type AdapterErrorClass,
  type ChannelAccountConfig,
  type ChannelHealthState,
  type ChannelProvider,
  type ChannelsOverviewResponse,
  type ConfigureChannelAccountInput,
  type CrmChannelAccountDto,
  type CrmOutboxDeliveryDto,
  type CrmTemplateDto,
  type OutboxStatus,
  type PollChannelNowInput,
  type ProcessOutboxNowInput,
  type ResolveMessageReviewInput,
  type SetChannelAccountModeInput,
  type SubmitTemplateInput,
  type SyncTemplateStatusInput,
  type TemplateCategory,
  type TemplateStatus,
  type TemplatesListResponse,
  type UpsertTemplateInput,
} from '../../shared/crm/channels';
import { normalizeEmail, normalizeEndpoint, normalizePhone, type CrmConsentDto } from '../../shared/crm/identity';
import { evaluateEffectiveChannelConsent } from '../../shared/crm/merge';
import type { Env } from '../auth';
import { D1BudgetExhausted, hasD1Budget } from '../d1budget';
import { sha256Hex } from '../password';
import { createReadGate } from '../readAccess';
import { pokeLive } from '../sync';
import { isLocalTestSimulatedMode } from './adapters/simulated';
import {
  evaluateSimulatedOutcome,
  parseChannelAccountConfig,
  readSecretBinding,
  type AdapterInboundEvent,
  type AdapterSendInput,
  type AdapterSendOutcome,
  type ChannelAccountRow,
} from './adapters/types';
import { pollZohoMailInbound, sendViaZohoMail } from './adapters/zohoMail';
import { sendViaWhatsAppCloud } from './adapters/whatsappCloud';
import { sendViaMetaMessaging } from './adapters/metaMessaging';
import type { AnyCommandDefinition, CommandDefinition } from './commands';
import {
  latestConsentRowsPerTupleStmt,
  loadAliasesForSurvivor,
  resolveCanonicalPersonId,
} from './merge';
import {
  actorGrantsStmt,
  crmActorFence,
  evaluateCrmReadAuthRows,
  finalizeCrmReadAuth,
  loadReadableTaskRecords,
  sessionAuthStmt,
  type CrmGrantRow,
  type CrmSessionRow,
} from './read';
import {
  canAccessCrmApi,
  evaluateCapability,
  isCrmEnabled,
  normalizeCanonicalRole,
  type CrmActor,
  type StoredGrant,
} from './rules';

export interface TemplateRow {
  id: string;
  channel: CrmChannel;
  channel_account_id: string | null;
  name: string;
  language: string;
  category: TemplateCategory;
  provider_template_id: string | null;
  status: TemplateStatus;
  body_text: string;
  variables_json: string;
  rejection_reason: string | null;
  submitted_at: number | null;
  approved_at: number | null;
  rev: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface OutboxRow {
  id: string;
  message_id: string;
  conversation_id: string;
  channel_account_id: string | null;
  actor_id: string;
  request_id: string;
  status: OutboxStatus;
  purpose: CrmConsentDto['scope'];
  attempts: number;
  max_attempts: number;
  next_attempt_at: number | null;
  lease_until: number | null;
  last_error_class: AdapterErrorClass | null;
  last_error: string | null;
  provider_receipt: string | null;
  idempotency_key: string | null;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: number | null;
  created_at: number;
  updated_at: number;
}

interface OutboxOverviewRow extends OutboxRow {
  conv_subject: string | null;
  conv_person_id: string | null;
  conv_org_id: string | null;
  conv_app_id: string | null;
  msg_channel: string | null;
  msg_recipient: string | null;
  msg_body: string | null;
  msg_tag: string | null;
  msg_template_id: string | null;
}

interface ConvMiniRow {
  id: string;
  channel: string;
  channel_account_id: string | null;
  external_thread_id: string | null;
  person_id: string | null;
  organisation_id: string | null;
  application_id: string | null;
  subject: string;
  state: string;
  window_expires_at: number | null;
  human_agent_window_expires_at: number | null;
  last_rfc_message_id: string | null;
  rev: number;
}

interface MsgOutboxRow {
  id: string;
  conversation_id: string;
  status: string;
  channel: string;
  recipient_endpoint: string | null;
  body_text: string;
  in_reply_to: string | null;
  references_json: string | null;
  template_id: string | null;
  template_params_json: string | null;
  message_tag: string | null;
  updated_at: number;
}

export type ProviderSendDelegate = (
  env: Env,
  input: AdapterSendInput,
  fetchFn?: typeof fetch,
) => Promise<AdapterSendOutcome>;

/** Optional hook map for additional provider senders registered by S11/S12 modules (read-only lookup via parameter or static import). */
export interface AdapterDispatchOverrides {
  fetchFn?: typeof fetch;
  whatsappSender?: ProviderSendDelegate;
  metaSender?: ProviderSendDelegate;
}

function changesOneFence(db: D1Database): D1PreparedStatement {
  return db.prepare(`SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('{', '$') END`);
}

function isDigitalChannel(ch: string): ch is CrmChannel {
  return (CRM_CHANNELS as readonly string[]).includes(ch);
}

function sendCap(ch: CrmChannel): CrmCapability {
  return `crm.send:${ch}` as CrmCapability;
}

export function mapChannelAccountRow(row: ChannelAccountRow, env: Env): CrmChannelAccountDto {
  const rawCfg = parseChannelAccountConfig(row.config_json);
  const parsedCfg = ChannelAccountConfigSchema.safeParse(rawCfg);
  const config: ChannelAccountConfig = parsedCfg.success ? parsedCfg.data : {};
  return {
    id: row.id,
    channel: row.channel,
    provider: row.provider,
    label: row.label,
    externalId: row.external_id,
    mode: row.mode,
    active: row.active === 1,
    secretName: row.secret_name,
    secretBound: Boolean(readSecretBinding(env, row.secret_name)),
    config,
    pollCursor: row.poll_cursor,
    lastPollAt: row.last_poll_at,
    healthState: row.health_state,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    rev: row.rev,
    updatedAt: row.updated_at,
  };
}

export function mapTemplateRow(row: TemplateRow): CrmTemplateDto {
  let variables: string[] = [];
  try {
    const parsed = JSON.parse(row.variables_json);
    if (Array.isArray(parsed)) {
      variables = parsed.filter((v): v is string => typeof v === 'string');
    }
  } catch {
    variables = [];
  }
  return {
    id: row.id,
    channel: row.channel,
    channelAccountId: row.channel_account_id,
    name: row.name,
    language: row.language,
    category: row.category,
    providerTemplateId: row.provider_template_id,
    status: row.status,
    bodyText: row.body_text,
    variables,
    rejectionReason: row.rejection_reason,
    submittedAt: row.submitted_at,
    approvedAt: row.approved_at,
    rev: row.rev,
    updatedAt: row.updated_at,
  };
}

function validateProductionAccountConfig(
  provider: ChannelProvider,
  config: ChannelAccountConfig,
  secretName: string | null | undefined,
  env: Env,
): string | null {
  if (provider === 'simulated') return 'simulated_provider_cannot_run_production';
  if (!secretName) return 'secret_name_required_for_production';
  if (!readSecretBinding(env, secretName)) return 'worker_secret_not_bound';
  if (provider === 'email_zoho') {
    if (!config.dataCenter || !config.zohoAccountId || !config.fromAddress) {
      return 'zoho_config_incomplete_pending_O20';
    }
    if (!isLocalTestSimulatedMode(env)) {
      return 'zoho_production_pending_G3';
    }
  } else if (provider === 'whatsapp_cloud') {
    if (!config.phoneNumberId) {
      return 'whatsapp_phone_number_id_required_pending_O04';
    }
  } else if (provider === 'instagram_meta') {
    if (!config.instagramAccountId && !config.pageId) {
      return 'instagram_account_id_required';
    }
  } else if (provider === 'facebook_meta') {
    if (!config.pageId) {
      return 'facebook_page_id_required';
    }
  }
  return null;
}

/**
 * Resolves the channel account for sending:
 * - When `channelAccountId` is explicitly specified, returns ONLY that exact account
 *   (NEVER falls back to an arbitrary different active account).
 * - When `channelAccountId` is null, returns the active non-disabled account for `channel`.
 */
export async function resolveChannelAccountForSend(
  db: D1Database,
  channel: CrmChannel,
  channelAccountId: string | null,
): Promise<ChannelAccountRow | null> {
  if (channelAccountId) {
    return (
      (await db
        .prepare(`SELECT * FROM crm_channel_accounts WHERE id = ?`)
        .bind(channelAccountId)
        .first<ChannelAccountRow>()) ?? null
    );
  }
  return (
    (await db
      .prepare(
        `SELECT * FROM crm_channel_accounts
         WHERE channel = ? AND active = 1 AND mode != 'disabled'
         ORDER BY CASE WHEN mode = 'production' THEN 0 ELSE 1 END, updated_at DESC
         LIMIT 1`,
      )
      .bind(channel)
      .first<ChannelAccountRow>()) ?? null
  );
}

/** Dispatches an outbound message through the configured provider adapter. */
export async function dispatchAdapterSend(
  env: Env,
  input: AdapterSendInput,
  overrides: AdapterDispatchOverrides = {},
): Promise<AdapterSendOutcome> {
  const { account, config } = input;
  const fetchFn = overrides.fetchFn ?? fetch;

  // Backward-compatible local-test fallback when no explicit channel account row has been configured yet.
  if (!account) {
    if (!isLocalTestSimulatedMode(env)) {
      return { ok: false, errorClass: 'auth', detail: 'channel_account_not_configured' };
    }
    const rfcId =
      input.channel === 'email'
        ? `<sim-${input.messageId}-${input.now}@crm.local>`
        : undefined;
    return evaluateSimulatedOutcome(config.simulatedBehavior, `sim_${input.channel}`, input.messageId, input.now, {
      rfcMessageId: rfcId,
    });
  }

  if (account.mode === 'disabled' || account.active !== 1) {
    return { ok: false, errorClass: 'auth', detail: 'channel_account_disabled' };
  }

  if (account.provider === 'email_zoho') {
    return sendViaZohoMail(env, input, fetchFn);
  }
  if (account.provider === 'whatsapp_cloud') {
    if (overrides.whatsappSender) {
      return overrides.whatsappSender(env, input, fetchFn);
    }
    return sendViaWhatsAppCloud(env, input, fetchFn);
  }
  if (account.provider === 'instagram_meta' || account.provider === 'facebook_meta') {
    if (overrides.metaSender) {
      return overrides.metaSender(env, input, fetchFn);
    }
    return sendViaMetaMessaging(env, input, fetchFn);
  }

  // Generic simulated provider
  if (!isLocalTestSimulatedMode(env)) {
    return { ok: false, errorClass: 'auth', detail: 'simulated_transport_requires_local_test' };
  }
  const rfcId =
    input.channel === 'email'
      ? `<sim-${input.messageId}-${input.now}@crm.local>`
      : undefined;
  return evaluateSimulatedOutcome(config.simulatedBehavior, `sim_${input.channel}`, input.messageId, input.now, {
    rfcMessageId: rfcId,
  });
}

/* ---------- Shared Inbound Event Ingestion (Zoho Polling + Meta Webhooks) ---------- */

function normalizeInboundSender(channel: CrmChannel, raw: string): string | null {
  if (channel === 'email') return normalizeEmail(raw);
  if (channel === 'whatsapp') return normalizePhone(raw);
  if (channel === 'instagram' || channel === 'facebook') return normalizeMetaScopedId(channel, raw);
  return normalizeEndpoint(channel, raw);
}

async function resolvePersonByInboundEndpoint(
  db: D1Database,
  channel: CrmChannel,
  normEndpoint: string,
): Promise<string | null> {
  const candidates = channel === 'whatsapp' ? [normEndpoint] : [normEndpoint];
  const ep = await db
    .prepare(
      `SELECT person_id FROM crm_endpoints
       WHERE kind = ? AND value_norm IN (SELECT value FROM json_each(?)) AND retired_at IS NULL
       LIMIT 1`,
    )
    .bind(channel, JSON.stringify(candidates))
    .first<{ person_id: string }>();
  if (ep) {
    return (await resolveCanonicalPersonId(db, ep.person_id)).canonicalId;
  }
  // For WhatsApp, also fall back to matching active 'phone' endpoint with identical E.164 value
  if (channel === 'whatsapp') {
    const phoneEp = await db
      .prepare(
        `SELECT person_id FROM crm_endpoints
         WHERE kind = 'phone' AND value_norm = ? AND retired_at IS NULL
         LIMIT 1`,
      )
      .bind(normEndpoint)
      .first<{ person_id: string }>();
    if (phoneEp) {
      return (await resolveCanonicalPersonId(db, phoneEp.person_id)).canonicalId;
    }
  }
  return null;
}

/**
 * Resolves existing email conversation strictly via RFC 5322 `In-Reply-To` / `References` headers
 * (or explicit provider `external_thread_id`) strictly scoped to the same `channel_account_id`.
 * NEVER threads by email subject alone and NEVER crosses channel accounts.
 */
async function findEmailThreadConversation(
  db: D1Database,
  accountId: string | null,
  inReplyTo: string | null | undefined,
  references: readonly string[] | undefined,
  externalThreadId: string | null | undefined,
): Promise<ConvMiniRow | null> {
  const candidateIds = buildRfcReferences(references ?? [], inReplyTo ?? null);
  if (candidateIds.length > 0) {
    const matchedMsg = await db
      .prepare(
        `SELECT m.conversation_id
         FROM crm_messages m
         JOIN crm_conversations c ON c.id = m.conversation_id
         WHERE m.channel = 'email'
           AND m.rfc_message_id IN (SELECT value FROM json_each(?))
           AND ((? IS NULL AND c.channel_account_id IS NULL) OR c.channel_account_id = ?)
         ORDER BY m.created_at DESC
         LIMIT 1`,
      )
      .bind(JSON.stringify(candidateIds), accountId, accountId)
      .first<{ conversation_id: string }>();
    if (matchedMsg) {
      const conv = await db
        .prepare(
          `SELECT id, channel, channel_account_id, external_thread_id, person_id, organisation_id, application_id, subject, state, window_expires_at, human_agent_window_expires_at, last_rfc_message_id, rev
           FROM crm_conversations WHERE id = ?`,
        )
        .bind(matchedMsg.conversation_id)
        .first<ConvMiniRow>();
      if (conv) return conv;
    }
  }

  if (externalThreadId) {
    const conv = await db
      .prepare(
        `SELECT id, channel, channel_account_id, external_thread_id, person_id, organisation_id, application_id, subject, state, window_expires_at, human_agent_window_expires_at, last_rfc_message_id, rev
         FROM crm_conversations
         WHERE channel = 'email' AND external_thread_id = ?
           AND ((? IS NULL AND channel_account_id IS NULL) OR channel_account_id = ?)
         LIMIT 1`,
      )
      .bind(externalThreadId, accountId, accountId)
      .first<ConvMiniRow>();
    if (conv) return conv;
  }

  return null;
}

function isInboundDuplicateConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed:\s*crm_inbound_events/i.test(msg);
}

function monotonicAllowedStatusesFor(next: 'sent' | 'delivered' | 'read' | 'failed'): readonly string[] {
  if (next === 'sent') return ['draft', 'queued', 'sending'];
  if (next === 'delivered') return ['draft', 'queued', 'sending', 'sent'];
  if (next === 'read') return ['draft', 'queued', 'sending', 'sent', 'delivered'];
  // 'failed' can never regress delivered/read/review_required/cancelled
  return ['queued', 'sending', 'sent'];
}

function scopedInboundEventKey(accountId: string | null, externalEventId: string): string {
  return accountId ? `${accountId}::${externalEventId}` : externalEventId;
}

function scopedThreadKey(_account: ChannelAccountRow | null, _channel: CrmChannel, rawThreadId: string | null | undefined): string | null {
  return rawThreadId ?? null;
}

function buildOptOutStatements(
  db: D1Database,
  personId: string,
  channel: CrmChannel,
  evidenceRef: string,
  now: number,
): D1PreparedStatement[] {
  const scopes: ('transactional' | 'updates')[] = ['transactional', 'updates'];
  const stmts: D1PreparedStatement[] = [];
  for (const scope of scopes) {
    const conId = `con_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    stmts.push(
      db
        .prepare(
          `INSERT INTO crm_consents (id, person_id, channel, scope, status, source, evidence_ref, recorded_by, recorded_at)
           VALUES (?, ?, ?, ?, 'withdrawn', 'inbound_optout', ?, 'system:inbound', ?)`,
        )
        .bind(conId, personId, channel, scope, evidenceRef, now),
    );
  }
  // Cancel any queued non-transactional outbox items & their messages for this person + channel!
  stmts.push(
    db
      .prepare(
        `UPDATE crm_messages
         SET status = 'cancelled', error_code = 'consent_withdrawn', error_detail = 'cancelled_by_inbound_optout', updated_at = ?
         WHERE id IN (
           SELECT o.message_id FROM crm_outbox o
           JOIN crm_conversations c ON c.id = o.conversation_id
           WHERE o.status = 'queued'
             AND o.purpose != 'transactional'
             AND c.channel = ?
             AND c.person_id = ?
         )`,
      )
      .bind(now, channel, personId),
    db
      .prepare(
        `UPDATE crm_outbox
         SET status = 'cancelled', last_error_class = 'blocked', last_error = 'cancelled_by_inbound_optout', lease_until = NULL, updated_at = ?
         WHERE status = 'queued'
           AND purpose != 'transactional'
           AND conversation_id IN (
             SELECT id FROM crm_conversations WHERE channel = ? AND person_id = ?
           )`,
      )
      .bind(now, channel, personId),
  );
  return stmts;
}

export interface IngestSummary {
  ingested: number;
  duplicatesSkipped: number;
  optOutsRecorded: number;
  statusesUpdated: number;
  conversationIds: string[];
  budgetExhausted: boolean;
  unprocessedCount: number;
  lastProcessedReceivedAt: number | null;
}

export async function ingestChannelInboundEvents(
  env: Env,
  account: ChannelAccountRow | null,
  events: readonly AdapterInboundEvent[],
  now = Date.now(),
): Promise<IngestSummary> {
  const summary: IngestSummary = {
    ingested: 0,
    duplicatesSkipped: 0,
    optOutsRecorded: 0,
    statusesUpdated: 0,
    conversationIds: [],
    budgetExhausted: false,
    unprocessedCount: 0,
    lastProcessedReceivedAt: null,
  };
  if (events.length === 0) return summary;

  const accountId = account?.id ?? null;

  for (let idx = 0; idx < events.length; idx += 1) {
    const ev = events[idx]!;
    if (!hasD1Budget(env.DB, 6)) {
      summary.budgetExhausted = true;
      summary.unprocessedCount = events.length - idx;
      break;
    }

    const evTs = ev.kind === 'message' ? ev.receivedAt : ev.timestamp;
    const dedupKey = scopedInboundEventKey(accountId, ev.externalEventId);

    const existing = await env.DB
      .prepare(`SELECT id FROM crm_inbound_events WHERE channel = ? AND external_event_id = ? LIMIT 1`)
      .bind(ev.channel, dedupKey)
      .first<{ id: string }>();
    if (existing) {
      summary.duplicatesSkipped += 1;
      if (summary.lastProcessedReceivedAt === null || evTs > summary.lastProcessedReceivedAt) {
        summary.lastProcessedReceivedAt = evTs;
      }
      continue;
    }

    const payloadHash = await sha256Hex(JSON.stringify(ev.rawHashInput));
    const inboundId = `in_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

    if (ev.kind === 'status') {
      // Strictly match messages belonging to this channel account (never cross-account)
      const msg = await env.DB
        .prepare(
          `SELECT m.id, m.conversation_id, m.status
           FROM crm_messages m
           JOIN crm_conversations c ON c.id = m.conversation_id
           WHERE m.channel = ? AND m.external_message_id = ?
             AND ((? IS NULL AND c.channel_account_id IS NULL) OR c.channel_account_id = ?)
           LIMIT 1`,
        )
        .bind(ev.channel, ev.externalMessageId, accountId, accountId)
        .first<{ id: string; conversation_id: string; status: string }>();

      const stmts: D1PreparedStatement[] = [];
      let state: 'processed' | 'ignored' = 'ignored';
      let willAdvance = false;
      if (msg && canAdvanceMessageStatus(msg.status, ev.status)) {
        state = 'processed';
        willAdvance = true;
        const allowedPrev = monotonicAllowedStatusesFor(ev.status);
        // Enforce monotonic progression in SQL so concurrent/reordered receipts can NEVER regress status!
        stmts.push(
          env.DB
            .prepare(
              `UPDATE crm_messages
               SET status = ?,
                   delivered_at = CASE WHEN ? = 'delivered' THEN COALESCE(delivered_at, ?) ELSE delivered_at END,
                   read_at = CASE WHEN ? = 'read' THEN COALESCE(read_at, ?) ELSE read_at END,
                   error_detail = CASE WHEN ? = 'failed' THEN COALESCE(?, error_detail) ELSE error_detail END,
                   updated_at = MAX(updated_at, ?)
               WHERE id = ?
                 AND status IN (SELECT value FROM json_each(?))`,
            )
            .bind(
              ev.status,
              ev.status,
              ev.timestamp,
              ev.status,
              ev.timestamp,
              ev.status,
              ev.errorDetail ?? null,
              now,
              msg.id,
              JSON.stringify(allowedPrev),
            ),
        );
        if (ev.status === 'failed') {
          stmts.push(
            env.DB
              .prepare(
                `UPDATE crm_outbox SET status = 'failed', last_error = COALESCE(?, last_error), updated_at = ?
                 WHERE message_id = ? AND status IN ('queued', 'sending', 'sent')
                   AND EXISTS (SELECT 1 FROM crm_messages WHERE id = ? AND status = 'failed')`,
              )
              .bind(ev.errorDetail ?? 'provider_status_failed', now, msg.id, msg.id),
          );
        }
      }
      stmts.push(
        env.DB
          .prepare(
            `INSERT INTO crm_inbound_events (id, channel, channel_account_id, external_event_id, payload_hash, state, conversation_id, message_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            inboundId,
            ev.channel,
            accountId,
            dedupKey,
            payloadHash,
            state,
            msg?.conversation_id ?? null,
            msg?.id ?? null,
            now,
          ),
      );
      try {
        const results = await env.DB.batch(stmts);
        summary.ingested += 1;
        if (willAdvance && (results[0]?.meta?.changes ?? 0) > 0) {
          summary.statusesUpdated += 1;
        }
        if (summary.lastProcessedReceivedAt === null || evTs > summary.lastProcessedReceivedAt) {
          summary.lastProcessedReceivedAt = evTs;
        }
      } catch (err) {
        if (err instanceof D1BudgetExhausted) {
          summary.budgetExhausted = true;
          summary.unprocessedCount = events.length - idx;
          break;
        }
        if (isInboundDuplicateConstraintError(err)) {
          summary.duplicatesSkipped += 1;
          if (summary.lastProcessedReceivedAt === null || evTs > summary.lastProcessedReceivedAt) {
            summary.lastProcessedReceivedAt = evTs;
          }
          continue;
        }
        throw err;
      }
      continue;
    }

    if (ev.kind === 'opt_out') {
      const fromNorm = normalizeInboundSender(ev.channel, ev.fromEndpoint) ?? ev.fromEndpoint.trim().toLowerCase();
      const personId = await resolvePersonByInboundEndpoint(env.DB, ev.channel, fromNorm);
      const stmts: D1PreparedStatement[] = [];
      if (personId) {
        stmts.push(...buildOptOutStatements(env.DB, personId, ev.channel, ev.externalEventId, ev.timestamp));
      }
      stmts.push(
        env.DB
          .prepare(
            `INSERT INTO crm_inbound_events (id, channel, channel_account_id, external_event_id, payload_hash, state, conversation_id, message_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
          )
          .bind(
            inboundId,
            ev.channel,
            accountId,
            dedupKey,
            payloadHash,
            personId ? 'processed' : 'ignored',
            now,
          ),
      );
      try {
        await env.DB.batch(stmts);
        summary.ingested += 1;
        if (personId) summary.optOutsRecorded += 1;
        if (summary.lastProcessedReceivedAt === null || evTs > summary.lastProcessedReceivedAt) {
          summary.lastProcessedReceivedAt = evTs;
        }
      } catch (err) {
        if (err instanceof D1BudgetExhausted) {
          summary.budgetExhausted = true;
          summary.unprocessedCount = events.length - idx;
          break;
        }
        if (isInboundDuplicateConstraintError(err)) {
          summary.duplicatesSkipped += 1;
          if (summary.lastProcessedReceivedAt === null || evTs > summary.lastProcessedReceivedAt) {
            summary.lastProcessedReceivedAt = evTs;
          }
          continue;
        }
        throw err;
      }
      continue;
    }

    // Inbound message event
    const fromNorm = normalizeInboundSender(ev.channel, ev.fromEndpoint) ?? ev.fromEndpoint.trim().toLowerCase();
    const personId = await resolvePersonByInboundEndpoint(env.DB, ev.channel, fromNorm);
    const threadIdForConv = scopedThreadKey(account, ev.channel, ev.externalThreadId);

    let targetConv: ConvMiniRow | null = null;
    if (ev.channel === 'email') {
      targetConv = await findEmailThreadConversation(
        env.DB,
        accountId,
        ev.inReplyTo,
        ev.references,
        threadIdForConv,
      );
    } else if (threadIdForConv) {
      targetConv =
        (await env.DB
          .prepare(
            `SELECT id, channel, channel_account_id, external_thread_id, person_id, organisation_id, application_id, subject, state, window_expires_at, human_agent_window_expires_at, last_rfc_message_id, rev
             FROM crm_conversations
             WHERE channel = ? AND external_thread_id = ?
               AND ((? IS NULL AND channel_account_id IS NULL) OR channel_account_id = ?)
             LIMIT 1`,
          )
          .bind(ev.channel, threadIdForConv, accountId, accountId)
          .first<ConvMiniRow>()) ?? null;
    }

    const convId = targetConv?.id ?? `conv_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const msgId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const rfcId = ev.channel === 'email' ? normalizeRfcMessageId(ev.rfcMessageId) : null;
    const inReplyTo = ev.channel === 'email' ? normalizeRfcMessageId(ev.inReplyTo) : null;
    const refsJson =
      ev.channel === 'email' && ev.references && ev.references.length > 0
        ? JSON.stringify(parseRfcReferences(ev.references))
        : null;
    const windowExpires = ev.channel === 'email' ? null : ev.receivedAt + STANDARD_WINDOW_MS;
    const humanAgentExpires =
      ev.channel === 'instagram' || ev.channel === 'facebook'
        ? ev.receivedAt + HUMAN_AGENT_WINDOW_MS
        : null;

    const stmts: D1PreparedStatement[] = [];
    if (targetConv) {
      // Strictly non-regressing window timestamps & last_rfc_message_id under reordered/concurrent events!
      stmts.push(
        env.DB
          .prepare(
            `UPDATE crm_conversations
             SET person_id = COALESCE(person_id, ?),
                 channel_account_id = COALESCE(channel_account_id, ?),
                 window_expires_at = CASE WHEN ? IS NULL THEN window_expires_at ELSE MAX(COALESCE(window_expires_at, 0), ?) END,
                 human_agent_window_expires_at = CASE WHEN ? IS NULL THEN human_agent_window_expires_at ELSE MAX(COALESCE(human_agent_window_expires_at, 0), ?) END,
                 last_rfc_message_id = CASE WHEN ? IS NOT NULL AND ? >= COALESCE(last_inbound_at, 0) THEN ? ELSE last_rfc_message_id END,
                 last_message_at = MAX(last_message_at, ?),
                 last_inbound_at = MAX(COALESCE(last_inbound_at, 0), ?),
                 unread_count = unread_count + 1,
                 state = CASE WHEN state = 'closed' THEN 'open' ELSE state END,
                 rev = rev + 1,
                 updated_at = ?
             WHERE id = ?`,
          )
          .bind(
            personId,
            accountId,
            windowExpires,
            windowExpires,
            humanAgentExpires,
            humanAgentExpires,
            rfcId,
            ev.receivedAt,
            rfcId,
            ev.receivedAt,
            ev.receivedAt,
            now,
            targetConv.id,
          ),
      );
    } else {
      const subject = ev.subject?.trim() || `Inbound ${ev.channel} from ${fromNorm}`;
      const subjNorm = ev.channel === 'email' ? normalizeEmailSubject(subject) : null;
      stmts.push(
        env.DB
          .prepare(
            `INSERT INTO crm_conversations
               (id, channel, channel_account_id, external_thread_id, person_id, organisation_id, programme_slug, application_id, subject, state, assignee_id, window_expires_at, human_agent_window_expires_at, last_rfc_message_id, email_subject_norm, last_message_at, last_inbound_at, last_outbound_at, unread_count, rev, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 'open', NULL, ?, ?, ?, ?, ?, ?, NULL, 1, 1, ?, ?)`,
          )
          .bind(
            convId,
            ev.channel,
            accountId,
            threadIdForConv,
            personId,
            subject,
            windowExpires,
            humanAgentExpires,
            rfcId,
            subjNorm,
            ev.receivedAt,
            ev.receivedAt,
            now,
            now,
          ),
      );
    }

    stmts.push(
      env.DB
        .prepare(
          `INSERT INTO crm_messages
             (id, conversation_id, direction, status, channel, sender_endpoint, recipient_endpoint, author_user_id, body_text, body_html_sanitized, external_message_id, rfc_message_id, in_reply_to, references_json, template_id, template_params_json, message_tag, ai_metadata_json, error_code, error_detail, sent_at, delivered_at, read_at, created_at, updated_at)
           VALUES (?, ?, 'inbound', 'received', ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .bind(
          msgId,
          convId,
          ev.channel,
          fromNorm,
          ev.toEndpoint ?? account?.external_id ?? null,
          ev.bodyText,
          ev.externalEventId,
          rfcId,
          inReplyTo,
          refsJson,
          ev.receivedAt,
          now,
        ),
      env.DB
        .prepare(
          `INSERT INTO crm_inbound_events (id, channel, channel_account_id, external_event_id, payload_hash, state, conversation_id, message_id, created_at)
           VALUES (?, ?, ?, ?, ?, 'processed', ?, ?, ?)`,
        )
        .bind(inboundId, ev.channel, accountId, dedupKey, payloadHash, convId, msgId, now),
    );

    const optOutTriggered = Boolean(ev.isOptOut || isOptOutMessageText(ev.bodyText));
    if (optOutTriggered && personId) {
      stmts.push(...buildOptOutStatements(env.DB, personId, ev.channel, ev.externalEventId, ev.receivedAt));
    }

    try {
      await env.DB.batch(stmts);
      summary.ingested += 1;
      if (optOutTriggered && personId) summary.optOutsRecorded += 1;
      if (!summary.conversationIds.includes(convId)) {
        summary.conversationIds.push(convId);
      }
      if (summary.lastProcessedReceivedAt === null || evTs > summary.lastProcessedReceivedAt) {
        summary.lastProcessedReceivedAt = evTs;
      }
    } catch (err) {
      if (err instanceof D1BudgetExhausted) {
        summary.budgetExhausted = true;
        summary.unprocessedCount = events.length - idx;
        break;
      }
      if (isInboundDuplicateConstraintError(err)) {
        summary.duplicatesSkipped += 1;
        if (summary.lastProcessedReceivedAt === null || evTs > summary.lastProcessedReceivedAt) {
          summary.lastProcessedReceivedAt = evTs;
        }
        continue;
      }
      throw err;
    }
  }

  return summary;
}

/* ---------- Durable Outbox Sweeper & Exponential Backoff / Ambiguous Review ---------- */

export interface OutboxSweepSummary {
  expiredMovedToReview: number;
  attempted: number;
  sent: number;
  requeued: number;
  failed: number;
  reviewRequired: number;
  cancelled: number;
}

async function loadCurrentSenderActor(db: D1Database, actorId: string): Promise<CrmActor | null> {
  const [userRes, grantsRes] = await db.batch([
    db
      .prepare(
        `SELECT id, disabled_at, COALESCE(workspace_role, role) AS canonicalRole
         FROM users WHERE id = ?`,
      )
      .bind(actorId),
    db
      .prepare(`SELECT capability, scope, granted_by, granted_at FROM crm_capability_grants WHERE user_id = ?`)
      .bind(actorId),
  ]);
  const userRow = userRes.results[0] as { id: string; disabled_at: number | null; canonicalRole: string } | undefined;
  if (!userRow) return null;
  const grants: StoredGrant[] = [];
  for (const r of grantsRes.results as unknown as CrmGrantRow[]) {
    if (!isCrmCapability(r.capability)) continue;
    grants.push({
      capability: r.capability,
      scope: r.scope,
      grantedBy: r.granted_by,
      grantedAt: r.granted_at,
    });
  }
  return {
    id: userRow.id,
    role: normalizeCanonicalRole(userRow.canonicalRole),
    disabled: userRow.disabled_at !== null,
    grants,
  };
}

/**
 * Executes a lease-fenced outbox batch commit.
 * If the exact acquired lease (`status='sending' AND attempts=? AND lease_until=?`) was
 * expired, resolved, or reclaimed by another worker, `changesOneFence` aborts the entire
 * batch so a stale worker can NEVER overwrite newer delivery state.
 */
async function commitFencedOutboxBatch(db: D1Database, stmts: D1PreparedStatement[]): Promise<boolean> {
  try {
    await db.batch(stmts);
    return true;
  } catch (err) {
    if (err instanceof D1BudgetExhausted) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (/malformed JSON/i.test(msg)) {
      // Exact lease fence failed (stale worker); silently refuse overwrite!
      return false;
    }
    throw err;
  }
}

export async function processCrmOutbox(
  env: Env,
  now = Date.now(),
  opts: { limit?: number; overrides?: AdapterDispatchOverrides } = {},
): Promise<OutboxSweepSummary> {
  const limit = Math.min(20, Math.max(1, opts.limit ?? 8));
  const summary: OutboxSweepSummary = {
    expiredMovedToReview: 0,
    attempted: 0,
    sent: 0,
    requeued: 0,
    failed: 0,
    reviewRequired: 0,
    cancelled: 0,
  };

  // 1. Expired 'sending' leases are AMBIGUOUS (provider may have already delivered!) -> move to review_required, NEVER blind retry!
  const expiredRes = await env.DB
    .prepare(
      `SELECT id, message_id, attempts, lease_until FROM crm_outbox
       WHERE status = 'sending' AND lease_until IS NOT NULL AND lease_until <= ?
       ORDER BY lease_until ASC LIMIT ?`,
    )
    .bind(now, limit)
    .all<{ id: string; message_id: string; attempts: number; lease_until: number }>();

  for (const exp of expiredRes.results) {
    if (!hasD1Budget(env.DB, 4)) break;
    const moved = await commitFencedOutboxBatch(env.DB, [
      env.DB
        .prepare(
          `UPDATE crm_outbox
           SET status = 'review_required', lease_until = NULL, last_error_class = 'unknown',
               last_error = 'lease_expired_ambiguous_delivery', updated_at = ?
           WHERE id = ? AND status = 'sending' AND attempts = ? AND lease_until = ? AND lease_until <= ?`,
        )
        .bind(now, exp.id, exp.attempts, exp.lease_until, now),
      changesOneFence(env.DB),
      env.DB
        .prepare(
          `UPDATE crm_messages
           SET status = 'review_required', error_code = 'unknown',
               error_detail = 'lease_expired_ambiguous_delivery', updated_at = ?
           WHERE id = ? AND status IN ('queued', 'sending')`,
        )
        .bind(now, exp.message_id),
    ]);
    if (moved) {
      summary.expiredMovedToReview += 1;
      summary.reviewRequired += 1;
    }
  }

  // 2. Fetch due 'queued' items
  const dueRes = await env.DB
    .prepare(
      `SELECT * FROM crm_outbox
       WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY COALESCE(next_attempt_at, created_at) ASC, id ASC
       LIMIT ?`,
    )
    .bind(now, limit)
    .all<OutboxRow>();

  for (const row of dueRes.results) {
    if (!hasD1Budget(env.DB, 10)) break;

    // Atomically claim exact lease generation (attempts + 1, exact leaseUntil)
    const leaseUntil = now + OUTBOX_LEASE_MS;
    const nextAttempts = row.attempts + 1;
    const claim = await env.DB
      .prepare(
        `UPDATE crm_outbox
         SET status = 'sending', attempts = ?, lease_until = ?, updated_at = ?
         WHERE id = ? AND status = 'queued' AND attempts = ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
      )
      .bind(nextAttempts, leaseUntil, now, row.id, row.attempts, now)
      .run();
    if (!claim.meta.changes) continue;

    summary.attempted += 1;

    const failOrCancelFenced = async (
      status: 'failed' | 'cancelled',
      errClass: AdapterErrorClass,
      reason: string,
      msgId?: string | null,
    ): Promise<boolean> => {
      const stmts: D1PreparedStatement[] = [
        env.DB
          .prepare(
            `UPDATE crm_outbox
             SET status = ?, lease_until = NULL, next_attempt_at = NULL,
                 last_error_class = ?, last_error = ?, updated_at = ?
             WHERE id = ? AND status = 'sending' AND attempts = ? AND lease_until = ?`,
          )
          .bind(status, errClass, reason, now, row.id, nextAttempts, leaseUntil),
        changesOneFence(env.DB),
      ];
      if (msgId) {
        stmts.push(
          env.DB
            .prepare(
              `UPDATE crm_messages
               SET status = ?, error_code = ?, error_detail = ?, updated_at = ?
               WHERE id = ?`,
            )
            .bind(status, errClass, reason, now, msgId),
        );
      }
      return commitFencedOutboxBatch(env.DB, stmts);
    };

    const [msg, conv] = await Promise.all([
      env.DB
        .prepare(
          `SELECT id, conversation_id, status, channel, recipient_endpoint, body_text, in_reply_to, references_json, template_id, template_params_json, message_tag, updated_at
           FROM crm_messages WHERE id = ?`,
        )
        .bind(row.message_id)
        .first<MsgOutboxRow>(),
      env.DB
        .prepare(
          `SELECT id, channel, channel_account_id, external_thread_id, person_id, organisation_id, application_id, subject, state, window_expires_at, human_agent_window_expires_at, last_rfc_message_id, rev
           FROM crm_conversations WHERE id = ?`,
        )
        .bind(row.conversation_id)
        .first<ConvMiniRow>(),
    ]);

    if (!msg || !conv || !isDigitalChannel(conv.channel)) {
      if (await failOrCancelFenced('failed', 'recipient_invalid', 'missing_message_or_conversation', msg?.id)) {
        summary.failed += 1;
      }
      continue;
    }

    // 2a. Revalidate current sender account authority & channel send capability
    const senderActor = await loadCurrentSenderActor(env.DB, row.actor_id);
    if (!senderActor || !canAccessCrmApi(senderActor) || !evaluateCapability(senderActor, sendCap(conv.channel), '*')) {
      if (await failOrCancelFenced('cancelled', 'auth', 'sender_authority_revoked', msg.id)) {
        summary.cancelled += 1;
      }
      continue;
    }

    // 2b. Revalidate sender's current ReadGate access to linked records
    const linkedIds = [conv.person_id, conv.organisation_id, conv.application_id].filter((x): x is string => Boolean(x));
    if (linkedIds.length > 0) {
      const gate = createReadGate(env.DB, senderActor.id);
      const readable = await loadReadableTaskRecords(env, gate, linkedIds);
      if (linkedIds.some((id) => !readable.has(id))) {
        if (await failOrCancelFenced('cancelled', 'auth', 'linked_record_access_revoked', msg.id)) {
          summary.cancelled += 1;
        }
        continue;
      }
    }

    // 2c. Revalidate canonical person, active non-retired endpoint, and non-broadening consent at dispatch time
    let dispatchRecipient = msg.recipient_endpoint;
    if (conv.person_id) {
      const canonicalId = (await resolveCanonicalPersonId(env.DB, conv.person_id)).canonicalId;
      const aliases = await loadAliasesForSurvivor(env.DB, canonicalId);
      const [latestCons, activeEps] = await Promise.all([
        latestConsentRowsPerTupleStmt(env.DB, [canonicalId, ...aliases.keys()]).all<{
          id: string;
          person_id: string;
          channel: CrmConsentDto['channel'];
          scope: CrmConsentDto['scope'];
          status: CrmConsentDto['status'];
          source: string;
          evidence_ref: string | null;
          recorded_by: string;
          recorded_at: number;
        }>(),
        env.DB
          .prepare(
            `SELECT value_norm, is_primary, kind FROM crm_endpoints
             WHERE person_id = ? AND retired_at IS NULL
               AND (kind = ? OR (? = 'whatsapp' AND kind = 'phone'))
             ORDER BY CASE WHEN kind = ? THEN 0 ELSE 1 END, is_primary DESC, created_at ASC`,
          )
          .bind(canonicalId, conv.channel, conv.channel, conv.channel)
          .all<{ value_norm: string; is_primary: number; kind: string }>(),
      ]);

      const consDtos: CrmConsentDto[] = latestCons.results.map((c) => ({
        id: c.id,
        personId: c.person_id,
        channel: c.channel,
        scope: c.scope,
        status: c.status,
        source: c.source,
        evidenceRef: c.evidence_ref,
        recordedBy: c.recorded_by,
        recordedAt: c.recorded_at,
      }));
      const evalCons = evaluateEffectiveChannelConsent(canonicalId, consDtos, aliases, conv.channel, row.purpose);
      if (evalCons.withdrawn) {
        if (await failOrCancelFenced('cancelled', 'blocked', 'consent_withdrawn', msg.id)) {
          summary.cancelled += 1;
        }
        continue;
      }

      if (activeEps.results.length === 0) {
        if (await failOrCancelFenced('failed', 'recipient_invalid', 'no_active_canonical_endpoint', msg.id)) {
          summary.failed += 1;
        }
        continue;
      }
      // Prefer stored recipient if still active on canonical person; otherwise resolve to canonical primary endpoint
      const storedStillActive = dispatchRecipient
        ? activeEps.results.some((ep) => ep.value_norm === dispatchRecipient)
        : false;
      dispatchRecipient = storedStillActive ? dispatchRecipient : activeEps.results[0]!.value_norm;
    }

    if (!dispatchRecipient) {
      if (await failOrCancelFenced('failed', 'recipient_invalid', 'no_recipient_endpoint', msg.id)) {
        summary.failed += 1;
      }
      continue;
    }

    // 2d. Revalidate exact channel account configuration & active status (NEVER substitute an arbitrary account)
    const explicitAccountId = row.channel_account_id ?? conv.channel_account_id;
    const account = await resolveChannelAccountForSend(env.DB, conv.channel, explicitAccountId);
    const config = parseChannelAccountConfig(account?.config_json);
    if (explicitAccountId && !account) {
      if (await failOrCancelFenced('cancelled', 'auth', 'channel_account_not_found', msg.id)) {
        summary.cancelled += 1;
      }
      continue;
    }
    if (!account && !isLocalTestSimulatedMode(env)) {
      if (await failOrCancelFenced('cancelled', 'auth', 'channel_account_not_configured', msg.id)) {
        summary.cancelled += 1;
      }
      continue;
    }
    if (account && (account.mode === 'disabled' || account.active !== 1)) {
      if (await failOrCancelFenced('cancelled', 'auth', 'channel_account_disabled', msg.id)) {
        summary.cancelled += 1;
      }
      continue;
    }
    if (account && account.mode === 'simulated' && !isLocalTestSimulatedMode(env)) {
      if (await failOrCancelFenced('cancelled', 'auth', 'simulated_transport_requires_local_test', msg.id)) {
        summary.cancelled += 1;
      }
      continue;
    }
    if (account && account.mode === 'production') {
      const prodErr = validateProductionAccountConfig(account.provider, config, account.secret_name, env);
      if (prodErr) {
        if (await failOrCancelFenced('cancelled', 'auth', prodErr, msg.id)) {
          summary.cancelled += 1;
        }
        continue;
      }
    }

    // 2e. Revalidate messaging window, HUMAN_AGENT approval, and account-scoped approved template
    const win = evaluateChannelWindow({
      channel: conv.channel,
      windowExpiresAt: conv.window_expires_at,
      humanAgentWindowExpiresAt: conv.human_agent_window_expires_at,
      humanAgentApproved: Boolean(config.humanAgentApproved),
      via: 'ui',
      now,
    });

    if (msg.message_tag === 'HUMAN_AGENT' && !win.humanAgentEligible && !win.standardOpen) {
      if (await failOrCancelFenced('failed', 'window_closed', 'human_agent_not_eligible', msg.id)) {
        summary.failed += 1;
      }
      continue;
    }

    let resolvedTpl: AdapterSendInput['template'] = null;
    if (msg.template_id) {
      const tplRow = await env.DB
        .prepare(
          `SELECT * FROM crm_templates
           WHERE id = ? AND channel = ? AND status = 'approved'
             AND (channel_account_id IS NULL OR channel_account_id = ?)`,
        )
        .bind(msg.template_id, conv.channel, account?.id ?? null)
        .first<TemplateRow>();
      if (tplRow) {
        let params: string[] = [];
        try {
          const parsed = msg.template_params_json ? JSON.parse(msg.template_params_json) : [];
          if (Array.isArray(parsed)) params = parsed.map((p) => String(p));
        } catch {
          params = [];
        }
        resolvedTpl = {
          id: tplRow.id,
          name: tplRow.name,
          language: tplRow.language,
          providerTemplateId: tplRow.provider_template_id,
          params,
        };
      }
    }

    if (!win.open && !resolvedTpl) {
      if (await failOrCancelFenced('failed', 'window_closed', 'window_closed', msg.id)) {
        summary.failed += 1;
      }
      continue;
    }

    const references = msg.references_json ? parseRfcReferences(msg.references_json) : [];
    const outcome = await dispatchAdapterSend(
      env,
      {
        account,
        config,
        channel: conv.channel,
        messageId: msg.id,
        conversationId: conv.id,
        subject: conv.subject,
        recipientEndpoint: dispatchRecipient,
        bodyText: msg.body_text,
        idempotencyKey: row.idempotency_key ?? row.request_id,
        inReplyTo: msg.in_reply_to ?? conv.last_rfc_message_id,
        references,
        template: resolvedTpl,
        messageTag:
          (msg.message_tag === 'HUMAN_AGENT' && win.humanAgentEligible) || win.requiresHumanAgentTag
            ? 'HUMAN_AGENT'
            : null,
        now,
      },
      opts.overrides,
    );

    if ('unknown' in outcome) {
      const committed = await commitFencedOutboxBatch(env.DB, [
        env.DB
          .prepare(
            `UPDATE crm_outbox
             SET status = 'review_required', lease_until = NULL, last_error_class = 'unknown', last_error = ?, updated_at = ?
             WHERE id = ? AND status = 'sending' AND attempts = ? AND lease_until = ?`,
          )
          .bind(outcome.detail, now, row.id, nextAttempts, leaseUntil),
        changesOneFence(env.DB),
        env.DB
          .prepare(
            `UPDATE crm_messages
             SET status = 'review_required', error_code = 'unknown', error_detail = ?, updated_at = ?
             WHERE id = ?`,
          )
          .bind(outcome.detail, now, msg.id),
      ]);
      if (committed) summary.reviewRequired += 1;
    } else if (outcome.ok) {
      const updateStmts: D1PreparedStatement[] = [
        env.DB
          .prepare(
            `UPDATE crm_outbox
             SET status = 'sent', lease_until = NULL, next_attempt_at = NULL,
                 provider_receipt = ?, last_error_class = NULL, last_error = NULL, updated_at = ?
             WHERE id = ? AND status = 'sending' AND attempts = ? AND lease_until = ?`,
          )
          .bind(outcome.externalId, now, row.id, nextAttempts, leaseUntil),
        changesOneFence(env.DB),
        env.DB
          .prepare(
            `UPDATE crm_messages
             SET status = 'sent', recipient_endpoint = ?, external_message_id = ?, rfc_message_id = COALESCE(?, rfc_message_id),
                 sent_at = ?, error_code = NULL, error_detail = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .bind(dispatchRecipient, outcome.externalId, outcome.rfcMessageId ?? null, now, now, msg.id),
        env.DB
          .prepare(
            `UPDATE crm_conversations
             SET last_outbound_at = MAX(COALESCE(last_outbound_at, 0), ?),
                 last_message_at = MAX(last_message_at, ?),
                 last_rfc_message_id = COALESCE(?, last_rfc_message_id),
                 unread_count = 0, rev = rev + 1, updated_at = ?
             WHERE id = ?`,
          )
          .bind(now, now, outcome.rfcMessageId ?? null, now, conv.id),
      ];
      if (account) {
        updateStmts.push(
          env.DB
            .prepare(`UPDATE crm_channel_accounts SET health_state = 'connected', last_error = NULL, last_error_at = NULL, updated_at = ? WHERE id = ?`)
            .bind(now, account.id),
        );
      }
      const committed = await commitFencedOutboxBatch(env.DB, updateStmts);
      if (committed) summary.sent += 1;
    } else if (isRetryableAdapterError(outcome.errorClass) && nextAttempts < row.max_attempts) {
      const nextAt = now + computeOutboxBackoffMs(nextAttempts);
      const stmts: D1PreparedStatement[] = [
        env.DB
          .prepare(
            `UPDATE crm_outbox
             SET status = 'queued', lease_until = NULL, next_attempt_at = ?,
                 last_error_class = ?, last_error = ?, updated_at = ?
             WHERE id = ? AND status = 'sending' AND attempts = ? AND lease_until = ?`,
          )
          .bind(nextAt, outcome.errorClass, outcome.detail, now, row.id, nextAttempts, leaseUntil),
        changesOneFence(env.DB),
        env.DB
          .prepare(
            `UPDATE crm_messages
             SET status = 'queued', error_code = ?, error_detail = ?, updated_at = ?
             WHERE id = ?`,
          )
          .bind(outcome.errorClass, outcome.detail, now, msg.id),
      ];
      if (account) {
        stmts.push(
          env.DB
            .prepare(`UPDATE crm_channel_accounts SET health_state = 'degraded', last_error = ?, last_error_at = ?, updated_at = ? WHERE id = ?`)
            .bind(outcome.detail, now, now, account.id),
        );
      }
      const committed = await commitFencedOutboxBatch(env.DB, stmts);
      if (committed) summary.requeued += 1;
    } else {
      const stmts: D1PreparedStatement[] = [
        env.DB
          .prepare(
            `UPDATE crm_outbox
             SET status = 'failed', lease_until = NULL, next_attempt_at = NULL,
                 last_error_class = ?, last_error = ?, updated_at = ?
             WHERE id = ? AND status = 'sending' AND attempts = ? AND lease_until = ?`,
          )
          .bind(outcome.errorClass, outcome.detail, now, row.id, nextAttempts, leaseUntil),
        changesOneFence(env.DB),
        env.DB
          .prepare(
            `UPDATE crm_messages
             SET status = 'failed', error_code = ?, error_detail = ?, updated_at = ?
             WHERE id = ?`,
          )
          .bind(outcome.errorClass, outcome.detail, now, msg.id),
      ];
      if (account && outcome.errorClass === 'auth') {
        stmts.push(
          env.DB
            .prepare(`UPDATE crm_channel_accounts SET health_state = 'error', last_error = ?, last_error_at = ?, updated_at = ? WHERE id = ?`)
            .bind(outcome.detail, now, now, account.id),
        );
      }
      const committed = await commitFencedOutboxBatch(env.DB, stmts);
      if (committed) summary.failed += 1;
    }
  }

  return summary;
}

/* ---------- Durable Pull Poller (Zoho Mail) & Scheduled Sweep ---------- */

export async function pollCrmChannelAccount(
  env: Env,
  accountId: string,
  now = Date.now(),
  opts: {
    limit?: number;
    simulatedMessages?: PollChannelNowInput['simulatedMessages'];
    fetchFn?: typeof fetch;
  } = {},
): Promise<
  | {
      ok: true;
      leased: boolean;
      ingested: number;
      duplicatesSkipped: number;
      optOutsRecorded: number;
      cursor: string | null;
      healthState: ChannelHealthState;
    }
  | { ok: false; error: 'not_found' | 'invalid_input' | 'provider_unavailable'; detail?: Record<string, unknown> }
> {
  const account = await env.DB
    .prepare(`SELECT * FROM crm_channel_accounts WHERE id = ?`)
    .bind(accountId)
    .first<ChannelAccountRow>();
  if (!account) return { ok: false, error: 'not_found' };
  if (account.provider !== 'email_zoho') {
    return { ok: false, error: 'invalid_input', detail: { reason: 'provider_not_pull_based' } };
  }
  if (account.mode === 'disabled' || account.active !== 1) {
    return { ok: false, error: 'provider_unavailable', detail: { reason: 'channel_account_disabled' } };
  }

  // Acquire durable poll lease atomically with exact rev generation bump
  const leaseUntil = now + POLL_LEASE_MS;
  const claimedRev = account.rev + 1;
  const claim = await env.DB
    .prepare(
      `UPDATE crm_channel_accounts
       SET poll_lease_until = ?, rev = ?, updated_at = ?
       WHERE id = ? AND rev = ? AND active = 1 AND mode != 'disabled'
         AND (poll_lease_until IS NULL OR poll_lease_until <= ?)`,
    )
    .bind(leaseUntil, claimedRev, now, account.id, account.rev, now)
    .run();
  if (!claim.meta.changes) {
    return {
      ok: true,
      leased: false,
      ingested: 0,
      duplicatesSkipped: 0,
      optOutsRecorded: 0,
      cursor: account.poll_cursor,
      healthState: account.health_state,
    };
  }

  const pollRes = await pollZohoMailInbound(
    env,
    account,
    {
      cursor: account.poll_cursor,
      limit: Math.min(25, Math.max(1, opts.limit ?? 15)),
      now,
      simulatedMessages: opts.simulatedMessages,
    },
    opts.fetchFn ?? fetch,
  );

  if (!pollRes.ok) {
    const nextHealth: ChannelHealthState = pollRes.errorClass === 'auth' ? 'error' : 'degraded';
    await env.DB
      .prepare(
        `UPDATE crm_channel_accounts
         SET poll_lease_until = NULL, health_state = ?, last_error = ?, last_error_at = ?, rev = rev + 1, updated_at = ?
         WHERE id = ? AND rev = ? AND poll_lease_until = ?`,
      )
      .bind(nextHealth, pollRes.detail, now, now, account.id, claimedRev, leaseUntil)
      .run();
    return {
      ok: false,
      error: 'provider_unavailable',
      detail: { errorClass: pollRes.errorClass, reason: pollRes.detail },
    };
  }

  const ingest = await ingestChannelInboundEvents(env, account, pollRes.events, now);

  // NEVER advance the polling cursor beyond durably processed events!
  let nextCursor = account.poll_cursor;
  if (ingest.budgetExhausted || ingest.unprocessedCount > 0) {
    const prevWatermark = parseZohoPollCursor(account.poll_cursor).watermarkTs;
    if (ingest.lastProcessedReceivedAt !== null && ingest.lastProcessedReceivedAt > prevWatermark) {
      nextCursor = formatZohoPollCursor({ watermarkTs: ingest.lastProcessedReceivedAt, offset: 0 });
    }
  } else {
    nextCursor = pollRes.nextCursor ?? account.poll_cursor;
  }

  const nextHealth: ChannelHealthState = ingest.budgetExhausted ? 'degraded' : 'connected';
  const lastErr = ingest.budgetExhausted ? 'poll_processing_budget_partial' : null;
  await env.DB
    .prepare(
      `UPDATE crm_channel_accounts
       SET poll_cursor = ?, poll_lease_until = NULL, last_poll_at = ?,
           health_state = ?, last_error = ?, last_error_at = CASE WHEN ? IS NULL THEN NULL ELSE ? END,
           rev = rev + 1, updated_at = ?
       WHERE id = ? AND rev = ? AND poll_lease_until = ?`,
    )
    .bind(nextCursor, now, nextHealth, lastErr, lastErr, now, now, account.id, claimedRev, leaseUntil)
    .run();

  return {
    ok: true,
    leased: true,
    ingested: ingest.ingested,
    duplicatesSkipped: ingest.duplicatesSkipped,
    optOutsRecorded: ingest.optOutsRecorded,
    cursor: nextCursor,
    healthState: nextHealth,
  };
}

/**
 * Scheduled cron sweep (invoked from `worker/reminders.ts` ONLY when `CRM_ENABLED` is set).
 * Bounded inside the shared 45-call D1 budget: processes due outbox items and polls active Zoho Mail accounts.
 */
export async function runCrmScheduledSweep(env: Env, now = Date.now()): Promise<{
  outbox: OutboxSweepSummary;
  polledAccounts: number;
  expiredHolds: number;
}> {
  const outbox = await processCrmOutbox(env, now, { limit: 6 });
  let polledAccounts = 0;
  let expiredHolds = 0;

  if (hasD1Budget(env.DB, 6)) {
    const { sweepExpiredBookingHolds } = await import('./bookings');
    expiredHolds = await sweepExpiredBookingHolds(env.DB, now, 8);
  }

  if (hasD1Budget(env.DB, 10)) {
    const pullAccounts = await env.DB
      .prepare(
        `SELECT id FROM crm_channel_accounts
         WHERE provider = 'email_zoho' AND active = 1 AND mode != 'disabled'
           AND (poll_lease_until IS NULL OR poll_lease_until <= ?)
         ORDER BY COALESCE(last_poll_at, 0) ASC
         LIMIT 3`,
      )
      .bind(now)
      .all<{ id: string }>();

    for (const acc of pullAccounts.results) {
      if (!hasD1Budget(env.DB, 8)) break;
      const res = await pollCrmChannelAccount(env, acc.id, now, { limit: 10 });
      if (res.ok && res.leased) polledAccounts += 1;
    }
  }

  return { outbox, polledAccounts, expiredHolds };
}

/* ---------- Commands: Channel Accounts, Templates, Review & Outbox ---------- */

function configureChannelAccountCommand(): CommandDefinition<
  ConfigureChannelAccountInput,
  { account: CrmChannelAccountDto }
> {
  return {
    name: 'channel.configure',
    authorizeCoarse: (actor, via) =>
      via === 'ui' &&
      canAccessCrmApi(actor) &&
      (actor.role === 'owner' || actor.role === 'admin') &&
      evaluateCapability(actor, 'crm.channels.manage', '*'),
    parseInput: (raw) => {
      const parsed = ConfigureChannelAccountInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input', detail: { reason: 'invalid_channel_config' } };
      if (!isProviderCompatibleWithChannel(parsed.data.provider, parsed.data.channel)) {
        return { ok: false, error: 'invalid_input', detail: { reason: 'provider_channel_mismatch' } };
      }
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      if (input.mode === 'simulated' && !isLocalTestSimulatedMode(env)) {
        return { kind: 'refuse', error: 'provider_unavailable', detail: { reason: 'simulated_local_test_only' } };
      }
      if (input.mode === 'production' && input.active) {
        const cfgErr = validateProductionAccountConfig(input.provider, input.config, input.secretName, env);
        if (cfgErr) {
          return { kind: 'refuse', error: 'invalid_input', detail: { reason: cfgErr } };
        }
      }

      const existing = input.accountId
        ? await env.DB.prepare(`SELECT * FROM crm_channel_accounts WHERE id = ?`).bind(input.accountId).first<ChannelAccountRow>()
        : null;
      if (input.accountId && !existing) {
        return { kind: 'refuse', error: 'not_found' };
      }

      const id = existing?.id ?? `ch_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const activeNum = input.mode === 'disabled' ? 0 : input.active ? 1 : 0;
      const health: ChannelHealthState =
        activeNum === 0 || input.mode === 'disabled' ? 'disconnected' : 'connected';
      const nextRev = existing ? existing.rev + 1 : 1;
      const secretName = input.secretName === undefined ? (existing?.secret_name ?? null) : input.secretName;

      const nextRow: ChannelAccountRow = {
        id,
        channel: input.channel,
        provider: input.provider,
        label: input.label,
        external_id: input.externalId,
        mode: input.mode,
        active: activeNum,
        secret_name: secretName,
        config_json: JSON.stringify(input.config),
        poll_cursor: existing?.poll_cursor ?? null,
        poll_lease_until: existing?.poll_lease_until ?? null,
        last_poll_at: existing?.last_poll_at ?? null,
        health_state: health,
        last_error: null,
        last_error_at: null,
        rev: nextRev,
        created_by: existing?.created_by ?? actor.id,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };

      const stmt = existing
        ? env.DB
            .prepare(
              `UPDATE crm_channel_accounts
               SET channel = ?, provider = ?, label = ?, external_id = ?, mode = ?, active = ?,
                   secret_name = ?, config_json = ?, health_state = ?, last_error = NULL, last_error_at = NULL,
                   rev = rev + 1, updated_at = ?
               WHERE id = ? AND rev = ?`,
            )
            .bind(
              nextRow.channel,
              nextRow.provider,
              nextRow.label,
              nextRow.external_id,
              nextRow.mode,
              nextRow.active,
              nextRow.secret_name,
              nextRow.config_json,
              nextRow.health_state,
              now,
              existing.id,
              existing.rev,
            )
        : env.DB
            .prepare(
              `INSERT INTO crm_channel_accounts
                 (id, channel, provider, label, external_id, mode, active, secret_name, config_json, poll_cursor, poll_lease_until, last_poll_at, health_state, last_error, last_error_at, rev, created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, 1, ?, ?, ?)`,
            )
            .bind(
              nextRow.id,
              nextRow.channel,
              nextRow.provider,
              nextRow.label,
              nextRow.external_id,
              nextRow.mode,
              nextRow.active,
              nextRow.secret_name,
              nextRow.config_json,
              nextRow.health_state,
              actor.id,
              now,
              now,
            );

      return {
        kind: 'commit',
        result: { account: mapChannelAccountRow(nextRow, env) },
        fences: [() => crmActorFence(env.DB, actor, tokenHash, 'crm.channels.manage', '*')],
        rows: existing ? [stmt, changesOneFence(env.DB)] : [stmt],
      };
    },
    mapConstraintError: () => ({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'duplicate_channel_external_id' },
      retryable: false,
    }),
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function setChannelAccountModeCommand(): CommandDefinition<
  SetChannelAccountModeInput,
  { account: CrmChannelAccountDto }
> {
  return {
    name: 'channel.set_mode',
    authorizeCoarse: (actor, via) =>
      via === 'ui' &&
      canAccessCrmApi(actor) &&
      (actor.role === 'owner' || actor.role === 'admin') &&
      evaluateCapability(actor, 'crm.channels.manage', '*'),
    parseInput: (raw) => {
      const parsed = SetChannelAccountModeInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const existing = await env.DB
        .prepare(`SELECT * FROM crm_channel_accounts WHERE id = ?`)
        .bind(input.accountId)
        .first<ChannelAccountRow>();
      if (!existing) return { kind: 'refuse', error: 'not_found' };
      if (input.expectedRev !== undefined && existing.rev !== input.expectedRev) {
        return { kind: 'refuse', error: 'stale' };
      }
      if (input.mode === 'simulated' && !isLocalTestSimulatedMode(env)) {
        return { kind: 'refuse', error: 'provider_unavailable', detail: { reason: 'simulated_local_test_only' } };
      }
      const config = parseChannelAccountConfig(existing.config_json);
      if (input.mode === 'production' && input.active) {
        const cfgErr = validateProductionAccountConfig(existing.provider, config, existing.secret_name, env);
        if (cfgErr) {
          return { kind: 'refuse', error: 'invalid_input', detail: { reason: cfgErr } };
        }
      }

      const activeNum = input.mode === 'disabled' ? 0 : input.active ? 1 : 0;
      const health: ChannelHealthState =
        activeNum === 0 || input.mode === 'disabled' ? 'disconnected' : 'connected';
      const updated: ChannelAccountRow = {
        ...existing,
        mode: input.mode,
        active: activeNum,
        health_state: health,
        last_error: activeNum === 0 ? null : existing.last_error,
        last_error_at: activeNum === 0 ? null : existing.last_error_at,
        rev: existing.rev + 1,
        updated_at: now,
      };

      return {
        kind: 'commit',
        result: { account: mapChannelAccountRow(updated, env) },
        fences: [() => crmActorFence(env.DB, actor, tokenHash, 'crm.channels.manage', '*')],
        rows: [
          env.DB
            .prepare(
              `UPDATE crm_channel_accounts
               SET mode = ?, active = ?, health_state = ?, rev = rev + 1, updated_at = ?
               WHERE id = ? AND rev = ?`,
            )
            .bind(updated.mode, updated.active, updated.health_state, now, existing.id, existing.rev),
          changesOneFence(env.DB),
        ],
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function pollChannelNowCommand(): CommandDefinition<
  PollChannelNowInput,
  {
    accountId: string;
    leased: boolean;
    ingested: number;
    duplicatesSkipped: number;
    optOutsRecorded: number;
    cursor: string | null;
    healthState: ChannelHealthState;
  }
> {
  return {
    name: 'channel.poll_now',
    authorizeCoarse: (actor, via) =>
      via === 'ui' && canAccessCrmApi(actor) && evaluateCapability(actor, 'crm.channels.manage', '*'),
    parseInput: (raw) => {
      const parsed = PollChannelNowInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input }) => {
      // Read-only pre-check ONLY; NEVER run side-effecting poll before crmActorFence & idempotency commit!
      const account = await env.DB
        .prepare(`SELECT id, provider, mode, active, poll_cursor, health_state FROM crm_channel_accounts WHERE id = ?`)
        .bind(input.accountId)
        .first<Pick<ChannelAccountRow, 'id' | 'provider' | 'mode' | 'active' | 'poll_cursor' | 'health_state'>>();
      if (!account) return { kind: 'refuse', error: 'not_found' };
      if (account.provider !== 'email_zoho') {
        return { kind: 'refuse', error: 'invalid_input', detail: { reason: 'provider_not_pull_based' } };
      }
      if (account.mode === 'disabled' || account.active !== 1) {
        return { kind: 'refuse', error: 'provider_unavailable', detail: { reason: 'channel_account_disabled' } };
      }
      return {
        kind: 'commit',
        result: {
          accountId: input.accountId,
          leased: false,
          ingested: 0,
          duplicatesSkipped: 0,
          optOutsRecorded: 0,
          cursor: account.poll_cursor,
          healthState: account.health_state,
        },
        fences: [() => crmActorFence(env.DB, actor, tokenHash, 'crm.channels.manage', '*')],
        postCommitExecute: async ({ env: execEnv, now: execNow }) => {
          const res = await pollCrmChannelAccount(execEnv, input.accountId, execNow, {
            limit: input.limit,
            simulatedMessages: input.simulatedMessages,
          });
          if (!res.ok) {
            return { ok: false, error: res.error, detail: res.detail };
          }
          return {
            ok: true,
            result: {
              accountId: input.accountId,
              leased: res.leased,
              ingested: res.ingested,
              duplicatesSkipped: res.duplicatesSkipped,
              optOutsRecorded: res.optOutsRecorded,
              cursor: res.cursor,
              healthState: res.healthState,
            },
          };
        },
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function upsertTemplateCommand(): CommandDefinition<UpsertTemplateInput, { template: CrmTemplateDto }> {
  return {
    name: 'template.upsert',
    authorizeCoarse: (actor, via) =>
      via === 'ui' &&
      canAccessCrmApi(actor) &&
      (evaluateCapability(actor, 'crm.channels.manage', '*') || evaluateCapability(actor, 'crm.configure', '*')),
    parseInput: (raw) => {
      const parsed = UpsertTemplateInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const existing = input.templateId
        ? await env.DB.prepare(`SELECT * FROM crm_templates WHERE id = ?`).bind(input.templateId).first<TemplateRow>()
        : null;
      if (input.templateId && !existing) return { kind: 'refuse', error: 'not_found' };
      if (existing && existing.status !== 'draft' && existing.status !== 'rejected') {
        return { kind: 'refuse', error: 'stale', detail: { reason: 'only_draft_or_rejected_templates_editable' } };
      }

      const id = existing?.id ?? `tpl_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const nextRow: TemplateRow = {
        id,
        channel: input.channel,
        channel_account_id: input.channelAccountId ?? existing?.channel_account_id ?? null,
        name: input.name,
        language: input.language,
        category: input.category,
        provider_template_id: existing?.provider_template_id ?? null,
        status: 'draft',
        body_text: input.bodyText,
        variables_json: JSON.stringify(input.variables),
        rejection_reason: null,
        submitted_at: null,
        approved_at: null,
        rev: existing ? existing.rev + 1 : 1,
        created_by: existing?.created_by ?? actor.id,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };

      const requiredCap: CrmCapability = evaluateCapability(actor, 'crm.channels.manage', '*')
        ? 'crm.channels.manage'
        : 'crm.configure';

      const stmt = existing
        ? env.DB
            .prepare(
              `UPDATE crm_templates
               SET channel = ?, channel_account_id = ?, name = ?, language = ?, category = ?,
                   status = 'draft', body_text = ?, variables_json = ?, rejection_reason = NULL,
                   rev = rev + 1, updated_at = ?
               WHERE id = ? AND rev = ?`,
            )
            .bind(
              nextRow.channel,
              nextRow.channel_account_id,
              nextRow.name,
              nextRow.language,
              nextRow.category,
              nextRow.body_text,
              nextRow.variables_json,
              now,
              existing.id,
              existing.rev,
            )
        : env.DB
            .prepare(
              `INSERT INTO crm_templates
                 (id, channel, channel_account_id, name, language, category, provider_template_id, status, body_text, variables_json, rejection_reason, submitted_at, approved_at, rev, created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, NULL, 'draft', ?, ?, NULL, NULL, NULL, 1, ?, ?, ?)`,
            )
            .bind(
              nextRow.id,
              nextRow.channel,
              nextRow.channel_account_id,
              nextRow.name,
              nextRow.language,
              nextRow.category,
              nextRow.body_text,
              nextRow.variables_json,
              actor.id,
              now,
              now,
            );

      return {
        kind: 'commit',
        result: { template: mapTemplateRow(nextRow) },
        fences: [() => crmActorFence(env.DB, actor, tokenHash, requiredCap, '*')],
        rows: existing ? [stmt, changesOneFence(env.DB)] : [stmt],
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function submitTemplateCommand(): CommandDefinition<SubmitTemplateInput, { template: CrmTemplateDto }> {
  return {
    name: 'template.submit',
    authorizeCoarse: (actor, via) =>
      via === 'ui' && canAccessCrmApi(actor) && evaluateCapability(actor, 'crm.channels.manage', '*'),
    parseInput: (raw) => {
      const parsed = SubmitTemplateInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const existing = await env.DB
        .prepare(`SELECT * FROM crm_templates WHERE id = ?`)
        .bind(input.templateId)
        .first<TemplateRow>();
      if (!existing) return { kind: 'refuse', error: 'not_found' };
      if (existing.status !== 'draft' && existing.status !== 'rejected') {
        return { kind: 'refuse', error: 'stale', detail: { reason: 'template_not_submittable', status: existing.status } };
      }

      const updated: TemplateRow = {
        ...existing,
        status: 'submitted',
        rejection_reason: null,
        submitted_at: now,
        rev: existing.rev + 1,
        updated_at: now,
      };
      return {
        kind: 'commit',
        result: { template: mapTemplateRow(updated) },
        fences: [() => crmActorFence(env.DB, actor, tokenHash, 'crm.channels.manage', '*')],
        rows: [
          env.DB
            .prepare(
              `UPDATE crm_templates
               SET status = 'submitted', rejection_reason = NULL, submitted_at = ?, rev = rev + 1, updated_at = ?
               WHERE id = ? AND rev = ?`,
            )
            .bind(now, now, existing.id, existing.rev),
          changesOneFence(env.DB),
        ],
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function syncTemplateStatusCommand(): CommandDefinition<SyncTemplateStatusInput, { template: CrmTemplateDto }> {
  return {
    name: 'template.sync_status',
    authorizeCoarse: (actor, via) =>
      via === 'ui' && canAccessCrmApi(actor) && evaluateCapability(actor, 'crm.channels.manage', '*'),
    parseInput: (raw) => {
      const parsed = SyncTemplateStatusInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const existing = await env.DB
        .prepare(`SELECT * FROM crm_templates WHERE id = ?`)
        .bind(input.templateId)
        .first<TemplateRow>();
      if (!existing) return { kind: 'refuse', error: 'not_found' };

      const providerTplId =
        input.providerTemplateId !== undefined ? input.providerTemplateId : existing.provider_template_id;
      const rejectionReason =
        input.status === 'rejected' ? (input.rejectionReason ?? 'Rejected by provider') : null;
      const approvedAt = input.status === 'approved' ? (existing.approved_at ?? now) : existing.approved_at;

      const updated: TemplateRow = {
        ...existing,
        status: input.status,
        provider_template_id: providerTplId,
        rejection_reason: rejectionReason,
        approved_at: approvedAt,
        rev: existing.rev + 1,
        updated_at: now,
      };
      return {
        kind: 'commit',
        result: { template: mapTemplateRow(updated) },
        fences: [() => crmActorFence(env.DB, actor, tokenHash, 'crm.channels.manage', '*')],
        rows: [
          env.DB
            .prepare(
              `UPDATE crm_templates
               SET status = ?, provider_template_id = ?, rejection_reason = ?, approved_at = ?, rev = rev + 1, updated_at = ?
               WHERE id = ? AND rev = ?`,
            )
            .bind(updated.status, updated.provider_template_id, updated.rejection_reason, updated.approved_at, now, existing.id, existing.rev),
          changesOneFence(env.DB),
        ],
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function resolveMessageReviewCommand(): CommandDefinition<
  ResolveMessageReviewInput,
  { messageId: string; status: 'sent' | 'failed' | 'cancelled'; providerReceipt: string | null }
> {
  return {
    name: 'message.resolve_review',
    authorizeCoarse: (actor, via) => via === 'ui' && canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = ResolveMessageReviewInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const [msg, outbox] = await Promise.all([
        env.DB
          .prepare(`SELECT id, conversation_id, status, channel, updated_at FROM crm_messages WHERE id = ?`)
          .bind(input.messageId)
          .first<{ id: string; conversation_id: string; status: string; channel: string; updated_at: number }>(),
        env.DB
          .prepare(`SELECT * FROM crm_outbox WHERE message_id = ?`)
          .bind(input.messageId)
          .first<OutboxRow>(),
      ]);
      if (!msg || !outbox) return { kind: 'refuse', error: 'not_found' };
      if (!isDigitalChannel(msg.channel)) return { kind: 'refuse', error: 'invalid_input' };

      const conv = await env.DB
        .prepare(`SELECT id, person_id, organisation_id, application_id, rev FROM crm_conversations WHERE id = ?`)
        .bind(msg.conversation_id)
        .first<{ id: string; person_id: string | null; organisation_id: string | null; application_id: string | null; rev: number }>();
      if (!conv) return { kind: 'refuse', error: 'not_found' };

      const gate = createReadGate(env.DB, actor.id);
      const linked = [conv.person_id, conv.organisation_id, conv.application_id].filter((x): x is string => Boolean(x));
      if (linked.length > 0) {
        const readable = await loadReadableTaskRecords(env, gate, linked);
        if (linked.some((id) => !readable.has(id))) {
          return { kind: 'refuse', error: 'not_found' };
        }
      }

      const cap = sendCap(msg.channel);
      if (!evaluateCapability(actor, cap, '*')) {
        return { kind: 'refuse', error: 'forbidden' };
      }

      if (msg.status !== 'review_required' || outbox.status !== 'review_required') {
        return { kind: 'refuse', error: 'stale', detail: { reason: 'message_not_in_review', status: msg.status } };
      }

      const nextStatus: 'sent' | 'failed' | 'cancelled' =
        input.resolution === 'confirm_sent'
          ? 'sent'
          : input.resolution === 'mark_failed'
            ? 'failed'
            : 'cancelled';
      const receipt =
        nextStatus === 'sent' ? (input.providerReceipt?.trim() || outbox.provider_receipt || `manual_verified_${now}`) : null;
      const note = input.note?.trim() || null;

      const rows: D1PreparedStatement[] = [
        env.DB
          .prepare(
            `UPDATE crm_outbox
             SET status = ?, lease_until = NULL, provider_receipt = COALESCE(?, provider_receipt),
                 resolution_note = ?, resolved_by = ?, resolved_at = ?, updated_at = ?
             WHERE id = ? AND status = 'review_required'`,
          )
          .bind(nextStatus, receipt, note, actor.id, now, now, outbox.id),
        changesOneFence(env.DB),
        env.DB
          .prepare(
            `UPDATE crm_messages
             SET status = ?, external_message_id = COALESCE(?, external_message_id),
                 sent_at = CASE WHEN ? = 'sent' THEN COALESCE(sent_at, ?) ELSE sent_at END,
                 error_code = CASE WHEN ? = 'sent' THEN NULL ELSE error_code END,
                 error_detail = CASE WHEN ? = 'sent' THEN NULL ELSE COALESCE(?, error_detail) END,
                 updated_at = ?
             WHERE id = ? AND status = 'review_required'`,
          )
          .bind(nextStatus, receipt, nextStatus, now, nextStatus, nextStatus, note, now, msg.id),
        changesOneFence(env.DB),
      ];

      if (nextStatus === 'sent') {
        rows.push(
          env.DB
            .prepare(
              `UPDATE crm_conversations
               SET last_outbound_at = ?, last_message_at = MAX(last_message_at, ?), unread_count = 0, rev = rev + 1, updated_at = ?
               WHERE id = ?`,
            )
            .bind(now, now, now, conv.id),
        );
      }

      return {
        kind: 'commit',
        result: { messageId: msg.id, status: nextStatus, providerReceipt: receipt },
        fences: [() => crmActorFence(env.DB, actor, tokenHash, cap, '*')],
        rows,
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

function processOutboxNowCommand(): CommandDefinition<ProcessOutboxNowInput, OutboxSweepSummary> {
  return {
    name: 'outbox.process_now',
    authorizeCoarse: (actor, via) =>
      via === 'ui' && canAccessCrmApi(actor) && evaluateCapability(actor, 'crm.channels.manage', '*'),
    parseInput: (raw) => {
      const parsed = ProcessOutboxNowInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input }) => {
      // NEVER dispatch outbox items before crmActorFence & crm_commands idempotency commit!
      return {
        kind: 'commit',
        result: {
          expiredMovedToReview: 0,
          attempted: 0,
          sent: 0,
          requeued: 0,
          failed: 0,
          reviewRequired: 0,
          cancelled: 0,
        },
        fences: [() => crmActorFence(env.DB, actor, tokenHash, 'crm.channels.manage', '*')],
        postCommitExecute: async ({ env: execEnv, now: execNow }) => {
          const summary = await processCrmOutbox(execEnv, execNow, { limit: input.limit ?? 10 });
          return { ok: true, result: summary };
        },
      };
    },
    afterCommit: ({ env, executionCtx }) => pokeLive(env, executionCtx),
  };
}

export function createP3ChannelCommandDefs(): AnyCommandDefinition[] {
  return [
    configureChannelAccountCommand(),
    setChannelAccountModeCommand(),
    pollChannelNowCommand(),
    upsertTemplateCommand(),
    submitTemplateCommand(),
    syncTemplateStatusCommand(),
    resolveMessageReviewCommand(),
    processOutboxNowCommand(),
  ];
}

/* ---------- Read APIs: GET /api/crm/read/channels & /read/templates ---------- */

export async function readChannelsOverview(
  env: Env,
  actorId: string,
  tokenHash: string,
): Promise<
  | { status: 200; body: ChannelsOverviewResponse }
  | { status: 401 | 403 | 404; body: { error: string } }
> {
  if (!isCrmEnabled(env)) {
    return { status: 404, body: { error: 'not_found' } };
  }

  const batchNow = Date.now();
  const [sessionRes, grantsRes, accountsRes, templatesRes, outboxRes] = await env.DB.batch([
    sessionAuthStmt(env.DB, actorId, tokenHash, batchNow),
    actorGrantsStmt(env.DB, actorId),
    env.DB.prepare(`SELECT * FROM crm_channel_accounts ORDER BY channel ASC, updated_at DESC LIMIT 50`),
    env.DB.prepare(`SELECT * FROM crm_templates ORDER BY channel ASC, updated_at DESC LIMIT 100`),
    env.DB.prepare(
      `SELECT o.*,
              c.subject AS conv_subject, c.person_id AS conv_person_id,
              c.organisation_id AS conv_org_id, c.application_id AS conv_app_id,
              m.channel AS msg_channel, m.recipient_endpoint AS msg_recipient,
              m.body_text AS msg_body, m.message_tag AS msg_tag, m.template_id AS msg_template_id
       FROM crm_outbox o
       JOIN crm_conversations c ON c.id = o.conversation_id
       JOIN crm_messages m ON m.id = o.message_id
       ORDER BY o.updated_at DESC, o.id DESC
       LIMIT 100`,
    ),
  ]);

  const batchAuth = evaluateCrmReadAuthRows(
    sessionRes.results[0] as CrmSessionRow | undefined,
    grantsRes.results as unknown as CrmGrantRow[],
  );
  if (!batchAuth.ok) return { status: batchAuth.status, body: batchAuth.body };

  const outboxRows = outboxRes.results as unknown as OutboxOverviewRow[];
  const gate = createReadGate(env.DB, actorId);
  const linkedIds = [
    ...new Set(
      outboxRows
        .flatMap((r) => [r.conv_person_id, r.conv_org_id, r.conv_app_id])
        .filter((x): x is string => Boolean(x)),
    ),
  ];
  const readableLinked = await loadReadableTaskRecords(env, gate, linkedIds);

  const finalAuth = await finalizeCrmReadAuth(env, actorId, tokenHash, { gate });
  if (!finalAuth.ok) return { status: finalAuth.status, body: finalAuth.body };

  let partial = outboxRows.length >= 100;
  const counts = { queued: 0, sending: 0, sent: 0, failed: 0, reviewRequired: 0, cancelled: 0 };
  const deliveries: CrmOutboxDeliveryDto[] = [];

  for (const r of outboxRows) {
    const ok =
      (!r.conv_person_id || readableLinked.has(r.conv_person_id)) &&
      (!r.conv_org_id || readableLinked.has(r.conv_org_id)) &&
      (!r.conv_app_id || readableLinked.has(r.conv_app_id));
    if (!ok) {
      partial = true;
      continue;
    }
    if (r.status === 'queued') counts.queued += 1;
    else if (r.status === 'sending') counts.sending += 1;
    else if (r.status === 'sent') counts.sent += 1;
    else if (r.status === 'failed') counts.failed += 1;
    else if (r.status === 'review_required') counts.reviewRequired += 1;
    else if (r.status === 'cancelled') counts.cancelled += 1;

    deliveries.push({
      id: r.id,
      messageId: r.message_id,
      conversationId: r.conversation_id,
      conversationSubject: r.conv_subject ?? '',
      channel: r.msg_channel ?? 'email',
      channelAccountId: r.channel_account_id,
      recipientEndpoint: r.msg_recipient,
      bodyPreview: (r.msg_body ?? '').slice(0, 160),
      status: r.status,
      purpose: r.purpose,
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
      nextAttemptAt: r.next_attempt_at,
      lastErrorClass: r.last_error_class,
      lastError: r.last_error,
      providerReceipt: r.provider_receipt,
      messageTag: r.msg_tag,
      templateId: r.msg_template_id,
      resolutionNote: r.resolution_note,
      resolvedBy: r.resolved_by,
      resolvedAt: r.resolved_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  }

  const accounts = (accountsRes.results as unknown as ChannelAccountRow[]).map((a) => mapChannelAccountRow(a, env));
  const templates = (templatesRes.results as unknown as TemplateRow[]).map(mapTemplateRow);
  const canManageChannels =
    (finalAuth.actor.role === 'owner' || finalAuth.actor.role === 'admin') &&
    evaluateCapability(finalAuth.actor, 'crm.channels.manage', '*');

  return {
    status: 200,
    body: ChannelsOverviewResponseSchema.parse({
      accounts,
      templates,
      deliveries,
      counts,
      simulatedMode: isLocalTestSimulatedMode(env),
      canManageChannels,
      partial,
    }),
  };
}

export async function readTemplates(
  env: Env,
  actorId: string,
  tokenHash: string,
  opts: { channel?: string | null; status?: string | null } = {},
): Promise<
  | { status: 200; body: TemplatesListResponse }
  | { status: 401 | 403 | 404; body: { error: string } }
> {
  if (!isCrmEnabled(env)) {
    return { status: 404, body: { error: 'not_found' } };
  }

  const batchNow = Date.now();
  const ch = opts.channel && isDigitalChannel(opts.channel) ? opts.channel : null;
  const st = opts.status?.trim() || null;

  const [sessionRes, grantsRes, tplRes] = await env.DB.batch([
    sessionAuthStmt(env.DB, actorId, tokenHash, batchNow),
    actorGrantsStmt(env.DB, actorId),
    env.DB
      .prepare(
        `SELECT * FROM crm_templates
         WHERE (?1 IS NULL OR channel = ?1)
           AND (?2 IS NULL OR status = ?2)
         ORDER BY channel ASC, name ASC, updated_at DESC
         LIMIT 100`,
      )
      .bind(ch, st),
  ]);

  const batchAuth = evaluateCrmReadAuthRows(
    sessionRes.results[0] as CrmSessionRow | undefined,
    grantsRes.results as unknown as CrmGrantRow[],
  );
  if (!batchAuth.ok) return { status: batchAuth.status, body: batchAuth.body };

  const finalAuth = await finalizeCrmReadAuth(env, actorId, tokenHash);
  if (!finalAuth.ok) return { status: finalAuth.status, body: finalAuth.body };

  return {
    status: 200,
    body: TemplatesListResponseSchema.parse({
      items: (tplRes.results as unknown as TemplateRow[]).map(mapTemplateRow),
    }),
  };
}
