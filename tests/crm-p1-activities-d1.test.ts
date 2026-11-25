import { afterEach, describe, expect, it } from 'vitest';
import { CRM_AUTOMATION_RECIPES } from '../shared/crm/automationRecipes';
import { validateAutomation } from '../shared/automations';
import { crmApi } from '../worker/crm';
import { d1BudgetRemaining, withD1Budget } from '../worker/d1budget';
import { openAuditFixture, ctx, type AuditFixture } from './audit-fixture';
import { WEBSITE_INBOX_ID } from '../shared/websiteInbox';

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
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const inThreeDays = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);

  await fx.db.batch([
    fx.db.prepare("UPDATE users SET workspace_role = CASE id WHEN 'owner1' THEN 'owner' ELSE 'member' END"),
    fx.db.prepare(
      "INSERT INTO crm_capability_grants (user_id, capability, scope, granted_by, granted_at) VALUES ('member1', 'crm.access', '*', 'owner1', 1)",
    ),
    fx.db.prepare(
      `INSERT INTO records(id, collection, data, field_ts, seq, space_id, updated_at)
       VALUES
         ('board-people', 'boards', '{"name":"People","templateDbKey":"people","fields":[]}', '{"name":1,"templateDbKey":1,"fields":1}', 1, 'space-core', 100),
         ('board-apps', 'boards', '{"name":"Applications","templateDbKey":"applications","columns":[{"id":"received","name":"Received"},{"id":"in_review","name":"In review"}],"fields":[{"id":"f_reviewer","name":"Reviewer","type":"person"}]}', '{"name":1,"templateDbKey":1,"columns":1,"fields":1}', 1, 'space-core', 100),
         ('board-acts', 'boards', '{"name":"Activities","templateDbKey":"activities","columns":[{"id":"planned","name":"Planned"},{"id":"done","name":"Done"}],"fields":[{"id":"f_type","name":"Type","type":"select","options":[{"id":"follow_up","name":"Follow-up"}]},{"id":"f_due","name":"Due","type":"date"},{"id":"f_owner","name":"Owner","type":"person"}]}', '{"name":1,"templateDbKey":1,"columns":1,"fields":1}', 1, 'space-core', 100),
         ('person-a', 'tasks', '{"boardId":"board-people","title":"Meera Menon"}', '{"boardId":1,"title":1}', 1, 'space-core', 100),
         ('act-overdue', 'tasks', ?, '{"boardId":1,"title":1,"status":1,"p_f_when":1,"p_f_due":1}', 1, 'space-core', 200),
         ('act-today', 'tasks', ?, '{"boardId":1,"title":1,"status":1,"p_f_due":1}', 1, 'space-core', 300),
         ('act-week', 'tasks', ?, '{"boardId":1,"title":1,"status":1,"p_f_due":1}', 1, 'space-core', 400),
         ('act-done', 'tasks', ?, '{"boardId":1,"title":1,"status":1,"p_f_done":1,"p_f_due":1}', 1, 'space-core', 500),
         ('lk-act-p', 'links', '{"fromId":"act-overdue","toId":"person-a","kind":"relation","fieldId":"f_people"}', '{"fromId":1,"toId":1,"kind":1,"fieldId":1}', 1, 'space-core', 200)`,
    ).bind(
      JSON.stringify({ boardId: 'board-acts', title: 'Overdue call back', status: 'planned', p_f_when: `${yesterday}T09:00:00.000Z`, p_f_due: yesterday }),
      JSON.stringify({ boardId: 'board-acts', title: 'Today studio check-in', status: 'planned', p_f_due: today }),
      JSON.stringify({ boardId: 'board-acts', title: 'Later this week prep', status: 'planned', p_f_due: inThreeDays }),
      JSON.stringify({ boardId: 'board-acts', title: 'Completed visit', status: 'done', p_f_done: true, p_f_due: yesterday }),
    ),
  ]);
}

describe('S3 Activities, Home My Work & Automation Recipes', () => {
  it('validates all CRM automation recipes against Workspace shared/automations without errors', () => {
    const boardsById = new Map<string, Record<string, unknown>>([
      [WEBSITE_INBOX_ID, { id: WEBSITE_INBOX_ID, name: 'Website inbox', columns: [], fields: [] }],
      [
        'board-apps',
        {
          id: 'board-apps',
          name: 'Applications',
          columns: [{ id: 'received', name: 'Received' }, { id: 'in_review', name: 'In review' }],
          fields: [{ id: 'f_reviewer', name: 'Reviewer', type: 'person' }],
        },
      ],
      [
        'board-acts',
        {
          id: 'board-acts',
          name: 'Activities',
          columns: [{ id: 'planned', name: 'Planned' }, { id: 'done', name: 'Done' }],
          fields: [
            { id: 'f_type', name: 'Type', type: 'select', options: [{ id: 'follow_up', name: 'Follow-up' }] },
            { id: 'f_due', name: 'Due', type: 'date' },
            { id: 'f_owner', name: 'Owner', type: 'person' },
          ],
        },
      ],
    ]);

    for (const recipe of CRM_AUTOMATION_RECIPES) {
      const auto = recipe.build({
        applicationsBoardId: 'board-apps',
        activitiesBoardId: 'board-acts',
      });
      expect(auto).not.toBeNull();
      const errs = validateAutomation(auto!, { boardsById });
      expect(errs, `Recipe ${recipe.id} validation errors`).toEqual([]);
    }
  });

  it('buckets overdue/today/upcoming activities in /read/home and exposes activities on /read/timeline', async () => {
    await setup();
    const scoped = withD1Budget(fx!.env, 45);
    const homeRes = await crmApi.request('/read/home', { headers: fx!.auth('member1') }, scoped, ctx);
    expect(45 - d1BudgetRemaining(scoped.DB)).toBeLessThanOrEqual(45);
    expect(homeRes.status).toBe(200);
    const home = await homeRes.json() as {
      today: { kind: string; title: string }[];
      thisWeek: { kind: string; title: string }[];
      counts: { dueFollowUps: number };
    };
    expect(home.counts.dueFollowUps).toBe(2);
    expect(home.today.map((i) => i.title)).toContain('Overdue call back');
    expect(home.today.map((i) => i.title)).toContain('Today studio check-in');
    expect(home.today.map((i) => i.title)).not.toContain('Completed visit');
    expect(home.thisWeek.map((i) => i.title)).toContain('Later this week prep');

    const tlScoped = withD1Budget(fx!.env, 45);
    const tlRes = await crmApi.request('/read/timeline?subject=person-a', { headers: fx!.auth('member1') }, tlScoped, ctx);
    expect(45 - d1BudgetRemaining(tlScoped.DB)).toBeLessThanOrEqual(45);
    expect(tlRes.status).toBe(200);
    const tl = await tlRes.json() as { items: { kind: string; title: string }[] };
    expect(tl.items.some((e) => e.kind === 'activity' && e.title === 'Overdue call back')).toBe(true);
  });
});
