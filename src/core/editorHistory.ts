/* Client adapter for shared/editorHistory (Phase 1 §12.1).
 *
 * Bridges the pure history to the local store: every committed write still
 * goes through mutate() (one write path), we just snapshot the record's field
 * values/timestamps around it so undo/redo can verify nobody intervened —
 * including a remote pull winning LWW — before applying the inverse. On
 * conflict the intended inverse is preserved as a draft envelope
 * ('undo-conflict') so the user can compare/copy/reapply explicitly.
 *
 * One history per editor surface (page body, record body, capture…):
 *   const h = beginEditing(`page:${pageId}`);
 *   await commitFields(h, 'blocks', blockId, { text: next }, { group: `type:${blockId}:text` });
 *   const r = await undo(h); // 'applied' | 'conflict' | 'none'
 */

import { stableJson } from '../../shared/stablejson';
import type { Collection } from '../../shared/collections';
import {
  createHistory,
  markRedone,
  markUndone,
  noteFieldWrite,
  peekRedo,
  peekUndo,
  planInverse,
  record,
  valueEq,
  canRedo as ehCanRedo,
  canUndo as ehCanUndo,
  type CaretBookmark,
  type EditorHistory,
  type FieldChange,
  type HistoryChange,
  type HistoryEntry,
  type InverseConflict,
  type RecordChange,
} from '../../shared/editorHistory';
import { db } from './db';
import { saveDraft } from './drafts';
import { createStore } from './store';
import { mutate } from './sync/engine';

const histories = new Map<string, EditorHistory>();

/** Bumped on every history mutation so `canUndo`/`canRedo` stay reactive. */
export const historyVersion = createStore(0);

export function beginEditing(editorId: string, limit?: number): string {
  if (!histories.has(editorId)) histories.set(editorId, createHistory(limit));
  return editorId;
}

/** Drop an editor's history (surface closed). Drafts are unaffected. */
export function endEditing(editorId: string): void {
  if (histories.delete(editorId)) historyVersion.set((v) => v + 1);
}

export function historyOf(editorId: string): EditorHistory | undefined {
  return histories.get(editorId);
}

export function canUndo(editorId: string): boolean {
  const h = histories.get(editorId);
  return h ? ehCanUndo(h) : false;
}
export function canRedo(editorId: string): boolean {
  const h = histories.get(editorId);
  return h ? ehCanRedo(h) : false;
}

function setHistory(editorId: string, h: EditorHistory): void {
  histories.set(editorId, h);
  historyVersion.set((v) => v + 1);
}

interface Snapshot {
  data: Record<string, unknown>;
  ts: Record<string, number>;
}

async function snapshot(collection: Collection, id: string): Promise<Snapshot | undefined> {
  const row = await db.collection(collection).get(id);
  if (!row) return undefined;
  const data = { ...row } as Record<string, unknown>;
  delete data._ts;
  const ts = { ...(row._ts as Record<string, number> | undefined) };
  return { data, ts };
}

export interface CommitOpts {
  /** Coalescing key, e.g. `type:${blockId}:text` — contiguous same-field writes merge. */
  group?: string;
  label?: string;
  caret?: { before?: CaretBookmark; after?: CaretBookmark };
}

/**
 * Commit a field patch through mutate() and record its inverse. No-op fields
 * (patch value already canonical) are skipped so undo never replays noise.
 */
export async function commitFields(
  editorId: string,
  collection: Collection,
  id: string,
  patch: Record<string, unknown>,
  opts?: CommitOpts,
): Promise<void> {
  const before = await snapshot(collection, id);
  const fields = Object.keys(patch).filter((f) => !valueEq(before?.data[f], patch[f]));
  if (!fields.length) return;
  const filtered: Record<string, unknown> = {};
  for (const f of fields) filtered[f] = patch[f];
  await mutate(collection, id, filtered);
  const after = await snapshot(collection, id);
  const changes: HistoryChange[] = fields.map((f) => ({
    kind: 'field',
    collection,
    id,
    field: f,
    before: before?.data[f],
    after: filtered[f],
    beforeTs: before?.ts[f],
    afterTs: after?.ts[f],
  }));
  pushEntry(editorId, { changes, at: Date.now(), ...opts });
  notifyWrites(editorId, changes);
}

/** A structural write for commitWrites: creates/deletes flag whole-record transitions. */
export interface StructuralWrite {
  collection: Collection;
  id: string;
  patch: Record<string, unknown>;
  /** The record did not exist before this write — inverse is soft-delete. */
  creates?: boolean;
  /** This write removes the record — inverse restores its pre-delete fields. */
  deletes?: boolean;
}

/**
 * Commit a structural operation (split/merge/insert/delete/reorder) as ONE
 * history entry spanning several records, then mutate each write in order.
 */
