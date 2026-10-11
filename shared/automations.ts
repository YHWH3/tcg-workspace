// Phase 4 — automations (Workstream E). Pure config model + matching rules
// shared by the worker engine, the editor UI and tests. Automation CONFIG is a
// synced `automations` collection (member-editable); every execution re-
// validates against live rows — config never authorizes anything.
//
// Record shape (synced `automations` rows):
//   { databaseId, name, enabled,
//     trigger: { kind, to?, fieldId?, dateKey?, days?, formId?, databaseId? },
//     conditions: Filter[] (view-filter shape, evaluated on the event AFTER state),
//     actions: AutomationAction[] }

import { evalFilter, type Filter, type FilterOp, type ViewCtx, type ViewRecord } from './views';
import { formatFieldValue, fieldsOf, propKey, type FieldDef } from './fields';
import { addDays, todayUtc } from './recurrence';
import { fnv1a64hex } from './linkid';
import { stableJson } from './stablejson';
import type { SemanticEvent } from './events';

export type AutomationTriggerKind =
  | 'record.created'
  | 'stage_changed'
  | 'field_changed'
  | 'date_offset'
  | 'form.submitted';

export interface AutomationTrigger {
  kind: AutomationTriggerKind;
  /** stage_changed: only fire when the target stage is this column id. */
  to?: string;
  /** field_changed: only fire for this field key (builtin or p_<fid>). */
  fieldId?: string;
  /** date_offset: field key carrying the date (builtin 'dueDate' or p_<fid>). */
  dateKey?: string;
  /** date_offset: days relative to the date (negative = N days before it). */
  days?: number;
  /** form.submitted: limit to this form record id. */
  formId?: string;
  /** Optional override of the automation's database scope. */
  databaseId?: string;
}

export interface AutomationAction {
  type:
    | 'create_record'
    | 'create_from_template'
    | 'set_field'
    | 'notify'
    | 'request_approval'
    | 'add_subrecords';
  /** create_record: target database (board id). */
  databaseId?: string;
  /** create_record: title (template-rendered). */
  title?: string;
  /** create_record: values — `p_<fid>` keys or builtins (status/assigneeId/dueDate/priority). */
  fields?: Record<string, unknown>;
  /** create_record: link the new record back to the triggering record.
   * fieldId set → `relation` link on that field; absent/null → `related` link. */
  link?: { fieldId?: string | null } | null;
  /** create_from_template: template page id + {{var}} substitutions. */
  templateId?: string;
  vars?: Record<string, string>;
  /** set_field: field key + value (template-rendered when string). */
  fieldKey?: string;
  value?: unknown;
  /** notify: recipients — userField resolves the record's p_<fid> person value;
   * userIds is a literal list. Either may be used, at least one required. */
  userField?: string;
  userIds?: string[];
  /** notify: body (template-rendered). */
  message?: string;
  /** request_approval: approverField resolves p_<fid> person value; approverId literal. */
  approverField?: string;
  approverId?: string;
  note?: string;
  /** add_subrecords: child record titles (template-rendered). */
  titles?: string[];
}

export interface AutomationConfig {
  databaseId?: string;
  name?: string;
  enabled?: boolean;
  trigger?: AutomationTrigger;
  conditions?: Filter[];
  actions?: AutomationAction[];
  deleted?: boolean;
  [k: string]: unknown;
}

/** The database an automation is scoped to (trigger override wins). */
export function automationDbId(auto: AutomationConfig): string | undefined {
  return auto.trigger?.databaseId ?? auto.databaseId;
}

/** 'due'/'duedate' aliases normalize to the stored builtin key. */
function normalizeDateKey(key: string | undefined): string {
  const k = (key ?? 'dueDate').trim().toLowerCase();
  return k === 'due' || k === 'duedate' ? 'dueDate' : (key ?? 'dueDate');
}

/**
 * Does this trigger fire on this semantic event?
 * `date_offset` is the cron-driven kind: the date_index sweep synthesizes a
 * `record.field_changed` event whose `to` is the matched date — so it fires
 * exactly when `event.to === today - days` (and, usefully, also when a member
 * sets the field to that date by hand). Replay collapses on the run key.
 */
