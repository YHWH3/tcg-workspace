# Executive recommendation and decision ledger

This is the single decision ledger for the CRM. Every other file refers to IDs here. Status values: **Approved** (your decision), **Source-supported** (stated in the TCG archive or the pinned repository; still subject to current verification), **Proposed** (my recommendation, not approved), **Open** (needs your decision, detailed in `12-OPEN-DECISIONS.md`).

## 1. Executive recommendation

1. **Build the CRM as a second app inside the existing Workspace codebase, Worker and D1 database**, mounted under `/crm` with its own shell, navigation and design tokens, an app switcher in both shells, and the same login, session and sync engine. This is a modular monolith, not a fork and not a separate deployment (P-01, P-02). It is the smallest durable way to honour shared login and shared canonical data without duplicating authentication, sync or AI plumbing.
2. **One person, one record.** The existing People database stays canonical. The CRM adds server-side contact endpoints (several emails, phones, WhatsApp, Instagram and Facebook identities), consent, aliases and a reviewed merge. No second People database is created (P-05, P-06).
3. **Split the data by consequence, not by module.** Relationship context (people, organisations, programmes, applications, opportunities, follow-ups, notes) uses the existing configurable database engine: editable, offline-capable, per-field last-write-wins. Anything with an external or financial consequence (sent messages, seat holds, confirmed bookings, payments, refunds, memberships) is a server command with its own server-only tables, idempotency, expected revision, permission check and audit, and is projected read-only into the records people look at (P-03, P-04). The current code already proves this split is needed: event capacity is explicitly informational and money fields are plain editable numbers.
4. **The 14 programmes are configuration over six shared engines** (Relationships, Conversations, Applications, Bookings, Money, Membership, plus the existing Opportunities pipeline), grouped into five navigation areas. They are not 14 apps (P-08, P-09).
5. **Pilot with real data while permissions stay off (A-19).** Workspace permissions are implemented but switched off, so until Track A is activated **every signed-in account can read every synced record**, including every CRM relationship record and every `_crm_` projection field. Participant screening, health and suitability notes, payment evidence and refund decisions therefore never live in synced records: they stay in server-only tables behind CRM capabilities, which are enforced whether or not Workspace permissions are on (A-19, A-21, ADR-10). Activating Track A is not a precondition for the pilot.
6. **Lean strongly on Monday CRM's interaction model, not its branding:** grouped editable grids with labelled status cells and group summaries, a side item panel with tabs and one relationship timeline, connected records with read-only lookup columns, sentence-style automations, Numbers, Battery and Chart widgets, My Work, and duplicate management. Reject email open tracking by default, autonomous AI agents acting externally, and colour-only meaning (`03-MONDAY-STUDY.md`).
7. **Start with thin end-to-end slices on local fixtures:** CRM shell and People, then a website enquiry becoming a person with a timeline, then manual activity logging and follow-ups, then email sending with human approval, then bookings without money, then manually recorded payments, then provider-verified payments and the Meta channels (`11-ROADMAP.md`).

## 2. Where I disagree with the previous plan

| Previous proposal | My position | Why |
|---|---|---|
| A booking and participant model built from configurable records | Rejected for seats, holds, waitlist, payment state | `shared/eventOps.ts:9-10` states capacity "is informational and never changes registration or attendance"; per-field LWW cannot enforce a seat limit under concurrent or offline edits. |
| "Shared canonical data" implies Workspace permissions protect CRM data | Conflict surfaced; resolved by A-19 | `worker/readAccess.ts:63-66` (`accessEnabled`) reads `access_state.enabled`; `docs/roadmap/A-access-activation.md:8-9` says permissions are certified but OFF. Restricted data stays server-only; the pilot proceeds with permissions off. |
| Seven programme groups | Five work areas | Seven groups for 14 programmes is nearly one per two programmes and still clutters the sidebar; five areas map to how TCG describes participation. |
| "Inbox" as the CRM communication nav item | Named **Conversations** | Workspace already has an `Inbox` module for notifications (`src/modules/index.ts:13`); two different "Inbox" meanings behind one login is a usability defect. |
| Activities as a top-level navigation item | Folded into the timeline, My Work and a saved view | Activities matter in context; a top-level grid of every call and note is rarely where work starts. |
| Roadmap ordered by subsystem (inbox foundation, then email, then bookings...) | Vertical slices | Each slice must be usable and testable end to end; subsystem phases produce half-finished foundations. |
| Lead scoring and probability as default fields | Not default | TCG relationships are mostly non-commercial (`02` section 6); scoring stays an optional field per commercial pipeline. |
| Patron as a CRM pipeline | Read-only projection | Edition allocation and payment matching live in the relay (`website:services/form-relay/src/patron.js` at `38ef9e3`). A second state machine would compete with the source of truth. |

