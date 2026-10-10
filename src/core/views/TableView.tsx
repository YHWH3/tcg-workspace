/**
 * TableView — sticky title column, resizable columns, header-click sort,
 * inline cell editing, add row, nested sub-records with disclosure,
 * windowed rendering >300 rows, compact list on narrow containers.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { useIsMobile } from '../mobile';
import { cn, todayISO } from '../utils';
import { authStore } from '../auth';
import { applyView, createRecord, defaultVisibleKeys, fieldKeyLabel, isRecordsDb, recordTitle, updateView, viewCtx, type FieldKey, type ViewRow } from '../records';
import { type BoardRow, type TaskRow, useTasks } from '../../modules/boards/api';
import { CellEditor, CellValue, subProgress } from './cells';
import { useLinks } from '../links';
import { EmptyState } from '../ui';
import { Table2 } from 'lucide-react';

const ROW_H = 36;
const WINDOW_AT = 300;

export function TableView({ board, view, records }: { board: BoardRow; view: ViewRow; records: TaskRow[] }) {
  const mobile = useIsMobile();
  const tasks = useTasks();
  const links = useLinks();
  const navigate = useNavigate();
  const meId = authStore.get().user?.id;
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const cfg = view.config ?? {};
  const visible = cfg.visible?.length ? cfg.visible : defaultVisibleKeys(board);
  const showSub = cfg.showSubrecords ?? true;

  const ctx = useMemo(() => viewCtx(board, tasks, links, meId, todayISO()), [meId, board, links, tasks]);

  const { rows } = useMemo(() => applyView(records, cfg, ctx), [records, cfg, ctx]);

  // Ordered flat list: parents, with children nested under when showSub.
  interface Row {
    rec: TaskRow;
    depth: number;
  }
  const flat = useMemo(() => {
    const parents = showSub ? rows.filter((r) => !r.parentId || !rows.some((x) => x.id === r.parentId)) : rows.filter((r) => !r.parentId);
    const kidsOf = (pid: string) => rows.filter((r) => String(r.parentId ?? '') === pid);
    const out: Row[] = [];
    const walk = (rs: TaskRow[], depth: number) => {
      for (const r of rs) {
        out.push({ rec: r, depth });
        if (showSub && expanded.has(r.id) && depth < 3) walk(kidsOf(r.id), depth + 1);
      }
    };
    walk(parents, 0);
    return out;
  }, [rows, showSub, expanded]);

  const windowed = flat.length > WINDOW_AT;
  const [winStart, winEnd] = useMemo(() => {
    if (!windowed) return [0, flat.length];
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 30);
    const end = Math.min(flat.length, start + Math.ceil(((containerRef.current?.clientHeight ?? 700) / ROW_H) + 60));
    return [start, end];
  }, [scrollTop, flat.length, windowed]);

  const sortBy = (key: FieldKey) => {
    const cur = cfg.sorts?.[0];
    const dir = cur?.key === key && cur.dir === 'asc' ? 'desc' : 'asc';
    void updateView(view.id, { config: { ...cfg, sorts: [{ key, dir }] } });
  };

  const widthFor = (k: FieldKey) => colWidths[k] ?? (k === 'title' ? 240 : 140);

  const resizeStart = (key: FieldKey) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widthFor(key);
    const onMove = (ev: PointerEvent) => setColWidths((w) => ({ ...w, [key]: Math.max(64, startW + ev.clientX - startX) }));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const toggleExpand = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const hasKids = useCallback((id: string) => rows.some((r) => String(r.parentId ?? '') === id), [rows]);

  /* Compact list presentation on narrow containers — same view/config. */
  if (mobile) {
    return (
      <div className="mx-auto max-w-3xl px-3 py-3">
        <div className="overflow-hidden rounded-xl border border-neutral-200/70 dark:border-neutral-800">
          {rows.map((r) => {
            const kids = subProgress(r, tasks, board);
            return (
              <button
                key={r.id}
                onClick={() => navigate(`/boards/${board.id}/views/${view.id}/records/${r.id}`)}
                className="flex w-full items-center gap-3 border-b border-neutral-100 px-3 py-3 text-left text-sm last:border-0 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
                style={{ minHeight: 44 }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{recordTitle(r)}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-neutral-400">
                    {visible
                      .filter((k) => k !== 'title')
                      .slice(0, 4)
                      .map((k) => (
                        <CellValue key={k} board={board} rec={r} keyName={k} />
                      ))}
                  </span>
                </span>
                {kids.total > 0 && <span className="text-[11px] text-neutral-400">{kids.done}/{kids.total}</span>}
                <ChevronRight size={14} className="shrink-0 text-neutral-300" />
              </button>
            );
          })}
        </div>
        <AddRow board={board} />
        {rows.length === 0 && <EmptyState icon={Table2} title="No records" body={`Add a ${isRecordsDb(board) ? 'record' : 'task'} to get started.`} />}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="h-full overflow-auto"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      role="grid"
      aria-label={`${view.name ?? 'Table'} view`}
    >
      <table className="w-full border-collapse text-sm" style={{ minWidth: 'max(100%, 480px)' }}>
        <thead className="sticky top-0 z-10 bg-white dark:bg-neutral-950">
          <tr className="border-b border-neutral-200/80 text-left dark:border-neutral-800">
            {visible.map((key, ci) => (
              <th
                key={key}
                className={cn('relative select-none px-2 py-2 text-xs font-semibold text-neutral-500 dark:text-neutral-400', ci === 0 && 'sticky left-0 z-10 bg-white dark:bg-neutral-950')}
                style={{ width: widthFor(key), minWidth: widthFor(key) }}
              >
                <button
                  className="flex w-full items-center gap-1 truncate text-left hover:text-neutral-800 dark:hover:text-neutral-200"
                  onClick={() => sortBy(key)}
                  aria-label={`Sort by ${fieldKeyLabel(board, key)}`}
                >
                  <span className="truncate">{fieldKeyLabel(board, key)}</span>
                  {cfg.sorts?.[0]?.key === key && (cfg.sorts[0].dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                </button>
                <span
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`Resize ${fieldKeyLabel(board, key)}`}
                  onPointerDown={resizeStart(key)}
                  onDoubleClick={() => setColWidths((w) => ({ ...w, [key]: key === 'title' ? 240 : 140 }))}
                  className="absolute right-0 top-0 h-full w-2 cursor-col-resize touch-none hover:bg-blue-400/40 focus:bg-blue-400/60"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowLeft') setColWidths((w) => ({ ...w, [key]: Math.max(64, widthFor(key) - 24) }));
                    if (e.key === 'ArrowRight') setColWidths((w) => ({ ...w, [key]: widthFor(key) + 24 }));
                  }}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {windowed && winStart > 0 && (
            <tr>
              <td colSpan={visible.length} style={{ height: winStart * ROW_H }} />
            </tr>
          )}
          {flat.slice(winStart, winEnd).map(({ rec, depth }) => {
            const kids = hasKids(rec.id);
            const isOpen = expanded.has(rec.id);
            return (
              <tr
                key={rec.id}
                className="group/row border-b border-neutral-100 hover:bg-neutral-50/60 dark:border-neutral-800/70 dark:hover:bg-neutral-900/40"
                onDoubleClick={() => navigate(`/boards/${board.id}/views/${view.id}/records/${rec.id}`)}
              >
                {visible.map((key, ci) => (
                  <td
                    key={key}
                    className={cn('px-1 py-0.5 align-middle', ci === 0 && 'sticky left-0 bg-white group-hover/row:bg-neutral-50 dark:bg-neutral-950 dark:group-hover/row:bg-neutral-900')}
                    style={{ width: widthFor(key), minWidth: widthFor(key), maxWidth: widthFor(key) + 80 }}
                  >
                    {ci === 0 ? (
                      <div className="flex items-center" style={{ paddingLeft: depth * 18 }}>
                        {showSub && kids ? (
                          <button
                            className="mr-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-neutral-200/70 dark:hover:bg-neutral-800"
                            onClick={() => toggleExpand(rec.id)}
                            aria-label={isOpen ? 'Collapse sub-records' : 'Expand sub-records'}
                            aria-expanded={isOpen}
                          >
                            {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          </button>
                        ) : (
                          <span className="w-6 shrink-0" />
                        )}
                        <button
                          className="mr-1 shrink-0 rounded px-0.5 text-[10px] text-neutral-300 opacity-0 transition-opacity hover:text-neutral-500 focus:opacity-100 group-hover/row:opacity-100 dark:text-neutral-600"
                          onClick={() => navigate(`/boards/${board.id}/views/${view.id}/records/${rec.id}`)}
                          aria-label="Open record detail"
                          title="Open record"
                        >
                          ⤢
                        </button>
                        <div className="min-w-0 flex-1">
                          <CellEditor board={board} rec={rec} keyName={key} />
                        </div>
                      </div>
                    ) : (
                      <CellEditor board={board} rec={rec} keyName={key} />
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
          {windowed && winEnd < flat.length && (
            <tr>
              <td colSpan={visible.length} style={{ height: (flat.length - winEnd) * ROW_H }} />
            </tr>
          )}
        </tbody>
      </table>
      <div className="sticky left-0 px-2 py-1.5">
        <AddRow board={board} />
      </div>
      {flat.length === 0 && <EmptyState icon={Table2} title="No records" body={`Add a ${isRecordsDb(board) ? 'record' : 'task'} to get started.`} />}
    </div>
  );
}

function AddRow({ board }: { board: BoardRow }) {
  const navigate = useNavigate();
  const noun = isRecordsDb(board) ? 'record' : 'task';
  return (
    <button
      className="flex items-center gap-1.5 rounded-lg px-2 py-2 text-xs text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
      style={{ minHeight: 40 }}
      onClick={async () => {
        const id = await createRecord(board.id, {});
        navigate(`/boards/${board.id}/tasks/${id}`);
      }}
    >
      <Plus size={13} /> New {noun}
    </button>
  );
}
