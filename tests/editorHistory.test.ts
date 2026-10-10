import { describe, it, expect } from 'vitest';
import {
  createHistory,
  record,
  markUndone,
  markRedone,
  noteFieldWrite,
  planInverse,
  peekUndo,
  peekRedo,
  canUndo,
  canRedo,
  valueEq,
  type EditorHistory,
  type FieldChange,
  type HistoryEntry,
  type RecordChange,
  type RecordSnapshot,
} from '../shared/editorHistory';

/* A tiny in-memory "document": collection/id → {data, ts}. `docApply` mirrors
 * the real engine's mutate(): merge patch, stamp a fresh ts per field, and it
 * returns the written ts so tests capture before/after timestamps the same
 * way the client adapter does by reading the row around the write. */
type Doc = Map<string, { data: Record<string, unknown>; ts: Record<string, number> }>;

let clock = 0;
function docGet(doc: Doc, collection: string, id: string) {
  return doc.get(`${collection}/${id}`);
}
function docApply(doc: Doc, collection: string, id: string, patch: Record<string, unknown>): number {
  const cur = docGet(doc, collection, id) ?? { data: {}, ts: {} };
  const ts = ++clock;
  for (const [f, v] of Object.entries(patch)) {
    cur.data[f] = v;
    cur.ts[f] = ts;
  }
  doc.set(`${collection}/${id}`, cur);
  return ts;
}
/** Snapshot a record's data + field ts (like reading LocalRow). */
function snap(doc: Doc, collection: string, id: string): { data: Record<string, unknown>; ts: Record<string, number> } | undefined {
  const r = docGet(doc, collection, id);
  return r ? { data: { ...r.data }, ts: { ...r.ts } } : undefined;
}
const reader =
  (doc: Doc) =>
  (collection: string, id: string): RecordSnapshot | undefined =>
    docGet(doc, collection, id);

/** planInverse + apply writes + refresh expectations — the adapter's loop. */
function applyInverse(h: EditorHistory, entry: HistoryEntry, dir: 'undo' | 'redo', doc: Doc) {
  const plan = planInverse(entry, dir, reader(doc));
  if (plan.conflicts.length) return { h, plan };
  for (const w of plan.writes) {
    docApply(doc, w.collection, w.id, w.patch);
    const s = docGet(doc, w.collection, w.id)!;
    for (const f of Object.keys(w.patch)) {
      h = noteFieldWrite(h, { collection: w.collection, id: w.id, field: f, value: s.data[f], ts: s.ts[f] });
    }
  }
  return { h: dir === 'undo' ? markUndone(h) : markRedone(h), plan };
}

const field = (over: Partial<FieldChange>): FieldChange => ({ kind: 'field', collection: 'blocks', id: 'b1', field: 'text', ...over }) as FieldChange;
const rec = (over: Partial<RecordChange>): RecordChange => ({ kind: 'record', collection: 'blocks', id: 'b2', ...over }) as RecordChange;
const entry = (changes: HistoryEntry['changes'], over: Partial<HistoryEntry> = {}): HistoryEntry => ({ changes, at: 1, ...over }) as HistoryEntry;

