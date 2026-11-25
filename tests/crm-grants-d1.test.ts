import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CapabilityChangeResultSchema,
  CommandErrorSchema,
} from '../shared/crm/contracts';
import { createCommandRegistry, runCommand } from '../worker/crm/commands';
import { createCapabilityCommandDefs, readCapabilitiesOverview, readCrmStatus } from '../worker/crm/grants';
import { withD1Budget, d1BudgetRemaining } from '../worker/d1budget';
import { openAuditFixture, ctx, type AuditFixture } from './audit-fixture';
import { interceptD1Batches } from './d1WriteBoundary';

let fx: AuditFixture | undefined;
let pokeSpy: ReturnType<typeof vi.fn>;
afterEach(async () => {
  vi.restoreAllMocks();
  await fx?.dispose();
  fx = undefined;
});

async function setup(permissionsEnabled: boolean) {
  pokeSpy = vi.fn();
  const liveStub = { poke: pokeSpy };
  const LIVE = {
    idFromName: () => 'workspace-id',
    get: () => liveStub,
  } as unknown as DurableObjectNamespace;

  fx = await openAuditFixture(
    [
      { id: 'owner1', role: 'admin' },
      { id: 'admin1', role: 'admin' },
      { id: 'admin2', role: 'admin' },
      { id: 'member1', role: 'member' },
      { id: 'guest1', role: 'member' },
      { id: 'disabled1', role: 'member' },
    ],
    { CRM_ENABLED: '1', LIVE },
  );

  await fx.db.batch([
    fx.db.prepare('UPDATE access_state SET enabled = ? WHERE id = 1').bind(permissionsEnabled ? 1 : 0),
    fx.db.prepare(
      `UPDATE users SET workspace_role = CASE id
         WHEN 'owner1' THEN 'owner'
         WHEN 'admin1' THEN 'admin'
         WHEN 'admin2' THEN 'admin'
         WHEN 'guest1' THEN 'guest'
         ELSE 'member'
       END`,
    ),
    fx.db.prepare("UPDATE users SET disabled_at = 1000 WHERE id = 'disabled1'"),
  ]);
}

async function tokenHashFor(userId: string): Promise<string> {
  const row = await fx!.db
    .prepare('SELECT token_hash FROM sessions WHERE user_id = ? LIMIT 1')
    .bind(userId)
    .first<{ token_hash: string }>();
  return row!.token_hash;
}

async function exec(
  actorId: string,
  name: 'capability.grant' | 'capability.revoke',
  requestId: string,
  input: Record<string, unknown>,
  env = fx!.env,
) {
  const scoped = withD1Budget(env, 45);
  const res = await runCommand({
    env: scoped,
    executionCtx: ctx,
    actorId,
    tokenHash: await tokenHashFor(actorId),
    via: 'ui',
    name,
    envelope: { requestId, input },
    registry: createCommandRegistry(createCapabilityCommandDefs()),
  });
  expect(45 - d1BudgetRemaining(scoped.DB)).toBeLessThanOrEqual(45);
  return res;
}

