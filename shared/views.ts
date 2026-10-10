/* View config + evaluation (Phase 1 §2.4, §3.1): pure filter/sort/group shared
 * by the client view components and MCP `query_records`. Records are generic
 * rows; custom-field values live at top-level `p_<fieldId>`; relation values
 * are never stored on the record — resolved on demand via ctx.relationTitles. */

import { cmpOrder } from './order';
import { isSelectType, optionByName, type FieldDef } from './fields';

export type ViewType = 'board' | 'table' | 'list' | 'gallery';

export type FieldKey =
  | 'title'
  | 'status'
  | 'assigneeId'
  | 'dueDate'
  | 'priority'
  | 'createdAt'
  | 'createdBy'
  | `p_${string}`
  | `rel_${string}`;

export type FilterOp =
  | 'is'
  | 'is_not'
  | 'contains'
  | 'not_contains'
  | 'empty'
  | 'not_empty'
  | 'before'
  | 'after'
  | 'on_or_before'
  | 'on_or_after'
  | 'checked'
  | 'unchecked'
  | 'me';

export interface Filter {
  key: FieldKey;
  op: FilterOp;
  value?: unknown;
}

export interface SortSpec {
  key: FieldKey;
  dir: 'asc' | 'desc';
}

export interface ViewConfig {
  filters?: Filter[];            // AND-combined
  sorts?: SortSpec[];
  groupBy?: FieldKey | null;     // board view: 'status' (default) or a select/person field
  visible?: FieldKey[];          // table/list/gallery columns & card props, in order
  cover?: 'cover' | `p_${string}` | null;  // gallery/board card image source
  showSubrecords?: boolean;      // default false on board/gallery, true (nested) on table
  mine?: boolean;                // shortcut filter: assignee = current user
}

export interface ViewRow {
  id: string;
  databaseId: string;
  name: string;
  type: ViewType;
  order: string;
  config: ViewConfig;
  createdBy?: string;
  createdAt?: number;
  deleted?: boolean;
}

/** Loose record row — synced records are schemaless JSON plus `id`. */
export type ViewRecord = { id?: unknown; deleted?: unknown } & Record<string, unknown>;

export interface ViewCtx {
  /** Current user id — the `me` filter op and `mine` view shortcut. */
  meId?: string | null;
  /** ISO 'yyyy-mm-dd'; a filter value of 'today' resolves against this. */
  today?: string;
  /** Field defs by field id for `p_<id>` keys (option order, coercions). */
  fieldsById?: Map<string, FieldDef> | Record<string, FieldDef>;
  /** Relation display titles for a `rel_<fieldId>` key on a record. */
  relationTitles?: (recordId: string, fieldId: string) => string[];
  /** Stage ordering for 'status' sorts/groups: column ids in order or id → index. */
  columnsById?: readonly string[] | Map<string, number> | Record<string, number>;
}

export interface ViewGroup {
  /** Group key — raw value as string ('' = empty group, always last). */
  key: string;
  rows: ViewRecord[];
}

export interface ViewResult {
  rows: ViewRecord[];
  groups?: ViewGroup[];
}

const PRIORITY_RANK: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, urgent: 4 };

function fieldDef(ctx: ViewCtx, key: FieldKey): FieldDef | undefined {
  if (!key.startsWith('p_')) return undefined;
  const id = key.slice(2);
  const src = ctx.fieldsById;
  if (!src) return undefined;
  return src instanceof Map ? src.get(id) : (src as Record<string, FieldDef>)[id];
}

function recordId(record: ViewRecord): string {
  return typeof record.id === 'string' ? record.id : '';
}

function columnIndex(ctx: ViewCtx, colId: string): number {
  const c = ctx.columnsById;
  if (!c) return -1;
  if (Array.isArray(c)) return c.indexOf(colId);
  const v = c instanceof Map ? c.get(colId) : (c as Record<string, number>)[colId];
  return typeof v === 'number' ? v : -1;
}

/** Raw value of a FieldKey on a record; `rel_` resolves to title strings. */
export function fieldValue(record: ViewRecord, key: FieldKey, ctx: ViewCtx = {}): unknown {
  if (key.startsWith('p_')) return record[key];
  if (key.startsWith('rel_')) return ctx.relationTitles?.(recordId(record), key.slice(4)) ?? [];
  return record[key];
}

