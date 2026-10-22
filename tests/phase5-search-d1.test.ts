// Phase 5 permission-aware search index and bounded listings on actual D1 (disposable
// fixtures; permissions enabled only here). Covers: large readable + private corpora,
// filters, ranking independence from hidden documents, keyset pagination completeness and
// stability (search, workspace_overview, query_records), duplicate titles, body-only matches,
// edits / moves / soft delete / restore before and after indexing, interrupted processing and
// index recovery, revocation and a permission change between candidate scan and decision,
// and measured binding calls / rows read / rows written. Evidence: phase5-search-cost.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openAuditFixture, ctx as executionCtx, type AuditFixture } from './audit-fixture';

const tools = vi.hoisted(() => new Map<string, (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>>());
vi.mock('@modelcontextprotocol/server', () => ({ McpServer: class { registerTool(name: string, _meta: unknown, fn: never) { tools.set(name, fn); } registerPrompt() {} registerResource() {} }, ResourceTemplate: class {} }));
vi.mock('agents/mcp/server', () => ({ createMcpHandler: vi.fn() }));
vi.mock('../worker/events', async (original) => ({ ...(await original<typeof import('../worker/events')>()), scheduleOutbox: vi.fn() }));
import { createWorkspaceServer } from '../worker/mcp';
import { applyChanges } from '../worker/sync';
import { moveRoot } from '../worker/spaceMove';
import { searchRecords, processSearchBacklog, processSearchDirty, enqueueSearchRebuild, SearchError } from '../worker/search';
import { searchApi } from '../worker/searchApi';
import { withReadGate } from '../worker/readAccess';
import { withD1Budget, d1BudgetRemaining } from '../worker/d1budget';

let fx: AuditFixture | undefined, seq = 0;
afterEach(async () => { await fx?.dispose(); fx = undefined; });
const db = () => fx!.db;
const row = (id: string, collection: string, data: Record<string, unknown>, space = 'space-core') =>
  db().prepare('INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES(?,?,?,?,?,?)').bind(id, collection, JSON.stringify(data), JSON.stringify(Object.fromEntries(Object.keys(data).map((k) => [k, 1]))), ++seq, space);
const bulk = async (n: number, make: (i: number) => D1PreparedStatement) => { for (let i = 0; i < n; i += 100) await db().batch(Array.from({ length: Math.min(100, n - i) }, (_, k) => make(i + k))); };
const member = (space: string, user: string, role = 'editor') => db().prepare('INSERT INTO space_members(space_id,user_id,role) VALUES(?,?,?) ON CONFLICT(space_id,user_id) DO UPDATE SET role=excluded.role').bind(space, user, role).run();
const revoke = (space: string, user: string) => db().prepare('DELETE FROM space_members WHERE space_id=? AND user_id=?').bind(space, user).run();
const drain = async () => { for (let i = 0; i < 200; i++) if (!(await processSearchBacklog(fx!.env, 50))) return; throw new Error('index did not drain'); };
const dirty = async () => Number(await db().prepare('SELECT COUNT(*) n FROM search_dirty').first('n'));

async function world() {
  seq = 0;
  fx = await openAuditFixture([{ id: 'alice', role: 'admin' }, { id: 'bob' }, { id: 'gina' }]);
  await db().prepare("UPDATE users SET workspace_role='guest' WHERE id='gina'").run();
  await db().prepare("INSERT INTO spaces(id,name,default_access,created_at) VALUES('vault','Vault','private',1)").run();
  await member('vault', 'alice', 'admin');
  await db().prepare('UPDATE access_state SET enabled=1 WHERE id=1').run();
}
async function searchAll(user: string, q: string, opts: { type?: 'page' | 'task' | 'board' | 'moodboard'; databaseId?: string; limit?: number } = {}) {
  const env = withReadGate(fx!.env, user), ids: string[] = [];
  let cursor: string | null = null, pages = 0;
  do {
    const out = await searchRecords(env, user, { q, ...opts, cursor, limit: opts.limit ?? 50 });
    ids.push(...out.results.map((r) => r.docId));
    cursor = out.nextCursor; pages++;
    expect(pages).toBeLessThan(500);
  } while (cursor);
  return ids;
}
function mcp(user: string, env: unknown = fx!.env) {
  createWorkspaceServer({ env, ectx: executionCtx, userId: user, userRole: 'member', origin: 'http://localhost', userByKey: new Map(), userNameById: new Map(), pageTitleById: new Map(),
    recordTitleById: new Map(), recordIdByTitle: new Map(), pageIdByTitle: new Map(), cachesReady: false, warnings: [], cs: null, toolName: '' } as never);
  return async (name: string, args: Record<string, unknown>) => { const res = await tools.get(name)!(args); return { json: JSON.parse(res.content[0].text) as Record<string, any>, isError: res.isError === true, text: res.content[0].text }; };
}
/** Binding calls, rows read and rows written of one operation. */
function meter() {
  const raw = fx!.env.DB, totals = { calls: 0, rowsRead: 0, rowsWritten: 0 };
  const note = (r: unknown) => { const m = (r as { meta?: { rows_read?: number; rows_written?: number } })?.meta; if (m) { totals.rowsRead += m.rows_read ?? 0; totals.rowsWritten += m.rows_written ?? 0; } return r; };
  const wrapStmt = (st: D1PreparedStatement): D1PreparedStatement => new Proxy(st, { get(t, k) {
    if (k === 'bind') return (...v: unknown[]) => wrapStmt(t.bind(...v));
    if (k === 'all' || k === 'run') return async () => { totals.calls++; return note(await (t as any)[k]()); };
    if (k === 'first' || k === 'raw') return async (...a: unknown[]) => { totals.calls++; return (t as any)[k](...a); };
    const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v;
  } });
  const unwrap = new WeakMap<object, D1PreparedStatement>();
  const DB = new Proxy(raw, { get(t, k) {
    if (k === 'prepare') return (sql: string) => { const st = t.prepare(sql), w = wrapStmt(st); unwrap.set(w, st); return w; };
    if (k === 'batch') return async (sts: D1PreparedStatement[]) => { totals.calls++; const rs = await t.batch(sts.map((s) => (s as unknown as { __target?: D1PreparedStatement }).__target ?? s)); rs.forEach(note); return rs; };
    const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v;
  } });
  return { env: { ...fx!.env, DB } as typeof fx extends undefined ? never : AuditFixture['env'], totals };
}

describe('search index: large readable and private corpora', () => {
  it('returns every readable match exactly once across pages, in a stable order, and nothing private', async () => {
    await world();
    await bulk(1500, (i) => row(`c${i}`, 'pages', { title: `Harvest report ${i}` }));
    await bulk(900, (i) => row(`v${i}`, 'pages', { title: `Harvest secret ${i}` }, 'vault'));
    await bulk(600, (i) => row(`cb${i}`, 'blocks', { pageId: `c${i}`, type: 'p', text: `crop yield notes ${i}`, order: 'a0' }));
    await drain();
    const bob = await searchAll('bob', 'harvest');
    expect(bob.length).toBe(1500); expect(new Set(bob).size).toBe(1500);
    expect(bob.every((id) => id.startsWith('c'))).toBe(true);
    expect(await searchAll('bob', 'harvest')).toEqual(bob);                    // stable
    const alice = await searchAll('alice', 'harvest secret');
    expect(alice.length).toBe(900); expect(alice.every((id) => id.startsWith('v'))).toBe(true);
    expect(await searchAll('gina', 'harvest')).toEqual([]);                    // a guest without spaces
    // Body-only matches rank after title matches; snippets come only from readable docs.
    const crop = await searchRecords(withReadGate(fx!.env, 'bob'), 'bob', { q: 'crop yield', limit: 5 });
    expect(crop.results).toHaveLength(5); expect(crop.results.every((r) => r.snippet?.includes('[crop]'))).toBe(true);
    expect(JSON.stringify(crop)).not.toMatch(/total|count|rank|secret/i);
  }, 300_000);

  it('hidden documents cannot change the visible ranking; filters by type and database; duplicate titles both appear', async () => {
    await world();
    await db().batch([
      row('p1', 'pages', { title: 'Orchid study' }), row('p2', 'pages', { title: 'Orchid study' }), row('p3', 'pages', { title: 'Greenhouse' }),
      row('p3b', 'blocks', { pageId: 'p3', type: 'p', text: 'orchid cuttings', order: 'a0' }),
      row('db1', 'boards', { name: 'Plants', columns: [{ id: 'todo', name: 'Todo' }] }), row('db2', 'boards', { name: 'Other', columns: [] }),
      row('t1', 'tasks', { title: 'Water orchid', boardId: 'db1', status: 'todo' }), row('t2', 'tasks', { title: 'Orchid order', boardId: 'db2', status: 'todo' }),
    ]);
    await drain();
    const before = await searchAll('bob', 'orchid');
    expect(before.sort()).toEqual(['p1', 'p2', 'p3', 't1', 't2']);
    const ordered = await searchAll('bob', 'orchid');
    expect(ordered.indexOf('p3')).toBeGreaterThan(Math.max(ordered.indexOf('p1'), ordered.indexOf('p2'), ordered.indexOf('t1'))); // body-only last
    await bulk(400, (i) => row(`hx${i}`, 'pages', { title: `Orchid orchid orchid ${i}` }, 'vault'));
    await drain();
    expect(await searchAll('bob', 'orchid')).toEqual(ordered);              // identical order and set
    expect(await searchAll('bob', 'orchid', { type: 'task' })).toEqual(expect.arrayContaining(['t1', 't2']));
    expect(await searchAll('bob', 'orchid', { databaseId: 'db1' })).toEqual(['t1']);
    expect(await searchAll('bob', 'plants', { type: 'board' })).toEqual(['db1']);
  });

  it('rejects a forged or foreign cursor and never interprets query syntax', async () => {
    await world();
    await db().batch([row('a', 'pages', { title: 'Alpha OR beta' })]);
    await drain();
    const env = withReadGate(fx!.env, 'bob');
    await expect(searchRecords(env, 'bob', { q: 'alpha', cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(SearchError);
    // FTS operators and punctuation are literals: `"alpha" OR* (` is the words alpha + or.
    expect((await searchRecords(env, 'bob', { q: '"alpha" OR* (' })).results.map((r) => r.docId)).toEqual(['a']);
    expect((await searchRecords(env, 'bob', { q: 'NEAR alpha' })).results).toEqual([]);
    expect((await searchRecords(env, 'bob', { q: '*' })).results).toEqual([]);
    const page = await searchRecords(env, 'bob', { q: 'a', limit: 1 });
    if (page.nextCursor) await expect(searchRecords(env, 'bob', { q: 'beta', cursor: page.nextCursor })).rejects.toThrow('invalid_cursor');
    const http = await searchApi.request('http://localhost/?q=alpha', { headers: fx!.auth('bob') }, fx!.env, executionCtx);
    expect(await http.json()).toMatchObject({ results: [{ id: 'a', type: 'page', url: '/pages/a' }], hasMore: false });
  });
});

describe('search freshness: edits, moves, deletion, restoration and recovery', () => {
  it('serves current content before AND after indexing, and never stale or moved text', async () => {
    await world();
    await db().batch([row('pg', 'pages', { title: 'Lantern plan' }), row('pgb', 'blocks', { pageId: 'pg', type: 'p', text: 'copper wiring', order: 'a0' })]);
    await drain();
    expect(await searchAll('bob', 'lantern')).toEqual(['pg']);
    // Edit (not yet indexed): the new title matches, the old one does not.
    await applyChanges(fx!.env, 'alice', [{ id: 'pg', collection: 'pages', patch: { title: 'Beacon plan' }, ts: Date.now() }], { serverTs: true });
    expect(await dirty()).toBe(1);
    expect(await searchAll('bob', 'lantern')).toEqual([]); expect(await searchAll('bob', 'beacon')).toEqual(['pg']);
    await drain();
    expect(await searchAll('bob', 'lantern')).toEqual([]); expect(await searchAll('bob', 'beacon')).toEqual(['pg']);
    // Body edit.
    await applyChanges(fx!.env, 'alice', [{ id: 'pgb', collection: 'blocks', patch: { text: 'brass fittings' }, ts: Date.now() }], { serverTs: true });
    expect(await searchAll('bob', 'copper')).toEqual([]); expect(await searchAll('bob', 'brass')).toEqual(['pg']);
    await drain();
    expect(await searchAll('bob', 'copper')).toEqual([]); expect(await searchAll('bob', 'brass')).toEqual(['pg']);
    // Soft delete and restore.
    await applyChanges(fx!.env, 'alice', [{ id: 'pg', collection: 'pages', patch: { deleted: true }, ts: Date.now() }], { serverTs: true });
    expect(await searchAll('bob', 'beacon')).toEqual([]); await drain(); expect(await searchAll('bob', 'beacon')).toEqual([]);
    await applyChanges(fx!.env, 'alice', [{ id: 'pg', collection: 'pages', patch: { deleted: false }, ts: Date.now() }], { serverTs: true });
    expect(await searchAll('bob', 'beacon')).toEqual(['pg']); await drain(); expect(await searchAll('bob', 'beacon')).toEqual(['pg']);
    // Move into a private space: gone for bob at once, still found by alice.
    await moveRoot(db(), { id: 'alice' }, { recordId: 'pg', toSpaceId: 'vault', requestId: 'mv1' });
    expect(await searchAll('bob', 'beacon')).toEqual([]); expect(await searchAll('alice', 'beacon')).toEqual(['pg']);
    await drain();
    expect(await searchAll('bob', 'brass')).toEqual([]); expect(await searchAll('alice', 'brass')).toEqual(['pg']);
    expect((await db().prepare("SELECT space_id FROM search_documents WHERE doc_id='pg'").first('space_id'))).toBe('vault');
  });

  it('an interrupted rebuild keeps the dirty key; a lost index is rebuilt; a backlog is reported, never hidden', async () => {
    await world();
    await bulk(260, (i) => row(`d${i}`, 'pages', { title: `Delta ${i}` }));
    // Interruption: the write batch fails -> nothing removed from the dirty queue, results still correct (live).
    const failing = { ...fx!.env, DB: new Proxy(fx!.env.DB, { get(t, k) { if (k === 'batch') return async (s: D1PreparedStatement[]) => { if (s.length > 2) throw new Error('injected'); return t.batch(s); }; const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v; } }) };
    await expect(processSearchDirty(failing)).rejects.toThrow('injected');
    expect(await dirty()).toBe(260);
    const pending = await searchRecords(withReadGate(fx!.env, 'bob'), 'bob', { q: 'delta', limit: 50 });
    expect(pending.indexPending).toBe(true);                                  // > 200 dirty: said explicitly
    await drain();
    expect((await searchAll('bob', 'delta')).length).toBe(260);
    // Lose the derived index entirely; rebuild from records.
    await db().batch([db().prepare('DELETE FROM search_fts'), db().prepare('DELETE FROM search_documents')]);
    expect(await searchAll('bob', 'delta')).toEqual([]);
    for (let after: string | null = ''; after !== null;) after = (await enqueueSearchRebuild(fx!.env, after)).next;
    await drain();
    expect((await searchAll('bob', 'delta')).length).toBe(260);
    expect((await searchRecords(withReadGate(fx!.env, 'bob'), 'bob', { q: 'delta' })).indexPending).toBe(false);
  });
});

describe('search authorization changes', () => {
  it('follows grants and revocations without reindexing, including a revocation after the candidate scan', async () => {
    await world();
    await db().batch([row('vp', 'pages', { title: 'Comet notes' }, 'vault'), row('cp', 'pages', { title: 'Comet public' })]);
    await drain();
    expect(await searchAll('bob', 'comet')).toEqual(['cp']);
    await member('vault', 'bob', 'viewer');
    expect((await searchAll('bob', 'comet')).sort()).toEqual(['cp', 'vp']);
    await revoke('vault', 'bob');
    expect(await searchAll('bob', 'comet')).toEqual(['cp']);
    // Revocation lands between the FTS candidate query and the gate's decision.
    await member('vault', 'bob', 'viewer');
    let armed = true;
    const DB = new Proxy(fx!.env.DB, { get(t, k) {
      if (k !== 'prepare') { const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v; }
      return (sql: string) => {
        const st = t.prepare(sql);
        if (!sql.includes('search_fts MATCH') || !sql.includes('ORDER BY score')) return st;
        return new Proxy(st, { get(s, p) { if (p !== 'bind') { const v = Reflect.get(s, p); return typeof v === 'function' ? v.bind(s) : v; }
          return (...args: unknown[]) => { const b = s.bind(...args); return new Proxy(b, { get(x, q) {
            if (q !== 'all') { const v = Reflect.get(x, q); return typeof v === 'function' ? v.bind(x) : v; }
            return async () => { const r = await x.all(); if (armed) { armed = false; await revoke('vault', 'bob'); } return r; };
          } }); }; } });
      };
    } }) as D1Database;
    const out = await searchRecords(withReadGate({ ...fx!.env, DB }, 'bob'), 'bob', { q: 'comet' });
    expect(out.results.map((r) => r.docId)).toEqual(['cp']);
  });
});

describe('bounded listings: workspace_overview and query_records', () => {
  it('overview pages every readable page exactly once in tree order; no private titles; explicit cursors', async () => {
    await world();
    await bulk(1300, (i) => row(`op${i}`, 'pages', { title: `Open ${i}`, order: `a${String(i).padStart(5, '0')}` }));
    await bulk(700, (i) => row(`hp${i}`, 'pages', { title: `Hidden ${i}`, order: `a${String(i).padStart(5, '0')}` }, 'vault'));
    const call = mcp('bob');
    const first = await call('workspace_overview', {});
    expect(first.json.pages).toHaveLength(200); expect(first.json.pagesNextCursor).toBeTruthy(); expect(first.json.people.length).toBe(3);
    const ids = first.json.pages.map((p: { id: string }) => p.id);
    for (let cursor = first.json.pagesNextCursor; cursor;) {
      const next = await call('workspace_overview', { section: 'pages', cursor, limit: 500 });
      expect(next.isError, next.text).toBe(false); expect(next.json.boards).toBeUndefined();
      ids.push(...next.json.pages.map((p: { id: string }) => p.id)); cursor = next.json.pagesNextCursor;
    }
    expect(ids).toHaveLength(1300); expect(new Set(ids).size).toBe(1300);
    expect(ids.slice(0, 3)).toEqual(['op0', 'op1', 'op2']);
    expect((await call('workspace_overview', { section: 'pages', cursor: 'bogus' })).isError).toBe(true);
    const alice = await mcp('alice')('workspace_overview', { limit: 500 });
    expect(alice.json.pages.some((p: { id: string }) => p.id.startsWith('hp'))).toBe(true);
    expect(JSON.stringify(first.json)).not.toContain('Hidden');
  });

  it('query_records pages a large database completely with filters, keeps sorts explicit, and follows revocation', async () => {
    await world();
    await db().batch([row('big', 'boards', { name: 'Big', columns: [{ id: 'todo', name: 'Todo' }, { id: 'done', name: 'Done' }], fields: [{ id: 'n', name: 'N', type: 'number' }] }),
      row('vdb', 'boards', { name: 'Vault DB', columns: [{ id: 'todo', name: 'Todo' }] }, 'vault')]);
    await bulk(5200, (i) => row(`r${String(i).padStart(5, '0')}`, 'tasks', { title: `Row ${i}`, boardId: 'big', status: i % 3 ? 'todo' : 'done', p_n: i }));
    await bulk(50, (i) => row(`vr${i}`, 'tasks', { title: `Vault row ${i}`, boardId: 'vdb', status: 'todo' }, 'vault'));
    const call = mcp('bob');
    const got: string[] = [];
    let cursor: string | undefined, calls = 0;
    do {
      const page = await call('query_records', { databaseId: 'big', filters: [{ field: 'stage', op: 'is', value: 'done' }], limit: 200, ...(cursor ? { cursor } : {}) });
      expect(page.isError, page.text).toBe(false);
      got.push(...page.json.rows.map((r: { id: string }) => r.id)); cursor = page.json.nextCursor ?? undefined; calls++;
      expect(page.json.hasMore).toBe(!!cursor);
    } while (cursor && calls < 100);
    const expected = Array.from({ length: 5200 }, (_, i) => i).filter((i) => i % 3 === 0).map((i) => `r${String(i).padStart(5, '0')}`);
    expect(got).toEqual(expected);                                            // complete, ordered, no duplicates
    const sorted = await call('query_records', { databaseId: 'big', sorts: [{ field: 'N', dir: 'desc' }] });
    expect(sorted.isError).toBe(true); expect(sorted.text).toMatch(/more than 5000/);
    expect((await call('query_records', { databaseId: 'vdb' })).json).toEqual({ error: 'database not found' });
    await member('vault', 'bob', 'viewer');
    const first = await mcp('bob')('query_records', { databaseId: 'vdb', limit: 20 });
    expect(first.json.rows).toHaveLength(20);
    const smallSorted = await mcp('bob')('query_records', { databaseId: 'vdb', sorts: [{ field: 'title', dir: 'desc' }], limit: 5 });
    expect(smallSorted.json.rows.map((r: { title: string }) => r.title)).toEqual(['Vault row 9', 'Vault row 8', 'Vault row 7', 'Vault row 6', 'Vault row 5']);
    await revoke('vault', 'bob');
    expect((await mcp('bob')('query_records', { databaseId: 'vdb', cursor: first.json.nextCursor })).json).toEqual({ error: 'database not found' });
  }, 300_000);
});

describe('measured cost', () => {
  it('search, listings, indexing and the per-write trigger stay bounded; evidence written', async () => {
    await world();
    await bulk(3000, (i) => row(`m${i}`, 'pages', { title: `Meadow ${i}`, order: `a${String(i).padStart(5, '0')}` }, i % 3 ? 'space-core' : 'vault'));
    await bulk(3000, (i) => row(`mb${i}`, 'blocks', { pageId: `m${i}`, type: 'p', text: `wildflower survey ${i}`, order: 'a0' }, i % 3 ? 'space-core' : 'vault'));
    await db().batch([row('qb', 'boards', { name: 'Q', columns: [{ id: 'todo', name: 'Todo' }] })]);
    await bulk(3000, (i) => row(`q${i}`, 'tasks', { title: `Q ${i}`, boardId: 'qb', status: 'todo' }));
    const index = meter();
    const indexed = await processSearchDirty(index.env);
    expect(indexed).toBe(50);
    await drain();
    const cost: Record<string, unknown> = { indexChunk: { docs: indexed, ...index.totals } };
    for (const [name, q] of [['searchTitle', 'meadow 12'], ['searchBody', 'wildflower'], ['searchRare', 'meadow 2999']] as const) {
      const m = meter(), budget = withD1Budget(m.env), before = d1BudgetRemaining(budget.DB);
      const out = await searchRecords(withReadGate(budget, 'bob'), 'bob', { q, limit: 20 });
      expect(out.results.length).toBeGreaterThan(0);
      cost[name] = { bindingCalls: before - d1BudgetRemaining(budget.DB), rowsRead: m.totals.rowsRead, rowsWritten: m.totals.rowsWritten };
      expect(m.totals.rowsWritten).toBe(0);
      expect(before - d1BudgetRemaining(budget.DB)).toBeLessThan(20);
    }
    for (const [name, tool, args] of [['overview', 'workspace_overview', {}], ['overviewPage', 'workspace_overview', { section: 'pages', limit: 500 }], ['queryRecords', 'query_records', { databaseId: 'qb', limit: 200 }]] as const) {
      const m = meter(), budget = withD1Budget(m.env), before = d1BudgetRemaining(budget.DB);
      const out = await mcp('bob', budget)(tool, args as Record<string, unknown>);
      expect(out.isError, out.text.slice(0, 200)).toBe(false);
      cost[name] = { bindingCalls: before - d1BudgetRemaining(budget.DB), rowsRead: m.totals.rowsRead, rowsWritten: m.totals.rowsWritten };
      expect(before - d1BudgetRemaining(budget.DB)).toBeLessThan(30);
    }
    // One ordinary edit: the dirty-key upsert is the only extra write.
    const w = meter();
    await applyChanges(w.env, 'alice', [{ id: 'm1', collection: 'pages', patch: { title: 'Meadow edited' }, ts: Date.now() }], { serverTs: true });
    cost.editPage = w.totals;
    expect(await dirty()).toBe(1);
    const dir = process.env.CERT_ARTIFACT_DIR ?? '.artifacts/phase5-reads';
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/phase5-search-cost.json`, JSON.stringify({ corpus: { pages: 3000, blocks: 3000, records: 3000, readableShare: '2/3' }, cost }, null, 2));
  }, 300_000);
});
