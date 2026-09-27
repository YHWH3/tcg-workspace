import { describe, expect, it } from 'vitest';
import { mergeRecord } from '../worker/merge';
import { CHUNK_SIZE, chunkCount } from '../src/core/chunks';
import { columnIdFor, columnsOf, firstColumnId, isDone, lastColumnId, taskBoardId, DEFAULT_BOARD_ID } from '../src/modules/boards/model';

describe('seeded records lose to real edits', () => {
  // seedRecord writes every field with ts=1; real mutations get HLC ts >> 1.
  const SEED_TS = 1;
  const realTs = 1_800_000_000_000;

  it('a real edit overwrites seeded fields', () => {
    const seeded = {
      data: { name: 'Tasks', icon: '✅' },
      field_ts: { name: SEED_TS, icon: SEED_TS },
    };
    const merged = mergeRecord(seeded, { patch: { name: 'Renamed board' }, ts: realTs });
    expect(merged.data.name).toBe('Renamed board');
    expect(merged.field_ts.name).toBe(realTs);
    expect(merged.data.icon).toBe('✅'); // untouched field survives
  });

  it('a seed arriving after a real edit is ignored', () => {
    const real = {
      data: { name: 'Custom', columns: [{ id: 'a', name: 'A', color: '#fff' }] },
      field_ts: { name: realTs, columns: realTs },
    };
    const merged = mergeRecord(real, { patch: { name: 'Tasks', columns: [] }, ts: SEED_TS });
    expect(merged.data.name).toBe('Custom');
    expect(merged.data.columns).toHaveLength(1);
    expect(merged.changed).toBe(false);
  });
});

describe('chunk math', () => {
  it('splits at exactly 1 MiB boundaries', () => {
    expect(chunkCount(0)).toBe(1);
    expect(chunkCount(1)).toBe(1);
    expect(chunkCount(CHUNK_SIZE)).toBe(1);
    expect(chunkCount(CHUNK_SIZE + 1)).toBe(2);
    expect(chunkCount(2.5 * CHUNK_SIZE)).toBe(3);
    expect(chunkCount(20 * CHUNK_SIZE)).toBe(20);
  });
});

describe('board column fallback', () => {
  const board = {
    columns: [
      { id: 'idea', name: 'Idea', color: '#e5a000' },
      { id: 'filming', name: 'Filming', color: '#0091ff' },
      { id: 'live', name: 'Live', color: '#30a46c' },
    ],
  };

  it('maps missing boardId to the default board', () => {
    expect(taskBoardId({})).toBe(DEFAULT_BOARD_ID);
    expect(taskBoardId({ boardId: null })).toBe(DEFAULT_BOARD_ID);
    expect(taskBoardId({ boardId: 'board-x' })).toBe('board-x');
  });

  it('maps unknown status to the first column', () => {
    expect(columnIdFor({ status: 'gone' }, board)).toBe('idea');
    expect(columnIdFor({}, board)).toBe('idea');
    expect(columnIdFor({ status: 'filming' }, board)).toBe('filming');
  });

  it('falls back to default columns for missing/malformed boards', () => {
    expect(columnsOf(undefined)[0].id).toBe('todo');
    expect(columnsOf({ columns: 'nope' })[0].id).toBe('todo');
    expect(columnsOf({ columns: [] })[0].id).toBe('todo');
    expect(firstColumnId(board)).toBe('idea');
    expect(lastColumnId(board)).toBe('live');
    expect(isDone({ status: 'live' }, board)).toBe(true);
    expect(isDone({ status: 'idea' }, board)).toBe(false);
  });
});
