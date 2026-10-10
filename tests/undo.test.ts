import { describe, it, expect } from 'vitest';
import { planUndo, type ChangesetItem } from '../shared/undo';

const item = (over: Partial<ChangesetItem>): ChangesetItem => ({
  collection: 'tasks',
  record_id: 't1',
  created: 0,
  before: {},
  after: {},
  field_ts: {},
  ...over,
});

describe('planUndo', () => {
  it('restores fields untouched since the change set', () => {
    const plan = planUndo(
      [item({ before: { title: 'Old' }, after: { title: 'New' }, field_ts: { title: 100 } })],
      new Map([['t1', { data: { title: 'New' }, field_ts: { title: 100 } }]]),
    );
    expect(plan.patches).toEqual([{ collection: 'tasks', id: 't1', patch: { title: 'Old' } }]);
    expect(plan.skipped).toEqual([]);
  });

  it('skips fields changed by someone else', () => {
    const plan = planUndo(
      [item({ before: { title: 'Old' }, after: { title: 'New' }, field_ts: { title: 100 } })],
      new Map([['t1', { data: { title: 'Human edit' }, field_ts: { title: 200 } }]]),
    );
    expect(plan.patches).toEqual([]);
    expect(plan.skipped[0].reason).toContain('changed since');
  });

  it('deletes a created record only when no field changed since', () => {
    const it = item({ created: 1, after: { title: 'X' }, field_ts: { title: 100 } });
    const fresh = planUndo([it], new Map([['t1', { data: { title: 'X' }, field_ts: { title: 100 } }]]));
    expect(fresh.patches[0].patch.deleted).toBe(true);
    const edited = planUndo([item({ created: 1, after: { title: 'X' }, field_ts: { title: 100 } })], new Map([['t1', { data: { title: 'Human' }, field_ts: { title: 100, description: 300 } }]]));
    expect(edited.patches).toEqual([]);
    expect(edited.skipped[0].field).toBe('*');
  });

  it('absent-before fields restore to null', () => {
    const plan = planUndo(
      [item({ before: {}, after: { title: 'New' }, field_ts: { title: 100 } })],
      new Map([['t1', { data: { title: 'New' }, field_ts: { title: 100 } }]]),
    );
    expect(plan.patches[0].patch.title).toBeNull();
  });
});
