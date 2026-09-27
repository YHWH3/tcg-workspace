import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { CalendarDays, Flag, LayoutGrid, List, Plus, CheckSquare } from 'lucide-react';
import { authStore } from '../../core/auth';
import { Avatar, EmptyState, Menu, Popover, Select } from '../../core/ui';
import { useUsers } from '../../core/users';
import { cn, formatDate, todayISO } from '../../core/utils';
import { TaskDetail } from './TaskDetail';
import { byOrder, createTask, liveTasks, PRIORITIES, setTaskField, STATUSES, useTasks, type TaskRow, type TaskStatus } from './api';
import { generateKeyBetween } from 'fractional-indexing';

type Filter = 'all' | 'mine' | string; // string = userId
type View = 'board' | 'list';
type Sort = 'order' | 'due' | 'priority' | 'title';

const PRIO_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

export function TasksPage() {
  const { taskId } = useParams();
  const tasks = useTasks();
  const users = useUsers();
  const me = useStoreMe();
  const [view, setView] = useState<View>('board');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('order');

  const filtered = useMemo(() => {
    let list = liveTasks(tasks);
    if (filter === 'mine') list = list.filter((t) => t.assigneeId === me);
    else if (filter !== 'all') list = list.filter((t) => t.assigneeId === filter);
    return list;
  }, [tasks, filter, me]);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-neutral-200/70 px-4 py-3 dark:border-neutral-800/70">
          <h1 className="mr-1 text-base font-semibold tracking-tight">Tasks</h1>
          <div className="flex rounded-lg bg-neutral-100 p-0.5 text-xs dark:bg-neutral-800">
            {(['board', 'list'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={cn('flex items-center gap-1 rounded-md px-2.5 py-1 font-medium capitalize transition-colors', view === v ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-950 dark:text-white' : 'text-neutral-500')}
              >
                {v === 'board' ? <LayoutGrid size={13} /> : <List size={13} />}
                {v}
              </button>
            ))}
          </div>
          <Select value={filter} onChange={(e) => setFilter(e.target.value)} className="w-auto py-1 text-xs">
            <option value="all">All tasks</option>
            <option value="mine">My tasks</option>
            <option disabled>— Assignee —</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
          {view === 'list' && (
            <Select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="w-auto py-1 text-xs">
              <option value="order">Manual order</option>
              <option value="due">Due date</option>
              <option value="priority">Priority</option>
              <option value="title">Title</option>
            </Select>
          )}
          <div className="ml-auto">
            <NewTaskButton />
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
          {filtered.length === 0 ? (
            <EmptyState icon={CheckSquare} title="No tasks" body="Create a task to get started." action={<NewTaskButton />} />
          ) : view === 'board' ? (
            <Board tasks={filtered} />
          ) : (
            <TaskList tasks={filtered} sort={sort} />
          )}
        </div>
      </div>
      {taskId && <TaskDetail taskId={taskId} />}
    </div>
  );
}

function useStoreMe(): string | undefined {
  return authStore.get().user?.id;
}

function NewTaskButton() {
  const navigate = useNavigate();
  return (
    <button
      className="flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
      onClick={async () => navigate(`/tasks/${await createTask('todo')}`)}
    >
      <Plus size={14} /> New task
    </button>
  );
}

/* ---------- Board ---------- */

function Board({ tasks }: { tasks: TaskRow[] }) {
  const [over, setOver] = useState<TaskStatus | null>(null);
  return (
    <div className="flex h-full items-start gap-3 overflow-x-auto p-4">
      {STATUSES.map((col) => {
        const items = tasks.filter((t) => (t.status ?? 'todo') === col.id).sort(byOrder);
        return (
          <div
            key={col.id}
            className={cn('flex w-64 shrink-0 flex-col rounded-xl bg-neutral-50 p-2 transition-colors sm:w-72 dark:bg-neutral-900/60', over === col.id && 'ring-2 ring-blue-400/50')}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(col.id);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              setOver(null);
              const id = e.dataTransfer.getData('text/task-id');
              if (!id) return;
              const order = generateKeyBetween(items.length ? String(items[items.length - 1].order ?? '') || null : null, null);
              void setTaskField(id, { status: col.id, order });
            }}
          >
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="flex items-center gap-2 text-xs font-semibold text-neutral-600 dark:text-neutral-300">
                <StatusDot status={col.id} />
                {col.label}
                <span className="text-neutral-400">{items.length}</span>
              </span>
              <AddInColumn status={col.id} />
            </div>
            <div className="flex min-h-8 flex-col gap-1.5">
              {items.map((t) => (
                <TaskCard key={t.id} task={t} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AddInColumn({ status }: { status: TaskStatus }) {
  const navigate = useNavigate();
  return (
    <button
      className="rounded-md p-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-600 dark:hover:bg-neutral-800"
      aria-label="Add task"
      onClick={async () => navigate(`/tasks/${await createTask(status)}`)}
    >
      <Plus size={14} />
    </button>
  );
}

export function StatusDot({ status }: { status: TaskStatus }) {
  const cls = status === 'done' ? 'bg-emerald-500' : status === 'in_progress' ? 'bg-amber-400' : 'bg-neutral-300 dark:bg-neutral-600';
  return <span className={cn('h-2.5 w-2.5 rounded-full', cls)} />;
}

export function TaskCard({ task, onClick }: { task: TaskRow; onClick?: () => void }) {
  const navigate = useNavigate();
  const users = useUsers();
  const assignee = users.find((u) => u.id === task.assigneeId);
  const prio = PRIORITIES.find((p) => p.id === (task.priority ?? 'none'))!;
  const overdue = task.dueDate && task.dueDate < todayISO() && task.status !== 'done';
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/task-id', task.id)}
      onClick={onClick ?? (() => navigate(`/tasks/${task.id}`))}
      className={cn(
        'group cursor-pointer rounded-lg border border-neutral-200/70 bg-white p-3 shadow-sm transition-all hover:border-neutral-300 hover:shadow dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-700',
        task.status === 'done' && 'opacity-60',
      )}
    >
      <p className={cn('text-sm font-medium leading-5', task.status === 'done' && 'line-through')}>{String(task.title ?? '') || 'Untitled task'}</p>
      <div className="mt-2 flex items-center gap-2">
        {task.priority && task.priority !== 'none' && (
          <span className={cn('flex items-center gap-1 text-[11px] font-medium', prio.cls)}>
            <Flag size={11} fill="currentColor" />
            {prio.label}
          </span>
        )}
        {task.dueDate && (
          <span className={cn('flex items-center gap-1 text-[11px]', overdue ? 'font-medium text-red-500' : 'text-neutral-400')}>
            <CalendarDays size={11} />
            {formatDate(String(task.dueDate))}
          </span>
        )}
        {assignee && <Avatar name={assignee.name} color={assignee.color} size={18} className="ml-auto" />}
      </div>
    </div>
  );
}

/* ---------- List view ---------- */

function TaskList({ tasks, sort }: { tasks: TaskRow[]; sort: Sort }) {
  const navigate = useNavigate();
  const users = useUsers();
  const sorter = (a: TaskRow, b: TaskRow) => {
    if (sort === 'due') return String(a.dueDate ?? '9999').localeCompare(String(b.dueDate ?? '9999'));
    if (sort === 'priority') return PRIO_RANK[String(a.priority ?? 'none')] - PRIO_RANK[String(b.priority ?? 'none')];
    if (sort === 'title') return String(a.title ?? '').localeCompare(String(b.title ?? ''));
    return byOrder(a, b);
  };
  return (
    <div className="mx-auto max-w-3xl p-4">
      {STATUSES.map((col) => {
        const items = tasks.filter((t) => (t.status ?? 'todo') === col.id).sort(sorter);
        if (items.length === 0) return null;
        return (
          <div key={col.id} className="mb-5">
            <div className="mb-1 flex items-center gap-2 px-2 text-xs font-semibold text-neutral-500 dark:text-neutral-400">
              <StatusDot status={col.id} />
              {col.label} <span className="text-neutral-300 dark:text-neutral-600">{items.length}</span>
            </div>
            <div className="overflow-hidden rounded-xl border border-neutral-200/70 dark:border-neutral-800">
              {items.map((t) => {
                const assignee = users.find((u) => u.id === t.assigneeId);
                const prio = PRIORITIES.find((p) => p.id === (t.priority ?? 'none'))!;
                const overdue = t.dueDate && t.dueDate < todayISO() && t.status !== 'done';
                return (
                  <button
                    key={t.id}
                    onClick={() => navigate(`/tasks/${t.id}`)}
                    className="flex w-full items-center gap-3 border-b border-neutral-100 px-3 py-2.5 text-left text-sm transition-colors last:border-0 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
                  >
                    <Popover
                      trigger={
                        <span className="shrink-0" onClick={(e) => e.stopPropagation()}>
                          <StatusDot status={(t.status ?? 'todo') as TaskStatus} />
                        </span>
                      }
                    >
                      {(close) => (
                        <Menu
                          close={close}
                          items={STATUSES.map((s) => ({
                            label: s.label,
                            onClick: () => void setTaskField(t.id, { status: s.id }),
                          }))}
                        />
                      )}
                    </Popover>
                    <span className={cn('min-w-0 flex-1 truncate', t.status === 'done' && 'text-neutral-400 line-through')}>{String(t.title ?? '') || 'Untitled task'}</span>
                    {t.priority && t.priority !== 'none' && (
                      <span className={cn('hidden items-center gap-1 text-[11px] sm:flex', prio.cls)}>
                        <Flag size={11} fill="currentColor" /> {prio.label}
                      </span>
                    )}
                    {t.dueDate && <span className={cn('text-[11px]', overdue ? 'font-medium text-red-500' : 'text-neutral-400')}>{formatDate(String(t.dueDate))}</span>}
                    {assignee && <Avatar name={assignee.name} color={assignee.color} size={20} />}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