function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function looseEq(a: unknown, b: unknown, ci = false): boolean {
  if (a === b) return true;
  const sa = String(a);
  const sb = String(b);
  return ci ? sa.toLowerCase() === sb.toLowerCase() : sa === sb;
}

/** For select-type fields, accept an option name as well as its id. */
function optionValue(def: FieldDef | undefined, want: unknown): unknown {
  if (!def || !isSelectType(def.type) || typeof want !== 'string') return want;
  if ((def.options ?? []).some((o) => o.id === want)) return want;
  return optionByName(def, want)?.id ?? want;
}

function valueIs(record: ViewRecord, f: Filter, ctx: ViewCtx): boolean {
  const v = fieldValue(record, f.key, ctx);
  const ci = f.key.startsWith('rel_');
  const want = ci ? f.value : optionValue(fieldDef(ctx, f.key), f.value);
  return Array.isArray(v) ? v.some((el) => looseEq(el, want, ci)) : looseEq(v, want, ci);
}

function valueContains(record: ViewRecord, f: Filter, ctx: ViewCtx): boolean {
  const v = fieldValue(record, f.key, ctx);
  if (f.value === undefined || f.value === null) return false;
  if (Array.isArray(v)) {
    if (f.key.startsWith('rel_')) {
      const needle = String(f.value).toLowerCase();
      return v.some((el) => String(el).toLowerCase().includes(needle));
    }
    const want = optionValue(fieldDef(ctx, f.key), f.value);
    return v.some((el) => looseEq(el, want));
  }
  if (typeof v === 'string') return v.toLowerCase().includes(String(f.value).toLowerCase());
  if (typeof v === 'number') return String(v).includes(String(f.value));
  return false;
}

