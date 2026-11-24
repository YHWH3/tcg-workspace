# Evidence-backed audit

Part A describes TCG's relationship model from the source archive. Part B audits the Workspace at `38c388a` against what the CRM needs. Paths are relative to the Workspace repository unless prefixed `website:`, which means `the-common-ground` at `38ef9e3`.

Verification levels used in Part B:

- **Template**: defined in a pack or fixture file; says nothing about installed data.
- **Implemented**: code exists at the pinned ref and I traced the behaviour.
- **Test file present**: a test file targets it; I did not run it.
- **Deployed**: not verifiable here for anything.

---

## Part A. TCG's relationship model

### A1. Who TCG has relationships with

The sources describe a network, not a customer base. One human can hold several of these roles at once, often over years (Manifesto 58, 68; `02` section 6):

| Relationship type | Examples in sources | Commercial? |
|---|---|---|
| Participant / learner | Workshop participants, course learners, visitors, students from schools and colleges | Often fee-based; historical fee only |
| Volunteer / intern | Long-term, short-term, creative, online volunteers; interns | Mostly unpaid; some basic fees (Website frame) |
| Knowledge holder / facilitator | Indigenous knowledge holders and elders; local builders, craftspeople | TCG pays them; consent and attribution matter (Manifesto 06) |
| Community member / supporter | Common Roots members, Patrons, followers | Contribution-based; terms unverified |
| Creative collaborator | Musicians, filmmakers, designers, stylists, photographers, models (Production, Fashion Flow, Culture Book) | Mixed: rights, compensation and scope per project |
| Maker / producer | Artists and craftspeople for Common Cupboard; forest-produce sellers at Dhaanyam | Commerce in development |
| Researcher / academic partner | Common Lab researchers, institutions | Usually non-commercial |
| Client | Architecture and consulting clients | Commercial |
| Organisation / institution | Schools, colleges, event partners, technology partners | Mixed |
| Space / community | Own bases (Dhaanyam, Parambu), associated independent spaces (association status historical and unverified), applicant spaces, collectives | Reciprocal, not commercial by default (Manifesto 30) |

Two consequences for design:

1. **The core object is a person with many concurrent participations, each with its own lifecycle.** A "lead to customer" funnel is the wrong spine. The profile must answer: who is this, how did they connect, what are they part of now, what happened with them, what is next (`02` section 6).
2. **Non-commercial relationships need first-class workflows that are not sales pipelines.** Association, collaboration and volunteering move by review, fit and mutual agreement (S-07). Value and probability fields belong only to commercial pipelines.

### A2. Operating needs the sources state explicitly

- Enquiries: answer the actual question, concisely, with current verified details; ask only what is needed (S-01).
- Screening: physical demands, terrain, accommodation and constraints disclosed privately; no medical judgments (S-03). This makes screening data restricted by nature.
- Curated programmes: an edition has a core setting and themes; the group shapes the experience (S-02). So "inclusions" are edition facts, not product SKUs.
- Knowledge ethics: credit, consent, compensation for knowledge holders (S-04). The CRM needs consent and attribution records for documentation and publication, not just marketing consent.
- Communication defaults: SHADOW mode for DMs (S-05); no invented facts (S-06).
- Independence and low cost (S-14): favour existing infrastructure and free tiers where possible; every paid provider needs an explicit reason.

### A3. Public intake that already exists

`website:content/forms.json` defines 20 forms in 6 families (matches `docs/integrations/the-common-ground.md` section 4). What each collects matters for identity and workflow design:

