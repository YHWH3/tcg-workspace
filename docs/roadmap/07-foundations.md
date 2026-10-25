# Phase 7 — Foundations

Branch `sol/p7-foundations` stacked on `sol/r1-date-window`. Everything later
depends on these items. Implement in order.

---

## 7.0 Certification harness covers new phases (N10)

- In `scripts/certify-phase4.mjs:118`, extend the d1 file regex from
  `(?:phase[456]|audit|assistant)-.*-d1\.test\.ts$` to
  `(?:phase(?:[4-9]|1[0-3])|audit|assistant)-.*-d1\.test\.ts$`.
- Add a harness self-test asserting that a `phase7-x-d1.test.ts` fixture name is
  collected.
- Convention from now on: D1 tests are named `phase<N>-<topic>-d1.test.ts`, and
  pure tests `phase<N>-<topic>.test.ts` or `<topic>.test.ts`.
- **Acceptance:** the harness gate passes and lists the new d1 files.

---

## 7.1 Date filters done properly (N03, builds on R1)

**Goal:** people can pick "next 30 days" or "older than 7 days" without typing
syntax, and created-date filters work.

**Design**
- **`createdAt` (N03).**
  - In `fieldValue` (`shared/views.ts`), when the key is `createdAt` and the
    filter op is temporal, compare by converting the record's millisecond value
    to a date-only string in the context's timezone (7.2 supplies it; until then
    use UTC).
  - Add `toDateOnlyInZone(ms, timeZone)` to `shared/dates.ts` using
    `Intl.DateTimeFormat('en-CA', {timeZone})`.
  - Sorting by `createdAt` stays numeric.
- **Relative-window operator.** Add `FilterOp` `'within'` with value
  `{from: RelDate, to: RelDate}`, where `RelDate = 'today' | 'today±N' | 'yyyy-mm-dd'`.
  - It is inclusive on both ends and expresses windows in one filter:
    next 30 days = `{from:'today', to:'today+30'}`; older than 7 days =
    `{from:'2000-01-01', to:'today-8'}`.
  - The existing two-filter form keeps working.
  - `evalFilter` resolves both ends with `resolveRelativeDate`.
  - Validation rejects from > to after resolution only when both are absolute.
- **Filter editor UI** (`FilterRow`, `src/core/views/DatabasePage.tsx:582`).
  - For date keys (built-in `dueDate`, `createdAt`, and custom `date` fields),
    render a date control:
    - a native `<input type="date">` for absolute values;
    - a "Relative" toggle exposing a select (Today, Tomorrow, In N days, N days
      ago) plus a number input;
    - presets for `within`: Next 7 days, Next 30 days, Last 7 days,
      Last 30 days, Overdue (`before today`).
  - Keyboard and touch operable, with labels via `aria-label` and
    `aria-describedby`. On compact width, stack the controls vertically.
- **Automation editor.** Use the same control in `src/modules/automations/index.tsx`.
- **MCP.**
  - `add_view`, `update_view` and `query_records` accept `within` and relative
    values. Update their zod schemas and validation messages.
  - Update the server instructions text to document `today±N` and `within`.

**Files:** `shared/dates.ts`, `shared/views.ts`, `shared/automations.ts`,
`src/core/views/DatabasePage.tsx`, `src/modules/automations/index.tsx`,
`worker/mcp.ts` (view schemas, `query_records`), `worker/mcpReadTools.ts`
(if it validates filters).

**Tests**
- Unit: `within` across boundaries, created-date filtering with a timezone,
  backward compatibility of the old filter shape, and validation.
- Browser: create a "Next 30 days" view by keyboard only and by touch at
  compact width in WebKit; axe clean.
- UX lab: new cells for the date filter control.

**Acceptance**
- The pack's three "Deadlines in the next 30 days" metrics can be expressed with
  one `within` filter.
- Created-date filters work.
- MCP and the app return identical ids.

---

## 7.2 Workspace locale: one "today", one currency rule (N02, N04)

**Goal:** the whole system agrees on what "today" is, and money is shown in the
right currency without mixing currencies.

### Data (migration, next number)

```sql
CREATE TABLE IF NOT EXISTS workspace_settings (
  id TEXT PRIMARY KEY CHECK (id = 'workspace'),
  time_zone TEXT NOT NULL DEFAULT 'UTC',
  currency TEXT NOT NULL DEFAULT 'INR',
  week_start INTEGER NOT NULL DEFAULT 1 CHECK (week_start BETWEEN 0 AND 6),
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO workspace_settings(id, time_zone, currency, week_start, updated_at)
VALUES ('workspace', 'UTC', 'INR', 1, 0);
```

- The default `time_zone` stays `UTC`, so behaviour is unchanged until an admin
  sets it. Owner decision D2 selects `Asia/Kolkata` and `INR`; expose these
  selections without modifying a real workspace during local certification.
- This is a server-only table; add it to the AGENTS.md list.

### Server

