import { useFileUrl } from '../../../core/files';
import type { MoodItem } from '../api';

/** Stored SVGs render via <img> only — never inline / dangerouslySetInnerHTML. */
export function SvgItem({ item }: { item: MoodItem }) {
  const { url, missing } = useFileUrl(item.fileId ? String(item.fileId) : undefined);
  return (
    <div className="w-full h-full flex items-center justify-center overflow-hidden">
      {url ? (
        <img src={url} alt={String(item.title ?? 'SVG')} className="w-full h-full object-contain pointer-events-none" draggable={false} />
      ) : (
        <span className="text-xs text-[var(--muted)]">{missing ? 'SVG unavailable' : '…'}</span>
      )}
    </div>
  );
}
