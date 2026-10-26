import { afterEach, describe, expect, it, vi } from 'vitest';
import { openAuditFixture, ctx as ectx, type AuditFixture } from './audit-fixture';
import { aggregate, type Filter } from '../shared/views';
import { withD1Budget, d1BudgetRemaining } from '../worker/d1budget';

const tools = vi.hoisted(() => new Map<string, (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>>());
vi.mock('@modelcontextprotocol/server', () => ({ McpServer: class { registerTool(name: string, _meta: unknown, fn: never) { tools.set(name, fn); } registerPrompt() {} registerResource() {} }, ResourceTemplate: class {} }));
vi.mock('agents/mcp/server', () => ({ createMcpHandler: vi.fn() }));
vi.mock('../worker/events', async original => ({ ...(await original<typeof import('../worker/events')>()), scheduleOutbox: vi.fn() }));
vi.mock('../worker/workspaceSettings', async original => ({ ...(await original<typeof import('../worker/workspaceSettings')>()), serverDateContext: async () => ({timeZone:'UTC',currency:'INR',weekStart:1,version:1,updatedAt:0,today:'2026-10-24'}) }));
import { createWorkspaceServer } from '../worker/mcp';

let fx: AuditFixture | undefined;
afterEach(async () => { await fx?.dispose(); fx = undefined; });

async function setup(enabled: boolean) {
  fx = await openAuditFixture([{ id: 'alice', role: 'admin' }, { id: 'bob' }]);
  const rows = [
    { id: 'near', title: 'Near', p_deadline: '2026-10-30', status: 'open' },
    { id: 'next', title: 'Next year', p_deadline: '2027-12-31', status: 'open' },
    { id: 'distant', title: 'Distant', p_deadline: '2099-01-01', status: 'open' },
    { id: 'won', title: 'Won', p_deadline: '2026-10-30', status: 'won' },
  ];
  const data = [
    { id: 'opportunities', collection: 'boards', data: { name: 'Opportunities', kind: 'records', columns: [{ id: 'open', name: 'Open' }, { id: 'won', name: 'Won' }], fields: [{ id: 'deadline', name: 'Deadline', type: 'date' }] } },
    { id: 'existing-view', collection: 'views', data: { databaseId: 'opportunities', name: 'Existing', type: 'table', config: {}, order: 'a0' } },
    ...rows.map(row => ({ id: row.id, collection: 'tasks', data: { ...row, boardId: 'opportunities' } })),
  ];
  await fx.db.batch(data.map((row, i) => fx!.db.prepare("INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES(?,?,?,'{}',?,'space-core')").bind(row.id, row.collection, JSON.stringify(row.data), i + 1)));
  await fx.db.prepare('UPDATE access_state SET enabled=? WHERE id=1').bind(enabled ? 1 : 0).run();
  return rows;
}

async function call(name: string, args: Record<string, unknown>, userId = 'alice') {
  const env = withD1Budget(fx!.env, 45);
  createWorkspaceServer({ env, ectx, userId, userRole: userId === 'alice' ? 'admin' : 'member', origin: 'http://localhost', userByKey: new Map(), userNameById: new Map(), pageTitleById: new Map(), recordTitleById: new Map(), recordIdByTitle: new Map(), pageIdByTitle: new Map(), cachesReady: false, warnings: [], cs: null, toolName: '' } as never);
  const output = await tools.get(name)!(args);
  expect(45 - d1BudgetRemaining(env.DB), name + ' binding calls').toBeLessThanOrEqual(45);
  return { ...output, json: JSON.parse(output.content[0].text) };
}

describe.each([false, true])('R1 actual D1, permissions enabled=%s (disposable)', enabled => {
  it('query_records agrees with metric ids, including sorted and paged reads', async () => {
    const rows = await setup(enabled);
    const filters: Filter[] = [{ key: 'p_deadline', op: 'on_or_before', value: 'today+30' }, { key: 'p_deadline', op: 'on_or_after', value: 'today' }, { key: 'status', op: 'is_not', value: 'won' }];
    const expected = aggregate(rows, { agg: 'count', filters }, { today: '2026-10-24' });
    expect(expected.ids).toEqual(['near']);
    const named = filters.map(f => ({ field: f.key === 'p_deadline' ? 'Deadline' : 'status', op: f.op, value: f.value }));
    for (const sorts of [undefined, [{ field: 'title', dir: 'asc' }]]) {
      const result = await call('query_records', { databaseId: 'opportunities', filters: named, sorts, limit: 1 });
      expect(result.isError, JSON.stringify(result.json)).not.toBe(true);
      expect(result.json.rows.map((r: { id: string }) => r.id)).toEqual(expected.ids);
      if (result.json.hasMore) {
        const remaining = await call('query_records', { databaseId: 'opportunities', filters: named, sorts, limit: 1, cursor: result.json.nextCursor });
        expect(remaining.json.rows).toEqual([]);
        expect(remaining.json.hasMore).toBe(false);
      }
    }
  });
  it('rejects malformed add/update/query operands and preserves stored config', async () => {
    await setup(enabled);
    for (const value of ['today+3651', 'today + 3', 'Today+3']) {
      const filters = [{ field: 'Deadline', op: 'on_or_before', value }];
      for (const [name, args] of [
        ['add_view', { databaseId: 'opportunities', name: 'Invalid ' + value, filters }],
        ['update_view', { viewId: 'existing-view', filters }],
      ] as const) {
        const out = await call(name, args);
        expect(out.isError).toBe(true);
        expect(JSON.stringify(out.json)).toContain('0 to 3650');
      }
      const invalidRead = await call('query_records', { databaseId: 'opportunities', filters });
      expect(invalidRead.isError).toBe(true);
      expect(JSON.stringify(invalidRead.json)).toContain('0 to 3650');
    }
    const row = await fx!.db.prepare("SELECT data FROM records WHERE id='existing-view'").first<{ data: string }>();
    expect(JSON.parse(row!.data).config).toEqual({});
    const valid = await call('add_view', { databaseId: 'opportunities', name: 'Next month', filters: [{ field: 'Deadline', op: 'on_or_before', value: 'today+30' }] });
    expect(valid.isError, JSON.stringify(valid.json)).not.toBe(true);
    const text = await call('query_records', { databaseId: 'opportunities', filters: [{ field: 'title', op: 'is', value: 'Today+3' }] });
    expect(text.isError).not.toBe(true);
  });
  it('retains private-space isolation for relative queries', async () => {
    await setup(enabled);
    await fx!.db.prepare("INSERT INTO spaces(id,name,default_access,created_at) VALUES('private-r1','Private','private',1)").run();
    await fx!.db.prepare("UPDATE records SET space_id='private-r1' WHERE id IN ('opportunities','near')").run();
    const result = await call('query_records', { databaseId: 'opportunities', filters: [{ field: 'Deadline', op: 'before', value: 'today+30' }] }, 'bob');
    expect(result.isError === true).toBe(enabled);
    if (enabled) expect(JSON.stringify(result.json)).not.toContain('Near');
  });
});
