import { CRM_CHANNELS, type CrmCapability, type CrmChannel } from '../../shared/crm/capabilities';
import {
  AddMessageNoteInputSchema,
  AssignConversationInputSchema,
  GenerateAiDraftInputSchema,
  LinkConversationPersonInputSchema,
  LogManualConversationInputSchema,
  MESSAGING_WINDOW_MS,
  RetryMessageInputSchema,
  SaveMessageDraftInputSchema,
  SendMessageInputSchema,
  SetConversationStateInputSchema,
  SimulateInboundInputSchema,
  composeGroundedAiDraft,
  type AddMessageNoteInput,
  type AssignConversationInput,
  type ConversationChannel,
  type ConversationDetailResponse,
  type ConversationFilter,
  type ConversationState,
  type ConversationsPageResponse,
  type CrmConversationDto,
  type CrmFactDto,
  type CrmMessageDto,
  type GenerateAiDraftInput,
  type LinkConversationPersonInput,
  type LogManualConversationInput,
  type RetryMessageInput,
  type SaveMessageDraftInput,
  type SendMessageInput,
  type SetConversationStateInput,
  type SimulateInboundInput,
} from '../../shared/crm/conversations';
import {
  HUMAN_AGENT_WINDOW_MS,
  buildRfcReferences,
  computeOutboxBackoffMs,
  evaluateChannelWindow,
  isRetryableAdapterError,
  type ChannelAccountMode,
} from '../../shared/crm/channels';
import { normalizeEndpoint, type CrmConsentDto } from '../../shared/crm/identity';
import { evaluateEffectiveChannelConsent } from '../../shared/crm/merge';
import {
  CRM_PROGRAMME_BY_SLUG,
  ProgrammeProfileV1Schema,
  isRegisteredProgrammeSlug,
} from '../../shared/crm/programmes';
import { CRM_PROJECTION } from '../../shared/crm/projection';
import type { Mutation } from '../../shared/types';
import type { Env } from '../auth';
import { sha256Hex } from '../password';
import { createReadGate, type ReadGate } from '../readAccess';
import { pokeLive } from '../sync';
import { isLocalTestSimulatedMode } from './adapters/simulated';
import { parseChannelAccountConfig } from './adapters/types';
import {
  dispatchAdapterSend,
  mapTemplateRow,
  resolveChannelAccountForSend,
  type TemplateRow,
} from './channels';
import type { AnyCommandDefinition, CommandDefinition } from './commands';
import { mapFactRow, type FactRow } from './facts';
import {
  assertNotArchivedAlias,
  latestConsentRowsPerTupleStmt,
  loadAliasesForSurvivor,
  notArchivedAliasFence,
  resolveCanonicalPersonId,
} from './merge';
import {
  actorGrantsStmt,
  crmActorFence,
  decodeTimeIdCursor,
  encodeTimeIdCursor,
  evaluateCrmReadAuthRows,
  finalizeCrmReadAuth,
  loadCrmReadContext,
  loadReadableTaskRecord,
  loadReadableTaskRecords,
  sessionAuthStmt,
  type CrmGrantRow,
  type CrmSessionRow,
} from './read';
import { canAccessCrmApi, evaluateCapability, isCrmEnabled } from './rules';

interface ConvRow {
  id: string;
  channel: ConversationChannel;
  channel_account_id: string | null;
  external_thread_id: string | null;
  person_id: string | null;
  organisation_id: string | null;
  programme_slug: string | null;
  application_id: string | null;
  subject: string;
  state: ConversationState;
  assignee_id: string | null;
  window_expires_at: number | null;
  human_agent_window_expires_at?: number | null;
  last_rfc_message_id?: string | null;
  email_subject_norm?: string | null;
  last_message_at: number;
  last_inbound_at: number | null;
  last_outbound_at: number | null;
  unread_count: number;
  rev: number;
  created_at: number;
  updated_at: number;
}

interface MsgRow {
  id: string;
  conversation_id: string;
  direction: 'inbound' | 'outbound' | 'note';
  status: 'received' | 'draft' | 'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'review_required' | 'cancelled' | 'note';
  channel: string;
  sender_endpoint: string | null;
  recipient_endpoint: string | null;
  author_user_id: string | null;
  author_name?: string | null;
  body_text: string;
  external_message_id: string | null;
  rfc_message_id?: string | null;
  in_reply_to?: string | null;
  references_json?: string | null;
  template_id: string | null;
  template_params_json?: string | null;
  message_tag?: string | null;
  ai_metadata_json: string | null;
  error_code: string | null;
  error_detail: string | null;
  sent_at: number | null;
  delivered_at?: number | null;
  read_at?: number | null;
  created_at: number;
  updated_at?: number;
}

function isDigitalSendChannel(ch: string): ch is CrmChannel {
  return (CRM_CHANNELS as readonly string[]).includes(ch);
}

function sendCapabilityForChannel(ch: CrmChannel): CrmCapability {
  return `crm.send:${ch}` as CrmCapability;
}

function convRevFence(
  db: D1Database,
  convId: string,
  expectedRev: number,
  extra?: { channel?: string; personId?: string | null; disallowSpam?: boolean },
): D1PreparedStatement {
  if (!extra) {
    return db
      .prepare(
        `SELECT CASE WHEN EXISTS (
           SELECT 1 FROM crm_conversations WHERE id = ? AND rev = ?
         ) THEN 1 ELSE json_extract('{', '$') END`,
      )
      .bind(convId, expectedRev);
  }
  return db
    .prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM crm_conversations
         WHERE id = ? AND rev = ?
           AND (? IS NULL OR channel = ?)
           AND COALESCE(person_id, '') = COALESCE(?, '')
           AND (? = 0 OR state != 'spam')
       ) THEN 1 ELSE json_extract('{', '$') END`,
    )
    .bind(
      convId,
      expectedRev,
      extra.channel ?? null,
      extra.channel ?? null,
      extra.personId ?? null,
      extra.disallowSpam ? 1 : 0,
    );
}

export function consentNotWithdrawnFence(
  db: D1Database,
  personId: string,
  channel: string,
  scope: 'transactional' | 'updates' | 'documentation' | 'publication' = 'transactional',
): D1PreparedStatement {
  return db
    .prepare(
      `WITH relevant_people(pid, eff_at, is_canon) AS (
         SELECT ?1, 0, 1
         UNION ALL
         SELECT alias_id, effective_at, 0 FROM crm_person_aliases WHERE survivor_id = ?1
       ),
       latest_per_person AS (
         SELECT c.person_id, c.channel, c.scope, c.status, c.recorded_at, c.id, rp.eff_at, rp.is_canon,
           ROW_NUMBER() OVER (
             PARTITION BY c.person_id, c.channel, c.scope
             ORDER BY c.recorded_at DESC, c.id DESC
           ) AS rn
         FROM crm_consents c
         JOIN relevant_people rp ON rp.pid = c.person_id
         WHERE c.channel IN (?2, 'any') AND c.scope = ?3
       ),
       latest AS (
         SELECT * FROM latest_per_person WHERE rn = 1
       ),
       canon_spec AS (
         SELECT status, recorded_at FROM latest WHERE is_canon = 1 AND channel = ?2
       ),
       canon_any AS (
         SELECT status, recorded_at FROM latest WHERE is_canon = 1 AND channel = 'any'
       ),
       spec_withdrawn AS (
         SELECT 1 AS blocked FROM canon_spec WHERE status = 'withdrawn'
         UNION ALL
         SELECT 1 AS blocked FROM latest l
         WHERE l.is_canon = 0 AND l.channel = ?2 AND l.status = 'withdrawn'
           AND COALESCE((SELECT recorded_at FROM canon_spec), -1) <= MAX(l.eff_at, l.recorded_at)
       ),
       any_blocking_ts AS (
         SELECT MAX(block_ts) AS ts FROM (
           SELECT recorded_at AS block_ts FROM canon_any WHERE status = 'withdrawn'
           UNION ALL
           SELECT MAX(l.eff_at, l.recorded_at) AS block_ts FROM latest l
           WHERE l.is_canon = 0 AND l.channel = 'any' AND l.status = 'withdrawn'
             AND COALESCE((SELECT recorded_at FROM canon_any), -1) <= MAX(l.eff_at, l.recorded_at)
         )
       ),
       any_withdrawn AS (
         SELECT 1 AS blocked FROM any_blocking_ts abt
         WHERE abt.ts IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM canon_spec cs WHERE cs.status = 'granted' AND cs.recorded_at > abt.ts
           )
       )
       SELECT CASE
         WHEN NOT EXISTS (SELECT 1 FROM spec_withdrawn) AND NOT EXISTS (SELECT 1 FROM any_withdrawn)
         THEN 1 ELSE json_extract('{', '$')
       END`,
    )
    .bind(personId, channel, scope);
}

function activeEndpointFence(db: D1Database, endpointId: string, personId: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM crm_endpoints WHERE id = ? AND person_id = ? AND retired_at IS NULL
       ) THEN 1 ELSE json_extract('{', '$') END`,
    )
    .bind(endpointId, personId);
}

