import {useWorkspaceLocale} from '../../../core/workspaceLocale';
/**
 * `mywork` dashboard block (§3): open records assigned to me across databases
 * (assigneeId === me, status ∉ the board's last column), grouped Overdue /
 * Today / Upcoming / No due date by `dueDate`; each row drills to the record.
 */
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { CheckSquare } from 'lucide-react';
import { authStore } from '../../../core/auth';
import type { LocalRow } from '../../../core/db';
import { useStore } from '../../../core/store';
import { cn, todayISO } from '../../../core/utils';
import { recordHref } from '../../../core/views/shared';
import { boardKind, recordNoun } from '../../../core/records';
import { columnsOf, taskBoardId, type BoardRow, type TaskRow } from '../api';
import { registerBlockType, type MediaBlockProps } from '../../pages/blocks/registry';
import { isArchived } from '../../../../shared/archive';
import { BlockNotice, DashBlock, HeadingField, LimitField, StageChip, num, saveBlockCfg, str, useBoardsQuery, useTasksQuery } from './shared';

function openOnBoard(t: TaskRow, board: BoardRow | undefined): boolean {
  if (t.deleted || isArchived(t) || !board || board.deleted || isArchived(board)) return false;
  const cols = columnsOf(board);
  if (!cols.length) return true;
  const last = cols[cols.length - 1].id;
  const status = typeof t.status === 'string' && cols.some((c) => c.id === t.status) ? t.status : cols[0].id;
  return status !== last;
}

function MyWorkBlockInner({ block }: { block: LocalRow }) {
  const locale=useWorkspaceLocale();
  const me = useStore(authStore).user;
  const boards = useBoardsQuery();
  const tasks = useTasksQuery();
  const navigate = useNavigate();

  const groups = useMemo(() => {
    const out: { key: string; label: string; rows: { rec: TaskRow; board: BoardRow }[] }[] = [
      { key: 'overdue', label: 'Overdue', rows: [] },
      { key: 'today', label: 'Today', rows: [] },
      { key: 'upcoming', label: 'Upcoming', rows: [] },
      { key: 'nodate', label: 'No due date', rows: [] },
    ];
    if (!me || !boards || !tasks) return out;
    const today = todayISO();
    const byId = new Map(boards.map((b) => [b.id, b]));
    const mine = tasks
      .filter((t) => t.assigneeId === me.id && openOnBoard(t, byId.get(taskBoardId(t))))
      .map((t) => ({ rec: t, board: byId.get(taskBoardId(t))! }));
    for (const m of mine) {
      const due = typeof m.rec.dueDate === 'string' && m.rec.dueDate ? m.rec.dueDate : null;
      if (!due) out[3].rows.push(m);
      else if (due < today) out[0].rows.push(m);
      else if (due === today) out[1].rows.push(m);
      else out[2].rows.push(m);
    }
    const byDue = (a: { rec: TaskRow }, b: { rec: TaskRow }) => String(a.rec.dueDate ?? '9999').localeCompare(String(b.rec.dueDate ?? '9999'));
    for (const g of out) g.rows.sort(byDue);
    return out;
  }, [me, boards, tasks,locale.today]);

  if (!me) return <BlockNotice>Sign in to see your work.</BlockNotice>;
  if (boards === undefined || tasks === undefined) return <BlockNotice tone="loading">Loading…</BlockNotice>;

  const limit = num(block.limit);
  let remaining = limit ?? Infinity;
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  if (total === 0) {
    return <p className="rounded-lg border border-dashed border-neutral-200 px-3 py-4 text-center text-xs text-neutral-400 dark:border-neutral-700">No open work.</p>;
  }

  return (
    <div className="space-y-3">
      {groups.map((g) => {
        if (!g.rows.length || remaining <= 0) return null;
        const rows = g.rows.slice(0, remaining);
        remaining -= rows.length;
        return (
          <section key={g.key}>
            <h4 className={cn('mb-1 text-[10px] font-semibold uppercase tracking-wide', g.key === 'overdue' ? 'text-red-500' : 'text-neutral-400')}>
              {g.label} <span className="font-normal">{g.rows.length}</span>
            </h4>
            <ul className="space-y-0.5">
              {rows.map(({ rec, board }) => {
                const noun = recordNoun(board);
                return (
                  <li key={rec.id}>
                    <button
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-neutral-100 focus-visible:bg-neutral-100 dark:hover:bg-neutral-800 dark:focus-visible:bg-neutral-800"
                      onClick={() => navigate(recordHref(board.id, undefined, rec.id))}
                    >
                      <span className="min-w-0 flex-1 truncate">{String(rec.title ?? 'Untitled')}</span>
                      {boardKind(board) === 'records' && <span className="shrink-0 text-[10px] text-neutral-400">{String(board.icon ?? '')} {noun}</span>}
                      {typeof rec.dueDate === 'string' && rec.dueDate && <span className={cn('shrink-0 text-[10px]', rec.dueDate <= todayISO() ? 'text-red-500' : 'text-neutral-400')}>{rec.dueDate.slice(5)}</span>}
                      <StageChip rec={rec} board={board} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {limit && total > limit && <p className="text-[10px] text-neutral-400">Showing {limit} of {total}.</p>}
    </div>
  );
}

function MyWorkBlock({ block }: MediaBlockProps) {
  return (
    <DashBlock
      block={block}
      icon={CheckSquare}
      label="My work"
      config={
        <>
          <HeadingField value={str(block.heading)} onChange={(v) => saveBlockCfg(block, { heading: v ?? null })} />
          <LimitField value={num(block.limit)} onChange={(n) => saveBlockCfg(block, { limit: n ?? null })} />
        </>
      }
    >
      {() => <MyWorkBlockInner block={block} />}
    </DashBlock>
  );
}

registerBlockType('mywork', 'My work', MyWorkBlock);
export default MyWorkBlock;
