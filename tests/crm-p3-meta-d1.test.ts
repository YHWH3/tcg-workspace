import { afterEach, describe, expect, it } from 'vitest';
import { crmApi } from '../worker/crm';
import { crmWebhooksApi } from '../worker/crm/webhooks';
import { computeHmacSha256Hex } from '../worker/crm/adapters/types';
import { sendViaWhatsAppCloud } from '../worker/crm/adapters/whatsappCloud';
import { sendViaMetaMessaging } from '../worker/crm/adapters/metaMessaging';
import { d1BudgetRemaining, withD1Budget } from '../worker/d1budget';
import { openAuditFixture, ctx, type AuditFixture } from './audit-fixture';

let fx: AuditFixture | undefined;
afterEach(async () => {
  await fx?.dispose();
  fx = undefined;
});

const WA_SECRET = JSON.stringify({
  accessToken: 'wa_test_tok',
  appSecret: 'wa_app_secret_0123456789',
  verifyToken: 'wa_verify_token_abc',
});
const IG_SECRET = JSON.stringify({
  accessToken: 'ig_test_tok',
  appSecret: 'ig_app_secret_0123456789',
  verifyToken: 'ig_verify_token_abc',
});
const FB_SECRET = JSON.stringify({
  accessToken: 'fb_test_tok',
  appSecret: 'fb_app_secret_0123456789',
  verifyToken: 'fb_verify_token_abc',
});

