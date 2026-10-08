/** GalleryView — card grid using view.config.cover for the image source. */
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { Image as ImageIcon } from 'lucide-react';
import { useFileUrl } from '../files';
import { authStore } from '../auth';
import { EmptyState } from '../ui';
import { todayISO } from '../utils';
import { applyView, defaultVisibleKeys, isRecordsDb, recordTitle, viewCtx, type ViewRow } from '../records';
import { useTasks, type BoardRow, type TaskRow } from '../../modules/boards/api';
import { useLinks } from '../links';
import { CellValue } from './cells';

function Cover({ rec, coverField }: { rec: TaskRow; coverField: string | null | undefined }) {
  const fileId = useMemo(() => {
    if (!coverField) return null;
    if (coverField === 'cover') return (rec.coverFileId as string | undefined) ?? null;
    if (coverField.startsWith('p_')) return (rec[coverField] as string | undefined) ?? null;
    return null;
  }, [rec, coverField]);
  const { url } = useFileUrl(fileId ?? undefined);
  if (!fileId || !url) {
    return (
      <div className="flex h-28 items-center justify-center bg-neutral-100 dark:bg-neutral-800/60">
        <ImageIcon size={22} className="text-neutral-300 dark:text-neutral-600" />
      </div>
    );
  }
  return <img src={url} alt="" className="h-28 w-full object-cover" loading="lazy" />;
}

export function GalleryView({ board, view, records }: { board: BoardRow; view: ViewRow; records: TaskRow[] }) {
  const tasks = useTasks();
  const links = useLinks();
  const navigate = useNavigate();
  const meId = authStore.get().user?.id;
  const cfg = view.config ?? {};
  const visible = (cfg.visible?.length ? cfg.visible : defaultVisibleKeys(board)).filter((k) => k !== 'title').slice(0, 3);
  const ctx = useMemo(() => viewCtx(board, tasks, links, meId, todayISO()), [meId, board, links, tasks]);
  const { rows } = useMemo(() => applyView(records, cfg, ctx), [records, cfg, ctx]);
  const coverField = cfg.cover ?? 'cover';

  return (
    <div className="px-4 py-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        {rows.map((r) => (
          <button
            key={r.id}
            onClick={() => navigate(`/boards/${board.id}/views/${view.id}/records/${r.id}`)}
            className="overflow-hidden rounded-xl border border-neutral-200/70 bg-white text-left shadow-sm transition-shadow hover:shadow-md dark:border-neutral-800 dark:bg-neutral-900"
          >
            <Cover rec={r} coverField={coverField} />
            <div className="p-3">
              <p className="truncate text-sm font-medium">{recordTitle(r)}</p>
              {visible.length > 0 && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {visible.map((k) => (
                    <CellValue key={k} board={board} rec={r} keyName={k} />
                  ))}
                </div>
              )}
            </div>
          </button>
        ))}
      </div>
      {rows.length === 0 && <EmptyState icon={ImageIcon} title={isRecordsDb(board) ? 'No records' : 'No tasks'} />}
    </div>
  );
}
