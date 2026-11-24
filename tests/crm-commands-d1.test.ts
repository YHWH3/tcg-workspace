import { afterEach, describe, expect, it } from 'vitest';
import {
  CommandErrorSchema,
  commandResultSchema,
  MAX_COMMAND_RESULT_BYTES,
} from '../shared/crm/contracts';
import { applyChanges } from '../worker/sync';
import {
  computeCommandRequestHash,
  createCommandRegistry,
  runCommand,
  stripUndefined,
  type CommandDefinition,
} from '../worker/crm/commands';
import { createCapabilityCommandDefs } from '../worker/crm/grants';
import { D1BudgetExhausted, d1BudgetRemaining, withD1Budget } from '../worker/d1budget';
import { openAuditFixture, ctx, type AuditFixture } from './audit-fixture';
import { interceptD1Batches } from './d1WriteBoundary';
import { z } from 'zod';

let fx: AuditFixture | undefined;
afterEach(async () => {
  await fx?.dispose();
  fx = undefined;
});

async function setup(permissionsEnabled = false) {
  fx = await openAuditFixture(
    [
      { id: 'owner1', role: 'admin' },
      { id: 'admin1', role: 'admin' },
      { id: 'member1', role: 'member' },
    ],
    { CRM_ENABLED: '1' },
  );
  await fx.db.batch([
    fx.db.prepare('UPDATE access_state SET enabled = ? WHERE id = 1').bind(permissionsEnabled ? 1 : 0),
    fx.db.prepare(
      "UPDATE users SET workspace_role = CASE id WHEN 'owner1' THEN 'owner' WHEN 'admin1' THEN 'admin' ELSE 'member' END",
    ),
    fx.db.prepare(
      `INSERT INTO records(id, collection, data, field_ts, seq, space_id)
       VALUES
         ('board-crm', 'boards', '{"name":"People","columns":[{"id":"todo","name":"To do","color":"gray"}]}', '{"name":1}', 1, 'space-core'),
         ('task-p1', 'tasks', '{"title":"Person One","boardId":"board-crm","status":"todo","_crm_stage":"lead"}', '{"title":1,"boardId":1,"status":1,"_crm_stage":1}', 2, 'space-core'),
         ('task-ro', 'tasks', '{"title":"Read Only Ref","boardId":"board-crm","status":"todo"}', '{"title":1,"boardId":1,"status":1}', 3, 'space-core')`,
    ),
  ]);
}

async function tokenHashFor(userId: string): Promise<string> {
  const row = await fx!.db
    .prepare('SELECT token_hash FROM sessions WHERE user_id = ? LIMIT 1')
    .bind(userId)
    .first<{ token_hash: string }>();
  return row!.token_hash;
}

