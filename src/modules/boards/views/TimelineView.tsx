import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { authStore } from '../../../core/auth';
import { useLinks, type DbLinkRow } from '../../../core/links';
import { useIsMobile } from '../../../core/mobile';
import { mutate } from '../../../core/sync/engine';
import { useStore } from '../../../core/store';
import { AdaptiveDialog, Button, Field, Input, Select } from '../../../core/ui';
import { cn } from '../../../core/utils';
import { recordHref } from '../../../core/views/shared';
import { groupKeyLabel, recordTitle, viewCtx, applyView } from '../../../core/records';
import { daysBetween, addDays, parseDateOnly, scaleRange, toDateOnly } from '../../../../shared/dates';
import { timelineBars, timelineConflicts, type TimelineBar } from '../../../../shared/calendarView';
import { resolveDateKey, type FieldKey } from '../../../../shared/views';
import { columnsOf, useTasks, type BoardRow, type TaskRow } from '../api';
import type { ViewRow } from '../../../core/records';

type Scale = 'week' | 'month' | 'quarter';
const DAY_W: Record<Scale, number> = { week: 64, month: 14, quarter: 4 };

function todayStr(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

const tickLabel = (scale: Scale, d: string) => {
  const p = parseDateOnly(d)!;
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][p.m - 1];
  return scale === 'week' ? `${p.d}` : scale === 'month' ? `${mon} ${p.d}` : mon;
};

async function setDates(rec: TaskRow, startKey: FieldKey, endKey: FieldKey | null, start: string, end: string | null): Promise<void> {
  const patch: Record<string, unknown> = { [startKey]: start };
  if (endKey) patch[endKey] = end;
  await mutate('tasks', rec.id, patch);
}

function BarEditor({ bar, startKey, endKey, onClose }: { bar: TimelineBar; startKey: FieldKey; endKey: FieldKey | null; onClose: () => void }) {
  const [start, setStart] = useState(bar.start);
  const [end, setEnd] = useState(bar.end);
  const dur = daysBetween(start, end);
  return (
    <AdaptiveDialog title={recordTitle(bar.record as TaskRow)} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3 px-4 pb-4 pt-1 sm:px-0 sm:pb-0">
        <Field label="Start">
          <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="End">
          <Input type="date" value={end} disabled={!endKey} onChange={(e) => setEnd(e.target.value)} />
        </Field>
      </div>
      <p className="px-4 text-xs text-[var(--muted)] sm:px-0">{dur !== null ? `${dur + 1} day${dur === 0 ? '' : 's'}` : ''}</p>
      <div className="mt-3 flex justify-end gap-2 px-4 pb-4 sm:px-0 sm:pb-0">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            void setDates(bar.record as TaskRow, startKey, endKey, start, endKey ? end : null).then(onClose);
          }}
        >
          Save
        </Button>
      </div>
    </AdaptiveDialog>
  );
}