- New `worker/workspaceSettings.ts`:
  - `GET /api/workspace/settings` for any authenticated user (read-only).
  - `PUT /api/workspace/settings` for admins only.
  - Validate `time_zone` with
    `Intl.supportedValuesOf('timeZone').includes(tz)` (fallback: try
    `new Intl.DateTimeFormat('en', {timeZone})`).
  - `currency` must be a 3-letter ISO 4217 code accepted by
    `Intl.NumberFormat`; `week_start` must be 0–6.
  - Use an optimistic `version` check: 409 on mismatch.
  - Log to `access_audit` with action `workspace_settings.update`.
- `shared/dates.ts`: add `workspaceToday(now: number, timeZone: string): string`.
- Replace every server "today" computation with one helper,
  `serverToday(env, now)`. It reads `workspace_settings` once per request or
  cron phase and is cached on the per-request context (no module state). Call
  sites:
  - `worker/mcpReadTools.ts:78,84`;
  - `worker/aiDigest.ts:13`;
  - `worker/reminders.ts` (`todayUtc()` in `runScheduled` and `runDueReminders`);
  - `worker/automations.ts:696` and `runDateOffsetAutomations`;
  - `worker/forms.ts:327` (day bucketing; verify intent before changing);
  - `worker/notifications.ts` `reminderKind`.
- **Behaviour change warning.** With a non-UTC zone, reminders and date-offset
  automations fire on the workspace's local day. Add D1 tests in
  `tests/phase7-locale-d1.test.ts` proving:
  - UTC default = existing behaviour (rerun the existing reminder and date-offset
    assertions under explicit UTC);
  - Asia/Kolkata at 2026-10-24T20:00Z treats "today" as 2026-10-25;
  - no reminder is sent twice across the change (`reminder_sent` dedupe still
    holds when the day boundary shifts);
  - binding-call cost is unchanged (one extra SELECT per phase at most).

### Client

- Fetch settings at app start and on the `changed` live poke.
- Cache them in Dexie `meta` under key `workspaceSettings` (no Dexie version
  bump: `meta` is a key-value table keyed by `key`, `src/core/db.ts:81`).
- `todayISO()` (`src/core/utils.ts:39`) becomes `workspaceToday(Date.now(), tz)`
  with tz from the cached settings, falling back to the device zone only before
  the first fetch. Show an "Offline: using this device's date" hint in
  date-sensitive dashboards when settings were never fetched.
- Calendar and timeline week start come from `week_start` where they currently
  default to Monday (`shared/dates.ts` `startOfWeek`, `monthGrid` callers).

### Currency

- Additive `FieldDef` options in `shared/fields.ts` for `number` fields:
  `format?: 'plain' | 'currency' | 'percent'` and `currency?: string`
  (ISO code). The field editor (`FieldsEditor.tsx`) exposes them.
- Formatting helper `formatNumber(value, def, workspaceCurrency)` in
  `shared/fields.ts`, used by:
  - `formatFieldValue`;
  - table cells (`src/core/views/cells.tsx`);
  - `MetricBlock` (replace the hard-coded `usd` at `MetricBlock.tsx:30`);
  - MCP outputs that format money.
- **Rule: never relabel.**
  - Fields with no `currency` display in the workspace currency, and the UI
    labels which currency is assumed ("₹, workspace default").
  - A Metric `sum`/`avg` over a currency field uses that field's currency.
  - The Metric "Currency" format option becomes "Currency (field or workspace)".
  - One field means one currency, so sums are always homogeneous. Records with
    different currencies need separate fields or databases.
  - No exchange conversion.
- **Pack update** (shipped through 7.4): set `format:'currency'` (no explicit
  code, so the workspace currency applies) on Budget (projects, events), Amount
  (opportunities, transactions), Revenue (events), Price and Cost (products).
  Margin (N05) is handled in 8.5.

### Settings UI

- A new Settings section "Workspace" (admins edit; members see read-only):
  timezone (searchable select), currency (select of common codes plus free ISO
  entry with validation), week start.
- Show the effect: "Today in this workspace is Saturday 25 October 2026".

### MCP

- `workspace_overview` includes `{timeZone, currency, today}`.
- No write tool; settings are human-only.

### Tests

- Unit: `workspaceToday` across zones and DST zones (e.g. America/New_York);
  currency formatting; the never-relabel rule.
- D1: as listed above, plus the settings API (auth, admin-only PUT, 409, audit).
- Browser: Settings → Workspace on three engines; a Metric shows ₹.

### Acceptance

- At 01:00 IST, app, MCP and digest all say the same "today".
- No dashboard shows "$" unless a field says USD.

---

## 7.3 Account disable (N06)

**Goal:** an admin can immediately cut someone off without deleting their
history. Owner decision D3 frees its place while disabled; restoring access
requires a free place under the seven-active-account limit.

### Server (no migration; `users.disabled_at` exists from 0012)

- `POST /api/users/:id/disable` and `POST /api/users/:id/enable` in
  `worker/admin.ts`, `requireAdmin`.
