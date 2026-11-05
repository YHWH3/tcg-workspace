import { describe, expect, it } from 'vitest';
import { parseCsv } from '../shared/csv';
import { planCsvImport } from '../src/core/csvImport';
import type { BoardRow, TaskRow } from '../src/modules/boards/api';

const board: BoardRow = {
  id: 'projects', _ts: {}, name: 'Projects',
  columns: [{ id: 'open', name: 'Open', color: '#999' }],
  fields: [
    { id: 'name_key', name: 'External ID', type: 'text' },
    { id: 'due', name: 'Due', type: 'date' },
    { id: 'kind', name: 'Kind', type: 'select', options: [{ id: 'one', name: 'One', color: '#999' }] },
    { id: 'owner', name: 'Owner', type: 'person' },
    { id: 'client', name: 'Client', type: 'relation', relation: { target: 'people', primary: true } },
  ],
};
const records: TaskRow[] = [{ id: 'existing', _ts: {}, boardId: 'projects', title: 'Existing', p_name_key: 'A-1', p_due: '2026-11-04' }];

describe('Phase 9 CSV import planning', () => {
  it('maps dates, people and updates existing records by a chosen key', () => {
    const parsed = parseCsv('Name,External ID,Due,Owner\nChanged,A-1,04/11/2026,alice\nNew,A-2,31/02/2026,missing');
    const plan = planCsvImport({
      board, parsed,
      mappings: [
        { header: 'Name', target: 'title' },
        { header: 'External ID', target: 'p_name_key' },
        { header: 'Due', target: 'p_due' },
        { header: 'Owner', target: 'p_owner' },
      ],
      records, dateFormat: 'dd/mm/yyyy', updateKey: 'p_name_key', unknownSelect: 'add',
      users: [{ id: 'u1', name: 'Alice', username: 'alice' }],
    });
    expect(plan.updates).toBe(1);
    expect(plan.creates).toBe(0);
    expect(plan.writes[0].patch).toEqual({ title: 'Changed', p_name_key: 'A-1', p_due: '2026-11-04', p_owner: 'u1' });
    expect(plan.errors).toEqual([{ row: 3, reason: 'Due: Invalid dd/mm/yyyy date.' }, { row: 3, reason: 'Owner: Person not found: missing' }]);
  });

  it('adds unknown select options and resolves exact relation titles', () => {
    const parsed = parseCsv('Title,Kind,Client\nOne,Two,Acme\nTwo,Two,Missing');
    const plan = planCsvImport({
      board, parsed,
      mappings: [{ header: 'Title', target: 'title' }, { header: 'Kind', target: 'p_kind' }, { header: 'Client', target: 'p_client' }],
      records: [], dateFormat: 'yyyy-mm-dd', updateKey: undefined, unknownSelect: 'add',
      relationTargets: { client: [{ id: 'person-1', title: 'Acme' }] },
    });
    expect(plan.creates).toBe(1);
    expect(plan.fields.find((field) => field.id === 'kind')?.options?.some((option) => option.name === 'Two')).toBe(true);
    expect(plan.links).toHaveLength(1);
    expect(plan.errors[0].reason).toContain('Relation target not found');
  });

  it('reports duplicate update keys instead of silently overwriting', () => {
    const parsed = parseCsv('Title,External ID\nOne,A-1\nTwo,A-1');
    const plan = planCsvImport({ board, parsed, mappings: [{ header: 'Title', target: 'title' }, { header: 'External ID', target: 'p_name_key' }], records, dateFormat: 'yyyy-mm-dd', updateKey: 'p_name_key', unknownSelect: 'error' });
    expect(plan.updates).toBe(1);
    expect(plan.errors[0].reason).toContain('Duplicate update key');
  });
});
