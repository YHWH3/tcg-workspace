/* Pure custom-field model for boards — shared by client UI, worker/MCP tools and tests. */

export type FieldType = 'text' | 'number' | 'select' | 'multi_select' | 'person' | 'date' | 'url' | 'checkbox';

export interface FieldOption {
  id: string;
  name: string;
  color: string;
}

export interface FieldDef {
  id: string;
  name: string;
  type: FieldType;
  /** select / multi_select options */
  options?: FieldOption[];
  /** render as a chip on board cards */
  showOnCard?: boolean;
}

export const FIELD_TYPES: { id: FieldType; label: string }[] = [
  { id: 'text', label: 'Text' },
  { id: 'number', label: 'Number' },
  { id: 'select', label: 'Select' },
  { id: 'multi_select', label: 'Multi-select' },
  { id: 'person', label: 'Person' },
  { id: 'date', label: 'Date' },
  { id: 'url', label: 'URL' },
  { id: 'checkbox', label: 'Checkbox' },
];

const SELECT_TYPES: FieldType[] = ['select', 'multi_select'];

/** Task property storage key: top-level `p_<fieldId>` so per-field LWW merges different fields independently. */
export function propKey(fieldId: string): string {
  return `p_${fieldId}`;
}

export function fieldsOf(board: { fields?: unknown } | undefined | null): FieldDef[] {
  const f = board?.fields;
  return Array.isArray(f) ? (f as FieldDef[]) : [];
}

/** Task custom-field values: top-level p_* keys present on the task record. */
export function taskProp(task: Record<string, unknown>, fieldId: string): unknown {
  return task[propKey(fieldId)];
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidOption(def: FieldDef, id: unknown): id is string {
  return typeof id === 'string' && !!id && (def.options ?? []).some((o) => o.id === id);
}

/**
 * Coerce a raw value into a storable value for `def`. Returns the coerced
 * value, or `undefined` when the input can't be represented (caller drops it).
 */
export function coerceFieldValue(def: FieldDef, raw: unknown): unknown {
  switch (def.type) {
    case 'text':
    case 'url': {
      if (raw === null || raw === undefined) return undefined;
      const s = String(raw).trim();
      return s === '' ? undefined : s;
    }
    case 'number': {
      if (raw === null || raw === undefined || raw === '') return undefined;
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      return Number.isFinite(n) ? n : undefined;
    }
    case 'checkbox':
      return raw === true || raw === 'true' || raw === 1 ? true : raw === false || raw === 'false' || raw === 0 ? false : undefined;
    case 'date': {
      if (typeof raw !== 'string') return undefined;
      const s = raw.trim().slice(0, 10);
      return ISO_DATE_RE.test(s) ? s : undefined;
    }
    case 'select': {
      // Accept option id or name (case-insensitive).
      const opt = typeof raw === 'string' ? optionByName(def, raw) ?? ((def.options ?? []).find((o) => o.id === raw) ?? null) : null;
      return opt ? opt.id : undefined;
    }
    case 'multi_select': {
      const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
      const ids = list
        .map((v) => (typeof v === 'string' ? (optionByName(def, v) ?? (def.options ?? []).find((o) => o.id === v)) : undefined))
        .filter((o): o is FieldOption => !!o)
        .map((o) => o.id);
      return [...new Set(ids)];
    }
    case 'person': {
      // Caller validates the id against workspace users; here we only shape it.
      return typeof raw === 'string' && raw ? raw : undefined;
    }
  }
}

/** Find a select option by name (case-insensitive) — used by MCP tools. */
export function optionByName(def: FieldDef, name: string): FieldOption | undefined {
  const n = name.trim().toLowerCase();
  return (def.options ?? []).find((o) => o.name.toLowerCase() === n);
}

/** Does this field type carry selectable options? */
export function isSelectType(t: FieldType): boolean {
  return SELECT_TYPES.includes(t);
}

/**
 * Coerce a stored value for display/export: returns a human string, or
 * `undefined` when empty. `resolveUser`/`optionLabel` optional lookups keep the
 * function pure — pass them when names are wanted instead of ids.
 */
export function formatFieldValue(
  def: FieldDef,
  value: unknown,
  lookups?: { userName?: (id: string) => string | undefined },
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  switch (def.type) {
    case 'checkbox':
      return value === true ? '✓' : undefined;
    case 'select': {
      const o = (def.options ?? []).find((o) => o.id === value);
      return o?.name;
    }
    case 'multi_select': {
      const names = (Array.isArray(value) ? value : [])
        .map((id) => (def.options ?? []).find((o) => o.id === id)?.name)
        .filter(Boolean) as string[];
      return names.length ? names.join(', ') : undefined;
    }
    case 'person':
      return lookups?.userName?.(String(value)) ?? String(value);
    default:
      return String(value);
  }
}

/** Option ids a select-type field references that are missing from its options (defensive display). */
export function staleOptionIds(def: FieldDef, value: unknown): string[] {
  const vals = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return vals.filter((v): v is string => typeof v === 'string' && !isValidOption(def, v));
}
