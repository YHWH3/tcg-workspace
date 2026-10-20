/* Shared bits for the database views: queries, chips, navigation helpers. */
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { BoardRow, TaskRow } from '../../modules/boards/api';
import { taskBoardId } from '../../modules/boards/model';

export function taskBoardIdOf(t: TaskRow | Record<string, unknown>): string {
  return taskBoardId(t as { boardId?: unknown });
}

/** Boards minus deleted, unsorted-lite version for pickers/lookups. */
export function useBoardsLite(): BoardRow[] {
  const rows = useLiveQuery(() => db.boards.toArray(), [], []);
  return ((rows ?? []) as BoardRow[]).filter((b) => !b.deleted);
}

export function useAllTasks(): TaskRow[] {
  return (useLiveQuery(() => db.tasks.toArray(), [], []) ?? []) as TaskRow[];
}

export { recordHref } from '../../../shared/recordRoutes';

export { boardKind, isRecordsDb, recordNoun } from '../records';
