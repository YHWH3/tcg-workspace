import { useMemo } from 'react';
import { layoutDiagram, type DiagramSpec } from '../../../../shared/diagramLayout';
import type { MoodItem } from '../api';

const NODE_W = 180;
const NODE_H = 64;

/** Renders a diagram spec through our own layout — React SVG primitives only,
 * never stored svg strings (those go through SvgItem's <img>). */
export function DiagramItem({ item }: { item: MoodItem }) {
  const spec = item.spec as DiagramSpec | undefined;
  const layout = useMemo(() => (spec ? layoutDiagram(spec) : null), [spec]);

  const bounds = useMemo(() => {
    if (!layout?.nodes.length) return { x: 0, y: 0, w: 1, h: 1 };
    const xs = layout.nodes.map((n) => n.x);
    const ys = layout.nodes.map((n) => n.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) + NODE_W - x, h: Math.max(...ys) + NODE_H - y };
  }, [layout]);

  if (!layout || !layout.nodes.length) {
    return <div className="w-full h-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-xs text-[var(--muted)]">Empty diagram</div>;
  }

  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  return (
    <svg className="w-full h-full" viewBox={`${bounds.x - 8} ${bounds.y - 8} ${bounds.w + 16} ${bounds.h + 16}`} preserveAspectRatio="xMidYMid meet">
      <defs>
        <marker id={`dg-arrow-${item.id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--muted,#8a8a8a)" />
        </marker>
      </defs>
      {layout.edges.map((e, i) => {
        const a = byId.get(e.from);
        const b = byId.get(e.to);
        if (!a || !b) return null;
        const x1 = a.x + NODE_W / 2;
        const y1 = a.y + NODE_H / 2;
        const x2 = b.x + NODE_W / 2;
        const y2 = b.y + NODE_H / 2;
        return (
          <line
            key={i}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke="var(--muted,#8a8a8a)"
            strokeWidth={1.5}
            strokeDasharray={e.style === 'dashed' ? '5 4' : undefined}
            markerEnd={`url(#dg-arrow-${item.id})`}
          />
        );
      })}
      {layout.nodes.map((n) => {
        const rx = n.shape === 'pill' ? NODE_H / 2 : n.shape === 'rect' || !n.shape ? 6 : 0;
        return (
          <g key={n.id}>
            {n.shape === 'ellipse' ? (
              <ellipse cx={n.x + NODE_W / 2} cy={n.y + NODE_H / 2} rx={NODE_W / 2} ry={NODE_H / 2} fill={n.color ?? 'var(--surface,#fff)'} stroke="var(--border,#ccc)" strokeWidth={1.5} />
            ) : n.shape === 'diamond' ? (
              <rect x={n.x + NODE_W / 4} y={n.y + NODE_H / 4} width={NODE_W / 2} height={NODE_H / 2} transform={`rotate(45 ${n.x + NODE_W / 2} ${n.y + NODE_H / 2})`} fill={n.color ?? 'var(--surface,#fff)'} stroke="var(--border,#ccc)" strokeWidth={1.5} />
            ) : (
              <rect x={n.x} y={n.y} width={NODE_W} height={NODE_H} rx={rx} fill={n.color ?? 'var(--surface,#fff)'} stroke="var(--border,#ccc)" strokeWidth={1.5} />
            )}
            <text x={n.x + NODE_W / 2} y={n.y + NODE_H / 2} textAnchor="middle" dominantBaseline="middle" fontSize={12} fill="currentColor">
              {n.label.length > 24 ? `${n.label.slice(0, 23)}…` : n.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
