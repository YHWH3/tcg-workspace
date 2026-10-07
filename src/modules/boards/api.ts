import { useLiveQuery } from 'dexie-react-hooks';
import { authStore } from '../../core/auth';
import { logActivity } from '../../core/activity';
import { db, type LocalRow } from '../../core/db';
import { mutate } from '../../core/sync/engine';
import { cmpOrder, orderBetween, uuid } from '../../core/utils';

/* ---------- types ---------- */

export {
  COLUMN_COLORS, DEFAULT_BOARD_ID, FALLBACK_COLUMNS, INBOX_BOARD_ID,
  columnIdFor, columnsOf, firstColumnId, isDone, lastColumnId, taskBoardId,
  type BoardColumn,
} from './model';
import type { FieldDef } from './model';
import { COLUMN_COLORS, DEFAULT_BOARD_ID, INBOX_BOARD_ID, columnIdFor, columnsOf, firstColumnId, lastColumnId, taskBoardId } from './model';
import type { BoardColumn } from './model';

export interface BoardRow extends LocalRow {
  name?: string;
  icon?: string;
  columns?: BoardColumn[];
  fields?: FieldDef[];
  order?: string;
  createdBy?: string;
  createdAt?: number;
  deleted?: boolean;
}

export interface TaskRow extends LocalRow {
  title?: string;
  description?: string;
  status?: string; // column id within its board
  boardId?: string;
  priority?: 'none' | 'low' | 'medium' | 'high' | 'urgent';
  assigneeId?: string | null;
  dueDate?: string | null;
  pageId?: string | null;
  coverFileId?: string | null;
  order?: string;
  createdBy?: string;
  createdAt?: number;
  deleted?: boolean;
}

export const PRIORITIES: { id: NonNullable<TaskRow['priority']>; label: string; cls: string }[] = [
  { id: 'none', label: 'None', cls: 'text-neutral-400' },
  { id: 'low', label: 'Low', cls: 'text-neutral-400' },
  { id: 'medium', label: 'Medium', cls: 'text-amber-500' },
  { id: 'high', label: 'High', cls: 'text-orange-500' },
  { id: 'urgent', label: 'Urgent', cls: 'text-red-500' },
];

/* ---------- queries ---------- */

export function useBoards(): BoardRow[] {
  const raw = useLiveQuery(() => db.boards.toArray(), [], []);
  return ((raw ?? []) as BoardRow[]).filter((b) => !b.deleted).sort((a, b) => cmpOrder(a.order, b.order));
}

export function useBoard(boardId: string | undefined): BoardRow | undefined {
  return useLiveQuery(() => (boardId ? db.boards.get(boardId) : Promise.resolve(undefined)), [boardId]) as BoardRow | undefined;
}

export function useTasks(): TaskRow[] {
  return (useLiveQuery(() => db.tasks.toArray(), [], []) ?? []) as TaskRow[];
}

export function liveTasks(tasks: TaskRow[]): TaskRow[] {
  return tasks.filter((t) => !t.deleted);
}

export function byOrder(a: TaskRow, b: TaskRow): number {
  return cmpOrder(a.order, b.order);
}

export function boardTasks(tasks: TaskRow[], boardId: string): TaskRow[] {
  return liveTasks(tasks).filter((t) => taskBoardId(t) === boardId);
}

/* ---------- writes ---------- */

export async function createTask(boardId: string = INBOX_BOARD_ID, columnId?: string, extra?: Record<string, unknown>): Promise<string> {
  const board = await db.boards.get(boardId);
  const status = columnId ?? firstColumnId(board as BoardRow | undefined);
  const inCol = (await db.tasks.toArray()).filter((t) => !t.deleted && taskBoardId(t) === boardId && String(t.status) === status).sort(byOrder);
  const order = orderBetween(inCol.length ? String(inCol[inCol.length - 1].order ?? '') || null : null, null);
  const id = uuid();
  const me = authStore.get().user;
  await mutate('tasks', id, {
    title: '',
    description: '',
    boardId,
    status,
    priority: 'none',
    assigneeId: null,
    dueDate: null,
    pageId: null,
    order,
    createdBy: me?.id ?? null,
    createdAt: Date.now(),
    ...extra,
  });
  return id;
}

export async function setTaskField(id: string, patch: Partial<TaskRow>): Promise<void> {
  const before = await db.tasks.get(id);
  await mutate('tasks', id, patch);
  const title = String(before?.title ?? 'Task');
  const board = (await db.boards.get(taskBoardId(before ?? {}))) as BoardRow | undefined;
  if (patch.status !== undefined && before?.status !== patch.status) {
    logActivity(patch.status === lastColumnId(board) ? 'completed' : 'moved', 'task', id, title, { status: patch.status });
  }
  if (patch.assigneeId !== undefined && before?.assigneeId !== patch.assigneeId) {
    logActivity('assigned', 'task', id, title, { assigneeId: patch.assigneeId });
  }
  if (patch.boardId !== undefined && before?.boardId !== patch.boardId) {
    const target = (await db.boards.get(String(patch.boardId))) as BoardRow | undefined;
    logActivity('moved', 'task', id, title, { boardId: patch.boardId, boardName: target?.name });
  }
  if (patch.title !== undefined && before && String(before.title ?? '') === '' && patch.title) {
    logActivity('created', 'task', id, String(patch.title));
  }
}