export function matchesTrigger(
  trigger: AutomationTrigger | undefined,
  event: SemanticEvent,
  ctx: { today?: string } = {},
): boolean {
  if (!trigger || typeof trigger.kind !== 'string') return false;
  switch (trigger.kind) {
    case 'record.created':
      return event.kind === 'record.created';
    case 'stage_changed':
      return event.kind === 'record.stage_changed' && (trigger.to === undefined || String(event.to) === trigger.to);
    case 'field_changed':
      return (
        event.kind === 'record.field_changed' &&
        (trigger.fieldId === undefined || event.fieldKey === trigger.fieldId)
      );
    case 'date_offset': {
      if (event.kind !== 'record.field_changed' || event.from!=='cron:date_offset') return false;
      const days = Number(trigger.days ?? 0);
      if (!Number.isFinite(days)) return false;
      if (event.fieldKey !== normalizeDateKey(trigger.dateKey)) return false;
      const want = addDays(ctx.today ?? todayUtc(), -Math.trunc(days));
      return String(event.to ?? '') === want;
    }
    case 'form.submitted':
      return event.kind === 'form.submitted' && (trigger.formId === undefined || event.formId === trigger.formId);
    default:
      return false;
  }
}

/** Should this automation even be considered for the event's scope? */
export function matchesScope(auto: AutomationConfig, event: SemanticEvent): boolean {
  if (auto.enabled === false || auto.deleted === true) return false;
  if (event.kind === 'form.submitted') return auto.trigger?.kind === 'form.submitted' && (!automationDbId(auto)||automationDbId(auto)===event.boardId);
  const dbId = automationDbId(auto);
  if (!dbId || !event.boardId) return false;
  return dbId === event.boardId;
}

const TEMPLATE_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export interface RenderCtx {
  record?: ViewRecord | null;
  /** Field defs of the record's database (for {{field:Name}} resolution). */
  fields?: FieldDef[];
  today?: string;
  /** Optional user-id → name resolver for person-valued fields. */
  userName?: (id: string) => string | undefined;
}

/**
 * `{{record.title}}`, `{{record.<builtin>}}`, `{{field:Field Name}}`,
 * `{{today}}`. Unknown placeholders stay literal — an authored template must
 * never silently drop content.
 */
export function renderTemplate(str: unknown, ctx: RenderCtx): string {
  return String(str ?? '').replace(TEMPLATE_RE, (m, name: string) => {
    const key = name.trim();
    if (key === 'today') return ctx.today ?? todayUtc();
    if (key.startsWith('record.')) {
      const v = ctx.record?.[key.slice('record.'.length)];
      return v === undefined || v === null ? '' : String(v);
    }
    if (key.startsWith('field:')) {
      const fname = key.slice('field:'.length).trim().toLowerCase();
      const def = (ctx.fields ?? []).find((f) => f.name.toLowerCase() === fname);
      if (!def) return '';
      const formatted = formatFieldValue(def, ctx.record?.[propKey(def.id)], { userName: ctx.userName });
      return formatted ?? '';
    }
    return m;
  });
}

/** Conditions are view filters AND-combined on the event AFTER snapshot. */
export function conditionsMatch(conditions: Filter[] | undefined, record: ViewRecord, ctx: ViewCtx = {}): boolean {
  if (!conditions || !conditions.length) return true;
  return conditions.every((f) => evalFilter(record, f, ctx));
}

/** Deterministic run dedupe key: one per (outbox batch, automation, event).
 * The outboxId scopes replay vs. fresh fires — re-processing the same outbox
 * row produces the same key, while a later identical edit gets a new outbox
 * and therefore a fresh run. The event discriminator keeps multi-record
 * batches running once per matching event, not once per batch. */
export function runEventKey(automationId: string, event: SemanticEvent, outboxId?: string): string {
  return 'ar_' + fnv1a64hex(`${outboxId ?? ''}|${automationId}|${stableJson(event)}`);
}

export interface ValidationCtx {
  /** Live board rows by id — enables db/column/field checks. */
  boardsById?: Map<string, Record<string, unknown>> | Record<string, Record<string, unknown>>;
  /** Workspace member ids — validates notify/request_approval recipients. */
  memberIds?: Set<string> | string[];
  /** Page ids flagged isTemplate — validates create_from_template. */
  templateIds?: Set<string> | string[];
  /** Live form record ids — validates form.submitted triggers. */
  formIds?: Set<string> | string[];
}

