# Phase 8 — Operating desks

Branch `sol/p8-desks` stacked on `sol/p7-foundations`.

**Principle:** a desk is a dashboard page that leads to an action. Every number
or item opens its source records and offers the next step: assign, reply,
decide, approve, correct, recover. Build desks from existing blocks first. Add
new code only where a desk needs something the blocks cannot express. Never
present device-local totals as organisation-wide totals.

Desk pages ship as operating-pack pages through 7.4 (pack upgrade), so existing
installs receive them too. Each desk is also usable without the pack where
noted.

**Implementation order** (this overrides numeric order):
8.1 → 8.9 → 8.11 → 8.3 → 8.4 → 8.5 → 8.6 → 8.7 → 8.8 → 8.12 → 8.13 → 8.14 → 8.10 → 8.2.
8.2 (Home) composes the others, so it comes last.

**Shared rules for every new dashboard block type**
- Register it with `registerBlockType` in `src/modules/boards/blocks/`.
- Teach `dashboard_snapshot` (`worker/mcpReadTools.ts:63-66`, the `supported`
  list) to evaluate it with the SAME shared function, so AI and app agree.
- It has distinct states: loading, empty, missing source, archived source,
  restricted, partial ("based on N of M records"), and offline/stale ("as of
  <time>, this device").
- It has a Configure panel that is keyboard and touch accessible, and a
  drill-down sheet (`RecordListSheet` in `blocks/shared.tsx`) with the exact
  contributing ids.
- It uses "today" from the context (7.2), never `new Date()` directly.

---

## 8.1 Attention queue (foundation of the desks)

**Goal:** one list of what needs *me*, now, across modules, each item with a
clear action. Owner decision D6 confirms the sources.

### Item model

The pure model lives in a new file `shared/attention.ts`:

```ts
type AttentionKind =
  | 'approval_pending'        // approvals.approver_id = me, status pending
  | 'ai_preview_pending'      // ai_previews.user_id = me, status pending, not expired
  | 'suggestion_pending'      // ai_suggestions pending on records I can edit (verify table columns)
  | 'record_overdue'          // a record whose attention person = me, date < today, not done
  | 'record_due_today'
  | 'record_due_soon'         // within board.attention.soonDays (default 3)
  | 'record_unassigned'       // only for boards with attention.triage=true; audience = triagers
  | 'website_aging'           // open Website submission older than band threshold (8.3)
  | 'mention_unread'          // unread notification kind 'mention'
  | 'automation_failed';      // admins only (8.10)

interface AttentionItem {
  key: string;                // stable: kind + target id
  kind: AttentionKind;
  targetType: 'record'|'page'|'approval'|'preview'|'suggestion'|'automation';
  targetId: string;
  title: string;              // '' when restricted
  url: string | null;
  databaseId?: string;
  ownerId?: string | null;
  date?: string | null;       // due/deadline/received date-only
  ageDays?: number;
  severity: 0|1|2|3;          // 3 blocking-me, 2 overdue, 1 due today/aging, 0 other
  actions: ('open'|'assign_me'|'decide'|'review'|'mark_done'|'snooze')[];  // snooze is out of scope v1
  restricted?: true;
}
```

`rankAttention(items, today)` sorts by severity desc, then date asc (oldest
first), then ageDays desc, then key. Pure, deterministic, unit-tested.

### Per-database configuration

This is configuration, not hard-coding: TCG specifics stay in the pack. Add an
additive board key `attention`:

```ts
attention?: {
  enabled: boolean;
  personKey: 'assigneeId' | `p_${string}`;   // whose item it is (person field)
  dateKey?: 'dueDate' | `p_${string}`;       // which date drives overdue/soon
  soonDays?: number;                          // default 3, max 30
  triage?: boolean;                           // unassigned records go to triagers
  triagers?: 'admins' | string[];            // user ids; default 'admins'
}
```

- Tasks databases default to `{enabled:true, personKey:'assigneeId', dateKey:'dueDate'}`
  when the key is absent.
- Records databases default to disabled.
- Pack values (via 7.4):
  - Opportunities: `p_f_owner` + `p_f_next_action_date`, then deadline. Verify
    the field ids in the pack.
  - Decisions: `p_<decision maker>` + `p_<date>`.
  - Media: Owner + Publish date.
  - Website inbox: `assigneeId` + `dueDate`, `triage:true`.
- UI: Board menu → "Attention" sheet (enable, person field, date field, soon
  days, triage). MCP `update_board` accepts `attention` with validation.

### Server collector

New `worker/attention.ts` exposes `GET /api/attention?limit=50&cursor=`.

- **Session-authenticated, at most 12 D1 calls**, using one `db.batch` of
  per-source SELECTs:
  1. pending approvals for me (index `idx_approval_approver`);
  2. pending, unexpired AI previews for me;
  3. pending suggestions on records I can read (verify `ai_suggestions` schema);
  4. boards with `attention.enabled` (one bounded `records` query on
     `collection='boards'`);
  5. dated records: `date_index` joined to `records` for
     `date <= today+maxSoonDays`, the attention boards and
     `field_key IN (dateKeys)`, filtered in SQL by the person key equal to me
     via `json_extract`. Cap 500 rows; verify the `date_index` column semantics
     (`record_id`, `field_key`, `date`, primary key on all three);
  6. unassigned triage records on triage boards (cap 200; triagers only);
  7. unread mentions (`notifications` with `kind='mention' AND read_at IS NULL`,
     cap 50);
  8. failed automation runs in the last 7 days (admins only, cap 20).
- **Done filtering.** A record is done when its status is the board's last
  column. Reuse the `isDone` helper in `shared/recurrence.ts` or the board
  column rule; check which one `mywork` uses (`mcpReadTools.ts:84`) and share
  it.
- **Authorization.** Collect every target record id and call
  `createReadGate(db, userId).decide(ids)` once. Unreadable items become
  `restricted:true` with an empty title and null url (mirror
  `restrictedApprovalJson`). Exception: items whose target is the approval or
  preview itself, which belong to the user.
- **Titles** come from the fetched rows. Never one `loadTargetMeta` call per
  row (N07).
- **Ranking** in the worker uses `rankAttention`.
- **Cursor:** an opaque keyset over (severity, date, key), bound to `userId`.
  Copy the notifications cursor validation (`worker/notifications.ts:374`).
- **Partial results:** when a source hits its cap or the D1 budget, return
  `partial:true` with the source names. The UI says "Some items may be missing."

### Clearing rules

These are derived from source state, so there is no queue table in v1.

| Item | Clears when |
|---|---|
| approval | decided or cancelled |
| preview | executed, cancelled, conflicted or expired |
| suggestion | accepted or rejected |
| record | done, reassigned, date moved out of the window, archived or deleted |
| unassigned | assigned |
| mention | read |
| automation failure | a later run of the same automation succeeds, or an admin acknowledges it (acknowledge is out of scope v1) |

### Client

- **Block type `attention`.** Config: max items (5/10/20), kinds filter,
  compact or full.
- Each row shows: kind icon, title, database, date or age, owner chip and a
  primary action button.
- **Actions**
  - `open` → url.
  - `assign_me` → `mutate()` the record's person key to me. Optimistic; show
    "Saved on this device" until synced.
  - `decide` → the existing approvals UI (`src/modules/approvals/`).
  - `review` → `/ai/review/:id`.
  - `mark_done` → move to the last stage via existing record APIs. Respect
    approval gates: a gated transition opens the approval request flow instead.
- **Offline:** cache the last response in Dexie `meta` under
  `attention:<userId>`; show "As of <time> (offline)". Actions still queue via
  `mutate()`.
- **Live refresh:** refetch on the `changed` poke from `src/core/live.ts`,
  debounced 2 s.
- **Navigation:** an optional sidebar badge with the count of severity ≥2.
  Respect the `quietDigest` preference.

### MCP and AI

- Read tool `attention_queue` (limit ≤50): same collector, same ranking.
  Classify as `R('attention_queue','dashboards')`.
- AI action `triage_my_attention` in `shared/aiActions.ts`
  (output: `answer`). It summarises the queue and proposes an order; it never
  acts.

### Tests

- Unit: `rankAttention`, clearing predicates and config validation.
- D1 `tests/phase8-attention-d1.test.ts`, with permissions enabled and disabled:
  each source, restricted rendering, budget ≤12 calls (assert), cursor,
  partial flag, no cross-user leakage, and a guest seeing only their spaces.
- Browser: a block on Home with three engines; keyboard actions; assign_me
  offline then reconnect.

### Acceptance

- An admin with one pending approval, one overdue task and one unassigned
  website submission sees all three, ranked approval → overdue → submission.
- Every action works.
- A member never sees items from spaces they cannot read.

---

## 8.2 Daily command center

**Goal:** Home becomes the place to start the day.

- **Pack page Home** (upgrade via 7.4). The page has four sections, built from
  existing blocks plus `attention`:
  1. Needs attention: `attention` block (severity ≥1).
  2. My execution: `mywork` block and a `view` block of "Projects I own"
     (Projects filtered by `p_f_owner` `me`).
  3. Coming up: a `calendar` block over Events, Meetings, Project dates and
     Opportunity deadlines. **Verify** whether the calendar block supports
     multiple sources (the atlas says it does). If not, add `sources[]` to its
     config with per-source date keys, rendering one agenda.
  4. What changed: an `activity` block and a "Pending AI review" mini list
     (from 8.11) plus the reliability summary chip (8.9).
- Replace the pack's broken two-filter "Deadlines in the next 30 days" metric
  with `within` (7.1). R1 already makes the old form correct.
- **Mobile:** sections stack; the attention block comes first.
- **Acceptance:** the Home page works with no pack-specific code beyond
  configuration.

---

## 8.3 Website response desk

**Goal:** no website submission goes unanswered or unowned.

Owner decisions D4 (triage audience) and D5 (age bands and target) apply.

### Data (no schema change)

The inbox board has `showBuiltins:true`, so:
- owner = `assigneeId`;
- follow-up date = `dueDate`;
- priority = `priority`;
- first reply = `wi_replied` (set by the existing automation `auto-wi-first-reply`).

Set `attention` on the inbox board: `assigneeId` + `dueDate` + `triage:true`.

### Shared logic (`shared/websiteStats.ts`)

- **N09:** one age basis. Age = days from the `wi_received` date (fallback:
  `createdAt` converted with the workspace timezone) to today. Apply it to both
  `oldestUnanswered` and the median.
- `responseBands(records, today, bands=[2,7])` returns the open counts and ids
  in 0–2, 3–7 and 8+ days. Configurable via workspace setting
  `websiteBands` (add a nullable JSON column to `workspace_settings` in the same
  phase's migration, or store it on the inbox board as `responseBands`; prefer
  the board key, which needs no migration).
- `ownerQueues(records)` returns `{ownerId|null, count, ids}` for open
  submissions.
- `targetBreaches(records, today, targetDays)` returns the open submissions past
  the target.
- `websiteDashboard` returns the new figures. `websiteDigest` adds bands.

### UI (`src/modules/website/index.tsx`)

- **Header strip:** open count, bands (clickable), median first reply against
  target, unassigned count.
- **Queues:** tabs "Unassigned", "Mine", "All open", "Follow-up due" (dueDate ≤
  today), plus the families.
- **Row actions:**
  - Assign to me / Assign…;
  - Set follow-up date;
  - Mark replied (status → `replied`; the automation stamps `wi_replied`);
  - Done;
  - Open answers.
- **Bulk:** select rows → assign / set status (uses 9.5's bulk-edit primitive
  if available; otherwise sequential `mutate()` with one undo). Spam
  suggestions remain suggestions.
- **Reply drafting:** the existing `draft_reply` prompt and assistant action.
  A "Copy draft" button only. Sending email is out of scope (owner integration
  later).
- **Patron pipeline panel:** unchanged; add refund-needed as a severity-2
  attention item.

### MCP

- `website_query` accepts `queue` (`unassigned|mine|open|followup_due`).
- `website_digest` includes bands and breaches.
- `propose_website_triage` may set `assigneeId` and `dueDate`. It stays
  significant (a preview).

### Contract

The ingest contract is unchanged. Do not touch
`docs/integrations/the-common-ground.md` or the website copy unless the event
body changes.

### Tests

- Unit: bands, owner queues, the age basis and breaches.
- D1: MCP queue filters under the read gate.
- Browser: Website UI gate (`scripts/verify-website-ui*.mjs`; verify the name)
  extended with queues and actions on three engines and the compact layout.

---

## 8.4 Project review cockpit

**Goal:** see why a project is stuck and fix it from one place.

- **Shared:** a new file `shared/projectHealth.ts` with
  `projectHealth(project, ctx): {signals: Signal[], status: 'on_track'|'at_risk'|'blocked'|'unknown'}`.
  The rules are transparent; each signal names its rule and source ids:
  - `blocked_stage`: the project's stage is "Blocked" (pack column id
    `blocked`) or any linked task is in a Blocked stage;
  - `dependency_blocked`: a `links` kind `blocks` from an unfinished record to
    this project or its tasks;
  - `owner_missing`, `dates_missing` (Start/End empty), `overdue_tasks` (count),
    `open_decisions` (linked Decisions not done), `pending_approvals` (on the
    project or its tasks);
  - `no_recent_activity` (no activity on the project tree in N days, default 14;
    needs activity data, so the client reads local activity and the server uses
    `activity_for`).
  - Status: blocked if any blocking signal; at_risk if overdue_tasks>0 or
    open_decisions>0 or dates_missing; on_track otherwise; unknown when sources
    are partial.
