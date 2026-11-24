# Product requirements and programme workflows

## 1. Purpose

Give TCG's small team one place to know every person and organisation it works with, hold every conversation with them, run every programme's applications, bookings and memberships, and see the money tied to them, without losing the context, ethics and tone the movement depends on. Workspace stays the place where projects, experiments and knowledge are built; the CRM is where external relationships and participation are run. Both share people, login and data.

## 2. Scope and non-goals

### In scope (all phased; see `11`)

- People and organisations with affiliations, endpoints, consent, provenance, history, duplicates and merge.
- One relationship timeline: website submissions, email, WhatsApp, Instagram, Facebook, logged calls, meetings, visits, notes, bookings, payments, decisions.
- Conversations: unified inbox with assignment, status, templates, approval-gated sending, provider windows, receipts.
- Applications for every programme that takes them, with review, decision and handoff.
- Bookings for editions and events: capacity, holds, groups, waitlist, screening, attendance, cancellation, transfer.
- Membership (Common Roots): application, contribution, validity, renewal, benefits.
- Opportunities: partnerships, consulting, production and other pipelines, with handoff to Workspace Projects.
- Money in phases: payment requests and recorded receipts, refunds and adjustments, programme income views; then provider-verified payments, receipts documents and reconciliation; formal accounting stays external.
- Home / My Work, dashboards and reports with drill-down to records.
- Contextual AI across all of the above, with approval safeguards.
- Configuration by admins and authorised managers.

### Non-goals for this initiative

| Not building | Reason |
|---|---|
| External CRM portal or member login | A-10 |
| SaaS billing, tenancy, org switching | A-02 |
| Learning management or video hosting for Common Lab courses | Courses live on the website; the CRM tracks interest and enrolment relationships |
| Common Cupboard orders, inventory, fulfilment | Needs an owner-designed workflow and ledger (`docs/roadmap/deferred.md`) |
| Formal accounting, tax engine, statutory invoices, bank feeds | Legal and financial implications; external accounting remains the book of record |
| Mass marketing campaigns | Deferred until consent, templates and provider cost are decided |
| Call recording, telephony dialler | Not requested; consent burden |
| Autonomous AI with external effects | P-14 |
| Replacing the Patron relay | S-10 |

## 3. Navigation model and programme areas

The 14 confirmed programmes sit in five work areas. Each programme is a Programme record with a profile that switches engines on and off. Areas are a navigation grouping, not data silos.

| Area | Programmes | Primary engines |
|---|---|---|
| **Experiences and learning** | Tribal Habitat Workshop; Common Lab | Applications, Bookings, Money, Conversations |
| **Spaces and network** | Dhaanyam Food Forest; Parambu Habitat; Common Spaces network | Relationships (places, facilitators, local collaborators), Bookings for visits or stays where offered, Applications for association |
| **Community and support** | Common Roots membership; Patrons; Volunteering and internships | Membership, Money, Applications, Patron projection |
| **Collaboration and work** | Partnerships and collaborations; Architecture and consulting; Common Ground Production | Opportunities, Applications (creative calls), handoff to Workspace Projects |
| **Culture and making** | Fashion Flow; Common Culture; Common Cupboard | Applications (portfolio and submission review), Bookings for showcases and events, Relationships with makers |

Each programme page opens on its default saved view and shows only the engines it uses.

## 4. Engines

### 4.1 Relationships

People, Organisations, Affiliations, Places, contact endpoints, consent, provenance, timeline, duplicates and merge.

Acceptance criteria:

1. A person created from a website form, a WhatsApp message and a manual entry with the same email or phone ends up as one person, or is placed in duplicate review with the reason shown. It never silently creates two.
2. A person shows every participation (application, booking, membership, opportunity, volunteer assignment) with its current stage in one strip.
3. Merging two people relinks every relation, conversation, booking and ledger reference to the survivor, records an alias for the merged ID, and can be reversed from the merge journal by an admin.
4. Editing a person offline works and syncs with per-field merge; changing a contact endpoint is a server command (endpoint uniqueness is enforced server-side).
5. Every field shows its source on hover or in the panel (website form ID, channel, manual, import, AI suggestion accepted by whom).

### 4.2 Conversations

Acceptance criteria:

1. An inbound message on any connected channel appears in Conversations within one sync cycle of the provider webhook being accepted, linked to the matched person or marked Unmatched or Ambiguous.
2. Replies are drafted by people or AI and sent only by a person holding `crm.send` for that channel, from the composer, after an explicit Send action. AI cannot send.
3. The composer shows the channel window state (open with time remaining, closed so template required, provider not connected) before the person writes.
4. A sent message shows Queued, Sent, Delivered, Read (where the provider reports it) or Failed with the provider's reason category, and retries do not duplicate a message.
5. Opt-out on any channel blocks future non-transactional sends on that channel immediately, including queued ones not yet sent.
6. Internal notes are visually distinct and can never be sent.

