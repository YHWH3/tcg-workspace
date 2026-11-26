import {
  META_DEFAULT_GRAPH_VERSION,
  META_GRAPH_HOST,
  isOptOutMessageText,
  normalizeMetaScopedId,
} from '../../../shared/crm/channels';
import type { Env } from '../../auth';
import { isLocalTestSimulatedMode } from './simulated';
import {
  assertAllowedEgressUrl,
  evaluateSimulatedOutcome,
  readSecretBinding,
  type AdapterInboundEvent,
  type AdapterSendInput,
  type AdapterSendOutcome,
} from './types';

interface MetaMessagingSecretPayload {
  accessToken?: string;
  appSecret?: string;
  verifyToken?: string;
}

export function parseMetaMessagingSecret(raw: string | null): MetaMessagingSecretPayload | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as MetaMessagingSecretPayload;
    return p && typeof p === 'object' ? p : null;
  } catch {
    return null;
  }
}

/**
 * Sends an Instagram DM or Facebook Messenger reply via Meta Graph API (`instagram_meta` / `facebook_meta`)
 * or simulated local-test transport.
 * - Uses provider-scoped IGSID (`igsid:...`) or PSID (`psid:...`) identities (never cross-channel).
 * - Uses `messaging_type: 'MESSAGE_TAG'` + `tag: 'HUMAN_AGENT'` ONLY when `input.messageTag === 'HUMAN_AGENT'`
 *   (strictly human-authored UI replies inside the 7-day window on approved accounts).
 * - Exact host allowlist `graph.facebook.com` + `redirect: 'error'`.
 */
export async function sendViaMetaMessaging(
  env: Env,
  input: AdapterSendInput,
  fetchFn: typeof fetch = fetch,
): Promise<AdapterSendOutcome> {
  const { account, config, channel } = input;
  if (channel !== 'instagram' && channel !== 'facebook') {
    return { ok: false, errorClass: 'recipient_invalid', detail: 'unsupported_meta_channel' };
  }

  const scopedId = normalizeMetaScopedId(channel, input.recipientEndpoint);
  if (!scopedId) {
    return { ok: false, errorClass: 'recipient_invalid', detail: `invalid_${channel}_scoped_id` };
  }
  const bareRecipientId = scopedId.replace(/^(igsid:|psid:)/i, '');

  if (!account || account.mode === 'disabled' || account.active !== 1) {
    return { ok: false, errorClass: 'auth', detail: 'channel_account_disabled' };
  }

  if (account.mode === 'simulated') {
    if (!isLocalTestSimulatedMode(env)) {
      return { ok: false, errorClass: 'auth', detail: 'simulated_transport_requires_local_test' };
    }
    return evaluateSimulatedOutcome(
      config.simulatedBehavior,
      channel === 'instagram' ? 'ig_sim' : 'fb_sim',
      input.messageId,
      input.now,
    );
  }

  // Production Meta Graph API path
  const targetNode = channel === 'instagram' ? (config.instagramAccountId ?? config.pageId) : config.pageId;
  if (!targetNode) {
    return { ok: false, errorClass: 'auth', detail: `${channel}_account_id_missing` };
  }
  const secret = parseMetaMessagingSecret(readSecretBinding(env, account.secret_name));
  if (!secret?.accessToken) {
    return { ok: false, errorClass: 'auth', detail: `${channel}_access_token_missing` };
  }

  const version = config.graphVersion ?? META_DEFAULT_GRAPH_VERSION;
  const endpoint = assertAllowedEgressUrl(
    `https://${META_GRAPH_HOST}/${encodeURIComponent(version)}/${encodeURIComponent(targetNode)}/messages`,
    [META_GRAPH_HOST],
  );

  const payload: Record<string, unknown> =
    input.messageTag === 'HUMAN_AGENT'
      ? {
          messaging_type: 'MESSAGE_TAG',
          tag: 'HUMAN_AGENT',
          recipient: { id: bareRecipientId },
          message: { text: input.bodyText },
        }
      : {
          messaging_type: 'RESPONSE',
          recipient: { id: bareRecipientId },
          message: { text: input.bodyText },
        };

  let res: Response;
  try {
    res = await fetchFn(endpoint.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      redirect: 'error',
    });
  } catch {
    return { unknown: true, detail: `${channel}_network_error_ambiguous_delivery` };
  }

  const json = (await res.json().catch(() => null)) as {
    message_id?: string;
    error?: { code?: number; error_subcode?: number; message?: string };
  } | null;

  if (res.status === 401 || res.status === 403 || json?.error?.code === 190) {
    return { ok: false, errorClass: 'auth', detail: json?.error?.message ?? `${channel}_auth_http_${res.status}` };
  }
  if (res.status === 429 || json?.error?.code === 4 || json?.error?.code === 613) {
    return { ok: false, errorClass: 'rate_limited', detail: json?.error?.message ?? `${channel}_rate_limited` };
  }
  if (json?.error?.code === 10 || json?.error?.error_subcode === 2018278) {
    return { ok: false, errorClass: 'window_closed', detail: json.error.message ?? `${channel}_window_closed` };
  }
  if (json?.error?.code === 551 || json?.error?.error_subcode === 2018001 || res.status === 400) {
    return { ok: false, errorClass: 'recipient_invalid', detail: json?.error?.message ?? `${channel}_rejected_${res.status}` };
  }
  if (res.status >= 500) {
    return { unknown: true, detail: `${channel}_server_http_${res.status}_ambiguous` };
  }
  if (!res.ok) {
    return { unknown: true, detail: `${channel}_unexpected_http_${res.status}` };
  }

  if (!json?.message_id) {
    return { unknown: true, detail: `${channel}_ack_missing_message_id` };
  }
  return { ok: true, externalId: json.message_id };
}