/** <0 a<b, 0 a=b, >0 a>b; null when either side can't be compared. */
function temporalCmp(a: unknown, b: unknown): number | null {
  if (isEmptyValue(a) || isEmptyValue(b)) return null;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function matchesMe(v: unknown, meId: string | null | undefined): boolean {
  if (!meId) return false;
  return Array.isArray(v) ? v.some((el) => looseEq(el, meId)) : looseEq(v, meId);
}

/** Evaluate one filter against a record. Unknown/missing values never match value ops. */
export function evalFilter(record: ViewRecord, filter: Filter, ctx: ViewCtx = {}): boolean {
  const v = fieldValue(record, filter.key, ctx);
  let want = filter.value;
  if (want === 'today' && ctx.today) want = ctx.today;
  switch (filter.op) {
    case 'empty':
      return isEmptyValue(v);
    case 'not_empty':
      return !isEmptyValue(v);
    case 'checked':
      return v === true;
    case 'unchecked':
      return v !== true;
    case 'me':
      return matchesMe(v, ctx.meId);
    case 'is':
      return valueIs(record, { ...filter, value: want }, ctx);
    case 'is_not':
      return !valueIs(record, { ...filter, value: want }, ctx);
    case 'contains':
      return valueContains(record, { ...filter, value: want }, ctx);
    case 'not_contains':
      return !valueContains(record, { ...filter, value: want }, ctx);
    case 'before': {
      const c = temporalCmp(v, want);
      return c !== null && c < 0;
    }
    case 'after': {
      const c = temporalCmp(v, want);
      return c !== null && c > 0;
    }
    case 'on_or_before': {
      const c = temporalCmp(v, want);
      return c !== null && c <= 0;
    }
    case 'on_or_after': {
      const c = temporalCmp(v, want);
      return c !== null && c >= 0;
    }
    default:
      return true;
  }
}

/** Per-key ordering of two NON-EMPTY values: options by def order, status by columns, priority fixed, else locale. */
function compareValues(va: unknown, vb: unknown, key: FieldKey, ctx: ViewCtx): number {
  const def = fieldDef(ctx, key);
  if (def && isSelectType(def.type)) {
    const idx = (v: unknown) => {
      const ids = Array.isArray(v) ? v : [v];
      const ranks = ids.map((id) => (def.options ?? []).findIndex((o) => o.id === id)).filter((i) => i >= 0);
      return ranks.length ? Math.min(...ranks) : Number.MAX_SAFE_INTEGER - 1;
    };
    const d = idx(va) - idx(vb);
    return d !== 0 ? d : String(va).localeCompare(String(vb));
  }
  if (key === 'status') {
    const ia = columnIndex(ctx, String(va));
    const ib = columnIndex(ctx, String(vb));
    const d = (ia < 0 ? Number.MAX_SAFE_INTEGER - 1 : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER - 1 : ib);
    return d !== 0 ? d : String(va).localeCompare(String(vb));
  }
  if (key === 'priority') {
    const ra = PRIORITY_RANK[String(va)] ?? Object.keys(PRIORITY_RANK).length;
    const rb = PRIORITY_RANK[String(vb)] ?? Object.keys(PRIORITY_RANK).length;
    return ra !== rb ? ra - rb : String(va).localeCompare(String(vb));
  }
  if (def?.type === 'number' || (typeof va === 'number' && typeof vb === 'number')) {
    return (va as number) - (vb as number);
  }
  if (def?.type === 'checkbox') {
    return (va === true ? 1 : 0) - (vb === true ? 1 : 0);
  }
  const sa = Array.isArray(va) ? va.join(', ') : String(va);
  const sb = Array.isArray(vb) ? vb.join(', ') : String(vb);
  return sa.localeCompare(sb);
}

/** Stable multi-key sort (Array.prototype.sort is stable). Nulls/empty always sort last in BOTH directions. */
export function sortRecords(records: readonly ViewRecord[], sorts: readonly SortSpec[] | undefined, ctx: ViewCtx = {}): ViewRecord[] {
  if (!sorts?.length) return [...records];
  const indexed = records.map((r, i) => ({ r, i }));
  indexed.sort((a, b) => {
    for (const s of sorts) {
      const va = fieldValue(a.r, s.key, ctx);
      const vb = fieldValue(b.r, s.key, ctx);
      const ea = isEmptyValue(va);
      const eb = isEmptyValue(vb);
      if (ea && eb) continue;
      if (ea) return 1;
      if (eb) return -1;
      const c = compareValues(va, vb, s.key, ctx);
      if (c !== 0) return s.dir === 'desc' ? -c : c;
    }
    return a.i - b.i;
  });
  return indexed.map((x) => x.r);
}

function groupRows(rows: ViewRecord[], groupBy: FieldKey, ctx: ViewCtx): ViewGroup[] {
  const buckets = new Map<string, ViewRecord[]>();
  for (const r of rows) {
    const v = fieldValue(r, groupBy, ctx);
    const key = isEmptyValue(v) ? '' : Array.isArray(v) ? String(v[0]) : String(v);
    const list = buckets.get(key) ?? [];
    list.push(r);
    buckets.set(key, list);
  }
  // Order groups by the same per-key ordering (status → column order, select → option order…).
  const keys = [...buckets.keys()].sort((ka, kb) => {
    if (ka === '' && kb === '') return 0;
    if (ka === '') return 1;
    if (kb === '') return -1;
    return compareValues(ka, kb, groupBy, ctx) || cmpOrder(ka, kb);
  });
  return keys.map((key) => ({ key, rows: buckets.get(key)! }));
}

/**
 * Apply a view config to records: drop deleted, AND-combine `filters` plus the
 * `mine` shortcut, stable-sort, and group when `groupBy` is set.
 */
export function applyView(records: readonly ViewRecord[], config: ViewConfig = {}, ctx: ViewCtx = {}): ViewResult {
  const filters = [...(config.filters ?? [])];
  if (config.mine) filters.push({ key: 'assigneeId', op: 'me' });
  const live = records.filter((r) => !r.deleted);
  const rows = filters.length ? live.filter((r) => filters.every((f) => evalFilter(r, f, ctx))) : live;
  const sorted = sortRecords(rows, config.sorts, ctx);
  if (config.groupBy) return { rows: sorted, groups: groupRows(sorted, config.groupBy, ctx) };
  return { rows: sorted };
}
