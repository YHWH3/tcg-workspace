import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyChanges, type ApplyOptions } from '../worker/sync';
import { beginChangeset, undoChangeset } from '../worker/changesets';
import { maintainDateIndex, processOutbox } from '../worker/events';
import { runScheduled } from '../worker/reminders';
import { admin } from '../worker/admin';
import { sha256Hex } from '../worker/password';
import { todayUtc } from '../shared/recurrence';
import { recoverAutomationRuns } from '../worker/automations';
import type { Env, AuthUser } from '../worker/auth';
import type { Mutation } from '../shared/types';

// Keep commit verification independent of opportunistic waitUntil execution.
// Persistence, SQL and explicit outbox recovery below are all real D1 calls.
vi.mock('../worker/events', async (original) => ({
  ...await original<typeof import('../worker/events')>(),
  scheduleOutbox: vi.fn(),
}));

type Fault = 'before' | 'during' | 'after';
let mf: Miniflare;
let db: D1Database;
let env: Env;
const ctx = { waitUntil: (_promise: Promise<unknown>) => {} };

/** Only intercept the request/ack boundary; never emulate SQL or transactions. */
function faultyDatabase(mode: Fault, failBatch = 1): D1Database {
  let calls = 0;
  return new Proxy(db, {
    get(target, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (++calls !== failBatch) return target.batch(statements);
        if (mode === 'before') throw new Error('injected failure before commit');
        if (mode === 'during') {
          // A real SQLite error after the first record/event statements must roll
          // back ALL statements, including earlier successful CAS writes.
          return target.batch([
            ...statements.slice(0, 3),
            target.prepare("SELECT json_extract('{', '$')"),
            ...statements.slice(3),
          ]);
        }
        await target.batch(statements);
        throw new Error('injected lost commit acknowledgement');
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function beforeBatchDatabase(callback: () => Promise<void>): D1Database {
  let first = true;
  return new Proxy(db, {
    get(target, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (first) { first = false; await callback(); }
        return target.batch(statements);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function mutation(id: string, patch: Record<string, unknown>, ts = 100, collection = 'tasks'): Mutation {
  return { id, collection, patch, ts } as Mutation;
}

function options(): ApplyOptions {
  const journal = beginChangeset({ userId: 'alice', clientName: 'D1 regression', tool: 'phase4_test' });
  return { journal, event: { source: 'mcp', changesetId: journal.id, ctx } };
}

async function count(table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row!.n;
}

async function assertDurable(ids: string[], changesetId: string): Promise<void> {
  const records = (await db.prepare("SELECT id, seq, data FROM records WHERE collection='tasks' ORDER BY id").all<{ id: string; seq: number; data: string }>()).results;
  const events = (await db.prepare('SELECT payload FROM event_outbox ORDER BY id').all<{ payload: string }>()).results;
  const items = (await db.prepare('SELECT record_id FROM changeset_items WHERE changeset_id=?').bind(changesetId).all<{ record_id: string }>()).results;
  expect(records.map(r => r.id).sort()).toEqual([...ids].sort());
  expect(items.map(r => r.record_id).sort()).toEqual([...ids].sort());
  expect(events).toHaveLength(ids.length);
  const byId = new Map(records.map(r => [r.id, r]));
  expect(events.map(r => JSON.parse(r.payload).applied[0].id).sort()).toEqual([...ids].sort());
  for (const row of events) {
    const event = JSON.parse(row.payload);
    const change = event.applied[0];
    expect(event).toMatchObject({ source: 'mcp', userId: 'alice', changesetId });
    expect(change.rev).toBe(byId.get(change.id)!.seq);
    expect(change.snapshot).toEqual(JSON.parse(byId.get(change.id)!.data));
  }
  const journal = await db.prepare('SELECT item_count FROM changesets WHERE id=?').bind(changesetId).first<{ item_count: number }>();
  expect(journal?.item_count ?? 0).toBe(ids.length);
}

beforeEach(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: 'phase4-verification',
      modules: true,
      script: 'export default {fetch(){return new Response("D1 verification")}}',
      compatibilityDate: '2026-09-18',
      d1Databases: { DB: 'phase4-disposable-regression' },
    }],
    // No persistence path, remote bindings, secrets or production resources.
  }));
  db = await mf.getD1Database('DB') as D1Database;
  env = { DB: db } as Env;
  const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const filename of readdirSync(folder).filter(f => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(`${folder}/${filename}`, 'utf8').replace(/--[^\n]*/g, '');
    // Approval delivery migrations include trigger bodies containing SQL
    // statement separators; prepare each complete trigger as one statement.
    const statements = (sql.match(/\s*CREATE\s+TRIGGER\b[\s\S]*?END\s*;|[^;]+;/gi) ?? [])
      .map(s => s.trim()).filter(Boolean);
    await db.batch(statements.map(s => db.prepare(s)));
  }
});

afterEach(async () => { await mf?.dispose(); });

describe('Phase 4 real SQLite-backed D1 record/event/journal boundary', () => {
  it('commits actual SQL with deterministic event ids, actual revisions and full snapshots', async () => {
    const opts = options();
    const result = await applyChanges(env, 'alice', [mutation('task', { title: 'Original', dueDate: '2026-10-20' })], opts);
    expect(result.changed).toBe(1);
    expect(result.partialError).toBeUndefined();
    await assertDurable(['task'], opts.journal!.id);
    const updateOpts = options();
    const updated = await applyChanges(env, 'alice', [mutation('task', { title: 'Renamed' }, 101)], updateOpts);
    expect(updated.applied[0].after).toEqual({ title: 'Renamed' });
    expect(updated.applied[0].before).toEqual({ title: 'Original' });
    expect(updated.applied[0].snapshot).toMatchObject({ title: 'Renamed', dueDate: '2026-10-20' });
  });

  it.each(['before', 'during'] as const)('stages nothing on %s-commit failure', async mode => {
    const opts = options();
    const result = await applyChanges({ ...env, DB: faultyDatabase(mode) }, 'alice', [mutation('task', { title: 'Uncommitted' })], opts);
    expect(result.partialError).toBeTruthy();
    expect(result.changed).toBe(0);
    expect(result.applied).toEqual([]);
    await assertDurable([], opts.journal!.id);
    expect(await count('changesets')).toBe(0);
  });

  it('rolls back the record CAS when the real event INSERT fails', async () => {
    await db.prepare("CREATE TRIGGER injected_event_failure BEFORE INSERT ON event_outbox BEGIN SELECT RAISE(ABORT, 'injected event insert failure'); END").run();
    const opts = options();
    const result = await applyChanges(env, 'alice', [mutation('task', { title: 'Never committed' })], opts);
    expect(result.partialError).toMatch(/injected event insert failure/);
    await assertDurable([], opts.journal!.id);
  });

  it('rolls back the record and event if durable changeset auditing fails', async () => {
    await db.prepare("CREATE TRIGGER injected_journal_failure BEFORE INSERT ON changeset_items BEGIN SELECT RAISE(ABORT, 'injected audit insert failure'); END").run();
    const opts = options();
    const result = await applyChanges(env, 'alice', [mutation('task', { title: 'Never committed' })], opts);
    expect(result.partialError).toMatch(/injected audit insert failure/);
    expect(result.changed).toBe(0);
    await assertDurable([], opts.journal!.id);
    expect(await count('changesets')).toBe(0);
  });

  it('the actual undo caller rolls back inverse writes with a failed undo audit, then safely retries', async () => {
    await applyChanges(env, 'alice', [mutation('task', { title: 'Original', dueDate: '2026-10-20' })]);
    const original = options();
    await applyChanges(env, 'alice', [mutation('task', { title: 'Edited' }, 200)], original);
    await db.prepare("CREATE TRIGGER injected_undo_audit_failure BEFORE INSERT ON changeset_items WHEN (SELECT source FROM changesets WHERE id=NEW.changeset_id)='undo' BEGIN SELECT RAISE(ABORT,'injected undo audit failure'); END").run();
    const user = { id: 'alice', role: 'admin' } as AuthUser;
    const failed = await undoChangeset(env, user, original.journal!.id, ctx);
    expect(failed).toMatchObject({ ok: false, status: 503 });
    expect(failed.error).toMatch(/interrupted|audit|retry/i);
    const stillEdited = (await db.prepare('SELECT data FROM records WHERE id=?').bind('task').first<{ data: string }>())!;
    expect(JSON.parse(stillEdited.data)).toMatchObject({ title: 'Edited', dueDate: '2026-10-20' });
    expect(await count('event_outbox')).toBe(1);
    expect(await count('changeset_items')).toBe(1);
    expect((await db.prepare('SELECT undone_by FROM changesets WHERE id=?').bind(original.journal!.id).first())!).toMatchObject({ undone_by: null });
    await db.prepare('DROP TRIGGER injected_undo_audit_failure').run();
    const restored = await undoChangeset(env, user, original.journal!.id, ctx);
    expect(restored).toMatchObject({ ok: true, restored: 1 });
    expect(restored.undoChangesetId).toBeTruthy();
    const record = (await db.prepare('SELECT data,seq FROM records WHERE id=?').bind('task').first<{ data: string; seq: number }>())!;
    expect(JSON.parse(record.data)).toMatchObject({ title: 'Original', dueDate: '2026-10-20' });
    const event = JSON.parse((await db.prepare("SELECT payload FROM event_outbox WHERE json_extract(payload,'$.source')='undo'").first<{ payload: string }>())!.payload);
    expect(event.changesetId).toBe(restored.undoChangesetId);
    expect(event.applied[0]).toMatchObject({ rev: record.seq, before: { title: 'Edited' }, after: { title: 'Original' }, snapshot: { title: 'Original', dueDate: '2026-10-20' } });
    const audit = (await db.prepare('SELECT before,after FROM changeset_items WHERE changeset_id=?').bind(restored.undoChangesetId!).first<{ before: string; after: string }>())!;
    expect(JSON.parse(audit.before)).toEqual({ title: 'Edited' });
    expect(JSON.parse(audit.after)).toEqual({ title: 'Original' });
    const replay = await undoChangeset(env, user, original.journal!.id, ctx);
    expect(replay).toMatchObject({ ok: false, status: 409 });
    expect(await count('event_outbox')).toBe(2);
    expect(await count('changeset_items')).toBe(2);
  });

  it('recovers committed outcomes after a lost acknowledgement and replay emits no duplicate', async () => {
    const opts = options();
    const changes = [mutation('task', { title: 'Committed' })];
    const first = await applyChanges({ ...env, DB: faultyDatabase('after') }, 'alice', changes, opts);
    expect(first.partialError).toMatch(/lost commit acknowledgement/);
    expect(first.changed).toBe(1);
    expect(first.applied.map(a => a.id)).toEqual(['task']);
    await assertDurable(['task'], opts.journal!.id);
    const replay = await applyChanges(env, 'alice', changes, opts);
    expect(replay.changed).toBe(0);
    expect(replay.partialError).toBeUndefined();
    await assertDurable(['task'], opts.journal!.id);
  });

  it.each(['before', 'during', 'after'] as const)('reports exact durable partial outcomes for 150 writes and a second-batch %s failure', async mode => {
    const opts = options();
    const changes = Array.from({ length: 150 }, (_, i) => mutation(`task_${String(i).padStart(3, '0')}`, { title: `Task ${i}` }));
    const result = await applyChanges({ ...env, DB: faultyDatabase(mode, 2) }, 'alice', changes, opts);
    const committed = changes.slice(0, mode === 'after' ? 150 : 100).map(c => c.id);
    expect(result.partialError).toBeTruthy();
    expect(result.changed).toBe(committed.length);
    expect(result.applied.map(a => a.id)).toEqual(committed);
    await assertDurable(committed, opts.journal!.id);
    const replay = await applyChanges(env, 'alice', changes, opts);
    expect(replay.changed).toBe(150 - committed.length);
    await assertDurable(changes.map(c => c.id), opts.journal!.id);
  }, 20_000);

  it('emits no events or journals for invalid mutations, old timestamps and revision mismatches', async () => {
    await applyChanges(env, 'alice', [mutation('task', { title: 'Fresh' }, 200)]);
    const opts = options();
    const result = await applyChanges(env, 'alice', [
      mutation('task', { title: 'Old' }, 100),
      { id: 'forbidden', collection: 'notifications', patch: { title: 'Invalid' }, ts: 300 },
      { id: 'malformed', collection: 'tasks', patch: [], ts: 300 },
    ], opts);
    expect(result.rejected).toBe(2);
    expect(result.changed).toBe(0);
    const stale = await applyChanges(env, 'alice', [mutation('task', { title: 'Stale rev' }, 301)], { ...opts, expect: new Map([['task', 0]]) });
    expect(stale.conflicts).toHaveLength(1);
    expect(stale.changed).toBe(0);
    expect(await count('event_outbox')).toBe(0);
    expect(await count('changeset_items')).toBe(0);
  });

  it('a real missed CAS creates no event for the losing patch', async () => {
    await applyChanges(env, 'alice', [mutation('task', { title: 'Base' }, 100)]);
    const loser = options();
    const winner = options();
    const raced = beforeBatchDatabase(async () => {
      const result = await applyChanges(env, 'alice', [mutation('task', { title: 'Winner' }, 300)], winner);
      expect(result.changed).toBe(1);
    });
    const result = await applyChanges({ ...env, DB: raced }, 'alice', [mutation('task', { title: 'Loser' }, 200)], loser);
    expect(result.changed).toBe(0);
    expect(result.applied).toEqual([]);
    expect(await count('event_outbox')).toBe(1);
    expect(await count('changeset_items')).toBe(1);
    const event = JSON.parse((await db.prepare('SELECT payload FROM event_outbox').first<{ payload: string }>())!.payload);
    expect(event.changesetId).toBe(winner.journal!.id);
    expect(event.applied[0].snapshot.title).toBe('Winner');
  });

  it('a CAS loser matching the concurrent winner creates no phantom audit item', async () => {
    await applyChanges(env, 'alice', [mutation('task', { title: 'Base' }, 100)]);
    const loser = options();
    const winner = options();
    const raced = beforeBatchDatabase(async () => {
      await applyChanges(env, 'alice', [mutation('task', { title: 'Same new value' }, 200)], winner);
    });
    const result = await applyChanges({ ...env, DB: raced }, 'alice', [mutation('task', { title: 'Same new value' }, 200)], loser);
    expect(result.changed).toBe(0);
    expect(await count('event_outbox')).toBe(1);
    expect(await count('changeset_items')).toBe(1);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM changeset_items WHERE changeset_id=?').bind(loser.journal!.id).first<{ n: number }>())!.n).toBe(0);
  });

  it('distinct client values with equal LWW timestamps each retain their committed event', async () => {
    const opts = { event: { source: 'client' as const, ctx } };
    const first = await applyChanges(env, 'alice', [mutation('task', { title: 'First device' }, 100)], opts);
    const second = await applyChanges(env, 'bob', [mutation('task', { title: 'Second device' }, 100)], opts);
    expect(first.changed).toBe(1);
    expect(second.changed).toBe(1);
    const events = (await db.prepare("SELECT payload FROM event_outbox ORDER BY json_extract(payload,'$.applied[0].rev')").all<{ payload: string }>()).results.map(row => JSON.parse(row.payload));
    expect(events).toHaveLength(2);
    expect(events.map(event => event.applied[0].snapshot.title)).toEqual(['First device', 'Second device']);
    expect(events.map(event => event.applied[0].rev)).toEqual([first.applied[0].rev, second.applied[0].rev]);
    const replay = await applyChanges(env, 'bob', [mutation('task', { title: 'Second device' }, 100)], opts);
    expect(replay.changed).toBe(0);
    expect(await count('event_outbox')).toBe(2);
    for (const title of ['First device', 'Second device']) {
      const result = await applyChanges(env, 'bob', [mutation('task', { title }, 100)], opts);
      expect(result.changed).toBe(1);
    }
    expect(await count('event_outbox')).toBe(4);
  });

  it('concurrent expected-revision writers commit only one logical event and journal', async () => {
    const initial = await applyChanges(env, 'alice', [mutation('task', { title: 'Base' })]);
    const rev = initial.applied[0].rev;
    let arrive!: () => void;
    let arrivals = 0;
    const barrier = new Promise<void>(resolve => { arrive = resolve; });
    const wait = async () => { if (++arrivals === 2) arrive(); await barrier; };
    const firstOpts = { ...options(), expect: new Map([['task', rev]]) };
    const secondOpts = { ...options(), expect: new Map([['task', rev]]) };
    const results = await Promise.all([
      applyChanges({ ...env, DB: beforeBatchDatabase(wait) }, 'alice', [mutation('task', { title: 'First' }, 200)], firstOpts),
      applyChanges({ ...env, DB: beforeBatchDatabase(wait) }, 'alice', [mutation('task', { title: 'Second' }, 300)], secondOpts),
    ]);
    expect(results.map(r => r.changed).sort()).toEqual([0, 1]);
    expect(results.flatMap(r => r.conflicts ?? [])).toHaveLength(1);
    expect(await count('event_outbox')).toBe(1);
    expect(await count('changeset_items')).toBe(1);
  });

  it('retries a raced different-field edit against authoritative state without losing either field', async () => {
    await applyChanges(env, 'alice', [mutation('task', { title: 'Base', dueDate: '2026-10-20' })]);
    const firstOpts = options();
    const secondOpts = options();
    const raced = beforeBatchDatabase(async () => {
      await applyChanges(env, 'alice', [mutation('task', { description: 'Other device' }, 200)], secondOpts);
    });
    const result = await applyChanges({ ...env, DB: raced }, 'alice', [mutation('task', { title: 'Renamed' }, 201)], firstOpts);
    expect(result.changed).toBe(1);
    expect(result.applied[0].snapshot).toMatchObject({ title: 'Renamed', description: 'Other device', dueDate: '2026-10-20' });
    expect(await count('event_outbox')).toBe(2);
    expect(await count('changeset_items')).toBe(2);
  });
});

async function seedDates() {
  await db.batch(['alice', 'bob'].map(id => db.prepare('INSERT INTO users(id,username,name,role,created_at) VALUES(?,?,?,?,?)').bind(id, id, id, id === 'alice' ? 'admin' : 'member', Date.now())));
  await applyChanges(env, 'alice', [
    mutation('board', { name: 'Dates', columns: [{ id: 'todo' }, { id: 'done' }], fields: [
      { id: 'deadline', name: 'Deadline', type: 'date' },
      { id: 'otherdate', name: 'Another date', type: 'date' },
      { id: 'text', name: 'Text', type: 'text' },
    ] }, 100, 'boards'),
    mutation('otherboard', { name: 'Other board', columns: [{ id: 'todo' }, { id: 'done' }], fields: [{ id: 'otherdate', name: 'Another date', type: 'date' }] }, 100, 'boards'),
  ]);
  const result = await applyChanges(env, 'alice', [mutation('dated', {
    title: 'Deadline', boardId: 'board', status: 'todo', assigneeId: 'bob',
    dueDate: '2026-10-20', p_deadline: '2026-10-21', p_otherdate: '2026-10-22', p_text: '2026-10-23', p_unknown: '2026-10-24',
  })], options());
  await maintainDateIndex(env, result.applied);
}

async function dateRows() {
  return (await db.prepare('SELECT field_key,date FROM date_index WHERE record_id=? ORDER BY field_key').bind('dated').all<{ field_key: string; date: string }>()).results;
}

const initialDates = [
  { field_key: 'dueDate', date: '2026-10-20' },
  { field_key: 'p_deadline', date: '2026-10-21' },
  { field_key: 'p_otherdate', date: '2026-10-22' },
];

describe('Phase 4 real D1 deadline indexing and reminder recovery', () => {
  it('preserves all dates through title/description/assigneeId/unrelated-property edits and sparse replay', async () => {
    await seedDates();
    expect(await dateRows()).toEqual(initialDates);
    let ts = 101;
    for (const patch of [{ title: 'Renamed' }, { description: 'Edited' }, { assigneeId: 'alice' }, { p_text: 'Edited text' }, { p_unknown: 'Edited custom property' }]) {
      const result = await applyChanges(env, 'alice', [mutation('dated', patch, ts++)], options());
      await maintainDateIndex(env, result.applied);
      await maintainDateIndex(env, result.applied);
      expect(await dateRows()).toEqual(initialDates);
    }
  });

  it('correctly clears/restores each date, archives/deletes/restores, moves boards and replays stale events', async () => {
    await seedDates();
    let ts = 101;
    const write = async (patch: Record<string, unknown>) => {
      const result = await applyChanges(env, 'alice', [mutation('dated', patch, ts++)], options());
      await maintainDateIndex(env, result.applied);
      return result.applied;
    };
    const stale = await write({ dueDate: null });
    expect(await dateRows()).toEqual(initialDates.slice(1));
    await write({ dueDate: '2026-10-25' });
    expect(await dateRows()).toEqual([{ field_key: 'dueDate', date: '2026-10-25' }, ...initialDates.slice(1)]);
    await maintainDateIndex(env, stale);
    expect((await dateRows())[0]).toEqual({ field_key: 'dueDate', date: '2026-10-25' });
    await write({ p_deadline: '' });
    expect((await dateRows()).map(r => r.field_key)).toEqual(['dueDate', 'p_otherdate']);
    await write({ p_deadline: '2026-10-21' });
    for (const flag of ['archived', 'deleted']) {
      await write({ [flag]: true });
      expect(await dateRows()).toEqual([]);
      await write({ [flag]: false });
      expect(await dateRows()).toHaveLength(3);
    }
    await write({ boardId: 'otherboard' });
    expect((await dateRows()).map(r => r.field_key)).toEqual(['dueDate', 'p_otherdate']);
    await write({ boardId: 'board' });
    expect(await dateRows()).toHaveLength(3);
  });

  it('reindexes custom dates when their board schema or archive state changes', async () => {
    await seedDates();
    let ts = 101;
    const changeBoard = async (patch: Record<string, unknown>) => {
      const result = await applyChanges(env, 'alice', [mutation('board', patch, ts++, 'boards')], options());
      await maintainDateIndex(env, result.applied);
    };
    await changeBoard({ fields: [{ id: 'deadline', name: 'Deadline now text', type: 'text' }, { id: 'text', name: 'Text now date', type: 'date' }] });
    expect(await dateRows()).toEqual([{ field_key: 'dueDate', date: '2026-10-20' }, { field_key: 'p_text', date: '2026-10-23' }]);
    await changeBoard({ archived: true });
    expect(await dateRows()).toEqual([]);
    await changeBoard({ archived: false });
    expect(await dateRows()).toHaveLength(2);
  });

  it('admin reindex rebuilds missing indexes from actual persisted rows', async () => {
    await seedDates();
    await db.prepare('DELETE FROM date_index').run();
    const token = 'local-d1-admin-test';
    await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await sha256Hex(token), 'alice', Date.now() + 60_000, Date.now()).run();
    const response = await admin.request('http://localhost/admin/reindex-dates', { method: 'POST', headers: { authorization: `Bearer ${token}` } }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, reindexed: 1 });
    expect(await dateRows()).toEqual(initialDates);
  });

  it('Cron twice emits one due reminder to the canonical assignee after unrelated edits', async () => {
    await seedDates();
    const today = todayUtc();
    const result = await applyChanges(env, 'alice', [mutation('dated', { dueDate: today, p_deadline: null, p_otherdate: null, title: 'Due today' }, 101)], options());
    await maintainDateIndex(env, result.applied);
    const rename = await applyChanges(env, 'alice', [mutation('dated', { description: 'Title alone should preserve reminders' }, 102)], options());
    await maintainDateIndex(env, rename.applied);
    expect(await dateRows()).toEqual([{ field_key: 'dueDate', date: today }]);
    await runScheduled(env);
    await runScheduled(env);
    const reminders = (await db.prepare("SELECT user_id,kind,target_id FROM notifications WHERE kind='due_soon'").all()).results;
    expect(reminders).toEqual([{ user_id: 'bob', kind: 'due_soon', target_id: 'dated' }]);
    expect(await count('reminder_sent')).toBe(1);
  });

  it('a failed reminder delivery does not burn its durable dedupe slot', async () => {
    await seedDates();
    const result = await applyChanges(env, 'alice', [mutation('dated', { dueDate: todayUtc(), p_deadline: null, p_otherdate: null }, 101)], options());
    await maintainDateIndex(env, result.applied);
    await db.prepare("CREATE TRIGGER injected_reminder_failure BEFORE INSERT ON notifications WHEN NEW.kind='due_soon' BEGIN SELECT RAISE(ABORT,'injected reminder failure'); END").run();
    await expect(runScheduled(env)).rejects.toThrow(/injected reminder failure/);
    expect(await count('notifications')).toBe(0);
    expect(await count('reminder_sent')).toBe(0);
    await db.prepare('DROP TRIGGER injected_reminder_failure').run();
    await runScheduled(env);
    await runScheduled(env);
    expect((await db.prepare("SELECT user_id,kind,group_count FROM notifications WHERE kind='due_soon'").all()).results).toEqual([{ user_id: 'bob', kind: 'due_soon', group_count: 1 }]);
    expect(await count('reminder_sent')).toBe(1);
  });

  it('recovers an outbox interrupted before processing without duplicating assignment delivery', async () => {
    await seedDates();
    const event = await db.prepare('SELECT id FROM event_outbox ORDER BY created_at LIMIT 1').first<{ id: string }>();
    expect(await count('notifications')).toBe(0);
    await processOutbox(env, event!.id);
    await processOutbox(env, event!.id);
    const rows = (await db.prepare("SELECT user_id,kind FROM notifications WHERE kind='assigned'").all()).results;
    expect(rows).toEqual([{ user_id: 'bob', kind: 'assigned' }]);
    // Simulate interruption after side effects before final processed ack.
    await db.prepare('UPDATE event_outbox SET processed_at=NULL WHERE id=?').bind(event!.id).run();
    await processOutbox(env, event!.id);
    expect((await db.prepare("SELECT group_count FROM notifications WHERE kind='assigned'").first<{ group_count: number }>())!.group_count).toBe(1);
  });

  it('different committed repeats of the same assignment transition remain separate logical deliveries', async () => {
    await seedDates();
    for (const [index, assigneeId] of ['alice', 'bob', 'alice', 'bob'].entries()) {
      await applyChanges(env, 'alice', [mutation('dated', { assigneeId }, 101 + index)], options());
    }
    const events = (await db.prepare('SELECT id FROM event_outbox ORDER BY created_at,id').all<{ id: string }>()).results;
    for (const event of events) await processOutbox(env, event.id);
    expect((await db.prepare("SELECT group_count FROM notifications WHERE user_id='bob' AND kind='assigned'").first<{ group_count: number }>())!.group_count).toBe(3);
    for (const event of events) await processOutbox(env, event.id);
    expect((await db.prepare("SELECT group_count FROM notifications WHERE user_id='bob' AND kind='assigned'").first<{ group_count: number }>())!.group_count).toBe(3);
  });

  it('retries notification fan-out after one recipient committed and a later recipient failed', async () => {
    await seedDates();
    await db.prepare("INSERT INTO users(id,username,name,role,created_at) VALUES('carol','carol','Carol','member',?)").bind(Date.now()).run();
    await applyChanges(env, 'alice', [mutation('mentions', { pageId: 'page', text: '@[user:bob] @[user:carol]' }, 101, 'blocks')], options());
    const event = await db.prepare("SELECT id FROM event_outbox WHERE json_extract(payload,'$.applied[0].id')='mentions'").first<{ id: string }>();
    await db.prepare("CREATE TRIGGER injected_fanout_failure BEFORE INSERT ON notifications WHEN NEW.user_id='carol' BEGIN SELECT RAISE(ABORT,'injected recipient failure'); END").run();
    await expect(processOutbox(env, event!.id)).rejects.toThrow(/injected recipient failure/);
    expect((await db.prepare("SELECT user_id,group_count FROM notifications WHERE kind='mention'").all()).results).toEqual([{ user_id: 'bob', group_count: 1 }]);
    const failed = await db.prepare('SELECT attempts,processed_at FROM event_outbox WHERE id=?').bind(event!.id).first();
    expect(failed).toMatchObject({ attempts: 1, processed_at: null });
    await db.prepare('DROP TRIGGER injected_fanout_failure').run();
    await processOutbox(env, event!.id);
    expect((await db.prepare("SELECT user_id,group_count FROM notifications WHERE kind='mention' ORDER BY user_id").all()).results).toEqual([{ user_id: 'bob', group_count: 1 }, { user_id: 'carol', group_count: 1 }]);
  });

  it('Cron recovers durable events after interruption and a failed sweep, then dedupes subsequent sweeps', async () => {
    await seedDates();
    await db.prepare('UPDATE event_outbox SET created_at=?').bind(Date.now() - 120_000).run();
    await db.prepare("CREATE TRIGGER injected_cron_failure BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'injected cron fanout failure'); END").run();
    await runScheduled(env);
    expect(await count('notifications')).toBe(0);
    expect((await db.prepare('SELECT attempts,processed_at FROM event_outbox').first())!).toMatchObject({ attempts: 1, processed_at: null });
    await db.prepare('DROP TRIGGER injected_cron_failure').run();
    await runScheduled(env);
    await runScheduled(env);
    expect((await db.prepare("SELECT user_id,kind,group_count FROM notifications WHERE kind='assigned'").all()).results).toEqual([{ user_id: 'bob', kind: 'assigned', group_count: 1 }]);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM event_outbox WHERE processed_at IS NULL').first<{ n: number }>())!.n).toBe(0);
  });

  it('keeps the input event recoverable if reserving its automation run fails', async () => {
    await seedDates();
    await applyChanges(env, 'alice', [mutation('automation', {
      databaseId: 'board', name: 'Create review', enabled: true,
      trigger: { kind: 'record.created' }, conditions: [],
      actions: [{ type: 'create_record', databaseId: 'board', title: 'Review {{record.title}}' }],
    }, 101, 'automations')]);
    const event = (await db.prepare('SELECT id FROM event_outbox').first<{ id: string }>())!;
    await db.prepare("CREATE TRIGGER injected_run_reservation_failure BEFORE INSERT ON automation_runs BEGIN SELECT RAISE(ABORT,'injected run reservation failure'); END").run();
    await expect(processOutbox(env, event.id)).rejects.toThrow(/injected run reservation failure/);
    expect(await count('automation_runs')).toBe(0);
    expect((await db.prepare('SELECT processed_at FROM event_outbox WHERE id=?').bind(event.id).first())!).toMatchObject({ processed_at: null });
    await db.prepare('DROP TRIGGER injected_run_reservation_failure').run();
    await processOutbox(env, event.id);
    expect((await db.prepare('SELECT status FROM automation_runs').first())!).toMatchObject({ status: 'completed' });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM records WHERE collection='tasks'").first<{ n: number }>())!.n).toBe(2);
  });

  it('resumes an automation after record commit and notification failure without duplicating its record or audit', async () => {
    await seedDates();
    await applyChanges(env, 'alice', [mutation('automation', {
      databaseId: 'board', name: 'Create review and notify', enabled: true,
      trigger: { kind: 'record.created' }, conditions: [],
      actions: [
        { type: 'create_record', databaseId: 'board', title: 'Review {{record.title}}' },
        { type: 'notify', userIds: ['bob'], message: 'Review created' },
      ],
    }, 101, 'automations')]);
    const event = (await db.prepare('SELECT id FROM event_outbox').first<{ id: string }>())!;
    await db.prepare("CREATE TRIGGER injected_automation_notify_failure BEFORE INSERT ON notifications WHEN NEW.kind='automation' BEGIN SELECT RAISE(ABORT,'injected automation notification failure'); END").run();
    await processOutbox(env, event.id);
    const run = (await db.prepare('SELECT status,changeset_id,error FROM automation_runs').first<{ status: string; changeset_id: string; error: string }>())!;
    expect(run.status).toBe('retryable_failure');
    expect(run.error).toMatch(/injected automation notification failure/);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM records WHERE collection='tasks'").first<{ n: number }>())!.n).toBe(2);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM changeset_items WHERE changeset_id=?').bind(run.changeset_id).first<{ n: number }>())!.n).toBe(1);
    await db.prepare('DROP TRIGGER injected_automation_notify_failure').run();
    await db.prepare('UPDATE automation_runs SET retry_at=0').run();
    await recoverAutomationRuns(env);
    await recoverAutomationRuns(env);
    expect((await db.prepare('SELECT status FROM automation_runs').first())!).toMatchObject({ status: 'completed' });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM records WHERE collection='tasks'").first<{ n: number }>())!.n).toBe(2);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM changeset_items WHERE changeset_id=?').bind(run.changeset_id).first<{ n: number }>())!.n).toBe(1);
    expect((await db.prepare("SELECT user_id,group_count FROM notifications WHERE kind='automation'").all()).results).toEqual([{ user_id: 'bob', group_count: 1 }]);
  });

  it.each([false, true])('undo after an automation (incomplete=%s) cancels further recovery and removes its created record', async incomplete => {
    await seedDates();
    await applyChanges(env, 'alice', [mutation('automation', {
      databaseId: 'board', name: 'Undoable review', enabled: true,
      trigger: { kind: 'record.created' }, conditions: [],
      actions: [
        { type: 'create_record', databaseId: 'board', title: 'Review {{record.title}}' },
        { type: 'notify', userIds: ['bob'], message: 'Review created' },
      ],
    }, 101, 'automations')]);
    if (incomplete) await db.prepare("CREATE TRIGGER injected_incomplete_automation BEFORE INSERT ON notifications WHEN NEW.kind='automation' BEGIN SELECT RAISE(ABORT,'injected incomplete automation'); END").run();
    const event = (await db.prepare('SELECT id FROM event_outbox').first<{ id: string }>())!;
    await processOutbox(env, event.id);
    const run = (await db.prepare('SELECT status,changeset_id FROM automation_runs').first<{ status: string; changeset_id: string }>())!;
    expect(run.status).toBe(incomplete ? 'retryable_failure' : 'completed');
    const undo = await undoChangeset(env, { id: 'alice', role: 'admin' } as AuthUser, run.changeset_id, ctx);
    expect(undo).toMatchObject({ ok: true, restored: 1 });
    const active = (await db.prepare("SELECT COUNT(*) AS n FROM records WHERE collection='tasks' AND COALESCE(json_extract(data,'$.deleted'),0)!=1").first<{ n: number }>())!;
    expect(active.n).toBe(1);
    if (incomplete) await db.prepare('DROP TRIGGER injected_incomplete_automation').run();
    await db.prepare('UPDATE automation_runs SET retry_at=0,lease_until=0').run();
    await recoverAutomationRuns(env);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM records WHERE collection='tasks' AND COALESCE(json_extract(data,'$.deleted'),0)!=1").first<{ n: number }>())!.n).toBe(1);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind='automation'").first<{ n: number }>())!.n).toBe(incomplete ? 0 : 1);
    if (incomplete) expect((await db.prepare('SELECT status FROM automation_runs').first())!).toMatchObject({ status: 'terminal_failure' });
  });

  it.each(['before record writes', 'during approval request', 'before completion acknowledgement'] as const)('resumes safely after failure %s, including concurrent recovery claims', async point => {
    await seedDates();
    await applyChanges(env, 'alice', [mutation('automation', {
      databaseId: 'board', name: 'Review with approval', enabled: true,
      trigger: { kind: 'record.created' }, conditions: [],
      actions: [
        { type: 'create_record', databaseId: 'board', title: 'Review {{record.title}}' },
        { type: 'request_approval', approverId: 'bob', note: 'Review requested' },
        { type: 'notify', userIds: ['bob'], message: 'Review created' },
      ],
    }, 101, 'automations')]);
    const target = point === 'before record writes' ? "BEFORE INSERT ON records WHEN json_extract(NEW.data,'$.title') LIKE 'Review %'"
      : point === 'during approval request' ? 'BEFORE INSERT ON approvals'
      : "BEFORE UPDATE ON automation_runs WHEN NEW.status='completed'";
    await db.prepare(`CREATE TRIGGER injected_execution_failure ${target} BEGIN SELECT RAISE(ABORT,'injected execution failure'); END`).run();
    const event = (await db.prepare('SELECT id FROM event_outbox').first<{ id: string }>())!;
    await processOutbox(env, event.id);
    const run = (await db.prepare('SELECT status,changeset_id,error FROM automation_runs').first<{ status: string; changeset_id: string; error: string }>())!;
    expect(run.status).toBe('retryable_failure');
    expect(run.error).toMatch(/injected execution failure/);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM records WHERE collection='tasks'").first<{ n: number }>())!.n).toBe(point === 'before record writes' ? 1 : 2);
    await db.prepare('DROP TRIGGER injected_execution_failure').run();
    await db.prepare('UPDATE automation_runs SET retry_at=0').run();
    await Promise.all([recoverAutomationRuns(env), recoverAutomationRuns(env)]);
    const pending = (await db.prepare('SELECT id FROM event_outbox WHERE processed_at IS NULL').all<{ id: string }>()).results;
    for (const entry of pending) await processOutbox(env, entry.id);
    for (const entry of pending) await processOutbox(env, entry.id);
    expect(await count('automation_runs')).toBe(1);
    expect((await db.prepare('SELECT status,attempts FROM automation_runs').first())!).toMatchObject({ status: 'completed', attempts: 2 });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM records WHERE collection='tasks'").first<{ n: number }>())!.n).toBe(2);
    expect(await count('approvals')).toBe(1);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM changeset_items WHERE changeset_id=?').bind(run.changeset_id).first<{ n: number }>())!.n).toBe(1);
    expect((await db.prepare("SELECT kind,user_id,group_count FROM notifications WHERE kind IN ('approval_requested','automation') ORDER BY kind").all()).results).toEqual([
      { kind: 'approval_requested', user_id: 'bob', group_count: 1 },
      { kind: 'automation', user_id: 'bob', group_count: 1 },
    ]);
  });
});
