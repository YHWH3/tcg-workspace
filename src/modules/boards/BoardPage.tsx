import {MoveSpaceButton} from '../../core/MoveSpace';
import { useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { Archive, ArchiveRestore, CheckSquare, LayoutGrid, List, ListPlus, MoreHorizontal, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { authStore } from '../../core/auth';
import { useIsMobile } from '../../core/mobile';
import { PresenceStack } from '../../core/presence';
import { AskAiMenu } from '../../core/assistant/AskAiMenu';
import { useAssistantContext } from '../../core/assistant/store';
import { FieldsEditor } from './FieldsEditor';
import { GateEditor, GateMoveHost, noteGatedMove } from './GateMove'; // P4-D gate UX
import { FieldChips, useFieldFilterOptions } from './FieldValue';
import { Avatar, EmptyState, IconButton, Menu, Popover, Select, Sheet } from '../../core/ui';
import { resolveUser, useUsers } from '../../core/users';
import { useStore } from '../../core/store';
import { cn, formatDate, todayISO } from '../../core/utils';
import { mutate } from '../../core/sync/engine';
import { db } from '../../core/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { Board } from './Board';
import { TaskDetail } from './TaskDetail';
import { archivePatch, isArchived } from '../../../shared/archive';
import {
  boardTasks, byOrder, columnIdFor, columnsOf, createTask, deleteBoard, isDone, lastColumnId, PRIORITIES, taskBoardId, useBoard, useTasks,
  type BoardRow, type TaskRow,
} from './api';

type Filter = 'all' | 'mine' | string;
type View = 'board' | 'list';
type Sort = 'order' | 'due' | 'priority' | 'title';

const PRIO_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

/** /tasks/:taskId → redirects to that task's board route. */
export function LegacyTaskRedirect() {
  const { taskId } = useParams();
  const task = useLiveQuery(() => (taskId ? db.tasks.get(taskId) : undefined), [taskId]);
  if (task === undefined) return null;
  if (!task) return <Navigate to="/tasks" replace />;
  return <Navigate to={`/boards/${taskBoardId(task as TaskRow)}/tasks/${task.id}`} replace />;
}

export function BoardPage() {
  const { boardId = '', taskId } = useParams();
  const navigate = useNavigate();
  const board = useBoard(boardId);
  useAssistantContext(board ? { kind: 'database', id: board.id } : null);
  const tasks = useTasks();
  const users = useUsers();
  const me = useStore(authStore).user?.id;
  const mobile = useIsMobile();
  const [view, setView] = useState<View>('board');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('order');

  const fieldFilterOptions = useFieldFilterOptions(board);
  const filtered = useMemo(() => {
    let list = boardTasks(tasks, boardId);
    if (filter === 'mine') list = list.filter((t) => t.assigneeId === me);
    else if (filter.startsWith('f:')) {
      const opt = fieldFilterOptions.find((o) => o.key === filter);
      if (opt) list = list.filter(opt.test);
    } else if (filter !== 'all') list = list.filter((t) => t.assigneeId === filter);
    return list;
  }, [tasks, boardId, filter, me, fieldFilterOptions]);

  if (board === undefined) return null;
  if (!board) return <Navigate to="/boards" replace />;

  const cols = columnsOf(board);
  const openTask = (id: string) => navigate(`/boards/${board.id}/tasks/${id}`);
  const closeDetail = () => navigate(`/boards/${board.id}`);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-x-2 gap-y-2 border-b border-neutral-200/70 px-4 py-2.5 dark:border-neutral-800/70">
          <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight">
            <span>{String(board.icon ?? '🗂️')}</span>
            {String(board.name ?? 'Board')}
          </h1>
          <div className="flex rounded-lg bg-neutral-100 p-0.5 text-xs dark:bg-neutral-800">
            {(['board', 'list'] as const).map((v) => (
              <button key={v} onClick={() => setView(v)} aria-label={`${v} view`} className={cn('flex items-center gap-1 rounded-md px-2.5 py-1 font-medium capitalize transition-colors', view === v ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-950 dark:text-white' : 'text-neutral-500')}>
                {v === 'board' ? <LayoutGrid size={13} /> : <List size={13} />}
                <span className="hidden sm:inline">{v}</span>
              </button>
            ))}
          </div>
          <div className="flex rounded-lg bg-neutral-100 p-0.5 text-xs dark:bg-neutral-800">
            {(
              [
                ['all', 'All'],
                ['mine', 'Mine'],
              ] as const
            ).map(([v, label]) => (
              <button key={v} onClick={() => setFilter(v)} className={cn('rounded-md px-2.5 py-1 font-medium transition-colors', filter === v ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-950 dark:text-white' : 'text-neutral-500')}>
                {label}
              </button>
            ))}
          </div>
          <div className="w-32">
            <Select value={filter === 'all' || filter === 'mine' ? '' : filter} onChange={(e) => setFilter(e.target.value || 'all')} className="py-1 text-xs" aria-label="Filter tasks">
              <option value="">Anyone</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
              {fieldFilterOptions.length > 0 && (
                <optgroup label="Fields">
                  {fieldFilterOptions.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          </div>
          {view === 'list' && (
            <div className="w-28">
              <Select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="py-1 text-xs" aria-label="Sort tasks">
                <option value="order">Manual</option>
                <option value="due">Due date</option>
                <option value="priority">Priority</option>
                <option value="title">Title</option>
              </Select>
            </div>
          )}
          <div className="ml-auto flex items-center gap-1">
            <AskAiMenu modules={['databases']} refs={{ database: { kind: 'database', id: board.id } }} compact />
            <MoveSpaceButton root={board}/><PresenceStack path={`/boards/${board.id}`} />
            {mobile ? (
              <IconButton aria-label="New task" onClick={async () => navigate(`/boards/${board.id}/tasks/${await createTask(board.id)}`)}>
                <Plus size={16} />
              </IconButton>
            ) : (
              <NewTaskButton board={board} />
            )}
            <BoardMenu board={board} deletable={board.id !== 'board-default' && board.id !== 'board-inbox'} />
          </div>
        </header>
        {isArchived(board) && (
          <div className="flex items-center gap-2 border-b border-neutral-200/70 bg-neutral-50 px-4 py-1.5 text-xs text-neutral-500 dark:border-neutral-800/70 dark:bg-neutral-900 dark:text-neutral-400">
            <Archive size={12} />
            <span className="flex-1">Archived</span>
            <button className="rounded-md px-2 py-0.5 font-medium text-neutral-700 hover:bg-neutral-200/70 dark:text-neutral-200 dark:hover:bg-neutral-800" onClick={() => void mutate('boards', board.id, archivePatch(false))}>
              Unarchive
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          {view === 'board' ? (
            cols.length === 0 ? (
              <EmptyState icon={CheckSquare} title="No stages" body="Add a stage to get started." action={<NewTaskButton board={board} />} />
            ) : (
              <Board board={board} tasks={filtered} />
            )
          ) : (
            <TaskList tasks={filtered} board={board} sort={sort} onOpen={openTask} />
          )}
        </div>
      </div>
      {taskId && <TaskDetail taskId={taskId} onClose={closeDetail} />}
      <GateMoveHost /> {/* P4-D: gated-stage request dialog */}
    </div>
  );
}

function BoardMenu({ board, deletable }: { board: BoardRow; deletable: boolean }) {
  const navigate = useNavigate();
  const mobile = useIsMobile();
  const [renaming, setRenaming] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [gateOpen, setGateOpen] = useState(false); // P4-D
  const [name, setName] = useState(String(board.name ?? ''));
  return (
    <>
    {fieldsOpen && (
      <Sheet onClose={() => setFieldsOpen(false)} side={mobile ? 'bottom' : 'right'}>
        <FieldsEditor board={board} />
      </Sheet>
    )}
    {gateOpen && (
      <Sheet onClose={() => setGateOpen(false)} side={mobile ? 'bottom' : 'right'}>
        <GateEditor board={board} />
      </Sheet>
    )}
    <Popover
      align="right"
      trigger={
        <IconButton aria-label="Board menu">
          <MoreHorizontal size={16} />
        </IconButton>
      }
    >
      {(close) => (
        <div className="p-1 text-sm">
          {renaming ? (
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mx-1 my-1 w-44 rounded-md border border-neutral-200 px-2 py-1 text-xs outline-none dark:border-neutral-700 dark:bg-neutral-800"
              onBlur={async () => {
                setRenaming(false);
                close();
                if (name.trim()) await mutate('boards', board.id, { name: name.trim() });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') {
                  setRenaming(false);
                  close();
                }
              }}
            />
          ) : (
            <Menu
              close={close}
              items={[
                { label: 'Fields', icon: ListPlus, onClick: () => setFieldsOpen(true) },
                { label: 'Approval gate', icon: ShieldCheck, onClick: () => setGateOpen(true) }, // P4-D
                { label: 'Rename board', icon: Pencil, onClick: () => setRenaming(true) },
                {
                  label: isArchived(board) ? 'Unarchive board' : 'Archive board',
                  icon: isArchived(board) ? ArchiveRestore : Archive,
                  onClick: () => void mutate('boards', board.id, archivePatch(!isArchived(board))),
                },
                ...(deletable
                  ? ([
                      'divider',
                      {
                        label: board.kind === 'records' ? 'Archive database (restore with Unarchive)' : 'Delete board (move tasks to default)',
                        icon: Trash2,
                        danger: true,
                        onClick: async () => {
                          await deleteBoard(board);
                          navigate('/boards');
                        },
                      },
                    ] as const)
                  : []),
              ]}
            />
          )}
        </div>
      )}
    </Popover>
    </>
  );
}

export function NewTaskButton({ board }: { board: BoardRow }) {
  const navigate = useNavigate();
  return (
    <button
      className="flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      onClick={async () => navigate(`/boards/${board.id}/tasks/${await createTask(board.id)}`)}
    >
      <Plus size={14} /> New task
    </button>
  );
}

/* ---------- List view ---------- */

function TaskList({ tasks, board, sort, onOpen }: { tasks: TaskRow[]; board: BoardRow; sort: Sort; onOpen: (id: string) => void }) {
  const cols = columnsOf(board);
  const sorted = [...tasks].sort((a, b) => {
    switch (sort) {
      case 'due':
        return String(a.dueDate ?? '9999').localeCompare(String(b.dueDate ?? '9999'));
      case 'priority':
        return (PRIO_RANK[a.priority ?? 'none'] ?? 4) - (PRIO_RANK[b.priority ?? 'none'] ?? 4);
      case 'title':
        return String(a.title ?? '').localeCompare(String(b.title ?? ''));
      default:
        return byOrder(a, b);
    }
  });
  return (
    <div className="mx-auto max-w-3xl px-4 py-4">
      {cols.map((col) => {
        const list = sorted.filter((t) => columnIdFor(t, board) === col.id);
        if (list.length === 0) return null;
        return (
          <div key={col.id} className="mb-4">
            <div className="mb-1 flex items-center gap-2 px-2 text-xs font-semibold text-neutral-500 dark:text-neutral-400">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: col.color }} />
              {col.name} <span className="font-normal text-neutral-400">{list.length}</span>
            </div>
            <div className="overflow-hidden rounded-xl border border-neutral-200/70 dark:border-neutral-800">
              {list.map((t) => (
                <ListRow key={t.id} task={t} board={board} onOpen={onOpen} />
              ))}
            </div>
          </div>
        );
      })}
      {sorted.length === 0 && <EmptyState icon={CheckSquare} title="No tasks" body="Create a task to get started." />}
    </div>
  );
}

function ListRow({ task, board, onOpen }: { task: TaskRow; board: BoardRow; onOpen: (id: string) => void }) {
  const users = useUsers();
  const me = authStore.get().user;
  const assignee = resolveUser(task.assigneeId ?? null, users, me);
  const overdue = task.dueDate && String(task.dueDate) < todayISO() && !isDone(task, board);
  const prio = PRIORITIES.find((p) => p.id === task.priority);
  const done = isDone(task, board);
  return (
    <button className="flex w-full items-center gap-3 border-b border-neutral-100 px-3 py-2.5 text-left text-sm transition-colors last:border-0 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900" onClick={() => onOpen(task.id)}>
      <span
        role="checkbox"
        aria-checked={done}
        aria-label="Mark done"
        className={cn('flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded border transition-colors', done ? 'border-blue-500 bg-blue-500 text-white' : 'border-neutral-300 hover:border-neutral-400 dark:border-neutral-600')}
        style={{ width: 18, height: 18 }}
        onClick={(e) => {
          e.stopPropagation();
          const next = done ? columnsOf(board)[0].id : lastColumnId(board);
          noteGatedMove(board, task.id, next); // P4-D
          void mutate('tasks', task.id, { status: next });
        }}
      >
        {done && (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        )}
      </span>
      <span className={cn('min-w-0 flex-1 truncate', done && 'text-neutral-400 line-through')}>{String(task.title ?? '') || 'Untitled task'}</span>
      <FieldChips board={board} task={task} />
      {prio && prio.id !== 'none' && <span className={cn('hidden items-center gap-1 text-[11px] sm:flex', prio.cls)}>{prio.label}</span>}
      {task.dueDate && <span className={cn('flex items-center gap-1 text-[11px]', overdue ? 'font-medium text-red-500' : 'text-neutral-400')}>{formatDate(String(task.dueDate))}</span>}
      {assignee && <Avatar name={assignee.name} color={assignee.color} size={18} />}
    </button>
  );
}
