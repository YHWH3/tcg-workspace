import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate, useParams } from 'react-router';
import {
  Copy, Hand, List, Maximize, Minus, MousePointer2, Plus, SlidersHorizontal, Spline, SquareCheck, Trash2, Wand2,
} from 'lucide-react';
import { db } from '../../core/db';
import { addFile, toast, useFileUrl } from '../../core/files';
import { useIsMobile } from '../../core/mobile';
import { PresenceStack } from '../../core/presence';
import { AskAiMenu } from '../../core/assistant/AskAiMenu';
import { useAssistantContext } from '../../core/assistant/store';
import { mutate } from '../../core/sync/engine';
import { Popover } from '../../core/ui';
import { SharePopover } from '../pages/Share';
import { cn } from '../../core/utils';
import { modules } from '..';
import { Slot } from '../slots';
import { columnsOf, createTask, firstColumnId, useBoards, type BoardRow } from '../boards/api';
import { useBoardsLite } from '../../core/views/shared';
import { itemBounds, marqueeSelect, cullItems, type Rect } from '../../../shared/mooditems';
import {
  NOTE_COLORS, addMoodItem, addCard, addFrame, addSvg, addShape, addDiagram, addConnector, removeItem, duplicateItem,
  useMoodItems, cardRef, type ItemRef, type MoodItem,
} from './api';
import { paletteFromPixels } from './palette';
import { CardItem } from './items/CardItem';
import { FrameItem } from './items/FrameItem';
import { ShapeItem } from './items/ShapeItem';
import { SvgItem } from './items/SvgItem';
import { DiagramItem } from './items/DiagramItem';
import { ConnectorLayer } from './items/ConnectorLayer';
import { AddMenu } from './AddMenu';
import { Inspector } from './Inspector';
import { ItemList } from './ItemList';
import { ConnectFlow } from './ConnectFlow';

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

type Mode = 'browse' | 'edit';

type Gesture =
  | { kind: 'pan'; startX: number; startY: number; vx: number; vy: number }
  | { kind: 'pinch'; d0: number; mx: number; my: number; z0: number; vx: number; vy: number }
  | { kind: 'press'; id: string; startX: number; startY: number }
  | { kind: 'move'; ids: string[]; primary: string; origs: Map<string, DragGeom>; startX: number; startY: number; started: boolean }
  | { kind: 'resize'; id: string; startX: number; startY: number; orig: DragGeom; aspect: number | null }
  | { kind: 'marquee'; sx: number; sy: number; additive: boolean; base: string[] };

const geomOf = (item: MoodItem): DragGeom => ({
  x: Number(item.x ?? 0),
  y: Number(item.y ?? 0),
  w: Number(item.w ?? 100),
  h: Number(item.h ?? 100),
});

/** Pointer coordinates are single-precision floats in some engines; a drag from a
 * fractional start point otherwise persists offsets like 20.0000152. Quantize
 * world-space deltas to 1/1000 unit (invisible at any supported zoom). */
const quantize = (n: number) => Math.round(n * 1000) / 1000;