- **Block type `projecthealth`.** Config is either one project (record id) or
  "all projects in database X with filter". It lists projects with status, top
  signals and a drill-down; each signal links to its records with a fix action
  (assign owner, set dates, open decision, open approval).
- **Pack:** the Project Review template and the Projects record page body get a
  `projecthealth` block for the current record. **Verify** how record-page
  blocks reference their own record (`pageId = recordId`); add a config value
  `self` if needed.
- **MCP:** `dashboard_snapshot` supports `projecthealth`; the
  `operating_review_context` result includes health signals. Same function.
- **Out of scope:** milestones (owner must define them first) and scoring
  numbers.
- **Tests:** unit for every rule and the status logic; parity test app vs MCP;
  browser on three engines.

---

## 8.5 Funding and finance desk (focused calculations, not general rollups)

**Goal:** see funding deadlines and project money without building a general
rollup system yet.

- **Funding attention** comes from 8.1 configuration on Opportunities. Also add
  a `view` block "Stale next actions":
  `Next action date within {from:'2000-01-01', to:'today-1'}` and status not
  won/lost.
- **Project budget summary.**
  - `shared/finance.ts`: `projectMoney(project, transactions, links, fieldsCtx)`
    returns `{budget, spent, income, remaining, currency, transactionIds, partial}`.
  - It sums the Amount of Transactions linked to the project through the
    relation field, split by Type (expense/income option names, matched by
    option name via `optionByName`).
  - Use the 7.2 currency rule: refuse to combine if the Budget and Amount fields
    declare different currencies, returning
    `{error:'mixed_currency', currencies:[…]}`. The UI says why.
