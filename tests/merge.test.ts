import { describe, expect, it } from 'vitest';
import { mergeRecord } from '../worker/merge';

describe('mergeRecord', () => {
  it('creates a new record when none exists', () => {
    const r = mergeRecord(null, { patch: { title: 'Hi', done: false }, ts: 100 });
    expect(r.changed).toBe(true);
    expect(r.data).toEqual({ title: 'Hi', done: false });
    expect(r.field_ts).toEqual({ title: 100, done: 100 });
  });

  it('newer field wins', () => {
    const existing = { data: { title: 'old' }, field_ts: { title: 100 } };
    const r = mergeRecord(existing, { patch: { title: 'new' }, ts: 200 });
    expect(r.data.title).toBe('new');
    expect(r.field_ts.title).toBe(200);
    expect(r.changed).toBe(true);
  });

  it('older field is ignored', () => {
    const existing = { data: { title: 'new' }, field_ts: { title: 200 } };
    const r = mergeRecord(existing, { patch: { title: 'old' }, ts: 100 });
    expect(r.data.title).toBe('new');
    expect(r.field_ts.title).toBe(200);
    expect(r.changed).toBe(false);
  });

  it('equal ts applies (>= rule)', () => {
    const existing = { data: { title: 'a' }, field_ts: { title: 100 } };
    const r = mergeRecord(existing, { patch: { title: 'b' }, ts: 100 });
    expect(r.data.title).toBe('b');
  });

  it('disjoint fields both kept', () => {
    const existing = { data: { title: 'T', color: 'red' }, field_ts: { title: 50, color: 50 } };
    const r = mergeRecord(existing, { patch: { status: 'done' }, ts: 80 });
    expect(r.data).toEqual({ title: 'T', color: 'red', status: 'done' });
    expect(r.field_ts).toEqual({ title: 50, color: 50, status: 80 });
    expect(r.changed).toBe(true);
  });

  it('mixed patch applies only newer fields', () => {
    const existing = { data: { a: 1, b: 2 }, field_ts: { a: 100, b: 100 } };
    const r = mergeRecord(existing, { patch: { a: 10, b: 20 }, ts: 150 });
    expect(r.data).toEqual({ a: 10, b: 20 });
    // now push a partial change with older ts for a, newer for b
    const r2 = mergeRecord(r, { patch: { a: 99 }, ts: 120 });
    expect(r2.data.a).toBe(10);
    expect(r2.changed).toBe(false);
  });

  it('identical values do not mark changed', () => {
    const existing = { data: { a: 1 }, field_ts: { a: 100 } };
    const r = mergeRecord(existing, { patch: { a: 1 }, ts: 150 });
    expect(r.changed).toBe(false);
  });

  it('soft delete flag participates in LWW like any field', () => {
    const existing = { data: { title: 'x', deleted: false }, field_ts: { title: 100, deleted: 100 } };
    const r = mergeRecord(existing, { patch: { deleted: true }, ts: 200 });
    expect(r.data.deleted).toBe(true);
    const restored = mergeRecord(r, { patch: { deleted: false }, ts: 150 });
    expect(restored.data.deleted).toBe(true); // older ts loses
    const restored2 = mergeRecord(r, { patch: { deleted: false }, ts: 300 });
    expect(restored2.data.deleted).toBe(false);
  });
});
