// The canvas and export both use stored item bounds, independent of pan and zoom.
import { layoutDiagram, validateDiagramSpec } from './diagramLayout';
import { connectorAnchors, itemBounds, type MoodItem, type Rect } from './mooditems';
import { RASTER_DATA_URL, sanitizeSvg } from './svgSanitize';

export const MAX_MOODBOARD_EXPORT_ITEMS = 600;

const escape = (value: string) => value.replace(/[<>&"']/g, char =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!);
const color = (value: unknown, fallback: string) =>
  typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) ? value : fallback;

function rect(bounds: Rect, fill: string, stroke: string, radius = 6) {
  return `<rect x="${bounds.x}" y="${bounds.y}" width="${bounds.w}" height="${bounds.h}" rx="${radius}" fill="${fill}" stroke="${stroke}"/>`;
}

function textLines(value: string, bounds: Rect, size: number, bold = false) {
  const columns = Math.max(1, Math.min(140, Math.floor((bounds.w - 16) / (size * .61))));
  const rows = Math.max(0, Math.min(24, Math.floor((bounds.h - 12) / (size * 1.25))));
  const lines: string[] = [];
  let overflow = false;
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const paragraph of value.slice(0, 12_000).split('\n')) {
    const characters = Array.from(segmenter.segment(paragraph), entry => entry.segment);
    let start = 0;
    do {
      if (lines.length >= rows) { overflow = true; break; }
      let end = Math.min(characters.length, start + columns);
      if (end < characters.length) {
        const space = characters.slice(start, end).findLastIndex(character => /\s/u.test(character));
        if (space > 0) end = start + space + 1;
      }
      lines.push(characters.slice(start, end).join(''));
      start = end;
    } while (start < characters.length);
    if (overflow) break;
  }
  if (overflow && lines.length) lines[lines.length - 1] = Array.from(segmenter.segment(lines[lines.length - 1]), entry => entry.segment).slice(0, -1).join('') + '…';
  return lines.map((line, i) =>
    `<text x="${bounds.x + 8}" y="${bounds.y + 8 + size + i * size * 1.25}" font-size="${size}" font-family="sans-serif" font-weight="${bold ? 'bold' : 'normal'}" fill="#18181b" xml:space="preserve">${escape(line)}</text>`).join('');
}

function diagram(item: MoodItem, bounds: Rect) {
  const checked = validateDiagramSpec(item.spec);
  const layout = checked.ok ? layoutDiagram(checked.spec) : null;
  if (!layout?.nodes.length) return textLines('Empty diagram', bounds, 14);
  const byId = new Map(layout.nodes.map(node => [node.id, node]));
  const left = Math.min(...layout.nodes.map(node => node.x));
  const top = Math.min(...layout.nodes.map(node => node.y));
  const right = Math.max(...layout.nodes.map(node => node.x)) + 180;
  const bottom = Math.max(...layout.nodes.map(node => node.y)) + 64;
  const scale = Math.min(bounds.w / (right - left + 16), bounds.h / (bottom - top + 16));
  const edges = layout.edges.flatMap(edge => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    return from && to ? [`<line x1="${from.x + 90}" y1="${from.y + 32}" x2="${to.x + 90}" y2="${to.y + 32}" stroke="#71717a"/>`] : [];
  });
  const nodes = layout.nodes.map(node => {
    const nodeBounds = { ...node, w: 180, h: 64 };
    return rect(nodeBounds, color(node.color, '#fafafa'), '#a1a1aa') + textLines(node.label, nodeBounds, 14);
  });
  return `<g transform="translate(${bounds.x} ${bounds.y}) scale(${scale}) translate(${8 - left} ${8 - top})">${edges.join('')}${nodes.join('')}</g>`;
}

export function exportableMoodItems(items: readonly MoodItem[], selection?: ReadonlySet<string>) {
  return items.filter(item => !item.deleted && (!selection || selection.has(item.id)
    || (item.type === 'connector' && selection.has(item.from ?? '') && selection.has(item.to ?? ''))));
}

