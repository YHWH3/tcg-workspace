// Phase 4 — semantic event derivation. Pure: maps AppliedChange-shaped rows
// (worker/sync.ts AppliedChange) to semantic events for notifications +
// automations. No imports from worker/ — the structural AppliedLike mirrors
// AppliedChange so both sides can call it.

export interface AppliedLike {
  id: string;
  collection: string;
  created: boolean;
  fields: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  snapshot?: Record<string, unknown>;
}

export interface SemanticEvent {
  kind:
    | 'record.created'
    | 'record.stage_changed'
    | 'record.field_changed'
    | 'record.assigned'
    | 'comment.created'
    | 'mention.created'
    | 'form.submitted';
  snapshot?:Record<string,unknown>;
  recordId: string;
  collection: string;
  /** Owning board id for record/db-scoped triggers (tasks rows only). */
  boardId?: string;
  /** Field key for field_changed (builtin or p_<fid>). */
  fieldKey?: string;
  from?: unknown;
  to?: unknown;
  /** targetType/targetId for comment + mention events. */
  targetType?: string;
  targetId?: string;
  formId?: string;
}

const USER_MENTION = /@\[user:([A-Za-z0-9_-]+)\]/g;

function mentionedUsers(text: unknown): string[] {
  if (typeof text !== 'string' || !text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(USER_MENTION)) out.add(m[1]);
  return [...out];
}

const FIELD_CAP = 20;

/** Pure derivation — never emits for rejected/non-applied writes (callers
 * only pass `applied`). Order preserved: created → stage → assigned → fields
 * → mentions so downstream consumers can rely on sequence. */
export function deriveEvents(applied: AppliedLike[]): SemanticEvent[] {
  const events: SemanticEvent[] = [];
  for (const ch of applied) {
    const { id, collection } = ch;
    const before = ch.before ?? {};
    const after = ch.snapshot ?? ch.after ?? {};
    const changed = new Set(ch.fields);

    if (collection === 'comments' && ch.created) {
      events.push({
        kind: 'comment.created',
        recordId: id,
        collection,
        targetType: typeof after.targetType === 'string' ? (after.targetType as string) : undefined,
        targetId: typeof after.targetId === 'string' ? (after.targetId as string) : undefined,
      });
    } else if (collection === 'tasks' && ch.created) {
      events.push({
        kind: 'record.created',
        recordId: id,
        collection,
        boardId: typeof after.boardId === 'string' ? (after.boardId as string) : undefined,
      });
    }

    if (collection === 'tasks') {
      if (changed.has('status') && before.status !== after.status) {
        events.push({
          kind: 'record.stage_changed',
          recordId: id,
          collection,
          boardId: typeof after.boardId === 'string' ? (after.boardId as string) : undefined,
          fieldKey: 'status',
          from: before.status,
          to: after.status,
        });
      }
      if (changed.has('assigneeId') && before.assigneeId !== after.assigneeId) {
        events.push({
          kind: 'record.assigned',
          recordId: id,
          collection,
          boardId: typeof after.boardId === 'string' ? (after.boardId as string) : undefined,
          fieldKey: 'assigneeId',
          from: before.assigneeId,
          to: after.assigneeId,
        });
      }
      let n = 0;
      for (const f of ch.fields) {
        if (f === 'status' || f === 'assigneeId' || n >= FIELD_CAP) continue;
        if (before[f] === after[f]) continue;
        n++;
        events.push({
          kind: 'record.field_changed',
          recordId: id,
          collection,
          boardId: typeof after.boardId === 'string' ? (after.boardId as string) : undefined,
          fieldKey: f,
          from: before[f],
          to: after[f],
        });
      }
    }

    // Newly-introduced @[user:id] tokens in block text or comment bodies.
    const textField = collection === 'comments' ? 'body' : 'text';
    if ((collection === 'blocks' || collection === 'comments') && changed.has(textField)) {
      const prev = new Set(mentionedUsers(before[textField]));
      for (const uid of mentionedUsers(after[textField])) {
        if (prev.has(uid)) continue;
        events.push({
          kind: 'mention.created',
          recordId: id,
          collection,
          targetType:
            collection === 'comments'
              ? typeof after.targetType === 'string'
                ? (after.targetType as string)
                : undefined
              : 'page',
          targetId:
            collection === 'comments'
              ? typeof after.targetId === 'string'
                ? (after.targetId as string)
                : undefined
              : typeof after.pageId === 'string'
                ? (after.pageId as string)
                : undefined,
          to: uid,
        });
      }
    }
  }
  for(const event of events) event.snapshot=applied.find(ch=>ch.id===event.recordId)?.snapshot;
  return events;
}
