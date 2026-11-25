import { afterEach, describe, expect, it } from 'vitest';
import { crmApi } from '../worker/crm';
import { admin } from '../worker/admin';
import { applyChanges } from '../worker/sync';
import { withD1Budget, d1BudgetRemaining } from '../worker/d1budget';
import { openAuditFixture, ctx, type AuditFixture } from './audit-fixture';

let fx: AuditFixture | undefined;
afterEach(async () => {
  await fx?.dispose();
  fx = undefined;
});

async function setup() {
  fx = await openAuditFixture(
    [
      { id: 'owner1', role: 'admin' },
      { id: 'admin1', role: 'admin' },
      { id: 'member1', role: 'member' },
      { id: 'guest1', role: 'member' },
    ],
    { CRM_ENABLED: '1' },
  );
  await fx.db.batch([
    fx.db.prepare(
      `UPDATE users SET workspace_role = CASE id
         WHEN 'owner1' THEN 'owner'
         WHEN 'admin1' THEN 'admin'
         WHEN 'member1' THEN 'member'
         ELSE 'guest'
       END`,
    ),
    fx.db.prepare(
      `INSERT INTO records(id, collection, data, field_ts, seq, space_id)
       VALUES
         ('board-people', 'boards', '{"name":"People","templateDbKey":"people","fields":[{"id":"f_email","name":"Email","type":"text"},{"id":"f_phone","name":"Phone","type":"text"}]}', '{"name":1,"templateDbKey":1,"fields":1}', 1, 'space-core'),
         ('person-1', 'tasks', '{"boardId":"board-people","title":"Asha Menon","p_f_email":"  ASHA@example.org ","p_f_phone":"9847012345"}', '{"boardId":1,"title":1,"p_f_email":1,"p_f_phone":1}', 2, 'space-core'),
         ('person-2', 'tasks', '{"boardId":"board-people","title":"Asha Alternate","p_f_email":"asha@example.org","p_f_phone":"9847099999"}', '{"boardId":1,"title":1,"p_f_email":1,"p_f_phone":1}', 3, 'space-core')`,
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

describe('S1 identity backend: endpoints, consent, backfill, duplicates & owner-only rename', () => {
  it('enforces owner-only audited account renaming on PATCH /api/users/:id', async () => {
    await setup();

    // Non-owner admin gets 403 owner_only when trying to rename anyone
    const adminRename = await admin.request(
      '/users/member1',
      {
        method: 'PATCH',
        headers: fx!.auth('admin1'),
        body: JSON.stringify({ name: 'Should Fail' }),
      },
      withD1Budget(fx!.env, 45),
      ctx,
    );
    expect(adminRename.status).toBe(403);
    expect(await adminRename.json()).toEqual({ error: 'owner_only' });

    // Owner can rename any user (including member and owner) and logs user.rename audit row
    const ownerRename = await admin.request(
      '/users/member1',
      {
        method: 'PATCH',
        headers: fx!.auth('owner1'),
        body: JSON.stringify({ name: 'Meera Nair' }),
      },
      withD1Budget(fx!.env, 45),
      ctx,
    );
    expect(ownerRename.status).toBe(200);
    expect(await ownerRename.json()).toMatchObject({ ok: true, name: 'Meera Nair' });

    const userRow = await fx!.db.prepare('SELECT name FROM users WHERE id = ?').bind('member1').first<{ name: string }>();
    expect(userRow?.name).toBe('Meera Nair');

    const auditRow = await fx!.db
      .prepare("SELECT actor_id, target_user_id, action, after_json FROM access_audit WHERE action = 'user.rename'")
      .first<{ actor_id: string; target_user_id: string; action: string; after_json: string }>();
    expect(auditRow).toMatchObject({
      actor_id: 'owner1',
      target_user_id: 'member1',
      action: 'user.rename',
    });
    expect(JSON.parse(auditRow!.after_json)).toEqual({ name: 'Meera Nair' });

    // Invalid empty name returns 400 invalid_name
    const badName = await admin.request(
      '/users/member1',
      {
        method: 'PATCH',
        headers: fx!.auth('owner1'),
        body: JSON.stringify({ name: '   ' }),
      },
      withD1Budget(fx!.env, 45),
      ctx,
    );
    expect(badName.status).toBe(400);
    expect(await badName.json()).toEqual({ error: 'invalid_name' });
  });

  it('adds, enforces uniqueness, promotes primary, retires endpoints and records append-only consent with atomic _crm_* projections', async () => {
    await setup();

    // Grant crm.access to member1
    await fx!.db.prepare(
      `INSERT INTO crm_capability_grants(user_id, capability, scope, granted_by, granted_at)
       VALUES ('member1', 'crm.access', '*', 'owner1', 1000)`,
    ).run();

    // Direct client attempt to write _crm_primary_email is rejected unconditionally
    const spoofRes = await applyChanges(fx!.env, 'member1', [
      { id: 'person-1', collection: 'tasks', patch: { _crm_primary_email: 'spoof@example.org' }, ts: Date.now() },
    ]);
    expect(spoofRes.rejected).toBe(1);
    expect(spoofRes.rejectedItems?.[0]).toMatchObject({ id: 'person-1', reason: 'protected_field' });

    // Add first WhatsApp endpoint -> auto primary
    const addWa = await reqCrm('/commands/person.add_endpoint', {
      method: 'POST',
      actor: 'member1',
      body: { requestId: 'ep_add_0001', input: { personId: 'person-1', kind: 'whatsapp', value: '9847012345' } },
    });
    expect(addWa.status).toBe(200);
    const addWaJson = await addWa.json() as { ok: boolean; result: { endpoint: { id: string; valueNorm: string; isPrimary: boolean } } };
    expect(addWaJson.ok).toBe(true);
    expect(addWaJson.result.endpoint.valueNorm).toBe('+919847012345');
    expect(addWaJson.result.endpoint.isPrimary).toBe(true);

    // Same endpoint added on person-2 fails with endpoint_in_use
    const dupAdd = await reqCrm('/commands/person.add_endpoint', {
      method: 'POST',
      actor: 'member1',
      body: { requestId: 'ep_add_0002', input: { personId: 'person-2', kind: 'whatsapp', value: '+91 98470 12345' } },
    });
    expect(await dupAdd.json()).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'endpoint_in_use', conflictingPersonId: 'person-1' },
    });

    // Add two email endpoints and switch primary
    const e1 = await (await reqCrm('/commands/person.add_endpoint', {
      method: 'POST',
      actor: 'member1',
      body: { requestId: 'ep_add_0003', input: { personId: 'person-1', kind: 'email', value: 'first@example.org' } },
    })).json() as { ok: boolean; result: { endpoint: { id: string } } };
    const e2 = await (await reqCrm('/commands/person.add_endpoint', {
      method: 'POST',
      actor: 'member1',
      body: { requestId: 'ep_add_0004', input: { personId: 'person-1', kind: 'email', value: 'second@example.org', makePrimary: false } },
    })).json() as { ok: boolean; result: { endpoint: { id: string } } };
    expect(e1.ok && e2.ok).toBe(true);

    const setPri = await reqCrm('/commands/person.set_primary_endpoint', {
      method: 'POST',
      actor: 'member1',
      body: { requestId: 'ep_pri_0001', input: { endpointId: e2.result.endpoint.id } },
    });
    expect(await setPri.json()).toMatchObject({ ok: true });

    // Record consent -> append-only
    const conRes = await reqCrm('/commands/person.record_consent', {
      method: 'POST',
      actor: 'member1',
      body: {
        requestId: 'con_rec_0001',
        input: { personId: 'person-1', channel: 'whatsapp', scope: 'transactional', status: 'granted', source: 'manual' },
      },
    });
    expect(await conRes.json()).toMatchObject({ ok: true });

    // Verify triggers block UPDATE/DELETE on crm_consents
    await expect(fx!.db.prepare(`UPDATE crm_consents SET status = 'withdrawn'`).run()).rejects.toThrow(/append-only/i);

    // Check person record projections updated atomically
    const personRow = await fx!.db.prepare(`SELECT data FROM records WHERE id = 'person-1'`).first<{ data: string }>();
    const pData = JSON.parse(personRow!.data);
    expect(pData._crm_primary_email).toBe('second@example.org');
    expect(pData.p_f_email).toBe('second@example.org');
    expect(pData._crm_consent_summary).toContain('whatsapp:granted');

    // Retire second email -> promotes first@example.org back to primary
    await reqCrm('/commands/person.retire_endpoint', {
      method: 'POST',
      actor: 'member1',
      body: { requestId: 'ep_ret_0001', input: { endpointId: e2.result.endpoint.id } },
    });
    const detailRes = await reqCrm('/read/person/person-1', { actor: 'member1' });
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json() as { endpoints: { valueNorm: string; isPrimary: boolean; retiredAt: number | null }[]; latestConsents: unknown[] };
    const activeFirst = detail.endpoints.find((x) => x.valueNorm === 'first@example.org');
    expect(activeFirst?.isPrimary).toBe(true);
    expect(detail.latestConsents).toHaveLength(1);
  });

  it('supports bounded endpoint backfill dry-run and apply with duplicate candidate creation and dismiss', async () => {
    await setup();

    // Non-configured user cannot run backfill
    await fx!.db.prepare(
      `INSERT INTO crm_capability_grants(user_id, capability, scope, granted_by, granted_at)
       VALUES ('member1', 'crm.access', '*', 'owner1', 1000)`,
    ).run();
    const denied = await (await reqCrm('/commands/endpoints.backfill', {
      method: 'POST',
      actor: 'member1',
      body: { requestId: 'bf_denied_01', input: { dryRun: true } },
    })).json();
    expect(denied).toMatchObject({ ok: false, error: 'forbidden' });

    // Dry-run by owner reports what would be created + conflict between person-1 and person-2 without writing
    const dryRes = await (await reqCrm('/commands/endpoints.backfill', {
      method: 'POST',
      actor: 'owner1',
      body: { requestId: 'bf_dry_0001', input: { dryRun: true } },
    })).json() as { ok: boolean; result: { dryRun: boolean; scanned: number; wouldCreate: number; conflicts: unknown[]; created: number } };
    expect(dryRes.ok).toBe(true);
    expect(dryRes.result.dryRun).toBe(true);
    expect(dryRes.result.scanned).toBe(2);
    expect(dryRes.result.created).toBe(0);
    expect(dryRes.result.wouldCreate).toBe(3);
    expect(dryRes.result.conflicts).toHaveLength(1);
    expect(await fx!.db.prepare('SELECT COUNT(*) n FROM crm_endpoints').first('n')).toBe(0);

    // Apply backfill creates non-conflicting endpoints and queues duplicate candidate
    const applyRes = await (await reqCrm('/commands/endpoints.backfill', {
      method: 'POST',
      actor: 'owner1',
      body: { requestId: 'bf_app_0001', input: { dryRun: false } },
    })).json() as { ok: boolean; result: { created: number; candidatesCreated: number } };
    expect(applyRes.ok).toBe(true);
    expect(applyRes.result.created).toBe(3);
    expect(applyRes.result.candidatesCreated).toBe(1);

    const dupsRes = await (await reqCrm('/read/duplicates?state=open', { actor: 'member1' })).json() as { items: { id: string; personAId: string; personBId: string; state: string }[] };
    expect(dupsRes.items).toHaveLength(1);
    expect(dupsRes.items[0]).toMatchObject({ personAId: 'person-1', personBId: 'person-2', state: 'open' });

    // Dismiss candidate
    const disRes = await (await reqCrm('/commands/duplicates.dismiss', {
      method: 'POST',
      actor: 'member1',
      body: { requestId: 'dup_dis_0001', input: { candidateId: dupsRes.items[0]!.id, note: 'Different family members' } },
    })).json();
    expect(disRes).toMatchObject({ ok: true, result: { state: 'dismissed' } });

    const openAfter = await (await reqCrm('/read/duplicates?state=open', { actor: 'member1' })).json() as { items: unknown[] };
    expect(openAfter.items).toHaveLength(0);
  });
});
