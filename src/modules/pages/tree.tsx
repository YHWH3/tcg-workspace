import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Archive, ArchiveRestore, ChevronRight, FolderInput, LayoutTemplate, Plus, FileText, Trash2, FilePlus2 } from 'lucide-react';
import { AdaptiveDialog, IconButton, Menu, Popover } from '../../core/ui';
import { cn, cmpOrder } from '../../core/utils';
import { mutate } from '../../core/sync/engine';
import { archivePatch, isArchived } from '../../../shared/archive';
import { useBoards } from '../boards/api';
import { createPage, deletePage, instantiateTemplate, movePage, usePages, visiblePages, type PageRow } from './api';

export function PagesTree() {
  const pages = usePages();
  const boards = useBoards();
  const navigate = useNavigate();
  const { pageId } = useParams();
  const [moveTarget, setMoveTarget] = useState<PageRow | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const visible = useMemo(() => visiblePages(pages).filter((p) => !isArchived(p)), [pages]);
  const archivedIds = useMemo(() => new Set(pages.filter((p) => isArchived(p) && !p.deleted).map((p) => p.id)), [pages]);
  const childrenOf = useMemo(() => {
    const map = new Map<string | null, PageRow[]>();
    for (const p of visible) {
      // an archived parent is hidden — re-home its live children at top level
      const raw = (p.parentId as string | null) ?? null;
      const key = raw && archivedIds.has(raw) ? null : raw;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    for (const list of map.values()) list.sort((a, b) => cmpOrder(a.order, b.order));
    return map;
  }, [visible, archivedIds]);

  const archivedPages = useMemo(
    () => pages.filter((p) => isArchived(p) && !p.deleted && (!(p.parentId as string | null) || archivedIds.has(String(p.parentId)))).sort((a, b) => cmpOrder(a.order, b.order)),
    [pages, archivedIds],
  );
  const archivedBoards = useMemo(() => boards.filter((b) => isArchived(b)), [boards]);

  const toggle = (id: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const renderLevel = (parentId: string | null, depth: number) =>
    (childrenOf.get(parentId) ?? []).map((p) => {
      const kids = childrenOf.get(p.id) ?? [];
      const isCollapsed = collapsed.has(p.id);
      return (
        <div key={p.id}>
          <div
            className={cn(
              'group flex items-center gap-0.5 rounded-lg py-1 pr-1 text-sm transition-colors cursor-pointer',
              p.id === pageId ? 'bg-neutral-200/70 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-white' : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800/60 dark:hover:text-neutral-200',
            )}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            onClick={() => navigate(`/pages/${p.id}`)}
          >
            <button
              className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-400 transition-transform hover:bg-neutral-200 dark:hover:bg-neutral-700', !kids.length && 'invisible', !isCollapsed && 'rotate-90')}
              onClick={(e) => {
                e.stopPropagation();
                toggle(p.id);
              }}
              aria-label="Toggle children"
            >
              <ChevronRight size={13} />
            </button>
            <span className="w-5 shrink-0 text-center text-[13px]">{String(p.icon ?? '📄')}</span>
            <span className="min-w-0 flex-1 truncate">{String(p.title ?? '') || 'Untitled'}</span>
            {!!p.isTemplate && <LayoutTemplate size={12} className="shrink-0 text-neutral-400" aria-label="Template" />}
            <span className="hidden shrink-0 items-center group-hover:flex" onClick={(e) => e.stopPropagation()}>
              <Popover
                align="right"
                trigger={
                  <IconButton className="h-6 w-6" aria-label="Page options">
                    <span className="text-sm leading-none">···</span>
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
                        onClick: async () => {
                          const id = await createPage(p.id);
                          navigate(`/pages/${id}`);
                        },
                      },
                      {
                        label: 'Move to…',
                        icon: FolderInput,
                        onClick: () => setMoveTarget(p),
                      },
                      {
                        label: 'Archive',
                        icon: Archive,
                        onClick: () => void mutate('pages', p.id, archivePatch(true)),
                      },
                      'divider',
                      { label: 'Delete', icon: Trash2, danger: true, onClick: () => void deletePage(p.id) },
                    ]}
                  />
                )}
              </Popover>
              <IconButton
                className="h-6 w-6"
                aria-label="Add sub-page"
                onClick={async () => {
                  const id = await createPage(p.id);
                  navigate(`/pages/${id}`);
                }}
              >
                <Plus size={14} />
              </IconButton>
            </span>
          </div>
          {!isCollapsed && kids.length > 0 && renderLevel(p.id, depth + 1)}
        </div>
      );
    });

  return (
    <div className="px-2">
      <div className="mb-1 flex items-center justify-between px-2">
        <span className="text-[11px] font-semibold tracking-wide text-neutral-400 uppercase">Pages</span>
        <Popover
          align="right"
          trigger={
            <IconButton className="h-5 w-5" aria-label="New page">
              <Plus size={14} />
            </IconButton>
          }
        >
          {(close) => (
            <div className="w-44 p-1 text-sm">
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800"
                onClick={async () => {
                  close();
                  const id = await createPage(null);
                  navigate(`/pages/${id}`);
                }}
              >
                <FileText size={13} /> Blank page
              </button>
              {visible.filter((t) => t.isTemplate).map((t) => (
                <button
                  key={t.id}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  onClick={async () => {
                    close();
                    const id = await instantiateTemplate(t.id);
                    if (id) navigate(`/pages/${id}`);
                  }}
                >
                  <span>{String(t.icon ?? '📄')}</span>
                  <span className="truncate">{String(t.title ?? 'Untitled')}</span>
                </button>
              ))}
            </div>
          )}
        </Popover>
      </div>
      {renderLevel(null, 0)}
      {visible.length === 0 && (
        <button
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800/60"
          onClick={async () => {
            const id = await createPage(null);
            navigate(`/pages/${id}`);
          }}
        >
          <FileText size={15} /> New page
        </button>
      )}
      {(archivedPages.length > 0 || archivedBoards.length > 0) && (
        <div className="mt-3 border-t border-neutral-100 pt-2 dark:border-neutral-800">
          <p className="mb-0.5 px-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Archived</p>
          {archivedPages.map((p) => (
            <ArchivedRow key={p.id} icon={String(p.icon ?? '📄')} title={String(p.title ?? '') || 'Untitled'} onOpen={() => navigate(`/pages/${p.id}`)} onUnarchive={() => void mutate('pages', p.id, archivePatch(false))} />
          ))}
          {archivedBoards.map((b) => (
            <ArchivedRow key={b.id} icon={String(b.icon ?? '🗂️')} title={String(b.name ?? 'Board')} onOpen={() => navigate(`/boards/${b.id}`)} onUnarchive={() => void mutate('boards', b.id, archivePatch(false))} />
          ))}
        </div>
      )}
      {moveTarget && <MovePageDialog page={moveTarget} pages={pages} onClose={() => setMoveTarget(null)} />}
    </div>
  );
}

