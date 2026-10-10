// Phase 4 — reminders/deadlines/recurrence + cron sweeps (Workstream B).
// Contract signature is FIXED; the outbox sweep below is the shared
// reliability floor. Reminder dedupe is the `reminder_sent` table; recurrence
// is event-driven via recurrencesForEvent (called from notificationsForEvent).

import { processOutbox } from './events';
import { notify, reminderKind, type EventCtx } from './notifications';
import { addDays, isDone, nextDate, todayUtc, type Recurrence } from '../shared/recurrence';
import { linkId } from '../shared/linkid';
import { applyChanges } from './sync';
import { kindAllowed, loadPrefs, type Env, type UserPrefs } from './auth';
import type { SemanticEvent } from '../shared/events';
import type { Mutation } from '../shared/types';

const OUTBOX_BATCH = 20;
const OUTBOX_MAX_ATTEMPTS = 5;
const OUTBOX_STALE_MS = 60_000;

const DATE_INDEX_SCAN_CAP = 500;
/** Boards may configure a longer reminderLeadDays; the scan window must be
 * wider than any sane lead so custom leads aren't silently clipped. */
const MAX_LEAD_DAYS = 30;

const DAY = 86400000;
const RETENTION = {
  formSubmissionMs: 30 * DAY,
  readNotificationMs: 180 * DAY,
  reminderSentMs: 400 * DAY,
  orphanFormFileMs: 24 * 3600_000,
  automationRunsPer: 200,
};

interface StoredRec {
  id: string;
  collection: string;
  data: Record<string, unknown>;
}

