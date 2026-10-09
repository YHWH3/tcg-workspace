import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { Maximize, Minus, Plus } from 'lucide-react';
import { connectorAnchors, itemBounds, normalizeItem, type MoodItem } from '../../shared/mooditems';
import { layoutDiagram, type DiagramSpec } from '../../shared/diagramLayout';
import { EmptyState } from '../core/ui';

interface View {
  x: number;
  y: number;
  z: number;
}

const clampZ = (z: number) => Math.min(4, Math.max(0.1, z));

interface PublicCanvasPayload {
  board?: { id?: string; name?: string; title?: string; icon?: string };
  moodboard?: { title?: string; icon?: string };
  items?: unknown[];
  [k: string]: unknown;
}

/** /s/canvas/:token — read-only public canvas. No auth, no sync, no record
 * drilling: cards show title + stage chip only, SVGs render via <img>. */
export function PublicCanvas() {
  const { token = '' } = useParams();
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'inactive'>('loading');
  const [payload, setPayload] = useState<PublicCanvasPayload | null>(null);
  const [view, setView] = useState<View>({ x: 40, y: 40, z: 1 });
  const ref = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ kind: 'pan'; sx: number; sy: number; vx: number; vy: number } | { kind: 'pinch'; d0: number; mx: number; my: number; z0: number; vx: number; vy: number } | null>(null);

  useEffect(() => {
    const m = document.createElement('meta');
    m.name = 'robots';
    m.content = 'noindex';
    document.head.appendChild(m);
    return () => {
      document.head.removeChild(m);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/public/canvas/${token}`);
        if (cancelled) return;
        if (res.status === 404) {
          setState('missing');
          return;
        }
        if (res.status === 410) {
          setState('inactive');
          return;
        }
        if (!res.ok) {
          setState('missing');
          return;
        }
        const data = (await res.json()) as PublicCanvasPayload;
        if (cancelled) return;
        setPayload(data);
        setState('ready');
      } catch {
        if (!cancelled) setState('missing');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const board = payload?.board ?? payload?.moodboard;
  const items = useMemo(
    () =>
      (payload?.items ?? [])
        .filter((i): i is { id: string } => typeof (i as { id?: unknown })?.id === 'string')
        .map((i) => normalizeItem(i as Partial<MoodItem> & { id: string }))
        .filter((i) => !i.deleted),
    [payload],
  );

  useEffect(() => {
    if (state !== 'ready' || !items.length || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const bs = items.filter((i) => i.type !== 'connector').map((i) => itemBounds(i));
    if (!bs.length) return;
    const minX = Math.min(...bs.map((b) => b.x));
    const minY = Math.min(...bs.map((b) => b.y));
    const bw = Math.max(1, Math.max(...bs.map((b) => b.x + b.w)) - minX);
    const bh = Math.max(1, Math.max(...bs.map((b) => b.y + b.h)) - minY);
    const z = clampZ(Math.min((r.width - 60) / bw, (r.height - 60) / bh, 1.5));
    setView({ z, x: r.width / 2 - (minX + bw / 2) * z, y: r.height / 2 - (minY + bh / 2) * z });
  }, [state, items]);

  // wheel zoom/pan
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setView((v) => {
        if (e.ctrlKey || e.metaKey) {
          const r = el.getBoundingClientRect();
          const z = clampZ(v.z * Math.exp(-e.deltaY * 0.0022));
          const px = e.clientX - r.left;
          const py = e.clientY - r.top;
          return { z, x: px - ((px - v.x) / v.z) * z, y: py - ((py - v.y) / v.z) * z };
        }
        return { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    ref.current?.setPointerCapture?.(e.pointerId);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { kind: 'pinch', d0: Math.hypot(b.x - a.x, b.y - a.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, z0: view.z, vx: view.x, vy: view.y };
    } else {
      gesture.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    }
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
      const z = clampZ(g.z0 * (d / g.d0));
      const r = ref.current!.getBoundingClientRect();
      const wx = (g.mx - r.left - g.vx) / g.z0;
      const wy = (g.my - r.top - g.vy) / g.z0;
      setView({ z, x: mx - r.left - wx * z, y: my - r.top - wy * z });
    } else if (g.kind === 'pan') {
      setView((v) => ({ ...v, x: g.vx + e.clientX - g.sx, y: g.vy + e.clientY - g.sy }));
    }
  };
  const onUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2 && gesture.current?.kind === 'pinch') gesture.current = null;
    else if (pointers.current.size === 0) gesture.current = null;
  };

  const fileUrl = (fileId: string) => `/api/public/canvas/${token}/files/${fileId}`;
  const btn = 'flex h-8 w-8 items-center justify-center rounded-lg text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800';

  return (
    <div className="flex h-dvh flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="flex items-center gap-2 border-b border-neutral-200/70 px-4 py-2.5 dark:border-neutral-800/70">
        <span className="text-lg leading-none">{board?.icon ?? '🎨'}</span>
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{(board as { name?: string } | undefined)?.name ?? board?.title ?? 'Shared canvas'}</h1>
        <div className="flex items-center gap-0.5">
          <button className={btn} title="Zoom out" onClick={() => setView((v) => ({ ...v, z: clampZ(v.z / 1.25) }))}>
            <Minus size={15} />
          </button>
          <button className={btn} title="Zoom in" onClick={() => setView((v) => ({ ...v, z: clampZ(v.z * 1.25) }))}>
            <Plus size={15} />
          </button>
          <button
            className={btn}
            title="Fit to content"
            onClick={() => {
              if (!items.length || !ref.current) return;
              const r = ref.current.getBoundingClientRect();
              const bs = items.filter((i) => i.type !== 'connector').map((i) => itemBounds(i));
              const minX = Math.min(...bs.map((b) => b.x));
              const minY = Math.min(...bs.map((b) => b.y));
              const bw = Math.max(1, Math.max(...bs.map((b) => b.x + b.w)) - minX);
              const bh = Math.max(1, Math.max(...bs.map((b) => b.y + b.h)) - minY);
              const z = clampZ(Math.min((r.width - 60) / bw, (r.height - 60) / bh, 1.5));
              setView({ z, x: r.width / 2 - (minX + bw / 2) * z, y: r.height / 2 - (minY + bh / 2) * z });
            }}
          >
            <Maximize size={15} />
          </button>
        </div>
      </header>

      <div
        ref={ref}
        className="relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-neutral-50 dark:bg-neutral-950"
        style={{ backgroundImage: 'radial-gradient(circle, rgba(0,0,0,0.10) 1px, transparent 1px)', backgroundSize: '24px 24px' }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {state === 'loading' && <div className="flex h-full items-center justify-center text-sm text-neutral-400">Loading…</div>}
        {(state === 'missing' || state === 'inactive') && (
          <div className="flex h-full items-center justify-center p-6">
            <EmptyState title={state === 'inactive' ? 'This link was turned off' : 'Canvas not found'} body="Ask the owner for a fresh link." />
          </div>
        )}
        {state === 'ready' && (
          <div className="absolute left-0 top-0" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`, transformOrigin: '0 0' }}>
            <svg className="absolute inset-0 overflow-visible">
              <defs>
                <marker id="pc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill="#8a8a8a" />
                </marker>
              </defs>
              {items
                .filter((i) => i.type === 'connector')
                .map((c) => {
                  const a = items.find((x) => x.id === c.from);
                  const b = items.find((x) => x.id === c.to);
                  if (!a || !b) return null;
                  const { from, to } = connectorAnchors(a, b);
                  return (
                    <g key={c.id}>
                      <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="#8a8a8a" strokeWidth={1.75 / view.z} strokeDasharray={c.style === 'dashed' ? `${6 / view.z} ${4 / view.z}` : undefined} markerEnd={c.arrow !== 'none' ? 'url(#pc-arrow)' : undefined} markerStart={c.arrow === 'both' ? 'url(#pc-arrow)' : undefined} />
                      {c.label ? (
                        <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 6 / view.z} textAnchor="middle" fontSize={12 / view.z} fill="#8a8a8a">
                          {String(c.label)}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
            </svg>
            {items
              .filter((i) => i.type !== 'connector')
              .map((item) => (
                <PublicItem key={item.id} item={item} fileUrl={fileUrl} />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PublicItem({ item, fileUrl }: { item: MoodItem; fileUrl: (id: string) => string }) {
  const g = itemBounds(item);
  return (
    <div className="absolute" style={{ left: g.x, top: g.y, width: g.w, height: g.h, zIndex: Number(item.z ?? 0) }}>
      {item.type === 'frame' ? (
        <div className="h-full w-full rounded-lg border-2 border-dashed border-neutral-300 dark:border-neutral-700">
          <div className="px-2 py-1 text-xs font-medium text-neutral-500">{String(item.title ?? 'Frame')}</div>
        </div>
      ) : item.type === 'shape' ? (
        <div
          className="flex h-full w-full items-center justify-center overflow-hidden"
          style={{ background: String(item.fill ?? '#e0e7ff'), border: `2px solid ${String(item.stroke ?? '#6366f1')}`, borderRadius: item.shape === 'ellipse' ? '50%' : item.shape === 'pill' ? 9999 : 6 }}
        >
          <span className="px-2 text-center text-xs font-medium line-clamp-3">{String(item.text ?? '')}</span>
        </div>
      ) : item.type === 'card' ? (
        // Public cards show title + stage chip only — no record drilling.
        <div className="h-full w-full overflow-hidden rounded-md border border-neutral-200 bg-white p-2.5 shadow-sm dark:border-neutral-700 dark:bg-neutral-900">
          <div className="line-clamp-2 text-sm font-medium leading-snug">{String((item.card as { title?: string } | undefined)?.title ?? item.title ?? 'Record')}</div>
          {(item.card as { stage?: string | null } | undefined)?.stage ? (
            <span className="mt-1.5 inline-flex items-center gap-1 rounded-full border border-neutral-200 px-1.5 py-0.5 text-xs text-neutral-500 dark:border-neutral-700">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: '#8a8a8a' }} />
              {String((item.card as { stage?: string | null })?.stage)}
            </span>
          ) : null}
        </div>
      ) : item.type === 'svg' && (item.fileId || item.svg) ? (
        <img
          src={item.svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(String(item.svg))}` : fileUrl(String(item.fileId))}
          alt={String(item.title ?? 'SVG')}
          className="h-full w-full object-contain"
          draggable={false}
        />
      ) : item.type === 'image' && item.fileId ? (
        <img src={fileUrl(String(item.fileId))} alt="" className="h-full w-full rounded-xl object-cover" draggable={false} />
      ) : item.type === 'note' ? (
        <div className="h-full w-full overflow-hidden rounded-lg p-3 text-sm whitespace-pre-wrap text-neutral-800 shadow-md" style={{ backgroundColor: String(item.color ?? '#fef3c7') }}>
          {String(item.text ?? '')}
        </div>
      ) : item.type === 'text' ? (
        <div className="flex h-full items-center px-1 font-bold tracking-tight" style={{ fontSize: Math.min(48, g.h * 0.6) }}>
          {String(item.text ?? '')}
        </div>
      ) : item.type === 'color' ? (
        <div className="flex h-full w-full items-end justify-end rounded-lg p-1.5 shadow-sm" style={{ backgroundColor: String(item.color ?? '#a5b4fc') }}>
          <span className="rounded bg-white/70 px-1 font-mono text-[10px] text-neutral-700">{String(item.color ?? '')}</span>
        </div>
      ) : item.type === 'diagram' && item.spec ? (
        <PublicDiagram spec={item.spec as DiagramSpec} id={item.id} />
      ) : null}
    </div>
  );
}

function PublicDiagram({ spec, id }: { spec: DiagramSpec; id: string }) {
  const layout = useMemo(() => layoutDiagram(spec), [spec]);
  if (!layout.nodes.length) return null;
  const xs = layout.nodes.map((n) => n.x);
  const ys = layout.nodes.map((n) => n.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const w = Math.max(...xs) + 180 - x0;
  const h = Math.max(...ys) + 64 - y0;
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  return (
    <svg className="h-full w-full" viewBox={`${x0 - 8} ${y0 - 8} ${w + 16} ${h + 16}`}>
      <defs>
        <marker id={`pd-${id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#8a8a8a" />
        </marker>
      </defs>
      {layout.edges.map((e, i) => {
        const a = byId.get(e.from);
        const b = byId.get(e.to);
        if (!a || !b) return null;
        return <line key={i} x1={a.x + 90} y1={a.y + 32} x2={b.x + 90} y2={b.y + 32} stroke="#8a8a8a" strokeWidth={1.5} strokeDasharray={e.style === 'dashed' ? '5 4' : undefined} markerEnd={`url(#pd-${id})`} />;
      })}
      {layout.nodes.map((n) => (
        <g key={n.id}>
          <rect x={n.x} y={n.y} width={180} height={64} rx={n.shape === 'pill' ? 32 : n.shape === 'ellipse' ? 32 : 6} fill={n.color ?? '#fff'} stroke="#d4d4d4" strokeWidth={1.5} />
          <text x={n.x + 90} y={n.y + 32} textAnchor="middle" dominantBaseline="middle" fontSize={12} fill="#171717">
            {n.label.length > 24 ? `${n.label.slice(0, 23)}…` : n.label}
          </text>
        </g>
      ))}
    </svg>
  );
}