export function MoodCanvas() {
  const { boardId = '' } = useParams();
  const mobile = useIsMobile();
  const nav = useNavigate();
  const board = useLiveQuery(() => db.moodboards.get(boardId), [boardId]);
  useAssistantContext(boardId && board && !board.deleted ? { kind: 'moodboard', id: boardId } : null);
  const items = useMoodItems(boardId);
  const boards = useBoards();
  const dbs = useBoardsLite();
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, z: 1 });
  const [mode, setMode] = useState<Mode>('edit');
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DragGeom>>({});
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [connectPair, setConnectPair] = useState<{ from: string; to: string } | null>(null);
  const [connectMode, setConnectMode] = useState(false);
  const [showList, setShowList] = useState(false);
  const [showInspector, setShowInspector] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [noteColor, setNoteColor] = useState(0);
  const [swatchColor, setSwatchColor] = useState('#a5b4fc');
  const [taskPicker, setTaskPicker] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture>(null);
  const movedSinceDown = useRef(false);
  /** Tap = select is resolved on pointer release (pointer capture retargets the
   * `click` event to the canvas, so item onClick cannot be relied on).
   * `lastReleaseSelect` dedupes the residual click — suppressed only on the
   * same item within a short window, so programmatic/AT clicks still work. */
  const pendingTap = useRef<{ id: string; additive: boolean } | null>(null);
  const lastReleaseSelect = useRef<{ id: string; t: number } | null>(null);
  /** Set when a real pointer sequence ends with movement — used to suppress the
   * browser click that trails a drag, but only for a short window so later
   * programmatic/assistive clicks (which have no pointerdown to reset the flag)
   * are not silently eaten. */
  const dragEndedAt = useRef(0);
  const spaceDown = useRef(false);

  const maxZ = useMemo(() => Math.max(0, ...items.map((i) => Number(i.z ?? 0))), [items]);
  const selItems = useMemo(() => items.filter((i) => sel.has(i.id)), [items, sel]);
  const selItem = selItems.length === 1 ? selItems[0] : null;
  const frames = useMemo(() => items.filter((i) => i.type === 'frame' && !i.deleted), [items]);
  const memberCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items) if (i.parentFrameId) m.set(String(i.parentFrameId), (m.get(String(i.parentFrameId)) ?? 0) + 1);
    return m;
  }, [items]);

  // Touch defaults to Browse/Pan; desktop to Select/Edit.
  useEffect(() => {
    setMode(window.matchMedia('(pointer:coarse)').matches ? 'browse' : 'edit');
  }, []);

  // Space = temporary pan in edit mode.
  useEffect(() => {
    const dn = (e: KeyboardEvent) => {
      if (e.key === ' ') spaceDown.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ') spaceDown.current = false;
    };
    window.addEventListener('keydown', dn);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', dn);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const toWorld = useCallback(
    (cx: number, cy: number) => {
      const r = ref.current!.getBoundingClientRect();
      return { x: (cx - r.left - view.x) / view.z, y: (cy - r.top - view.y) / view.z };
    },
    [view],
  );

  /* ---------- gesture lifecycle ---------- */

  /** Restore draft geometry and drop the gesture — never commits. */
  const cancelGesture = useCallback(() => {
    gesture.current = null;
    pendingTap.current = null;
    setDrafts({});
    setMarquee(null);
  }, []);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') cancelGesture();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [cancelGesture]);

  // Canvas resize cancels any in-flight gesture first (design §3), then re-measures.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (gesture.current) cancelGesture();
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [cancelGesture]);

  /** Ids dragged together: the pressed item's selection set (or itself), plus
   * members of any frame in the set. Connectors never move. */
  const moveSet = useCallback(
    (id: string): string[] => {
      const base = sel.has(id) ? [...sel] : [id];
      const out = new Set<string>(base.filter((bid) => items.find((i) => i.id === bid)?.type !== 'connector'));
      for (const bid of [...out]) {
        const it = items.find((i) => i.id === bid);
        if (it?.type === 'frame') {
          for (const m of items) if (m.parentFrameId === bid && m.type !== 'connector') out.add(m.id);
        }
      }
      return [...out];
    },
    [items, sel],
  );

  const commitItemWrites = useCallback(
    async (id: string, g: DragGeom) => {
      await mutate('mooditems', id, { x: g.x, y: g.y, w: g.w, h: g.h });
    },
    [],
  );

  const endItemGesture = useCallback(
    async (g: Extract<Gesture, { kind: 'move' | 'resize' }>, finalDrafts: Record<string, DragGeom>) => {
      if (g.kind === 'move') {
        for (const id of g.ids) {
          const final = finalDrafts[id];
          const orig = g.origs.get(id);
          if (!final || !orig || (final.x === orig.x && final.y === orig.y)) continue;
          await commitItemWrites(id, final);
        }
        // Recompute frame membership + stage-mirror for the moved items.
        for (const id of g.ids) {
          const item = items.find((i) => i.id === id);
          const final = finalDrafts[id];
          if (item && final) await settleItemDrop(item, final);
        }
      } else {
        const final = finalDrafts[g.id];
        if (final) await commitItemWrites(g.id, final);
      }
    },
    [commitItemWrites, items],
  );

  /** Re-evaluate one item's frame membership + stage mirror after a drop. */
  const settleItemDrop = useCallback(async (item: MoodItem, geom: DragGeom) => {
    if (item.type === 'frame' || item.type === 'connector') return;
    const all = (await db.mooditems.where('boardId').equals(String(item.boardId)).toArray()) as MoodItem[];
    const { frameMembership } = await import('../../../shared/mooditems');
    const moved = { ...item, ...geom } as MoodItem;
    const mem = frameMembership([...all.filter((i) => i.id !== item.id), moved]);
    const frameId = mem.get(item.id) ?? null;
    if ((item.parentFrameId ?? null) !== frameId) await mutate('mooditems', item.id, { parentFrameId: frameId });
    const frame = frameId ? all.find((f) => f.id === frameId && f.type === 'frame') : null;
    const mirror = frame?.frameStageOf;
    const ref2 = cardRef(moved);
    if (mirror?.stageId && ref2?.type === 'record') {
      const rec = await db.tasks.get(ref2.id);
      if (rec && !rec.deleted && String(rec.boardId ?? '') === mirror.databaseId && String(rec.status ?? '') !== mirror.stageId) {
        await mutate('tasks', ref2.id, { status: mirror.stageId });
      }
    }
  }, []);

  /* ---------- pointer handling (canvas-level; items forward their down) ---------- */

  const startPinch = useCallback(() => {
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
  }, [view]);

  const onDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).focus();
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    movedSinceDown.current = false;
    if (pointers.current.size >= 2) {
      // Second pointer: any item gesture is cancelled and its draft restored.
      if (gesture.current && gesture.current.kind !== 'pan' && gesture.current.kind !== 'pinch') cancelGesture();
      startPinch();
      return;
    }
    if (gesture.current) return;
    const el = e.target as HTMLElement;
    const onBg = e.target === e.currentTarget || el.dataset.canvas === 'bg' || el.dataset.marquee === 'bg';
    if (!onBg) return;
    // Capture only for real canvas gestures — capturing every pointerdown
    // inside the canvas subtree retargets the trailing click to this element
    // and kills toolbar/overlay button clicks (setPointerCapture can throw
    // e.g. WebKit NotFoundError — never abort the gesture over it).
    try { ref.current?.setPointerCapture?.(e.pointerId); } catch { /* noop */ }
    if (mode === 'edit' && !spaceDown.current) {
      const w = toWorld(e.clientX, e.clientY);
      gesture.current = { kind: 'marquee', sx: w.x, sy: w.y, additive: e.shiftKey, base: [...sel] };
      setMarquee({ x: w.x, y: w.y, w: 0, h: 0 });
      if (!e.shiftKey) setSel(new Set());
    } else {
      gesture.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, vx: view.x, vy: view.y };
      if (!e.shiftKey) setSel(new Set());
      setConnectFrom(null);
    }
  };

  /** Item pointer-down. In edit mode it starts a pending move; in browse it
   * bubbles to the canvas (drag = pan, tap = select). */
  const itemDown = (item: MoodItem, e: React.PointerEvent) => {
    if (e.button !== undefined && e.button > 0) return;
    if (pointers.current.size === 0)
      pendingTap.current = { id: item.id, additive: e.shiftKey || e.metaKey || e.ctrlKey };
    if (mode === 'browse') return; // bubbles up → pan
    e.stopPropagation();
    (e.currentTarget as HTMLElement).focus?.();
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { ref.current?.setPointerCapture?.(e.pointerId); } catch { /* noop */ }
    movedSinceDown.current = false;
    if (pointers.current.size >= 2) {
      if (gesture.current && gesture.current.kind !== 'pinch') cancelGesture();
      startPinch();
      return;
    }
    if (gesture.current) return;
    if (connectMode) {
      // Connect mode: taps pick endpoints, never start drags and never select.
      pendingTap.current = null;
      setConnectFrom((from) => {
        if (!from) return item.id;
        setConnectPair({ from, to: item.id });
        setConnectMode(false);
        return null;
      });
      return;
    }
    gesture.current = { kind: 'press', id: item.id, startX: e.clientX, startY: e.clientY };
  };

  const onMove = (e: React.PointerEvent) => {
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
        const wx = (g.mx - r.left - g.vx) / g.z0;
        const wy = (g.my - r.top - g.vy) / g.z0;
        return { z, x: mx - r.left - wx * z, y: my - r.top - wy * z };
      });
      movedSinceDown.current = true;
    } else if (g.kind === 'pan') {
      setView((v) => ({ ...v, x: g.vx + e.clientX - g.startX, y: g.vy + e.clientY - g.startY }));
      movedSinceDown.current = true;
    } else if (g.kind === 'press') {
      const dist = Math.hypot(e.clientX - g.startX, e.clientY - g.startY);
      if (dist < 6) return;
      const ids = moveSet(g.id);
      const origs = new Map<string, DragGeom>();
      for (const id of ids) {
        const it = items.find((i) => i.id === id);
        if (it) origs.set(id, geomOf(it));
      }
      gesture.current = { kind: 'move', ids, primary: g.id, origs, startX: g.startX, startY: g.startY, started: true };
      movedSinceDown.current = true;
    } else if (g.kind === 'move') {
      const dx = quantize((e.clientX - g.startX) / view.z);
      const dy = quantize((e.clientY - g.startY) / view.z);
      setDrafts((d) => {
        const next = { ...d };
        for (const [id, o] of g.origs) next[id] = { ...o, x: o.x + dx, y: o.y + dy };
        return next;
      });
      movedSinceDown.current = true;
    } else if (g.kind === 'resize') {
      const dx = quantize((e.clientX - g.startX) / view.z);
      const dy = quantize((e.clientY - g.startY) / view.z);
      setDrafts((d) => {
        const o = g.orig;
        const w = Math.max(40, o.w + dx);
        const next: DragGeom = { ...o, w, h: g.aspect ? Math.max(30, w / g.aspect) : Math.max(30, o.h + dy) };
        return { ...d, [g.id]: next };
      });
      movedSinceDown.current = true;
    } else if (g.kind === 'marquee') {
      const w = toWorld(e.clientX, e.clientY);
      setMarquee({ x: Math.min(g.sx, w.x), y: Math.min(g.sy, w.y), w: Math.abs(w.x - g.sx), h: Math.abs(w.y - g.sy) });
      movedSinceDown.current = true;
    }
  };

  const onUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (movedSinceDown.current) dragEndedAt.current = Date.now();
    const g = gesture.current;
    if (g?.kind === 'move' || g?.kind === 'resize') {
      const final = { ...drafts };
      setDrafts({});
      void endItemGesture(g, final);
      gesture.current = null;
    } else if (g?.kind === 'marquee') {
      if (marquee && (marquee.w > 2 || marquee.h > 2)) {
        const hit = marqueeSelect(items.filter((i) => i.type !== 'connector'), marquee);
        setSel(new Set(g.additive ? [...g.base, ...hit] : hit));
      }
      setMarquee(null);
      gesture.current = null;
    } else if (g?.kind === 'press') {
      gesture.current = null; // click event performs selection
    } else if (pointers.current.size < 2 && g?.kind === 'pinch') {
      gesture.current = null;
    } else if (pointers.current.size === 0) {
      gesture.current = null;
    }
    // Tap (press with no drag) selects — the click event cannot be trusted to
    // reach the item once pointer capture is set on the canvas.
    if (pendingTap.current) {
      if (!movedSinceDown.current && pointers.current.size === 0 && g?.kind !== 'pinch' && !connectMode) {
        const it = items.find((i) => i.id === pendingTap.current!.id);
        if (it) {
          selectItem(it, pendingTap.current.additive);
          lastReleaseSelect.current = { id: it.id, t: Date.now() };
        }
      }
      pendingTap.current = null;
    }
  };

  /** pointercancel / lostpointercapture → cancel, restore, never commit. */
  const onCancel = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    pendingTap.current = null;
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'move' || g.kind === 'resize' || g.kind === 'marquee' || g.kind === 'press') {
      cancelGesture();
    } else if (g.kind === 'pinch' && pointers.current.size < 2) {
      gesture.current = null;
    } else if (g.kind === 'pan' && pointers.current.size === 0) {
      gesture.current = null;
    }
  };

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

  /* ---------- selection ---------- */

  const selectItem = (item: MoodItem, additive: boolean) => {
    setSel((s) => {
      const next = new Set(additive ? s : []);
      if (additive && next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
    // Preserve convention: single-select bumps z to front (edit mode only).
    if (!additive && mode === 'edit' && item.type !== 'frame' && Number(item.z ?? 0) < maxZ) {
      void mutate('mooditems', item.id, { z: maxZ + 1 });
    }
  };

  const itemClick = (item: MoodItem, e: React.MouseEvent) => {
    e.stopPropagation();
    // Click that trails a release-select on the same item — handled already.
    if (lastReleaseSelect.current && lastReleaseSelect.current.id === item.id && Date.now() - lastReleaseSelect.current.t < 800) {
      lastReleaseSelect.current = null;
      return;
    }
    if (movedSinceDown.current && Date.now() - dragEndedAt.current < 120) return;
    if (connectMode) return; // handled in itemDown
    selectItem(item, e.shiftKey || e.metaKey || e.ctrlKey);
  };

  const resizeDown = (item: MoodItem, e: React.PointerEvent) => {
    if (mode !== 'edit') return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = geomOf(item);
    gesture.current = {
      kind: 'resize',
      id: item.id,
      startX: e.clientX,
      startY: e.clientY,
      orig: g,
      aspect: item.type === 'image' ? g.w / Math.max(1, g.h) : null,
    };
  };

  /* ---------- ops ---------- */

  const center = () => {
    const r = ref.current!.getBoundingClientRect();
    // Cascade successive spawns so items don't pile at the exact center.
    const off = (items.length % 8) * 28;
    return { x: (r.width / 2 - view.x) / view.z + off, y: (r.height / 2 - view.y) / view.z + off };
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
    [boardId, view, items],
  );

  const addNote = async () => {
    const c = center();
    const id = await addMoodItem(boardId, { type: 'note', x: c.x - 110, y: c.y - 80, w: 220, h: 160, color: NOTE_COLORS[noteColor % NOTE_COLORS.length], text: '' });
    setNoteColor((n) => n + 1);
    setSel(new Set([id]));
    setEditing(id);
  };

  const addText = async () => {
    const c = center();
    const id = await addMoodItem(boardId, { type: 'text', x: c.x - 200, y: c.y - 30, w: 400, h: 60, text: 'Heading' });
    setSel(new Set([id]));
    setEditing(id);
  };

  const addColor = async (color: string) => {
    const c = center();
    const id = await addMoodItem(boardId, { type: 'color', x: c.x - 60, y: c.y - 40, w: 120, h: 80, color });
    setSel(new Set([id]));
  };

  const addItem = async (kind: string, extra?: unknown) => {
    const c = center();
    if (kind === 'card') {
      const ref2 = extra as ItemRef;
      const id = await addCard(boardId, ref2, { x: c.x - 130, y: c.y - 70 });
      setSel(new Set([id]));
    } else if (kind === 'frame') {
      const id = await addFrame(boardId, { x: c.x - 240, y: c.y - 160 });
      setSel(new Set([id]));
    } else if (kind === 'shape') {
      const id = await addShape(boardId, extra as NonNullable<MoodItem['shape']>, { x: c.x - 90, y: c.y - 60 });
      setSel(new Set([id]));
    } else if (kind === 'diagram') {
      const res = await addDiagram(boardId, extra, { x: c.x - 240, y: c.y - 160 });
      if (res.error) toast(res.error, 'error');
      else if (res.id) setSel(new Set([res.id]));
    } else if (kind === 'connector') {
      setConnectMode(true);
      setConnectFrom(null);
      setHint('Connect: tap the first item, then the second');
    }
  };

  const addSvgFile = async (f: File) => {
    const c = center();
    const res = await addSvg(boardId, f, f.name, { x: c.x - 120, y: c.y - 120 });
    if (res.error) toast(res.error, 'error');
    else if (res.id) setSel(new Set([res.id]));
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

  const fit = useCallback(() => {
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
  }, [items]);

  const focusItem = useCallback(
    (item: MoodItem) => {
      if (!ref.current) return;
      const r = ref.current.getBoundingClientRect();
      const g = itemBounds(item);
      const z = clampZ(Math.max(view.z, Math.min(2, Math.min(r.width / (g.w + 120), r.height / (g.h + 120)))));
      setView({ z, x: r.width / 2 - (g.x + g.w / 2) * z, y: r.height / 2 - (g.y + g.h / 2) * z });
      setSel(new Set([item.id]));
    },
    [view.z],
  );

  const nudge = useCallback(
    async (dx: number, dy: number) => {
      const ids = new Set<string>();
      for (const s of selItems) for (const id of moveSet(s.id)) ids.add(id);
      // Read committed geometry from Dexie (not React state) so rapid repeated
      // nudges accumulate instead of all reading the same stale position.
      const finals = new Map<string, { x: number; y: number }>();
      for (const id of ids) {
        const it = (await db.mooditems.get(id)) as MoodItem | undefined;
        if (!it || it.type === 'connector') continue;
        const g = { x: Number(it.x ?? 0) + dx, y: Number(it.y ?? 0) + dy };
        finals.set(id, g);
        await mutate('mooditems', id, g);
      }
      for (const s of selItems) {
        if (s.type !== 'frame' && s.type !== 'connector') {
          const f = finals.get(s.id);
          if (f) await settleItemDrop(s, { ...geomOf(s), x: f.x, y: f.y });
        }
      }
    },
    [selItems, moveSet, settleItemDrop],
  );

  const deleteSel = useCallback(() => {
    for (const it of selItems) void removeItem(it);
    setSel(new Set());
  }, [selItems]);

  const dupSel = useCallback(async () => {
    const ids: string[] = [];
    for (const it of selItems) if (it.type !== 'connector') ids.push(await duplicateItem(boardId, it));
    if (ids.length) setSel(new Set(ids));
  }, [boardId, selItems]);

  const groupIntoFrame = useCallback(async () => {
    const movable = selItems.filter((i) => i.type !== 'frame' && i.type !== 'connector');
    if (!movable.length) return;
    const bs = movable.map((i) => itemBounds(i));
    const x = Math.min(...bs.map((b) => b.x)) - 24;
    const y = Math.min(...bs.map((b) => b.y)) - 40;
    const w = Math.max(...bs.map((b) => b.x + b.w)) - x + 24;
    const h = Math.max(...bs.map((b) => b.y + b.h)) - y + 24;
    const id = await addFrame(boardId, { x, y, w, h, memberIds: movable.map((i) => i.id) });
    setSel(new Set([id]));
  }, [boardId, selItems]);

  const reorderSel = useCallback(
    async (dir: 1 | -1) => {
      for (const it of selItems) await mutate('mooditems', it.id, { z: Number(it.z ?? 0) + dir });
    },
    [selItems],
  );

  const extractPalette = async (item: MoodItem) => {
    const blobRow = item.fileId ? await db.blobs.get(String(item.fileId)) : undefined;
    let url: string | undefined;
    if (blobRow?.blob) url = URL.createObjectURL(blobRow.blob);
    else if (item.fileId) {
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

  /* ---------- keyboard parity (design §3.4) ---------- */

  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea, select, [contenteditable]')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSel(new Set(items.filter((i) => i.type !== 'connector').map((i) => i.id)));
      return;
    }
    if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      void dupSel();
      return;
    }
    if (mod && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      void groupIntoFrame();
      return;
    }
    if (e.key === 'Escape') {
      if (gesture.current) cancelGesture();
      else if (editing) setEditing(null);
      else if (connectMode || connectFrom) {
        setConnectMode(false);
        setConnectFrom(null);
      } else if (sel.size) setSel(new Set());
      return;
    }
    if (!sel.size) return;
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      void nudge(-step, 0);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      void nudge(step, 0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      void nudge(0, -step);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      void nudge(0, step);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSel();
    } else if (e.key === '[') {
      void reorderSel(-1);
    } else if (e.key === ']') {
      void reorderSel(1);
    } else if (e.key === 'Enter' && selItem && (selItem.type === 'note' || selItem.type === 'text')) {
      e.preventDefault();
      setEditing(selItem.id);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const sorted = items.filter((i) => i.type !== 'connector').sort((a, b) => Number(a.z ?? 0) - Number(b.z ?? 0));
      if (!sorted.length) return;
      const idx = selItem ? sorted.findIndex((i) => i.id === selItem.id) : -1;
      const next = sorted[(idx + (e.shiftKey ? -1 : 1) + sorted.length) % sorted.length];
      setSel(new Set([next.id]));
    }
  };

  /* ---------- culling ---------- */

  const keepIds = useMemo(() => {
    const k = new Set(sel);
    if (editing) k.add(editing);
    if (connectFrom) k.add(connectFrom);
    for (const id of Object.keys(drafts)) k.add(id);
    return k;
  }, [sel, editing, connectFrom, drafts]);

  const worldRect: Rect = { x: -view.x / view.z, y: -view.y / view.z, w: size.w / view.z, h: size.h / view.z };
  const culled = items.length > 300;
  const visible = (culled ? cullItems(items, worldRect, 1.5, keepIds) : items) as MoodItem[];
  const hidden = items.length - visible.length;

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
        <AskAiMenu modules={['moodboards']} refs={{ moodboard: { kind: 'moodboard', id: boardId } }} compact />
        <SharePopover moodboardId={boardId} />
      </div>

      <div
        ref={ref}
        tabIndex={0}
        role="application"
        aria-label="Moodboard canvas"
        className="relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-neutral-50 outline-none dark:bg-neutral-950"
        style={{ backgroundImage: 'radial-gradient(circle, rgba(0,0,0,0.10) 1px, transparent 1px)', backgroundSize: '24px 24px' }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onCancel}
        onLostPointerCapture={onCancel}
        onKeyDown={onKeyDown}
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
          <ConnectorLayer items={visible} drafts={drafts as Record<string, Rect>} zoom={view.z} selected={sel} onSelect={(id, additive) => selectItem(visible.find((i) => i.id === id)!, additive)} />
          {visible
            .filter((i) => i.type !== 'connector')
            .map((item) => (
              <MoodItemView
                key={item.id}
                item={item}
                draft={drafts[item.id]}
                selected={sel.has(item.id)}
                connectSource={connectFrom === item.id}
                editing={editing === item.id}
                mode={mode}
                zoom={view.z}
                memberCount={memberCount.get(item.id) ?? 0}
                stageName={
                  item.type === 'frame' && item.frameStageOf?.stageId
                    ? columnsOf(dbs.find((b) => b.id === item.frameStageOf!.databaseId) as BoardRow | undefined).find((c) => c.id === item.frameStageOf!.stageId)?.name
                    : undefined
                }
                frameMirror={
                  item.parentFrameId
                    ? ((frames.find((f) => f.id === item.parentFrameId)?.frameStageOf?.stageId as string | undefined) ?? null)
                    : null
                }
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
          {/* marquee */}
          {marquee && <div data-marquee="bg" className="absolute border border-blue-500 bg-blue-500/10" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h, zIndex: 9999 }} />}
        </div>

        {/* hint + cull chips */}
        {(hint || culled) && (
          <div className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 gap-2">
            {hint && (
              <button className="rounded-full bg-neutral-900/90 px-3 py-1.5 text-xs text-white shadow" onClick={() => setHint(null)}>
                {hint} ✕
              </button>
            )}
            {culled && hidden > 0 && <span className="rounded-full bg-neutral-900/70 px-3 py-1.5 text-xs text-white shadow">{hidden} item{hidden === 1 ? '' : 's'} outside view hidden</span>}
          </div>
        )}

        {/* toolbar */}
        <div
          className={cn(
            'absolute left-1/2 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-2xl border border-neutral-200/80 bg-white/95 px-1.5 py-1 shadow-lg backdrop-blur dark:border-neutral-700 dark:bg-neutral-900/95',
            mobile ? 'bottom-[calc(4.75rem+env(safe-area-inset-bottom))]' : 'top-3',
          )}
          data-testid="mood-toolbar"
        >
          <button
            className={cn(toolBtn, mode === 'browse' && 'bg-neutral-200 dark:bg-neutral-700')}
            title={mode === 'browse' ? 'Browse (pan/zoom; tap selects) — click to edit' : 'Edit (drag moves, handles resize) — click to browse'}
            onClick={() => {
              const next = mode === 'browse' ? 'edit' : 'browse';
              setMode(next);
              cancelGesture();
              setHint(next === 'browse' ? 'Browse: drag to pan, scroll/pinch to zoom, tap to select' : 'Edit: drag items to move, drag empty space to marquee-select');
            }}
            data-testid="mode-toggle"
          >
            {mode === 'browse' ? <Hand size={16} /> : <MousePointer2 size={16} />}
          </button>

          <AddMenu
            boards={dbs}
            toolBtn={toolBtn}
            swatchColor={swatchColor}
            onSwatch={setSwatchColor}
            onAddImages={(files) => void addImages(files)}
            onAddNote={() => void addNote()}
            onAddText={() => void addText()}
            onAddColor={(c) => void addColor(c)}
            onAdd={addItem}
            onAddSvg={(f) => void addSvgFile(f)}
          />

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
          <button className={cn(toolBtn, showList && 'bg-neutral-200 dark:bg-neutral-700')} title="Item list" onClick={() => setShowList((s) => !s)}>
            <List size={15} />
          </button>
          <button className={cn(toolBtn, showInspector && 'bg-neutral-200 dark:bg-neutral-700')} title="Inspector" onClick={() => setShowInspector((s) => !s)}>
            <SlidersHorizontal size={15} />
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
              <button className={toolBtn} title="Duplicate (⌘D)" onClick={() => void dupSel()}>
                <Copy size={15} />
              </button>
              <button className={cn(toolBtn, 'text-red-500 hover:bg-red-50 dark:hover:bg-red-950')} title="Delete" onClick={() => void removeItem(selItem).then(() => setSel(new Set()))}>
                <Trash2 size={15} />
              </button>
            </>
          )}
          {sel.size === 2 && (
            <button
              className={toolBtn}
              title="Connect selected items"
              onClick={() => {
                const [a, b] = [...sel];
                setConnectPair({ from: a, to: b });
              }}
            >
              <Spline size={15} />
            </button>
          )}
        </div>

        {/* side panels */}
        {showList && (
          <ItemList
            items={items}
            frames={frames}
            sel={sel}
            onSel={setSel}
            onFocus={focusItem}
            onClose={() => setShowList(false)}
            boardId={boardId}
            onConnect={(from, to) => setConnectPair({ from, to })}
          />
        )}
        {showInspector && (
          <Inspector
            items={selItems}
            allItems={items}
            boards={dbs}
            boardId={boardId}
            onClose={() => setShowInspector(false)}
            onConnect={() => {
              setConnectMode(true);
              setConnectFrom(selItems[0]?.id ?? null);
            }}
            onConnectPair={(from, to) => setConnectPair({ from, to })}
          />
        )}

        <ConnectFlow
          open={!!connectPair}
          from={connectPair?.from ?? null}
          to={connectPair?.to ?? null}
          items={items}
          onClose={() => setConnectPair(null)}
          onCreate={async (opts) => {
            if (!connectPair) return;
            await addConnector(boardId, { from: connectPair.from, to: connectPair.to, ...opts });
            setConnectPair(null);
          }}
        />
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------

function MoodItemView({
  item,
  draft,
  selected,
  connectSource,
  editing,
  mode,
  zoom,
  memberCount,
  stageName,
  frameMirror,
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
  connectSource: boolean;
  editing: boolean;
  mode: Mode;
  zoom: number;
  memberCount: number;
  stageName?: string | null;
  frameMirror?: string | null;
  onDown: (e: React.PointerEvent) => void;
  onClick: (e: React.MouseEvent) => void;
  onResizeDown: (e: React.PointerEvent) => void;
  onEdit: () => void;
  onCommitText: (text: string) => void;
  onOpenTask: () => void;
}) {
  const g = draft ?? geomOf(item);
  const [text, setText] = useState(String(item.text ?? ''));
  const handlePx = Math.max(24 / zoom, 14);

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
          connectSource && 'ring-2 ring-emerald-500',
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
        {item.type === 'card' && <CardItem item={item} stageMirror={frameMirror} />}
        {item.type === 'frame' && <FrameItem item={item} memberCount={memberCount} stageName={stageName} />}
        {item.type === 'shape' && <ShapeItem item={item} />}
        {item.type === 'svg' && <SvgItem item={item} />}
        {item.type === 'diagram' && <DiagramItem item={item} />}
      </div>

      {/* badges */}
      {item.taskId && item.type !== 'card' && (
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

      {selected && mode === 'edit' && item.type !== 'frame' && (
        <span
          className="absolute z-20 cursor-nwse-resize rounded-full border-2 border-white bg-blue-500 shadow"
          style={{ width: handlePx, height: handlePx, right: -handlePx / 2, bottom: -handlePx / 2 }}
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
