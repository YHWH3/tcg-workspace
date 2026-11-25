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
import {
  createS1IdentityCommandDefs,
  readDuplicates,
  readPersonDetail,
} from './identity';
import {
  createS2ProgrammeCommandDefs,
  readProgrammes,
} from './programmes';
import {
  createS2ApplicationCommandDefs,
  readCrmHome,
  readTimeline,
} from './applications';
import { isCrmEnabled } from './rules';

export function createS0CommandRegistry(): CommandRegistry {
  return createCommandRegistry([
    ...createCapabilityCommandDefs(),
    ...createS1IdentityCommandDefs(),
    ...createS2ProgrammeCommandDefs(),
    ...createS2ApplicationCommandDefs(),
  ]);
}

export const crmApi = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
crmApi.use('*', requireAuth);

crmApi.get('/status', async (c) => {
  const user = c.get('user');
  const outcome = await readCrmStatus(c.env, user.id, user.tokenHash);
  return c.json(outcome.body, outcome.status);
});

crmApi.post('/commands/:name', async (c) => {
  if (!isCrmEnabled(c.env)) {
    return c.json({ error: 'not_found' }, 404);
  }
  const name = c.req.param('name')!;
  const registry = createS0CommandRegistry();
  if (!registry.has(name)) {
    return c.json({ error: 'not_found' }, 404);
  }
  const rawBytes = await boundedRequestBody(c.req.raw, MAX_COMMAND_BODY_BYTES);
  if (rawBytes === null) {
    return c.json({ error: 'request_too_large' }, 413);
  }
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

crmApi.get('/read/person/:id', async (c) => {
  const user = c.get('user');
  const personId = c.req.param('id')!;
  const outcome = await readPersonDetail(c.env, user.id, user.tokenHash, personId);
  return c.json(outcome.body, outcome.status);
});

crmApi.get('/read/duplicates', async (c) => {
  const user = c.get('user');
  const url = new URL(c.req.url);
  const state = url.searchParams.get('state') ?? 'open';
  const rawCursor = url.searchParams.has('cursor') ? (url.searchParams.get('cursor') ?? '') : undefined;
  const outcome = await readDuplicates(c.env, user.id, user.tokenHash, state, rawCursor);
  return c.json(outcome.body, outcome.status);
});

crmApi.get('/read/programmes', async (c) => {
  const user = c.get('user');
  const outcome = await readProgrammes(c.env, user.id, user.tokenHash);
  return c.json(outcome.body, outcome.status);
});

crmApi.get('/read/timeline', async (c) => {
  const user = c.get('user');
  const url = new URL(c.req.url);
  const subjectId = url.searchParams.get('subject') ?? '';
  const cursor = url.searchParams.has('cursor') ? (url.searchParams.get('cursor') ?? '') : undefined;
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit ? Number(rawLimit) : undefined;
  const outcome = await readTimeline(c.env, user.id, user.tokenHash, {
    subjectId,
    cursor,
    limit: typeof limit === 'number' && Number.isFinite(limit) ? limit : undefined,
  });
  return c.json(outcome.body, outcome.status);
});

crmApi.get('/read/home', async (c) => {
  const user = c.get('user');
  const outcome = await readCrmHome(c.env, user.id, user.tokenHash);
  return c.json(outcome.body, outcome.status);
});

crmApi.all('*', (c) => c.json({ error: 'not_found' }, 404));
