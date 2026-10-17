// Phase 4 — notifications (Workstream B). Contract signatures are FIXED here;
// storage is the server-controlled `notifications` D1 table — never a synced
// collection, so generic sync can never mint, mark-read, or leak a row.
// Every query below is bound to the session user's own rows.

import { createReadGate } from './readAccess';
import { Hono } from 'hono';
import type { SemanticEvent } from '../shared/events';
import type { EventSource } from './events';
import { kindAllowed, loadPrefs, requireAuth, type Env, type AuthUser, type UserPrefs } from './auth';
import { recurrencesForEvent } from './reminders';
import { fnv1a64hex } from '../shared/linkid';

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
  /** One immutable key per logical delivery, preserved across all retries. */
  dedupeKey?: string;
}

export interface EventCtx {
  source: EventSource;
  userId: string;
  outboxId?: string;
}

const GROUP_WINDOW_MS = 30 * 60 * 1000;
const ITEMS_CAP = 20;
const LIST_CAP = 200;
const DEFAULT_LIMIT = 50;

/** Kinds that still bump the nav badge while quietDigest is on. The quiet
 * kinds (comments, reminders, form/automation output) still land in the
 * Inbox as unread — they just don't shout in the nav. */
export const URGENT_KINDS: readonly string[] = ['mention', 'assigned', 'approval_requested', 'approval_decided'];

export interface GroupItem {
  actorId?: string;
  at: number;
  summary: string;
}

/** Append one item to a group's `items` JSON array, capped at ITEMS_CAP most
 * recent. Pure — unit-tested (tests/notifications.test.ts). */
export function appendGroupItem(itemsJson: string | null | undefined, entry: GroupItem, cap = ITEMS_CAP): string {
  let items: GroupItem[] = [];
  if (itemsJson) {
    try {
      const parsed = JSON.parse(itemsJson) as unknown;
      if (Array.isArray(parsed)) items = parsed as GroupItem[];
    } catch {
      items = [];
    }
  }
  items.push(entry);
  return JSON.stringify(items.slice(-cap));
}

/** Which reminder kind a date_index row produces (pure, unit-tested). */
export function reminderKind(date: string, today: string, leadDays: number): 'due_soon' | 'overdue' | null {
  if (date < today) return 'overdue';
  // Lead counts calendar days ahead of today; today itself is "due soon".
  const upper = Date.parse(today + 'T00:00:00Z') + Math.max(0, Math.floor(leadDays)) * 86400000;
  return Date.parse(date + 'T00:00:00Z') <= upper ? 'due_soon' : null;
}

/** Insert (or group-update) one notification honoring per-user prefs.
 * Same (user_id, group_key) with an unread row <30min old → UPDATE the
 * existing row (count++, fresh title/body, items append capped at 20) —
 * never a pile of near-identical rows. */