describe('editorHistory — field edits', () => {
  it('undoes and redoes a single field write', () => {
    const doc: Doc = new Map();
    const t0 = docApply(doc, 'blocks', 'b1', { text: 'hi' });
    let h = createHistory();
    const t1 = docApply(doc, 'blocks', 'b1', { text: 'hello' });
    h = record(h, entry([field({ before: 'hi', after: 'hello', beforeTs: t0, afterTs: t1 })]));

    ({ h } = applyInverse(h, peekUndo(h)!, 'undo', doc));
    expect(docGet(doc, 'blocks', 'b1')!.data.text).toBe('hi');
    expect(canRedo(h)).toBe(true);

    ({ h } = applyInverse(h, peekRedo(h)!, 'redo', doc));
    expect(docGet(doc, 'blocks', 'b1')!.data.text).toBe('hello');
    expect(canUndo(h)).toBe(true);
  });

  it('refuses undo when a remote edit intervened, keeping the candidate for review', () => {
    const doc: Doc = new Map();
    const t0 = docApply(doc, 'blocks', 'b1', { text: 'hi' });
    let h = createHistory();
    const t1 = docApply(doc, 'blocks', 'b1', { text: 'hello' });
    h = record(h, entry([field({ before: 'hi', after: 'hello', beforeTs: t0, afterTs: t1 })]));

    docApply(doc, 'blocks', 'b1', { text: 'remote edit' }); // someone else wrote
    const { h: h2, plan } = applyInverse(h, peekUndo(h)!, 'undo', doc);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].wanted).toBe('hi');
    expect(plan.conflicts[0].current).toBe('remote edit');
    expect(docGet(doc, 'blocks', 'b1')!.data.text).toBe('remote edit');
    expect(h2).toBe(h); // nothing applied, nothing moved to redo
  });

  it('coalesces contiguous typing groups into one entry', () => {
    const doc: Doc = new Map();
    docApply(doc, 'blocks', 'b1', { text: '' });
    let h = createHistory();
    const group = 'type:b1:text';
    const steps = ['h', 'he', 'hel', 'hell', 'hello'];
    for (const [i, text] of steps.entries()) {
      const before = i === 0 ? '' : steps[i - 1];
      const beforeSnap = snap(doc, 'blocks', 'b1')!.ts.text;
      const ts = docApply(doc, 'blocks', 'b1', { text });
      h = record(h, entry([field({ before, after: text, beforeTs: beforeSnap, afterTs: ts })], { group, at: i }));
    }
    expect(h.undo).toHaveLength(1);
    ({ h } = applyInverse(h, peekUndo(h)!, 'undo', doc));
    expect(docGet(doc, 'blocks', 'b1')!.data.text).toBe('');
  });

  it('starts a new entry when the chain broke (non-contiguous value)', () => {
    let h = createHistory();
    const group = 'type:b1:text';
    h = record(h, entry([field({ before: 'a', after: 'ab', afterTs: 1 })], { group }));
    // Remote rewrote the field between keystrokes: next edit's before isn't 'ab'
    h = record(h, entry([field({ before: 'xyz', after: 'xyz!', afterTs: 3 })], { group }));
    expect(h.undo).toHaveLength(2);
  });

  it('clears the redo stack when a new local edit is recorded', () => {
    const doc: Doc = new Map();
    const t0 = docApply(doc, 'blocks', 'b1', { text: 'hi' });
    let h = createHistory();
    const t1 = docApply(doc, 'blocks', 'b1', { text: 'hello' });
    h = record(h, entry([field({ before: 'hi', after: 'hello', beforeTs: t0, afterTs: t1 })]));
    ({ h } = applyInverse(h, peekUndo(h)!, 'undo', doc));
    expect(canRedo(h)).toBe(true);
    // A fresh local edit invalidates redo.
    const t2 = docApply(doc, 'blocks', 'b1', { text: 'new' });
    h = record(h, entry([field({ before: 'hi', after: 'new', beforeTs: t0, afterTs: t2 })]));
    expect(canRedo(h)).toBe(false);
  });

  it('keeps chained undos valid: own inverse writes refresh timestamps', () => {
    const doc: Doc = new Map();
    const t0 = docApply(doc, 'blocks', 'b1', { text: 'a' });
    let h = createHistory();
    const t1 = docApply(doc, 'blocks', 'b1', { text: 'b' });
    h = record(h, entry([field({ before: 'a', after: 'b', beforeTs: t0, afterTs: t1 })]));
    const t2 = docApply(doc, 'blocks', 'b1', { text: 'c' });
    h = record(h, entry([field({ before: 'b', after: 'c', beforeTs: t1, afterTs: t2 })]));

    ({ h } = applyInverse(h, peekUndo(h)!, 'undo', doc)); // c → b
    ({ h } = applyInverse(h, peekUndo(h)!, 'undo', doc)); // b → a — must still apply
    expect(docGet(doc, 'blocks', 'b1')!.data.text).toBe('a');
    expect(h.undo).toHaveLength(0);
    // …and redo walks back up the chain (redo pops from the end)
    ({ h } = applyInverse(h, peekRedo(h)!, 'redo', doc)); // a → b
    ({ h } = applyInverse(h, peekRedo(h)!, 'redo', doc)); // b → c
    expect(docGet(doc, 'blocks', 'b1')!.data.text).toBe('c');
  });

  it('accepts a foreign rewrite of the same value (refreshed expectation)', () => {
    const doc: Doc = new Map();
    const t0 = docApply(doc, 'blocks', 'b1', { text: 'hi' });
    let h = createHistory();
    const t1 = docApply(doc, 'blocks', 'b1', { text: 'hello' });
    h = record(h, entry([field({ before: 'hi', after: 'hello', beforeTs: t0, afterTs: t1 })]));
    // Foreign rewrite of the SAME value with a new ts: expectation follows it.
    const t2 = docApply(doc, 'blocks', 'b1', { text: 'hello' });
    h = noteFieldWrite(h, { collection: 'blocks', id: 'b1', field: 'text', value: 'hello', ts: t2 });
    const plan = planInverse(peekUndo(h)!, 'undo', reader(doc));
    expect(plan.conflicts).toHaveLength(0);
  });
});

