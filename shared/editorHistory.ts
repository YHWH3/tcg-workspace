/* Pure per-editor undo/redo history (Phase 1 §12.1, platform spec §5).
 *
 * One editor owns one ordered sequence of entries. An entry is the inverse
 * patch set of one user operation: a coalesced typing group on a field, or a
 * structural op (split/merge/insert/delete/reorder) touching several records.
 * Each change records the value AND the LWW field timestamp observed before
 * and after the forward write, so an undo can distinguish "nobody touched
 * this field since" from "a remote/other edit intervened". Intervention must
 * surface for review — never silently overwrite. This is editor-local undo
 * and is unrelated to the server-side change-set undo in shared/undo.ts.
 */

import { stableJson } from './stablejson';

/** Semantic value equality (stable key order); `undefined` ≠ `null` here —
 * an absent field is meaningfully different from one explicitly cleared. */
export function valueEq(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  return stableJson(a) === stableJson(b);
}

/** One field's forward write on one record. */
export interface FieldChange {
  kind: 'field';
  collection: string;
  id: string;
  field: string;
  /** Value before the forward write (undefined = field absent). */
  before: unknown;
  after: unknown;
  /** Field timestamp before the forward write. */
  beforeTs?: number;
  /** Field timestamp observed right after the forward write. */
  afterTs?: number;
}

/**
 * Whole-record transition: creation (`before` undefined), deletion (`after`
 * undefined) or full replace. `beforeTs`/`afterTs` carry the record's field
 * timestamp map at snapshot time so "changed since" is detectable per field.
 */
export interface RecordChange {
  kind: 'record';
  collection: string;
  id: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  beforeTs?: Record<string, number>;
  afterTs?: Record<string, number>;
}

export type HistoryChange = FieldChange | RecordChange;

/** Text caret position inside one record field (UTF-16 offset). */
export interface CaretBookmark {
  recordId: string;
  field: string;
  offset: number;
}

export interface HistoryEntry {
  changes: HistoryChange[];
  /** Short human description, e.g. 'typing', 'split block', 'reorder'. */
  label?: string;
  /**
   * Coalescing key. Two consecutive entries merge when they share a group and
   * each is a single field change on the same field whose values chain
   * (prev.after === next.before) — the typing-group model.
   */
  group?: string;
  caret?: { before?: CaretBookmark; after?: CaretBookmark };
  /** Wall-clock time the entry was recorded. */
  at: number;
}

export interface EditorHistory {
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  limit: number;
}

export function createHistory(limit = 200): EditorHistory {
  return { undo: [], redo: [], limit };
}

export function canUndo(h: EditorHistory): boolean {
  return h.undo.length > 0;
}
export function canRedo(h: EditorHistory): boolean {
  return h.redo.length > 0;
}
export function peekUndo(h: EditorHistory): HistoryEntry | undefined {
  return h.undo[h.undo.length - 1];
}
export function peekRedo(h: EditorHistory): HistoryEntry | undefined {
  return h.redo[h.redo.length - 1];
}

/* Mergeable iff same non-empty group, both single field changes on the same
 * record field, and the forward values chain contiguously (the row value
 * didn't diverge between the two writes — e.g. no remote edit in between). */
function tryMerge(prev: HistoryEntry, next: HistoryEntry): HistoryEntry | null {
  if (!prev.group || prev.group !== next.group) return null;
  if (prev.changes.length !== 1 || next.changes.length !== 1) return null;
  const a = prev.changes[0];
  const b = next.changes[0];
  if (a.kind !== 'field' || b.kind !== 'field') return null;
  if (a.collection !== b.collection || a.id !== b.id || a.field !== b.field) return null;
  if (!valueEq(a.after, b.before)) return null;
  return {
    ...next,
    label: prev.label ?? next.label,
    changes: [{ ...b, before: a.before, beforeTs: a.beforeTs }],
    caret: { before: prev.caret?.before ?? next.caret?.before, after: next.caret?.after ?? prev.caret?.after },
  };
}

/**
 * Record a committed forward edit. Clears the redo stack (a new local edit
 * invalidates redo) and coalesces into the top entry when the group chains.
 */
export function record(h: EditorHistory, entry: HistoryEntry): EditorHistory {
  const top = peekUndo(h);
  const merged = top ? tryMerge(top, entry) : null;
  const undo = merged ? [...h.undo.slice(0, -1), merged] : [...h.undo, entry];
  while (undo.length > h.limit) undo.shift();
  return { ...h, undo, redo: [] };
}

