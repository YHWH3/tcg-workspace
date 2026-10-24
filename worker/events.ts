// Phase 4 — unified server event pipeline.
// One emission point: applyChanges callers pass opts.event; we durably stage
// the event in event_outbox (same D1 transaction) and process it in
// waitUntil; the cron sweeper recovers unprocessed rows. All semantic events
// derive from successfully applied changes — never from client intentions.

import { processSearchDirty } from './search';
import { deriveEvents, type SemanticEvent, type AppliedLike } from '../shared/events';
import type { AppliedChange } from './sync';
import { notificationsForEvent, notify } from './notifications';
import type { NewNotification } from './notifications';
import { runAutomationsForEvent } from './automations';
import { fnv1a64hex } from '../shared/linkid';
import {hasD1Budget,D1BudgetExhausted,d1CleanupDatabase} from './d1budget';

export type EventSource = 'client' | 'mcp' | 'automation' | 'form' | 'undo' | 'website';

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

/** Deterministic outbox id → replay of the same write batch dedupes. */
export function outboxIdFor(ev: ChangeEvent): string {
  const seed =
    ev.source + '|' + (ev.changesetId ?? '') + '|' + ev.applied.map((a) => a.id + ':' + a.rev).join(',');
  return 'ev_' + fnv1a64hex(seed);
}

/** Must immediately follow its record CAS statement in the SAME batch.
 * SQLite changes() is zero for a missed CAS and one for a landed upsert.
 * The actual revision is read inside that transaction, before any other
 * writer can interleave. A failed event INSERT rolls back the record write. */
export function stageAppliedEvent(db: D1Database, ev: ChangeEvent, now: number): { id: string; statement: D1PreparedStatement } {
  const ch = ev.applied[0];
  const id = 'ev_' + fnv1a64hex(JSON.stringify([ev.source, ev.changesetId ?? '', ch.id,ch.rev, ch.fieldTs,ch.before,ch.after]));
  const payload = JSON.stringify({ ...ev, extra: ev.extra ?? [] });
  return {
    id,
    statement: db.prepare(`INSERT OR IGNORE INTO event_outbox (id, payload, created_at)
      SELECT ?, json_set(?, '$.applied[0].rev', seq), ? FROM records
      WHERE id = ? AND changes() = 1`).bind(id, payload, now, ch.id),
  };
}

/** Scheduling is optional acceleration; persistence has already committed. */
export function scheduleOutbox(env: { DB: D1Database }, ctx: CtxLike | undefined, ids: string[]): void {
  if (!ctx) return;
  ctx.waitUntil((async () => {
    for (const id of ids) {
      if(!hasD1Budget(env.DB,18))break;
      try { await processOutbox(env, id); } catch { /* durable retry by Cron */ }
    }
  })());
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
  const lease=crypto.randomUUID(),now=Date.now();
  const row = await env.DB.prepare(`UPDATE event_outbox SET lease_id=?,lease_until=?,attempts=attempts+1
    WHERE id=? AND processed_at IS NULL AND terminal_at IS NULL AND COALESCE(lease_until,0)<=? AND attempts<8
    RETURNING id,payload,attempts`).bind(lease,now+60_000,outboxId,now).first<OutboxRow>();
  if (!row) return;

  const ev = JSON.parse(row.payload) as {
    source: EventSource;
    userId: string;
    changesetId: string | null;
    applied: AppliedLike[];
    extra?: SemanticEvent[];
    notifications?:NewNotification[];
  };

  try {
    const semantic = [...deriveEvents(ev.applied), ...(ev.extra ?? [])];
    await maintainDateIndex(env, ev.applied);
    await notificationsForEvent(env, semantic, { source: ev.source, userId: ev.userId, outboxId });
    for(const notification of ev.notifications??[]) await notify(env,notification);
    if (ev.source !== 'automation') {
      await runAutomationsForEvent(env, semantic, { source: ev.source, userId: ev.userId, outboxId });
    }
    await env.DB.prepare('UPDATE event_outbox SET processed_at=?,last_error=NULL,lease_id=NULL,lease_until=NULL WHERE id=? AND lease_id=?')
      .bind(Date.now(), outboxId,lease)
      .run();
    // Search freshness: rebuild one bounded chunk of dirty documents (the triggers already
    // marked this write's documents). Best effort — the cron drains whatever remains, and
    // queries match dirty documents live in the meantime.
    if(hasD1Budget(env.DB,8)) await processSearchDirty(env).catch(()=>{});
  } catch (err) {
    if(err instanceof D1BudgetExhausted) {
      await d1CleanupDatabase(env.DB).prepare('UPDATE event_outbox SET attempts=MAX(0,attempts-1),last_error=?,lease_id=NULL,lease_until=NULL WHERE id=? AND lease_id=?').bind(err.message,outboxId,lease).run();
      throw err;
    }
    await env.DB.prepare('UPDATE event_outbox SET last_error=?,terminal_at=?,lease_id=NULL,lease_until=NULL WHERE id=? AND lease_id=?')
      .bind(err instanceof Error ? err.message : String(err),row.attempts>=8?Date.now():null,outboxId,lease)
      .run();
    throw err;
  }
}