async function fetchRecs(db: D1Database, ids: string[]): Promise<Map<string, StoredRec>> {
  const out = new Map<string, StoredRec>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    if (!chunk.length) continue;
    const { results } = await db
      .prepare(`SELECT id, collection, data FROM records WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk)
      .all<{ id: string; collection: string; data: string }>();
    for (const r of results) {
      try {
        out.set(r.id, { id: r.id, collection: r.collection, data: JSON.parse(r.data) as Record<string, unknown> });
      } catch {
        /* unparseable — treat as absent */
      }
    }
  }
  return out;
}

function boardColumns(board: StoredRec | undefined): { id: string }[] {
  const c = board?.data?.columns;
  return Array.isArray(c) ? (c as { id: string }[]) : [];
}

function leadDays(board: StoredRec | undefined): number {
  const v = board?.data?.reminderLeadDays;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(MAX_LEAD_DAYS, Math.floor(v)) : 1;
}

/** Person-typed custom field named owner/lead — the fallback reminder
 * recipient when a record has no assignee (§4 routing). */
function ownerFieldRecipient(record: Record<string, unknown>, board: StoredRec | undefined): string | null {
  const fields = board?.data?.fields;
  if (!Array.isArray(fields)) return null;
  for (const f of fields as { id?: string; name?: string; type?: string }[]) {
    if (f?.type !== 'person' || typeof f.id !== 'string' || typeof f.name !== 'string') continue;
    if (!/owner|lead/i.test(f.name)) continue;
    const v = record[`p_${f.id}`];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

function dueLabel(date: string, today: string): string {
  if (date === today) return 'today';
  if (date === addDays(today, 1)) return 'tomorrow';
  return `on ${date}`;
}

/** due_soon / overdue: scan the date index once per cron tick, dedupe through
 * reminder_sent, and notify the assignee (else owner/lead person field). */
async function runDueReminders(env: { DB: D1Database }, today: string): Promise<number> {
  const { results: rows } = await env.DB.prepare(
    `SELECT record_id, field_key, date FROM date_index WHERE date <= ? ORDER BY date LIMIT ?`,
  )
    .bind(addDays(today, MAX_LEAD_DAYS), DATE_INDEX_SCAN_CAP)
    .all<{ record_id: string; field_key: string; date: string }>();
  if (!rows.length) return 0;

  const recs = await fetchRecs(env.DB, [...new Set(rows.map((r) => r.record_id))]);
  const boardIds = new Set<string>();
  for (const r of recs.values()) boardIds.add(typeof r.data.boardId === 'string' ? r.data.boardId : 'board-default');
  const boards = await fetchRecs(env.DB, [...boardIds]);

  const prefsCache = new Map<string, UserPrefs>();
  const prefsFor = async (userId: string): Promise<UserPrefs> => {
    const hit = prefsCache.get(userId);
    if (hit) return hit;
    const p = await loadPrefs(env.DB, userId);
    prefsCache.set(userId, p);
    return p;
  };

  let sent = 0;
  for (const row of rows) {
    const rec = recs.get(row.record_id);
    if (!rec || rec.collection !== 'tasks') continue;
    if (rec.data.deleted === true || rec.data.archived === true) continue;
    const board = boards.get(typeof rec.data.boardId === 'string' ? rec.data.boardId : 'board-default');
    if (isDone(boardColumns(board), rec.data.status)) continue;

    const kind = row.date < today ? 'overdue' : reminderKind(row.date, today, leadDays(board));
    if (!kind) continue;

    const recipient = typeof rec.data.assignee === 'string' && rec.data.assignee ? rec.data.assignee : ownerFieldRecipient(rec.data, board);
    if (!recipient) continue;

    // Prefs before dedupe: an opted-out kind must not burn the reminder slot —
    // re-enabling it later should still fire while the window is open.
    if (!kindAllowed(await prefsFor(recipient), kind)) continue;

    // Dedupe before notify: the row lands or it doesn't — never notify twice.
    const ins = await env.DB.prepare(
      `INSERT OR IGNORE INTO reminder_sent (record_id, field_key, date, kind, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(row.record_id, row.field_key, row.date, kind, Date.now())
      .run();
    if (!(ins.meta.changes ?? 0)) continue;

    const title = titleOf(rec.data) || 'A record';
    await notify(env, {
      userId: recipient,
      kind,
      targetType: 'task',
      targetId: rec.id,
      title: kind === 'overdue' ? `"${title}" is overdue` : `"${title}" is due ${dueLabel(row.date, today)}`,
      body: `Due ${row.date}${row.field_key !== 'dueDate' ? ` (${row.field_key})` : ''}`,
      url: `/tasks/${rec.id}`,
    });
    sent++;
  }
  return sent;
}

function titleOf(data: Record<string, unknown>): string {
  const t = data.title;
  return typeof t === 'string' ? t.trim() : '';
}

/** Retention sweeps (§10): expired submissions, read notifications, ancient
 * dedupe rows, run history past 200/automation, orphan form-upload files. */
async function runRetention(env: { DB: D1Database }, now: number): Promise<void> {
  const db = env.DB;
  const stmts = [
    db.prepare('DELETE FROM form_submissions WHERE created_at < ?').bind(now - RETENTION.formSubmissionMs),
    db.prepare('DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < ?').bind(now - RETENTION.readNotificationMs),
    db.prepare('DELETE FROM reminder_sent WHERE created_at < ?').bind(now - RETENTION.reminderSentMs),
    db.prepare(
      `DELETE FROM automation_runs WHERE id NOT IN (
         SELECT id FROM automation_runs r2 WHERE r2.automation_id = automation_runs.automation_id
         ORDER BY created_at DESC LIMIT ${RETENTION.automationRunsPer})`,
    ),
  ];
  await db.batch(stmts).catch(() => {});

  // Orphan public-form uploads: 'form-pending' file records abandoned >24h.
  const { results: orphans } = await db
    .prepare(`SELECT id FROM records WHERE collection = 'files' AND json_extract(data, '$.parentType') = 'form-pending' AND updated_at < ?`)
    .bind(now - RETENTION.orphanFormFileMs)
    .all<{ id: string }>();
  for (const o of orphans) {
    await db
      .batch([
        db.prepare(`DELETE FROM records WHERE id = ?`).bind(o.id),
        db.prepare(`DELETE FROM files WHERE id = ?`).bind(o.id),
        db.prepare(`DELETE FROM file_chunks WHERE file_id = ?`).bind(o.id),
      ])
      .catch(() => {});
  }
}

/** Called by the cron scheduled() handler every 15 min:
 * 1) sweep unprocessed event_outbox rows (crash/waitUntil-kill recovery),
 * 2) due_soon + overdue reminders via date_index + reminder_sent dedupe,
 * 3) date_offset automation triggers,
 * 4) retention sweeps (rate_limits, stale submissions, old runs/notifs). */
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

  const today = todayUtc();
  // 2. due_soon / overdue via date_index + reminder_sent.
  await runDueReminders(env, today).catch(() => {});
  // 3. date_offset automation triggers (E's engine — fires date_offset
  // triggers only; synthetic field_changed events would misfire real
  // field-changed automations).
  const { runDateOffsetAutomations } = await import('./automations');
  await runDateOffsetAutomations(env as unknown as Env, today).catch(() => {});
  // 4. notification/run/submission/orphan-file retention sweeps.
  await runRetention(env, Date.now());
}

/* ---------- Recurrence (event-driven, §5) ---------- */

/**
 * Scan semantic events for stage → done transitions on records carrying a
 * `recurrence` field and spawn the next occurrence. Called from
 * notificationsForEvent (the event fan-out), for every write source —
 * including 'automation' (an automation completing a record spawns the next
 * one). Spawn ids are deterministic so replays collapse onto the same row.
 */
