# CRM UX and UI specification

Everything visual here is a design specification. Wireframes are illustrative and use fictional data. None of this is implemented.

## 1. Principles

1. **The grid is the workplace.** Most work happens in grouped, editable grids; the panel opens beside them, so context is never lost.
2. **One person, one timeline.** Every channel and every operational event about a person reads as one story.
3. **State is always labelled.** Colour helps scanning; the text label is the meaning. Pending, partial and restricted states are explicit.
4. **Fast for a small team on desktop, complete on a phone.** Dense by default on desktop; full functional parity on mobile, with layouts built for touch.
5. **Calm, not pushy.** No urgency banners at contacts' expense, no open tracking, no gamified scores. The interface reflects TCG's tone: clear, warm, practical.
6. **CRM looks like its own app** and never changes how Workspace looks.

## 2. Shell

### 2.1 Desktop (1280 px and wider)

```
+--------------------------------------------------------------------------------------------+
| [TCG v] CRM    Search people, conversations, records...  (Ctrl K)      Ask AI   (bell) (PS) |
+----------------+---------------------------------------------------------------------------+
| Home           |  People                                          [+ Person] [Import] [...] |
| Conversations 3|  [All people v] [Grid] [Board] [Map later]  Filter  Sort  Group: Programme  |
| People         | -------------------------------------------------------------------------- |
| Organisations  |  | Experiences and learning                                   12 people   |
| -------------- |  | [ ] Name          Stage        Programme     Owner  Last contact  Next  |
| Applications 5 |  | [ ] Asha Menon    Interested   Tribal Habitat  PS   2 days ago    Today |
| Bookings       |  | [ ] Ravi K.       Confirmed    Tribal Habitat  MS   1 week ago    -     |
| Pipeline       |  |                                       Summary: 3 Interested, 1 Confirmed |
| Members        |  | Community and support                                      8 people     |
| -------------- |  | [ ] Lena Fischer  Applied      Common Roots    PS   today         -     |
| Programmes   v |  | ...                                                                    |
|  Experiences   |                                                                            |
|  Spaces        |                                                                            |
|  Community     |                                                                            |
|  Collaboration |                                                                            |
|  Culture       |                                                                            |
| -------------- |                                                                            |
| Money          |                                                                            |
| Reports        |                                                                            |
| Settings       |                                                                            |
+----------------+---------------------------------------------------------------------------+
(fictional data)
```

- Left rail 232 px, collapsible to 56 px icons. Counts are unread or waiting-on-me only.
- **App switcher** `[TCG v]`: a menu with Workspace and CRM, each with its icon and a short description, keyboard reachable, remembers the last app per device.
- Global search covers people, organisations, conversations (subject and participants), applications, editions, and Workspace records (labelled "in Workspace").
- **Ask AI** opens the assistant panel scoped to the current screen.

### 2.2 Tablet (768 to 1279 px)

Rail collapses to icons; the record panel opens as an overlay at about 70 % width with a scrim; grids keep horizontal scroll with a pinned first column.

### 2.3 Phone (below 768 px)

Bottom bar: Home, Conversations, People, Programmes, More. Grids become **cards in groups** (title, status chip, two chosen fields, next action). The panel is a full-screen sheet with tabs as a segmented control. The composer docks above the keyboard. All commands are available; dense multi-select editing is replaced with per-card actions and a bulk-select mode.

## 3. Navigation

| Item | Opens | Notes |
|---|---|---|
| Home | My Work (`04` section 6) | Default landing |
| Conversations | Unified inbox | Named to avoid clashing with Workspace's notification Inbox |
| People | People grid | Saved views: All, Mine, New this week, Needs follow-up, Duplicates to review |
| Organisations | Organisations grid | |
| Applications | All applications grouped by programme | Saved views per programme |
| Bookings | Upcoming editions with occupancy | Opens edition screens |
| Pipeline | Opportunities grouped by pipeline | Board or grid |
| Members | Common Roots memberships and Patrons (read-only) | |
| Programmes | Five areas, each listing its programmes | Programme pages show only enabled engines |
| Money | Requests, receipts, refunds, balances | Visible only with `crm.finance.read` |
| Reports | Dashboards | |
| Settings | Programmes, channels, templates, facts, accounts and capabilities, automations, fields | Each tab is visible to holders of its capability (`crm.configure`, `crm.channels.manage`, `crm.capabilities.manage`); the owner sees all |

