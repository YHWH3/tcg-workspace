// Phase 4 — automation engine (Workstream E). Config is a synced `automations`
// collection; this file is the only executor: matches triggers on derived
// semantic events, evaluates conditions on the post-write record, then runs
// actions as ONE source:'automation' applyChanges batch inside a changeset.
// Replay-safe via automation_runs.event_key UNIQUE; automation-sourced events
// never re-trigger (the processOutbox depth-1 loop guard).

import { Hono } from 'hono';
import type { SemanticEvent } from '../shared/events';
import type { EventSource } from './events';
import { requireAuth, type Env, type AuthUser } from './auth';
import { applyChanges } from './sync';
import { getRec, listBy, listCollection } from './records';
import { beginChangeset } from './changesets';
import { notify, type NewNotification } from './notifications';
import {hasD1Budget,D1BudgetExhausted,d1CleanupDatabase} from './d1budget';
import {
  automationDbId,
  conditionsMatch,
  matchesScope,
  matchesTrigger,
  renderTemplate,
  runEventKey,
  validateAutomation,
  type AutomationAction,
  type AutomationConfig,
} from '../shared/automations';
import type { ViewCtx } from '../shared/views';
import { coerceFieldValue, fieldsOf, type FieldDef } from '../shared/fields';
import { addDays, todayUtc } from '../shared/recurrence';
import { linkId } from '../shared/linkid';
import { planTemplateInstantiation, type RecSnapshot } from '../shared/templates';
import { fnv1a64hex } from '../shared/linkid';
import type { Mutation } from '../shared/types';
import { completedRecords, executionOptions, executionFence, EXECUTION_LEASE_MS, EXECUTION_MAX_ATTEMPTS, retryDelay } from './execution';

export interface EventCtx {
  source: EventSource;
  userId: string;
  /** The event_outbox row id this batch came from — scopes run dedupe keys so
   * replays skip and fresh fires run. Cron passes a synthetic `cron:<day>` id. */
  outboxId?: string;
}

const MAX_ACTION_RECORDS = 400; // keep automation batches well under the 500 write cap
const MAX_RUNS_KEPT = 200;

type BoardRow = Record<string, unknown>;
type AutomationRow = { id: string; data: AutomationConfig };

