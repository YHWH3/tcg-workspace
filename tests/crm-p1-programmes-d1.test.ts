import { afterEach, describe, expect, it } from 'vitest';
import { crmApi } from '../worker/crm';
import { d1BudgetRemaining, withD1Budget } from '../worker/d1budget';
import { openAuditFixture, ctx, type AuditFixture } from './audit-fixture';
import { CRM_PROGRAMME_BY_SLUG } from '../shared/crm/programmes';
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
      { id: 'member2', role: 'member' },
    ],
    { CRM_ENABLED: '1' },
  );
  await fx.db.batch([
    fx.db.prepare("UPDATE users SET workspace_role = CASE id WHEN 'owner1' THEN 'owner' ELSE 'member' END"),
    fx.db.prepare(
      `INSERT INTO crm_capability_grants (user_id, capability, scope, granted_by, granted_at)
       VALUES
         ('member1', 'crm.access', '*', 'owner1', 1),
         ('member1', 'crm.configure', 'programme:common-lab', 'owner1', 1),
         ('member2', 'crm.access', '*', 'owner1', 1)`,
    ),
    fx.db.prepare(
      `INSERT INTO records(id, collection, data, field_ts, seq, space_id)
       VALUES
         ('board-programs', 'boards', '{"name":"Programs","templateDbKey":"programs","fields":[{"id":"f_slug","name":"Slug","type":"text"}]}', '{"name":1,"templateDbKey":1,"fields":1}', 1, 'space-core'),
         ('board-apps', 'boards', '{"name":"Applications","templateDbKey":"applications","columns":[{"id":"received","name":"Received","color":"#e5a000"},{"id":"converted","name":"Converted","color":"#12a594"}],"fields":[]}', '{"name":1,"templateDbKey":1,"columns":1,"fields":1}', 1, 'space-core'),
         ('board-projects', 'boards', '{"name":"Projects","templateDbKey":"projects","columns":[{"id":"planning","name":"Planning","color":"#0091ff"}],"fields":[]}', '{"name":1,"templateDbKey":1,"columns":1,"fields":1}', 1, 'space-core'),
         ('board-website-inbox', 'boards', '{"name":"Website inbox","columns":[{"id":"new","name":"New","color":"#e5a000"}],"fields":[]}', '{"name":1,"columns":1,"fields":1}', 1, 'space-core'),
         ('board-people', 'boards', '{"name":"People","templateDbKey":"people","fields":[]}', '{"name":1,"templateDbKey":1,"fields":1}', 1, 'space-core'),
         ('prog-lab', 'tasks', '{"boardId":"board-programs","title":"Common Lab","p_f_slug":"common-lab"}', '{"boardId":1,"title":1,"p_f_slug":1}', 1, 'space-core'),
         ('person-sub-1', 'tasks', '{"boardId":"board-people","title":"Karthik Rao"}', '{"boardId":1,"title":1}', 1, 'space-core'),
         ('sub-1', 'tasks', ?, ?, 2, 'space-core')`,
    ).bind(
      JSON.stringify({
        boardId: 'board-website-inbox',
        title: 'Karthik Rao — Common Lab inquiry',
        [`p_${WI_FIELD.family}`]: 'lab',
        [`p_${WI_FIELD.email}`]: 'karthik@example.org',
        createdAt: 1700000000000,
      }),
      JSON.stringify({
        boardId: 1,
        title: 1,
        [`p_${WI_FIELD.family}`]: 1,
        [`p_${WI_FIELD.email}`]: 1,
        createdAt: 1,
      }),
    ),
    fx.db.prepare(
      `INSERT INTO crm_endpoints (id, person_id, kind, value_raw, value_norm, is_primary, source, created_by, created_at, updated_at)
       VALUES ('ep-sub-1', 'person-sub-1', 'email', 'karthik@example.org', 'karthik@example.org', 1, 'manual', 'owner1', 1000, 1000)`,
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

describe('S2 Programmes, Enquiries, Applications & Timeline backend', () => {
  it('enforces scoped crm.configure and neutral defaults on programme.update_profile & /read/programmes', async () => {
    await setup();

    // Initial GET returns all 14 programmes with null unconfigured policies
    const listRes = await reqCrm('/read/programmes', { actor: 'member1' });
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json() as { programmes: { slug: string; canConfigure: boolean; profile: { responseTargetDays: number | null; policies: { feeSummary: string | null } } }[] };
    expect(listJson.programmes).toHaveLength(14);
    const lab = listJson.programmes.find((p) => p.slug === 'common-lab')!;
    const habitat = listJson.programmes.find((p) => p.slug === 'parambu-habitat')!;
    expect(lab.canConfigure).toBe(true);
    expect(habitat.canConfigure).toBe(false);
    expect(lab.profile.responseTargetDays).toBeNull();
    expect(lab.profile.policies.feeSummary).toBeNull();

    // member1 CANNOT configure parambu-habitat (scoped only to common-lab)
    const deniedUpdate = await reqCrm('/commands/programme.update_profile', {
      method: 'POST',
      actor: 'member1',
      body: {
        requestId: 's2_prog_deny_01',
        input: { slug: 'parambu-habitat', profile: CRM_PROGRAMME_BY_SLUG.get('parambu-habitat')!.defaultProfile },
      },
    });
    expect(await deniedUpdate.json()).toMatchObject({ ok: false, error: 'forbidden' });

    // member1 CAN configure common-lab + projects onto prog-lab
    const baseProfile = CRM_PROGRAMME_BY_SLUG.get('common-lab')!.defaultProfile;
    const okUpdate = await reqCrm('/commands/programme.update_profile', {
      method: 'POST',
      actor: 'member1',
      body: {
        requestId: 's2_prog_ok_01',
        input: {
          slug: 'common-lab',
          programmeRecordId: 'prog-lab',
          profile: {
            ...baseProfile,
            responseTargetDays: 7,
            policies: { ...baseProfile.policies, eligibilityCriteria: 'Open to community practitioners' },
          },
        },
      },
    });
    expect(okUpdate.status).toBe(200);
    const okJson = await okUpdate.json() as { ok: boolean; result: { programme: { rev: number; profile: { responseTargetDays: number } } }; projections: { recordId: string }[] };
    expect(okJson.ok).toBe(true);
    expect(okJson.result.programme.rev).toBe(1);
    expect(okJson.result.programme.profile.responseTargetDays).toBe(7);
    expect(okJson.projections).toEqual([{ recordId: 'prog-lab', rev: 3 }]);
  });

  it('creates application from immutable website submission, converts to Project, and paginates unified timeline', async () => {
    await setup();

    const subBefore = await fx!.db.prepare("SELECT data, seq FROM records WHERE id = 'sub-1'").first<{ data: string; seq: number }>();

    // Create application from sub-1
    const appRes = await reqCrm('/commands/application.create_from_submission', {
      method: 'POST',
      actor: 'member2',
      body: {
        requestId: 's2_app_create_01',
        input: { submissionId: 'sub-1' },
      },
    });
    expect(appRes.status).toBe(200);
    const appJson = await appRes.json() as { ok: boolean; result: { applicationId: string; personId: string | null; programmeSlug: string | null; already: boolean } };
    expect(appJson.ok).toBe(true);
    expect(appJson.result.already).toBe(false);
    expect(appJson.result.personId).toBe('person-sub-1');
    expect(appJson.result.programmeSlug).toBe('common-lab');

    // Source website submission remains completely untouched!
    const subAfter = await fx!.db.prepare("SELECT data, seq FROM records WHERE id = 'sub-1'").first<{ data: string; seq: number }>();
    expect(subAfter!.data).toBe(subBefore!.data);
    expect(subAfter!.seq).toBe(subBefore!.seq);

    // Idempotent second call returns existing applicationId
    const replayApp = await reqCrm('/commands/application.create_from_submission', {
      method: 'POST',
      actor: 'member2',
      body: {
        requestId: 's2_app_create_02',
        input: { submissionId: 'sub-1' },
      },
    });
    const replayJson = await replayApp.json() as { result: { applicationId: string; already: boolean } };
    expect(replayJson.result.already).toBe(true);
    expect(replayJson.result.applicationId).toBe(appJson.result.applicationId);

    // Convert application -> Project
    const convRes = await reqCrm('/commands/application.convert', {
      method: 'POST',
      actor: 'member2',
      body: {
        requestId: 's2_app_conv_01',
        input: {
          applicationId: appJson.result.applicationId,
          targetKind: 'project',
          targetBoardId: 'board-projects',
          title: 'Common Lab Bamboo Cohort',
        },
      },
    });
    const convJson = await convRes.json() as { ok: boolean; result: { convertedRecordId: string; targetKind: string } };
    expect(convJson.ok).toBe(true);
    expect(convJson.result.targetKind).toBe('project');

    const appRow = await fx!.db.prepare('SELECT data FROM records WHERE id = ?').bind(appJson.result.applicationId).first<{ data: string }>();
    const appData = JSON.parse(appRow!.data) as Record<string, unknown>;
    expect(appData.status).toBe('converted');
    expect(appData._crm_converted_record_id).toBe(convJson.result.convertedRecordId);

    // Unified timeline for person-sub-1 and application
    const tlRes = await reqCrm(`/read/timeline?subject=${encodeURIComponent(appJson.result.applicationId)}&limit=1`, { actor: 'member2' });
    expect(tlRes.status).toBe(200);
    const tlJson = await tlRes.json() as { items: { kind: string }[]; next: string | null };
    expect(tlJson.items.length).toBe(1);
    expect(tlJson.next).toBeTruthy();

    const tlPage2 = await reqCrm(`/read/timeline?subject=${encodeURIComponent(appJson.result.applicationId)}&limit=10&cursor=${encodeURIComponent(tlJson.next!)}`, { actor: 'member2' });
    expect(tlPage2.status).toBe(200);

    // Home My Work summary
    const homeRes = await reqCrm('/read/home', { actor: 'member2' });
    expect(homeRes.status).toBe(200);
    const homeJson = await homeRes.json() as { counts: Record<string, number>; recently: unknown[] };
    expect(homeJson.recently.length).toBeGreaterThan(0);
  });
});
