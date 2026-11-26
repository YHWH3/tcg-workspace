import { afterEach, describe, expect, it } from 'vitest';
import { parseRawRfcHeaders } from '../shared/crm/channels';
import type { Env } from '../worker/auth';
import { withD1Budget } from '../worker/d1budget';
import { computeHmacSha256Hex } from '../worker/crm/adapters/types';
import { pollZohoMailInbound, sendViaZohoMail } from '../worker/crm/adapters/zohoMail';
import {
  ingestChannelInboundEvents,
  pollCrmChannelAccount,
  processCrmOutbox,
} from '../worker/crm/channels';
import { runCommand } from '../worker/crm/commands';
import { createS0CommandRegistry } from '../worker/crm/index';
import { crmWebhooksApi } from '../worker/crm/webhooks';
import { openAuditFixture, ctx, type AuditFixture } from './audit-fixture';

let fx: AuditFixture | undefined;

afterEach(async () => {
  await fx?.dispose();
  fx = undefined;
});

async function setupFixture(workspaceEnv = 'local-test', extraEnv: Record<string, string> = {}) {
  fx = await openAuditFixture(
    [
      { id: 'owner1', role: 'admin' },
      { id: 'member1', role: 'member' },
    ],
    {
      CRM_ENABLED: '1',
      WORKSPACE_ENV: workspaceEnv,
      ...(extraEnv as Record<string, string>),
    } as Partial<Env>,
  );
  const now = Date.now();
  await fx.db.batch([
    fx.db.prepare(`UPDATE users SET workspace_role = 'owner', role = 'admin' WHERE id = 'owner1'`),
    fx.db.prepare(`UPDATE users SET workspace_role = 'member', role = 'member' WHERE id = 'member1'`),
    fx.db
      .prepare(
        `INSERT INTO crm_capability_grants (user_id, capability, scope, granted_by, granted_at)
         VALUES ('member1', 'crm.access', '*', 'owner1', ?)`,
      )
      .bind(now),
  ]);
  const ownerRow = await fx.db
    .prepare(`SELECT token_hash FROM sessions WHERE user_id = 'owner1' LIMIT 1`)
    .first<{ token_hash: string }>();
  const memberRow = await fx.db
    .prepare(`SELECT token_hash FROM sessions WHERE user_id = 'member1' LIMIT 1`)
    .first<{ token_hash: string }>();
  return {
    fx,
    owner: { userId: 'owner1', token: fx.token('owner1'), tokenHash: ownerRow!.token_hash },
    member: { userId: 'member1', token: fx.token('member1'), tokenHash: memberRow!.token_hash },
  };
}

async function seedPersonWithEndpoint(
  f: AuditFixture,
  id: string,
  title: string,
  channel: 'email' | 'whatsapp' | 'instagram' | 'facebook',
  value: string,
  now = Date.now(),
) {
  await f.db
    .prepare(
      `INSERT INTO records (id, collection, data, field_ts, seq, updated_at, space_id)
       VALUES (?, 'tasks', ?, '{}', 1, ?, 'space-core')`,
    )
    .bind(id, JSON.stringify({ boardId: 'db_people', title }), now)
    .run();
  await f.db
    .prepare(
      `INSERT INTO crm_endpoints (id, person_id, kind, value_raw, value_norm, is_primary, verified_at, retired_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, NULL, NULL, 'owner1', ?, ?)`,
    )
    .bind(`ep_${id}_${channel}`, id, channel, value, value.toLowerCase(), now, now)
    .run();
}

