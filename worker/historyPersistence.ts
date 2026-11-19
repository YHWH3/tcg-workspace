import type {AppliedChange} from './sync';
/** Structural authority/ownership fields cannot be restored as ordinary fields. */
export const historyField = (key: string) => /^(title|name|text|body|description|caption|checked|archived|deleted|status|priority|dueDate|assigneeId|url|provider|p_[A-Za-z0-9_-]+)$/.test(key);

/** Capture the delta and body context in the record's own atomic transaction. */
export function historyStatement(db: D1Database, item: AppliedChange, userId: string, source: string, changesetId: string | null, now: number, previous: Record<string, unknown> = {}) {
  const before: Record<string, unknown> = {}, after: Record<string, unknown> = {}, omitted: string[] = [];
  const body = item.collection === 'blocks';
  // Block deletion and movement still need the unchanged answer text for a body diff.
  const fields = new Set([...item.fields, ...(body ? ['text', 'caption', 'checked', 'url', 'provider'] : [])]);
  let size = 0;
  for (const field of fields) {
    if (!historyField(field)) continue;
    const a = (body ? item.snapshot?.[field] : item.after[field]) ?? null;
    const b = (body ? previous[field] : item.before[field]) ?? null;
    if (body && a === null && b === null && !item.fields.includes(field)) continue;
    const bytes = new TextEncoder().encode(JSON.stringify([field, a, b])).length;
    if (size + bytes > 128000) { omitted.push(field); continue; }
    size += bytes; before[field] = b; after[field] = a;
  }
  const beforeParent = body && typeof previous.pageId === 'string' ? previous.pageId : null;
  const afterParent = body && typeof item.snapshot?.pageId === 'string' ? item.snapshot.pageId : null;
  return db.prepare(`INSERT INTO record_history(record_id,revision,collection,actor_id,source,changeset_id,
    space_id,peer_space_id,created_at,before_json,after_json,omitted_json,before_parent_id,after_parent_id,was_created)
    SELECT id,seq,collection,?,?,?,space_id,peer_space_id,?,?,?,?,?,?,? FROM records WHERE id=? AND changes()=1`)
    .bind(userId,source,changesetId,now,JSON.stringify(before),JSON.stringify(after),JSON.stringify(omitted),beforeParent,afterParent,item.created ? 1 : 0,item.id);
}
