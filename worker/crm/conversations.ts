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
  isChannelWindowOpen,
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
import { normalizeEndpoint } from '../../shared/crm/identity';
import {
  CRM_PROGRAMME_BY_SLUG,
  ProgrammeProfileV1Schema,
  isRegisteredProgrammeSlug,
} from '../../shared/crm/programmes';
import { CRM_PROJECTION } from '../../shared/crm/projection';
import type { Mutation } from '../../shared/types';
import type { Env } from '../auth';
import { sha256Hex } from '../password';
import { createReadGate } from '../readAccess';
import { pokeLive } from '../sync';
import { deliverViaSimulatedAdapter, isLocalTestSimulatedMode } from './adapters/simulated';
import type { AnyCommandDefinition, CommandDefinition } from './commands';
import { mapFactRow, type FactRow } from './facts';
import {
  crmActorFence,
  decodeTimeIdCursor,
  encodeTimeIdCursor,
  loadCrmReadContext,
  loadReadableTaskRecord,
} from './read';
import { canAccessCrmApi, evaluateCapability } from './rules';

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
  status: 'received' | 'draft' | 'queued' | 'sending' | 'sent' | 'delivered' | 'failed' | 'note';
  channel: string;
  sender_endpoint: string | null;
  recipient_endpoint: string | null;
  author_user_id: string | null;
  author_name?: string | null;
  body_text: string;
  external_message_id: string | null;
  template_id: string | null;
  ai_metadata_json: string | null;
  error_code: string | null;
  error_detail: string | null;
  sent_at: number | null;
  created_at: number;
}

function isDigitalSendChannel(ch: string): ch is CrmChannel {
  return (CRM_CHANNELS as readonly string[]).includes(ch);
}

function sendCapabilityForChannel(ch: CrmChannel): CrmCapability {
  return `crm.send:${ch}` as CrmCapability;
}

