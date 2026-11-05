import { describe, expect, it } from 'vitest';
import { inverseBulkJournal, planBulkEdit, type BulkJournal } from '../src/core/views/bulk';
import type { BoardRow, TaskRow } from '../src/modules/boards/api';

const board = (overrides: Partial<BoardRow> = {}): BoardRow => ({
  id: 'board',
  _ts: {},
  name: 'Records',
  columns: [{ id: 'open', name: 'Open', color: '#999' }, { id: 'done', name: 'Done', color: '#0a5' }],
  fields: [{ id: 'priority_text', name: 'Priority text', type: 'text' }],
  ...overrides,
});

const row = (id: string, patch: Record<string, unknown> = {}): TaskRow => ({ id, _ts: {}, boardId: 'board', title: id, status: 'open', ...patch });

describe('Phase 9 bulk edit planning', () => {
  it('plans one patch per selected record and records inverse values', () => {
    const result = planBulkEdit(board(), [row('a', { p_priority_text: 'old' }), row('b')], { p_priority_text: 'new' });
    expect(result.gated).toEqual([]);
    expect(result.patches).toEqual([{ id: 'a', patch: { p_priority_text: 'new' } }, { id: 'b', patch: { p_priority_text: 'new' } }]);
    expect(result.journal[0].before).toEqual({ p_priority_text: 'old' });
    expect(result.journal[1].before).toEqual({ p_priority_text: undefined });
  });

  it('separates approval-gated stage transitions without applying them', () => {
    const result = planBulkEdit(board({ approvalGate: { stageId: 'done' } }), [row('a'), row('b', { status: 'done' })], { status: 'done' });
    expect(result.gated).toEqual(['a']);
    expect(result.patches).toEqual([{ id: 'b', patch: { status: 'done' } }]);
  });

  it('creates a revision-safe inverse and skips changed rows', () => {
    const journal: BulkJournal = {
      id: 'bulk-1', createdAt: 1, expiresAt: 2, collection: 'tasks', databaseId: 'board', summary: 'set field',
      items: [
        { id: 'a', before: { title: 'A' }, after: { title: 'A2' } },
        { id: 'b', before: { title: 'B' }, after: { title: 'B2' } },
      ],
    };
    expect(inverseBulkJournal([row('a', { title: 'A2' }), row('b', { title: 'someone else' })], journal)).toEqual([{ id: 'a', patch: { title: 'A' } }]);
  });
});
