import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openAuditFixture, ctx, type AuditFixture } from './audit-fixture';

type Result = { content: { text: string }[]; structuredContent?: unknown; isError?: boolean };
type Schema = { parse(input: unknown): Record<string, unknown> };
const registry = vi.hoisted(() => new Map<string, {
  input: Schema; output?: Schema; run(input: Record<string, unknown>): Promise<Result>;
}>());
vi.mock('@modelcontextprotocol/server', () => ({
  McpServer: class {
    registerTool(name: string, meta: { inputSchema: Schema; outputSchema?: Schema }, run: (input: Record<string, unknown>) => Promise<Result>) {
      registry.set(name, { input: meta.inputSchema, output: meta.outputSchema, run });
    }
    registerPrompt() {}
    registerResource() {}
  },
  ResourceTemplate: class {},
}));
vi.mock('agents/mcp/server', () => ({ createMcpHandler: vi.fn() }));
vi.mock('../worker/events', async original => ({
  ...(await original<typeof import('../worker/events')>()), scheduleOutbox: vi.fn(),
}));

import { createWorkspaceServer } from '../worker/mcp';
import { withD1Budget } from '../worker/d1budget';

let fixture: AuditFixture;
beforeAll(async () => {
  fixture = await openAuditFixture();
  await fixture.db.prepare("INSERT INTO spaces(id,name,created_at) VALUES('space-other','Separate project',0)").run();
  await fixture.db.prepare("UPDATE access_state SET enabled=1 WHERE id=1").run();
  const rows = [
    { id: 'projects', collection: 'boards', data: { name: 'Projects', kind: 'records', fields: [{ id: 'points', name: 'Points', type: 'number' }] }, space: 'space-core' },
    { id: 'project-a', collection: 'tasks', data: { boardId: 'projects', title: 'First', createdAt: 50, p_points: 5 }, space: 'space-core' },
    { id: 'project-b', collection: 'tasks', data: { boardId: 'projects', title: 'Second', createdAt: 400, p_points: 4 }, space: 'space-core' },
    { id: 'project-c', collection: 'tasks', data: { boardId: 'projects', title: 'Skip', createdAt: 500, p_points: 7 }, space: 'space-core' },
    { id: 'dashboard-feed', collection: 'views', data: { databaseId: 'projects', name: 'Dashboard feed', type: 'feed', order: 'a0', config: {} }, space: 'space-core' },
    { id: 'projects-landing', collection: 'pages', data: { title: 'Project updates' }, space: 'space-core' },
    { id: 'other-project', collection: 'boards', data: { name: 'Private', kind: 'records' }, space: 'space-other' },
    { id: 'other-view', collection: 'views', data: { databaseId: 'other-project', name: 'Private plan', type: 'table', config: {} }, space: 'space-other' },
  ];
  await fixture.db.batch(rows.map((row, index) => fixture.db.prepare(
    "INSERT INTO records(id,collection,data,field_ts,seq,space_id) VALUES(?,?,?,'{}',?,?)",
  ).bind(row.id, row.collection, JSON.stringify(row.data), index + 1, row.space)));
});
afterAll(async () => { await fixture?.dispose(); });

async function tool(name: string, input: Record<string, unknown>, userId = 'alice') {
  createWorkspaceServer({
    env: withD1Budget(fixture.env, 45), ectx: ctx, userId, userRole: userId === 'alice' ? 'admin' : 'member',
    clientName: 'Local test', origin: 'https://localhost', userByKey: new Map(), userNameById: new Map(),
    pageTitleById: new Map(), recordTitleById: new Map(), recordIdByTitle: new Map(),
    pageIdByTitle: new Map(), cachesReady: false, warnings: [], cs: null, toolName: '',
  } as never);
  const handler = registry.get(name)!;
  const result = await handler.run(handler.input.parse(input));
  if (!result.isError && handler.output) expect(handler.output.parse(result.structuredContent)).toEqual(result.structuredContent);
  return { ...result, data: JSON.parse(result.content[0].text) };
}

