import { Check, Minus } from 'lucide-react';
import { cn } from '../../../core/utils';

export type CrmPaletteName = 'clay' | 'ochre' | 'leaf' | 'river' | 'dusk' | 'berry' | 'stone' | 'ember' | 'teal';

const PALETTE_LIGHT_RGB: Record<CrmPaletteName, [number, number, number]> = {
  clay: [0xb4, 0x53, 0x2a],
  ochre: [0x8a, 0x61, 0x00],
  leaf: [0x2f, 0x7a, 0x4b],
  river: [0x1f, 0x6f, 0xa8],
  dusk: [0x6b, 0x4f, 0xa3],
  berry: [0xa8, 0x3a, 0x64],
  stone: [0x5e, 0x66, 0x72],
  ember: [0xb4, 0x23, 0x18],
  teal: [0x0e, 0x7c, 0x7b],
};

function parseHexRgb(hex: string | undefined | null): [number, number, number] | null {
  if (!hex) return null;
  const raw = hex.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    return [
      parseInt(raw[0]! + raw[0]!, 16),
      parseInt(raw[1]! + raw[1]!, 16),
      parseInt(raw[2]! + raw[2]!, 16),
    ];
  }
  if (/^[0-9a-f]{6}$/i.test(raw)) {
    return [
      parseInt(raw.slice(0, 2), 16),
      parseInt(raw.slice(2, 4), 16),
      parseInt(raw.slice(4, 6), 16),
    ];
  }
  return null;
}

/** Map any Workspace hex stage colour to the closest WCAG-verified CRM palette token (`08-UX-SPEC` §4.2). */
export function nearestCrmPalette(color: string | undefined | null): CrmPaletteName {
  if (!color) return 'stone';
  const low = color.trim().toLowerCase();
  if (low in PALETTE_LIGHT_RGB) return low as CrmPaletteName;
  if (low === 'green' || low === 'emerald') return 'leaf';
  if (low === 'blue' || low === 'sky') return 'river';
  if (low === 'amber' || low === 'yellow' || low === 'orange') return 'ochre';
  if (low === 'red' || low === 'rose') return 'ember';
  if (low === 'purple' || low === 'violet' || low === 'indigo') return 'dusk';
  if (low === 'pink' || low === 'magenta') return 'berry';
  if (low === 'teal' || low === 'cyan') return 'teal';
  if (low === 'gray' || low === 'grey' || low === 'neutral') return 'stone';

  const rgb = parseHexRgb(low);
  if (!rgb) return 'stone';
  let best: CrmPaletteName = 'stone';
  let bestDist = Infinity;
  for (const [name, target] of Object.entries(PALETTE_LIGHT_RGB) as [CrmPaletteName, [number, number, number]][]) {
    const d = (rgb[0] - target[0]) ** 2 + (rgb[1] - target[1]) ** 2 + (rgb[2] - target[2]) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  return best;
}

export function crmPaletteVar(name: CrmPaletteName): string {
  return `var(--crm-status-${name})`;
}

export function StatusPill({
  label,
  color,
  palette,
  kind,
  className,
}: {
  label: string;
  color?: string | null;
  palette?: CrmPaletteName;
  kind?: 'active' | 'done' | 'blocked';
  className?: string;
}) {
  const token = palette ?? nearestCrmPalette(color);
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 truncate rounded-md px-2.5 py-0.5 text-xs font-semibold leading-5',
        className,
      )}
      style={{
        backgroundColor: crmPaletteVar(token),
        color: 'var(--crm-status-fg)',
      }}
    >
      {kind === 'done' && <Check size={12} aria-hidden="true" className="shrink-0" />}
      {kind === 'blocked' && <Minus size={12} aria-hidden="true" className="shrink-0" />}
      <span className="truncate">{label}</span>
    </span>
  );
}
