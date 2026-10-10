/**
 * `calendar` dashboard block (§3): `sources[]` → a merged date→records map via
 * the shared `recordsForCalendar` planner, rendered in the existing
 * CalendarView visual language (month grid ↔ agenda). Each source's `color`
 * tints its record chips; a day click lists that day's records as links that
 * drill to the record route. Compact containers render the agenda list.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { authStore } from '../../../core/auth';
import type { LocalRow } from '../../../core/db';
import { useLinks } from '../../../core/links';
import { useStore } from '../../../core/store';
import { IconButton, Select } from '../../../core/ui';
import { cn, todayISO } from '../../../core/utils';
import { recordHref } from '../../../core/views/shared';
import { viewCtx } from '../../../core/records';
import { boardTasks, type BoardRow, type TaskRow } from '../api';
import { fieldsOf } from '../model';
import { COLUMN_COLORS } from '../model';
import { registerBlockType, type MediaBlockProps } from '../../pages/blocks/registry';
import { monthGrid, parseDateOnly } from '../../../../shared/dates';
import { recordsForCalendar } from '../../../../shared/calendarView';
import { isArchived } from '../../../../shared/archive';
import { BlockNotice, DashBlock, HeadingField, LimitField, blockSources, pickableBoards, saveBlockCfg, str, num, useBoardsQuery, useTasksQuery, type CalendarSource } from './shared';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function todayStr(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

interface CalEntry {
  rec: TaskRow;
  board: BoardRow;
  color: string;
}

/** date field options for a source's database: the builtin dueDate + date custom fields. */
function dateKeyOptions(board: BoardRow | undefined): { id: string; label: string }[] {
  const opts = [{ id: 'dueDate', label: 'Due date' }];
  for (const f of fieldsOf(board)) if (f.type === 'date') opts.push({ id: `p_${f.id}`, label: f.name });
  return opts;
}

