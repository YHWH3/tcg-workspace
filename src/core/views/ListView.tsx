/** ListView — compact rows with property chips; groups when groupBy set. */
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { useIsMobile } from '../mobile';
import { authStore } from '../auth';
import { useStore } from '../store';
import { mutate } from '../sync/engine';
import { EmptyState } from '../ui';
import { Avatar } from '../ui';
import { resolveUser, useUsers } from '../users';
import { cn, formatDate, todayISO } from '../utils';
import { applyView, defaultVisibleKeys, groupKeyLabel, isRecordsDb, recordTitle, stagesOf, viewCtx, type ViewRow } from '../records';
import { columnIdFor, lastColumnId, PRIORITIES, useTasks, type BoardRow, type TaskRow } from '../../modules/boards/api';
import { CellValue, subProgress } from './cells';
import { dependencyEdges, isBlocked, useLinks } from '../links';
import { CheckSquare } from 'lucide-react';
import { useTokenResolver } from '../resolveMentions';
import { renderPlain } from '../mentions';

export function ListView({ board, view, records }: { board: BoardRow; view: ViewRow; records: TaskRow[] }) {
  const tasks = useTasks();
  const links = useLinks();
  const navigate = useNavigate();
  const users = useUsers();
  const meUser = useStore(authStore).user;
  const meId = meUser?.id;
  const resolve = useTokenResolver();
  const mobile = useIsMobile();
  const cfg = view.config ?? {};
  const visible = (cfg.visible?.length ? cfg.visible : defaultVisibleKeys(board)).filter((k) => k !== 'title');

  const ctx = useMemo(() => viewCtx(board, tasks, links, meId, todayISO()), [meId, board, links, tasks]);

  const { rows, groups } = useMemo(() => applyView(records, cfg, ctx), [records, cfg, ctx]);
  const edges = dependencyEdges(links);
  const done = (id: string) => {
    const t = tasks.find((x) => x.id === id);
    return t ? columnIdFor(t, board) === lastColumnId(board) && stagesOf(board).length > 0 : false;
  };

  const renderRows = (list: TaskRow[]) => (
    <div className="overflow-hidden rounded-xl border border-neutral-200/70 dark:border-neutral-800">
      {list.map((r) => {
        const kids = subProgress(r, tasks, board);
        const blocked = isBlocked(r.id, edges, done);
        const assignee = resolveUser(r.assigneeId ? String(r.assigneeId) : null, users, meUser);
        const overdue = r.dueDate && String(r.dueDate) < todayISO() && !done(r.id);
        const prio = PRIORITIES.find((p) => p.id === r.priority);
        const isDone = done(r.id);
        return (
          <button
            key={r.id}
            onClick={() => navigate(`/boards/${board.id}/views/${view.id}/records/${r.id}`)}
            className="flex w-full items-center gap-3 border-b border-neutral-100 px-3 py-2.5 text-left text-sm transition-colors last:border-0 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
            style={{ minHeight: 44 }}
          >
            {stagesOf(board).length > 0 && (
              <span
                role="checkbox"
                aria-checked={isDone}
                aria-label="Mark done"
                className={cn('flex shrink-0 items-center justify-center rounded border transition-colors', isDone ? 'border-blue-500 bg-blue-500 text-white' : 'border-neutral-300 hover:border-neutral-400 dark:border-neutral-600')}
                style={{ width: 18, height: 18 }}
                onClick={(e) => {
                  e.stopPropagation();
                  void mutate('tasks', r.id, { status: isDone ? stagesOf(board)[0].id : lastColumnId(board) });
                }}
              >
                {isDone && (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                )}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className={cn('block truncate', isDone && 'text-neutral-400 line-through')}>
                {renderPlain(recordTitle(r), resolve)}
                {blocked && <span className="ml-1.5 rounded bg-red-50 px-1 py-0.5 text-[10px] font-medium text-red-500 dark:bg-red-950/40">blocked</span>}
              </span>
            </span>
            {!mobile && visible.slice(0, 4).map((k) => <CellValue key={k} board={board} rec={r} keyName={k} />)}
            {kids.total > 0 && <span className="text-[11px] text-neutral-400">{kids.done}/{kids.total}</span>}
            {prio && prio.id !== 'none' && <span className={cn('hidden text-[11px] sm:inline', prio.cls)}>{prio.label}</span>}
            {r.dueDate && <span className={cn('text-[11px]', overdue ? 'font-medium text-red-500' : 'text-neutral-400')}>{formatDate(String(r.dueDate))}</span>}
            {assignee && <Avatar name={assignee.name} color={assignee.color} size={18} />}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="mx-auto max-w-3xl px-4 py-4">
      {groups
        ? groups.map((g) => (
            <div key={g.key} className="mb-4">
              <div className="mb-1 px-2 text-xs font-semibold text-neutral-500 dark:text-neutral-400">
                {cfg.groupBy ? groupKeyLabel(board, cfg.groupBy, g.key) : ''} <span className="font-normal text-neutral-400">{g.rows.length}</span>
              </div>
              {renderRows(g.rows)}
            </div>
          ))
        : renderRows(rows)}
      {rows.length === 0 && <EmptyState icon={CheckSquare} title={isRecordsDb(board) ? 'No records' : 'No tasks'} />}
    </div>
  );
}