| Form | Family | Collects (field names) | CRM implication |
|---|---|---|---|
| `ws` Workshop application | join | Name, Email, Practice, Note | No edition, dates or group size: an application cannot become a booking without follow-up questions |
| `events` Event enquiry | join | Name, Email, Format, Interest | Enquiry, not booking |
| `roots` Common Roots | join | Name, Email, WhatsApp, Where, Updates, Why | Only form besides `space` that collects a phone; WhatsApp identity starts here |
| `intern` | join | Name, Email, Where, Areas, Mode, Dates, Work, Why | Application with availability |
| `vol-*` (6 kinds) | join | Name, Email, Where, Dates, Offer, Work | Same shape; kind is the form ID |
| `consulting` Project application | consulting | 14+ fields (building, users, location, ownership, land area, zoning, climate, access, built area...) | Rich discovery data; maps to an Opportunity with structured requirements |
| `arch` Architecture consultation | consulting | Name, Email, Where, About | Light enquiry |
| `community`, `space`, `collab`, `lab` | community | Practice, location, phone (space), social, "together" | Association and collaboration applications |
| `book`, `ff` | culture | Craft or Role, Work, About | Creative portfolio review |
| `patron` | patrons | Country, Organisation, Edition, Currency, Wallet | Patron lifecycle owned by the relay |
| `general` | general | Name, Email, About | Triage |

Every form keys identity on email only. WhatsApp, Instagram and Facebook conversations will arrive with no email, so identity matching cannot stay email-only.

---

## Part B. Workspace capability and gap audit

### B1. Summary

The Workspace is a strong foundation for the relationship half of a CRM and for AI governance. It is not a foundation for the transactional half: it has no booking enforcement, no money ledger, no outbound communication to external people and no inbound channel other than the signed website relay. Its permission system exists but is switched off. Those four facts drive the architecture.

### B2. Matrix

Verdicts: **Reuse** as-is, **Configure** (data or settings only), **Extend** (change existing code), **Build** (new code), **Defer**.