- **Block type `budget`.**
  - Config: a project, or a projects database with a filter.
  - It shows budget vs spent with a bar, the remaining amount and a drill-down
    to transactions.
  - "Partial" when transactions on this device are incomplete; the MCP figure
    is authoritative for the user's accessible set.
- **Common Cupboard margin (N05).**
  - Do not alter or delete the existing text "Margin" field.
  - Add `productEconomics(product)` to `shared/finance.ts`, returning price − cost
    and the margin percentage.
  - Render it with block type `budget` in `mode:'product'` on the products
    database page, labelled "computed from Price and Cost".
  - When Phase 12 formulas arrive, the pack upgrade can add a formula field
    beside the text field.
- **MCP:** `dashboard_snapshot` supports `budget`.
- **Out of scope:** bank feeds, reconciliation, exchange rates, formal
  accounting.
- **Tests:** unit for split and sign rules, the mixed-currency refusal and the
  partial flag; D1 parity; browser.

---

## 8.6 Field evidence desk

**Goal:** check what was observed, what is missing, and see measurements over
time.

- **Field sessions:** `shared/fieldSessions.ts` `groupSessions(fieldLogs)`
  groups records by (Date, Place, Experiment) into visits. Missing-context
  checks per record: no Place, no Experiment or Project, Measurement without
  Unit, no Observation text, photo link missing when the capture had media
  (verify capture provenance keys in `src/modules/boards/fieldMode.ts`).
