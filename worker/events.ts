// Phase 4 — unified server event pipeline.
// One emission point: applyChanges callers pass opts.event; we durably stage
// the event in event_outbox (same request, post-commit) and process it in
// waitUntil; the cron sweeper recovers unprocessed rows. All semantic events
// derive from successfully applied changes — never from client intentions.

import { deriveEvents, type SemanticEvent, type AppliedLike } from '../shared/events';
import type { AppliedChange } from './sync';
import { notificationsForEvent, notify } from './notifications';
import { runAutomationsForEvent } from './automations';

export type EventSource = 'client' | 'mcp' | 'automation' | 'form' | 'undo';

export interface ChangeEvent {
  source: EventSource;
  userId: string;
  applied: AppliedChange[];
  changesetId?: string;
  /** Synthetic events appended after derivation (e.g. form.submitted). */
  extra?: SemanticEvent[];
}

interface CtxLike {
  waitUntil(p: Promise<unknown>): void;
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Deterministic outbox id → replay of the same write batch dedupes. */
export function outboxIdFor(ev: ChangeEvent): string {
  const seed =
    ev.source + '|' + (ev.changesetId ?? '') + '|' + ev.applied.map((a) => a.id + ':' + a.rev).join(',');
  return 'ev_' + fnv1a(seed);
}

/** Stage + schedule processing. Called from applyChanges post-commit. Never
 * awaited by callers: the durable row survives; processing is best-effort now,
 * guaranteed by the scheduled sweeper. */
export function emitChanges(env: { DB: D1Database }, ctx: CtxLike, ev: ChangeEvent): void {
  if (!ev.applied.length && !ev.extra?.length) return;
  const id = outboxIdFor(ev);
  const payload = JSON.stringify({
    source: ev.source,
    userId: ev.userId,
    changesetId: ev.changesetId ?? null,
    applied: ev.applied,
    extra: ev.extra ?? [],
  });
  const staged = env.DB.prepare(
    'INSERT OR IGNORE INTO event_outbox (id, payload, created_at) VALUES (?, ?, ?)'
  )
    .bind(id, payload, Date.now())
    .run();
  ctx.waitUntil(
    staged
      .then(() => processOutbox(env, id))
      .catch(() => {
        /* sweeper recovers */
      })
  );
}

interface OutboxRow {
  id: string;
  payload: string;
  attempts: number;
}

/** Process one outbox event: derive → date index → notify → automations
 * (skipped for automation-sourced events; depth-1 loop guard). Idempotent:
 * downstream writes use deterministic dedupe keys. */
export async function processOutbox(env: { DB: D1Database }, outboxId: string): Promise<void> {
  const row = await env.DB.prepare('SELECT id, payload, attempts, processed_at FROM event_outbox WHERE id = ?')
    .bind(outboxId)
    .first<OutboxRow & { processed_at: number | null }>();
  if (!row || row.processed_at !== null) return;

  const ev = JSON.parse(row.payload) as {
    source: EventSource;
    userId: string;
    changesetId: string | null;
    applied: AppliedLike[];
    extra?: SemanticEvent[];
  };

  try {
    const semantic = [...deriveEvents(ev.applied), ...(ev.extra ?? [])];
    await maintainDateIndex(env, ev.applied);
    await notificationsForEvent(env, semantic, { source: ev.source, userId: ev.userId });
    if (ev.source !== 'automation') {
      await runAutomationsForEvent(env, semantic, { source: ev.source, userId: ev.userId, outboxId });
    }
    await env.DB.prepare('UPDATE event_outbox SET processed_at = ? WHERE id = ?')
      .bind(Date.now(), outboxId)
      .run();
  } catch (err) {
    await env.DB.prepare('UPDATE event_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?')
      .bind(err instanceof Error ? err.message : String(err), outboxId)
      .run();
    throw err;
  }
}

/** Resync one changed record's date_index rows: drop stale, insert current
 * date-valued fields (builtin `dueDate` + any p_<fid> whose value is yyyy-mm-dd).
 * Deleted/archived rows are removed — reminders never fire on dead records. */
export async function maintainDateIndex(env: { DB: D1Database }, applied: AppliedLike[]): Promise<void> {
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const stmts: { q: string; b: unknown[] }[] = [];
  for (const ch of applied) {
    if (ch.collection !== 'tasks') continue;
    const dead = ch.after.deleted === true || ch.after.archived === true;
    stmts.push({ q: 'DELETE FROM date_index WHERE record_id = ?', b: [ch.id] });
    if (dead) continue;
    const after = ch.after;
    const add = (fieldKey: string, v: unknown) => {
      if (typeof v === 'string' && DATE.test(v)) {
        stmts.push({
          q: 'INSERT OR IGNORE INTO date_index (record_id, field_key, date) VALUES (?, ?, ?)',
          b: [ch.id, fieldKey, v],
        });
      }
    };
    add('dueDate', after.dueDate);
    for (const k of Object.keys(after)) {
      if (k.startsWith('p_')) add(k, after[k]);
    }
  }
  if (stmts.length) {
    await env.DB.batch(stmts.map((s) => env.DB.prepare(s.q).bind(...(s.b as never[]))));
  }
}

// Re-exported for fan-out implementers.
export { notify };
