import { useMemo } from 'react';
import { connectorAnchors, type MoodItem, type Rect } from '../../../../shared/mooditems';

interface Props {
  items: MoodItem[];
  drafts: Record<string, Rect>;
  zoom: number;
  selected: ReadonlySet<string>;
  onSelect: (id: string, additive: boolean) => void;
}

/** SVG overlay of connector items. A dangling endpoint or missing link renders
 * as a plain arrow — connectors degrade gracefully, never crash. */
export function ConnectorLayer({ items, drafts, zoom, selected, onSelect }: Props) {
  const connectors = useMemo(() => items.filter((i) => i.type === 'connector' && !i.deleted), [items]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  if (!connectors.length) return null;

  const itemOf = (id: unknown) => {
    const it = typeof id === 'string' ? byId.get(id) : undefined;
    if (!it) return null;
    const d = drafts[it.id];
    return d ? ({ ...it, ...d } as MoodItem) : it;
  };

  return (
    <svg className="absolute inset-0 overflow-visible pointer-events-none" style={{ zIndex: 1 }}>
      <defs>
        <marker id="conn-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth={7 / zoom} markerHeight={7 / zoom} orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--muted,#8a8a8a)" />
        </marker>
      </defs>
      {connectors.map((c) => {
        const a = itemOf(c.from);
        const b = itemOf(c.to);
        if (!a || !b) return null;
        const { from, to } = connectorAnchors(a, b);
        const mx = (from.x + to.x) / 2;
        const isSel = selected.has(c.id);
        const stroke = isSel ? 'var(--accent,#6366f1)' : 'var(--muted,#8a8a8a)';
        return (
          <g key={c.id}>
            {/* fat invisible hit line — pointer events for selection */}
            <line
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke="transparent"
              strokeWidth={Math.max(12 / zoom, 8)}
              className="pointer-events-auto cursor-pointer"
              onPointerDown={(e) => {
                e.stopPropagation();
                onSelect(c.id, e.shiftKey);
              }}
            />
            <line
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={stroke}
              strokeWidth={(isSel ? 2.5 : 1.75) / zoom}
              strokeDasharray={c.style === 'dashed' ? `${6 / zoom} ${4 / zoom}` : undefined}
              markerEnd={c.arrow !== 'none' ? 'url(#conn-arrow)' : undefined}
              markerStart={c.arrow === 'both' ? 'url(#conn-arrow)' : undefined}
            />
            {c.label ? (
              <text x={mx} y={(from.y + to.y) / 2 - 6 / zoom} textAnchor="middle" fontSize={12 / zoom} fill={stroke} className="select-none">
                {String(c.label)}
              </text>
            ) : null}
            {c.linkKind ? (
              <text x={mx} y={(from.y + to.y) / 2 + 12 / zoom} textAnchor="middle" fontSize={10 / zoom} fill="var(--muted,#8a8a8a)" className="select-none">
                {String(c.linkKind)}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