## 3. Conflicts and risks in the approved direction

These are not overrides. They need your awareness or decision.

| ID | Issue | Options |
|---|---|---|
| C-01 | Permissions are off (above). | **Resolved 24 Nov 2026 by A-19 (O-01):** pilot directly with real data; Track A activation is not a precondition. Restricted data (screening, health and suitability notes, payment evidence, refund decisions) stays in server-only tables behind CRM capabilities. **Consequence, accepted by the owner:** until Track A is active, every signed-in account (up to seven, guests included) can read every synced record, which includes People names, the primary Email and Phone fields, Applications, Activities, Opportunities, notes in ordinary fields and every `_crm_` projection. Two design consequences follow and are now part of the design: (1) the `_crm_` write protection cannot rely on `authorizeMutations`, which only runs when permissions are on (`worker/sync.ts:353`), so S0 adds an unconditional check (ADR-04); (2) CRM forms must steer sensitive input away from ordinary fields (`08` section 13). Earlier options (a) activate first and (c) activate before bookings with screening are withdrawn as preconditions; Track A remains a separate, later decision. |
| C-02 | "Full send-and-receive on all channels" cannot mean "send any time". WhatsApp allows free-form replies only inside a 24-hour customer service window and needs pre-approved templates outside it; Instagram and Messenger use a 24-hour standard window, with a Human Agent tag allowing manual replies for up to 7 days. | Design the composer around provider windows (shown in `09`). No decision needed; expectation-setting. |
| C-03 | The website relay's Patron tiers include foreign-currency amounts that are still marked as proposals, and the organisation's eligibility to accept foreign contributions is not verified (the archive holds only historical, user-stated information, which is not reproduced in this public repository). | Not a CRM design choice, but the Money engine must not mark foreign contributions as accepted without a verified rule. Recommend a legal check before any foreign-currency Patron or Roots payment. O-14. |
| C-04 | Seven active accounts is a hard cap including guests (`MAX_USERS = 7` at `worker/auth.ts:76`; enforced at signup, `worker/auth.ts:284` and atomically in the insert at `:308-316`, and on re-enable, `worker/admin.ts:130`). | **Resolved by A-20 (O-02):** no fixed list; accounts come from sign-up and invite within the cap. |
| C-05 | The website integration doc names a `site-patron` branch (`docs/integrations/the-common-ground.md:3`); in the local website clone the relay is on `codex/website-launch-fixes` and there is no `site-patron` branch. | Fix the doc reference in both copies when the website work next moves. Not a CRM blocker. |
| C-06 | A-20 says there is exactly one super admin, the workspace owner. The Workspace code creates exactly one owner (the bootstrap signup, `worker/auth.ts:316`) and has no ownership transfer, but any admin can demote the owner to member (`worker/admin.ts:165-176`: owner plus `member` becomes `member`), disable the owner (`:108-124`) or remove the owner (`:206-215`), provided another owner or admin remains. The CRM's "owner holds every capability" rule would then leave nobody holding it. | **Resolved 24 Nov 2026 by A-23 (O-19):** server-side owner protection on all three routes, which are the only server paths that change another account's role or status (checked: every other `UPDATE users` is a self-edit, `worker/auth.ts:466-489`, `worker/email.ts:156`, `worker/notificationEmail.ts:222-224`). Built in S0. |
| C-07 | Zoho Mail (A-22) was not among the evaluated mailbox options, and its API, limits and push-notification support are not verified here. | Adapter designed for Zoho with every provider fact marked [needs verification] (`09` section 1.7). No decision needed now; verification before S5. |

## 4. Decision ledger

### Approved (owner)