export async function notify(env: { DB: D1Database }, n: NewNotification, transaction: D1PreparedStatement[] = []): Promise<void> {
  const user=await env.DB.prepare('SELECT id FROM users WHERE id=?').bind(n.userId).first();
  if(!user) return;
  const prefs = await loadPrefs(env.DB, n.userId);
  if (!kindAllowed(prefs, n.kind)) return;
  const now = Date.now();
  let id: string | undefined;
  if (n.groupKey) {
    const existing = await env.DB.prepare(
      `SELECT id, items, group_count,read_at FROM notifications
       WHERE user_id = ? AND group_key = ? AND created_at > ?
       ORDER BY (read_at IS NULL) DESC,created_at DESC LIMIT 1`,
    )
      .bind(n.userId, n.groupKey, now - GROUP_WINDOW_MS)
      .first<{ id: string; items: string | null; group_count: number;read_at:number|null }>();
    id=existing&&existing.read_at===null?existing.id:`ntf_${fnv1a64hex(JSON.stringify([n.userId,n.kind,n.groupKey,Math.floor(now/GROUP_WINDOW_MS),existing?.id??'',existing?.read_at??'']))}`;
  }
  id ??= n.dedupeKey ? `ntf_${fnv1a64hex(n.userId+'|'+n.dedupeKey)}` : `ntf_${crypto.randomUUID().replace(/-/g,'')}`;
  const key=n.dedupeKey ? n.userId+'|'+n.dedupeKey : crypto.randomUUID();
  const item=JSON.stringify({actorId:n.actorId,at:now,summary:n.body??n.title});
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO notification_deliveries(delivery_key,notification_id,created_at) VALUES(?,?,?)').bind(key,id,now),
    env.DB.prepare(
    `INSERT INTO notifications (id, user_id, kind, actor_id, target_type, target_id, title, body, url, group_key, group_count, items, read_at, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, json_array(json(?)), NULL, ? WHERE changes()=1
     ON CONFLICT(id) DO UPDATE SET group_count=notifications.group_count+1,
       title=excluded.title,body=excluded.body,url=excluded.url,actor_id=excluded.actor_id,
       items=(SELECT json_group_array(json(value)) FROM (SELECT value FROM json_each(json_insert(COALESCE(notifications.items,'[]'),'$[#]',json(?))) ORDER BY key DESC LIMIT ${ITEMS_CAP})),
       created_at=excluded.created_at,read_at=NULL`)
    .bind(id,n.userId,n.kind,n.actorId??null,n.targetType??null,n.targetId??null,n.title,n.body??null,n.url??null,n.groupKey??null,item,now,item),
    ...transaction,
  ]);
}

/* ---------- Event → recipient routing ---------- */

interface RecordLite {
  collection: string;
  data: Record<string, unknown>;
}

async function fetchRec(db: D1Database, id: string, cache: Map<string, RecordLite | null>): Promise<RecordLite | null> {
  if (cache.has(id)) return cache.get(id) ?? null;
  const row = await db.prepare('SELECT collection, data FROM records WHERE id = ?').bind(id).first<{ collection: string; data: string }>();
  let rec: RecordLite | null = null;
  if (row) {
    try {
      rec = { collection: row.collection, data: JSON.parse(row.data) as Record<string, unknown> };
    } catch {
      rec = null;
    }
  }
  cache.set(id, rec);
  return rec;
}

async function userName(db: D1Database, id: string | undefined, cache: Map<string, string>): Promise<string> {
  if (!id) return 'Someone';
  const hit = cache.get(id);
  if (hit) return hit;
  const row = await db.prepare('SELECT name FROM users WHERE id = ?').bind(id).first<{ name: string }>();
  const name = row?.name ?? 'Someone';
  cache.set(id, name);
  return name;
}

function titleOf(rec: RecordLite | null): string {
  const t = rec?.data?.title;
  return typeof t === 'string' && t.trim() ? t.trim() : '';
}

function excerpt(text: unknown, n = 140): string {
  if (typeof text !== 'string') return '';
  // Strip mention tokens down to readable text for the preview line.
  return text.replace(/@\[(?:user|page|rec):[A-Za-z0-9_-]+\]/g, '@…').replace(/\s+/g, ' ').trim().slice(0, n);
}

/** URL a notification deep-links to, based on the real stored collection of
 * the target (deriveEvents calls block parents 'page', but record bodies are
 * tasks rows). */
function urlFor(rec: RecordLite | null, id: string): string | undefined {
  if (!rec) return undefined;
  if (rec.collection === 'tasks') return `/tasks/${id}`;
  if (rec.collection === 'pages') return `/pages/${id}`;
  if (rec.collection === 'boards') return `/boards/${id}`;
  if (rec.collection === 'moodboards') return `/moodboards/${id}`;
  return undefined;
}

/** Route derived events to the right recipients. Per-event failures are
 * contained so one bad row can't kill the whole outbox batch. Recurrence
 * spawning rides this same fan-out (event-driven, not cron). */
