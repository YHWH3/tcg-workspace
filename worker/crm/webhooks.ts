import { Hono } from 'hono';
import type { CrmChannel } from '../../shared/crm/capabilities';
import type { ChannelProvider } from '../../shared/crm/channels';
import type { Env } from '../auth';
import { boundedRequestBody } from '../forms';
import { pokeLive } from '../sync';
import { parseMetaMessagingSecret, parseMetaMessagingWebhookPayload } from './adapters/metaMessaging';
import { isLocalTestSimulatedMode } from './adapters/simulated';
import {
  readSecretBinding,
  timingSafeEqualStr,
  verifyHubSignature256,
  type ChannelAccountRow,
} from './adapters/types';
import { parseWhatsAppSecret, parseWhatsAppWebhookPayload } from './adapters/whatsappCloud';
import { ingestChannelInboundEvents } from './channels';
import { isCrmEnabled } from './rules';

const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

interface WebhookProviderRouteConfig {
  channel: CrmChannel;
  provider: ChannelProvider;
}

const WEBHOOK_ROUTES: Record<string, WebhookProviderRouteConfig> = {
  whatsapp: { channel: 'whatsapp', provider: 'whatsapp_cloud' },
  instagram: { channel: 'instagram', provider: 'instagram_meta' },
  facebook: { channel: 'facebook', provider: 'facebook_meta' },
};

async function loadActiveWebhookAccount(
  db: D1Database,
  cfg: WebhookProviderRouteConfig,
): Promise<ChannelAccountRow | null> {
  return (
    (await db
      .prepare(
        `SELECT * FROM crm_channel_accounts
         WHERE channel = ? AND provider = ? AND active = 1 AND mode != 'disabled'
         ORDER BY CASE WHEN mode = 'production' THEN 0 ELSE 1 END, updated_at DESC
         LIMIT 1`,
      )
      .bind(cfg.channel, cfg.provider)
      .first<ChannelAccountRow>()) ?? null
  );
}

function extractWebhookSecrets(
  env: Env,
  account: ChannelAccountRow,
): { appSecret: string | null; verifyToken: string | null } {
  const raw = readSecretBinding(env, account.secret_name);
  if (account.provider === 'whatsapp_cloud') {
    const p = parseWhatsAppSecret(raw);
    return { appSecret: p?.appSecret ?? null, verifyToken: p?.verifyToken ?? null };
  }
  const p = parseMetaMessagingSecret(raw);
  return { appSecret: p?.appSecret ?? null, verifyToken: p?.verifyToken ?? null };
}

/**
 * Public signature-verified inbound webhook router mounted at `/api/crm/webhooks`.
 * - Always returns 404 when `CRM_ENABLED` is off or no active matching channel account exists.
 * - Rejects `mode === 'simulated'` outside `WORKSPACE_ENV === 'local-test'`.
 * - Verifies raw request body HMAC-SHA256 (`X-Hub-Signature-256`) in constant time BEFORE JSON parsing.
 */
export const crmWebhooksApi = new Hono<{ Bindings: Env }>();

crmWebhooksApi.get('/:provider', async (c) => {
  if (!isCrmEnabled(c.env)) return c.json({ error: 'not_found' }, 404);
  const cfg = WEBHOOK_ROUTES[c.req.param('provider') ?? ''];
  if (!cfg) return c.json({ error: 'not_found' }, 404);

  const account = await loadActiveWebhookAccount(c.env.DB, cfg);
  if (!account) return c.json({ error: 'not_found' }, 404);
  if (account.mode === 'simulated' && !isLocalTestSimulatedMode(c.env)) {
    return c.json({ error: 'not_found' }, 404);
  }

  const { verifyToken } = extractWebhookSecrets(c.env, account);
  if (!verifyToken) return c.json({ error: 'webhook_unconfigured' }, 403);

  const url = new URL(c.req.url);
  const mode = url.searchParams.get('hub.mode') ?? '';
  const token = url.searchParams.get('hub.verify_token') ?? '';
  const challenge = url.searchParams.get('hub.challenge') ?? '';

  if (mode === 'subscribe' && challenge.length > 0 && challenge.length <= 256 && timingSafeEqualStr(token, verifyToken)) {
    return c.text(challenge, 200);
  }
  return c.json({ error: 'forbidden' }, 403);
});

crmWebhooksApi.post('/:provider', async (c) => {
  if (!isCrmEnabled(c.env)) return c.json({ error: 'not_found' }, 404);
  const cfg = WEBHOOK_ROUTES[c.req.param('provider') ?? ''];
  if (!cfg) return c.json({ error: 'not_found' }, 404);

  const account = await loadActiveWebhookAccount(c.env.DB, cfg);
  if (!account) return c.json({ error: 'not_found' }, 404);
  if (account.mode === 'simulated' && !isLocalTestSimulatedMode(c.env)) {
    return c.json({ error: 'not_found' }, 404);
  }

  const { appSecret } = extractWebhookSecrets(c.env, account);
  if (!appSecret) {
    return c.json({ error: 'webhook_secret_missing' }, 403);
  }

  const rawBytes = await boundedRequestBody(c.req.raw, MAX_WEBHOOK_BODY_BYTES);
  if (rawBytes === null) {
    return c.json({ error: 'payload_too_large' }, 413);
  }

  const sigHeader = c.req.header('x-hub-signature-256');
  const validSig = await verifyHubSignature256(rawBytes, sigHeader, appSecret);
  if (!validSig) {
    return c.json({ error: 'invalid_signature' }, 401);
  }

  let body: unknown;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
    body = JSON.parse(decoded);
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const now = Date.now();
  const events =
    cfg.channel === 'whatsapp'
      ? parseWhatsAppWebhookPayload(body, now)
      : parseMetaMessagingWebhookPayload(cfg.channel as 'instagram' | 'facebook', body, now);

  const summary = await ingestChannelInboundEvents(c.env, account, events, now);
  if (summary.ingested > 0) {
    pokeLive(c.env, c.executionCtx);
  }

  return c.json(
    {
      ok: true,
      ingested: summary.ingested,
      duplicatesSkipped: summary.duplicatesSkipped,
      optOutsRecorded: summary.optOutsRecorded,
      statusesUpdated: summary.statusesUpdated,
    },
    200,
  );
});
