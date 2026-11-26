import {
  ZOHO_ACCOUNTS_HOSTS,
  ZOHO_API_HOSTS,
  formatZohoPollCursor,
  normalizeRfcMessageId,
  parseRawRfcHeaders,
  parseRfcReferences,
  parseZohoPollCursor,
  type ZohoDataCenter,
} from '../../../shared/crm/channels';
import { normalizeEmail } from '../../../shared/crm/identity';
import type { Env } from '../../auth';
import { isLocalTestSimulatedMode } from './simulated';
import {
  assertAllowedEgressUrl,
  evaluateSimulatedOutcome,
  readSecretBinding,
  type AdapterInboundEvent,
  type AdapterPollOutcome,
  type AdapterSendInput,
  type AdapterSendOutcome,
  type ChannelAccountRow,
  parseChannelAccountConfig,
} from './types';

interface ZohoSecretPayload {
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
}

function parseZohoSecret(raw: string | null): ZohoSecretPayload | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as ZohoSecretPayload;
    return p && typeof p === 'object' ? p : null;
  } catch {
    return null;
  }
}

/**
 * Obtains a per-request Zoho OAuth access token (NEVER cached in module-level state).
 * Uses the exact regional `accounts.zoho.<dc>` allowlist and `redirect: 'error'`.
 */
async function resolveZohoAccessToken(
  dc: ZohoDataCenter,
  secret: ZohoSecretPayload,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: true; token: string } | { ok: false; detail: string }> {
  if (secret.accessToken && !secret.refreshToken) {
    return { ok: true, token: secret.accessToken };
  }
  if (!secret.refreshToken || !secret.clientId || !secret.clientSecret) {
    return { ok: false, detail: 'zoho_oauth_secret_incomplete' };
  }
  const accountsHost = ZOHO_ACCOUNTS_HOSTS[dc];
  const url = assertAllowedEgressUrl(`https://${accountsHost}/oauth/v2/token`, [accountsHost]);
  const params = new URLSearchParams({
    refresh_token: secret.refreshToken,
    client_id: secret.clientId,
    client_secret: secret.clientSecret,
    grant_type: 'refresh_token',
  });
  let res: Response;
  try {
    res = await fetchFn(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      redirect: 'error',
    });
  } catch {
    return { ok: false, detail: 'zoho_oauth_network_error' };
  }
  if (!res.ok) {
    return { ok: false, detail: `zoho_oauth_http_${res.status}` };
  }
  const json = (await res.json().catch(() => null)) as { access_token?: string } | null;
  if (!json?.access_token) {
    return { ok: false, detail: 'zoho_oauth_missing_access_token' };
  }
  return { ok: true, token: json.access_token };
}

/**
 * Sends an email via Zoho Mail REST API (`email_zoho`) or simulated local-test transport.
 * - Production calls are strictly disabled unless `account.mode === 'production' && account.active === 1`.
 * - No open/click tracking (P-16).
 * - Ambiguous transport failures (timeout, HTTP 5xx, malformed ack) return `{ unknown: true }`
 *   so the outbox moves the message to `review_required` instead of blind resending.
 */
