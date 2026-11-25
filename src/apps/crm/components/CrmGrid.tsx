import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Columns3,
  ExternalLink,
  Filter,
  Lock,
  Plus,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import { isCrmProjectionKey, type CrmProjectionKey } from '../../../../shared/crm/projection';
import { fieldsOf, formatNumber, propKey } from '../../../../shared/fields';
import { applyView, type FieldKey, type ViewConfig } from '../../../../shared/views';
import { useLayoutMode } from '../../../core/mobile';
import {
  availableFieldKeys,
  createRecord,
  defaultVisibleKeys,
  fieldKeyLabel,
  fieldKeyOf,
  groupKeyLabel,
  implicitView,
  persistViewConfig,
  recordNoun,
  recordTitle,
  rememberView,
  resolveView,
  stagesOf,
  viewCtx,
  type ViewRow,
} from '../../../core/records';
import { mutate } from '../../../core/sync/engine';
import { Popover } from '../../../core/ui';
import { cn, todayISO } from '../../../core/utils';
import { CellEditor, CellValue } from '../../../core/views/cells';
import { workspaceCurrency } from '../../../core/workspaceLocale';
import { columnIdFor, type BoardRow, type TaskRow } from '../../../modules/boards/api';

const MAX_EVALUATED_RECORDS = 5000;
import { useCrmDatabases } from '../hooks/useCrmDatabases';
import { StatusPill, crmPaletteVar, nearestCrmPalette } from './StatusPill';

export interface CrmProjectionColumn {
  key: CrmProjectionKey;
  label: string;
  format?: 'text' | 'date';
}

export interface CrmGridProps {
  board: BoardRow;
  records: TaskRow[];
  projectionColumns?: CrmProjectionColumn[];
  selectedRecordId?: string | null;
  onSelectRecord: (recordId: string) => void;
  defaultGroupBy?: FieldKey | null;
  emptyTitle?: string;
  emptyBody?: string;
  headerActions?: React.ReactNode;
  rowActionSlot?: (rec: TaskRow) => React.ReactNode;
}

const DEFAULT_COL_WIDTH = 168;
const TITLE_COL_WIDTH = 240;

function formatProjectedCell(rec: TaskRow, col: CrmProjectionColumn): string {
  const raw = rec[col.key];
  if (raw === undefined || raw === null || raw === '') return '—';
  if (col.format === 'date' && typeof raw === 'number' && Number.isFinite(raw)) {
    try {
      return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(raw));
    } catch {
      return new Date(raw).toISOString().slice(0, 10);
    }
  }
  return String(raw);
}

function summarizeGroupColumn(
  board: BoardRow,
  rows: readonly TaskRow[],
  key: string,
): string | null {
  if (rows.length === 0) return null;
  if (key === 'title' || isCrmProjectionKey(key)) return null;
  if (key === 'status') {
    const cols = stagesOf(board);
    if (!cols.length) return null;
    const counts = new Map<string, number>();
    for (const r of rows) {
      const cid = columnIdFor(r, board);
      counts.set(cid, (counts.get(cid) ?? 0) + 1);
    }
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([cid, n]) => `${n} ${cols.find((c) => c.id === cid)?.name ?? cid}`);
    return top.length ? top.join(' · ') : null;
  }
  if (key.startsWith('p_')) {
    const field = fieldsOf(board).find((f) => f.id === key.slice(2));
    if (!field) return null;
    if (field.type === 'number') {
      let sum = 0;
      let count = 0;
      for (const r of rows) {
        const val = r[key];
        if (typeof val === 'number' && Number.isFinite(val)) {
          sum += val;
          count += 1;
        }
      }
      if (!count) return null;
      return `Sum ${formatNumber(sum, field, workspaceCurrency())}`;
    }
    if (field.type === 'select') {
      const counts = new Map<string, number>();
      for (const r of rows) {
        const val = r[key];
        if (typeof val === 'string' && val) counts.set(val, (counts.get(val) ?? 0) + 1);
      }
      const top = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([oid, n]) => `${n} ${field.options?.find((o) => o.id === oid)?.name ?? oid}`);
      return top.length ? top.join(' · ') : null;
    }
  }
  return null;
}

