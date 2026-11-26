import type { CrmChannel } from '../../../shared/crm/capabilities';
import type {
  AdapterErrorClass,
  ChannelAccountConfig,
  ChannelAccountMode,
  ChannelHealthState,
  ChannelProvider,
} from '../../../shared/crm/channels';
import type { Env } from '../../auth';

export interface ChannelAccountRow {
  id: string;
  channel: CrmChannel;
  provider: ChannelProvider;
  label: string;
  external_id: string;
  mode: ChannelAccountMode;
  active: number;
  secret_name: string | null;
  config_json: string;
  poll_cursor: string | null;
  poll_lease_until: number | null;
  last_poll_at: number | null;
  health_state: ChannelHealthState;
  last_error: string | null;
  last_error_at: number | null;
  rev: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface AdapterSendInput {
  account: ChannelAccountRow | null;
  config: ChannelAccountConfig;
  channel: CrmChannel;
  messageId: string;
  conversationId: string;
  subject: string;
  recipientEndpoint: string;
  bodyText: string;
  idempotencyKey: string;
  inReplyTo?: string | null;
  references?: readonly string[];
  template?: {
    id: string;
    name: string;
    language: string;
    providerTemplateId: string | null;
    params: readonly string[];
  } | null;
  messageTag?: 'HUMAN_AGENT' | null;
  now: number;
}

export type AdapterSendOutcome =
  | { ok: true; externalId: string; rfcMessageId?: string | null }
  | { ok: false; errorClass: AdapterErrorClass; detail: string }
  | { unknown: true; detail: string };

export type AdapterInboundEvent =
  | {
      kind: 'message';
      externalEventId: string;
      channel: CrmChannel;
      fromEndpoint: string;
      toEndpoint?: string | null;
      externalThreadId?: string | null;
      rfcMessageId?: string | null;
      inReplyTo?: string | null;
      references?: string[];
      subject?: string | null;
      bodyText: string;
      receivedAt: number;
      isOptOut?: boolean;
      rawHashInput: unknown;
    }
  | {
      kind: 'status';
      externalEventId: string;
      channel: CrmChannel;
      externalMessageId: string;
      status: 'sent' | 'delivered' | 'read' | 'failed';
      errorDetail?: string | null;
      timestamp: number;
      rawHashInput: unknown;
    }
  | {
      kind: 'opt_out';
      externalEventId: string;
      channel: CrmChannel;
      fromEndpoint: string;
      reason?: string | null;
      timestamp: number;
      rawHashInput: unknown;
    };

export type AdapterPollOutcome =
  | { ok: true; events: AdapterInboundEvent[]; nextCursor: string | null; more: boolean }
  | { ok: false; errorClass: AdapterErrorClass; detail: string };

export function parseChannelAccountConfig(raw: string | null | undefined): ChannelAccountConfig {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as ChannelAccountConfig)
      : {};
  } catch {
    return {};
  }
}

/** Reads a Worker secret by exact binding name without ever persisting or logging its value. */
export function readSecretBinding(env: Env, secretName: string | null | undefined): string | null {
  if (!secretName || !/^[A-Z0-9_]{3,64}$/.test(secretName)) return null;
  const val = (env as unknown as Record<string, unknown>)[secretName];
  return typeof val === 'string' && val.trim().length > 0 ? val.trim() : null;
}

/**
 * Enforces HTTPS + exact host allowlist + no embedded credentials before any outbound fetch.
 * All callers MUST pass `redirect: 'error'` to `fetch`.
 */
export function assertAllowedEgressUrl(rawUrl: string, allowedHosts: readonly string[]): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') {
    throw new Error(`egress_protocol_denied:${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error('egress_credentials_in_url_denied');
  }
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.some((h) => h.toLowerCase() === host)) {
    throw new Error(`egress_host_denied:${host}`);
  }
  return url;
}

/** Constant-time string/byte comparison for webhook tokens and HMAC digests. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const maxLen = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < maxLen; i += 1) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Computes and verifies Meta `X-Hub-Signature-256` (`sha256=<lowercase hex>`)
 * over the exact raw request body bytes using Web Crypto HMAC-SHA256.
 */
export async function computeHmacSha256Hex(rawBody: Uint8Array, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, rawBody as BufferSource);
  return Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function verifyHubSignature256(
  rawBody: Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader || !secret) return false;
  const trimmed = signatureHeader.trim();
  if (!trimmed.startsWith('sha256=')) return false;
  const providedHex = trimmed.slice('sha256='.length).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(providedHex)) return false;
  const expectedHex = await computeHmacSha256Hex(rawBody, secret);
  return timingSafeEqualStr(providedHex, expectedHex);
}

/**
 * Evaluates simulated outcome behavior under `WORKSPACE_ENV === 'local-test'`.
 * Returns null if normal simulated success should proceed.
 */
export function evaluateSimulatedOutcome(
  behavior: ChannelAccountConfig['simulatedBehavior'],
  prefix: string,
  messageId: string,
  now: number,
  extra?: { rfcMessageId?: string },
): AdapterSendOutcome {
  switch (behavior) {
    case 'transient_fail':
      return { ok: false, errorClass: 'transient', detail: 'simulated_transient_error' };
    case 'rate_limited':
      return { ok: false, errorClass: 'rate_limited', detail: 'simulated_rate_limited' };
    case 'auth_error':
      return { ok: false, errorClass: 'auth', detail: 'simulated_auth_rejected' };
    case 'recipient_invalid':
      return { ok: false, errorClass: 'recipient_invalid', detail: 'simulated_recipient_invalid' };
    case 'blocked':
      return { ok: false, errorClass: 'blocked', detail: 'simulated_recipient_blocked' };
    case 'ambiguous':
      return { unknown: true, detail: 'simulated_ambiguous_timeout_after_dispatch' };
    default:
      return {
        ok: true,
        externalId: `${prefix}_${messageId}_${now}`,
        ...(extra?.rfcMessageId ? { rfcMessageId: extra.rfcMessageId } : {}),
      };
  }
}