function windowOrApprovedTemplateFence(
  db: D1Database,
  convId: string,
  channel: string,
  templateId: string | null,
  allowHumanAgentTag: boolean,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT CASE WHEN (
         EXISTS (
           SELECT 1 FROM crm_conversations
           WHERE id = ? AND window_expires_at IS NOT NULL AND window_expires_at > ?
         )
         OR (
           ? = 1 AND EXISTS (
             SELECT 1 FROM crm_conversations
             WHERE id = ? AND channel IN ('instagram', 'facebook')
               AND human_agent_window_expires_at IS NOT NULL AND human_agent_window_expires_at > ?
           )
         )
         OR (
           ? IS NOT NULL AND EXISTS (
             SELECT 1 FROM crm_templates WHERE id = ? AND channel = ? AND status = 'approved'
           )
         )
       ) THEN 1 ELSE json_extract('{', '$') END`,
    )
    .bind(convId, now, allowHumanAgentTag ? 1 : 0, convId, now, templateId, templateId, channel);
}

function changesOneFence(db: D1Database): D1PreparedStatement {
  return db.prepare(`SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('{', '$') END`);
}

async function assertConversationTargetsReadable(
  env: Env,
  actorId: string,
  conv: { person_id: string | null; organisation_id?: string | null; application_id?: string | null },
  gate: ReadGate = createReadGate(env.DB, actorId),
): Promise<boolean> {
  const ids = [conv.person_id, conv.organisation_id, conv.application_id].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
  if (ids.length === 0) return true;
  const readable = await loadReadableTaskRecords(env, gate, ids);
  return ids.every((id) => readable.has(id));
}

function mapConvRow(
  r: ConvRow,
  extras?: { personName?: string | null; assigneeName?: string | null; humanAgentApproved?: boolean; now?: number },
): CrmConversationDto {
  const now = extras?.now ?? Date.now();
  const win = evaluateChannelWindow({
    channel: r.channel,
    windowExpiresAt: r.window_expires_at,
    humanAgentWindowExpiresAt: r.human_agent_window_expires_at ?? null,
    humanAgentApproved: extras?.humanAgentApproved ?? false,
    via: 'ui',
    now,
  });
  return {
    id: r.id,
    channel: r.channel,
    channelAccountId: r.channel_account_id ?? null,
    externalThreadId: r.external_thread_id,
    personId: r.person_id,
    personName: extras?.personName ?? null,
    programmeSlug: r.programme_slug,
    applicationId: r.application_id,
    subject: r.subject,
    state: r.state,
    assigneeId: r.assignee_id,
    assigneeName: extras?.assigneeName ?? null,
    windowExpiresAt: r.window_expires_at,
    windowOpen: win.open,
    humanAgentWindowExpiresAt: r.human_agent_window_expires_at ?? null,
    humanAgentEligible: win.humanAgentEligible,
    requiresTemplate: win.requiresTemplate,
    lastMessageAt: r.last_message_at,
    lastInboundAt: r.last_inbound_at,
    lastOutboundAt: r.last_outbound_at,
    unreadCount: r.unread_count,
    rev: r.rev,
    createdAt: r.created_at,
  };
}

function mapMsgRow(r: MsgRow): CrmMessageDto {
  let aiMetadata: CrmMessageDto['aiMetadata'] = null;
  if (r.ai_metadata_json) {
    try {
      const p = JSON.parse(r.ai_metadata_json) as {
        citedFactIds?: string[];
        unconfirmedItems?: string[];
        staleFactWarnings?: string[];
      };
      aiMetadata = {
        citedFactIds: Array.isArray(p.citedFactIds) ? p.citedFactIds : [],
        unconfirmedItems: Array.isArray(p.unconfirmedItems) ? p.unconfirmedItems : [],
        staleFactWarnings: Array.isArray(p.staleFactWarnings) ? p.staleFactWarnings : [],
      };
    } catch {
      aiMetadata = null;
    }
  }
  return {
    id: r.id,
    conversationId: r.conversation_id,
    direction: r.direction,
    status: r.status,
    channel: r.channel,
    senderEndpoint: r.sender_endpoint,
    recipientEndpoint: r.recipient_endpoint,
    authorUserId: r.author_user_id,
    authorName: r.author_name ?? null,
    bodyText: r.body_text,
    rfcMessageId: r.rfc_message_id ?? null,
    inReplyTo: r.in_reply_to ?? null,
    templateId: r.template_id ?? null,
    messageTag: r.message_tag ?? null,
    aiMetadata,
    errorCode: r.error_code,
    errorDetail: r.error_detail,
    sentAt: r.sent_at,
    deliveredAt: r.delivered_at ?? null,
    readAt: r.read_at ?? null,
    createdAt: r.created_at,
  };
}

async function loadConsentAndEndpointsForPerson(
  db: D1Database,
  personId: string | null,
  channel: ConversationChannel,
  scope: CrmConsentDto['scope'] = 'transactional',
): Promise<{
  withdrawn: boolean;
  consentStatus: 'granted' | 'withdrawn' | 'unrecorded';
  primaryEndpointId: string | null;
  primaryEndpoint: string | null;
}> {
  if (!personId) {
    return { withdrawn: false, consentStatus: 'unrecorded', primaryEndpointId: null, primaryEndpoint: null };
  }
  const epKind = channel === 'call' || channel === 'in_person' ? 'phone' : channel;
  const aliases = await loadAliasesForSurvivor(db, personId);
  const consentIds = [personId, ...aliases.keys()];
  const [consRes, epRes] = await db.batch([
    latestConsentRowsPerTupleStmt(db, consentIds),
    db
      .prepare(
        `SELECT id, value_norm, is_primary FROM crm_endpoints
         WHERE person_id = ? AND kind = ? AND retired_at IS NULL
         ORDER BY is_primary DESC, created_at ASC LIMIT 5`,
      )
      .bind(personId, epKind),
  ]);

  const consDtos = (
    consRes.results as unknown as {
      id: string;
      person_id: string;
      channel: 'email' | 'whatsapp' | 'instagram' | 'facebook' | 'any';
      scope: 'transactional' | 'updates' | 'documentation' | 'publication';
      status: 'granted' | 'withdrawn';
      source: string;
      evidence_ref: string | null;
      recorded_by: string;
      recorded_at: number;
    }[]
  ).map((r) => ({
    id: r.id,
    personId: r.person_id,
    channel: r.channel,
    scope: r.scope,
    status: r.status,
    source: r.source,
    evidenceRef: r.evidence_ref,
    recordedBy: r.recorded_by,
    recordedAt: r.recorded_at,
  }));
  const evalChannel: 'email' | 'whatsapp' | 'instagram' | 'facebook' | 'any' =
    isDigitalSendChannel(channel) ? channel : 'any';
  const effective = evaluateEffectiveChannelConsent(personId, consDtos, aliases, evalChannel, scope);

  const eps = epRes.results as unknown as { id: string; value_norm: string; is_primary: number }[];
  return {
    withdrawn: effective.withdrawn,
    consentStatus: effective.status,
    primaryEndpointId: eps[0]?.id ?? null,
    primaryEndpoint: eps[0]?.value_norm ?? null,
  };
}

function logManualConversationCommand(): CommandDefinition<
  LogManualConversationInput,
  { conversation: CrmConversationDto; message: CrmMessageDto }
> {
  return {
    name: 'conversation.log_manual',
    projectionKeys: [CRM_PROJECTION.lastContactAt, CRM_PROJECTION.openConversations],
    authorizeCoarse: (actor) => canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = LogManualConversationInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input', detail: { reason: 'invalid_conversation_input' } };
      if (parsed.data.programmeSlug && !isRegisteredProgrammeSlug(parsed.data.programmeSlug)) {
        return { ok: false, error: 'invalid_input', detail: { reason: 'unknown_programme_slug' } };
      }
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      let readablePerson = null;
      if (input.personId) {
        readablePerson = await loadReadableTaskRecord(env, actor.id, input.personId);
        if (!readablePerson) return { kind: 'refuse', error: 'not_found' };
        const aliasState = await assertNotArchivedAlias(env.DB, readablePerson);
        if (aliasState.archived) {
          return {
            kind: 'refuse',
            error: 'invalid_input',
            detail: { reason: 'person_merged_or_archived', mergedInto: aliasState.mergedInto },
          };
        }
      }

      const convId = `conv_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const msgId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const lastIn = input.direction === 'inbound' ? now : null;
      const lastOut = input.direction === 'outbound' ? now : null;
      const msgStatus = input.direction === 'inbound' ? 'received' : 'sent';

      const convRow: ConvRow = {
        id: convId,
        channel: input.channel,
        channel_account_id: null,
        external_thread_id: null,
        person_id: readablePerson?.id ?? null,
        organisation_id: null,
        programme_slug: input.programmeSlug ?? null,
        application_id: null,
        subject: input.subject,
        state: 'open',
        assignee_id: actor.id,
        window_expires_at: isDigitalSendChannel(input.channel) && input.channel !== 'email' ? now + MESSAGING_WINDOW_MS : null,
        last_message_at: now,
        last_inbound_at: lastIn,
        last_outbound_at: lastOut,
        unread_count: input.direction === 'inbound' ? 1 : 0,
        rev: 1,
        created_at: now,
        updated_at: now,
      };
      const msgRow: MsgRow = {
        id: msgId,
        conversation_id: convId,
        direction: input.direction,
        status: msgStatus,
        channel: input.channel,
        sender_endpoint: null,
        recipient_endpoint: null,
        author_user_id: actor.id,
        body_text: input.bodyText,
        external_message_id: null,
        template_id: null,
        ai_metadata_json: null,
        error_code: null,
        error_detail: null,
        sent_at: input.direction === 'outbound' ? now : null,
        created_at: now,
      };

      const rows: D1PreparedStatement[] = [
        env.DB
          .prepare(
            `INSERT INTO crm_conversations
               (id, channel, channel_account_id, external_thread_id, person_id, organisation_id, programme_slug, application_id, subject, state, assignee_id, window_expires_at, last_message_at, last_inbound_at, last_outbound_at, unread_count, rev, created_at, updated_at)
             VALUES (?, ?, NULL, NULL, ?, NULL, ?, NULL, ?, 'open', ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .bind(
            convRow.id,
            convRow.channel,
            convRow.person_id,
            convRow.programme_slug,
            convRow.subject,
            convRow.assignee_id,
            convRow.window_expires_at,
            convRow.last_message_at,
            convRow.last_inbound_at,
            convRow.last_outbound_at,
            convRow.unread_count,
            now,
            now,
          ),
        env.DB
          .prepare(
            `INSERT INTO crm_messages
               (id, conversation_id, direction, status, channel, sender_endpoint, recipient_endpoint, author_user_id, body_text, body_html_sanitized, external_message_id, template_id, ai_metadata_json, error_code, error_detail, sent_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
          )
          .bind(msgRow.id, convRow.id, msgRow.direction, msgRow.status, msgRow.channel, actor.id, msgRow.body_text, msgRow.sent_at, now, now),
      ];

      let records: Mutation[] | undefined;
      let recordExpect: Map<string, number> | undefined;
      if (readablePerson) {
        const countRes = await env.DB
          .prepare(`SELECT COUNT(*) AS n FROM crm_conversations WHERE person_id = ? AND state = 'open'`)
          .bind(readablePerson.id)
          .first<{ n: number }>();
        records = [
          {
            id: readablePerson.id,
            collection: 'tasks',
            patch: {
              [CRM_PROJECTION.lastContactAt]: now,
              [CRM_PROJECTION.openConversations]: (countRes?.n ?? 0) + 1,
            },
            ts: now,
          },
        ];
        recordExpect = new Map([[readablePerson.id, readablePerson.seq]]);
      }

      return {
        kind: 'commit',
        result: {
          conversation: mapConvRow(convRow, { now }),
          message: mapMsgRow(msgRow),
        },
        fences: [
          () => crmActorFence(env.DB, actor, tokenHash),
          ...(readablePerson ? [() => notArchivedAliasFence(env.DB, readablePerson.id)] : []),
        ],
        rows,
        records,
        recordExpect,
      };
    },
    afterCommit: ({ env, executionCtx }) => {
      pokeLive(env, executionCtx);
    },
  };
}

function simulateInboundCommand(): CommandDefinition<
  SimulateInboundInput,
  { already: boolean; conversationId: string; messageId: string; personId: string | null }