describe('configurable database MCP', () => {
  it('lists, copies and queries a saved feed without creating records', async () => {
    const created = await tool('add_view', {
      databaseId: 'projects', name: 'Updates', type: 'feed',
      filters: [{ field: 'title', op: 'is_not', value: 'Skip' }],
    });
    expect(created.isError, JSON.stringify(created.data)).not.toBe(true);
    const feedId = created.data.id;
    const listed = await tool('list_database_views', { databaseId: 'projects' });
    expect(listed.structuredContent).toEqual(listed.data);
    expect(listed.data.views.find((view: { id: string }) => view.id === feedId)).toMatchObject({
      id: feedId, type: 'feed', config: { sorts: [{ key: 'createdAt', dir: 'desc' }] },
    });
    const first = await tool('query_records', { databaseId: 'projects', viewId: feedId, limit: 1 });
    expect(first.data.rows.map((row: { id: string }) => row.id)).toEqual(['project-b']);
    const next = await tool('query_records', { databaseId: 'projects', viewId: feedId, cursor: first.data.nextCursor });
    expect(next.data.rows.map((row: { id: string }) => row.id)).toEqual(['project-a']);
    const copy = await tool('duplicate_view', { viewId: feedId, name: 'Personal setup', requestId: 'copy-updates' });
    expect(copy.isError, JSON.stringify(copy.data)).not.toBe(true);
    expect(copy.data.id).not.toBe(feedId);
    expect((await tool('duplicate_view', { viewId: feedId, name: 'Personal setup', requestId: 'copy-updates' })).data.replayed).toBe(true);
    const withCopy = await tool('list_database_views', { databaseId: 'projects' });
    expect(withCopy.data.views.at(-1)).toMatchObject({ id: copy.data.id, name: 'Personal setup', config: listed.data.views.find((view: { id: string }) => view.id === feedId).config });
    const selected = await tool('set_default_view', { databaseId: 'projects', viewId: copy.data.id, expectedRev: withCopy.data.databaseRev });
    expect(selected.isError, JSON.stringify(selected.data)).not.toBe(true);
    expect((await tool('set_default_view', { databaseId: 'projects', viewId: null, expectedRev: withCopy.data.databaseRev })).data.error).toBe('conflict');
    expect((await tool('list_database_views', { databaseId: 'projects' })).data.defaultViewId).toBe(copy.data.id);
  });

  it('keeps view lookup and dashboard attachment inside canonical scopes', async () => {
    expect((await tool('list_database_views', { databaseId: 'other-project' }, 'bob')).data.error).toBe('database not found');
    expect((await tool('query_records', { databaseId: 'projects', viewId: 'other-view' })).data.error).toBe('view not found');
    const widgets = [
      { type: 'view', databaseId: 'projects', viewId: 'dashboard-feed', limit: 2 },
      { type: 'metric', databaseId: 'projects', agg: 'sum', field: 'Points', label: 'Total points' },
    ];
    const preview = await tool('append_dashboard_widgets', { pageId: 'projects-landing', widgets, dryRun: true });
    expect(preview.data.humanApprovalRequired, JSON.stringify(preview.data)).toBe(true);
    const write = await tool('append_dashboard_widgets', { pageId: 'projects-landing', widgets });
    expect(write.data.widgetsCreated, JSON.stringify(write.data)).toBe(2);
    const snapshot = await tool('dashboard_snapshot', { pageId: 'projects-landing' });
    expect(snapshot.isError, JSON.stringify(snapshot.data)).not.toBe(true);
    expect(snapshot.data.blocks).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'metric', value: 16 })]));
    expect(snapshot.data.blocks.find((block: { type: string }) => block.type === 'view')).toMatchObject({
      records: [expect.objectContaining({ id: expect.any(String) }), expect.objectContaining({ id: expect.any(String) })],
      truncated: true,
    });
  });

  it('validates draft questions, keeps drafts off and fences revisions and live forms', async () => {
    const args = { databaseId: 'projects', title: 'Project intake', fields: [
      { fieldKey: 'title', label: 'Project', required: true },
      { fieldKey: 'p_points', label: 'Points' },
    ] };
    const rejected = await tool('save_form_draft', { ...args, fields: [{ fieldKey: 'p_missing', label: 'Missing' }] });
    expect(rejected.data.error).toBe('form_validation');
    const created = await tool('save_form_draft', args);
    expect(created.isError, JSON.stringify(created.data)).not.toBe(true);
    const listed = await tool('list_database_forms', { databaseId: 'projects', formId: created.data.id });
    expect(listed.data.forms[0]).toMatchObject({ title: args.title, enabled: false });
    const rev = listed.data.forms[0].rev;
    const updated = await tool('save_form_draft', { ...args, formId: created.data.id, expectedRev: rev, title: 'Updated intake' });
    expect(updated.isError, JSON.stringify(updated.data)).not.toBe(true);
    expect((await tool('save_form_draft', { ...args, formId: created.data.id, expectedRev: rev })).data.error).toBe('conflict');
    await fixture.db.prepare("UPDATE records SET data=json_set(data,'$.enabled',json('true')) WHERE id=?").bind(created.data.id).run();
    expect((await tool('save_form_draft', { ...args, formId: created.data.id, expectedRev: rev })).data.error).toContain('published forms');
    expect(await fixture.db.prepare('SELECT COUNT(*) AS n FROM form_tokens').first('n')).toBe(0);
  });
});