const boardOf = (ctx: ValidationCtx, id: unknown): Record<string, unknown> | undefined => {
  if (typeof id !== 'string' || !ctx.boardsById) return undefined;
  return ctx.boardsById instanceof Map ? ctx.boardsById.get(id) : ctx.boardsById[id];
};
const inSet = (set: Set<string> | string[] | undefined, id: string): boolean =>
  !set ? true : set instanceof Set ? set.has(id) : set.includes(id);

const BUILTIN_FIELD_KEYS = new Set(['title', 'status', 'assigneeId', 'dueDate', 'priority', 'createdAt', 'createdBy']);
const ACTION_FIELD_KEYS=new Set(['title','status','assigneeId','dueDate','priority','description']);

const FILTER_OPS: ReadonlySet<FilterOp> = new Set([
  'is', 'is_not', 'contains', 'not_contains', 'empty', 'not_empty',
  'before', 'after', 'on_or_before', 'on_or_after', 'checked', 'unchecked', 'me',
]);

function fieldDefByKey(board: Record<string, unknown> | undefined, key: string): FieldDef | undefined {
  if (!key.startsWith('p_')) return undefined;
  return fieldsOf(board).find((f) => f.id === key.slice(2));
}

/**
 * Static validation of one automation config. Validation is advisory —
 * execution re-validates live state every run; this surfaces config errors
 * early in the editor and fails runs cleanly before any partial write.
 */