export async function commitWrites(
  editorId: string,
  writes: StructuralWrite[],
  opts?: CommitOpts,
): Promise<void> {
  const changes: HistoryChange[] = [];
  for (const w of writes) {
    const before = await snapshot(w.collection, w.id);
    const fields = Object.keys(w.patch).filter((f) => w.deletes || w.creates || !valueEq(before?.data[f], w.patch[f]));
    if (!fields.length && !w.creates && !w.deletes) continue;
    const filtered: Record<string, unknown> = {};
    for (const f of fields) filtered[f] = w.patch[f];
    await mutate(w.collection, w.id, filtered);
    const after = await snapshot(w.collection, w.id);
    if (w.creates) {
      const data = { ...(after?.data ?? filtered) };
      delete data.deleted;
      changes.push({ kind: 'record', collection: w.collection, id: w.id, after: data, afterTs: after?.ts } satisfies RecordChange);
    } else if (w.deletes) {
      changes.push({ kind: 'record', collection: w.collection, id: w.id, before: before?.data, beforeTs: before?.ts } satisfies RecordChange);
    } else {
      for (const f of fields) {
        changes.push({
          kind: 'field',
          collection: w.collection,
          id: w.id,
          field: f,
          before: before?.data[f],
          after: filtered[f],
          beforeTs: before?.ts[f],
          afterTs: after?.ts[f],
        } satisfies FieldChange);
      }
    }
  }
  if (!changes.length) return;
  pushEntry(editorId, { changes, at: Date.now(), ...opts });
  notifyWrites(editorId, changes);
}

function pushEntry(editorId: string, entry: HistoryEntry): void {
  const h = histories.get(editorId) ?? createHistory();
  setHistory(editorId, record(h, entry));
}

/**
 * After our own forward/inverse writes, refresh the expected timestamps on
 * every stacked entry that anticipates the value just written — that's what
 * keeps long undo chains (a→b→c→b→a) passing the no-intervention check while
 * foreign writes still conflict.
 */
function notifyWrites(editorId: string, changes: HistoryChange[]): void {
  let h = histories.get(editorId);
  if (!h) return;
  for (const ch of changes) {
    if (ch.kind === 'field' && ch.afterTs !== undefined) {
      h = noteFieldWrite(h, { collection: ch.collection, id: ch.id, field: ch.field, value: ch.after, ts: ch.afterTs });
    } else if (ch.kind === 'record' && ch.afterTs) {
      for (const [f, ts] of Object.entries(ch.afterTs)) {
        h = noteFieldWrite(h, { collection: ch.collection, id: ch.id, field: f, value: ch.after?.[f], ts });
      }
    }
  }
  setHistory(editorId, h);
}

async function applyInverseFor(editorId: string, direction: 'undo' | 'redo'): Promise<UndoResult> {
  const h = histories.get(editorId);
  if (!h) return { status: 'none' };
  const e = direction === 'undo' ? peekUndo(h) : peekRedo(h);
  if (!e) return { status: 'none' };
  const snapshots = new Map<string, Snapshot | undefined>();
  const reader = (collection: string, id: string): Snapshot | undefined => snapshots.get(`${collection}/${id}`);
  // Snapshot once up front: the conflict check must see pre-write state.
  for (const ch of e.changes) {
    const k = `${ch.collection}/${ch.id}`;
    if (!snapshots.has(k)) snapshots.set(k, await snapshot(ch.collection as Collection, ch.id));
  }
  const plan = planInverse(e, direction, reader);
  if (plan.conflicts.length) {
    await preserveConflicts(plan.conflicts);
    return { status: 'conflict', entry: e, conflicts: plan.conflicts };
  }
  // Group writes by record → one mutate per record.
  const byRecord = new Map<string, { collection: Collection; id: string; patch: Record<string, unknown> }>();
  for (const w of plan.writes) {
    const k = `${w.collection}/${w.id}`;
    const acc = byRecord.get(k) ?? { collection: w.collection as Collection, id: w.id, patch: {} };
    Object.assign(acc.patch, w.patch);
    byRecord.set(k, acc);
  }
  let cur: EditorHistory = h;
  for (const w of byRecord.values()) {
    await mutate(w.collection, w.id, w.patch);
    const after = await snapshot(w.collection, w.id);
    for (const f of Object.keys(w.patch)) {
      cur = noteFieldWrite(cur, { collection: w.collection, id: w.id, field: f, value: after?.data[f], ts: after?.ts[f] });
    }
  }
  setHistory(editorId, direction === 'undo' ? markUndone(cur) : markRedone(cur));
  return { status: 'applied', entry: e, caret: direction === 'undo' ? e.caret?.before : e.caret?.after };
}

/** Keep refused inverses recoverable: candidate values become drafts. */
async function preserveConflicts(conflicts: InverseConflict[]): Promise<void> {
  const byRecord = new Map<string, { collection: Collection; id: string; values: Record<string, unknown> }>();
  for (const c of conflicts) {
    const k = `${c.collection}/${c.id}`;
    const acc = byRecord.get(k) ?? { collection: c.collection as Collection, id: c.id, values: {} };
    if (c.field === '*') {
      // Whole-record conflict: preserve every wanted field.
      if (c.wanted && typeof c.wanted === 'object' && !Array.isArray(c.wanted)) Object.assign(acc.values, c.wanted);
    } else {
      acc.values[c.field] = c.wanted;
    }
    byRecord.set(k, acc);
  }
  for (const w of byRecord.values()) {
    if (Object.keys(w.values).length) await saveDraft(w.collection, w.id, w.values, { source: 'undo-conflict' });
  }
}

export type UndoResult =
  | { status: 'none' }
  | { status: 'applied'; entry: HistoryEntry; caret?: CaretBookmark }
  | { status: 'conflict'; entry: HistoryEntry; conflicts: InverseConflict[] };

export function undo(editorId: string): Promise<UndoResult> {
  return applyInverseFor(editorId, 'undo');
}
export function redo(editorId: string): Promise<UndoResult> {
  return applyInverseFor(editorId, 'redo');
}

/** Re-export the pure surface editors/tests may need. */
export type { CaretBookmark, HistoryEntry, InverseConflict };
export { stableJson };
