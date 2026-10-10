import { describe, expect, it } from 'vitest';
import { aggregate, applyView, evalFilter, fieldValue, resolveDateKey, sortRecords, VIEW_TYPES, type Filter, type ViewConfig, type ViewCtx, type ViewRecord, type ViewRow, type ViewType } from '../shared/views';
import type { FieldDef } from '../shared/fields';

const tags: FieldDef = { id: 'ftags', name: 'Tags', type: 'multi_select', options: [
  { id: 'o1', name: 'Video', color: '#0091ff' },
  { id: 'o2', name: 'Design', color: '#e93d82' },
  { id: 'o3', name: 'Writing', color: '#30a46c' },
] };
const stage: FieldDef = { id: 'fstage', name: 'Stage', type: 'select', options: [
  { id: 's1', name: 'Live', color: '#30a46c' },
  { id: 's2', name: 'Draft', color: '#8a8a8a' },
] };
const hours: FieldDef = { id: 'fhours', name: 'Hours', type: 'number' };
const done: FieldDef = { id: 'fdone', name: 'Done', type: 'checkbox' };
const rel: FieldDef = { id: 'forg', name: 'Organization', type: 'relation', relation: { target: 'db-orgs', primary: true } };

const ctx: ViewCtx = {
  meId: 'u-me',
  today: '2026-10-08',
  fieldsById: { ftags: tags, fstage: stage, fhours: hours, fdone: done, forg: rel },
  columnsById: ['c-todo', 'c-doing', 'c-done'],
  relationTitles: (recordId, fieldId) =>
    fieldId === 'forg' && recordId === 'r1' ? ['Mayavadi Space', 'TCG'] : fieldId === 'forg' && recordId === 'r2' ? ['Dhaanyam'] : [],
};

const rec = (id: string, data: Record<string, unknown>): ViewRecord => ({ id, ...data });
const evalOn = (r: ViewRecord) => (f: Filter) => evalFilter(r, f, ctx);

describe('evalFilter — equality ops', () => {
  const r = rec('r1', { title: 'Launch', status: 'c-doing', assigneeId: 'u-me', p_ftags: ['o1', 'o3'], p_fstage: 's2', rel: undefined });

  it('is / is_not on scalars', () => {
    expect(evalOn(r)({ key: 'status', op: 'is', value: 'c-doing' })).toBe(true);
    expect(evalOn(r)({ key: 'status', op: 'is', value: 'c-done' })).toBe(false);
    expect(evalOn(r)({ key: 'status', op: 'is_not', value: 'c-done' })).toBe(true);
  });

  it('is matches membership inside multi_select arrays', () => {
    expect(evalOn(r)({ key: 'p_ftags', op: 'is', value: 'o3' })).toBe(true);
    expect(evalOn(r)({ key: 'p_ftags', op: 'is', value: 'o2' })).toBe(false);
    expect(evalOn(r)({ key: 'p_ftags', op: 'is_not', value: 'o2' })).toBe(true);
  });

  it('select accepts option names case-insensitively', () => {
    expect(evalOn(r)({ key: 'p_fstage', op: 'is', value: 'Draft' })).toBe(true);
    expect(evalOn(r)({ key: 'p_fstage', op: 'is', value: 'draft' })).toBe(true);
    expect(evalOn(r)({ key: 'p_fstage', op: 'is', value: 'Live' })).toBe(false);
  });

  it('is on a missing value is false; is_not on a missing value is true', () => {
    const bare = rec('r9', { title: 'x' });
    expect(evalOn(bare)({ key: 'dueDate', op: 'is', value: '2026-01-01' })).toBe(false);
    expect(evalOn(bare)({ key: 'dueDate', op: 'is_not', value: '2026-01-01' })).toBe(true);
  });
});