export function TimelineView({ board, view, records }: { board: BoardRow; view: ViewRow; records: TaskRow[] }) {
  const navigate = useNavigate();
  const compact = useIsMobile();
  const tasks = useTasks();
  const links = useLinks();
  const me = useStore(authStore).user?.id;
  const today = todayStr();
  const [anchor, setAnchor] = useState(today);
  const [editBar, setEditBar] = useState<TimelineBar | null>(null);

  const cfg = view.config ?? {};
  const dateKey = resolveDateKey(cfg);
  const endKey = (cfg.endDateKey ?? null) as FieldKey | null;
  const scale: Scale = cfg.timelineScale === 'week' || cfg.timelineScale === 'quarter' ? cfg.timelineScale : 'month';
  const ctx = useMemo(() => viewCtx(board, tasks, links, me, today), [board, tasks, links, me, today]);

  const grouped = useMemo(() => applyView(records, cfg, ctx), [records, cfg, ctx]);
  const groups = grouped.groups ?? [{ key: '', rows: grouped.rows }];
  const groupBars = useMemo(() => groups.map((g) => ({ key: g.key, bars: timelineBars(g.rows, cfg, ctx) })), [groups, cfg, ctx]);

  const edges = useMemo(
    () =>
      links
        .filter((l: DbLinkRow) => !l.deleted && l.kind === 'blocks')
        .map((l) => ({ from: String(l.fromId), to: String(l.toId) })),
    [links],
  );
  const conflicts = useMemo(() => timelineConflicts(groupBars.flatMap((g) => g.bars), edges), [groupBars, edges]);

  const range = scaleRange(scale, anchor);
  const dayW = DAY_W[scale];
  const days = range ? (daysBetween(range.start, range.end) ?? 0) + 1 : 0;
  const open = (rec: TaskRow) => navigate(recordHref(board.id, view.id || undefined, rec.id));

  const shift = (n: number) => {
    const p = parseDateOnly(anchor)!;
    if (scale === 'week') setAnchor(addDays(anchor, n * 7)!);
    else if (scale === 'month') setAnchor(toDateOnly({ y: p.y + Math.floor((p.m - 1 + n) / 12), m: ((p.m - 1 + n + 1200) % 12) + 1, d: 1 }));
    else setAnchor(toDateOnly({ y: p.y + n, m: p.m, d: 1 }));
  };

  if (!range) return null;
  const x = (d: string) => (daysBetween(range.start, d) ?? 0) * dayW;

  // Flat row index for dependency arrows.
  let rowIdx = 0;
  const barPos = new Map<string, { x1: number; x2: number; y: number }>();
  const groupLayouts = groupBars.map((g) => {
    const rows = g.bars.map((b) => {
      const pos = { x1: x(b.start), x2: x(b.end) + dayW, y: rowIdx * 30 + 14 };
      barPos.set(b.id, pos);
      rowIdx += 1;
      return { bar: b, pos };
    });
    return { key: g.key, rows };
  });
  const totalH = rowIdx * 30;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200/70 px-3 py-1.5 dark:border-neutral-800/70">
        <Button size="sm" variant="ghost" onClick={() => shift(-1)} aria-label="Previous period">
          <ChevronLeft size={14} />
        </Button>
        <span className="min-w-28 text-center text-sm font-semibold">
          {range.start} → {range.end}
        </span>
        <Button size="sm" variant="ghost" onClick={() => shift(1)} aria-label="Next period">
          <ChevronRight size={14} />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setAnchor(today)}>
          Today
        </Button>
        <span className="flex-1" />
        <Select value={scale} onChange={(e) => void mutate('views', view.id, { config: { ...cfg, timelineScale: e.target.value } })} className="h-8 w-24 text-xs" aria-label="Scale" disabled={!view.id}>
          <option value="week">Week</option>
          <option value="month">Month</option>
          <option value="quarter">Quarter</option>
        </Select>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {compact ? (
          // Compact: grouped rows with inline date editors — no pointer-drag needed.
          <div>
            {groupBars.map((g) => (
              <div key={g.key || 'all'}>
                {g.key && <p className="sticky top-0 bg-neutral-50 px-3 py-1.5 text-xs font-semibold text-neutral-500 dark:bg-neutral-900">{groupKeyLabel(board, cfg.groupBy!, g.key)}</p>}
                {g.bars.map((b) => {
                  const conflict = conflicts.has(b.id);
                  return (
                    <div key={b.id} className={cn('border-b border-neutral-100 px-3 py-2 dark:border-neutral-800/60', conflict && 'border-l-2 border-l-red-500')}>
                      <button className="w-full truncate text-left text-sm" onClick={() => open(b.record as TaskRow)}>
                        {recordTitle(b.record as TaskRow)}
                      </button>
                      <div className="mt-1.5 flex items-center gap-2">
                        <Input type="date" value={b.start} className="h-7 flex-1 text-xs" aria-label="Start date" onChange={(e) => e.target.value && void setDates(b.record as TaskRow, dateKey, endKey, e.target.value, endKey ? b.end : null)} />
                        {endKey && <Input type="date" value={b.end} className="h-7 flex-1 text-xs" aria-label="End date" onChange={(e) => e.target.value && void setDates(b.record as TaskRow, dateKey, endKey, b.start, e.target.value)} />}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
            {groupBars.every((g) => !g.bars.length) && <p className="p-6 text-center text-sm text-neutral-400">No dated records in range.</p>}
          </div>
        ) : (
          <div className="relative" style={{ width: days * dayW + 160 }}>
            {/* tick header */}
            <div className="sticky top-0 z-10 flex h-8 items-end border-b border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900">
              {range.ticks.map((t) => (
                <div key={t} className="absolute border-l border-neutral-200 pb-1 pl-1 text-[10px] text-neutral-400 dark:border-neutral-800" style={{ left: x(t), height: '100%' }}>
                  {tickLabel(scale, t)}
                </div>
              ))}
              {/* today marker */}
              {daysBetween(range.start, today) !== null && daysBetween(today, range.end)! >= 0 && (
                <div className="absolute bottom-0 top-0 w-px bg-blue-500" style={{ left: x(today) + dayW / 2 }} />
              )}
            </div>
            {/* group rows */}
            <div className="relative">
              {groupLayouts.map((g) => (
                <div key={g.key || 'all'}>
                  {g.key && <p className="sticky left-0 px-2 py-1 text-[11px] font-semibold uppercase text-neutral-400">{groupKeyLabel(board, cfg.groupBy!, g.key)}</p>}
                  <div className="relative" style={{ height: g.rows.length * 30 }}>
                    {g.rows.map(({ bar, pos }) => {
                      const conflict = conflicts.has(bar.id);
                      const col = columnsOf(board).find((c) => c.id === String((bar.record as TaskRow).status ?? ''));
                      return (
                        <button
                          key={bar.id}
                          className={cn('absolute flex items-center overflow-hidden rounded-md border px-1.5 text-[11px] shadow-sm', conflict ? 'border-l-4 border-l-red-500' : 'border-neutral-200 dark:border-neutral-700', 'bg-white dark:bg-neutral-900')}
                          style={{ left: pos.x1, width: Math.max(pos.x2 - pos.x1, 10), top: pos.y - 12, height: 24 }}
                          title={`${recordTitle(bar.record as TaskRow)} · ${bar.start} → ${bar.end}${conflict ? ' · starts before its blocker ends' : ''}`}
                          onClick={() => setEditBar(bar)}
                        >
                          {col && <span className="mr-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: col.color }} />}
                          <span className="truncate">{recordTitle(bar.record as TaskRow)}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              {/* dependency arrows */}
              <svg className="pointer-events-none absolute inset-0" style={{ width: days * dayW + 160, height: totalH + 8 }}>
                <defs>
                  <marker id="tl-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M0,0 L10,5 L0,10 z" fill="#8a8a8a" />
                  </marker>
                </defs>
                {edges.map((e, i) => {
                  const a = barPos.get(e.from);
                  const b = barPos.get(e.to);
                  if (!a || !b) return null;
                  const conflict = conflicts.has(e.to);
                  return <line key={i} x1={a.x2} y1={a.y} x2={b.x1} y2={b.y} stroke={conflict ? '#e5484d' : '#8a8a8a'} strokeWidth={1.25} strokeDasharray="4 3" markerEnd="url(#tl-arrow)" />;
                })}
              </svg>
            </div>
            {groupBars.every((g) => !g.bars.length) && <p className="p-6 text-center text-sm text-neutral-400">No dated records in range.</p>}
          </div>
        )}
      </div>

      {editBar && <BarEditor bar={editBar} startKey={dateKey} endKey={endKey} onClose={() => setEditBar(null)} />}
    </div>
  );
}
