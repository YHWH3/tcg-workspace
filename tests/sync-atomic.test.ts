import { describe, it, expect } from 'vitest';
import { applyChanges } from '../worker/sync';
import type { Env } from '../worker/auth';
import type { Mutation } from '../shared/types';

/* Minimal in-memory D1 covering exactly the statements applyChanges uses.
 * batch() is atomic (snapshot/rollback) like real D1; `interleave(i)` runs
 * inside the batch — index 0 models a write that landed between the
 * expectedRev precheck and the atomic write batch starting (the only
 * externally reachable race window). */
interface Row {
  id: string;
  collection: string;
  data: string;
  field_ts: string;
  seq: number;
  updated_by: string | null;
  updated_at: number | null;
}

class FakeD1 {
  rows = new Map<string, Row>();
  maxSeq = 0;
  interleave: ((index: number, db: FakeD1) => void) | null = null;
  /** SQL the test saw execute (debugging aid). */
  seen: string[] = [];

  put(id: string, seq: number, data: Record<string, unknown>, fieldTs?: Record<string, number>) {
    const row: Row = { id, collection: 'tasks', data: JSON.stringify(data), field_ts: JSON.stringify(fieldTs ?? { title: 1 }), seq, updated_by: 'seed', updated_at: 1 };
    this.rows.set(id, row);
    this.maxSeq = Math.max(this.maxSeq, seq);
  }

