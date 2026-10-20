/* Human labels + internal URLs for context chips and source citations. Titles
 * come from the local replica only (never sent anywhere); URLs are always
 * app-internal paths — anything else is ignored. */
import { useLiveQuery } from 'dexie-react-hooks';
import type { ContextRef } from '../../../shared/assistantProtocol';
import { db } from '../db';

export { contextPath, safeInternalPath, sourcePath } from './contextPaths';

const KIND_LABEL: Record<ContextRef['kind'], string> = {
  page: 'Page',
  record: 'Record',
  database: 'Database',
  moodboard: 'Moodboard',
  dashboard: 'Dashboard',
  selection: 'Selection',
};

export function contextKindLabel(r: ContextRef): string {
  return KIND_LABEL[r.kind];
}

function clip(s: string, n = 48): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Live title for a context chip (local replica; falls back to the kind). */
export function useContextTitle(r: ContextRef): string {
  const key = r.kind === 'selection' || r.kind === 'dashboard' ? '' : `${r.kind}:${r.id}`;
  const title = useLiveQuery(async () => {
    if (r.kind === 'page') return (await db.pages.get(r.id))?.title;
    if (r.kind === 'record') return (await db.tasks.get(r.id))?.title;
    if (r.kind === 'database') return (await db.boards.get(r.id))?.name;
    if (r.kind === 'moodboard') return (await db.moodboards.get(r.id))?.title;
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (r.kind === 'selection') return `“${clip(r.text.replace(/@\[(page|user|rec):[A-Za-z0-9_-]+\]/g, '@…'), 40)}”`;
  if (r.kind === 'dashboard') return 'Dashboard';
  return clip(String(title ?? '') || 'Untitled');
}
