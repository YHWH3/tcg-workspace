import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Check, ChevronLeft, Database, FileText, Search, X } from 'lucide-react';
import { db, type LocalRow } from '../../core/db';
import { renderPlain } from '../../core/mentions';
import { useTokenResolver } from '../../core/resolveMentions';
import { isRecordsDb, recordNoun } from '../../core/records';
import { IconButton } from '../../core/ui';
import { cn } from '../../core/utils';
import { taskBoardId, type BoardRow, type TaskRow } from './api';
import type { FieldContext } from './fieldMode';

interface Hit {
  id: string;
  kind: 'page' | 'record';
  title: string;
  subtitle: string;
  databaseId?: string;
}

/**
 * Field-context picker — rendered as the capture sheet's content (parent owns
 * the surface). Keyboard-first: type to filter, ↑/↓ to move, Enter to pick,
 * Escape to go back. Selection is stored by the caller in `ws_field_ctx`.
 */
export function ContextPicker({
  current,
  onPick,
  onClose,
}: {
  current: FieldContext | null;
  onPick: (ctx: FieldContext | null) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const pages = useLiveQuery(() => db.pages.toArray(), [], []) ?? [];
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], []) ?? [];
  const boards = useLiveQuery(() => db.boards.toArray(), [], []) ?? [];
  const resolveTokens = useTokenResolver();

  const hits = useMemo<Hit[]>(() => {
    const q = query.trim().toLowerCase();
    const boardById = new Map((boards as BoardRow[]).map((b) => [b.id, b]));
    const all: Hit[] = [];
    for (const p of pages as LocalRow[]) {
      if (p.deleted) continue;
      const title = renderPlain(String(p.title ?? ''), resolveTokens) || 'Untitled';
      all.push({ id: p.id, kind: 'page', title, subtitle: `${String(p.icon ?? '')} Page`.trim() });
    }
    for (const t of tasks as TaskRow[]) {
      if (t.deleted) continue;
      const board = boardById.get(taskBoardId(t));
      const title = renderPlain(String(t.title ?? ''), resolveTokens) || 'Untitled';
      const subtitle = board ? `${String(board.icon ?? '')} ${String(board.name ?? 'Database')} · ${isRecordsDb(board) ? recordNoun(board) : 'Task'}` : 'Record';
      all.push({ id: t.id, kind: 'record', title, subtitle, databaseId: board?.id });
    }
    const filtered = q ? all.filter((h) => h.title.toLowerCase().includes(q) || h.subtitle.toLowerCase().includes(q)) : all;
    return filtered.slice(0, 60);
  }, [pages, tasks, boards, query, resolveTokens]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  // Keep the highlighted row in view while arrow-keying.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="1"]')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const pick = (hit: Hit | null) => {
    onPick(hit ? { id: hit.id, kind: hit.kind, title: hit.title, databaseId: hit.databaseId } : null);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (hits[index]) pick(hits[index]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const isCurrent = (h: Hit) => current?.id === h.id && current.kind === h.kind;

  return (
    <div className="flex h-full min-h-0 flex-col" role="dialog" aria-modal="true" aria-label="Capture context">
      <div className="flex items-center gap-1 border-b border-neutral-100 px-2 py-3 dark:border-neutral-800">
        <IconButton onClick={onClose} aria-label="Back to capture">
          <ChevronLeft size={17} />
        </IconButton>
        <span className="flex-1 text-sm font-semibold">Capture context</span>
        <IconButton onClick={onClose} aria-label="Close context picker">
          <X size={17} />
        </IconButton>
      </div>
      <div className="flex items-center gap-2.5 border-b border-neutral-100 px-4 dark:border-neutral-800">
        <Search size={16} className="shrink-0 text-neutral-400" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder="Search pages and records…"
          aria-label="Search context"
          className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-neutral-400"
        />
        <kbd className="rounded border border-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-400 dark:border-neutral-700">esc</kbd>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5" role="listbox" aria-label="Contexts">
        <button
          type="button"
          role="option"
          aria-selected={!current}
          onClick={() => pick(null)}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-neutral-50 dark:hover:bg-neutral-900"
        >
          <X size={15} className="shrink-0 text-neutral-400" />
          <span className="min-w-0 flex-1 text-sm text-neutral-500 dark:text-neutral-400">No context</span>
          {!current && <Check size={14} className="shrink-0 text-blue-500" />}
        </button>
        {hits.length === 0 && <p className="px-3 py-6 text-center text-sm text-neutral-400">No results — context search covers pages and records already synced to this device.</p>}
        {hits.map((hit, i) => (
          <button
            key={hit.kind + hit.id}
            type="button"
            role="option"
            aria-selected={isCurrent(hit)}
            data-active={i === index ? 1 : undefined}
            onMouseEnter={() => setIndex(i)}
            onClick={() => pick(hit)}
            className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left', i === index && 'bg-neutral-100 dark:bg-neutral-800')}
          >
            {hit.kind === 'page' ? (
              <FileText size={15} className="shrink-0 text-neutral-400" />
            ) : (
              <Database size={15} className="shrink-0 text-neutral-400" />
            )}
            <span className="min-w-0 flex-1 truncate text-sm">{hit.title}</span>
            <span className="shrink-0 truncate text-xs text-neutral-400" style={{ maxWidth: '45%' }}>
              {hit.subtitle}
            </span>
            {isCurrent(hit) && <Check size={14} className="shrink-0 text-blue-500" />}
          </button>
        ))}
      </div>
    </div>
  );
}
