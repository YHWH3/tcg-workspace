import {ReliabilityChip} from '../../core/ReliabilityPanel';
import {MoveSpaceButton} from '../../core/MoveSpace';
import {HistoryButton} from '../../core/History';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, Navigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { Archive, ArchiveRestore, FilePlus2, FileText, LayoutTemplate, MoreHorizontal, Trash2 } from 'lucide-react';
import { db } from '../../core/db';
import { mutate } from '../../core/sync/engine';
import { archivePatch, isArchived } from '../../../shared/archive';
import { IconButton, Menu, Popover, EmptyState } from '../../core/ui';
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

/** Block types that make a page a dashboard (Phase 3 dashboard blocks). */
const DASHBOARD_BLOCKS = new Set(['metric', 'view', 'mywork', 'activity', 'calendar', 'attention', 'projecthealth','budget']);

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
  const debouncedRename = useRef(debounce((id: string, t: string) => void renamePage(id, t), 400));
  const editorRef = useRef<HTMLDivElement>(null);
  const isDashboard = useLiveQuery(
    async () => (pageId ? (await db.blocks.where('pageId').equals(pageId).filter((b) => !b.deleted && DASHBOARD_BLOCKS.has(String(b.type))).count()) > 0 : false),
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
    <div className="mx-auto h-full max-w-3xl overflow-y-auto px-5 pb-16 pt-8 sm:px-8">
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
        className={cn('mb-4 w-full resize-none overflow-hidden bg-transparent text-4xl font-bold tracking-tight outline-none placeholder:text-neutral-300 dark:placeholder:text-neutral-700')}
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
    </div>
  );
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