/** Automation configs live on synced records — load the enabled, live ones. */
async function enabledAutomations(env: Env): Promise<AutomationRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, data FROM records WHERE collection = 'automations'
       AND COALESCE(json_extract(data,'$.deleted'),0) != 1
       AND COALESCE(json_extract(data,'$.enabled'),1) != 0`
  ).all<{ id: string; data: string }>();
  const out: AutomationRow[] = [];
  for (const r of results) {
    try {
      out.push({ id: r.id, data: JSON.parse(r.data) as AutomationConfig });
    } catch {
      /* malformed config — skip */
    }
  }
  return out;
}

/** Field-key values written by automation actions get FieldDef coercions. */
function coercePatchValue(board: BoardRow | undefined, key: string, raw: unknown): unknown {
  if (!key.startsWith('p_')) return raw;
  const def = fieldsOf(board).find((f) => f.id === key.slice(2));
  if (!def) return raw;
  return coerceFieldValue(def, raw);
}

function firstColumnId(board: BoardRow | undefined): string | null {
  const cols = Array.isArray(board?.columns) ? (board!.columns as { id: string }[]) : [];
  return cols[0]?.id ?? null;
}

function recordUrl(boardId: string | undefined, recordId: string): string {
  return boardId ? `/boards/${boardId}/tasks/${recordId}` : `/tasks/${recordId}`;
}

interface PlannedSideEffects {
  /** D1 approvals rows to insert after the record batch lands. */
  approvals: Record<string, unknown>[];
  /** Notification rows to write via notify(). */
  notifications: NewNotification[];
}

/**
 * Plan one automation's actions into record mutations + side effects.
 * Pure given fetched rows — throws a readable Error on invalid config so the
 * run is recorded failed with nothing written.
 */
async function planActions(
  env: Env,
  auto: AutomationRow,
  ev: SemanticEvent,
  rec: { id: string; data: Record<string, unknown> },
  board: BoardRow | undefined,
  ctx: EventCtx,
  runId: string,
  today: string,
): Promise<{ ops: Mutation[]; side: PlannedSideEffects; memberIds: Set<string> }> {
  const ops: Mutation[] = [];
  const side: PlannedSideEffects = { approvals: [], notifications: [] };
  const renderCtx = { record: { id: rec.id, ...rec.data }, fields: fieldsOf(board), today };
  const render = (v: unknown) => (typeof v === 'string' ? renderTemplate(v, renderCtx) : v);
  const renderStr = (v: unknown) => String(render(v) ?? '');

  const boardCache = new Map<string, BoardRow | null>();
  const fetchBoard = async (id: string): Promise<BoardRow | null> => {
    if (!boardCache.has(id)) boardCache.set(id, (await getRec(env, id))?.data ?? null);
    return boardCache.get(id) ?? null;
  };

  const memberIds = new Set<string>();
  let membersLoaded = false;
  const loadMembers = async (): Promise<Set<string>> => {
    if (!membersLoaded) {
      const { results } = await env.DB.prepare('SELECT id FROM users').all<{ id: string }>();
      for (const r of results) memberIds.add(r.id);
      membersLoaded = true;
    }
    return memberIds;
  };

  const personFieldValue = async (fieldId: string | undefined, fallback: string | undefined): Promise<string | undefined> => {
    if (fieldId) {
      const v = rec.data[`p_${fieldId}`] ?? rec.data[fieldId];
      if (typeof v === 'string' && v) return v;
    }
    return fallback;
  };

  const actions = auto.data.actions ?? [];
  let i = 0;
  for (const a of actions) {
    i += 1;
    switch (a.type) {
      case 'create_record': {
        if (!a.databaseId) throw new Error(`action ${i}: databaseId required`);
        const target = await fetchBoard(a.databaseId);
        if (!target) throw new Error(`action ${i}: database ${a.databaseId} not found`);
        const newId = `${runId}_r${i}`;
        const patch: Record<string, unknown> = {
          title: render(a.title ?? '') || 'Untitled',
          boardId: a.databaseId,
          createdAt: Date.now(),
        };
        const col0 = firstColumnId(target);
        if (col0) patch.status = col0;
        for (const [k, v] of Object.entries(a.fields ?? {})) {
          const coerced = coercePatchValue(target, k, render(v));
          if (coerced !== undefined) patch[k] = coerced;
        }
        ops.push({ id: newId, collection: 'tasks', patch, ts: Date.now() });
        if (a.link !== undefined && a.link !== null) {
          const fieldId = typeof a.link.fieldId === 'string' ? a.link.fieldId : null;
          const kind = fieldId ? 'relation' : 'related';
          ops.push({
            id: linkId(kind, fieldId, newId, rec.id),
            collection: 'links',
            patch: { fromId: newId, fromType: 'record', toId: rec.id, toType: 'record', kind, fieldId, createdAt: Date.now() },
            ts: Date.now(),
          });
        }
        break;
      }
      case 'create_from_template': {
        if (!a.templateId) throw new Error(`action ${i}: templateId required`);
        let templateIndex=0;
        const plan = planTemplateInstantiation(await loadSnapshot(env), {
          templateId: a.templateId,
          variables: Object.fromEntries(Object.entries(a.vars ?? {}).map(([k, v]) => [k, String(render(v) ?? '')])),
          actorId: ctx.userId,
        }, { id: ()=>`auto_${fnv1a64hex(`${runId}:${i}:${templateIndex++}`)}`, now: Date.now() });
        if (!plan) throw new Error(`action ${i}: template ${a.templateId} not found`);
        for (const w of plan.writes) ops.push({ id: w.id, collection: w.collection, patch: w.patch, ts: Date.now() });
        break;
      }
      case 'set_field': {
        const key = String(a.fieldKey ?? '');
        if (!key) throw new Error(`action ${i}: fieldKey required`);
        const coerced = coercePatchValue(board, key, render(a.value));
        ops.push({ id: rec.id, collection: 'tasks', patch: { [key]: coerced }, ts: Date.now() });
        break;
      }
      case 'notify': {
        const recipients = new Set<string>();
        const fv = await personFieldValue(a.userField, undefined);
        if (fv) recipients.add(fv);
        for (const uid of a.userIds ?? []) recipients.add(uid);
        const members = await loadMembers();
        for (const uid of recipients) {
          if (!members.has(uid)) throw new Error(`action ${i}: user ${uid} is not a member`);
        }
        const body = renderStr(a.message ?? '') || `${auto.data.name ?? 'Automation'} fired`;
        for (const uid of recipients) {
          side.notifications.push({
            userId: uid,
            kind: 'automation',
            actorId: ctx.userId,
            targetType: 'record',
            targetId: rec.id,
            title: String(auto.data.name ?? 'Automation'),
            body,
            url: recordUrl(ev.boardId, rec.id),
            groupKey: `automation:${auto.id}`,
            dedupeKey:`${runId}:notify:${i}:${uid}`,
          });
        }
        break;
      }
      case 'request_approval': {
        const approver = await personFieldValue(a.approverField, a.approverId);
        if (!approver) throw new Error(`action ${i}: no approver resolved`);
        const members = await loadMembers();
        if (!members.has(approver)) throw new Error(`action ${i}: user ${approver} is not a member`);
        const key = `rq_${runId}_${i}`;
        side.approvals.push({
          id: `appr_${runId}_${i}`,
          target_type: 'record',
          target_id: rec.id,
          stage_id: ev.kind === 'record.stage_changed' ? (typeof ev.to === 'string' ? ev.to : null) : null,
          requested_by: ctx.userId,
          approver_id: approver,
          status: 'pending',
          note: typeof a.note === 'string' ? renderStr(a.note) : null,
          request_key: key,
          created_at: Date.now(),
        });
        break;
      }
      case 'add_subrecords': {
        const titles = a.titles ?? [];
        if (!titles.length) throw new Error(`action ${i}: no titles`);
        const col0 = firstColumnId(board);
        titles.forEach((t, j) => {
          const patch: Record<string, unknown> = {
            title: render(t) || 'Untitled',
            boardId: ev.boardId ?? rec.data.boardId,
            parentId: rec.id,
            createdAt: Date.now(),
          };
          if (col0) patch.status = col0;
          ops.push({ id: `${runId}_s${i}_${j}`, collection: 'tasks', patch, ts: Date.now() });
        });
        break;
      }
      default:
        throw new Error(`action ${i}: unknown type ${String((a as AutomationAction).type)}`);
    }
  }
  if (ops.length > MAX_ACTION_RECORDS) throw new Error(`too many writes (${ops.length} > ${MAX_ACTION_RECORDS})`);
  return { ops, side, memberIds };
}

async function loadSnapshot(env: Env): Promise<RecSnapshot> {
  const [pages, blocks, boards, tasks, views, links] = await Promise.all([
    listCollection(env, 'pages'), listCollection(env, 'blocks'), listCollection(env, 'boards'),
    listCollection(env, 'tasks'), listCollection(env, 'views'), listCollection(env, 'links'),
  ]);
  const map = (rs: { id: string; data: Record<string, unknown> }[]) => Object.fromEntries(rs.map((r) => [r.id, r.data]));
  return { pages: map(pages), blocks: map(blocks), boards: map(boards), tasks: map(tasks), views: map(views), links: map(links) };
}

/** Synthetic `record.field_changed` event for a date_offset hit (cron §5.4 contract). */
export function dateOffsetEvent(recordId: string, boardId: string | undefined, dateKey: string, date: string): SemanticEvent {
  return { kind: 'record.field_changed', recordId, collection: 'tasks', boardId, fieldKey: dateKey, to: date,from:'cron:date_offset' };
}

/**
 * Cron step 4 (B calls this from runScheduled): for every enabled
 * date_offset automation, fire records whose indexed date is `today - days`.
 */
export async function runDateOffsetAutomations(env: { DB: D1Database }, today: string = todayUtc()): Promise<void> {
  const e = env as unknown as Env;
  const autos = await enabledAutomations(e);
  for (const auto of autos) {
    const t = auto.data.trigger;
    if (t?.kind !== 'date_offset') continue;
    const days = Number(t.days ?? 0);
    if (!Number.isFinite(days)) continue;
    const dateKey = t.dateKey ?? 'dueDate';
    const want = addDays(today, -Math.trunc(days));
    const { results } = await env.DB.prepare('SELECT record_id FROM date_index WHERE field_key = ? AND date = ?')
      .bind(dateKey === 'due' ? 'dueDate' : dateKey, want)
      .all<{ record_id: string }>();
    for (const row of results) {
      const rec = await getRec(e, row.record_id);
      if (!rec || rec.collection !== 'tasks' || rec.data.deleted === true || rec.data.archived === true) continue;
      await runOneAutomation(e, auto, dateOffsetEvent(row.record_id, String(rec.data.boardId ?? ''), dateKey, want), { source: 'automation', userId: String(rec.data.createdBy ?? '') || 'system', outboxId: `cron:${today}` }, rec.data, today).catch(() => {});
    }
  }
}

/** One (automation, event) run: dedupe → validate → plan → single batch. */
export async function runOneAutomation(
  env: Env,
  auto: AutomationRow,
  ev: SemanticEvent,
  ctx: EventCtx,
  recData: Record<string, unknown>,
  today: string,
): Promise<void> {
  const eventKey = runEventKey(auto.id, ev, ctx.outboxId);
  const runId = `arun_${eventKey}`;
  const payload=JSON.stringify({auto,ev,ctx,recData,today});
  await env.DB.prepare(`INSERT OR IGNORE INTO automation_runs(id,automation_id,event_key,status,created_at,payload)
    VALUES(?,?,?,'pending',?,?)`).bind(runId,auto.id,eventKey,Date.now(),payload).run();
  const lease=crypto.randomUUID(), now=Date.now();
  const claimed=await env.DB.prepare(`UPDATE automation_runs SET status='running',lease_id=?,lease_until=?,attempts=attempts+1,updated_at=?,payload=COALESCE(payload,?)
    WHERE id=? AND attempts<? AND retry_at<=? AND (status IN ('pending','retryable_failure') OR (status='running' AND COALESCE(lease_until,0)<=?))
    RETURNING attempts,plan,changeset_id`).bind(lease,now+EXECUTION_LEASE_MS,now,payload,runId,EXECUTION_MAX_ATTEMPTS,now,now).first<{attempts:number;plan:string|null;changeset_id:string|null}>();
  if(!claimed) return;
  const cs=beginChangeset({userId:ctx.userId,tool:'automation',summary:`Automation: ${String(auto.data.name??auto.id)}`,source:'automation'});
  cs.id=claimed.changeset_id??`cs_${runId}`;
  let terminal=false;
  try {
    const board = ev.boardId ? (await getRec(env, ev.boardId))?.data : undefined;
    const boardsById = new Map<string, Record<string, unknown>>();
    if (ev.boardId && board) boardsById.set(ev.boardId, board);
    for (const a of auto.data.actions ?? []) {
      if (a.type === 'create_record' && a.databaseId && !boardsById.has(a.databaseId)) {
        const b = await getRec(env, a.databaseId);
        if (b) boardsById.set(a.databaseId, b.data);
      }
    }
    // Fail fast on config errors — nothing partial is written. Boards-only
    // ctx: missing-member/template checks stay advisory at the API layer.
    const {results:users}=await env.DB.prepare('SELECT id FROM users').all<{id:string}>();
    const templates=await listBy(env,'pages','isTemplate',true);
    const errors = validateAutomation(auto.data, { boardsById,memberIds:new Set(users.map(u=>u.id)),templateIds:new Set(templates.map(t=>t.id)) });
    if (errors.length) {terminal=true;throw new Error(errors.join('; '));}
    let plan:{ops:Mutation[];side:PlannedSideEffects};
    if(claimed.plan) plan=JSON.parse(claimed.plan);
    else {
      terminal=true;
      plan=await planActions(env,auto,ev,{id:ev.recordId,data:recData},board,ctx,runId,today);
      terminal=false;
      await env.DB.prepare('UPDATE automation_runs SET plan=?,changeset_id=? WHERE id=? AND lease_id=?').bind(JSON.stringify(plan),cs.id,runId,lease).run();
    }
    const done=await completedRecords(env.DB,runId);
    const ops=plan.ops.filter(o=>!done.has(o.id));
    if (ops.length) {
      const nested:Promise<unknown>[]=[];
      const res = await applyChanges(env, ctx.userId, ops, {
        serverTs: true,
        atomic:true,journal:cs,execution:executionOptions(env,'automation_runs',runId,lease),
        event: { source: 'automation', ctx: { waitUntil: p=>nested.push(p) }, changesetId: cs.id },
      });
      await Promise.all(nested);
      if(res.rejected) {terminal=true;throw new Error(`rejected: ${JSON.stringify(res.rejectedItems)}`);}
      if(res.partialError||res.conflict||res.conflicts?.length) throw new Error(res.partialError??'write conflict; retry');
    }
    for (const a of plan.side.approvals) {
      await env.DB.batch([executionFence(env.DB,'automation_runs',runId,lease)(),env.DB.prepare(
        `INSERT OR IGNORE INTO approvals (id, target_type, target_id, stage_id, requested_by, approver_id, status, note, request_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(a.id, a.target_type, a.target_id, a.stage_id, a.requested_by, a.approver_id, a.status, a.note, a.request_key, a.created_at)]);
    }
    for (const n of plan.side.notifications) {
      await env.DB.batch([executionFence(env.DB,'automation_runs',runId,lease)()]);
      await notify(env,n);
    }
    await env.DB.prepare(`UPDATE automation_runs SET status='completed',error=NULL,lease_id=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_id=?`).bind(Date.now(),runId,lease).run();
  } catch (err) {
    if(err instanceof D1BudgetExhausted) {
      await d1CleanupDatabase(env.DB).prepare("UPDATE automation_runs SET status='retryable_failure',attempts=MAX(0,attempts-1),error=?,retry_at=?,lease_id=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_id=?").bind(err.message,Date.now()+60_000,Date.now(),runId,lease).run();
      throw err;
    }
    const exhausted=claimed.attempts>=EXECUTION_MAX_ATTEMPTS;
    await env.DB.prepare(`UPDATE automation_runs SET status=?,error=?,retry_at=?,lease_id=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_id=?`)
      .bind(terminal||exhausted?'terminal_failure':'retryable_failure',err instanceof Error?err.message:String(err),Date.now()+retryDelay(claimed.attempts),Date.now(),runId,lease).run();
  }

  // Retention: keep the last MAX_RUNS_KEPT runs per automation.
  await env.DB.prepare(
    `DELETE FROM automation_runs WHERE automation_id = ? AND id NOT IN
       (SELECT id FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT ?) AND status IN ('completed','terminal_failure')`
  ).bind(auto.id, auto.id, MAX_RUNS_KEPT).run().catch(() => {});
}

