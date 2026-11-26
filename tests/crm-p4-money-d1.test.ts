import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../worker/auth';
import { crmApi } from '../worker/crm';
import { openAuditFixture, ctx, type AuditFixture } from './audit-fixture';

let fx: AuditFixture | undefined;

afterEach(async () => {
  await fx?.dispose();
  fx = undefined;
});

async function setupMoneyFixture() {
  fx = await openAuditFixture(
    [
      { id: 'owner1', role: 'admin' },
      { id: 'fin1', role: 'member' },
      { id: 'approver1', role: 'member' },
      { id: 'coord1', role: 'member' },
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
         ('fin1', 'crm.refund.approve', '*', 'owner1', 1),
         ('approver1', 'crm.access', '*', 'owner1', 1),
         ('approver1', 'crm.finance.read', '*', 'owner1', 1),
         ('approver1', 'crm.refund.approve', '*', 'owner1', 1),
         ('coord1', 'crm.access', '*', 'owner1', 1)`,
    ),
    fx.db
      .prepare(
        `INSERT INTO records (id, collection, data, field_ts, seq, updated_at, space_id) VALUES
         ('ev_ws1', 'tasks', ?, '{}', 1, ?, 'space-core'),
         ('p_dev', 'tasks', ?, '{}', 1, ?, 'space-core'),
         ('p_late', 'tasks', ?, '{}', 1, ?, 'space-core')`,
      )
      .bind(
        JSON.stringify({ boardId: 'db_events', title: 'Workshop 1' }),
        now,
        JSON.stringify({ boardId: 'db_people', title: 'Dev Kumar' }),
        now,
        JSON.stringify({ boardId: 'db_people', title: 'Late Payer' }),
        now,
      ),
  ]);
}

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

describe('S7 Manual Financial Operations (append-only ledger, dual control, paid-without-seat, foreign block)', () => {
  it('enforces append-only triggers, duplicate receipt & repeated reversal prevention, partial/overpayment, self-approval block, independent refund approval, paid-without-seat, and foreign block', async () => {
    await setupMoneyFixture();

    // Create edition requiring payment before confirm
    const edRes = await callCrm('/commands/edition.upsert', 'owner1', {
      requestId: 's7_ed_0001',
      input: {
        eventRecordId: 'ev_ws1',
        programmeSlug: 'tribal-habitat-workshop',
        title: 'Workshop 1',
        capacity: 2,
        holdMinutes: 30,
        maxGroupSize: 2,
        confirmBeforePayment: false,
        priceOptions: [{ id: 'std', label: 'Standard', amountMinor: 100000, currency: 'INR', active: true }],
        state: 'open',
      },
    });
    expect(edRes.json).toMatchObject({ ok: true });
    const edId = (edRes.json.result as { edition: { id: string } }).edition.id;

    // Booking 1: request -> hold -> confirm before payment MUST FAIL!
    const bkRes = await callCrm('/commands/booking.request', 'coord1', {
      requestId: 's7_bk_0001',
      input: { editionId: edId, bookerPersonId: 'p_dev', seats: 1, priceOptionId: 'std' },
    });
    const bkId = (bkRes.json.result as { booking: { id: string } }).booking.id;
    await callCrm('/commands/booking.hold', 'coord1', { requestId: 's7_bk1_hold', input: { bookingId: bkId } });

    const unpaidConfirm = await callCrm('/commands/booking.confirm', 'coord1', {
      requestId: 's7_bk1_unpaid_confirm',
      input: { bookingId: bkId },
    });
    expect(unpaidConfirm.json).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'payment_required_before_confirm' },
    });

    // Foreign currency / contributor MUST be blocked pending policy!
    const foreignPr = await callCrm('/commands/payment_request.create', 'fin1', {
      requestId: 's7_pr_usd',
      input: { objectType: 'booking', objectId: bkId, amountMinor: 5000, currency: 'USD' },
    });
    expect(foreignPr.json).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'foreign_contribution_blocked_pending_policy' },
    });

    // Issue INR 1000.00 payment request (100000 paise)
    const prRes = await callCrm('/commands/payment_request.create', 'fin1', {
      requestId: 's7_pr_inr',
      input: { objectType: 'booking', objectId: bkId, amountMinor: 100000, currency: 'INR', label: 'Seat fee' },
    });
    expect(prRes.json).toMatchObject({ ok: true });
    const prId = (prRes.json.result as { paymentRequest: { id: string } }).paymentRequest.id;

    // Foreign residency receipt MUST fail
    const foreignRcpt = await callCrm('/commands/ledger.record_receipt', 'fin1', {
      requestId: 's7_rcpt_foreign',
      input: {
        objectType: 'booking',
        objectId: bkId,
        paymentRequestId: prId,
        amountMinor: 50000,
        currency: 'INR',
        evidenceKind: 'bank_reference',
        evidenceRef: 'UTR-FOR-1',
        contributorResidency: 'foreign',
      },
    });
    expect(foreignRcpt.json).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'foreign_contribution_blocked_pending_policy' },
    });

    // Partial payment: INR 600.00 -> part_paid
    const r1 = await callCrm('/commands/ledger.record_receipt', 'fin1', {
      requestId: 's7_rcpt_1',
      input: {
        objectType: 'booking',
        objectId: bkId,
        paymentRequestId: prId,
        amountMinor: 60000,
        currency: 'INR',
        evidenceKind: 'bank_reference',
        evidenceRef: 'UTR-001',
        receiptIdempotencyKey: 'bank_utr_001',
      },
    });
    expect(r1.json).toMatchObject({ ok: true, result: { paymentStatus: 'part_paid', netPaidMinor: 60000 } });
    const entry1Id = (r1.json.result as { entry: { id: string } }).entry.id;

    // Duplicate receipt with same receiptIdempotencyKey under new command requestId -> idempotency_conflict!
    const dupR1 = await callCrm('/commands/ledger.record_receipt', 'fin1', {
      requestId: 's7_rcpt_1_dup',
      input: {
        objectType: 'booking',
        objectId: bkId,
        paymentRequestId: prId,
        amountMinor: 60000,
        currency: 'INR',
        evidenceKind: 'bank_reference',
        evidenceRef: 'UTR-001',
        receiptIdempotencyKey: 'bank_utr_001',
      },
    });
    expect(dupR1.json).toMatchObject({ ok: false, error: 'idempotency_conflict' });

    // SQL append-only triggers MUST block UPDATE and DELETE on crm_ledger_entries!
    await expect(
      fx!.db.prepare(`UPDATE crm_ledger_entries SET amount_minor = 1 WHERE id = ?`).bind(entry1Id).run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      fx!.db.prepare(`DELETE FROM crm_ledger_entries WHERE id = ?`).bind(entry1Id).run(),
    ).rejects.toThrow(/append-only/);

    // Overpayment: second receipt of INR 700.00 -> net 1300.00 -> overpaid!
    const r2 = await callCrm('/commands/ledger.record_receipt', 'fin1', {
      requestId: 's7_rcpt_2',
      input: {
        objectType: 'booking',
        objectId: bkId,
        paymentRequestId: prId,
        amountMinor: 70000,
        currency: 'INR',
        evidenceKind: 'bank_reference',
        evidenceRef: 'UTR-002',
      },
    });
    expect(r2.json).toMatchObject({ ok: true, result: { paymentStatus: 'overpaid', netPaidMinor: 130000 } });

    // Now booking confirmation SUCCEEDS because authoritative ledger status is overpaid!
    const paidConfirm = await callCrm('/commands/booking.confirm', 'coord1', {
      requestId: 's7_bk1_paid_confirm',
      input: { bookingId: bkId },
    });
    expect(paidConfirm.json).toMatchObject({ ok: true, result: { booking: { state: 'confirmed' } } });

    // Excessive refund (> 130000) MUST fail!
    const bigRef = await callCrm('/commands/refund.request', 'fin1', {
      requestId: 's7_ref_excessive',
      input: { objectType: 'booking', objectId: bkId, amountMinor: 150000, currency: 'INR', reason: 'Too much' },
    });
    expect(bigRef.json).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'excessive_refund' },
    });

    // Request refund of overpayment INR 300.00: unconfigured threshold -> MUST require independent approval!
    const refReq = await callCrm('/commands/refund.request', 'fin1', {
      requestId: 's7_ref_req',
      input: { objectType: 'booking', objectId: bkId, amountMinor: 30000, currency: 'INR', reason: 'Overpayment return' },
    });
    expect(refReq.json).toMatchObject({
      ok: true,
      result: { refundRequest: { state: 'requested', requiresIndependentApproval: true } },
    });
    const refId = (refReq.json.result as { refundRequest: { id: string } }).refundRequest.id;

    // Self-approval by fin1 (even though fin1 holds crm.refund.approve!) MUST be forbidden!
    const selfApprove = await callCrm('/commands/refund.decide', 'fin1', {
      requestId: 's7_ref_self',
      input: { refundRequestId: refId, decision: 'approve', note: 'Self try' },
    });
    expect(selfApprove.json).toMatchObject({
      ok: false,
      error: 'forbidden',
      detail: { reason: 'self_approval_forbidden' },
    });

    // Issuing before approval MUST fail with approval_required!
    const earlyIssue = await callCrm('/commands/refund.issue', 'fin1', {
      requestId: 's7_ref_early',
      input: { refundRequestId: refId, evidenceRef: 'REF-001' },
    });
    expect(earlyIssue.json).toMatchObject({ ok: false, error: 'approval_required' });

    // Second person (approver1) approves -> fin1 issues -> net returns to 100000 ('paid')!
    const approve = await callCrm('/commands/refund.decide', 'approver1', {
      requestId: 's7_ref_approve',
      input: { refundRequestId: refId, decision: 'approve', note: 'Verified overpayment' },
    });
    expect(approve.json).toMatchObject({ ok: true, result: { refundRequest: { state: 'approved' } } });

    const issue = await callCrm('/commands/refund.issue', 'fin1', {
      requestId: 's7_ref_issue',
      input: { refundRequestId: refId, evidenceRef: 'REF-UTR-300' },
    });
    expect(issue.json).toMatchObject({ ok: true, result: { paymentStatus: 'paid' } });

    // Reversal of entry1 -> succeeds once; second reversal of same entry MUST fail!
    const rev1 = await callCrm('/commands/ledger.reverse_entry', 'fin1', {
      requestId: 's7_rev_0001',
      input: { entryId: entry1Id, reason: 'Bank bounce' },
    });
    expect(rev1.json).toMatchObject({ ok: true, result: { paymentStatus: 'part_paid', netPaidMinor: 40000 } });

    const rev1Again = await callCrm('/commands/ledger.reverse_entry', 'fin1', {
      requestId: 's7_rev_1_again',
      input: { entryId: entry1Id, reason: 'Duplicate reversal' },
    });
    expect(rev1Again.json).toMatchObject({ ok: false, error: 'stale', detail: { reason: 'entry_already_reversed' } });

    // Payment received AFTER hold expiry -> paid_without_seat review (NEVER auto-confirm or oversell!)
    const lateBk = await callCrm('/commands/booking.request', 'coord1', {
      requestId: 's7_late_bk',
      input: { editionId: edId, bookerPersonId: 'p_late', seats: 1, priceOptionId: 'std' },
    });
    const lateBkId = (lateBk.json.result as { booking: { id: string } }).booking.id;
    await callCrm('/commands/booking.hold', 'coord1', { requestId: 's7_late_hold', input: { bookingId: lateBkId } });
    // Expire hold
    const past = Date.now() - 60_000;
    await fx!.db.batch([
      fx!.db.prepare(`UPDATE crm_allocations SET expires_at = ? WHERE booking_id = ?`).bind(past, lateBkId),
      fx!.db.prepare(`UPDATE crm_bookings SET hold_expires_at = ? WHERE id = ?`).bind(past, lateBkId),
    ]);
    await callCrm('/commands/payment_request.create', 'fin1', {
      requestId: 's7_late_pr',
      input: { objectType: 'booking', objectId: lateBkId, amountMinor: 100000, currency: 'INR' },
    });
    const latePay = await callCrm('/commands/ledger.record_receipt', 'fin1', {
      requestId: 's7_late_rcpt',
      input: {
        objectType: 'booking',
        objectId: lateBkId,
        amountMinor: 100000,
        currency: 'INR',
        evidenceKind: 'bank_reference',
        evidenceRef: 'UTR-LATE-1',
      },
    });
    expect(latePay.json).toMatchObject({
      ok: true,
      result: { paymentStatus: 'paid', bookingStateAfter: 'paid_without_seat' },
    });

    // Capability-gated financial read: coord1 -> 403, fin1 -> 200 with INR-isolated totals
    const coordMoney = await callCrm('/read/money', 'coord1');
    expect(coordMoney.status).toBe(403);
    const finMoney = await callCrm('/read/money', 'fin1');
    expect(finMoney.status).toBe(200);
    expect((finMoney.json.totalsByCurrency as { currency: string; netMinor: number }[])).toEqual([
      expect.objectContaining({ currency: 'INR', netMinor: 140000 }),
    ]);
  });
});