function convRevFence(db: D1Database, convId: string, expectedRev: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM crm_conversations WHERE id = ? AND rev = ?
       ) THEN 1 ELSE json_extract('{', '$') END`,
    )
    .bind(convId, expectedRev);
}

function mapConvRow(
  r: ConvRow,
  extras?: { personName?: string | null; assigneeName?: string | null; now?: number },
): CrmConversationDto {
  const now = extras?.now ?? Date.now();
  return {
    id: r.id,
    channel: r.channel,
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
    windowOpen: isChannelWindowOpen(r.channel, r.window_expires_at, now),
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
    aiMetadata,
    errorCode: r.error_code,
    errorDetail: r.error_detail,
    sentAt: r.sent_at,
    createdAt: r.created_at,
  };
}

async function loadConsentAndEndpointsForPerson(
  db: D1Database,
  personId: string | null,
  channel: ConversationChannel,
): Promise<{
  withdrawn: boolean;
  consentStatus: 'granted' | 'withdrawn' | 'unrecorded';
  primaryEndpoint: string | null;
}> {
  if (!personId) {
    return { withdrawn: false, consentStatus: 'unrecorded', primaryEndpoint: null };
  }
  const epKind = channel === 'call' || channel === 'in_person' ? 'phone' : channel;
  const [consRes, epRes] = await db.batch([
    db
      .prepare(
        `SELECT channel, scope, status, recorded_at, id
         FROM crm_consents
         WHERE person_id = ? AND channel IN (?, 'any')
         ORDER BY recorded_at DESC, id DESC
         LIMIT 20`,
      )
      .bind(personId, channel),
    db
      .prepare(
        `SELECT value_norm, is_primary FROM crm_endpoints
         WHERE person_id = ? AND kind = ? AND retired_at IS NULL
         ORDER BY is_primary DESC, created_at ASC LIMIT 5`,
      )
      .bind(personId, epKind),
  ]);

  const consRows = consRes.results as unknown as {
    channel: string;
    scope: string;
    status: 'granted' | 'withdrawn';
  }[];
  // Check exact channel transactional -> any transactional -> latest recorded
  const specificTrans = consRows.find((r) => r.channel === channel && r.scope === 'transactional');
  const anyTrans = consRows.find((r) => r.channel === 'any' && r.scope === 'transactional');
  const effective = specificTrans ?? anyTrans ?? consRows[0];

  const eps = epRes.results as unknown as { value_norm: string; is_primary: number }[];
  return {
    withdrawn: effective?.status === 'withdrawn',
    consentStatus: effective ? effective.status : 'unrecorded',
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
        fences: [() => crmActorFence(env.DB, actor, tokenHash)],
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

      const matchedPerson = epMatch ? await loadReadableTaskRecord(env, actor.id, epMatch.person_id) : null;
      const personId = matchedPerson?.id ?? null;

      // Reuse existing thread if matching externalThreadId or open channel+person
      let targetConv: ConvRow | null = null;
      if (input.externalThreadId) {
        targetConv = await env.DB
          .prepare(`SELECT * FROM crm_conversations WHERE channel = ? AND external_thread_id = ? LIMIT 1`)
          .bind(input.channel, input.externalThreadId)
          .first<ConvRow>();
      }

      const convId = targetConv?.id ?? `conv_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const msgId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const evId = `in_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const payloadHash = await sha256Hex(JSON.stringify(input));
      const windowExpires = input.channel === 'email' ? null : now + MESSAGING_WINDOW_MS;

      const rows: D1PreparedStatement[] = [];
      if (targetConv) {
        rows.push(
          env.DB
            .prepare(
              `UPDATE crm_conversations
               SET person_id = COALESCE(person_id, ?),
                   window_expires_at = COALESCE(?, window_expires_at),
                   last_message_at = ?, last_inbound_at = ?, unread_count = unread_count + 1,
                   state = CASE WHEN state = 'closed' THEN 'open' ELSE state END,
                   rev = rev + 1, updated_at = ?
               WHERE id = ?`,
            )
            .bind(personId, windowExpires, now, now, now, targetConv.id),
        );
      } else {
        rows.push(
          env.DB
            .prepare(
              `INSERT INTO crm_conversations
                 (id, channel, channel_account_id, external_thread_id, person_id, organisation_id, programme_slug, application_id, subject, state, assignee_id, window_expires_at, last_message_at, last_inbound_at, last_outbound_at, unread_count, rev, created_at, updated_at)
               VALUES (?, ?, NULL, ?, ?, NULL, ?, NULL, ?, 'open', NULL, ?, ?, ?, NULL, 1, 1, ?, ?)`,
            )
            .bind(
              convId,
              input.channel,
              input.externalThreadId ?? null,
              personId,
              input.programmeSlug ?? null,
              input.subject?.trim() || `Inbound ${input.channel} from ${input.fromValue}`,
              windowExpires,
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
          convRevFence(env.DB, conv.id, conv.rev),
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
      if (input.expectedRev !== undefined && conv.rev !== input.expectedRev) return { kind: 'refuse', error: 'stale' };

      let records: Mutation[] | undefined;
      let recordExpect: Map<string, number> | undefined;
      if (conv.person_id) {
        const person = await loadReadableTaskRecord(env, actor.id, conv.person_id);
        if (person) {
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
      }

      return {
        kind: 'commit',
        result: { conversationId: conv.id, state: input.state },
        fences: [() => crmActorFence(env.DB, actor, tokenHash), convRevFence(env.DB, conv.id, conv.rev)],
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
        fences: [() => crmActorFence(env.DB, actor, tokenHash)],
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
    plan: async ({ env, actor, tokenHash, input, now }) => {
      const conv = await env.DB.prepare(`SELECT * FROM crm_conversations WHERE id = ?`).bind(input.conversationId).first<ConvRow>();
      if (!conv) return { kind: 'refuse', error: 'not_found' };

      if (input.messageId) {
        const existing = await env.DB
          .prepare(`SELECT * FROM crm_messages WHERE id = ? AND conversation_id = ? AND status = 'draft'`)
          .bind(input.messageId, conv.id)
          .first<MsgRow>();
        if (!existing) return { kind: 'refuse', error: 'not_found' };
        const updated: MsgRow = { ...existing, body_text: input.bodyText };
        return {
          kind: 'commit',
          result: { message: mapMsgRow(updated) },
          fences: [() => crmActorFence(env.DB, actor, tokenHash)],
          rows: [
            env.DB
              .prepare(`UPDATE crm_messages SET body_text = ?, author_user_id = ?, updated_at = ? WHERE id = ?`)
              .bind(input.bodyText, actor.id, now, existing.id),
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
        ai_metadata_json: null,
        error_code: null,
        error_detail: null,
        sent_at: null,
        created_at: now,
      };
      return {
        kind: 'commit',
        result: { message: mapMsgRow(row) },
        fences: [() => crmActorFence(env.DB, actor, tokenHash)],
        rows: [
          env.DB
            .prepare(
              `INSERT INTO crm_messages
                 (id, conversation_id, direction, status, channel, sender_endpoint, recipient_endpoint, author_user_id, body_text, body_html_sanitized, external_message_id, template_id, ai_metadata_json, error_code, error_detail, sent_at, created_at, updated_at)
               VALUES (?, ?, 'outbound', 'draft', ?, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
            )
            .bind(msgId, conv.id, conv.channel, actor.id, input.bodyText, now, now),
        ],
      };
    },
    afterCommit: ({ env, executionCtx }) => {
      pokeLive(env, executionCtx);
    },
  };
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
    plan: async ({ env, actor, tokenHash, input, requestId, now }) => {
      const conv = await env.DB.prepare(`SELECT * FROM crm_conversations WHERE id = ?`).bind(input.conversationId).first<ConvRow>();
      if (!conv) return { kind: 'refuse', error: 'not_found' };
      if (!isDigitalSendChannel(conv.channel)) {
        return { kind: 'refuse', error: 'invalid_input', detail: { reason: 'manual_channel_no_send' } };
      }

      const sendCap = sendCapabilityForChannel(conv.channel);
      if (!evaluateCapability(actor, sendCap, '*')) {
        return { kind: 'refuse', error: 'forbidden' };
      }

      const { withdrawn, primaryEndpoint } = await loadConsentAndEndpointsForPerson(env.DB, conv.person_id, conv.channel);
      if (withdrawn) {
        return { kind: 'refuse', error: 'consent_withdrawn' };
      }

      if (!isChannelWindowOpen(conv.channel, conv.window_expires_at, now)) {
        if (!input.templateId) {
          return { kind: 'refuse', error: 'window_closed' };
        }
        const tpl = await env.DB
          .prepare(`SELECT id FROM crm_templates WHERE id = ? AND channel = ? AND status = 'approved'`)
          .bind(input.templateId, conv.channel)
          .first();
        if (!tpl) {
          return { kind: 'refuse', error: 'window_closed' };
        }
      }

      const msgId = input.messageId ?? `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const delivery = deliverViaSimulatedAdapter(env, {
        channel: conv.channel,
        messageId: msgId,
        recipientEndpoint: primaryEndpoint,
      }, now);
      if (!delivery.ok) {
        return { kind: 'refuse', error: 'provider_unavailable', detail: { reason: delivery.detail } };
      }

      const outboxId = `ob_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const msgRow: MsgRow = {
        id: msgId,
        conversation_id: conv.id,
        direction: 'outbound',
        status: 'sent',
        channel: conv.channel,
        sender_endpoint: null,
        recipient_endpoint: primaryEndpoint,
        author_user_id: actor.id,
        body_text: input.bodyText,
        external_message_id: delivery.receiptId,
        template_id: input.templateId ?? null,
        ai_metadata_json: null,
        error_code: null,
        error_detail: null,
        sent_at: now,
        created_at: now,
      };

      const rows: D1PreparedStatement[] = [
        input.messageId
          ? env.DB
              .prepare(
                `UPDATE crm_messages
                 SET status = 'sent', body_text = ?, recipient_endpoint = ?, author_user_id = ?,
                     external_message_id = ?, template_id = ?, sent_at = ?, updated_at = ?, error_code = NULL, error_detail = NULL
                 WHERE id = ? AND conversation_id = ? AND direction = 'outbound'`,
              )
              .bind(input.bodyText, primaryEndpoint, actor.id, delivery.receiptId, input.templateId ?? null, now, now, msgId, conv.id)
          : env.DB
              .prepare(
                `INSERT INTO crm_messages
                   (id, conversation_id, direction, status, channel, sender_endpoint, recipient_endpoint, author_user_id, body_text, body_html_sanitized, external_message_id, template_id, ai_metadata_json, error_code, error_detail, sent_at, created_at, updated_at)
                 VALUES (?, ?, 'outbound', 'sent', ?, NULL, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
              )
              .bind(msgId, conv.id, conv.channel, primaryEndpoint, actor.id, input.bodyText, delivery.receiptId, input.templateId ?? null, now, now, now),
        env.DB
          .prepare(
            `INSERT INTO crm_outbox
               (id, message_id, conversation_id, channel_account_id, actor_id, request_id, status, attempts, max_attempts, next_attempt_at, last_error, provider_receipt, created_at, updated_at)
             VALUES (?, ?, ?, NULL, ?, ?, 'sent', 1, 3, NULL, NULL, ?, ?, ?)
             ON CONFLICT(message_id) DO UPDATE SET
               status = 'sent', attempts = attempts + 1, provider_receipt = excluded.provider_receipt, last_error = NULL, updated_at = excluded.updated_at`,
          )
          .bind(outboxId, msgId, conv.id, actor.id, requestId, delivery.receiptId, now, now),
        env.DB
          .prepare(
            `UPDATE crm_conversations
             SET last_outbound_at = ?, last_message_at = ?, unread_count = 0, rev = rev + 1, updated_at = ?
             WHERE id = ?`,
          )
          .bind(now, now, now, conv.id),
      ];

      let records: Mutation[] | undefined;
      let recordExpect: Map<string, number> | undefined;
      if (conv.person_id) {
        const person = await loadReadableTaskRecord(env, actor.id, conv.person_id);
        if (person) {
          records = [
            {
              id: person.id,
              collection: 'tasks',
              patch: {
                [CRM_PROJECTION.lastOutboundAt]: now,
                [CRM_PROJECTION.lastContactAt]: now,
              },
              ts: now,
            },
          ];
          recordExpect = new Map([[person.id, person.seq]]);
        }
      }

      return {
        kind: 'commit',
        result: { message: mapMsgRow(msgRow), receiptId: delivery.receiptId },
        fences: [
          () => crmActorFence(env.DB, actor, tokenHash, sendCap, '*'),
          convRevFence(env.DB, conv.id, conv.rev),
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
    plan: async ({ env, actor, tokenHash, input, requestId, now }) => {
      const msg = await env.DB
        .prepare(`SELECT * FROM crm_messages WHERE id = ? AND direction = 'outbound' AND status IN ('failed', 'draft')`)
        .bind(input.messageId)
        .first<MsgRow>();
      if (!msg) return { kind: 'refuse', error: 'not_found' };
      const conv = await env.DB.prepare(`SELECT * FROM crm_conversations WHERE id = ?`).bind(msg.conversation_id).first<ConvRow>();
      if (!conv || !isDigitalSendChannel(conv.channel)) return { kind: 'refuse', error: 'not_found' };

      const sendCap = sendCapabilityForChannel(conv.channel);
      if (!evaluateCapability(actor, sendCap, '*')) return { kind: 'refuse', error: 'forbidden' };

      const { withdrawn, primaryEndpoint } = await loadConsentAndEndpointsForPerson(env.DB, conv.person_id, conv.channel);
      if (withdrawn) return { kind: 'refuse', error: 'consent_withdrawn' };
      if (!isChannelWindowOpen(conv.channel, conv.window_expires_at, now) && !msg.template_id) {
        return { kind: 'refuse', error: 'window_closed' };
      }

      const delivery = deliverViaSimulatedAdapter(env, {
        channel: conv.channel,
        messageId: msg.id,
        recipientEndpoint: primaryEndpoint,
      }, now);
      if (!delivery.ok) return { kind: 'refuse', error: 'provider_unavailable' };

      const outboxId = `ob_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      return {
        kind: 'commit',
        result: { messageId: msg.id, receiptId: delivery.receiptId },
        fences: [() => crmActorFence(env.DB, actor, tokenHash, sendCap, '*'), convRevFence(env.DB, conv.id, conv.rev)],
        rows: [
          env.DB
            .prepare(`UPDATE crm_messages SET status = 'sent', external_message_id = ?, sent_at = ?, error_code = NULL, error_detail = NULL, updated_at = ? WHERE id = ?`)
            .bind(delivery.receiptId, now, now, msg.id),
          env.DB
            .prepare(
              `INSERT INTO crm_outbox
                 (id, message_id, conversation_id, channel_account_id, actor_id, request_id, status, attempts, max_attempts, next_attempt_at, last_error, provider_receipt, created_at, updated_at)
               VALUES (?, ?, ?, NULL, ?, ?, 'sent', 1, 3, NULL, NULL, ?, ?, ?)
               ON CONFLICT(message_id) DO UPDATE SET
                 status = 'sent', attempts = attempts + 1, provider_receipt = excluded.provider_receipt, last_error = NULL, updated_at = excluded.updated_at`,
            )
            .bind(outboxId, msg.id, conv.id, actor.id, requestId, delivery.receiptId, now, now),
          env.DB
            .prepare(`UPDATE crm_conversations SET last_outbound_at = ?, last_message_at = ?, rev = rev + 1, updated_at = ? WHERE id = ?`)
            .bind(now, now, now, conv.id),
        ],
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
        fences: [() => crmActorFence(env.DB, actor, tokenHash)],
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

  const [convRes, usersRes] = await env.DB.batch([
    env.DB
      .prepare(`SELECT * FROM crm_conversations ORDER BY last_message_at DESC, id DESC LIMIT ?`)
      .bind(CONV_SCAN_LIMIT + 1),
    env.DB.prepare(`SELECT id, name FROM users`),
  ]);

  const rawConvs = convRes.results as unknown as ConvRow[];
  const partial = rawConvs.length > CONV_SCAN_LIMIT;
  const rows = rawConvs.slice(0, CONV_SCAN_LIMIT);
  const userNameById = new Map<string, string>(
    (usersRes.results as unknown as { id: string; name: string }[]).map((u) => [u.id, u.name]),
  );

  // Batch ReadGate check on referenced linked people
  const personIds = [...new Set(rows.map((r) => r.person_id).filter((id): id is string => Boolean(id)))];
  const personTitleById = new Map<string, string>();
  const deniedPersonIds = new Set<string>();
  if (personIds.length > 0) {
    const gate = createReadGate(env.DB, actorId);
    const { results: recRows } = await env.DB
      .prepare(`SELECT id, data, seq FROM records WHERE collection = 'tasks' AND id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(personIds))
      .all<{ id: string; data: string; seq: number }>();
    const kept = await gate.filter(recRows.map((r) => ({ id: r.id, rev: r.seq })));
    const allowed = new Set(kept.map((k) => k.id));
    for (const pid of personIds) {
      if (!allowed.has(pid)) deniedPersonIds.add(pid);
    }
    for (const r of recRows) {
      if (!allowed.has(r.id)) continue;
      try {
        const d = JSON.parse(r.data) as { title?: unknown };
        personTitleById.set(r.id, typeof d.title === 'string' && d.title.trim() ? d.title : 'Untitled');
      } catch {
        /* ignore */
      }
    }
  }

  const counts = { all: 0, unassigned: 0, mine: 0, unmatched: 0, snoozed: 0, closed: 0 };
  const visible: ConvRow[] = [];
  for (const r of rows) {
    if (r.person_id && deniedPersonIds.has(r.person_id)) continue;
    visible.push(r);
    if (r.state !== 'spam') counts.all += 1;
    if (r.state === 'open' && !r.assignee_id) counts.unassigned += 1;
    if (r.state === 'open' && r.assignee_id === actorId) counts.mine += 1;
    if (r.state === 'open' && !r.person_id) counts.unmatched += 1;
    if (r.state === 'snoozed') counts.snoozed += 1;
    if (r.state === 'closed' || r.state === 'spam') counts.closed += 1;
  }

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
      items: pageRows.map((r) =>
        mapConvRow(r, {
          personName: r.person_id ? personTitleById.get(r.person_id) ?? null : null,
          assigneeName: r.assignee_id ? userNameById.get(r.assignee_id) ?? null : null,
          now,
        }),
      ),
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
  const auth = await loadCrmReadContext(env, actorId, tokenHash);
  if (!auth.ok) return { status: auth.status, body: auth.body };

  const conv = await env.DB
    .prepare(`SELECT * FROM crm_conversations WHERE id = ?`)
    .bind(conversationId)
    .first<ConvRow>();
  if (!conv) return { status: 404, body: { error: 'not_found' } };

  let personName: string | null = null;
  let personEndpoints: { id: string; kind: string; valueNorm: string; isPrimary: boolean }[] = [];
  if (conv.person_id) {
    const person = await loadReadableTaskRecord(env, actorId, conv.person_id);
    if (!person) return { status: 404, body: { error: 'not_found' } };
    personName = typeof person.data.title === 'string' && person.data.title.trim() ? person.data.title : 'Untitled';
    const epRes = await env.DB
      .prepare(`SELECT id, kind, value_norm, is_primary FROM crm_endpoints WHERE person_id = ? AND retired_at IS NULL ORDER BY is_primary DESC`)
      .bind(person.id)
      .all<{ id: string; kind: string; value_norm: string; is_primary: number }>();
    personEndpoints = epRes.results.map((e) => ({
      id: e.id,
      kind: e.kind,
      valueNorm: e.value_norm,
      isPrimary: e.is_primary === 1,
    }));
  }

  const now = Date.now();
  const [msgsRes, factsRes, consentInfo, assigneeRow] = await Promise.all([
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
    loadConsentAndEndpointsForPerson(env.DB, conv.person_id, conv.channel),
    conv.assignee_id
      ? env.DB.prepare(`SELECT name FROM users WHERE id = ?`).bind(conv.assignee_id).first<{ name: string }>()
      : Promise.resolve(null),
  ]);

  const mappedFacts = factsRes.results.map((r) => mapFactRow(r, now));
  const verifiedFacts = mappedFacts.filter((f) => !f.isStale);
  const staleFacts = mappedFacts.filter((f) => f.isStale);
  const canSend =
    isDigitalSendChannel(conv.channel) &&
    evaluateCapability(auth.actor, sendCapabilityForChannel(conv.channel), '*') &&
    isLocalTestSimulatedMode(env);

  return {
    status: 200,
    body: {
      conversation: mapConvRow(conv, {
        personName,
        assigneeName: assigneeRow?.name ?? null,
        now,
      }),
      messages: msgsRes.results.map(mapMsgRow),
      personEndpoints,
      consentStatus: consentInfo.consentStatus,
      verifiedFacts,
      staleFacts,
      canSend,
      simulatedMode: isLocalTestSimulatedMode(env),
    },
  };
}
