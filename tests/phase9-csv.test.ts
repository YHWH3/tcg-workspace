import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from '../shared/csv';
import { exportView } from '../src/core/records';
import type { BoardRow, TaskRow } from '../src/modules/boards/api';

describe('Phase 9 CSV export', () => {
  it('writes an Excel-compatible BOM, CRLF rows, RFC quoting and formula guards', () => {
    expect(toCsv([['Name', 'Answer'], ['A,sha', '=1+1'], ['Line\nTwo', '"quoted"']])).toBe('\uFEFFName,Answer\r\n"A,sha",\'=1+1\r\n"Line\nTwo","""quoted"""\r\n');
    expect(toCsv([])).toBe('\uFEFF');
  });

  it('exports filtered visible values with labels, people, relations and currency metadata', () => {
    const board: BoardRow = {
      id: 'db', name: 'Projects', kind: 'records', columns: [{ id: 'todo', name: 'To do', color: '#aaa' }],
      fields: [
        { id: 'budget', name: 'Budget', type: 'number', format: 'currency', currency: 'INR' },
        { id: 'kind', name: 'Kind', type: 'select', options: [{ id: 'a', name: 'Alpha', color: '#aaa' }] },
        { id: 'tags', name: 'Tags', type: 'multi_select', options: [{ id: 'x', name: 'One', color: '#aaa' }, { id: 'y', name: 'Two', color: '#bbb' }] },
        { id: 'owner', name: 'Owner', type: 'person' },
        { id: 'done', name: 'Done', type: 'checkbox' },
      ], _ts: {},
    };
    const records: TaskRow[] = [
      { id: 'r1', title: 'Visible', boardId: 'db', status: 'todo', p_budget: 1250, p_kind: 'a', p_tags: ['x', 'y'], p_owner: 'u1', p_done: true, createdAt: Date.UTC(2026, 0, 2), _ts: {} },
      { id: 'r2', title: 'Hidden', boardId: 'db', status: 'todo', p_budget: 500, _ts: {} },
    ];
    const result = exportView(board, { filters: [{ key: 'title', op: 'is', value: 'Visible' }], visible: ['title', 'p_budget', 'p_kind', 'p_tags', 'p_owner', 'p_done', 'createdAt'] }, records, {
      fieldsById: { budget: board.fields![0], kind: board.fields![1], tags: board.fields![2], owner: board.fields![3], done: board.fields![4] },
      timeZone: 'UTC', relationTitles: () => [],
    }, { userName: id => id === 'u1' ? 'Asha' : undefined });
    expect(result.rows).toBe(1);
    expect(result.headers).toEqual(['Title', 'Budget', 'Budget currency', 'Kind', 'Tags', 'Owner', 'Done', 'Created', 'id']);
    expect(result.csv).toContain('Visible,1250,INR,Alpha,One; Two,Asha,TRUE,2026-01-02,r1');
    expect(result.csv).not.toContain('Hidden');
  });

  it('omits Website token and payment references unless requested', () => {
    const board = { id: 'board-website-inbox', name: 'Website inbox', kind: 'records', fields: [
      { id: 'wi_email', name: 'Email', type: 'text' as const },
      { id: 'wi_paid', name: 'Paid', type: 'text' as const },
      { id: 'wi_token', name: 'Token', type: 'text' as const },
    ], columns: [], _ts: {} } as BoardRow;
    const record = { id: 'r1', title: 'Submission', boardId: board.id, p_wi_email: 'a@example.com', p_wi_paid: 'pay_1', p_wi_token: 'tok_1', _ts: {} } as TaskRow;
    const ctx = { fieldsById: { wi_email: board.fields![0], wi_paid: board.fields![1], wi_token: board.fields![2] } };
    const hidden = exportView(board, { visible: ['title', 'p_wi_email', 'p_wi_paid', 'p_wi_token'] }, [record], ctx);
    expect(hidden.headers).toEqual(['Title', 'Email', 'id']);
    expect(hidden.csv).not.toContain('pay_1');
    expect(hidden.csv).not.toContain('tok_1');
    const included = exportView(board, { visible: ['title', 'p_wi_email', 'p_wi_paid', 'p_wi_token'] }, [record], ctx, { includePaymentReferences: true });
    expect(included.headers).toEqual(['Title', 'Email', 'Paid', 'Token', 'id']);
    expect(included.csv).toContain('pay_1');
    expect(included.csv).toContain('tok_1');
  });

  it('parses BOM, semicolon delimiters, quoted newlines and bounded errors', () => {
    const parsed = parseCsv('\uFEFFName;Notes\r\nA;"line one\nline two"\r\nB;ok\r\n');
    expect(parsed.delimiter).toBe(';');
    expect(parsed.headers).toEqual(['Name', 'Notes']);
    expect(parsed.rows).toEqual([['A', 'line one\nline two'], ['B', 'ok']]);
    expect(() => parseCsv('A,A\n1,2\n')).toThrow('duplicate');
    expect(() => parseCsv('A\n"unterminated')).toThrow('unterminated');
  });
});
