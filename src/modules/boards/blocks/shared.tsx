/**
 * Shared chrome for the Phase 3 dashboard blocks (§3): per-block Configure
 * popover, container-compact wrapper, database pickers, missing/loading/
 * archived states, and the RecordListSheet drill-down. Config fields live
 * directly on the block row (`databaseId`, `viewId`, `inline`, `limit`,
 * `heading`, `filters`, `agg`, `fieldKey`, `label`, `format`, `sources`,
 * `scope`) and are edited via `mutate('blocks', id, …)` — synced + undoable.
 */
import { useEffect, useMemo, useRef, useState, type ComponentType, type InputHTMLAttributes, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, Database, Settings2 } from 'lucide-react';
import { db, type LocalRow } from '../../../core/db';
import { useContainerWidth } from '../../../core/container';
import { mutate } from '../../../core/sync/engine';
import { Field, IconButton, Input, Popover, Select, Sheet, Spinner } from '../../../core/ui';
import { cn } from '../../../core/utils';
import { recordHref } from '../../../core/views/shared';
import { columnIdFor, type BoardRow, type TaskRow } from '../api';
import { stagesOf } from '../../../core/records';
import { isArchived } from '../../../../shared/archive';
import type { Filter, ViewConfig } from '../../../../shared/views';

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Boards table — `undefined` while Dexie is still loading (distinct from "missing"). */
export function useBoardsQuery(): BoardRow[] | undefined {
  return useLiveQuery(() => db.boards.toArray(), []) as BoardRow[] | undefined;
}

export function useTasksQuery(): TaskRow[] | undefined {
  return useLiveQuery(() => db.tasks.toArray(), []) as TaskRow[] | undefined;
}

/** Pickers never offer archived or deleted databases. */
export function pickableBoards(boards: readonly BoardRow[] | undefined): BoardRow[] {
  return (boards ?? []).filter((b) => !b.deleted && !isArchived(b));
}

export function saveBlockCfg(block: LocalRow, patch: Record<string, unknown>): void {
  void mutate('blocks', block.id, patch);
}

/* ---------- frame ---------- */

export function DashBlock({
  block,
  icon: Icon,
  label,
  config,
  children,
}: {
  block: LocalRow;
  icon: ComponentType<{ size?: number | string; className?: string }>;
  /** Accessible name of the block type ("Metric", "Calendar"…). */
  label: string;
  /** Configure-popover form contents (Selects/Inputs per type). */
  config: ReactNode;
  children: (compact: boolean) => ReactNode;
}) {
  const { ref, compact } = useContainerWidth<HTMLDivElement>();
  const heading = str(block.heading);
  return (
    <div ref={ref} className="rounded-xl border border-neutral-200/80 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900/40">
      <div className="flex items-center gap-1.5">
        <Icon size={13} className="shrink-0 text-neutral-300 dark:text-neutral-600" aria-hidden />
        {heading && <h3 className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">{heading}</h3>}
        <span className="flex-1" />
        <Popover
          adaptive
          align="right"
          trigger={
            <IconButton className="h-8 w-8 text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200" aria-label={`Configure ${label}`}>
              <Settings2 size={14} />
            </IconButton>
          }
        >
          {() => <div className="flex w-64 max-w-[calc(100vw-2rem)] flex-col gap-2.5 p-3 text-xs">{config}</div>}
        </Popover>
      </div>
      {children(compact)}
    </div>
  );
}

/* ---------- states ---------- */

export function BlockNotice({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'loading' }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-neutral-200 px-3 py-3 text-xs text-neutral-400 dark:border-neutral-700">
      {tone === 'loading' ? <Spinner size={13} /> : <Database size={13} />}
      {children}
    </div>
  );
}