export async function notificationsForEvent(
  env: { DB: D1Database },
  semantic: SemanticEvent[],
  ctx: EventCtx,
): Promise<void> {
  const actorId = ctx.userId;
  const recCache = new Map<string, RecordLite | null>();
  const nameCache = new Map<string, string>();
  const actor = () => userName(env.DB, actorId, nameCache);

  for (let index=0;index<semantic.length;index++) {
    const ev=semantic[index];
    const dedupeKey=`event:${ctx.outboxId??JSON.stringify(ev)}:${index}`;
      if (ev.kind === 'record.assigned') {
        const to = typeof ev.to === 'string' ? ev.to : '';
        if (!to || to === actorId) continue;
        const rec = await fetchRec(env.DB, ev.recordId, recCache);
        const t = titleOf(rec);
        await notify(env, {
          userId: to,
          kind: 'assigned',
          actorId,
          targetType: 'task',
          targetId: ev.recordId,
          title: `${await actor()} assigned you ${t ? `"${t}"` : 'a record'}`,
          body: t || undefined,
          url: `/tasks/${ev.recordId}`,
          groupKey: `assigned:${ev.recordId}`,
          dedupeKey,
        });
      } else if (ev.kind === 'comment.created') {
        // "on mine" = record assignee (documented simplification: no assignee → skip).
        if (ev.targetType !== 'task' || !ev.targetId) continue;
        const rec = await fetchRec(env.DB, ev.targetId, recCache);
        const assignee = rec?.data?.assigneeId;
        if (typeof assignee !== 'string' || !assignee || assignee === actorId) continue;
        const comment = await fetchRec(env.DB, ev.recordId, recCache);
        const t = titleOf(rec);
        await notify(env, {
          userId: assignee,
          kind: 'comment_on_mine',
          actorId,
          targetType: 'task',
          targetId: ev.targetId,
          title: `${await actor()} commented on ${t ? `"${t}"` : 'your record'}`,
          body: excerpt(comment?.data?.body) || undefined,
          url: `/tasks/${ev.targetId}`,
          groupKey: `comment:${ev.targetId}`,
          dedupeKey,
        });
      } else if (ev.kind === 'mention.created') {
        const uid = typeof ev.to === 'string' ? ev.to : '';
        if (!uid || uid === actorId) continue;
        let url: string | undefined;
        let t = '';
        if (ev.targetId) {
          const target = await fetchRec(env.DB, ev.targetId, recCache);
          t = titleOf(target);
          url = urlFor(target, ev.targetId);
        }
        const source = await fetchRec(env.DB, ev.recordId, recCache);
        const text = excerpt(source?.data?.text ?? source?.data?.body);
        await notify(env, {
          userId: uid,
          kind: 'mention',
          actorId,
          targetType: ev.targetType,
          targetId: ev.targetId,
          title: `${await actor()} mentioned you${t ? ` in "${t}"` : ''}`,
          body: text || undefined,
          url,
          groupKey: ev.targetId ? `mention:${ev.targetId}` : undefined,
          dedupeKey,
        });
      } else if(ev.kind==='form.submitted' && ev.formId) {
        const form=await fetchRec(env.DB,ev.formId,recCache);
        const rec=await fetchRec(env.DB,ev.recordId,recCache);
        const recipients=Array.isArray(form?.data.notifyUserIds)?form.data.notifyUserIds:[];
        for(const uid of new Set(recipients)) if(typeof uid==='string') await notify(env,{
          userId:uid,kind:'form_submission',targetType:'record',targetId:ev.recordId,
          title:`New submission: ${String(form?.data.title??'Form')}`,body:titleOf(rec),url:`/tasks/${ev.recordId}`,dedupeKey,
        });
      }
  }

  // Recurrence is event-driven: stage → done here spawns the next occurrence.
  await recurrencesForEvent(env, semantic, ctx);
}

/* ---------- Recipient-scoped REST API ---------- */

interface NotifRow {
  id: string;
  kind: string;
  actor_id: string | null;
  target_type: string | null;
  target_id: string | null;
  title: string;
  body: string | null;
  url: string | null;
  group_key: string | null;
  group_count: number;
  items: string | null;
  read_at: number | null;
  created_at: number;
}