export async function deleteTask(id: string): Promise<void> {
  await mutate('tasks', id, { deleted: true });
}

/** Move a task to another board: lands in that board's first column, at the end. */
export async function moveTaskToBoard(taskId: string, boardId: string): Promise<void> {
  const board = (await db.boards.get(boardId)) as BoardRow | undefined;
  const status = firstColumnId(board);
  const inCol = (await db.tasks.toArray()).filter((t) => !t.deleted && taskBoardId(t) === boardId && String(t.status) === status).sort(byOrder);
  const order = orderBetween(inCol.length ? String(inCol[inCol.length - 1].order ?? '') || null : null, null);
  await setTaskField(taskId, { boardId, status, order });
}

/* ---------- boards + columns ---------- */

export async function createBoard(name: string): Promise<string> {
  const boards = await db.boards.toArray();
  const live = boards.filter((b) => !b.deleted).sort((a, b) => cmpOrder(a.order, b.order));
  const order = orderBetween(live.length ? String(live[live.length - 1].order ?? '') || null : null, null);
  const id = uuid();
  const me = authStore.get().user;
  await mutate('boards', id, {
    name: name.trim() || 'Untitled board',
    icon: '🗂️',
    columns: [
      { id: 'c1', name: 'To do', color: '#8a8a8a' },
      { id: 'c2', name: 'Doing', color: '#0091ff' },
      { id: 'c3', name: 'Done', color: '#30a46c' },
    ],
    order,
    createdBy: me?.id ?? null,
    createdAt: Date.now(),
  });
  logActivity('created', 'board', id, name.trim() || 'Untitled board');
  return id;
}

export async function setBoardColumns(boardId: string, columns: BoardColumn[]): Promise<void> {
  await mutate('boards', boardId, { columns });
}

export async function addColumn(board: BoardRow, name: string): Promise<void> {
  const cols = columnsOf(board);
  const used = new Set(cols.map((c) => c.color));
  const color = COLUMN_COLORS.find((c) => !used.has(c)) ?? COLUMN_COLORS[cols.length % COLUMN_COLORS.length];
  await setBoardColumns(board.id, [...cols, { id: uuid().slice(0, 8), name: name.trim() || 'New stage', color }]);
}

export async function renameColumn(board: BoardRow, colId: string, name: string): Promise<void> {
  await setBoardColumns(board.id, columnsOf(board).map((c) => (c.id === colId ? { ...c, name: name.trim() || c.name } : c)));
}

export async function recolorColumn(board: BoardRow, colId: string, color: string): Promise<void> {
  await setBoardColumns(board.id, columnsOf(board).map((c) => (c.id === colId ? { ...c, color } : c)));
}

export async function moveColumn(board: BoardRow, colId: string, dir: -1 | 1): Promise<void> {
  const cols = [...columnsOf(board)];
  const i = cols.findIndex((c) => c.id === colId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= cols.length) return;
  [cols[i], cols[j]] = [cols[j], cols[i]];
  await setBoardColumns(board.id, cols);
}

/** Delete a column; move its tasks to `moveTo` first when it isn't empty. */
export async function deleteColumn(board: BoardRow, colId: string, moveTo?: string): Promise<void> {
  const cols = columnsOf(board);
  if (cols.length <= 1) return;
  const stranded = (await db.tasks.toArray()).filter((t) => !t.deleted && taskBoardId(t) === board.id && columnIdFor(t, board) === colId);
  const target = moveTo ?? cols.find((c) => c.id !== colId)!.id;
  for (const t of stranded) await mutate('tasks', t.id, { status: target });
  await setBoardColumns(board.id, cols.filter((c) => c.id !== colId));
}

export async function deleteBoard(board: BoardRow): Promise<void> {
  // Move any tasks to the default board's first column so nothing is orphaned.
  if (board.id !== DEFAULT_BOARD_ID) {
    const def = (await db.boards.get(DEFAULT_BOARD_ID)) as BoardRow | undefined;
    const status = firstColumnId(def);
    const tasks = (await db.tasks.toArray()).filter((t) => !t.deleted && taskBoardId(t) === board.id);
    for (const t of tasks) await mutate('tasks', t.id, { boardId: DEFAULT_BOARD_ID, status });
  }
  await mutate('boards', board.id, { deleted: true });
}
