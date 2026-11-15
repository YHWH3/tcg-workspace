import type { AttentionItem } from './attention';
import { WEBSITE_INBOX_ID } from './websiteInbox';

const headings = ['Needs you', 'Due today', 'New on the Website inbox', 'Unread mentions'] as const;

export function buildEmailDigest(items: readonly AttentionItem[], today: string) {
  const groups = headings.map(heading => ({heading, items: [] as AttentionItem[]}));
  const seen = new Set<string>();
  for (const item of items) {
    if (item.restricted || !item.url) continue;
    const key = item.kind + ':' + item.targetId;
    if (seen.has(key)) continue;
    seen.add(key);
    if (item.kind === 'mention_unread') groups[3].items.push(item);
    else if (item.kind === 'record_unassigned' && item.databaseId === WEBSITE_INBOX_ID) groups[2].items.push(item);
    else if (item.kind === 'record_due_today' && item.date === today) groups[1].items.push(item);
    else if (item.severity >= 2) groups[0].items.push(item);
  }
  return groups.filter(group => group.items.length);
}
