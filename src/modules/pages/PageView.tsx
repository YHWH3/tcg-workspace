import {DASHBOARD_BLOCK_TYPES} from '../../../shared/templates';
import {ReliabilityChip} from '../../core/ReliabilityPanel';
import {MoveSpaceButton} from '../../core/MoveSpace';
import {HistoryButton} from '../../core/History';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, Navigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Archive, ArchiveRestore, Download, FilePlus2, FileText, LayoutTemplate, MoreHorizontal, Printer, Trash2 } from 'lucide-react';
import { db } from '../../core/db';
import { mutate } from '../../core/sync/engine';
import { archivePatch, isArchived } from '../../../shared/archive';
import { Dialog, IconButton, Menu, Popover, EmptyState, Button } from '../../core/ui';
import { cn, cmpOrder, debounce } from '../../core/utils';
import { PAGE_ICONS } from '../../core/config';
import { modules } from '..';
import { Slot } from '../slots';
import { PresenceStack } from '../../core/presence';
import { Backlinks } from './Backlinks';
import { SharePopover } from './Share';
import { createPage, deletePage, renamePage, usePages, visiblePages, type PageRow } from './api';
import { BlockEditor } from './BlockEditor';
import { SelectionAskAi } from './SelectionAskAi';
import { AskAiMenu } from '../../core/assistant/AskAiMenu';
import { useAssistantContext } from '../../core/assistant/store';
import { pageToMarkdown } from '../../core/pageExport';
import { fieldsOf, propKey } from '../../../shared/fields';
import { useUsers } from '../../core/users';
import type { BoardRow, TaskRow } from '../boards/api';

export function PagesHome() {
  const pages = usePages();
  const visible = useMemo(() => visiblePages(pages), [pages]);
  const navigate = useNavigate();
  const roots = visible.filter((p) => !p.parentId);
  if (roots.length > 0) {
    const sorted = [...roots].sort((a, b) => cmpOrder(a.order, b.order));
    return <Navigate to={`/pages/${sorted[0].id}`} replace />;
  }
  return (
    <div className="flex h-full items-center justify-center p-6">
      <EmptyState
        icon={FileText}
        title="No pages yet"
        body="Create your first page to start writing."
        action={
          <button
            className="rounded-lg bg-neutral-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900"
            onClick={async () => navigate(`/pages/${await createPage(null)}`)}
          >
            New page
          </button>
        }
      />
    </div>
  );
}

function EmojiPicker({ onPick }: { onPick: (e: string) => void }) {
  return (
    <div className="grid w-56 grid-cols-8 gap-0.5 p-2">
      {PAGE_ICONS.map((e) => (
        <button key={e} className="rounded-md p-1 text-lg hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={() => onPick(e)}>
          {e}
        </button>
      ))}
    </div>
  );
}