/** Cron independently resumes leased/failed runs even after their input event
 * has completed. No already-completed record or delivery is blindly replayed. */
export async function recoverAutomationRuns(env:Pick<Env,'DB'>):Promise<void> {
  const now=Date.now();
  await env.DB.prepare(`UPDATE automation_runs SET status='terminal_failure',error=COALESCE(error,'execution attempt limit reached') WHERE attempts>=? AND status IN ('pending','running','retryable_failure') AND COALESCE(lease_until,0)<=?`).bind(EXECUTION_MAX_ATTEMPTS,now).run();
  const {results}=await env.DB.prepare(`SELECT payload FROM automation_runs WHERE payload IS NOT NULL AND retry_at<=? AND (status IN ('pending','retryable_failure') OR (status='running' AND COALESCE(lease_until,0)<=?)) ORDER BY created_at LIMIT 20`).bind(now,now).all<{payload:string}>();
  for(const row of results) {
    if(!hasD1Budget(env.DB,24))break;
    const p=JSON.parse(row.payload) as {auto:AutomationRow;ev:SemanticEvent;ctx:EventCtx;recData:Record<string,unknown>;today:string};
    await runOneAutomation(env as Env,p.auto,p.ev,p.ctx,p.recData,p.today);
  }
}

/**
 * Called from processOutbox for every non-automation event batch. For each
 * semantic event: recurrence spawn (stage→done), then every enabled
 * automation whose database scope matches. One bad automation can never take
 * the others down — each run is isolated in its own try + run row.
 */
