import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ChevronRight, Plus, FileText, Trash2, FilePlus2 } from 'lucide-react';
import { IconButton, Menu, Popover } from '../../core/ui';
import { cn } from '../../core/utils';
import { createPage, deletePage, usePages, visiblePages, type PageRow } from './api';

export function PagesTree() {
  const pages = usePages();
  const navigate = useNavigate();
  const { pageId } = useParams();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const visible = useMemo(() => visiblePages(pages), [pages]);
  const childrenOf = useMemo(() => {
    const map = new Map<string | null, PageRow[]>();
    for (const p of visible) {
      const key = (p.parentId as string | null) ?? null;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    for (const list of map.values()) list.sort((a, b) => String(a.order).localeCompare(String(b.order)));
    return map;
  }, [visible]);

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
        <IconButton
          className="h-5 w-5"
          aria-label="New page"
          onClick={async () => {
            const id = await createPage(null);
            navigate(`/pages/${id}`);
          }}
        >
          <Plus size={14} />
        </IconButton>
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
    </div>
  );
}