### 4.3 Applications

Generic lifecycle, relabelled per programme:

```
Received -> In review -> (Needs info <-> In review) -> Conversation -> Decision
Decision: Accepted | Declined | Withdrawn | Not now
Accepted -> Onboarded / Converted (to booking, membership, assignment, opportunity or project)
```

Acceptance criteria:

1. Every website form submission in an application family can become an Application in one action (or automatically, per programme setting) without altering the source submission.
2. A Decision requires a decision reason (internal) and, for programmes with a review gate, an approval from the programme lead.
3. Declining never sends anything by itself; a decline message is a separate drafted message.
4. Conversion keeps the link from the application to what it became.

### 4.4 Bookings

Acceptance criteria (detail in `09`):

1. Confirmed seats never exceed edition capacity, including under concurrent confirmations from two devices and MCP.
2. A hold has an expiry; expired holds release seats and the booker sees why.
3. A booking can have several participants; each participant can be a known person or a placeholder until named.
4. Waitlist promotion offers a seat (creating a hold) and never confirms without the booker's acceptance and any required payment.
5. Offline, a coordinator can create a booking request, which shows as "Request, not confirmed" until the server accepts it.
6. Attendance is recorded per participant and per session day where the edition has days.
7. Screening answers are visible only to holders of `crm.restricted.read` for that programme.

### 4.5 Money

Phase 1 (operational, recorded): payment requests, manually recorded receipts with evidence, refunds and adjustments by reversal, balance per booking or membership, programme income view.
Phase 2 (verified): provider payment links and webhooks, automatic matching, receipt documents, reconciliation view.
Phase 3 (accounting boundary): exports to the external accounting system; no in-app books of account.

Acceptance criteria:

1. Every amount is stored as an integer in minor units with an ISO 4217 currency; totals never mix currencies.
2. Ledger entries are append-only; a correction is a reversing entry referencing the original.
3. A booking or membership shows Paid only when the ledger balance for it reaches zero from verified or recorded-with-evidence entries, never from a stage edit.
4. Recording, refunding and adjusting require distinct capabilities; refunds over an owner-set threshold need a second person's approval (threshold is an owner decision, O-09).

### 4.6 Membership (Common Roots)

Lifecycle: Interested -> Applied -> Approved -> Awaiting contribution -> Active (valid from, valid until) -> Renewal due -> Lapsed | Renewed; Cancelled at any point.

Acceptance criteria:

1. Active requires a recorded contribution linked in the ledger.
2. Validity dates come from the membership scheme configuration, not hardcoded (historical "one year" is a source concept only).
3. Benefits (priority consideration, redemption against eligible bookings) are configurable rules, all off until you confirm them (O-07).
4. The member identifier format is configurable; no historical format from the sources is assumed.

### 4.7 Opportunities

Pipelines with configurable stages per type. Defaults proposed:

| Pipeline | Stages (proposed) | Notes |
|---|---|---|
| Partnership / collaboration | Connect -> Understand -> Explore fit -> Agree scope -> Active -> Review -> Closed | Non-commercial default; reciprocity notes required at Agree scope |
| Architecture / consulting | Enquiry -> Discovery -> Requirements -> Proposal -> Agreement -> Handoff -> Closed won / Closed lost | Handoff creates a Workspace Project linked back |
| Production | Brief -> Team and rights -> Agreement -> In production -> Delivered -> Closed | Rights, credits and compensation fields required before Agreement |
| Funding / institutional | Researching -> Contacted -> Conversation -> Proposal -> Decision | Mirrors the existing pack Opportunities stages |
| Supply (Common Cupboard makers) | Exploring -> Sampling -> Listed -> Paused | Mirrors the existing pack Common Cupboard stages |

## 5. Programme workflows

Each row states what the CRM does for the programme. Policies marked "owner" are open decisions, not assumptions.

