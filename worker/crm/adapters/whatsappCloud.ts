import {
  META_DEFAULT_GRAPH_VERSION,
  META_GRAPH_HOST,
  isOptOutMessageText,
} from '../../../shared/crm/channels';
import { normalizePhone } from '../../../shared/crm/identity';
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

interface WhatsAppSecretPayload {
  accessToken?: string;
  appSecret?: string;
  verifyToken?: string;
}

export function parseWhatsAppSecret(raw: string | null): WhatsAppSecretPayload | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as WhatsAppSecretPayload;
    return p && typeof p === 'object' ? p : null;
  } catch {
    return null;
  }
}

/**
 * Sends a WhatsApp message via Meta WhatsApp Cloud API (`whatsapp_cloud`) or simulated local-test transport.
 * - Enforces 24h customer service window vs pre-approved template payload shape.
 * - Exact host allowlist `graph.facebook.com` + `redirect: 'error'`.
 * - Network drops and HTTP 5xx return `{ unknown: true }` -> `review_required`.
 */
export async function sendViaWhatsAppCloud(
  env: Env,
  input: AdapterSendInput,
  fetchFn: typeof fetch = fetch,
): Promise<AdapterSendOutcome> {
  const { account, config } = input;
  const recipientNorm = normalizePhone(input.recipientEndpoint);
  if (!recipientNorm) {
    return { ok: false, errorClass: 'recipient_invalid', detail: 'invalid_whatsapp_e164_number' };
  }

  if (!account || account.mode === 'disabled' || account.active !== 1) {
    return { ok: false, errorClass: 'auth', detail: 'channel_account_disabled' };
  }

  if (account.mode === 'simulated') {
    if (!isLocalTestSimulatedMode(env)) {
      return { ok: false, errorClass: 'auth', detail: 'simulated_transport_requires_local_test' };
    }
    return evaluateSimulatedOutcome(config.simulatedBehavior, 'wamid.sim', input.messageId, input.now);
  }

  // Production WhatsApp Cloud API path (disabled until O-04 & credentials confirmed)
  if (!config.phoneNumberId) {
    return { ok: false, errorClass: 'auth', detail: 'whatsapp_phone_number_id_missing_O04' };
  }
  const secret = parseWhatsAppSecret(readSecretBinding(env, account.secret_name));
  if (!secret?.accessToken) {
    return { ok: false, errorClass: 'auth', detail: 'whatsapp_access_token_missing' };
  }

  const version = config.graphVersion ?? META_DEFAULT_GRAPH_VERSION;
  const endpoint = assertAllowedEgressUrl(
    `https://${META_GRAPH_HOST}/${encodeURIComponent(version)}/${encodeURIComponent(config.phoneNumberId)}/messages`,
    [META_GRAPH_HOST],
  );

  // Meta Cloud API expects digits-only international number (without leading '+')
  const waTo = recipientNorm.replace(/^\+/, '');
  const payload: Record<string, unknown> = input.template
    ? {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: waTo,
        type: 'template',
        template: {
          name: input.template.name,
          language: { code: input.template.language },
          ...(input.template.params.length > 0
            ? {
                components: [
                  {
                    type: 'body',
                    parameters: input.template.params.map((text) => ({ type: 'text', text })),
                  },
                ],
              }
            : {}),
        },
      }
    : {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: waTo,
        type: 'text',
        text: { preview_url: false, body: input.bodyText },
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
    return { unknown: true, detail: 'whatsapp_network_error_ambiguous_delivery' };
  }

  const json = (await res.json().catch(() => null)) as {
    messages?: { id?: string }[];
    error?: { code?: number; message?: string; error_subcode?: number };
  } | null;

  if (res.status === 401 || res.status === 403 || json?.error?.code === 190) {
    return { ok: false, errorClass: 'auth', detail: json?.error?.message ?? `whatsapp_auth_http_${res.status}` };
  }
  if (res.status === 429 || json?.error?.code === 130429 || json?.error?.code === 80007) {
    return { ok: false, errorClass: 'rate_limited', detail: json?.error?.message ?? 'whatsapp_rate_limited' };
  }
  if (json?.error?.code === 131047) {
    return { ok: false, errorClass: 'window_closed', detail: json.error.message ?? 'whatsapp_reengagement_window_closed' };
  }
  if (json?.error?.code === 131049) {
    return { ok: false, errorClass: 'blocked', detail: json.error.message ?? 'whatsapp_ecosystem_blocked' };
  }
  if (res.status === 400 || json?.error?.code === 131026 || json?.error?.code === 131030) {
    return { ok: false, errorClass: 'recipient_invalid', detail: json?.error?.message ?? `whatsapp_rejected_${res.status}` };
  }
  if (res.status >= 500) {
    return { unknown: true, detail: `whatsapp_server_http_${res.status}_ambiguous` };
  }
  if (!res.ok) {
    return { unknown: true, detail: `whatsapp_unexpected_http_${res.status}` };
  }

  const wamid = json?.messages?.[0]?.id;
  if (!wamid) {
    return { unknown: true, detail: 'whatsapp_ack_missing_wamid' };
  }
  return { ok: true, externalId: wamid };
}

