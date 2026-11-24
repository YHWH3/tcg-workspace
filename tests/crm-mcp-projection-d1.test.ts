import { afterEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(
  () => new Map<string, (a: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>>(),
);
vi.mock('@modelcontextprotocol/server', () => ({
  ResourceTemplate: class {},
  McpServer: class {
    registerResource() {}
    registerTool(n: string, _m: unknown, f: never) {
      handlers.set(n, f);
    }
    registerPrompt() {}
  },
}));
vi.mock('agents/mcp/server', () => ({ createMcpHandler: vi.fn() }));
vi.mock('../worker/events', async (o) => ({
  ...(await o<typeof import('../worker/events')>()),
  scheduleOutbox: vi.fn(),
}));

import { createWorkspaceServer } from '../worker/mcp';
import { applyChanges } from '../worker/sync';
import { withD1Budget } from '../worker/d1budget';
import { createReadGate } from '../worker/readAccess';
import type { ConnectorAuthority } from '../worker/connectorAccess';
import { openAuditFixture, ctx, type AuditFixture } from './audit-fixture';

let fx: AuditFixture | undefined;
afterEach(async () => {
  handlers.clear();
  await fx?.dispose();
  fx = undefined;
});

async function setup(permissionsEnabled: boolean) {
  fx = await openAuditFixture(
    [{ id: 'owner1', role: 'admin' }],
    { CRM_ENABLED: '1' },
  );
  await fx.db.batch([
    fx.db.prepare('UPDATE access_state SET enabled = ? WHERE id = 1').bind(permissionsEnabled ? 1 : 0),
    fx.db.prepare("UPDATE users SET workspace_role = 'owner' WHERE id = 'owner1'"),
    fx.db.prepare(
      `INSERT INTO records(id, collection, data, field_ts, seq, space_id)
       VALUES
         ('board-crm', 'boards', '{"name":"People","columns":[{"id":"todo","name":"To do","color":"gray"}],"fields":[{"id":"f_email","name":"Email","type":"text"}]}', '{"name":1,"columns":1,"fields":1}', 1, 'space-core'),
         ('task-crm-1', 'tasks', '{"title":"Ada","boardId":"board-crm","status":"todo","p_f_email":"ada@example.com","_crm_stage":"enrolled"}', '{"title":1,"boardId":1,"status":1,"p_f_email":1,"_crm_stage":1}', 2, 'space-core')`,
    ),
    fx.db.prepare(
      `INSERT INTO ai_connections(id, user_id, client_id, spaces_json, version, created_at, expires_at)
       VALUES ('conn-1', 'owner1', 'test-mcp', '["space-core"]', 1, ?, ?)`,
    ).bind(Date.now(), Date.now() + 86_400_000),
  ]);
}

function bootMcp(userId = 'owner1', connector?: ConnectorAuthority) {
  const env = withD1Budget({ ...fx!.env, ...(connector ? { CONNECTOR: connector } : {}) }, 45);
  env.READ_GATE = createReadGate(env.DB, userId, connector);
  createWorkspaceServer({
    env,
    ectx: ctx,
    userId,
    userRole: 'admin',
    origin: 'https://workspace.test',
    userByKey: new Map(),
    userNameById: new Map(),
    pageTitleById: new Map(),
    recordTitleById: new Map(),
    recordIdByTitle: new Map(),
    pageIdByTitle: new Map(),
    cachesReady: false,
    warnings: [],
    cs: null,
    toolName: '',
  } as never);
  return env;
}

describe.each([false, true])('SC-3 & SC-5 MCP projection protection & read access (permissions=%s)', (permissionsEnabled) => {
  it('never registers capability.grant or capability.revoke as MCP tools, allows query_records/get_record to read records with _crm_*, and blocks MCP writes to _crm_*', async () => {
    await setup(permissionsEnabled);
    const connector: ConnectorAuthority = {
      id: 'conn-1',
      version: 1,
    };
    const callMcp = async (tool: string, args: Record<string, unknown>) => {
      bootMcp('owner1', connector);
      return handlers.get(tool)!(args);
    };

    // SC-5: capability commands are NEVER registered as MCP tools
    bootMcp('owner1', connector);
    expect(handlers.has('capability.grant')).toBe(false);
    expect(handlers.has('capability.revoke')).toBe(false);
    expect(handlers.has('capability_grant')).toBe(false);
    expect(handlers.has('capability_revoke')).toBe(false);

    // MCP query_records and get_record continue to read records carrying _crm_* projections
    const qRaw = await callMcp('query_records', { databaseId: 'board-crm' });
    expect(qRaw.isError).not.toBe(true);
    const qOut = JSON.parse(qRaw.content[0]!.text) as { rows: { id: string; title: string }[] };
    expect(qOut.rows).toHaveLength(1);
    expect(qOut.rows[0]).toMatchObject({ id: 'task-crm-1', title: 'Ada' });

    const gRaw = await callMcp('get_record', { recordId: 'task-crm-1' });
    expect(gRaw.isError).not.toBe(true);
    expect(JSON.parse(gRaw.content[0]!.text)).toMatchObject({ record: { id: 'task-crm-1', title: 'Ada' } });

    // MCP update_records updates normal fields while preserving server-owned _crm_stage untouched
    const updRaw = await callMcp('update_records', {
      updates: [
        {
          recordId: 'task-crm-1',
          expectedRev: 2,
          title: 'Ada Lovelace',
          fields: { _crm_stage: 'tampered', Email: 'ada2@example.com' },
        },
      ],
    });
    expect(updRaw.isError).not.toBe(true);
    const afterUpd = JSON.parse(
      (await fx!.db.prepare("SELECT data FROM records WHERE id = 'task-crm-1'").first<string>('data'))!,
    ) as Record<string, unknown>;
    expect(afterUpd.title).toBe('Ada Lovelace');
    expect(afterUpd.p_f_email).toBe('ada2@example.com');
    expect(afterUpd._crm_stage).toBe('enrolled');

    // Direct MCP-connector applyChanges targeting _crm_* is rejected unconditionally in BOTH permission modes
    const freshEnv = bootMcp('owner1', connector);
    const directMcp = await applyChanges(
      freshEnv,
      'owner1',
      [{ id: 'task-crm-1', collection: 'tasks', patch: { _crm_stage: 'hijacked' }, ts: Date.now() }],
      { atomic: true, serverTs: true },
    );
    expect(directMcp.rejected).toBe(1);
    expect(directMcp.changed).toBe(0);
    expect(directMcp.rejectedItems).toEqual([
      { id: 'task-crm-1', collection: 'tasks', reason: 'protected_field' },
    ]);
    const stillIntact = JSON.parse(
      (await fx!.db.prepare("SELECT data FROM records WHERE id = 'task-crm-1'").first<string>('data'))!,
    ) as Record<string, unknown>;
    expect(stillIntact._crm_stage).toBe('enrolled');
  });
});