export function validateAutomation(auto: AutomationConfig, ctx: ValidationCtx = {}): string[] {
  const errors: string[] = [];
  const t = auto.trigger;
  if (!auto.name || !String(auto.name).trim()) errors.push('name is required');
  if (!t || typeof t.kind !== 'string') {
    errors.push('trigger is required');
    return errors;
  }
  const dbId = automationDbId(auto);
  const board = boardOf(ctx, dbId);

  const dbScoped = t.kind !== 'form.submitted';
  if (dbScoped) {
    if (!dbId) errors.push('databaseId is required');
    else if (ctx.boardsById && !board) errors.push(`database ${dbId} not found`);
  }
  switch (t.kind) {
    case 'record.created':
      break;
    case 'stage_changed': {
      if (t.to !== undefined) {
        const cols = Array.isArray(board?.columns) ? (board!.columns as { id: string }[]) : [];
        if (ctx.boardsById && board && cols.length && !cols.some((c) => c.id === t.to)) {
          errors.push(`stage ${t.to} is not a column of ${String(board?.name ?? dbId)}`);
        }
      }
      break;
    }
    case 'field_changed': {
      if (t.fieldId !== undefined && ctx.boardsById && board) {
        const ok = BUILTIN_FIELD_KEYS.has(t.fieldId) || t.fieldId.startsWith('rel_') || !!fieldDefByKey(board, t.fieldId);
        if (!ok) errors.push(`field ${t.fieldId} not found on ${String(board?.name ?? dbId)}`);
      }
      break;
    }
    case 'date_offset': {
      const key = normalizeDateKey(t.dateKey);
      if (key !== 'dueDate' && ctx.boardsById && board) {
        const def = fieldDefByKey(board, key);
        if (!def) errors.push(`date field ${key} not found on ${String(board?.name ?? dbId)}`);
        else if (def.type !== 'date') errors.push(`field ${key} is not a date field`);
      }
      if (!Number.isFinite(Number(t.days ?? 0))) errors.push('days must be a number');
      break;
    }
    case 'form.submitted': {
      if (t.formId !== undefined && !inSet(ctx.formIds, t.formId)) errors.push(`form ${t.formId} not found`);
      break;
    }
    default:
      errors.push(`unknown trigger kind ${String(t.kind)}`);
  }

  for (const [i, c] of (auto.conditions ?? []).entries()) {
    if (!c || typeof c.key !== 'string' || !FILTER_OPS.has(c.op)) errors.push(`condition ${i + 1} is invalid`);
  }

  const actions = auto.actions ?? [];
  if(!Array.isArray(actions)) return [...errors,'actions must be an array'];
  if(actions.length>20) errors.push('at most 20 actions');
  if (!actions.length) errors.push('at least one action is required');
  for (const [i, a] of actions.entries()) {
    const at = `action ${i + 1}`;
    if (!a || typeof a.type !== 'string') {
      errors.push(`${at} is invalid`);
      continue;
    }
    switch (a.type) {
      case 'create_record': {
        if (!a.databaseId) errors.push(`${at}: databaseId is required`);
        else if (ctx.boardsById && !boardOf(ctx, a.databaseId)) errors.push(`${at}: database ${a.databaseId} not found`);
        if (!a.title || !String(a.title).trim()) errors.push(`${at}: title is required`);
        const target=boardOf(ctx,a.databaseId);
        for(const key of Object.keys(a.fields??{})) if(!ACTION_FIELD_KEYS.has(key)&&(!fieldDefByKey(target,key)||fieldDefByKey(target,key)?.type==='relation')) errors.push(`${at}: field ${key} is not writable on target database`);
        if(a.link?.fieldId) {
          const relation=fieldsOf(target).find(f=>f.id===a.link!.fieldId);
          if(ctx.boardsById&&(!relation||relation.type!=='relation'||relation.relation?.target!==dbId)) errors.push(`${at}: relation field cannot link to the trigger database`);
        }
        break;
      }
      case 'create_from_template': {
        if (!a.templateId) errors.push(`${at}: templateId is required`);
        else if (!inSet(ctx.templateIds, a.templateId)) errors.push(`${at}: template ${a.templateId} not found`);
        break;
      }
      case 'set_field': {
        if (!a.fieldKey || !String(a.fieldKey).trim()) errors.push(`${at}: fieldKey is required`);
        else if(ctx.boardsById&&!ACTION_FIELD_KEYS.has(a.fieldKey)&&(!fieldDefByKey(board,a.fieldKey)||fieldDefByKey(board,a.fieldKey)?.type==='relation')) errors.push(`${at}: field ${a.fieldKey} is not writable`);
        break;
      }
      case 'notify': {
        if (!a.userField && !(a.userIds && a.userIds.length)) errors.push(`${at}: a recipient is required`);
        for (const uid of a.userIds ?? []) if (!inSet(ctx.memberIds, uid)) errors.push(`${at}: user ${uid} is not a member`);
        if (!a.message || !String(a.message).trim()) errors.push(`${at}: message is required`);
        if(a.userField&&ctx.boardsById&&a.userField!=='assigneeId'&&fieldsOf(board).find(f=>f.id===a.userField)?.type!=='person') errors.push(`${at}: userField must be a person field`);
        break;
      }
      case 'request_approval': {
        if (!a.approverField && !a.approverId) errors.push(`${at}: an approver is required`);
        if (a.approverId && !inSet(ctx.memberIds, a.approverId)) errors.push(`${at}: user ${a.approverId} is not a member`);
        if(a.approverField&&ctx.boardsById&&a.approverField!=='assigneeId'&&fieldsOf(board).find(f=>f.id===a.approverField)?.type!=='person') errors.push(`${at}: approverField must be a person field`);
        break;
      }
      case 'add_subrecords': {
        if (!Array.isArray(a.titles) || !a.titles.length) errors.push(`${at}: at least one title is required`);
        else if (a.titles.length > 20) errors.push(`${at}: at most 20 titles`);
        break;
      }
      default:
        errors.push(`${at}: unknown action type ${String(a.type)}`);
    }
  }
  return errors;
}

/* ---------- editor labels (shared so worker + UI phrase identically) ---------- */

export const TRIGGER_KINDS: { id: AutomationTriggerKind; label: string }[] = [
  { id: 'record.created', label: 'record is created' },
  { id: 'stage_changed', label: 'stage changes' },
  { id: 'field_changed', label: 'field changes' },
  { id: 'date_offset', label: 'a date is reached' },
  { id: 'form.submitted', label: 'a form is submitted' },
];

export const ACTION_TYPES: { id: AutomationAction['type']; label: string }[] = [
  { id: 'create_record', label: 'create record' },
  { id: 'create_from_template', label: 'create from template' },
  { id: 'set_field', label: 'set field' },
  { id: 'notify', label: 'notify' },
  { id: 'request_approval', label: 'request approval' },
  { id: 'add_subrecords', label: 'add sub-records' },
];