## 4. Design tokens

All tokens are CSS custom properties defined under `[data-app="crm"]`, so they cannot affect Workspace. Light and dark values; the CRM follows the existing theme setting (`src/core/theme.ts`), which toggles a `dark` class on the document element (`src/core/theme.ts:14-15`), so dark tokens are declared under `.dark [data-app="crm"]`.

### 4.1 Colour

| Token | Light | Dark | Use |
|---|---|---|---|
| `--crm-bg` | `#F6F5F2` | `#0F1114` | App background (warm paper, not pure white) |
| `--crm-surface` | `#FFFFFF` | `#14161A` | Grids, panels |
| `--crm-surface-2` | `#EFEDE8` | `#1C1F24` | Group headers, hover |
| `--crm-border` | `#E2DFD8` | `#2A2E35` | Hairlines |
| `--crm-text` | `#1C1F24` | `#ECEDEF` | Body (16.5:1 on white; 15.5:1 on dark surface) |
| `--crm-text-muted` | `#5B6270` | `#A3A9B3` | Secondary (6.1:1 on white; 7.7:1 on dark surface) |
| `--crm-primary` | `#1F6FA8` | `#8CC4F0` | Primary actions, focus ring base |
| `--crm-accent` | `#B4532A` | `#F0A07A` | Brand accent (clay), used sparingly |

### 4.2 Status palette

Named, not semantic, so programmes can map their own stages. In light theme the cell fill uses the light value with white text; in dark theme the cell fill uses the dark value with `#14161A` text. Ratios computed with the WCAG relative-luminance formula:

| Name | Light fill | White text ratio | Dark fill | Dark text ratio |
|---|---|---|---|---|
| clay | `#B4532A` | 4.99 | `#F0A07A` | 8.64 |
| ochre | `#8A6100` | 5.54 | `#E8C15A` | 10.53 |
| leaf | `#2F7A4B` | 5.24 | `#7FD1A0` | 9.94 |
| river | `#1F6FA8` | 5.39 | `#8CC4F0` | 9.72 |
| dusk | `#6B4FA3` | 6.42 | `#C4AEF2` | 9.21 |
| berry | `#A83A64` | 6.08 | `#F29BBE` | 8.80 |
| stone | `#5E6672` | 5.80 | `#B8C0CC` | 9.88 |
| ember | `#B42318` | 6.57 | `#FF9C8F` | 8.97 |
| teal | `#0E7C7B` | 5.01 | `#7BD8D6` | 10.90 |

All meet 4.5:1. Existing stage colours chosen in Workspace (any hex) are mapped to the nearest palette entry for CRM display and keep their exact colour in Workspace. Done-type stages add a check glyph; blocked-type stages add a bar glyph, so meaning never relies on colour alone.

### 4.3 Type, spacing, shape

- **Typeface:** Inter Variable (already a dependency, `@fontsource-variable/inter`), tabular numbers in grids and money.
- **Scale:** 12 (meta), 13 (grid cells), 14 (body), 16 (panel titles), 20 (page titles), 28 (Home greeting). Line height 1.4 for text, 1.2 for headings.
- **Spacing:** 4 px base; grid row height 36 px (compact 32, comfortable 44 for touch).
- **Radius:** 6 px controls, 10 px panels and cards, 999 px chips.
- **Elevation:** panels use a 1 px border and a soft shadow; no heavy drop shadows.
- **Motion:** 120 to 180 ms for panel and menu transitions; none when reduced motion is requested.

## 5. Core components

