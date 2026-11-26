import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../worker/auth';
import { crmApi } from '../worker/crm';
import { openAuditFixture, ctx, type AuditFixture } from './audit-fixture';

let fx: AuditFixture | undefined;

afterEach(async () => {
  await fx?.dispose();
  fx = undefined;
});

async function setupP4Fixture() {
  fx = await openAuditFixture(
    [
      { id: 'owner1', role: 'admin' },
      { id: 'merger_no_scr', role: 'admin' },
      { id: 'fin1', role: 'member' },
    ],
    { CRM_ENABLED: '1', WORKSPACE_ENV: 'local-test' } as Partial<Env>,
  );
  const now = Date.now();
  await fx.db.batch([
    fx.db.prepare(
      `UPDATE users SET workspace_role = CASE id WHEN 'owner1' THEN 'owner' WHEN 'merger_no_scr' THEN 'admin' ELSE 'member' END`,
    ),
    fx.db.prepare(
      `INSERT INTO crm_capability_grants (user_id, capability, scope, granted_by, granted_at)
       VALUES
         ('merger_no_scr', 'crm.access', '*', 'owner1', 1),
         ('merger_no_scr', 'crm.merge', '*', 'owner1', 1),
         ('fin1', 'crm.access', '*', 'owner1', 1),
         ('fin1', 'crm.finance.read', '*', 'owner1', 1),
         ('fin1', 'crm.finance.record', '*', 'owner1', 1)`,
    ),
    fx.db
      .prepare(
        `INSERT INTO records (id, collection, data, field_ts, seq, updated_at, space_id) VALUES
         ('db_people', 'boards', ?, '{}', 1, ?, 'space-core'),
         ('ev_thw', 'tasks', ?, '{}', 1, ?, 'space-core'),
         ('p_member', 'tasks', ?, '{}', 1, ?, 'space-core'),
         ('p_surv', 'tasks', ?, '{}', 1, ?, 'space-core'),
         ('p_loser_clean', 'tasks', ?, '{}', 1, ?, 'space-core'),
         ('p_loser_fin', 'tasks', ?, '{}', 1, ?, 'space-core')`,
      )
      .bind(
        JSON.stringify({ name: 'People', kind: 'records', templateDbKey: 'people', columns: [], fields: [] }),
        now,
        JSON.stringify({ boardId: 'db_events', title: 'THW Edition' }),
        now,
        JSON.stringify({ boardId: 'db_people', title: 'Meera Roots' }),
        now,
        JSON.stringify({ boardId: 'db_people', title: 'Rohan Canonical' }),
        now,
        JSON.stringify({ boardId: 'db_people', title: 'Rohan Duplicate' }),
        now,
        JSON.stringify({ boardId: 'db_people', title: 'Rohan Paid Dup' }),
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

describe('S8 Common Roots Membership & Cross-Module Merge/Unmerge Integrity', () => {
  it('enforces configurable schemes (no hardcoded amounts/benefits), ledger-backed activation/renewal, reversal consistency, and Home/Timeline integration', async () => {
    await setupP4Fixture();

    // 1. Activating an unconfigured scheme fails closed (pending O-07)
    const uncfgScheme = await callCrm('/commands/membership_scheme.upsert', 'owner1', {
      requestId: 's8_scheme_uncfg',
      input: { slug: 'roots-2026', name: 'Common Roots', active: true },
    });
    expect(uncfgScheme.json).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'scheme_contribution_unconfigured_pending_O07' },
    });

    // 2. Configure scheme with explicit contribution, validity, renewal notice & identifier format; benefitsEnabled stays false!
    const schemeRes = await callCrm('/commands/membership_scheme.upsert', 'owner1', {
      requestId: 's8_scheme_cfg',
      input: {
        slug: 'roots-2026',
        name: 'Common Roots Annual',
        contributionAmountMinor: 50000,
        currency: 'INR',
        validityDays: 365,
        renewalNoticeDays: 30,
        identifierPrefix: 'CR',
        identifierDigits: 4,
        active: true,
      },
    });
    expect(schemeRes.json).toMatchObject({
      ok: true,
      result: { scheme: { benefitsEnabled: false, active: true } },
    });
    const schemeId = (schemeRes.json.result as { scheme: { id: string } }).scheme.id;

    // 3. Apply -> approve -> issue contribution request -> activate BEFORE receipt MUST FAIL!
    const applyRes = await callCrm('/commands/membership.apply', 'owner1', {
      requestId: 's8_mem_apply',
      input: { schemeId, personId: 'p_member' },
    });
    const memId = (applyRes.json.result as { membership: { id: string } }).membership.id;

    await callCrm('/commands/membership.decide', 'owner1', {
      requestId: 's8_mem_approve',
      input: { membershipId: memId, decision: 'approve', reason: 'Welcome to Common Roots' },
    });
    await callCrm('/commands/membership.issue_request', 'fin1', {
      requestId: 's8_mem_issue_req',
      input: { membershipId: memId },
    });

    const unpaidActivate = await callCrm('/commands/membership.activate', 'owner1', {
      requestId: 's8_mem_act_unpaid',
      input: { membershipId: memId },
    });
    expect(unpaidActivate.json).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'contribution_receipt_required' },
    });

    // 4. Record manual contribution receipt -> activate succeeds with formatted ID CR-0001!
    const rcpt1 = await callCrm('/commands/ledger.record_receipt', 'fin1', {
      requestId: 's8_mem_rcpt_1',
      input: {
        objectType: 'membership',
        objectId: memId,
        amountMinor: 50000,
        currency: 'INR',
        evidenceKind: 'bank_reference',
        evidenceRef: 'UTR-ROOTS-1',
      },
    });
    expect(rcpt1.json).toMatchObject({ ok: true, result: { paymentStatus: 'paid' } });
    const rcpt1Id = (rcpt1.json.result as { entry: { id: string } }).entry.id;

    const act1 = await callCrm('/commands/membership.activate', 'owner1', {
      requestId: 's8_mem_act_1',
      input: { membershipId: memId },
    });
    expect(act1.json).toMatchObject({
      ok: true,
      result: { membership: { state: 'active', memberIdentifier: 'CR-0001', periodCount: 1 } },
    });

    // 5. Reversing the contribution receipt MUST demote unsupported Active membership back to awaiting_contribution!
    const rev = await callCrm('/commands/ledger.reverse_entry', 'fin1', {
      requestId: 's8_mem_rev_1',
      input: { entryId: rcpt1Id, reason: 'Cheque dishonoured' },
    });
    expect(rev.json).toMatchObject({ ok: true, result: { paymentStatus: 'unpaid' } });
    const afterRevRow = await fx!.db
      .prepare(`SELECT state, payment_status FROM crm_memberships WHERE id = ?`)
      .bind(memId)
      .first<{ state: string; payment_status: string }>();
    expect(afterRevRow).toEqual({ state: 'awaiting_contribution', payment_status: 'unpaid' });

    // Re-pay and re-activate cleanly (keeps same member_identifier CR-0001!)
    await callCrm('/commands/ledger.record_receipt', 'fin1', {
      requestId: 's8_mem_rcpt_2',
      input: {
        objectType: 'membership',
        objectId: memId,
        amountMinor: 100000, // Covers re-activation (period 2)
        currency: 'INR',
        evidenceKind: 'bank_reference',
        evidenceRef: 'UTR-ROOTS-2',
      },
    });
    const act2 = await callCrm('/commands/membership.activate', 'owner1', {
      requestId: 's8_mem_act_2',
      input: { membershipId: memId },
    });
    expect(act2.json).toMatchObject({
      ok: true,
      result: { membership: { state: 'active', memberIdentifier: 'CR-0001' } },
    });

    // 6. Simulate approaching expiry -> effectiveState becomes renewal_due & surfaces in Home!
    const soon = Date.now() + 5 * 86_400_000;
    await fx!.db.prepare(`UPDATE crm_memberships SET valid_until = ? WHERE id = ?`).bind(soon, memId).run();

    const homeRes = await callCrm('/read/home', 'owner1');
    expect(homeRes.status).toBe(200);
    const thisWeek = homeRes.json.thisWeek as { kind: string; title: string }[];
    expect(thisWeek.some((i) => i.kind === 'membership_renewal_due' && i.title.includes('Meera Roots'))).toBe(true);

    // Renewal BEFORE recording renewal receipt fails; AFTER recording receipt succeeds!
    const unpaidRenew = await callCrm('/commands/membership.renew', 'owner1', {
      requestId: 's8_mem_ren_unpaid',
      input: { membershipId: memId },
    });
    expect(unpaidRenew.json).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'renewal_contribution_receipt_required' },
    });

    await callCrm('/commands/ledger.record_receipt', 'fin1', {
      requestId: 's8_mem_rcpt_ren',
      input: {
        objectType: 'membership',
        objectId: memId,
        amountMinor: 50000,
        currency: 'INR',
        evidenceKind: 'bank_reference',
        evidenceRef: 'UTR-ROOTS-REN',
      },
    });
    const renewOk = await callCrm('/commands/membership.renew', 'owner1', {
      requestId: 's8_mem_ren_ok',
      input: { membershipId: memId },
    });
    expect(renewOk.json).toMatchObject({ ok: true, result: { membership: { state: 'active', effectiveState: 'active' } } });

    // Timeline includes membership item
    const tl = await callCrm('/read/timeline?subject=p_member', 'owner1');
    expect(tl.status).toBe(200);
    expect((tl.json.items as { kind: string }[]).some((i) => i.kind === 'membership')).toBe(true);
  });

  it('protects append-only ledger history, restricted screening authority, and atomically merges/unmerges bookings, participants, and memberships', async () => {
    await setupP4Fixture();

    const edRes = await callCrm('/commands/edition.upsert', 'owner1', {
      requestId: 's8m_ed_001',
      input: {
        eventRecordId: 'ev_thw',
        programmeSlug: 'tribal-habitat-workshop',
        title: 'THW Merge Test',
        capacity: 5,
        holdMinutes: 60,
        maxGroupSize: 3,
        confirmBeforePayment: true,
        requiresScreening: true,
        screeningQuestions: ['Dietary notes?'],
        state: 'open',
      },
    });
    const edId = (edRes.json.result as { edition: { id: string } }).edition.id;

    // 1. Loser with financial ledger entry -> merge MUST refuse (append-only ledger cannot be rewritten!)
    const finBk = await callCrm('/commands/booking.request', 'owner1', {
      requestId: 's8m_fin_bk',
      input: { editionId: edId, bookerPersonId: 'p_loser_fin', seats: 1 },
    });
    const finBkId = (finBk.json.result as { booking: { id: string } }).booking.id;
    await callCrm('/commands/ledger.record_receipt', 'fin1', {
      requestId: 's8m_fin_rcpt',
      input: {
        objectType: 'booking',
        objectId: finBkId,
        amountMinor: 50000,
        currency: 'INR',
        evidenceKind: 'bank_reference',
        evidenceRef: 'UTR-FIN-MERGE',
      },
    });
    const survSeq1 = (await fx!.db.prepare(`SELECT seq FROM records WHERE id = 'p_surv'`).first<{ seq: number }>())!.seq;
    const finLoserSeq = (await fx!.db.prepare(`SELECT seq FROM records WHERE id = 'p_loser_fin'`).first<{ seq: number }>())!.seq;

    const refusedFinMerge = await callCrm('/commands/person.merge', 'owner1', {
      requestId: 's8m_merge_fin_refuse',
      expected: { p_surv: survSeq1, p_loser_fin: finLoserSeq },
      input: { survivorId: 'p_surv', loserId: 'p_loser_fin', confirm: true },
    });
    expect(refusedFinMerge.json).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'loser_has_financial_history_cannot_rewrite_ledger' },
    });

    // 2. Loser with booking + participant + restricted screening (no financial entries):
    //    - merger_no_scr (lacks crm.restricted.read) -> refused with restricted_screening_authority_required!
    //    - owner1 (has full authority) -> merges atomically, moves booking & participant, and clean unmerge restores them!
    const cleanBk = await callCrm('/commands/booking.request', 'owner1', {
      requestId: 's8m_clean_bk',
      input: { editionId: edId, bookerPersonId: 'p_loser_clean', seats: 1 },
    });
    const cleanBkId = (cleanBk.json.result as { booking: { id: string } }).booking.id;
    const cleanPtId = (cleanBk.json.result as { participants: { id: string }[] }).participants[0]!.id;
    await callCrm('/commands/screening.upsert', 'owner1', {
      requestId: 's8m_clean_scr',
      input: { participantId: cleanPtId, answers: { 'Dietary notes?': 'Vegetarian' } },
    });

    const sSeq = (await fx!.db.prepare(`SELECT seq FROM records WHERE id = 'p_surv'`).first<{ seq: number }>())!.seq;
    const lSeq = (await fx!.db.prepare(`SELECT seq FROM records WHERE id = 'p_loser_clean'`).first<{ seq: number }>())!.seq;

    const unauthMerge = await callCrm('/commands/person.merge', 'merger_no_scr', {
      requestId: 's8m_merge_no_scr',
      expected: { p_surv: sSeq, p_loser_clean: lSeq },
      input: { survivorId: 'p_surv', loserId: 'p_loser_clean', confirm: true },
    });
    expect(unauthMerge.json).toMatchObject({
      ok: false,
      error: 'forbidden',
      detail: { reason: 'restricted_screening_authority_required' },
    });

    const okMerge = await callCrm('/commands/person.merge', 'owner1', {
      requestId: 's8m_merge_ok',
      expected: { p_surv: sSeq, p_loser_clean: lSeq },
      input: { survivorId: 'p_surv', loserId: 'p_loser_clean', confirm: true },
    });
    expect(okMerge.json).toMatchObject({ ok: true });
    const mergeId = (okMerge.json.result as { mergeId: string }).mergeId;

    expect(
      await fx!.db.prepare(`SELECT booker_person_id FROM crm_bookings WHERE id = ?`).bind(cleanBkId).first('booker_person_id'),
    ).toBe('p_surv');
    expect(
      await fx!.db.prepare(`SELECT person_id FROM crm_participants WHERE id = ?`).bind(cleanPtId).first('person_id'),
    ).toBe('p_surv');

    // Clean unmerge restores booking & participant back to p_loser_clean!
    const sSeqPost = (await fx!.db.prepare(`SELECT seq FROM records WHERE id = 'p_surv'`).first<{ seq: number }>())!.seq;
    const lSeqPost = (await fx!.db.prepare(`SELECT seq FROM records WHERE id = 'p_loser_clean'`).first<{ seq: number }>())!.seq;
    const okUnmerge = await callCrm('/commands/person.unmerge', 'owner1', {
      requestId: 's8m_unmerge_ok',
      expected: { p_surv: sSeqPost, p_loser_clean: lSeqPost },
      input: { mergeId, confirm: true, reason: 'Reverting test merge' },
    });
    expect(okUnmerge.json).toMatchObject({ ok: true });
    expect(
      await fx!.db.prepare(`SELECT booker_person_id FROM crm_bookings WHERE id = ?`).bind(cleanBkId).first('booker_person_id'),
    ).toBe('p_loser_clean');
    expect(
      await fx!.db.prepare(`SELECT person_id FROM crm_participants WHERE id = ?`).bind(cleanPtId).first('person_id'),
    ).toBe('p_loser_clean');
  });
});