| Area | What exists (evidence) | Level | Verdict | Notes and gap |
|---|---|---|---|---|
| App shell and routing | One router; every authenticated route sits under one `Shell` (`src/App.tsx:43-71`). Modules contribute routes at the root path (`src/modules/index.ts:13`, `src/modules/types.ts:6-29`) | Implemented | Extend | No app switcher, no second shell. Workspace owns `/`, `/inbox`, `/boards`, `/website`, so the CRM needs a prefix (`/crm`) to avoid collisions. |
| Auth, session, account switch | `RequireAuth` + `AccessBarrier` wrap the shell (`src/App.tsx:30-35`); `AccountSwitchGate` blocks routes during account change (`src/App.tsx:90-91`) | Implemented, test files present (`account-switch`, `phase5-sessions`) | Reuse | One sync engine start (`src/App.tsx:73-85`) must stay single across both shells. |
| Account cap | `MAX_USERS = 7` (`worker/auth.ts:76`), enforced at signup (`worker/auth.ts:284`, and atomically in the insert, `:308-316`) and on re-enable (`worker/admin.ts:130`); includes guests (`AGENTS.md` Phase 5) | Implemented | Reuse | C-04, closed by A-20. |
| Account roles and admin routes | Bootstrap signup creates the only `owner` (`worker/auth.ts:316`); invites create members, guest invites create guests. Owner or admin may invite, change admin ⇄ member, disable, re-enable and remove accounts, each fenced and (except remove and invites) audited in `access_audit` (`worker/admin.ts:93-215`). People rename themselves via `PATCH /api/me` (`worker/auth.ts:454-475`); no route renames another account. An admin can demote, disable or remove the owner while another owner or admin remains (`worker/admin.ts:103-105,165-179`) | Implemented | Reuse, extend | A-20 needs "rename another account" (S1) and owner protection (C-06, resolved by A-23). |
| Generic records | One `records` table with JSON `data`, per-field `field_ts`, `seq` revision (`migrations/0001_init.sql`); 13 synced collections (`shared/collections.ts:5`) | Implemented | Reuse | Right for editable relationship data. Wrong for anything needing a single authoritative transition. |
| Write paths | Client `mutate()` (`src/core/sync/engine.ts:172`), server `applyChanges(env,userId,changes,opts)` (`worker/sync.ts:290`) with `expect`, `atomic`, `fences`, `execution`, `journal`, `createOnly`, `event` options (`worker/sync.ts:158-194`) | Implemented | Reuse, extend | `fences` and `execution` are exactly what server commands need to project results atomically. Need a sanctioned way for a command to write server-owned projection fields (P-04). |
| Protected fields | Fields starting `_` and several system keys are rejected item-wise in `authorizeMutations` (`worker/mutationAccess.ts:66-67`). **Only when permissions are on or the request is a connector:** `applyChanges` calls `authorizeMutations` only if `access_state.enabled = 1 \|\| env.CONNECTOR` (`worker/sync.ts:352-355`); the existing rejection test enables permissions first (`tests/phase5-audit-interplay-d1.test.ts:68,78`) | Implemented | Extend | With permissions off (A-19) a client push can write `_` fields today. Projection keys need an unconditional pre-check plus a command-only exception (ADR-04, `S0-PLAN.md`). |
| Field types | `text, number, select, multi_select, person, date, url, checkbox, relation`; number formats plain, currency, percent (`shared/fields.ts:4,16`) | Implemented | Extend selectively | No email, phone, datetime, duration, file, formula, rollup, lookup (mirror), button. `person` is a Workspace account, not an external person. Date is date-only. CRM needs: read-only **lookup** columns, **datetime** for sessions, and typed **email/phone** display. Formulas: not needed for the first slices. |
| Relations | Links collection, paired reverse fields, single clamp, deterministic IDs (`AGENTS.md` "Databases, views & links") | Implemented | Reuse | Equivalent of Monday's Connect Boards. |
| Views | 9 layouts: board, table, list, gallery, calendar, timeline, chart, feed, dashboard (`shared/views.ts:11`); saved views per database; saved-view query evaluates up to 5,000 records and fails explicitly above (`docs/roadmap/14-configurable-databases.md:79-80`) | Implemented, test files present (`views`, `configurable-database-mcp-d1`) | Reuse, extend | 5,000 is fine for TCG scale; keep explicit failure. |
| Grid UX | Virtualised table, sticky header, resize handles, bulk select, sort (`src/core/views/TableView.tsx`) | Implemented | Build CRM grid | Column widths are component-local `useState` (`TableView.tsx:32`), so not persisted. No arrow-key cell navigation found. No grouped sections with summaries in the table. The CRM grouped grid is new UI over the same view config. |
| Record detail | History, conflict indicator, body editor, attachments, linked panel, comments, assistant context (`src/core/views/RecordDetail.tsx:3-61,118,316-331`) | Implemented | Reuse inside CRM panel | Not a relationship timeline: no messages, no cross-record activity aggregation. |
| Forms | Draft builder, authenticated publication, public `/f/:token` (`src/App.tsx:50`), MCP `save_form_draft` | Implemented | Reuse | Useful for CRM screening questionnaires later; publication stays human-controlled. |
| Website ingest | Signed `POST /api/ingest/website`, contract v2, scoped grant, durable relay outbox (`docs/integrations/the-common-ground.md` sections 2, 9; `worker/websiteIngest.ts`) | Implemented, test files present (`website-ingest-d1`, `website-mixed-lifecycle-d1`, `website-remediation-d1`) | Reuse | The model for every future inbound channel: signed, scoped, idempotent, `applyChanges`. |
| People matching | People database chosen and pinned (`choosePeopleDatabase`, `worker/websiteIngest.ts:436-442`; grant column `people_id`, `migrations/0034_website_source_authority.sql:22-23`); email field is a text or url field named "Email" or "E-mail", case-insensitive (`peopleEmailField`, `worker/websiteIngest.ts:426-429`); deterministic `person_<sha256(db|field|email)>` ID truncated to 48 hex characters (`worker/websiteIngest.ts:445-447`); unusable identity handling and admin rebind (contract section "Explicit People identity recovery") | Implemented | Extend | Email-only, one address per person, no phone/handle identities, no merge. Deterministic IDs must survive: never re-key existing people. |
| Website desk and AI tools | `website_query`, `website_digest`, `website_read_answers`, `propose_website_triage`, `draft_reply` prompt that never sends (`shared/aiCapabilities.ts`; contract section 5) | Implemented, test files present (`website-ai-d1`, `website-mcp-d1`) | Reuse | Basis for the Conversations AI. |
| Website inbox statuses | New, In review, Replied, Done; Patron stages Applied, Approved, Paid, Minted, Refund needed (`shared/websiteInbox.ts:31-37,147-152`) | Implemented | Reuse as source | One generic status for 20 forms is right for triage, wrong for programme lifecycles (P-07). |
| Patron authority | Relay matches Razorpay payments, assigns numbered editions, records refund-needed and review cases (`website:services/form-relay/src/patron.js`); the Workspace receives tier, currency and display amount in the lifecycle event (`docs/integrations/the-common-ground.md:62`) | Implemented on draft branch | Reuse, do not duplicate | CRM shows Patron state read-only. |
| Event operations | Read-only summary of facilitators, volunteers, participants per event via relations; "Capacity is informational and never changes registration or attendance" (`shared/eventOps.ts:9-16`); bounded reads of 200 events and 1,000 links (`worker/eventOps.ts:21-28,39`) | Implemented, test file present (`phase8-community`) | Build bookings | Participant is a relation, not a booking; no holds, waitlist, groups, payments, attendance, cancellation. Deferred list confirms (`docs/roadmap/deferred.md`, "Event check-in, attendance proof, capacity enforcement, consent records"). |
| Finance | "Focused operating summaries, not a ledger" (`shared/finance.ts:1`); converts editable number fields to minor units at calculation time (`shared/finance.ts:18-25`); refuses mixed currencies | Implemented, test files present (`phase8-finance*`) | Reuse for budgets, build ledger | Amounts are ordinary editable numbers under LWW; no payment verification, receipts, refunds, balances. Deferred list: bank feeds, reconciliation, exchange rates, formal accounting. |
| Email | Resend or local simulated sink only (`worker/email.ts:14-19`); used for account verification, notifications and digests to Workspace users | Implemented, test files present (`phase10-*`) | Extend pattern, build channel | Nothing sends to or receives from external people. Deferred list: "Sending email replies from the Website inbox", "Email-to-inbox". Resend's 24-hour idempotency limit is already handled by the relay design (contract section 9). |
| Notification outbox | `email_outbox` atomic with the inbox write, rechecks recipient access at send time (`AGENTS.md` Conventions) | Implemented | Reuse pattern | The CRM message outbox should copy these rules. |
| Automations | Triggers: record created, stage changed, field changed, date offset, form submitted (`shared/automations.ts:19-24`); actions: create record, create from template, set field, notify, request approval, add sub-records, AI classify (`:44-50`); branches with conditions (`:82-86`, migration 0043); 15-minute cron (`wrangler.jsonc:49`) | Implemented, test files present (`automations`, `phase4-*`) | Extend | No waits or delays, no inactivity trigger, no message-received trigger, no external actions, no sequences with stop conditions. MCP can list and read health but not create or edit automations (`shared/aiCapabilities.ts`). |
| Approvals | Stage gates via `gateTransition` strip gated status changes until approved (`shared/approvals.ts:72-86`); approvals are server-only tables | Implemented, test file present (`approvals`) | Reuse | Good for "review required before Selected", not for sends or refunds (those are commands). |
| AI assistant | Embedded assistant is an MCP client of the same server; writes become frozen previews; approval, execution, undo, publication are human-only; providers off by default (`AGENTS.md` "Embedded AI + universal MCP") | Implemented, test files present (`assistant-*`, `phase6-*`) | Reuse | The right governance core. |
| MCP | About 90 tools: 30 read, 51 write, 3 proposal, 6 human-only, each classified in `shared/aiCapabilities.ts` with a drift test (`tests/assistant-registry.test.ts`) | Implemented | Extend | Add CRM domain tools in the same registry. Side-effect tools must be human-only or proposal-only. |
| Changesets, undo, history | Per-call changesets with undo; record history with restore under current rights (`AGENTS.md` MCP section, Phase 13) | Implemented | Reuse | Undo is wrong for sent messages and money; those need reversal commands, not undo. |
| Search | FTS with read gate, keyset cursors (`AGENTS.md` cross-phase invariants) | Implemented | Reuse | Messages need their own indexed search with the same gate (Build, later slice). |
| Attention / My Work basis | `worker/attention.ts` bounded derived collector shared by REST and MCP; `attention_queue` tool | Implemented | Extend | Basis for CRM My Work (follow-ups, unanswered conversations, expiring holds). |
| Spaces and permissions | Workspace roles owner/admin/member/guest; space roles owner/admin/editor/commenter/viewer (`shared/access.ts:3-4`); explicit membership precedes default access (`:49-59`); **disabled** unless `access_state.enabled=1` (`worker/readAccess.ts:63-66`; `docs/roadmap/A-access-activation.md:8-9`) | Implemented and certified locally per docs; switched off | Gate | No record-level or field-level permissions; no CRM manager capability; no finance or restricted roles. |
| Pack and templates | `templates/tcg-pack.json` version 11: 17 databases, 38 pages, 6 forms, 5 automations; additive pack upgrades (`shared/bundled.ts`, `worker/packUpgrade.ts`) | Template | Configure, extend | Already has People, Organizations, Programs, Events, Places, Opportunities, Transactions, Courses, Common Cupboard. Use these as the CRM's canonical records; upgrade additively. |
| CSV import and export | `shared/csv.ts`, `src/core/csvImport.ts`, record export | Implemented | Reuse | Initial data migration path for existing spreadsheets. |
| Dates and time zone | Workspace setting `timeZone`, default `UTC`, currency default `INR` (`shared/workspaceSettings.ts:3-5`) | Implemented | Configure | Bookings and send windows need datetime with time zone; set workspace time zone to `Asia/Kolkata` (proposal; confirm). |
| Budgets and limits | 45 D1 binding calls per request phase by default (`withD1Budget(env, limit = 45)`, `worker/d1budget.ts:18`); collection reads capped at 5,000 (`COLLECTION_READ_LIMIT`, `worker/records.ts:79`); 20 MB per file in both storage modes (`worker/fileStore.ts:26`, `src/core/chunks.ts:3`), 450 MB quota (`FILE_QUOTA_MB`, `wrangler.jsonc:24`); `applyChanges` accepts at most 100 expected IDs per call (`MAX_EXPECTED`, `worker/sync.ts:42`) and 1,000,000-byte records (`MAX_RECORD_BYTES`, `:34`) | Implemented | Reuse constraints | CRM commands must be batch-shaped. Attachment storage is tight for message media: R2 support exists (`worker/fileStore.ts`, `file_storage_jobs`) but is **not enabled** at the pinned config (`wrangler.jsonc:22-24`: `r2_buckets` commented out, `FILE_STORAGE` `d1`). Enabling it is an owner step before channel media. |

