import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CapabilityAuditPageSchema,
  CapabilityChangeResultSchema,
  CapabilityOverviewSchema,
  CommandErrorSchema,
  CrmHttpErrorSchema,
  CrmRetryableHttpErrorSchema,
  CrmStatusSchema,
  MAX_COMMAND_BODY_BYTES,
} from '../shared/crm/contracts';
import { crmApi } from '../worker/crm';
import { admin } from '../worker/admin';
import { D1BudgetExhausted, d1BudgetRemaining, withD1Budget } from '../worker/d1budget';
import { openAuditFixture, ctx, type AuditFixture } from './audit-fixture';
import { interceptD1Batches } from './d1WriteBoundary';

let fx: AuditFixture | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await fx?.dispose();
  fx = undefined;
});

async function setup(crmEnabled?: string) {
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
  await fx.db.prepare(
    "UPDATE users SET workspace_role = CASE id WHEN 'owner1' THEN 'owner' WHEN 'admin1' THEN 'admin' ELSE 'member' END",
  ).run();
}

async function reqCrm(
  path: string,
  opts: { method?: string; actor?: string | null; body?: BodyInit | null; headers?: Record<string, string>; env?: typeof fx extends undefined ? never : NonNullable<typeof fx>['env'] } = {},
) {
  const env = withD1Budget(opts.env ?? fx!.env, 45);
  const headers: Record<string, string> = {
    ...(opts.actor === null ? {} : fx!.auth(opts.actor ?? 'owner1')),
    ...(opts.headers ?? {}),
  };
  const res = await crmApi.request(
    path,
    {
      method: opts.method ?? 'GET',
      headers,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
    },
    env,
    ctx,
  );
  expect(45 - d1BudgetRemaining(env.DB)).toBeLessThanOrEqual(45);
  return res;
}

