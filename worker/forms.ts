// Phase 4 — public forms (Workstream C). Contract mounts are FIXED in
// worker/index.ts; the C agent replaces stub bodies only.
// `forms` config = synced collection (member-editable); form_tokens,
// form_submissions, rate_limits = server-controlled D1 (never synced).

import { Hono } from 'hono';
import type { Env, AuthUser } from './auth';
import { requireAuth } from './auth';

/** Member-side form/token management (mounted at /api/forms). */
export const formsApi = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
formsApi.use('*', requireAuth);

formsApi.get('/', async (c) => c.json({ error: 'not implemented — Workstream C' }, 501));

/** Public, unauthenticated form API (mounted at /api/public/forms). Schema
 * responses must never leak notifyUserIds/createRelations/peopleMatch. */
export const publicFormsApi = new Hono<{ Bindings: Env }>();

publicFormsApi.get('/:token', async (c) => c.json({ error: 'not implemented — Workstream C' }, 501));
publicFormsApi.post('/:token', async (c) => c.json({ error: 'not implemented — Workstream C' }, 501));
publicFormsApi.post('/:token/files', async (c) => c.json({ error: 'not implemented — Workstream C' }, 501));