async function setupFixture() {
  fx = await openAuditFixture(
    [
      { id: 'owner1', role: 'admin' },
      { id: 'admin1', role: 'admin' },
      { id: 'agent1', role: 'member' },
    ],
    {
      CRM_ENABLED: '1',
      WORKSPACE_ENV: 'local-test',
      ...({
        WA_TEST_SECRET: WA_SECRET,
        IG_TEST_SECRET: IG_SECRET,
        FB_TEST_SECRET: FB_SECRET,
      } as Record<string, string>),
    },
  );

  await fx.db.batch([
    fx.db.prepare("UPDATE users SET workspace_role = CASE id WHEN 'owner1' THEN 'owner' WHEN 'admin1' THEN 'admin' ELSE 'member' END"),
    fx.db.prepare(
      `INSERT INTO crm_capability_grants (user_id, capability, scope, granted_by, granted_at)
       VALUES
         ('admin1', 'crm.access', '*', 'owner1', 1),
         ('admin1', 'crm.channels.manage', '*', 'owner1', 1),
         ('admin1', 'crm.send:whatsapp', '*', 'owner1', 1),
         ('admin1', 'crm.send:instagram', '*', 'owner1', 1),
         ('admin1', 'crm.send:facebook', '*', 'owner1', 1),
         ('agent1', 'crm.access', '*', 'owner1', 1),
         ('agent1', 'crm.send:whatsapp', '*', 'owner1', 1),
         ('agent1', 'crm.send:instagram', '*', 'owner1', 1),
         ('agent1', 'crm.send:facebook', '*', 'owner1', 1)`,
    ),
    fx.db.prepare(
      `INSERT INTO records (id, collection, data, field_ts, seq, space_id, updated_at)
       VALUES
         ('board-people', 'boards', '{"name":"People","templateDbKey":"people","fields":[]}', '{"name":1}', 1, 'space-core', 100),
         ('person-wa', 'tasks', '{"boardId":"board-people","title":"Meera Rao"}', '{"boardId":1,"title":1}', 1, 'space-core', 100),
         ('person-wa-alias', 'tasks', '{"boardId":"board-people","title":"Meera Old","archived":true,"_crm_merged_into":"person-wa"}', '{"boardId":1,"title":1}', 2, 'space-core', 100),
         ('person-ig', 'tasks', '{"boardId":"board-people","title":"Rohan Dev"}', '{"boardId":1,"title":1}', 3, 'space-core', 100),
         ('person-fb', 'tasks', '{"boardId":"board-people","title":"Devika Sen"}', '{"boardId":1,"title":1}', 4, 'space-core', 100)`,
    ),
    fx.db.prepare(
      `INSERT INTO crm_person_aliases (alias_id, survivor_id, merge_id, effective_at, created_by, created_at)
       VALUES ('person-wa-alias', 'person-wa', 'mrg_seed_1', 50, 'owner1', 50)`,
    ),
    fx.db.prepare(
      `INSERT INTO crm_endpoints (id, person_id, kind, value_raw, value_norm, is_primary, source, created_by, created_at, updated_at)
       VALUES
         ('ep-wa-1', 'person-wa-alias', 'whatsapp', '+919876543210', '+919876543210', 1, 'manual', 'owner1', 100, 100),
         ('ep-wa-surv', 'person-wa', 'whatsapp', '+919876543211', '+919876543211', 1, 'manual', 'owner1', 100, 100),
         ('ep-ig-1', 'person-ig', 'instagram', 'igsid:17841400999', 'igsid:17841400999', 1, 'manual', 'owner1', 100, 100),
         ('ep-fb-1', 'person-fb', 'facebook', 'psid:2244668800', 'psid:2244668800', 1, 'manual', 'owner1', 100, 100)`,
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

async function postSignedWebhook(provider: 'whatsapp' | 'instagram' | 'facebook', payload: unknown, appSecret: string, tamperSig = false) {
  const raw = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(raw);
  const hex = await computeHmacSha256Hex(bytes, tamperSig ? 'wrong_secret' : appSecret);
  const scoped = withD1Budget(fx!.env, 45);
  const res = await crmWebhooksApi.request(
    `/${provider}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${hex}`,
      },
      body: raw,
    },
    scoped,
    ctx,
  );
  expect(45 - d1BudgetRemaining(scoped.DB)).toBeLessThanOrEqual(45);
  return res;
}

describe('CRM S11 WhatsApp Cloud API & S12 Instagram/Facebook Messaging (D1)', () => {
  it('handles WhatsApp signed webhooks, alias matching, 24h window vs approved template lifecycle, monotonic read receipts, and STOP opt-out cancellation', async () => {
    await setupFixture();

    // 1. Webhook is 404 before channel account is active
    const unconfGet = await crmWebhooksApi.request(
      '/whatsapp?hub.mode=subscribe&hub.verify_token=wa_verify_token_abc&hub.challenge=chal_1',
      { method: 'GET' },
      fx!.env,
      ctx,
    );
    expect(unconfGet.status).toBe(404);

    // 2. Configure simulated WhatsApp Cloud account
    const cfgRes = await reqCrm('/commands/channel.configure', {
      method: 'POST',
      actor: 'admin1',
      body: {
        requestId: 'wa_cfg_01',
        input: {
          channel: 'whatsapp',
          provider: 'whatsapp_cloud',
          label: 'Riverbank WhatsApp',
          externalId: '+919800000001',
          mode: 'simulated',
          active: true,
          secretName: 'WA_TEST_SECRET',
          config: { phoneNumberId: '100200300' },
        },
      },
    });
    expect(await cfgRes.json()).toMatchObject({ ok: true });

    // 3. GET handshake verifies token & rejects wrong token
    const badHandshake = await crmWebhooksApi.request(
      '/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=chal_1',
      { method: 'GET' },
      fx!.env,
      ctx,
    );
    expect(badHandshake.status).toBe(403);
    const okHandshake = await crmWebhooksApi.request(
      '/whatsapp?hub.mode=subscribe&hub.verify_token=wa_verify_token_abc&hub.challenge=chal_999',
      { method: 'GET' },
      fx!.env,
      ctx,
    );
    expect(okHandshake.status).toBe(200);
    expect(await okHandshake.text()).toBe('chal_999');

    // 4. Signed inbound message from merged alias number (+919876543210) resolves canonical person-wa!
    const waPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { display_phone_number: '+919800000001', phone_number_id: '100200300' },
                messages: [
                  {
                    id: 'wamid.inbound.001',
                    from: '919876543210',
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: 'Hi, when does the pottery retreat start?' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    // Tampered signature -> 401
    expect((await postSignedWebhook('whatsapp', waPayload, 'wa_app_secret_0123456789', true)).status).toBe(401);

    // Valid signature -> 200 & matches canonical person-wa
    const inOk = await postSignedWebhook('whatsapp', waPayload, 'wa_app_secret_0123456789');
    expect(inOk.status).toBe(200);
    expect(await inOk.json()).toMatchObject({ ok: true, ingested: 1, duplicatesSkipped: 0 });

    // Replay exact same wamid -> idempotent dedupe!
    const inDup = await postSignedWebhook('whatsapp', waPayload, 'wa_app_secret_0123456789');
    expect(await inDup.json()).toMatchObject({ ok: true, ingested: 0, duplicatesSkipped: 1 });

    const conv = await fx!.db
      .prepare("SELECT id, person_id, window_expires_at FROM crm_conversations WHERE channel = 'whatsapp' LIMIT 1")
      .first<{ id: string; person_id: string; window_expires_at: number }>();
    expect(conv?.person_id).toBe('person-wa');
    expect(conv!.window_expires_at).toBeGreaterThan(Date.now());

    // 5. Close 24h window -> free-form send refused with window_closed!
    await fx!.db
      .prepare('UPDATE crm_conversations SET window_expires_at = ? WHERE id = ?')
      .bind(Date.now() - 60_000, conv!.id)
      .run();

    const closedSend = await reqCrm('/commands/message.send', {
      method: 'POST',
      actor: 'agent1',
      body: { requestId: 'wa_closed_free', input: { conversationId: conv!.id, bodyText: 'Free form outside 24h' } },
    });
    expect(await closedSend.json()).toMatchObject({ ok: false, error: 'window_closed' });

    // Create draft template -> still refused until approved!
    const tplUpsert = await reqCrm('/commands/template.upsert', {
      method: 'POST',
      actor: 'admin1',
      body: {
        requestId: 'wa_tpl_upsert_1',
        input: {
          channel: 'whatsapp',
          name: 'workshop_schedule_update',
          language: 'en',
          category: 'utility',
          bodyText: 'Hi {{1}}, the workshop dates are confirmed for {{2}}.',
          variables: ['name', 'dates'],
        },
      },
    });
    const tplId = ((await tplUpsert.json()) as { result: { template: { id: string } } }).result.template.id;

    // Draft template refused
    const draftTplSend = await reqCrm('/commands/message.send', {
      method: 'POST',
      actor: 'agent1',
      body: {
        requestId: 'wa_closed_draft_tpl',
        input: { conversationId: conv!.id, bodyText: 'Hi Meera', templateId: tplId },
      },
    });
    expect(await draftTplSend.json()).toMatchObject({ ok: false, error: 'window_closed' });

    // Submit & mirror approval -> template send SUCCEEDS outside 24h window!
    expect(
      await (
        await reqCrm('/commands/template.submit', {
          method: 'POST',
          actor: 'admin1',
          body: { requestId: 'wa_tpl_submit_1', input: { templateId: tplId } },
        })
      ).json(),
    ).toMatchObject({ ok: true, result: { template: { status: 'submitted' } } });

    expect(
      await (
        await reqCrm('/commands/template.sync_status', {
          method: 'POST',
          actor: 'admin1',
          body: {
            requestId: 'wa_tpl_approve_1',
            input: { templateId: tplId, status: 'approved', providerTemplateId: 'meta_tpl_42' },
          },
        })
      ).json(),
    ).toMatchObject({ ok: true, result: { template: { status: 'approved', providerTemplateId: 'meta_tpl_42' } } });

    const tplSend = await reqCrm('/commands/message.send', {
      method: 'POST',
      actor: 'agent1',
      body: {
        requestId: 'wa_closed_approved_tpl',
        input: {
          conversationId: conv!.id,
          bodyText: 'Hi Meera, the workshop dates are confirmed for Nov 12.',
          templateId: tplId,
          templateParams: ['Meera', 'Nov 12'],
        },
      },
    });
    const tplSendJson = (await tplSend.json()) as { ok: boolean; result: { message: { id: string; status: string }; receiptId: string } };
    expect(tplSendJson).toMatchObject({ ok: true, result: { message: { status: 'sent' } } });
    const sentWamid = tplSendJson.result.receiptId;

    // 6. Delivery & read status receipts progress monotonically (sent -> delivered -> read) and ignore out-of-order downgrade!
    const statusHook = (st: string, ts: number) => ({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: sentWamid, status: st, timestamp: String(ts) }] } }] }],
    });
    await postSignedWebhook('whatsapp', statusHook('delivered', 1_700_000_100), 'wa_app_secret_0123456789');
    expect(await fx!.db.prepare('SELECT status FROM crm_messages WHERE id = ?').bind(tplSendJson.result.message.id).first('status')).toBe('delivered');
    await postSignedWebhook('whatsapp', statusHook('read', 1_700_000_200), 'wa_app_secret_0123456789');
    expect(await fx!.db.prepare('SELECT status FROM crm_messages WHERE id = ?').bind(tplSendJson.result.message.id).first('status')).toBe('read');
    // Out-of-order older 'delivered' MUST NOT downgrade 'read'!
    await postSignedWebhook('whatsapp', statusHook('delivered', 1_700_000_090), 'wa_app_secret_0123456789');
    expect(await fx!.db.prepare('SELECT status FROM crm_messages WHERE id = ?').bind(tplSendJson.result.message.id).first('status')).toBe('read');

    // 7. Queue a non-transactional updates message, then receive inbound 'STOP' -> appends withdrawn consent & cancels queued updates!
    const qUpdates = await reqCrm('/commands/message.send', {
      method: 'POST',
      actor: 'agent1',
      body: {
        requestId: 'wa_queued_updates_01',
        input: {
          conversationId: conv!.id,
          bodyText: 'Seasonal calendar update',
          templateId: tplId,
          purpose: 'updates',
          deliveryMode: 'queued',
        },
      },
    });
    const qUpdatesMsgId = ((await qUpdates.json()) as { result: { message: { id: string } } }).result.message.id;

    const stopPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    id: 'wamid.inbound.stop',
                    from: '919876543210',
                    timestamp: String(Math.floor(Date.now() / 1000) + 5),
                    type: 'text',
                    text: { body: 'STOP' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const stopRes = await postSignedWebhook('whatsapp', stopPayload, 'wa_app_secret_0123456789');
    expect(await stopRes.json()).toMatchObject({ ok: true, ingested: 1, optOutsRecorded: 1 });

    // Queued non-transactional message is cancelled, and new sends are blocked with consent_withdrawn!
    expect(await fx!.db.prepare('SELECT status FROM crm_outbox WHERE message_id = ?').bind(qUpdatesMsgId).first('status')).toBe('cancelled');
    expect(await fx!.db.prepare('SELECT status FROM crm_messages WHERE id = ?').bind(qUpdatesMsgId).first('status')).toBe('cancelled');

    const postStopSend = await reqCrm('/commands/message.send', {
      method: 'POST',
      actor: 'agent1',
      body: {
        requestId: 'wa_post_stop_blocked',
        input: { conversationId: conv!.id, bodyText: 'Blocked after STOP', templateId: tplId },
      },
    });
    expect(await postStopSend.json()).toMatchObject({ ok: false, error: 'consent_withdrawn' });
  });

  it('handles Instagram & Facebook signed webhooks, provider-scoped IGSID/PSID identities, echo skipping, and 7-day HUMAN_AGENT human-only replies', async () => {
    await setupFixture();

    // Configure simulated Instagram (humanAgentApproved: false initially) and Facebook (humanAgentApproved: true)
    const igCfg = await reqCrm('/commands/channel.configure', {
      method: 'POST',
      actor: 'admin1',
      body: {
        requestId: 'ig_cfg_01',
        input: {
          channel: 'instagram',
          provider: 'instagram_meta',
          label: 'Riverbank IG',
          externalId: 'ig_acct_1',
          mode: 'simulated',
          active: true,
          secretName: 'IG_TEST_SECRET',
          config: { instagramAccountId: '17841400001', humanAgentApproved: false },
        },
      },
    });
    const igAccId = ((await igCfg.json()) as { result: { account: { id: string } } }).result.account.id;

    await reqCrm('/commands/channel.configure', {
      method: 'POST',
      actor: 'admin1',
      body: {
        requestId: 'fb_cfg_01',
        input: {
          channel: 'facebook',
          provider: 'facebook_meta',
          label: 'Riverbank FB Page',
          externalId: 'fb_page_1',
          mode: 'simulated',
          active: true,
          secretName: 'FB_TEST_SECRET',
          config: { pageId: '100900800', humanAgentApproved: true },
        },
      },
    });

    // Inbound Instagram webhook with 1 real DM + 1 outbound echo (echo MUST be skipped!)
    const igHook = {
      object: 'instagram',
      entry: [
        {
          id: '17841400001',
          messaging: [
            {
              sender: { id: '17841400999' },
              recipient: { id: '17841400001' },
              timestamp: Date.now(),
              message: { mid: 'ig_mid_1', text: 'Interested in the residency!' },
            },
            {
              sender: { id: '17841400001' },
              recipient: { id: '17841400999' },
              timestamp: Date.now() + 1,
              message: { mid: 'ig_mid_echo', text: 'Echo from IG app', is_echo: true },
            },
          ],
        },
      ],
    };
    const igIn = await postSignedWebhook('instagram', igHook, 'ig_app_secret_0123456789');
    expect(await igIn.json()).toMatchObject({ ok: true, ingested: 1, duplicatesSkipped: 0 });

    const igConv = await fx!.db
      .prepare("SELECT id, person_id, external_thread_id, human_agent_window_expires_at FROM crm_conversations WHERE channel = 'instagram' LIMIT 1")
      .first<{ id: string; person_id: string; external_thread_id: string; human_agent_window_expires_at: number }>();
    expect(igConv?.person_id).toBe('person-ig');
    expect(igConv?.external_thread_id).toBe('igsid:17841400999');
    expect(igConv!.human_agent_window_expires_at).toBeGreaterThan(Date.now() + 5 * 86_400_000);

    // Expire 24h window (still inside 7d window): without humanAgentApproved=true -> refused window_closed!
    await fx!.db
      .prepare('UPDATE crm_conversations SET window_expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1_000, igConv!.id)
      .run();
    const igBlockedHa = await reqCrm('/commands/message.send', {
      method: 'POST',
      actor: 'agent1',
      body: { requestId: 'ig_ha_unapproved', input: { conversationId: igConv!.id, bodyText: 'Late IG reply' } },
    });
    expect(await igBlockedHa.json()).toMatchObject({ ok: false, error: 'window_closed' });

    // Enable humanAgentApproved on Instagram account -> human UI reply SUCCEEDS with messageTag = 'HUMAN_AGENT'!
    await reqCrm('/commands/channel.configure', {
      method: 'POST',
      actor: 'admin1',
      body: {
        requestId: 'ig_cfg_enable_ha',
        input: {
          accountId: igAccId,
          channel: 'instagram',
          provider: 'instagram_meta',
          label: 'Riverbank IG',
          externalId: 'ig_acct_1',
          mode: 'simulated',
          active: true,
          secretName: 'IG_TEST_SECRET',
          config: { instagramAccountId: '17841400001', humanAgentApproved: true },
        },
      },
    });
    const igHaOk = await reqCrm('/commands/message.send', {
      method: 'POST',
      actor: 'agent1',
      body: {
        requestId: 'ig_ha_approved_ok',
        input: { conversationId: igConv!.id, bodyText: 'Human follow-up within 7 days', useHumanAgentTag: true },
      },
    });
    expect(await igHaOk.json()).toMatchObject({
      ok: true,
      result: { message: { status: 'sent', messageTag: 'HUMAN_AGENT' } },
    });

    // Facebook webhook uses PSID ('psid:2244668800') and never merges with Instagram IGSID
    const fbHook = {
      object: 'page',
      entry: [
        {
          id: '100900800',
          messaging: [
            {
              sender: { id: '2244668800' },
              recipient: { id: '100900800' },
              timestamp: Date.now(),
              message: { mid: 'fb_mid_1', text: 'Hello on Facebook Messenger!' },
            },
          ],
        },
      ],
    };
    const fbIn = await postSignedWebhook('facebook', fbHook, 'fb_app_secret_0123456789');
    expect(await fbIn.json()).toMatchObject({ ok: true, ingested: 1 });
    const fbConv = await fx!.db
      .prepare("SELECT person_id, external_thread_id FROM crm_conversations WHERE channel = 'facebook' LIMIT 1")
      .first<{ person_id: string; external_thread_id: string }>();
    expect(fbConv).toMatchObject({ person_id: 'person-fb', external_thread_id: 'psid:2244668800' });
  });

  it('verifies production WhatsApp Cloud and Meta Messaging adapter payloads, host allowlist, redirect:error, and error classification', async () => {
    await setupFixture();

    const waCalls: { url: string; init: RequestInit }[] = [];
    const waAccount = {
      id: 'ch_wa_p',
      channel: 'whatsapp' as const,
      provider: 'whatsapp_cloud' as const,
      label: 'Prod WA',
      external_id: '+919800000001',
      mode: 'production' as const,
      active: 1,
      secret_name: 'WA_TEST_SECRET',
      config_json: JSON.stringify({ phoneNumberId: '100200300', graphVersion: 'v21.0' }),
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

    const waTplRes = await sendViaWhatsAppCloud(
      fx!.env,
      {
        account: waAccount,
        config: { phoneNumberId: '100200300', graphVersion: 'v21.0' },
        channel: 'whatsapp',
        messageId: 'm_wa_1',
        conversationId: 'c_wa_1',
        subject: 'WA',
        recipientEndpoint: '+919876543210',
        bodyText: 'Template body',
        idempotencyKey: 'rk_1',
        template: { id: 't1', name: 'hello_utility', language: 'en', providerTemplateId: 'pt1', params: ['Meera'] },
        now: 1000,
      },
      async (url, init) => {
        waCalls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ messages: [{ id: 'wamid.prod.001' }] }), { status: 200 });
      },
    );
    expect(waTplRes).toMatchObject({ ok: true, externalId: 'wamid.prod.001' });
    expect(waCalls[0]!.url).toBe('https://graph.facebook.com/v21.0/100200300/messages');
    expect(waCalls[0]!.init.redirect).toBe('error');
    expect(JSON.parse(String(waCalls[0]!.init.body))).toMatchObject({
      messaging_product: 'whatsapp',
      to: '919876543210',
      type: 'template',
      template: { name: 'hello_utility', language: { code: 'en' } },
    });

    // Meta 131047 -> window_closed; HTTP 500 -> unknown (ambiguous)
    expect(
      await sendViaWhatsAppCloud(
        fx!.env,
        {
          account: waAccount,
          config: { phoneNumberId: '100200300' },
          channel: 'whatsapp',
          messageId: 'm_wa_2',
          conversationId: 'c_wa_1',
          subject: 'WA',
          recipientEndpoint: '+919876543210',
          bodyText: 'Text',
          idempotencyKey: 'rk_2',
          now: 1000,
        },
        async () => new Response(JSON.stringify({ error: { code: 131047, message: 'Re-engagement window closed' } }), { status: 400 }),
      ),
    ).toMatchObject({ ok: false, errorClass: 'window_closed' });

    // Meta Messaging production HUMAN_AGENT tag payload check
    const fbCalls: { url: string; init: RequestInit }[] = [];
    const fbAccount = {
      ...waAccount,
      id: 'ch_fb_p',
      channel: 'facebook' as const,
      provider: 'facebook_meta' as const,
      secret_name: 'FB_TEST_SECRET',
      config_json: JSON.stringify({ pageId: '100900800', graphVersion: 'v21.0', humanAgentApproved: true }),
    };
    const fbRes = await sendViaMetaMessaging(
      fx!.env,
      {
        account: fbAccount,
        config: { pageId: '100900800', graphVersion: 'v21.0', humanAgentApproved: true },
        channel: 'facebook',
        messageId: 'm_fb_1',
        conversationId: 'c_fb_1',
        subject: 'FB',
        recipientEndpoint: 'psid:2244668800',
        bodyText: 'Human support reply',
        idempotencyKey: 'rk_fb_1',
        messageTag: 'HUMAN_AGENT',
        now: 1000,
      },
      async (url, init) => {
        fbCalls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ message_id: 'm_meta_prod_1' }), { status: 200 });
      },
    );
    expect(fbRes).toMatchObject({ ok: true, externalId: 'm_meta_prod_1' });
    expect(fbCalls[0]!.url).toBe('https://graph.facebook.com/v21.0/100900800/messages');
    expect(fbCalls[0]!.init.redirect).toBe('error');
    expect(JSON.parse(String(fbCalls[0]!.init.body))).toMatchObject({
      messaging_type: 'MESSAGE_TAG',
      tag: 'HUMAN_AGENT',
      recipient: { id: '2244668800' },
      message: { text: 'Human support reply' },
    });
  });
});
