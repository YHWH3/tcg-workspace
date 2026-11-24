# Open owner decisions

Prioritised by what they block. Each has my recommendation; none is assumed. Policy values (prices, capacities, durations) must come from you, not from historical sources.

## Closed on 24 November 2026

| ID | Decision | Closed by | Outcome |
|---|---|---|---|
| O-01 | When to activate Workspace permissions (Track A) relative to the CRM | A-19 (Paul, 24 Nov 2026) | Pilot directly with real data; Track A is not a precondition. Restricted data stays server-only behind CRM capabilities. Until Track A is active, every signed-in account can read every synced record. |
| O-02 | Who will use the CRM, and does the seven-account cap fit | A-20 (Paul, 24 Nov 2026) | No fixed list. Accounts by sign-up and invite within the seven-account cap (guests included). People set their own names. One super admin: Paul, the workspace owner, who manages accounts, names and roles in the tool. |
| O-03 | Email mailbox for contact@thecommonground.living | A-22 (Paul, 24 Nov 2026) | Zoho Mail: option (d) below. |
| O-08 | Programme leads and capability holders | A-21 (Paul, 24 Nov 2026) | Nothing pre-assigned. The owner (and admins he authorises) grants and revokes every CRM capability from a CRM settings screen. New accounts start with none; the owner holds all; every grant and revoke is audited. |
| O-19 | Protect the owner account (C-06) | A-23 (Paul, 24 Nov 2026) | Option (a): ordinary admins cannot demote, disable or remove the owner; last-owner protection kept; enforced server-side. Built in S0. |
| — | S0 baseline comparison | A-24 (Paul, 24 Nov 2026) | Tolerate only the three documented failures with unchanged signatures and passing isolated reruns; anything else blocks. See SI-01. |
| — | CRM grants on account disable | A-25 (Paul, 24 Nov 2026) | Revoked with audit records on disable; not restored on re-enable. |

O-03 options as evaluated, with the owner's answer added:

| Option | Mailbox host | Status |
|---|---|---|
| (a) | Google Workspace / Gmail API (mail also visible in Gmail) | Not applicable |
| (b) | Microsoft 365 / Graph | Not applicable |
| (c) | Cloudflare Email Routing inbound plus a sending provider (CRM becomes the only mail client for that address) | Not applicable while Zoho hosts the MX records |
| **(d)** | **Zoho Mail** (added 24 Nov 2026; not in the original list) | **Chosen.** Adapter: Zoho Mail REST API first, IMAP/SMTP fallback; see `09` section 1.7. Provider facts [needs verification]. |

## Needed before S0 starts

No open owner decision blocks S0. What remains before implementation: independent review and freeze of `contracts/crm-s0-v1.md`; Paul's approval of the design (G0) and of `S0-PLAN.md`; authorisation to implement (and, separately, to commit implementation work); the read-only owner check in `S0-PLAN.md` section 6.1; the screenshot baseline in `S0-PLAN.md` section 9.1.

## Unresolved stability issues

| ID | Issue | Status | Required by |
|---|---|---|---|
| SI-01 | Three Workspace tests fail under the full parallel suite and pass alone (baseline in `00-README.md`): `phase4-events-d1` "Cron recovers durable events after interruption and a failed sweep, then dedupes subsequent sweeps" (`beforeEach` timeout creating Miniflare); `phase8-commitments-d1` "keeps private action metadata out while retaining available decisions" (`read ECONNRESET`); `phase8-form-operations-d1` "fences disablement and session revocation during a read" (test timeout). | **Open.** Tolerated for S0 acceptance only under A-24. Not skipped, not removed, not given longer timeouts to hide them. Owner: Neon (backend tests), reviewed by ChatGPT. | Investigated and stabilised **before production release** (A-24; `11` section 5). |

## Needed before first real use

| ID | Decision | Options | My recommendation | Blocks |
|---|---|---|---|---|
| O-17 | Retention, export, erasure; privacy notice wording for CRM processing | Retention periods for messages, screening, ledger; who handles requests | Short retention for screening (until an edition completes plus a review period you set); ledger kept per accounting advice; get legal review of the notice. With permissions off (A-19), the notice should not promise staff-level restriction of ordinary relationship records. | Real data |
| O-20 | Zoho account details for the adapter | Zoho data centre of the account (it decides the API host), plan, whether API access and IMAP/SMTP access are enabled for contact@, whether sent mail must also appear in Zoho's Sent folder | Tell me the data centre and plan; I verify the API against Zoho's current documentation before S5 | S5 real |
| O-21 | Inbound email latency | Use the existing 15-minute cron (`wrangler.jsonc:49`) for Zoho polling, or add a dedicated, more frequent cron | Start with the existing cron; decide after measuring with the simulated adapter | S5 |

## Needed before bookings

| ID | Decision | Options | My recommendation | Blocks |
|---|---|---|---|---|
| O-05 | Booking policy per programme and edition | Capacity, hold length, confirm before or after payment, group size limit, price options | Hold length and confirm-before-payment as programme settings with edition overrides | S6 |
| O-06 | Cancellation, refund, transfer, waitlist rules; accommodation options; screening questions | Your current practice | Write them as edition facts and settings; I can draft wording once you give the rules | S6 |
| O-13 | Dhaanyam and Parambu: are visits or stays bookable; how facilitator compensation is recorded | Bookable or relationship-only; payouts in CRM ledger (phase 2) or outside | Relationship-only first; payouts recorded in phase 2 if you want them tracked with consent and attribution | S6, S13 |
| O-15 | Space association criteria and what association grants | Your criteria | Store as programme facts so reviews are consistent | S2 configuration |
| O-16 | Volunteer and internship fees, durations, accommodation, equipment, safeguarding | Your current terms | Programme facts plus application stages | S2 configuration |

## Needed before money

| ID | Decision | Options | My recommendation | Blocks |
|---|---|---|---|---|
| O-09 | Refund approval threshold and dual control | Threshold amount per currency; who approves | Dual approval above a threshold you set; never self-approval | S7 |
| O-14 | Foreign currency and foreign contributors | Allowed, blocked, case by case | Blocked by default until a qualified adviser confirms the rule (C-03) | S7, S13 |
| O-11 | Payment provider for bookings and memberships | Reuse the Razorpay account used by Patrons; another provider; manual only | Manual recording first (S7); reuse Razorpay for phase 2 if its terms suit | S13 |
| O-10 | Receipts, quotes, invoices: wording, numbering, tax treatment | Your accountant's guidance | Payment confirmations only until advised | S13 |
| O-07 | Common Roots scheme | Contribution, validity, benefits, redemption rules, identifier format | All benefits off until written down; identifier configurable | S8 |

## Later

| ID | Decision | Options | My recommendation |
|---|---|---|---|
| O-04 | WhatsApp number strategy | Move the current number to the Cloud API; use a new number for the API; check current Meta coexistence options for using the app and API on one number | Decide with the team member who handles WhatsApp bookings today, after checking Meta's current rules; do not move the number without a plan for the team's existing chats |
| O-12 | Common Lab course enrolment | Website handles enrolment and the CRM records relationships; CRM handles enrolment | Website handles enrolment; CRM records interest and enrolment events |
| O-18 | Whether external AI clients may ever trigger side-effect actions through preview plus browser approval | Never; later with strict scope | Never for money or capability grants; maybe later for sends, with per-user opt-in |

## Small confirmations (still Proposed)

- Set the workspace time zone to `Asia/Kolkata` (current default is `UTC`, `shared/workspaceSettings.ts:5`).
- Keep email open and click tracking off (P-16).
- Name the CRM communication area "Conversations" (P-20).
