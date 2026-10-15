// Cross-phase audit regressions — MCP soft-delete / restore (Phase 0 §8 trash
// semantics × Phase 4 INT-01 immediate byte reclamation). A soft delete must be
// reversible: restoring a record brings back what its deletion took down, and
// no soft delete may destroy attachment bytes (reclamation belongs to explicit
// attachment deletion / purge, not to hiding a parent).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyChanges } from '../worker/sync';
import { getRec } from '../worker/records';
import { openAuditFixture, type AuditFixture } from './audit-fixture';

const tools = vi.hoisted(() => new Map<string, (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>>());
vi.mock('@modelcontextprotocol/server', () => ({ McpServer: class { registerTool(name: string, _meta: unknown, fn: never) { tools.set(name, fn); } registerPrompt() {} } }));
vi.mock('agents/mcp/server', () => ({ createMcpHandler: vi.fn() }));
vi.mock('../worker/events', async (original) => ({ ...(await original<typeof import('../worker/events')>()), scheduleOutbox: vi.fn() }));
import { createWorkspaceServer } from '../worker/mcp';

let fx: AuditFixture;
function context() {
  return { env: fx.env, ectx: { waitUntil: () => {} } as unknown as ExecutionContext, userId: 'alice', userRole: 'admin', origin: 'http://localhost', userByKey: new Map(), userNameById: new Map(), pageTitleById: new Map(), recordTitleById: new Map(), recordIdByTitle: new Map(), pageIdByTitle: new Map(), cachesReady: false, warnings: [], cs: null, toolName: '' } as Parameters<typeof createWorkspaceServer>[0];
}
async function call(name: string, args: Record<string, unknown>) {
  createWorkspaceServer(context());
  const res = await tools.get(name)!(args);
  return { ...JSON.parse(res.content[0].text), isError: res.isError } as Record<string, unknown> & { isError?: boolean };
}
const rev = async (id: string) => (await getRec(fx.env, id))!.rev;
const flag = async (id: string) => (await getRec(fx.env, id))!.data.deleted === true;
async function chunkCount(fileId: string) {
  return (await fx.db.prepare('SELECT COUNT(*) n FROM file_chunks WHERE file_id=?').bind(fileId).first<{ n: number }>())!.n;
}

beforeEach(async () => {
  fx = await openAuditFixture([{ id: 'alice', role: 'admin' }]);
  // A stored attachment: bytes + metadata record + owning task.
  await fx.db.prepare("INSERT INTO files(id,mime,size,chunks,uploaded_by,created_at,complete) VALUES('att','image/png',4,1,'alice',1,1)").run();
  await fx.db.prepare("INSERT INTO file_chunks(file_id,idx,data) VALUES('att',0,X'89504e47')").run();
  await applyChanges(fx.env, 'alice', [
    { id: 'b', collection: 'boards', patch: { name: 'B', columns: [{ id: 'todo' }, { id: 'done' }], fields: [] }, ts: 1 },
    { id: 't', collection: 'tasks', patch: { title: 'Task', boardId: 'b', status: 'todo' }, ts: 1 },
    { id: 'sub', collection: 'tasks', patch: { title: 'Sub', boardId: 'b', status: 'todo', parentId: 't' }, ts: 1 },
    { id: 'att', collection: 'files', patch: { name: 'a.png', mime: 'image/png', kind: 'image', parentType: 'task', parentId: 't', size: 4 }, ts: 1 },
    { id: 'c1', collection: 'comments', patch: { targetType: 'task', targetId: 't', body: 'hello', authorId: 'alice' }, ts: 1 },
    { id: 'p', collection: 'pages', patch: { title: 'Parent' }, ts: 1 },
    { id: 'child', collection: 'pages', patch: { title: 'Child', parentId: 'p' }, ts: 1 },
    { id: 'blk', collection: 'blocks', patch: { pageId: 'p', type: 'p', text: 'body', order: 'a0' }, ts: 1 },
    { id: 'cblk', collection: 'blocks', patch: { pageId: 'child', type: 'p', text: 'child body', order: 'a0' }, ts: 1 },
  ]);
});
afterEach(async () => { await fx.dispose(); });

describe('record soft delete is reversible', () => {
  it('deleting a task does not destroy its attachment bytes, and restoring brings back comments and sub-records', async () => {
    const del = await call('delete_item', { type: 'task', id: 't', expectedRev: await rev('t') });
    expect(del.isError, JSON.stringify(del)).not.toBe(true);
    expect(await flag('t')).toBe(true);
    // The bytes (and their metadata) must survive hiding the parent.
    expect(await chunkCount('att')).toBe(1);
    expect(await flag('att')).toBe(false);

    const back = await call('restore_item', { type: 'task', id: 't', expectedRev: await rev('t') });
    expect(back.isError, JSON.stringify(back)).not.toBe(true);
    expect(await flag('t')).toBe(false);
    expect(await flag('sub')).toBe(false);
    expect(await flag('c1')).toBe(false);
    expect(await chunkCount('att')).toBe(1);
  });

  it('restoring a page brings back the content and child pages its deletion hid', async () => {
    const del = await call('delete_item', { type: 'page', id: 'p', expectedRev: await rev('p') });
    expect(del.isError, JSON.stringify(del)).not.toBe(true);
    expect(await flag('p')).toBe(true);

    const back = await call('restore_item', { type: 'page', id: 'p', expectedRev: await rev('p') });
    expect(back.isError, JSON.stringify(back)).not.toBe(true);
    expect(await flag('p')).toBe(false);
    expect(await flag('blk')).toBe(false);
    expect(await flag('child')).toBe(false);
    expect(await flag('cblk')).toBe(false);
  });

  it('only what that delete took down comes back: an independently deleted child stays deleted', async () => {
    await call('delete_item', { type: 'page', id: 'child', expectedRev: await rev('child') });
    await call('delete_item', { type: 'page', id: 'p', expectedRev: await rev('p') });
    await call('restore_item', { type: 'page', id: 'p', expectedRev: await rev('p') });
    expect(await flag('p')).toBe(false);
    expect(await flag('blk')).toBe(false);
    expect(await flag('child')).toBe(true);
  });
});
