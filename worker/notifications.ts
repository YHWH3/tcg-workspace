// Phase 4 — notifications (Workstream B). Contract signatures are FIXED here;
// storage is the server-controlled `notifications` D1 table — never a synced
// collection, so generic sync can never mint, mark-read, or leak a row.
// Every query below is bound to the session user's own rows.

import { levelSql } from './capability';
import { loadScopeGraph, scopeParentsSql } from './recordAccess';
import { scopeResolver } from '../shared/recordScope';
import { createReadGate } from './readAccess';
import { Hono } from 'hono';
import type { SemanticEvent } from '../shared/events';
import type { EventSource } from './events';
import { channelsFor, kindAllowed, loadPrefs, parsePrefs, requireAuth, type Env, type AuthUser, type UserPrefs } from './auth';
import { sendNotificationEmails } from './notificationEmail';
import { notificationEmailOrigin, type EmailEnv } from './email';
import { recurrencesForEvent } from './reminders';
import { fnv1a64hex } from '../shared/linkid';
import {pushMode,type PushEnv} from './webpush';

export interface NewNotification {
  userId: string;
  kind:
    | 'mention'
    | 'assigned'
    | 'comment_on_mine'
    | 'comment_resolved'
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
  ctx?: Pick<ExecutionContext, 'waitUntil'>;
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
  targetId?: string;
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
export async function notify(env: { DB: D1Database } & EmailEnv & PushEnv, n: NewNotification, transaction: D1PreparedStatement[] = [], ctx?: Pick<ExecutionContext, 'waitUntil'>): Promise<void> {
  const user=await env.DB.prepare('SELECT id,(SELECT enabled FROM access_state WHERE id=1) enabled FROM users WHERE id=? AND disabled_at IS NULL').bind(n.userId).first<{id:string;enabled:number}>();
  if(!user) return;
  const prefs = await loadPrefs(env.DB, n.userId);
  if (!kindAllowed(prefs, n.kind)) return;
  // Capture the ownership graph, then fence its revisions and the recipient's
  // current memberships inside the SAME insert statement. No private copy is
  // persisted if a move/revoke lands after preflight.
  let guard=`EXISTS(SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL)`,guardBinds:unknown[]=[n.userId];
  if(user.enabled===1){
    if(!n.targetId)return;
    const graph=await loadScopeGraph(env.DB,[n.targetId]);let scope;
    try{scope=scopeResolver(graph.records)(n.targetId);}catch{return;}
    if(scope.serviceOnly||scope.ancestorDeleted||graph.records.get(n.targetId)?.data.deleted===true)return;
    guard+=` AND (SELECT enabled FROM access_state WHERE id=1)=1 AND NOT EXISTS(SELECT 1 FROM json_each(?) scope WHERE ${levelSql('?', 'scope.value')}<1)
      AND NOT EXISTS(SELECT 1 FROM json_each(?) rev WHERE NOT EXISTS(SELECT 1 FROM records r WHERE r.id=rev.key AND r.seq=rev.value))`;
    guardBinds.push(JSON.stringify(scope.readSpaceIds),n.userId,JSON.stringify(Object.fromEntries([...graph.records].map(([id,r])=>[id,r.rev]))));
  }else guard+=' AND (SELECT enabled FROM access_state WHERE id=1)=0';
  if(user.enabled===1 && !await env.DB.prepare(`SELECT 1 WHERE ${guard}`).bind(...guardBinds).first())return;
  const now = Date.now();
  let existing: NotificationGroup | null = null;
  if (n.groupKey) {
    existing = await env.DB.prepare(
      `SELECT id, items, group_count,read_at FROM notifications
       WHERE user_id = ? AND group_key = ? AND created_at > ? AND target_id IS ?
       ORDER BY (read_at IS NULL) DESC,created_at DESC LIMIT 1`,
    )
      .bind(n.userId, n.groupKey, now - GROUP_WINDOW_MS,n.targetId??null)
      .first<{ id: string; items: string | null; group_count: number;read_at:number|null }>();
  }
  const {statements, emailId} = notificationStatements(env, n, prefs, guard, guardBinds, existing, now);
  await env.DB.batch([...statements, ...transaction]);
  if (emailId && ctx && (n.kind === 'mention' || n.kind === 'approval_requested')) {
    ctx.waitUntil(sendNotificationEmails(env, emailId).catch(() => {
      console.warn('Immediate notification email deferred to scheduled delivery');
    }));
  }
}

interface NotificationGroup {id: string; items: string | null; group_count: number; read_at: number | null}
/** One builder for ordinary and batched Space deliveries. No I/O here. */
function notificationStatements(env: {DB: D1Database} & EmailEnv & PushEnv, n: NewNotification, prefs: UserPrefs,
  guard: string, guardBinds: unknown[], existing: NotificationGroup | null, now: number) {
  let id: string | undefined;
  if (n.groupKey) {
    id=existing&&existing.read_at===null?existing.id:`ntf_${fnv1a64hex(JSON.stringify([n.userId,n.kind,n.groupKey,n.targetId??'',Math.floor(now/GROUP_WINDOW_MS),existing?.id??'',existing?.read_at??'']))}`;
  }
  id ??= n.dedupeKey ? `ntf_${fnv1a64hex(n.userId+'|'+n.dedupeKey)}` : `ntf_${crypto.randomUUID().replace(/-/g,'')}`;
  const key=n.dedupeKey ? n.userId+'|'+n.dedupeKey : crypto.randomUUID();
  const item=JSON.stringify({actorId:n.actorId,at:now,summary:n.body??n.title,targetId:n.targetId});
  const emailId = notificationEmailOrigin(env) && channelsFor(prefs, n.kind).has('email') ? 'email_' + fnv1a64hex(key) : null;
  const pushId = pushMode(env) && channelsFor(prefs,n.kind).has('push') ? 'push_' + fnv1a64hex(key) : null;
  const statements = [
    // Abort the whole batch on a raced authority change: caller checkpoints must
    // never commit when delivery was refused by the insert fence.
    env.DB.prepare(`SELECT CASE WHEN ${guard} THEN 1 ELSE json_extract('{','$') END`).bind(...guardBinds),
    env.DB.prepare(`INSERT OR IGNORE INTO notification_deliveries(delivery_key,notification_id,created_at) SELECT ?,?,? WHERE ${guard}`).bind(key,id,now,...guardBinds),
    env.DB.prepare(
    `INSERT INTO notifications (id, user_id, kind, actor_id, target_type, target_id, title, body, url, group_key, group_count, items, read_at, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, json_array(json(?)), NULL, ? WHERE changes()=1
     ON CONFLICT(id) DO UPDATE SET group_count=notifications.group_count+1,
       title=excluded.title,body=excluded.body,url=excluded.url,actor_id=excluded.actor_id,
       items=(SELECT json_group_array(json(value)) FROM (SELECT value FROM json_each(json_insert(COALESCE(notifications.items,'[]'),'$[#]',json(?))) ORDER BY key DESC LIMIT ${ITEMS_CAP})),
       created_at=excluded.created_at,read_at=NULL`)
    .bind(id,n.userId,n.kind,n.actorId??null,n.targetType??null,n.targetId??null,n.title,n.body??null,n.url??null,n.groupKey??null,item,now,item),
    ...(emailId || pushId ? [env.DB.prepare(`
      INSERT OR IGNORE INTO email_outbox(id,user_id,kind,notification_id,target_id,verified_at,created_at,next_attempt_at,push_subscription_id)
      SELECT ?,id,?,?,?,email_verified_at,?,?,NULL FROM users WHERE id=? AND changes()=1 AND disabled_at IS NULL
        AND ? IS NOT NULL
        AND email_verified_at IS NOT NULL AND email IS NOT NULL
        AND EXISTS(SELECT 1 FROM json_each(prefs,?) WHERE value='email')
      UNION ALL
      SELECT ?||'_'||p.id,u.id,?,?,?,0,?,?,p.id FROM push_subscriptions p JOIN users u ON u.id=p.user_id
      JOIN sessions s ON s.token_hash=p.session_hash AND s.user_id=u.id
      WHERE ? IS NOT NULL AND u.id=? AND u.disabled_at IS NULL AND s.expires_at>? AND changes()=1
        AND EXISTS(SELECT 1 FROM json_each(u.prefs,?) WHERE value='push')`
    ).bind(emailId,n.kind,id,n.targetId??null,now,now,n.userId,emailId,'$.notifications.'+n.kind,
      pushId,'push:'+n.kind,id,n.targetId??null,now,now,pushId,n.userId,now,'$.notifications.'+n.kind)] : []),
  ];
  return {statements, emailId};
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
  return text.replace(/@\[(?:user|page|rec|group):[A-Za-z0-9_-]+\]/g, '@…').replace(/\s+/g, ' ').trim().slice(0, n);
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

  const spaceSources = new Map<string, SemanticEvent[]>();
  for (const event of semantic) if (event.kind === 'mention.created' && event.groupId) spaceSources.set(event.recordId, []);
  for (const event of semantic) if (event.kind === 'mention.created' && spaceSources.has(event.recordId)) spaceSources.get(event.recordId)!.push(event);
  for (const events of spaceSources.values()) await notifySpaceMentions(env, events, semantic, ctx);

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
      } else if (ev.kind === 'comment.resolved') {
        if (!ev.targetId || !ev.targetType) continue;
        const target = await fetchRec(env.DB, ev.targetId, recCache);
        const title = titleOf(target);
        const participants = await env.DB.prepare(`SELECT DISTINCT json_extract(data,'$.authorId') AS author_id FROM records WHERE collection='comments' AND json_extract(data,'$.targetId')=? AND COALESCE(json_extract(data,'$.deleted'),0) != 1`).bind(ev.targetId).all<{ author_id: string | null }>();
        for (const participant of participants.results) {
          const uid = participant.author_id;
          if (typeof uid !== 'string' || !uid || uid === actorId) continue;
          await notify(env, {
            userId: uid,
            kind: 'comment_resolved',
            actorId,
            targetType: ev.targetType,
            targetId: ev.targetId,
            title: `${await actor()} resolved comments${title ? ` on "${title}"` : ''}`,
            body: title || undefined,
            url: urlFor(target, ev.targetId),
            groupKey: `comment-resolved:${ev.targetId}`,
            dedupeKey,
          });
        }
      } else if (ev.kind === 'mention.created') {
        if (spaceSources.has(ev.recordId)) continue;
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
        }, [], ctx.ctx);
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