| Programme | Entry points | Workflow | Owner policies needed |
|---|---|---|---|
| Tribal Habitat Workshop | `ws`, `events` forms; WhatsApp; Instagram; referrals | Enquiry -> information shared (fact-grounded) -> interested -> screening if the edition requires it -> booking request -> hold -> payment -> confirmed -> pre-arrival information -> attended -> feedback. Cancellation, refund, transfer, waitlist branches | Capacity, price and inclusions per edition; hold length; cancellation and refund rules; screening questions; accommodation options (O-05, O-06) |
| Common Lab | `lab` form; course interest; academic contacts | Research applications -> review -> collaboration (Opportunity) or participation; course interest list; workshop bookings via Bookings | Enrolment model for prerecorded courses (website or CRM), O-12 |
| Dhaanyam Food Forest | Visits, stays, workshops; local collaborators | Place record with facilitators and local collaborators; visit or stay bookings if offered; facilitator compensation recorded as outgoing payments (Money phase 2); consent and attribution for documentation | Whether visits or stays are bookable; facilitator compensation recording; site safety notes (O-13) |
| Parambu Habitat | Visitors, collaborators | Same model as Dhaanyam; starts with relationships only until readiness is confirmed | Readiness and arrangements (unverified in sources) |
| Common Spaces network | `space`, `community`, `collab` forms | Application -> review of practices -> conversation -> association decision -> associated space (Place relationship Associated) -> ongoing exchange | Association criteria and what association grants (O-15) |
| Common Roots | `roots` form | Membership lifecycle (4.6) | Contribution, validity, benefits, identifier (O-07) |
| Patrons | Relay events | Read-only Patron projection (stage, tier, edition) plus stewardship conversations and notes | None for CRM; legal check on foreign currency (C-03) |
| Volunteering and internships | `vol-*`, `intern` forms | Application -> review -> conversation -> selection -> assignment (place, project or edition, dates) -> participation -> completion and feedback | Fees, duration, accommodation, equipment, safeguarding rules (O-16) |
| Partnerships and collaborations | `collab`, inbound emails, introductions | Partnership pipeline (4.7) | Agreement template, value-exchange fields |
| Architecture and consulting | `consulting`, `arch` forms | Consulting pipeline (4.7) with structured requirements from the form; handoff to Workspace Project | Proposal and quote format (Money phase 2), O-10 |
| Common Ground Production | Creative volunteer forms, direct briefs | Production pipeline with credits, rights and compensation | Rights and compensation terms per project |
| Fashion Flow | `ff` form | Portfolio application -> review -> featured or collaborator -> showcase participation (Bookings) | Feature criteria |
| Common Culture | `book` form, event participation | Submission -> editorial review -> feature decision; culture events via Bookings | Culture Book publication status (proposed initiative) |
| Common Cupboard | Maker introductions | Maker relationships and products in the Supply pipeline; orders deferred | Whether and when commerce starts |

## 6. Home / My Work

The CRM opens on **Home** for the signed-in person:

- **Today**: follow-ups due, holds expiring, payments to verify, reviews waiting on me, conversations assigned to me with no reply.
- **This week**: upcoming editions with seats taken / capacity, arrivals, applications ageing past the programme's response target.
- **Recently**: my last edited records.
- An **Ask** bar for the assistant, scoped to what I can see.

Data comes from the existing attention collector pattern (`worker/attention.ts`), extended with CRM sources, with explicit "partial" states when a source is capped or unavailable.

## 7. Reports (definitions)

Every figure drills to the records behind it, under the viewer's permissions. Counts never include records the viewer cannot read; when that hides data, the widget says "Some records are not visible to you".

| Report | Definition |
|---|---|
| Open enquiries by age | Conversations or applications in a non-final stage, bucketed by days since received |
| First response time | Received time to first outbound message or recorded reply, per programme, median and slowest |
| Due follow-ups | Activities of type Follow-up with due date on or before today, not done |
| Edition occupancy | Confirmed seats / capacity; held seats shown separately; never estimated |
| Participation by programme | Distinct people with a participation in a non-final or completed stage in the period |
| Membership renewals | Active memberships with valid-until in the next N days (N configurable) |
| Volunteer pipeline | Applications by stage and availability window |
| Collaboration pipeline | Opportunities by pipeline and stage; value shown only for commercial pipelines with a value |
| Recorded income | Sum of ledger receipts minus refunds per currency, per programme, per period |
| Outstanding | Issued payment requests minus allocated receipts, per currency |

## 8. Roles (product view)

Revised for A-20 and A-21: nobody is named in advance and roles below are typical bundles of capability grants, not stored roles.

| Role | Who | Can |
|---|---|---|
| Super admin | The workspace owner (Paul), exactly one | Every CRM capability implicitly; manages accounts, names and roles; grants and revokes capabilities, including authorising admins to manage capabilities |
| Admin | Workspace admin | Workspace account management today; in the CRM only what has been granted, plus managing capabilities if the owner granted `crm.capabilities.manage` |
| Programme lead | Any account granted `crm.access` + `crm.configure` (and optionally `crm.restricted.read`) for a programme | Configure that programme's views, fields, stages, automations, templates; approve gated decisions; see restricted data for that programme if granted |
| Coordinator | Any account granted `crm.access` | Work queues, edit relationship records, draft messages, send if granted `crm.send:<channel>` |
| Finance | Any account granted `crm.finance.read` / `crm.finance.record` | Record and reconcile money; refunds need approval per policy |
| New account | Anyone who signs up with an invite | No CRM capabilities until granted |
| Guest | Workspace guest | Cannot hold CRM capabilities |

Capability details and enforcement are in `07` and `10`.
