import { Hono } from 'hono';
import type { CrmChannel } from '../../shared/crm/capabilities';
import type { ChannelProvider } from '../../shared/crm/channels';
import type { Env } from '../auth';
import { D1BudgetExhausted } from '../d1budget';
import { boundedRequestBody } from '../forms';
import { pokeLive } from '../sync';
import { parseMetaMessagingSecret, parseMetaMessagingWebhookPayload } from './adapters/metaMessaging';
import { isLocalTestSimulatedMode } from './adapters/simulated';
import {
  parseChannelAccountConfig,
  readSecretBinding,
  timingSafeEqualStr,
  verifyHubSignature256,
  type AdapterInboundEvent,
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

async function loadActiveWebhookAccounts(
  db: D1Database,
  cfg: WebhookProviderRouteConfig,
): Promise<ChannelAccountRow[]> {
  const res = await db
    .prepare(
      `SELECT * FROM crm_channel_accounts
       WHERE channel = ? AND provider = ? AND active = 1 AND mode != 'disabled'
       ORDER BY CASE WHEN mode = 'production' THEN 0 ELSE 1 END, updated_at DESC
       LIMIT 25`,
    )
    .bind(cfg.channel, cfg.provider)
    .all<ChannelAccountRow>();
  return res.results;
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
 * Returns the exact provider-side receiving account identifiers owned by `account`.
 * Webhooks MUST match an explicit configured receiving identifier — NEVER associate
 * an unconfigured or mismatched receiving ID with an arbitrary active account.
 */
function receivingIdentifiersForAccount(account: ChannelAccountRow): Set<string> {
  const cfg = parseChannelAccountConfig(account.config_json);
  const ids = new Set<string>();
  const add = (v: string | null | undefined) => {
    const t = v?.trim();
    if (t) ids.add(t);
  };
  if (account.provider === 'whatsapp_cloud') {
    add(cfg.phoneNumberId);
    add(account.external_id);
  } else if (account.provider === 'instagram_meta') {
    add(cfg.instagramAccountId);
    add(cfg.pageId);
    add(account.external_id);
  } else if (account.provider === 'facebook_meta') {
    add(cfg.pageId);
    add(account.external_id);
  }
  return ids;
}

/**
 * Public signature-verified inbound webhook router mounted at `/api/crm/webhooks`.
 * - Always returns 404 when `CRM_ENABLED` is off or no active matching channel account exists.
 * - Rejects `mode === 'simulated'` outside `WORKSPACE_ENV === 'local-test'`.
 * - Verifies raw request body HMAC-SHA256 (`X-Hub-Signature-256`) in constant time BEFORE JSON parsing.
 * - Strictly matches each event's receiving provider account ID (`phone_number_id` / `entry.id` / `recipient.id`)
 *   against the verified active account(s); refuses unmatched receiving accounts instead of guessing.
 * - Returns `503` (retryable) whenever D1 processing budget is exhausted so Meta redelivers unprocessed events.
 */
export const crmWebhooksApi = new Hono<{ Bindings: Env }>();

crmWebhooksApi.get('/:provider', async (c) => {
  if (!isCrmEnabled(c.env)) return c.json({ error: 'not_found' }, 404);
  const cfg = WEBHOOK_ROUTES[c.req.param('provider') ?? ''];
  if (!cfg) return c.json({ error: 'not_found' }, 404);

  const accounts = (await loadActiveWebhookAccounts(c.env.DB, cfg)).filter(
    (a) => !(a.mode === 'simulated' && !isLocalTestSimulatedMode(c.env)),
  );
  if (accounts.length === 0) return c.json({ error: 'not_found' }, 404);

  const url = new URL(c.req.url);
  const mode = url.searchParams.get('hub.mode') ?? '';
  const token = url.searchParams.get('hub.verify_token') ?? '';
  const challenge = url.searchParams.get('hub.challenge') ?? '';

  const configuredTokens = accounts
    .map((a) => extractWebhookSecrets(c.env, a).verifyToken)
    .filter((t): t is string => Boolean(t));
  if (configuredTokens.length === 0) return c.json({ error: 'webhook_unconfigured' }, 403);

  const matched =
    mode === 'subscribe' &&
    challenge.length > 0 &&
    challenge.length <= 256 &&
    configuredTokens.some((expected) => timingSafeEqualStr(token, expected));

  if (matched) {
    return c.text(challenge, 200);
  }
  return c.json({ error: 'forbidden' }, 403);
});

crmWebhooksApi.post('/:provider', async (c) => {
  if (!isCrmEnabled(c.env)) return c.json({ error: 'not_found' }, 404);
  const cfg = WEBHOOK_ROUTES[c.req.param('provider') ?? ''];
  if (!cfg) return c.json({ error: 'not_found' }, 404);

  const activeAccounts = (await loadActiveWebhookAccounts(c.env.DB, cfg)).filter(
    (a) => !(a.mode === 'simulated' && !isLocalTestSimulatedMode(c.env)),
  );
  if (activeAccounts.length === 0) return c.json({ error: 'not_found' }, 404);

  const accountsWithSecrets = activeAccounts
    .map((account) => ({ account, appSecret: extractWebhookSecrets(c.env, account).appSecret }))
    .filter((item): item is { account: ChannelAccountRow; appSecret: string } => Boolean(item.appSecret));
  if (accountsWithSecrets.length === 0) {
    return c.json({ error: 'webhook_secret_missing' }, 403);
  }

  const rawBytes = await boundedRequestBody(c.req.raw, MAX_WEBHOOK_BODY_BYTES);
  if (rawBytes === null) {
    return c.json({ error: 'payload_too_large' }, 413);
  }

  const sigHeader = c.req.header('x-hub-signature-256');
  const verifiedAccounts: ChannelAccountRow[] = [];
  for (const item of accountsWithSecrets) {
    if (await verifyHubSignature256(rawBytes, sigHeader, item.appSecret)) {
      verifiedAccounts.push(item.account);
    }
  }
  if (verifiedAccounts.length === 0) {
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

  // Strictly group events by their exact verified receiving account — NEVER fall back to an arbitrary account!
  const verifiedWithIds = verifiedAccounts.map((account) => ({
    account,
    ids: receivingIdentifiersForAccount(account),
  }));
  const grouped = new Map<string, { account: ChannelAccountRow; events: AdapterInboundEvent[] }>();

  for (const ev of events) {
    const recId = ev.receivingAccountId?.trim() || null;
    if (!recId) {
      return c.json({ ok: false, error: 'missing_receiving_account_id' }, 400);
    }
    const matched = verifiedWithIds.filter((item) => item.ids.has(recId));
    if (matched.length !== 1) {
      return c.json(
        {
          ok: false,
          error: matched.length === 0 ? 'unmatched_receiving_account' : 'ambiguous_receiving_account',
          receivingAccountId: recId,
        },
        matched.length === 0 ? 403 : 409,
      );
    }
    const acc = matched[0]!.account;
    const bucket = grouped.get(acc.id) ?? { account: acc, events: [] };
    bucket.events.push(ev);
    grouped.set(acc.id, bucket);
  }

  let ingested = 0;
  let duplicatesSkipped = 0;
  let optOutsRecorded = 0;
  let statusesUpdated = 0;
  let unprocessedCount = 0;
  let budgetExhausted = false;

  try {
    for (const { account, events: accEvents } of grouped.values()) {
      if (budgetExhausted) {
        unprocessedCount += accEvents.length;
        continue;
      }
      const summary = await ingestChannelInboundEvents(c.env, account, accEvents, now);
      ingested += summary.ingested;
      duplicatesSkipped += summary.duplicatesSkipped;
      optOutsRecorded += summary.optOutsRecorded;
      statusesUpdated += summary.statusesUpdated;
      unprocessedCount += summary.unprocessedCount;
      if (summary.budgetExhausted) {
        budgetExhausted = true;
      }
    }
  } catch (err) {
    if (err instanceof D1BudgetExhausted) {
      if (ingested > 0) pokeLive(c.env, c.executionCtx);
      return c.json(
        { ok: false, error: 'processing_budget', retryable: true, ingested, duplicatesSkipped },
        503,
      );
    }
    // Genuine database failure: NEVER acknowledge as 200 OK or count as duplicate!
    return c.json(
      { ok: false, error: 'ingest_failed', retryable: true, ingested, duplicatesSkipped },
      500,
    );
  }

  if (ingested > 0) {
    pokeLive(c.env, c.executionCtx);
  }

  if (budgetExhausted || unprocessedCount > 0) {
    return c.json(
      {
        ok: false,
        error: 'processing_budget',
        retryable: true,
        ingested,
        duplicatesSkipped,
        optOutsRecorded,
        statusesUpdated,
        unprocessedCount,
      },
      503,
    );
  }

  return c.json(
    {
      ok: true,
      ingested,
      duplicatesSkipped,
      optOutsRecorded,
      statusesUpdated,
    },
    200,
  );
});