| Component | Behaviour |
|---|---|
| App switcher | Menu button with two items; Escape closes and returns focus |
| CRM Grid | Grouped, virtualised, editable; see section 6 |
| Status cell | Full-cell fill from the palette with text label; opens a label picker with type-ahead |
| People cell | Avatar stack for Workspace users (owner, reviewer) |
| Person chip | External person: initials on a neutral circle (never a Workspace avatar), name, endpoint icon |
| Lookup cell | Read-only value from a related record, with a small link icon; editing opens the source record |
| Window badge | WhatsApp and Meta: "Open, 6 h left", "Template needed", "Not connected" |
| Pending badge | "Request, not confirmed", "Queued", "Waiting for approval", with reason on hover or tap |
| Partial notice | "Showing 200 of more; refine the filter" or "Some records are not visible to you" |
| Timeline item | Icon by kind, actor, time, one-line summary, expandable body, source link |
| Composer | Channel picker, window badge, template picker, facts insert, attachments, AI draft, Send (capability-gated) |
| Command button | Shows the capability it needs when disabled ("You need permission to send on WhatsApp") |

## 6. CRM Grid

Built for the CRM shell over the existing saved-view configuration (`shared/views.ts`). Not added to Workspace in this initiative.

- **Groups:** group by any select, status, person, relation or date bucket; colour bar on the left edge of each group; collapse and expand; group header shows count and per-column summaries (count by label, sum and average for numbers, earliest and latest for dates).
- **Columns:** pinned first column (name), drag to reorder, resize, hide; **persisted per saved view** (new: Workspace's widths are component-local, `src/core/views/TableView.tsx:32`).
- **Editing:** click or Enter to edit a cell; Escape cancels; Tab and Shift Tab move; typing on a focused cell starts editing for text and number.
- **Keyboard navigation:** arrow keys move cell focus (roving tabindex, `role="grid"`); Space opens the record panel; Ctrl or Cmd plus Enter opens the full page; `x` toggles row selection.
- **Bulk:** select rows, then set field, assign, add to programme, propose AI triage, export.
- **Inline add:** "+ Add person" row at the bottom of each group pre-fills the group value.
- **Projection fields:** shown with a lock glyph; clicking explains where the value comes from.
- **Limits:** show the existing saved-view ceiling explicitly (5,000 evaluated records) instead of silently truncating.

## 7. Record panel (people, organisations, applications, opportunities)

```
+--------------------------------------------------------------+
| Asha Menon                                   [Open full] [x]  |
| Interested in Tribal Habitat Workshop  |  Owner: PS           |
| asha@example.org   +91 98xxxxxx12 (WhatsApp)   Kochi           |
| [Message] [Log activity] [Follow-up] [Book] [...]              |
+--------------------------------------------------------------+
| Overview | Timeline | Participation | Money | Files | AI       |
+--------------------------------------------------------------+
| Participation                                                |
|  Tribal Habitat Workshop   Interested      since 12 Nov        |
|  Common Roots              Applied         since 20 Nov        |
|  Volunteering              -                                  |
|                                                               |
| Next: Follow up about December edition dates   due today      |
|                                                               |
| Timeline (newest first)                                       |
|  WhatsApp in   "Is there space for two people?"   2 h ago     |
|  Website       Workshop application (ws)          3 days ago  |
|  Note (team)   Prefers WhatsApp; asked about terrain  PS      |
+--------------------------------------------------------------+
(fictional data)
```

- **Overview:** key fields (editable), endpoints (managed by commands), consent summary, affiliations, programmes.
- **Timeline:** filters by channel and kind; team notes are visually distinct (dotted border, "Team note" label).
- **Participation:** one row per programme involvement with stage and the action that moves it.
- **Money:** only with `crm.finance.read`; balances per currency, requests, receipts.
- **Files:** attachments from records and messages.
- **AI:** summary of the relationship, suggested next step, open questions, each with sources.
- Restricted sections (screening) appear as a locked row: "Screening: received, restricted" with no content for users without access.

## 8. Conversations

```
+----------------------+---------------------------------------+----------------------+
| Conversations        | Asha Menon   WhatsApp   Open, 21 h left | Asha Menon           |
| [Mine] [Unassigned]  |                                         | Interested: THW      |
| [All open] [Waiting] |  Asha: Is there space for two people    | Last booking: none   |
| Filter: channel v    |        on the December edition?  10:12  | Consent: WhatsApp,   |
|                      |                                         |   transactional      |
| (WA) Asha Menon  2h  |  Team note (PS): Check whether Dec is   |                      |
| (IG) @example.maker  |  confirmed before replying.             | Facts (verified):    |
|      Unmatched   5h  |                                         |  Dec dates: unknown  |
| (EM) KMEA college 1d |  [AI draft ready]                       |   (not verified)     |
| (WEB) Lena F.     1d |  +-----------------------------------+  |  Inclusions: ...     |
|                      |  | Hi Asha, thanks for asking. I'm   |  |   verified 18 Nov    |
|                      |  | checking the December dates with  |  |                      |
|                      |  | the team and will confirm today.  |  | [Book] [Log]         |
|                      |  +-----------------------------------+  |                      |
|                      |  [Template] [Facts] [Attach]  [Send v]  |                      |
+----------------------+---------------------------------------+----------------------+
(fictional data)
```

- Three panes on desktop (list, thread, context), two on tablet (context as a drawer), one on phone.
- List items show channel icon, person or handle, match state ("Unmatched", "Possible match: 2"), last message time, assignee.
- **Window badge** in the thread header; when closed, the composer switches to template mode and says why.
- **AI draft** appears as a suggestion card above the composer; inserting it puts text in the editor; the person edits and sends. Drafts that rely on a missing or stale fact say so inline ("December dates are not verified").
- **Send** is a split button: Send, Send and close, Schedule (later phase). Disabled with an explanation if the user lacks `crm.send:<channel>`, consent is withdrawn, or the provider is disconnected.
- Unmatched conversations show "Link to person" with suggestions and "Create person".

## 9. Applications

Grid grouped by stage, filtered by programme. Panel tabs: Application (answers from the source submission, read-only, with "Visitor's words" label), Review (reviewer, notes, decision with required reason), Person, Timeline. Actions: Request info (drafts a message), Move stage, Decide (respects review gate), Convert.

## 10. Bookings and editions

### Edition screen

```
Tribal Habitat Workshop  >  December edition (fictional)          [Edit edition] [...]
Dates: 4-6 Feb (fictional)   Place: Dhaanyam   State: Open
Seats  [##########------]  10 confirmed  |  2 held (1 expires in 3 h)  |  capacity 16
Waitlist: 0     Screening: required     Hold: 24 h (programme setting)

| Booking         | Booker        | Seats | State             | Paid           | Screening      |
| BK-1042         | Ravi K.       | 2     | Confirmed         | Paid           | Cleared        |
| BK-1043         | Asha Menon    | 2     | Held (3 h left)   | Request issued | Received       |
| BK-1044         | Lena F.       | 1     | Request, not conf.| -              | Not requested  |
[+ Booking request]
(fictional data)
```

- The seat bar shows confirmed, held and free, with text, not only colour.
- "Paid" comes from the ledger; "Screening" shows state only; content needs restricted access.
- Booking panel: participants (named or placeholder), hold timer, payment requests and receipts, messages about this booking, attendance per day.
- **Confirm** is a deliberate action with a summary dialog: who, seats, price option, payment state, screening state. If confirming before payment, the dialog states the programme rule.
- Concurrent conflicts show a clear message: "Only 1 seat left. Reduce seats or add to waitlist."

## 11. Money

Visible with `crm.finance.read`. Views: Outstanding requests, Recent receipts, Refunds awaiting approval, Reconciliation (phase 2). Amounts right-aligned with tabular numbers and currency codes. Recording a receipt requires evidence (provider event, proof file or bank reference) and shows the resulting balance before saving. Reversals are a separate action with a reason; nothing is edited in place.

## 12. Reports and dashboards

Reuse Workspace dashboard and metric blocks inside CRM pages, plus a new **Stage battery** widget (stage distribution as a segmented bar with labels and counts). Every number links to the filtered grid. Partial and permission-limited states are shown on the widget.

## 13. Settings

- **Programmes:** list of 14; each opens its profile editor (engines, forms, stages, review gate, booking defaults, response target, restricted fields).
- **Channels:** connect and disconnect, health, last inbound and outbound, templates and their approval state.
- **Facts:** per programme and edition, with state, verified date, review-by date; stale facts highlighted.
- **Accounts and capabilities:** specified in section 13.1 (S0).
- **Automations:** CRM recipes in sentence form ("When a conversation is unanswered for 2 days, notify the owner"); built on the Workspace automation engine.
- **Fields and views:** CRM databases' fields, with protected projection fields listed separately. Field help text warns that ordinary fields are visible to every signed-in account while Workspace permissions are off (A-19), and points to restricted sections for screening, health and payment evidence.

### 13.1 Accounts and capabilities (S0; A-20, A-21)

Route `/crm/settings/access`. Visible to the owner and to admins holding `crm.capabilities.manage`; everyone else gets the Access denied state naming the owner as the person who can grant access. Two tabs.

**Accounts tab** (owner and admins; uses existing Workspace routes, `07` section 3)

```
+------------------------------------------------------------------------------------+
| Settings > Accounts and capabilities          [Accounts] [Capabilities] [History]  |
| 5 of 7 places in use (guests included)                         [Create invite]     |
| ---------------------------------------------------------------------------------- |
| Name              Username   Role      CRM access   Status    Actions              |
| Pia Sol (you)     pia        Owner     All (owner)  Active    -                    |
| Arun V.           arun       Admin     6 of 13      Active    [Role v] [Disable]   |
| Meera K.          meera      Member    None         Active    [Role v] [Disable]   |
| Guest: Tom R.     tomr       Guest     Not eligible Active    Managed in Spaces    |
| Unused invite     K7Q-...    -         -            Unused    [Copy] [Delete]      |
+------------------------------------------------------------------------------------+
(fictional data)
```

- The seat line reads `seatsTotal` and the active count from `GET /api/users`; when all seven places are used, "Create invite" is disabled with the reason.
- Name is shown as each person set it (A-20). The owner sees a Rename action from S1 (new endpoint); before S1 the column is read-only with "People set their own name in Settings".
- The owner row has no actions for anyone (A-23). Hiding them is presentation only: the server refuses with `owner_protected` (`07` section 3), and the UI maps that response to "The owner account can only be changed by the owner." if a stale screen sends one.
- Role menu offers Admin and Member only (the existing route refuses others); guests show "Managed in Spaces".
- Every action uses a confirmation dialog for Disable and Remove, shows the result in a live region, and refreshes the list. A 409 (`account_or_authority_changed`) shows "Someone changed this account. The list has been refreshed."

**Capabilities tab** (owner, and admins holding `crm.capabilities.manage`)

```
+------------------------------------------------------------------------------------+
| Account: [Arun V. v]                                   Effective: 6 capabilities   |
| ---------------------------------------------------------------------------------- |
| Capability                  Scope                 Held       Granted by / when     |
| Open the CRM                All                   [x]        Pia, 2 Dec            |
| Send email                  All                   [x]        Pia, 2 Dec            |
| Send WhatsApp               All                   [ ]                              |
| Send Instagram              All                   [ ]                              |
| Send Facebook               All                   [ ]                              |
| Read restricted notes       All                   [x]        Pia, 3 Dec            |
| See money                   All                   [ ]                              |
| Record payments             All                   [ ]                              |
| Approve refunds             All                   [ ]                              |
| Configure                   All                   [x]        Pia, 2 Dec            |
| Merge people                All                   [ ]                              |
| Connect channels            All                   [ ]                              |
| Manage capabilities         All                   [x] (owner only can change)      |
+------------------------------------------------------------------------------------+
(fictional data)
```

- S0 grants are scope "All" only (`contracts/crm-s0-v1.md`, SC-2 rule 7). Programme-scoped rows and an "Add programme scope" control arrive with the programme registry in S2.
- Each row is a labelled switch (`role="switch"`, name = capability label plus scope). Toggling sends `capability.grant` or `capability.revoke` with a fresh `requestId`; the switch shows a pending state until the server replies and reverts with the error text on failure. No optimistic success.
- The owner's own row reads "All capabilities (owner)" with no switches (`owner_implicit`).
- Guests: "Guests cannot hold CRM capabilities." Members: every row except "Manage capabilities", which shows "Admins only".
- Admins with manage rights cannot change their own row and cannot change "Manage capabilities" for anyone; the disabled control states why.
- Offline: switches are disabled with "Capability changes need a connection" (capability changes are never queued as intents).
- A short description under each capability says what it unlocks and, for "Read restricted notes" and "See money", that holders will see sensitive data.

**History tab**: the append-only audit list (`GET /api/crm/read/capability-audit`): time, actor, target, action, capability, scope, reason. Keyset "Load older". Read-only; no export in S0.

Layouts: desktop as drawn; tablet keeps the table with horizontal scroll and a pinned name column; phone shows one card per account (name, role, status, CRM access summary) and opens the capability list as a full-screen sheet with the same switches. Keyboard: tabs are an ARIA tablist; the account picker is a combobox; every switch is reachable by Tab and toggled with Space.

## 14. Contextual AI

- **Ask bar** on Home and a panel on every screen; context is the current screen and selection.
- Answers cite records and facts as links; uncertain answers say so.
- Proposals appear as previews with Apply and Discard; applying uses the existing approval path.
- The assistant never shows a Send, Confirm or Record button inside its own panel; it links to the human action.

## 15. States

| State | Treatment |
|---|---|
| Empty | One sentence on what belongs here and one primary action (for example "No conversations yet. Connect a channel" for admins, "No conversations yet" for others) |
| Loading | Skeleton rows matching the layout; no spinners longer than 300 ms without a skeleton |
| Error | What failed, whether data is safe, and a retry; never raw error text |
| Offline | Top banner "Offline: edits will sync; bookings, payments and messages will wait"; pending badges on affected items |
| Access denied | "You don't have access to this" with who can grant it; no hints about the hidden content |
| Partial | Partial notice with reason |
| Pending | Pending badge with reason and time |
| Stale fact | Amber fact chip "Not verified since 18 Nov" |

## 16. Keyboard map (desktop)

| Keys | Action |
|---|---|
| Ctrl or Cmd K | Search |
| Ctrl or Cmd J | Ask AI |
| G then H, C, P, O, A, B | Go to Home, Conversations, People, Organisations, Applications, Bookings |
| Arrows | Move in grid |
| Enter / Escape | Edit / cancel |
| Space | Open panel |
| R | Reply (in a conversation) |
| N | New note (in a conversation) |
| E | Close conversation |
| ? | Shortcut sheet |

All shortcuts avoid single letters while focus is in a text field.

## 17. Accessibility

WCAG 2.2 AA is a permanent requirement in this repository (`AGENTS.md`). Specifically: grid follows the ARIA grid pattern; every status has text; focus is always visible (2 px ring using `--crm-primary`); panels trap focus and return it on close; live regions announce queued, sent and failed messages; touch targets at least 44 by 44 px on touch layouts; reduced motion respected; axe checks in CI for each CRM screen (the repo already uses `@axe-core/playwright`).

## 18. Isolation from Workspace

- CRM styles exist only under `[data-app="crm"]`; no global CSS changes.
- No Workspace component is restyled; shared primitives are imported and wrapped.
- Regression gate: screenshot comparison of key Workspace screens before and after each CRM slice, compact, tablet and desktop, light and dark. The existing UX lab (`npm run qa:ux`, `scripts/ux-lab/playwright.config.mjs`) already runs 18 projects (Chromium, Firefox, WebKit × 390×844, 820×1180, 1440×900 × light, dark) with `toHaveScreenshot` at `maxDiffPixels: 0`; `S0-PLAN.md` section 9 says how it is used.
- The app switcher is the one intended Workspace change. It renders only when the Worker variable `CRM_ENABLED` is on and the account holds `crm.access` (P-24), so a Workspace-only account sees no change at all.

## 19. Visual prototype

A separate static prototype (fictional data, no backend) can be produced for review before implementation. It is not production code and should not be merged.