| ID | Decision | Source |
|---|---|---|
| A-01 | Shared product suite with app switcher | `02` table, item 1 |
| A-02 | TCG first, reusable later (no SaaS, no multi-tenancy now) | item 2 |
| A-03 | Shared login | item 3 |
| A-04 | Shared canonical data (not unrestricted access, not necessarily one physical store) | item 4 |
| A-05 | Module scope: currently active programmes, confirmed as all 14 | item 5, section 3 |
| A-06 | Full send-and-receive inbox | item 6 |
| A-07 | All channels, in phases | item 7 |
| A-08 | Complete booking and participant management | item 8 |
| A-09 | Broader financial functionality, in phases | item 9 |
| A-10 | Internal CRM only; no external CRM portal initially (public website intake continues) | item 10 |
| A-11 | Central AI-native experience with approval safeguards | item 11 |
| A-12 | Customisation by administrators and authorised managers | item 12 |
| A-13 | Distinct CRM design | item 13 |
| A-14 | Small internal TCG team | item 14 |
| A-15 | Comprehensive feature and gap audit first | item 15 |
| A-16 | UI/UX leans strongly towards Monday CRM (reference, not copy) | `02` section 2 |
| A-17 | Engineering baseline `tcg-workspace` at `38c388a`; CRM work happens on local branch `crm/foundation`, which points at the same commit (`00-README.md`) | `02` section 4 |
| A-18 | This stage is design only; implementation, commits, deployment, provider activation need separate approval | master prompt, "Non-negotiable working boundaries" |

### Approved 24 November 2026 (owner decisions on open items)

Status **Approved**, dated 24 November 2026, evidence "Paul, 24 Nov 2026" (A-19 to A-22 from the first instruction, A-23 to A-26 from the follow-up the same day). Wording is recorded as given; the "Design consequence" column is my reading and is part of the specification.

| ID | Closes | Decision | Design consequence |
|---|---|---|---|
| A-19 | O-01, C-01 | **Permissions timing:** pilot directly with real data. Activating Workspace permissions (Track A) is not a precondition for the pilot. Restricted data (screening, health and suitability notes, payment evidence, refund decisions) still stays in server-only tables behind CRM capabilities. Until Track A is active, every signed-in account can read every synced record. | CRM capability checks never depend on `access_state.enabled`. `_crm_` projection keys are rejected for every non-command write in both permission modes (ADR-04, S0). Projections carry state words only, never restricted content (`10` section 8). |
| A-20 | O-02, C-04 | **CRM users:** no fixed list of names. Accounts are created by sign-up and invite within the existing seven-account cap (guests included). People set their own names. There is exactly one super admin: Paul, as the workspace owner. The super admin manages accounts, names and roles inside the tool itself. | The CRM Settings "Accounts" tab fronts the existing admin routes (`worker/admin.ts`) and adds renaming another account (S1). People keep renaming themselves through `PATCH /api/me` (`worker/auth.ts:454-475`). "Super admin" means the account whose workspace role is `owner`; see C-06 and O-19 for protecting it. |
| A-21 | O-08 | **Capabilities:** nothing is pre-assigned to named people. The super admin (and admins he authorises) grants and revokes every CRM capability (send per channel, restricted read, finance read/record, refund approve, configure) to accounts from a settings screen inside the CRM. Default for a new account: no CRM capabilities. Default for the owner: all of them. Every grant and revoke is audited. | Owner capabilities are implicit, computed from the current `owner` role, and cannot be revoked. An admin may grant or revoke only while holding `crm.capabilities.manage`, which only the owner can grant. Grant and revoke are server commands with an append-only audit table (`07` section 3, `06` section 3). Built in S0. |
| A-22 | O-03 | **contact@thecommonground.living is hosted on Zoho Mail.** | New option (d) in `12`. The email adapter is designed for Zoho (Mail API versus IMAP/SMTP, `09` section 1.7); Zoho's API capabilities, limits and push support are marked [needs verification]; no Gmail-style behaviour is assumed. Built in S5. |
| A-23 | O-19, C-06, P-22 | **Owner protection:** ordinary administrators must not be able to demote, disable or remove the owner. Preserve protection against accidental loss of the last owner. Enforce these rules server-side, not merely through UI restrictions. | `PATCH /api/users/:id`, `POST /api/users/:id/disable` and `DELETE /api/users/:id` refuse an owner target unless the actor is that owner, with a matching SQL fence in the same batch as a race backstop. The owner's self-change refusals (`worker/admin.ts:109,169,208`) and the existing last-privileged-account fence (`:103-105`) stay. Tests call the routes directly, so UI hiding is never the control (`S0-PLAN.md` sections 6.3 and 6.6). |
| A-24 | S0 question 2 | **Baseline comparison:** tolerate only the three documented pre-existing failures, provided their failure signatures stay consistent with the baseline and isolated reruns pass. Any new failure or changed failure behaviour blocks acceptance. Keep the three tests as explicit unresolved stability issues (not skipped, not removed). Investigate and stabilise them before production release. | Gate rule and signatures in `S0-PLAN.md` section 9.4; open stability item SI-01 in `12`; release-readiness item in `11` section 5. |
| A-25 | S0 question 3 | **Capability revocation:** disabling an account revokes its CRM capabilities and creates audit records. Re-enabling it does not restore them automatically. | Revocation and audit rows in the existing disable batch; the enable route writes nothing to CRM tables (`S0-PLAN.md` section 6.3). |
| A-26 | — | **Division of responsibilities (revised 24 Nov 2026):** Opus 5.5 completed product discovery, independent architecture specification, repository audit, baseline testing and initial S0 planning, and its multi-agent frontend/backend split is superseded. **Neon** is the principal engineering agent responsible for technical architecture refinement, shared TypeScript contracts (`shared/crm/*`), database migrations, backend implementation, server-side security and authorisation, APIs, frontend implementation (backend-first in later stages), UI/UX quality, testing, integration, regression verification, and engineering documentation/progress reporting. **ChatGPT** serves as central project management, requirements coordination and independent review. **Paul** retains owner decision authority and gate approval. A separate clickable frontend prototype is no longer a mandatory gate. Neither Neon nor reviewers override approved owner decisions without explicit owner approval. | `S0-PLAN.md` sections 2 and 4; `contracts/crm-s0-v2.md`; `BACKEND-S0-BRIEF.md`; `PROGRESS.md`. |
| A-27 | — | **Package execution model and permanent cross-platform parity (25 Nov 2026):** Delivery proceeds in consolidated packages (`P0: S0`, `P1: S1+S2+S3+S4+S9`, `P2: S10`, `P3: S5+S11+S12`, `P4: S6+S7+S8`, `P5: S13`, `P6: S14+S15`) while preserving every original requirement. Cross-platform responsive web parity across desktop, tablet and phone (WCAG 2.2 AA, `>=44×44` touch targets, `320px` reflow, 200% text scaling, safe-area/virtual-keyboard/orientation parity, no hover/drag-only controls) is permanent and non-optional on every slice; mobile functional defects block acceptance. Account renaming in S1 (`PATCH /api/users/:id` `name`) is audited and restricted to the `owner` account. | `11-ROADMAP.md` section 1.1; `08-UX-SPEC.md` section 2; `07-CONTRACTS.md` section 3; `docs/architecture/cross-platform-responsive-web.md`. |