/** Row in the sidebar "Archived" section — unarchive affordance on hover/focus-visible. */
function ArchivedRow({ icon, title, onOpen, onUnarchive }: { icon: string; title: string; onOpen: () => void; onUnarchive: () => void }) {
  return (
    <div className="group flex items-center gap-0.5 rounded-lg py-1 pl-2 pr-1 text-sm text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800/60">
      <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onOpen}>
        <span className="w-5 shrink-0 text-center text-[13px] opacity-60">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </button>
      <IconButton className="h-6 w-6 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100" aria-label={`Unarchive ${title}`} onClick={onUnarchive}>
        <ArchiveRestore size={13} />
      </IconButton>
    </div>
  );
}

/** Parent selector for 'Move to…' — excludes the page itself and its descendants. */
function MovePageDialog({ page, pages, onClose }: { page: PageRow; pages: PageRow[]; onClose: () => void }) {
  const live = useMemo(() => visiblePages(pages), [pages]);
  const excluded = useMemo(() => {
    const out = new Set<string>([page.id]);
    const kids = new Map<string | null, string[]>();
    for (const p of live) {
      const pid = p.parentId ?? null;
      kids.set(pid, [...(kids.get(pid) ?? []), p.id]);
    }
    const queue = [...(kids.get(page.id) ?? [])];
    while (queue.length) {
      const id = queue.shift()!;
      out.add(id);
      queue.push(...(kids.get(id) ?? []));
    }
    return out;
  }, [live, page.id]);
  const candidates = live.filter((p) => !excluded.has(p.id) && !p.isTemplate);
  const move = async (parentId: string | null) => {
    await movePage(page.id, parentId);
    onClose();
  };
  return (
    <AdaptiveDialog title="Move page" onClose={onClose}>
      <div className="max-h-[50vh] overflow-y-auto">
        <button className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800" onClick={() => void move(null)}>
          <FileText size={14} className="text-neutral-400" /> Top level
        </button>
        {candidates.map((p) => (
          <button key={p.id} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800" onClick={() => void move(p.id)}>
            <span className="w-4 text-center text-[13px]">{String(p.icon ?? '📄')}</span>
            <span className="min-w-0 flex-1 truncate">{String(p.title ?? '') || 'Untitled'}</span>
          </button>
        ))}
        {!candidates.length && <p className="px-2.5 py-2 text-xs text-neutral-400">No other pages.</p>}
      </div>
    </AdaptiveDialog>
  );
}
