/* View evaluation — shared by client views and MCP query_records. Pure. */
import { propKey, taskProp, type FieldDef, optionByName } from './fields';

export interface ViewFilter { fieldId: string; op: string; value?: unknown }
export interface ViewSort { fieldId: string; dir: 'asc' | 'desc' }
export interface ViewConfig {
  filters?: ViewFilter[];
  sorts?: ViewSort[];
  groupBy?: string;
  visibleFields?: string[];
  cover?: string;
}

export interface ViewCtx {
  meId?: string;
  today?: string; // ISO yyyy-mm-dd
  fieldsById?: Map<string, FieldDef>;
  relationTitles?: (recordId: string, fieldId: string) => string[];
  columnsById?: Map<string, { id: string; name: string }>;
}

type Rec = Record<string, unknown>;

const val = (r: Rec, fieldId: string, c: ViewCtx): unknown => {
  const f = c.fieldsById?.get(fieldId);
  if (f) {
    if (f.type === 'relation') return c.relationTitles?.(String(r.id), f.id) ?? [];
    return taskProp(r, fieldId);
  }
  switch (fieldId) {
    case 'title': return r.title;
    case 'status': return r.status;
    case 'assignee': return r.assigneeId;
    case 'due': return r.dueDate;
    case 'priority': return r.priority;
    case 'createdAt': return r.createdAt;
    case 'id': return r.id;
    default: return r[propKey(fieldId)] ?? r[fieldId];
  }
};

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

export function evalFilter(r: Rec, f: ViewFilter, c: ViewCtx): boolean {
  const v = val(r, f.fieldId, c);
  const w = f.value;
  const eq = (a: unknown, b: unknown) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
  switch (f.op) {
    case 'is':
      if (Array.isArray(v)) return v.some((x) => eq(x, w));
      if (f.fieldId === 'status' && c.columnsById?.size) {
        const col = c.columnsById.get(String(v)) ?? [...c.columnsById.values()].find((x) => eq(x.name, w));
        return !!col && eq(v, col.id);
      }
      const def = c.fieldsById?.get(f.fieldId);
      if (def && (def.type === 'select' || def.type === 'multi_select')) {
        const opt = optionByName(def, String(w ?? '')) ?? (def.options ?? []).find((o) => o.id === w);
        return opt ? (Array.isArray(v) ? v.includes(opt.id) : v === opt.id) : false;
      }
      if (def?.type === 'person') return v === w || eq(c.meId, w) && v === w;
      return eq(v, w);
    case 'is_not':
      return !evalFilter(r, { ...f, op: 'is' }, c);
    case 'contains':
      if (Array.isArray(v)) return v.some((x) => String(x).toLowerCase().includes(String(w ?? '').toLowerCase()));
      return String(v ?? '').toLowerCase().includes(String(w ?? '').toLowerCase());
    case 'not_contains':
      return !evalFilter(r, { ...f, op: 'contains' }, c);
    case 'empty': return isEmpty(v);
    case 'not_empty': return !isEmpty(v);
    case 'before': return typeof v === 'string' && typeof w === 'string' && v < w;
    case 'after': return typeof v === 'string' && typeof w === 'string' && v > w;
    case 'on_or_before': return typeof v === 'string' && typeof w === 'string' && v <= w;
    case 'on_or_after': return typeof v === 'string' && typeof w === 'string' && v >= w;
    case 'checked': return v === true;
    case 'unchecked': return v !== true;
    case 'me': return v === c.meId || (Array.isArray(v) && v.includes(c.meId));
    default: return true;
  }
}

export function applyView(records: Rec[], cfg: ViewConfig, c: ViewCtx): { rows: Rec[]; groups?: Map<string, Rec[]> } {
  let rows = records.filter((r) => (cfg.filters ?? []).every((f) => evalFilter(r, f, c)));
  if (cfg.sorts?.length) {
    const cmp = (a: Rec, b: Rec): number => {
      for (const s of cfg.sorts!) {
        const av = val(a, s.fieldId, c);
        const bv = val(b, s.fieldId, c);
        const ae = isEmpty(av), be = isEmpty(bv);
        let d = 0;
        if (ae && be) d = 0;
        else if (ae) d = 1; // nulls last
        else if (be) d = -1;
        else if (s.fieldId === 'title') d = String(av).localeCompare(String(bv));
        else {
          const def = c.fieldsById?.get(s.fieldId);
          if (def && (def.type === 'select' || def.type === 'multi_select')) {
            const order = (x: unknown) => (def.options ?? []).findIndex((o) => o.id === (Array.isArray(x) ? x[0] : x));
            d = order(av) - order(bv);
          } else if (typeof av === 'number' && typeof bv === 'number') d = av - bv;
          else d = String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
        }
        if (d !== 0) return s.dir === 'desc' ? -d : d;
      }
      return 0;
    };
    rows = rows.slice().sort(cmp); // Array.prototype.sort is stable in modern JS
  }
  if (cfg.groupBy) {
    const groups = new Map<string, Rec[]>();
    for (const r of rows) {
      const g = String(val(r, cfg.groupBy, c) ?? '');
      const l = groups.get(g);
      if (l) l.push(r);
      else groups.set(g, [r]);
    }
    return { rows, groups };
  }
  return { rows };
}