export async function sendViaZohoMail(
  env: Env,
  input: AdapterSendInput,
  fetchFn: typeof fetch = fetch,
): Promise<AdapterSendOutcome> {
  const { account, config } = input;
  const recipientNorm = normalizeEmail(input.recipientEndpoint);
  if (!recipientNorm) {
    return { ok: false, errorClass: 'recipient_invalid', detail: 'invalid_email_recipient' };
  }

  if (!account || account.mode === 'disabled' || account.active !== 1) {
    return { ok: false, errorClass: 'auth', detail: 'channel_account_disabled' };
  }

  const rfcMessageId = `<crm-${input.messageId}-${input.now}@${account.external_id.split('@')[1] || 'zoho.local'}>`;

  if (account.mode === 'simulated') {
    if (!isLocalTestSimulatedMode(env)) {
      return { ok: false, errorClass: 'auth', detail: 'simulated_transport_requires_local_test' };
    }
    return evaluateSimulatedOutcome(config.simulatedBehavior, 'zoho_sim', input.messageId, input.now, {
      rfcMessageId,
    });
  }

  // Production Zoho Mail REST API path — explicitly blocked pending G3 owner verification:
  // Official Zoho docs require separate `/messages/view` (`start`/`limit`), `/folders/{folderId}/messages/{id}/content`,
  // and `/header?raw=true` (`headerContent`) endpoints plus account-specific O-20/O-21 verification.
  // Enablement stays blocked until G3 verification is explicitly approved.
  if (account.mode === 'production') {
    const dc: ZohoDataCenter | undefined = config.dataCenter;
    if (!dc || !(dc in ZOHO_API_HOSTS)) {
      return { ok: false, errorClass: 'auth', detail: 'zoho_datacenter_unconfigured_O20' };
    }
    if (!config.zohoAccountId || !config.fromAddress) {
      return { ok: false, errorClass: 'auth', detail: 'zoho_account_config_incomplete_O20' };
    }
    if (!isLocalTestSimulatedMode(env)) {
      return { ok: false, errorClass: 'auth', detail: 'zoho_production_pending_G3' };
    }
  }

  const dc: ZohoDataCenter | undefined = config.dataCenter;
  if (!dc || !(dc in ZOHO_API_HOSTS)) {
    return { ok: false, errorClass: 'auth', detail: 'zoho_datacenter_unconfigured_O20' };
  }
  if (!config.zohoAccountId || !config.fromAddress) {
    return { ok: false, errorClass: 'auth', detail: 'zoho_account_config_incomplete_O20' };
  }

  const secret = parseZohoSecret(readSecretBinding(env, account.secret_name));
  if (!secret) {
    return { ok: false, errorClass: 'auth', detail: 'zoho_secret_missing' };
  }

  const tokenRes = await resolveZohoAccessToken(dc, secret, fetchFn);
  if (!tokenRes.ok) {
    return { ok: false, errorClass: 'auth', detail: tokenRes.detail };
  }

  const apiHost = ZOHO_API_HOSTS[dc];
  const endpoint = assertAllowedEgressUrl(
    `https://${apiHost}/api/accounts/${encodeURIComponent(config.zohoAccountId)}/messages`,
    [apiHost],
  );

  const payload: Record<string, unknown> = {
    fromAddress: config.fromAddress,
    toAddress: recipientNorm,
    subject: input.subject || 'Following up',
    content: input.bodyText,
    mailFormat: 'plaintext',
    askReceipt: 'no',
  };
  const replyToId = normalizeRfcMessageId(input.inReplyTo);
  if (replyToId) {
    payload.inReplyTo = replyToId;
  }

  let res: Response;
  try {
    res = await fetchFn(endpoint.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${tokenRes.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      redirect: 'error',
    });
  } catch {
    // Request may already have reached Zoho Mail -> NEVER blind retry!
    return { unknown: true, detail: 'zoho_network_error_ambiguous_delivery' };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, errorClass: 'auth', detail: `zoho_auth_http_${res.status}` };
  }
  if (res.status === 429) {
    return { ok: false, errorClass: 'rate_limited', detail: 'zoho_rate_limited' };
  }
  if (res.status === 400 || res.status === 422) {
    const errText = (await res.text().catch(() => '')).slice(0, 200);
    return { ok: false, errorClass: 'recipient_invalid', detail: `zoho_rejected_${res.status}:${errText}` };
  }
  if (res.status >= 500) {
    // 5xx after POST submit is ambiguous on Zoho (no guaranteed client idempotency key) -> review!
    return { unknown: true, detail: `zoho_server_http_${res.status}_ambiguous` };
  }
  if (!res.ok) {
    return { unknown: true, detail: `zoho_unexpected_http_${res.status}` };
  }

  const data = (await res.json().catch(() => null)) as {
    data?: { messageId?: string; mailId?: string };
    status?: { code?: number };
  } | null;
  const providerMsgId = data?.data?.messageId ?? data?.data?.mailId;
  if (!providerMsgId) {
    return { unknown: true, detail: 'zoho_ack_missing_message_id' };
  }
  return {
    ok: true,
    externalId: String(providerMsgId),
    rfcMessageId: normalizeRfcMessageId(String(providerMsgId)) ?? rfcMessageId,
  };
}

