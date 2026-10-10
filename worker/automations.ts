// Phase 4 — lightweight automations (Workstream E). Contract signature is
// FIXED here; the E agent replaces the stub body only.

import { Hono } from 'hono';
import type { SemanticEvent } from '../shared/events';
import type { EventSource } from './events';
import { requireAuth, type Env, type AuthUser } from './auth';

export interface EventCtx {
  source: EventSource;
  userId: string;
}

/** Match enabled automations on the event's database and execute actions as a
 * single source:'automation' applyChanges batch inside a changeset. Replay-
 * safe via automation_runs.event_key UNIQUE. Never fires for automation-
 * sourced events (caller guards) — automation writes may notify but never
 * re-trigger automations. */
export async function runAutomationsForEvent(
  _env: { DB: D1Database },
  _semantic: SemanticEvent[],
  _ctx: EventCtx
): Promise<void> {
  // STUB — Workstream E.
}

/** Member API (mounted at /api/automations): run history, validation, etc.
 * E agent replaces the stub routes. Automation CONFIG itself is a synced
 * `automations` collection edited through normal mutate()/sync. */
export const automationsApi = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
automationsApi.use('*', requireAuth);

automationsApi.get('/:id/runs', async (c) => c.json({ error: 'not implemented — Workstream E' }, 501));
