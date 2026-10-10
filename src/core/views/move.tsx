/**
 * MoveRecordDialog — the keyboard/touch 'Move' affordance for records:
 * reparent inside the database (cycle + depth≤3 checked via shared/tree.ts)
 * or move to another database entirely (descendants move too).
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Check } from 'lucide-react';
import { toast } from '../files';
import { Button, Dialog } from '../ui';
import { cn } from '../utils';
import { taskBoardId, type BoardRow, type TaskRow } from '../../modules/boards/api';
import { isRecordsDb, moveRecordToDatabase, recordTitle, setParent, stagesOf } from '../records';
import { checkReparent, buildParentMap } from '../records';
import { useBoardsLite } from './shared';

export function MoveRecordDialog({ rec, board, tasks, onClose }: { rec: TaskRow; board: BoardRow; tasks: TaskRow[]; onClose: () => void }) {
  const navigate = useNavigate();
  const boards = useBoardsLite();
  const [targetDb, setTargetDb] = useState(board.id);
  const [parentId, setParentId] = useState<string | ''>(String(rec.parentId ?? ''));

  const sameDb = targetDb === board.id;
  const pm = useMemo(() => buildParentMap(tasks), [tasks]);
  const candidates = useMemo(
    () =>
      tasks
        .filter((t) => !t.deleted && taskBoardId(t) === board.id && t.id !== rec.id)
        .map((t) => ({ t, check: checkReparent(pm, rec.id, t.id) })),
    [tasks, board.id, rec.id, pm],
  );

  const validParents = candidates.filter((c) => c.check === 'ok');
  const otherDbs = boards.filter((b) => b.id !== board.id && !b.deleted);

  const apply = async () => {
    try {
      if (!sameDb) {
        const { hiddenRelations } = await moveRecordToDatabase(rec.id, targetDb);
        if (hiddenRelations) toast(`${hiddenRelations} relation${hiddenRelations === 1 ? '' : 's'} kept but hidden (field absent on target)`);
        navigate(`/boards/${targetDb}/tasks/${rec.id}`);
      } else {
        const pid = parentId || null;
        if (pid !== (rec.parentId ?? null)) await setParent(rec.id, pid);
      }
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Move failed', 'error');
    }
  };

  return (
    <Dialog title={`Move ${isRecordsDb(board) ? 'record' : 'task'}`} onClose={onClose}>
      <p className="mb-1 text-xs font-semibold text-neutral-500 dark:text-neutral-400">Database</p>
      <div className="max-h-40 overflow-y-auto rounded-lg border border-neutral-200 dark:border-neutral-700">
        {[board, ...otherDbs].map((b) => (
          <button key={b.id} className={cn('flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900', b.id === targetDb && 'bg-blue-50/60 dark:bg-blue-950/30')} onClick={() => setTargetDb(b.id)}>
            <span>{String(b.icon ?? (isRecordsDb(b) ? '🗃️' : '🗂️'))}</span>
            <span className="flex-1 truncate">{String(b.name ?? 'Untitled')}</span>
            {b.id === targetDb && <Check size={13} className="text-blue-500" />}
          </button>
        ))}
      </div>
      {sameDb && (
        <>
          <p className="mb-1 mt-3 text-xs font-semibold text-neutral-500 dark:text-neutral-400">Under…</p>
          <div className="max-h-44 overflow-y-auto rounded-lg border border-neutral-200 dark:border-neutral-700">
            <button className={cn('flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900', parentId === '' && 'bg-blue-50/60 dark:bg-blue-950/30')} onClick={() => setParentId('')}>
              <span className="flex-1 text-neutral-500">Top level</span>
              {parentId === '' && <Check size={13} className="text-blue-500" />}
            </button>
            {validParents.map(({ t }) => {
              const stage = stagesOf(board).find((c) => c.id === String(t.status));
              return (
                <button key={t.id} className={cn('flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900', parentId === t.id && 'bg-blue-50/60 dark:bg-blue-950/30')} onClick={() => setParentId(t.id)}>
                  <span className="flex-1 truncate">{recordTitle(t)}</span>
                  {stage && <span className="h-1.5 w-1.5 rounded-full" style={{ background: stage.color }} />}
                  {parentId === t.id && <Check size={13} className="text-blue-500" />}
                </button>
              );
            })}
          </div>
          {candidates.length > validParents.length && <p className="mt-1 text-[11px] text-neutral-400">Some records are hidden — moving under them would create a cycle or exceed 3 levels.</p>}
        </>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={() => void apply()}>Move</Button>
      </div>
    </Dialog>
  );
}