- **Block type `fieldsessions`:** a list of recent visits with counts and
  missing-context chips; fix actions open the record with the empty field
  focused.
- **Measurement chart (focused, before the general chart view).**
  - `shared/measurements.ts`: `measurementSeries(fieldLogs, {experimentId?, placeId?, unit})`
    returns sorted points `{date, value, recordId}`.
  - A series requires a single Unit string, compared exactly after trimming and
    lowercasing. Mixed units are refused with a list of units found.
  - **Block type `measurechart`:** an SVG line chart (no new dependency; follow
    `shared/diagramLayout.ts` and canvas SVG conventions).
    - Accessible: a `<title>`, a data table toggle and keyboard focus on points
      with values announced.
    - Every point opens its record and its original photo or notes.
- **Capture health** comes from the reliability summary (8.9) for this device.
- **AI:** keep interpretation separate from observations; any AI summary is
  labelled and never written into Observation.
- **MCP:** `dashboard_snapshot` supports both new blocks.
- **Tests:** unit grouping, the unit refusal and series ordering; chart a11y;
  three engines.

---

## 8.7 Community and event desk

- **Relationships:** People by Membership status, and Organizations by
  Partnership status.
  - Through the pack upgrade (additive), add to both databases a
    "Relationship owner" (person) field and a "Next conversation" (date) field.
  - Configure `attention` on both: `personKey` = Relationship owner,
    `dateKey` = Next conversation.
