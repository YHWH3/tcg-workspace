import type { MoodItem } from '../api';

/** Translucent grouping container; the title bar is the drag/editing surface. */
export function FrameItem({ item, memberCount, stageName }: { item: MoodItem; memberCount: number; stageName?: string | null }) {
  return (
    <div className="w-full h-full rounded-lg border-2 border-dashed border-[var(--border)] bg-[var(--accent-soft,rgba(120,120,255,0.04))]">
      <div className="flex items-center gap-2 px-2 py-1 text-xs font-medium text-[var(--muted)]">
        <span className="truncate">{String(item.title ?? 'Frame')}</span>
        {stageName && <span className="rounded-full border border-[var(--border)] px-1.5 py-px text-[10px]">{stageName}</span>}
        <span className="ml-auto shrink-0">{memberCount}</span>
      </div>
    </div>
  );
}
