# CRM P4 Operations Contract (`crm-p4-v1`)

**Scope:** S6 Editions & Bookings, S7 Manual Financial Operations, S8 Common Roots Membership, and Cross-Module Merge/Unmerge Integrity.  
**Migration:** `migrations/0049_crm_operations.sql` (migration #49, server-only D1 tables; never in `shared/collections.ts`).  
**Governance:** Preserves A-19 through A-28, S0 command journaling/replay safety, `ReadGate`, capability enforcement, projection protection, and WCAG 2.2 AA mobile functional parity.

---

## 1. S6 — Editions & Bookings

- **Editions (`crm_editions`):** 1:1 with canonical Workspace Events (`event_record_id`) and Programme (`programme_slug`). Capacity, hold duration (`hold_minutes`), max group size, `confirm_before_payment`, price options, session dates, and screening questions are configurable — **unconfigured consequential policies fail closed** (`policy_unconfigured`). No historical capacities, prices, durations, or screening questions are hardcoded.
- **Atomic Capacity (`crm_allocations`):** Seats in use = `SUM(seats)` where `released_at IS NULL AND (kind = 'confirmed' OR expires_at > now)`. Every allocation (`booking.hold`, `booking.confirm`, `waitlist.offer`, `booking.transfer`) executes a single conditional `INSERT` fenced by `changes() = 1` in the same D1 batch. Expired holds release capacity inline regardless of whether a background sweep has run.
- **Group Bookings & Placeholders (`crm_participants`):** Group bookings hold all seats or none; unnamed participants are stored as `placeholder` rows until named via `participant.update`.
- **Waitlists & Offers:** `booking.request` with no seats or explicit waitlist choice enters `waitlisted`; `waitlist.offer` atomically creates a time-bounded hold (`offered`); `waitlist.accept` converts to `held` (never auto-confirmed without acceptance and required payment).
- **Atomic Transfers (`booking.transfer`):** Allocates seats in the target edition and releases the source allocation in one atomic D1 batch.
- **Attendance (`crm_attendance`):** Per participant per `YYYY-MM-DD` session date (`present | absent | partial | not_recorded`). Completing an edition leaves unrecorded slots as `not_recorded` (never `absent`).
- **Restricted Screening (`crm_screenings`):** Server-only table gated strictly by `crm.restricted.read` for `programme:<slug>` or `*`. Excluded from ordinary sync, generic search, unauthorized MCP/AI output, notifications, and projections. No automatic medical or suitability decisions.
- **Offline Booking Requests:** Client records offline requests visibly as `"Request, not confirmed"` intents until accepted by the server via `booking.request`.

### S6 Commands & Reads
- Commands: `edition.upsert`, `edition.set_state`, `booking.request`, `booking.hold`, `booking.confirm`, `booking.cancel`, `booking.transfer`, `waitlist.offer`, `waitlist.accept`, `participant.update`, `attendance.record`, `screening.upsert`, `screening.review`, `edition.complete`.
- Reads: `GET /api/crm/read/editions`, `GET /api/crm/read/edition/:id`, `GET /api/crm/read/bookings`, `GET /api/crm/read/booking/:id`, `GET /api/crm/read/booking/:id/screening` (strictly `crm.restricted.read` scoped to `programme:<slug>` or `*`).

---

## 2. S7 — Manual Financial Operations

- **Integer Minor Units & Currency Isolation:** Every amount is stored as an integer in minor units with an explicit uppercase ISO 4217 currency (`INR`, `USD`, etc.). Totals and balances are ALWAYS grouped by currency and NEVER summed across different currencies.
- **Append-Only Ledger (`crm_ledger_entries`):** SQL `BEFORE UPDATE` and `BEFORE DELETE` triggers unconditionally abort mutations. `idempotency_key UNIQUE` blocks duplicate receipts; `reverses_entry_id UNIQUE` blocks repeated reversals; `refund_request_id UNIQUE` blocks duplicate refund issuance.
- **Authoritative Paid State:** A booking or membership becomes `paid` / `overpaid` ONLY from ledger math (`netPaidMinor >= dueMinor`), projected to `_crm_payment_status` via `ProjectionGrant` — never from editable Workspace fields or stages.
- **Payment After Hold Expiry:** Recording a receipt for an expired booking appends the receipt to the ledger and transitions the booking to `paid_without_seat` for human review — NEVER auto-oversells, auto-confirms, or auto-refunds.
- **Refund Policy & Dual Control (`crm_refund_policies`, `crm_refund_requests`):** Thresholds per currency are configurable and default to unconfigured (`NULL`), which ALWAYS requires independent approval from a second actor holding `crm.refund.approve`. Self-approval is always refused (`self_approval_forbidden`). Refunds cannot exceed net paid balance for that object and currency (`excessive_refund`).
- **Foreign Contributions Blocked:** `contributor_residency` and `allow_foreign_contributions` fail closed (`foreign_contribution_blocked_pending_policy`, O-14 / C-03).
- **Operational Scope:** Operational ledger only — no GST computation, no statutory invoices, no live payment-provider API calls or money movement.

### S7 Commands & Reads
- Commands: `payment_request.create`, `payment_request.cancel`, `ledger.record_receipt`, `ledger.reverse_entry`, `refund_policy.configure`, `refund.request`, `refund.decide`, `refund.issue`.
- Reads: `GET /api/crm/read/money` (requires `crm.finance.read`), `GET /api/crm/read/refunds` (requires `crm.finance.read` or `crm.refund.approve`).

---

## 3. S8 — Common Roots Membership

- **Configurable Schemes (`crm_membership_schemes`):** Contribution amount, currency, validity days, renewal notice window, and member identifier prefix/digits are all configurable (no historical defaults hardcoded). Unconfigured schemes fail closed on activation/request. `benefits_enabled` is locked to `0` until owner-approved rules exist (O-07).
- **Lifecycle (`crm_memberships`):** `applied` -> `approved` | `declined`; `approved` -> `awaiting_contribution` (issues payment request) -> `active` (requires authoritative ledger receipt covering scheme contribution; allocates configurable member identifier + `valid_from`/`valid_until`); `active` -> `renewal_due` (within `renewal_notice_days`) -> `active` (renewed only upon recorded ledger receipt for the new period!) or `lapsed` (after `valid_until`); `cancelled` at any point.
- **Reversal Consistency:** Reversing a membership receipt recomputes net paid ledger balance; if paid coverage drops below required active periods, membership automatically drops out of unsupported `active`/`paid` state back to `awaiting_contribution` (or `renewal_due`/`lapsed` if prior periods covered).

### S8 Commands & Reads
- Commands: `membership_scheme.upsert`, `membership.apply`, `membership.decide`, `membership.issue_request`, `membership.activate`, `membership.renew`, `membership.cancel`.
- Reads: `GET /api/crm/read/memberships` (returns schemes + readable memberships + upcoming renewal reminders).

---

## 4. Cross-Module Contact Merge & Unmerge Integrity

- `worker/crm/merge.ts` inspects `crm_bookings`, `crm_participants`, `crm_screenings`, `crm_memberships`, `crm_payment_requests`, `crm_ledger_entries`, and `crm_refund_requests` during merge preview, merge, and unmerge:
  - **Append-only ledger protection:** If the loser contact has ANY `crm_ledger_entries` (or `crm_refund_requests` / `crm_payment_requests`), `person.merge` refuses cleanly (`loser_has_financial_history_cannot_rewrite_ledger`) rather than mutating append-only ledger history or creating split ownership!
  - **Restricted screening protection:** If the loser contact has ANY `crm_screenings`, merge refuses unless the actor holds `crm.restricted.read` for every affected programme (`restricted_screening_authority_required`), and unmerge refuses if any screening state/review changed post-merge.
  - **Operational booking & membership references:** `crm_bookings`, `crm_participants`, and `crm_memberships` are included in the canonical reference inventory, counted in preview, fenced against concurrent mutations, moved atomically with `person.merge` journal entries (when within budget and without ledger/screening blocks), and verified for post-merge operational drift before `person.unmerge`.

---

## 5. Remaining Owner Policy Decisions (Never Hardcoded)

| ID | Policy Area | Current Behavior |
|---|---|---|
| `O-05` | Edition capacity, hold duration, confirm-before-payment, group limit, price options | Configurable per edition; fails closed when unconfigured |
| `O-06` | Cancellation, refund, transfer, waitlist rules; accommodation; screening questions | Configurable per edition; fails closed when unconfigured |
| `O-07` | Common Roots contribution, validity, identifier format, benefits/redemption | Scheme fields configurable (fail closed until set); benefits locked off |
| `O-09` | Refund approval threshold per currency & dual control | Configurable per currency; unconfigured ALWAYS requires independent approval |
| `O-10` | Statutory receipt/invoice wording, numbering, tax/GST | Not implemented; operational confirmations only |
| `O-14` / `C-03` | Foreign currency & foreign contributors | Blocked by default (`foreign_contribution_blocked_pending_policy`) |
| `O-04`, `O-17`, `O-20`, `O-21`, `P-16`, `P-20` | Provider & communications policies | Unchanged from P3; Zoho production blocked pending G3 |