describe('CRM command framework, idempotency & atomic Records Commit Mode (SC-1, SC-3, CR-01, CR-02)', () => {
  it('strips undefined recursively for canonical hashing and collides across expected/via differences', async () => {
    expect(stripUndefined({ a: 1, b: undefined, nested: { x: undefined, y: 'ok' }, arr: [1, undefined] })).toEqual({
      a: 1,
      nested: { y: 'ok' },
      arr: [1, null],
    });

    const h1 = await computeCommandRequestHash({
      name: 'capability.grant',
      via: 'ui',
      input: { userId: 'member1', capability: 'crm.access', scope: '*', reason: undefined },
    });
    const h2 = await computeCommandRequestHash({
      name: 'capability.grant',
      via: 'ui',
      input: { userId: 'member1', capability: 'crm.access', scope: '*' },
      expected: {},
    });
    expect(h1).toBe(h2);

    const hDifferentVia = await computeCommandRequestHash({
      name: 'capability.grant',
      via: 'mcp',
      input: { userId: 'member1', capability: 'crm.access', scope: '*' },
    });
    expect(hDifferentVia).not.toBe(h1);

    const hDifferentExpected = await computeCommandRequestHash({
      name: 'capability.grant',
      via: 'ui',
      input: { userId: 'member1', capability: 'crm.access', scope: '*' },
      expected: { 'task-p1': 2 },
    });
    expect(hDifferentExpected).not.toBe(h1);
  });

  it('rejects malformed projectionKeys at registry creation time', () => {
    const base: CommandDefinition = {
      name: 'test.bad',
      projectionKeys: ['not_crm_key'],
      authorizeCoarse: () => true,
      parseInput: (raw) => ({ ok: true, input: raw }),
      plan: async () => ({ kind: 'commit', result: {}, fences: [] }),
    };
    expect(() => createCommandRegistry([base])).toThrow(/invalid CRM projection key/);
    expect(() => createCommandRegistry([{ ...base, projectionKeys: ['_crm_Upper'] }])).toThrow(
      /invalid CRM projection key/,
    );
    expect(() => createCommandRegistry([{ ...base, projectionKeys: ['_crm_valid_1'] }])).not.toThrow();
  });

  it('journals successful no-ops, persists zero errors, enforces 16 KB cap, and collides across via/expected', async () => {
    await setup(false);
    const ownerHash = await tokenHashFor('owner1');
    const registry = createCommandRegistry([
      ...createCapabilityCommandDefs(),
      {
        name: 'test.huge',
        authorizeCoarse: () => true,
        parseInput: (raw) => ({ ok: true, input: raw }),
        plan: async () => ({
          kind: 'commit',
          result: { blob: 'x'.repeat(MAX_COMMAND_RESULT_BYTES) },
          fences: [],
        }),
      },
    ]);

    // Refusal persists ZERO crm_commands rows
    const refRes = await runCommand({
      env: fx!.env,
      executionCtx: ctx,
      actorId: 'owner1',
      tokenHash: ownerHash,
      via: 'ui',
      name: 'capability.grant',
      envelope: {
        requestId: 'req_refusal_01',
        input: { userId: 'missing-user', capability: 'crm.access', scope: '*' },
      },
      registry,
    });
    expect(refRes.status).toBe(200);
    expect(CommandErrorSchema.parse(refRes.body)).toMatchObject({ ok: false, error: 'not_found', retryable: false });
    expect(await fx!.db.prepare('SELECT COUNT(*) n FROM crm_commands').first('n')).toBe(0);

    // >16 KB result returns budget_exceeded before commit (no row written, never truncated)
    const hugeRes = await runCommand({
      env: fx!.env,
      executionCtx: ctx,
      actorId: 'owner1',
      tokenHash: ownerHash,
      via: 'ui',
      name: 'test.huge',
      envelope: { requestId: 'req_huge_0001', input: {} },
      registry,
    });
    expect(hugeRes.status).toBe(200);
    expect(CommandErrorSchema.parse(hugeRes.body)).toMatchObject({
      ok: false,
      error: 'budget_exceeded',
      retryable: false,
    });
    expect(await fx!.db.prepare('SELECT COUNT(*) n FROM crm_commands').first('n')).toBe(0);

    // No-op revoke journals crm_commands (status = 'ok') with zero audit rows
    const noopRes = await runCommand({
      env: fx!.env,
      executionCtx: ctx,
      actorId: 'owner1',
      tokenHash: ownerHash,
      via: 'ui',
      name: 'capability.revoke',
      envelope: {
        requestId: 'req_noop_0001',
        input: { userId: 'member1', capability: 'crm.access', scope: '*', reason: '   ' },
      },
      registry,
    });
    expect(noopRes.status).toBe(200);
    expect(noopRes.body).toMatchObject({ ok: true, result: { already: true } });
    expect(await fx!.db.prepare("SELECT status FROM crm_commands WHERE request_id = 'req_noop_0001'").first('status')).toBe('ok');
    expect(await fx!.db.prepare('SELECT COUNT(*) n FROM crm_capability_audit').first('n')).toBe(0);

    // Replaying with omitted reason hashes identically to whitespace reason -> exact replay
    const replayRes = await runCommand({
      env: fx!.env,
      executionCtx: ctx,
      actorId: 'owner1',
      tokenHash: ownerHash,
      via: 'ui',
      name: 'capability.revoke',
      envelope: {
        requestId: 'req_noop_0001',
        input: { userId: 'member1', capability: 'crm.access', scope: '*' },
      },
      registry,
    });
    expect(replayRes.body).toEqual(noopRes.body);

    // Same requestId with different via channel -> idempotency_conflict
    const diffVia = await runCommand({
      env: fx!.env,
      executionCtx: ctx,
      actorId: 'owner1',
      tokenHash: ownerHash,
      via: 'mcp',
      name: 'capability.revoke',
      envelope: {
        requestId: 'req_noop_0001',
        input: { userId: 'member1', capability: 'crm.access', scope: '*' },
      },
      registry,
    });
    expect(CommandErrorSchema.parse(diffVia.body)).toMatchObject({
      ok: false,
      error: 'idempotency_conflict',
      retryable: false,
    });

    // Same requestId with different expected map -> idempotency_conflict
    const diffExp = await runCommand({
      env: fx!.env,
      executionCtx: ctx,
      actorId: 'owner1',
      tokenHash: ownerHash,
      via: 'ui',
      name: 'capability.revoke',
      envelope: {
        requestId: 'req_noop_0001',
        input: { userId: 'member1', capability: 'crm.access', scope: '*' },
        expected: { 'task-p1': 2 },
      },
      registry,
    });
    expect(CommandErrorSchema.parse(diffExp.body)).toMatchObject({
      ok: false,
      error: 'idempotency_conflict',
      retryable: false,
    });
  });

  it('recovers concurrent UNIQUE collision, winner-tripped-fence race, lost ack, transient 503, and enforces replay authority', async () => {
    await setup(false);
    const ownerHash = await tokenHashFor('owner1');
    const registry = createCommandRegistry(createCapabilityCommandDefs());

    // 1. Winner-tripped-fence race: loser reads snapshot before winner commits; winner commits grant + crm_commands;
    // loser's targetGrantStateFence throws malformed JSON; loser recovers winner's stored CommandResult verbatim!
    let raced = false;
    let winnerResult: unknown;
    const raw = fx!.db;
    const racedDb = interceptD1Batches(raw, async (target, stmts, sql) => {
      if (!raced && sql.some((s) => /INSERT INTO crm_commands/.test(s))) {
        raced = true;
        const w = await runCommand({
          env: fx!.env,
          executionCtx: ctx,
          actorId: 'owner1',
          tokenHash: ownerHash,
          via: 'ui',
          name: 'capability.grant',
          envelope: {
            requestId: 'req_race_win_01',
            input: { userId: 'member1', capability: 'crm.access', scope: '*' },
          },
          registry,
        });
        winnerResult = w.body;
      }
      return target.batch(stmts);
    });

    const loserRes = await runCommand({
      env: { ...fx!.env, DB: racedDb },
      executionCtx: ctx,
      actorId: 'owner1',
      tokenHash: ownerHash,
      via: 'ui',
      name: 'capability.grant',
      envelope: {
        requestId: 'req_race_win_01',
        input: { userId: 'member1', capability: 'crm.access', scope: '*' },
      },
      registry,
    });
    expect(loserRes.status).toBe(200);
    expect(loserRes.body).toEqual(winnerResult);
    expect(await raw.prepare('SELECT COUNT(*) n FROM crm_capability_audit').first('n')).toBe(1);

    // 2. Concurrent UNIQUE collision on crm_commands (no-op command where fences still pass for both, hitting UNIQUE)
    let uniqueRaced = false;
    let uniqueWinner: unknown;
    const uniqueDb = interceptD1Batches(raw, async (target, stmts, sql) => {
      if (!uniqueRaced && sql.some((s) => /INSERT INTO crm_commands/.test(s))) {
        uniqueRaced = true;
        const w = await runCommand({
          env: fx!.env,
          executionCtx: ctx,
          actorId: 'owner1',
          tokenHash: ownerHash,
          via: 'ui',
          name: 'capability.grant',
          envelope: {
            requestId: 'req_race_uniq_01',
            input: { userId: 'member1', capability: 'crm.access', scope: '*' },
          },
          registry,
        });
        uniqueWinner = w.body;
      }
      return target.batch(stmts);
    });
    const uniqueLoser = await runCommand({
      env: { ...fx!.env, DB: uniqueDb },
      executionCtx: ctx,
      actorId: 'owner1',
      tokenHash: ownerHash,
      via: 'ui',
      name: 'capability.grant',
      envelope: {
        requestId: 'req_race_uniq_01',
        input: { userId: 'member1', capability: 'crm.access', scope: '*' },
      },
      registry,
    });
    expect(uniqueLoser.status).toBe(200);
    expect(uniqueLoser.body).toEqual(uniqueWinner);

    // 3. Lost acknowledgement: commit succeeds in D1, transport throws after commit -> recovery replays verbatim!
    let lostAckThrown = false;
    const lostAckDb = interceptD1Batches(raw, async (target, stmts, sql) => {
      const res = await target.batch(stmts);
      if (!lostAckThrown && sql.some((s) => /INSERT INTO crm_commands/.test(s))) {
        lostAckThrown = true;
        throw new Error('simulated network drop after commit');
      }
      return res;
    });
    const lostAckRes = await runCommand({
      env: { ...fx!.env, DB: lostAckDb },
      executionCtx: ctx,
      actorId: 'owner1',
      tokenHash: ownerHash,
      via: 'ui',
      name: 'capability.grant',
      envelope: {
        requestId: 'req_lost_ack_01',
        input: { userId: 'member1', capability: 'crm.finance.read', scope: '*' },
      },
      registry,
    });
    expect(lostAckRes.status).toBe(200);
    expect(lostAckRes.body).toMatchObject({ ok: true, result: { already: false } });

    // 4. Transient D1 failure BEFORE commit (nothing persisted) -> 503 write_interrupted
    let transientThrown = false;
    const transientDb = interceptD1Batches(raw, async (target, stmts, sql) => {
      if (!transientThrown && sql.some((s) => /INSERT INTO crm_commands/.test(s))) {
        transientThrown = true;
        throw new Error('transient D1 timeout');
      }
      return target.batch(stmts);
    });
    const transientRes = await runCommand({
      env: { ...fx!.env, DB: transientDb },
      executionCtx: ctx,
      actorId: 'owner1',
      tokenHash: ownerHash,
      via: 'ui',
      name: 'capability.grant',
      envelope: {
        requestId: 'req_transient_01',
        input: { userId: 'member1', capability: 'crm.send:email', scope: '*' },
      },
      registry,
    });
    expect(transientRes).toEqual({
      status: 503,
      body: { error: 'write_interrupted', retryable: true },
    });

    // 5. Replay denied after actor loses capability (200 forbidden) or is disabled (401)
    const adminHash = await tokenHashFor('admin1');
    await raw.batch([
      raw.prepare("INSERT INTO crm_capability_grants(user_id, capability, scope, granted_by, granted_at) VALUES ('admin1', 'crm.access', '*', 'owner1', 1)"),
      raw.prepare("INSERT INTO crm_capability_grants(user_id, capability, scope, granted_by, granted_at) VALUES ('admin1', 'crm.capabilities.manage', '*', 'owner1', 1)"),
    ]);
    const adminGrant = await runCommand({
      env: fx!.env,
      executionCtx: ctx,
      actorId: 'admin1',
      tokenHash: adminHash,
      via: 'ui',
      name: 'capability.grant',
      envelope: {
        requestId: 'req_admin_rep_01',
        input: { userId: 'member1', capability: 'crm.merge', scope: '*' },
      },
      registry,
    });
    expect(adminGrant.status).toBe(200);
    expect(adminGrant.body).toMatchObject({ ok: true });

    // Revoke admin1's crm.capabilities.manage -> replay returns forbidden (not cached result!)
    await raw.prepare("DELETE FROM crm_capability_grants WHERE user_id = 'admin1' AND capability = 'crm.capabilities.manage'").run();
    const deniedReplay = await runCommand({
      env: fx!.env,
      executionCtx: ctx,
      actorId: 'admin1',
      tokenHash: adminHash,
      via: 'ui',
      name: 'capability.grant',
      envelope: {
        requestId: 'req_admin_rep_01',
        input: { userId: 'member1', capability: 'crm.merge', scope: '*' },
      },
      registry,
    });
    expect(CommandErrorSchema.parse(deniedReplay.body)).toMatchObject({ ok: false, error: 'forbidden' });

    // Disable admin1 -> replay returns 401
    await raw.prepare("UPDATE users SET disabled_at = 1 WHERE id = 'admin1'").run();
    const disabledReplay = await runCommand({
      env: fx!.env,
      executionCtx: ctx,
      actorId: 'admin1',
      tokenHash: adminHash,
      via: 'ui',
      name: 'capability.grant',
      envelope: {
        requestId: 'req_admin_rep_01',
        input: { userId: 'member1', capability: 'crm.merge', scope: '*' },
      },
      registry,
    });
    expect(disabledReplay).toEqual({ status: 401, body: { error: 'unauthenticated' } });
  });

  it('never misclassifies unrelated SQLite constraints (CHECK / trigger abort) as idempotency_conflict or stale, and rethrows D1BudgetExhausted', async () => {
    await setup(false);
    const ownerHash = await tokenHashFor('owner1');
    const registry = createCommandRegistry([
      {
        name: 'test.bad_check',
        authorizeCoarse: () => true,
        parseInput: (raw) => ({ ok: true, input: raw }),
        plan: async ({ env }) => ({
          kind: 'commit',
          result: { done: true },
          fences: [],
          // Violates CHECK (action IN ('grant','revoke')) on crm_capability_audit
          rows: [
            env.DB.prepare(
              `INSERT INTO crm_capability_audit(id, actor_id, target_user_id, action, capability, scope, before_json, after_json, request_id, created_at)
               VALUES ('bad-check-1234', 'owner1', 'member1', 'INVALID_ACTION', 'crm.access', '*', '{}', '{}', 'req_bad_check', 1)`,
            ),
          ],
        }),
      },
      {
        name: 'test.trigger_abort',
        authorizeCoarse: () => true,
        parseInput: (raw) => ({ ok: true, input: raw }),
        plan: async ({ env }) => ({
          kind: 'commit',
          result: { done: true },
          fences: [],
          // Triggers BEFORE DELETE append-only RAISE(ABORT) on crm_capability_audit
          rows: [env.DB.prepare('DELETE FROM crm_capability_audit')],
        }),
      },
    ]);

    // Seed one audit row so DELETE fires the append-only trigger
    await fx!.db
      .prepare(
        `INSERT INTO crm_capability_audit(id, actor_id, target_user_id, action, capability, scope, before_json, after_json, request_id, created_at)
         VALUES ('seed-audit-1234', 'owner1', 'member1', 'grant', 'crm.access', '*', '{}', '{}', 'seed_req_1', 1)`,
      )
      .run();

    // Unrelated CHECK constraint rethrows (becomes 500) and writes zero crm_commands rows
    await expect(
      runCommand({
        env: fx!.env,
        executionCtx: ctx,
        actorId: 'owner1',
        tokenHash: ownerHash,
        via: 'ui',
        name: 'test.bad_check',
        envelope: { requestId: 'req_bad_check_01', input: {} },
        registry,
      }),
    ).rejects.toThrow(/CHECK constraint failed/i);
    expect(await fx!.db.prepare('SELECT COUNT(*) n FROM crm_commands').first('n')).toBe(0);

    // Append-only trigger abort rethrows (becomes 500) and writes zero crm_commands rows
    await expect(
      runCommand({
        env: fx!.env,
        executionCtx: ctx,
        actorId: 'owner1',
        tokenHash: ownerHash,
        via: 'ui',
        name: 'test.trigger_abort',
        envelope: { requestId: 'req_trig_abort_01', input: {} },
        registry,
      }),
    ).rejects.toThrow(/append-only/i);
    expect(await fx!.db.prepare('SELECT COUNT(*) n FROM crm_commands').first('n')).toBe(0);

    // D1BudgetExhausted during commit rethrows immediately
    const budgetDb = interceptD1Batches(fx!.db, async (target, stmts, sql) => {
      if (sql.some((s) => /INSERT INTO crm_commands/.test(s))) {
        throw new D1BudgetExhausted();
      }
      return target.batch(stmts);
    });
    const capRegistry = createCommandRegistry(createCapabilityCommandDefs());
    await expect(
      runCommand({
        env: { ...fx!.env, DB: budgetDb },
        executionCtx: ctx,
        actorId: 'owner1',
        tokenHash: ownerHash,
        via: 'ui',
        name: 'capability.grant',
        envelope: {
          requestId: 'req_budget_err_01',
          input: { userId: 'member1', capability: 'crm.access', scope: '*' },
        },
        registry: capRegistry,
      }),
    ).rejects.toBeInstanceOf(D1BudgetExhausted);
  });

  it('proves atomic Records Commit Mode on real D1: empty-todo, read-only expected, missing expected, changes()=1 rollback, historyStatement, committed seq capture, and !authority fence', async () => {
    await setup(false);
    const ownerHash = await tokenHashFor('owner1');
    const now = Date.now();

    const projectCmd: CommandDefinition<
      {
        recordId?: string;
        stage?: string;
        title?: string;
        sideEffectAuditId?: string;
        forceRecordsCommit?: boolean;
      },
      { ok: boolean }
    > = {
      name: 'test.project',
      projectionKeys: ['_crm_stage'],
      authorizeCoarse: () => true,
      parseInput: (raw) => ({ ok: true, input: raw as never }),
      plan: async ({ env, input, expected, requestId }) => ({
        kind: 'commit',
        result: { ok: true },
        fences: [],
        forceRecordsCommit: input.forceRecordsCommit,
        recordExpect: expected ? new Map(expected) : undefined,
        records: input.recordId
          ? [
              {
                id: input.recordId,
                collection: 'tasks',
                patch: {
                  ...(input.stage !== undefined ? { _crm_stage: input.stage } : {}),
                  ...(input.title !== undefined ? { title: input.title } : {}),
                },
                ts: now,
              },
            ]
          : [],
        rows: input.sideEffectAuditId
          ? [
              env.DB.prepare(
                `INSERT INTO crm_capability_audit(id, actor_id, target_user_id, action, capability, scope, before_json, after_json, request_id, created_at)
                 VALUES (?, 'owner1', 'member1', 'grant', 'crm.access', '*', '{}', '{}', ?, ?)`,
              ).bind(input.sideEffectAuditId, requestId, now),
            ]
          : [],
      }),
    };
    const registry = createCommandRegistry([projectCmd]);

    // A. Rejects invalid applyChanges({ commit }) option combinations
    await expect(
      applyChanges(fx!.env, 'owner1', [], { commit: () => [] }),
    ).rejects.toThrow(/commit requires atomic: true/);
    await expect(
      applyChanges(fx!.env, 'owner1', [], {
        atomic: true,
        journal: { id: 'cs1', userId: 'owner1', source: 'mcp', clientName: null, tool: 'test', summary: '', requestId: null, undoes: null, items: [] },
        commit: () => [],
      }),
    ).rejects.toThrow(/commit cannot be combined/);

    // B. Projection + non-_crm_ title write commits atomically inside 45-call D1 budget,
    // captures exact committed records.seq in BOTH returned CommandResult.projections AND crm_commands.result,
    // AND preserves changes() = 1 so historyStatement writes a record_history row (excluding _crm_stage)!
    const scopedEnv = withD1Budget(fx!.env, 45);
    const projRes = await runCommand({
      env: scopedEnv,
      executionCtx: ctx,
      actorId: 'owner1',
      tokenHash: ownerHash,
      via: 'ui',
      name: 'test.project',
      envelope: {
        requestId: 'req_proj_ok_001',
        input: {
          recordId: 'task-p1',
          stage: 'enrolled',
          title: 'Person One Updated',
          sideEffectAuditId: 'audit_proj_ok_01',
        },
        expected: { 'task-p1': 2, 'task-ro': 3 },
      },
      registry,
    });
    expect(45 - d1BudgetRemaining(scopedEnv.DB)).toBeLessThanOrEqual(45);
    expect(projRes.status).toBe(200);
    const parsedProj = commandResultSchema(z.object({ ok: z.boolean() }).strict()).parse(projRes.body);
    const committedRow = await fx!.db
      .prepare("SELECT seq, data FROM records WHERE id = 'task-p1'")
      .first<{ seq: number; data: string }>();
    expect(committedRow!.seq).toBeGreaterThan(3);
    expect(JSON.parse(committedRow!.data)).toMatchObject({
      _crm_stage: 'enrolled',
      title: 'Person One Updated',
    });
    expect(parsedProj.projections).toEqual([{ recordId: 'task-p1', rev: committedRow!.seq }]);

    // Verify stored crm_commands.result JSON has identical committed projections rev!
    const storedJson = await fx!.db
      .prepare("SELECT result FROM crm_commands WHERE request_id = 'req_proj_ok_001'")
      .first<string>('result');
    expect(JSON.parse(storedJson!)).toEqual(parsedProj);

    // Verify historyStatement still observed changes() = 1 and captured title (NOT _crm_stage)!
    const histRow = await fx!.db
      .prepare("SELECT revision, after_json FROM record_history WHERE record_id = 'task-p1' ORDER BY revision DESC LIMIT 1")
      .first<{ revision: number; after_json: string }>();
    expect(histRow).not.toBeNull();
    expect(histRow!.revision).toBe(committedRow!.seq);
    expect(JSON.parse(histRow!.after_json)).toEqual({ title: 'Person One Updated' });

    // C. Empty-todo atomic commit (read-only expected ID + zero record changes) still executes commit batch & persists rows + journal
    const emptyTodoRes = await runCommand({
      env: fx!.env,
      executionCtx: ctx,
      actorId: 'owner1',
      tokenHash: ownerHash,
      via: 'ui',
      name: 'test.project',
      envelope: {
        requestId: 'req_empty_todo_1',
        input: { sideEffectAuditId: 'audit_empty_todo', forceRecordsCommit: true },
        expected: { 'task-ro': 3 },
      },
      registry,
    });
    expect(emptyTodoRes.status).toBe(200);
    expect(emptyTodoRes.body).toMatchObject({ ok: true, projections: [] });
    expect(
      await fx!.db.prepare("SELECT COUNT(*) n FROM crm_capability_audit WHERE id = 'audit_empty_todo'").first('n'),
    ).toBe(1);
    expect(
      await fx!.db.prepare("SELECT COUNT(*) n FROM crm_commands WHERE request_id = 'req_empty_todo_1'").first('n'),
    ).toBe(1);

    // D. Read-only expected record raced concurrently BEFORE commit batch -> strictExpectationGuard aborts & rolls back!
    let roRaced = false;
    const roRaceDb = interceptD1Batches(fx!.db, async (target, stmts, sql) => {
      if (!roRaced && sql.some((s) => /INSERT INTO crm_commands/.test(s))) {
        roRaced = true;
        await fx!.db.prepare("UPDATE records SET seq = seq + 1 WHERE id = 'task-ro'").run();
      }
      return target.batch(stmts);
    });
    const roStale = await runCommand({
      env: { ...fx!.env, DB: roRaceDb },
      executionCtx: ctx,
      actorId: 'owner1',
      tokenHash: ownerHash,
      via: 'ui',
      name: 'test.project',
      envelope: {
        requestId: 'req_ro_stale_01',
        input: { sideEffectAuditId: 'audit_ro_stale_1', forceRecordsCommit: true },
        expected: { 'task-ro': 3 },
      },
      registry,
    });
    expect(CommandErrorSchema.parse(roStale.body)).toMatchObject({ ok: false, error: 'stale', retryable: true });
    expect(
      await fx!.db.prepare("SELECT COUNT(*) n FROM crm_capability_audit WHERE id = 'audit_ro_stale_1'").first('n'),
    ).toBe(0);
    expect(
      await fx!.db.prepare("SELECT COUNT(*) n FROM crm_commands WHERE request_id = 'req_ro_stale_01'").first('n'),
    ).toBe(0);

    // E. Missing expected record causes stale refusal and zero writes
    const missingExp = await runCommand({
      env: fx!.env,
      executionCtx: ctx,
      actorId: 'owner1',
      tokenHash: ownerHash,
      via: 'ui',
      name: 'test.project',
      envelope: {
        requestId: 'req_missing_exp1',
        input: { sideEffectAuditId: 'audit_missing_01', forceRecordsCommit: true },
        expected: { 'does-not-exist': 1 },
      },
      registry,
    });
    expect(CommandErrorSchema.parse(missingExp.body)).toMatchObject({ ok: false, error: 'stale', retryable: true });
    expect(
      await fx!.db.prepare("SELECT COUNT(*) n FROM crm_capability_audit WHERE id = 'audit_missing_01'").first('n'),
    ).toBe(0);

    // F. Simulated 0-row projection write: inject a non-matching WHERE records.seq into stmtFor while strictExpectationGuard passes ->
    // `SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('{', '$') END` detects 0 rows and rolls back ALL CRM rows + journal!
    const currentSeq = committedRow!.seq;
    const zeroRowDb = interceptD1Batches(fx!.db, async (target, stmts, sql) => {
      if (sql.some((s) => /INSERT INTO crm_commands/.test(s))) {
        const idx = sql.findIndex((s) => /INSERT INTO records/i.test(s));
        expect(idx).toBeGreaterThan(-1);
        // Replace the record upsert with an UPDATE that matches 0 rows (same effect as a missed CAS WHERE records.seq=?)
        const tampered = [...stmts];
        tampered[idx] = target.prepare("UPDATE records SET seq = seq WHERE id = 'task-p1' AND seq = -999");
        return target.batch(tampered);
      }
      return target.batch(stmts);
    });
    const zeroRowRes = await runCommand({
      env: { ...fx!.env, DB: zeroRowDb },
      executionCtx: ctx,
      actorId: 'owner1',
      tokenHash: ownerHash,
      via: 'ui',
      name: 'test.project',
      envelope: {
        requestId: 'req_zero_row_01',
        input: {
          recordId: 'task-p1',
          stage: 'should_rollback',
          sideEffectAuditId: 'audit_zero_row_1',
        },
        expected: { 'task-p1': currentSeq },
      },
      registry,
    });
    expect(CommandErrorSchema.parse(zeroRowRes.body)).toMatchObject({ ok: false, error: 'stale', retryable: true });
    // Consequential CRM row AND crm_commands journal BOTH rolled back!
    expect(
      await fx!.db.prepare("SELECT COUNT(*) n FROM crm_capability_audit WHERE id = 'audit_zero_row_1'").first('n'),
    ).toBe(0);
    expect(
      await fx!.db.prepare("SELECT COUNT(*) n FROM crm_commands WHERE request_id = 'req_zero_row_01'").first('n'),
    ).toBe(0);

    // G. Concurrent Track A activation (`access_state.enabled` flips 0 -> 1 before commit) trips `!authority` fence -> stale, zero writes
    let flipped = false;
    const flipDb = interceptD1Batches(fx!.db, async (target, stmts, sql) => {
      if (!flipped && sql.some((s) => /INSERT INTO crm_commands/.test(s))) {
        flipped = true;
        await fx!.db.prepare('UPDATE access_state SET enabled = 1 WHERE id = 1').run();
      }
      return target.batch(stmts);
    });
    const flipRes = await runCommand({
      env: { ...fx!.env, DB: flipDb },
      executionCtx: ctx,
      actorId: 'owner1',
      tokenHash: ownerHash,
      via: 'ui',
      name: 'test.project',
      envelope: {
        requestId: 'req_flip_acc_01',
        input: {
          recordId: 'task-p1',
          stage: 'flip_blocked',
          sideEffectAuditId: 'audit_flip_blk_1',
        },
        expected: { 'task-p1': currentSeq },
      },
      registry,
    });
    expect(CommandErrorSchema.parse(flipRes.body)).toMatchObject({ ok: false, error: 'stale', retryable: true });
    expect(
      await fx!.db.prepare("SELECT COUNT(*) n FROM crm_capability_audit WHERE id = 'audit_flip_blk_1'").first('n'),
    ).toBe(0);
    expect(
      await fx!.db.prepare("SELECT COUNT(*) n FROM crm_commands WHERE request_id = 'req_flip_acc_01'").first('n'),
    ).toBe(0);
  });

  it.each([false, true])(
    'prevents false success on RecordAccessError / authorization failure / unexecuted commit while keeping no-change atomic commands working (permissions=%s, N2)',
    async (permissionsEnabled) => {
      await setup(permissionsEnabled);
      const ownerHash = await tokenHashFor('owner1');
      const now = Date.now();

      const atomicCmd: CommandDefinition<
        {
          recordId?: string;
          stage?: string;
          sideEffectAuditId?: string;
          forceRecordsCommit?: boolean;
        },
        { ok: boolean }
      > = {
        name: 'test.atomic_ro',
        projectionKeys: ['_crm_stage'],
        authorizeCoarse: () => true,
        parseInput: (raw) => ({ ok: true, input: raw as never }),
        plan: async ({ env, input, expected, requestId }) => ({
          kind: 'commit',
          result: { ok: true },
          fences: [],
          forceRecordsCommit: input.forceRecordsCommit,
          recordExpect: expected ? new Map(expected) : undefined,
          records: input.recordId
            ? [
                {
                  id: input.recordId,
                  collection: 'tasks',
                  patch: { _crm_stage: input.stage ?? 'lead' },
                  ts: now,
                },
              ]
            : [],
          rows: input.sideEffectAuditId
            ? [
                env.DB.prepare(
                  `INSERT INTO crm_capability_audit(id, actor_id, target_user_id, action, capability, scope, before_json, after_json, request_id, created_at)
                   VALUES (?, 'owner1', 'member1', 'grant', 'crm.access', '*', '{}', '{}', ?, ?)`,
                ).bind(input.sideEffectAuditId, requestId, now),
              ]
            : [],
        }),
      };
      const registry = createCommandRegistry([atomicCmd]);

      // 1. Successful no-change commands in BOTH permission modes:
      // 1a. Unchanged projection value ('lead' === existing 'lead') still executes commit batch and writes crm_commands + rows.
      const unchangedRes = await runCommand({
        env: fx!.env,
        executionCtx: ctx,
        actorId: 'owner1',
        tokenHash: ownerHash,
        via: 'ui',
        name: 'test.atomic_ro',
        envelope: {
          requestId: 'req_noop_proj1',
          input: { recordId: 'task-p1', stage: 'lead', sideEffectAuditId: 'audit_noop_proj1' },
          expected: { 'task-p1': 2 },
        },
        registry,
      });
      expect(unchangedRes.status).toBe(200);
      expect(unchangedRes.body).toMatchObject({ ok: true, projections: [] });
      expect(
        await fx!.db.prepare("SELECT COUNT(*) n FROM crm_commands WHERE request_id = 'req_noop_proj1'").first('n'),
      ).toBe(1);
      expect(
        await fx!.db.prepare("SELECT COUNT(*) n FROM crm_capability_audit WHERE id = 'audit_noop_proj1'").first('n'),
      ).toBe(1);

      // 1b. Empty incoming mutation list with valid read-only expected record commits journal + rows.
      const emptyValidRes = await runCommand({
        env: fx!.env,
        executionCtx: ctx,
        actorId: 'owner1',
        tokenHash: ownerHash,
        via: 'ui',
        name: 'test.atomic_ro',
        envelope: {
          requestId: 'req_empty_ok_1',
          input: { sideEffectAuditId: 'audit_empty_ok_1' },
          expected: { 'task-ro': 3 },
        },
        registry,
      });
      expect(emptyValidRes.status).toBe(200);
      expect(emptyValidRes.body).toMatchObject({ ok: true, projections: [] });
      expect(
        await fx!.db.prepare("SELECT COUNT(*) n FROM crm_commands WHERE request_id = 'req_empty_ok_1'").first('n'),
      ).toBe(1);
      expect(
        await fx!.db.prepare("SELECT COUNT(*) n FROM crm_capability_audit WHERE id = 'audit_empty_ok_1'").first('n'),
      ).toBe(1);

      if (permissionsEnabled) {
        // 2. Empty incoming mutation list + read-only expected record: trigger RecordAccessError('access_reset_required')
        // by bumping task-ro.seq right AFTER readWriteSnapshot and BEFORE loadScopeGraph!
        const raw = fx!.db;
        let bumpedForApply = false;
        const driftDbForApply = interceptD1Batches(raw, async (target, stmts, sql) => {
          const res = await target.batch(stmts);
          if (!bumpedForApply && sql.some((s) => /SELECT enabled FROM access_state/i.test(s))) {
            bumpedForApply = true;
            await raw.prepare("UPDATE records SET seq = seq + 1 WHERE id = 'task-ro'").run();
          }
          return res;
        });

        let commitInvoked = false;
        const directApply = await applyChanges(
          { ...fx!.env, DB: driftDbForApply },
          'owner1',
          [],
          {
            atomic: true,
            expect: new Map([['task-ro', 3]]),
            commit: () => {
              commitInvoked = true;
              return [];
            },
          },
        );
        expect(bumpedForApply).toBe(true);
        expect(commitInvoked).toBe(false);
        expect(directApply.committed).not.toBe(true);
        expect(directApply.authorizationError).toBe('access_reset_required');
        expect(directApply.rejected).toBeGreaterThan(0);
        expect(directApply.rejectedItems).toEqual([
          { id: 'task-ro', collection: '', reason: 'access_changed_retry' },
        ]);

        // Same race through runCommand must NEVER return false { ok: true }!
        const curRoSeq = (await raw.prepare("SELECT seq FROM records WHERE id = 'task-ro'").first<number>('seq'))!;
        let bumpedForCmd = false;
        const driftDbForCmd = interceptD1Batches(raw, async (target, stmts, sql) => {
          const res = await target.batch(stmts);
          if (!bumpedForCmd && sql.some((s) => /SELECT enabled FROM access_state/i.test(s))) {
            bumpedForCmd = true;
            await raw.prepare("UPDATE records SET seq = seq + 1 WHERE id = 'task-ro'").run();
          }
          return res;
        });
        const cmdDriftRes = await runCommand({
          env: { ...fx!.env, DB: driftDbForCmd },
          executionCtx: ctx,
          actorId: 'owner1',
          tokenHash: ownerHash,
          via: 'ui',
          name: 'test.atomic_ro',
          envelope: {
            requestId: 'req_ro_drift_1',
            input: { sideEffectAuditId: 'audit_ro_drift_1' },
            expected: { 'task-ro': curRoSeq },
          },
          registry,
        });
        expect(bumpedForCmd).toBe(true);
        expect(cmdDriftRes.status).toBe(200);
        expect(CommandErrorSchema.parse(cmdDriftRes.body)).toMatchObject({
          ok: false,
          error: 'stale',
          retryable: true,
        });
        expect(
          await raw.prepare("SELECT COUNT(*) n FROM crm_commands WHERE request_id = 'req_ro_drift_1'").first('n'),
        ).toBe(0);
        expect(
          await raw.prepare("SELECT COUNT(*) n FROM crm_capability_audit WHERE id = 'audit_ro_drift_1'").first('n'),
        ).toBe(0);

        // 3. Empty incoming + empty expected (`forceRecordsCommit: true`) where access_state.enabled flips 1 -> 0
        // between readWriteSnapshot and loadAccessContext -> RecordAccessError('access_reset_required') -> stale, 0 writes!
        let flippedOff = false;
        const flipOffDb = interceptD1Batches(raw, async (target, stmts, sql) => {
          const res = await target.batch(stmts);
          if (!flippedOff && sql.some((s) => /SELECT enabled FROM access_state/i.test(s))) {
            flippedOff = true;
            await raw.prepare('UPDATE access_state SET enabled = 0 WHERE id = 1').run();
          }
          return res;
        });
        const flipOffRes = await runCommand({
          env: { ...fx!.env, DB: flipOffDb },
          executionCtx: ctx,
          actorId: 'owner1',
          tokenHash: ownerHash,
          via: 'ui',
          name: 'test.atomic_ro',
          envelope: {
            requestId: 'req_flip_off_1',
            input: { sideEffectAuditId: 'audit_flip_off_1', forceRecordsCommit: true },
          },
          registry,
        });
        expect(flippedOff).toBe(true);
        expect(CommandErrorSchema.parse(flipOffRes.body)).toMatchObject({
          ok: false,
          error: 'stale',
          retryable: true,
        });
        expect(
          await raw.prepare("SELECT COUNT(*) n FROM crm_commands WHERE request_id = 'req_flip_off_1'").first('n'),
        ).toBe(0);
        expect(
          await raw.prepare("SELECT COUNT(*) n FROM crm_capability_audit WHERE id = 'audit_flip_off_1'").first('n'),
        ).toBe(0);
        await raw.prepare('UPDATE access_state SET enabled = 1 WHERE id = 1').run();

        // 4. Unauthorized read-only expected record in a private space with empty incoming -> forbidden (never false success!)
        await raw.batch([
          raw.prepare("INSERT INTO spaces(id, name, default_access, created_at) VALUES ('space-priv', 'Private', 'private', 1)"),
          raw.prepare(
            `INSERT INTO records(id, collection, data, field_ts, seq, space_id)
             VALUES ('board-priv', 'boards', '{"name":"Secret"}', '{"name":1}', 10, 'space-priv'),
                    ('task-priv', 'tasks', '{"title":"Secret","boardId":"board-priv","status":"todo"}', '{"title":1}', 11, 'space-priv')`,
          ),
          raw.prepare(
            "INSERT INTO crm_capability_grants(user_id, capability, scope, granted_by, granted_at) VALUES ('member1', 'crm.access', '*', 'owner1', 1)",
          ),
        ]);
        const memberHash = await tokenHashFor('member1');
        const privRes = await runCommand({
          env: fx!.env,
          executionCtx: ctx,
          actorId: 'member1',
          tokenHash: memberHash,
          via: 'ui',
          name: 'test.atomic_ro',
          envelope: {
            requestId: 'req_priv_exp_1',
            input: { sideEffectAuditId: 'audit_priv_exp_1' },
            expected: { 'task-priv': 11 },
          },
          registry,
        });
        expect(privRes.status).toBe(200);
        expect(CommandErrorSchema.parse(privRes.body)).toMatchObject({
          ok: false,
          error: 'forbidden',
          retryable: false,
        });
        expect(
          await raw.prepare("SELECT COUNT(*) n FROM crm_commands WHERE request_id = 'req_priv_exp_1'").first('n'),
        ).toBe(0);
        expect(
          await raw.prepare("SELECT COUNT(*) n FROM crm_capability_audit WHERE id = 'audit_priv_exp_1'").first('n'),
        ).toBe(0);

        // 5. RecordAccessError('scope_graph_budget') with empty incoming + read-only expected -> budget_exceeded (never false success!)
        let budgetHit = false;
        const graphBudgetDb = interceptD1Batches(raw, async (target, stmts, sql) => {
          if (!budgetHit && sql.some((s) => /WITH RECURSIVE scope_graph/i.test(s))) {
            budgetHit = true;
            return [
              {
                success: true,
                meta: {} as D1Result['meta'],
                results: Array.from({ length: 5001 }, (_, i) => ({
                  id: `synthetic-${i}`,
                  collection: 'pages',
                  data: '{}',
                  seq: 1,
                  space_id: 'space-core',
                })),
              },
            ];
          }
          return target.batch(stmts);
        });
        const latestRoSeq = (await raw.prepare("SELECT seq FROM records WHERE id = 'task-ro'").first<number>('seq'))!;
        const budgetCmdRes = await runCommand({
          env: { ...fx!.env, DB: graphBudgetDb },
          executionCtx: ctx,
          actorId: 'owner1',
          tokenHash: ownerHash,
          via: 'ui',
          name: 'test.atomic_ro',
          envelope: {
            requestId: 'req_graph_bgt1',
            input: { sideEffectAuditId: 'audit_graph_bgt1' },
            expected: { 'task-ro': latestRoSeq },
          },
          registry,
        });
        expect(budgetHit).toBe(true);
        expect(budgetCmdRes.status).toBe(200);
        expect(CommandErrorSchema.parse(budgetCmdRes.body)).toMatchObject({
          ok: false,
          error: 'budget_exceeded',
          retryable: false,
        });
        expect(
          await raw.prepare("SELECT COUNT(*) n FROM crm_commands WHERE request_id = 'req_graph_bgt1'").first('n'),
        ).toBe(0);
        expect(
          await raw.prepare("SELECT COUNT(*) n FROM crm_capability_audit WHERE id = 'audit_graph_bgt1'").first('n'),
        ).toBe(0);
      }
    },
  );
});
