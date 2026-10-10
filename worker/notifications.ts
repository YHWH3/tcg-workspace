// Phase 4 — notifications (Workstream B). Contract signatures are FIXED here;
// the B agent replaces stub bodies only. Storage is the server-controlled
// `notifications` D1 table — never a synced collection.

import { Hono } from 'hono';
import type { SemanticEvent } from '../shared/events';
import type { EventSource } from './events';
import { requireAuth, type Env, type AuthUser } from './auth';

export interface NewNotification {
  userId: string;
  kind:
    | 'mention'
    | 'assigned'
    | 'comment_on_mine'
    | 'due_soon'
    | 'overdue'
    | 'approval_requested'
    | 'approval_decided'
    | 'form_submission'
    | 'automation';
  actorId?: string;
  targetType?: string;
  targetId?: string;
  title: string;
  body?: string;
  url?: string;
  groupKey?: string;
}

export interface EventCtx {
  source: EventSource;
  userId: string;
}

/** Insert (or group-update) one notification honoring per-user prefs.
 * B agent implements: prefs check, 30-min groupKey grouping (count+items),
 * actor resolution, pokeLive handled by caller. */
export async function notify(_env: { DB: D1Database }, _n: NewNotification): Promise<void> {
  // STUB — Workstream B.
}

/** Route derived events to the right recipients. B agent implements. */
export async function notificationsForEvent(
  _env: { DB: D1Database },
  _semantic: SemanticEvent[],
  _ctx: EventCtx
): Promise<void> {
  // STUB — Workstream B.
}

/** Recipient-scoped REST API (mounted at /api/notifications). Every query is
 * bound to the session user's own rows — no member ever reads another's
 * Inbox. B agent replaces the stub routes. */
export const notificationsApi = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
notificationsApi.use('*', requireAuth);

notificationsApi.get('/', async (c) => c.json({ error: 'not implemented — Workstream B' }, 501));
notificationsApi.get('/badge', async (c) => c.json({ unread: 0 }));
notificationsApi.post('/:id/read', async (c) => c.json({ error: 'not implemented — Workstream B' }, 501));
notificationsApi.post('/read-all', async (c) => c.json({ error: 'not implemented — Workstream B' }, 501));