export async function recurrencesForEvent(env: { DB: D1Database }, semantic: SemanticEvent[], ctx: EventCtx): Promise<void> {
  const boardCache = new Map<string, StoredRec | null>();
  for (const ev of semantic) {
    if (ev.kind !== 'record.stage_changed') continue;
    try {
      const rec = await fetchRecs(env.DB, [ev.recordId]).then((m) => m.get(ev.recordId));
      if (!rec || rec.collection !== 'tasks') continue;
      const boardId = typeof rec.data.boardId === 'string' ? rec.data.boardId : 'board-default';
      if (!boardCache.has(boardId)) boardCache.set(boardId, (await fetchRecs(env.DB, [boardId])).get(boardId) ?? null);
      const board = boardCache.get(boardId);
      if (!isDone(boardColumns(board ?? undefined), ev.to)) continue;

      const recurrence = rec.data.recurrence as Recurrence | undefined;
      if (!recurrence || typeof recurrence !== 'object') continue;
      // From the record's own date when present, else today (spec §5.5).
      const srcDue = typeof rec.data.dueDate === 'string' ? rec.data.dueDate : todayUtc();
      const next = nextDate(recurrence, srcDue);
      if (!next) continue;
      await spawnNextOccurrence(env, ctx.userId, rec, board ?? null, next);
    } catch {
      /* a failed spawn must not poison the outbox event */
    }
  }
}

function columnsOf(board: StoredRec | null): { id: string }[] {
  const c = board?.data?.columns;
  return Array.isArray(c) ? (c as { id: string }[]) : [];
}

/**
 * Spawn the next occurrence of a completed recurring record: clone fields,
 * links and body blocks into `rec_<srcId>_<nextDue>` via one applyChanges
 * batch stamped source:'automation'. Deterministic ids make replays and
 * concurrent completions collapse onto the same row (replay-safe).
 */
export async function spawnNextOccurrence(
  env: { DB: D1Database },
  userId: string,
  src: StoredRec,
  board: StoredRec | null,
  nextDue: string,
): Promise<void> {
  const now = Date.now();
  const spawnId = `rec_${src.id}_${nextDue}`.slice(0, 64);
  const cols = columnsOf(board);

  const patch: Record<string, unknown> = { ...src.data };
  delete patch.deleted;
  delete patch.archived;
  delete patch.deletedVia;
  patch.status = cols[0]?.id ?? patch.status;
  patch.dueDate = nextDue;
  patch.recurrenceFrom = src.id;

  const mutations: Mutation[] = [{ id: spawnId, collection: 'tasks', patch, ts: now }];

  // Relation/dependency links the source participates in (both directions).
  const { results: links } = await env.DB.prepare(
    `SELECT id, data FROM records WHERE collection = 'links'
       AND COALESCE(json_extract(data, '$.deleted'), 0) != 1
       AND (json_extract(data, '$.fromId') = ? OR json_extract(data, '$.toId') = ?)`,
  )
    .bind(src.id, src.id)
    .all<{ id: string; data: string }>();
  for (const l of links) {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(l.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const fromId = d.fromId === src.id ? spawnId : d.fromId;
    const toId = d.toId === src.id ? spawnId : d.toId;
    if (typeof fromId !== 'string' || typeof toId !== 'string') continue;
    const kind = typeof d.kind === 'string' ? d.kind : 'relation';
    const fieldId = typeof d.fieldId === 'string' ? d.fieldId : null;
    mutations.push({
      id: linkId(kind, fieldId, fromId, toId),
      collection: 'links',
      patch: { ...d, fromId, toId, kind, fieldId },
      ts: now,
    });
  }

  // Body blocks (record pages / meeting agendas) — deterministic _b<i> ids
  // with any internal parent references remapped the same way.
  const { results: blocks } = await env.DB.prepare(
    `SELECT id, data FROM records WHERE collection = 'blocks' AND json_extract(data, '$.pageId') = ?
       AND COALESCE(json_extract(data, '$.deleted'), 0) != 1`,
  )
    .bind(src.id)
    .all<{ id: string; data: string }>();
  if (blocks.length) {
    const idMap = new Map<string, string>();
    blocks.forEach((b, i) => idMap.set(b.id, `rec_${src.id}_${nextDue}_b${i}`.slice(0, 64)));
    for (const b of blocks) {
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(b.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const np: Record<string, unknown> = { ...d, pageId: spawnId };
      if (typeof np.parentId === 'string' && idMap.has(np.parentId)) np.parentId = idMap.get(np.parentId);
      mutations.push({ id: idMap.get(b.id)!, collection: 'blocks', patch: np, ts: now });
    }
  }

  // Run inside processOutbox — there is no ExecutionContext here, so the
  // nested emit's waitUntil is captured and awaited inline instead.
  const nested: Promise<unknown>[] = [];
  const shimCtx = { waitUntil(p: Promise<unknown>) { nested.push(p); } };
  // applyChanges wants the full Env but only touches env.DB (+ event ctx);
  // the {DB} contract is what processOutbox threads down to us.
  await applyChanges(env as Parameters<typeof applyChanges>[0], userId, mutations, {
    serverTs: true,
    event: { source: 'automation', ctx: shimCtx },
  });
  await Promise.all(nested);
}