describe.each([false, true])('SC-2 & SC-5 capability.grant / capability.revoke (permissions=%s)', (permissionsEnabled) => {
  it('enforces the complete 15-step precedence, crm.access non-cascading gate, dormant revoke, pokeLive, and append-only audit triggers', async () => {
    await setup(permissionsEnabled);

    // Step 2: admin1 without crm.access/manage gets forbidden BEFORE input validation (even with unknown_capability!)
    const unauthAdmin = await exec('admin1', 'capability.grant', 'req_step2_001', {
      userId: 'member1',
      capability: 'crm.nonexistent',
      scope: 'bad',
    });
    expect(CommandErrorSchema.parse(unauthAdmin.body)).toMatchObject({ ok: false, error: 'forbidden' });

    // Owner grants admin1 crm.capabilities.manage WITHOUT crm.access -> still forbidden (CR-03)!
    const grantManageOnly = await exec('owner1', 'capability.grant', 'req_mgr_only1', {
      userId: 'admin1',
      capability: 'crm.capabilities.manage',
      scope: '*',
      reason: 'delegated manager',
    });
    expect(CapabilityChangeResultSchema.parse(grantManageOnly.body)).toMatchObject({
      ok: true,
      result: { already: false, grant: { userId: 'admin1', capability: 'crm.capabilities.manage', held: true } },
    });
    expect(pokeSpy).toHaveBeenCalledTimes(1);

    const adminWithoutAccess = await exec('admin1', 'capability.grant', 'req_no_acc_01', {
      userId: 'member1',
      capability: 'crm.access',
      scope: '*',
    });
    expect(CommandErrorSchema.parse(adminWithoutAccess.body)).toMatchObject({ ok: false, error: 'forbidden' });

    // Owner grants admin1 crm.access -> now admin1 can manage non-manage capabilities
    const grantAdminAccess = await exec('owner1', 'capability.grant', 'req_adm_acc01', {
      userId: 'admin1',
      capability: 'crm.access',
      scope: '*',
    });
    expect(grantAdminAccess.body).toMatchObject({ ok: true, result: { already: false } });
    expect(pokeSpy).toHaveBeenCalledTimes(2);

    // Step 3: wire schema error
    const badWire = await exec('admin1', 'capability.grant', 'req_step3_001', {
      userId: 'member1',
      capability: 'crm.access',
      scope: '*',
      reason: 'x'.repeat(501),
    });
    expect(CommandErrorSchema.parse(badWire.body)).toMatchObject({ ok: false, error: 'invalid_input' });

    // Step 4: unknown_capability beats unknown_scope
    const badCap = await exec('admin1', 'capability.grant', 'req_step4_001', {
      userId: 'member1',
      capability: 'crm.fake',
      scope: 'prog-1',
    });
    expect(CommandErrorSchema.parse(badCap.body)).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'unknown_capability' },
    });

    // Step 5: unknown_scope
    const badScope = await exec('admin1', 'capability.grant', 'req_step5_001', {
      userId: 'member1',
      capability: 'crm.restricted.read',
      scope: 'prog-1',
    });
    expect(CommandErrorSchema.parse(badScope.body)).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'unknown_scope' },
    });

    // Step 6: non-owner touching crm.capabilities.manage -> forbidden BEFORE target lookup (even for nonexistent user!)
    const nonOwnerManage = await exec('admin1', 'capability.grant', 'req_step6_001', {
      userId: 'does-not-exist',
      capability: 'crm.capabilities.manage',
      scope: '*',
    });
    expect(CommandErrorSchema.parse(nonOwnerManage.body)).toMatchObject({ ok: false, error: 'forbidden' });

    // Step 8: missing target -> not_found
    const missing = await exec('admin1', 'capability.grant', 'req_step8_001', {
      userId: 'does-not-exist',
      capability: 'crm.access',
      scope: '*',
    });
    expect(CommandErrorSchema.parse(missing.body)).toMatchObject({ ok: false, error: 'not_found' });

    // Step 9: owner_implicit (beats self_grant when owner targets self)
    const ownerSelf = await exec('owner1', 'capability.grant', 'req_step9_001', {
      userId: 'owner1',
      capability: 'crm.access',
      scope: '*',
    });
    expect(CommandErrorSchema.parse(ownerSelf.body)).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'owner_implicit' },
    });

    // Step 10: self_grant
    const adminSelf = await exec('admin1', 'capability.grant', 'req_step10_01', {
      userId: 'admin1',
      capability: 'crm.finance.read',
      scope: '*',
    });
    expect(CommandErrorSchema.parse(adminSelf.body)).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'self_grant' },
    });

    // Step 11: guest_not_eligible
    const guestRes = await exec('owner1', 'capability.grant', 'req_step11_01', {
      userId: 'guest1',
      capability: 'crm.access',
      scope: '*',
    });
    expect(CommandErrorSchema.parse(guestRes.body)).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'guest_not_eligible' },
    });

    // Step 12: account_disabled on grant; revoke still allowed on disabled account
    const disGrant = await exec('owner1', 'capability.grant', 'req_step12_01', {
      userId: 'disabled1',
      capability: 'crm.access',
      scope: '*',
    });
    expect(CommandErrorSchema.parse(disGrant.body)).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'account_disabled' },
    });
    const disRevoke = await exec('owner1', 'capability.revoke', 'req_step12_02', {
      userId: 'disabled1',
      capability: 'crm.access',
      scope: '*',
    });
    expect(CapabilityChangeResultSchema.parse(disRevoke.body)).toMatchObject({
      ok: true,
      result: { already: true, grant: { held: false } },
    });

    // Step 13: not_admin on grant; revoke allowed on demoted member with dormant manage grant!
    const notAdminGrant = await exec('owner1', 'capability.grant', 'req_step13_01', {
      userId: 'member1',
      capability: 'crm.capabilities.manage',
      scope: '*',
    });
    expect(CommandErrorSchema.parse(notAdminGrant.body)).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'not_admin' },
    });
    // Give admin2 manage, demote admin2 to member, then owner revokes dormant manage grant cleanly!
    await exec('owner1', 'capability.grant', 'req_a2_mgr_01', {
      userId: 'admin2',
      capability: 'crm.capabilities.manage',
      scope: '*',
    });
    await fx!.db.prepare("UPDATE users SET role = 'member', workspace_role = 'member' WHERE id = 'admin2'").run();
    const revokeDormant = await exec('owner1', 'capability.revoke', 'req_a2_mgr_02', {
      userId: 'admin2',
      capability: 'crm.capabilities.manage',
      scope: '*',
    });
    expect(CapabilityChangeResultSchema.parse(revokeDormant.body)).toMatchObject({
      ok: true,
      result: { already: false, grant: { userId: 'admin2', capability: 'crm.capabilities.manage', held: false } },
    });

    // Step 14 & 15: grant member1 finance.read + crm.access; verify non-cascading revoke of crm.access
    await exec('admin1', 'capability.grant', 'req_m1_fin_01', {
      userId: 'member1',
      capability: 'crm.finance.read',
      scope: '*',
    });
    await exec('admin1', 'capability.grant', 'req_m1_acc_01', {
      userId: 'member1',
      capability: 'crm.access',
      scope: '*',
    });
    const pokesBeforeNoop = pokeSpy.mock.calls.length;
    const noopGrant = await exec('admin1', 'capability.grant', 'req_m1_acc_02', {
      userId: 'member1',
      capability: 'crm.access',
      scope: '*',
    });
    expect(CapabilityChangeResultSchema.parse(noopGrant.body)).toMatchObject({
      ok: true,
      result: { already: true, grant: { held: true } },
    });
    expect(pokeSpy.mock.calls.length).toBe(pokesBeforeNoop); // no pokeLive on no-op

    // Revoking crm.access hides effective capabilities without deleting stored crm.finance.read row
    await exec('admin1', 'capability.revoke', 'req_m1_acc_03', {
      userId: 'member1',
      capability: 'crm.access',
      scope: '*',
    });
    const m1Status = await readCrmStatus(fx!.env, 'member1', await tokenHashFor('member1'));
    expect(m1Status).toEqual({
      status: 200,
      body: {
        contract: 'crm-s0-v2',
        enabled: true,
        access: false,
        owner: false,
        capabilities: [],
      },
    });
    const overview = await readCapabilitiesOverview(fx!.env, 'owner1', await tokenHashFor('owner1'));
    expect(overview.status).toBe(200);
    if (overview.status === 200) {
      const m1Acc = overview.body.accounts.find((a) => a.userId === 'member1')!;
      expect(m1Acc.effectiveAccess).toBe(false);
      expect(m1Acc.grants.map((g) => g.capability)).toEqual(['crm.finance.read']);
    }

    // Re-granting crm.access restores crm.finance.read immediately
    await exec('admin1', 'capability.grant', 'req_m1_acc_04', {
      userId: 'member1',
      capability: 'crm.access',
      scope: '*',
    });
    const m1Restored = await readCrmStatus(fx!.env, 'member1', await tokenHashFor('member1'));
    expect(m1Restored.status).toBe(200);
    if (m1Restored.status === 200) {
      expect(m1Restored.body.access).toBe(true);
      expect(m1Restored.body.capabilities.map((c) => c.capability)).toEqual([
        'crm.access',
        'crm.finance.read',
      ]);
    }

    // Append-only triggers reject UPDATE and DELETE on crm_capability_audit
    await expect(
      fx!.db.prepare("UPDATE crm_capability_audit SET reason = 'tampered'").run(),
    ).rejects.toThrow(/append-only/);
    await expect(fx!.db.prepare('DELETE FROM crm_capability_audit').run()).rejects.toThrow(
      /append-only/,
    );
  });

  it('enforces all 3 commit fences (actorFence, targetAccountFence, targetGrantStateFence) under concurrent races', async () => {
    await setup(permissionsEnabled);
    await exec('owner1', 'capability.grant', 'req_setup_a1_1', {
      userId: 'admin1',
      capability: 'crm.access',
      scope: '*',
    });
    await exec('owner1', 'capability.grant', 'req_setup_a1_2', {
      userId: 'admin1',
      capability: 'crm.capabilities.manage',
      scope: '*',
    });

    // Race 1 (actorFence): admin1 loses crm.access before commit -> recovery sees lost authority -> forbidden, 0 writes
    let actorRaced = false;
    const raw = fx!.db;
    const actorRaceDb = interceptD1Batches(raw, async (target, stmts, sql) => {
      if (!actorRaced && sql.some((s) => /INSERT INTO crm_commands/.test(s))) {
        actorRaced = true;
        await raw.prepare("DELETE FROM crm_capability_grants WHERE user_id = 'admin1' AND capability = 'crm.access'").run();
      }
      return target.batch(stmts);
    });
    const r1 = await exec(
      'admin1',
      'capability.grant',
      'req_race_act_01',
      { userId: 'member1', capability: 'crm.access', scope: '*' },
      { ...fx!.env, DB: actorRaceDb },
    );
    expect(CommandErrorSchema.parse(r1.body)).toMatchObject({ ok: false, error: 'forbidden' });
    expect(
      await raw.prepare("SELECT COUNT(*) n FROM crm_capability_grants WHERE user_id = 'member1'").first('n'),
    ).toBe(0);

    // Race 2 (targetAccountFence): target member1 gets disabled before commit -> stale, 0 writes
    let targetRaced = false;
    const targetRaceDb = interceptD1Batches(raw, async (target, stmts, sql) => {
      if (!targetRaced && sql.some((s) => /INSERT INTO crm_commands/.test(s))) {
        targetRaced = true;
        await raw.prepare("UPDATE users SET disabled_at = 2000 WHERE id = 'member1'").run();
      }
      return target.batch(stmts);
    });
    const r2 = await exec(
      'owner1',
      'capability.grant',
      'req_race_tgt_01',
      { userId: 'member1', capability: 'crm.access', scope: '*' },
      { ...fx!.env, DB: targetRaceDb },
    );
    expect(CommandErrorSchema.parse(r2.body)).toMatchObject({ ok: false, error: 'stale', retryable: true });
    expect(
      await raw.prepare("SELECT COUNT(*) n FROM crm_capability_grants WHERE user_id = 'member1'").first('n'),
    ).toBe(0);

    // Race 3 (targetGrantStateFence): another actor grants the same capability before commit -> stale, 0 double-audit
    await raw.prepare("UPDATE users SET disabled_at = NULL WHERE id = 'member1'").run();
    const auditsBefore = (await raw.prepare('SELECT COUNT(*) n FROM crm_capability_audit').first<number>('n'))!;
    let grantRaced = false;
    const grantRaceDb = interceptD1Batches(raw, async (target, stmts, sql) => {
      if (!grantRaced && sql.some((s) => /INSERT INTO crm_commands/.test(s))) {
        grantRaced = true;
        await raw
          .prepare(
            "INSERT INTO crm_capability_grants(user_id, capability, scope, granted_by, granted_at) VALUES ('member1', 'crm.send:email', '*', 'owner1', 999)",
          )
          .run();
      }
      return target.batch(stmts);
    });
    const r3 = await exec(
      'owner1',
      'capability.grant',
      'req_race_grt_01',
      { userId: 'member1', capability: 'crm.send:email', scope: '*' },
      { ...fx!.env, DB: grantRaceDb },
    );
    expect(CommandErrorSchema.parse(r3.body)).toMatchObject({ ok: false, error: 'stale', retryable: true });
    expect(await raw.prepare('SELECT COUNT(*) n FROM crm_capability_audit').first('n')).toBe(auditsBefore);
  });

  it('aborts grant and revoke with 401 and zero writes when the actor session expires between planning and transactional commit (N2)', async () => {
    await setup(permissionsEnabled);
    const raw = fx!.db;

    // Case 1: Real wall-clock expiry at the SQL write boundary during capability.grant
    // Session is valid during pre-commit snapshot and plan(), then expires right before target.batch(stmts) runs.
    const grantExpiry = Date.now() + 90;
    await raw
      .prepare("UPDATE sessions SET expires_at = ? WHERE user_id = 'owner1'")
      .bind(grantExpiry)
      .run();

    let delayedGrant = false;
    const grantExpiredDb = interceptD1Batches(raw, async (target, stmts, sql) => {
      if (!delayedGrant && sql.some((s) => /INSERT INTO crm_commands/.test(s))) {
        delayedGrant = true;
        await new Promise((resolve) => setTimeout(resolve, 130));
      }
      return target.batch(stmts);
    });

    const grantRes = await exec(
      'owner1',
      'capability.grant',
      'req_exp_grt_01',
      { userId: 'member1', capability: 'crm.access', scope: '*' },
      { ...fx!.env, DB: grantExpiredDb },
    );
    expect(delayedGrant).toBe(true);
    expect(grantRes).toEqual({ status: 401, body: { error: 'unauthenticated' } });
    expect(
      await raw.prepare("SELECT COUNT(*) n FROM crm_capability_grants WHERE user_id = 'member1'").first('n'),
    ).toBe(0);
    expect(await raw.prepare('SELECT COUNT(*) n FROM crm_capability_audit').first('n')).toBe(0);
    expect(
      await raw.prepare("SELECT COUNT(*) n FROM crm_commands WHERE request_id = 'req_exp_grt_01'").first('n'),
    ).toBe(0);

    // Case 2: Real wall-clock expiry at the SQL write boundary during capability.revoke
    await raw
      .prepare(
        "INSERT INTO crm_capability_grants(user_id, capability, scope, granted_by, granted_at) VALUES ('member1', 'crm.access', '*', 'owner1', 1)",
      )
      .run();
    const revokeExpiry = Date.now() + 90;
    await raw
      .prepare("UPDATE sessions SET expires_at = ? WHERE user_id = 'owner1'")
      .bind(revokeExpiry)
      .run();

    let delayedRevoke = false;
    const revokeExpiredDb = interceptD1Batches(raw, async (target, stmts, sql) => {
      if (!delayedRevoke && sql.some((s) => /INSERT INTO crm_commands/.test(s))) {
        delayedRevoke = true;
        await new Promise((resolve) => setTimeout(resolve, 130));
      }
      return target.batch(stmts);
    });

    const revokeRes = await exec(
      'owner1',
      'capability.revoke',
      'req_exp_rev_01',
      { userId: 'member1', capability: 'crm.access', scope: '*' },
      { ...fx!.env, DB: revokeExpiredDb },
    );
    expect(delayedRevoke).toBe(true);
    expect(revokeRes).toEqual({ status: 401, body: { error: 'unauthenticated' } });
    // Existing grant must remain intact; zero audit rows and zero journal rows written
    expect(
      await raw.prepare("SELECT COUNT(*) n FROM crm_capability_grants WHERE user_id = 'member1'").first('n'),
    ).toBe(1);
    expect(await raw.prepare('SELECT COUNT(*) n FROM crm_capability_audit').first('n')).toBe(0);
    expect(
      await raw.prepare("SELECT COUNT(*) n FROM crm_commands WHERE request_id = 'req_exp_rev_01'").first('n'),
    ).toBe(0);

    // Case 3: JS clock advance between plan() and commit batch construction (proves actorFence does not bind stale request-start `now`)
    const baseNow = Date.now();
    await raw
      .prepare("UPDATE sessions SET expires_at = ? WHERE user_id = 'owner1'")
      .bind(baseNow + 5_000)
      .run();
    let virtualNow = baseNow;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => virtualNow);
    try {
      let planObserved = false;
      const clockJumpDb = interceptD1Batches(raw, async (target, stmts, sql) => {
        const res = await target.batch(stmts);
        if (!planObserved && sql.some((s) => /FROM users WHERE id = \?/.test(s))) {
          planObserved = true;
          virtualNow = baseNow + 10_000;
        }
        return res;
      });
      const jumpRes = await exec(
        'owner1',
        'capability.grant',
        'req_exp_clk_01',
        { userId: 'member1', capability: 'crm.finance.read', scope: '*' },
        { ...fx!.env, DB: clockJumpDb },
      );
      expect(planObserved).toBe(true);
      expect(jumpRes).toEqual({ status: 401, body: { error: 'unauthenticated' } });
      expect(
        await raw
          .prepare("SELECT COUNT(*) n FROM crm_capability_grants WHERE user_id = 'member1' AND capability = 'crm.finance.read'")
          .first('n'),
      ).toBe(0);
      expect(await raw.prepare('SELECT COUNT(*) n FROM crm_capability_audit').first('n')).toBe(0);
      expect(
        await raw.prepare("SELECT COUNT(*) n FROM crm_commands WHERE request_id = 'req_exp_clk_01'").first('n'),
      ).toBe(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('supports programme:<slug> grants for PROGRAMME_SCOPED capabilities while rejecting non-scoped or unknown slugs', async () => {
    await setup(false);

    // Activate member1 and check PROGRAMME_SCOPED capability crm.configure on common-lab
    const grantAccess = await exec('owner1', 'capability.grant', 'req_pg_acc_01', {
      userId: 'member1',
      capability: 'crm.access',
      scope: '*',
    });
    expect(CapabilityChangeResultSchema.parse(grantAccess.body).ok).toBe(true);

    // Reject unknown slug
    const badSlug = await exec('owner1', 'capability.grant', 'req_pg_bad_01', {
      userId: 'member1',
      capability: 'crm.configure',
      scope: 'programme:not-a-real-programme',
    });
    expect(CommandErrorSchema.parse(badSlug.body)).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'unknown_scope' },
    });

    // Reject programme scope on non-scoped capability
    const nonScoped = await exec('owner1', 'capability.grant', 'req_pg_non_01', {
      userId: 'member1',
      capability: 'crm.send:email',
      scope: 'programme:common-lab',
    });
    expect(CommandErrorSchema.parse(nonScoped.body)).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'unknown_scope' },
    });

    // Valid scoped grant + status exposure + revoke
    const scopedGrant = await exec('owner1', 'capability.grant', 'req_pg_ok_01', {
      userId: 'member1',
      capability: 'crm.configure',
      scope: 'programme:common-lab',
    });
    expect(CapabilityChangeResultSchema.parse(scopedGrant.body)).toMatchObject({
      ok: true,
      result: {
        already: false,
        grant: { userId: 'member1', capability: 'crm.configure', scope: 'programme:common-lab', held: true },
      },
    });

    const status = await readCrmStatus(fx!.env, 'member1', await tokenHashFor('member1'));
    expect(status.status).toBe(200);
    if (status.status === 200) {
      expect(status.body.capabilities).toContainEqual({
        capability: 'crm.configure',
        scope: 'programme:common-lab',
      });
    }

    const scopedRevoke = await exec('owner1', 'capability.revoke', 'req_pg_rev_01', {
      userId: 'member1',
      capability: 'crm.configure',
      scope: 'programme:common-lab',
    });
    expect(CapabilityChangeResultSchema.parse(scopedRevoke.body)).toMatchObject({
      ok: true,
      result: { already: false, grant: { scope: 'programme:common-lab', held: false } },
    });
  });
});
