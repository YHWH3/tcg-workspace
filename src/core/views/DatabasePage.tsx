/**
 * DatabasePage — the Phase 1 database shell: view tabs, view config toolbar
 * (filter/sort/group/props/mine), new-view menu, new-record button, and the
 * record detail panel. Mounted inside Shell via a nested <Routes> — app
 * route paths stay unchanged (/boards/:id[/tasks/:id] plus /views/:viewId).
 *
 * BoardOrDb dispatches /boards/:boardId[/tasks/:taskId] between the legacy
 * BoardPage (kind 'tasks', unchanged UX) and this shell (kind 'records',
 * or when a database has views).
 */
import { useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { ArrowUpDown, Filter, Image as ImageIcon, KanbanSquare, List, MoreHorizontal, Pencil, Plus, Table2, Trash2, Users } from 'lucide-react';
import { authStore } from '../auth';
import { useIsMobile } from '../mobile';
import { PresenceStack } from '../presence';
import { useStore } from '../store';
import { mutate } from '../sync/engine';
import { Button, Dialog, Popover, Select, Sheet } from '../ui';
import { cn } from '../utils';
import { Board } from '../../modules/boards/Board';
import { BoardPage } from '../../modules/boards/BoardPage';
import { FieldsEditor } from '../../modules/boards/FieldsEditor';
import { useBoard, useTasks, boardTasks, deleteBoard, type BoardRow } from '../../modules/boards/api';
import {
  availableFieldKeys,
  createRecord,
  createView,
  defaultVisibleKeys,
  deleteView,
  fieldKeyLabel,
  isRecordsDb,
  persistViewConfig,
  recordNoun,
  rememberView,
  resolveView,
  stagesOf,
  updateView,
  useDbRecords,
  useViews,
  VIEW_TYPE_LABELS,
  type FieldKey,
  type ViewConfig,
  type Filter as VFilter,
  type ViewRow,
  type ViewType,
} from '../records';
import { useLinks } from '../links';
import { TableView } from './TableView';
import { ListView } from './ListView';
import { GalleryView } from './GalleryView';
import { GroupBoard } from './GroupBoard';
import { RecordDetail } from './RecordDetail';

const VIEW_ICONS: Record<ViewType, typeof Table2> = { board: KanbanSquare, table: Table2, list: List, gallery: ImageIcon };

/* ============ dispatcher for the legacy routes ============ */

export function BoardOrDb() {
  const { boardId = '', taskId } = useParams();
  const board = useBoard(boardId);
  const views = useViews(boardId);
  if (board === undefined) return null;
  if (!board) return <Navigate to="/boards" replace />;
  // Records databases and tasks boards that already have views use the shell.
  if (isRecordsDb(board) || views.length > 0) return <DatabasePage recordId={taskId} />;
  return <BoardPage />;
}

/* ============ shell ============ */

export function DatabasePage({ recordId: propRecordId }: { recordId?: string }) {
  const { boardId = '', viewId, taskId, recordId } = useParams();
  const openRecordId = propRecordId ?? recordId ?? taskId;
  const navigate = useNavigate();
  const board = useBoard(boardId);
  const views = useViews(boardId);
  const tasks = useTasks();
  const links = useLinks();
  const me = useStore(authStore).user?.id;
  const mobile = useIsMobile();
  const [fieldsOpen, setFieldsOpen] = useState(false);

  const view = board ? resolveView(board, views, viewId) : undefined;

  if (board === undefined) return null;
  if (!board) return <Navigate to="/boards" replace />;

  const records = boardTasks(tasks, board.id).filter((t) => !t.parentId);
  const noun = recordNoun(board);
  const cols = stagesOf(board);

  const pickView = (v: ViewRow) => {
    rememberView(board.id, v.id || null);
    navigate(v.id ? `/boards/${board.id}/views/${v.id}` : `/boards/${board.id}`);
  };

  const closeDetail = () => navigate(view?.id ? `/boards/${board.id}/views/${view.id}` : `/boards/${board.id}`);


  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-x-2 gap-y-2 border-b border-neutral-200/70 px-4 py-2.5 dark:border-neutral-800/70">
          <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight">
            <span>{String(board.icon ?? (isRecordsDb(board) ? '🗃️' : '🗂️'))}</span>
            {String(board.name ?? (isRecordsDb(board) ? 'Database' : 'Board'))}
          </h1>
          <span className="flex-1" />
          <Button size="sm" onClick={() => void createRecord(board.id, {}).then((id) => navigate(view?.id ? `/boards/${board.id}/views/${view.id}/records/${id}` : `/boards/${board.id}/tasks/${id}`))}>
            <Plus size={14} /> New {noun.toLowerCase()}
          </Button>
          <Popover
            align="right"
            trigger={
              <button className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800" aria-label="Database menu">
                <MoreHorizontal size={17} />
              </button>
            }
          >
            {(close) => (
              <div className="w-52 p-1 text-sm">
                <button className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={() => { close(); setFieldsOpen(true); }}>
                  <Pencil size={14} /> Fields…
                </button>
                <button className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40" onClick={() => { close(); void deleteBoard(board).then(() => navigate('/boards')); }}>
                  <Trash2 size={14} /> Delete database
                </button>
              </div>
            )}
          </Popover>
          <PresenceStack path={`/boards/${board.id}`} />
        </header>

        {/* view tabs */}
        <div className="flex items-center gap-1 overflow-x-auto border-b border-neutral-200/70 px-3 py-1.5 dark:border-neutral-800/70" role="tablist" aria-label="Views">
          {(views.length ? views : [view!]).map((v) => {
            const Icon = VIEW_ICONS[v.type ?? 'table'];
            const active = v.id === view?.id;
            return (
              <div key={v.id || 'implicit'} className={cn('group flex items-center rounded-lg text-xs', active && 'bg-neutral-100 dark:bg-neutral-800')}>
                <button
                  role="tab"
                  aria-selected={active}
                  className={cn('flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 font-medium transition-colors', active ? 'text-neutral-900 dark:text-white' : 'text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200')}
                  style={{ minHeight: 32 }}
                  onClick={() => pickView(v)}
                >
                  <Icon size={13} />
                  {v.name}
                </button>
                {active && v.id !== '' && (
                  <ViewTabMenu view={v} board={board} onDeleted={() => navigate(`/boards/${board.id}`)} />
                )}
              </div>
            );
          })}
          <Popover
            trigger={
              <button className="flex items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1.5 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800" aria-label="New view" style={{ minHeight: 32 }}>
                <Plus size={12} /> View
              </button>
            }
          >
            {(close) => (
              <div className="w-40 p-1 text-sm">
                {(['table', 'list', 'gallery', 'board'] as ViewType[])
                  .filter((t) => t !== 'board' || cols.length > 0)
                  .map((t) => {
                    const Icon = VIEW_ICONS[t];
                    return (
                      <button
                        key={t}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800"
                        onClick={() => {
                          close();
                          void createView(board.id, t).then((id) => {
                            rememberView(board.id, id);
                            navigate(`/boards/${board.id}/views/${id}`);
                          });
                        }}
                      >
                        <Icon size={14} className="text-neutral-400" /> {VIEW_TYPE_LABELS[t]}
                      </button>
                    );
                  })}
              </div>
            )}
          </Popover>
          <span className="flex-1" />
          <ViewToolbar board={board} view={view!} noun={noun} />
        </div>

        {/* the active view */}
        <div className="min-h-0 flex-1 overflow-hidden">
          {view && renderView(board, view, records, { tasks, links, meId: me })}
        </div>
      </div>

      {/* record detail: desktop aside / mobile sheet */}
      {openRecordId && !mobile && (
        <aside className="w-[400px] shrink-0 overflow-y-auto border-l border-neutral-200/70 dark:border-neutral-800/70">
          <RecordDetail recordId={openRecordId} board={board} onClose={closeDetail} />
        </aside>
      )}
      {openRecordId && mobile && (
        <Sheet onClose={closeDetail}>
          <RecordDetail recordId={openRecordId} board={board} onClose={closeDetail} />
        </Sheet>
      )}

      {fieldsOpen && (
        <Sheet onClose={() => setFieldsOpen(false)}>
          <div className="overflow-y-auto p-4">
            <FieldsEditor board={board} />
          </div>
        </Sheet>
      )}
    </div>
  );
}