export async function runAutomationsForEvent(
  env: { DB: D1Database },
  semantic: SemanticEvent[],
  ctx: EventCtx
): Promise<void> {
  const today = todayUtc();
  const recCache = new Map<string, { id: string; collection: string; data: Record<string, unknown> } | null>();
  const fetchRec = async (id: string) => {
    if (!recCache.has(id)) recCache.set(id, (await getRec(env as Env, id)) ?? null);
    return recCache.get(id)!;
  };

  let autos: AutomationRow[] | null = null;
  for (const ev of semantic) {
      autos ??= await enabledAutomations(env as Env);
      for (const auto of autos) {
        // boardId is absent from update events (after = touched fields only):
        // resolve scope from the live record when the event doesn't carry it.
        const rec = await fetchRec(ev.recordId);
        if (!rec || rec.collection !== 'tasks') continue;
        const ev2: SemanticEvent = ev.boardId ? ev : { ...ev, boardId: String(rec.data.boardId ?? '') };
        if (!matchesScope(auto.data, ev2)) continue;
        if (auto.data.trigger?.kind==='date_offset' || !matchesTrigger(auto.data.trigger, ev2, { today })) continue;
        const board = ev2.boardId ? (await fetchRec(ev2.boardId))?.data : undefined;
        const vctx: ViewCtx = { meId: ctx.userId, today, fieldsById: new Map(fieldsOf(board).map((f: FieldDef) => [f.id, f])) };
        try {
          if (!conditionsMatch(auto.data.conditions, { id: rec.id, ...(ev.snapshot??rec.data) }, vctx)) continue;
        } catch {
          continue;
        }
        await runOneAutomation(env as Env, auto, ev2, ctx, ev.snapshot??rec.data, today);
      }
  }
}