function serialize(r: NotifRow) {
  let items: GroupItem[] = [];
  if (r.items) {
    try {
      const p = JSON.parse(r.items) as unknown;
      if (Array.isArray(p)) items = p as GroupItem[];
    } catch {
      items = [];
    }
  }
  return {
    id: r.id,
    kind: r.kind,
    actorId: r.actor_id,
    targetType: r.target_type,
    targetId: r.target_id,
    title: r.title,
    body: r.body,
    url: r.url,
    groupKey: r.group_key,
    groupCount: r.group_count,
    items,
    readAt: r.read_at,
    createdAt: r.created_at,
  };
}

/** Unread count honoring the user's quietDigest pref (quiet kinds still land
 * in the Inbox but don't count against the badge). */
export async function unreadBadge(db: D1Database, userId: string, prefs: UserPrefs): Promise<number> {
  if (prefs.quietDigest) {
    const row = await db
      .prepare(`SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL AND kind IN (${URGENT_KINDS.map(() => '?').join(',')})`)
      .bind(userId, ...URGENT_KINDS)
      .first<{ c: number }>();
    return row?.c ?? 0;
  }
  const row = await db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL').bind(userId).first<{ c: number }>();
  return row?.c ?? 0;
}

/** Recipient-scoped REST API (mounted at /api/notifications). Every query is
 * bound to the session user's own rows — no member ever reads another's
 * Inbox. */
export const notificationsApi = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
notificationsApi.use('*', requireAuth);

notificationsApi.get('/', async (c) => {
  const limit = Math.min(LIST_CAP, Math.max(1, Number(c.req.query('limit')) || DEFAULT_LIMIT));
  const before = Number(c.req.query('before')) || 0;
  const userId = c.get('user').id;
  let sql = `SELECT * FROM notifications WHERE user_id = ?`;
  const binds: (string | number)[] = [userId];
  if (before > 0) {
    sql += ' AND created_at < ?';
    binds.push(before);
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  binds.push(limit + 1);
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all<NotifRow>();
  const page = results.slice(0, limit);
  // Stored title/body/items are historical copies of record content. While permissions are
  // enabled each is shown only if the recipient can read its target NOW; otherwise a neutral
  // "Restricted item" row keeps the inbox order without the copy (design review §5).
  const decision = await createReadGate(c.env.DB, userId).decide(page.map((r) => r.target_id).filter((id): id is string => !!id));
  const shown = (r: NotifRow) => !decision.enabled || !r.target_id || decision.readable.has(r.target_id);
  return c.json({
    notifications: page.map((r) => (shown(r) ? serialize(r) : { ...serialize({ ...r, title: 'Restricted item', body: null, url: null, items: null }), targetId: null, restricted: true })),
    nextBefore: results.length > limit ? page[page.length - 1].created_at : null,
  });
});

notificationsApi.get('/badge', async (c) => {
  const user = c.get('user');
  const prefs = await loadPrefs(c.env.DB, user.id);
  return c.json({ unread: await unreadBadge(c.env.DB, user.id, prefs) });
});

notificationsApi.post('/:id/read', async (c) => {
  const user = c.get('user');
  const res = await c.env.DB.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL')
    .bind(Date.now(), c.req.param('id'), user.id)
    .run();
  if (!(res.meta.changes ?? 0)) {
    // Either not their row, unknown id, or already read — distinguish only own-row.
    const row = await c.env.DB.prepare('SELECT id FROM notifications WHERE id = ? AND user_id = ?').bind(c.req.param('id'), user.id).first();
    if (!row) return c.json({ error: 'not found' }, 404);
  }
  return c.json({ ok: true });
});

notificationsApi.post('/read-all', async (c) => {
  const res = await c.env.DB.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
    .bind(Date.now(), c.get('user').id)
    .run();
  return c.json({ ok: true, updated: res.meta.changes ?? 0 });
});