describe('evalFilter — contains / empty', () => {
  const r = rec('r1', { title: 'Big Launch Plan', p_ftags: ['o1', 'o3'] });

  it('contains does case-insensitive substring on text', () => {
    expect(evalOn(r)({ key: 'title', op: 'contains', value: 'launch' })).toBe(true);
    expect(evalOn(r)({ key: 'title', op: 'contains', value: 'nope' })).toBe(false);
    expect(evalOn(r)({ key: 'title', op: 'not_contains', value: 'nope' })).toBe(true);
  });

  it('contains on multi_select matches an option id or name', () => {
    expect(evalOn(r)({ key: 'p_ftags', op: 'contains', value: 'o3' })).toBe(true);
    expect(evalOn(r)({ key: 'p_ftags', op: 'contains', value: 'Writing' })).toBe(true);
    expect(evalOn(r)({ key: 'p_ftags', op: 'contains', value: 'o2' })).toBe(false);
  });

  it('empty covers null/undefined/empty-string/empty-array; not_empty inverts', () => {
    expect(evalOn(rec('a', { dueDate: null }))({ key: 'dueDate', op: 'empty' })).toBe(true);
    expect(evalOn(rec('b', { dueDate: '2026-01-01' }))({ key: 'dueDate', op: 'empty' })).toBe(false);
    expect(evalOn(rec('c', { p_ftags: [] }))({ key: 'p_ftags', op: 'empty' })).toBe(true);
    expect(evalOn(rec('d', { p_fhours: 0 }))({ key: 'p_fhours', op: 'empty' })).toBe(false); // 0 is a value
    expect(evalOn(rec('e', { p_fdone: false }))({ key: 'p_fdone', op: 'not_empty' })).toBe(true); // false is a value
    expect(evalOn(r)({ key: 'title', op: 'not_empty' })).toBe(true);
  });
});

describe('evalFilter — date/order ops', () => {
  const r = rec('r1', { dueDate: '2026-10-05', createdAt: 100 });

  it('before / after / on_or_before / on_or_after on ISO dates', () => {
    expect(evalOn(r)({ key: 'dueDate', op: 'before', value: '2026-10-08' })).toBe(true);
    expect(evalOn(r)({ key: 'dueDate', op: 'after', value: '2026-10-08' })).toBe(false);
    expect(evalOn(r)({ key: 'dueDate', op: 'on_or_before', value: '2026-10-05' })).toBe(true);
    expect(evalOn(r)({ key: 'dueDate', op: 'on_or_after', value: '2026-10-05' })).toBe(true);
    expect(evalOn(r)({ key: 'dueDate', op: 'on_or_after', value: '2026-10-06' })).toBe(false);
  });

  it('value "today" resolves against ctx.today', () => {
    expect(evalOn(r)({ key: 'dueDate', op: 'before', value: 'today' })).toBe(true);
    expect(evalOn(r)({ key: 'dueDate', op: 'after', value: 'today' })).toBe(false);
  });

  it('missing values never match date ops', () => {
    const bare = rec('x', {});
    for (const op of ['before', 'after', 'on_or_before', 'on_or_after'] as const) {
      expect(evalOn(bare)({ key: 'dueDate', op, value: '2026-10-08' })).toBe(false);
    }
  });

  it('numeric values compare numerically', () => {
    expect(evalOn(r)({ key: 'createdAt', op: 'before', value: 200 })).toBe(true);
    expect(evalOn(r)({ key: 'createdAt', op: 'after', value: 200 })).toBe(false);
  });
});

describe('evalFilter — checked / unchecked / me', () => {
  it('checked is strict true; unchecked covers false and missing', () => {
    expect(evalOn(rec('a', { p_fdone: true }))({ key: 'p_fdone', op: 'checked' })).toBe(true);
    expect(evalOn(rec('b', { p_fdone: false }))({ key: 'p_fdone', op: 'checked' })).toBe(false);
    expect(evalOn(rec('c', {}))({ key: 'p_fdone', op: 'unchecked' })).toBe(true);
    expect(evalOn(rec('d', { p_fdone: true }))({ key: 'p_fdone', op: 'unchecked' })).toBe(false);
  });

  it('me matches ctx.meId on assignee and person fields (incl. arrays)', () => {
    expect(evalOn(rec('a', { assigneeId: 'u-me' }))({ key: 'assigneeId', op: 'me' })).toBe(true);
    expect(evalOn(rec('b', { assigneeId: 'u-other' }))({ key: 'assigneeId', op: 'me' })).toBe(false);
    expect(evalOn(rec('c', {}))({ key: 'assigneeId', op: 'me' })).toBe(false);
    expect(evalFilter(rec('d', {}), { key: 'assigneeId', op: 'me' }, {})).toBe(false); // no meId → no match
  });
});

