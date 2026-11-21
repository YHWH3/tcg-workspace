/* Pure board model helpers — no Dexie/React imports so unit tests can load them. */

export interface BoardColumn {
  id: string;
  name: string;
  color: string;
}

export const DEFAULT_BOARD_ID = 'board-default';
export const INBOX_BOARD_ID = 'board-inbox';

/** Fallback columns when a board row is missing or malformed. */
export const FALLBACK_COLUMNS: BoardColumn[] = [
  { id: 'todo', name: 'To do', color: '#8a8a8a' },
  { id: 'in_progress', name: 'In progress', color: '#0091ff' },
  { id: 'done', name: 'Done', color: '#30a46c' },
];

export const COLUMN_PALETTE = [
  { color: '#8a8a8a', label: 'Gray' }, { color: '#e5484d', label: 'Red' },
  { color: '#e5a000', label: 'Amber' }, { color: '#30a46c', label: 'Green' },
  { color: '#0091ff', label: 'Blue' }, { color: '#8e4ec6', label: 'Purple' },
  { color: '#e93d82', label: 'Pink' }, { color: '#795548', label: 'Brown' },
];
export const COLUMN_COLORS = COLUMN_PALETTE.map(option => option.color);

export function taskBoardId(task: { id?: string; boardId?: unknown }): string {
  return typeof task.boardId === 'string' && task.boardId ? task.boardId : DEFAULT_BOARD_ID;
}

export function columnsOf(board: { id?: string; columns?: unknown } | undefined | null): BoardColumn[] {
  const cols = board?.columns;
  return Array.isArray(cols) && cols.length > 0 ? (cols as BoardColumn[]) : FALLBACK_COLUMNS;
}

/** Column the task renders in: its status if valid, else the first column. */
export function columnIdFor(task: { id?: string; status?: unknown }, board: { id?: string; columns?: unknown } | undefined | null): string {
  const cols = columnsOf(board);
  const status = typeof task.status === 'string' ? task.status : '';
  return cols.some((c) => c.id === status) ? status : cols[0].id;
}

export function firstColumnId(board: { id?: string; columns?: unknown } | undefined | null): string {
  return columnsOf(board)[0].id;
}

export function lastColumnId(board: { id?: string; columns?: unknown } | undefined | null): string {
  const cols = columnsOf(board);
  return cols[cols.length - 1].id;
}

export function isDone(task: { id?: string; status?: unknown }, board: { id?: string; columns?: unknown } | undefined | null): boolean {
  return columnIdFor(task, board) === lastColumnId(board);
}

/* Custom field definitions + value helpers live in shared/ so the worker/MCP
 * layer imports the same code. */
export {
  FIELD_TYPES, coerceFieldValue, fieldsOf, formatFieldValue, isSelectType, optionByName, propKey, taskProp,
  type FieldDef, type FieldOption, type FieldType,
} from './fields';