/** Member API (mounted at /api/automations): run history + validation.
 * Automation CONFIG itself is a synced collection edited via mutate()/sync. */
export const automationsApi = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();
automationsApi.use('*', requireAuth);

automationsApi.get('/:id/runs', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, automation_id, event_key, changeset_id, status, error, created_at FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT 50'
  ).bind(c.req.param('id')).all();
  return c.json({ runs: results });
});

automationsApi.get('/:id/validate', async (c) => {
  const rec = await getRec(c.env, c.req.param('id'));
  if (!rec || rec.collection !== 'automations') return c.json({ error: 'not found' }, 404);
  const cfg = rec.data as AutomationConfig;
  const dbIds = new Set<string>();
  if (automationDbId(cfg)) dbIds.add(automationDbId(cfg)!);
  for (const a of cfg.actions ?? []) if (a.databaseId) dbIds.add(a.databaseId);
  const boardsById = new Map<string, Record<string, unknown>>();
  for (const id of dbIds) {
    const b = await getRec(c.env, id);
    if (b) boardsById.set(id, b.data);
  }
  const { results: users } = await c.env.DB.prepare('SELECT id FROM users').all<{ id: string }>();
  const templates = await listBy(c.env, 'pages', 'isTemplate', true);
  const forms = await listCollection(c.env, 'forms');
  const errors = validateAutomation(cfg, {
    boardsById,
    memberIds: new Set(users.map((u) => u.id)),
    templateIds: new Set(templates.map((t) => t.id)),
    formIds: new Set(forms.map((f) => f.id)),
  });
  return c.json({ errors });
});
