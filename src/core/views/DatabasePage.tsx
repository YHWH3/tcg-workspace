import {modules} from '../../modules';
import {Slot} from '../../modules/slots';
import {AttentionEditor} from '../../modules/boards/AttentionEditor';
import {GateEditor, GateMoveHost} from '../../modules/boards/GateMove';
import {MoveSpaceButton} from '../MoveSpace';
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
import { useId, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { Archive, ArchiveRestore, ArrowUpDown, BarChart3, Calendar, ClipboardList, Copy, Download, Filter, Image as ImageIcon, KanbanSquare, LayoutDashboard, List, MoreHorizontal, Newspaper, Pencil, Plus, ShieldCheck, Table2, GanttChartSquare, Trash2, Upload, Users, Zap } from 'lucide-react';
import { authStore } from '../auth';
import { useIsMobile } from '../mobile';
import { PresenceStack } from '../presence';
import { AskAiMenu } from '../assistant/AskAiMenu';
import { useAssistantContext } from '../assistant/store';
import { useStore } from '../store';
import { mutate } from '../sync/engine';
import { Button, Dialog, Popover, Select, Sheet } from '../ui';
import { cn, todayISO } from '../utils';
import { Board } from '../../modules/boards/Board';
import { BoardPage } from '../../modules/boards/BoardPage';
import { FieldsEditor } from '../../modules/boards/FieldsEditor';
import { useBoard, useTasks, boardTasks, deleteBoard, type BoardRow } from '../../modules/boards/api';
import { fieldsOf } from '../../modules/boards/model';
import {
  applyView,
  availableFieldKeys,
  createRecord,
  createView,
  defaultVisibleKeys,
  deleteView,
  exportView,
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
  viewCtx,
  type FieldKey,
  type ViewConfig,
  type Filter as VFilter,
  type ViewRow,
  type ViewType,
} from '../records';
import { useLinks } from '../links';
import { useUsers } from '../users';
import { TableView } from './TableView';
import {ChartView} from './ChartView';
import {DEFAULT_CHART} from '../../../shared/charts';
import { ListView } from './ListView';
import { DashboardView } from './DashboardView';
import { FeedView } from './FeedView';
import { GalleryView } from './GalleryView';
import { GroupBoard } from './GroupBoard';
import { RecordDetail } from './RecordDetail';
import { CalendarView } from '../../modules/boards/views/CalendarView';
import { TimelineView } from '../../modules/boards/views/TimelineView';
import { fieldKeyOf } from '../records';
import {changeFilterOperator,isDateFilterKey, VIEW_LAYOUTS, type DateFieldKey} from '../../../shared/views';
import {DateFilterControl,DATE_VALUE_OPERATORS} from './DateFilterControl';
import {useContainerWidth} from '../container';
import { archivePatch, isArchived } from '../../../shared/archive';
import { BulkActionBar, BulkSelectionProvider } from './bulk';
import { ImportCsvDialog } from './ImportCsv';

const VIEW_ICONS: Record<ViewType, typeof Table2> = { board: KanbanSquare, table: Table2, list: List, gallery: ImageIcon, calendar: Calendar, timeline: GanttChartSquare, chart: BarChart3, feed: Newspaper, dashboard: LayoutDashboard };

/* ============ dispatcher for the legacy routes ============ */

export function BoardOrDb({ savedViews = false }: { savedViews?: boolean }) {
  const { boardId = '', taskId } = useParams();
  const board = useBoard(boardId);
  const views = useViews(boardId);
  if (board === undefined) return null;
  if (!board) return <Navigate to="/boards" replace />;
  // Records databases and tasks boards that already have views use the shell.
  if (savedViews || isRecordsDb(board) || views.length > 0) return <DatabasePage recordId={taskId} />;
  return <BoardPage />;
}

/* ============ shell ============ */

export function DatabasePage({ recordId: propRecordId }: { recordId?: string }) {
  const container=useContainerWidth();
  const { boardId = '', viewId, taskId, recordId } = useParams();
  const openRecordId = propRecordId ?? recordId ?? taskId;
  const navigate = useNavigate();
  const board = useBoard(boardId);
  const views = useViews(boardId);
  const tasks = useTasks();
  const links = useLinks();
  const me = useStore(authStore).user?.id;
  const mobile = useIsMobile();
  // Keep both panes usable. A tablet database must not shrink to a toolbar
  // sliver beside a fixed-width detail, especially with enlarged root text.
  const detailOverlay=mobile||container.width<54*parseFloat(getComputedStyle(document.documentElement).fontSize);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [gateOpen, setGateOpen] = useState(false);
  const [attentionOpen,setAttentionOpen]=useState(false);
  const [csvExportOpen, setCsvExportOpen] = useState(false);
  const [csvImportOpen, setCsvImportOpen] = useState(false);
  useAssistantContext(board ? { kind: 'database', id: board.id } : null);

  const view = board ? resolveView(board, views, viewId) : undefined;
  const records = board ? boardTasks(tasks, board.id).filter((t) => !t.parentId) : [];
  const selectionRows = useMemo(() => {
    if (!board || !view) return [];
    const ctx = viewCtx(board, tasks, links, me, todayISO());
    return applyView(records, view.config, ctx).rows;
  }, [board, links, me, records, tasks, view]);

  if (board === undefined) return null;
  if (!board) return <Navigate to="/boards" replace />;

  const noun = recordNoun(board);
  const cols = stagesOf(board);

  const pickView = (v: ViewRow) => {
    rememberView(board.id, v.id || null);
    navigate(v.id ? `/boards/${board.id}/views/${v.id}` : `/boards/${board.id}`);
  };

  const closeDetail = () => navigate(view?.id ? `/boards/${board.id}/views/${view.id}` : `/boards/${board.id}`);


  return (
    <div ref={container.ref} className="flex h-full min-h-0 min-w-0">
      <div className="flex min-w-0 flex-1 flex-col max-md:overflow-y-auto">
        <header className="flex flex-wrap items-center gap-x-2 gap-y-2 border-b border-neutral-200/70 px-4 py-2.5 dark:border-neutral-800/70">
          <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight">
            <span>{String(board.icon ?? (isRecordsDb(board) ? '🗃️' : '🗂️'))}</span>
            {String(board.name ?? (isRecordsDb(board) ? 'Database' : 'Board'))}
          </h1>
          <span className="flex-1" />
          <AskAiMenu
            modules={/\b(people|person|contact|member)s?\b/i.test(`${String(board.name ?? '')} ${String(board.recordNoun ?? '')}`) ? ['databases', 'people'] : ['databases']}
            refs={{ database: { kind: 'database', id: board.id } }}
            compact
          />
          <MoveSpaceButton root={board}/>
          <Button size="sm" onClick={() => void createRecord(board.id, {}).then((id) => navigate(view?.id ? `/boards/${board.id}/views/${view.id}/records/${id}` : `/boards/${board.id}/tasks/${id}`))}>
            <Plus size={14} /> New {noun.toLowerCase()}
          </Button>
          <Popover
            align="right"
            trigger={
              <button className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800" aria-label="Database menu">
                <MoreHorizontal size={17} />
              </button>
            }
          >
            {(close) => (
              <div className="w-52 p-1 text-sm">
                <button className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={() => { close(); setFieldsOpen(true); }}>
                  <Pencil size={14} /> Fields…
                </button>
                <button className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={() => { close(); setCsvExportOpen(true); }}>
                  <Download size={14} /> Export CSV…
                </button>
                <button className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={() => { close(); setCsvImportOpen(true); }}>
                  <Upload size={14} /> Import CSV…
                </button>
                <button className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={() => { close(); setAttentionOpen(true); }}>Attention…</button>
                <button className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={() => { close(); navigate(`/forms/${board.id}`); }}>
                  <ClipboardList size={14} /> Forms…
                </button>
                {cols.length > 0 && <button className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  onClick={() => { close(); setGateOpen(true); }}>
                  <ShieldCheck size={14} /> Approval gate…
                </button>}
                <button className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={() => { close(); navigate(`/automations/${board.id}`); }}>
                  <Zap size={14} /> Automations…
                </button>
                <button className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={() => { close(); void mutate('boards', board.id, archivePatch(!isArchived(board))); }}>
                  {isArchived(board) ? <ArchiveRestore size={14} /> : <Archive size={14} />} {isArchived(board) ? 'Unarchive' : 'Archive'} database
                </button>
                {!isRecordsDb(board) && <button className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40" onClick={() => { close(); void deleteBoard(board).then(() => navigate('/boards')); }}>
                  <Trash2 size={14} /> Delete task database (move tasks to default)
                </button>}
              </div>
            )}
          </Popover>
          <PresenceStack path={`/boards/${board.id}`} />
        </header>

        {isArchived(board) && (
          <div className="flex items-center gap-2 border-b border-neutral-200/70 bg-neutral-50 px-4 py-1.5 text-xs text-neutral-500 dark:border-neutral-800/70 dark:bg-neutral-900 dark:text-neutral-400">
            <Archive size={12} />
            <span className="flex-1">Archived</span>
            <button className="rounded-md px-2 py-0.5 font-medium text-neutral-700 hover:bg-neutral-200/70 dark:text-neutral-200 dark:hover:bg-neutral-800" onClick={() => void mutate('boards', board.id, archivePatch(false))}>
              Unarchive
            </button>
          </div>
        )}

        <Slot modules={modules} kind="databaseSummary" props={{databaseId:board.id}}/>

        {/* view tabs */}
        <div className="flex min-w-0 items-center gap-1 border-b border-neutral-200/70 px-3 py-1.5 dark:border-neutral-800/70">
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto" role="tablist" aria-label="Views">
          {(views.length ? views : [view!]).map((v) => {
            const Icon = VIEW_ICONS[v.type] ?? Table2;
            const active = v.id === view?.id;
            return (
              <div key={v.id || 'implicit'} role="presentation" className={cn('group flex shrink-0 items-center rounded-lg text-xs', active && 'bg-neutral-100 dark:bg-neutral-800')}>
                <button
                  role="tab"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  onKeyDown={(e) => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
                    e.preventDefault();
                    const tabs = [...e.currentTarget.closest('[role="tablist"]')!.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
                    const i = tabs.indexOf(e.currentTarget);
                    const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
                    tabs[next].focus(); tabs[next].click();
                  }}
                  className={cn('flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 font-medium transition-colors', active ? 'text-neutral-900 dark:text-white' : 'text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200')}
                  style={{ minHeight: 32 }}
                  onClick={() => pickView(v)}
                >
                  <Icon size={13} />
                  {v.name}
                </button>
              </div>
            );
          })}
          </div>
          {view?.id && (
            <div className="shrink-0">
              <ViewTabMenu key={view.id} view={view} board={board} onCreated={id => pickView({ ...view, id })} onDeleted={() => navigate(`/boards/${board.id}`)} />
            </div>
          )}
          <div className="shrink-0">
            <Popover adaptive label="Add a database view" align="right"
              trigger={
                <button type="button" className="inline-flex min-h-11 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2 text-xs font-medium text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800" aria-label="New view">
                  <Plus size={14} aria-hidden="true" /> View
                </button>
              }
            >
              {(close) => (
                <NewViewMenu
                  board={board}
                  hasStages={cols.length > 0}
                  onForms={() => { close(); navigate(`/forms/${board.id}`); }}
                  onCreate={(t, cfg) => {
                    close();
                    void createView(board.id, t, undefined, cfg).then((id) => {
                      rememberView(board.id, id);
                      navigate(`/boards/${board.id}/views/${id}`);
                    });
                  }}
                />
              )}
            </Popover>
          </div>
          </div>
        <div className="border-b border-neutral-200/70 px-3 py-1 dark:border-neutral-800/70">
          <ViewToolbar board={board} view={view!} noun={noun} />
        </div>

        {/* the active view */}
        <div className="min-h-0 flex-1 overflow-hidden max-md:flex-none max-md:overflow-visible">
          {view && (
            <BulkSelectionProvider rows={selectionRows}>
              {(view.type === 'table' || view.type === 'list') && <BulkActionBar board={board} />}
              {renderView(board, view, records, { tasks, links, meId: me })}
            </BulkSelectionProvider>
          )}
        </div>
      </div>

      {/* record detail: desktop aside / mobile sheet */}
      {openRecordId && !detailOverlay && (
        <aside className="w-[400px] shrink-0 overflow-y-auto border-l border-neutral-200/70 dark:border-neutral-800/70">
          <RecordDetail recordId={openRecordId} board={board} onClose={closeDetail} />
        </aside>
      )}
      {openRecordId && detailOverlay && (
        <Sheet onClose={closeDetail}>
          <RecordDetail recordId={openRecordId} board={board} onClose={closeDetail} />
        </Sheet>
      )}

      {attentionOpen&&<Sheet label="Attention settings" onClose={()=>setAttentionOpen(false)}><AttentionEditor board={board}/></Sheet>}
      {fieldsOpen && (
        <Sheet onClose={() => setFieldsOpen(false)}>
          <div className="overflow-y-auto p-4">
            <FieldsEditor board={board} />
          </div>
        </Sheet>
      )}
      {csvExportOpen && view && <CsvExportDialog board={board} view={view} records={records} tasks={tasks} links={links} meId={me} onClose={() => setCsvExportOpen(false)} />}
      {csvImportOpen && <ImportCsvDialog board={board} records={records} onClose={() => setCsvImportOpen(false)} />}
      {gateOpen && <Dialog title="Approval gate" onClose={() => setGateOpen(false)}><GateEditor board={board} /></Dialog>}
      <GateMoveHost />
    </div>
  );
}

function CsvExportDialog({ board, view, records, tasks, links, meId, onClose }: { board: BoardRow; view: ViewRow; records: ReturnType<typeof useDbRecords>; tasks: ReturnType<typeof useTasks>; links: ReturnType<typeof useLinks>; meId: string | undefined; onClose: () => void }) {
  const mobile = useIsMobile();
  const users = useUsers();
  const [includePaymentReferences, setIncludePaymentReferences] = useState(false);
  const [message, setMessage] = useState('');
  const ctx = useMemo(() => viewCtx(board, tasks, links, meId, todayISO()), [board, links, meId, tasks]);
  const result = useMemo(() => exportView(board, view.config, records, ctx, {
    includePaymentReferences,
    userName: id => users.find(user => user.id === id)?.name,
  }), [board, ctx, includePaymentReferences, records, users, view.config]);
  const filename = `${safeFilename(String(board.name ?? 'database'))}-${safeFilename(String(view.name ?? 'view'))}-${todayISO()}.csv`;
  const nav = typeof navigator === 'undefined' ? undefined : navigator as Navigator & { share?: (data: ShareData) => Promise<void>; canShare?: (data: ShareData) => boolean };
  const canShare = typeof nav?.share === 'function' && typeof File !== 'undefined';

  const download = () => {
    const url = URL.createObjectURL(new Blob([result.csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const share = async () => {
    if (!canShare || !nav) return download();
    const file = new File([result.csv], filename, { type: 'text/csv;charset=utf-8' });
    if (!nav.canShare?.({ files: [file] })) return download();
    try {
      await nav.share?.({ title: filename, files: [file] });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setMessage('Sharing was unavailable. The file is ready to download.');
    }
  };

  return (
    <Dialog title="Export CSV" onClose={onClose}>
      <p className="text-sm text-neutral-600 dark:text-neutral-300">{result.rows} rows · {result.columns} columns</p>
      <p className="mt-2 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">Exports the records synced to this device that you can see.</p>
      {board.id === 'board-website-inbox' && (
        <label className="mt-4 flex items-start gap-2 text-sm">
          <input type="checkbox" checked={includePaymentReferences} onChange={event => setIncludePaymentReferences(event.target.checked)} className="mt-0.5 h-4 w-4 accent-neutral-900 dark:accent-neutral-200" />
          <span>Include payment references</span>
        </label>
      )}
      {message && <p role="status" className="mt-3 text-xs text-amber-700 dark:text-amber-300">{message}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        {mobile && canShare && <Button variant="primary" onClick={() => void share()}>Share CSV</Button>}
        <Button variant={mobile && canShare ? 'ghost' : 'primary'} onClick={download}><Download size={14} /> Download CSV</Button>
      </div>
    </Dialog>
  );
}

function safeFilename(value: string): string {
  return value.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'export';
}

function renderView(board: BoardRow, view: ViewRow, records: ReturnType<typeof useDbRecords>, deps: { tasks: ReturnType<typeof useTasks>; links: ReturnType<typeof useLinks>; meId: string | undefined }) {
  const type = view.type ?? 'table';
  const cols = stagesOf(board);
  if (type === 'board') {
    const groupBy = view.config?.groupBy;
    if (!groupBy || groupBy === 'status') {
      if (!cols.length) return <ListView board={board} view={{ ...view, type: 'list' }} records={records} />; // no stages → list fallback
      const ctx = viewCtx(board, deps.tasks, deps.links, deps.meId, todayISO());
      return <Board board={board} tasks={applyView(records, view.config, ctx).rows} />;
    }
    return <GroupBoard board={board} view={view} records={records} />;
  }
  if (type === 'list') return <ListView board={board} view={view} records={records} />;
  if (type === 'feed') return <FeedView key={view.id} board={board} view={view} records={records} />;
  if (type === 'gallery') return <GalleryView board={board} view={view} records={records} />;
  if (type === 'calendar') return <CalendarView board={board} view={view} records={records} />;
  if (type === 'timeline') return <TimelineView board={board} view={view} records={records} />;
  if (type === 'dashboard') return <DashboardView key={view.id} board={board} view={view} records={records}
    context={viewCtx(board, deps.tasks, deps.links, deps.meId, todayISO())} />;
  if (type === 'chart') return <ChartView key={view.id} board={board} view={view} records={records}
    context={viewCtx(board, deps.tasks, deps.links, deps.meId, todayISO())}
    onConfig={chart => void persistViewConfig(board, view, {...view.config, chart})} />;
  return <TableView board={board} view={view} records={records} />;
}

function ViewTabMenu({ view, board, onCreated, onDeleted }: { view: ViewRow; board: BoardRow; onCreated: (id: string) => void; onDeleted: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(String(view.name ?? ''));
  return (
    <>
      <Popover
        align="right"
        adaptive
        label="View options"
        trigger={
          <button type="button" className="flex min-h-11 min-w-9 items-center justify-center rounded-lg text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800" aria-label={`${view.name} options`}>
            <MoreHorizontal size={16} />
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
              className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800"
              onClick={() => {
                close();
                void createView(board.id, view.type, `${view.name} copy`, view.config).then(onCreated);
              }}
            >
              <Copy size={13} /> Duplicate view
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
        <Dialog title="Rename view" onClose={() => setRenaming(false)} guard={() => !name.trim() || name.trim() === (view?.name ?? '')}>
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
  { id: 'within', label: 'within range' },
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
  const filterLabel = `Filter${filters.length ? ` · ${filters.length}` : ''}`;
  const sortLabel = `Sort${sorts.length ? ` · ${sorts.length}` : ''}`;
  const visible = cfg.visible?.length ? cfg.visible : defaultVisibleKeys(board);

  return (
    <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label="View controls">
      <button
        aria-label="Mine"
        onClick={() => setCfg({ mine: !cfg.mine })}
        aria-pressed={!!cfg.mine}
        className={cn('flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition-colors', cfg.mine ? 'bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-400' : 'text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800')}
        style={{ minHeight: 32 }}
      >
        <Users size={12} /> <span className="hidden sm:inline">Mine</span>
      </button>
      <button
        onClick={() => setCfg({ includeArchived: !cfg.includeArchived })}
        aria-pressed={!!cfg.includeArchived}
        className={cn('flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition-colors', cfg.includeArchived ? 'bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-400' : 'text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800')}
        style={{ minHeight: 32 }}
        title="Include archived records"
      >
        <Archive size={12} /> <span className="hidden sm:inline">Archived</span>
      </button>
      <Popover
        align="right"
        adaptive
        label="Filters"
        trigger={
          <button className={cn('flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition-colors', filters.length ? 'bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-400' : 'text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800')} style={{ minHeight: 32 }} aria-label={filterLabel}>
            <Filter size={12} /> <span className="hidden sm:inline">{filterLabel}</span>
          </button>
        }
      >
        {() => (
          <div className="w-full p-3 text-xs sm:w-72 sm:max-w-[calc(100vw-2rem)] sm:p-2">
            <p className="px-1 pb-1.5 font-semibold text-neutral-600 dark:text-neutral-400">Filters</p>
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
          <button className={cn('flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium transition-colors', sorts.length ? 'bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-400' : 'text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800')} style={{ minHeight: 32 }} aria-label={sortLabel}>
            <ArrowUpDown size={12} /> <span className="hidden sm:inline">{sortLabel}</span>
          </button>
        }
      >
        {() => (
          <div className="w-64 p-2 text-xs">
            <p className="px-1 pb-1.5 font-semibold text-neutral-600 dark:text-neutral-400">Sort</p>
            {sorts.map((s, i) => (
              <div key={i} className="mb-1 flex items-center gap-1">
                <Select density="compact" aria-label="Sort field" value={s.key} onChange={(e) => setCfg({ sorts: sorts.map((x, j) => (j === i ? { ...x, key: e.target.value as FieldKey } : x)) })} className="flex-1">
                  {keys.map((k) => (
                    <option key={k} value={k}>
                      {fieldKeyLabel(board, k)}
                    </option>
                  ))}
                </Select>
                <Select density="compact" aria-label="Sort direction" value={s.dir} onChange={(e) => setCfg({ sorts: sorts.map((x, j) => (j === i ? { ...x, dir: e.target.value as 'asc' | 'desc' } : x)) })} className="w-20">
                  <option value="asc">Asc</option>
                  <option value="desc">Desc</option>
                </Select>
                <button className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-600 hover:text-red-600 dark:text-neutral-400" onClick={() => setCfg({ sorts: sorts.filter((_, j) => j !== i) })} aria-label="Remove sort">
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
      <Select density="compact"
        value={cfg.groupBy ?? ''}
        onChange={(e) => setCfg({ groupBy: (e.target.value || null) as ViewConfig['groupBy'] })}
        className="w-auto max-w-full"
        aria-label="Group by"
        title={cfg.groupBy ? `Group by: ${fieldKeyLabel(board, cfg.groupBy)}` : 'Group by: No grouping'}
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
          <button className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800" style={{ minHeight: 32 }} aria-label="Properties">
            <span className="hidden sm:inline">Properties</span>
            <span className="sm:hidden">▦</span>
          </button>
        }
      >
        {() => (
          <div className="w-52 p-1.5 text-xs">
            <p className="px-1 pb-1 font-semibold text-neutral-600 dark:text-neutral-400">Shown properties</p>
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
      {(view.type === 'calendar' || view.type === 'timeline' || view.type === 'dashboard') && (
        <>
          <Select density="compact"
            value={cfg.dateKey ?? 'dueDate'}
            onChange={(e) => setCfg({ dateKey: e.target.value as DateFieldKey })}
            className="w-auto max-w-32"
            aria-label="Date field"
            title="Date field"
          >
            {dateFieldKeys(board).map((k) => (
              <option key={k} value={k}>
                {fieldKeyLabel(board, k)}
              </option>
            ))}
          </Select>
          {view.type === 'timeline' && (
            <Select density="compact"
              value={cfg.endDateKey ?? ''}
              onChange={(e) => setCfg({ endDateKey: (e.target.value || null) as DateFieldKey | null })}
              className="w-auto max-w-32"
              aria-label="End date field"
              title="End date field"
            >
              <option value="">No end date</option>
              {dateFieldKeys(board).map((k) => (
                <option key={k} value={k}>
                  {fieldKeyLabel(board, k)}
                </option>
              ))}
            </Select>
          )}
        </>
      )}
      {noun && <span className="hidden" />}
    </div>
  );
}

/** dueDate + every date-type custom field — the calendar/timeline bucketing keys. */
function dateFieldKeys(board: BoardRow): DateFieldKey[] {
  const keys: DateFieldKey[] = ['dueDate'];
  for (const f of fieldsOf(board)) if (f.type === 'date') keys.push(fieldKeyOf(f) as DateFieldKey);
  return keys;
}

/** New-view menu: type list; calendar/timeline ask for the date field first. */
function NewViewMenu({ board, hasStages, onCreate, onForms }: {
  board: BoardRow;
  hasStages: boolean;
  onCreate: (type: ViewType, config?: ViewConfig) => void;
  onForms: () => void;
}) {
  const descriptionId = useId();
  const [pending, setPending] = useState<'calendar' | 'timeline' | null>(null);
  const [dateKey, setDateKey] = useState<DateFieldKey>('dueDate');
  const groupField = fieldsOf(board).find(field => field.type === 'select' || field.type === 'person');

  if (pending) {
    return (
      <div className="w-full p-4 text-sm sm:w-72">
        <label className="block">
          <span className="font-medium">{VIEW_LAYOUTS[pending].label} date field</span>
          <Select autoFocus value={dateKey} onChange={e => setDateKey(e.target.value as DateFieldKey)} className="my-2 w-full">
            {dateFieldKeys(board).map(key => <option key={key} value={key}>{fieldKeyLabel(board, key)}</option>)}
          </Select>
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setPending(null)}>Back</Button>
          <Button variant="primary" onClick={() => onCreate(pending, { dateKey })}>Create</Button>
        </div>
      </div>
    );
  }

  const layouts: ViewType[] = ['table', 'board', 'calendar', 'timeline', 'dashboard', 'chart', 'list', 'gallery', 'feed'];
  const buttonClass = 'flex min-h-11 w-full items-start gap-3 rounded-lg px-3 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800';
  return (
    <div className="w-full p-2 text-sm sm:w-[min(32rem,calc(100vw-2rem))]">
      <p className="px-3 pt-2 pb-1 font-semibold">Add a view</p>
      <div className="grid gap-1 sm:grid-cols-2">
        {layouts.map((type, index) => {
          const Icon = VIEW_ICONS[type];
          const { label, description } = VIEW_LAYOUTS[type];
          const unavailable = type === 'board' && !hasStages && !groupField;
          return (
            <button key={type} type="button" autoFocus={index === 0} disabled={unavailable}
              aria-label={label} aria-describedby={`${descriptionId}-${type}`}
              className={`${buttonClass} disabled:cursor-default disabled:hover:bg-transparent`}
              onClick={() => {
                if (type === 'calendar' || type === 'timeline') setPending(type);
                else if (type === 'chart') onCreate(type, { chart: DEFAULT_CHART });
                else if (type === 'board' && !hasStages && groupField) onCreate(type, { groupBy: fieldKeyOf(groupField) });
                else onCreate(type);
              }}
            >
              <Icon aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-neutral-600 dark:text-neutral-400" />
              <span>
                <span className="block font-medium">{label}</span>
                <span id={`${descriptionId}-${type}`} className="block text-xs text-neutral-600 dark:text-neutral-300">
                  {unavailable ? 'Add a stage, select, or person property first.' : description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-1 border-t border-neutral-200 pt-1 dark:border-neutral-700">
        <button type="button" className={buttonClass} onClick={onForms}>
          <ClipboardList aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-neutral-600 dark:text-neutral-400" />
          <span><span className="block font-medium">Form builder</span><span className="block text-xs text-neutral-600 dark:text-neutral-300">Collect new records through a form.</span></span>
        </button>
      </div>
    </div>
  );
}

export function FilterRow({ board, keys, filter, onChange }: { board: BoardRow; keys: FieldKey[]; filter: VFilter; onChange: (f: VFilter | null) => void }) {
  const noValue = ['empty', 'not_empty', 'checked', 'unchecked', 'me'].includes(filter.op);
  const fields=fieldsOf(board),isDate=isDateFilterKey(filter.key,fields);
  const structuredDate=isDate&&DATE_VALUE_OPERATORS.includes(filter.op);
  return (
    <div className="mb-1">
    <div className={isDate ? 'grid grid-cols-[minmax(0,1fr)_2rem] gap-1' : 'flex items-center gap-1'}>
      <Select density="compact" aria-label="Filter field" value={filter.key} onChange={(e) => {const key=e.target.value as FieldKey;onChange({...filter,key,...(filter.op==='within'&&!isDateFilterKey(key,fields)?{op:'is',value:''}:{})});}} className={isDate ? 'col-span-2 w-full' : 'flex-1'}>
        {keys.map((k) => (
          <option key={k} value={k}>
            {fieldKeyLabel(board, k)}
          </option>
        ))}
      </Select>
      <Select density="compact" aria-label="Filter operator" value={filter.op} onChange={(e) => onChange(changeFilterOperator(filter,e.target.value as VFilter['op']))} className={isDate ? 'col-span-2 w-full' : 'w-24'}>
        {FILTER_OPS.filter(o=>o.id===filter.op||(isDate?['is','is_not','empty','not_empty',...DATE_VALUE_OPERATORS].includes(o.id):o.id!=='within')).map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
      {!noValue && (structuredDate ? <div className="col-span-2 min-w-0"><DateFilterControl filter={filter} onChange={onChange} label="Filter" fields={fields}/></div>
        : <input aria-label="Filter value" value={String(filter.value ?? '')} placeholder="value" onChange={(e) => onChange({ ...filter, value: e.target.value })} className={cn('h-8 rounded-md border border-neutral-200 bg-transparent px-1.5 text-xs dark:border-neutral-700', isDate ? 'col-span-2 w-full min-w-0' : 'w-20')} />)}
      <button className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-600 hover:text-red-600 dark:text-neutral-400" onClick={() => onChange(null)} aria-label="Remove filter">
        <Trash2 size={12} />
      </button>
    </div>
    </div>
  );
}