export function PageView() {
  const { pageId } = useParams();
  const navigate = useNavigate();
  // Distinguish an unresolved query from an evicted/missing row. Revocation
  // must produce an actionable empty state rather than an endless blank view.
  const page = useLiveQuery(async () => pageId ? (await db.pages.get(pageId)) ?? null : null, [pageId]) as PageRow | null | undefined;
  const [title, setTitle] = useState('');
  const [focused, setFocused] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const debouncedRename = useRef(debounce((id: string, t: string) => void renamePage(id, t), 400));
  const editorRef = useRef<HTMLDivElement>(null);
  const isDashboard = useLiveQuery(
    async () => (pageId ? (await db.blocks.where('pageId').equals(pageId).filter((b) => !b.deleted && DASHBOARD_BLOCK_TYPES.has(String(b.type))).count()) > 0 : false),
    [pageId],
    false,
  );
  useAssistantContext(pageId && page && !page.deleted ? { kind: 'page', id: pageId } : null);

  useEffect(() => {
    if (page && !focused) setTitle(String(page.title ?? ''));
  }, [page?.title, page?.id, focused]);
  // eslint-disable-next-line react-hooks/exhaustive-deps

  if (!pageId) return null;
  if (page === undefined) return <div className="p-8" />;
  if (!page || page.deleted) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState icon={FileText} title="Page not found" body="It may have been deleted." />
      </div>
    );
  }

  return (
    // Preserve ordinary inline margins when text enlarges, leaving room for title words.
    <div className="mx-auto h-full max-w-3xl overflow-y-auto px-[20px] pb-16 pt-8 sm:px-[32px]">
      {!page.parentId&&<ReliabilityChip/>}
      <div className="mb-1 flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1 text-xs text-neutral-400">
          <Breadcrumbs page={page} />
        </div>
        <div className="ms-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1">
          <PresenceStack path={`/pages/${page.id}`} />
          <AskAiMenu
            modules={isDashboard ? ['dashboards', 'pages', 'notes'] : ['pages', 'notes']}
            refs={{ page: { kind: 'page', id: page.id }, dashboard: { kind: 'dashboard' } }}
            primary={{ kind: 'page', id: page.id }}
            compact
          />
          {!page.parentId&&<MoveSpaceButton root={page}/>}<HistoryButton recordId={page.id}/><SharePopover pageId={page.id} />
          <Popover
          align="right"
          trigger={
            <IconButton aria-label="Page menu">
              <MoreHorizontal size={17} />
            </IconButton>
          }
        >
          {(close) => (
            <Menu
              close={close}
              items={[
                {
                  label: 'Add sub-page',
                  icon: FilePlus2,
                  onClick: async () => navigate(`/pages/${await createPage(page.id)}`),
                },
                {
                  label: page.isTemplate ? 'Remove template' : 'Use as template',
                  icon: LayoutTemplate,
                  onClick: () => void mutate('pages', page.id, { isTemplate: !page.isTemplate }),
                },
                {
                  label: 'Export Markdown…',
                  icon: Download,
                  onClick: () => setExportOpen(true),
                },
                {
                  label: 'Print / Save as PDF',
                  icon: Printer,
                  onClick: () => window.print(),
                },
                {
                  label: isArchived(page) ? 'Unarchive' : 'Archive',
                  icon: isArchived(page) ? ArchiveRestore : Archive,
                  onClick: () => void mutate('pages', page.id, archivePatch(!isArchived(page))),
                },
                'divider',
                {
                  label: 'Delete page',
                  icon: Trash2,
                  danger: true,
                  onClick: async () => {
                    await deletePage(page.id);
                    navigate('/');
                  },
                },
              ]}
            />
          )}
          </Popover>
        </div>
      </div>

      {isArchived(page) && (
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-neutral-200/80 bg-neutral-50 px-3 py-2 text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
          <Archive size={13} />
          <span className="flex-1">Archived</span>
          <button className="rounded-md px-2 py-1 font-medium text-neutral-700 hover:bg-neutral-200/70 dark:text-neutral-200 dark:hover:bg-neutral-800" onClick={() => void mutate('pages', page.id, archivePatch(false))}>
            Unarchive
          </button>
        </div>
      )}

      <div className="mb-2 flex items-start gap-2">
        <Popover
          trigger={
            <button className="rounded-lg p-1 text-3xl leading-none transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800" aria-label="Change icon">
              {String(page.icon ?? '📄')}
            </button>
          }
        >
          {(close) => (
            <EmojiPicker
              onPick={(e) => {
                close();
                void mutate('pages', page.id, { icon: e });
              }}
            />
          )}
        </Popover>
      </div>

      <textarea
        value={title}
        rows={1}
        placeholder="Untitled"
        className={cn('mb-4 w-full resize-none overflow-hidden bg-transparent text-4xl font-bold tracking-tight outline-none placeholder:text-neutral-600 dark:placeholder:text-neutral-400')}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          debouncedRename.current.flush(page.id, title);
        }}
        onChange={(e) => {
          setTitle(e.target.value);
          debouncedRename.current(page.id, e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'ArrowDown') {
            e.preventDefault();
            e.currentTarget.blur();
            const first = document.querySelector<HTMLTextAreaElement>('[data-block]');
            if (first) first.focus();
            else document.querySelector<HTMLElement>('[data-placeholder-block]')?.click();
          }
        }}
      />

      <div ref={editorRef}>
        <BlockEditor pageId={page.id} />
      </div>
      <SelectionAskAi pageId={page.id} container={editorRef} />

      <Backlinks pageId={page.id} />
      <Slot modules={modules} kind="pageFooter" props={{ pageId: page.id }} />
      {exportOpen && <PageExportDialog page={page} onClose={() => setExportOpen(false)} />}
    </div>
  );
}

