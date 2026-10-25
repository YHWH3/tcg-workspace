import {useWorkspaceLocale} from '../../../core/workspaceLocale';
import type {Weekday} from '../../../../shared/dates';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { authStore } from '../../../core/auth';
import { useStore } from '../../../core/store';
import { useLinks } from '../../../core/links';
import { useIsMobile } from '../../../core/mobile';
import { mutate } from '../../../core/sync/engine';
import { Button, Input, Popover } from '../../../core/ui';
import { cn } from '../../../core/utils';
import { recordHref } from '../../../core/views/shared';
import { recordTitle, viewCtx } from '../../../core/records';
import { monthGrid, toDateOnly, parseDateOnly } from '../../../../shared/dates';
import { recordsForCalendar, unscheduled } from '../../../../shared/calendarView';
import { resolveDateKey, type FieldKey } from '../../../../shared/views';
import { columnsOf, useTasks, type BoardRow, type TaskRow } from '../api';
import type { ViewRow } from '../../../core/records';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const fine = () => typeof window !== 'undefined' && window.matchMedia('(pointer:fine)').matches;



async function setRecordDate(rec: TaskRow, key: FieldKey, value: string | null): Promise<void> {
  await mutate('tasks', rec.id, { [key]: value });
}

function RecChip({ rec, board, onOpen }: { rec: TaskRow; board: BoardRow; onOpen: () => void }) {
  const col = columnsOf(board).find((c) => c.id === String(rec.status ?? ''));
  return (
    <button
      draggable={fine()}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/record-id', rec.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      className="flex w-full items-center gap-1 truncate rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-left text-[11px] shadow-sm hover:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900"
      title={recordTitle(rec)}
    >
      {col && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: col.color }} />}
      <span className="truncate">{recordTitle(rec)}</span>
    </button>
  );
}

/** Pick-a-date control for the unscheduled tray — a real input, no dragging needed. */
function DatePicker({ onPick }: { onPick: (d: string) => void }) {
  return (
    <Input density="compact"
      type="date"
      className="w-32"
      aria-label="Pick date"
      onChange={(e) => {
        if (e.target.value) onPick(e.target.value);
      }}
    />
  );
}