/** One source record per durable applied event. Constant binding calls for up to
 * 20 recipients; canonical membership and both source/target revisions are fenced
 * again inside the same transaction as receipts and channel outboxes. */
async function notifySpaceMentions(env: {DB: D1Database} & EmailEnv & PushEnv, events: SemanticEvent[], semantic: SemanticEvent[], ctx: EventCtx) {
  const first = events[0], targetId = first.targetId;
  if (!targetId || events.some(event => event.targetId !== targetId)) return;
  const graph = await loadScopeGraph(env.DB, [first.recordId, targetId]);
  const resolve = scopeResolver(graph.records);
  let sourceScope, targetScope;
  try {sourceScope = resolve(first.recordId); targetScope = resolve(targetId);} catch {return;}
  if ([sourceScope, targetScope].some(scope => scope.serviceOnly || scope.ancestorDeleted)
    || graph.records.get(first.recordId)?.data.deleted === true || graph.records.get(targetId)?.data.deleted === true) return;
  const groups = [...new Set(events.flatMap(event => event.groupId ? [event.groupId] : []))];
  const direct = events.filter(event => !event.groupId && typeof event.to === 'string');
  const spaces = [...new Set([...sourceScope.readSpaceIds, ...targetScope.readSpaceIds])];
  const revisions = JSON.stringify(Object.fromEntries([...graph.records].map(([id,row]) => [id,row.rev])));
  const [state, members, content] = await env.DB.batch([
    env.DB.prepare('SELECT enabled, (SELECT name FROM users WHERE id=?) actor FROM access_state WHERE id=1').bind(ctx.userId),
    env.DB.prepare(`SELECT u.id,u.prefs,
      (SELECT json_group_array(g.value) FROM json_each(?) g WHERE ${levelSql('?', 'g.value')}>=1 AND ${levelSql('u.id', 'g.value')}>=1) groups_json
      FROM users u WHERE u.disabled_at IS NULL AND u.id!=? AND
       (u.id IN (SELECT value FROM json_each(?)) OR EXISTS(SELECT 1 FROM json_each(?) g WHERE ${levelSql('?', 'g.value')}>=1 AND ${levelSql('u.id', 'g.value')}>=1))
      AND ((SELECT enabled FROM access_state WHERE id=1)=0 OR NOT EXISTS(SELECT 1 FROM json_each(?) scope WHERE ${levelSql('u.id', 'scope.value')}<1))
      ORDER BY u.id LIMIT 201`).bind(JSON.stringify(groups),ctx.userId,ctx.userId,JSON.stringify(direct.map(event=>event.to)),JSON.stringify(groups),ctx.userId,JSON.stringify(spaces)),
    env.DB.prepare('SELECT id,collection,data,seq FROM records WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify([first.recordId,targetId])),
  ]);
  if (members.results.length > 200) throw new Error('Space mention candidate budget exceeded');
  const mode = state.results[0] as {enabled: number; actor: string | null} | undefined;
  if (!mode) return;
  const rows = new Map((content.results as {id: string; collection: string; data: string; seq: number}[]).map(row => [row.id, row]));
  const source = rows.get(first.recordId), target = rows.get(targetId);
  if (!source || !target || source.seq !== graph.records.get(source.id)?.rev || target.seq !== graph.records.get(target.id)?.rev) throw new Error('Mention source changed; retry');
  const sourceData = JSON.parse(source.data) as Record<string,unknown>, targetData = JSON.parse(target.data) as Record<string,unknown>;
  const parent = source.collection === 'comments' ? sourceData.targetId : sourceData.pageId;
  if (parent !== targetId) return;
  const text = String(sourceData.text ?? sourceData.body ?? '');
  // A removed token must not deliver an old queued broadcast.
  const activeGroups = groups.filter(group => text.includes(`@[group:${group}]`));
  const activeDirect = direct.filter(event => text.includes(`@[user:${event.to}]`));
  const eligible = (members.results as {id: string; prefs: string | null; groups_json: string}[]).flatMap(user => {
    const prefs = parsePrefs(user.prefs), memberGroups = (JSON.parse(user.groups_json) as string[]).filter(id=>activeGroups.includes(id));
    const directEvent = activeDirect.find(event => event.to === user.id);
    return kindAllowed(prefs,'mention') && (memberGroups.length || directEvent) ? [{...user,prefsParsed:prefs,memberGroups,directEvent}] : [];
  }).slice(0,20);
  if (!eligible.length) return;
  const now = Date.now(), groupKey = `mention:${targetId}`;
  const existing = await env.DB.prepare(`SELECT * FROM (
    SELECT id,user_id,items,group_count,read_at,ROW_NUMBER() OVER(PARTITION BY user_id ORDER BY (read_at IS NULL) DESC,created_at DESC) position
    FROM notifications WHERE user_id IN (SELECT value FROM json_each(?)) AND group_key=? AND target_id=? AND created_at>?) WHERE position=1`)
    .bind(JSON.stringify(eligible.map(user=>user.id)),groupKey,targetId,now-GROUP_WINDOW_MS).all<NotificationGroup & {user_id:string}>();
  const statements: D1PreparedStatement[] = [];
  for (const user of eligible) {
    let guard = `EXISTS(SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL AND prefs IS ?) AND (SELECT enabled FROM access_state WHERE id=1)=?
      AND NOT EXISTS(SELECT 1 FROM json_each(?) rev WHERE NOT EXISTS(SELECT 1 FROM records r WHERE r.id=rev.key AND r.seq=rev.value))`;
    const binds: unknown[] = [user.id,user.prefs,mode.enabled,revisions];
    if (mode.enabled === 1) {
      guard += ` AND NOT EXISTS(SELECT 1 FROM json_each(?) scope WHERE ${levelSql('?', 'scope.value')}<1)`;
      binds.push(JSON.stringify(spaces),user.id);
    }
    if (!user.directEvent) {
      guard += ` AND EXISTS(SELECT 1 FROM json_each(?) g WHERE ${levelSql('?', 'g.value')}>=1 AND ${levelSql('?', 'g.value')}>=1)`;
      binds.push(JSON.stringify(user.memberGroups),ctx.userId,user.id);
    }
    const dedupeKey = user.directEvent
      ? `event:${ctx.outboxId??JSON.stringify(user.directEvent)}:${semantic.indexOf(user.directEvent)}`
      : `event:${ctx.outboxId??JSON.stringify(first)}:space:${first.recordId}:${user.id}`;
    const n: NewNotification = {userId:user.id,kind:'mention',actorId:ctx.userId,targetType:first.targetType,targetId,
      title:`${mode.actor??'Someone'} mentioned you${titleOf({collection:target.collection,data:targetData}) ? ` in "${titleOf({collection:target.collection,data:targetData})}"` : ''}`,
      body:excerpt(text)||undefined,url:urlFor({collection:target.collection,data:targetData},targetId),groupKey,dedupeKey};
    statements.push(...notificationStatements(env,n,user.prefsParsed,guard,binds,existing.results.find(row=>row.user_id===user.id)??null,now).statements);
  }
  await env.DB.batch(statements);
  // Group delivery stays in the durable channel outboxes; scheduled recovery
  // sends email/push using the existing per-recipient gates and preferences.
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
  currently_visible?: number;
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

/** Current server-derived audiences, also used for badge/read mutations. Hidden
 * historical rows remain retained; they do not create public badge/count signals. */
function notificationVisibleSql(alias='notifications') {
 return `((SELECT enabled FROM access_state WHERE id=1)=0 OR EXISTS(SELECT 1 FROM records target
 WHERE target.id=${alias}.target_id AND COALESCE(json_extract(target.data,'$.deleted'),0)!=1
 AND ${levelSql(`${alias}.user_id`,'target.space_id')}>=1
 AND (target.peer_space_id IS NULL OR ${levelSql(`${alias}.user_id`,'target.peer_space_id')}>=1)
 AND NOT EXISTS(WITH RECURSIVE ancestry(id,collection,data) AS (
   SELECT target.id,target.collection,target.data
   UNION
   SELECT p.id,p.collection,p.data FROM ancestry child JOIN records p
     ON p.id IN (SELECT value FROM json_each(${scopeParentsSql('child')}))
   LIMIT 5001
 ) SELECT 1 FROM ancestry WHERE COALESCE(json_extract(data,'$.deleted'),0)=1
   OR (collection='files' AND json_extract(data,'$.parentType')='form-pending')
   OR ${levelSql(`${alias}.user_id`,"(SELECT space_id FROM records WHERE id=ancestry.id)")}<1
   OR (SELECT COUNT(*) FROM ancestry)>5000)))`;
}

/** Unread count honoring the user's quietDigest pref (quiet kinds still land
 * in the Inbox but don't count against the badge). */
export async function unreadBadge(db: D1Database, userId: string, prefs: UserPrefs): Promise<number> {
  if (prefs.quietDigest) {
    const row = await db
      .prepare(`SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL AND ${notificationVisibleSql()} AND kind IN (${URGENT_KINDS.map(() => '?').join(',')})`)
      .bind(userId, ...URGENT_KINDS)
      .first<{ c: number }>();
    return row?.c ?? 0;
  }
  const row = await db.prepare(`SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL AND ${notificationVisibleSql()}`).bind(userId).first<{ c: number }>();
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
  let cursor:{userId:string;at:number;id:string}|null=null;
  if(c.req.query('cursor')){try{cursor=JSON.parse(atob(c.req.query('cursor')!));if(!cursor||cursor.userId!==userId||!Number.isSafeInteger(cursor.at)||typeof cursor.id!=='string'||!cursor.id.length||cursor.id.length>128)throw new Error();}catch{return c.json({error:'invalid_cursor'},400);}}
  let sql = `SELECT *,${notificationVisibleSql()} AS currently_visible FROM notifications WHERE user_id = ?`;
  const binds: (string | number)[] = [userId];
  if(cursor){sql+=' AND (created_at < ? OR (created_at = ? AND id < ?))';binds.push(cursor.at,cursor.at,cursor.id);}
  else if (before > 0) {
    sql += ' AND created_at < ?';
    binds.push(before);
  }
  sql += ' ORDER BY created_at DESC,id DESC LIMIT ?';
  binds.push(limit + 1);
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all<NotifRow>();
  const page = results.slice(0, limit);
  // Stored title/body/items are historical copies of record content. While permissions are
  // enabled each is shown only if the recipient can read its target NOW; otherwise a neutral
  // "Restricted item" row keeps the inbox order without the copy (design review §5).
  const decision = await createReadGate(c.env.DB, userId).decide(page.map((r) => r.target_id).filter((id): id is string => !!id));
  const shown = (r: NotifRow) => !decision.enabled || (r.currently_visible===1 && !!r.target_id && decision.readable.has(r.target_id));
  const safeSerialize=(r:NotifRow)=>{const value=serialize(r);if(decision.enabled && value.items.some(i=>i.targetId!==r.target_id))return {...value,title:'Activity on an accessible item',body:null,items:[],groupCount:1};return value;};
  return c.json({
    notifications: page.map((r) => (shown(r) ? safeSerialize(r) : { ...serialize({ ...r, title: 'Restricted item', body: null, url: null, items: null }), actorId:null,targetType:null,groupKey:null,groupCount:0,targetId: null, restricted: true })),
    nextCursor:results.length>limit?btoa(JSON.stringify({userId,at:page[page.length-1].created_at,id:page[page.length-1].id})):null,
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
  const res = await c.env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL AND ${notificationVisibleSql()}`)
    .bind(Date.now(), c.req.param('id'), user.id)
    .run();
  if (!(res.meta.changes ?? 0)) {
    // Either not their row, unknown id, or already read — distinguish only own-row.
    const row = await c.env.DB.prepare(`SELECT id FROM notifications WHERE id = ? AND user_id = ? AND ${notificationVisibleSql()}`).bind(c.req.param('id'), user.id).first();
    if (!row) return c.json({ error: 'not found' }, 404);
  }
  return c.json({ ok: true });
});

notificationsApi.post('/read-all', async (c) => {
  const res = await c.env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND ${notificationVisibleSql()}`)
    .bind(Date.now(), c.get('user').id)
    .run();
  return c.json({ ok: true, updated: res.meta.changes ?? 0 });
});
