import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { FileText, CheckSquare, Search } from 'lucide-react';
import { db } from './db';
import { createStore, useStore } from './store';
import { cn } from './utils';

export const paletteStore = createStore(false);

interface Hit {
  kind: 'page' | 'task';
  id: string;
  title: string;
  subtitle: string;
}

export function CommandPalette() {
  const open = useStore(paletteStore);
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const pages = useLiveQuery(() => db.pages.toArray(), [], []) ?? [];
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], []) ?? [];

  const hits = useMemo<Hit[]>(() => {
    const q = query.trim().toLowerCase();
    const all: Hit[] = [
      ...pages
        .filter((p) => !p.deleted)
        .map((p) => ({ kind: 'page' as const, id: p.id, title: String(p.title ?? 'Untitled'), subtitle: `${String(p.icon ?? '')} Page` })),
      ...tasks
        .filter((t) => !t.deleted)
        .map((t) => ({ kind: 'task' as const, id: t.id, title: String(t.title ?? ''), subtitle: `Task · ${String(t.status ?? '').replace('_', ' ')}` })),
    ];
    const filtered = q ? all.filter((h) => h.title.toLowerCase().includes(q)) : all;
    return filtered.slice(0, 12);
  }, [pages, tasks, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => setIndex(0), [query]);

  if (!open) return null;

  const go = (hit: Hit) => {
    paletteStore.set(false);
    navigate(hit.kind === 'page' ? `/pages/${hit.id}` : `/tasks/${hit.id}`);
  };

  return (
    <div className="anim-fade fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" onMouseDown={() => paletteStore.set(false)}>
      <div
        className="anim-slide-up mx-auto mt-[12vh] w-full max-w-lg overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900"
        onMouseDown={(e) => e.stopPropagation()}
        style={{ margin: '12vh 1rem auto' }}
      >
        <div className="flex items-center gap-2.5 border-b border-neutral-100 px-4 dark:border-neutral-800">
          <Search size={16} className="text-neutral-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, hits.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
              else if (e.key === 'Enter' && hits[index]) go(hits[index]);
              else if (e.key === 'Escape') paletteStore.set(false);
            }}
            placeholder="Search pages and tasks…"
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-neutral-400"
          />
          <kbd className="rounded border border-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-400 dark:border-neutral-700">esc</kbd>
        </div>
        <div className="max-h-80 overflow-y-auto p-1.5">
          {hits.length === 0 && <p className="px-3 py-6 text-center text-sm text-neutral-400">No results</p>}
          {hits.map((hit, i) => (
            <button
              key={hit.kind + hit.id}
              onMouseDown={(e) => { e.preventDefault(); go(hit); }}
              onMouseEnter={() => setIndex(i)}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left',
                i === index && 'bg-neutral-100 dark:bg-neutral-800',
              )}
            >
              {hit.kind === 'page' ? (
                <FileText size={15} className="shrink-0 text-neutral-400" />
              ) : (
                <CheckSquare size={15} className="shrink-0 text-neutral-400" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm">{hit.title || 'Untitled'}</span>
              <span className="shrink-0 text-xs text-neutral-400">{hit.subtitle}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