function groupAccentPalette(board: BoardRow, groupBy: FieldKey | null | undefined, groupKey: string, idx: number) {
  if (!groupKey) return 'stone' as const;
  if (groupBy === 'status') {
    const col = stagesOf(board).find((c) => c.id === groupKey);
    if (col) return nearestCrmPalette(col.color);
  }
  if (groupBy && groupBy.startsWith('p_')) {
    const field = fieldsOf(board).find((f) => f.id === groupBy.slice(2));
    const opt = field?.options?.find((o) => o.id === groupKey);
    if (opt) return nearestCrmPalette(opt.color);
  }
  const cycle = ['river', 'leaf', 'dusk', 'clay', 'ochre', 'teal', 'berry'] as const;
  return cycle[idx % cycle.length]!;
}

export function CrmGrid({
  board,
  records,
  projectionColumns = [],
  selectedRecordId,
  onSelectRecord,
  defaultGroupBy = null,
  emptyTitle,
  emptyBody,
  headerActions,
  rowActionSlot,
}: CrmGridProps) {
  const layout = useLayoutMode();
  const isCompact = layout === 'compact';
  const { views, tasks, links } = useCrmDatabases();
  const noun = recordNoun(board);
  const cols = stagesOf(board);
  const boardViews = useMemo(
    () => views.filter((v) => v.databaseId === board.id),
    [views, board.id],
  );
  const [selectedViewId, setSelectedViewId] = useState<string | undefined>(undefined);
  const activeView: ViewRow = useMemo(
    () => resolveView(board, boardViews, selectedViewId),
    [board, boardViews, selectedViewId],
  );
  const cfg = useMemo<ViewConfig>(
    () => ({
      ...(activeView.config ?? {}),
      ...(activeView.config?.groupBy === undefined && defaultGroupBy !== null
        ? { groupBy: defaultGroupBy }
        : {}),
    }),
    [activeView.config, defaultGroupBy],
  );

  const [searchText, setSearchText] = useState('');
  const [projectionHintKey, setProjectionHintKey] = useState<string | null>(null);
  const [quickAddDrafts, setQuickAddDrafts] = useState<Record<string, string>>({});
  const [creatingGroup, setCreatingGroup] = useState<string | null>(null);
  const [localWidths, setLocalWidths] = useState<Record<string, number>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const searchId = useId();

  useEffect(() => {
    setLocalWidths({});
  }, [activeView.id]);

  const ctx = useMemo(
    () => viewCtx(board, tasks, links, undefined, todayISO()),
    [board, tasks, links],
  );

  const effectiveCfg: ViewConfig = useMemo(() => {
    if (!searchText.trim()) return cfg;
    const filters = [...(cfg.filters ?? []), { key: 'title' as FieldKey, op: 'contains' as const, value: searchText.trim() }];
    return { ...cfg, filters };
  }, [cfg, searchText]);

  const evaluated = useMemo(() => applyView(records, effectiveCfg, ctx), [records, effectiveCfg, ctx]);

  const allAvailKeys = useMemo(() => availableFieldKeys(board), [board]);
  const visibleDataKeys: FieldKey[] = useMemo(() => {
    const base = cfg.visible?.length ? cfg.visible : defaultVisibleKeys(board);
    return base.filter((k) => allAvailKeys.includes(k));
  }, [cfg.visible, board, allAvailKeys]);

  // Display order: title first, then configured visible columns, then projection columns.
  const orderedCols = useMemo(() => {
    const rest = visibleDataKeys.filter((k) => k !== 'title');
    const dataCols: { kind: 'data'; key: FieldKey; label: string }[] = [
      { kind: 'data', key: 'title', label: fieldKeyLabel(board, 'title') },
      ...rest.map((k) => ({ kind: 'data' as const, key: k, label: fieldKeyLabel(board, k) })),
    ];
    const projCols = projectionColumns.map((p) => ({ kind: 'projection' as const, col: p, key: p.key, label: p.label }));
    return [...dataCols, ...projCols];
  }, [visibleDataKeys, board, projectionColumns]);

  const groups = useMemo(() => {
    if (evaluated.groups && evaluated.groups.length > 0) {
      return evaluated.groups;
    }
    return [{ key: '', rows: evaluated.rows }];
  }, [evaluated]);

  const collapsedSet = useMemo(() => new Set(cfg.collapsedGroups ?? []), [cfg.collapsedGroups]);

  const persistPatch = (patch: Partial<ViewConfig>) => {
    const nextCfg: ViewConfig = { ...cfg, ...patch };
    void persistViewConfig(board, activeView.id ? activeView : implicitView(board), nextCfg).then((newId) => {
      if (newId && newId !== activeView.id) {
        rememberView(board.id, newId);
        setSelectedViewId(newId);
      }
    });
  };

  const toggleGroupCollapse = (groupKey: string) => {
    const next = new Set(collapsedSet);
    if (next.has(groupKey)) next.delete(groupKey);
    else next.add(groupKey);
    persistPatch({ collapsedGroups: [...next] });
  };

  const widthFor = (key: string) =>
    localWidths[key] ??
    cfg.columnWidths?.[key] ??
    (key === 'title' ? TITLE_COL_WIDTH : key.includes('email') ? 210 : DEFAULT_COL_WIDTH);

  const commitWidth = (key: string, px: number) => {
    const clamped = Math.min(600, Math.max(96, Math.round(px)));
    setLocalWidths((prev) => ({ ...prev, [key]: clamped }));
    persistPatch({ columnWidths: { ...(cfg.columnWidths ?? {}), [key]: clamped } });
  };

  const startResize = (key: string) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widthFor(key);
    let latest = startW;
    const onMove = (ev: PointerEvent) => {
      latest = Math.min(600, Math.max(96, Math.round(startW + ev.clientX - startX)));
      setLocalWidths((prev) => ({ ...prev, [key]: latest }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      commitWidth(key, latest);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const toggleVisibleCol = (key: FieldKey) => {
    if (key === 'title') return;
    const current = [...visibleDataKeys];
    const next = current.includes(key)
      ? current.filter((k) => k !== key)
      : [...current, key];
    persistPatch({ visible: next });
  };

  const moveVisibleCol = (key: FieldKey, dir: -1 | 1) => {
    if (key === 'title') return;
    const rest = visibleDataKeys.filter((k) => k !== 'title');
    const idx = rest.indexOf(key);
    const swap = idx + dir;
    if (idx < 0 || swap < 0 || swap >= rest.length) return;
    const next = [...rest];
    const tmp = next[idx]!;
    next[idx] = next[swap]!;
    next[swap] = tmp;
    persistPatch({ visible: ['title', ...next] });
  };

  const groupableKeys: FieldKey[] = useMemo(() => {
    const list: FieldKey[] = [];
    if (cols.length > 0) list.push('status');
    for (const f of fieldsOf(board)) {
      if (f.type === 'select' || f.type === 'person' || f.type === 'relation') {
        list.push(fieldKeyOf(f));
      }
    }
    return list;
  }, [board, cols.length]);

  const handleQuickAdd = async (groupKey: string) => {
    if (creatingGroup === groupKey) return;
    const title = (quickAddDrafts[groupKey] ?? '').trim() || `New ${noun.toLowerCase()}`;
    setCreatingGroup(groupKey);
    try {
      const groupBy = cfg.groupBy;
      const extra: Record<string, unknown> = {};
      let statusOverride: string | null | undefined = undefined;
      if (groupBy === 'status' && groupKey && cols.some((c) => c.id === groupKey)) {
        statusOverride = groupKey;
      } else if (groupBy?.startsWith('p_') && groupKey) {
        const fid = groupBy.slice(2);
        const f = fieldsOf(board).find((x) => x.id === fid);
        if (f?.type === 'multi_select') extra[propKey(fid)] = [groupKey];
        else extra[propKey(fid)] = groupKey;
      }
      const newId = await createRecord(board.id, { title, status: statusOverride, extra });
      setQuickAddDrafts((prev) => ({ ...prev, [groupKey]: '' }));
      onSelectRecord(newId);
    } finally {
      setCreatingGroup(null);
    }
  };

  const moveGridFocus = (currentEl: HTMLElement, rowDelta: number, colDelta: number) => {
    const root = gridContainerRef.current;
    if (!root) return;
    const cells = [...root.querySelectorAll<HTMLElement>('[data-grid-cell="1"]')];
    const r = Number(currentEl.dataset.gridRow);
    const c = Number(currentEl.dataset.gridCol);
    if (!Number.isFinite(r) || !Number.isFinite(c)) return;
    const target = cells.find(
      (el) => Number(el.dataset.gridRow) === r + rowDelta && Number(el.dataset.gridCol) === c + colDelta,
    );
    target?.focus();
  };

  const ceilingReached = records.length >= MAX_EVALUATED_RECORDS;

  let runningRowIdx = 0;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* Saved view bar + toolbar */}
      <div className="crm-panel flex flex-col gap-3 p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="tablist" aria-label="Saved views">
            {(boardViews.length ? boardViews : [activeView]).map((v) => {
              const isSelected = (v.id || '') === (activeView.id || '');
              return (
                <button
                  key={v.id || 'default'}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  onClick={() => {
                    rememberView(board.id, v.id || null);
                    setSelectedViewId(v.id || undefined);
                  }}
                  className={cn(
                    'inline-flex min-h-11 items-center rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
                    isSelected
                      ? 'bg-[var(--crm-primary)] text-[var(--crm-primary-contrast)]'
                      : 'text-[var(--crm-text-muted)] hover:bg-[var(--crm-surface-2)] hover:text-[var(--crm-text)]',
                  )}
                >
                  {v.name}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {headerActions}
            <button
              type="button"
              className="crm-btn-primary"
              onClick={() => void handleQuickAdd('__top__')}
            >
              <Plus size={15} aria-hidden="true" />
              <span>Add {noun.toLowerCase()}</span>
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--crm-border)] pt-2.5">
          <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
            <Search
              size={14}
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--crm-text-muted)]"
            />
            <label htmlFor={searchId} className="sr-only">
              Filter {String(board.name ?? noun)}
            </label>
            <input
              id={searchId}
              type="search"
              className="crm-input !min-h-11 !pl-9 !text-xs"
              placeholder={`Search ${String(board.name ?? noun).toLowerCase()}…`}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
            />
          </div>

          {groupableKeys.length > 0 && (
            <div className="flex items-center gap-1.5">
              <SlidersHorizontal size={14} aria-hidden="true" className="text-[var(--crm-text-muted)]" />
              <label htmlFor={`${searchId}-group`} className="sr-only">
                Group by
              </label>
              <select
                id={`${searchId}-group`}
                aria-label="Group by"
                className="crm-select !min-h-11 !w-auto !py-1.5 !text-xs"
                value={cfg.groupBy ?? ''}
                onChange={(e) => persistPatch({ groupBy: (e.target.value || null) as FieldKey | null })}
              >
                <option value="">No grouping</option>
                {groupableKeys.map((k) => (
                  <option key={k} value={k}>
                    Group: {fieldKeyLabel(board, k)}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <Filter size={14} aria-hidden="true" className="text-[var(--crm-text-muted)]" />
            <label htmlFor={`${searchId}-sort`} className="sr-only">
              Sort by
            </label>
            <select
              id={`${searchId}-sort`}
              aria-label="Sort by"
              className="crm-select !min-h-11 !w-auto !py-1.5 !text-xs"
              value={cfg.sorts?.[0] ? `${cfg.sorts[0].key}:${cfg.sorts[0].dir}` : ''}
              onChange={(e) => {
                if (!e.target.value) {
                  persistPatch({ sorts: [] });
                  return;
                }
                const [k, d] = e.target.value.split(':') as [FieldKey, 'asc' | 'desc'];
                persistPatch({ sorts: [{ key: k, dir: d }] });
              }}
            >
              <option value="">Default order</option>
              <option value="title:asc">Name (A–Z)</option>
              <option value="title:desc">Name (Z–A)</option>
              <option value="createdAt:desc">Newest first</option>
              {visibleDataKeys
                .filter((k) => k !== 'title')
                .slice(0, 5)
                .map((k) => (
                  <option key={k} value={`${k}:asc`}>
                    {fieldKeyLabel(board, k)} (A–Z)
                  </option>
                ))}
            </select>
          </div>

          <Popover
            adaptive
            align="right"
            label="Columns and order"
            trigger={
              <button type="button" className="crm-btn-secondary !text-xs">
                <Columns3 size={14} aria-hidden="true" />
                <span>Columns ({visibleDataKeys.length})</span>
              </button>
            }
          >
            {() => (
              <div className="w-72 space-y-2 p-2 text-xs">
                <p className="font-semibold text-[var(--crm-text)]">Show and reorder columns</p>
                <p className="text-[11px] text-[var(--crm-text-muted)]">
                  Saved to this view ({activeView.name}).
                </p>
                <ul className="max-h-72 space-y-1 overflow-y-auto">
                  {allAvailKeys.map((k) => {
                    const isTitle = k === 'title';
                    const checked = visibleDataKeys.includes(k);
                    const rest = visibleDataKeys.filter((x) => x !== 'title') as FieldKey[];
                    const pos = rest.indexOf(k);
                    return (
                      <li
                        key={k}
                        className="flex items-center justify-between gap-2 rounded px-1.5 py-1 hover:bg-[var(--crm-surface-2)]"
                      >
                        <label className="flex min-h-9 flex-1 cursor-pointer items-center gap-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={isTitle}
                            onChange={() => toggleVisibleCol(k)}
                          />
                          <span className="truncate font-medium">{fieldKeyLabel(board, k)}</span>
                        </label>
                        {checked && !isTitle && (
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              aria-label={`Move ${fieldKeyLabel(board, k)} left`}
                              disabled={pos <= 0}
                              onClick={() => moveVisibleCol(k, -1)}
                              className="inline-flex h-8 w-8 items-center justify-center rounded border border-[var(--crm-border)] disabled:opacity-40"
                            >
                              <ArrowLeft size={12} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              aria-label={`Move ${fieldKeyLabel(board, k)} right`}
                              disabled={pos < 0 || pos >= rest.length - 1}
                              onClick={() => moveVisibleCol(k, 1)}
                              className="inline-flex h-8 w-8 items-center justify-center rounded border border-[var(--crm-border)] disabled:opacity-40"
                            >
                              <ArrowRight size={12} aria-hidden="true" />
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </Popover>
        </div>
      </div>

      {ceilingReached && (
        <div
          role="status"
          className="rounded-lg border px-4 py-2.5 text-xs font-medium"
          style={{
            backgroundColor: 'var(--crm-warn-bg)',
            color: 'var(--crm-warn-text)',
            borderColor: 'var(--crm-warn-border)',
          }}
        >
          Showing up to {MAX_EVALUATED_RECORDS} evaluated records for this view. Refine filters to inspect older rows.
        </div>
      )}

      {projectionHintKey && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--crm-border)] bg-[var(--crm-surface)] px-4 py-2.5 text-xs"
        >
          <span>
            <strong className="font-semibold">{projectionColumns.find((p) => p.key === projectionHintKey)?.label ?? projectionHintKey}</strong>{' '}
            is a server-owned CRM projection updated automatically by verified CRM actions and cannot be edited directly.
          </span>
          <button
            type="button"
            className="crm-btn-secondary !min-h-9 !px-2.5 !py-1 !text-xs"
            onClick={() => setProjectionHintKey(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {evaluated.rows.length === 0 ? (
        <div className="crm-panel p-6 text-center">
          <p className="text-sm font-semibold">{emptyTitle ?? `No ${noun.toLowerCase()}s match this view`}</p>
          <p className="mt-1 text-xs text-[var(--crm-text-muted)]">
            {emptyBody ?? `Create a new ${noun.toLowerCase()} or clear filters to see records.`}
          </p>
          <div className="mt-4">
            <button
              type="button"
              className="crm-btn-primary"
              onClick={() => void handleQuickAdd('__empty__')}
            >
              <Plus size={15} aria-hidden="true" />
              <span>Add {noun.toLowerCase()}</span>
            </button>
          </div>
        </div>
      ) : isCompact ? (
        /* Purpose-built mobile cards in collapsible groups */
        <div className="space-y-4">
          {groups.map((grp, gIdx) => {
            const gLabel = cfg.groupBy
              ? groupKeyLabel(board, cfg.groupBy, grp.key)
              : String(board.name ?? noun);
            const collapsed = collapsedSet.has(grp.key);
            const accent = crmPaletteVar(groupAccentPalette(board, cfg.groupBy, grp.key, gIdx));
            return (
              <section
                key={grp.key || 'all'}
                className="crm-panel overflow-hidden"
                style={{ borderLeft: `4px solid ${accent}` }}
              >
                <button
                  type="button"
                  aria-expanded={!collapsed}
                  onClick={() => toggleGroupCollapse(grp.key)}
                  className="flex min-h-11 w-full items-center justify-between gap-2 bg-[var(--crm-surface-2)] px-3.5 py-2 text-left text-sm font-semibold"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    {collapsed ? <ChevronRight size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
                    <span className="truncate">{gLabel}</span>
                  </span>
                  <span className="crm-tabular rounded-full border border-[var(--crm-border)] bg-[var(--crm-surface)] px-2 py-0.5 text-xs text-[var(--crm-text-muted)]">
                    {grp.rows.length}
                  </span>
                </button>

                {!collapsed && (
                  <ul className="divide-y divide-[var(--crm-border)]">
                    {grp.rows.map((rec) => {
                      const typed = rec as TaskRow;
                      const col = cols.length ? cols.find((c) => c.id === columnIdFor(typed, board)) : undefined;
                      const active = selectedRecordId === typed.id;
                      const chipKeys = visibleDataKeys.filter((k) => k !== 'title' && k !== 'status').slice(0, 3);
                      return (
                        <li
                          key={typed.id}
                          className={cn(
                            'p-3',
                            active && 'bg-[var(--crm-primary-soft)]',
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <button
                              type="button"
                              onClick={() => onSelectRecord(typed.id)}
                              className="min-h-11 min-w-0 flex-1 text-left"
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-semibold break-words">
                                  {recordTitle(typed)}
                                </span>
                                {col && <StatusPill label={col.name} color={col.color} />}
                              </div>
                              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-[var(--crm-text-muted)]">
                                {chipKeys.map((k) => (
                                  <span key={k} className="inline-flex items-center gap-1">
                                    <CellValue board={board} rec={typed} keyName={k} />
                                  </span>
                                ))}
                                {projectionColumns.slice(0, 1).map((p) => {
                                  const v = formatProjectedCell(typed, p);
                                  if (v === '—') return null;
                                  return (
                                    <span
                                      key={p.key}
                                      className="inline-flex items-center gap-1 rounded border border-[var(--crm-border)] bg-[var(--crm-bg)] px-1.5 py-0.5 text-[11px]"
                                    >
                                      <Lock size={10} aria-hidden="true" />
                                      <span>{v}</span>
                                    </span>
                                  );
                                })}
                              </div>
                            </button>
                            {rowActionSlot && <div className="shrink-0">{rowActionSlot(typed)}</div>}
                          </div>
                        </li>
                      );
                    })}
                    <li className="p-2.5">
                      <button
                        type="button"
                        className="crm-btn-secondary w-full !justify-start !text-xs"
                        onClick={() => void handleQuickAdd(grp.key)}
                      >
                        <Plus size={14} aria-hidden="true" />
                        <span>Add {noun.toLowerCase()} here</span>
                      </button>
                    </li>
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        /* Desktop / Tablet ARIA grid with collapsible coloured groups, sticky first col & persisted resize */
        <div ref={gridContainerRef} className="min-w-0 w-full max-w-full space-y-4">
          {groups.map((grp, gIdx) => {
            const gLabel = cfg.groupBy
              ? groupKeyLabel(board, cfg.groupBy, grp.key)
              : String(board.name ?? noun);
            const collapsed = collapsedSet.has(grp.key);
            const accent = crmPaletteVar(groupAccentPalette(board, cfg.groupBy, grp.key, gIdx));
            const sortSpec = cfg.sorts?.[0];

            return (
              <section
                key={grp.key || 'all'}
                className="crm-panel relative min-w-0 w-full max-w-full overflow-hidden"
                style={{ borderLeft: `4px solid ${accent}` }}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 bg-[var(--crm-surface-2)] px-3.5 py-2">
                  <button
                    type="button"
                    aria-expanded={!collapsed}
                    onClick={() => toggleGroupCollapse(grp.key)}
                    className="inline-flex min-h-9 items-center gap-2 text-sm font-semibold text-[var(--crm-text)]"
                  >
                    {collapsed ? <ChevronRight size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
                    <span>{gLabel}</span>
                    <span className="crm-tabular rounded-full border border-[var(--crm-border)] bg-[var(--crm-surface)] px-2 py-0.5 text-xs font-medium text-[var(--crm-text-muted)]">
                      {grp.rows.length}
                    </span>
                  </button>

                  {!collapsed && (
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--crm-text-muted)]">
                      {orderedCols
                        .filter((c) => c.kind === 'data')
                        .slice(1, 4)
                        .map((c) => {
                          const summary = summarizeGroupColumn(board, grp.rows as TaskRow[], c.key);
                          if (!summary) return null;
                          return (
                            <span
                              key={c.key}
                              className="rounded border border-[var(--crm-border)] bg-[var(--crm-surface)] px-2 py-0.5 font-medium"
                            >
                              {c.label}: {summary}
                            </span>
                          );
                        })}
                    </div>
                  )}
                </div>

                {!collapsed && (
                  <div
                    role="region"
                    aria-label={`${String(board.name ?? noun)} — ${gLabel}`}
                    tabIndex={0}
                    className="w-full max-w-full overflow-x-auto"
                  >
                    <table
                      role="grid"
                      aria-label={`${String(board.name ?? noun)} — ${gLabel}`}
                      className="crm-table w-full"
                    >
                      <thead>
                        <tr>
                          <th scope="col" className="crm-sticky-col !w-10 !px-2">
                            <span className="sr-only">Select</span>
                          </th>
                          {orderedCols.map((col, cIdx) => {
                            const w = widthFor(col.key);
                            const isProjection = col.kind === 'projection';
                            const isSorted = col.kind === 'data' && sortSpec?.key === col.key;
                            return (
                              <th
                                key={col.key}
                                scope="col"
                                style={{ width: w, minWidth: w }}
                                className={cn('relative select-none', cIdx === 0 && 'crm-sticky-col !left-10')}
                              >
                                <div className="flex items-center justify-between gap-1 pr-2">
                                  {isProjection ? (
                                    <button
                                      type="button"
                                      onClick={() => setProjectionHintKey(col.key)}
                                      className="inline-flex min-h-8 items-center gap-1 text-left text-xs font-semibold text-[var(--crm-text-muted)] hover:text-[var(--crm-text)]"
                                      title="Server-owned CRM projection (read-only)"
                                    >
                                      <Lock size={11} aria-hidden="true" />
                                      <span className="truncate">{col.label}</span>
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const dir =
                                          sortSpec?.key === col.key && sortSpec.dir === 'asc'
                                            ? 'desc'
                                            : 'asc';
                                        persistPatch({ sorts: [{ key: col.key as FieldKey, dir }] });
                                      }}
                                      aria-label={`Sort by ${col.label}`}
                                      className="inline-flex min-h-8 items-center gap-1 truncate text-left text-xs font-semibold text-[var(--crm-text-muted)] hover:text-[var(--crm-text)]"
                                    >
                                      <span className="truncate">{col.label}</span>
                                      {isSorted &&
                                        (sortSpec.dir === 'asc' ? (
                                          <ArrowUp size={11} aria-hidden="true" />
                                        ) : (
                                          <ArrowDown size={11} aria-hidden="true" />
                                        ))}
                                    </button>
                                  )}
                                </div>
                                <span
                                  role="separator"
                                  aria-orientation="vertical"
                                  aria-label={`Resize ${col.label}`}
                                  aria-valuenow={w}
                                  aria-valuemin={96}
                                  aria-valuemax={600}
                                  tabIndex={0}
                                  onPointerDown={startResize(col.key)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'ArrowLeft') commitWidth(col.key, w - 20);
                                    if (e.key === 'ArrowRight') commitWidth(col.key, w + 20);
                                  }}
                                  className="absolute right-0 top-0 h-full w-2 cursor-col-resize touch-none hover:bg-[var(--crm-primary)]/40"
                                />
                              </th>
                            );
                          })}
                          <th scope="col" className="w-24">
                            <span className="sr-only">Actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {grp.rows.map((rawRec) => {
                          const rec = rawRec as TaskRow;
                          const rowIndex = runningRowIdx++;
                          const isSelectedRow = selectedRecordId === rec.id;
                          const isChecked = selectedIds.has(rec.id);

                          return (
                            <tr
                              key={rec.id}
                              className={cn(isSelectedRow && 'bg-[var(--crm-primary-soft)]')}
                            >
                              <td className="crm-sticky-col !w-10 !px-2">
                                <input
                                  type="checkbox"
                                  aria-label={`Select ${recordTitle(rec)}`}
                                  checked={isChecked}
                                  onChange={(e) => {
                                    setSelectedIds((prev) => {
                                      const next = new Set(prev);
                                      if (e.target.checked) next.add(rec.id);
                                      else next.delete(rec.id);
                                      return next;
                                    });
                                  }}
                                />
                              </td>
                              {orderedCols.map((col, cIdx) => {
                                const w = widthFor(col.key);
                                const isFirst = cIdx === 0;
                                const isStage = col.kind === 'data' && col.key === 'status' && cols.length > 0;
                                return (
                                  <td
                                    key={col.key}
                                    data-grid-cell="1"
                                    data-grid-row={rowIndex}
                                    data-grid-col={cIdx}
                                    tabIndex={-1}
                                    style={{ width: w, minWidth: w, maxWidth: w + 80 }}
                                    className={cn(
                                      isFirst && 'crm-sticky-col !left-10',
                                      '!py-1.5 !px-2 align-middle outline-none focus:ring-2 focus:ring-inset focus:ring-[var(--crm-primary)]',
                                    )}
                                    onKeyDown={(e) => {
                                      const targetTag = (e.target as HTMLElement).tagName;
                                      const inInput = targetTag === 'INPUT' || targetTag === 'SELECT' || targetTag === 'TEXTAREA';
                                      if (inInput) return;
                                      if (e.key === 'ArrowDown') {
                                        e.preventDefault();
                                        moveGridFocus(e.currentTarget, 1, 0);
                                      } else if (e.key === 'ArrowUp') {
                                        e.preventDefault();
                                        moveGridFocus(e.currentTarget, -1, 0);
                                      } else if (e.key === 'ArrowRight') {
                                        e.preventDefault();
                                        moveGridFocus(e.currentTarget, 0, 1);
                                      } else if (e.key === 'ArrowLeft') {
                                        e.preventDefault();
                                        moveGridFocus(e.currentTarget, 0, -1);
                                      } else if (e.key === ' ') {
                                        e.preventDefault();
                                        onSelectRecord(rec.id);
                                      } else if (e.key === 'x' || e.key === 'X') {
                                        e.preventDefault();
                                        setSelectedIds((prev) => {
                                          const next = new Set(prev);
                                          if (next.has(rec.id)) next.delete(rec.id);
                                          else next.add(rec.id);
                                          return next;
                                        });
                                      } else if (e.key === 'Enter') {
                                        const focusable = e.currentTarget.querySelector<HTMLElement>('input,select,button');
                                        if (focusable) {
                                          e.preventDefault();
                                          focusable.focus();
                                        }
                                      }
                                    }}
                                  >
                                    {col.kind === 'projection' ? (
                                      <button
                                        type="button"
                                        onClick={() => setProjectionHintKey(col.key)}
                                        className="inline-flex min-h-8 w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-xs text-[var(--crm-text-muted)] hover:bg-[var(--crm-surface-2)]"
                                      >
                                        <Lock size={11} aria-hidden="true" className="shrink-0" />
                                        <span className="truncate">{formatProjectedCell(rec, col.col)}</span>
                                      </button>
                                    ) : isStage ? (
                                      <div className="relative">
                                        <select
                                          aria-label={`Stage for ${recordTitle(rec)}`}
                                          value={columnIdFor(rec, board)}
                                          onChange={(e) => void mutate('tasks', rec.id, { status: e.target.value })}
                                          className="crm-select !min-h-8 !py-1 !text-xs font-semibold"
                                        >
                                          {cols.map((stage) => (
                                            <option key={stage.id} value={stage.id}>
                                              {stage.name}
                                            </option>
                                          ))}
                                        </select>
                                      </div>
                                    ) : (
                                      <CellEditor board={board} rec={rec} keyName={col.key} />
                                    )}
                                  </td>
                                );
                              })}
                              <td className="!px-2 !py-1.5">
                                <div className="flex items-center justify-end gap-1">
                                  <button
                                    type="button"
                                    onClick={() => onSelectRecord(rec.id)}
                                    className="crm-btn-secondary !min-h-8 !px-2.5 !py-1 !text-xs"
                                  >
                                    Open
                                  </button>
                                  <Link
                                    to={`/boards/${board.id}/tasks/${rec.id}`}
                                    aria-label={`Open ${recordTitle(rec)} in Workspace`}
                                    title="Open in Workspace"
                                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--crm-text-muted)] hover:bg-[var(--crm-surface-2)] hover:text-[var(--crm-text)]"
                                  >
                                    <ExternalLink size={13} aria-hidden="true" />
                                  </Link>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                        <tr>
                          <td colSpan={orderedCols.length + 2} className="!px-3 !py-2">
                            <form
                              onSubmit={(e) => {
                                e.preventDefault();
                                void handleQuickAdd(grp.key);
                              }}
                              className="flex items-center gap-2"
                            >
                              <input
                                type="text"
                                className="crm-input !min-h-9 !max-w-xs !text-xs"
                                placeholder={`+ Add ${noun.toLowerCase()} to ${gLabel}…`}
                                aria-label={`Add ${noun.toLowerCase()} to ${gLabel}`}
                                value={quickAddDrafts[grp.key] ?? ''}
                                onChange={(e) =>
                                  setQuickAddDrafts((prev) => ({ ...prev, [grp.key]: e.target.value }))
                                }
                              />
                              <button
                                type="submit"
                                disabled={creatingGroup === grp.key}
                                className="crm-btn-secondary !min-h-9 !px-3 !py-1 !text-xs"
                              >
                                Add
                              </button>
                            </form>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
