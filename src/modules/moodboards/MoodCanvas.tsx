import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate, useParams } from 'react-router';
import { Copy, Image as ImageIcon, Minus, Maximize, Paintbrush, Plus, SquareCheck, StickyNote, Trash2, Type, Wand2 } from 'lucide-react';
import { db } from '../../core/db';
import { addFile, useFileUrl } from '../../core/files';
import { useIsMobile } from '../../core/mobile';
import { PresenceStack } from '../../core/presence';
import { mutate } from '../../core/sync/engine';
import { Popover } from '../../core/ui';
import { cn } from '../../core/utils';
import { modules } from '..';
import { Slot } from '../slots';
import { createTask, firstColumnId, useBoards, type BoardRow } from '../boards/api';
import { NOTE_COLORS, addMoodItem, useMoodItems, type MoodItem } from './api';
import { paletteFromPixels } from './palette';

interface View {
  x: number;
  y: number;
  z: number;
}

const clampZ = (z: number) => Math.min(4, Math.max(0.1, z));

interface DragGeom {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function MoodCanvas() {
  const { boardId = '' } = useParams();
  const mobile = useIsMobile();
  const nav = useNavigate();
  const board = useLiveQuery(() => db.moodboards.get(boardId), [boardId]);
  const items = useMoodItems(boardId);
  const boards = useBoards();
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, z: 1 });
  const [sel, setSel] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DragGeom>>({});
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<
    | { kind: 'pan'; startX: number; startY: number; vx: number; vy: number }
    | { kind: 'pinch'; d0: number; mx: number; my: number; z0: number; vx: number; vy: number }
    | { kind: 'move'; id: string; startX: number; startY: number; orig: DragGeom }
    | { kind: 'resize'; id: string; startX: number; startY: number; orig: DragGeom; aspect: number | null }
    | null
  >(null);
  const [noteColor, setNoteColor] = useState(0);
  const [swatchColor, setSwatchColor] = useState('#a5b4fc');
  const [taskPicker, setTaskPicker] = useState(false);

  const maxZ = useMemo(() => Math.max(0, ...items.map((i) => Number(i.z ?? 0))), [items]);
  const selItem = items.find((i) => i.id === sel);

  // ---------- wheel: ctrl/pinch zoom (toward cursor), plain wheel pans ----------
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setView((v) => {
        if (e.ctrlKey || e.metaKey) {
          const r = el.getBoundingClientRect();
          const px = e.clientX - r.left;
          const py = e.clientY - r.top;
          const z = clampZ(v.z * Math.exp(-e.deltaY * 0.0022));
          return { z, x: px - ((px - v.x) / v.z) * z, y: py - ((py - v.y) / v.z) * z };
        }
        return { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ---------- canvas-level pointer: pan (1 pointer) / pinch (2 pointers) ----------
  const onBackdropDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = {
        kind: 'pinch',
        d0: Math.hypot(b.x - a.x, b.y - a.y) || 1,
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
        z0: view.z,
        vx: view.x,
        vy: view.y,
      };
    } else if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.canvas === 'bg') {
      gesture.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, vx: view.x, vy: view.y };
      setSel(null);
    }
  };

  const onCanvasMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      setView(() => {
        const z = clampZ(g.z0 * (d / g.d0));
        const r = ref.current!.getBoundingClientRect();
        // Keep the pinch midpoint anchored: world point under midpoint stays fixed.
        const wx = (g.mx - r.left - g.vx) / g.z0;
        const wy = (g.my - r.top - g.vy) / g.z0;
        return { z, x: mx - r.left - wx * z, y: my - r.top - wy * z };
      });
    } else if (g.kind === 'pan') {
      setView((v) => ({ ...v, x: g.vx + e.clientX - g.startX, y: g.vy + e.clientY - g.startY }));
    } else if (g.kind === 'move' || g.kind === 'resize') {
      const dx = (e.clientX - g.startX) / view.z;
      const dy = (e.clientY - g.startY) / view.z;
      setDrafts((d) => {
        const o = g.orig;
        let next: DragGeom;
        if (g.kind === 'move') {
          next = { ...o, x: o.x + dx, y: o.y + dy };
        } else {
          const w = Math.max(40, o.w + dx);
          next = { ...o, w, h: g.aspect ? Math.max(30, w / g.aspect) : Math.max(30, o.h + dy) };
        }
        return { ...d, [g.id]: next };
      });
    }
  };

  const endGesture = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (g && (g.kind === 'move' || g.kind === 'resize')) {
      setDrafts((d) => {
        const final = d[g.id];
        if (final) {
          // Single commit at gesture end — never mid-drag.
          void mutate('mooditems', g.id, { x: final.x, y: final.y, w: final.w, h: final.h });
        }
        const next = { ...d };
        delete next[g.id];
        return next;
      });
    }
    if (pointers.current.size < 2 && g?.kind === 'pinch') gesture.current = null;
    else if (pointers.current.size === 0) gesture.current = null;
  };

  // ---------- add items ----------
  const center = () => {
    const r = ref.current!.getBoundingClientRect();
    return { x: (r.width / 2 - view.x) / view.z, y: (r.height / 2 - view.y) / view.z };
  };

  const addImages = useCallback(
    async (files: File[]) => {
      let i = 0;
      for (const f of files) {
        const c = center();
        const id = await addMoodItem(boardId, { type: 'image', x: c.x - 160 + i * 24, y: c.y - 120 + i * 24, w: 320, h: 213 });
        const fileId = await addFile(f, { parentType: 'mooditem', parentId: id, name: f.name });
        const meta = await db.files.get(fileId);
        const w = Number(meta?.width ?? 320);
        const h = Number(meta?.height ?? 213);
        const scale = Math.min(1, 360 / Math.max(w, 1));
        await mutate('mooditems', id, { fileId, w: Math.max(80, w * scale), h: Math.max(60, h * scale) });
        i += 1;
      }
    },
    [boardId, view],
  );

  const addNote = async () => {
    const c = center();
    const id = await addMoodItem(boardId, { type: 'note', x: c.x - 110, y: c.y - 80, w: 220, h: 160, color: NOTE_COLORS[noteColor % NOTE_COLORS.length], text: '' });
    setNoteColor((n) => n + 1);
    setSel(id);
    setEditing(id);
  };

  const addText = async () => {
    const c = center();
    const id = await addMoodItem(boardId, { type: 'text', x: c.x - 200, y: c.y - 30, w: 400, h: 60, text: 'Heading' });
    setSel(id);
    setEditing(id);
  };

  const addColor = async (color: string) => {
    const c = center();
    const id = await addMoodItem(boardId, { type: 'color', x: c.x - 60, y: c.y - 40, w: 120, h: 80, color });
    setSel(id);
  };

  // paste + drop images onto the canvas
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) {
        e.preventDefault();
        void addImages(files);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addImages]);

  const fit = () => {
    if (items.length === 0 || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const xs = items.map((i) => Number(i.x ?? 0));
    const ys = items.map((i) => Number(i.y ?? 0));
    const xe = items.map((i) => Number(i.x ?? 0) + Number(i.w ?? 100));
    const ye = items.map((i) => Number(i.y ?? 0) + Number(i.h ?? 100));
    const bw = Math.max(1, Math.max(...xe) - Math.min(...xs));
    const bh = Math.max(1, Math.max(...ye) - Math.min(...ys));
    const z = clampZ(Math.min((r.width - 80) / bw, (r.height - 80) / bh, 2));
    setView({ z, x: r.width / 2 - (Math.min(...xs) + bw / 2) * z, y: r.height / 2 - (Math.min(...ys) + bh / 2) * z });
  };

  const selectItem = (item: MoodItem) => {
    setSel(item.id);
    // Bring to front on select — one write per selection.
    if (Number(item.z ?? 0) < maxZ) void mutate('mooditems', item.id, { z: maxZ + 1 });
  };

  const itemDown = (item: MoodItem, e: React.PointerEvent) => {
    e.stopPropagation();
    if (e.button !== undefined && e.button > 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const g = { x: Number(item.x ?? 0), y: Number(item.y ?? 0), w: Number(item.w ?? 100), h: Number(item.h ?? 100) };
    gesture.current = { kind: 'move', id: item.id, startX: e.clientX, startY: e.clientY, orig: g };
    // Selection (and its z-bump) happens on click — not on drag start — so
    // simple drags never write to the outbox until drop.
    setSel(item.id);
  };

  const itemClick = (item: MoodItem, e: React.MouseEvent) => {
    e.stopPropagation();
    selectItem(item);
  };

  const resizeDown = (item: MoodItem, e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const g = { x: Number(item.x ?? 0), y: Number(item.y ?? 0), w: Number(item.w ?? 100), h: Number(item.h ?? 100) };
    gesture.current = {
      kind: 'resize',
      id: item.id,
      startX: e.clientX,
      startY: e.clientY,
      orig: g,
      aspect: item.type === 'image' ? g.w / Math.max(1, g.h) : null,
    };
  };

  const duplicate = async (item: MoodItem) => {
    const id = await addMoodItem(boardId, {
      type: item.type,
      x: Number(item.x ?? 0) + 24,
      y: Number(item.y ?? 0) + 24,
      w: item.w,
      h: item.h,
      fileId: item.fileId,
      text: item.text,
      color: item.color,
    });
    setSel(id);
  };

  const remove = (item: MoodItem) => {
    void mutate('mooditems', item.id, { deleted: true });
    setSel(null);
  };

  const extractPalette = async (item: MoodItem) => {
    const blobRow = item.fileId ? await db.blobs.get(item.fileId) : undefined;
    let url: string | undefined;
    if (blobRow?.blob) url = URL.createObjectURL(blobRow.blob);
    else if (item.fileId) {
      // fetch via the file endpoint (bearer needed → reuse useFileUrl path is hook-only; fetch manually)
      const token = localStorage.getItem('ws_token');
      const res = await fetch(`/api/files/${item.fileId}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (res.ok) url = URL.createObjectURL(await res.blob());
    }
    if (!url) return;
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => {});
    const c = document.createElement('canvas');
    const s = Math.min(1, 48 / Math.max(img.width, img.height, 1));
    c.width = Math.max(1, Math.round(img.width * s));
    c.height = Math.max(1, Math.round(img.height * s));
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    URL.revokeObjectURL(url);
    const colors = paletteFromPixels(data, 5);
    const x0 = Number(item.x ?? 0) + Number(item.w ?? 200) + 16;
    for (let i = 0; i < colors.length; i++) {
      await addMoodItem(boardId, { type: 'color', x: x0, y: Number(item.y ?? 0) + i * 56, w: 96, h: 44, color: colors[i] });
    }
  };

  const makeTask = async (boardRow: BoardRow) => {
    if (!selItem) return;
    const col = firstColumnId(boardRow);
    const title = String(selItem.text ?? '').trim() || `From ${String(board?.title ?? 'moodboard')}`;
    const taskId = await createTask(boardRow.id, col, {
      title,
      ...(selItem.fileId ? { coverFileId: selItem.fileId } : {}),
    });
    await mutate('mooditems', selItem.id, { taskId });
    setTaskPicker(false);
  };

  const toolBtn = 'flex h-9 w-9 items-center justify-center rounded-lg text-neutral-600 transition-colors hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800';

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-200/70 px-4 py-2.5 dark:border-neutral-800/70">
        <span className="text-lg leading-none">{String(board?.icon ?? '🎨')}</span>
        <input
          className="min-w-0 flex-1 bg-transparent text-base font-semibold outline-none"
          value={String(board?.title ?? '')}
          placeholder="Untitled board"
          onChange={(e) => void mutate('moodboards', boardId, { title: e.target.value })}
        />
        <PresenceStack path={`/moodboards/${boardId}`} />
      </div>

      <div
        ref={ref}
        className="relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-neutral-50 dark:bg-neutral-950"
        style={{ backgroundImage: 'radial-gradient(circle, rgba(0,0,0,0.10) 1px, transparent 1px)', backgroundSize: '24px 24px' }}
        onPointerDown={onBackdropDown}
        onPointerMove={onCanvasMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
          if (files.length) void addImages(files);
        }}
        data-testid="mood-canvas"
      >
        <div data-canvas="bg" className="absolute inset-0" />

        {/* world layer */}
        <div className="absolute left-0 top-0" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`, transformOrigin: '0 0' }}>
          {items.map((item) => (
            <MoodItemView
              key={item.id}
              item={item}
              draft={drafts[item.id]}
              selected={sel === item.id}
              editing={editing === item.id}
              onDown={(e) => itemDown(item, e)}
              onClick={(e) => itemClick(item, e)}
              onResizeDown={(e) => resizeDown(item, e)}
              onEdit={() => setEditing(item.id)}
              onCommitText={(text) => {
                setEditing(null);
                void mutate('mooditems', item.id, { text });
              }}
              onOpenTask={() => {
                void db.tasks.get(String(item.taskId)).then((t) => {
                  if (t) nav(`/boards/${String(t.boardId ?? 'board-default')}/tasks/${t.id}`);
                });
              }}
            />
          ))}
        </div>

        {/* toolbar */}
        <div
          className={cn(
            'absolute left-1/2 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-2xl border border-neutral-200/80 bg-white/95 px-1.5 py-1 shadow-lg backdrop-blur dark:border-neutral-700 dark:bg-neutral-900/95',
            mobile ? 'bottom-[calc(4.75rem+env(safe-area-inset-bottom))]' : 'top-3',
          )}
          data-testid="mood-toolbar"
        >
          <label className={toolBtn} title="Add image(s)">
            <ImageIcon size={17} />
            <input
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = '';
                if (files.length) void addImages(files);
              }}
            />
          </label>
          <button className={toolBtn} title="Sticky note" onClick={() => void addNote()}>
            <StickyNote size={17} />
          </button>
          <button className={toolBtn} title="Text" onClick={() => void addText()}>
            <Type size={17} />
          </button>
          <Popover
            align="center"
            trigger={
              <button className={toolBtn} title="Color swatch">
                <Paintbrush size={17} />
              </button>
            }
          >
            {(close) => (
              <div className="flex w-56 items-center gap-2 p-3">
                <input type="color" value={swatchColor} onChange={(e) => setSwatchColor(e.target.value)} className="h-8 w-10 cursor-pointer rounded border-0 bg-transparent" />
                <input
                  value={swatchColor}
                  onChange={(e) => setSwatchColor(e.target.value)}
                  className="w-24 rounded-md border border-neutral-200 px-2 py-1 font-mono text-xs dark:border-neutral-700"
                  placeholder="#a5b4fc"
                />
                <button
                  className="rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white dark:bg-white dark:text-neutral-900"
                  onClick={() => {
                    close();
                    void addColor(swatchColor);
                  }}
                >
                  Add
                </button>
              </div>
            )}
          </Popover>

          <span className="mx-0.5 h-5 w-px bg-neutral-200 dark:bg-neutral-700" />
          <button className={toolBtn} title="Zoom out" onClick={() => setView((v) => ({ ...v, z: clampZ(v.z / 1.25) }))}>
            <Minus size={15} />
          </button>
          <button className={toolBtn} title="Zoom in" onClick={() => setView((v) => ({ ...v, z: clampZ(v.z * 1.25) }))}>
            <Plus size={15} />
          </button>
          <button className={toolBtn} title="Fit to content" onClick={fit}>
            <Maximize size={15} />
          </button>

          {selItem && (
            <>
              <span className="mx-0.5 h-5 w-px bg-neutral-200 dark:bg-neutral-700" />
              {selItem.type === 'image' && selItem.fileId && (
                <button className={toolBtn} title="Extract palette" onClick={() => void extractPalette(selItem)}>
                  <Wand2 size={16} />
                </button>
              )}
              <Popover
                open={taskPicker}
                onOpenChange={setTaskPicker}
                align="center"
                trigger={
                  <button className={toolBtn} title="Make task">
                    <SquareCheck size={16} />
                  </button>
                }
              >
                {(close) => (
                  <div className="w-56 p-1.5">
                    <p className="px-2 py-1 text-xs font-semibold text-neutral-400">Make task in…</p>
                    {boards.map((b) => (
                      <button
                        key={b.id}
                        className="w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
                        onClick={() => {
                          close();
                          void makeTask(b as BoardRow);
                        }}
                      >
                        {String(b.icon ?? '')} {String(b.name ?? 'Board')}
                      </button>
                    ))}
                  </div>
                )}
              </Popover>
              <button className={toolBtn} title="Duplicate" onClick={() => void duplicate(selItem)}>
                <Copy size={15} />
              </button>
              <button className={cn(toolBtn, 'text-red-500 hover:bg-red-50 dark:hover:bg-red-950')} title="Delete" onClick={() => remove(selItem)}>
                <Trash2 size={15} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------

function MoodItemView({
  item,
  draft,
  selected,
  editing,
  onDown,
  onClick,
  onResizeDown,
  onEdit,
  onCommitText,
  onOpenTask,
}: {
  item: MoodItem;
  draft?: DragGeom;
  selected: boolean;
  editing: boolean;
  onDown: (e: React.PointerEvent) => void;
  onClick: (e: React.MouseEvent) => void;
  onResizeDown: (e: React.PointerEvent) => void;
  onEdit: () => void;
  onCommitText: (text: string) => void;
  onOpenTask: () => void;
}) {
  const g = draft ?? { x: Number(item.x ?? 0), y: Number(item.y ?? 0), w: Number(item.w ?? 100), h: Number(item.h ?? 100) };
  const [text, setText] = useState(String(item.text ?? ''));

  return (
    <div
      data-mooditem={item.id}
      className={cn('absolute', selected && 'z-10')}
      style={{ left: g.x, top: g.y, width: g.w, height: g.h, zIndex: Number(item.z ?? 0) }}
      onPointerDown={onDown}
      onClick={onClick}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (item.type === 'note' || item.type === 'text') onEdit();
      }}
    >
      <div
        className={cn(
          'h-full w-full overflow-hidden transition-shadow',
          item.type === 'image' && 'rounded-xl bg-white shadow-sm dark:bg-neutral-900',
          item.type === 'note' && 'rounded-lg shadow-md',
          item.type === 'color' && 'rounded-lg shadow-sm',
          selected && 'ring-2 ring-blue-500',
        )}
        style={item.type === 'note' || item.type === 'color' ? { backgroundColor: String(item.color ?? '#fef3c7') } : undefined}
      >
        {item.type === 'image' && item.fileId && <MoodImage fileId={String(item.fileId)} />}
        {item.type === 'note' &&
          (editing ? (
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={() => onCommitText(text)}
              onKeyDown={(e) => e.key === 'Escape' && onCommitText(text)}
              className="h-full w-full resize-none bg-transparent p-3 text-sm text-neutral-800 outline-none"
              placeholder="Write a note…"
              onPointerDown={(e) => e.stopPropagation()}
            />
          ) : (
            <div className="h-full w-full overflow-hidden p-3 text-sm whitespace-pre-wrap text-neutral-800">{String(item.text ?? '') || <span className="text-neutral-400">Note…</span>}</div>
          ))}
        {item.type === 'text' &&
          (editing ? (
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={() => onCommitText(text)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') onCommitText(text);
              }}
              className="h-full w-full bg-transparent px-1 text-4xl font-bold text-neutral-900 outline-none dark:text-white"
              onPointerDown={(e) => e.stopPropagation()}
            />
          ) : (
            <div className="flex h-full items-center px-1 text-4xl font-bold tracking-tight text-neutral-900 dark:text-white" style={{ fontSize: Math.min(48, g.h * 0.6) }}>
              {String(item.text ?? '')}
            </div>
          ))}
        {item.type === 'color' && (
          <div className="flex h-full w-full items-end justify-end p-1.5">
            <span className="rounded bg-white/70 px-1 font-mono text-[10px] text-neutral-700">{String(item.color ?? '')}</span>
          </div>
        )}
      </div>

      {/* badges */}
      {item.taskId && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpenTask();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute -top-2 right-8 z-10 flex items-center gap-1 rounded-full bg-blue-600 px-1.5 py-0.5 text-[9px] font-semibold text-white shadow"
          title="Open linked task"
        >
          <SquareCheck size={9} /> Task
        </button>
      )}
      <span className="absolute -top-2 -right-1 z-10" onPointerDown={(e) => e.stopPropagation()}>
        <Slot modules={modules} kind="commentBadge" props={{ targetType: 'mooditem', targetId: item.id, overlay: true }} />
      </span>

      {selected && (
        <span
          className="absolute -bottom-1.5 -right-1.5 z-20 h-3.5 w-3.5 cursor-nwse-resize rounded-full border-2 border-white bg-blue-500 shadow"
          onPointerDown={onResizeDown}
          data-testid="resize-handle"
        />
      )}
    </div>
  );
}

function MoodImage({ fileId }: { fileId: string }) {
  const { url, missing, failed } = useFileUrl(fileId);
  if (!url) {
    return <div className={cn('flex h-full w-full items-center justify-center text-xs text-neutral-400', failed ? 'text-red-400' : '')}>{missing ? 'Uploading…' : 'Image unavailable'}</div>;
  }
  return <img src={url} alt="" className="h-full w-full rounded-xl object-cover" draggable={false} />;
}