  exec(sql: string, binds: unknown[]): { rows?: Row[]; changes: number } {
    this.seen.push(sql.slice(0, 60));
    // Atomic expectation guard (must precede the generic SELECT branches).
    if (/JOIN json_each\(\?\)/.test(sql)) {
      const expectMap = JSON.parse(String(binds[0])) as Record<string, number>;
      for (const [id, rev] of Object.entries(expectMap)) {
        const row = this.rows.get(id);
        if (row && row.seq !== rev) throw new Error('malformed JSON');
      }
      return { rows: [{ 'CASE WHEN': 1 } as unknown as Row], changes: 0 };
    }
    if (/WHERE id IN/.test(sql)) {
      const rows = binds.map((id) => this.rows.get(String(id))).filter((r): r is Row => !!r);
      return { rows, changes: 0 };
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
    throw new Error(`FakeD1 unhandled SQL: ${sql.slice(0, 80)}`);
  }

  prepare(sql: string): D1PreparedStatement {
    const self = this;
    let binds: unknown[] = [];
    const stmt = {
      bind: (...b: unknown[]) => {
        binds = b;
        return stmt;
      },
      run: async () => {
        const r = self.exec(sql, binds);
        return { success: true, results: r.rows ?? [], meta: { changes: r.changes } };
      },
      all: async () => {
        const r = self.exec(sql, binds);
        return { success: true, results: r.rows ?? [], meta: { changes: r.changes } };
      },
      first: async () => {
        const r = self.exec(sql, binds);
        return (r.rows ?? [null])[0] ?? null;
      },
    };
    return stmt as unknown as D1PreparedStatement;
  }

  async batch(stmts: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
    // Interleave index 0 runs before the snapshot → the raced write is part
    // of the state the transaction sees (it landed before the batch began).
    this.interleave?.(0, this);
    const snapshot = new Map([...this.rows].map(([k, v]) => [k, { ...v }]));
    const maxSeq = this.maxSeq;
    const out: D1Result<unknown>[] = [];
    try {
      for (let i = 0; i < stmts.length; i++) {
        if (i > 0) this.interleave?.(i, this);
        out.push((await stmts[i].run()) as D1Result<unknown>);
      }
    } catch (e) {
      this.rows = snapshot;
      this.maxSeq = maxSeq;
      throw e;
    }
    return out;
  }
}

const envOf = (db: FakeD1) => ({ DB: db }) as unknown as Env;
const chg = (id: string, patch: Record<string, unknown>): Mutation => ({ id, collection: 'tasks', patch, ts: Date.now() });

describe('applyChanges atomic expectedRev gate (review B2)', () => {
  it('writes expected + non-expected ops together when every expectation holds', async () => {
    const db = new FakeD1();
    db.put('A', 1, { title: 'A0' });
    db.put('B', 2, { title: 'B0' });
    const res = await applyChanges(envOf(db), 'u1', [chg('A', { title: 'A1' }), chg('B', { title: 'B1' }), chg('C', { title: 'new' }), chg('D', { title: 'free' })], {
      expect: new Map([
        ['A', 1],
        ['B', 2],
      ]),
    });
    expect(res.conflicts).toBeUndefined();
    expect(res.applied).toHaveLength(4);
    expect(JSON.parse(db.rows.get('A')!.data).title).toBe('A1');
    expect(JSON.parse(db.rows.get('B')!.data).title).toBe('B1');
    expect(db.rows.has('C')).toBe(true);
    expect(db.rows.has('D')).toBe(true);
  });

  it('aborts the ENTIRE call — including non-expected ops — when an expectation raced before the batch', async () => {
    const db = new FakeD1();
    db.put('A', 1, { title: 'A0' });
    db.put('B', 2, { title: 'B0' });
    // Between the expectedRev precheck and the write batch, another writer
    // bumps A's seq. Only the in-batch guard can catch this.
    db.interleave = (i) => {
      if (i === 0) {
        const r = db.rows.get('A')!;
        db.maxSeq += 1;
        db.rows.set('A', { ...r, data: '{"title":"raced"}', seq: db.maxSeq });
      }
    };
    const res = await applyChanges(envOf(db), 'u1', [chg('A', { title: 'A1' }), chg('B', { title: 'B1' }), chg('C', { title: 'new' }), chg('D', { title: 'free' })], {
      expect: new Map([
        ['A', 1],
        ['B', 2],
      ]),
    });
    expect(res.applied).toEqual([]);
    expect(res.conflicts).toHaveLength(2); // every expected write reported
    const a = res.conflicts!.find((c) => c.id === 'A')!;
    expect(a.expectedRev).toBe(1);
    expect(a.currentRev).toBe(3); // hydrated with the raced rev
    expect(JSON.parse(db.rows.get('A')!.data).title).toBe('raced');
    expect(JSON.parse(db.rows.get('B')!.data).title).toBe('B0');
    expect(db.rows.has('C')).toBe(false); // free ops skipped too
    expect(db.rows.has('D')).toBe(false);
  });

  it('still reports applied rows honestly if a defensive CAS miss lands mid-batch', async () => {
    const db = new FakeD1();
    db.put('A', 1, { title: 'A0' });
    db.put('B', 2, { title: 'B0' });
    // Anomaly: a write lands mid-batch (impossible inside a real D1 batch
    // transaction, but the code must not silently mis-report if it happens).
    db.interleave = (i) => {
      if (i === 2) {
        const r = db.rows.get('B')!;
        db.maxSeq += 1;
        db.rows.set('B', { ...r, data: '{"title":"raced"}', seq: db.maxSeq });
      }
    };
    const res = await applyChanges(envOf(db), 'u1', [chg('A', { title: 'A1' }), chg('B', { title: 'B1' }), chg('C', { title: 'free' })], {
      expect: new Map([
        ['A', 1],
        ['B', 2],
      ]),
    });
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts![0].id).toBe('B');
    expect(res.applied.map((a) => a.id)).toEqual(['A']); // A committed — reported, not masked
    expect(db.rows.has('C')).toBe(false); // free ops still skipped
  });

  it('conflicts fast when the expected row is missing entirely', async () => {
    const db = new FakeD1();
    db.put('B', 2, { title: 'B0' });
    const res = await applyChanges(envOf(db), 'u1', [chg('A', { title: 'x' }), chg('B', { title: 'y' })], {
      expect: new Map([
        ['A', 5],
        ['B', 2],
      ]),
    });
    expect(res.applied).toEqual([]);
    expect(res.conflicts).toHaveLength(1);
    expect(res.conflicts![0].id).toBe('A');
    expect(res.conflicts![0].currentRev).toBeNull();
    expect(JSON.parse(db.rows.get('B')!.data).title).toBe('B0');
  });

  it('rejects more than MAX_EXPECTED expectations outright', async () => {
    const db = new FakeD1();
    const expectMap = new Map<string, number>();
    const changes: Mutation[] = [];
    for (let i = 0; i < 101; i++) {
      db.put(`id${i}`, 1 + i, { t: i });
      expectMap.set(`id${i}`, 1 + i);
      changes.push(chg(`id${i}`, { t: 0 }));
    }
    await expect(applyChanges(envOf(db), 'u1', changes, { expect: expectMap })).rejects.toThrow(/MAX_EXPECTED|100/);
  });
});