/** Resync one changed record's date_index rows: drop stale, insert current
 * date-valued fields (builtin `dueDate` + any p_<fid> whose value is yyyy-mm-dd).
 * Deleted/archived rows are removed — reminders never fire on dead records. */
export async function maintainDateIndex(env: { DB: D1Database }, applied: AppliedLike[], force=false): Promise<void> {
  const ids = new Set<string>();
  for (const ch of applied) {
    if (ch.collection === 'tasks' && (force || ch.created || ch.fields.some(k=>k==='dueDate'||k.startsWith('p_')||['boardId','deleted','archived'].includes(k)))) ids.add(ch.id);
    if (ch.collection === 'boards' && ch.fields.some(k=>['fields','deleted','archived'].includes(k))) {
      const {results}=await env.DB.prepare(`SELECT id FROM records WHERE collection='tasks' AND COALESCE(json_extract(data,'$.boardId'),'board-default')=?`).bind(ch.id).all<{id:string}>();
      for(const r of results) ids.add(r.id);
    }
  }
  // Read and rebuild inside the same transaction. No stale JS snapshot can
  // overwrite a concurrent deadline edit, and sparse events are harmless.
  // Many records share one binding call: each call spends the invocation's
  // D1 budget, so one batch per record could never finish a board with more
  // than ~40 tasks (the event retried the same prefix forever).
  const rebuild = (id: string): D1PreparedStatement[] => [
    env.DB.prepare('DELETE FROM date_index WHERE record_id=?').bind(id),
    env.DB.prepare(`INSERT OR IGNORE INTO date_index(record_id,field_key,date)
        SELECT id, field_key, value FROM (
          SELECT t.id, 'dueDate' AS field_key, json_extract(t.data,'$.dueDate') AS value
          FROM records t LEFT JOIN records b ON b.id=COALESCE(json_extract(t.data,'$.boardId'),'board-default') AND b.collection='boards'
          WHERE t.id=? AND t.collection='tasks' AND COALESCE(json_extract(t.data,'$.deleted'),0)!=1 AND COALESCE(json_extract(t.data,'$.archived'),0)!=1
            AND COALESCE(json_extract(b.data,'$.deleted'),0)!=1 AND COALESCE(json_extract(b.data,'$.archived'),0)!=1
          UNION ALL
          SELECT t.id, 'p_'||json_extract(f.value,'$.id'), json_extract(t.data,'$.p_'||json_extract(f.value,'$.id'))
          FROM records t JOIN records b ON b.id=COALESCE(json_extract(t.data,'$.boardId'),'board-default') AND b.collection='boards'
          JOIN json_each(b.data,'$.fields') f
          WHERE t.id=? AND t.collection='tasks' AND json_extract(f.value,'$.type')='date'
            AND COALESCE(json_extract(t.data,'$.deleted'),0)!=1 AND COALESCE(json_extract(t.data,'$.archived'),0)!=1
            AND COALESCE(json_extract(b.data,'$.deleted'),0)!=1 AND COALESCE(json_extract(b.data,'$.archived'),0)!=1
        ) WHERE typeof(value)='text' AND length(value)=10 AND value GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(value)=value`).bind(id, id),
  ];
  const all = [...ids];
  for (let i = 0; i < all.length; i += REINDEX_IDS_PER_BATCH) {
    await env.DB.batch(all.slice(i, i + REINDEX_IDS_PER_BATCH).flatMap(rebuild));
  }
}

/** Records rebuilt per D1 binding call (two statements each). */
const REINDEX_IDS_PER_BATCH = 50;

// Re-exported for fan-out implementers.
export { notify };