describe('P3 communications hardening (review findings 1-8)', () => {
  it('1) prevents inbound event loss under tight D1 budget (poll cursor stays bounded; webhook returns 503)', async () => {
    const waSecret = JSON.stringify({ accessToken: 'tok', appSecret: 'sec_budget', verifyToken: 'vt' });
    const s = await setupFixture('local-test', { WA_BUDGET_SEC: waSecret });
    const reg = createS0CommandRegistry();

    const zohoCfg = await runCommand({
      env: s.fx.env,
      executionCtx: ctx,
      actorId: s.owner.userId,
      tokenHash: s.owner.tokenHash,
      via: 'ui',
      name: 'channel.configure',
      envelope: {
        requestId: 'p3h_zoho_cfg',
        input: {
          channel: 'email',
          provider: 'email_zoho',
          label: 'Zoho Budget Test',
          externalId: 'desk@example.org',
          mode: 'simulated',
          active: true,
          config: { dataCenter: 'in', fromAddress: 'desk@example.org' },
        },
      },
      registry: reg,
    });
    expect(zohoCfg.status).toBe(200);
    const zohoAccId = (zohoCfg.body as { result: { account: { id: string } } }).result.account.id;

    // Tight budget (12 D1 calls): enough to claim lease + ingest fewer than 3 messages
    const tightEnv: Env = withD1Budget(s.fx.env, 12);
    const t1 = 1_760_000_001_000;
    const t2 = 1_760_000_002_000;
    const t3 = 1_760_000_003_000;
    const poll = await pollCrmChannelAccount(tightEnv, zohoAccId, t3, {
      limit: 5,
      simulatedMessages: [
        { externalEventId: 'ev_b1', fromAddress: 'a@example.org', subject: 'One', bodyText: 'Msg 1', receivedAt: t1 },
        { externalEventId: 'ev_b2', fromAddress: 'b@example.org', subject: 'Two', bodyText: 'Msg 2', receivedAt: t2 },
        { externalEventId: 'ev_b3', fromAddress: 'c@example.org', subject: 'Three', bodyText: 'Msg 3', receivedAt: t3 },
      ],
    });
    expect(poll.ok).toBe(true);
    if (poll.ok) {
      expect(poll.ingested).toBeLessThan(3);
      expect(poll.cursor).not.toBe(String(t3));
    }

    // Webhook tight budget -> MUST return 503 retryable, never 200 OK!
    const waCfg = await runCommand({
      env: s.fx.env,
      executionCtx: ctx,
      actorId: s.owner.userId,
      tokenHash: s.owner.tokenHash,
      via: 'ui',
      name: 'channel.configure',
      envelope: {
        requestId: 'p3h_wa_cfg',
        input: {
          channel: 'whatsapp',
          provider: 'whatsapp_cloud',
          label: 'WA Budget',
          externalId: 'pn_budget_1',
          mode: 'simulated',
          active: true,
          secretName: 'WA_BUDGET_SEC',
          config: { phoneNumberId: 'pn_budget_1' },
        },
      },
      registry: reg,
    });
    expect(waCfg.status).toBe(200);

    const payload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'pn_budget_1', display_phone_number: '+919999900001' },
                messages: [
                  { id: 'wamid.b1', from: '919876543210', timestamp: '1760000010', type: 'text', text: { body: 'Hi 1' } },
                  { id: 'wamid.b2', from: '919876543210', timestamp: '1760000011', type: 'text', text: { body: 'Hi 2' } },
                  { id: 'wamid.b3', from: '919876543210', timestamp: '1760000012', type: 'text', text: { body: 'Hi 3' } },
                ],
              },
            },
          ],
        },
      ],
    });
    const sig = 'sha256=' + (await computeHmacSha256Hex(new TextEncoder().encode(payload), 'sec_budget'));
    const tightWebhookEnv: Env = withD1Budget(s.fx.env, 8);
    const res = await crmWebhooksApi.fetch(
      new Request('https://example.test/whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig },
        body: payload,
      }),
      tightWebhookEnv,
      ctx,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error: string; retryable: boolean };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('processing_budget');
    expect(body.retryable).toBe(true);
  });

  it('2) distinguishes real DB failures from duplicate-event conflicts', async () => {
    const s = await setupFixture('local-test');
    const failingDb = {
      prepare: (sql: string) => {
        if (sql.includes('SELECT id FROM crm_inbound_events')) {
          return { bind: () => ({ first: async () => null }) };
        }
        return s.fx.db.prepare(sql);
      },
      batch: async () => {
        throw new Error('D1_ERROR: disk I/O failure');
      },
    } as unknown as D1Database;

    const brokenEnv: Env = { ...s.fx.env, DB: failingDb };
    await expect(
      ingestChannelInboundEvents(
        brokenEnv,
        null,
        [
          {
            kind: 'message',
            externalEventId: 'ev_disk_fail',
            channel: 'email',
            fromEndpoint: 'fail@example.org',
            bodyText: 'Should throw, not count as duplicate',
            receivedAt: Date.now(),
            rawHashInput: { id: 'ev_disk_fail' },
          },
        ],
        Date.now(),
      ),
    ).rejects.toThrow(/disk I\/O failure/);
  });

  it('3 & 4) revalidates sender authority/endpoint/account before dispatch and fences stale outbox leases', async () => {
    const s = await setupFixture('local-test');
    const reg = createS0CommandRegistry();
    const now = Date.now();
    await seedPersonWithEndpoint(s.fx, 'p_outbox_1', 'Ananya Rao', 'email', 'ananya@example.org', now);

    await s.fx.db
      .prepare(
        `INSERT INTO crm_capability_grants (user_id, capability, scope, granted_by, granted_at)
         VALUES ('member1', 'crm.send:email', '*', 'owner1', ?)`,
      )
      .bind(now)
      .run();

    const accRes = await runCommand({
      env: s.fx.env,
      executionCtx: ctx,
      actorId: s.owner.userId,
      tokenHash: s.owner.tokenHash,
      via: 'ui',
      name: 'channel.configure',
      envelope: {
        requestId: 'p3h_acc_1',
        input: {
          channel: 'email',
          provider: 'email_zoho',
          label: 'Desk Sim',
          externalId: 'desk1@example.org',
          mode: 'simulated',
          active: true,
          config: { dataCenter: 'in', fromAddress: 'desk1@example.org' },
        },
      },
      registry: reg,
    });
    const accId = (accRes.body as { result: { account: { id: string } } }).result.account.id;

    await s.fx.db.batch([
      s.fx.db
        .prepare(
          `INSERT INTO crm_conversations (id, channel, channel_account_id, external_thread_id, person_id, subject, state, last_message_at, rev, created_at, updated_at)
           VALUES ('conv_auth_rev', 'email', ?, NULL, 'p_outbox_1', 'Auth test', 'open', ?, 1, ?, ?)`,
        )
        .bind(accId, now, now, now),
      s.fx.db
        .prepare(
          `INSERT INTO crm_messages (id, conversation_id, direction, status, channel, recipient_endpoint, author_user_id, body_text, created_at, updated_at)
           VALUES ('msg_auth_rev', 'conv_auth_rev', 'outbound', 'queued', 'email', 'ananya@example.org', 'member1', 'Hello', ?, ?)`,
        )
        .bind(now, now),
      s.fx.db
        .prepare(
          `INSERT INTO crm_outbox (id, message_id, conversation_id, channel_account_id, actor_id, request_id, status, purpose, attempts, max_attempts, next_attempt_at, created_at, updated_at)
           VALUES ('ob_auth_rev', 'msg_auth_rev', 'conv_auth_rev', ?, 'member1', 'req_auth_rev', 'queued', 'transactional', 0, 3, ?, ?, ?)`,
        )
        .bind(accId, now - 1000, now, now),
    ]);

    // Revoke member1's crm.send:email BEFORE outbox runs -> cancelled without dispatch!
    await s.fx.db
      .prepare(`DELETE FROM crm_capability_grants WHERE user_id = 'member1' AND capability = 'crm.send:email'`)
      .run();

    const sweep = await processCrmOutbox(s.fx.env, now);
    expect(sweep.cancelled).toBe(1);
    expect(sweep.sent).toBe(0);
    const ob = await s.fx.db
      .prepare(`SELECT status, last_error FROM crm_outbox WHERE id = 'ob_auth_rev'`)
      .first<{ status: string; last_error: string }>();
    expect(ob).toEqual({ status: 'cancelled', last_error: 'sender_authority_revoked' });

    // Stale outbox worker lease fence: mid-send lease expiry moves row to review_required -> late worker CANNOT overwrite!
    await seedPersonWithEndpoint(s.fx, 'p_wa_fence', 'Kabir', 'whatsapp', '+919876543211', now);
    await s.fx.db.batch([
      s.fx.db
        .prepare(
          `INSERT INTO crm_channel_accounts (id, channel, provider, label, external_id, mode, active, config_json, health_state, rev, created_by, created_at, updated_at)
           VALUES ('ch_wa_fence', 'whatsapp', 'whatsapp_cloud', 'WA Fence', 'pn_fence', 'simulated', 1, '{"phoneNumberId":"pn_fence"}', 'connected', 1, 'owner1', ?, ?)`,
        )
        .bind(now, now),
      s.fx.db
        .prepare(
          `INSERT INTO crm_conversations (id, channel, channel_account_id, external_thread_id, person_id, subject, state, window_expires_at, last_message_at, rev, created_at, updated_at)
           VALUES ('conv_wa_fence', 'whatsapp', 'ch_wa_fence', 'ch_wa_fence:+919876543211', 'p_wa_fence', 'WA Fence', 'open', ?, ?, 1, ?, ?)`,
        )
        .bind(now + 600_000, now, now, now),
      s.fx.db
        .prepare(
          `INSERT INTO crm_messages (id, conversation_id, direction, status, channel, recipient_endpoint, author_user_id, body_text, created_at, updated_at)
           VALUES ('msg_wa_fence', 'conv_wa_fence', 'outbound', 'queued', 'whatsapp', '+919876543211', 'owner1', 'Mid-send lease theft', ?, ?)`,
        )
        .bind(now, now),
      s.fx.db
        .prepare(
          `INSERT INTO crm_outbox (id, message_id, conversation_id, channel_account_id, actor_id, request_id, status, purpose, attempts, max_attempts, next_attempt_at, created_at, updated_at)
           VALUES ('ob_wa_fence', 'msg_wa_fence', 'conv_wa_fence', 'ch_wa_fence', 'owner1', 'req_wa_fence', 'queued', 'transactional', 0, 3, ?, ?, ?)`,
        )
        .bind(now - 1000, now, now),
    ]);

    const fenceSweep = await processCrmOutbox(s.fx.env, now, {
      overrides: {
        whatsappSender: async () => {
          await s.fx.db.batch([
            s.fx.db.prepare(`UPDATE crm_outbox SET status = 'review_required', lease_until = NULL WHERE id = 'ob_wa_fence'`),
            s.fx.db.prepare(`UPDATE crm_messages SET status = 'review_required' WHERE id = 'msg_wa_fence'`),
          ]);
          return { ok: true, externalId: 'wamid.stale_late_ack' };
        },
      },
    });
    expect(fenceSweep.sent).toBe(0);
    const fencedMsg = await s.fx.db
      .prepare(`SELECT status FROM crm_messages WHERE id = 'msg_wa_fence'`)
      .first<{ status: string }>();
    const fencedOb = await s.fx.db
      .prepare(`SELECT status FROM crm_outbox WHERE id = 'ob_wa_fence'`)
      .first<{ status: string }>();
    expect(fencedMsg?.status).toBe('review_required');
    expect(fencedOb?.status).toBe('review_required');
  });

  it('5 & 6) enforces monotonic receipts, non-regressing windows, and strict receiving-account webhook validation', async () => {
    const waSecret = JSON.stringify({ accessToken: 'tok', appSecret: 'sec_acc_scope', verifyToken: 'vt' });
    const s = await setupFixture('local-test', { WA_SCOPE_SEC: waSecret });
    const reg = createS0CommandRegistry();

    const acc1Res = await runCommand({
      env: s.fx.env,
      executionCtx: ctx,
      actorId: s.owner.userId,
      tokenHash: s.owner.tokenHash,
      via: 'ui',
      name: 'channel.configure',
      envelope: {
        requestId: 'p3h_scope_a1',
        input: {
          channel: 'whatsapp',
          provider: 'whatsapp_cloud',
          label: 'WA Desk 1',
          externalId: 'pn_desk_1',
          mode: 'simulated',
          active: true,
          secretName: 'WA_SCOPE_SEC',
          config: { phoneNumberId: 'pn_desk_1' },
        },
      },
      registry: reg,
    });
    expect(acc1Res.status).toBe(200);

    // Webhook with UNMATCHED phone_number_id MUST be rejected with 403, NEVER associated with pn_desk_1!
    const badPayload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'pn_rogue_999' },
                messages: [{ id: 'wamid.rogue', from: '919800000001', timestamp: '1760000100', type: 'text', text: { body: 'Rogue' } }],
              },
            },
          ],
        },
      ],
    });
    const badSig = 'sha256=' + (await computeHmacSha256Hex(new TextEncoder().encode(badPayload), 'sec_acc_scope'));
    const badRes = await crmWebhooksApi.fetch(
      new Request('https://example.test/whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': badSig },
        body: badPayload,
      }),
      s.fx.env,
      ctx,
    );
    expect(badRes.status).toBe(403);
    expect(((await badRes.json()) as { error: string }).error).toBe('unmatched_receiving_account');

    // Deliver newer message first (t=2000), then reordered older message (t=1000) -> window MUST NOT regress!
    const newerPayload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'pn_desk_1' },
                messages: [{ id: 'wamid.new', from: '919800000002', timestamp: '1760002000', type: 'text', text: { body: 'Newer' } }],
              },
            },
          ],
        },
      ],
    });
    const newerSig = 'sha256=' + (await computeHmacSha256Hex(new TextEncoder().encode(newerPayload), 'sec_acc_scope'));
    const r1 = await crmWebhooksApi.fetch(
      new Request('https://example.test/whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': newerSig },
        body: newerPayload,
      }),
      s.fx.env,
      ctx,
    );
    expect(r1.status).toBe(200);
    const convAfterNew = await s.fx.db
      .prepare(`SELECT id, window_expires_at FROM crm_conversations WHERE channel = 'whatsapp' LIMIT 1`)
      .first<{ id: string; window_expires_at: number }>();
    expect(convAfterNew?.window_expires_at).toBe(1760002000 * 1000 + 24 * 60 * 60 * 1000);

    const olderPayload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'pn_desk_1' },
                messages: [{ id: 'wamid.old', from: '919800000002', timestamp: '1760001000', type: 'text', text: { body: 'Older' } }],
              },
            },
          ],
        },
      ],
    });
    const olderSig = 'sha256=' + (await computeHmacSha256Hex(new TextEncoder().encode(olderPayload), 'sec_acc_scope'));
    const r2 = await crmWebhooksApi.fetch(
      new Request('https://example.test/whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': olderSig },
        body: olderPayload,
      }),
      s.fx.env,
      ctx,
    );
    expect(r2.status).toBe(200);
    const convAfterOld = await s.fx.db
      .prepare(`SELECT window_expires_at FROM crm_conversations WHERE id = ?`)
      .bind(convAfterNew!.id)
      .first<{ window_expires_at: number }>();
    expect(convAfterOld?.window_expires_at).toBe(convAfterNew!.window_expires_at);
  });

  it('7 & 8) fences manual poll/outbox idempotency and blocks Zoho production pending G3 + parses raw RFC headers', async () => {
    const hdr = parseRawRfcHeaders(
      'Message-Id: <zoho-123@mail.zoho.in>\r\nIn-Reply-To: <parent-1@example.org>\r\nReferences: <root-0@example.org>\r\n <parent-1@example.org>\r\n',
    );
    expect(hdr).toEqual({
      messageId: '<zoho-123@mail.zoho.in>',
      inReplyTo: '<parent-1@example.org>',
      references: ['<root-0@example.org>', '<parent-1@example.org>'],
    });

    const s = await setupFixture('production', {
      ZOHO_PROD_SEC: JSON.stringify({ accessToken: 'fake-never-used' }),
    });
    const reg = createS0CommandRegistry();

    const prodZohoCfg = await runCommand({
      env: s.fx.env,
      executionCtx: ctx,
      actorId: s.owner.userId,
      tokenHash: s.owner.tokenHash,
      via: 'ui',
      name: 'channel.configure',
      envelope: {
        requestId: 'p3h_zoho_g3_block',
        input: {
          channel: 'email',
          provider: 'email_zoho',
          label: 'Zoho Prod',
          externalId: 'hello@tcg.example',
          mode: 'production',
          active: true,
          secretName: 'ZOHO_PROD_SEC',
          config: { dataCenter: 'in', zohoAccountId: '123456', fromAddress: 'hello@tcg.example' },
        },
      },
      registry: reg,
    });
    expect(prodZohoCfg.status).toBe(200);
    expect(prodZohoCfg.body).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'zoho_production_pending_G3' },
    });

    let fetched = 0;
    const fakeAcc = {
      id: 'ch_z',
      channel: 'email' as const,
      provider: 'email_zoho' as const,
      label: 'Z',
      external_id: 'hello@tcg.example',
      mode: 'production' as const,
      active: 1,
      secret_name: 'ZOHO_PROD_SEC',
      config_json: JSON.stringify({ dataCenter: 'in', zohoAccountId: '123456', fromAddress: 'hello@tcg.example' }),
      poll_cursor: null,
      poll_lease_until: null,
      last_poll_at: null,
      health_state: 'disconnected' as const,
      last_error: null,
      last_error_at: null,
      rev: 1,
      created_by: s.owner.userId,
      created_at: 1,
      updated_at: 1,
    };
    const sendBlocked = await sendViaZohoMail(
      s.fx.env,
      {
        account: fakeAcc,
        config: { dataCenter: 'in', zohoAccountId: '123456', fromAddress: 'hello@tcg.example' },
        channel: 'email',
        messageId: 'm1',
        conversationId: 'c1',
        subject: 'Hi',
        recipientEndpoint: 'to@example.org',
        bodyText: 'Hello',
        idempotencyKey: 'k1',
        now: Date.now(),
      },
      async () => {
        fetched += 1;
        return new Response('{}');
      },
    );
    expect(sendBlocked).toEqual({ ok: false, errorClass: 'auth', detail: 'zoho_production_pending_G3' });
    const pollBlocked = await pollZohoMailInbound(
      s.fx.env,
      fakeAcc,
      { cursor: null, limit: 5, now: Date.now() },
      async () => {
        fetched += 1;
        return new Response('{}');
      },
    );
    expect(pollBlocked).toEqual({ ok: false, errorClass: 'auth', detail: 'zoho_production_pending_G3' });
    expect(fetched).toBe(0);

    const rFirst = await runCommand({
      env: s.fx.env,
      executionCtx: ctx,
      actorId: s.owner.userId,
      tokenHash: s.owner.tokenHash,
      via: 'ui',
      name: 'outbox.process_now',
      envelope: { requestId: 'p3h_outbox_idem_1', input: { limit: 5 } },
      registry: reg,
    });
    expect(rFirst.status).toBe(200);
    expect((rFirst.body as { ok: boolean }).ok).toBe(true);
    const rReplay = await runCommand({
      env: s.fx.env,
      executionCtx: ctx,
      actorId: s.owner.userId,
      tokenHash: s.owner.tokenHash,
      via: 'ui',
      name: 'outbox.process_now',
      envelope: { requestId: 'p3h_outbox_idem_1', input: { limit: 5 } },
      registry: reg,
    });
    expect(rReplay.status).toBe(200);
    expect(rReplay.body).toEqual(rFirst.body);
  });
});