/** Move the top undo entry to the redo stack after its inverse was applied. */
export function markUndone(h: EditorHistory): EditorHistory {
  const entry = peekUndo(h);
  if (!entry) return h;
  return { ...h, undo: h.undo.slice(0, -1), redo: [...h.redo, entry] };
}

/** Move the top redo entry back to the undo stack after it was re-applied. */
export function markRedone(h: EditorHistory): EditorHistory {
  const entry = peekRedo(h);
  if (!entry) return h;
  return { ...h, redo: h.redo.slice(0, -1), undo: [...h.undo, entry] };
}

/**
 * Refresh expected timestamps after a write the history itself observed
 * (an applied inverse, or any instrumented mutate). When a write lands the
 * value a change already expects, that change's expected timestamp moves to
 * the new one — this is what lets a chain of undos (a→b→c→b→a) keep passing
 * the no-intervention check while genuinely foreign writes still conflict.
 */
export function noteFieldWrite(
  h: EditorHistory,
  w: { collection: string; id: string; field: string; value: unknown; ts?: number },
): EditorHistory {
  if (w.ts === undefined) return h;
  let dirty = false;
  const visit = (entries: HistoryEntry[]): HistoryEntry[] =>
    entries.map((entry) => {
      let entryDirty = false;
      const changes = entry.changes.map((ch) => {
        if (ch.collection !== w.collection || ch.id !== w.id) return ch;
        if (ch.kind === 'field') {
          if (ch.field !== w.field) return ch;
          const next = { ...ch };
          if (valueEq(ch.before, w.value) && ch.beforeTs !== w.ts) {
            next.beforeTs = w.ts;
            entryDirty = true;
          }
          if (valueEq(ch.after, w.value) && ch.afterTs !== w.ts) {
            next.afterTs = w.ts;
            entryDirty = true;
          }
          if (entryDirty) dirty = true;
          return next;
        }
        // record change: refresh per-field ts maps where the value matches
        const next = { ...ch };
        if (ch.before && valueEq(ch.before[w.field], w.value) && ch.beforeTs?.[w.field] !== w.ts) {
          next.beforeTs = { ...(ch.beforeTs ?? {}), [w.field]: w.ts! };
          entryDirty = true;
        }
        if (ch.after && valueEq(ch.after[w.field], w.value) && ch.afterTs?.[w.field] !== w.ts) {
          next.afterTs = { ...(ch.afterTs ?? {}), [w.field]: w.ts! };
          entryDirty = true;
        }
        if (entryDirty) dirty = true;
        return next;
      });
      return entryDirty ? { ...entry, changes } : entry;
    });
  const undo = visit(h.undo);
  const redo = visit(h.redo);
  return dirty ? { ...h, undo, redo } : h;
}

/** Current per-field value + timestamp for a record (undefined when absent). */
export interface RecordSnapshot {
  data: Record<string, unknown>;
  ts: Record<string, number>;
}
export type CurrentReader = (collection: string, id: string) => RecordSnapshot | undefined;

export interface PlannedWrite {
  collection: string;
  id: string;
  patch: Record<string, unknown>;
}

export interface InverseConflict {
  collection: string;
  id: string;
  /** Field name, or '*' for a record-level conflict. */
  field: string;
  reason: string;
  /** What the entry expected the field to look like. */
  expected: unknown;
  /** What's actually there now. */
  current: unknown;
  /** The inverse value the undo wanted to write — the recovery candidate. */
  wanted: unknown;
}

export interface InversePlan {
  /** Writes to apply, in entry order. Empty patch writes are omitted. */
  writes: PlannedWrite[];
  /** Non-empty when intervention was detected: the caller must NOT apply. */
  conflicts: InverseConflict[];
}

/* All non-`deleted` field timestamps still match the snapshot, and no new
 * fields appeared since. `deleted` itself is exempt — callers handle the
 * soft-delete flag explicitly before reaching this check. */
function recordUntouched(cur: RecordSnapshot, tsMap: Record<string, number> | undefined, snapshotData: Record<string, unknown>): boolean {
  if (!tsMap) {
    // No timestamps captured: fall back to comparing values.
    return Object.keys(snapshotData).every((f) => valueEq(cur.data[f], snapshotData[f]));
  }
  const extra = Object.keys(cur.ts).some((f) => f !== 'deleted' && !(f in tsMap));
  const changed = Object.entries(tsMap).some(([f, t]) => cur.ts[f] !== t);
  return !extra && !changed;
}