function CalendarBlockInner({ block, compact }: { block: LocalRow; compact: boolean }) {
  const boards = useBoardsQuery();
  const tasks = useTasksQuery();
  const links = useLinks();
  const me = useStore(authStore).user?.id;
  const navigate = useNavigate();
  const [ym, setYm] = useState(() => {
    const t = parseDateOnly(todayStr());
    return t ? { y: t.y, m: t.m } : { y: 2026, m: 1 };
  });
  const [sel, setSel] = useState<string | null>(null);

  const sources = blockSources(block);
  const boardById = useMemo(() => new Map((boards ?? []).map((b) => [b.id, b])), [boards]);

  /** date → entries merged across sources. */
  const byDate = useMemo(() => {
    const out = new Map<string, CalEntry[]>();
    if (!tasks) return out;
    sources.forEach((src, i) => {
      const board = boardById.get(src.databaseId);
      if (!board || board.deleted || isArchived(board)) return;
      const ctx = viewCtx(board, tasks, links, me, todayISO());
      const rows = boardTasks(tasks, board.id).filter((t) => !t.parentId);
      const map = recordsForCalendar(rows, { dateKey: (src.dateKey as 'dueDate' | `p_${string}` | undefined) ?? 'dueDate', filters: src.filters }, ctx);
      const color = src.color ?? COLUMN_COLORS[i % COLUMN_COLORS.length];
      for (const [d, recs] of map) {
        const list = out.get(d) ?? [];
        for (const r of recs) list.push({ rec: r as TaskRow, board, color });
        out.set(d, list);
      }
    });
    return out;
  }, [sources, boardById, tasks, links, me]);

  if (sources.length === 0) return <BlockNotice>Add a source in Configure.</BlockNotice>;
  if (boards === undefined || tasks === undefined) return <BlockNotice tone="loading">Loading…</BlockNotice>;

  const cells = monthGrid(ym.y, ym.m);
  const today = todayStr();
  const move = (dir: -1 | 1) => setYm((p) => (dir === 1 ? (p.m === 12 ? { y: p.y + 1, m: 1 } : { y: p.y, m: p.m + 1 }) : p.m === 1 ? { y: p.y - 1, m: 12 } : { y: p.y, m: p.m - 1 }));
  const selEntries = sel ? (byDate.get(sel) ?? []) : [];

  const chip = (e: CalEntry) => (
    <button
      key={e.rec.id}
      className="flex w-full items-center gap-1.5 truncate rounded px-1 py-0.5 text-left text-[11px] leading-tight hover:bg-neutral-100 focus-visible:bg-neutral-100 dark:hover:bg-neutral-800 dark:focus-visible:bg-neutral-800"
      onClick={() => navigate(recordHref(e.board.id, undefined, e.rec.id))}
      title={String(e.rec.title ?? 'Untitled')}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: e.color }} />
      <span className="min-w-0 flex-1 truncate">{String(e.rec.title ?? 'Untitled')}</span>
    </button>
  );

  /* agenda mode (compact): sorted in-month days with their entries. */
  const monthDays = cells.filter((c) => c.inMonth && (byDate.get(c.date)?.length ?? 0) > 0);
  if (compact) {
    return (
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-semibold">{MONTHS[ym.m - 1]} {ym.y}</span>
          <span className="flex items-center gap-0.5">
            <IconButton className="h-7 w-7" aria-label="Previous month" onClick={() => move(-1)}><ChevronLeft size={14} /></IconButton>
            <IconButton className="h-7 w-7" aria-label="Next month" onClick={() => move(1)}><ChevronRight size={14} /></IconButton>
          </span>
        </div>
        {monthDays.length === 0 && <p className="py-3 text-center text-xs text-neutral-400">Nothing scheduled.</p>}
        <ul className="space-y-2">
          {monthDays.map((c) => (
            <li key={c.date}>
              <p className={cn('text-[10px] font-semibold uppercase tracking-wide', c.date === today ? 'text-blue-600 dark:text-blue-400' : 'text-neutral-400')}>{formatDay(c.date)}</p>
              <ul>{(byDate.get(c.date) ?? []).map(chip)}</ul>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-semibold">{MONTHS[ym.m - 1]} {ym.y}</span>
        <span className="flex items-center gap-0.5">
          <IconButton className="h-7 w-7" aria-label="Previous month" onClick={() => move(-1)}><ChevronLeft size={14} /></IconButton>
          <IconButton className="h-7 w-7" aria-label="Next month" onClick={() => move(1)}><ChevronRight size={14} /></IconButton>
        </span>
      </div>
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-neutral-200/70 bg-neutral-200/70 dark:border-neutral-800 dark:bg-neutral-800">
        {WDAYS.map((d) => (
          <div key={d} className="bg-white px-1 py-0.5 text-center text-[9px] font-semibold uppercase tracking-wide text-neutral-400 dark:bg-neutral-900">{d.slice(0, 2)}</div>
        ))}
        {cells.map((c) => {
          const entries = byDate.get(c.date) ?? [];
          return (
            <button
              key={c.date}
              className={cn(
                'flex min-h-14 flex-col items-stretch gap-0.5 bg-white p-1 text-left focus-visible:bg-neutral-50 dark:bg-neutral-900 dark:focus-visible:bg-neutral-800/70',
                !c.inMonth && 'opacity-40',
                sel === c.date && 'ring-1 ring-inset ring-blue-400',
              )}
              onClick={() => setSel(sel === c.date ? null : c.date)}
              aria-label={`${formatDay(c.date)} — ${entries.length} record${entries.length === 1 ? '' : 's'}`}
              aria-pressed={sel === c.date}
            >
              <span className={cn('w-fit rounded-full px-1 text-[10px] font-medium', c.date === today && 'bg-blue-600 text-white')}>{Number(c.date.slice(8))}</span>
              {entries.slice(0, 3).map((e) => (
                <span key={e.rec.id} className="flex items-center gap-1 truncate rounded px-0.5 text-[10px] leading-tight" style={{ borderLeft: `2px solid ${e.color}` }}>
                  <span className="truncate">{String(e.rec.title ?? 'Untitled')}</span>
                </span>
              ))}
              {entries.length > 3 && <span className="text-[9px] text-neutral-400">+{entries.length - 3} more</span>}
            </button>
          );
        })}
      </div>
      {sel && (
        <div className="mt-2 rounded-lg border border-neutral-200/70 p-2 dark:border-neutral-800">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">{formatDay(sel)}</p>
          {selEntries.length === 0 && <p className="text-xs text-neutral-400">Nothing on this day.</p>}
          <ul>{selEntries.map(chip)}</ul>
        </div>
      )}
    </div>
  );
}

function formatDay(iso: string): string {
  const p = parseDateOnly(iso);
  if (!p) return iso;
  return `${WDAYS[(new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7]} ${p.d} ${MONTHS[p.m - 1].slice(0, 3)}`;
}

function CalendarBlock({ block }: MediaBlockProps) {
  const boards = useBoardsQuery();
  const sources = blockSources(block);
  const pickers = pickableBoards(boards);
  const boardById = new Map(pickers.map((b) => [b.id, b]));

  const setSources = (next: CalendarSource[]) => saveBlockCfg(block, { sources: next.length ? next : null });
  const updateSrc = (i: number, patch: Partial<CalendarSource>) => setSources(sources.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  return (
    <DashBlock
      block={block}
      icon={CalendarDays}
      label="Calendar"
      config={
        <>
          <HeadingField value={str(block.heading)} onChange={(v) => saveBlockCfg(block, { heading: v ?? null })} />
          <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">Sources</p>
          {sources.map((src, i) => {
            const b = src.databaseId ? boardById.get(src.databaseId) : undefined;
            return (
              <div key={i} className="flex flex-col gap-1.5 rounded-lg border border-neutral-200/70 p-2 dark:border-neutral-800">
                <div className="flex items-center gap-1">
                  <Select value={src.databaseId} onChange={(e) => updateSrc(i, { databaseId: e.target.value })} className="h-8 flex-1 text-xs" aria-label={`Source ${i + 1} database`}>
                    <option value="">Pick a database…</option>
                    {pickers.map((x) => (
                      <option key={x.id} value={x.id}>
                        {String(x.icon ?? '')} {String(x.name ?? 'Board')}
                      </option>
                    ))}
                  </Select>
                  <IconButton className="h-7 w-7 text-neutral-400 hover:text-red-500" aria-label={`Remove source ${i + 1}`} onClick={() => setSources(sources.filter((_, j) => j !== i))}>
                    <Trash2 size={13} />
                  </IconButton>
                </div>
                <Select value={src.dateKey ?? 'dueDate'} onChange={(e) => updateSrc(i, { dateKey: e.target.value })} className="h-8 text-xs" aria-label={`Source ${i + 1} date field`}>
                  {dateKeyOptions(b).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </Select>
                <div className="flex items-center gap-1" role="radiogroup" aria-label={`Source ${i + 1} color`}>
                  {COLUMN_COLORS.map((c) => (
                    <button
                      key={c}
                      role="radio"
                      aria-checked={(src.color ?? COLUMN_COLORS[i % COLUMN_COLORS.length]) === c}
                      className={cn('h-4 w-4 rounded-full transition-transform', (src.color ?? COLUMN_COLORS[i % COLUMN_COLORS.length]) === c && 'ring-2 ring-neutral-900 ring-offset-1 dark:ring-white')}
                      style={{ background: c }}
                      onClick={() => updateSrc(i, { color: c })}
                      aria-label={`Color ${c}`}
                    />
                  ))}
                </div>
              </div>
            );
          })}
          <button
            className="flex items-center gap-1 rounded-md px-1.5 py-1.5 text-left text-xs text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40"
            onClick={() => setSources([...sources, { databaseId: pickers[0]?.id ?? '', dateKey: 'dueDate', color: COLUMN_COLORS[sources.length % COLUMN_COLORS.length] }])}
          >
            <Plus size={12} /> Add source
          </button>
          <LimitField value={num(block.limit)} onChange={(n) => saveBlockCfg(block, { limit: n ?? null })} />
        </>
      }
    >
      {(compact) => <CalendarBlockInner block={block} compact={compact} />}
    </DashBlock>
  );
}

registerBlockType('calendar', 'Calendar', CalendarBlock);
export default CalendarBlock;
