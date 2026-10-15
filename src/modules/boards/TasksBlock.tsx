import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from 'react-router';
import { Check, Plus } from 'lucide-react';
import { db, type LocalRow } from '../../core/db';
import { renderPlain } from '../../core/mentions';
import { useTokenResolver } from '../../core/resolveMentions';
import { FileImage } from '../../core/fileui';
import { mutate } from '../../core/sync/engine';
import { useResolvedUser } from '../../core/users';
import { cn, cmpOrder } from '../../core/utils';
import { columnIdFor, columnsOf, createTask, lastColumnId } from './api';
import { GateMoveHost, noteGatedMove } from './GateMove';
import { registerBlockType, type MediaBlockProps } from '../pages/blocks/registry';

/** Embedded board task list inside a page block. */
function TasksBlock({ block }: MediaBlockProps) {
  const nav = useNavigate();
  const resolveTokens = useTokenResolver();
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const boardId = block.boardId ? String(block.boardId) : undefined;
  const board = useLiveQuery(() => (boardId ? db.boards.get(boardId) : undefined), [boardId]) as LocalRow | undefined;
  const boards = useLiveQuery(() => db.boards.filter((b) => !b.deleted && b.archived !== true).sortBy('order'), [], []);
  const tasks = useLiveQuery(
    () =>
      boardId
        ? db.tasks
            .filter((t) => !t.deleted && (t.boardId === boardId || (!t.boardId && boardId === 'board-default')))
            .toArray()
        : Promise.resolve([] as LocalRow[]),
    [boardId],
    [],
  );

  if (!boardId) {
    return (
      <div className="rounded-xl border border-dashed border-neutral-300 px-4 py-5 dark:border-neutral-700">
        <p className="mb-2 text-xs text-neutral-400">Embed a task list — pick a board</p>
        <div className="flex flex-wrap gap-1.5">
          {(boards ?? []).map((b) => (
            <button
              key={b.id}
              onClick={() => void mutate('blocks', block.id, { boardId: b.id })}
              className="rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium hover:border-neutral-400 dark:border-neutral-700 dark:hover:border-neutral-500"
            >
              {String(b.icon ?? '')} {String(b.name ?? 'Board')}
            </button>
          ))}
          {boards !== undefined && boards.length === 0 && <span className="text-xs text-neutral-400">No boards yet</span>}
        </div>
      </div>
    );
  }

  const cols = board ? columnsOf(board) : [];
  const lastCol = board ? lastColumnId(board) : 'done';
  const list = [...(tasks ?? [])].sort((a, b) => cmpOrder(a.order, b.order));

  const add = async () => {
    const t = newTitle.trim();
    if (!t) return;
    setNewTitle('');
    setAdding(false);
    await createTask(boardId, cols[0]?.id ?? 'todo', { title: t });
  };

  return (
    <div className="rounded-xl border border-neutral-200 px-3 py-2 dark:border-neutral-800">
      <GateMoveHost /> {/* P4-D: gated-stage request dialog */}
      <p className="mb-1 text-[11px] font-semibold tracking-wide text-neutral-400 uppercase">
        {board ? `${String(board.icon ?? '')} ${String(board.name)}` : 'Board'}
      </p>
      {list.length === 0 && !adding && <p className="py-1 text-xs text-neutral-400">No tasks yet</p>}
      {list.map((t) => {
        const colId = columnIdFor(t, board);
        const done = colId === lastCol;
        const col = cols.find((c) => c.id === colId);
        const coverId = t.coverFileId ? String(t.coverFileId) : undefined;
        return (
          <div key={t.id} className="group/t flex items-center gap-2 rounded-md px-1 py-1 hover:bg-neutral-50 dark:hover:bg-neutral-900">
            <button
              className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                done ? 'border-blue-500 bg-blue-500 text-white' : 'border-neutral-300 hover:border-blue-400 dark:border-neutral-600',
              )}
              onClick={() => {
                const next = done ? cols[0]?.id ?? 'todo' : lastCol;
                noteGatedMove(board, t.id, next); // P4-D
                void mutate('tasks', t.id, { status: next });
              }}
              aria-label={done ? 'Reopen task' : 'Complete task'}
            >
              {done && <Check size={10} />}
            </button>
            {coverId && <FileImage fileId={coverId} className="h-7 w-10 shrink-0 rounded object-cover" />}
            <button className={cn('min-w-0 flex-1 truncate text-left text-sm', done && 'text-neutral-400 line-through')} onClick={() => nav(`/boards/${boardId}/tasks/${t.id}`)}>
              {renderPlain(String(t.title ?? 'Untitled'), resolveTokens)}
            </button>
            <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium" style={{ backgroundColor: `${col?.color ?? '#9ca3af'}22`, color: col?.color ?? '#9ca3af' }}>
              {col?.name ?? colId}
            </span>
            <AssigneeDot id={t.assigneeId ? String(t.assigneeId) : undefined} />
          </div>
        );
      })}
      {adding ? (
        <input
          autoFocus
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
            if (e.key === 'Escape') setAdding(false);
          }}
          onBlur={() => void add()}
          placeholder="Task title…"
          className="mt-1 w-full rounded-md border border-neutral-200 bg-transparent px-2 py-1 text-sm outline-none focus:border-blue-400 dark:border-neutral-700"
        />
      ) : (
        <button onClick={() => setAdding(true)} className="mt-1 flex items-center gap-1 rounded-md px-1 py-1 text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300">
          <Plus size={12} /> Add task
        </button>
      )}
    </div>
  );
}

function AssigneeDot({ id }: { id: string | undefined }) {
  const u = useResolvedUser(id);
  if (!u) return null;
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-neutral-200 text-[9px] font-semibold text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
      {(u.name ?? u.id).slice(0, 1).toUpperCase()}
    </span>
  );
}

registerBlockType('tasks', 'Task list', TasksBlock);
