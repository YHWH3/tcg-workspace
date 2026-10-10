import type { MoodItem } from '../api';

export function ShapeItem({ item }: { item: MoodItem }) {
  const fill = String(item.fill ?? '#e0e7ff');
  const stroke = String(item.stroke ?? '#6366f1');
  const shape = item.shape ?? 'rect';
  const base: React.CSSProperties = { background: fill, border: `2px solid ${stroke}` };
  if (shape === 'ellipse') base.borderRadius = '50%';
  else if (shape === 'pill') base.borderRadius = 9999;
  else if (shape === 'diamond') return (
    <div className="w-full h-full flex items-center justify-center overflow-hidden">
      <div style={{ background: fill, border: `2px solid ${stroke}`, width: '70.7%', height: '70.7%', transform: 'rotate(45deg)', borderRadius: 4 }} />
      <span className="absolute text-xs font-medium text-center px-6 line-clamp-3">{String(item.text ?? '')}</span>
    </div>
  );
  else base.borderRadius = 6;
  return (
    <div className="w-full h-full flex items-center justify-center overflow-hidden" style={base}>
      <span className="text-xs font-medium text-center px-2 line-clamp-3 text-neutral-800">{String(item.text ?? '')}</span>
    </div>
  );
}
