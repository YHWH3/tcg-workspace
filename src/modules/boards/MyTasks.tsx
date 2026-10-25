import {useWorkspaceLocale} from '../../core/workspaceLocale';
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { CheckSquare } from 'lucide-react';
import { authStore } from '../../core/auth';
import { Avatar, EmptyState } from '../../core/ui';
import { resolveUser, useUsers } from '../../core/users';
import { useStore } from '../../core/store';
import { cn, cmpOrder, formatDate, todayISO } from '../../core/utils';
import { columnIdFor, columnsOf, isDone, liveTasks, PRIORITIES, taskBoardId, useBoards, useTasks, type TaskRow } from './api';
import { FieldChips } from './FieldValue';

/** /tasks — "My tasks" across all boards, grouped by board. */
export function MyTasksPage() {
  useWorkspaceLocale();
  const tasks = useTasks();
  const boards = useBoards();
  const users = useUsers();
  const me = useStore(authStore).user;
  const navigate = useNavigate();

  const groups = useMemo(() => {
    const mine = liveTasks(tasks).filter((t) => t.assigneeId === me?.id);
    const byBoard = new Map<string, TaskRow[]>();
    for (const t of mine) {
      const bid = taskBoardId(t);
      if (!byBoard.has(bid)) byBoard.set(bid, []);
      byBoard.get(bid)!.push(t);
    }
    return boards
      .filter((b) => byBoard.has(b.id))
      .map((b) => ({ board: b, tasks: byBoard.get(b.id)!.sort((a, b2) => cmpOrder(a.order, b2.order)) }));
  }, [tasks, boards, me?.id]);

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto px-5 py-8">
      <h1 className="mb-5 text-xl font-semibold tracking-tight">My tasks</h1>
      {groups.length === 0 ? (
        <EmptyState icon={CheckSquare} title="Nothing assigned to you" body="Tasks assigned to you across all boards will show up here." />
      ) : (
        groups.map(({ board, tasks: list }) => {
          const cols = columnsOf(board);
          return (
            <div key={board.id} className="mb-6">
              <button className="mb-1.5 flex items-center gap-2 px-1 text-xs font-semibold text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200" onClick={() => navigate(`/boards/${board.id}`)}>
                <span>{String(board.icon ?? '🗂️')}</span> {String(board.name ?? 'Board')}
              </button>
              <div className="overflow-hidden rounded-xl border border-neutral-200/70 dark:border-neutral-800">
                {list.map((t) => {
                  const col = cols.find((c) => c.id === columnIdFor(t, board));
                  const assignee = resolveUser(t.assigneeId ?? null, users, me);
                  const overdue = t.dueDate && String(t.dueDate) < todayISO() && !isDone(t, board);
                  const prio = PRIORITIES.find((p) => p.id === t.priority);
                  return (
                    <button
                      key={t.id}
                      className="flex w-full items-center gap-3 border-b border-neutral-100 px-3 py-2.5 text-left text-sm transition-colors last:border-0 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
                      onClick={() => navigate(`/boards/${board.id}/tasks/${t.id}`)}
                    >
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: col?.color ?? '#999' }} title={col?.name} />
                      <span className={cn('min-w-0 flex-1 truncate', isDone(t, board) && 'text-neutral-400 line-through')}>{String(t.title ?? '') || 'Untitled task'}</span>
                      <FieldChips board={board} task={t} />
                      {prio && prio.id !== 'none' && <span className={cn('hidden items-center gap-1 text-[11px] sm:flex', prio.cls)}>{prio.label}</span>}
                      {t.dueDate && <span className={cn('text-[11px]', overdue ? 'font-medium text-red-500' : 'text-neutral-400')}>{formatDate(String(t.dueDate))}</span>}
                      {assignee && <Avatar name={assignee.name} color={assignee.color} size={18} />}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