describe('evalFilter — relation keys', () => {
  it('rel_ values come from ctx.relationTitles; contains is a title substring', () => {
    const r1 = rec('r1', {});
    const r2 = rec('r2', {});
    const r3 = rec('r3', {});
    expect(fieldValue(r1, 'rel_forg', ctx)).toEqual(['Mayavadi Space', 'TCG']);
    expect(evalOn(r1)({ key: 'rel_forg', op: 'contains', value: 'mayavadi' })).toBe(true);
    expect(evalOn(r2)({ key: 'rel_forg', op: 'contains', value: 'dhaan' })).toBe(true);
    expect(evalOn(r3)({ key: 'rel_forg', op: 'contains', value: 'mayavadi' })).toBe(false);
    expect(evalOn(r1)({ key: 'rel_forg', op: 'is', value: 'TCG' })).toBe(true);
    expect(evalOn(r1)({ key: 'rel_forg', op: 'is', value: 'tcg' })).toBe(true);
    expect(evalOn(r3)({ key: 'rel_forg', op: 'empty' })).toBe(true);
    expect(evalOn(r1)({ key: 'rel_forg', op: 'not_empty' })).toBe(true);
  });
});

describe('sortRecords', () => {
  it('sorts title by locale, stably for equal keys', () => {
    const rows = [
      rec('a', { title: 'beta' }),
      rec('b', { title: 'alpha' }),
      rec('c', { title: 'beta' }),
      rec('d', { title: 'Beta' }),
    ];
    const sorted = sortRecords(rows, [{ key: 'title', dir: 'asc' }], ctx);
    expect(sorted.map((r) => r.id)).toEqual(['b', 'a', 'c', 'd']); // 'beta' < 'Beta' in locale; a before c (stable)
  });

  it('nulls and empty values always sort last — both directions', () => {
    const rows = [
      rec('a', { dueDate: '2026-01-02' }),
      rec('b', {}),
      rec('c', { dueDate: '2026-01-01' }),
      rec('d', { dueDate: '' }),
    ];
    const asc = sortRecords(rows, [{ key: 'dueDate', dir: 'asc' }], ctx).map((r) => r.id);
    const desc = sortRecords(rows, [{ key: 'dueDate', dir: 'desc' }], ctx).map((r) => r.id);
    expect(asc.slice(0, 2)).toEqual(['c', 'a']);
    expect(desc.slice(0, 2)).toEqual(['a', 'c']);
    expect(new Set(asc.slice(2))).toEqual(new Set(['b', 'd']));
    expect(new Set(desc.slice(2))).toEqual(new Set(['b', 'd']));
  });

  it('select sorts by option order, not alphabetically', () => {
    const rows = [rec('a', { p_fstage: 's1' }), rec('b', { p_fstage: 's2' }), rec('c', { p_fstage: 's1' })];
    const sorted = sortRecords(rows, [{ key: 'p_fstage', dir: 'asc' }], ctx);
    expect(sorted.map((r) => r.id)).toEqual(['a', 'c', 'b']); // s1 'Live' is option 0, stable a before c
  });

  it('status sorts by column order via columnsById', () => {
    const rows = [rec('a', { status: 'c-done' }), rec('b', { status: 'c-todo' }), rec('c', { status: 'c-doing' })];
    expect(sortRecords(rows, [{ key: 'status', dir: 'asc' }], ctx).map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('multi-key sorts chain in order', () => {
    const rows = [
      rec('a', { status: 'c-todo', title: 'b' }),
      rec('b', { status: 'c-todo', title: 'a' }),
      rec('c', { status: 'c-done', title: 'a' }),
    ];
    const sorted = sortRecords(rows, [{ key: 'status', dir: 'asc' }, { key: 'title', dir: 'asc' }], ctx);
    expect(sorted.map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });

  it('numbers sort numerically', () => {
    const rows = [rec('a', { p_fhours: 10 }), rec('b', { p_fhours: 2 }), rec('c', { p_fhours: 1 })];
    expect(sortRecords(rows, [{ key: 'p_fhours', dir: 'asc' }], ctx).map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('applyView', () => {
  const rows: ViewRecord[] = [
    rec('a', { title: 'A', status: 'c-todo', assigneeId: 'u-me', dueDate: '2026-10-01' }),
    rec('b', { title: 'B', status: 'c-doing', assigneeId: 'u-other', dueDate: '2026-10-02' }),
    rec('c', { title: 'C', status: 'c-done', assigneeId: 'u-me' }),
    rec('d', { title: 'D', status: 'c-todo', deleted: true }), // soft-deleted never shows
  ];

  it('drops deleted records and AND-combines filters', () => {
    const { rows: out } = applyView(rows, { filters: [{ key: 'status', op: 'is', value: 'c-todo' }] }, ctx);
    expect(out.map((r) => r.id)).toEqual(['a']);
    const all = applyView(rows, {}, ctx);
    expect(all.rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('mine shortcut filters to assignee = ctx.meId', () => {
    const { rows: out } = applyView(rows, { mine: true }, ctx);
    expect(out.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('groups by a key preserving row order; empty group last', () => {
    const { groups } = applyView(rows, { groupBy: 'status', sorts: [{ key: 'dueDate', dir: 'asc' }] }, ctx);
    expect(groups?.map((g) => g.key)).toEqual(['c-todo', 'c-doing', 'c-done']); // column order
    expect(groups?.[0].rows.map((r) => r.id)).toEqual(['a']);
    const byPriority = applyView(
      [rec('x', { priority: 'high' }), rec('y', {}), rec('z', { priority: 'low' })],
      { groupBy: 'priority' },
      ctx,
    );
    expect(byPriority.groups?.map((g) => g.key)).toEqual(['low', 'high', '']); // priority order, '' last
  });
});

describe('Phase 3 — includeArchived', () => {
  const rows: ViewRecord[] = [
    rec('a', { title: 'Active' }),
    rec('b', { title: 'Gone', archived: true }),
    rec('c', { title: 'False flag', archived: false }),
    rec('d', { title: 'Deleted', archived: true, deleted: true }),
  ];

  it('archived rows are dropped by default and kept with includeArchived', () => {
    expect(applyView(rows, {}, ctx).rows.map((r) => r.id)).toEqual(['a', 'c']);
    expect(applyView(rows, { includeArchived: true }, ctx).rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('archived rows drop alongside other filters when includeArchived is absent', () => {
    const { rows: out } = applyView(rows, { filters: [{ key: 'title', op: 'contains', value: 'e' }] }, ctx);
    expect(out.map((r) => r.id)).toEqual(['a', 'c']); // 'Gone'/'Deleted' match 'e' but are archived/deleted
  });

  it('aggregate drops archived rows like query_records', () => {
    const res = aggregate(rows, { agg: 'count' }, ctx);
    expect(res.count).toBe(2);
    expect(res.ids).toEqual(['a', 'c']);
  });
});

describe('Phase 3 — aggregate', () => {
  const rows: ViewRecord[] = [
    rec('a', { title: 'A', status: 'c-todo', p_fhours: 10 }),
    rec('b', { title: 'B', status: 'c-todo', p_fhours: 4 }),
    rec('c', { title: 'C', status: 'c-done', p_fhours: 'not a number' }),
    rec('d', { title: 'D', status: 'c-done', p_fhours: null }),
    rec('e', { title: 'E', status: 'c-done' }), // missing value
    rec('f', { title: 'F', status: 'c-done', p_fhours: Number.POSITIVE_INFINITY }),
    rec('g', { title: 'G', status: 'c-done', deleted: true, p_fhours: 100 }),
    rec('h', { title: 'H', status: 'c-done', archived: true, p_fhours: 1000 }),
  ];

  it('count ignores fieldKey; value=count, ids are the filtered set', () => {
    const res = aggregate(rows, { agg: 'count', fieldKey: 'p_fhours' }, ctx);
    // g (deleted) + h (archived) dropped by applyView → 6 rows
    expect(res).toEqual({ value: 6, count: 6, numericCount: 6, ids: ['a', 'b', 'c', 'd', 'e', 'f'] });
    const filtered = aggregate(rows, { agg: 'count', filters: [{ key: 'status', op: 'is', value: 'c-done' }] }, ctx);
    expect(filtered.ids).toEqual(['c', 'd', 'e', 'f']);
    expect(filtered.value).toBe(4);
  });

  it('sum coerces Number(v), skips null/empty/invalid/non-finite', () => {
    const res = aggregate(rows, { agg: 'sum', fieldKey: 'p_fhours' }, ctx);
    expect(res.value).toBe(14); // 10 + 4; 'not a number', null, missing, Infinity skipped
    expect(res.numericCount).toBe(2);
    expect(res.count).toBe(6);
  });

  it('sum of an empty set is 0', () => {
    const res = aggregate(rows, { agg: 'sum', fieldKey: 'p_fhours', filters: [{ key: 'status', op: 'is', value: 'c-todo' }] }, ctx);
    expect(res.value).toBe(14);
    const none = aggregate(rows, { agg: 'sum', fieldKey: 'p_fhours', filters: [{ key: 'title', op: 'is', value: 'zzz' }] }, ctx);
    expect(none.value).toBe(0);
    expect(none.numericCount).toBe(0);
    expect(none.count).toBe(0);
  });

  it('avg returns mean over numeric rows and null when numericCount is 0', () => {
    const res = aggregate(rows, { agg: 'avg', fieldKey: 'p_fhours' }, ctx);
    expect(res.value).toBeCloseTo(7);
    expect(res.numericCount).toBe(2);
    const empty = aggregate(rows, { agg: 'avg', fieldKey: 'p_fhours', filters: [{ key: 'title', op: 'is', value: 'zzz' }] }, ctx);
    expect(empty.value).toBeNull();
    const noKey = aggregate(rows, { agg: 'avg' }, ctx);
    expect(noKey.value).toBeNull();
    expect(noKey.numericCount).toBe(0);
  });

  it('respects filters the same way applyView does', () => {
    const res = aggregate(rows, { agg: 'sum', fieldKey: 'p_fhours', filters: [{ key: 'status', op: 'is', value: 'c-todo' }] }, ctx);
    expect(res.ids).toEqual(['a', 'b']);
    expect(res.value).toBe(14);
  });
});

describe('Phase 2 — calendar/timeline view config', () => {
  it('calendar and timeline are valid ViewTypes', () => {
    const types: ViewType[] = ['calendar', 'timeline'];
    for (const t of types) {
      const row: ViewRow = { id: 'v1', databaseId: 'db', name: 'v', type: t, order: 'a', config: {} };
      expect(row.type).toBe(t);
    }
    expect(VIEW_TYPES).toContain('calendar');
    expect(VIEW_TYPES).toContain('timeline');
  });

  it('resolveDateKey defaults to dueDate and honors config', () => {
    expect(resolveDateKey({})).toBe('dueDate');
    expect(resolveDateKey(undefined)).toBe('dueDate');
    expect(resolveDateKey(null)).toBe('dueDate');
    expect(resolveDateKey({ dateKey: 'dueDate' })).toBe('dueDate');
    expect(resolveDateKey({ dateKey: 'p_fdeadline' })).toBe('p_fdeadline');
  });

  it('date config fields pass through applyView untouched', () => {
    const cfg: ViewConfig = {
      dateKey: 'p_deadline',
      endDateKey: 'p_launch',
      timelineScale: 'quarter',
      sorts: [{ key: 'title', dir: 'asc' }],
    };
    const { rows } = applyView(
      [rec('b', { title: 'b', p_deadline: '2026-01-02' }), rec('a', { title: 'a', p_deadline: '2026-01-01' })],
      cfg,
      ctx,
    );
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']); // sorts still apply; date fields don't break eval
    expect(cfg.timelineScale).toBe('quarter');
  });
});
