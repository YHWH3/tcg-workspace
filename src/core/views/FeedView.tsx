import { useState } from 'react';
import { Link } from 'react-router';
import { Newspaper } from 'lucide-react';
import { toDateOnlyInZone } from '../../../shared/dates';
import { recordHref } from '../../../shared/recordRoutes';
import { useTasks, type BoardRow, type TaskRow } from '../../modules/boards/api';
import { authStore } from '../auth';
import { useLinks } from '../links';
import { renderPlain } from '../mentions';
import { applyView, defaultVisibleKeys, groupKeyLabel, recordTitle, viewCtx, type ViewRow } from '../records';
import { useTokenResolver } from '../resolveMentions';
import { useStore } from '../store';
import { Button, EmptyState } from '../ui';
import { formatDate, todayISO } from '../utils';
import { useWorkspaceLocale } from '../workspaceLocale';
import { BulkRowCheckbox } from './bulk';
import { CellValue } from './cells';

const PAGE_SIZE = 25;

export function FeedView({ board, view, records }: { board: BoardRow; view: ViewRow; records: TaskRow[] }) {
  const tasks = useTasks();
  const links = useLinks();
  const me = useStore(authStore).user?.id;
  const resolve = useTokenResolver();
  const { settings } = useWorkspaceLocale();
  const [limit, setLimit] = useState(PAGE_SIZE);
  const config = view.config ?? {};
  const { rows, groups } = applyView(records, config, viewCtx(board, tasks, links, me, todayISO()));
  const shown = new Set(rows.slice(0, limit).map(row => row.id));
  const visible = (config.visible ?? defaultVisibleKeys(board)).filter(key => key !== 'title');

  if (!rows.length) return <EmptyState icon={Newspaper} title="No records in this feed" />;

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-3 py-4 sm:px-5">
      {(groups ?? [{ key: '', rows }]).map(group => {
        const cards = group.rows.filter(row => shown.has(row.id));
        if (!cards.length) return null;
        return (
          <section key={group.key} className="space-y-3">
            {config.groupBy && <h2 className="text-sm font-semibold">{groupKeyLabel(board, config.groupBy, group.key)}</h2>}
            <ul className="space-y-3">
              {cards.map(row => {
                const title = renderPlain(recordTitle(row), resolve) || 'Untitled record';
                const summary = typeof row.description === 'string' ? row.description.trim() : '';
                const created = typeof row.createdAt === 'number' ? toDateOnlyInZone(row.createdAt, settings?.timeZone) : null;
                return (
                  <li key={row.id} className="min-w-0 rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900 sm:p-4">
                    <article>
                      <div className="flex items-start gap-2">
                        <BulkRowCheckbox id={row.id} label={`Select ${title}`} />
                        <h3 className="min-w-0 flex-1 font-semibold">
                          <Link className="inline-flex min-h-11 items-center break-words [overflow-wrap:anywhere] hover:underline"
                            to={recordHref(board.id, view.id || undefined, row.id)}>{title}</Link>
                        </h3>
                      </div>
                      {(!config.visible || visible.includes('createdAt')) && created && (
                        <time className="text-xs text-neutral-600 dark:text-neutral-300" dateTime={created}>
                          {formatDate(created)}
                        </time>
                      )}
                      {summary && <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{renderPlain(summary, resolve)}</p>}
                      <div className="mt-2 flex flex-wrap items-center gap-2 empty:hidden">
                        {visible.filter(key => key !== 'createdAt').map(key => <CellValue key={key} board={board} rec={row} keyName={key} />)}
                      </div>
                    </article>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {rows.length > limit && <Button onClick={() => setLimit(limit + PAGE_SIZE)}>Show more records</Button>}
    </div>
  );
}
