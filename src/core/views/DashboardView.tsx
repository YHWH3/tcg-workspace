import { useState } from 'react';
import { LayoutDashboard } from 'lucide-react';
import { Link } from 'react-router';
import { columnIdFor } from '../../../shared/boardModel';
import { recordHref } from '../../../shared/recordRoutes';
import { summarizeDashboard } from '../../../shared/views';
import type { BoardRow, TaskRow } from '../../modules/boards/api';
import { fieldOptionStyle } from '../fieldColors';
import { applyView, fieldKeyLabel, recordTitle, type ViewCtx, type ViewRow } from '../records';
import { EmptyState } from '../ui';
import { cn } from '../utils';

export function DashboardView({ board, view, records, context }: {
  board: BoardRow;
  view: ViewRow;
  records: TaskRow[];
  context: ViewCtx;
}) {
  const [stage, setStage] = useState<string | null>(null);
  const [limit, setLimit] = useState(12);
  const { rows } = applyView(records, view.config, context);
  const overview = summarizeDashboard(rows, board, view.config);
  const selected = overview.stages.find(column => column.id === stage);
  const displayed = selected ? rows.filter(row => columnIdFor(row, board) === selected.id) : rows;
  const metrics: { key: string; label: string; value: number; color?: string }[] = [
    { key: 'total', label: 'Records', value: overview.total },
    { key: 'scheduled', label: `With ${fieldKeyLabel(board, overview.dateKey).toLowerCase()}`, value: overview.scheduled },
    ...overview.stages.map(column => ({ key: `stage:${column.id}`, label: column.name, value: column.count, color: column.color })),
  ];
  return (
    <section aria-label="Database dashboard" className="mx-auto max-w-4xl space-y-5 px-3 py-4 sm:px-5">
      <dl className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(100%,10rem),1fr))]">
        {metrics.map(metric => (
          <div key={metric.key} className="min-w-0 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800"
            style={metric.color ? fieldOptionStyle(metric.color) : undefined}>
            <dt className="break-words text-sm font-medium [overflow-wrap:anywhere]">{metric.label}</dt>
            <dd className="mt-0.5 text-2xl font-semibold tabular-nums">{metric.value}</dd>
          </div>
        ))}
      </dl>
      {overview.stages.length > 0 && (
        <div role="group" aria-label="Show records by stage" className="flex flex-wrap gap-1.5">
          {[{ id: null, name: 'All records' }, ...overview.stages].map(column => (
            <button key={column.id ?? 'all'} type="button" aria-pressed={column.id === (selected?.id ?? null)}
              className={cn('min-h-11 rounded-lg border border-transparent px-3 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800',
                column.id === (selected?.id ?? null) && 'border-neutral-300 bg-neutral-100 font-medium dark:border-neutral-700 dark:bg-neutral-800')}
              onClick={() => { setStage(column.id); setLimit(12); }}>{column.name}</button>
          ))}
        </div>
      )}
      {displayed.length ? (
        <>
          <ul className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {displayed.slice(0, limit).map(row => (
              <li key={row.id}>
                <Link className="flex min-h-11 items-center break-words px-3 py-2 text-sm hover:underline [overflow-wrap:anywhere]"
                  to={recordHref(board.id, view.id || undefined, row.id)}>{recordTitle(row) || 'Untitled record'}</Link>
              </li>
            ))}
          </ul>
          {displayed.length > limit && <button type="button" className="min-h-11 px-3 text-sm underline" onClick={() => setLimit(limit + 12)}>Show more records</button>}
        </>
      ) : <EmptyState icon={LayoutDashboard} title="No matching records" />}
    </section>
  );
}
