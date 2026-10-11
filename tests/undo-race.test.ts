import { describe, it, expect } from 'vitest';
import { beginChangeset, commitChangeset, undoChangeset } from '../worker/changesets';
import type { Env, AuthUser } from '../worker/auth';
import { parseGate } from '../shared/approvals';

/* In-memory D1 for undoChangeset control flow, not SQL transaction proof.
 * onRead receives the actual record SELECT and its bindings after taking a
 * read snapshot. A one-shot callback then changes persisted state, modeling
 * a human write after undo read its revisions and before inverse writes. */
interface Row {
  id: string;
  collection: string;
  data: string;
  field_ts: string;
  seq: number;
  updated_by: string | null;
  updated_at: number | null;
}
interface CsRow { id: string; user_id: string; undone_by: string | null; tool: string; undoes?: string | null; item_count?: number }

class FakeD1 {
  rows = new Map<string, Row>();
  changesets = new Map<string, CsRow>();
  csItems = new Map<string, { collection: string; record_id: string; created: number; before: string; after: string; field_ts: string }[]>();
  events = new Map<string, { id: string; payload: string; created_at: number; processed_at: number | null; attempts: number }>();
  insertedChangesets: string[] = [];
  insertedItems = 0;
  maxSeq = 0;
  lastChanges = 0;
  onRead: ((statement: { sql: string; binds: unknown[] }, db: FakeD1) => void) | null = null;

  put(id: string, seq: number, data: Record<string, unknown>, fieldTs: Record<string, number>) {
    this.rows.set(id, { id, collection: 'tasks', data: JSON.stringify(data), field_ts: JSON.stringify(fieldTs), seq, updated_by: 'seed', updated_at: 1 });
    this.maxSeq = Math.max(this.maxSeq, seq);
  }
  bump(id: string, data: Record<string, unknown>, fieldTs: Record<string, number>) {
    const r = this.rows.get(id)!;
    this.maxSeq += 1;
    this.rows.set(id, { ...r, data: JSON.stringify(data), field_ts: JSON.stringify(fieldTs), seq: this.maxSeq });
  }