export interface SimulatedZohoPollItem {
  externalEventId: string;
  rfcMessageId?: string;
  inReplyTo?: string;
  references?: string[];
  externalThreadId?: string;
  fromAddress: string;
  subject?: string;
  bodyText: string;
  receivedAt?: number;
}

/**
 * Polls inbound emails for a Zoho Mail account using a durable cursor.
 * - Simulated accounts ingest `simulatedMessages` only in `WORKSPACE_ENV === 'local-test'`.
 * - Production accounts call Zoho Mail REST API with exact DC allowlist and bounded limit.
 */
export async function pollZohoMailInbound(
  env: Env,
  account: ChannelAccountRow,
  opts: {
    cursor: string | null;
    limit: number;
    now: number;
    simulatedMessages?: readonly SimulatedZohoPollItem[];
  },
  fetchFn: typeof fetch = fetch,
): Promise<AdapterPollOutcome> {
  const config = parseChannelAccountConfig(account.config_json);
  if (account.mode === 'disabled' || account.active !== 1) {
    return { ok: false, errorClass: 'auth', detail: 'channel_account_disabled' };
  }

  if (account.mode === 'simulated') {
    if (!isLocalTestSimulatedMode(env)) {
      return { ok: false, errorClass: 'auth', detail: 'simulated_poll_requires_local_test' };
    }
    const cursorState = parseZohoPollCursor(opts.cursor);
    const items = [...(opts.simulatedMessages ?? [])]
      .sort((a, b) => (a.receivedAt ?? opts.now) - (b.receivedAt ?? opts.now))
      .slice(0, opts.limit);
    const events: AdapterInboundEvent[] = [];
    let maxTs = cursorState.watermarkTs;
    for (const item of items) {
      const fromNorm = normalizeEmail(item.fromAddress);
      if (!fromNorm) continue;
      const receivedAt = item.receivedAt ?? opts.now;
      if (receivedAt > maxTs) maxTs = receivedAt;
      const rfcId = normalizeRfcMessageId(item.rfcMessageId ?? `<${item.externalEventId}@mail.zoho.local>`);
      const inReplyTo = normalizeRfcMessageId(item.inReplyTo);
      const refs = parseRfcReferences(item.references ?? (inReplyTo ? [inReplyTo] : []));
      events.push({
        kind: 'message',
        externalEventId: item.externalEventId,
        channel: 'email',
        receivingAccountId: account.external_id,
        fromEndpoint: fromNorm,
        toEndpoint: config.fromAddress ?? account.external_id,
        externalThreadId: item.externalThreadId ?? null,
        rfcMessageId: rfcId,
        inReplyTo,
        references: refs,
        subject: item.subject?.trim() || 'Email enquiry',
        bodyText: item.bodyText,
        receivedAt,
        rawHashInput: item,
      });
    }
    const nextCursor = maxTs > 0 ? formatZohoPollCursor({ watermarkTs: maxTs, offset: 0 }) : opts.cursor;
    return {
      ok: true,
      events,
      nextCursor,
      more: (opts.simulatedMessages?.length ?? 0) > items.length,
    };
  }

  // Production Zoho Mail REST API polling — explicitly blocked pending G3 owner verification:
  // Official Zoho API separates list (`/messages/view` with `start`/`limit`), body (`/content`),
  // and RFC 5322 headers (`/header?raw=true` -> `headerContent`). Account-specific folder IDs,
  // pagination ordering, and Sent copy sync remain unverified until G3 (O-20, O-21).
  const dc: ZohoDataCenter | undefined = config.dataCenter;
  if (!dc || !(dc in ZOHO_API_HOSTS) || !config.zohoAccountId) {
    return { ok: false, errorClass: 'auth', detail: 'zoho_account_config_incomplete_O20' };
  }
  if (!isLocalTestSimulatedMode(env)) {
    return { ok: false, errorClass: 'auth', detail: 'zoho_production_pending_G3' };
  }
  const secret = parseZohoSecret(readSecretBinding(env, account.secret_name));
  if (!secret) {
    return { ok: false, errorClass: 'auth', detail: 'zoho_secret_missing' };
  }
  const tokenRes = await resolveZohoAccessToken(dc, secret, fetchFn);
  if (!tokenRes.ok) {
    return { ok: false, errorClass: 'auth', detail: tokenRes.detail };
  }

  const cursorState = parseZohoPollCursor(opts.cursor);
  const pageLimit = Math.min(25, Math.max(1, opts.limit));
  const apiHost = ZOHO_API_HOSTS[dc];
  const qs = new URLSearchParams({
    start: String(cursorState.offset + 1),
    limit: String(pageLimit),
    ...(config.folderId ? { folderId: config.folderId } : {}),
  });
  const listUrl = assertAllowedEgressUrl(
    `https://${apiHost}/api/accounts/${encodeURIComponent(config.zohoAccountId)}/messages/view?${qs.toString()}`,
    [apiHost],
  );

  let listRes: Response;
  try {
    listRes = await fetchFn(listUrl.toString(), {
      method: 'GET',
      headers: { Authorization: `Zoho-oauthtoken ${tokenRes.token}` },
      redirect: 'error',
    });
  } catch {
    return { ok: false, errorClass: 'transient', detail: 'zoho_poll_network_error' };
  }
  if (listRes.status === 401 || listRes.status === 403) {
    return { ok: false, errorClass: 'auth', detail: `zoho_poll_auth_${listRes.status}` };
  }
  if (listRes.status === 429) {
    return { ok: false, errorClass: 'rate_limited', detail: 'zoho_poll_rate_limited' };
  }
  if (!listRes.ok) {
    return { ok: false, errorClass: 'transient', detail: `zoho_poll_http_${listRes.status}` };
  }

  const json = (await listRes.json().catch(() => null)) as {
    data?: Array<{
      messageId?: string;
      folderId?: string;
      threadId?: string;
      fromAddress?: string;
      toAddress?: string;
      subject?: string;
      summary?: string;
      receivedTime?: string | number;
      headerContent?: string;
      headerMessageId?: string;
      inReplyTo?: string;
      references?: string;
    }>;
  } | null;

  const rows = Array.isArray(json?.data) ? json!.data : [];
  const cursorTs = cursorState.watermarkTs;
  let maxTs = cursorTs;
  const events: AdapterInboundEvent[] = [];

  for (const m of rows) {
    if (!m.messageId || !m.fromAddress) continue;
    const recTs = Number(m.receivedTime ?? opts.now) || opts.now;
    if (cursorTs > 0 && recTs < cursorTs) continue;
    const fromNorm = normalizeEmail(m.fromAddress);
    if (!fromNorm) continue;
    if (recTs > maxTs) maxTs = recTs;
    const rawHdrs = parseRawRfcHeaders(m.headerContent);
    const rfcId = rawHdrs.messageId ?? normalizeRfcMessageId(m.headerMessageId ?? `<${m.messageId}@mail.zoho.${dc}>`);
    const inReplyTo = rawHdrs.inReplyTo ?? normalizeRfcMessageId(m.inReplyTo);
    const refs =
      rawHdrs.references.length > 0 ? rawHdrs.references : parseRfcReferences(m.references ?? inReplyTo ?? null);
    events.push({
      kind: 'message',
      externalEventId: String(m.messageId),
      channel: 'email',
      receivingAccountId: config.zohoAccountId,
      fromEndpoint: fromNorm,
      toEndpoint: m.toAddress ?? config.fromAddress ?? account.external_id,
      externalThreadId: m.threadId ? String(m.threadId) : null,
      rfcMessageId: rfcId,
      inReplyTo,
      references: refs,
      subject: m.subject?.trim() || 'Email enquiry',
      bodyText: (m.summary ?? '').trim() || '(No text summary)',
      receivedAt: recTs,
      rawHashInput: m,
    });
  }

  events.sort((a, b) => (a.kind === 'message' ? a.receivedAt : 0) - (b.kind === 'message' ? b.receivedAt : 0));
  const hasMore = rows.length >= pageLimit;
  const nextCursor = hasMore
    ? formatZohoPollCursor({ watermarkTs: cursorTs, offset: cursorState.offset + rows.length })
    : maxTs > 0
      ? formatZohoPollCursor({ watermarkTs: maxTs, offset: 0 })
      : opts.cursor;

  return {
    ok: true,
    events,
    nextCursor,
    more: hasMore,
  };
}
