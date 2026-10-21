import { useMemo, useState } from 'react';
import { BringToFront, SendToBack, Spline, Trash2, X } from 'lucide-react';
import { mutate } from '../../core/sync/engine';
import { Input, Select } from '../../core/ui';
import { cardRef, removeItem, type MoodItem } from './api';

const typeLabel = (i: MoodItem) => {
  if (i.type === 'connector') return `connector`;
  return i.type;
};

const itemTitle = (i: MoodItem) => {
  const t = String(i.title ?? i.text ?? i.label ?? '').trim();
  if (t) return t.slice(0, 40);
  const ref = cardRef(i);
  if (ref) return `${ref.type} ${ref.id.slice(0, 6)}`;
  return `${i.type} ${i.id.slice(0, 6)}`;
};

interface Props {
  items: MoodItem[];
  frames: MoodItem[];
  sel: ReadonlySet<string>;
  onSel: (s: ReadonlySet<string>) => void;
  onFocus: (item: MoodItem) => void;
  onClose: () => void;
  boardId?: string;
  onConnect: (from: string, to: string) => void;
}

/** Pointer-free inventory of every item: focus, nudge, resize, frame,
 * connect, z-order, delete — all as buttons (design §3.4). */
export function ItemList({ items, frames, sel, onSel, onFocus, onClose, onConnect }: Props) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'z' | 'type' | 'name'>('z');
  const [connectFrom, setConnectFrom] = useState<string | null>(null);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = items.filter((i) => !s || itemTitle(i).toLowerCase().includes(s) || i.type.includes(s));
    list.sort((a, b) => {
      if (sort === 'z') return Number(a.z ?? 0) - Number(b.z ?? 0);
      if (sort === 'type') return a.type.localeCompare(b.type) || itemTitle(a).localeCompare(itemTitle(b));
      return itemTitle(a).localeCompare(itemTitle(b));
    });
    return list;
  }, [items, q, sort]);

  const nudge = (i: MoodItem, dx: number, dy: number) => void mutate('mooditems', i.id, { x: Number(i.x ?? 0) + dx, y: Number(i.y ?? 0) + dy });
  const resize = (i: MoodItem, f: number) =>
    void mutate('mooditems', i.id, { w: Math.max(10, Number(i.w ?? 100) * f), h: Math.max(10, Number(i.h ?? 100) * f) });
  const z = (i: MoodItem, dir: 1 | -1) => void mutate('mooditems', i.id, { z: Number(i.z ?? 0) + dir });
  const zEdge = (i: MoodItem, dir: 'front' | 'back') => {
    const zs = items.map((x) => Number(x.z ?? 0));
    void mutate('mooditems', i.id, { z: dir === 'front' ? Math.max(0, ...zs) + 1 : Math.min(0, ...zs) - 1 });
  };

  const pickConnect = (i: MoodItem) => {
    if (!connectFrom) setConnectFrom(i.id);
    else if (connectFrom !== i.id) {
      onConnect(connectFrom, i.id);
      setConnectFrom(null);
    } else setConnectFrom(null);
  };

  const ob = 'rounded border border-neutral-200 px-1 py-0.5 text-[10px] hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800';

  return (
    <div className="absolute left-3 top-3 z-20 flex max-h-[calc(100%-6rem)] w-80 flex-col rounded-2xl border border-neutral-200/80 bg-white/95 shadow-lg backdrop-blur dark:border-neutral-700 dark:bg-neutral-900/95" data-testid="mood-itemlist">
      <div className="flex items-center gap-2 border-b border-neutral-100 p-2 dark:border-neutral-800">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter items…" className="h-8 flex-1 text-xs" aria-label="Filter items" />
        <Select value={sort} onChange={(e) => setSort(e.target.value as 'z' | 'type' | 'name')} className="h-8 w-24 text-xs" aria-label="Sort items">
          <option value="z">By z</option>
          <option value="type">By type</option>
          <option value="name">By name</option>
        </Select>
        <button className="rounded p-1 hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={onClose} aria-label="Close item list">
          <X size={14} />
        </button>
      </div>
      {connectFrom && <p className="bg-emerald-50 px-3 py-1 text-[11px] text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">Connect: pick the second item</p>}
      <div role="listbox" aria-label="Canvas items" aria-multiselectable className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {shown.length === 0 && <p className="p-3 text-sm text-neutral-400">No items.</p>}
        {shown.map((i) => (
          <div key={i.id} role="option" aria-selected={sel.has(i.id)} className={`mb-1 rounded-lg border p-1.5 ${sel.has(i.id) ? 'border-blue-400 bg-blue-50/60 dark:border-blue-600 dark:bg-blue-950/40' : 'border-neutral-200 dark:border-neutral-800'}`}>
            <button
              className="flex w-full items-center gap-2 text-left"
              onClick={(e) => {
                if (connectFrom) {
                  pickConnect(i);
                  return;
                }
                const next = new Set(e.shiftKey || e.metaKey || e.ctrlKey ? sel : []);
                if ((e.shiftKey || e.metaKey || e.ctrlKey) && next.has(i.id)) next.delete(i.id);
                else next.add(i.id);
                onSel(next);
                onFocus(i);
              }}
            >
              <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">{typeLabel(i)}</span>
              <span className="min-w-0 flex-1 truncate text-xs">{itemTitle(i)}</span>
            </button>
            <div className="mt-1 flex flex-wrap gap-1">
              <button className={ob} title="Nudge left" aria-label="Nudge left" onClick={() => nudge(i, -10, 0)}>←</button>
              <button className={ob} title="Nudge up" aria-label="Nudge up" onClick={() => nudge(i, 0, -10)}>↑</button>
              <button className={ob} title="Nudge down" aria-label="Nudge down" onClick={() => nudge(i, 0, 10)}>↓</button>
              <button className={ob} title="Nudge right" aria-label="Nudge right" onClick={() => nudge(i, 10, 0)}>→</button>
              <button className={ob} title="Shrink 10%" onClick={() => resize(i, 0.9)}>−</button>
              <button className={ob} title="Grow 10%" onClick={() => resize(i, 1.1)}>+</button>
              <button className={ob} title="Bring to front" onClick={() => zEdge(i, 'front')}><BringToFront size={11} /></button>
              <button className={ob} title="Send to back" onClick={() => zEdge(i, 'back')}><SendToBack size={11} /></button>
              <button className={ob} title="Reorder z -1" onClick={() => z(i, -1)}>z−</button>
              <button className={ob} title="Reorder z +1" onClick={() => z(i, 1)}>z+</button>
              {i.type !== 'frame' && i.type !== 'connector' && (
                <select
                  className={ob}
                  value={String(i.parentFrameId ?? '')}
                  title="Frame membership"
                  onChange={(e) => void mutate('mooditems', i.id, { parentFrameId: e.target.value || null })}
                >
                  <option value="">unframed</option>
                  {frames.map((f) => (
                    <option key={f.id} value={f.id}>
                      {String(f.title ?? 'frame')}
                    </option>
                  ))}
                </select>
              )}
              {i.type !== 'connector' && (
                <button className={ob} title={connectFrom === i.id ? 'Cancel connect' : 'Connect from here'} onClick={() => pickConnect(i)}>
                  <Spline size={11} />
                </button>
              )}
              <button className={`${ob} text-red-500`} title="Delete" onClick={() => void removeItem(i)}>
                <Trash2 size={11} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="border-t border-neutral-100 p-1.5 text-right text-[10px] text-neutral-400 dark:border-neutral-800">
        {items.length} item{items.length === 1 ? '' : 's'} · {sel.size} selected
      </div>
    </div>
  );
}
