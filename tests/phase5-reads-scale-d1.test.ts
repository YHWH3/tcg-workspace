// Phase 5 authorized reads at scale, on actual D1, with permissions ENABLED in a disposable
// fixture. Every MCP read path must stay inside the 45-call invocation budget, and the
// targeted ones (page/record reads, templates, mention resolution) must not grow with the
// workspace at all. Correctness of mention resolution (page-first, ambiguity, hidden pages)
// is checked at the large size. Evidence: phase5-reads-scale.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openAuditFixture, ctx as executionCtx, type AuditFixture } from './audit-fixture';

const tools = vi.hoisted(() => new Map<string, (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>>());
vi.mock('@modelcontextprotocol/server', () => ({ McpServer: class { registerTool(name: string, _meta: unknown, fn: never) { tools.set(name, fn); } registerPrompt() {} registerResource() {} }, ResourceTemplate: class {} }));
vi.mock('agents/mcp/server', () => ({ createMcpHandler: vi.fn() }));
vi.mock('../worker/events', async (original) => ({ ...(await original<typeof import('../worker/events')>()), scheduleOutbox: vi.fn() }));
import { createWorkspaceServer } from '../worker/mcp';
import { withD1Budget, d1BudgetRemaining } from '../worker/d1budget';

let fx: AuditFixture | undefined;
afterEach(async () => { await fx?.dispose(); fx = undefined; });

async function world(size: number) {
  fx = await openAuditFixture([{ id: 'alice', role: 'admin' }, { id: 'bob' }]);
  const db = fx.db;
  await db.prepare("INSERT INTO spaces(id,name,default_access,created_at) VALUES('vault','Vault','private',1)").run();
  await db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES('vault','alice','admin')").run();
  let seq = 0;
  const row = (id: string, collection: string, data: Record<string, unknown>, space = 'space-core', peer: string | null = null) =>
    db.prepare('INSERT INTO records(id,collection,data,field_ts,seq,space_id,peer_space_id) VALUES(?,?,?,?,?,?,?)').bind(id, collection, JSON.stringify(data), '{}', ++seq, space, peer);
  const bulk = async (n: number, make: (i: number) => D1PreparedStatement) => { for (let i = 0; i < n; i += 100) await db.batch(Array.from({ length: Math.min(100, n - i) }, (_, k) => make(i + k))); };
  // Fixed probes (identical at every size).
  await db.batch([
    row('core-board', 'boards', { name: 'Core DB', columns: [{ id: 'todo', name: 'Todo' }], fields: [{ id: 'rel', name: 'Rel', type: 'relation', relation: { target: 'core-board' } }] }),
    row('vault-board', 'boards', { name: 'Vault DB', columns: [{ id: 'todo', name: 'Todo' }], fields: [] }, 'vault'),
    row('probe', 'pages', { title: 'Probe page' }),
    row('probe-b1', 'blocks', { pageId: 'probe', type: 'p', text: 'Links @[page:alpha] @[rec:t1] @[page:hidden]', order: 'a0' }),
    row('alpha', 'pages', { title: 'Alpha' }),
    row('dup1', 'pages', { title: 'Twin' }), row('dup2', 'pages', { title: 'Twin' }),
    row('both-page', 'pages', { title: 'Shared name' }),
    row('hidden', 'pages', { title: 'Hidden name' }, 'vault'),
    row('tpl', 'pages', { title: 'Template', isTemplate: true }),
    row('tpl-b', 'blocks', { pageId: 'tpl', type: 'p', text: 'Template body', order: 'a0' }),
    row('t1', 'tasks', { title: 'Task one', boardId: 'core-board', status: 'todo' }),
    row('t2', 'tasks', { title: 'Shared name', boardId: 'core-board', status: 'todo' }),
    row('t3', 'tasks', { title: 'Hidden name', boardId: 'core-board', status: 'todo' }),
    row('child', 'tasks', { title: 'Child', boardId: 'core-board', status: 'todo', parentId: 't1' }),
    row('l1', 'links', { kind: 'relation', fieldId: 'rel', fromType: 'record', fromId: 't1', toType: 'record', toId: 't2' }),
    row('mb', 'moodboards', { title: 'Canvas' }),
  ]);
  // Bulk, scaled by `size`: readable and private pages with bodies, records, items, links, activity.
  await bulk(size, (i) => row(`p${i}`, 'pages', { title: `${i % 3 ? '' : 'Secret '}Bulk page ${i}`, ...(i % 4 === 0 ? { parentId: `p${i - (i % 40)}` } : {}) }, i % 3 ? 'space-core' : 'vault'));
  await bulk(size, (i) => row(`b${i}`, 'blocks', { pageId: `p${i}`, type: 'p', text: `body ${i} mentions @[page:probe]`, order: 'a0' }, i % 3 ? 'space-core' : 'vault'));
  await bulk(size, (i) => row(`r${i}`, 'tasks', { title: `${i % 3 ? '' : 'Secret '}Bulk record ${i}`, boardId: i % 3 ? 'core-board' : 'vault-board', status: 'todo' }, i % 3 ? 'space-core' : 'vault'));
  await bulk(size / 2, (i) => row(`m${i}`, 'mooditems', { boardId: 'mb', type: 'note', text: `n${i}` }));
  await bulk(size / 2, (i) => row(`lk${i}`, 'links', { kind: 'related', fromType: 'record', fromId: `r${3 * i + 1}`, toType: 'record', toId: `r${3 * i + 2}` }));
  await bulk(size, (i) => row(`a${i}`, 'activity', { verb: 'edited', targetType: 'page', targetId: `p${i}`, targetTitle: `${i % 3 ? '' : 'Secret '}Bulk page ${i}`, actorId: 'alice', createdAt: i }, i % 3 ? 'space-core' : 'vault'));
  await db.prepare('UPDATE access_state SET enabled=1 WHERE id=1').run();
}

function context(userId: string, env: unknown) {
  return { env, ectx: executionCtx, userId, userRole: 'member', origin: 'http://localhost', userByKey: new Map(), userNameById: new Map(), pageTitleById: new Map(),
    recordTitleById: new Map(), recordIdByTitle: new Map(), pageIdByTitle: new Map(), cachesReady: false, warnings: [], cs: null, toolName: '' } as never;
}
async function measure(userId: string, tool: string, args: Record<string, unknown>) {
  const env = withD1Budget(fx!.env), before = d1BudgetRemaining(env.DB);
  createWorkspaceServer(context(userId, env));
  const res = await tools.get(tool)!(args);
  const text = res.content[0].text;
  return { calls: before - d1BudgetRemaining(env.DB), text, json: JSON.parse(text) as Record<string, any>, isError: res.isError === true };
}

const PROBES: [string, Record<string, unknown>][] = [
  ['get_page', { pageId: 'probe' }],
  ['fetch', { id: 'page:probe' }],
  ['get_record', { recordId: 't1' }],
  ['query_records', { databaseId: 'core-board', include: ['fields', 'subrecords', 'deps'], limit: 20 }],
  ['fetch', { id: 'board:core-board' }],
  ['list_templates', {}],
  ['search', { query: 'bulk page 1' }],
  ['workspace_overview', {}],
  ['recent_activity', { limit: 20 }],
];
// Targeted reads: cost must be the same at every workspace size.
const FLAT = new Set(['get_page', 'fetch', 'get_record', 'list_templates', 'recent_activity']);

describe('MCP authorized reads at scale (permissions enabled, disposable fixture)', () => {
  it('stay inside the binding budget, and targeted reads do not grow with the workspace', async () => {
    const evidence: Record<string, Record<string, number>> = {};
    for (const size of [600, 4800]) {
      await world(size);
      const calls: Record<string, number> = {};
      for (const [tool, args] of PROBES) {
        const out = await measure('bob', tool, args);
        expect(out.isError, `${tool} at ${size}: ${out.text.slice(0, 200)}`).toBe(false);
        expect(out.text, `${tool} leaks private content`).not.toMatch(/Secret Bulk|Vault DB/);
        calls[`${tool}${args.id ? `:${String(args.id).split(':')[0]}` : ''}`] = out.calls;
      }
      // Mention resolution in a write: page-first, ambiguity warning, hidden page invisible.
      const write = await measure('bob', 'create_page', { title: `Writer ${size}`, markdown: 'See [[Alpha]], [[Twin]], [[Shared name]], [[Hidden name]], [[rec:t1]] and @bob', parentId: 'probe' });
      expect(write.isError, write.text).toBe(false);
      calls.create_page_mentions = write.calls;
      const tpl = await measure('bob', 'create_from_template', { templateId: 'tpl', title: `From template ${size}` });
      expect(tpl.isError, tpl.text).toBe(false);
      calls.create_from_template = tpl.calls;
      for (const [name, n] of Object.entries(calls)) expect(n, `${name} binding calls at ${size}`).toBeLessThan(40);
      evidence[String(size)] = calls;

      if (size === 4800) {
        const page = await measure('bob', 'get_page', { pageId: write.json.id });
        const text = page.json.markdown as string;
        expect(text).toContain('[[Alpha]]');              // page mention resolved and rendered by title
        expect(text).toContain('[[Shared name]]');        // page-first: the PAGE won, not record t2
        expect(text).toContain('[[Task one]]');           // explicit rec: id resolved to the record
        expect(text).toContain('[[Hidden name]]');        // hidden page invisible -> resolved to the readable RECORD t3
        expect(write.json.warnings ?? []).toContainEqual(expect.stringMatching(/ambiguous page "Twin"/));
        const blocks = page.json.blocks.map((b: { text: string }) => b.text).join(' ');
        expect(blocks).toContain('@[page:alpha]'); expect(blocks).toContain('@[page:both-page]'); expect(blocks).toContain('@[rec:t3]');
        expect(blocks).not.toContain('@[page:hidden]');
        const alice = await measure('alice', 'create_page', { title: 'Alice writer', markdown: '[[Hidden name]]', parentId: 'probe' });
        const alicePage = await measure('alice', 'get_page', { pageId: alice.json.id });
        expect(alicePage.json.blocks[0].text).toBe('@[page:hidden]');   // a reader of the page gets the page (page-first)
        const probe = await measure('bob', 'get_page', { pageId: 'probe' });
        expect(probe.json.markdown).toContain('[[Alpha]]'); expect(probe.json.markdown).not.toContain('Hidden name');
        expect(probe.json.backlinks.length).toBeGreaterThan(0);
      }
      await fx!.dispose(); fx = undefined;
    }
    for (const [name, small] of Object.entries(evidence['600'])) {
      if (FLAT.has(name.split(':')[0]) || name === 'create_page_mentions' || name === 'create_from_template') expect(evidence['4800'][name], `${name} grows with the workspace`).toBe(small);
    }
    const dir = process.env.CERT_ARTIFACT_DIR ?? '.artifacts/phase5-reads';
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/phase5-reads-scale.json`, JSON.stringify({ budget: 45, sizes: { '600': 'records per bulk collection', '4800': 'records per bulk collection' }, bindingCalls: evidence }, null, 2));
  }, 600_000);
});
