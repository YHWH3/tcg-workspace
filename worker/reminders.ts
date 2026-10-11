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
import { beginChangeset } from './changesets';
import { fnv1a64hex } from '../shared/linkid';
import {hasD1Budget,d1BudgetRemaining,D1BudgetExhausted} from './d1budget';

const OUTBOX_BATCH = 20;
const OUTBOX_STALE_MS = 60_000;

const DATE_INDEX_SCAN_CAP = 250;
const REMINDER_DELIVERY_CAP = 4;
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

type SweepCursor = { date: string; record_id: string; field_key: string };
type DateHit = { record_id: string; field_key: string; date: string };

/** Unsent date-index rows after `after`, on or before `through`, optionally not past `until`. */
async function unsentDateHits(env: { DB: D1Database }, today: string, after: SweepCursor, until: SweepCursor | null, limit: number, through = addDays(today, MAX_LEAD_DAYS)): Promise<DateHit[]> {
  const sql = `SELECT d.record_id, d.field_key, d.date FROM date_index d
      WHERE d.date<=? AND (d.date,d.record_id,d.field_key)>(?,?,?)
      ${until ? 'AND (d.date,d.record_id,d.field_key)<=(?,?,?)' : ''}
      AND NOT EXISTS(SELECT 1 FROM reminder_sent s WHERE s.record_id=d.record_id AND s.field_key=d.field_key AND s.date=d.date
        AND s.kind=CASE WHEN d.date<? THEN 'overdue' ELSE 'due_soon' END)
      ORDER BY d.date,d.record_id,d.field_key LIMIT ?`;
  const binds = until
    ? [through, after.date, after.record_id, after.field_key, until.date, until.record_id, until.field_key, today, limit]
    : [through, after.date, after.record_id, after.field_key, today, limit];
  return (await env.DB.prepare(sql).bind(...binds).all<DateHit>()).results;
}

/**
 * due_soon / overdue. The forward cursor keeps completed prefixes from being
 * reread. One lookbehind page per run, stored as `reminders-behind`, picks up
 * a date that sorts before that cursor (a new or rescheduled urgent task)
 * without resetting the forward cursor. Already-sent keys stay in
 * reminder_sent, so the same logical reminder is not delivered twice.
 * Lookbehind shares the delivery cap and runs before the forward page.
 * Already-sent rows are excluded. A new earlier row is sent on the next run
 * when fewer than REMINDER_DELIVERY_CAP unsent rows sort before it. Otherwise
 * it is sent within ceil((unsent rows before it + 1) / REMINDER_DELIVERY_CAP)
 * runs when those earlier rows are themselves deliverable. Undeliverable rows
 * do not use a delivery slot, so a full lookbehind page advances
 * REMINDER_BEHIND_CAP rows. A row inside the 30-day scan but outside the board
 * lead is not due yet and does not advance `reminders-behind`; a sustained
 * not-yet-due tail must not hide a newer earlier reminder. Overdue and
 * due-today rows are also read on `reminders-due`, which excludes that tail.
 * A skipped row (no recipient, or the recipient opted out) is not written to
 * reminder_sent. An empty forward page does not
 * discard a full lookbehind page: that scan is still unfinished. The backward
 * cursor is cleared only after a short page is fully examined, which is the
 * end of this pass. The next pass then starts at the beginning, so a newly
 * inserted earlier date or a row that became eligible is included without
 * rereading the same undeliverable prefix on every tick. Later backlog does
 * not reset the forward cursor.
 */
export const REMINDER_BEHIND_CAP = 40;

