# Phase 3 — TCG operating pack, dashboards, field mode

Goal: give TCG a ready workspace built **only from configuration** (databases, relations, views, templates) plus two generic product features: **dashboard blocks** and **field mode**. Nothing TCG-specific is hardcoded; the pack is a bundled template JSON like Phase 1's People starter.

Depends on Phases 1–2 (databases, relations, views incl. calendar/timeline).

---

## 1. Generic product features in this phase

### 1.1 Archive
- `archived?: boolean` on pages, boards, records. Archived items: hidden from sidebar/default views, still searchable, still linked; view filter "Include archived". Distinct from `deleted`.
- MCP `archive_item` / `unarchive_item`.

### 1.2 Dashboard blocks (new block types, registered via `registerBlockType`)
| Block | Config (block fields) | Renders |
|---|---|---|
| `view` | `{databaseId, viewId? , inline?: ViewConfig, limit?}` | any database view embedded in a page (generalises `tasks` block; `tasks` remains as alias) |
| `metric` | `{databaseId, filters, agg: 'count'\|'sum'\|'avg', fieldKey?, label, format?: 'number'\|'currency'}` | big number; click → filtered table of the underlying records |
| `calendar` | `{sources: {databaseId, dateKey, filters, color}[]}` | unified calendar across databases |
| `activity` | `{scope: 'all'\|'mine'\|{pageTreeId}, limit}` | recent activity list |
| `mywork` | `{}` | current user's open records across task databases (overdue/today/upcoming) |

Rule: every number links back to the records (no vanity metrics). Aggregation reuses `shared/views.ts` (+ `aggregate()` added there, unit-tested).

### 1.3 Field mode (mobile capture context)
- Capture screen gains a **Context** chip: pick a record/page/place (any record) → stored in `localStorage ws_field_ctx` (+ shown on Home). Captures (photo, voice, note, expense, observation, task) create a record in a chosen target database (default Inbox) and a `related` link to the context; observations/expenses use a per-context "capture target" mapping stored on the context database (`board.captureTargets?: {kind: 'observation'|'expense'|'task'|'note', databaseId}[]`).
- Quick actions configurable per database ("Field actions"), not hardcoded.
- Works offline (all writes via `mutate`, files via existing pipeline, Drive links as text).

### 1.4 Template gallery
- Settings → Templates lists bundled JSON templates (Phase 1 mechanism) + workspace templates. "TCG Operating Pack" is one bundled entry.
- Instantiation uses the Phase 1 planner (databases, views, relations, pages, links, record bodies).

## 2. TCG Operating Pack (`templates/tcg-pack.json`)

All databases `kind:'records'` unless noted. ↔ = two-way relation.

| Database | Stages | Key fields | Relations |
|---|---|---|---|
| Programs | Active, Paused, Closed | Owner (person), Objectives (body), KPIs (body/metrics) | ↔ Projects |
| Projects | Idea, Under review, Approved, Planning, Active, Blocked, Review, Completed, Paused, Cancelled | Owner, Team (multi person), Priority, Start/End (date), Budget (number), Objective (text) | ↔ Programs, ↔ Places, ↔ People, ↔ Organizations, ↔ Experiments, ↔ Events, ↔ Media, ↔ Decisions, ↔ Transactions |
| Tasks (`kind:'tasks'`) | To do, Doing, Review, Done | built-ins + Project (relation) | → Projects |
| Experiments | Proposed, Designing, Running, Analysing, Documented, Published | Problem, Question, Hypothesis (text), Lead, Location, Publication status | ↔ Projects, ↔ Places, ↔ People, ↔ Media, ↔ Courses |
| Field log (observations) | — | Date, Measurement (number), Unit, Observation (text), Photos (files) | → Experiments / Projects / Places |
| Ideas | Captured, Researching, Review, Approved, Parked, Rejected, Converted | Theme (multi), Impact, Effort (select), Creator | → Projects (converted to), → Decisions |
| Decisions | Open, Recommended, Decided, Superseded | Question, Options/Context/Reason (body), Decision maker (person), Date | ↔ Projects, ← Meetings |
| Meetings | Planned, Done | Type (select), Date, Participants (person + People relation) | ↔ Projects, ↔ Organizations, → Decisions; actions = Tasks with relation |
| Events | Planning, Open, Running, Done, Reviewed | Type, Dates, Capacity, Budget, Revenue | ↔ Places, ↔ People as three separate relation fields (Facilitators, Volunteers, Participants), ↔ Organizations, ↔ Transactions |
| Places | Active, Partner, Historical | Relationship (Owned/Leased/Partner), Location, Capacity | ↔ Projects, Events, Experiments, People, Organizations |
| Opportunities | Researching, Target, Contacted, Conversation, Proposal, Negotiation, Submitted, Active, Won, Lost, Dormant | Type (Grant, CSR, Donation, Sponsorship, Research funding, Technology grant, Cloud credit, Nonprofit software, Institutional partnership, Academic collaboration), Amount, Deadline, Decision date, Owner, Next action + date | ↔ Organizations, ↔ Projects |
| Media | Idea, Research, Pre-production, Production, Editing, Review, Approved, Scheduled, Published, Archived | Format, Channel, Publish date, Owner | ↔ Projects, Experiments, Courses, People (credits) ; Drive links as attachments |
| Courses | Idea, Research, Curriculum, Production, Review, Published | Format, Tutors | ↔ Media, Experiments, Events |
| Transactions | — | Type (Income/Expense/Budget line), Amount, Date, Category (select), Funding source, Receipt (files/Drive) | → Projects, Events, Opportunities |
| Products (Common Cupboard) | Exploring, Sampling, Listed, Paused | Price, Cost, Margin (computed later; text now), Producer (relation People/Org) | → Projects |
| People, Organizations | from Phase 1 starter | + Membership status, Joined, Skills, Availability | as above |

Templates (pages with `{{vars}}`): New Project, New Experiment, Event/Workshop, Field Visit, Meeting (weekly operating review, project review, finance review, partnership review, content planning, quarterly strategy), Research Note, Case Study, Grant Application, Course, Media Production, Volunteer Program, **Project Review** (planned / happened / worked / failed / learned / change / document / could become course-article-video).

Dashboards (pages using §1.2 blocks): Home/Leadership, My Work, Program (one per program via template), Project (inside project template), Common Lab, Community, Partnerships & Funding, Media, Operations/Finance. Each block listed with its exact filter in the JSON.

Information architecture created by the pack (pages): Home, My Work, Programs, Common Lab, Places (Parambu Habitat page), Community, Partnerships & Funding, Events & Education, Media, Meetings & Decisions, Ideas, Finance, Knowledge (research notes/SOPs/policies page tree), Archive view.

## 3. MCP additions
- `install_template({bundled: 'tcg-pack' | 'starter-people'})` (dryRun supported).
- `convert_idea_to_project({ideaId, templateId?})` generic: `convert_record({recordId, toDatabaseId, templateId?, linkKind:'related'})` — creates target record (optionally from template), links back, sets source stage to a given stage.
- Prompts: `weekly_operating_review`, `project_review`, `field_notes_to_log`.

## 4. Tests (outline)
Pack installs into an empty workspace and into a workspace with Phase 1 starter (no duplicate People DB: installer detects by `templateKey` stored on boards and reuses); every dashboard block renders and its numbers match `query_records`; field mode capture offline → links created after sync; convert_record links both ways.

## 5. Acceptance
Leadership questions in the brief ("what is blocked", "which grants are due", "what happened at Parambu") are answerable from the installed dashboards and searchable records, with every number clicking through to records.
