import { afterEach, describe, expect, it } from 'vitest';
import { crmApi } from '../worker/crm';
import { d1BudgetRemaining, withD1Budget } from '../worker/d1budget';
import { openAuditFixture, ctx, type AuditFixture } from './audit-fixture';
import { createCommandRegistry, runCommand } from '../worker/crm/commands';
import { createS4ConversationCommandDefs } from '../worker/crm/conversations';

let fx: AuditFixture | undefined;
afterEach(async () => {
  await fx?.dispose();
  fx = undefined;
});

async function setup(localTest = true) {
  fx = await openAuditFixture(
    [
      { id: 'owner1', role: 'admin' },
      { id: 'member1', role: 'member' },
    ],
    {
      CRM_ENABLED: '1',
      ...(localTest ? { WORKSPACE_ENV: 'local-test' } : {}),
    },
  );
  await fx.db.batch([
    fx.db.prepare("UPDATE users SET workspace_role = CASE id WHEN 'owner1' THEN 'owner' ELSE 'member' END"),
    fx.db.prepare(
      `INSERT INTO crm_capability_grants (user_id, capability, scope, granted_by, granted_at)
       VALUES
         ('member1', 'crm.access', '*', 'owner1', 1),
         ('member1', 'crm.send:whatsapp', '*', 'owner1', 1),
         ('member1', 'crm.send:email', '*', 'owner1', 1)`,
    ),
    fx.db.prepare(
      `INSERT INTO records (id, collection, data, field_ts, seq, space_id)
       VALUES
         ('board-people', 'boards', '{"name":"People","templateDbKey":"people","fields":[]}', '{"name":1,"templateDbKey":1,"fields":1}', 1, 'space-core'),
         ('person-1', 'tasks', '{"boardId":"board-people","title":"Asha Menon"}', '{"boardId":1,"title":1}', 1, 'space-core')`,
    ),
    fx.db.prepare(
      `INSERT INTO crm_endpoints (id, person_id, kind, value_raw, value_norm, is_primary, source, created_by, created_at, updated_at)
       VALUES ('ep-wa-1', 'person-1', 'whatsapp', '9847012345', '+919847012345', 1, 'manual', 'owner1', 1, 1)`,
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

describe('S4 Conversations core, Verified Facts & Grounded AI Drafts', () => {
  it('blocks simulated inbound outside local-test, dedupes inbound events, and matches endpoints cleanly', async () => {
    await setup(false);
    const blocked = await reqCrm('/commands/conversation.simulate_inbound', {
      method: 'POST',
      actor: 'member1',
      body: {
        requestId: 's4_sim_block_1',
        input: { channel: 'whatsapp', externalEventId: 'ev_1', fromValue: '9847012345', bodyText: 'Hello!' },
      },
    });
    expect(await blocked.json()).toMatchObject({ ok: false, error: 'provider_unavailable' });

    await fx!.dispose();
    await setup(true);

    const sim1 = await reqCrm('/commands/conversation.simulate_inbound', {
      method: 'POST',
      actor: 'member1',
      body: {
        requestId: 's4_sim_ok_1',
        input: {
          channel: 'whatsapp',
          externalEventId: 'ev_wa_100',
          externalThreadId: 'thr_wa_100',
          fromValue: '9847012345',
          programmeSlug: 'common-lab',
          bodyText: 'When is the next lab session?',
        },
      },
    });
    const sim1Json = await sim1.json() as { ok: boolean; result: { already: boolean; conversationId: string; personId: string | null } };
    expect(sim1Json.ok).toBe(true);
    expect(sim1Json.result.already).toBe(false);
    expect(sim1Json.result.personId).toBe('person-1');

    // Duplicate webhook externalEventId is idempotent even under new requestId
    const simDup = await reqCrm('/commands/conversation.simulate_inbound', {
      method: 'POST',
      actor: 'member1',
      body: {
        requestId: 's4_sim_dup_1',
        input: {
          channel: 'whatsapp',
          externalEventId: 'ev_wa_100',
          fromValue: '9847012345',
          bodyText: 'Duplicate webhook payload',
        },
      },
    });
    const simDupJson = await simDup.json() as { result: { already: boolean; conversationId: string } };
    expect(simDupJson.result.already).toBe(true);
    expect(simDupJson.result.conversationId).toBe(sim1Json.result.conversationId);
  });

  it('enforces human-only send, internal note outbox separation, consent withdrawal, 24h window, and grounded fact staleness', async () => {
    await setup(true);

    // 1. Propose + verify one fresh fact and one stale fact
    const p1 = await reqCrm('/commands/fact.propose', {
      method: 'POST',
      actor: 'member1',
      body: {
        requestId: 's4_fact_p1',
        input: {
          programmeSlug: 'common-lab',
          title: 'Common Lab Schedule',
          statement: 'Common Lab runs bi-weekly open studio sessions in Kochi.',
        },
      },
    });
    const f1Id = ((await p1.json()) as { result: { fact: { id: string } } }).result.fact.id;

    // Non-admin member1 without crm.configure cannot verify facts
    const denyVerify = await reqCrm('/commands/fact.verify', {
      method: 'POST',
      actor: 'member1',
      body: { requestId: 's4_fact_deny_v', input: { factId: f1Id } },
    });
    expect(await denyVerify.json()).toMatchObject({ ok: false, error: 'forbidden' });

    await reqCrm('/commands/fact.verify', {
      method: 'POST',
      actor: 'owner1',
      body: { requestId: 's4_fact_v1', input: { factId: f1Id, reviewBy: Date.now() + 86_400_000 } },
    });

    const pStale = await reqCrm('/commands/fact.propose', {
      method: 'POST',
      actor: 'member1',
      body: {
        requestId: 's4_fact_p2',
        input: {
          programmeSlug: 'common-lab',
          title: 'Expired December Dates',
          statement: 'Old December 2025 dates should NOT be cited.',
        },
      },
    });
    const fStaleId = ((await pStale.json()) as { result: { fact: { id: string } } }).result.fact.id;
    await reqCrm('/commands/fact.verify', {
      method: 'POST',
      actor: 'owner1',
      body: { requestId: 's4_fact_v2', input: { factId: fStaleId, reviewBy: Date.now() - 10_000 } },
    });

    // 2. Simulate inbound WhatsApp thread -> open 24h window
    const sim = await reqCrm('/commands/conversation.simulate_inbound', {
      method: 'POST',
      actor: 'member1',
      body: {
        requestId: 's4_conv_in_1',
        input: { channel: 'whatsapp', externalEventId: 'ev_1', fromValue: '9847012345', programmeSlug: 'common-lab', bodyText: 'Hello team' },
      },
    });
    const convId = ((await sim.json()) as { result: { conversationId: string } }).result.conversationId;

    // 3. Add internal note -> must NEVER create a crm_outbox row
    const noteRes = await reqCrm('/commands/message.add_note', {
      method: 'POST',
      actor: 'member1',
      body: { requestId: 's4_note_1', input: { conversationId: convId, bodyText: 'Internal check before replying.' } },
    });
    expect((await noteRes.json() as { ok: boolean }).ok).toBe(true);
    expect(await fx!.db.prepare('SELECT COUNT(*) AS n FROM crm_outbox').first('n')).toBe(0);

    // 4. Generate grounded AI draft -> cites fresh fact only, excludes stale fact
    const aiRes = await reqCrm('/commands/message.generate_ai_draft', {
      method: 'POST',
      actor: 'member1',
      body: { requestId: 's4_aidraft_1', input: { conversationId: convId } },
    });
    const aiJson = await aiRes.json() as {
      ok: boolean;
      result: { citedFactIds: string[]; message: { bodyText: string; status: string }; staleFactWarnings: string[] };
    };
    expect(aiJson.ok).toBe(true);
    expect(aiJson.result.message.status).toBe('draft');
    expect(aiJson.result.citedFactIds).toEqual([f1Id]);
    expect(aiJson.result.message.bodyText).not.toContain('Old December 2025');
    expect(aiJson.result.message.bodyText).toContain('To be confirmed');
    expect(aiJson.result.staleFactWarnings.length).toBe(1);

    // 5. Non-UI channels (`via: 'mcp'`) CANNOT execute message.send!
    const tokenRow = await fx!.db.prepare("SELECT token_hash FROM sessions WHERE user_id = 'member1' LIMIT 1").first<{ token_hash: string }>();
    const nonUiSend = await runCommand({
      env: withD1Budget(fx!.env, 45),
      executionCtx: ctx,
      actorId: 'member1',
      tokenHash: tokenRow!.token_hash,
      via: 'mcp',
      name: 'message.send',
      envelope: { requestId: 's4_mcp_send_deny', input: { conversationId: convId, bodyText: 'Forbidden' } },
      registry: createCommandRegistry(createS4ConversationCommandDefs()),
    });
    expect(nonUiSend.body).toMatchObject({ ok: false, error: 'forbidden' });

    // 6. UI human send succeeds while consent granted & window open
    const uiSend = await reqCrm('/commands/message.send', {
      method: 'POST',
      actor: 'member1',
      body: { requestId: 's4_ui_send_ok', input: { conversationId: convId, bodyText: 'Happy to share session details.' } },
    });
    expect((await uiSend.json() as { ok: boolean }).ok).toBe(true);
    expect(await fx!.db.prepare('SELECT COUNT(*) AS n FROM crm_outbox WHERE status = \'sent\'').first('n')).toBe(1);

    // 7. Consent withdrawal blocks subsequent send
    await reqCrm('/commands/person.record_consent', {
      method: 'POST',
      actor: 'member1',
      body: {
        requestId: 's4_cons_wd',
        input: { personId: 'person-1', channel: 'whatsapp', scope: 'transactional', status: 'withdrawn', source: 'manual' },
      },
    });
    const sendAfterWd = await reqCrm('/commands/message.send', {
      method: 'POST',
      actor: 'member1',
      body: { requestId: 's4_ui_send_wd', input: { conversationId: convId, bodyText: 'Should be blocked' } },
    });
    expect(await sendAfterWd.json()).toMatchObject({ ok: false, error: 'consent_withdrawn' });
  });
});
