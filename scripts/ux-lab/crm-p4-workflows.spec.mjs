import { randomUUID } from 'node:crypto';
import { test, expect, health, request, fixture } from './support.mjs';
import { navigateReady } from '../navigation-ready.mjs';

async function pullBoardsByKey() {
  const manifest = await request('/api/access', undefined, 'GET');
  const byKey = {};
  if (Array.isArray(manifest?.spaces)) {
    let cursor = 0;
    let joining = manifest.spaces.map((s) => ({ space: s.id, after: 0, base: 0 }));
    for (let i = 0; i < 20; i++) {
      const reply = await request('/api/sync/pull', { protocol: 3, etag: manifest.etag, cursor, joining, limit: 500 });
      for (const r of reply.records) {
        if (r.collection === 'boards' && !r.data?.deleted && typeof r.data?.templateDbKey === 'string') {
          byKey[r.data.templateDbKey] = r.id;
        }
      }
      if (!reply.hasMore) break;
      cursor = reply.cursor;
      joining = reply.joining;
    }
  } else {
    let since = 0;
    for (let i = 0; i < 20; i++) {
      const reply = await request(`/api/sync/pull?since=${since}&limit=500`, undefined, 'GET');
      for (const r of reply.records) {
        if (r.collection === 'boards' && !r.data?.deleted && typeof r.data?.templateDbKey === 'string') {
          byKey[r.data.templateDbKey] = r.id;
        }
      }
      if (!reply.hasMore) break;
      since = reply.cursor;
    }
  }
  return byKey;
}

async function syncPush(changes) {
  const manifest = await request('/api/access', undefined, 'GET');
  return request('/api/sync/push', Array.isArray(manifest?.spaces) ? { protocol: 3, changes } : { changes });
}

const REQUIRED_KEYS = ['people', 'organizations', 'programs', 'events'];

