import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { LayoutGrid, Plus } from 'lucide-react';
import { db } from '../../core/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { EmptyState } from '../../core/ui';
import type { FileRow } from '../../core/files';
import { boardTasks, useBoards, useTasks, type BoardRow } from './api';
import { FileImage } from '../../core/fileui';
import { isArchived } from '../../../shared/archive';

/** /boards — grid of board tiles with a mosaic of recent task covers. */
export function BoardsIndex() {
  const boards = useBoards();
  const tasks = useTasks();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  return (
    <div className="mx-auto h-full max-w-4xl overflow-y-auto px-5 py-8">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Boards</h1>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {boards.filter((b) => !isArchived(b)).map((b) => (
          <BoardTile key={b.id} board={b} tasks={boardTasks(tasks, b.id)} />
        ))}
        <div className="min-h-32">
          {creating ? (
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Board name"
              className="h-full w-full rounded-2xl border border-neutral-200 bg-white px-4 text-sm outline-none focus:ring-2 focus:ring-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-900"
              onKeyDown={async (e) => {
                if (e.key === 'Enter') {
                  const { createBoard } = await import('./api');
                  const id = await createBoard(name);
                  setCreating(false);
                  setName('');
                  navigate(`/boards/${id}`);
                }
                if (e.key === 'Escape') setCreating(false);
              }}
              onBlur={() => setCreating(false)}
            />
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="flex h-full min-h-32 w-full flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-neutral-300 text-sm text-neutral-400 transition-colors hover:border-neutral-400 hover:text-neutral-600 dark:border-neutral-700 dark:hover:border-neutral-600 dark:hover:text-neutral-300"
            >
              <Plus size={18} /> New board
            </button>
          )}
        </div>
      </div>
      {boards.length === 0 && <EmptyState icon={LayoutGrid} title="No boards yet" body="Boards appear after the first sync." />}
    </div>
  );
}

function BoardTile({ board, tasks }: { board: BoardRow; tasks: ReturnType<typeof boardTasks> }) {
  const covers = useBoardCovers(tasks);
  const open = tasks.filter((t) => !t.deleted).length;
  return (
    <Link
      to={`/boards/${board.id}`}
      className="group flex min-h-32 flex-col overflow-hidden rounded-2xl border border-neutral-200/80 bg-white transition-shadow hover:shadow-md dark:border-neutral-800 dark:bg-neutral-900"
    >
      {covers.length > 0 ? (
        <div className={`grid h-24 gap-px overflow-hidden bg-neutral-100 dark:bg-neutral-800 ${covers.length === 1 ? 'grid-cols-1' : covers.length === 2 ? 'grid-cols-2' : 'grid-cols-2 grid-rows-2'}`}>
          {covers.slice(0, 4).map((f, i) => (
            <FileImage key={f.id} fileId={f.id} thumbId={f.thumbId} className={`h-full w-full ${covers.length === 3 && i === 0 ? 'row-span-2' : ''}`} />
          ))}
        </div>
      ) : (
        <div className="flex h-24 items-center justify-center bg-neutral-50 text-3xl dark:bg-neutral-900/60">{String(board.icon ?? '🗂️')}</div>
      )}
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="truncate text-sm font-medium">{String(board.name ?? 'Board')}</span>
        <span className="text-[11px] text-neutral-400">{open}</span>
      </div>
    </Link>
  );
}

/** Up to 4 cover images from the board's most recently created tasks. */
function useBoardCovers(tasks: { id: string; coverFileId?: string | null; createdAt?: number }[]): FileRow[] {
  const ids = useMemo(() => [...tasks].sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0)).slice(0, 12).map((t) => t.id), [tasks]);
  const files = useLiveQuery(() => db.files.filter((f) => !f.deleted && f.kind === 'image' && ids.includes(String(f.parentId))).toArray(), [ids.join(',')], []);
  return useMemo(() => {
    const list = (files ?? []) as FileRow[];
    const covers: FileRow[] = [];
    const seenTask = new Set<string>();
    for (const t of [...tasks].sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0))) {
      const cover = t.coverFileId ? list.find((f) => f.id === t.coverFileId) : list.find((f) => f.parentId === t.id);
      if (cover && !seenTask.has(t.id)) {
        covers.push(cover);
        seenTask.add(t.id);
      }
      if (covers.length >= 4) break;
    }
    return covers;
  }, [files, tasks]);
}