/**
 * Parses official Meta WhatsApp Cloud API webhook payloads (`whatsapp_business_account`)
 * into normalized inbound message, status receipt (`sent|delivered|read|failed`), and opt-out events.
 */
export function parseWhatsAppWebhookPayload(body: unknown, now = Date.now()): AdapterInboundEvent[] {
  if (!body || typeof body !== 'object') return [];
  const root = body as {
    object?: string;
    entry?: Array<{
      changes?: Array<{
        field?: string;
        value?: {
          metadata?: { display_phone_number?: string; phone_number_id?: string };
          messages?: Array<{
            id?: string;
            from?: string;
            timestamp?: string;
            type?: string;
            text?: { body?: string };
            button?: { text?: string; payload?: string };
            interactive?: {
              button_reply?: { title?: string; id?: string };
              list_reply?: { title?: string; id?: string };
            };
          }>;
          statuses?: Array<{
            id?: string;
            status?: string;
            timestamp?: string;
            errors?: Array<{ code?: number; title?: string; message?: string }>;
          }>;
        };
      }>;
    }>;
  };

  if (root.object !== 'whatsapp_business_account' || !Array.isArray(root.entry)) {
    return [];
  }

  const events: AdapterInboundEvent[] = [];
  for (const entry of root.entry) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages' || !change.value) continue;
      const toEndpoint = change.value.metadata?.display_phone_number ?? change.value.metadata?.phone_number_id ?? null;

      for (const msg of change.value.messages ?? []) {
        if (!msg.id || !msg.from) continue;
        const rawFrom = msg.from.startsWith('+') ? msg.from : `+${msg.from}`;
        const fromNorm = normalizePhone(rawFrom) ?? rawFrom;
        const bodyText =
          msg.text?.body ??
          msg.button?.text ??
          msg.interactive?.button_reply?.title ??
          msg.interactive?.list_reply?.title ??
          `[${msg.type ?? 'message'}]`;
        const tsSec = Number(msg.timestamp);
        const receivedAt = Number.isFinite(tsSec) && tsSec > 0 ? tsSec * 1000 : now;
        events.push({
          kind: 'message',
          externalEventId: msg.id,
          channel: 'whatsapp',
          fromEndpoint: fromNorm,
          toEndpoint,
          externalThreadId: fromNorm,
          subject: `WhatsApp ${fromNorm}`,
          bodyText: bodyText.slice(0, 8000),
          receivedAt,
          isOptOut: isOptOutMessageText(bodyText),
          rawHashInput: msg,
        });
      }

      for (const st of change.value.statuses ?? []) {
        if (!st.id || !st.status) continue;
        if (st.status !== 'sent' && st.status !== 'delivered' && st.status !== 'read' && st.status !== 'failed') {
          continue;
        }
        const tsSec = Number(st.timestamp);
        const tsMs = Number.isFinite(tsSec) && tsSec > 0 ? tsSec * 1000 : now;
        const errDetail = st.errors?.[0]
          ? `${st.errors[0].code ?? ''}:${st.errors[0].title ?? st.errors[0].message ?? 'failed'}`
          : null;
        events.push({
          kind: 'status',
          externalEventId: `wa_status:${st.id}:${st.status}:${st.timestamp ?? tsMs}`,
          channel: 'whatsapp',
          externalMessageId: st.id,
          status: st.status,
          errorDetail: errDetail,
          timestamp: tsMs,
          rawHashInput: st,
        });
      }
    }
  }

  return events;
}
