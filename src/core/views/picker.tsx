/**
 * Searchable pickers: generic item picker (records/pages) and the relation
 * field editor (chips + popover search + inline create). All writes go
 * through links.ts → mutate().
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { FileText, Plus, Search, X } from 'lucide-react';
import { db } from '../db';
import { Popover } from '../ui';
import { cn } from '../utils';
import { useTokenResolver } from '../resolveMentions';
import { renderPlain } from '../mentions';
import { linkRelation, unlinkRelation, useLinks, relationValues, type LinkRef, type RelationFieldDef } from '../links';
import { recordNoun, taskBoardIdOf, useBoardsLite } from './shared';
import { recordTitle } from '../records';
import type { BoardRow, TaskRow } from '../../modules/boards/api';
import type { PageRow } from '../../modules/pages/api';

export interface PickItem {
  ref: LinkRef;
  title: string;
  /** e.g. database name or 'Page' */
  subtitle: string;
  icon?: string;
  /** whether picking this item would create it (create-inline row) */
  create?: boolean;
}


/**
 * Generic searchable picker popover over workspace items (records across
 * databases and/or pages). `items` are computed by the caller; this renders
 * the trigger + search list.
 */
export function ItemPicker({
  trigger,
  items,
  placeholder = 'Search…',
  onPick,
  onCreate,
  createLabel,
  align = 'left',
}: {
  trigger: ReactNode;
  items: PickItem[];
  placeholder?: string;
  onPick: (item: PickItem) => void;
  onCreate?: (title: string) => void;
  createLabel?: (q: string) => string;
  align?: 'left' | 'right';
}) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? items.filter((i) => i.title.toLowerCase().includes(s)) : items;
  }, [items, q]);
  const canCreate = !!onCreate && q.trim().length > 0;
  const rows = filtered.slice(0, 50);
  const total = rows.length + (canCreate ? 1 : 0);
  return (
    <Popover
      align={align}
      trigger={trigger}
      className="w-64"
      onOpenChange={(o) => {
        if (o) {
          setQ('');
          setIdx(0);
        }
      }}
    >
      {(close) => (
        <div>
          <div className="flex items-center gap-2 border-b border-neutral-100 px-3 py-2 dark:border-neutral-800">
            <Search size={13} className="shrink-0 text-neutral-400" />
            <input
              autoFocus
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setIdx(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setIdx((i) => Math.min(i + 1, total - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setIdx((i) => Math.max(i - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  if (idx < rows.length) {
                    close();
                    onPick(rows[idx]);
                  } else if (canCreate) {
                    close();
                    onCreate!(q.trim());
                  }
                }
              }}
              placeholder={placeholder}
              className="h-7 w-full bg-transparent text-sm outline-none placeholder:text-neutral-400"
              role="combobox"
              aria-expanded="true"
              aria-label={placeholder}
            />
          </div>
          <div className="max-h-60 overflow-y-auto p-1" role="listbox">
            {rows.map((item, i) => (
              <button
                key={`${item.ref.type}:${item.ref.id}`}
                role="option"
                aria-selected={i === idx}
                className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm', i === idx && 'bg-neutral-100 dark:bg-neutral-800')}
                onMouseEnter={() => setIdx(i)}
                onClick={() => {
                  close();
                  onPick(item);
                }}
              >
                <span className="w-4 shrink-0 text-center text-xs">{item.icon ?? (item.ref.type === 'page' ? '📄' : '·')}</span>
                <span className="min-w-0 flex-1 truncate">{item.title || 'Untitled'}</span>
                <span className="shrink-0 truncate text-[10px] text-neutral-400">{item.subtitle}</span>
              </button>
            ))}
            {canCreate && (
              <button
                role="option"
                aria-selected={idx === rows.length}
                className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-blue-600 dark:text-blue-400', idx === rows.length && 'bg-neutral-100 dark:bg-neutral-800')}
                onMouseEnter={() => setIdx(rows.length)}
                onClick={() => {
                  close();
                  onCreate!(q.trim());
                }}
              >
                <Plus size={13} /> <span className="truncate">{createLabel ? createLabel(q.trim()) : `Create "${q.trim()}"`}</span>
              </button>
            )}
            {rows.length === 0 && !canCreate && <p className="px-2 py-3 text-center text-xs text-neutral-400">No matches</p>}
          </div>
        </div>
      )}
    </Popover>
  );
}

/** Chips of linked items that navigate on click. */
export function LinkedChips({ ids, kind, boards, onRemove }: { ids: string[]; kind: 'record' | 'page'; boards: BoardRow[]; onRemove?: (id: string) => void }) {
  const navigate = useNavigate();
  const resolve = useTokenResolver();
  const targets = useLiveQuery(
    async () => {
      const rows: { id: string; title: string; boardId?: string }[] = [];
      for (const id of ids) {
        const t = kind === 'page' ? await db.pages.get(id) : await db.tasks.get(id);
        if (t && !t.deleted) rows.push({ id, title: String(t.title ?? ''), boardId: kind === 'record' ? taskBoardIdOf(t as TaskRow) : undefined });
      }
      return rows;
    },
    [ids.join(','), kind],
    [],
  );
  if (!targets?.length) return null;
  return (
    <>
      {targets.map((t) => {
        const board = t.boardId ? boards.find((b) => b.id === t.boardId) : undefined;
        const href = kind === 'page' ? `/pages/${t.id}` : `/boards/${t.boardId}/tasks/${t.id}`;
        return (
          <span key={t.id} className="inline-flex max-w-44 items-center gap-1 rounded-full bg-neutral-100 py-0.5 pl-2 pr-1 text-[11px] font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300" title={t.title}>
            <button className="min-w-0 truncate hover:underline" onClick={() => navigate(href)}>
              {kind === 'page' ? <FileText size={10} className="mr-0.5 inline" /> : null}
              {renderPlain(t.title || 'Untitled', resolve)}
            </button>
            {board && <span className="text-neutral-400">{String(board.icon ?? '')}</span>}
            {onRemove && (
              <button aria-label={`Unlink ${t.title}`} className="flex h-3.5 w-3.5 items-center justify-center rounded-full opacity-60 hover:opacity-100" onClick={() => onRemove(t.id)}>
                <X size={10} />
              </button>
            )}
          </span>
        );
      })}
    </>
  );
}

/**
 * Relation field editor: chips of linked records/pages + "add" picker over
 * the target database (or pages). `single` replaces on pick.
 */
export function RelationPicker({ record, field }: { record: TaskRow; field: RelationFieldDef }) {
  const links = useLinks();
  const boards = useBoardsLite();
  const pages = useLiveQuery(() => db.pages.toArray(), [], []) as PageRow[] | undefined;
  const targetId = field.relation!.target;
  const targetBoard = boards.find((b) => b.id === targetId);
  const isPages = targetId === 'pages';
  const allTasks = useLiveQuery(() => db.tasks.toArray(), [], []);
  const targetTasks = useMemo(() => (allTasks ?? []).filter((t) => !t.deleted && taskBoardIdOf(t as TaskRow) === targetId), [allTasks, targetId]);
  const resolve = useTokenResolver();

  const values = relationValues(links, record.id, field);
  const missingTarget = !isPages && targetBoard === undefined;

  const items: PickItem[] = useMemo(() => {
    if (isPages) {
      return (pages ?? [])
        .filter((p) => !p.deleted)
        .map((p) => ({ ref: { type: 'page' as const, id: p.id }, title: renderPlain(String(p.title ?? ''), resolve), subtitle: 'Page', icon: String(p.icon ?? '📄') }));
    }
    return ((targetTasks ?? []) as TaskRow[]).map((t) => ({
      ref: { type: 'record' as const, id: t.id },
      title: renderPlain(recordTitle(t), resolve),
      subtitle: recordNoun(targetBoard),
      icon: String(targetBoard?.icon ?? ''),
    }));
  }, [isPages, pages, targetTasks, targetBoard, resolve]);

  const noun = isPages ? 'page' : recordNoun(targetBoard).toLowerCase();

  const pick = async (item: PickItem) => {
    if (field.relation!.single && values.length) {
      await unlinkRelation(record.id, field, values[0]);
    }
    await linkRelation(record.id, field, item.ref);
  };

  const create = async (title: string) => {
    if (isPages) {
      const { createPage } = await import('../../modules/pages/api');
      const id = await createPage(null);
      await pick({ ref: { type: 'page', id }, title, subtitle: 'Page' });
      return;
    }
    const { createRecord } = await import('../records');
    const id = await createRecord(targetId, { title });
    await pick({ ref: { type: 'record', id }, title, subtitle: noun });
  };

  const kind: 'record' | 'page' = isPages ? 'page' : 'record';

  return (
    <div className="flex min-h-[34px] w-full flex-wrap items-center gap-1 rounded-lg border border-neutral-200 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">
      {missingTarget && <span className="text-xs text-red-400">Missing database</span>}
      <LinkedChips ids={values} kind={kind} boards={boards} onRemove={(id) => void unlinkRelation(record.id, field, id)} />
      <ItemPicker
        trigger={
          <button className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300" aria-label={`Link ${field.name}`}>
            <Plus size={11} /> {values.length === 0 ? `Link ${noun}…` : 'Add'}
          </button>
        }
        items={items.filter((i) => !values.includes(i.ref.id))}
        placeholder={`Search ${isPages ? 'pages' : `${noun}s`}…`}
        onPick={(i) => void pick(i)}
        onCreate={missingTarget ? undefined : create}
        createLabel={(q) => `Create "${q}"`}
      />
    </div>
  );
}
