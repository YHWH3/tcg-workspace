// Phase 4 — reminders/deadlines/recurrence + cron sweeps (Workstream B).
// Contract signature is FIXED; the B agent fills in the reminder and
// date-offset bodies. The outbox sweep below is the shared reliability floor.

import { processOutbox } from './events';

const OUTBOX_BATCH = 20;
const OUTBOX_MAX_ATTEMPTS = 5;
const OUTBOX_STALE_MS = 60_000;

/** Called by the cron scheduled() handler every 15 min:
 * 1) sweep unprocessed event_outbox rows (crash/waitUntil-kill recovery),
 * 2) due_soon + overdue reminders via date_index + reminder_sent dedupe,
 * 3) date_offset automation triggers,
 * 4) retention sweeps (rate_limits, stale submissions, old runs/notifs).
 * B agent implements 2–4; keep this function the single entry point. */
export async function runScheduled(env: { DB: D1Database }): Promise<void> {
  // 1. Event outbox sweep — the durable-processing guarantee.
  const { results: pending } = await env.DB.prepare(
    'SELECT id FROM event_outbox WHERE processed_at IS NULL AND created_at < ? ORDER BY created_at LIMIT ?'
  )
    .bind(Date.now() - OUTBOX_STALE_MS, OUTBOX_BATCH)
    .all<{ id: string }>();
  for (const row of pending) {
    const { attempts } = (await env.DB.prepare('SELECT attempts FROM event_outbox WHERE id = ?')
      .bind(row.id)
      .first<{ attempts: number }>()) ?? { attempts: 0 };
    if (attempts >= OUTBOX_MAX_ATTEMPTS) {
      // Poisoned event: park it processed with the error on record — never loop.
      await env.DB.prepare('UPDATE event_outbox SET processed_at = ? WHERE id = ?')
        .bind(Date.now(), row.id)
        .run();
      continue;
    }
    try {
      await processOutbox(env, row.id);
    } catch {
      /* attempts recorded by processOutbox; retry next run */
    }
  }
  // Retention: drop processed outbox + stale rate-limit rows.
  await env.DB.prepare('DELETE FROM event_outbox WHERE processed_at IS NOT NULL').run().catch(() => {});
  await env.DB.prepare('DELETE FROM rate_limits WHERE reset_at < ?').bind(Date.now()).run().catch(() => {});

  // TODO Workstream B: due_soon / overdue via date_index + reminder_sent.
  // TODO Workstream B: date_offset automation triggers.
  // TODO Workstream B: notification/run/submission retention sweeps.
}