export function CalendarView({ board, view, records }: { board: BoardRow; view: ViewRow; records: TaskRow[] }) {
  const navigate = useNavigate();
  const compact = useIsMobile();
  const tasks = useTasks();
  const links = useLinks();
  const me = useStore(authStore).user?.id;
  const locale=useWorkspaceLocale(),today=locale.today,weekStart=(locale.settings?.weekStart??1) as Weekday;
  const [anchor, setAnchor] = useState(today);
  const [mode, setMode] = useState<'month' | 'agenda' | null>(null);
  const [trayOpen, setTrayOpen] = useState(false);

  const cfg = view.config ?? {};
  const dateKey = resolveDateKey(cfg);
  const ctx = useMemo(() => viewCtx(board, tasks, links, me, today), [board, tasks, links, me, today,locale.settings?.timeZone]);
  const byDay = useMemo(() => recordsForCalendar(records, cfg, ctx) as Map<string, TaskRow[]>, [records, cfg, ctx]);
  const unsched = useMemo(() => unscheduled(records, cfg, ctx) as TaskRow[], [records, cfg, ctx]);

  const a = parseDateOnly(anchor) ?? parseDateOnly(today)!;
  const cells = monthGrid(a.y, a.m, weekStart);
  const effMode = mode ?? (compact ? 'agenda' : 'month');

  const open = (rec: TaskRow) => navigate(recordHref(board.id, view.id || undefined, rec.id));
  const shiftMonth = (n: number) => {
    const p = parseDateOnly(anchor)!;
    const m0 = (p.m - 1 + n + 12 * 100) % 12;
    const y = p.y + Math.floor((p.m - 1 + n) / 12);
    setAnchor(toDateOnly({ y, m: m0 + 1, d: 1 }));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200/70 px-3 py-1.5 dark:border-neutral-800/70">
        <Button size="sm" variant="ghost" onClick={() => shiftMonth(-1)} aria-label="Previous month">
          <ChevronLeft size={14} />
        </Button>
        <span className="min-w-28 text-center text-sm font-semibold">
          {MONTHS[a.m - 1]} {a.y}
        </span>
        <Button size="sm" variant="ghost" onClick={() => shiftMonth(1)} aria-label="Next month">
          <ChevronRight size={14} />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setAnchor(today)}>
          Today
        </Button>
        <span className="flex-1" />
        <div className="flex rounded-lg border border-neutral-200 p-0.5 text-xs dark:border-neutral-700" role="tablist" aria-label="Calendar mode">
          {(['month', 'agenda'] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={effMode === m}
              className={cn('rounded-md px-2 py-1 capitalize', effMode === m ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900' : 'text-neutral-600 dark:text-neutral-400')}
              onClick={() => setMode(m)}
              style={{ minHeight: 24 }}
            >
              {m}
            </button>
          ))}
        </div>
        <Button size="sm" variant="ghost" onClick={() => setTrayOpen((v) => !v)} aria-pressed={trayOpen}>
          Unscheduled ({unsched.length})
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {effMode === 'month' ? (
          <div className="grid h-full grid-cols-7 auto-rows-fr">
            {Array.from({length:7},(_,i)=>WDAYS[(weekStart+i+6)%7]).map((d) => (
              <div key={d} className="border-b border-neutral-200/70 px-1 py-1 text-center text-[10px] font-semibold uppercase text-neutral-600 dark:text-neutral-400 dark:border-neutral-800/70">
                {d}
              </div>
            ))}
            {cells.map((cell) => {
              const recs = byDay.get(cell.date) ?? [];
              const isToday = cell.date === today;
              return (
                <div
                  key={cell.date}
                  className={cn('min-h-20 border-b border-r border-neutral-100 p-1 dark:border-neutral-800/60', !cell.inMonth && 'bg-neutral-50 dark:bg-neutral-900/40', isToday && 'bg-blue-50/50 dark:bg-blue-950/20')}
                  onDragOver={(e) => {
                    if (fine()) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    const id = e.dataTransfer.getData('text/record-id');
                    const rec = records.find((r) => r.id === id);
                    if (rec) void setRecordDate(rec, dateKey, cell.date);
                  }}
                >
                  <div className={cn('mb-0.5 text-[10px] font-medium', isToday ? 'text-blue-600 dark:text-blue-400' : 'text-neutral-600 dark:text-neutral-400')}>{Number(cell.date.slice(8))}</div>
                  <div className="grid gap-0.5">
                    {recs.slice(0, 3).map((r) => (
                      <RecChip key={r.id} rec={r} board={board} onOpen={() => open(r)} />
                    ))}
                    {recs.length > 3 && (
                      <Popover
                        trigger={
                          <button className="px-1 text-left text-[10px] text-neutral-600 dark:text-neutral-400 hover:text-neutral-600" aria-label={`${recs.length - 3} more`}>
                            +{recs.length - 3} more
                          </button>
                        }
                      >
                        {() => (
                          <div className="w-56 p-1.5">
                            {recs.slice(3).map((r) => (
                              <RecChip key={r.id} rec={r} board={board} onOpen={() => open(r)} />
                            ))}
                          </div>
                        )}
                      </Popover>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800/60">
            {cells
              .filter((c) => byDay.has(c.date))
              .map((cell) => (
                <div key={cell.date} className="px-3 py-2">
                  <p className={cn('mb-1 text-xs font-semibold', cell.date === today ? 'text-blue-600 dark:text-blue-400' : 'text-neutral-500')}>
                    {cell.date === today ? 'Today · ' : ''}
                    {cell.date}
                  </p>
                  <div className="grid gap-1">
                    {(byDay.get(cell.date) ?? []).map((r) => (
                      <button key={r.id} className="flex items-center gap-2 rounded-lg border border-neutral-200 px-2.5 py-2 text-left text-sm dark:border-neutral-800" onClick={() => open(r)} style={{ minHeight: 36 }}>
                        {recordTitle(r)}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            {byDay.size === 0 && (
              <div className="flex h-32 items-center justify-center text-sm text-neutral-600 dark:text-neutral-400">
                <Calendar size={16} className="mr-2" /> Nothing scheduled this {MONTHS[a.m - 1]}
              </div>
            )}
          </div>
        )}
      </div>

      {trayOpen && (
        <div className="max-h-44 shrink-0 overflow-y-auto border-t border-neutral-200/70 bg-neutral-50/60 p-2 dark:border-neutral-800/70 dark:bg-neutral-900/40">
          <p className="px-1 pb-1 text-[11px] font-semibold uppercase text-neutral-600 dark:text-neutral-400">Unscheduled — pick a date</p>
          {unsched.length === 0 && <p className="px-1 text-xs text-neutral-600 dark:text-neutral-400">Everything is scheduled.</p>}
          <div className="grid gap-1">
            {unsched.map((r) => (
              <div key={r.id} className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-2 py-1.5 dark:border-neutral-800 dark:bg-neutral-900">
                <button className="min-w-0 flex-1 truncate text-left text-sm" onClick={() => open(r)}>
                  {recordTitle(r)}
                </button>
                <DatePicker onPick={(d) => void setRecordDate(r, dateKey, d)} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
