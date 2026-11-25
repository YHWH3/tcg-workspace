import { afterEach, describe, expect, it } from 'vitest';
import { crmApi } from '../worker/crm';
import { d1BudgetRemaining, withD1Budget } from '../worker/d1budget';
import { openAuditFixture, ctx, type AuditFixture } from './audit-fixture';
import { WI_FIELD } from '../shared/websiteInbox';

let fx: AuditFixture | undefined;
afterEach(async () => {
  await fx?.dispose();
  fx = undefined;
});

async function setup() {
  fx = await openAuditFixture(
    [
      { id: 'owner1', role: 'admin' },
      { id: 'member1', role: 'member' },
    ],
    { CRM_ENABLED: '1' },
  );
  await fx.db.batch([
    fx.db.prepare("UPDATE users SET workspace_role = CASE id WHEN 'owner1' THEN 'owner' ELSE 'member' END"),
    fx.db.prepare(
      "INSERT INTO crm_capability_grants (user_id, capability, scope, granted_by, granted_at) VALUES ('member1', 'crm.access', '*', 'owner1', 1)",
    ),
    fx.db.prepare(
      `INSERT INTO records (id, collection, data, field_ts, seq, space_id, updated_at)
       VALUES
         ('board-opps', 'boards', '{"name":"Opportunities","templateDbKey":"opportunities","columns":[{"id":"proposal","name":"Proposal"}],"fields":[]}', '{"name":1,"templateDbKey":1,"columns":1,"fields":1}', 1, 'space-core', 100),
         ('board-projects', 'boards', '{"name":"Projects","templateDbKey":"projects","columns":[{"id":"planning","name":"Planning"}],"fields":[]}', '{"name":1,"templateDbKey":1,"columns":1,"fields":1}', 1, 'space-core', 100),
         ('board-people', 'boards', '{"name":"People","templateDbKey":"people","fields":[]}', '{"name":1,"templateDbKey":1,"fields":1}', 1, 'space-core', 100),
         ('person-p1', 'tasks', '{"boardId":"board-people","title":"Ananya Sen"}', '{"boardId":1,"title":1}', 1, 'space-core', 100),
         ('opp-1', 'tasks', '{"boardId":"board-opps","title":"Kochi Bamboo Residency Partnership","status":"proposal","p_f_pipeline":"partnership","p_f_amount":250000,"p_f_next_action":"Finalize studio allocation"}', '{"boardId":1,"title":1,"status":1,"p_f_pipeline":1,"p_f_amount":1,"p_f_next_action":1}', 2, 'space-core', 200),
         ('patron-sub-1', 'tasks', ?, ?, 3, 'space-core', 300),
         ('general-sub-1', 'tasks', ?, ?, 4, 'space-core', 310)`,
    ).bind(
      JSON.stringify({
        boardId: 'board-website-inbox',
        title: 'Ananya Sen — Founding Patron',
        [`p_${WI_FIELD.family}`]: 'patron',
        [`p_${WI_FIELD.email}`]: 'ananya@example.org',
        [`p_${WI_FIELD.tier}`]: 'founding',
        [`p_${WI_FIELD.stage}`]: 'approved',
        [`p_${WI_FIELD.edition}`]: '12/100',
        [`p_${WI_FIELD.event}`]: 'patron.approved',
      }),
      JSON.stringify({ boardId: 1, title: 1 }),
      JSON.stringify({
        boardId: 'board-website-inbox',
        title: 'General enquiry',
        [`p_${WI_FIELD.family}`]: 'contact',
      }),
      JSON.stringify({ boardId: 1, title: 1 }),
    ),
    fx.db.prepare(
      `INSERT INTO crm_endpoints (id, person_id, kind, value_raw, value_norm, is_primary, source, created_by, created_at, updated_at)
       VALUES ('ep-p1', 'person-p1', 'email', 'ananya@example.org', 'ananya@example.org', 1, 'manual', 'owner1', 100, 100)`,
    ),
  ]);
}

async function reqCrm(path: string, opts: { method?: string; actor?: string; body?: unknown } = {}) {
  const scoped = withD1Budget(fx!.env, 45);
  const res = await crmApi.request(
    path,
    {
      method: opts.method ?? 'GET',
      headers: fx!.auth(opts.actor ?? 'owner1'),
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    },
    scoped,
    ctx,
  );
  expect(45 - d1BudgetRemaining(scoped.DB)).toBeLessThanOrEqual(45);
  return res;
}

describe('S9 Pipelines & Read-Only Patrons', () => {
  it('idempotently hands off an opportunity to a Workspace Project with _crm_project_id projection & links', async () => {
    await setup();

    const first = await reqCrm('/commands/opportunity.handoff_project', {
      method: 'POST',
      actor: 'member1',
      body: {
        requestId: 's9_handoff_1',
        input: { opportunityId: 'opp-1', projectsBoardId: 'board-projects' },
      },
    });
    const firstJson = await first.json() as {
      ok: boolean;
      result: { opportunityId: string; projectId: string; already: boolean };
      projections: { recordId: string; rev: number }[];
    };
    expect(firstJson.ok).toBe(true);
    expect(firstJson.result.already).toBe(false);
    expect(firstJson.result.projectId).toMatch(/^proj_/);
    expect(firstJson.projections.some((p) => p.recordId === 'opp-1')).toBe(true);

    // Calling again under a new requestId reuses the handed-off project idempotently
    const second = await reqCrm('/commands/opportunity.handoff_project', {
      method: 'POST',
      actor: 'member1',
      body: {
        requestId: 's9_handoff_2',
        input: { opportunityId: 'opp-1', projectsBoardId: 'board-projects' },
      },
    });
    const secondJson = await second.json() as { result: { projectId: string; already: boolean } };
    expect(secondJson.result.already).toBe(true);
    expect(secondJson.result.projectId).toBe(firstJson.result.projectId);
  });

  it('serves strictly read-only Patron projections from board-website-inbox and rejects any patron command', async () => {
    await setup();

    const res = await reqCrm('/read/patrons', { actor: 'member1' });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      readOnly: boolean;
      items: { submissionId: string; personId: string | null; tier: string; edition: string }[];
      countsByTier: { founding: number };
    };
    expect(body.readOnly).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      submissionId: 'patron-sub-1',
      personId: 'person-p1',
      tier: 'founding',
      edition: '12/100',
    });
    expect(body.countsByTier.founding).toBe(1);

    // Zero Patron write commands in P1
    const writeAttempt = await reqCrm('/commands/patron.update', {
      method: 'POST',
      actor: 'owner1',
      body: { requestId: 's9_patron_no_write', input: {} },
    });
    expect(writeAttempt.status).toBe(404);
  });
});
