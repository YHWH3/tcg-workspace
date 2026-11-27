import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../worker/auth';
import { crmApi } from '../worker/crm';
import { openAuditFixture, ctx, type AuditFixture } from './audit-fixture';

let fx: AuditFixture | undefined;

afterEach(async () => {
  await fx?.dispose();
  fx = undefined;
});

async function callCrm(path: string, actor: string, body?: unknown) {
  const res = await crmApi.request(
    path,
    {
      method: body !== undefined ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${fx!.token(actor)}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    fx!.env,
    ctx,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function setupHardeningFixture() {
  fx = await openAuditFixture(
    [
      { id: 'owner1', role: 'admin' },
      { id: 'fin1', role: 'member' },
      { id: 'approver_only', role: 'member' },
      { id: 'coord1', role: 'member' },
      { id: 'lead1', role: 'member' },
    ],
    { CRM_ENABLED: '1', WORKSPACE_ENV: 'local-test' } as Partial<Env>,
  );
  const now = Date.now();
  await fx.db.batch([
    fx.db.prepare(
      `UPDATE users SET workspace_role = CASE id WHEN 'owner1' THEN 'owner' ELSE 'member' END`,
    ),
    fx.db.prepare(
      `INSERT INTO crm_capability_grants (user_id, capability, scope, granted_by, granted_at)
       VALUES
         ('fin1', 'crm.access', '*', 'owner1', 1),
         ('fin1', 'crm.finance.read', '*', 'owner1', 1),
         ('fin1', 'crm.finance.record', '*', 'owner1', 1),
         ('approver_only', 'crm.access', '*', 'owner1', 1),
         ('approver_only', 'crm.refund.approve', '*', 'owner1', 1),
         ('coord1', 'crm.access', '*', 'owner1', 1),
         ('lead1', 'crm.access', '*', 'owner1', 1),
         ('lead1', 'crm.configure', 'programme:tribal-habitat-workshop', 'owner1', 1),
         ('lead1', 'crm.restricted.read', 'programme:tribal-habitat-workshop', 'owner1', 1)`,
    ),
    fx.db
      .prepare(
        `INSERT INTO spaces (id, name, default_access, created_by, created_at) VALUES ('space-restricted', 'Restricted Space', 'private', 'owner1', ?)`,
      )
      .bind(now),
    fx.db
      .prepare(
        `INSERT INTO records (id, collection, data, field_ts, seq, updated_at, space_id) VALUES
         ('db_events', 'boards', ?, '{}', 1, ?, 'space-core'),
         ('db_events_secret', 'boards', ?, '{}', 1, ?, 'space-restricted'),
         ('db_people', 'boards', ?, '{}', 1, ?, 'space-core'),
         ('db_people_secret', 'boards', ?, '{}', 1, ?, 'space-restricted'),
         ('ev_public', 'tasks', ?, '{}', 1, ?, 'space-core'),
         ('ev_secret', 'tasks', ?, '{}', 1, ?, 'space-restricted'),
         ('p_pub', 'tasks', ?, '{}', 1, ?, 'space-core'),
         ('p_secret', 'tasks', ?, '{}', 1, ?, 'space-restricted')`,
      )
      .bind(
        JSON.stringify({ name: 'Events', kind: 'records', columns: [], fields: [] }),
        now,
        JSON.stringify({ name: 'Restricted Events', kind: 'records', columns: [], fields: [] }),
        now,
        JSON.stringify({ name: 'People', kind: 'records', columns: [], fields: [] }),
        now,
        JSON.stringify({ name: 'Restricted People', kind: 'records', columns: [], fields: [] }),
        now,
        JSON.stringify({ boardId: 'db_events', title: 'Public THW Edition' }),
        now,
        JSON.stringify({ boardId: 'db_events_secret', title: 'Restricted Retreat Edition' }),
        now,
        JSON.stringify({ boardId: 'db_people', title: 'Public Guest' }),
        now,
        JSON.stringify({ boardId: 'db_people_secret', title: 'Secret Guest' }),
        now,
      ),
  ]);
}

describe('P4 Targeted Integrity & Authorization Hardening (D1)', () => {
  it('Finding 1: derives booking settlement from authoritative agreed price * seats, allocates requests per-request, and fences concurrent receipts/reversals', async () => {
    await setupHardeningFixture();

    const edRes = await callCrm('/commands/edition.upsert', 'owner1', {
      requestId: 'h1_ed_0001',
      input: {
        eventRecordId: 'ev_public',
        programmeSlug: 'tribal-habitat-workshop',
        title: 'THW Authoritative Pricing',
        capacity: 5,
        holdMinutes: 60,
        maxGroupSize: 4,
        confirmBeforePayment: false,
        priceOptions: [{ id: 'std', label: 'Standard', amountMinor: 100000, currency: 'INR', active: true }],
        state: 'open',
      },
    });
    expect(edRes.json).toMatchObject({ ok: true });
    const edId = (edRes.json.result as { edition: { id: string } }).edition.id;

    // 2 seats @ 100,000 = 200,000 authoritative due
    const bkRes = await callCrm('/commands/booking.request', 'coord1', {
      requestId: 'h1_bk_0001',
      input: { editionId: edId, bookerPersonId: 'p_pub', seats: 2, priceOptionId: 'std' },
    });
    expect(bkRes.json).toMatchObject({ ok: true });
    const bkId = (bkRes.json.result as { booking: { id: string } }).booking.id;
    await callCrm('/commands/booking.hold', 'coord1', { requestId: 'h1_hold_01', input: { bookingId: bkId } });

    // Create an arbitrarily smaller 10,000 payment request + a second 190,000 request
    const pr1 = await callCrm('/commands/payment_request.create', 'fin1', {
      requestId: 'h1_pr_0001',
      input: { objectType: 'booking', objectId: bkId, amountMinor: 10000, currency: 'INR' },
    });
    expect(pr1.json).toMatchObject({ ok: true });
    const pr1Id = (pr1.json.result as { paymentRequest: { id: string } }).paymentRequest.id;
    const pr2 = await callCrm('/commands/payment_request.create', 'fin1', {
      requestId: 'h1_pr_0002',
      input: { objectType: 'booking', objectId: bkId, amountMinor: 190000, currency: 'INR' },
    });
    expect(pr2.json).toMatchObject({ ok: true });
    const pr2Id = (pr2.json.result as { paymentRequest: { id: string } }).paymentRequest.id;

    // Paying the 10,000 deposit marks ONLY pr1 paid, leaves pr2 issued, keeps booking part_paid!
    const rcpt1 = await callCrm('/commands/ledger.record_receipt', 'fin1', {
      requestId: 'h1_rcpt_01',
      input: {
        objectType: 'booking',
        objectId: bkId,
        paymentRequestId: pr1Id,
        amountMinor: 10000,
        currency: 'INR',
        evidenceKind: 'bank_reference',
        evidenceRef: 'UTR-DEP-10K',
      },
    });
    expect(rcpt1.json).toMatchObject({ ok: true, result: { paymentStatus: 'part_paid' } });

    const reqRows = await fx!.db
      .prepare(`SELECT id, state FROM crm_payment_requests WHERE object_id = ? ORDER BY created_at ASC`)
      .bind(bkId)
      .all<{ id: string; state: string }>();
    expect(reqRows.results).toEqual([
      { id: pr1Id, state: 'paid' },
      { id: pr2Id, state: 'issued' },
    ]);

    // Booking confirm MUST STILL FAIL despite pr1 being paid!
    const earlyConfirm = await callCrm('/commands/booking.confirm', 'coord1', {
      requestId: 'h1_confirm_early',
      input: { bookingId: bkId },
    });
    expect(earlyConfirm.json).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'payment_required_before_confirm', requiredMinor: 200000, coveredMinor: 10000, currency: 'INR' },
    });

    // Even if someone tampered with cached payment_status directly, booking.confirm fences authoritative ledger!
    await fx!.db.prepare(`UPDATE crm_bookings SET payment_status = 'paid' WHERE id = ?`).bind(bkId).run();
    const tamperedConfirm = await callCrm('/commands/booking.confirm', 'coord1', {
      requestId: 'h1_confirm_tampered',
      input: { bookingId: bkId },
    });
    expect(tamperedConfirm.json).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'payment_required_before_confirm' },
    });

    // Pay the remaining 190,000 against pr2 -> both requests paid, booking paid, confirm succeeds!
    const rcpt2 = await callCrm('/commands/ledger.record_receipt', 'fin1', {
      requestId: 'h1_rcpt_02',
      input: {
        objectType: 'booking',
        objectId: bkId,
        paymentRequestId: pr2Id,
        amountMinor: 190000,
        currency: 'INR',
        evidenceKind: 'bank_reference',
        evidenceRef: 'UTR-BAL-190K',
      },
    });
    expect(rcpt2.json).toMatchObject({ ok: true, result: { paymentStatus: 'paid' } });

    const reqRowsAfter = await fx!.db
      .prepare(`SELECT id, state FROM crm_payment_requests WHERE object_id = ? ORDER BY created_at ASC`)
      .bind(bkId)
      .all<{ id: string; state: string }>();
    expect(reqRowsAfter.results).toEqual([
      { id: pr1Id, state: 'paid' },
      { id: pr2Id, state: 'paid' },
    ]);

    const okConfirm = await callCrm('/commands/booking.confirm', 'coord1', {
      requestId: 'h1_confirm_ok',
      input: { bookingId: bkId },
    });
    expect(okConfirm.json).toMatchObject({ ok: true, result: { booking: { state: 'confirmed' } } });

    // Concurrent receipt + reversal race on the same booking never leaves corrupted state or over-refund
    const rcpt2Id = (rcpt2.json.result as { entry: { id: string } }).entry.id;
    const [rRace1, rRace2] = await Promise.all([
      callCrm('/commands/ledger.reverse_entry', 'fin1', {
        requestId: 'h1_race_rev',
        input: { entryId: rcpt2Id, reason: 'Concurrent reversal' },
      }),
      callCrm('/commands/refund.request', 'fin1', {
        requestId: 'h1_race_ref',
        input: { objectType: 'booking', objectId: bkId, amountMinor: 190000, currency: 'INR', reason: 'Concurrent refund' },
      }),
    ]);
    // At most one of full-reversal vs full-refund can commit cleanly; the loser must fail closed (stale or invalid_input)!
    const successes = [rRace1, rRace2].filter((r) => r.json.ok === true);
    expect(successes.length).toBe(1);
    const loser = [rRace1, rRace2].find((r) => r.json.ok === false)!;
    expect(['stale', 'invalid_input']).toContain(loser.json.error);
  });

  it('Finding 3: enforces unconfigured price & paid cancellation policy fail-closed, DB-time hold expiry, and cancellation refund review', async () => {
    await setupHardeningFixture();

    // Open edition with confirm_before_payment = false and NO cancellationPolicyText yet
    const edRes = await callCrm('/commands/edition.upsert', 'owner1', {
      requestId: 'h3_ed_0001',
      input: {
        eventRecordId: 'ev_public',
        programmeSlug: 'tribal-habitat-workshop',
        title: 'THW Policy Edition',
        capacity: 3,
        holdMinutes: 30,
        maxGroupSize: 3,
        confirmBeforePayment: false,
        priceOptions: [{ id: 'std', label: 'Standard', amountMinor: 50000, currency: 'INR', active: true }],
        state: 'open',
      },
    });
    expect(edRes.json).toMatchObject({ ok: true });
    const edId = (edRes.json.result as { edition: { id: string } }).edition.id;

    // 1. Unpriced booking on confirm_before_payment=false edition MUST refuse pending O-05!
    const unpriced = await callCrm('/commands/booking.request', 'coord1', {
      requestId: 'h3_bk_unpriced',
      input: { editionId: edId, bookerPersonId: 'p_pub', seats: 1 },
    });
    expect(unpriced.json).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'price_option_required_pending_O05' },
    });

    // 2. Priced booking -> hold -> expire hold in DB -> confirm MUST refuse hold_expired using DB time!
    const bkExpRes = await callCrm('/commands/booking.request', 'coord1', {
      requestId: 'h3_bk_exp',
      input: { editionId: edId, bookerPersonId: 'p_pub', seats: 1, priceOptionId: 'std' },
    });
    const bkExpId = (bkExpRes.json.result as { booking: { id: string } }).booking.id;
    await callCrm('/commands/booking.hold', 'coord1', { requestId: 'h3_hold_exp', input: { bookingId: bkExpId } });
    await callCrm('/commands/ledger.record_receipt', 'fin1', {
      requestId: 'h3_rcpt_exp',
      input: {
        objectType: 'booking',
        objectId: bkExpId,
        amountMinor: 50000,
        currency: 'INR',
        evidenceKind: 'bank_reference',
        evidenceRef: 'UTR-EXP-1',
      },
    });
    // Force hold expiry in DB past SQLite current time
    const past = Date.now() - 10_000;
    await fx!.db.batch([
      fx!.db.prepare(`UPDATE crm_bookings SET hold_expires_at = ? WHERE id = ?`).bind(past, bkExpId),
      fx!.db.prepare(`UPDATE crm_allocations SET expires_at = ? WHERE booking_id = ?`).bind(past, bkExpId),
    ]);
    const expConfirm = await callCrm('/commands/booking.confirm', 'coord1', {
      requestId: 'h3_confirm_exp',
      input: { bookingId: bkExpId },
    });
    expect(expConfirm.json).toMatchObject({ ok: false, error: 'hold_expired' });

    // 3. Confirmed paid booking cancellation WITHOUT cancellationPolicyText MUST refuse pending O-06!
    const bkPaidRes = await callCrm('/commands/booking.request', 'coord1', {
      requestId: 'h3_bk_paid',
      input: { editionId: edId, bookerPersonId: 'p_pub', seats: 2, priceOptionId: 'std' },
    });
    const bkPaidId = (bkPaidRes.json.result as { booking: { id: string } }).booking.id;
    await callCrm('/commands/booking.hold', 'coord1', { requestId: 'h3_hold_paid', input: { bookingId: bkPaidId } });
    await callCrm('/commands/ledger.record_receipt', 'fin1', {
      requestId: 'h3_rcpt_paid',
      input: {
        objectType: 'booking',
        objectId: bkPaidId,
        amountMinor: 100000,
        currency: 'INR',
        evidenceKind: 'bank_reference',
        evidenceRef: 'UTR-CANCEL-100K',
      },
    });
    await callCrm('/commands/booking.confirm', 'coord1', { requestId: 'h3_confirm_paid', input: { bookingId: bkPaidId } });

    const uncfgCancel = await callCrm('/commands/booking.cancel', 'coord1', {
      requestId: 'h3_cancel_uncfg',
      input: { bookingId: bkPaidId, reason: 'Guest cannot travel' },
    });
    expect(uncfgCancel.json).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'cancellation_policy_unconfigured_pending_O06' },
    });

    // Configure explicit owner cancellationPolicyText -> cancel succeeds with refund review metadata & seat projection release!
    await callCrm('/commands/edition.upsert', 'owner1', {
      requestId: 'h3_ed1_policy',
      input: {
        editionId: edId,
        eventRecordId: 'ev_public',
        programmeSlug: 'tribal-habitat-workshop',
        title: 'THW Policy Edition',
        capacity: 3,
        holdMinutes: 30,
        maxGroupSize: 3,
        confirmBeforePayment: false,
        cancellationPolicyText: 'Full review required for cancellations within 14 days.',
        priceOptions: [{ id: 'std', label: 'Standard', amountMinor: 50000, currency: 'INR', active: true }],
        state: 'open',
      },
    });
    const okCancel = await callCrm('/commands/booking.cancel', 'coord1', {
      requestId: 'h3_cancel_ok',
      input: { bookingId: bkPaidId, reason: 'Guest cannot travel' },
    });
    expect(okCancel.json).toMatchObject({
      ok: true,
      result: {
        booking: { state: 'cancelled' },
        refundReviewRequired: true,
        refundableByCurrency: [{ currency: 'INR', netPaidMinor: 100000 }],
        cancellationPolicyText: 'Full review required for cancellations within 14 days.',
      },
    });
    const evAfter = await fx!.db.prepare(`SELECT data FROM records WHERE id = 'ev_public'`).first<{ data: string }>();
    expect(JSON.parse(evAfter!.data)._crm_edition_booked_seats).toBe(0);
  });

  it('Finding 4: enforces current linked-record authority on financial reads, refund-only visibility, and consequential command replay', async () => {
    await setupHardeningFixture();

    // Enable space access control: space-restricted ONLY allows owner1 and lead1 initially (NOT fin1, coord1, approver_only!)
    const now = Date.now();
    await fx!.db.batch([
      fx!.db.prepare(`UPDATE access_state SET enabled = 1 WHERE id = 1`),
      fx!.db
        .prepare(
          `INSERT INTO space_members (space_id, user_id, role, access, updated_at) VALUES
           ('space-restricted', 'owner1', 'admin', 'allow', ?),
           ('space-restricted', 'lead1', 'editor', 'allow', ?)`,
        )
        .bind(now, now),
    ]);

    // Owner creates both a public edition/booking and a restricted edition/booking
    const pubEd = await callCrm('/commands/edition.upsert', 'owner1', {
      requestId: 'h4_ed_pub',
      input: {
        eventRecordId: 'ev_public',
        programmeSlug: 'tribal-habitat-workshop',
        title: 'Public Workshop',
        capacity: 5,
        holdMinutes: 60,
        maxGroupSize: 2,
        confirmBeforePayment: true,
        requiresScreening: true,
        screeningQuestions: ['Dietary?'],
        priceOptions: [{ id: 'std', label: 'Std', amountMinor: 40000, currency: 'INR', active: true }],
        state: 'open',
      },
    });
    expect(pubEd.json).toMatchObject({ ok: true });
    const pubEdId = (pubEd.json.result as { edition: { id: string } }).edition.id;

    const secEd = await callCrm('/commands/edition.upsert', 'owner1', {
      requestId: 'h4_ed_sec',
      input: {
        eventRecordId: 'ev_secret',
        programmeSlug: 'tribal-habitat-workshop',
        title: 'Secret Retreat',
        capacity: 5,
        holdMinutes: 60,
        maxGroupSize: 2,
        confirmBeforePayment: true,
        priceOptions: [{ id: 'std', label: 'Std', amountMinor: 90000, currency: 'INR', active: true }],
        state: 'open',
      },
    });
    const secEdId = (secEd.json.result as { edition: { id: string } }).edition.id;

    const pubBkRes = await callCrm('/commands/booking.request', 'owner1', {
      requestId: 'h4_bk_pub',
      input: { editionId: pubEdId, bookerPersonId: 'p_pub', seats: 1, priceOptionId: 'std' },
    });
    const pubBkId = (pubBkRes.json.result as { booking: { id: string } }).booking.id;
    const pubPtId = (pubBkRes.json.result as { participants: { id: string }[] }).participants[0]!.id;

    // Booking on restricted event (`ev_secret`) with public booker (`p_pub`)!
    const secBkRes = await callCrm('/commands/booking.request', 'owner1', {
      requestId: 'h4_bk_sec',
      input: { editionId: secEdId, bookerPersonId: 'p_pub', seats: 1, priceOptionId: 'std' },
    });
    const secBkId = (secBkRes.json.result as { booking: { id: string } }).booking.id;

    // Owner records receipts & refund requests on both bookings
    await callCrm('/commands/ledger.record_receipt', 'owner1', {
      requestId: 'h4_rcpt_pub',
      input: {
        objectType: 'booking',
        objectId: pubBkId,
        amountMinor: 40000,
        currency: 'INR',
        evidenceKind: 'bank_reference',
        evidenceRef: 'UTR-PUB-40K',
      },
    });
    await callCrm('/commands/refund.request', 'owner1', {
      requestId: 'h4_ref_pub',
      input: { objectType: 'booking', objectId: pubBkId, amountMinor: 10000, currency: 'INR', reason: 'Public refund' },
    });
    await callCrm('/commands/ledger.record_receipt', 'owner1', {
      requestId: 'h4_rcpt_sec',
      input: {
        objectType: 'booking',
        objectId: secBkId,
        amountMinor: 90000,
        currency: 'INR',
        evidenceKind: 'bank_reference',
        evidenceRef: 'UTR-SECRET-90K',
      },
    });
    await callCrm('/commands/refund.request', 'owner1', {
      requestId: 'h4_ref_sec',
      input: { objectType: 'booking', objectId: secBkId, amountMinor: 20000, currency: 'INR', reason: 'Secret refund' },
    });

    // 1. fin1 (no access to space-restricted) MUST NOT see secBk's ledger/evidenceRef/refund/income in readMoneyOverview!
    const finOverview = await callCrm('/read/money', 'fin1');
    expect(finOverview.status).toBe(200);
    const finLedger = finOverview.json.ledgerEntries as { evidenceRef: string | null }[];
    const finRefunds = finOverview.json.refundRequests as { objectId: string }[];
    const finTotals = finOverview.json.totalsByCurrency as { currency: string; netMinor: number }[];
    expect(finLedger.some((e) => e.evidenceRef === 'UTR-PUB-40K')).toBe(true);
    expect(finLedger.some((e) => e.evidenceRef === 'UTR-SECRET-90K')).toBe(false);
    expect(finRefunds.some((r) => r.objectId === pubBkId)).toBe(true);
    expect(finRefunds.some((r) => r.objectId === secBkId)).toBe(false);
    expect(finTotals).toEqual([expect.objectContaining({ currency: 'INR', netMinor: 40000 })]);

    // 2. approver_only (crm.refund.approve WITHOUT crm.finance.read) sees accessible refundRequests ONLY — zero payment evidence leaked!
    const apprOverview = await callCrm('/read/money', 'approver_only');
    expect(apprOverview.status).toBe(200);
    expect(apprOverview.json.ledgerEntries).toEqual([]);
    expect(apprOverview.json.paymentRequests).toEqual([]);
    expect(apprOverview.json.totalsByCurrency).toEqual([]);
    expect(apprOverview.json.programmeIncomeByCurrency).toEqual([]);
    const apprRefunds = apprOverview.json.refundRequests as { objectId: string }[];
    expect(apprRefunds.map((r) => r.objectId)).toEqual([pubBkId]);

    // 3. Replay authorization checks AFTER revoking capability or linked-record space access!
    // 3a. screening.upsert replay after revoking crm.restricted.read -> forbidden!
    const scrUpsert = await callCrm('/commands/screening.upsert', 'lead1', {
      requestId: 'h4_scr_replay',
      input: {
        participantId: pubPtId,
        answers: { 'Dietary?': 'Confidential allergy info' },
      },
    });
    expect(scrUpsert.json).toMatchObject({ ok: true });
    await fx!.db
      .prepare(`DELETE FROM crm_capability_grants WHERE user_id = 'lead1' AND capability = 'crm.restricted.read'`)
      .run();
    const scrReplay = await callCrm('/commands/screening.upsert', 'lead1', {
      requestId: 'h4_scr_replay',
      input: {
        participantId: pubPtId,
        answers: { 'Dietary?': 'Confidential allergy info' },
      },
    });
    expect(scrReplay.json).toMatchObject({ ok: false, error: 'forbidden' });

    // 3b. ledger.record_receipt replay after revoking crm.finance.record -> forbidden!
    const finRcpt = await callCrm('/commands/ledger.record_receipt', 'fin1', {
      requestId: 'h4_fin_replay',
      input: {
        objectType: 'booking',
        objectId: pubBkId,
        amountMinor: 5000,
        currency: 'INR',
        evidenceKind: 'cash_voucher',
        evidenceRef: 'CASH-5K',
      },
    });
    expect(finRcpt.json).toMatchObject({ ok: true });
    await fx!.db
      .prepare(`DELETE FROM crm_capability_grants WHERE user_id = 'fin1' AND capability = 'crm.finance.record'`)
      .run();
    const finReplay = await callCrm('/commands/ledger.record_receipt', 'fin1', {
      requestId: 'h4_fin_replay',
      input: {
        objectType: 'booking',
        objectId: pubBkId,
        amountMinor: 5000,
        currency: 'INR',
        evidenceKind: 'cash_voucher',
        evidenceRef: 'CASH-5K',
      },
    });
    expect(finReplay.json).toMatchObject({ ok: false, error: 'forbidden' });

    // 3c. booking.confirm replay on restricted booking after removing lead1 from space-restricted -> forbidden!
    const secConfirm = await callCrm('/commands/booking.confirm', 'lead1', {
      requestId: 'h4_sec_confirm_replay',
      input: { bookingId: secBkId },
    });
    expect(secConfirm.json).toMatchObject({ ok: true });
    await fx!.db
      .prepare(`DELETE FROM space_members WHERE space_id = 'space-restricted' AND user_id = 'lead1'`)
      .run();
    const secConfirmReplay = await callCrm('/commands/booking.confirm', 'lead1', {
      requestId: 'h4_sec_confirm_replay',
      input: { bookingId: secBkId },
    });
    expect(secConfirmReplay.json).toMatchObject({ ok: false, error: 'forbidden' });
  });
});