async function ensurePackInstalled(page) {
  let byKey = await pullBoardsByKey();
  if (REQUIRED_KEYS.every((k) => Boolean(byKey[k]))) return byKey;
  await navigateReady(page, fixture.base + '/crm/organisations');
  const orgsHeading = page.getByRole('heading', { name: 'Organisations', exact: true });
  const initBtn = page.getByRole('button', { name: 'Initialise TCG CRM databases' });
  await expect(orgsHeading.or(initBtn)).toBeVisible({ timeout: 25_000 });
  if (await initBtn.isVisible()) await initBtn.click();
  await expect(orgsHeading).toBeVisible({ timeout: 25_000 });
  for (let i = 0; i < 60; i++) {
    byKey = await pullBoardsByKey();
    if (REQUIRED_KEYS.every((k) => Boolean(byKey[k]))) return byKey;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Timed out waiting for TCG Operating Pack boards');
}

test('P3 Channels Settings & Templates — Responsive, Accessible & Visual Reference', async ({ page }, info) => {
  await ensurePackInstalled(page);

  await request('/api/crm/commands/channel.configure', {
    requestId: 'ux_p3_wa_' + randomUUID().replace(/-/g, '').slice(0, 16),
    input: {
      channel: 'whatsapp',
      provider: 'whatsapp_cloud',
      label: 'UX Lab WhatsApp Desk (Disabled)',
      externalId: 'ux-wa-phone-01',
      mode: 'disabled',
      active: false,
      config: { phoneNumberId: '100000000001', graphVersion: 'v21.0' },
    },
  });

  await request('/api/crm/commands/template.upsert', {
    requestId: 'ux_p3_tpl_' + randomUUID().replace(/-/g, '').slice(0, 16),
    input: {
      channel: 'whatsapp',
      name: 'ux_programme_update',
      language: 'en',
      category: 'utility',
      bodyText: 'Hello {{1}}, update for {{2}}.',
      variables: ['name', 'programme'],
    },
  });

  await navigateReady(page, fixture.base + '/crm/settings/channels');
  await expect(page.getByRole('heading', { name: 'Channels, templates & delivery' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('UX Lab WhatsApp Desk (Disabled)')).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await health(page, 'crm-p3-channels', info);
  await expect(page.locator('[data-app="crm"]')).toHaveScreenshot('crm-p3-channels.png', {
    mask: [page.locator('[data-app="crm"] time')],
  });

  await page.getByRole('tab', { name: /Templates/ }).click();
  await expect(page.getByText('ux_programme_update')).toBeVisible({ timeout: 15_000 });
});

test('P4 S6–S8 Bookings, Append-Only Money, Memberships, 320px Reflow & 200% Scaling', async ({ page }, info) => {
  const boards = await ensurePackInstalled(page);
  const fixedTs = Date.UTC(2026, 10, 26, 9, 0, 0);

  const pushed = await syncPush([
    {
      id: 'ux-p4-event-1',
      collection: 'tasks',
      ts: fixedTs,
      patch: { boardId: boards.events, title: 'Autumn Earthcraft Residency', order: 'a0' },
    },
    {
      id: 'ux-p4-person-1',
      collection: 'tasks',
      ts: fixedTs,
      patch: {
        boardId: boards.people,
        title: 'Ananya Nair',
        order: 'a0',
        p_f_email: 'ananya.p4@commons-demo.example.org',
      },
    },
    {
      id: 'ux-p4-person-2',
      collection: 'tasks',
      ts: fixedTs,
      patch: {
        boardId: boards.people,
        title: 'Vikram Rao',
        order: 'a1',
        p_f_email: 'vikram.p4@commons-demo.example.org',
      },
    },
  ]);
  expect(pushed.rejected).toBeFalsy();

  // S6 Edition + Group Booking with placeholders + Attendance + Restricted Screening
  const edRes = await request('/api/crm/commands/edition.upsert', {
    requestId: 'ux_p4_ed_' + randomUUID().replace(/-/g, '').slice(0, 16),
    input: {
      eventRecordId: 'ux-p4-event-1',
      programmeSlug: 'tribal-habitat-workshop',
      title: 'Earthcraft Autumn Cohort',
      capacity: 4,
      holdMinutes: 30,
      maxGroupSize: 3,
      confirmBeforePayment: false,
      requiresScreening: true,
      screeningQuestions: ['Dietary or mobility notes?'],
      cancellationPolicyText: 'Full credit up to 14 days before start.',
      priceOptions: [{ id: 'std', label: 'Standard Seat', amountMinor: 250000, currency: 'INR', active: true }],
      sessionDates: ['2026-12-10', '2026-12-11'],
      state: 'open',
    },
  });
  expect(edRes.ok).toBe(true);
  const editionId = edRes.result.edition.id;

  const bkRes = await request('/api/crm/commands/booking.request', {
    requestId: 'ux_p4_bk_' + randomUUID().replace(/-/g, '').slice(0, 16),
    input: {
      editionId,
      bookerPersonId: 'ux-p4-person-1',
      seats: 2,
      priceOptionId: 'std',
      participantNames: ['Ananya Nair'],
      source: 'crm',
    },
  });
  expect(bkRes.ok).toBe(true);
  const bookingId = bkRes.result.booking.id;

  // S7 Payment Request + Manual Receipt + Refund Request
  const prRes = await request('/api/crm/commands/payment_request.create', {
    requestId: 'ux_p4_pr_' + randomUUID().replace(/-/g, '').slice(0, 16),
    input: { objectType: 'booking', objectId: bookingId, amountMinor: 500000, currency: 'INR', label: 'Cohort fee (2 seats)' },
  });
  expect(prRes.ok).toBe(true);

  const rcptRes = await request('/api/crm/commands/ledger.record_receipt', {
    requestId: 'ux_p4_rc_' + randomUUID().replace(/-/g, '').slice(0, 16),
    input: {
      objectType: 'booking',
      objectId: bookingId,
      paymentRequestId: prRes.result.paymentRequest.id,
      amountMinor: 500000,
      currency: 'INR',
      evidenceKind: 'bank_reference',
      evidenceRef: 'UTR-UX-2026-0001',
      contributorResidency: 'domestic',
    },
  });
  expect(rcptRes.ok).toBe(true);

  const rfRes = await request('/api/crm/commands/refund.request', {
    requestId: 'ux_p4_rf_' + randomUUID().replace(/-/g, '').slice(0, 16),
    input: { objectType: 'booking', objectId: bookingId, amountMinor: 50000, currency: 'INR', reason: 'Partial scholarship adjustment' },
  });
  expect(rfRes.ok).toBe(true);

  // S8 Common Roots Scheme + Active Membership
  const scRes = await request('/api/crm/commands/membership_scheme.upsert', {
    requestId: 'ux_p4_sc_' + randomUUID().replace(/-/g, '').slice(0, 16),
    input: {
      slug: 'common-roots-ux',
      name: 'Common Roots Annual',
      programmeSlug: 'common-roots',
      contributionAmountMinor: 120000,
      currency: 'INR',
      validityDays: 365,
      renewalNoticeDays: 30,
      identifierPrefix: 'CR',
      identifierDigits: 4,
      active: true,
    },
  });
  expect(scRes.ok).toBe(true);

  const memApp = await request('/api/crm/commands/membership.apply', {
    requestId: 'ux_p4_ma_' + randomUUID().replace(/-/g, '').slice(0, 16),
    input: { schemeId: scRes.result.scheme.id, personId: 'ux-p4-person-2' },
  });
  expect(memApp.ok).toBe(true);
  const memDec = await request('/api/crm/commands/membership.decide', {
    requestId: 'ux_p4_md_' + randomUUID().replace(/-/g, '').slice(0, 16),
    input: { membershipId: memApp.result.membership.id, decision: 'approve', reason: 'Approved in UX fixture' },
  });
  expect(memDec.ok).toBe(true);
  const memReq = await request('/api/crm/commands/membership.issue_request', {
    requestId: 'ux_p4_mr_' + randomUUID().replace(/-/g, '').slice(0, 16),
    input: { membershipId: memApp.result.membership.id },
  });
  expect(memReq.ok).toBe(true);
  await request('/api/crm/commands/ledger.record_receipt', {
    requestId: 'ux_p4_mrc_' + randomUUID().replace(/-/g, '').slice(0, 16),
    input: {
      objectType: 'membership',
      objectId: memApp.result.membership.id,
      paymentRequestId: memReq.result.paymentRequestId,
      amountMinor: 120000,
      currency: 'INR',
      evidenceKind: 'bank_reference',
      evidenceRef: 'UTR-CR-UX-0001',
      contributorResidency: 'domestic',
    },
  });
  const memAct = await request('/api/crm/commands/membership.activate', {
    requestId: 'ux_p4_mact_' + randomUUID().replace(/-/g, '').slice(0, 16),
    input: { membershipId: memApp.result.membership.id },
  });
  expect(memAct.ok).toBe(true);

  // 1. Bookings surface
  await navigateReady(page, fixture.base + `/crm/bookings/${editionId}`);
  await expect(page.getByRole('heading', { name: 'Editions & Bookings' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Earthcraft Autumn Cohort').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Ananya Nair').first()).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await health(page, 'crm-p4-bookings', info);
  await expect(page.locator('[data-app="crm"]')).toHaveScreenshot('crm-p4-bookings.png', {
    mask: [page.locator('[data-app="crm"] time')],
  });

  // 2. Money & Append-Only Ledger surface
  await navigateReady(page, fixture.base + '/crm/money');
  await expect(page.getByRole('heading', { name: 'Money & Append-Only Ledger' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Cohort fee (2 seats)').first()).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await health(page, 'crm-p4-money', info);
  await expect(page.locator('[data-app="crm"]')).toHaveScreenshot('crm-p4-money.png', {
    mask: [page.locator('[data-app="crm"] time')],
  });

  await page.getByRole('tab', { name: /Refunds/ }).click();
  await expect(page.getByText('Self-approval blocked')).toBeVisible({ timeout: 15_000 });

  // 3. Common Roots Memberships surface
  await navigateReady(page, fixture.base + '/crm/memberships');
  await expect(page.getByRole('heading', { name: 'Common Roots Memberships' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('CR-0001').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Benefits & redemption disabled pending O-07')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await health(page, 'crm-p4-memberships', info);
  await expect(page.locator('[data-app="crm"]')).toHaveScreenshot('crm-p4-memberships.png', {
    mask: [page.locator('[data-app="crm"] time')],
  });

  // 4. 320px Reflow + 200% text scaling on P4 Bookings & Money
  await page.setViewportSize({ width: 320, height: 568 });
  for (const path of [`/crm/bookings/${editionId}`, '/crm/money', '/crm/memberships']) {
    await navigateReady(page, fixture.base + path);
    const reflow = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(reflow.scroll, `Horizontal overflow at 320px on ${path}`).toBeLessThanOrEqual(reflow.width + 1);
  }
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  await health(page, 'crm-p4-200pct', info);
});