- **Events:** an upcoming-events `view` block, plus a per-event role-coverage
  display. `shared/events.ts` must not be confused with the event pipeline; name
  the new file `shared/eventOps.ts`. `roleCoverage(event, links)` returns the
  counts of Facilitators, Volunteers and Participants relations and Capacity vs
  Participants (display only, never enforcement).
- **Registrations:** forms already create records. Show recent registrations per
  event (relation or form mapping; verify how the pack's Event registration form
  links to Events).
- **Out of scope:** check-in, attendance proof, capacity enforcement, consent
  records. These need owner-defined rules (list them in deferred.md as
  "needs design").
- **Tests:** unit for coverage; browser.

---

## 8.8 Editorial and knowledge desk

- Media by stage and publish date, using `calendar` and `view` blocks from the
  pack's Media database.
- **Review queue:**
  - Media records in stage `review`. The pack's Media stages are idea,
    research, pre_production, production, editing, review, approved, scheduled,
    published, archived.
  - Plus pending approvals on Media (8.1 kind filter).
  - "Missing owner or date" view using `empty` filters.
- **Evidence checklist:** for case studies and research notes, a `view` of pages
  or records lacking linked sources (Experiments, Field Log). Use relation
  `empty` filters where relations exist.
- **Out of scope:** external publishing, social posting, CMS sync, analytics.
- **Tests:** browser; pack upgrade adds the page.

---

## 8.9 Reliability view (this device)

**Goal:** a person can see whether their work actually reached the server, and
what to do if not.

- **Client-only data:**
  - outbox pending count and oldest pending age (`db.outbox`);
  - blobs by state: pending, uploading, failed, with names (`db.blobs`);
  - quarantined or held work (`accessQuarantineInfo`; `QuarantineReview.tsx`);
  - last successful pull and push times (read from engine state; **verify**
    where `src/core/sync/engine.ts` records them, and add a `meta` key if absent);
  - live socket connected or not.
- **Wording:** "On this device". Never claim server receipt beyond what the
  engine observed: an acknowledged push is "Synced at <time>".
