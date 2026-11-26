import { afterEach, describe, expect, it } from 'vitest';
import { crmApi } from '../worker/crm';
import { pollCrmChannelAccount, processCrmOutbox, runCrmScheduledSweep } from '../worker/crm/channels';
import { sendViaZohoMail } from '../worker/crm/adapters/zohoMail';
import { ChannelsOverviewResponseSchema } from '../shared/crm/channels';
import { d1BudgetRemaining, withD1Budget } from '../worker/d1budget';
import { openAuditFixture, ctx, type AuditFixture } from './audit-fixture';

let fx: AuditFixture | undefined;
afterEach(async () => {
  await fx?.dispose();
  fx = undefined;
});

async function setupFixture(opts: { localTest?: boolean; extraEnv?: Record<string, string> } = {}) {
  fx = await openAuditFixture(
    [
      { id: 'owner1', role: 'admin' },
      { id: 'admin1', role: 'admin' },
      { id: 'sender1', role: 'member' },
      { id: 'reader1', role: 'member' },
    ],
    {
      CRM_ENABLED: '1',
      ...(opts.localTest !== false ? { WORKSPACE_ENV: 'local-test' } : {}),
      ...(opts.extraEnv ?? {}),
    },
  );

  await fx.db.batch([
    fx.db.prepare("UPDATE users SET workspace_role = CASE id WHEN 'owner1' THEN 'owner' WHEN 'admin1' THEN 'admin' ELSE 'member' END"),
    fx.db.prepare(
      `INSERT INTO crm_capability_grants (user_id, capability, scope, granted_by, granted_at)
       VALUES
         ('admin1', 'crm.access', '*', 'owner1', 1),
         ('admin1', 'crm.channels.manage', '*', 'owner1', 1),
         ('admin1', 'crm.send:email', '*', 'owner1', 1),
         ('sender1', 'crm.access', '*', 'owner1', 1),
         ('sender1', 'crm.send:email', '*', 'owner1', 1),
         ('reader1', 'crm.access', '*', 'owner1', 1)`,
    ),
    fx.db.prepare(
      `INSERT INTO records (id, collection, data, field_ts, seq, space_id, updated_at)
       VALUES
         ('board-people', 'boards', '{"name":"People","templateDbKey":"people","fields":[]}', '{"name":1}', 1, 'space-core', 100),
         ('person-a', 'tasks', '{"boardId":"board-people","title":"Tara Patel"}', '{"boardId":1,"title":1}', 1, 'space-core', 100),
         ('person-b', 'tasks', '{"boardId":"board-people","title":"Kabir Nair"}', '{"boardId":1,"title":1}', 2, 'space-core', 100)`,
    ),
    fx.db.prepare(
      `INSERT INTO crm_endpoints (id, person_id, kind, value_raw, value_norm, is_primary, source, created_by, created_at, updated_at)
       VALUES
         ('ep-a-em', 'person-a', 'email', 'tara@example.org', 'tara@example.org', 1, 'manual', 'owner1', 100, 100),
         ('ep-b-em', 'person-b', 'email', 'kabir@example.org', 'kabir@example.org', 1, 'manual', 'owner1', 100, 100)`,
    ),
  ]);
}

async function reqCrm(path: string, opts: { method?: string; actor?: string; body?: unknown } = {}) {
  const scoped = withD1Budget(fx!.env, 45);
  const res = await crmApi.request(
    path,
    {
      method: opts.method ?? 'GET',
      headers: fx!.auth(opts.actor ?? 'admin1'),
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    },
    scoped,
    ctx,
  );
  expect(45 - d1BudgetRemaining(scoped.DB)).toBeLessThanOrEqual(45);
  return res;
}

