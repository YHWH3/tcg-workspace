import { afterEach, describe, expect, it, vi } from 'vitest';
import { admin } from '../worker/admin';
import { withD1Budget, d1BudgetRemaining } from '../worker/d1budget';
import { openAuditFixture, ctx, type AuditFixture } from './audit-fixture';
import { interceptD1Batches } from './d1WriteBoundary';

let fx: AuditFixture | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await fx?.dispose();
  fx = undefined;
});

async function setup(crmEnabled: string | undefined, permissionsEnabled = false) {
  const provider = {
    listUserGrants: vi.fn(async () => ({ items: [] })),
    revokeGrant: vi.fn(async () => {}),
  };
  fx = await openAuditFixture(
    [
      { id: 'owner1', role: 'admin' },
      { id: 'admin1', role: 'admin' },
      { id: 'member1', role: 'member' },
    ],
    {
      OAUTH_PROVIDER: provider as never,
      ...(crmEnabled !== undefined ? { CRM_ENABLED: crmEnabled } : {}),
    },
  );
  await fx.db.batch([
    fx.db.prepare('UPDATE access_state SET enabled = ? WHERE id = 1').bind(permissionsEnabled ? 1 : 0),
    fx.db.prepare(
      "UPDATE users SET workspace_role = CASE id WHEN 'owner1' THEN 'owner' WHEN 'admin1' THEN 'admin' ELSE 'member' END",
    ),
  ]);
}

async function seedGrants(userId: string, caps: string[]) {
  const now = Date.now();
  await fx!.db.batch(
    caps.map((cap) =>
      fx!.db
        .prepare(
          `INSERT INTO crm_capability_grants(user_id, capability, scope, granted_by, granted_at, reason)
           VALUES (?, ?, '*', 'owner1', ?, 'seed')`,
        )
        .bind(userId, cap, now),
    ),
  );
}

async function callAdmin(path: string, method = 'POST', actor = 'owner1', env = fx!.env) {
  const scoped = withD1Budget(env);
  const res = await admin.request(path, { method, headers: fx!.auth(actor) }, scoped, ctx);
  expect(45 - d1BudgetRemaining(scoped.DB)).toBeLessThanOrEqual(45);
  return res;
}

