import { Link, useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, Shapes } from 'lucide-react';
import { db } from '../../core/db';
import { useFileUrl } from '../../core/files';
import { EmptyState } from '../../core/ui';
import { cn } from '../../core/utils';
import { createMoodboard, useMoodboards } from './api';

function Thumb({ fileId }: { fileId: string }) {
  const { url } = useFileUrl(fileId);
  return url ? <img src={url} alt="" className="h-full w-full object-cover" /> : <div className="h-full w-full bg-neutral-200/70 dark:bg-neutral-800" />;
}

function BoardTile({ board }: { board: { id: string; title?: unknown; icon?: unknown } }) {
  const images =
    useLiveQuery(
      () =>
        db.mooditems
          .where('boardId')
          .equals(board.id)
          .filter((i) => !i.deleted && i.type === 'image' && !!i.fileId)
          .limit(4)
          .toArray(),
      [board.id],
      [],
    ) ?? [];
  return (
    <Link
      to={`/moodboards/${board.id}`}
      className="group overflow-hidden rounded-2xl border border-neutral-200/80 bg-white shadow-sm transition-shadow hover:shadow-md dark:border-neutral-800 dark:bg-neutral-900"
    >
      <div className="grid aspect-[4/3] grid-cols-2 gap-px bg-neutral-100 dark:bg-neutral-800">
        {[0, 1, 2, 3].map((i) =>
          images[i] ? <Thumb key={i} fileId={String(images[i].fileId)} /> : <div key={i} className="bg-neutral-50 dark:bg-neutral-900" />,
        )}
      </div>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span className="text-base leading-none">{String(board.icon ?? '🎨')}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{String(board.title ?? '') || 'Untitled board'}</span>
      </div>
    </Link>
  );
}

export function MoodIndex() {
  const boards = useMoodboards();
  const nav = useNavigate();
  return (
    <div className="mx-auto h-full max-w-4xl overflow-y-auto px-5 py-8">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Mood boards</h1>
        <button
          className={cn('flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900')}
          onClick={async () => nav(`/moodboards/${await createMoodboard()}`)}
        >
          <Plus size={15} /> New board
        </button>
      </div>
      {boards.length === 0 ? (
        <EmptyState icon={Shapes} title="No mood boards" body="Collect images, notes, text and colors on an infinite canvas." />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">{boards.map((b) => <BoardTile key={b.id} board={b} />)}</div>
      )}
    </div>
  );
}
