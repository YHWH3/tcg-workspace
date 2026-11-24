# Monday CRM study

## Method and limits

I reviewed Monday's public support centre, developer documentation and product pages (links at the end). I did not use a signed-in Monday CRM account, so I have not tested interaction speed, keyboard behaviour or visual detail first-hand. Where I describe behaviour, it is what Monday's own documentation states. Nothing here copies Monday's branding, assets or code; the TCG CRM uses its own components, names and visual identity.

## 1. What Monday CRM is built from

| Concept | How Monday does it | Source |
|---|---|---|
| Entity boards | A CRM account comes with interconnected core boards Monday calls entities: Contacts, Leads, Deals, Accounts and Activities. Core boards and columns cannot be deleted or duplicated. | "Manage your contacts with monday CRM"; "monday CRM Ultimate" |
| Lead flow | Leads arrive manually, by import or by a Monday form; a qualified lead is moved to Contacts, and can be linked to Deals and Accounts. A duplicate-check column scans for duplicated leads by email and company and for existing accounts. | "Get started with monday CRM"; "Lead management with monday CRM" |
| Groups | A group is a colour-coded section of a board holding items; groups collapse, and collapsed groups show column summaries. A board footer summarises all groups. | "Groups"; "How to custom design your board" |
| Status column | Up to 40 coloured labels per status column; labels can be account defaults; status changes appear in the item's Updates. | "The Status Column" |
| Connect Boards and Mirror | Connect Boards links items across boards; a Mirror column displays a chosen column from connected items, and edits through it reflect on the source. | "The Connect Boards Column"; "The Mirror Column"; "Multi-board mirroring" |
| Item view | Opening an item shows its Updates section (team conversation with mentions, files, checklists, reactions, AI summaries) and optional item views such as the Item Card with widgets. | "The Updates Section"; "The Item Card" |
| Emails & Activities | Preinstalled on entity boards. Connect Gmail or Outlook by OAuth; send and receive from the item; templates; log meetings, call summaries and custom activity types; an Activities timeline column links to the timeline. | "Emails & Activities"; developer "Custom activity" reference; "Activities timeline column" |
| Email matching | An email is logged on an item when the item's Email column address and the connected account both appear in the thread; it appears on every item whose Email column matches, and on connected items with a Board > Group > Item path. Addresses in more than 250 Email columns are not logged. Threads keep replies together. | "Emails & Activities: how it works" |
| Email tracking | Opens via a single-pixel image and link clicks; can be disabled per email; Monday itself notes blocked images cause missed opens and security scanners cause false opens. | "Emails & Activities: how it works" |
| Duplicates | "Manage duplicates" supports text, email, link, name, numeric, country and status columns. | "Manage duplicates" |
| Automations | Recipes read as "When trigger, if condition, then action"; there is an Automations Center of prebuilt recipes and custom recipes. CRM recipes include updating a date column when an email or activity is created. | "Get started with monday automations"; "Build your own custom automation"; "Emails & Activities" |
| Dashboards | Widgets including Numbers, Chart, Battery (progress by status), Gantt, Calendar, List; widgets read from one or more boards. | Dashboards product page; developer widget schema; "The Battery Widget" |
| My Work | One page of items assigned to you across the account, with customisable columns and views; documented limit of 1,000 items. | "My Work"; "Troubleshoot: My Work" |
| Mobile | Board views on mobile are a subset (Calendar, Timeline, Kanban, Battery per an older article); Emails & Activities on mobile requires connecting the email on a computer first; offline mode lets you change values and create items, but "If someone else has made changes to the same item, your change will override theirs", with no offline indicator, and the Emails & Activities timeline is not supported offline. | "Mobile app board views"; "Key differences..."; "Mobile app - Offline Mode"; "Emails & Activities" |
| AI | Sidekick (conversational assistant), AI agents (act on schedules, events or monitoring), AI email composer in Emails & Activities, AI summaries of updates. CRM AI Sales Agent is beta and U.S.-only per its article. | "AI Agents on monday.com"; "Get started with monday sidekick"; "Emails & Activities: AI email composer"; "monday CRM AI Sales Agent" |