function renderView(board: BoardRow, view: ViewRow, records: ReturnType<typeof useDbRecords>, deps: { tasks: ReturnType<typeof useTasks>; links: ReturnType<typeof useLinks>; meId: string | undefined }) {
  const type = view.type ?? 'table';
  const cols = stagesOf(board);
  if (type === 'board') {
    const groupBy = view.config?.groupBy;
    if (!groupBy || groupBy === 'status') {
      if (!cols.length) return <ListView board={board} view={{ ...view, type: 'list' }} records={records} />; // no stages → list fallback
      return <Board board={board} tasks={boardTasks(deps.tasks, board.id)} />;
    }
    return <GroupBoard board={board} view={view} records={records} />;
  }
  if (type === 'list') return <ListView board={board} view={view} records={records} />;
  if (type === 'gallery') return <GalleryView board={board} view={view} records={records} />;
  return <TableView board={board} view={view} records={records} />;
}

function ViewTabMenu({ view, board, onDeleted }: { view: ViewRow; board: BoardRow; onDeleted: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(String(view.name ?? ''));
  return (
    <>
      <Popover
        align="left"
        trigger={
          <button className="mr-1 flex h-5 w-5 items-center justify-center rounded text-neutral-400 opacity-0 transition-opacity hover:bg-neutral-200 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-neutral-700" aria-label={`${view.name} options`}>
            <MoreHorizontal size={12} />
          </button>
        }
      >
        {(close) => (
          <div className="w-44 p-1 text-sm">
            <button
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800"
              onClick={() => {
                close();
                setRenaming(true);
              }}
            >
              <Pencil size={13} /> Rename
            </button>
            <button
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800"
              onClick={() => {
                close();
                void mutate('boards', board.id, { defaultViewId: view.id });
              }}
            >
              <KanbanSquare size={13} /> Set as default
            </button>
            <button
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
              onClick={() => {
                close();
                void deleteView(view).then(onDeleted);
              }}
            >
              <Trash2 size={13} /> Delete view
            </button>
          </div>
        )}
      </Popover>
      {renaming && (
        <Dialog title="Rename view" onClose={() => setRenaming(false)}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-lg border border-neutral-200 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700" />
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRenaming(false)}>Cancel</Button>
            <Button
              onClick={() => {
                void updateView(view.id, { name: name.trim() || String(view.name) });
                setRenaming(false);
              }}
            >
              Save
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}

/* ============ view toolbar: filter / sort / group / props / mine ============ */

const FILTER_OPS: { id: VFilter['op']; label: string }[] = [
  { id: 'is', label: 'is' },
  { id: 'is_not', label: 'is not' },
  { id: 'contains', label: 'contains' },
  { id: 'not_contains', label: "doesn't contain" },
  { id: 'empty', label: 'is empty' },
  { id: 'not_empty', label: 'is not empty' },
  { id: 'before', label: 'before' },
  { id: 'after', label: 'after' },
  { id: 'on_or_before', label: 'on or before' },
  { id: 'on_or_after', label: 'on or after' },
  { id: 'checked', label: 'checked' },
  { id: 'unchecked', label: 'unchecked' },
  { id: 'me', label: 'is me' },
];

function ViewToolbar({ board, view, noun }: { board: BoardRow; view: ViewRow; noun: string }) {
  const cfg = view.config ?? {};
  const keys = availableFieldKeys(board);
  const setCfg = (patch: Partial<NonNullable<ViewRow['config']>>) => void persistViewConfig(board, view, { ...cfg, ...patch });

  const filters = cfg.filters ?? [];
  const sorts = cfg.sorts ?? [];
  const visible = cfg.visible?.length ? cfg.visible : defaultVisibleKeys(board);

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => setCfg({ mine: !cfg.mine })}
        aria-pressed={!!cfg.mine}
        className={cn('flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition-colors', cfg.mine ? 'bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-400' : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800')}
        style={{ minHeight: 32 }}
      >
        <Users size={12} /> <span className="hidden sm:inline">Mine</span>
      </button>
      <Popover
        align="right"
        trigger={
          <button className={cn('flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition-colors', filters.length ? 'bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-400' : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800')} style={{ minHeight: 32 }} aria-label="Filters">
            <Filter size={12} /> <span className="hidden sm:inline">Filter{filters.length ? ` · ${filters.length}` : ''}</span>
          </button>
        }
      >
        {() => (
          <div className="w-72 max-w-[calc(100vw-2rem)] p-2 text-xs">
            <p className="px-1 pb-1.5 font-semibold text-neutral-500">Filters</p>
            {filters.map((f, i) => (
              <FilterRow key={i} board={board} keys={keys} filter={f} onChange={(nf) => setCfg({ filters: nf ? filters.map((x, j) => (j === i ? nf : x)) : filters.filter((_, j) => j !== i) })} />
            ))}
            <button className="mt-1 flex items-center gap-1 rounded-md px-1.5 py-1.5 text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40" onClick={() => setCfg({ filters: [...filters, { key: keys[0], op: 'is', value: '' }] })}>
              <Plus size={12} /> Add filter
            </button>
          </div>
        )}
      </Popover>
      <Popover
        align="right"
        trigger={
          <button className={cn('flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition-colors', sorts.length ? 'bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-400' : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800')} style={{ minHeight: 32 }} aria-label="Sort">
            <ArrowUpDown size={12} /> <span className="hidden sm:inline">Sort{sorts.length ? ` · ${sorts.length}` : ''}</span>
          </button>
        }
      >
        {() => (
          <div className="w-64 p-2 text-xs">
            <p className="px-1 pb-1.5 font-semibold text-neutral-500">Sort</p>
            {sorts.map((s, i) => (
              <div key={i} className="mb-1 flex items-center gap-1">
                <Select value={s.key} onChange={(e) => setCfg({ sorts: sorts.map((x, j) => (j === i ? { ...x, key: e.target.value as FieldKey } : x)) })} className="h-8 flex-1 text-xs">
                  {keys.map((k) => (
                    <option key={k} value={k}>
                      {fieldKeyLabel(board, k)}
                    </option>
                  ))}
                </Select>
                <Select value={s.dir} onChange={(e) => setCfg({ sorts: sorts.map((x, j) => (j === i ? { ...x, dir: e.target.value as 'asc' | 'desc' } : x)) })} className="h-8 w-20 text-xs">
                  <option value="asc">Asc</option>
                  <option value="desc">Desc</option>
                </Select>
                <button className="text-neutral-400 hover:text-red-500" onClick={() => setCfg({ sorts: sorts.filter((_, j) => j !== i) })} aria-label="Remove sort">
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <button className="mt-1 flex items-center gap-1 rounded-md px-1.5 py-1.5 text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40" onClick={() => setCfg({ sorts: [...sorts, { key: keys[0], dir: 'asc' }] })}>
              <Plus size={12} /> Add sort
            </button>
          </div>
        )}
      </Popover>
      <Select
        value={cfg.groupBy ?? ''}
        onChange={(e) => setCfg({ groupBy: (e.target.value || null) as ViewConfig['groupBy'] })}
        className="h-8 w-auto max-w-28 text-xs"
        aria-label="Group by"
        title="Group by"
      >
        <option value="">No grouping</option>
        {keys.map((k) => (
          <option key={k} value={k}>
            {fieldKeyLabel(board, k)}
          </option>
        ))}
      </Select>
      <Popover
        align="right"
        trigger={
          <button className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800" style={{ minHeight: 32 }} aria-label="Properties">
            <span className="hidden sm:inline">Props</span>
            <span className="sm:hidden">▦</span>
          </button>
        }
      >
        {() => (
          <div className="w-52 p-1.5 text-xs">
            <p className="px-1 pb-1 font-semibold text-neutral-500">Shown properties</p>
            {keys.map((k) => {
              const on = visible.includes(k);
              return (
                <label key={k} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={k === 'title'}
                    onChange={() => setCfg({ visible: on ? visible.filter((x) => x !== k) : [...visible, k] })}
                    className="h-3.5 w-3.5 accent-neutral-900 dark:accent-neutral-200"
                  />
                  {fieldKeyLabel(board, k)}
                </label>
              );
            })}
          </div>
        )}
      </Popover>
      {noun && <span className="hidden" />}
    </div>
  );
}

function FilterRow({ board, keys, filter, onChange }: { board: BoardRow; keys: FieldKey[]; filter: VFilter; onChange: (f: VFilter | null) => void }) {
  const noValue = ['empty', 'not_empty', 'checked', 'unchecked', 'me'].includes(filter.op);
  return (
    <div className="mb-1 flex items-center gap-1">
      <Select value={filter.key} onChange={(e) => onChange({ ...filter, key: e.target.value as FieldKey })} className="h-8 flex-1 text-xs">
        {keys.map((k) => (
          <option key={k} value={k}>
            {fieldKeyLabel(board, k)}
          </option>
        ))}
      </Select>
      <Select value={filter.op} onChange={(e) => onChange({ ...filter, op: e.target.value as VFilter['op'] })} className="h-8 w-24 text-xs">
        {FILTER_OPS.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
      {!noValue && <input value={String(filter.value ?? '')} placeholder="value" onChange={(e) => onChange({ ...filter, value: e.target.value })} className="h-8 w-20 rounded-md border border-neutral-200 bg-transparent px-1.5 text-xs dark:border-neutral-700" />}
      <button className="text-neutral-400 hover:text-red-500" onClick={() => onChange(null)} aria-label="Remove filter">
        <Trash2 size={12} />
      </button>
    </div>
  );
}