function PageExportDialog({ page, onClose }: { page: PageRow; onClose: () => void }) {
  const [includeSubPages, setIncludeSubPages] = useState(false);
  const pages = (useLiveQuery(() => db.pages.toArray(), [], []) ?? []) as PageRow[];
  const blocks = useLiveQuery(() => db.blocks.toArray(), [], []) ?? [];
  const tasks = (useLiveQuery(() => db.tasks.toArray(), [], []) ?? []) as TaskRow[];
  const boards = (useLiveQuery(() => db.boards.toArray(), [], []) ?? []) as BoardRow[];
  const files = useLiveQuery(() => db.files.toArray(), [], []) ?? [];
  const users = useUsers();
  const markdown = useMemo(() => pageToMarkdown(page, pages.filter((row) => !row.deleted), blocks.filter((row) => !row.deleted) as never[], {
    includeSubPages,
    files: files.filter((row) => !row.deleted) as never[],
    databases: boards.filter((board) => !board.deleted).map((board) => {
      const fields = fieldsOf(board as BoardRow);
      return {
        id: board.id,
        name: String(board.name ?? 'Database'),
        columns: [{ id: 'title', name: 'Title' }, ...(board.columns?.length ? [{ id: 'status', name: 'Stage' }] : []), ...fields.filter((field) => field.type !== 'relation').map((field) => ({ id: propKey(field.id), name: field.name }))],
        records: tasks.filter((task) => !task.deleted && task.boardId === board.id).map((task) => ({ ...task, title: String(task.title ?? '') })),
      };
    }),
    resolvers: {
      userName: (id) => users.find((user) => user.id === id)?.name,
      pageTitle: (id) => pages.find((row) => row.id === id)?.title,
      recordTitle: (id) => { const title = tasks.find((task) => task.id === id)?.title; return title === undefined ? undefined : String(title); },
    },
  }), [blocks, boards, files, includeSubPages, page, pages, tasks, users]);
  const filename = `${String(page.title ?? 'page').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'page'}.md`;
  const download = () => {
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return <Dialog title="Export page" onClose={onClose}>
    <div className="space-y-3">
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={includeSubPages} onChange={(event) => setIncludeSubPages(event.target.checked)} /> Include sub-pages</label>
      <pre aria-label="Markdown preview" className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-xs dark:border-neutral-700 dark:bg-neutral-950">{markdown}</pre>
      <div className="flex flex-wrap justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={download}><Download size={14} /> Download Markdown</Button><Button variant="outline" onClick={() => window.print()}><Printer size={14} /> Print / PDF</Button></div>
    </div>
  </Dialog>;
}

function Breadcrumbs({ page }: { page: PageRow }) {
  const pages = usePages();
  const byId = new Map(pages.map((p) => [p.id, p]));
  const trail: PageRow[] = [];
  let cur: PageRow | undefined = page;
  const seen = new Set<string>();
  while (cur?.parentId) {
    const parent = byId.get(String(cur.parentId));
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    trail.unshift(parent);
    cur = parent;
  }
  if (trail.length === 0) return null;
  return (
    <>
      {trail.map((p) => (
        <span key={p.id} className="flex items-center gap-1">
          <a href={`/pages/${p.id}`} className="hover:text-neutral-600 dark:hover:text-neutral-300">
            {String(p.icon ?? '')} {String(p.title ?? '') || 'Untitled'}
          </a>
          <span>/</span>
        </span>
      ))}
    </>
  );
}
