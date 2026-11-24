import { afterEach, describe, expect, it, vi } from 'vitest';
import { OWNER_PROTECTED_ERROR } from '../shared/crm/contracts';
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

async function setup(crmEnabled: string | undefined) {
  const provider = {
    listUserGrants: vi.fn(async () => ({ items: [] })),
    revokeGrant: vi.fn(async () => {}),
  };
  fx = await openAuditFixture(
    [
      { id: 'owner1', role: 'admin' },
      { id: 'admin1', role: 'admin' },
      { id: 'admin2', role: 'admin' },
      { id: 'member1', role: 'member' },
    ],
    {
      OAUTH_PROVIDER: provider as never,
      ...(crmEnabled !== undefined ? { CRM_ENABLED: crmEnabled } : {}),
    },
  );
  await fx.db.prepare(
    `UPDATE users SET workspace_role = CASE id
       WHEN 'owner1' THEN 'owner'
       WHEN 'admin1' THEN 'admin'
       WHEN 'admin2' THEN 'admin'
       ELSE 'member'
     END`,
  ).run();
}

async function req(
  path: string,
  method: string,
  actor: string,
  body?: unknown,
  env = fx!.env,
) {
  const scoped = withD1Budget(env);
  const res = await admin.request(
    path,
    {
      method,
      headers: fx!.auth(actor),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    scoped,
    ctx,
  );
  expect(45 - d1BudgetRemaining(scoped.DB)).toBeLessThanOrEqual(45);
  return res;
}

describe.each([
  { crmEnabled: undefined },
  { crmEnabled: '1' },
])('SC-6 owner protection on admin routes (CRM_ENABLED=$crmEnabled)', ({ crmEnabled }) => {
  it('blocks non-owner admin PATCH (member AND admin), disable (even if already disabled), and DELETE on owner with 403 owner_protected', async () => {
    await setup(crmEnabled);

    // PATCH role -> member
    const patchMember = await req('/users/owner1', 'PATCH', 'admin1', { role: 'member' });
    expect(patchMember.status).toBe(403);
    expect(await patchMember.json()).toEqual({ error: OWNER_PROTECTED_ERROR });

    // PATCH role -> admin (previously returned 200; must now return 403 owner_protected)
    const patchAdmin = await req('/users/owner1', 'PATCH', 'admin1', { role: 'admin' });
    expect(patchAdmin.status).toBe(403);
    expect(await patchAdmin.json()).toEqual({ error: OWNER_PROTECTED_ERROR });

    // POST /disable
    const disableRes = await req('/users/owner1/disable', 'POST', 'admin1');
    expect(disableRes.status).toBe(403);
    expect(await disableRes.json()).toEqual({ error: OWNER_PROTECTED_ERROR });

    // DELETE
    const deleteRes = await req('/users/owner1', 'DELETE', 'admin1');
    expect(deleteRes.status).toBe(403);
    expect(await deleteRes.json()).toEqual({ error: OWNER_PROTECTED_ERROR });

    // Verify owner untouched and zero audit rows written
    const ownerRow = await fx!.db
      .prepare("SELECT role, workspace_role, disabled_at FROM users WHERE id = 'owner1'")
      .first<{ role: string; workspace_role: string; disabled_at: number | null }>();
    expect(ownerRow).toEqual({ role: 'admin', workspace_role: 'owner', disabled_at: null });
    expect(await fx!.db.prepare('SELECT COUNT(*) n FROM access_audit').first('n')).toBe(0);
  });

  it('preserves owner self-refusal (400) and non-owner admin management of non-owners', async () => {
    await setup(crmEnabled);

    expect((await req('/users/owner1', 'PATCH', 'owner1', { role: 'member' })).status).toBe(400);
    expect((await req('/users/owner1/disable', 'POST', 'owner1')).status).toBe(400);
    expect((await req('/users/owner1', 'DELETE', 'owner1')).status).toBe(400);

    // Non-owner admin can still manage regular members and other non-owner admins
    expect((await req('/users/member1', 'PATCH', 'admin1', { role: 'admin' })).status).toBe(200);
    expect((await req('/users/member1/disable', 'POST', 'admin1')).status).toBe(200);
    expect((await req('/users/member1', 'DELETE', 'admin1')).status).toBe(200);
  });

  it('fences concurrent promotion of target to owner during PATCH, disable, and DELETE with 409', async () => {
    for (const [method, suffix, body] of [
      ['PATCH', '', { role: 'member' }],
      ['POST', '/disable', undefined],
      ['DELETE', '', undefined],
    ] as const) {
      await fx?.dispose();
      fx = undefined;
      await setup(crmEnabled);

      let promoted = false;
      const raw = fx!.db;
      const db = interceptD1Batches(raw, async (target, stmts, sql) => {
        if (!promoted && sql.some((s) => /UPDATE users|DELETE FROM users/.test(s))) {
          promoted = true;
          await raw.prepare("UPDATE users SET workspace_role = 'owner' WHERE id = 'admin2'").run();
        }
        return target.batch(stmts);
      });

      const res = await req(`/users/admin2${suffix}`, method, 'admin1', body, { ...fx!.env, DB: db });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'account_or_authority_changed' });

      const row = await raw
        .prepare("SELECT workspace_role, disabled_at FROM users WHERE id = 'admin2'")
        .first<{ workspace_role: string; disabled_at: number | null }>();
      expect(row).toEqual({ workspace_role: 'owner', disabled_at: null });
    }
  });
});