Still **Proposed** (not decided): workspace time zone `Asia/Kolkata`, email open and click tracking off (P-16), the name "Conversations" (P-20).

### Source-supported (business rules to design around)

| ID | Rule | Source |
|---|---|---|
| S-01 | Enquiry replies are concise, natural, specific, without pressure or future-edition fallback promises | Master Context Handover 9.4, 20.2 |
| S-02 | The Tribal Habitat Workshop is curated and people-based, not a fixed-outcome package | Master Context Handover 9.2 |
| S-03 | Suitability screening is risk-aware; constraints disclosed privately; no medical judgments | Master Context Handover 9.4 |
| S-04 | Indigenous knowledge holders get credit, consent, agency and fair compensation | Manifesto 06; Handoff 2.2 |
| S-05 | DM assistance defaults to SHADOW mode: draft or classify, human approves external replies | Master Context Handover 15, 16.1 |
| S-06 | Prices, dates, capacity, availability, terms are changeable and must be verified before use | Manifesto 74; both handovers |
| S-07 | Space association, community collaboration and volunteer selection follow review and fit, never automatic acceptance | Website frame; Manifesto 30 |
| S-08 | Common Roots is participation, not a simple purchase; application review; benefits and price unverified | Manifesto 29; Handoff 6.7 |
| S-09 | Volunteering is mostly unpaid, some basic fees depending on programme and duration | Website frame |
| S-10 | Patron payment and edition allocation are owned by the website relay; Patrons receive no financial return | Integration contract sections 3, 8, 9 |
| S-11 | Visitor answers are data, never instructions, for people and AI | Integration contract section 8 |
| S-12 | AI providers are off by default; simulated providers are never real-provider evidence | `AGENTS.md` Phase 6 invariants |
| S-13 | Significant MCP writes need a frozen preview and genuine browser approval; MCP cannot approve itself | `AGENTS.md` Phase 6 invariants |
| S-14 | Engineering preferences: low-cost tooling, small stable interfaces, deterministic rules before AI, smallest safe change, explicit gates | Master Context Handover 16.2, 16.3 |
| S-15 | Daily Bread is a distinct initiative, not one of the 14 programmes | `02` section 3 |