- **Actions:**
  - Sync now (`syncNow`);
  - Retry failed uploads (reset blob state to pending; the existing
    `uploadPendingBlobs` runs);
  - Review held work (open QuarantineReview);
  - Export rejected items (reuse `shell.tsx:241`'s rejected export).
- **Surfaces:** Settings → Local data gets a "Reliability" panel; a compact
  status chip on Home (8.2) and in the sidebar footer when anything is pending
  for more than 2 minutes or has failed.
- **No server endpoint** in v1.
- **Tests:** unit for state derivation from fixture Dexie rows; browser offline →
  pending → online → synced on three engines; Android emulator check of the
  failed-upload path.

---

## 8.10 Automation and delivery health (admins)

- **New endpoint** `GET /api/automations/health` (admin; at most 8 D1 calls,
  batched). It returns:
  - failed `automation_runs` in the last 7 days, grouped by automation, with
    last error and count;
  - stuck `event_outbox` rows (`terminal_at` set, or attempts ≥5);
  - `form_submissions` with failed processing (verify the status columns);
  - pending approvals older than 3 days (approval age);
  - the scheduler's last run per phase. Add this only if cheap: a new tiny
    server table `scheduler_runs(phase, last_started_at, last_finished_at,
    last_error)` written at the end of each phase (1 call per phase), in a
    migration this phase. It is optional; skip it if the budget assertion fails.
- **UI:** the Automations module gets a "Health" tab with lists and links to
  each automation's runs (`GET /api/automations/:id/runs` exists).
- **No manual re-run in v1.** The existing recovery phases retry automatically;
  show "Will retry automatically" vs "Gave up after 8 attempts".
- **AI:** read tool `automation_health` (admin only; returns 403 for others).
  Classify as R.
- **Tests:** D1 with seeded failures; budget assertion; non-admin 403.

---

## 8.11 AI review desk

- Extend `/ai` (`src/core/AiWorkspace.tsx`) with one "Review" view:
  - pending previews (`/api/ai/previews`), with expiry countdown;
  - partially executed or conflicted previews with a Resume / Review action;
  - pending suggestions (`/api/ai/suggestions`) with accept, edit or reject;
  - recent AI changesets (`/api/changes?mine=1`) with Undo (existing
    `/ai/undo/:id`).
- Each section links to the existing screens; no new approval path.
- Attention queue kinds `ai_preview_pending` and `suggestion_pending` point
  here.
- **Tests:** browser with seeded previews and suggestions (disposable fixture
  approvals only); the human-only rule is unchanged (`execute_preview` and
  `undo_change` stay H).

---

## 8.12 Ideas review queue and conversion handoff

- **Pack Ideas stages:** captured, researching, review, approved, parked,
  rejected, converted.
- **Desk section** on the Ideas page:
  - "Waiting for review": stage `review`.
  - "Parked over 30 days": stage `parked` with updated-date
    `within {from:'2000-01-01', to:'today-30'}`. **Verify** there is a filterable
    updated timestamp on records; if not, use `createdAt` and say so in the UI.
  - "Approved, not converted": stage `approved`.
  Use `view` blocks; configure `attention` on Ideas with Creator + no date.
- **Conversion handoff:**
  - After `convert_idea_to_project` (MCP) or the UI convert action
    (`shared/conversion.ts`), the idea shows a "Converted to <project>" banner
    linking to the new project, using the existing "Converted to project"
    relation.
  - The project shows "From idea <title>" with a link back.
  - If the relation is missing on older conversions, show nothing; never guess.
- **Tests:** browser convert → banner both ways; unit for the banner data
  helper.

## 8.13 Meetings commitment review

- **Pack data:**
  - Meetings: stages planned/done; relations Participants, Projects,
    Organizations, "Decisions taken", "Action items" (→ Tasks).
  - Decisions: stages open, recommended, decided, superseded.
- `shared/commitments.ts` `meetingCommitments(meeting, links, tasks, decisions, today)`
  returns:
  - open action items (tasks not done), split overdue and upcoming;
  - unresolved decisions (stage open or recommended);
  - each with the meeting it came from.
- **Block type `commitments`:**
  - config is one meeting (record page), or "meetings in the last N days";
  - lists unresolved decisions and overdue actions grouped by meeting, each
    linking back to its meeting;
  - actions: assign, set due date, open decision.
  - `dashboard_snapshot` support.
- **AI:** the existing meeting-to-actions workflow creates proposals only; this
  view never invents owners or deadlines (empty stays empty, flagged
  "No owner").
- **Pack:** add the block to the Meetings & Decisions page and the Meeting
  template page.
- **Tests:** unit, parity, browser.

## 8.14 Forms operations view

- **Data:**
  - `form_submissions` (server-only) states: pending, processing,
    retryable_failure, rejected, accepted, with `attempts`, `error`,
    `retry_at`, `record_id`, `form_id`.
  - Public forms are defined in the pack (6 forms).
- **Endpoint:**
  - `GET /api/forms/:id/operations` (and `/api/forms/operations` for all forms
    the caller can edit). Members see the forms whose destination database they
    can edit; admins see all.
  - It returns: counts by state for 7 and 30 days; recent
    `retryable_failure` / `rejected` rows with the error class (never the
    submitted payload); and accepted submissions whose record is still in the
    first stage after N days ("unresolved follow-ups", via records read through
    the gate).
  - At most 6 D1 calls, batched.
- **UI:** the Forms module gets an "Operations" tab per form and overall.
  Website relay submissions are shown separately (they arrive through
  `worker/websiteIngest.ts`, not public forms) with a label "Website", so the
  two intake paths stay distinguishable.
- **Overlap with 8.10:** 8.10 shows workspace-wide delivery health for admins;
  8.14 is per-form for form owners. Share the query helpers in
  `worker/forms.ts`.
- **Tests:** D1 with seeded submissions in every state; non-editor forbidden;
  payload never returned.

---

## Phase 8 MCP/AI summary

| New read tool | Capability | Notes |
|---|---|---|
| `attention_queue` | `R('attention_queue','dashboards')` | per-user collector |
| `automation_health` | `R('automation_health','automations')` | admin only |

`dashboard_snapshot` gains `attention`, `projecthealth`, `budget`,
`fieldsessions`, `measurechart` and `commitments`.

New AI actions in `shared/aiActions.ts`: `triage_my_attention`,
`summarize_project_health` (record context, answer),
`explain_budget` (answer). Update `tests/assistant-registry.test.ts`
expectations automatically via the catalogs.
