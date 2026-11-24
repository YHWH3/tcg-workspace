import { Hono } from 'hono';
import {
  CommandRequestEnvelopeSchema,
  MAX_COMMAND_BODY_BYTES,
} from '../../shared/crm/contracts';
import { requireAuth, type AuthUser, type Env } from '../auth';
import { boundedRequestBody } from '../forms';
import { createCommandRegistry, runCommand, type CommandRegistry } from './commands';
import {
  createCapabilityCommandDefs,
  readCapabilitiesOverview,
  readCapabilityAudit,
  readCrmStatus,
} from './grants';
import { isCrmEnabled } from './rules';

export function createS0CommandRegistry(): CommandRegistry {
  return createCommandRegistry(createCapabilityCommandDefs());
}

export const crmApi = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
crmApi.use('*', requireAuth);

crmApi.get('/status', async (c) => {
  const user = c.get('user');
  const outcome = await readCrmStatus(c.env, user.id, user.tokenHash);
  return c.json(outcome.body, outcome.status);
});

crmApi.post('/commands/:name', async (c) => {
  // Exact SC-4.1 validation precedence:
  // 1. 401 unauthenticated (requireAuth)
  // 2. 404 not_found (CRM_ENABLED off)
  if (!isCrmEnabled(c.env)) {
    return c.json({ error: 'not_found' }, 404);
  }
  // 3. 404 not_found (unregistered command)
  const name = c.req.param('name')!;
  const registry = createS0CommandRegistry();
  if (!registry.has(name)) {
    return c.json({ error: 'not_found' }, 404);
  }
  // 4. 413 request_too_large (streamed UTF-8 byte enforcement via boundedRequestBody)
  const rawBytes = await boundedRequestBody(c.req.raw, MAX_COMMAND_BODY_BYTES);
  if (rawBytes === null) {
    return c.json({ error: 'request_too_large' }, 413);
  }
  // 5. 400 invalid_body (strict UTF-8 + JSON + CommandRequestEnvelopeSchema)
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
  } catch {
    return c.json({ error: 'invalid_body' }, 400);
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(decoded);
  } catch {
    return c.json({ error: 'invalid_body' }, 400);
  }
  const envelope = CommandRequestEnvelopeSchema.safeParse(parsedJson);
  if (!envelope.success) {
    return c.json({ error: 'invalid_body' }, 400);
  }

  // 6-8. Authority, wire parse, fine auth, idempotency, plan, atomic commit & recovery.
  const user = c.get('user');
  const outcome = await runCommand({
    env: c.env,
    executionCtx: c.executionCtx,
    actorId: user.id,
    tokenHash: user.tokenHash,
    via: 'ui',
    name,
    envelope: envelope.data,
    registry,
  });
  return c.json(outcome.body, outcome.status);
});

crmApi.get('/read/capabilities', async (c) => {
  const user = c.get('user');
  const outcome = await readCapabilitiesOverview(c.env, user.id, user.tokenHash);
  return c.json(outcome.body, outcome.status);
});

crmApi.get('/read/capability-audit', async (c) => {
  const user = c.get('user');
  const url = new URL(c.req.url);
  const rawCursor = url.searchParams.has('cursor') ? (url.searchParams.get('cursor') ?? '') : undefined;
  const outcome = await readCapabilityAudit(c.env, user.id, user.tokenHash, rawCursor);
  return c.json(outcome.body, outcome.status);
});

// Terminate all unmatched /api/crm/* paths with canonical 'not_found' (never fall through to admin or 'not found').
crmApi.all('*', (c) => c.json({ error: 'not_found' }, 404));