export function DatabasePicker({
  value,
  boards,
  onChange,
}: {
  value: string;
  boards: BoardRow[];
  onChange: (id: string) => void;
}) {
  return (
    <Field label="Database">
      <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Database">
        <option value="">Pick a database…</option>
        {boards.map((b) => (
          <option key={b.id} value={b.id}>
            {String(b.icon ?? '')} {String(b.name ?? 'Board')}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export function LimitField({ value, onChange }: { value: number | undefined; onChange: (n: number | undefined) => void }) {
  return (
    <Field label="Limit">
      <DraftInput
        type="number"
        min={1}
        max={200}
        value={value === undefined ? '' : String(value)}
        placeholder="All"
        onCommit={(v) => onChange(v ? Math.max(1, Math.min(200, Number(v))) : undefined)}
        aria-label="Row limit"
      />
    </Field>
  );
}

export function HeadingField({ value, onChange }: { value: string | undefined; onChange: (v: string | undefined) => void }) {
  return (
    <Field label="Heading">
      <DraftInput value={value ?? ''} placeholder="Block title" onCommit={(v) => onChange(v || undefined)} aria-label="Block heading" />
    </Field>
  );
}

/**
 * Draft input for block-config text fields: typing is local state, the patch
 * commits on a 400ms debounce / blur — a per-keystroke `mutate()` round-trip
 * would re-render mid-word and drop characters.
 */
export function DraftInput({ value, onCommit, ...props }: { value: string; onCommit: (v: string) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [v, setV] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setV(value);
  }, [value]);
  const commit = (next: string) => {
    if (timer.current) clearTimeout(timer.current);
    dirty.current = false;
    if (next !== value) onCommit(next);
  };
  return (
    <Input
      {...props}
      value={v}
      onChange={(e) => {
        dirty.current = true;
        setV(e.target.value);
        if (timer.current) clearTimeout(timer.current);
        const next = e.target.value;
        timer.current = setTimeout(() => commit(next), 400);
      }}
      onBlur={() => commit(v)}
    />
  );
}

/* ---------- record drill-down ---------- */

/** Stage chip = colored dot + column name, matching the views' status chip language. */
export function StageChip({ rec, board }: { rec: TaskRow; board: BoardRow }) {
  const col = stagesOf(board).find((c) => c.id === columnIdFor(rec, board));
  if (!col) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 rounded-md bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: col.color }} />
      {col.name}
    </span>
  );
}

/**
 * Metric drill-down (§3): bottom sheet listing the exact aggregated `ids`.
 * Back closes; the sheet never navigated away so the page's scroll position
 * is restored untouched. Each row drills to the record route.
 */
export function RecordListSheet({ ids, board, onClose }: { ids: string[]; board: BoardRow; onClose: () => void }) {
  const navigate = useNavigate();
  const tasks = useTasksQuery();
  const byId = useMemo(() => new Map((tasks ?? []).map((t) => [t.id, t])), [tasks]);
  const rows = ids.map((id) => byId.get(id)).filter((t): t is TaskRow => !!t && !t.deleted);
  return (
    <Sheet side="bottom" onClose={onClose} label="Records">
      <div className="flex max-h-[80vh] flex-col">
        <div className="flex items-center gap-2 border-b border-neutral-100 px-3 py-2.5 dark:border-neutral-800">
          <IconButton onClick={onClose} aria-label="Back">
            <ArrowLeft size={16} />
          </IconButton>
          <span className="text-sm font-semibold">
            {rows.length} {rows.length === 1 ? 'record' : 'records'}
          </span>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {rows.map((r) => (
            <li key={r.id}>
              <button
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-neutral-100 focus-visible:bg-neutral-100 dark:hover:bg-neutral-800 dark:focus-visible:bg-neutral-800"
                onClick={() => {
                  onClose();
                  navigate(recordHref(board.id, undefined, r.id));
                }}
              >
                <span className="min-w-0 flex-1 truncate">{String(r.title ?? 'Untitled')}</span>
                <StageChip rec={r} board={board} />
              </button>
            </li>
          ))}
          {rows.length === 0 && <li className="px-3 py-4 text-center text-xs text-neutral-400">Nothing to show.</li>}
        </ul>
      </div>
    </Sheet>
  );
}

/* ---------- calendar source config (shared by block + config editor) ---------- */

export interface CalendarSource {
  databaseId: string;
  dateKey?: string;
  color?: string;
  filters?: Filter[];
}

export function blockSources(block: LocalRow): CalendarSource[] {
  const raw = block.sources;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => (s && typeof s === 'object' ? (s as Record<string, unknown>) : null))
    .filter((s): s is Record<string, unknown> => !!s && typeof s.databaseId === 'string' && !!s.databaseId)
    .map((s) => ({
      databaseId: String(s.databaseId),
      dateKey: str(s.dateKey),
      color: str(s.color),
      filters: Array.isArray(s.filters) ? (s.filters as Filter[]) : undefined,
    }));
}

/** Inline ViewConfig the view block merges over the resolved view's config. */
export function blockInline(block: LocalRow): ViewConfig | undefined {
  const raw = block.inline;
  return raw && typeof raw === 'object' ? (raw as ViewConfig) : undefined;
}

export { cn };