describe.each([
  { crmEnabled: undefined },
  { crmEnabled: '1' },
])('SC-7 disable-time CRM capability revocation (CRM_ENABLED=$crmEnabled)', ({ crmEnabled }) => {
  it('atomically revokes all CRM grants with ordered |-delimited audit rows, keeps them gone on re-enable, and handles repeated disable cycles', async () => {
    await setup(crmEnabled);
    await seedGrants('member1', ['crm.send:email', 'crm.access', 'crm.finance.read']);

    // Disable member1
    const res1 = await callAdmin('/users/member1/disable', 'POST', 'owner1');
    expect(res1.status).toBe(200);
    expect(await res1.json()).toMatchObject({ ok: true, disabled: true, already: false });

    const remainingGrants = await fx!.db
      .prepare("SELECT * FROM crm_capability_grants WHERE user_id = 'member1'")
      .all();
    expect(remainingGrants.results).toHaveLength(0);

    const audits1 = (
      await fx!.db
        .prepare(
          `SELECT actor_id, target_user_id, action, capability, scope, reason, request_id, before_json, after_json
           FROM crm_capability_audit WHERE target_user_id = 'member1' ORDER BY capability, scope`,
        )
        .all<{
          actor_id: string;
          target_user_id: string;
          action: string;
          capability: string;
          scope: string;
          reason: string;
          request_id: string;
          before_json: string;
          after_json: string;
        }>()
    ).results;
    expect(audits1).toHaveLength(3);
    expect(audits1.map((a) => a.capability)).toEqual([
      'crm.access',
      'crm.finance.read',
      'crm.send:email',
    ]);
    for (const a of audits1) {
      expect(a.actor_id).toBe('owner1');
      expect(a.action).toBe('revoke');
      expect(a.reason).toBe('account_disabled');
      expect(a.request_id).toMatch(/^disable\|[0-9a-f-]{36}\|crm\.[^|]+\|\*$/);
      expect(JSON.parse(a.before_json)).toMatchObject({ held: true, grantedBy: 'owner1' });
      expect(JSON.parse(a.after_json)).toEqual({ held: false });
    }

    // Calling disable again while already disabled is a no-op (zero extra audit rows)
    const repeatAlready = await callAdmin('/users/member1/disable', 'POST', 'owner1');
    expect(repeatAlready.status).toBe(200);
    expect(await repeatAlready.json()).toMatchObject({ ok: true, disabled: true, already: true });
    expect(
      await fx!.db.prepare("SELECT COUNT(*) n FROM crm_capability_audit WHERE target_user_id = 'member1'").first('n'),
    ).toBe(3);

    // Re-enable restores ZERO CRM grants
    const enRes = await callAdmin('/users/member1/enable', 'POST', 'owner1');
    expect(enRes.status).toBe(200);
    expect(
      await fx!.db.prepare("SELECT COUNT(*) n FROM crm_capability_grants WHERE user_id = 'member1'").first('n'),
    ).toBe(0);

    // Re-grant and disable a second time: fresh UUID in request_id prevents UNIQUE collision
    await seedGrants('member1', ['crm.access']);
    const res2 = await callAdmin('/users/member1/disable', 'POST', 'owner1');
    expect(res2.status).toBe(200);
    expect(
      await fx!.db.prepare("SELECT COUNT(*) n FROM crm_capability_grants WHERE user_id = 'member1'").first('n'),
    ).toBe(0);
    expect(
      await fx!.db.prepare("SELECT COUNT(*) n FROM crm_capability_audit WHERE target_user_id = 'member1'").first('n'),
    ).toBe(4);
  });

  it('leaves grants and audit rows untouched when the disable batch aborts via fence', async () => {
    await setup(crmEnabled);
    await seedGrants('member1', ['crm.access', 'crm.finance.read']);

    let raced = false;
    const raw = fx!.db;
    const db = interceptD1Batches(raw, async (target, stmts, sql) => {
      if (!raced && sql.some((s) => /UPDATE users SET disabled_at/.test(s))) {
        raced = true;
        // Demote acting admin before disable batch executes -> actor fence aborts batch
        await raw.prepare("UPDATE users SET workspace_role = 'member' WHERE id = 'admin1'").run();
      }
      return target.batch(stmts);
    });

    const res = await callAdmin('/users/member1/disable', 'POST', 'admin1', { ...fx!.env, DB: db });
    expect(res.status).toBe(409);

    expect(await raw.prepare("SELECT disabled_at FROM users WHERE id = 'member1'").first('disabled_at')).toBeNull();
    expect(
      await raw.prepare("SELECT COUNT(*) n FROM crm_capability_grants WHERE user_id = 'member1'").first('n'),
    ).toBe(2);
    expect(
      await raw.prepare("SELECT COUNT(*) n FROM crm_capability_audit WHERE target_user_id = 'member1'").first('n'),
    ).toBe(0);
  });

  it('explicitly deletes CRM grants on DELETE /users/:id while preserving audit history', async () => {
    await setup(crmEnabled);
    await seedGrants('member1', ['crm.access']);
    await fx!.db
      .prepare(
        `INSERT INTO crm_capability_audit(id, actor_id, target_user_id, action, capability, scope, before_json, after_json, reason, request_id, created_at)
         VALUES ('audit-keep-1234', 'owner1', 'member1', 'grant', 'crm.access', '*', '{}', '{}', 'initial', 'req-keep-1234', ?)`,
      )
      .bind(Date.now())
      .run();

    const delRes = await callAdmin('/users/member1', 'DELETE', 'owner1');
    expect(delRes.status).toBe(200);
    expect(
      await fx!.db.prepare("SELECT COUNT(*) n FROM crm_capability_grants WHERE user_id = 'member1'").first('n'),
    ).toBe(0);
    expect(
      await fx!.db.prepare("SELECT COUNT(*) n FROM crm_capability_audit WHERE target_user_id = 'member1'").first('n'),
    ).toBe(1);
  });
});