### B3. Pack databases mapped to CRM use

| Pack database | CRM role | Change needed |
|---|---|---|
| People | Canonical person | Add fields (location, languages, disciplines, interests, source, lifecycle projections). Keep the field named "Email" (website matching depends on its name). |
| Organizations | Canonical organisation | Add type (school, collective, space operator, supplier, partner...). |
| Programs | Programme registry for all 14 | Add area, engines, programme lead, public form mapping. |
| Events | Editions, events, workshops, sessions | Capacity becomes a projection of the server edition; add datetime fields. |
| Places | Dhaanyam, Parambu, associated and applicant spaces | Relationship select already has Owned, Leased, Partner, Community, Other (Active, Partner, Historical are the stage columns); add Associated and Applied. |
| Opportunities | Commercial and collaboration pipelines (consulting, partnerships, production, funding, supply) | Add pipeline and programme; keep stages configurable per pipeline. |
| Transactions | Budget and expense tracking for projects | Stays a project-finance tool; not the payment ledger. |
| Common Cupboard | Product ideas and makers | Orders and inventory deferred (owner design needed). |
| Courses | Common Lab courses | Enrolment interest only; no LMS. |
| Meetings, Decisions, Tasks, Projects | Workspace delivery side | Accepted collaborations hand off to Projects. |