describe('CRM S5 Zoho Mail Adapter, RFC 5322 Threading, Durable Polling & Outbox Review (D1)', () => {
  it('configures Zoho Mail disabled by default, polls with durable cursor & lease, threads strictly by RFC 5322 headers (never subject-only), and dedupes replays', async () => {
    await setupFixture({ localTest: true });

    // Non-admin sender cannot configure channel account
    const deniedCfg = await reqCrm('/commands/channel.configure', {
      method: 'POST',
      actor: 'sender1',
      body: {
        requestId: 'zoho_cfg_deny_01',
        input: {
          channel: 'email',
          provider: 'email_zoho',
          label: 'Contact Desk',
          externalId: 'contact@riverbank.example',
        },
      },
    });
    expect(await deniedCfg.json()).toMatchObject({ ok: false, error: 'forbidden' });

    // Admin configures Zoho Mail account: defaults to mode='disabled', active=false
    const cfgRes = await reqCrm('/commands/channel.configure', {
      method: 'POST',
      actor: 'admin1',
      body: {
        requestId: 'zoho_cfg_01',
        input: {
          channel: 'email',
          provider: 'email_zoho',
          label: 'Riverbank Contact Desk',
          externalId: 'contact@riverbank.example',
          config: { dataCenter: 'in', fromAddress: 'contact@riverbank.example' },
        },
      },
    });
    const cfgJson = (await cfgRes.json()) as { ok: boolean; result: { account: { id: string; mode: string; active: boolean; rev: number } } };
    expect(cfgJson).toMatchObject({ ok: true, result: { account: { mode: 'disabled', active: false } } });
    const accountId = cfgJson.result.account.id;

    // Cannot activate production without bound secret & zohoAccountId (O-20 guard)
    const prodBlocked = await reqCrm('/commands/channel.set_mode', {
      method: 'POST',
      actor: 'admin1',
      body: {
        requestId: 'zoho_prod_block',
        input: { accountId, mode: 'production', active: true },
      },
    });
    expect(await prodBlocked.json()).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'secret_name_required_for_production' },
    });

    // Polling while disabled refuses cleanly
    const disabledPoll = await reqCrm('/commands/channel.poll_now', {
      method: 'POST',
      actor: 'admin1',
      body: { requestId: 'zoho_poll_disabled', input: { accountId } },
    });
    expect(await disabledPoll.json()).toMatchObject({ ok: false, error: 'provider_unavailable' });

    // Switch to simulated mode in local-test
    const simOn = await reqCrm('/commands/channel.set_mode', {
      method: 'POST',
      actor: 'admin1',
      body: { requestId: 'zoho_sim_on', input: { accountId, mode: 'simulated', active: true } },
    });
    expect(await simOn.json()).toMatchObject({ ok: true, result: { account: { mode: 'simulated', active: true, healthState: 'connected' } } });

    // Poll 3 emails:
    //  - msg1 from Tara ("Workshop enquiry", rfc <m1@ext.org>)
    //  - msg2 from Kabir with IDENTICAL subject ("Workshop enquiry", NO In-Reply-To) -> MUST create a SEPARATE thread (never subject-only threading!)
    //  - msg3 from Tara replying with In-Reply-To: <m1@ext.org> (even with changed subject!) -> MUST attach to Tara's existing thread!
    const poll1 = await reqCrm('/commands/channel.poll_now', {
      method: 'POST',
      actor: 'admin1',
      body: {
        requestId: 'zoho_poll_01',
        input: {
          accountId,
          simulatedMessages: [
            {
              externalEventId: 'zoho_ev_1',
              rfcMessageId: '<m1@ext.org>',
              fromAddress: 'tara@example.org',
              subject: 'Workshop enquiry',
              bodyText: 'Hello, asking about the autumn workshop.',
              receivedAt: 1_700_000_001_000,
            },
            {
              externalEventId: 'zoho_ev_2',
              rfcMessageId: '<m2@ext.org>',
              fromAddress: 'kabir@example.org',
              subject: 'Workshop enquiry',
              bodyText: 'Hi, different person with same subject!',
              receivedAt: 1_700_000_002_000,
            },
            {
              externalEventId: 'zoho_ev_3',
              rfcMessageId: '<m3@ext.org>',
              inReplyTo: '<m1@ext.org>',
              references: ['<m1@ext.org>'],
              fromAddress: 'tara@example.org',
              subject: 'Re: Follow up question',
              bodyText: 'One more question on the same thread.',
              receivedAt: 1_700_000_003_000,
            },
          ],
        },
      },
    });
    expect(await poll1.json()).toMatchObject({
      ok: true,
      result: { ingested: 3, duplicatesSkipped: 0, cursor: '1700000003000', healthState: 'connected' },
    });

    // Verify 2 distinct conversations (Tara has 2 messages, Kabir has 1 message)
    const convs = (await fx!.db.prepare('SELECT id, person_id, last_rfc_message_id FROM crm_conversations ORDER BY created_at ASC').all()).results as {
      id: string;
      person_id: string;
      last_rfc_message_id: string;
    }[];
    expect(convs).toHaveLength(2);
    const taraConv = convs.find((c) => c.person_id === 'person-a')!;
    const kabirConv = convs.find((c) => c.person_id === 'person-b')!;
    expect(taraConv.id).not.toBe(kabirConv.id);
    expect(taraConv.last_rfc_message_id).toBe('<m3@ext.org>');
    expect(await fx!.db.prepare('SELECT COUNT(*) n FROM crm_messages WHERE conversation_id = ?').bind(taraConv.id).first('n')).toBe(2);
    expect(await fx!.db.prepare('SELECT COUNT(*) n FROM crm_messages WHERE conversation_id = ?').bind(kabirConv.id).first('n')).toBe(1);

    // Re-polling exact same events dedupes cleanly with 0 duplicate messages!
    const pollReplay = await reqCrm('/commands/channel.poll_now', {
      method: 'POST',
      actor: 'admin1',
      body: {
        requestId: 'zoho_poll_replay',
        input: {
          accountId,
          simulatedMessages: [
            {
              externalEventId: 'zoho_ev_1',
              rfcMessageId: '<m1@ext.org>',
              fromAddress: 'tara@example.org',
              subject: 'Workshop enquiry',
              bodyText: 'Hello, asking about the autumn workshop.',
              receivedAt: 1_700_000_001_000,
            },
          ],
        },
      },
    });
    expect(await pollReplay.json()).toMatchObject({ ok: true, result: { ingested: 0, duplicatesSkipped: 1 } });

    // Outbound reply on Tara's email thread automatically carries RFC In-Reply-To = <m3@ext.org> and stores rfc_message_id
    const replyRes = await reqCrm('/commands/message.send', {
      method: 'POST',
      actor: 'sender1',
      body: {
        requestId: 'zoho_reply_01',
        input: { conversationId: taraConv.id, bodyText: 'Thanks Tara! Here are the verified details.' },
      },
    });
    const replyJson = (await replyRes.json()) as { ok: boolean; result: { message: { id: string; status: string; inReplyTo: string; rfcMessageId: string } } };
    expect(replyJson.ok).toBe(true);
    expect(replyJson.result.message.status).toBe('sent');
    expect(replyJson.result.message.inReplyTo).toBe('<m3@ext.org>');
    expect(replyJson.result.message.rfcMessageId).toMatch(/^<crm-msg_.*@riverbank\.example>$/);
  });

  it('handles queued outbox exponential backoff, retry cap, expired lease -> review_required, ambiguous delivery review & human resolution', async () => {
    await setupFixture({ localTest: true });

    // Configure simulated Zoho Mail with 'transient_fail' behavior
    const cfgRes = await reqCrm('/commands/channel.configure', {
      method: 'POST',
      actor: 'admin1',
      body: {
        requestId: 'ob_cfg_transient',
        input: {
          channel: 'email',
          provider: 'email_zoho',
          label: 'Transient Zoho',
          externalId: 'desk@riverbank.example',
          mode: 'simulated',
          active: true,
          config: { dataCenter: 'in', fromAddress: 'desk@riverbank.example', simulatedBehavior: 'transient_fail' },
        },
      },
    });
    const accountId = ((await cfgRes.json()) as { result: { account: { id: string } } }).result.account.id;

    // Seed email conversation
    await fx!.db
      .prepare(
        `INSERT INTO crm_conversations (id, channel, channel_account_id, person_id, subject, state, last_message_at, rev, created_at, updated_at)
         VALUES ('conv-em-1', 'email', ?, 'person-a', 'Backoff test', 'open', 1000, 1, 1000, 1000)`,
      )
      .bind(accountId)
      .run();

    // 1. Send with deliveryMode: 'queued' -> queued in outbox
    const qSend = await reqCrm('/commands/message.send', {
      method: 'POST',
      actor: 'sender1',
      body: {
        requestId: 'ob_send_queued_01',
        input: { conversationId: 'conv-em-1', bodyText: 'Queued email test', deliveryMode: 'queued' },
      },
    });
    const qJson = (await qSend.json()) as { ok: boolean; result: { message: { id: string; status: string } } };
    expect(qJson).toMatchObject({ ok: true, result: { message: { status: 'queued' } } });
    const msgId = qJson.result.message.id;

    // Attempt 1 -> transient_fail -> requeued with +30s backoff
    const t0 = Date.now() + 1_000;
    const sweep1 = await processCrmOutbox(fx!.env, t0);
    expect(sweep1).toMatchObject({ attempted: 1, requeued: 1, failed: 0 });
    const ob1 = await fx!.db.prepare('SELECT status, attempts, next_attempt_at FROM crm_outbox WHERE message_id = ?').bind(msgId).first<{ status: string; attempts: number; next_attempt_at: number }>();
    expect(ob1).toMatchObject({ status: 'queued', attempts: 1 });
    expect(ob1!.next_attempt_at).toBe(t0 + 30_000);

    // Before backoff elapses, sweep does NOT re-attempt
    expect((await processCrmOutbox(fx!.env, t0 + 10_000)).attempted).toBe(0);

    // Attempt 2 (+30s) -> requeued (+120s); Attempt 3 (+150s) -> hits max_attempts (3) -> terminal failed!
    expect(await processCrmOutbox(fx!.env, t0 + 30_000)).toMatchObject({ attempted: 1, requeued: 1 });
    expect(await processCrmOutbox(fx!.env, t0 + 150_000)).toMatchObject({ attempted: 1, failed: 1 });
    expect(await fx!.db.prepare('SELECT status FROM crm_messages WHERE id = ?').bind(msgId).first('status')).toBe('failed');

    // 2. Ambiguous outcome ('ambiguous') -> moves directly to review_required, NEVER blindly retried by cron!
    await reqCrm('/commands/channel.configure', {
      method: 'POST',
      actor: 'admin1',
      body: {
        requestId: 'ob_cfg_ambiguous',
        input: {
          accountId,
          channel: 'email',
          provider: 'email_zoho',
          label: 'Ambiguous Zoho',
          externalId: 'desk@riverbank.example',
          mode: 'simulated',
          active: true,
          config: { dataCenter: 'in', fromAddress: 'desk@riverbank.example', simulatedBehavior: 'ambiguous' },
        },
      },
    });

    const ambSend = await reqCrm('/commands/message.send', {
      method: 'POST',
      actor: 'sender1',
      body: {
        requestId: 'ob_send_ambig_01',
        input: { conversationId: 'conv-em-1', bodyText: 'Ambiguous outcome test' },
      },
    });
    const ambJson = (await ambSend.json()) as { ok: boolean; result: { message: { id: string; status: string }; receiptId: string } };
    expect(ambJson).toMatchObject({ ok: true, result: { message: { status: 'review_required' }, receiptId: 'review_required' } });
    const ambMsgId = ambJson.result.message.id;

    // Outbox sweep NEVER retries review_required!
    const sweepAfterAmb = await runCrmScheduledSweep(fx!.env, Date.now() + 600_000);
    expect(sweepAfterAmb.outbox.attempted).toBe(0);

    // Direct message.retry on review_required MUST refuse stale until human resolves!
    const blockedRetry = await reqCrm('/commands/message.retry', {
      method: 'POST',
      actor: 'sender1',
      body: { requestId: 'ob_retry_blocked_review', input: { messageId: ambMsgId } },
    });
    expect(await blockedRetry.json()).toMatchObject({ ok: false, error: 'stale', detail: { reason: 'message_not_retryable' } });

    // Channels overview read reports reviewRequired count and delivery details
    const overviewRes = await reqCrm('/read/channels', { actor: 'admin1' });
    expect(overviewRes.status).toBe(200);
    const overview = ChannelsOverviewResponseSchema.parse(await overviewRes.json());
    expect(overview.counts.reviewRequired).toBe(1);
    expect(overview.counts.failed).toBe(1);

    // Reader without crm.send:email cannot resolve review
    const deniedResolve = await reqCrm('/commands/message.resolve_review', {
      method: 'POST',
      actor: 'reader1',
      body: { requestId: 'ob_resolve_deny', input: { messageId: ambMsgId, resolution: 'confirm_sent' } },
    });
    expect(await deniedResolve.json()).toMatchObject({ ok: false, error: 'forbidden' });

    // Human sender resolves review as 'confirm_sent' with provider receipt after verifying in Zoho Sent folder
    const resolveOk = await reqCrm('/commands/message.resolve_review', {
      method: 'POST',
      actor: 'sender1',
      body: {
        requestId: 'ob_resolve_ok_01',
        input: {
          messageId: ambMsgId,
          resolution: 'confirm_sent',
          providerReceipt: 'zoho_confirmed_9911',
          note: 'Verified present in Zoho Sent folder',
        },
      },
    });
    expect(await resolveOk.json()).toMatchObject({
      ok: true,
      result: { messageId: ambMsgId, status: 'sent', providerReceipt: 'zoho_confirmed_9911' },
    });
    expect(await fx!.db.prepare('SELECT status, external_message_id FROM crm_messages WHERE id = ?').bind(ambMsgId).first()).toMatchObject({
      status: 'sent',
      external_message_id: 'zoho_confirmed_9911',
    });

    // 3. Expired 'sending' lease moves to review_required cleanly (never blind resend!)
    await fx!.db.batch([
      fx!.db.prepare(
        `INSERT INTO crm_messages (id, conversation_id, direction, status, channel, recipient_endpoint, body_text, created_at, updated_at)
         VALUES ('msg-stale-lease', 'conv-em-1', 'outbound', 'sending', 'email', 'tara@example.org', 'Crash mid-send', 1000, 1000)`,
      ),
      fx!.db.prepare(
        `INSERT INTO crm_outbox (id, message_id, conversation_id, channel_account_id, actor_id, request_id, status, purpose, attempts, max_attempts, lease_until, created_at, updated_at)
         VALUES ('ob-stale-lease', 'msg-stale-lease', 'conv-em-1', ?, 'sender1', 'req-stale', 'sending', 'transactional', 1, 3, 5000, 1000, 1000)`,
      ).bind(accountId),
    ]);
    const expSweep = await processCrmOutbox(fx!.env, 10_000);
    expect(expSweep.expiredMovedToReview).toBe(1);
    expect(await fx!.db.prepare("SELECT status FROM crm_outbox WHERE id = 'ob-stale-lease'").first('status')).toBe('review_required');
    expect(await fx!.db.prepare("SELECT status FROM crm_messages WHERE id = 'msg-stale-lease'").first('status')).toBe('review_required');
  });

  it('verifies Zoho Mail adapter request shape under local-test mock fetch, exact DC host allowlist, redirect:error, HTTP 5xx -> ambiguous, and G3 production block', async () => {
    await setupFixture({
      localTest: true,
      extraEnv: {
        ZOHO_MAIL_TEST_SECRET: JSON.stringify({ accessToken: '1000.test_access_token' }),
      },
    });

    const calls: { url: string; init: RequestInit }[] = [];
    const mockFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ status: { code: 200 }, data: { messageId: '9876543210' } }), { status: 200 });
    };

    const account = {
      id: 'ch_zoho_prod',
      channel: 'email' as const,
      provider: 'email_zoho' as const,
      label: 'Prod Zoho',
      external_id: 'contact@thecommonground.example',
      mode: 'production' as const,
      active: 1,
      secret_name: 'ZOHO_MAIL_TEST_SECRET',
      config_json: JSON.stringify({
        dataCenter: 'in',
        zohoAccountId: '44556677',
        fromAddress: 'contact@thecommonground.example',
      }),
      poll_cursor: null,
      poll_lease_until: null,
      last_poll_at: null,
      health_state: 'connected' as const,
      last_error: null,
      last_error_at: null,
      rev: 1,
      created_by: 'owner1',
      created_at: 100,
      updated_at: 100,
    };

    const okRes = await sendViaZohoMail(
      fx!.env,
      {
        account,
        config: { dataCenter: 'in', zohoAccountId: '44556677', fromAddress: 'contact@thecommonground.example' },
        channel: 'email',
        messageId: 'msg_z1',
        conversationId: 'conv_z1',
        subject: 'Re: Residency enquiry',
        recipientEndpoint: 'tara@example.org',
        bodyText: 'Hello Tara',
        idempotencyKey: 'req_z1',
        inReplyTo: '<parent@ext.org>',
        now: 1_700_000_000_000,
      },
      mockFetch,
    );
    expect(okRes).toMatchObject({ ok: true, externalId: '9876543210' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://mail.zoho.in/api/accounts/44556677/messages');
    expect(calls[0]!.init.redirect).toBe('error');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Zoho-oauthtoken 1000.test_access_token');
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      fromAddress: 'contact@thecommonground.example',
      toAddress: 'tara@example.org',
      mailFormat: 'plaintext',
      askReceipt: 'no',
      inReplyTo: '<parent@ext.org>',
    });

    // HTTP 503 after POST submit MUST return { unknown: true } (never blind retry!)
    const ambRes = await sendViaZohoMail(
      fx!.env,
      {
        account,
        config: { dataCenter: 'in', zohoAccountId: '44556677', fromAddress: 'contact@thecommonground.example' },
        channel: 'email',
        messageId: 'msg_z2',
        conversationId: 'conv_z1',
        subject: 'Re: Residency enquiry',
        recipientEndpoint: 'tara@example.org',
        bodyText: 'Second reply',
        idempotencyKey: 'req_z2',
        now: 1_700_000_000_001,
      },
      async () => new Response('upstream timeout', { status: 503 }),
    );
    expect(ambRes).toMatchObject({ unknown: true });

    // Poll lease prevents double-polling while lease is active
    await fx!.db
      .prepare(
        `INSERT INTO crm_channel_accounts (id, channel, provider, label, external_id, mode, active, config_json, poll_lease_until, health_state, rev, created_by, created_at, updated_at)
         VALUES ('ch_leased', 'email', 'email_zoho', 'Leased', 'leased@example.org', 'production', 1, '{}', 9999999999999, 'connected', 1, 'owner1', 100, 100)`,
      )
      .run();
    const locked = await pollCrmChannelAccount(fx!.env, 'ch_leased', 1_700_000_000_000);
    expect(locked).toMatchObject({ ok: true, leased: false, ingested: 0 });
  });
});