export function moodboardSvg(options: {
  title: string;
  items: readonly MoodItem[];
  images: ReadonlyMap<string, string>;
  cardTitles?: ReadonlyMap<string, string>;
}) {
  const { items, images, cardTitles } = options;
  if (items.length > MAX_MOODBOARD_EXPORT_ITEMS) throw new Error('Select up to 600 items to export.');
  const visible = items.filter(item => !item.deleted && item.type !== 'connector')
    .sort((a, b) => (Number(a.z) || 0) - (Number(b.z) || 0) || a.id.localeCompare(b.id));
  if (!visible.length) throw new Error('Select at least one canvas item to export.');
  const byId = new Map(visible.map(item => [item.id, item]));
  const bounds = visible.map(itemBounds);
  const left = Math.min(...bounds.map(b => b.x)) - 24;
  const top = Math.min(...bounds.map(b => b.y)) - 24;
  const width = Math.ceil(Math.max(...bounds.map(b => b.x + b.w)) + 24 - left);
  const height = Math.ceil(Math.max(...bounds.map(b => b.y + b.h)) + 24 - top);
  if (![left, top, width, height].every(Number.isFinite)) throw new Error('The canvas bounds cannot be exported.');

  let missing = 0;
  const renderItem = (item: MoodItem) => {
    const b = itemBounds(item);
    switch (item.type) {
      case 'image':
      case 'svg': {
        const uri = images.get(item.fileId ?? '');
        if (uri && RASTER_DATA_URL.test(uri)) {
          const aspect = item.type === 'image' ? 'xMidYMid slice' : 'xMidYMid meet';
          return `<image x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" preserveAspectRatio="${aspect}" href="${uri}"/>`;
        }
        missing++;
        return rect(b, '#f4f4f5', '#d4d4d8') + textLines('Image unavailable', b, 14);
      }
      case 'note': return rect(b, color(item.color, '#fef3c7'), 'none') + textLines(String(item.text ?? ''), b, 14);
      case 'text': return textLines(String(item.text ?? ''), b, Math.min(40, Math.max(12, b.h / 3)), true);
      case 'color': return rect(b, color(item.color, '#fef3c7'), '#d4d4d8') + textLines(color(item.color, ''), b, 12);
      case 'card': return rect(b, '#ffffff', '#a1a1aa') + textLines(cardTitles?.get(item.id) ?? 'Linked item', b, 14, true);
      case 'frame': return rect(b, '#fafafa', '#d4d4d8') + textLines(String(item.title ?? 'Frame'), b, 14, true);
      case 'diagram': return diagram(item, b);
      case 'shape': {
        const fill = color(item.fill, '#e0e7ff');
        const stroke = color(item.stroke, '#6366f1');
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        const shape = item.shape === 'ellipse'
          ? `<ellipse cx="${cx}" cy="${cy}" rx="${b.w / 2}" ry="${b.h / 2}" fill="${fill}" stroke="${stroke}"/>`
          : item.shape === 'diamond'
            ? `<polygon points="${cx},${b.y} ${b.x + b.w},${cy} ${cx},${b.y + b.h} ${b.x},${cy}" fill="${fill}" stroke="${stroke}"/>`
            : rect(b, fill, stroke, item.shape === 'pill' ? Math.min(b.w, b.h) / 2 : 6);
        return shape + textLines(String(item.text ?? ''), b, 14);
      }
      default: return '';
    }
  };

  const connectors = items.flatMap(item => {
    if (item.deleted || item.type !== 'connector') return [];
    const source = byId.get(item.from ?? '');
    const target = byId.get(item.to ?? '');
    if (!source || !target) return [];
    const { from, to } = connectorAnchors(source, target);
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const arrow = (x: number, y: number, direction: number) =>
      `<path d="M-9 -4 L0 0 L-9 4" fill="none" stroke="#52525b" stroke-width="2" transform="translate(${x} ${y}) rotate(${direction * 180 / Math.PI})"/>`;
    return [`<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="#52525b" stroke-width="2"${item.style === 'dashed' ? ' stroke-dasharray="5 4"' : ''}/>`,
      item.arrow !== 'none' ? arrow(to.x, to.y, angle) : '',
      item.arrow === 'both' ? arrow(from.x, from.y, angle + Math.PI) : '',
      item.label ? textLines(String(item.label), { x: (from.x + to.x) / 2 - 6, y: (from.y + to.y) / 2 - 28, w: 160, h: 40 }, 12) : ''];
  });

  const outputWidth = Math.max(1, Math.round(width * Math.min(1, 4096 / Math.max(width, height))));
  const outputHeight = Math.max(1, Math.round(height * Math.min(1, 4096 / Math.max(width, height))));
  const raw = `<svg viewBox="${left} ${top} ${width} ${height}" width="${outputWidth}" height="${outputHeight}"><title>${escape(options.title)}</title>${rect({ x: left, y: top, w: width, h: height }, '#ffffff', 'none', 0)}${visible.filter(item => item.type === 'frame').map(renderItem).join('')}${connectors.join('')}${visible.filter(item => item.type !== 'frame').map(renderItem).join('')}</svg>`;
  const result = sanitizeSvg(raw, { moodboardExport: true });
  if (!result.ok) throw new Error('This canvas is too large to export at once. Export a smaller selection.');
  return { svg: result.svg, width: outputWidth, height: outputHeight, missing };
}
