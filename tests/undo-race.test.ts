import { describe, it, expect } from 'vitest';
import { undoChangeset } from '../worker/changesets';
import type { Env, AuthUser } from '../worker/auth';

/* In-memory D1 for undoChangeset: records + changesets + changeset_items.
 * `onSelect(n)` fires after the n-th `SELECT ... WHERE id IN` on records —
 * select #1 is undo's own getRecs read, #2/#3 are applyChanges' internal
 * reads; bumping a row at #2 is the deterministic "a human wrote between the
 * undo's plan read and its writes" race (review C1). */
interface Row {
  id: string;
  collection: string;
  data: string;
  field_ts: string;
  seq: number;
  updated_by: string | null;
  updated_at: number | null;
}
interface CsRow { id: string; user_id: string; undone_by: string | null; tool: string; undoes?: string | null }

class FakeD1 {
  rows = new Map<string, Row>();
  changesets = new Map<string, CsRow>();
  csItems = new Map<string, { collection: string; record_id: string; created: number; before: string; after: string; field_ts: string }[]>();
  insertedChangesets: string[] = [];
  insertedItems = 0;
  maxSeq = 0;
  selectCount = 0;
  onSelect: ((n: number, db: FakeD1) => void) | null = null;

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
    if (/FROM changesets WHERE id = \?/.test(sql)) {
      const cs = this.changesets.get(String(binds[0]));
      return { rows: cs ? [cs as unknown as Record<string, unknown>] : [], changes: 0 };
    }
    if (/FROM changeset_items WHERE changeset_id = \?/.test(sql)) {
      return { rows: (this.csItems.get(String(binds[0])) ?? []) as unknown as Record<string, unknown>[], changes: 0 };
    }
    if (/INSERT INTO changesets/.test(sql)) {
      this.insertedChangesets.push(String(binds[0]));
      this.changesets.set(String(binds[0]), { id: String(binds[0]), user_id: String(binds[1]), undone_by: null, tool: String(binds[4] ?? 'x'), undoes: (binds[6] as string | null) ?? null });
      return { changes: 1 };
    }
    if (/INSERT INTO changeset_items/.test(sql)) {
      this.insertedItems += 1;
      return { changes: 1 };
    }
    if (/UPDATE changesets SET undone_by/.test(sql)) {
      const cs = this.changesets.get(String(binds[1]));
      if (cs) cs.undone_by = String(binds[0]);
      return { changes: 1 };
    }
    if (/WHERE id IN/.test(sql)) {
      this.selectCount += 1;
      const n = this.selectCount;
      const rows = binds.map((id) => this.rows.get(String(id))).filter((r): r is Row => !!r);
      this.onSelect?.(n, this);
      return { rows: rows as unknown as Record<string, unknown>[], changes: 0 };
    }
    if (/INSERT INTO records/.test(sql)) {
      const [id, collection, data, fieldTs, userId, now, baseSeq] = binds as [string, string, string, string, string, number, number];
      const row = this.rows.get(id);
      if (row) {
        if (row.seq !== baseSeq) return { changes: 0 }; // CAS miss
        this.maxSeq += 1;
        this.rows.set(id, { ...row, data, field_ts: fieldTs, seq: this.maxSeq, updated_by: userId, updated_at: now });
        return { changes: 1 };
      }
      this.maxSeq += 1;
      this.rows.set(id, { id, collection, data, field_ts: fieldTs, seq: this.maxSeq, updated_by: userId, updated_at: now });
      return { changes: 1 };
    }
    throw new Error(`FakeD1 unhandled SQL: ${sql.slice(0, 90)}`);
  }

  prepare(sql: string): D1PreparedStatement {
    const self = this;
    let binds: unknown[] = [];
    const stmt = {
      bind: (...b: unknown[]) => { binds = b; return stmt; },
      run: async () => { const r = self.exec(sql, binds); return { success: true, results: r.rows ?? [], meta: { changes: r.changes } }; },
      all: async () => { const r = self.exec(sql, binds); return { success: true, results: r.rows ?? [], meta: { changes: r.changes } }; },
      first: async () => { const r = self.exec(sql, binds); return (r.rows ?? [null])[0] ?? null; },
    };
    return stmt as unknown as D1PreparedStatement;
  }

  async batch(stmts: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
    const snapshot = new Map([...this.rows].map(([k, v]) => [k, { ...v }]));
    const maxSeq = this.maxSeq;
    const out: D1Result<unknown>[] = [];
    try {
      for (const s of stmts) out.push((await s.run()) as D1Result<unknown>);
    } catch (e) {
      this.rows = snapshot;
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
  it('restores untouched rows and skips a row raced after the undo read', async () => {
    const db = new FakeD1();
    seedCs(db);
    // Human write lands between undo's getRecs read (#1) and applyChanges'
    // internal read (#3 → precheck sees it): B raced.
    db.onSelect = (n) => { if (n === 2) db.bump('B', { title: 'human edit' }, { title: 20 }); };
    const out = await undoChangeset(envOf(db), user, 'cs-1');
    expect(out.ok).toBe(true);
    expect(out.restored).toBe(1);
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts![0].id).toBe('B');
    expect(JSON.parse(db.rows.get('A')!.data).title).toBe('A0'); // restored
    expect(JSON.parse(db.rows.get('B')!.data).title).toBe('human edit'); // NOT clobbered
    expect(db.insertedItems).toBe(1); // changeset records only what landed
    expect(db.changesets.get('cs-1')!.undone_by).toBe(db.insertedChangesets[0]);
  });

  it('marks nothing undone when every inverse raced — retry stays possible', async () => {
    const db = new FakeD1();
    seedCs(db);
    db.onSelect = (n) => {
      if (n === 2) {
        db.bump('A', { title: 'human A' }, { title: 20 });
        db.bump('B', { title: 'human B' }, { title: 21 });
      }
    };
    const out = await undoChangeset(envOf(db), user, 'cs-1');
    expect(out.ok).toBe(false);
    expect(out.status).toBe(409);
    expect(out.conflicts).toHaveLength(2);
    expect(JSON.parse(db.rows.get('A')!.data).title).toBe('human A');
    expect(JSON.parse(db.rows.get('B')!.data).title).toBe('human B');
    expect(db.changesets.get('cs-1')!.undone_by).toBeNull(); // still undoable
    expect(db.insertedChangesets).toHaveLength(0); // no empty undo changeset
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
  });
});
