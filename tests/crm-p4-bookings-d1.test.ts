import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../worker/auth';
import { crmApi } from '../worker/crm';
import { openAuditFixture, ctx, type AuditFixture } from './audit-fixture';

let fx: AuditFixture | undefined;

afterEach(async () => {
  await fx?.dispose();
  fx = undefined;
});

async function setupBookingsFixture() {
  fx = await openAuditFixture(
    [
      { id: 'owner1', role: 'admin' },
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
         ('coord1', 'crm.access', '*', 'owner1', 1),
         ('lead1', 'crm.access', '*', 'owner1', 1),
         ('lead1', 'crm.configure', 'programme:tribal-habitat-workshop', 'owner1', 1),
         ('lead1', 'crm.restricted.read', 'programme:tribal-habitat-workshop', 'owner1', 1)`,
    ),
    fx.db
      .prepare(
        `INSERT INTO records (id, collection, data, field_ts, seq, updated_at, space_id) VALUES
         ('ev_thw_nov', 'tasks', ?, '{}', 1, ?, 'space-core'),
         ('ev_thw_dec', 'tasks', ?, '{}', 1, ?, 'space-core'),
         ('p_alice', 'tasks', ?, '{}', 1, ?, 'space-core'),
         ('p_bob', 'tasks', ?, '{}', 1, ?, 'space-core'),
         ('p_cara', 'tasks', ?, '{}', 1, ?, 'space-core')`,
      )
      .bind(
        JSON.stringify({ boardId: 'db_events', title: 'THW Nov Edition' }),
        now,
        JSON.stringify({ boardId: 'db_events', title: 'THW Dec Edition' }),
        now,
        JSON.stringify({ boardId: 'db_people', title: 'Alice Dev' }),
        now,
        JSON.stringify({ boardId: 'db_people', title: 'Bob Nair' }),
        now,
        JSON.stringify({ boardId: 'db_people', title: 'Cara Sen' }),
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

describe('S6 Editions & Bookings (D1 transactional integrity)', () => {
  it('enforces unconfigured policy fail-closed, concurrent final-seat safety, inline hold expiry, waitlist offer/accept, group placeholders, transfer, attendance, and restricted screening', async () => {
    await setupBookingsFixture();

    // 1. Opening an edition with unconfigured policy MUST fail closed!
    const uncfg = await callCrm('/commands/edition.upsert', 'lead1', {
      requestId: 's6_ed_uncfg',
      input: {
        eventRecordId: 'ev_thw_nov',
        programmeSlug: 'tribal-habitat-workshop',
        title: 'Tribal Habitat Nov',
        state: 'open',
      },
    });
    expect(uncfg.json).toMatchObject({
      ok: false,
      error: 'invalid_input',
      detail: { reason: 'edition_policy_unconfigured_pending_O05' },
    });

    // 2. Configure Edition 1 (capacity = 3, hold = 60m, screening required) & Edition 2 (capacity = 2)
    const ed1Res = await callCrm('/commands/edition.upsert', 'lead1', {
      requestId: 's6_ed1_open',
      input: {
        eventRecordId: 'ev_thw_nov',
        programmeSlug: 'tribal-habitat-workshop',
        title: 'Tribal Habitat Nov',
        capacity: 3,
        holdMinutes: 60,
        maxGroupSize: 3,
        confirmBeforePayment: true,
        requiresScreening: true,
        screeningQuestions: ['Any mobility considerations?', 'Dietary needs?'],
        priceOptions: [{ id: 'standard', label: 'Standard seat', amountMinor: 150000, currency: 'INR', active: true }],
        sessionDates: ['2026-12-01', '2026-12-02'],
        state: 'open',
      },
    });
    expect(ed1Res.json).toMatchObject({ ok: true });
    const ed1Id = ((ed1Res.json.result as { edition: { id: string } }).edition).id;

    const ed2Res = await callCrm('/commands/edition.upsert', 'lead1', {
      requestId: 's6_ed2_open',
      input: {
        eventRecordId: 'ev_thw_dec',
        programmeSlug: 'tribal-habitat-workshop',
        title: 'Tribal Habitat Dec',
        capacity: 2,
        holdMinutes: 60,
        maxGroupSize: 2,
        confirmBeforePayment: true,
        state: 'open',
      },
    });
    const ed2Id = ((ed2Res.json.result as { edition: { id: string } }).edition).id;

    // 3. Group booking for 2 seats (1 named booker + 1 placeholder) -> hold & confirm (leaves 1 final seat!)
    const grpReq = await callCrm('/commands/booking.request', 'coord1', {
      requestId: 's6_grp_req',
      input: { editionId: ed1Id, bookerPersonId: 'p_alice', seats: 2, priceOptionId: 'standard' },
    });
    expect(grpReq.json).toMatchObject({ ok: true });
    const grpBookingId = (grpReq.json.result as { booking: { id: string } }).booking.id;
    const grpParticipants = (grpReq.json.result as { participants: { id: string; state: string }[] }).participants;
    expect(grpParticipants).toHaveLength(2);
    expect(grpParticipants[0]!.state).toBe('named');
    expect(grpParticipants[1]!.state).toBe('placeholder');

    const grpHold = await callCrm('/commands/booking.hold', 'coord1', {
      requestId: 's6_grp_hold',
      input: { bookingId: grpBookingId },
    });
    expect(grpHold.json).toMatchObject({ ok: true, result: { booking: { state: 'held' } } });

    const grpConfirm = await callCrm('/commands/booking.confirm', 'coord1', {
      requestId: 's6_grp_confirm',
      input: { bookingId: grpBookingId },
    });
    expect(grpConfirm.json).toMatchObject({ ok: true, result: { booking: { state: 'confirmed' } } });

    // Name placeholder participant
    const namePt = await callCrm('/commands/participant.update', 'coord1', {
      requestId: 's6_name_pt2',
      input: { participantId: grpParticipants[1]!.id, displayName: 'Arjun Dev' },
    });
    expect(namePt.json).toMatchObject({ ok: true, result: { participant: { state: 'named', displayName: 'Arjun Dev' } } });

    // 4. Two competing requests for the FINAL remaining seat (1 of 3 left) -> concurrent holds MUST never oversell!
    const bobReq = await callCrm('/commands/booking.request', 'coord1', {
      requestId: 's6_bob_req',
      input: { editionId: ed1Id, bookerPersonId: 'p_bob', seats: 1 },
    });
    const caraReq = await callCrm('/commands/booking.request', 'coord1', {
      requestId: 's6_cara_req',
      input: { editionId: ed1Id, bookerPersonId: 'p_cara', seats: 1 },
    });
    const bobBkId = (bobReq.json.result as { booking: { id: string } }).booking.id;
    const caraBkId = (caraReq.json.result as { booking: { id: string } }).booking.id;

    const [bobHold, caraHold] = await Promise.all([
      callCrm('/commands/booking.hold', 'coord1', { requestId: 's6_race_bob', input: { bookingId: bobBkId } }),
      callCrm('/commands/booking.hold', 'coord1', { requestId: 's6_race_cara', input: { bookingId: caraBkId } }),
    ]);
    const winners = [bobHold, caraHold].filter((r) => r.json.ok === true);
    const losers = [bobHold, caraHold].filter((r) => r.json.ok === false);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.json.error).toBe('capacity_exceeded');

    const winnerId = winners[0] === bobHold ? bobBkId : caraBkId;
    const loserId = winners[0] === bobHold ? caraBkId : bobBkId;

    // 5. Expire winner's hold directly in DB WITHOUT running any background sweep -> capacity MUST release inline!
    const past = Date.now() - 60_000;
    await fx!.db.batch([
      fx!.db.prepare(`UPDATE crm_allocations SET expires_at = ? WHERE booking_id = ?`).bind(past, winnerId),
      fx!.db.prepare(`UPDATE crm_bookings SET hold_expires_at = ? WHERE id = ?`).bind(past, winnerId),
    ]);

    // Move loser to waitlisted, then offer seat (inline expiry freed the 3rd seat!) and accept offer
    await fx!.db.prepare(`UPDATE crm_bookings SET state = 'waitlisted' WHERE id = ?`).bind(loserId).run();
    const offerRes = await callCrm('/commands/waitlist.offer', 'coord1', {
      requestId: 's6_wl_offer',
      input: { bookingId: loserId },
    });
    expect(offerRes.json).toMatchObject({ ok: true, result: { booking: { state: 'offered' } } });

    const acceptRes = await callCrm('/commands/waitlist.accept', 'coord1', {
      requestId: 's6_wl_accept',
      input: { bookingId: loserId },
    });
    expect(acceptRes.json).toMatchObject({ ok: true, result: { booking: { state: 'held' } } });

    // 6. Atomic transfer of Alice's 2-seat confirmed booking from Edition 1 -> Edition 2 (capacity 2)
    const xfer = await callCrm('/commands/booking.transfer', 'coord1', {
      requestId: 's6_xfer_ed2',
      input: { bookingId: grpBookingId, targetEditionId: ed2Id },
    });
    expect(xfer.json).toMatchObject({ ok: true, result: { booking: { editionId: ed2Id, state: 'confirmed' } } });

    // Verify source edition now has 0 confirmed seats and target edition has 2 confirmed seats
    const ed1Detail = await callCrm(`/read/edition/${ed1Id}`, 'coord1');
    expect((ed1Detail.json.edition as { confirmedSeats: number }).confirmedSeats).toBe(0);
    const ed2Detail = await callCrm(`/read/edition/${ed2Id}`, 'coord1');
    expect((ed2Detail.json.edition as { confirmedSeats: number }).confirmedSeats).toBe(2);

    // 7. Restricted screening: lead1 (with crm.restricted.read for tribal-habitat-workshop) can upsert & review;
    //    coord1 (without crm.restricted.read) receives 403 forbidden and sees zero screening fields in ordinary reads!
    const scrUpsert = await callCrm('/commands/screening.upsert', 'lead1', {
      requestId: 's6_scr_upsert',
      input: {
        participantId: grpParticipants[0]!.id,
        answers: { 'Any mobility considerations?': 'Needs ground-floor room' },
        evidenceNote: 'Self-reported form',
      },
    });
    expect(scrUpsert.json).toMatchObject({ ok: true, result: { screening: { state: 'received' } } });

    const scrReview = await callCrm('/commands/screening.review', 'lead1', {
      requestId: 's6_scr_review',
      input: { participantId: grpParticipants[0]!.id, state: 'cleared', reviewNote: 'Ground-floor room confirmed' },
    });
    expect(scrReview.json).toMatchObject({ ok: true, result: { screening: { state: 'cleared' } } });

    const coordScrRead = await callCrm(`/read/booking/${grpBookingId}/screening`, 'coord1');
    expect(coordScrRead.status).toBe(403);
    const leadScrRead = await callCrm(`/read/booking/${grpBookingId}/screening`, 'lead1');
    expect(leadScrRead.status).toBe(200);
    expect((leadScrRead.json.items as unknown[]).length).toBe(1);

    // Ordinary booking detail MUST NOT leak screening text
    const bkDetail = await callCrm(`/read/booking/${grpBookingId}`, 'coord1');
    expect(JSON.stringify(bkDetail.json)).not.toContain('ground-floor');

    // 8. Attendance recording + edition completion leaves unrecorded slots as 'not_recorded' (never 'absent')
    await callCrm('/commands/edition.upsert', 'lead1', {
      requestId: 's6_ed2_dates',
      input: {
        editionId: ed2Id,
        eventRecordId: 'ev_thw_dec',
        programmeSlug: 'tribal-habitat-workshop',
        title: 'Tribal Habitat Dec',
        sessionDates: ['2026-12-10', '2026-12-11'],
      },
    });
    const att = await callCrm('/commands/attendance.record', 'coord1', {
      requestId: 's6_att_1',
      input: { participantId: grpParticipants[0]!.id, sessionDate: '2026-12-10', state: 'present' },
    });
    expect(att.json).toMatchObject({ ok: true, result: { attendance: { state: 'present' } } });

    const comp = await callCrm('/commands/edition.complete', 'lead1', {
      requestId: 's6_ed2_complete',
      input: { editionId: ed2Id },
    });
    expect(comp.json).toMatchObject({ ok: true, result: { completedBookings: 1 } });
    const attDay2 = await fx!.db
      .prepare(`SELECT state FROM crm_attendance WHERE participant_id = ? AND session_date = '2026-12-11'`)
      .bind(grpParticipants[0]!.id)
      .first<{ state: string }>();
    expect(attDay2?.state).toBe('not_recorded');
  });
});