/**
 * Parses official Meta Instagram (`object === 'instagram'`) and Facebook Messenger (`object === 'page'`)
 * webhook payloads into normalized inbound messages (with `igsid:` / `psid:` identities),
 * delivery/read receipts, and opt-outs. Skips `is_echo: true` messages cleanly.
 */
export function parseMetaMessagingWebhookPayload(
  channel: 'instagram' | 'facebook',
  body: unknown,
  now = Date.now(),
): AdapterInboundEvent[] {
  if (!body || typeof body !== 'object') return [];
  const root = body as {
    object?: string;
    entry?: Array<{
      id?: string;
      messaging?: Array<{
        sender?: { id?: string };
        recipient?: { id?: string };
        timestamp?: number;
        message?: {
          mid?: string;
          text?: string;
          is_echo?: boolean;
          attachments?: Array<{ type?: string }>;
        };
        postback?: { mid?: string; title?: string; payload?: string };
        delivery?: { mids?: string[]; watermark?: number };
        read?: { mid?: string; watermark?: number };
        optout?: { ref?: string };
      }>;
    }>;
  };

  const expectedObject = channel === 'instagram' ? 'instagram' : 'page';
  if (root.object !== expectedObject || !Array.isArray(root.entry)) {
    return [];
  }

  const events: AdapterInboundEvent[] = [];
  for (const entry of root.entry) {
    const entryAccountId = entry.id?.trim() || null;
    for (const item of entry.messaging ?? []) {
      const ts = typeof item.timestamp === 'number' && item.timestamp > 0 ? item.timestamp : now;
      const receivingAccountId = item.recipient?.id?.trim() || entryAccountId;

      if (item.message) {
        if (item.message.is_echo === true) continue;
        const senderRaw = item.sender?.id;
        const mid = item.message.mid;
        if (!senderRaw || !mid) continue;
        const scopedSender = normalizeMetaScopedId(channel, senderRaw);
        if (!scopedSender) continue;
        const bodyText =
          item.message.text?.trim() ||
          (item.message.attachments?.length ? `[${item.message.attachments[0]?.type ?? 'attachment'}]` : '[message]');
        events.push({
          kind: 'message',
          externalEventId: mid,
          channel,
          receivingAccountId,
          fromEndpoint: scopedSender,
          toEndpoint: receivingAccountId,
          externalThreadId: scopedSender,
          subject: `${channel === 'instagram' ? 'Instagram DM' : 'Facebook Messenger'} ${scopedSender}`,
          bodyText: bodyText.slice(0, 8000),
          receivedAt: ts,
          isOptOut: isOptOutMessageText(bodyText),
          rawHashInput: item,
        });
        continue;
      }

      if (item.postback && item.sender?.id) {
        const scopedSender = normalizeMetaScopedId(channel, item.sender.id);
        if (!scopedSender) continue;
        const bodyText = item.postback.title?.trim() || item.postback.payload?.trim() || '[postback]';
        events.push({
          kind: 'message',
          externalEventId: item.postback.mid ?? `${channel}_pb_${item.sender.id}_${ts}`,
          channel,
          receivingAccountId,
          fromEndpoint: scopedSender,
          toEndpoint: receivingAccountId,
          externalThreadId: scopedSender,
          subject: `${channel === 'instagram' ? 'Instagram DM' : 'Facebook Messenger'} ${scopedSender}`,
          bodyText: bodyText.slice(0, 8000),
          receivedAt: ts,
          isOptOut: isOptOutMessageText(bodyText),
          rawHashInput: item,
        });
        continue;
      }

      if (item.delivery?.mids?.length) {
        for (const mid of item.delivery.mids) {
          events.push({
            kind: 'status',
            externalEventId: `${channel}_deliv:${mid}`,
            channel,
            receivingAccountId: entryAccountId ?? item.sender?.id?.trim() ?? item.recipient?.id?.trim() ?? null,
            externalMessageId: mid,
            status: 'delivered',
            timestamp: item.delivery.watermark ?? ts,
            rawHashInput: { mid, delivery: item.delivery },
          });
        }
        continue;
      }

      if (item.read?.mid) {
        events.push({
          kind: 'status',
          externalEventId: `${channel}_read:${item.read.mid}`,
          channel,
          receivingAccountId: entryAccountId ?? item.sender?.id?.trim() ?? item.recipient?.id?.trim() ?? null,
          externalMessageId: item.read.mid,
          status: 'read',
          timestamp: item.read.watermark ?? ts,
          rawHashInput: item.read,
        });
        continue;
      }

      if (item.optout && item.sender?.id) {
        const scopedSender = normalizeMetaScopedId(channel, item.sender.id);
        if (!scopedSender) continue;
        events.push({
          kind: 'opt_out',
          externalEventId: `${channel}_optout:${scopedSender}:${ts}`,
          channel,
          receivingAccountId,
          fromEndpoint: scopedSender,
          reason: item.optout.ref ?? 'meta_optout',
          timestamp: ts,
          rawHashInput: item,
        });
      }
    }
  }

  return events;
}
