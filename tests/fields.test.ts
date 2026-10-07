import { describe, expect, it } from 'vitest';
import { coerceFieldValue, fieldsOf, formatFieldValue, optionByName, propKey, type FieldDef } from '../shared/fields';

const sel: FieldDef = { id: 'f1', name: 'Stage', type: 'select', options: [{ id: 'o1', name: 'Live', color: '#30a46c' }, { id: 'o2', name: 'Draft', color: '#8a8a8a' }] };
const multi: FieldDef = { id: 'f2', name: 'Tags', type: 'multi_select', options: [{ id: 'o1', name: 'Video', color: '#0091ff' }] };
const num: FieldDef = { id: 'f3', name: 'Hours', type: 'number' };
const cb: FieldDef = { id: 'f4', name: 'Done', type: 'checkbox' };
const date: FieldDef = { id: 'f5', name: 'Ship', type: 'date' };
const person: FieldDef = { id: 'f6', name: 'Owner', type: 'person' };
const txt: FieldDef = { id: 'f7', name: 'Notes', type: 'text' };

describe('field coercion', () => {
  it('select accepts option id or name (case-insensitive)', () => {
    expect(coerceFieldValue(sel, 'o1')).toBe('o1');
    expect(coerceFieldValue(sel, 'Live')).toBe('o1');
    expect(coerceFieldValue(sel, 'live')).toBe('o1');
    expect(coerceFieldValue(sel, 'nope')).toBeUndefined();
  });

  it('multi_select coerces arrays + names, dedupes', () => {
    expect(coerceFieldValue(multi, ['o1', 'Video'])).toEqual(['o1']);
    expect(coerceFieldValue(multi, 'Video')).toEqual(['o1']);
    expect(coerceFieldValue(multi, [])).toEqual([]);
  });

  it('number/date/checkbox/text/url coerce or drop', () => {
    expect(coerceFieldValue(num, '12')).toBe(12);
    expect(coerceFieldValue(num, 'abc')).toBeUndefined();
    expect(coerceFieldValue(date, '2026-10-06')).toBe('2026-10-06');
    expect(coerceFieldValue(date, 'tomorrow')).toBeUndefined();
    expect(coerceFieldValue(cb, 'true')).toBe(true);
    expect(coerceFieldValue(cb, 0)).toBe(false);
    expect(coerceFieldValue(cb, 'junk')).toBeUndefined();
    expect(coerceFieldValue(txt, '  hi  ')).toBe('hi');
    expect(coerceFieldValue(txt, '   ')).toBeUndefined();
    expect(coerceFieldValue(person, 'u123')).toBe('u123');
  });

  it('propKey namespacing keeps per-field LWW', () => {
    expect(propKey('f1')).toBe('p_f1');
  });

  it('fieldsOf tolerates missing/malformed', () => {
    expect(fieldsOf(undefined)).toEqual([]);
    expect(fieldsOf({ fields: 'x' })).toEqual([]);
  });
});

describe('field display', () => {
  it('formats select/multi/person/checkbox', () => {
    expect(formatFieldValue(sel, 'o2')).toBe('Draft');
    expect(formatFieldValue(multi, ['o1'])).toBe('Video');
    expect(formatFieldValue(cb, true)).toBe('✓');
    expect(formatFieldValue(cb, false)).toBeUndefined();
    expect(formatFieldValue(person, 'u1', { userName: (id) => (id === 'u1' ? 'Maya' : undefined) })).toBe('Maya');
    expect(formatFieldValue(txt, 'hello')).toBe('hello');
  });

  it('optionByName is case-insensitive', () => {
    expect(optionByName(sel, 'LIVE')?.id).toBe('o1');
  });
});