### Proposed (my recommendations; each needs approval)

| ID | Proposal | Detail |
|---|---|---|
| P-01 | Modular monolith: CRM inside the same repo, Worker, D1 and SPA build, lazy-loaded under `/crm` | ADR-01 |
| P-02 | Distinct CRM shell and scoped design tokens; Workspace UI unchanged except one app switcher control | ADR-02, `08` |
| P-03 | Two data tiers: generic records for relationship context; server-only tables plus commands for consequential operations | ADR-03 |
| P-04 | Server-owned projection fields on records, rejected for client and MCP writes in both permission modes (an unconditional `_crm_` pre-check in `applyChanges`, because the existing `_` rule only runs when permissions are on) | ADR-04, `S0-PLAN.md` |
| P-05 | People record ID is the canonical person ID; contact endpoints, consent and aliases live server-side | ADR-05 |
| P-06 | Duplicate review and reversible merge as a server command with a journal | ADR-05, `09` |
| P-07 | Applications are CRM work items linked to the immutable Website submission, not edits to it | ADR-06 |
| P-08 | Six engines; programmes enable engines through a programme profile | ADR-07 |
| P-09 | Five work areas in navigation (see `04` section 3) | `04`, `08` |
| P-10 | Bookings with server-authoritative capacity using D1 conditional writes in one batch; no new Durable Object | ADR-08 |
| P-11 | CRM capabilities layered on workspace and space roles. The owner's list (A-21: send per channel, restricted read, finance read/record, refund approve, configure) plus four proposed: `crm.access` (mandatory CRM gate to open the CRM and use any CRM API or specialised capability), `crm.merge`, `crm.channels.manage` and `crm.capabilities.manage` | ADR-10, `07` section 3, `contracts/crm-s0-v2.md` SC-2 |
| P-12 | Money as integer minor units plus ISO currency in an append-only ledger; corrections by reversal | ADR-09 |
| P-13 | Channel adapters with signed per-provider inbound routes and one outbox with leases, retries and receipts | ADR-11 |
| P-14 | AI drafts, classifies and proposes; sending, confirming, recording money and refunds are human-only actions | ADR-12, `10` |
| P-15 | Operational knowledge store with owner, verified date, expiry and programme/edition scope | `10` section 4 |
| P-16 | No email open or click tracking by default | `03`, `09` |
| P-17 | Offline: relationship edits sync normally; consequential actions queue as visible pending intents and never show as confirmed | ADR-13 |
| P-18 | A fictional "Commons" CRM demo fixture analogous to Studio, local only | `11` |
| P-19 | Workspace routes, modules and styles stay untouched apart from the switcher; CRM regression gate includes the existing suite | ADR-14, `11` |
| P-20 | Rename the CRM's communication area "Conversations" | `08` |
| P-21 | Capability management (grant, revoke, audit, Settings screen) ships in S0 as the command framework's first real commands | `11`, `S0-PLAN.md` |
| P-22 | ~~Protect the owner account~~ Approved as A-23 | — |
| P-23 | Zoho Mail adapter on the Zoho Mail REST API with scheduled polling for inbound; IMAP/SMTP only as fallback | `09` section 1.7 |
| P-24 | The CRM shell, app switcher and operational `/api/crm/*` routes (other than `/status`) sit behind `CRM_ENABLED` (default off), so Workspace UI stays pixel-identical and rollback is a configuration change, while Workspace-hardening security controls (A-23 owner protection, A-25 disable-time revocation, SC-3 `_crm_` protection) remain active | ADR-02, `contracts/crm-s0-v2.md` SC-9, `S0-PLAN.md` |

### Open (decisions needed)

See `12-OPEN-DECISIONS.md` for options and my recommendation on each. IDs O-01 to O-21; O-01, O-02, O-03, O-08 and O-19 are closed by A-19 to A-23.