> {
  return {
    name: 'conversation.simulate_inbound',
    projectionKeys: [CRM_PROJECTION.lastContactAt, CRM_PROJECTION.openConversations],
    authorizeCoarse: (actor) => canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = SimulateInboundInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input', detail: { reason: 'invalid_inbound_input' } };
      if (parsed.data.programmeSlug && !isRegisteredProgrammeSlug(parsed.data.programmeSlug)) {
        return { ok: false, error: 'invalid_input', detail: { reason: 'unknown_programme_slug' } };
      }
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      if (!isLocalTestSimulatedMode(env)) {
        return {
          kind: 'refuse',
          error: 'provider_unavailable',
          detail: { reason: 'simulated_local_test_only' },
        };
      }

      const existingEvent = await env.DB
        .prepare(
          `SELECT id, conversation_id, message_id FROM crm_inbound_events
           WHERE channel = ? AND external_event_id = ? LIMIT 1`,
        )
        .bind(input.channel, input.externalEventId)
        .first<{ id: string; conversation_id: string | null; message_id: string | null }>();
      if (existingEvent && existingEvent.conversation_id && existingEvent.message_id) {
        return {
          kind: 'commit',
          result: {
            already: true,
            conversationId: existingEvent.conversation_id,
            messageId: existingEvent.message_id,
            personId: null,
          },
          fences: [() => crmActorFence(env.DB, actor, tokenHash)],
        };
      }

      const norm = normalizeEndpoint(input.channel, input.fromValue) ?? input.fromValue.trim().toLowerCase();
      const epMatch = await env.DB
        .prepare(
          `SELECT person_id FROM crm_endpoints
           WHERE kind = ? AND value_norm = ? AND retired_at IS NULL LIMIT 1`,
        )
        .bind(input.channel, norm)
        .first<{ person_id: string }>();

      const resolvedMatchId = epMatch ? (await resolveCanonicalPersonId(env.DB, epMatch.person_id)).canonicalId : null;
      const matchedPerson = resolvedMatchId ? await loadReadableTaskRecord(env, actor.id, resolvedMatchId) : null;
      const personId = matchedPerson?.id ?? null;

      // Reuse existing thread if matching externalThreadId or open channel+person
      let targetConv: ConvRow | null = null;
      if (input.externalThreadId) {
        targetConv = await env.DB
          .prepare(`SELECT * FROM crm_conversations WHERE channel = ? AND external_thread_id = ? LIMIT 1`)
          .bind(input.channel, input.externalThreadId)
          .first<ConvRow>();
        if (targetConv && !(await assertConversationTargetsReadable(env, actor.id, targetConv))) {
          return { kind: 'refuse', error: 'not_found' };
        }
      }

      const convId = targetConv?.id ?? `conv_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const msgId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const evId = `in_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const payloadHash = await sha256Hex(JSON.stringify(input));
      const windowExpires = input.channel === 'email' ? null : now + MESSAGING_WINDOW_MS;
      const humanAgentExpires =
        input.channel === 'instagram' || input.channel === 'facebook' ? now + HUMAN_AGENT_WINDOW_MS : null;

      const rows: D1PreparedStatement[] = [];
      if (targetConv) {
        rows.push(
          env.DB
            .prepare(
              `UPDATE crm_conversations
               SET person_id = COALESCE(person_id, ?),
                   window_expires_at = COALESCE(?, window_expires_at),
                   human_agent_window_expires_at = COALESCE(?, human_agent_window_expires_at),
                   last_message_at = ?, last_inbound_at = ?, unread_count = unread_count + 1,
                   state = CASE WHEN state = 'closed' THEN 'open' ELSE state END,
                   rev = rev + 1, updated_at = ?
               WHERE id = ?`,
            )
            .bind(personId, windowExpires, humanAgentExpires, now, now, now, targetConv.id),
        );
      } else {
        rows.push(
          env.DB
            .prepare(
              `INSERT INTO crm_conversations
                 (id, channel, channel_account_id, external_thread_id, person_id, organisation_id, programme_slug, application_id, subject, state, assignee_id, window_expires_at, human_agent_window_expires_at, last_message_at, last_inbound_at, last_outbound_at, unread_count, rev, created_at, updated_at)
               VALUES (?, ?, NULL, ?, ?, NULL, ?, NULL, ?, 'open', NULL, ?, ?, ?, ?, NULL, 1, 1, ?, ?)`,
            )
            .bind(
              convId,
              input.channel,
              input.externalThreadId ?? null,
              personId,
              input.programmeSlug ?? null,
              input.subject?.trim() || `Inbound ${input.channel} from ${input.fromValue}`,
              windowExpires,
              humanAgentExpires,
              now,
              now,
              now,
              now,
            ),
        );
      }

      rows.push(
        env.DB
          .prepare(
            `INSERT INTO crm_messages
               (id, conversation_id, direction, status, channel, sender_endpoint, recipient_endpoint, author_user_id, body_text, body_html_sanitized, external_message_id, template_id, ai_metadata_json, error_code, error_detail, sent_at, created_at, updated_at)
             VALUES (?, ?, 'inbound', 'received', ?, ?, NULL, NULL, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
          )
          .bind(msgId, convId, input.channel, norm, input.bodyText, input.externalEventId, now, now),
        env.DB
          .prepare(
            `INSERT INTO crm_inbound_events (id, channel, channel_account_id, external_event_id, payload_hash, state, conversation_id, message_id, created_at)
             VALUES (?, ?, NULL, ?, ?, 'processed', ?, ?, ?)`,
          )
          .bind(evId, input.channel, input.externalEventId, payloadHash, convId, msgId, now),
      );

      let records: Mutation[] | undefined;
      let recordExpect: Map<string, number> | undefined;
      if (matchedPerson) {
        const countRes = await env.DB
          .prepare(`SELECT COUNT(*) AS n FROM crm_conversations WHERE person_id = ? AND state = 'open'`)
          .bind(matchedPerson.id)
          .first<{ n: number }>();
        records = [
          {
            id: matchedPerson.id,
            collection: 'tasks',
            patch: {
              [CRM_PROJECTION.lastContactAt]: now,
              [CRM_PROJECTION.openConversations]: targetConv ? (countRes?.n ?? 1) : (countRes?.n ?? 0) + 1,
            },
            ts: now,
          },
        ];
        recordExpect = new Map([[matchedPerson.id, matchedPerson.seq]]);
      }

      return {
        kind: 'commit',
        result: { already: false, conversationId: convId, messageId: msgId, personId },
        fences: [
          () => crmActorFence(env.DB, actor, tokenHash),
          ...(targetConv ? [convRevFence(env.DB, targetConv.id, targetConv.rev)] : []),
        ],
        rows,
        records,
        recordExpect,
      };
    },
    afterCommit: ({ env, executionCtx }) => {
      pokeLive(env, executionCtx);
    },
  };
}

function linkConversationPersonCommand(): CommandDefinition<
  LinkConversationPersonInput,
  { conversationId: string; personId: string }
> {
  return {
    name: 'conversation.link_person',
    projectionKeys: [CRM_PROJECTION.lastContactAt, CRM_PROJECTION.openConversations],
    authorizeCoarse: (actor) => canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = LinkConversationPersonInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const [conv, person] = await Promise.all([
        env.DB.prepare(`SELECT * FROM crm_conversations WHERE id = ?`).bind(input.conversationId).first<ConvRow>(),
        loadReadableTaskRecord(env, actor.id, input.personId),
      ]);
      if (!conv || !person) return { kind: 'refuse', error: 'not_found' };
      const aliasState = await assertNotArchivedAlias(env.DB, person);
      if (aliasState.archived) {
        return {
          kind: 'refuse',
          error: 'invalid_input',
          detail: { reason: 'person_merged_or_archived', mergedInto: aliasState.mergedInto },
        };
      }
      if (!(await assertConversationTargetsReadable(env, actor.id, conv))) {
        return { kind: 'refuse', error: 'not_found' };
      }
      if (input.expectedRev !== undefined && conv.rev !== input.expectedRev) {
        return { kind: 'refuse', error: 'stale' };
      }

      const countRes = await env.DB
        .prepare(`SELECT COUNT(*) AS n FROM crm_conversations WHERE person_id = ? AND state = 'open'`)
        .bind(person.id)
        .first<{ n: number }>();

      return {
        kind: 'commit',
        result: { conversationId: conv.id, personId: person.id },
        fences: [
          () => crmActorFence(env.DB, actor, tokenHash),
          convRevFence(env.DB, conv.id, conv.rev, { personId: conv.person_id }),
          () => notArchivedAliasFence(env.DB, person.id),
        ],
        rows: [
          env.DB
            .prepare(`UPDATE crm_conversations SET person_id = ?, rev = rev + 1, updated_at = ? WHERE id = ?`)
            .bind(person.id, now, conv.id),
        ],
        records: [
          {
            id: person.id,
            collection: 'tasks',
            patch: {
              [CRM_PROJECTION.lastContactAt]: conv.last_message_at,
              [CRM_PROJECTION.openConversations]: conv.person_id === person.id ? (countRes?.n ?? 0) : (countRes?.n ?? 0) + (conv.state === 'open' ? 1 : 0),
            },
            ts: now,
          },
        ],
        recordExpect: new Map([[person.id, person.seq]]),
      };
    },
    afterCommit: ({ env, executionCtx }) => {
      pokeLive(env, executionCtx);
    },
  };
}

function assignConversationCommand(): CommandDefinition<
  AssignConversationInput,
  { conversationId: string; assigneeId: string | null }
> {
  return {
    name: 'conversation.assign',
    authorizeCoarse: (actor) => canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = AssignConversationInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const conv = await env.DB.prepare(`SELECT * FROM crm_conversations WHERE id = ?`).bind(input.conversationId).first<ConvRow>();
      if (!conv) return { kind: 'refuse', error: 'not_found' };
      if (!(await assertConversationTargetsReadable(env, actor.id, conv))) {
        return { kind: 'refuse', error: 'not_found' };
      }
      if (input.expectedRev !== undefined && conv.rev !== input.expectedRev) return { kind: 'refuse', error: 'stale' };
      if (input.assigneeId) {
        const assignee = await env.DB.prepare(`SELECT id FROM users WHERE id = ? AND disabled_at IS NULL`).bind(input.assigneeId).first();
        if (!assignee) return { kind: 'refuse', error: 'invalid_input', detail: { reason: 'assignee_not_found' } };
      }
      return {
        kind: 'commit',
        result: { conversationId: conv.id, assigneeId: input.assigneeId },
        fences: [() => crmActorFence(env.DB, actor, tokenHash), convRevFence(env.DB, conv.id, conv.rev)],
        rows: [
          env.DB
            .prepare(`UPDATE crm_conversations SET assignee_id = ?, rev = rev + 1, updated_at = ? WHERE id = ?`)
            .bind(input.assigneeId, now, conv.id),
        ],
      };
    },
    afterCommit: ({ env, executionCtx }) => {
      pokeLive(env, executionCtx);
    },
  };
}

function setConversationStateCommand(): CommandDefinition<
  SetConversationStateInput,
  { conversationId: string; state: ConversationState }
> {
  return {
    name: 'conversation.set_state',
    projectionKeys: [CRM_PROJECTION.openConversations],
    authorizeCoarse: (actor) => canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = SetConversationStateInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const conv = await env.DB.prepare(`SELECT * FROM crm_conversations WHERE id = ?`).bind(input.conversationId).first<ConvRow>();
      if (!conv) return { kind: 'refuse', error: 'not_found' };
      if (!(await assertConversationTargetsReadable(env, actor.id, conv))) {
        return { kind: 'refuse', error: 'not_found' };
      }
      if (input.expectedRev !== undefined && conv.rev !== input.expectedRev) return { kind: 'refuse', error: 'stale' };

      let records: Mutation[] | undefined;
      let recordExpect: Map<string, number> | undefined;
      if (conv.person_id) {
        const person = await loadReadableTaskRecord(env, actor.id, conv.person_id);
        if (!person) return { kind: 'refuse', error: 'not_found' };
        const countRes = await env.DB
          .prepare(`SELECT COUNT(*) AS n FROM crm_conversations WHERE person_id = ? AND state = 'open' AND id != ?`)
          .bind(person.id, conv.id)
          .first<{ n: number }>();
        records = [
          {
            id: person.id,
            collection: 'tasks',
            patch: {
              [CRM_PROJECTION.openConversations]: (countRes?.n ?? 0) + (input.state === 'open' ? 1 : 0),
            },
            ts: now,
          },
        ];
        recordExpect = new Map([[person.id, person.seq]]);
      }

      return {
        kind: 'commit',
        result: { conversationId: conv.id, state: input.state },
        fences: [() => crmActorFence(env.DB, actor, tokenHash), convRevFence(env.DB, conv.id, conv.rev, { personId: conv.person_id })],
        rows: [
          env.DB
            .prepare(`UPDATE crm_conversations SET state = ?, unread_count = CASE WHEN ? = 'closed' THEN 0 ELSE unread_count END, rev = rev + 1, updated_at = ? WHERE id = ?`)
            .bind(input.state, input.state, now, conv.id),
        ],
        records,
        recordExpect,
      };
    },
    afterCommit: ({ env, executionCtx }) => {
      pokeLive(env, executionCtx);
    },
  };
}

function addMessageNoteCommand(): CommandDefinition<AddMessageNoteInput, { message: CrmMessageDto }> {
  return {
    name: 'message.add_note',
    authorizeCoarse: (actor) => canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = AddMessageNoteInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const conv = await env.DB.prepare(`SELECT * FROM crm_conversations WHERE id = ?`).bind(input.conversationId).first<ConvRow>();
      if (!conv) return { kind: 'refuse', error: 'not_found' };
      if (!(await assertConversationTargetsReadable(env, actor.id, conv))) {
        return { kind: 'refuse', error: 'not_found' };
      }

      const msgId = `note_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const msgRow: MsgRow = {
        id: msgId,
        conversation_id: conv.id,
        direction: 'note',
        status: 'note',
        channel: 'internal',
        sender_endpoint: null,
        recipient_endpoint: null,
        author_user_id: actor.id,
        body_text: input.bodyText,
        external_message_id: null,
        template_id: null,
        ai_metadata_json: null,
        error_code: null,
        error_detail: null,
        sent_at: null,
        created_at: now,
      };
      // Internal notes NEVER enter crm_outbox.
      return {
        kind: 'commit',
        result: { message: mapMsgRow(msgRow) },
        fences: [() => crmActorFence(env.DB, actor, tokenHash), convRevFence(env.DB, conv.id, conv.rev)],
        rows: [
          env.DB
            .prepare(
              `INSERT INTO crm_messages
                 (id, conversation_id, direction, status, channel, sender_endpoint, recipient_endpoint, author_user_id, body_text, body_html_sanitized, external_message_id, template_id, ai_metadata_json, error_code, error_detail, sent_at, created_at, updated_at)
               VALUES (?, ?, 'note', 'note', 'internal', NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
            )
            .bind(msgId, conv.id, actor.id, input.bodyText, now, now),
          env.DB
            .prepare(`UPDATE crm_conversations SET last_message_at = ?, rev = rev + 1, updated_at = ? WHERE id = ?`)
            .bind(now, now, conv.id),
        ],
      };
    },
    afterCommit: ({ env, executionCtx }) => {
      pokeLive(env, executionCtx);
    },
  };
}

function saveMessageDraftCommand(): CommandDefinition<SaveMessageDraftInput, { message: CrmMessageDto }> {
  return {
    name: 'message.save_draft',
    authorizeCoarse: (actor) => canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = SaveMessageDraftInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, expected, now }) => {
      const conv = await env.DB.prepare(`SELECT * FROM crm_conversations WHERE id = ?`).bind(input.conversationId).first<ConvRow>();
      if (!conv) return { kind: 'refuse', error: 'not_found' };
      if (!(await assertConversationTargetsReadable(env, actor.id, conv))) {
        return { kind: 'refuse', error: 'not_found' };
      }
      if (expected?.get(conv.id) !== undefined && expected.get(conv.id) !== conv.rev) {
        return { kind: 'refuse', error: 'stale' };
      }

      const aiMetaJson = input.aiMetadata ? JSON.stringify(input.aiMetadata) : null;

      if (input.messageId) {
        const existing = await env.DB
          .prepare(`SELECT * FROM crm_messages WHERE id = ? AND conversation_id = ?`)
          .bind(input.messageId, conv.id)
          .first<MsgRow>();
        if (!existing || existing.direction !== 'outbound') return { kind: 'refuse', error: 'not_found' };
        if (existing.status !== 'draft') {
          return { kind: 'refuse', error: 'stale', detail: { reason: 'message_not_draft', status: existing.status } };
        }
        if (expected?.get(existing.id) !== undefined && expected.get(existing.id) !== existing.updated_at) {
          return { kind: 'refuse', error: 'stale' };
        }
        const expectedMsgUpdatedAt = existing.updated_at ?? existing.created_at;
        const updated: MsgRow = {
          ...existing,
          body_text: input.bodyText,
          ai_metadata_json: aiMetaJson ?? existing.ai_metadata_json,
        };
        return {
          kind: 'commit',
          result: { message: mapMsgRow(updated) },
          fences: [
            () => crmActorFence(env.DB, actor, tokenHash),
            convRevFence(env.DB, conv.id, conv.rev, { personId: conv.person_id }),
            env.DB
              .prepare(
                `SELECT CASE WHEN EXISTS (
                   SELECT 1 FROM crm_messages
                   WHERE id = ? AND conversation_id = ? AND direction = 'outbound' AND status = 'draft' AND updated_at = ?
                 ) THEN 1 ELSE json_extract('{', '$') END`,
              )
              .bind(existing.id, conv.id, expectedMsgUpdatedAt),
          ],
          rows: [
            env.DB
              .prepare(
                `UPDATE crm_messages
                 SET body_text = ?, author_user_id = ?, ai_metadata_json = COALESCE(?, ai_metadata_json), updated_at = ?
                 WHERE id = ? AND conversation_id = ? AND direction = 'outbound' AND status = 'draft' AND updated_at = ?`,
              )
              .bind(input.bodyText, actor.id, aiMetaJson, now, existing.id, conv.id, expectedMsgUpdatedAt),
            changesOneFence(env.DB),
          ],
        };
      }

      const msgId = `draft_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const row: MsgRow = {
        id: msgId,
        conversation_id: conv.id,
        direction: 'outbound',
        status: 'draft',
        channel: conv.channel,
        sender_endpoint: null,
        recipient_endpoint: null,
        author_user_id: actor.id,
        body_text: input.bodyText,
        external_message_id: null,
        template_id: null,
        ai_metadata_json: aiMetaJson,
        error_code: null,
        error_detail: null,
        sent_at: null,
        created_at: now,
      };
      return {
        kind: 'commit',
        result: { message: mapMsgRow(row) },
        fences: [
          () => crmActorFence(env.DB, actor, tokenHash),
          convRevFence(env.DB, conv.id, conv.rev, { personId: conv.person_id }),
        ],
        rows: [
          env.DB
            .prepare(
              `INSERT INTO crm_messages
                 (id, conversation_id, direction, status, channel, sender_endpoint, recipient_endpoint, author_user_id, body_text, body_html_sanitized, external_message_id, template_id, ai_metadata_json, error_code, error_detail, sent_at, created_at, updated_at)
               VALUES (?, ?, 'outbound', 'draft', ?, NULL, NULL, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, NULL, ?, ?)`,
            )
            .bind(msgId, conv.id, conv.channel, actor.id, input.bodyText, aiMetaJson, now, now),
        ],
      };
    },
    afterCommit: ({ env, executionCtx }) => {
      pokeLive(env, executionCtx);
    },
  };
}

async function authorizeDigitalMessageReplay(
  actor: Parameters<NonNullable<CommandDefinition['authorizeReplay']>>[0],
  conversationId: string,
  env: Env,
  via: string,
): Promise<boolean> {
  if (via !== 'ui') return false;
  const conv = await env.DB
    .prepare(`SELECT id, channel, person_id, organisation_id, application_id FROM crm_conversations WHERE id = ?`)
    .bind(conversationId)
    .first<Pick<ConvRow, 'id' | 'channel' | 'person_id' | 'organisation_id' | 'application_id'>>();
  if (!conv || !isDigitalSendChannel(conv.channel)) return false;
  const sendCap = sendCapabilityForChannel(conv.channel);
  if (!evaluateCapability(actor, sendCap, '*')) return false;
  return assertConversationTargetsReadable(env, actor.id, conv);
}

async function classifyMessageFenceAbort(
  env: Env,
  convId: string,
  templateId: string | null,
  purpose: CrmConsentDto['scope'] = 'transactional',
  now = Date.now(),
) {
  const conv = await env.DB
    .prepare(`SELECT id, channel, channel_account_id, person_id, window_expires_at, human_agent_window_expires_at FROM crm_conversations WHERE id = ?`)
    .bind(convId)
    .first<Pick<ConvRow, 'id' | 'channel' | 'channel_account_id' | 'person_id' | 'window_expires_at' | 'human_agent_window_expires_at'>>();
  if (!conv) return { ok: false as const, error: 'not_found' as const, retryable: false };
  const { withdrawn, primaryEndpointId } = await loadConsentAndEndpointsForPerson(env.DB, conv.person_id, conv.channel, purpose);
  if (withdrawn) return { ok: false as const, error: 'consent_withdrawn' as const, retryable: false };
  if (conv.person_id && !primaryEndpointId) {
    return {
      ok: false as const,
      error: 'invalid_input' as const,
      detail: { reason: 'no_active_endpoint' },
      retryable: false,
    };
  }
  const account = isDigitalSendChannel(conv.channel)
    ? await resolveChannelAccountForSend(env.DB, conv.channel, conv.channel_account_id)
    : null;
  const cfg = parseChannelAccountConfig(account?.config_json);
  const win = evaluateChannelWindow({
    channel: conv.channel,
    windowExpiresAt: conv.window_expires_at,
    humanAgentWindowExpiresAt: conv.human_agent_window_expires_at ?? null,
    humanAgentApproved: Boolean(cfg.humanAgentApproved),
    via: 'ui',
    now,
  });
  if (!win.open) {
    if (!templateId) return { ok: false as const, error: 'window_closed' as const, retryable: false };
    const tpl = await env.DB
      .prepare(`SELECT id FROM crm_templates WHERE id = ? AND channel = ? AND status = 'approved'`)
      .bind(templateId, conv.channel)
      .first();
    if (!tpl) return { ok: false as const, error: 'window_closed' as const, retryable: false };
  }
  return null;
}

function sendMessageCommand(): CommandDefinition<
  SendMessageInput,
  { message: CrmMessageDto; receiptId: string }
> {
  return {
    name: 'message.send',
    projectionKeys: [CRM_PROJECTION.lastOutboundAt, CRM_PROJECTION.lastContactAt],
    // Human-only execution path (never MCP or automation).
    authorizeCoarse: (actor, via) => via === 'ui' && canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = SendMessageInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    authorizeReplay: async (actor, input, _stored, { env, via }) =>
      authorizeDigitalMessageReplay(actor, input.conversationId, env, via),
    classifyFenceError: async ({ env, input }) =>
      classifyMessageFenceAbort(env, input.conversationId, input.templateId ?? null, input.purpose ?? 'transactional'),
    plan: async ({ env, actor, tokenHash, input, expected, requestId, now }) => {
      const conv = await env.DB.prepare(`SELECT * FROM crm_conversations WHERE id = ?`).bind(input.conversationId).first<ConvRow>();
      if (!conv) return { kind: 'refuse', error: 'not_found' };
      if (!(await assertConversationTargetsReadable(env, actor.id, conv))) {
        return { kind: 'refuse', error: 'not_found' };
      }
      if (!isDigitalSendChannel(conv.channel)) {
        return { kind: 'refuse', error: 'invalid_input', detail: { reason: 'manual_channel_no_send' } };
      }
      if (conv.state === 'spam') {
        return { kind: 'refuse', error: 'invalid_input', detail: { reason: 'conversation_spam' } };
      }
      if (expected?.get(conv.id) !== undefined && expected.get(conv.id) !== conv.rev) {
        return { kind: 'refuse', error: 'stale' };
      }

      const sendCap = sendCapabilityForChannel(conv.channel);
      if (!evaluateCapability(actor, sendCap, '*')) {
        return { kind: 'refuse', error: 'forbidden' };
      }

      const purpose = input.purpose ?? 'transactional';
      let existingMsg: MsgRow | null = null;
      if (input.messageId) {
        existingMsg = await env.DB
          .prepare(`SELECT * FROM crm_messages WHERE id = ? AND conversation_id = ?`)
          .bind(input.messageId, conv.id)
          .first<MsgRow>();
        if (!existingMsg || existingMsg.direction !== 'outbound') {
          return { kind: 'refuse', error: 'not_found' };
        }
        if (existingMsg.status !== 'draft') {
          return {
            kind: 'refuse',
            error: 'stale',
            detail: { reason: 'message_already_sent', status: existingMsg.status },
          };
        }
        if (expected?.get(existingMsg.id) !== undefined && expected.get(existingMsg.id) !== existingMsg.updated_at) {
          return { kind: 'refuse', error: 'stale' };
        }
        const priorOutbox = await env.DB
          .prepare(`SELECT id FROM crm_outbox WHERE message_id = ? LIMIT 1`)
          .bind(existingMsg.id)
          .first();
        if (priorOutbox) {
          return { kind: 'refuse', error: 'stale', detail: { reason: 'message_already_queued' } };
        }
      }

      const { withdrawn, primaryEndpointId, primaryEndpoint } = await loadConsentAndEndpointsForPerson(
        env.DB,
        conv.person_id,
        conv.channel,
        purpose,
      );
      if (withdrawn) {
        return { kind: 'refuse', error: 'consent_withdrawn' };
      }
      if (conv.person_id && (!primaryEndpointId || !primaryEndpoint)) {
        return { kind: 'refuse', error: 'invalid_input', detail: { reason: 'no_active_endpoint' } };
      }

      const account = await resolveChannelAccountForSend(env.DB, conv.channel, conv.channel_account_id);
      const accountConfig = parseChannelAccountConfig(account?.config_json);
      if (!account && !isLocalTestSimulatedMode(env)) {
        return { kind: 'refuse', error: 'provider_unavailable', detail: { reason: 'channel_account_not_configured' } };
      }
      if (account && (account.mode === 'disabled' || account.active !== 1)) {
        return { kind: 'refuse', error: 'provider_unavailable', detail: { reason: 'channel_account_disabled' } };
      }
      if (account && account.mode === 'simulated' && !isLocalTestSimulatedMode(env)) {
        return { kind: 'refuse', error: 'provider_unavailable', detail: { reason: 'simulated_transport_requires_local_test' } };
      }

      const win = evaluateChannelWindow({
        channel: conv.channel,
        windowExpiresAt: conv.window_expires_at,
        humanAgentWindowExpiresAt: conv.human_agent_window_expires_at ?? null,
        humanAgentApproved: Boolean(accountConfig.humanAgentApproved),
        via: 'ui',
        now,
      });

      let approvedTpl: TemplateRow | null = null;
      if (input.templateId) {
        approvedTpl =
          (await env.DB
            .prepare(`SELECT * FROM crm_templates WHERE id = ? AND channel = ? AND status = 'approved'`)
            .bind(input.templateId, conv.channel)
            .first<TemplateRow>()) ?? null;
      }

      if (!win.open) {
        if (!approvedTpl) {
          return { kind: 'refuse', error: 'window_closed' };
        }
      }

      const messageTag: 'HUMAN_AGENT' | null =
        (win.requiresHumanAgentTag || (input.useHumanAgentTag && win.humanAgentEligible)) ? 'HUMAN_AGENT' : null;
      const inReplyTo = conv.channel === 'email' ? (conv.last_rfc_message_id ?? null) : null;
      const refsArr = conv.channel === 'email' && inReplyTo ? buildRfcReferences([], inReplyTo) : [];
      const refsJson = refsArr.length > 0 ? JSON.stringify(refsArr) : null;
      const tplParamsJson = input.templateParams?.length ? JSON.stringify(input.templateParams) : null;

      const msgId = existingMsg?.id ?? `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const outboxId = `ob_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

      let msgStatus: MsgRow['status'] = 'queued';
      let outboxStatus: 'queued' | 'sent' | 'failed' | 'review_required' = 'queued';
      let receiptId = 'queued';
      let rfcMessageId: string | null = null;
      let errCode: string | null = null;
      let errDetail: string | null = null;
      let nextAttemptAt: number | null = now;
      let attempts = 0;

      if (input.deliveryMode !== 'queued') {
        const delivery = await dispatchAdapterSend(env, {
          account,
          config: accountConfig,
          channel: conv.channel,
          messageId: msgId,
          conversationId: conv.id,
          subject: conv.subject,
          recipientEndpoint: primaryEndpoint ?? conv.external_thread_id ?? 'unmatched@local.invalid',
          bodyText: input.bodyText,
          idempotencyKey: requestId,
          inReplyTo,
          references: refsArr,
          template: approvedTpl
            ? {
                id: approvedTpl.id,
                name: approvedTpl.name,
                language: approvedTpl.language,
                providerTemplateId: approvedTpl.provider_template_id,
                params: input.templateParams ?? [],
              }
            : null,
          messageTag,
          now,
        });

        attempts = 1;
        if ('unknown' in delivery) {
          msgStatus = 'review_required';
          outboxStatus = 'review_required';
          receiptId = 'review_required';
          errCode = 'unknown';
          errDetail = delivery.detail;
          nextAttemptAt = null;
        } else if (delivery.ok) {
          msgStatus = 'sent';
          outboxStatus = 'sent';
          receiptId = delivery.externalId;
          rfcMessageId = delivery.rfcMessageId ?? null;
          nextAttemptAt = null;
        } else if (isRetryableAdapterError(delivery.errorClass)) {
          msgStatus = 'queued';
          outboxStatus = 'queued';
          receiptId = 'queued';
          errCode = delivery.errorClass;
          errDetail = delivery.detail;
          nextAttemptAt = now + computeOutboxBackoffMs(1);
        } else if (delivery.errorClass === 'auth') {
          return { kind: 'refuse', error: 'provider_unavailable', detail: { reason: delivery.detail } };
        } else {
          msgStatus = 'failed';
          outboxStatus = 'failed';
          receiptId = 'failed';
          errCode = delivery.errorClass;
          errDetail = delivery.detail;
          nextAttemptAt = null;
        }
      }

      const msgRow: MsgRow = {
        id: msgId,
        conversation_id: conv.id,
        direction: 'outbound',
        status: msgStatus,
        channel: conv.channel,
        sender_endpoint: account?.external_id ?? null,
        recipient_endpoint: primaryEndpoint,
        author_user_id: actor.id,
        body_text: input.bodyText,
        external_message_id: msgStatus === 'sent' ? receiptId : null,
        rfc_message_id: rfcMessageId,
        in_reply_to: inReplyTo,
        references_json: refsJson,
        template_id: approvedTpl?.id ?? input.templateId ?? null,
        template_params_json: tplParamsJson,
        message_tag: messageTag,
        ai_metadata_json: existingMsg?.ai_metadata_json ?? null,
        error_code: errCode,
        error_detail: errDetail,
        sent_at: msgStatus === 'sent' ? now : null,
        created_at: existingMsg?.created_at ?? now,
      };

      const expectedMsgUpdatedAt = existingMsg ? (existingMsg.updated_at ?? existingMsg.created_at) : null;
      const rows: D1PreparedStatement[] = [];
      if (existingMsg && expectedMsgUpdatedAt !== null) {
        rows.push(
          env.DB
            .prepare(
              `UPDATE crm_messages
               SET status = ?, body_text = ?, sender_endpoint = ?, recipient_endpoint = ?, author_user_id = ?,
                   external_message_id = ?, rfc_message_id = ?, in_reply_to = ?, references_json = ?,
                   template_id = ?, template_params_json = ?, message_tag = ?,
                   sent_at = ?, updated_at = ?, error_code = ?, error_detail = ?
               WHERE id = ? AND conversation_id = ? AND direction = 'outbound' AND status = 'draft' AND updated_at = ?`,
            )
            .bind(
              msgRow.status,
              input.bodyText,
              msgRow.sender_endpoint,
              primaryEndpoint,
              actor.id,
              msgRow.external_message_id,
              rfcMessageId,
              inReplyTo,
              refsJson,
              msgRow.template_id,
              tplParamsJson,
              messageTag,
              msgRow.sent_at,
              now,
              errCode,
              errDetail,
              msgId,
              conv.id,
              expectedMsgUpdatedAt,
            ),
          changesOneFence(env.DB),
        );
      } else {
        rows.push(
          env.DB
            .prepare(
              `INSERT INTO crm_messages
                 (id, conversation_id, direction, status, channel, sender_endpoint, recipient_endpoint, author_user_id, body_text, body_html_sanitized, external_message_id, rfc_message_id, in_reply_to, references_json, template_id, template_params_json, message_tag, ai_metadata_json, error_code, error_detail, sent_at, delivered_at, read_at, created_at, updated_at)
               VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?)`,
            )
            .bind(
              msgId,
              conv.id,
              msgRow.status,
              conv.channel,
              msgRow.sender_endpoint,
              primaryEndpoint,
              actor.id,
              input.bodyText,
              msgRow.external_message_id,
              rfcMessageId,
              inReplyTo,
              refsJson,
              msgRow.template_id,
              tplParamsJson,
              messageTag,
              errCode,
              errDetail,
              msgRow.sent_at,
              now,
              now,
            ),
        );
      }
      rows.push(
        env.DB
          .prepare(
            `INSERT INTO crm_outbox
               (id, message_id, conversation_id, channel_account_id, actor_id, request_id, status, purpose, attempts, max_attempts, next_attempt_at, lease_until, last_error_class, last_error, provider_receipt, idempotency_key, resolution_note, resolved_by, resolved_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 3, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
          )
          .bind(
            outboxId,
            msgId,
            conv.id,
            account?.id ?? conv.channel_account_id ?? null,
            actor.id,
            requestId,
            outboxStatus,
            purpose,
            attempts,
            nextAttemptAt,
            errCode,
            errDetail,
            msgStatus === 'sent' ? receiptId : null,
            requestId,
            now,
            now,
          ),
        env.DB
          .prepare(
            `UPDATE crm_conversations
             SET last_outbound_at = CASE WHEN ? = 'sent' THEN ? ELSE last_outbound_at END,
                 last_message_at = ?,
                 last_rfc_message_id = COALESCE(?, last_rfc_message_id),
                 unread_count = 0, rev = rev + 1, updated_at = ?
             WHERE id = ? AND rev = ?`,
          )
          .bind(msgStatus, now, now, rfcMessageId, now, conv.id, conv.rev),
        changesOneFence(env.DB),
      );

      let records: Mutation[] | undefined;
      let recordExpect: Map<string, number> | undefined;
      if (conv.person_id) {
        const person = await loadReadableTaskRecord(env, actor.id, conv.person_id);
        if (!person) return { kind: 'refuse', error: 'not_found' };
        records = [
          {
            id: person.id,
            collection: 'tasks',
            patch: {
              ...(msgStatus === 'sent' ? { [CRM_PROJECTION.lastOutboundAt]: now } : {}),
              [CRM_PROJECTION.lastContactAt]: now,
            },
            ts: now,
          },
        ];
        recordExpect = new Map([[person.id, person.seq]]);
      }

      const fences = [
        () => crmActorFence(env.DB, actor, tokenHash, sendCap, '*'),
        convRevFence(env.DB, conv.id, conv.rev, {
          channel: conv.channel,
          personId: conv.person_id,
          disallowSpam: true,
        }),
        ...(conv.person_id ? [() => notArchivedAliasFence(env.DB, conv.person_id!)] : []),
        ...(conv.person_id ? [consentNotWithdrawnFence(env.DB, conv.person_id, conv.channel, purpose)] : []),
        ...(conv.person_id && primaryEndpointId
          ? [activeEndpointFence(env.DB, primaryEndpointId, conv.person_id)]
          : []),
        ...(conv.channel !== 'email'
          ? [
              windowOrApprovedTemplateFence(
                env.DB,
                conv.id,
                conv.channel,
                approvedTpl?.id ?? input.templateId ?? null,
                Boolean(accountConfig.humanAgentApproved),
                now,
              ),
            ]
          : []),
        ...(existingMsg && expectedMsgUpdatedAt !== null
          ? [
              env.DB
                .prepare(
                  `SELECT CASE WHEN EXISTS (
                     SELECT 1 FROM crm_messages
                     WHERE id = ? AND conversation_id = ? AND direction = 'outbound' AND status = 'draft' AND updated_at = ?
                   ) AND NOT EXISTS (
                     SELECT 1 FROM crm_outbox WHERE message_id = ?
                   ) THEN 1 ELSE json_extract('{', '$') END`,
                )
                .bind(existingMsg.id, conv.id, expectedMsgUpdatedAt, existingMsg.id),
            ]
          : []),
      ];

      return {
        kind: 'commit',
        result: { message: mapMsgRow(msgRow), receiptId },
        fences,
        rows,
        records,
        recordExpect,
      };
    },
    afterCommit: ({ env, executionCtx }) => {
      pokeLive(env, executionCtx);
    },
  };
}

function retryMessageCommand(): CommandDefinition<RetryMessageInput, { messageId: string; receiptId: string }> {
  return {
    name: 'message.retry',
    projectionKeys: [CRM_PROJECTION.lastOutboundAt, CRM_PROJECTION.lastContactAt],
    authorizeCoarse: (actor, via) => via === 'ui' && canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = RetryMessageInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    authorizeReplay: async (actor, input, _stored, { env, via }) => {
      if (via !== 'ui') return false;
      const msg = await env.DB
        .prepare(`SELECT conversation_id FROM crm_messages WHERE id = ?`)
        .bind(input.messageId)
        .first<{ conversation_id: string }>();
      if (!msg) return false;
      return authorizeDigitalMessageReplay(actor, msg.conversation_id, env, via);
    },
    classifyFenceError: async ({ env, input }) => {
      const msg = await env.DB
        .prepare(`SELECT conversation_id, template_id FROM crm_messages WHERE id = ?`)
        .bind(input.messageId)
        .first<{ conversation_id: string; template_id: string | null }>();
      if (!msg) return { ok: false as const, error: 'not_found' as const, retryable: false };
      return classifyMessageFenceAbort(env, msg.conversation_id, msg.template_id);
    },
    plan: async ({ env, actor, tokenHash, input, expected, requestId, now }) => {
      const msg = await env.DB
        .prepare(`SELECT * FROM crm_messages WHERE id = ? AND direction = 'outbound'`)
        .bind(input.messageId)
        .first<MsgRow>();
      if (!msg) return { kind: 'refuse', error: 'not_found' };
      if (msg.status !== 'failed' && msg.status !== 'draft') {
        return { kind: 'refuse', error: 'stale', detail: { reason: 'message_not_retryable', status: msg.status } };
      }
      if (expected?.get(msg.id) !== undefined && expected.get(msg.id) !== msg.updated_at) {
        return { kind: 'refuse', error: 'stale' };
      }

      const conv = await env.DB.prepare(`SELECT * FROM crm_conversations WHERE id = ?`).bind(msg.conversation_id).first<ConvRow>();
      if (!conv || !isDigitalSendChannel(conv.channel)) return { kind: 'refuse', error: 'not_found' };
      if (!(await assertConversationTargetsReadable(env, actor.id, conv))) {
        return { kind: 'refuse', error: 'not_found' };
      }
      if (expected?.get(conv.id) !== undefined && expected.get(conv.id) !== conv.rev) {
        return { kind: 'refuse', error: 'stale' };
      }

      const sendCap = sendCapabilityForChannel(conv.channel);
      if (!evaluateCapability(actor, sendCap, '*')) return { kind: 'refuse', error: 'forbidden' };

      const { withdrawn, primaryEndpointId, primaryEndpoint } = await loadConsentAndEndpointsForPerson(
        env.DB,
        conv.person_id,
        conv.channel,
      );
      if (withdrawn) return { kind: 'refuse', error: 'consent_withdrawn' };
      if (conv.person_id && (!primaryEndpointId || !primaryEndpoint)) {
        return { kind: 'refuse', error: 'invalid_input', detail: { reason: 'no_active_endpoint' } };
      }

      const account = await resolveChannelAccountForSend(env.DB, conv.channel, conv.channel_account_id);
      const accountConfig = parseChannelAccountConfig(account?.config_json);
      if (!account && !isLocalTestSimulatedMode(env)) {
        return { kind: 'refuse', error: 'provider_unavailable' };
      }
      if (account && (account.mode === 'disabled' || account.active !== 1)) {
        return { kind: 'refuse', error: 'provider_unavailable' };
      }

      const win = evaluateChannelWindow({
        channel: conv.channel,
        windowExpiresAt: conv.window_expires_at,
        humanAgentWindowExpiresAt: conv.human_agent_window_expires_at ?? null,
        humanAgentApproved: Boolean(accountConfig.humanAgentApproved),
        via: 'ui',
        now,
      });

      let approvedTpl: TemplateRow | null = null;
      if (msg.template_id) {
        approvedTpl =
          (await env.DB
            .prepare(`SELECT * FROM crm_templates WHERE id = ? AND channel = ? AND status = 'approved'`)
            .bind(msg.template_id, conv.channel)
            .first<TemplateRow>()) ?? null;
      }
      if (!win.open && !approvedTpl) {
        return { kind: 'refuse', error: 'window_closed' };
      }

      const delivery = await dispatchAdapterSend(env, {
        account,
        config: accountConfig,
        channel: conv.channel,
        messageId: msg.id,
        conversationId: conv.id,
        subject: conv.subject,
        recipientEndpoint: primaryEndpoint ?? msg.recipient_endpoint ?? 'unmatched@local.invalid',
        bodyText: msg.body_text,
        idempotencyKey: requestId,
        inReplyTo: msg.in_reply_to ?? conv.last_rfc_message_id ?? null,
        references: [],
        template: approvedTpl
          ? {
              id: approvedTpl.id,
              name: approvedTpl.name,
              language: approvedTpl.language,
              providerTemplateId: approvedTpl.provider_template_id,
              params: [],
            }
          : null,
        messageTag: msg.message_tag === 'HUMAN_AGENT' || win.requiresHumanAgentTag ? 'HUMAN_AGENT' : null,
        now,
      });

      let nextStatus: 'sent' | 'queued' | 'failed' | 'review_required' = 'sent';
      let receiptId = '';
      let rfcMessageId: string | null = null;
      let errCode: string | null = null;
      let errDetail: string | null = null;
      let nextAttemptAt: number | null = null;

      if ('unknown' in delivery) {
        nextStatus = 'review_required';
        receiptId = 'review_required';
        errCode = 'unknown';
        errDetail = delivery.detail;
      } else if (delivery.ok) {
        nextStatus = 'sent';
        receiptId = delivery.externalId;
        rfcMessageId = delivery.rfcMessageId ?? null;
      } else if (isRetryableAdapterError(delivery.errorClass)) {
        nextStatus = 'queued';
        receiptId = 'queued';
        errCode = delivery.errorClass;
        errDetail = delivery.detail;
        nextAttemptAt = now + computeOutboxBackoffMs(1);
      } else {
        return { kind: 'refuse', error: 'provider_unavailable', detail: { reason: delivery.detail } };
      }

      const expectedMsgUpdatedAt = msg.updated_at ?? msg.created_at;
      const outboxId = `ob_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

      let records: Mutation[] | undefined;
      let recordExpect: Map<string, number> | undefined;
      if (conv.person_id) {
        const person = await loadReadableTaskRecord(env, actor.id, conv.person_id);
        if (!person) return { kind: 'refuse', error: 'not_found' };
        records = [
          {
            id: person.id,
            collection: 'tasks',
            patch: {
              ...(nextStatus === 'sent' ? { [CRM_PROJECTION.lastOutboundAt]: now } : {}),
              [CRM_PROJECTION.lastContactAt]: now,
            },
            ts: now,
          },
        ];
        recordExpect = new Map([[person.id, person.seq]]);
      }

      return {
        kind: 'commit',
        result: { messageId: msg.id, receiptId },
        fences: [
          () => crmActorFence(env.DB, actor, tokenHash, sendCap, '*'),
          convRevFence(env.DB, conv.id, conv.rev, {
            channel: conv.channel,
            personId: conv.person_id,
            disallowSpam: true,
          }),
          ...(conv.person_id ? [() => notArchivedAliasFence(env.DB, conv.person_id!)] : []),
          ...(conv.person_id ? [consentNotWithdrawnFence(env.DB, conv.person_id, conv.channel)] : []),
          ...(conv.person_id && primaryEndpointId
            ? [activeEndpointFence(env.DB, primaryEndpointId, conv.person_id)]
            : []),
          ...(conv.channel !== 'email'
            ? [
                windowOrApprovedTemplateFence(
                  env.DB,
                  conv.id,
                  conv.channel,
                  approvedTpl?.id ?? msg.template_id,
                  Boolean(accountConfig.humanAgentApproved),
                  now,
                ),
              ]
            : []),
          env.DB
            .prepare(
              `SELECT CASE WHEN EXISTS (
                 SELECT 1 FROM crm_messages
                 WHERE id = ? AND conversation_id = ? AND direction = 'outbound'
                   AND status IN ('failed', 'draft') AND updated_at = ?
               ) AND NOT EXISTS (
                 SELECT 1 FROM crm_outbox WHERE message_id = ? AND status IN ('queued', 'sending', 'sent', 'review_required')
               ) THEN 1 ELSE json_extract('{', '$') END`,
            )
            .bind(msg.id, conv.id, expectedMsgUpdatedAt, msg.id),
        ],
        rows: [
          env.DB
            .prepare(
              `UPDATE crm_messages
               SET status = ?, recipient_endpoint = ?, external_message_id = ?, rfc_message_id = COALESCE(?, rfc_message_id),
                   sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END,
                   error_code = ?, error_detail = ?, updated_at = ?
               WHERE id = ? AND conversation_id = ? AND direction = 'outbound' AND status IN ('failed', 'draft') AND updated_at = ?`,
            )
            .bind(
              nextStatus,
              primaryEndpoint,
              nextStatus === 'sent' ? receiptId : null,
              rfcMessageId,
              nextStatus,
              now,
              errCode,
              errDetail,
              now,
              msg.id,
              conv.id,
              expectedMsgUpdatedAt,
            ),
          changesOneFence(env.DB),
          env.DB
            .prepare(
              `INSERT INTO crm_outbox
                 (id, message_id, conversation_id, channel_account_id, actor_id, request_id, status, purpose, attempts, max_attempts, next_attempt_at, lease_until, last_error_class, last_error, provider_receipt, idempotency_key, resolution_note, resolved_by, resolved_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'transactional', 1, 3, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
               ON CONFLICT(message_id) DO UPDATE SET
                 status = excluded.status, attempts = attempts + 1, actor_id = excluded.actor_id, request_id = excluded.request_id,
                 next_attempt_at = excluded.next_attempt_at, lease_until = NULL, last_error_class = excluded.last_error_class,
                 last_error = excluded.last_error, provider_receipt = COALESCE(excluded.provider_receipt, crm_outbox.provider_receipt),
                 updated_at = excluded.updated_at
               WHERE crm_outbox.status = 'failed'`,
            )
            .bind(
              outboxId,
              msg.id,
              conv.id,
              account?.id ?? conv.channel_account_id ?? null,
              actor.id,
              requestId,
              nextStatus,
              nextAttemptAt,
              errCode,
              errDetail,
              nextStatus === 'sent' ? receiptId : null,
              requestId,
              now,
              now,
            ),
          changesOneFence(env.DB),
          env.DB
            .prepare(
              `UPDATE crm_conversations
               SET last_outbound_at = CASE WHEN ? = 'sent' THEN ? ELSE last_outbound_at END,
                   last_message_at = ?, last_rfc_message_id = COALESCE(?, last_rfc_message_id),
                   rev = rev + 1, updated_at = ?
               WHERE id = ? AND rev = ?`,
            )
            .bind(nextStatus, now, now, rfcMessageId, now, conv.id, conv.rev),
          changesOneFence(env.DB),
        ],
        records,
        recordExpect,
      };
    },
    afterCommit: ({ env, executionCtx }) => {
      pokeLive(env, executionCtx);
    },
  };
}

function generateAiDraftCommand(): CommandDefinition<
  GenerateAiDraftInput,
  { message: CrmMessageDto; citedFactIds: string[]; unconfirmedItems: string[]; staleFactWarnings: string[] }
> {
  return {
    name: 'message.generate_ai_draft',
    authorizeCoarse: (actor) => canAccessCrmApi(actor),
    parseInput: (raw) => {
      const parsed = GenerateAiDraftInputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'invalid_input' };
      return { ok: true, input: parsed.data };
    },
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const conv = await env.DB.prepare(`SELECT * FROM crm_conversations WHERE id = ?`).bind(input.conversationId).first<ConvRow>();
      if (!conv) return { kind: 'refuse', error: 'not_found' };
      if (!(await assertConversationTargetsReadable(env, actor.id, conv))) {
        return { kind: 'refuse', error: 'not_found' };
      }

      const [factsRes, progRow, personRow] = await Promise.all([
        env.DB
          .prepare(
            `SELECT * FROM crm_facts
             WHERE status = 'verified' AND (?1 IS NULL OR programme_slug = ?1 OR programme_slug IS NULL)
             ORDER BY updated_at DESC LIMIT 80`,
          )
          .bind(conv.programme_slug)
          .all<FactRow>(),
        conv.programme_slug
          ? env.DB.prepare(`SELECT profile_json FROM crm_programme_profiles WHERE slug = ?`).bind(conv.programme_slug).first<{ profile_json: string }>()
          : Promise.resolve(null),
        conv.person_id ? loadReadableTaskRecord(env, actor.id, conv.person_id) : Promise.resolve(null),
      ]);

      const allVerified = factsRes.results.map((r) => mapFactRow(r, now));
      const verifiedFacts: CrmFactDto[] = allVerified.filter((f) => !f.isStale);
      const staleFacts: CrmFactDto[] = allVerified.filter((f) => f.isStale);
      const def = conv.programme_slug ? CRM_PROGRAMME_BY_SLUG.get(conv.programme_slug) : undefined;
      const parsedProfile = progRow
        ? ProgrammeProfileV1Schema.safeParse(JSON.parse(progRow.profile_json))
        : null;
      const profile = parsedProfile?.success ? parsedProfile.data : def?.defaultProfile ?? null;

      const composed = composeGroundedAiDraft({
        personName: personRow && typeof personRow.data.title === 'string' ? personRow.data.title : null,
        subject: conv.subject,
        verifiedFacts,
        staleFacts,
        programmeProfile: profile,
        prompt: input.prompt,
        now,
      });

      const msgId = `draft_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const aiMetaJson = JSON.stringify({
        citedFactIds: composed.citedFactIds,
        unconfirmedItems: composed.unconfirmedItems,
        staleFactWarnings: composed.staleFactWarnings,
      });
      const msgRow: MsgRow = {
        id: msgId,
        conversation_id: conv.id,
        direction: 'outbound',
        status: 'draft',
        channel: conv.channel,
        sender_endpoint: null,
        recipient_endpoint: null,
        author_user_id: actor.id,
        body_text: composed.bodyText,
        external_message_id: null,
        template_id: null,
        ai_metadata_json: aiMetaJson,
        error_code: null,
        error_detail: null,
        sent_at: null,
        created_at: now,
      };

      return {
        kind: 'commit',
        result: {
          message: mapMsgRow(msgRow),
          citedFactIds: composed.citedFactIds,
          unconfirmedItems: composed.unconfirmedItems,
          staleFactWarnings: composed.staleFactWarnings,
        },
        fences: [
          () => crmActorFence(env.DB, actor, tokenHash),
          convRevFence(env.DB, conv.id, conv.rev, { personId: conv.person_id }),
        ],
        rows: [
          env.DB
            .prepare(
              `INSERT INTO crm_messages
                 (id, conversation_id, direction, status, channel, sender_endpoint, recipient_endpoint, author_user_id, body_text, body_html_sanitized, external_message_id, template_id, ai_metadata_json, error_code, error_detail, sent_at, created_at, updated_at)
               VALUES (?, ?, 'outbound', 'draft', ?, NULL, NULL, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, NULL, ?, ?)`,
            )
            .bind(msgId, conv.id, conv.channel, actor.id, composed.bodyText, aiMetaJson, now, now),
        ],
      };
    },
    afterCommit: ({ env, executionCtx }) => {
      pokeLive(env, executionCtx);
    },
  };
}

export function createS4ConversationCommandDefs(): AnyCommandDefinition[] {
  return [
    logManualConversationCommand(),
    simulateInboundCommand(),
    linkConversationPersonCommand(),
    assignConversationCommand(),
    setConversationStateCommand(),
    addMessageNoteCommand(),
    saveMessageDraftCommand(),
    sendMessageCommand(),
    retryMessageCommand(),
    generateAiDraftCommand(),
  ];
}

const CONV_SCAN_LIMIT = 400;
const CONV_PAGE_LIMIT = 40;

export async function readConversations(
  env: Env,
  actorId: string,
  tokenHash: string,
  opts: { filter?: string | null; channel?: string | null; cursor?: string } = {},
): Promise<
  | { status: 200; body: ConversationsPageResponse }
  | { status: 400; body: { error: 'invalid_cursor' } }
  | { status: 401 | 403 | 404; body: { error: 'unauthenticated' | 'forbidden' | 'not_found' } }
> {
  const auth = await loadCrmReadContext(env, actorId, tokenHash);
  if (!auth.ok) return { status: auth.status, body: auth.body };

  let parsedCursor: { ts: number; id: string } | null = null;
  if (opts.cursor !== undefined) {
    parsedCursor = decodeTimeIdCursor(opts.cursor);
    if (!parsedCursor) return { status: 400, body: { error: 'invalid_cursor' } };
  }

  const batchNow = Date.now();
  const [sessionRes, grantsRes, convRes, usersRes] = await env.DB.batch([
    sessionAuthStmt(env.DB, actorId, tokenHash, batchNow),
    actorGrantsStmt(env.DB, actorId),
    env.DB
      .prepare(`SELECT * FROM crm_conversations ORDER BY last_message_at DESC, id DESC LIMIT ?`)
      .bind(CONV_SCAN_LIMIT + 1),
    env.DB.prepare(`SELECT id, name FROM users`),
  ]);

  const batchAuth = evaluateCrmReadAuthRows(
    sessionRes.results[0] as CrmSessionRow | undefined,
    grantsRes.results as unknown as CrmGrantRow[],
  );
  if (!batchAuth.ok) return { status: batchAuth.status, body: batchAuth.body };

  const rawConvs = convRes.results as unknown as ConvRow[];
  let partial = rawConvs.length > CONV_SCAN_LIMIT;
  const rows = rawConvs.slice(0, CONV_SCAN_LIMIT);
  const userNameById = new Map<string, string>(
    (usersRes.results as unknown as { id: string; name: string }[]).map((u) => [u.id, u.name]),
  );

  // Batch ReadGate check on all referenced linked records (person, organisation, application)
  const gate = createReadGate(env.DB, actorId);
  const linkedIds = [
    ...new Set(
      rows
        .flatMap((r) => [r.person_id, r.organisation_id, r.application_id])
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const readableLinked = await loadReadableTaskRecords(env, gate, linkedIds);

  const counts = { all: 0, unassigned: 0, mine: 0, unmatched: 0, snoozed: 0, closed: 0 };
  const visible: ConvRow[] = [];
  for (const r of rows) {
    const linkedOk =
      (!r.person_id || readableLinked.has(r.person_id)) &&
      (!r.organisation_id || readableLinked.has(r.organisation_id)) &&
      (!r.application_id || readableLinked.has(r.application_id));
    if (!linkedOk) {
      partial = true;
      continue;
    }
    visible.push(r);
    if (r.state !== 'spam') counts.all += 1;
    if (r.state === 'open' && !r.assignee_id) counts.unassigned += 1;
    if (r.state === 'open' && r.assignee_id === actorId) counts.mine += 1;
    if (r.state === 'open' && !r.person_id) counts.unmatched += 1;
    if (r.state === 'snoozed') counts.snoozed += 1;
    if (r.state === 'closed' || r.state === 'spam') counts.closed += 1;
  }

  const finalAuth = await finalizeCrmReadAuth(env, actorId, tokenHash, { gate });
  if (!finalAuth.ok) return { status: finalAuth.status, body: finalAuth.body };

  const filter: ConversationFilter =
    opts.filter === 'unassigned' || opts.filter === 'mine' || opts.filter === 'unmatched' || opts.filter === 'snoozed' || opts.filter === 'closed'
      ? opts.filter
      : 'all';

  const channelFiltered = visible.filter((r) => {
    if (opts.channel && r.channel !== opts.channel) return false;
    if (filter === 'unassigned') return r.state === 'open' && !r.assignee_id;
    if (filter === 'mine') return r.state === 'open' && r.assignee_id === actorId;
    if (filter === 'unmatched') return r.state === 'open' && !r.person_id;
    if (filter === 'snoozed') return r.state === 'snoozed';
    if (filter === 'closed') return r.state === 'closed' || r.state === 'spam';
    return r.state !== 'spam';
  });

  const afterCursor = parsedCursor
    ? channelFiltered.filter(
        (c) =>
          c.last_message_at < parsedCursor!.ts ||
          (c.last_message_at === parsedCursor!.ts && c.id < parsedCursor!.id),
      )
    : channelFiltered;

  const hasMore = afterCursor.length > CONV_PAGE_LIMIT;
  const pageRows = afterCursor.slice(0, CONV_PAGE_LIMIT);
  const last = pageRows[pageRows.length - 1];
  const next = hasMore && last ? encodeTimeIdCursor(last.last_message_at, last.id) : null;
  const now = Date.now();

  return {
    status: 200,
    body: {
      items: pageRows.map((r) => {
        const pRec = r.person_id ? readableLinked.get(r.person_id) : undefined;
        const pTitle =
          pRec && typeof pRec.data.title === 'string' && pRec.data.title.trim()
            ? pRec.data.title
            : pRec
              ? 'Untitled'
              : null;
        return mapConvRow(r, {
          personName: pTitle,
          assigneeName: r.assignee_id ? userNameById.get(r.assignee_id) ?? null : null,
          now,
        });
      }),
      next,
      counts,
      simulatedMode: isLocalTestSimulatedMode(env),
      partial,
    },
  };
}

export async function readConversationDetail(
  env: Env,
  actorId: string,
  tokenHash: string,
  conversationId: string,
): Promise<
  | { status: 200; body: ConversationDetailResponse }
  | { status: 401 | 403 | 404; body: { error: 'unauthenticated' | 'forbidden' | 'not_found' } }
> {
  if (!isCrmEnabled(env)) {
    return { status: 404, body: { error: 'not_found' } };
  }

  const batchNow = Date.now();
  const [sessionRes, grantsRes, convRes] = await env.DB.batch([
    sessionAuthStmt(env.DB, actorId, tokenHash, batchNow),
    actorGrantsStmt(env.DB, actorId),
    env.DB.prepare(`SELECT * FROM crm_conversations WHERE id = ?`).bind(conversationId),
  ]);

  const auth = evaluateCrmReadAuthRows(
    sessionRes.results[0] as CrmSessionRow | undefined,
    grantsRes.results as unknown as CrmGrantRow[],
  );
  if (!auth.ok) return { status: auth.status, body: auth.body };

  const conv = convRes.results[0] as unknown as ConvRow | undefined;
  if (!conv) return { status: 404, body: { error: 'not_found' } };

  const gate = createReadGate(env.DB, actorId);
  const linkedIds = [conv.person_id, conv.organisation_id, conv.application_id].filter(
    (id): id is string => Boolean(id),
  );
  const readableLinked = await loadReadableTaskRecords(env, gate, linkedIds);
  if (linkedIds.some((id) => !readableLinked.has(id))) {
    return { status: 404, body: { error: 'not_found' } };
  }

  const person = conv.person_id ? readableLinked.get(conv.person_id) : undefined;
  const personName = person
    ? typeof person.data.title === 'string' && person.data.title.trim()
      ? person.data.title
      : 'Untitled'
    : null;

  const now = Date.now();
  const [msgsRes, factsRes, epRes, consentInfo, assigneeRow, tplRes, channelAcc] = await Promise.all([
    env.DB
      .prepare(
        `SELECT m.*, u.name AS author_name
         FROM crm_messages m
         LEFT JOIN users u ON u.id = m.author_user_id
         WHERE m.conversation_id = ?
         ORDER BY m.created_at ASC, m.id ASC
         LIMIT 200`,
      )
      .bind(conv.id)
      .all<MsgRow>(),
    env.DB
      .prepare(
        `SELECT * FROM crm_facts
         WHERE status = 'verified' AND (?1 IS NULL OR programme_slug = ?1 OR programme_slug IS NULL)
         ORDER BY updated_at DESC LIMIT 80`,
      )
      .bind(conv.programme_slug)
      .all<FactRow>(),
    conv.person_id
      ? env.DB
          .prepare(`SELECT id, kind, value_norm, is_primary FROM crm_endpoints WHERE person_id = ? AND retired_at IS NULL ORDER BY is_primary DESC`)
          .bind(conv.person_id)
          .all<{ id: string; kind: string; value_norm: string; is_primary: number }>()
      : Promise.resolve({ results: [] as { id: string; kind: string; value_norm: string; is_primary: number }[] }),
    loadConsentAndEndpointsForPerson(env.DB, conv.person_id, conv.channel),
    conv.assignee_id
      ? env.DB.prepare(`SELECT name FROM users WHERE id = ?`).bind(conv.assignee_id).first<{ name: string }>()
      : Promise.resolve(null),
    isDigitalSendChannel(conv.channel)
      ? env.DB
          .prepare(`SELECT * FROM crm_templates WHERE channel = ? AND status = 'approved' ORDER BY name ASC LIMIT 50`)
          .bind(conv.channel)
          .all<TemplateRow>()
      : Promise.resolve({ results: [] as TemplateRow[] }),
    isDigitalSendChannel(conv.channel)
      ? resolveChannelAccountForSend(env.DB, conv.channel, conv.channel_account_id)
      : Promise.resolve(null),
  ]);

  const finalAuth = await finalizeCrmReadAuth(env, actorId, tokenHash, { gate, deniedStatus: 404 });
  if (!finalAuth.ok) return { status: finalAuth.status, body: finalAuth.body };

  const personEndpoints = epRes.results.map((e) => ({
    id: e.id,
    kind: e.kind,
    valueNorm: e.value_norm,
    isPrimary: e.is_primary === 1,
  }));

  const mappedFacts = factsRes.results.map((r) => mapFactRow(r, now));
  const verifiedFacts = mappedFacts.filter((f) => !f.isStale);
  const staleFacts = mappedFacts.filter((f) => f.isStale);
  const channelAccountCfg = parseChannelAccountConfig(channelAcc?.config_json);
  const channelAccountMode: ChannelAccountMode =
    channelAcc?.active === 1
      ? channelAcc.mode
      : isLocalTestSimulatedMode(env)
        ? 'simulated'
        : 'disabled';
  const transportReady =
    channelAccountMode === 'production' ||
    (channelAccountMode === 'simulated' && isLocalTestSimulatedMode(env));
  const canSend =
    isDigitalSendChannel(conv.channel) &&
    evaluateCapability(finalAuth.actor, sendCapabilityForChannel(conv.channel), '*') &&
    transportReady;

  return {
    status: 200,
    body: {
      conversation: mapConvRow(conv, {
        personName,
        assigneeName: assigneeRow?.name ?? null,
        humanAgentApproved: Boolean(channelAccountCfg.humanAgentApproved),
        now,
      }),
      messages: msgsRes.results.map(mapMsgRow),
      personEndpoints,
      consentStatus: consentInfo.consentStatus,
      verifiedFacts,
      staleFacts,
      approvedTemplates: tplRes.results.map(mapTemplateRow),
      channelAccountMode,
      canSend,
      simulatedMode: isLocalTestSimulatedMode(env),
    },
  };
}