### B4. Documentation versus code

| Document says | Code says | Impact |
|---|---|---|
| `AGENTS.md` lists collections ending at `links` | `shared/collections.ts:5` also has `automations`, `forms` | Minor doc drift. |
| Handover: pack has 35 pages | Pack has 38 pages | Count, not behaviour. |
| Integration contract names website branch `site-patron` | No such branch; relay is on `codex/website-launch-fixes` | Update both contract copies later (C-05). |
| Handover says People has normalized-email matching | Confirmed, plus deterministic person IDs and an admin rebind route (`worker/admin.ts:70`) | Stronger than described; must be preserved. |
| Earlier version of this audit: `_` fields are rejected for client writes | True only with permissions on (`worker/sync.ts:352-355`) | Design corrected (ADR-04). |
| Earlier version: Places Relationship select contains Active, Partner, Historical | Those are stage columns; the select is Owned, Leased, Partner, Community, Other | Pack upgrade plan corrected (`06`). |
| Earlier version: 20 MB is a D1-only file limit | 20 MB per file in both modes; R2 not enabled in `wrangler.jsonc` | ADR-11 corrected. |

### B5. Regression risks and migration hazards

1. **Re-keying people.** Website people IDs are derived from the database ID, email field ID and email (`worker/websiteIngest.ts:445-446`). Any merge or endpoint change must keep the existing record ID as canonical and add aliases; changing the Email field ID or name breaks matching for new submissions.
2. **Pinned People database.** The ingest grant pins `people_id` (`migrations/0034_website_source_authority.sql:23`). If the CRM introduced its own People database, website senders would keep landing in the old one. One People database, always.
3. **Shell coupling.** Mounting a second shell must not start a second sync engine or bypass `AccountSwitchGate`. A regression here can cross-contaminate account-local caches.
4. **CSS leakage.** Workspace styling is global Tailwind. CRM tokens must be scoped under a root attribute so Workspace screens render identically (regression screenshots required).
5. **D1 budget.** Timeline aggregation across people, conversations and records can exceed 45 calls if written naively. Commands and reads must be batch-shaped from the start.
6. **Pack upgrades.** New CRM fields must arrive as additive pack upgrades, retain team customisations, and keep legacy stable IDs (`AGENTS.md` Architecture).
7. **Permission activation.** Activating permissions later evicts unreadable records from devices. CRM data placed in Spaces now must be placed deliberately, or activation will hide data from people who need it.
8. **Projection forgery while permissions are off.** The general `_` rule does not run in disabled mode (`worker/sync.ts:352-355`). Without the S0 pre-check, any account could set `_crm_` values that grids would display as server facts.
9. **Owner loss.** An admin can demote, disable or remove the only owner (C-06), which would leave the CRM with no implicit capability holder.

### B6. High-value gaps in the current abstractions

1. A **command abstraction**: server operations with idempotency, expected revision, capability check, journal and atomic projection. Today these exist piecemeal (website ingest, approvals, MCP `reg()`), not as a reusable pattern.
2. **External identity**: no notion of an external endpoint (email address, phone, social handle) separate from a person record.
3. **Communication as data**: no conversation, message or delivery receipt model.
4. **Lookup (mirror) columns**: relations exist but showing a related record's field in a grid needs a read-only lookup.
5. **Persisted grid presentation**: column order, width and pinning per saved view.
6. **Capability grants finer than space role**: needed for send, finance and restricted reads.