## 2. What makes the experience good (and what to learn from it)

1. **One dense, editable surface.** The main table is where work happens: grouped rows, coloured status cells, inline edits, summaries per group. It reads like a spreadsheet and behaves like a workflow.
2. **Colour as orientation.** Group colours and status colours let people scan state quickly. Monday's own community shows the downside: dashboards that group status by colour rather than label confuse reports. TCG keeps the label as the identity and colour as a cue.
3. **The item is a place.** Opening an item gives one place for the record's fields, its conversation and its communication history.
4. **Connections are visible.** Connect Boards plus Mirror makes related data visible in the grid without opening records.
5. **Automations read like sentences.** "When status changes to Won, create item in Onboarding" is understandable without training.
6. **Communication lives next to the record.** Emails & Activities removes the inbox-to-CRM copy step.

## 3. Where Monday's model is weak for TCG

| Weakness (from Monday's own docs or community) | TCG design response |
|---|---|
| Email matching by Email-column address puts the same email on every matching item; one address in 250+ columns is silently not logged | Identity endpoints are unique per person; ambiguous matches go to a review queue instead of logging everywhere |
| Basic duplicate handling; community reports merging accounts does not merge linked contacts | Merge is a server command that relinks relations, keeps aliases, and is reviewable and journalled |
| Offline edits override others with no indicator | Workspace already has per-field merge, conflict review and pending states; consequential CRM actions are never "done" offline |
| Open tracking is unreliable and invasive | No open or click tracking by default (P-16), in line with TCG's non-pressuring ethos |
| Sales-first entities (Leads, Deals) | TCG's spine is People and Participations; pipelines are optional per programme |
| Agents that act on their own | AI proposes and drafts; humans send, confirm and record money (P-14) |
| Mobile is a reduced subset | Workspace's standing requirement is full mobile functional parity (`AGENTS.md`) |

## 4. Adopt, adapt, reject

| Capability | Decision | TCG form |
|---|---|---|
| Grouped editable grid with group colour bar, collapse, per-group summaries | Adopt | CRM Grid (`08` section 6) |
| Status cells with full-cell colour | Adapt | Full-cell colour plus always-visible text label and icon shape for done/blocked; contrast-checked in light and dark |
| Item side panel with tabs | Adopt | Record panel: Overview, Timeline, Participation, Money (capability-gated), Files, AI |
| Updates section | Adapt | Workspace comments become the "Team notes" filter of the timeline; internal notes are never sendable |
| Emails & Activities timeline | Adopt, extend | One timeline across email, WhatsApp, Instagram, Facebook, website submissions, logged calls and meetings, bookings and payments |
| Activity types incl. custom | Adopt | Call, Meeting, Visit, Note, Follow-up, plus admin-defined types |
| Connect Boards + Mirror | Adapt | Existing relations plus a read-only Lookup column; edits go to the source record, not through the mirror |
| Manage duplicates | Adopt, strengthen | Duplicate review queue with confidence reasons and reversible merge |
| Sentence automations and recipe centre | Adopt | CRM Automations reuse the Workspace engine plus new CRM triggers and gated actions |
| Numbers, Battery, Chart, List widgets | Adopt | Existing chart/dashboard/metric blocks plus a Battery (stage distribution) widget |
| My Work | Adopt | CRM Home: today's follow-ups, unanswered conversations, expiring holds, reviews waiting on me |
| Lead scoring, forecasting view | Defer, optional | Only for commercial pipelines if wanted |
| Email open/click tracking | Reject by default | Possible later as an explicit per-message opt-in, owner decision |
| Autonomous AI agents with external effects | Reject by default | AI stays proposal-only for side effects |
| Mass email campaigns | Defer | Out of scope until consent, templates and provider costs are decided; TCG's voice guidance discourages broadcast pressure |
| Colour-coded groups as the only structure | Adapt | Groups are a saved-view setting (group by any field), not a fixed property of the record |

## 5. Improvements beyond parity

1. **Window-aware composer**: shows whether a free-form WhatsApp or Instagram reply is allowed right now, and offers an approved template when not.
2. **Fact-grounded drafts**: AI drafts cite verified operational facts (price, dates, inclusions) with their verified date, and refuse to state a fact that is stale or missing.
3. **Participation strip** on every profile: one line per programme involvement with its stage, so "who is this person to us" is answered in one glance.
4. **Pending is visible**: any action waiting on a provider, approval or connectivity shows as pending with its reason, never as done.
5. **Keyboard grid**: arrow-key cell navigation, Enter to edit, Escape to cancel, Space to open the panel, so a small team moves fast on desktop.

## Sources

- [Emails & Activities](https://support.monday.com/hc/en-us/articles/360019213180)
- [Emails & Activities: how it works](https://support.monday.com/hc/en-us/articles/12428852177810-Emails-Activities-how-it-works)
- [Emails & Activities: AI email composer](https://support.monday.com/hc/en-us/articles/20487462433554-Emails-Activities-AI-email-composer)
- [Activities timeline column](https://support.monday.com/hc/en-us/articles/25070276400658-Activities-timeline-column)
- [Custom activity (developer API)](https://developer.monday.com/api-reference/reference/custom-activity)
- [Manage your contacts with monday CRM](https://support.monday.com/hc/en-us/articles/115005311909-monday-com-as-a-CRM)
- [Get started with monday CRM](https://support.monday.com/hc/en-us/articles/4409464697618)
- [monday CRM Ultimate](https://support.monday.com/hc/en-us/articles/360013494979-monday-CRM-Ultimate)
- [Lead management with monday CRM](https://support.monday.com/hc/en-us/articles/360008648359)
- [Manage duplicates](https://support.monday.com/hc/en-us/articles/4402803033490-Manage-duplicates)
- [The Updates Section](https://support.monday.com/hc/en-us/articles/115005900249)
- [The Item Card](https://support.monday.com/hc/en-us/articles/360017143959)
- [The Connect Boards Column](https://support.monday.com/hc/en-us/articles/360000635139)
- [The Mirror Column](https://support.monday.com/hc/en-us/articles/360001733859)
- [Multi-board mirroring](https://support.monday.com/hc/en-us/articles/4403442212498-Multi-board-mirroring)
- [The Status Column](https://support.monday.com/hc/en-us/articles/360001269685)
- [Groups](https://support.monday.com/hc/en-us/articles/360011472320)
- [How to custom design your board](https://support.monday.com/hc/en-us/articles/360019103140-How-to-Custom-Design-Your-Board)
- [Get started with monday automations](https://support.monday.com/hc/en-us/articles/360001222900-monday-com-Automations)
- [Build your own custom automation](https://support.monday.com/hc/en-us/articles/360012254440)
- [Dashboards](https://monday.com/w/dashboards) and [All widgets schema](https://developer.monday.com/api-reference/reference/all-widgets-schema)
- [The Battery Widget](https://support.monday.com/hc/en-us/articles/360002159360)
- [My Work](https://support.monday.com/hc/en-us/articles/360019300579) and [Troubleshoot: My Work](https://support.monday.com/hc/en-us/articles/4413988748818-Troubleshoot-My-Work)
- [Mobile app: board views](https://support.monday.com/hc/en-us/articles/360015740220-Mobile-app-board-views), [Key differences between mobile and browser](https://support.monday.com/hc/en-us/articles/360015779760-Key-differences-between-the-mobile-app-and-your-browser), [Mobile app: Offline Mode](https://support.monday.com/hc/en-us/articles/360017712819-Mobile-app-Offline-Mode)
- [AI Agents on monday.com](https://support.monday.com/hc/en-us/articles/33347027353746), [Get started with monday sidekick](https://support.monday.com/hc/en-us/articles/26701503726610), [monday CRM AI Sales Agent](https://support.monday.com/hc/en-us/articles/31002285812882-monday-CRM-AI-Sales-Agent)