describe('editorHistory — structural ops', () => {
  it('roundtrips a block split (update + create)', () => {
    const doc: Doc = new Map();
    const t0 = docApply(doc, 'blocks', 'b1', { text: 'helloworld', order: 'a0' });
    // split 'helloworld' → 'hello' | 'world'(new b2)
    const t1 = docApply(doc, 'blocks', 'b1', { text: 'hello' });
    docApply(doc, 'blocks', 'b2', { pageId: 'p1', text: 'world', order: 'a1' });
    const b2snap = snap(doc, 'blocks', 'b2')!;
    const split = entry([
      field({ id: 'b1', before: 'helloworld', after: 'hello', beforeTs: t0, afterTs: t1 }),
      rec({ id: 'b2', after: { pageId: 'p1', text: 'world', order: 'a1' }, afterTs: b2snap.ts }),
    ]);
    let h = record(createHistory(), split);

    ({ h } = applyInverse(h, peekUndo(h)!, 'undo', doc));
    expect(docGet(doc, 'blocks', 'b1')!.data.text).toBe('helloworld');
    expect(docGet(doc, 'blocks', 'b2')!.data.deleted).toBe(true);

    ({ h } = applyInverse(h, peekRedo(h)!, 'redo', doc));
    expect(docGet(doc, 'blocks', 'b1')!.data.text).toBe('hello');
    expect(docGet(doc, 'blocks', 'b2')!.data.deleted).toBe(false);
    expect(docGet(doc, 'blocks', 'b2')!.data.text).toBe('world');
  });

  it('roundtrips a merge (update + delete) and restores the deleted block', () => {
    const doc: Doc = new Map();
    docApply(doc, 'blocks', 'b1', { text: 'hello', order: 'a0' });
    docApply(doc, 'blocks', 'b2', { text: 'world', order: 'a1' });
    const t0 = docGet(doc, 'blocks', 'b1')!.ts.text;
    const b2before = snap(doc, 'blocks', 'b2')!;
    // merge b2 into b1: b1.text += b2.text, b2 deleted
    const t1 = docApply(doc, 'blocks', 'b1', { text: 'helloworld' });
    docApply(doc, 'blocks', 'b2', { deleted: true });
    let h = createHistory();
    h = record(
      h,
      entry([
        field({ id: 'b1', before: 'hello', after: 'helloworld', beforeTs: t0, afterTs: t1 }),
        rec({ id: 'b2', before: b2before.data, beforeTs: b2before.ts }),
      ]),
    );
    ({ h } = applyInverse(h, peekUndo(h)!, 'undo', doc));
    expect(docGet(doc, 'blocks', 'b1')!.data.text).toBe('hello');
    expect(docGet(doc, 'blocks', 'b2')!.data.deleted).toBe(false);
    expect(docGet(doc, 'blocks', 'b2')!.data.text).toBe('world');
  });

  it('roundtrips a reorder (order field writes on several records)', () => {
    const doc: Doc = new Map();
    docApply(doc, 'blocks', 'b1', { order: 'a0' });
    docApply(doc, 'blocks', 'b2', { order: 'a1' });
    const t1 = docApply(doc, 'blocks', 'b1', { order: 'a2' });
    const t2 = docApply(doc, 'blocks', 'b2', { order: 'a0' });
    let h = createHistory();
    h = record(
      h,
      entry([
        field({ id: 'b1', field: 'order', before: 'a0', after: 'a2', beforeTs: 1, afterTs: t1 }),
        field({ id: 'b2', field: 'order', before: 'a1', after: 'a0', beforeTs: 1, afterTs: t2 }),
      ]),
    );
    ({ h } = applyInverse(h, peekUndo(h)!, 'undo', doc));
    expect(docGet(doc, 'blocks', 'b1')!.data.order).toBe('a0');
    expect(docGet(doc, 'blocks', 'b2')!.data.order).toBe('a1');
  });

  it('refuses to delete a created record that someone edited since', () => {
    const doc: Doc = new Map();
    docApply(doc, 'blocks', 'b2', { text: 'world', order: 'a1' });
    const s = snap(doc, 'blocks', 'b2')!;
    const h = record(createHistory(), entry([rec({ id: 'b2', after: s.data, afterTs: s.ts })]));
    docApply(doc, 'blocks', 'b2', { text: 'world!' }); // remote edit after creation
    const plan = planInverse(peekUndo(h)!, 'undo', reader(doc));
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].field).toBe('*');
    expect(plan.writes).toHaveLength(0);
    expect(docGet(doc, 'blocks', 'b2')!.data.deleted).toBeUndefined();
  });

  it('treats an already-deleted created record as satisfied (no write)', () => {
    const doc: Doc = new Map();
    docApply(doc, 'blocks', 'b2', { text: 'w' });
    const s = snap(doc, 'blocks', 'b2')!;
    docApply(doc, 'blocks', 'b2', { deleted: true });
    const h = record(createHistory(), entry([rec({ id: 'b2', after: s.data, afterTs: s.ts })]));
    const plan = planInverse(peekUndo(h)!, 'undo', reader(doc));
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.writes).toHaveLength(0);
  });

  it('preserves caret bookmarks through coalescing', () => {
    let h = createHistory();
    const group = 'type:b1:text';
    h = record(
      h,
      entry([field({ before: '', after: 'h' })], {
        group,
        caret: { before: { recordId: 'b1', field: 'text', offset: 0 }, after: { recordId: 'b1', field: 'text', offset: 1 } },
      }),
    );
    h = record(
      h,
      entry([field({ before: 'h', after: 'hi' })], { group, caret: { after: { recordId: 'b1', field: 'text', offset: 2 } } }),
    );
    const top = peekUndo(h)!;
    expect(top.caret?.before?.offset).toBe(0);
    expect(top.caret?.after?.offset).toBe(2);
  });
});

describe('valueEq', () => {
  it('compares objects by content regardless of key order', () => {
    expect(valueEq({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 })).toBe(true);
    expect(valueEq({ a: 1 }, { a: 2 })).toBe(false);
  });
  it('distinguishes absent (undefined) from explicit null', () => {
    expect(valueEq(undefined, null)).toBe(false);
    expect(valueEq(undefined, undefined)).toBe(true);
  });
});
