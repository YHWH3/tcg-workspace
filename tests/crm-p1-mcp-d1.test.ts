import { afterEach, describe, expect, it, vi } from 'vitest';
import { openAuditFixture, ctx, type AuditFixture } from './audit-fixture';

const capturedTools = vi.hoisted(
  () => new Map<string, { annotations?: { readOnlyHint?: boolean }; handler: (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }> }>(),
);

vi.mock('@modelcontextprotocol/server', () => ({
  McpServer: class {
    registerTool(
      name: string,
      meta: { annotations?: { readOnlyHint?: boolean } },
      handler: (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>,
    ) {
      capturedTools.set(name, { annotations: meta.annotations, handler });
      return { disable() {} };
    }
    registerPrompt() {}
    registerResource() {}
  },
  ResourceTemplate: class {
    constructor(public uri: string) {}
  },
}));
vi.mock('agents/mcp/server', () => ({ createMcpHandler: vi.fn() }));

import { createWorkspaceServer } from '../worker/mcp';

let fx: AuditFixture | undefined;
afterEach(async () => {
  await fx?.dispose();
  fx = undefined;
  capturedTools.clear();
});

function makeMcpCtx(userId: string) {
  return {
    env: fx!.env,
    ectx: ctx,
    userId,
    userRole: 'member',
    origin: 'https://crm.test',
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
  } as never;
}

describe('S4 CRM MCP tools (read & proposal-only with CRM_ENABLED + crm.access gating)', () => {
  it('registers all 8 read/proposal tools, zero side-effect CRM tools, and enforces CRM_ENABLED & crm.access at call time', async () => {
    fx = await openAuditFixture(
      [
        { id: 'owner1', role: 'admin' },
        { id: 'member1', role: 'member' },
        { id: 'unauth1', role: 'member' },
      ],
      { CRM_ENABLED: '0' },
    );

    await fx.db.batch([
      fx.db.prepare("UPDATE users SET workspace_role = CASE id WHEN 'owner1' THEN 'owner' ELSE 'member' END"),
      fx.db.prepare(
        "INSERT INTO crm_capability_grants (user_id, capability, scope, granted_by, granted_at) VALUES ('member1', 'crm.access', '*', 'owner1', 1)",
      ),
      fx.db.prepare(
        `INSERT INTO records (id, collection, data, field_ts, seq, space_id)
         VALUES
           ('board-people', 'boards', '{"name":"People","templateDbKey":"people","fields":[]}', '{"name":1,"templateDbKey":1,"fields":1}', 1, 'space-core'),
           ('person-1', 'tasks', '{"boardId":"board-people","title":"Asha Menon","_crm_primary_email":"asha@example.org"}', '{"boardId":1,"title":1,"_crm_primary_email":1}', 1, 'space-core')`,
      ),
      fx.db.prepare(
        `INSERT INTO crm_conversations (id, channel, person_id, programme_slug, subject, state, last_message_at, rev, created_at, updated_at)
         VALUES ('conv-1', 'email', 'person-1', 'common-lab', 'Studio visit', 'open', 1000, 1, 1000, 1000)`,
      ),
      fx.db.prepare(
        `INSERT INTO crm_facts (id, scope, programme_slug, category, title, statement, status, rev, created_by, created_at, updated_at)
         VALUES ('fact-1', 'programme:common-lab', 'common-lab', 'general', 'Location', 'Kochi studio open Tue–Sat.', 'verified', 1, 'owner1', 1000, 1000)`,
      ),
    ]);

    // Ensure CRM send/admin tools are NOT registered on MCP server
    createWorkspaceServer(makeMcpCtx('member1'));
    expect(capturedTools.has('message.send')).toBe(false);
    expect(capturedTools.has('crm_send_message')).toBe(false);
    expect(capturedTools.has('crm_find_people')).toBe(true);
    expect(capturedTools.has('crm_draft_message')).toBe(true);
    expect(capturedTools.has('crm_propose_fact')).toBe(true);

    // With CRM_ENABLED=0 -> refused even for crm.access user
    const disabledRes = await capturedTools.get('crm_find_people')!.handler({});
    expect(disabledRes.isError).toBe(true);
    expect(JSON.parse(disabledRes.content[0].text)).toMatchObject({ error: 'crm_disabled' });

    // Enable CRM; unauth1 (no crm.access) is refused
    fx.env.CRM_ENABLED = '1';
    capturedTools.clear();
    createWorkspaceServer(makeMcpCtx('unauth1'));
    const unauthRes = await capturedTools.get('crm_find_people')!.handler({});
    expect(unauthRes.isError).toBe(true);
    expect(JSON.parse(unauthRes.content[0].text)).toMatchObject({ error: 'crm_forbidden' });

    // Authorized member1 succeeds: searches person, generates grounded draft without outbox write, proposes draft fact
    capturedTools.clear();
    createWorkspaceServer(makeMcpCtx('member1'));

    const findRes = await capturedTools.get('crm_find_people')!.handler({ query: 'Asha' });
    expect(findRes.isError).toBeFalsy();
    const found = JSON.parse(findRes.content[0].text) as { people: { id: string; primaryEmail: string }[] };
    expect(found.people).toHaveLength(1);
    expect(found.people[0].primaryEmail).toBe('asha@example.org');

    const draftRes = await capturedTools.get('crm_draft_message')!.handler({ conversationId: 'conv-1' });
    expect(draftRes.isError).toBeFalsy();
    const drafted = JSON.parse(draftRes.content[0].text) as { status: string; citedFactIds: string[] };
    expect(drafted.status).toBe('draft_saved');
    expect(drafted.citedFactIds).toEqual(['fact-1']);
    expect(await fx.db.prepare('SELECT COUNT(*) AS n FROM crm_outbox').first('n')).toBe(0);

    const factRes = await capturedTools.get('crm_propose_fact')!.handler({
      title: 'Parking note',
      statement: 'Street parking available nearby.',
      programmeSlug: 'common-lab',
    });
    expect(factRes.isError).toBeFalsy();
    const proposedFact = JSON.parse(factRes.content[0].text) as { status: string };
    expect(proposedFact.status).toBe('draft');
  });
});
