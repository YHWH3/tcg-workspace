import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from 'react-router';
import { db, type LocalRow } from '../../../core/db';
import { mutate } from '../../../core/sync/engine';
import { recordHref } from '../../../core/views/shared';
import { Button } from '../../../core/ui';
import { columnsOf, taskBoardId, PRIORITIES } from '../../boards/api';
import { cardRef, type MoodItem } from '../api';

/** Live record/page card on the canvas. Legacy `taskId` resolves as a record ref. */
export function CardItem({ item, stageMirror }: { item: MoodItem; stageMirror?: string | null }) {
  const navigate = useNavigate();
  const ref = cardRef(item);
  const task = useLiveQuery(async () => (ref?.type === 'record' ? ((await db.tasks.get(ref.id)) as LocalRow | undefined) : undefined), [ref?.type, ref?.id]);
  const page = useLiveQuery(async () => (ref?.type === 'page' ? ((await db.pages.get(ref.id)) as LocalRow | undefined) : undefined), [ref?.type, ref?.id]);
  const board = useLiveQuery(async () => (task && ref ? ((await db.boards.get(taskBoardId(task))) as LocalRow | undefined) : undefined), [task?.id, task?.boardId]);

  if (!ref) return <div className="w-full h-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-xs text-[var(--muted)]">Unlinked card</div>;

  if (ref.type === 'page') {
    const deleted = !!page?.deleted;
    return (
      <button
        type="button"
        className={`w-full h-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2.5 text-left shadow-sm overflow-hidden ${deleted ? 'opacity-50' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          if (!deleted) navigate(`/pages/${ref.id}`);
        }}
      >
        <div className="text-xs text-[var(--muted)] mb-1">Page</div>
        <div className="text-sm font-medium leading-snug line-clamp-3">{page ? String(page.title ?? 'Untitled') : '…'}</div>
        {deleted && (
          <Button
            size="sm"
            variant="ghost"
            className="mt-1"
            onClick={(e) => {
              e.stopPropagation();
              void mutate('pages', ref.id, { deleted: false });
            }}
          >
            Restore
          </Button>
        )}
      </button>
    );
  }

  const deleted = !task || !!task.deleted;
  const col = task && board ? columnsOf(board).find((c) => c.id === String(task.status ?? '')) : undefined;
  const prio = PRIORITIES.find((p) => p.id === task?.priority);
  const mismatch = !!stageMirror && !deleted && String(task?.status ?? '') !== stageMirror;

  return (
    <div
      className={`w-full h-full rounded-md border bg-[var(--surface)] p-2.5 text-left shadow-sm overflow-hidden ${deleted ? 'border-dashed border-[var(--border)] opacity-60' : 'border-[var(--border)]'}`}
      onClick={(e) => {
        e.stopPropagation();
        if (!deleted && task) navigate(recordHref(taskBoardId(task), undefined, ref.id));
      }}
      role="button"
      tabIndex={-1}
    >
      <div className="flex items-start gap-1.5">
        <div className="text-sm font-medium leading-snug line-clamp-2 flex-1">{task ? String(task.title ?? 'Untitled') : 'Missing record'}</div>
        {mismatch && <span title="Record stage differs from this frame's stage" className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-amber-500" />}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--muted)]">
        {col && (
          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-1.5 py-0.5">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: col.color }} />
            {col.name}
          </span>
        )}
        {prio && prio.id !== 'none' && <span className={prio.cls}>{prio.label}</span>}
        {!!task?.dueDate && <span>{String(task.dueDate)}</span>}
      </div>
      {deleted && (
        <Button
          size="sm"
          variant="ghost"
          className="mt-1"
          onClick={(e) => {
            e.stopPropagation();
            void mutate('tasks', ref.id, { deleted: false });
          }}
        >
          Restore
        </Button>
      )}
    </div>
  );
}