export async function runDueReminders(env: { DB: D1Database }, today: string): Promise<number> {
  const cursor=await env.DB.prepare("SELECT date,record_id,field_key FROM rhythm_sweep_cursors WHERE name='reminders'").first<SweepCursor>();
  const behindCursor=await env.DB.prepare("SELECT date,record_id,field_key FROM rhythm_sweep_cursors WHERE name='reminders-behind'").first<SweepCursor>();
  const dueCursor=await env.DB.prepare("SELECT date,record_id,field_key FROM rhythm_sweep_cursors WHERE name='reminders-due'").first<SweepCursor>();
  const behindStart: SweepCursor = behindCursor ?? { date: '', record_id: '', field_key: '' };
  const dueStart: SweepCursor = dueCursor ?? { date: '', record_id: '', field_key: '' };
  const dueRows = await unsentDateHits(env, today, dueStart, null, REMINDER_BEHIND_CAP, today);
  const behindRows = cursor
    ? await unsentDateHits(env, today, behindStart, cursor, REMINDER_BEHIND_CAP)
    : [];
  const rows = await unsentDateHits(env, today, { date: cursor?.date ?? '', record_id: cursor?.record_id ?? '', field_key: cursor?.field_key ?? '' }, null, DATE_INDEX_SCAN_CAP);
  if (!rows.length && !behindRows.length && !dueRows.length) {
    await env.DB.prepare("DELETE FROM rhythm_sweep_cursors WHERE name='reminders'").run();
    await env.DB.prepare("DELETE FROM rhythm_sweep_cursors WHERE name='reminders-behind'").run();
    await env.DB.prepare("DELETE FROM rhythm_sweep_cursors WHERE name='reminders-due'").run();
    return 0;
  }

  const recs = await fetchRecs(env.DB, [...new Set([...dueRows, ...behindRows, ...rows].map((r) => r.record_id))]);
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
  /** Returns false when the page stopped early. The cursor stays on the last examined row. */
  const deliver = async (batch: DateHit[], cursorName: string | null): Promise<boolean> => {
    let lastSeen: DateHit | null = null;
    let finished = true;
    for (const row of batch) {
      if (sent >= REMINDER_DELIVERY_CAP || !hasD1Budget(env.DB, 8)) { finished = false; break; }
      const rec = recs.get(row.record_id);
      if (!rec || rec.collection !== 'tasks' || rec.data.deleted === true || rec.data.archived === true) {
        lastSeen = row;
        continue;
      }
      const board = boards.get(typeof rec.data.boardId === 'string' ? rec.data.boardId : 'board-default');
      if (isDone(boardColumns(board), rec.data.status)) {
        lastSeen = row;
        continue;
      }

      const kind = row.date < today ? 'overdue' : reminderKind(row.date, today, leadDays(board));
      if (!kind) {
        if (cursorName === 'reminders') lastSeen = row;
        continue;
      }
      lastSeen = row;

      const recipient = typeof rec.data.assigneeId === 'string' && rec.data.assigneeId ? rec.data.assigneeId : ownerFieldRecipient(rec.data, board);
    if (!recipient) continue;

    // Prefs before dedupe: an opted-out kind must not burn the reminder slot —
    // re-enabling it later should still fire while the window is open.
    if (!kindAllowed(await prefsFor(recipient), kind)) continue;

    // Dedupe before notify: the row lands or it doesn't — never notify twice.
    const title = titleOf(rec.data) || 'A record';
    await notify(env, {
      userId: recipient,
      kind,
      targetType: 'task',
      targetId: rec.id,
      title: kind === 'overdue' ? `"${title}" is overdue` : `"${title}" is due ${dueLabel(row.date, today)}`,
      body: `Due ${row.date}${row.field_key !== 'dueDate' ? ` (${row.field_key})` : ''}`,
      url: `/tasks/${rec.id}`,
      dedupeKey:`reminder:${row.record_id}:${row.field_key}:${row.date}:${kind}`,
    },[env.DB.prepare('INSERT OR IGNORE INTO reminder_sent(record_id,field_key,date,kind,created_at) VALUES(?,?,?,?,?)').bind(row.record_id,row.field_key,row.date,kind,Date.now())]);
      sent++;
    }
    if (cursorName && lastSeen) {
      await env.DB.prepare("INSERT INTO rhythm_sweep_cursors(name,date,record_id,field_key) VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET date=excluded.date,record_id=excluded.record_id,field_key=excluded.field_key").bind(cursorName, lastSeen.date, lastSeen.record_id, lastSeen.field_key).run();
    }
    return finished;
  };
  if (dueRows.length) await deliver(dueRows, 'reminders-due');
  else await env.DB.prepare("DELETE FROM rhythm_sweep_cursors WHERE name='reminders-due'").run();
  let behindFinished = true;
  if (behindRows.length) behindFinished = await deliver(behindRows, 'reminders-behind');
  else if (cursor) await env.DB.prepare("DELETE FROM rhythm_sweep_cursors WHERE name='reminders-behind'").run();
  if (rows.length) await deliver(rows, 'reminders');
  else if (behindFinished && behindRows.length < REMINDER_BEHIND_CAP) {
    await env.DB.prepare("DELETE FROM rhythm_sweep_cursors WHERE name='reminders'").run();
    await env.DB.prepare("DELETE FROM rhythm_sweep_cursors WHERE name='reminders-behind'").run();
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
    db.prepare("DELETE FROM form_submissions WHERE state IN ('accepted','rejected') AND created_at < ?").bind(now - RETENTION.formSubmissionMs),
    db.prepare('DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < ?').bind(now - RETENTION.readNotificationMs),
    db.prepare('DELETE FROM reminder_sent WHERE created_at < ?').bind(now - RETENTION.reminderSentMs),
    db.prepare(
      `DELETE FROM automation_runs WHERE id NOT IN (
         SELECT id FROM automation_runs r2 WHERE r2.automation_id = automation_runs.automation_id
         ORDER BY created_at DESC LIMIT ${RETENTION.automationRunsPer}) AND status IN ('completed','terminal_failure')`,
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
  const events=async()=>{
    const { results: pending } = await env.DB.prepare(
    'SELECT id FROM event_outbox INDEXED BY idx_outbox_pending WHERE processed_at IS NULL AND terminal_at IS NULL AND created_at < ? AND COALESCE(lease_until,0)<=? ORDER BY created_at LIMIT ?'
  )
    .bind(Date.now() - OUTBOX_STALE_MS,Date.now(), OUTBOX_BATCH)
    .all<{ id: string }>();
  for (const row of pending) {
    if(!hasD1Budget(env.DB,18))break;
    try {
      await processOutbox(env, row.id);
    } catch {
      /* attempts recorded by processOutbox; retry next run */
    }
  }
  // Retention: drop processed outbox + stale rate-limit rows.
  await env.DB.prepare('UPDATE event_outbox SET terminal_at=? WHERE processed_at IS NULL AND terminal_at IS NULL AND attempts>=8 AND COALESCE(lease_until,0)<=?').bind(Date.now(),Date.now()).run();
  await env.DB.prepare('DELETE FROM event_outbox WHERE processed_at IS NOT NULL AND processed_at<?').bind(Date.now()-30*DAY).run();
  await env.DB.prepare('DELETE FROM rate_limits WHERE reset_at < ?').bind(Date.now()).run().catch(() => {});
  };
  const today = todayUtc();
  const { runDateOffsetAutomations,recoverAutomationRuns } = await import('./automations');
  const {recoverFormSubmissions}=await import('./forms');
  const phases:{minimum:number;run:()=>Promise<unknown>}[]=[
    {minimum:18,run:events},
    {minimum:18,run:()=>runDueReminders(env,today)},
    {minimum:24,run:()=>recoverAutomationRuns(env)},
    {minimum:28,run:async()=>{const nested:Promise<unknown>[]=[];await recoverFormSubmissions(env as Env,{waitUntil:p=>nested.push(p)});await Promise.all(nested);}},
    {minimum:24,run:()=>runDateOffsetAutomations(env as Env,today)},
    {minimum:10,run:()=>runRetention(env,Date.now())},
  ];
  // Each scheduled invocation has its own budget. Rotate the first phase
  // every 15-minute slot so a sustained event backlog cannot starve receipts,
  // automation retries, reminders or retention indefinitely. Plain test
  // bindings retain the historical ordering unless explicitly budgeted.
  const offset=d1BudgetRemaining(env.DB)===Infinity?0:Math.floor(Date.now()/900_000)%phases.length;
  for(const phase of [...phases.slice(offset),...phases.slice(0,offset)]) {
    if(!hasD1Budget(env.DB,phase.minimum))continue;
    try {await phase.run();}catch(error){if(error instanceof D1BudgetExhausted)return;throw error;}
  }
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
  const spawnId = `rec_${fnv1a64hex(src.id+'|'+nextDue)}`;
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
       AND COALESCE(json_extract(data, '$.deleted'), 0) != 1 ORDER BY id`,
  )
    .bind(src.id)
    .all<{ id: string; data: string }>();
  if (blocks.length) {
    const idMap = new Map<string, string>();
    blocks.forEach((b, i) => idMap.set(b.id,`${spawnId}_b${i}`));
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
  const cs=beginChangeset({userId,tool:'recurrence',source:'automation',summary:'Create next recurring record'});cs.id=`cs_${spawnId}`;
  const result=await applyChanges(env as Parameters<typeof applyChanges>[0], userId, mutations, {
    serverTs: true,
    atomic:true,createOnly:new Set(mutations.map(m=>m.id)),journal:cs,
    event: { source: 'automation', ctx: shimCtx,changesetId:cs.id },
  });
  if(result.partialError||result.rejected||result.conflict||result.conflicts?.length) throw new Error(result.partialError??'recurrence write rejected');
  await Promise.all(nested);
}