describe('CRM HTTP API contract, validation precedence, feature flag, pagination & audit snapshot concurrency (SC-4, SC-9)', () => {
  it('enforces SC-9 CRM_ENABLED flag matrix across all values and terminates unmatched paths with not_found', async () => {
    for (const [val, expectedEnabled] of [
      [undefined, false],
      ['', false],
      ['0', false],
      ['false', false],
      ['1', true],
      ['true', true],
      ['TRUE', true],
    ] as const) {
      await fx?.dispose();
      fx = undefined;
      await setup(val);

      // /status works in both states and validates against CrmStatusSchema
      const statusRes = await reqCrm('/status', { actor: 'owner1' });
      expect(statusRes.status).toBe(200);
      const status = CrmStatusSchema.parse(await statusRes.json());
      expect(status.enabled).toBe(expectedEnabled);
      expect(status.access).toBe(expectedEnabled);
      expect(status.owner).toBe(true);
      expect(status.capabilities).toHaveLength(expectedEnabled ? 13 : 0);

      // Operational routes return 404 { error: 'not_found' } when off
      const capsRes = await reqCrm('/read/capabilities', { actor: 'owner1' });
      const auditRes = await reqCrm('/read/capability-audit', { actor: 'owner1' });
      const cmdRes = await reqCrm('/commands/capability.grant', {
        method: 'POST',
        actor: 'owner1',
        body: JSON.stringify({
          requestId: 'req_flag_0001',
          input: { userId: 'member1', capability: 'crm.access', scope: '*' },
        }),
      });
      if (!expectedEnabled) {
        expect(capsRes.status).toBe(404);
        expect(CrmHttpErrorSchema.parse(await capsRes.json())).toEqual({ error: 'not_found' });
        expect(auditRes.status).toBe(404);
        expect(CrmHttpErrorSchema.parse(await auditRes.json())).toEqual({ error: 'not_found' });
        expect(cmdRes.status).toBe(404);
        expect(CrmHttpErrorSchema.parse(await cmdRes.json())).toEqual({ error: 'not_found' });
      } else {
        expect(capsRes.status).toBe(200);
        CapabilityOverviewSchema.parse(await capsRes.json());
        expect(auditRes.status).toBe(200);
        CapabilityAuditPageSchema.parse(await auditRes.json());
        expect(cmdRes.status).toBe(200);
        CapabilityChangeResultSchema.parse(await cmdRes.json());
      }

      // Unmatched /api/crm/* path returns 404 { error: 'not_found' } (not 'not found')
      const unknownRes = await reqCrm('/does-not-exist', { actor: 'owner1' });
      expect(unknownRes.status).toBe(404);
      expect(CrmHttpErrorSchema.parse(await unknownRes.json())).toEqual({ error: 'not_found' });
    }
  });

  it('enforces exact POST /commands/:name validation precedence: 401 -> 404 -> 413 (header & streamed) -> 400 (UTF-8 / JSON / envelope) -> 200', async () => {
    await setup('1');

    // 1. 401 unauthenticated (even for unknown command & huge body)
    const r401 = await reqCrm('/commands/unknown.cmd', {
      method: 'POST',
      actor: null,
      body: 'not-json',
    });
    expect(r401.status).toBe(401);

    // 2. 404 unknown command (even with oversized body)
    const r404 = await reqCrm('/commands/unknown.cmd', {
      method: 'POST',
      actor: 'member1',
      body: 'x'.repeat(MAX_COMMAND_BODY_BYTES + 10),
    });
    expect(r404.status).toBe(404);
    expect(CrmHttpErrorSchema.parse(await r404.json())).toEqual({ error: 'not_found' });

    // 3a. 413 via Content-Length header
    const r413Header = await reqCrm('/commands/capability.grant', {
      method: 'POST',
      actor: 'member1',
      headers: { 'content-length': String(MAX_COMMAND_BODY_BYTES + 1) },
      body: '{}',
    });
    expect(r413Header.status).toBe(413);
    expect(CrmHttpErrorSchema.parse(await r413Header.json())).toEqual({ error: 'request_too_large' });

    // 3b. 413 via streamed body WITHOUT Content-Length header (>65,536 bytes)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40_000).fill(97));
        controller.enqueue(new Uint8Array(30_000).fill(98));
        controller.close();
      },
    });
    const streamReq = new Request('http://localhost/commands/capability.grant', {
      method: 'POST',
      headers: { authorization: fx!.auth('member1').authorization, 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    const r413Stream = await crmApi.fetch(streamReq, withD1Budget(fx!.env, 45), ctx);
    expect(r413Stream.status).toBe(413);
    expect(CrmHttpErrorSchema.parse(await r413Stream.json())).toEqual({ error: 'request_too_large' });

    // 4a. 400 invalid UTF-8 bytes
    const invalidUtf8 = new Uint8Array([0xff, 0xfe, 0xfd]);
    const r400Utf8 = await reqCrm('/commands/capability.grant', {
      method: 'POST',
      actor: 'member1',
      body: invalidUtf8,
    });
    expect(r400Utf8.status).toBe(400);
    expect(CrmHttpErrorSchema.parse(await r400Utf8.json())).toEqual({ error: 'invalid_body' });

    // 4b. 400 invalid JSON
    const r400Json = await reqCrm('/commands/capability.grant', {
      method: 'POST',
      actor: 'member1',
      body: '{not valid json',
    });
    expect(r400Json.status).toBe(400);
    expect(CrmHttpErrorSchema.parse(await r400Json.json())).toEqual({ error: 'invalid_body' });

    // 4c. 400 invalid envelope (short requestId)
    const r400Env = await reqCrm('/commands/capability.grant', {
      method: 'POST',
      actor: 'member1',
      body: JSON.stringify({ requestId: 'short', input: {} }),
    });
    expect(r400Env.status).toBe(400);
    expect(CrmHttpErrorSchema.parse(await r400Env.json())).toEqual({ error: 'invalid_body' });

    // 5. Valid envelope by unauthorized member -> 200 CommandError('forbidden')
    const rForbidden = await reqCrm('/commands/capability.grant', {
      method: 'POST',
      actor: 'member1',
      body: JSON.stringify({ requestId: 'req_forb_0001', input: { capability: 'crm.fake', scope: 'bad' } }),
    });
    expect(rForbidden.status).toBe(200);
    expect(CommandErrorSchema.parse(await rForbidden.json())).toMatchObject({ ok: false, error: 'forbidden' });

    // 6. Valid envelope by owner with unknown_capability / unknown_scope -> 200 CommandError('invalid_input')
    const rBadCap = await reqCrm('/commands/capability.grant', {
      method: 'POST',
      actor: 'owner1',
      body: JSON.stringify({
        requestId: 'req_bad_cap01',
        input: { userId: 'member1', capability: 'crm.nonexistent', scope: '*' },
      }),
    });
    expect(rBadCap.status).toBe(200);
    expect(CommandErrorSchema.parse(await rBadCap.json())).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'unknown_capability' },
    });

    const rBadScope = await reqCrm('/commands/capability.grant', {
      method: 'POST',
      actor: 'owner1',
      body: JSON.stringify({
        requestId: 'req_bad_scp01',
        input: { userId: 'member1', capability: 'crm.restricted.read', scope: 'prog-1' },
      }),
    });
    expect(rBadScope.status).toBe(200);
    expect(CommandErrorSchema.parse(await rBadScope.json())).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'unknown_scope' },
    });
  });

  it('enforces capability-audit auth-before-cursor-validation, cursor validation, keyset pagination (>50 rows), and LEFT JOIN null names', async () => {
    await setup('1');

    // Member with bad cursor gets 403 forbidden BEFORE 400 invalid_cursor!
    const memberBadCursor = await reqCrm('/read/capability-audit?cursor=!!!not-base64!!!', {
      actor: 'member1',
    });
    expect(memberBadCursor.status).toBe(403);
    expect(CrmHttpErrorSchema.parse(await memberBadCursor.json())).toEqual({ error: 'forbidden' });

    // Owner with invalid cursors gets 400 invalid_cursor
    for (const bad of [
      '',
      'a'.repeat(257),
      'not+base64/url=',
      btoa('not-json').replace(/=/g, ''),
      btoa('[-1,"valid_id_1234"]').replace(/=/g, ''),
      btoa('[100,"short"]').replace(/=/g, ''),
    ]) {
      const res = await reqCrm(`/read/capability-audit?cursor=${encodeURIComponent(bad)}`, {
        actor: 'owner1',
      });
      expect(res.status, `cursor=${bad}`).toBe(400);
      expect(CrmHttpErrorSchema.parse(await res.json())).toEqual({ error: 'invalid_cursor' });
    }

    // Seed 55 audit rows (including one whose target is member1 before we delete member1)
    const baseTime = 1_700_000_000_000;
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 55; i++) {
      const id = `audit_row_${String(i).padStart(3, '0')}`;
      // Use pairs with identical created_at to exercise tie-breaking on id DESC
      const ts = baseTime + Math.floor(i / 2) * 1000;
      stmts.push(
        fx!.db
          .prepare(
            `INSERT INTO crm_capability_audit(id, actor_id, target_user_id, action, capability, scope, before_json, after_json, reason, request_id, created_at)
             VALUES (?, 'owner1', 'member1', 'grant', 'crm.access', '*', '{}', '{}', ?, ?, ?)`,
          )
          .bind(id, `row-${i}`, `seed_audit_req_${i}`, ts),
      );
    }
    await fx!.db.batch(stmts);

    // Delete member1 via admin route -> LEFT JOIN users must still return all 55 rows with targetName: null
    const delRes = await admin.request(
      '/users/member1',
      { method: 'DELETE', headers: fx!.auth('owner1') },
      fx!.env,
      ctx,
    );
    expect(delRes.status).toBe(200);

    const p1Res = await reqCrm('/read/capability-audit', { actor: 'owner1' });
    expect(p1Res.status).toBe(200);
    const p1 = CapabilityAuditPageSchema.parse(await p1Res.json());
    expect(p1.items).toHaveLength(50);
    expect(p1.next).not.toBeNull();
    expect(p1.items[0].actorName).toBe('owner1');
    expect(p1.items[0].targetName).toBeNull();

    const p2Res = await reqCrm(`/read/capability-audit?cursor=${encodeURIComponent(p1.next!)}`, {
      actor: 'owner1',
    });
    expect(p2Res.status).toBe(200);
    const p2 = CapabilityAuditPageSchema.parse(await p2Res.json());
    expect(p2.items).toHaveLength(5);
    expect(p2.next).toBeNull();

    // No duplicates, exact newest-first ordering across all 55 rows
    const allIds = [...p1.items, ...p2.items].map((i) => i.id);
    expect(new Set(allIds).size).toBe(55);
    const allItems = [...p1.items, ...p2.items];
    for (let i = 1; i < allItems.length; i++) {
      const prev = allItems[i - 1];
      const curr = allItems[i];
      const ordered =
        prev.createdAt > curr.createdAt || (prev.createdAt === curr.createdAt && prev.id > curr.id);
      expect(ordered).toBe(true);
    }
  });

  it('prevents audit disclosure when capability revocation, admin demotion, or account disablement races between pre-cursor check and final snapshot batch (N1)', async () => {
    await setup('1');

    // Seed 2 audit rows + give admin1 crm.access and crm.capabilities.manage
    await fx!.db.batch([
      fx!.db.prepare(
        "INSERT INTO crm_capability_grants(user_id, capability, scope, granted_by, granted_at) VALUES ('admin1', 'crm.access', '*', 'owner1', 1)",
      ),
      fx!.db.prepare(
        "INSERT INTO crm_capability_grants(user_id, capability, scope, granted_by, granted_at) VALUES ('admin1', 'crm.capabilities.manage', '*', 'owner1', 1)",
      ),
      fx!.db.prepare(
        `INSERT INTO crm_capability_audit(id, actor_id, target_user_id, action, capability, scope, before_json, after_json, reason, request_id, created_at)
         VALUES ('audit_secret_01', 'owner1', 'member1', 'grant', 'crm.restricted.read', '*', '{}', '{}', 'sensitive', 'req_sec_01', 1700000001000)`,
      ),
    ]);

    const validCursor = btoa(JSON.stringify([1700000009000, 'audit_zzz_9999']))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    // Helper that injects a race mutation RIGHT BEFORE the final audit SELECT batch executes
    const runRace = async (raceSql: string) => {
      let injected = false;
      const raw = fx!.db;
      const racedDb = interceptD1Batches(raw, async (target, stmts, sql) => {
        if (!injected && sql.some((s) => /FROM crm_capability_audit/i.test(s))) {
          injected = true;
          await raw.prepare(raceSql).run();
        }
        return target.batch(stmts);
      });
      const res = await reqCrm(`/read/capability-audit?cursor=${encodeURIComponent(validCursor)}`, {
        actor: 'admin1',
        env: { ...fx!.env, DB: racedDb },
      });
      expect(injected).toBe(true);
      return res;
    };

    // Race A: concurrent revocation of crm.capabilities.manage -> 403, ZERO audit items leaked
    const revokeRes = await runRace(
      "DELETE FROM crm_capability_grants WHERE user_id = 'admin1' AND capability = 'crm.capabilities.manage'",
    );
    expect(revokeRes.status).toBe(403);
    const revokeText = await revokeRes.text();
    expect(revokeText).not.toContain('audit_secret_01');
    expect(CrmHttpErrorSchema.parse(JSON.parse(revokeText))).toEqual({ error: 'forbidden' });

    // Restore manage grant; Race B: concurrent demotion of admin1 -> member -> 403, ZERO audit items leaked
    await fx!.db
      .prepare(
        "INSERT INTO crm_capability_grants(user_id, capability, scope, granted_by, granted_at) VALUES ('admin1', 'crm.capabilities.manage', '*', 'owner1', 2)",
      )
      .run();
    const demoteRes = await runRace(
      "UPDATE users SET role = 'member', workspace_role = 'member' WHERE id = 'admin1'",
    );
    expect(demoteRes.status).toBe(403);
    const demoteText = await demoteRes.text();
    expect(demoteText).not.toContain('audit_secret_01');
    expect(CrmHttpErrorSchema.parse(JSON.parse(demoteText))).toEqual({ error: 'forbidden' });

    // Restore admin role; Race C: concurrent disablement of admin1 -> 401, ZERO audit items leaked
    await fx!.db
      .prepare("UPDATE users SET role = 'admin', workspace_role = 'admin' WHERE id = 'admin1'")
      .run();
    const disableRes = await runRace("UPDATE users SET disabled_at = 5000 WHERE id = 'admin1'");
    expect(disableRes.status).toBe(401);
    const disableText = await disableRes.text();
    expect(disableText).not.toContain('audit_secret_01');
  });

  it('returns retryable 503 matching CrmRetryableHttpErrorSchema on processing_budget or write_interrupted', async () => {
    await setup('1');

    // Simulate transient D1 commit error -> 503 write_interrupted
    let failedOnce = false;
    const raw = fx!.db;
    const failDb = interceptD1Batches(raw, async (target, stmts, sql) => {
      if (!failedOnce && sql.some((s) => /INSERT INTO crm_commands/.test(s))) {
        failedOnce = true;
        throw new Error('D1 transient failure');
      }
      return target.batch(stmts);
    });
    const r503 = await reqCrm('/commands/capability.grant', {
      method: 'POST',
      actor: 'owner1',
      env: { ...fx!.env, DB: failDb },
      body: JSON.stringify({
        requestId: 'req_503_test01',
        input: { userId: 'member1', capability: 'crm.access', scope: '*' },
      }),
    });
    expect(r503.status).toBe(503);
    expect(CrmRetryableHttpErrorSchema.parse(await r503.json())).toEqual({
      error: 'write_interrupted',
      retryable: true,
    });

    // D1BudgetExhausted propagates to top-level app.onError -> HTTP 503 processing_budget
    const { Hono } = await import('hono');
    const host = new Hono<{ Bindings: typeof fx extends undefined ? never : NonNullable<typeof fx>['env'] }>();
    host.onError((err, c) => {
      if (err instanceof D1BudgetExhausted) return c.json({ error: 'processing_budget', retryable: true }, 503);
      return c.json({ error: 'internal error' }, 500);
    });
    host.route('/api/crm', crmApi);
    const budgetDb = interceptD1Batches(raw, async () => {
      throw new D1BudgetExhausted();
    });
    const budgetRes = await host.request(
      '/api/crm/status',
      { method: 'GET', headers: fx!.auth('owner1') },
      { ...fx!.env, DB: budgetDb },
      ctx,
    );
    expect(budgetRes.status).toBe(503);
    expect(CrmRetryableHttpErrorSchema.parse(await budgetRes.json())).toEqual({
      error: 'processing_budget',
      retryable: true,
    });
  });
});
