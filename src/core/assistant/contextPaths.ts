/* Pure internal-path helpers for context chips and source citations (unit-
 * tested). Only app-internal paths are ever produced. */
import type { ContextRef, SourceRef } from '../../../shared/assistantProtocol';

/** Accept only same-app paths ("/x"), never protocol-relative or absolute URLs. */
export function safeInternalPath(url: string | undefined | null): string | null {
  if (!url || typeof url !== 'string') return null;
  if (!url.startsWith('/') || url.startsWith('//') || url.startsWith('/\\')) return null;
  if (/[\s<>"]/.test(url)) return null;
  return url;
}

export function sourcePath(s: SourceRef): string | null {
  const direct = safeInternalPath(s.url);
  if (direct) return direct;
  const id = encodeURIComponent(s.id);
  switch (s.type) {
    case 'page':
    case 'pages':
      return `/pages/${id}`;
    case 'task':
    case 'tasks':
    case 'record':
    case 'records':
      return `/tasks/${id}`;
    case 'board':
    case 'boards':
    case 'database':
      return `/boards/${id}`;
    case 'moodboard':
    case 'moodboards':
      return `/moodboards/${id}`;
    default:
      return null;
  }
}

export function contextPath(r: ContextRef): string | null {
  switch (r.kind) {
    case 'page':
      return `/pages/${encodeURIComponent(r.id)}`;
    case 'record':
      return `/tasks/${encodeURIComponent(r.id)}`;
    case 'database':
      return `/boards/${encodeURIComponent(r.id)}`;
    case 'moodboard':
      return `/moodboards/${encodeURIComponent(r.id)}`;
    case 'selection':
      return r.pageId ? `/pages/${encodeURIComponent(r.pageId)}` : null;
    default:
      return null;
  }
}