/**
 * Decide the writes for one history entry. `direction 'undo'` restores
 * `before`, `'redo'` re-applies `after`. A change applies only when the
 * field still carries the value (and timestamp, when captured) the forward
 * write produced; anything else is reported as a conflict for review.
 * Absent `before`/`after` (a field that didn't exist) writes `null`, matching
 * the shared/undo.ts restore convention.
 */
export function planInverse(entry: HistoryEntry, direction: 'undo' | 'redo', current: CurrentReader): InversePlan {
  const writes: PlannedWrite[] = [];
  const conflicts: InverseConflict[] = [];
  const conflict = (ch: HistoryChange, field: string, reason: string, expected: unknown, cur: unknown, wanted: unknown) =>
    conflicts.push({ collection: ch.collection, id: ch.id, field, reason, expected, current: cur, wanted });

  for (const ch of entry.changes) {
    const cur = current(ch.collection, ch.id);

    if (ch.kind === 'field') {
      const expected = direction === 'undo' ? ch.after : ch.before;
      const expectedTs = direction === 'undo' ? ch.afterTs : ch.beforeTs;
      const wanted = direction === 'undo' ? ch.before : ch.after;
      const curV = cur ? cur.data[ch.field] : undefined;
      const curTs = cur?.ts[ch.field];
      if (valueEq(curV, expected) && (expectedTs === undefined || curTs === expectedTs)) {
        writes.push({ collection: ch.collection, id: ch.id, patch: { [ch.field]: wanted ?? null } });
      } else {
        conflict(ch, ch.field, 'field changed since this edit', expected, curV, wanted);
      }
      continue;
    }

    // Record-level transition.
    const restoring = direction === 'undo' ? ch.before : ch.after;
    const wasCreation = ch.before === undefined && ch.after !== undefined;
    const wasDeletion = ch.before !== undefined && ch.after === undefined;

    if (wasCreation) {
      if (direction === 'undo') {
        // Inverse of create = soft delete — only when untouched since.
        if (cur && cur.data.deleted === true) continue; // already gone
        if (cur && !recordUntouched(cur, ch.afterTs, ch.after!)) {
          conflict(ch, '*', 'record changed since it was created', ch.after, cur.data, { deleted: true });
          continue;
        }
        writes.push({ collection: ch.collection, id: ch.id, patch: { deleted: true } });
      } else {
        // Redo of the delete: recreate. Only when still gone.
        if (cur && cur.data.deleted !== true) {
          conflict(ch, '*', 'record exists again', undefined, cur.data, ch.after);
          continue;
        }
        writes.push({ collection: ch.collection, id: ch.id, patch: { ...ch.after, deleted: false } });
      }
      continue;
    }

    if (wasDeletion) {
      if (direction === 'undo') {
        // Inverse of delete = restore. Only when still deleted/missing.
        if (cur && cur.data.deleted !== true) {
          conflict(ch, '*', 'record already exists', ch.before, cur.data, { ...ch.before, deleted: false });
          continue;
        }
        writes.push({ collection: ch.collection, id: ch.id, patch: { deleted: false, ...ch.before } });
      } else {
        // Redo of restore = re-delete. Only when present and untouched.
        if (!cur || cur.data.deleted === true) continue; // already gone
        if (!recordUntouched(cur, ch.beforeTs, ch.before!)) {
          conflict(ch, '*', 'record changed since it was restored', ch.before, cur.data, { deleted: true });
          continue;
        }
        writes.push({ collection: ch.collection, id: ch.id, patch: { deleted: true } });
      }
      continue;
    }

    // Full replace (both sides defined): inverse writes the other snapshot,
    // only when the current snapshot's fields are untouched.
    const anchorTs = direction === 'undo' ? ch.afterTs : ch.beforeTs;
    const anchorData = (direction === 'undo' ? ch.after : ch.before)!;
    if (cur && cur.data.deleted === true) {
      conflict(ch, '*', 'record is deleted', anchorData, cur.data, restoring);
      continue;
    }
    if (cur && !recordUntouched(cur, anchorTs, anchorData)) {
      conflict(ch, '*', 'record changed since this edit', anchorData, cur.data, restoring);
      continue;
    }
    writes.push({ collection: ch.collection, id: ch.id, patch: { deleted: false, ...restoring } });
  }

  return { writes, conflicts };
}