  exec(sql: string, binds: unknown[]): { rows?: Record<string, unknown>[]; changes: number } {
    if (/INSERT OR IGNORE INTO event_outbox/.test(sql)) {
      const id = String(binds[0]);
      const record = this.rows.get(String(binds[3]));
      if (this.lastChanges !== 1 || this.events.has(id) || !record) return { changes: 0 };
      const payload = JSON.parse(String(binds[1]));
      payload.applied[0].rev = record.seq;
      this.events.set(id, { id, payload: JSON.stringify(payload), created_at: Number(binds[2]), processed_at: null, attempts: 0 });
      return { changes: 1 };
    }
    if (/SELECT .* FROM event_outbox WHERE id\s*=\s*\?/.test(sql)) {
      const row = this.events.get(String(binds[0]));
      return { rows: row ? [{ ...row }] : [], changes: 0 };
    }
    if (/^UPDATE (?:automation_runs|form_submissions)\b/.test(sql)) {
      // No executions/submissions are seeded by this undo fixture. Their
      // cancellation therefore affects zero rows; real execution cancellation
      // is verified in phase4-events-d1.test.ts, not inferred from this fake.
      return { changes: 0 };
    }
    if (/SELECT CASE WHEN NOT EXISTS/.test(sql) && /approvalGate/.test(sql)) {
      const next = JSON.parse(String(binds[0]));
      const previous = JSON.parse(String(binds[3]));
      const board = this.rows.get(next.boardId ?? 'board-default');
      const gate = board?.collection === 'boards' ? parseGate(JSON.parse(board.data)) : null;
      if (gate && next.status === gate.stageId && (next.status !== previous.status || next.boardId !== previous.boardId || gate.approverField)) throw new Error('malformed JSON');
      return { rows: [{ allowed: 1 }], changes: 0 };
    }
    if (/JOIN json_each\(\?\)/.test(sql)) {
      const expectations = JSON.parse(String(binds[0])) as Record<string, number>;
      for (const [id, rev] of Object.entries(expectations)) {
        const row = this.rows.get(id);
        if (row && row.seq !== rev) throw new Error('malformed JSON');
      }
      return { rows: [{ allowed: 1 }], changes: 0 };
    }
    if (/FROM changesets WHERE id = \?/.test(sql)) {
      const cs = this.changesets.get(String(binds[0]));
      return { rows: cs ? [cs as unknown as Record<string, unknown>] : [], changes: 0 };
    }
    if (/FROM changeset_items WHERE changeset_id = \?/.test(sql)) {
      return { rows: (this.csItems.get(String(binds[0])) ?? []) as unknown as Record<string, unknown>[], changes: 0 };
    }
    if (/INSERT(?: OR IGNORE)? INTO changesets/.test(sql)) {
      if (/OR IGNORE/.test(sql) && this.changesets.has(String(binds[0]))) return { changes: 0 };
      this.insertedChangesets.push(String(binds[0]));
      this.changesets.set(String(binds[0]), { id: String(binds[0]), user_id: String(binds[1]), undone_by: null, tool: String(binds[4] ?? 'x'), undoes: (binds[7] as string | null) ?? null, item_count: binds.length === 9 ? 0 : Number(binds[8] ?? 0) });
      return { changes: 1 };
    }
    if (/INSERT INTO changeset_items/.test(sql)) {
      const items = this.csItems.get(String(binds[0])) ?? [];
      if (/WHERE changes\(\)=1/.test(sql) && this.lastChanges !== 1) return { changes: 0 };
      if (/NOT EXISTS\s*\(SELECT 1 FROM changeset_items/.test(sql) && items.some(item => item.record_id === binds[9] && item.field_ts === binds[10])) return { changes: 0 };
      items.push({ collection: String(binds[2]), record_id: String(binds[3]), created: Number(binds[4]), before: String(binds[5]), after: String(binds[6]), field_ts: String(binds[7]) });
      this.csItems.set(String(binds[0]), items);
      this.insertedItems += 1;
      return { changes: 1 };
    }
    if (/UPDATE changesets SET item_count/.test(sql)) {
      const cs = this.changesets.get(String(binds[1]));
      if (cs) cs.item_count = (this.csItems.get(String(binds[0])) ?? []).length;
      return { changes: cs ? 1 : 0 };
    }
    if (/UPDATE changesets SET undone_by/.test(sql)) {
      const cs = this.changesets.get(String(binds[1]));
      if (cs) cs.undone_by = String(binds[0]);
      return { changes: 1 };
    }
    if (/WHERE id IN/.test(sql)) {
      const rows = binds.map((id) => this.rows.get(String(id))).filter((r): r is Row => !!r);
      this.onRead?.({ sql, binds }, this);
      return { rows: rows as unknown as Record<string, unknown>[], changes: 0 };
    }
    if (/INSERT INTO records/.test(sql)) {
      const [id, collection, data, fieldTs, userId, now, baseSeq] = binds as [string, string, string, string, string, number, number];
      const row = this.rows.get(id);
      if (row) {
        if (row.seq !== baseSeq) return { changes: 0 }; // CAS miss
        this.maxSeq += 1;
        this.rows.set(id, { ...row, data, field_ts: fieldTs, seq: this.maxSeq, updated_by: userId, updated_at: now });
        return { rows: [{ seq: this.maxSeq }], changes: 1 };
      }
      this.maxSeq += 1;
      this.rows.set(id, { id, collection, data, field_ts: fieldTs, seq: this.maxSeq, updated_by: userId, updated_at: now });
      return { rows: [{ seq: this.maxSeq }], changes: 1 };
    }
    throw new Error(`FakeD1 unhandled SQL: ${sql.slice(0, 90)}`);
  }

  prepare(sql: string): D1PreparedStatement {
    const self = this;
    let binds: unknown[] = [];
    const execute = () => {
      const result = self.exec(sql, binds);
      // SQLite changes() is unaffected by SELECT, even though SELECT's
      // own D1 meta.changes is zero.
      if (/^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(sql)) self.lastChanges = result.changes;
      return result;
    };
    const stmt = {
      bind: (...b: unknown[]) => { binds = b; return stmt; },
      run: async () => { const r = execute(); return { success: true, results: r.rows ?? [], meta: { changes: r.changes } }; },
      all: async () => { const r = execute(); return { success: true, results: r.rows ?? [], meta: { changes: r.changes } }; },
      first: async () => { const r = execute(); return (r.rows ?? [null])[0] ?? null; },
    };
    return stmt as unknown as D1PreparedStatement;
  }

  async batch(stmts: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
    const snapshot = new Map([...this.rows].map(([k, v]) => [k, { ...v }]));
    const changesets = new Map([...this.changesets].map(([k, v]) => [k, { ...v }]));
    const items = new Map([...this.csItems].map(([k, v]) => [k, v.map(item => ({ ...item }))]));
    const events = new Map([...this.events].map(([k, v]) => [k, { ...v }]));
    const inserted = [...this.insertedChangesets];
    const insertedItems = this.insertedItems;
    const lastChanges = this.lastChanges;
    const maxSeq = this.maxSeq;
    const out: D1Result<unknown>[] = [];
    try {
      for (const s of stmts) out.push((await s.run()) as D1Result<unknown>);
    } catch (e) {
      this.rows = snapshot;
      this.changesets = changesets;
      this.csItems = items;
      this.events = events;
      this.insertedChangesets = inserted;
      this.insertedItems = insertedItems;
      this.lastChanges = lastChanges;
      this.maxSeq = maxSeq;
      throw e;
    }
    return out;
  }
}

const envOf = (db: FakeD1) => ({ DB: db }) as unknown as Env;
const user = { id: 'u-admin', role: 'admin' } as AuthUser;

/* Seed: a change set that set A.title→'A1' and B.title→'B1' at t=10. */
function seedCs(db: FakeD1) {
  db.changesets.set('cs-1', { id: 'cs-1', user_id: 'u-admin', undone_by: null, tool: 'update_tasks' });
  db.csItems.set('cs-1', [
    { collection: 'tasks', record_id: 'A', created: 0, before: JSON.stringify({ title: 'A0' }), after: JSON.stringify({ title: 'A1' }), field_ts: JSON.stringify({ title: 10 }) },
    { collection: 'tasks', record_id: 'B', created: 0, before: JSON.stringify({ title: 'B0' }), after: JSON.stringify({ title: 'B1' }), field_ts: JSON.stringify({ title: 10 }) },
  ]);
  db.put('A', 5, { title: 'A1' }, { title: 10 });
  db.put('B', 7, { title: 'B1' }, { title: 10 });
}

describe('undoChangeset inverse-patch rev guards (review C1)', () => {
  it('commitChangeset replays neither its header nor already recorded audit items', async () => {
    const db = new FakeD1();
    const cs = beginChangeset({ userId: 'u-admin', tool: 'update_tasks' });
    cs.items = [{ id: 'A', collection: 'tasks', created: false, fields: ['title'], before: { title: 'A0' }, after: { title: 'A1' }, fieldTs: { title: 10 }, rev: 5 }];
    expect(await commitChangeset(envOf(db), cs)).toBe(cs.id);
    expect(await commitChangeset(envOf(db), cs)).toBe(cs.id);
    expect(db.insertedChangesets).toEqual([cs.id]);
    expect(db.insertedItems).toBe(1);
    expect(db.csItems.get(cs.id)).toEqual([{ collection: 'tasks', record_id: 'A', created: 0, before: JSON.stringify({ title: 'A0' }), after: JSON.stringify({ title: 'A1' }), field_ts: JSON.stringify({ title: 10 }) }]);
    expect(db.changesets.get(cs.id)?.item_count).toBe(1);
  });
  it('restores untouched rows and skips a row raced after the undo read', async () => {
    const db = new FakeD1();
    seedCs(db);
    db.onRead = (statement) => {
      expect(statement.sql).toMatch(/SELECT id, collection, data, field_ts, seq/);
      expect(statement.binds).toEqual(['A', 'B']);
      db.onRead = null;
      db.bump('B', { title: 'human edit' }, { title: 20 });
    };
    const out = await undoChangeset(envOf(db), user, 'cs-1');
    expect(out.ok).toBe(true);
    expect(out.restored).toBe(1);
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts![0].id).toBe('B');
    expect(JSON.parse(db.rows.get('A')!.data).title).toBe('A0'); // restored
    expect(JSON.parse(db.rows.get('B')!.data).title).toBe('human edit'); // NOT clobbered
    expect(db.insertedItems).toBe(1); // changeset records only what landed
    expect(db.events.size).toBe(1);
    expect(JSON.parse([...db.events.values()][0].payload)).toMatchObject({ source: 'undo', changesetId: db.insertedChangesets[0], applied: [{ id: 'A' }] });
    expect(db.changesets.get('cs-1')!.undone_by).toBe(db.insertedChangesets[0]);
  });

  it('marks nothing undone when every inverse raced — retry stays possible', async () => {
    const db = new FakeD1();
    seedCs(db);
    db.onRead = (statement) => {
      expect(statement.sql).toMatch(/SELECT id, collection, data, field_ts, seq/);
      expect(statement.binds).toEqual(['A', 'B']);
      db.onRead = null;
      db.bump('A', { title: 'human A' }, { title: 20 });
      db.bump('B', { title: 'human B' }, { title: 21 });
    };
    const out = await undoChangeset(envOf(db), user, 'cs-1');
    expect(out.ok).toBe(false);
    expect(out.status).toBe(409);
    expect(out.conflicts).toHaveLength(2);
    expect(JSON.parse(db.rows.get('A')!.data).title).toBe('human A');
    expect(JSON.parse(db.rows.get('B')!.data).title).toBe('human B');
    expect(db.changesets.get('cs-1')!.undone_by).toBeNull(); // still undoable
    expect(db.insertedChangesets).toHaveLength(0); // no empty undo changeset
    expect(db.events.size).toBe(0);
  });

  it('restores all rows cleanly when nothing raced', async () => {
    const db = new FakeD1();
    seedCs(db);
    const out = await undoChangeset(envOf(db), user, 'cs-1');
    expect(out.ok).toBe(true);
    expect(out.restored).toBe(2);
    expect(out.conflicts).toBeUndefined();
    expect(JSON.parse(db.rows.get('A')!.data).title).toBe('A0');
    expect(JSON.parse(db.rows.get('B')!.data).title).toBe('B0');
    expect(db.insertedItems).toBe(2);
    expect(db.events.size).toBe(2);
  });
});