- **Disable**, in one `db.batch` with the admin session fence (`adminSessionFence`):
  - `UPDATE users SET disabled_at=? WHERE id=? AND disabled_at IS NULL`;
  - `DELETE FROM sessions WHERE user_id=?`;
  - an `access_audit` row (`action:'user.disable'`, before/after JSON).
  - After the batch: `revokeAllGrants(env, id)` (`worker/ratelimit.ts:79`).
- **Guards:**
  - cannot disable yourself;
  - cannot disable the last enabled owner or admin, counted on
    `COALESCE(workspace_role, role)` with `disabled_at IS NULL`;
  - idempotent (200 with `{ok:true, already:true}`).
- **Enable:** clears `disabled_at` and audits. It does not restore grants or
  sessions; the user signs in again and reauthorizes connectors.
- **Effects already implemented** (verify each with a test, do not re-implement):
  - sync refuses (`spaceFeed.ts:66`);
  - capabilities are 0 (`capability.ts:39`);
  - MCP refuses per request;
  - the live socket sweep closes sockets;
  - pending guest invites the user issued become unredeemable, because the
    issuer must hold admin capability at redemption (`guestInvites.ts:4`).
- **Seat cap (owner D3):** disabled accounts do not count toward the seven
  active accounts. Signup (including guest redemption) and restoration must
  enforce the active limit atomically. Restoring a disabled account when all
  seven places are occupied returns a recoverable capacity error. Removing via
  `DELETE` frees a place as today. Bootstrap remains based on zero total users,
  never zero active users. Preserve disabled users and their history.
- **Fix the last-admin checks** in `PATCH /users/:id` and `DELETE /users/:id`
  to use `COALESCE(workspace_role, role)` and ignore disabled admins. Add
  regression tests.
- **Login and sessions: already implemented.** The login query excludes
  disabled users (`worker/auth.ts:331`), so a disabled user gets the generic
  failure; `userByToken` excludes them too (`auth.ts:163`). Add regression tests
  only; do not change the behaviour.

### Client

- Settings → Admin users list:
  - a "Disabled" badge;
  - a "Disable access" / "Restore access" action with a confirmation dialog
    explaining the effects (signed out everywhere, AI connectors revoked, seat
    freed while disabled, restore needs a free place, history kept);
  - keyboard accessible.
- People pickers and mentions show disabled users greyed out with "(disabled)"
  and exclude them from new assignments. Existing assignments remain.

### MCP

- No tool (human-only). Read tools that list users include `disabled: true`.

### Tests

- `tests/phase7-disable-d1.test.ts` (enabled and disabled permission modes):
  sessions gone, grants revoked (mock the OAuth provider), sync 401, MCP 401,
  capability 0, last-admin protection, audit row, enable path, seat count, and
  login refusal. Binding cost ≤45.
- Browser: an admin disables a member; the member's other tab is signed out on
  the next request; three engines.

---

## 7.4 Operating-pack upgrades for existing installs (N08)

**Goal:** improvements to `templates/tcg-pack.json` (new views, fields, blocks,
formats) reach workspaces that installed the pack earlier, without overwriting
anything people changed.

### Design

- **Provenance (additive record keys, no migration):**
  - boards already carry `templateDbKey` and `templateKey` (`shared/bundled.ts`
    `findReusableBoards`);
  - add `templateItemKey` to views, pages and dashboard blocks created by an
    install, from now on. The authored pack gets stable `key` values for
    every view, page and block.
  - Fallback matching for pre-key installs: view = (databaseId, name);
    page = (title, parent chain under the pack root); block = (page, type,
    label). **Verify** the planner's id remapping and record the rule.
- **Pure planner** `planPackUpgrade(bundle, existing): UpgradePlan` in
  `shared/bundled.ts`. It returns additive operations only:
  - add missing fields to a matched board;
  - add missing views and select options;
  - add missing pages and blocks;
  - set field `format` / `currency` only when the existing field has none.
- **Never:** rename, delete, reorder user content, change stage columns,
  overwrite a user-edited filter or label, or touch records.
- Each operation carries a human-readable reason.
- **Apply.**
  - Client: Settings → Template gallery shows "Update available (N changes)" →
    preview sheet listing every change → Apply runs the writes via `mutate()`.
  - MCP: extend `install_template` with `mode:'upgrade'` (dry-run preview
    first). It is significant, so it goes through a frozen preview and human
    approval. Classify it unchanged in `aiCapabilities.ts`; update the
    significance rule.
- **Versioning.** The pack gets `version` (integer). Each installed root page
  stores `templateVersion`; the upgrade sets it.

### Tests

- Unit: the planner on a fixture install with user edits (renamed view, changed
  filter, deleted block) produces no destructive or overwrite operation and
  adds only missing items; idempotent second run = empty plan.
- D1/MCP: upgrade dry run = apply result.
- Browser: preview and apply on three engines.

### Acceptance

- An install from before 7.2 gains currency formats.
- An install from before Phase 8 gains the new desk pages when they ship.
