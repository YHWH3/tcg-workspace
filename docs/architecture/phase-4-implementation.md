# Phase 4 implementation — Operating rhythm

Detailed engineering contract for `phase-4-rhythm.md`. Authoritative for Phase 4 code; resolves every §0–§16 requirement of the dispatch brief against the merged Phase 0–3 implementation.

## 0. Design decisions (material, resolved up front)

1. **Server-controlled storage.** Notifications, approvals, automation runs, form tokens, form submissions, reminder dedupe, the date index and the event outbox are **dedicated D1 tables, never synced `records` collections**. Two reasons, both required by the brief:
   - *Privacy:* `/api/sync/pull` is workspace-wide; a generic `notifications` collection would leak every member's Inbox to all members. Notification contents live in D1 rows read only through authenticated recipient-scoped endpoints.
   - *No sync bypass:* nothing in `shared/collections.ts` grants these entities a client write path. `mutate()` can never mark another user's notification read, self-issue an approval, or edit automation execution state. Generic sync cannot carry them, by construction.
2. **Synced config collections.** `automations` and `forms` **are** generic synced collections (member-editable configuration). They are *configuration, not authority*: every execution re-validates targets, recipients, fields and relations server-side. An automation config cannot authorize anything a member could not already do, and writes produced by automations pass the same approval-gate guard as every other write.
3. **One emission point.** `applyChanges()` gains `opts.event` (source, ctx, changesetId). Every successful write pathway — `/api/sync/push`, MCP `write()`, form submissions, automation action batches, changeset undo — emits through it. No caller may emit ad-hoc record events.
4. **Durable event outbox, no Queue.** The outbox row is appended **to the same `db.batch()` that commits the record writes** (atomic, `INSERT OR IGNORE` on a deterministic id). `ctx.waitUntil` then processes it; the cron `scheduled()` sweeps `processed_at IS NULL` rows, so a killed isolate loses nothing. waitUntil alone is not adequate (isolate kill drops it) — D1 outbox is the lightweight durable mechanism the spec asks us to justify or skip. Cloudflare Queues are not introduced.
5. **Approvals are D1 + authenticated endpoints.** Approvals are not records; undo/changeset integration therefore covers the *record writes* an approval request/decision triggers (none by default — decisions only mint events + notifications). Idempotency is a `request_key` UNIQUE column.
6. **Gate enforcement inside `applyChanges()`.** `guardStageWrites()` runs after mutation validation and before planning, on every pathway. Rejections surface as normal `rejectedItems` (reason `approval_required`) — the client outbox already renders refused entries honestly; MCP `write()` maps them to a §4.3-style error.
7. **Recurrence is a builtin field.** `recurrence?: {freq, interval, byWeekday?, until?}` on `tasks` rows (rendered by a `recurrence` FieldDef type). Next occurrences spawn with a deterministic id `rec_<srcId>_<nextDate>` — replay/concurrent completion collapses onto one row.
8. **People dedupe is opt-in per form.** `forms.peopleMatch?: {emailField}` — only forms configured for it touch People rows, and nothing about a match is disclosed to the public caller.
9. **Turnstile test-key mode is local-only.** `env.TURNSTILE_SECRET` unset ⇒ documented test mode (token `pass` accepted, `fail` rejected) with a loud log. Production sets the real secret via Wrangler secrets; siteverify is always called when a real secret is present.
10. **TCG upgrade = existing reconcile install.** Phase 4 rows are authored into `templates/tcg-pack.json` under new `automations`/`forms` snapshot keys; `instantiateTemplate`'s `stableIds` reconcile (R1d) already applies only absent plan ids — no new upgrade machinery, no overwrite regression. Starter automations ship `enabled: true`; users may disable.

## 1. Migration `0007_phase4.sql`

```sql
ALTER TABLE users ADD COLUMN prefs TEXT;                       -- JSON, NULL = defaults

CREATE TABLE notifications (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,
  actor_id TEXT, target_type TEXT, target_id TEXT,
  title TEXT NOT NULL, body TEXT, url TEXT,
  group_key TEXT, group_count INTEGER NOT NULL DEFAULT 1,
  items TEXT,                                                 -- JSON array ≤20 {actorId, at, summary}
  read_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX idx_notif_user ON notifications(user_id, read_at, created_at DESC);
CREATE INDEX idx_notif_group ON notifications(user_id, group_key, read_at);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
  stage_id TEXT,                                             -- gate request: required stage
  requested_by TEXT NOT NULL, approver_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','cancelled')),
  note TEXT, decided_note TEXT,
  request_key TEXT UNIQUE,                                  -- idempotency
  decided_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX idx_approval_target ON approvals(target_type, target_id);
CREATE INDEX idx_approval_approver ON approvals(approver_id, status);

CREATE TABLE form_tokens (
  token TEXT PRIMARY KEY, form_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE form_submissions (
  submission_id TEXT PRIMARY KEY, form_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('rejected','processing','accepted')),
  receipt TEXT, record_id TEXT, error TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE rate_limits (
  bucket TEXT NOT NULL, key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0, reset_at INTEGER NOT NULL,
  PRIMARY KEY (bucket, key)
);

CREATE TABLE date_index (
  record_id TEXT NOT NULL, field_key TEXT NOT NULL, date TEXT NOT NULL,
  PRIMARY KEY (record_id, field_key, date)
);
CREATE INDEX idx_date_date ON date_index(date);

CREATE TABLE reminder_sent (
  record_id TEXT NOT NULL, field_key TEXT NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (record_id, field_key, date, kind)
);

CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, event_key TEXT UNIQUE NOT NULL,
  changeset_id TEXT, status TEXT NOT NULL CHECK(status IN ('ok','failed')),
  error TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX idx_runs_auto ON automation_runs(automation_id, created_at DESC);

CREATE TABLE event_outbox (
  id TEXT PRIMARY KEY, payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  created_at INTEGER NOT NULL, processed_at INTEGER
);
CREATE INDEX idx_outbox_pending ON event_outbox(processed_at);
```

New synced collections appended to `COLLECTIONS` (`shared/collections.ts`): `'automations'`, `'forms'`. Dexie `db.ts` bumps version with the two new tables only (no `inbox` table — Inbox data is REST-fetched, React-cached).

## 2. Event pipeline — `worker/events.ts`, `shared/events.ts`

```ts
// shared/events.ts — pure
export interface SemanticEvent {
  kind: 'record.created'|'record.stage_changed'|'record.field_changed'|'record.assigned'
       |'comment.created'|'mention.created'|'form.submitted';
  recordId: string; collection: string; boardId?: string;
  fieldId?: string; from?: unknown; to?: unknown; actorId?: string; formId?: string;
}
export function deriveEvents(applied: AppliedChange[]): SemanticEvent[];
```

Derivation rules (per `AppliedChange {id, collection, created, fields, before, after}`):
- `created === true` on `tasks` → `record.created`; on `comments` → `comment.created`; on `boards`/`pages` → none (v1 scope: record/task lifecycle + comments + mentions + forms).
- `status` ∈ `fields` on `tasks` → `record.stage_changed {from: before.status, to: after.status}`; `stage → done` (target = board's last column) additionally drives recurrence.
- `assignee` delta → `record.assigned {to}`.
- Any `p_*`/builtin field delta → `record.field_changed` (one per changed key, capped 20/record).
- `@[user:<id>]` tokens newly present in committed `blocks.text` or `comments.body` → `mention.created` per user.
- `form.submitted` is minted by the form path directly (a synthetic `AppliedChange`-free event), not derived.

```ts
// worker/events.ts
export function emitChanges(env, ctx, ev: {
  source: 'client'|'mcp'|'automation'|'form'|'undo';
  userId: string; applied: AppliedChange[]; changesetId?: string;
}): void   // inserts outbox row (id = 'ev_'+fnv(source+changesetId|firstAppliedIds)) then ctx.waitUntil(processOutbox(env, id))
export async function processOutbox(env, outboxId): Promise<void>
```

`processOutbox`: `deriveEvents` → for each, in order:
1. `maintainDateIndex(env, applied)` — resync that record's `date_index` rows (all date-valued builtins + date-typed `p_*` fields from its board's FieldDefs; drop all rows on `deleted:true`/`archived:true`).
2. `notificationsForEvent(env, semantic, ev)` → writes `notifications` rows honoring prefs + grouping.
3. If `ev.source !== 'automation'` → `runAutomationsForEvent(env, semantic, ev)` (loop guard, depth 1).
4. `reminders` need no per-event action (cron scans `date_index`).
5. `pokeLive` so open clients refetch Inbox badge.
`attempts++` + `last_error` on failure; leave `processed_at` NULL → cron sweeps. Mark `processed_at` on success.

`applyChanges` signature: `opts.event?: {source, ctx, changesetId?}`. Inside `flushPlans`, the outbox `INSERT OR IGNORE` statement is appended to each commit `db.batch()` (atomic with the writes). `ctx.waitUntil(processOutbox)` is called from `applyChanges` post-commit. Call sites pass `event: {source: 'client'|'mcp'|..., ctx: c.executionCtx}`: `/api/sync/push` → `'client'`; MCP `write()` → `'mcp'`; forms → `'form'`; automation engine → `'automation'`; `POST /api/changes/:id/undo` → `'undo'`; `casUpdate`/`remotefile`/seedRecord paths that already call applyChanges get `'mcp'` where MCP-driven, else none (no emit).

## 3. Approval gates — inside `applyChanges`

After `validChange` filtering, `await guardStageWrites(env, incoming, reject)` (`worker/approvals.ts`):
- Only `tasks` writes whose patch contains `status`. Load the record's board row → `board.approvalGate` (boards field, see §6) → if `patch.status === gate.stageId`:
  - Require a row `approvals{target_type:'record', target_id:<id>, stage_id:<gate.stageId>, status:'approved'}`; if `gate.approverField` set, additionally require `approval.approver_id === record.p_<approverField>` (staleness = changed field value ⇒ rejected).
  - Else `reject(id,'tasks','approval_required')`.
- `boards` writes may set/clear `approvalGate` freely (member config).
- Batched links/undo: gate runs identically — an undo restoring a gated status also needs the approval.

MCP tools (`worker/mcpApprovals.ts`, registered inside `createWorkspaceServer`): `request_approval{targetType,targetId,approverId,note?,stageId?,requestId?,dryRun?}`, `list_approvals{mine?|targetId?|status?}`, `decide_approval{approvalId,decision:'approved'|'rejected',note?,expectedRev?}` — decide validates `approver_id === userId` + `status==='pending'` in one CAS UPDATE (replay-safe); mints `approval_decided` notification to requester; `request_approval` mints `approval_requested` to approver. `request_key` default = caller `requestId` else `fnv(payload)` — INSERT OR IGNORE returns existing on retry.

UI (`src/modules/approvals/`): record/page ⋯ menu → "Request approval" (approver picker + note); approvals section in record detail (pending badge, history list, Approve/Reject/Cancel); gated-stage attempt shows the `approval_required` state + "Request approval" affordance.

## 4. Notifications — `worker/notifications.ts`, `src/modules/inbox/`

Kinds: `mention, assigned, comment_on_mine, due_soon, overdue, approval_requested, approval_decided, form_submission, automation`.

`notify(env, {userId, kind, actorId, targetType, targetId, title, body?, url, groupKey?})`:
- Load `users.prefs` → per-kind `inbox|off` (defaults: all on; `form_submission` only for `notifyUserIds` recipients — enforced by caller, not pref).
- Grouping: same `(user_id, group_key)` unread row with `created_at > now-30min` → `UPDATE group_count++, title/body refreshed, items JSON append (cap 20), created_at=now`; else INSERT.
- Notification routing per event kind: `assigned`→new assignee; `comment_on_mine`→record assignee else record creator (`updated_by` of earliest seq? use `assignee` then skip — documented); `mention`→mentioned users; `due_soon`/`overdue`→assignee else owner-field (`p_*` user field named owner/lead) else skip; `approval_requested`→approver; `approval_decided`→requester; `form_submission`→form.notifyUserIds; `automation`→action's notify targets.
- Client never sees another user's rows: `GET /api/notifications` is `WHERE user_id = <session.user>`.

Endpoints (`worker/notifications.ts`, `requireAuth`): `GET /api/notifications?limit&before`, `GET /api/notifications/badge` (`{unread}`), `POST /api/notifications/:id/read` (404 unless `user_id=me`), `POST /api/notifications/read-all`. `PATCH /api/me {prefs}` merges prefs JSON (auth.ts owns the route; B implements the prefs shape + validation there).

UI: `src/modules/inbox/` AppModule — nav item with unread badge (refetch on mount + `changed` poke), Inbox page: unread section + read section, grouped rows (`(N)` badge expands `items`), mark-read buttons + "Mark all", deep links (`url` field → record/page), empty/error states, 320px-safe. Prefs section in Settings → per-kind selects + quiet-digest toggle (read-state/prefs are server-only writes — offline shows disabled with "needs connection" hint).

## 5. Reminders & recurrence — `worker/reminders.ts`, `shared/recurrence.ts`

`wrangler.jsonc`: `"triggers": { "crons": ["*/15 * * * *"] }`. `worker/index.ts` default export gains `scheduled(_event, env, ctx) { ctx.waitUntil(runScheduled(env)) }` alongside `fetch`. Local testing: `wrangler dev --test-scheduled` + `curl http://localhost:8788/cdn-cgi/handler/scheduled` (verify script uses this).

`runScheduled(env)`:
1. Outbox sweep: unprocessed rows older than 60s → `processOutbox` (cap 20/run, attempts≤5 then `processed_at=now` + `last_error` — a poisoned event can't loop forever; visible via run logs/manual inspection).
2. Due soon: `SELECT * FROM date_index WHERE date <= today+lead AND date >= today AND date NOT NULL`, lead = board `reminderLeadDays` (boards field, default 1). `INSERT OR IGNORE INTO reminder_sent` → affected==0 ⇒ skip; else `notify kind='due_soon'`.
3. Overdue: `date < today` → `kind='overdue'`, same dedupe. Record gone/`deleted`/`archived`/`status` in done column ⇒ skip (query live row before notify).
4. Date-offset automation triggers: date_index rows where `date + days = today` for each enabled `trigger.kind==='date_offset'` automation → synthetic events into `runAutomationsForEvent`.
5. Recurrence is **event-driven** (not cron): `record.stage_changed` to a done column + `after.recurrence` → `spawnNextOccurrence` (see below).

```ts
// shared/recurrence.ts — pure
export function nextDate(r: Recurrence, after: string /*yyyy-mm-dd*/): string | null;
export function isDone(board, status): boolean;   // status === last column id
```

`spawnNextOccurrence(env, srcRecord)`: `nextDue = nextDate(recurrence, srcDue)`; `null` (past `until`) → nothing. Spawn `tasks` row id `rec_<srcId>_<nextDue>` (deterministic ⇒ replay-safe) copying title, fields, assignee, `boardId`, links (fresh `lnk_<fnv(src, dst, fieldId)>` per deterministic linkid rules), `due=nextDue`, `status=first column`, `recurrence` copied, `recurrenceFrom=srcId`. Via `applyChanges(source:'automation', changeset)`. Meetings: same path (`recurrence` on Meeting records; body blocks NOT copied — meeting template applies on open? spec: "including their template-based agenda/body" → copy `blocks` subtree rows too, ids `rec_<src>_<nextDue>_b<i>`).

Timezone semantics: `date_index.date` is `yyyy-mm-dd` as authored; `today` computed in `env.TZ || 'UTC'` (Cloudflare `scheduled` runs UTC — document that due boundaries are UTC-day; client displays its own locale but never converts stored dates).

Backfill: `POST /api/admin/reindex-dates` (admin session) → `maintainDateIndex` for every `tasks` row — used once after migration + by tests.

## 6. Public forms — `worker/forms.ts`, `src/public/FormView.tsx`, `src/modules/forms/`

`forms` record: `{databaseId, title, description, fields: [{fieldKey, label, required?, help?, order}], successMessage, enabled, notifyUserIds, createRelations?: [{fieldId, toId}], peopleMatch?: {emailField}, branding?: {intro?}}`.

Member API (`requireAuth`): `POST /api/forms` (validate config), `POST /api/forms/:id/tokens` (mint `tok_<base62(128bit)>`), `DELETE /api/forms/tokens/:token` (revoke), `GET /api/forms/:id` incl. token list.

Public API (no auth — mount under `worker/public.ts` family): 
- `GET /api/public/forms/:token` → 404/410 inactive; else `{title, description, fields[{key,type,label,required,help,options?}], successMessage, turnstileSiteKey}` — server filters; `notifyUserIds`/`createRelations`/`peopleMatch` NEVER leave the response.
- `POST /api/public/forms/:token` `{submissionId(≤64), values{fieldKey:val}, fileIds[], turnstileToken}`:
  1. token valid+form enabled else 410 `{error:'unavailable'}`.
  2. Rate limit `rate_limits('form', ip+token)` ≤10/h + payload ≤256KB else 429.
  3. Turnstile: `env.TURNSTILE_SECRET` set → siteverify; unset → test mode (`turnstileToken==='pass'` ok, `'fail'` → 403 retry-able `{error:'challenge'}`).
  4. `form_submissions` row: INSERT OR IGNORE `submission_id`; existing row → return stored `{state, receipt}` (lost-response retry = same receipt, no dup record).
  5. Validate: only configured fieldKeys, `required` enforced, `coerceFieldValue` per the board's FieldDef type; reject → state `rejected` + `{error, fields}` stored.
  6. `peopleMatch`: normalize email (`lower().trim()`) → search People board records `p_<emailFid>` → match ⇒ link submission to person + flag name-similarity duplicates as `p_<notes>` marker text on the new row (still creates a row — "possible duplicate" review flag); no match ⇒ create person row.
  7. Create record + `createRelations` links + reparent `fileIds` via `applyChanges(source:'form')` in one changeset (`meta.via='form'`).
  8. `form.submitted` event → `form_submission` notifications to `notifyUserIds`.
  9. state `accepted`, receipt `{submissionId, recordUrl, message: successMessage, at}`.
- `POST /api/public/forms/:token/files` multipart, `image/*` ≤5MB, rate-limited with submissions → `files` row `parentType:'form-pending'` + blob; reparented on accepted submit; orphan sweep in cron (older than 24h → delete row+blob).

Client builder (`src/modules/forms/`): database ⋯ menu → "Forms" → list/create/edit — stacked fields, move up/down buttons, required/help toggles, preview pane incl. 390px preview, notify recipients, `createRelations` picker (fixed relation), enable/disable, copy `/f/:token` link, revoke. All compact-safe.

`src/public/FormView.tsx`: mounted in `App.tsx` outside auth shell on `/f/:token` (like `PublicView`): fetches schema once; renders native-input fields (type/inputmode/label/help/required/error summary); drafts in `localStorage` `wsform_<token>` (JSON {values, savedAt} — cleared on `accepted`; retention: local-only, never in workspace Dexie, survives reload/network/Turnstile fail; expired/disabled → explanation + "Copy your answers" export); file input `image/*` ≤5MB with client-side size check + "send via Drive link instead" alt text field; Turnstile widget (sitekey from schema response; absent key in test mode → hidden, token auto-'pass' only when `turnstileSiteKey==='test'`); success shows server receipt + record-less confirmation (no internal data); `noindex` + security headers.

Starter form configs in pack: Volunteer registration (→People), Event registration (→Events participants link), Participant feedback (→Feedback? → Field Log), Partnership inquiry (→Organizations+Opportunities link), Field observation (→Field Log), General inquiry (→Ideas) — authored into `templates/tcg-pack.json` `forms` snapshot key with deterministic ids.

## 7. Automations — `worker/automations.ts`, `shared/automations.ts`, `src/modules/automations/`

`automations` record: `{databaseId, name, enabled, trigger: {kind:'record.created'|'stage_changed'|'field_changed'|'date_offset'|'form.submitted', to?, fieldId?, dateKey?, days?, formId?}, conditions: Filter[] (view-filter shape, evaluated on event AFTER snapshot), actions: Action[]}`.

Actions: `{type:'create_record', databaseId, title, fields{}, link?}` | `{type:'create_from_template', templateId, vars{}}` | `{type:'set_field', fieldKey, value}` | `{type:'notify', userField?|userIds[], message}` | `{type:'request_approval', approverField?|approverId, note?}` | `{type:'add_subrecords', titles[]}`.

`shared/automations.ts` pure: `matchesTrigger(trigger, event)`, `renderTemplate(str, {record, today})` (`{{record.title}}`, `{{field:Name}}`, `{{today}}`), `validateAutomation(auto, ctx)` (db exists, fields valid, recipients members, template resolvable).

`runAutomationsForEvent(env, event, ev)` (inside `processOutbox`):
- For each enabled automation where `trigger.databaseId === event.boardId` (or `form.submitted` matches formId): `matchesTrigger` + `matchesFilters(conditions, after-record)` → `event_key = 'ar_'+fnv(outboxId+':'+auto.id)` → `INSERT OR IGNORE automation_runs(id, event_key)` affected==0 ⇒ replay, skip.
- Execute actions → single `applyChanges(source:'automation', changeset)` batch (atomic; ≤500 records; validation first — invalid action ⇒ run `failed` with error, nothing partial). `request_approval` inserts an approvals row (not a record op). `notify` inserts notification rows.
- Update run row `{status:'ok'|'failed', changeset_id, error}`; failures surface in editor Run history + `automation` kind notification to the automation's editor? — no: to workspace admins? decide: `notify` failure goes to the run only (no extra noise); Run history shows error text.
- `source:'automation'` events re-enter `processOutbox` but skip automation matching (depth-1 loop guard); they still notify + update date_index.

Cron `date_offset`: for each enabled automation `{kind:'date_offset', dateKey, days}` → `SELECT record_id FROM date_index WHERE field_key=? AND date = today-days` → synthesize `record.field_changed`-style event per record.

Editor (`src/modules/automations/`): database ⋯ → "Automations" — When/If/Then stacked form: trigger selector, condition rows (reusing the view filter UI vocabulary), ordered action rows w/ Move Up/Down, enable toggle, run history (`automation_runs` via `GET /api/automations/:id/runs` → authed member), changeset link → undo affordance (existing `/api/changes/:id/undo`).

TCG starter automations (authored in pack snapshot `automations`):
1. Projects: stage→Completed ⇒ create_record in Tasks `{title:'Complete Project Review — {{record.title}}', link field Projects→record}` + notify owner.
2. Experiments: stage→Documented ⇒ create documentation-review task linked to Experiment.
3. Opportunities: `date_offset deadline -14d` ⇒ notify record owner.
4. Opportunities: stage→Proposal ⇒ create follow-up task + related link.
5. People (members): record.created ⇒ `add_subrecords` onboarding checklist tasks.

## 8. Remapping bundled config

`shared/templates.ts` planner: extend remap to walk `automations`/`forms` writes' JSON configs — keys `databaseId`, `formId`, `fieldId`/`fieldKey` (`p_<fid>`/`rel_<fid>`/`f_<fid>` id segments), `toId`, `templateId`, `notifyUserIds` (NOT remapped — user ids aren't authored), `link.fieldId` — replacing authored ids with `inst_` ids (same deterministic fnv scheme). `stableIds` reconcile then fills missing automation/form rows without touching existing.

## 9. File ownership (agents)

- **Integrator (me):** this doc; `migrations/0007_phase4.sql`; `shared/collections.ts`; `shared/events.ts`; `shared/recurrence.ts`; `worker/events.ts`; `worker/sync.ts` (event opts + batch append + guard call); `worker/index.ts` (scheduled + mounts); `wrangler.jsonc`; `src/core/db.ts`; `worker/mcp.ts` registration lines.
- **B inbox+reminders:** `worker/notifications.ts`, `worker/reminders.ts`, `src/modules/inbox/`, prefs wiring in `worker/auth.ts` (`/api/me` PATCH — owned file), `tests/recurrence.test.ts`, `tests/notifications.test.ts`.
- **C forms:** `worker/forms.ts` (+ routes mounted via provided hook), `src/public/FormView.tsx`, `src/modules/forms/`, `tests/forms.test.ts`.
- **D approvals:** `worker/approvals.ts` (incl. `guardStageWrites` impl to contract signature), `src/modules/approvals/`, `worker/mcpApprovals.ts`, `tests/approvals.test.ts`.
- **E automations:** `worker/automations.ts`, `shared/automations.ts`, `src/modules/automations/`, pack snapshot automation entries + `shared/templates.ts` remap extension (that file only for config remap), `tests/automations.test.ts`.
- **F verify:** `scripts/verify-mcp-phase4.mjs`, `scripts/verify-v9.mjs` (J1–J12 ×3 engines), perf fixtures; runs last after integration.

## 10. Retention & privacy policy

- Public drafts: `localStorage` only, keyed `wsform_<token>`, cleared on accepted receipt; never in workspace Dexie; shared-device exposure bounded to that browser profile — documented.
- `form_submissions`: rows kept 30 days then cron-swept (receipt replayable while retained).
- `rate_limits`: swept >24h. `event_outbox` processed rows deleted on sweep. `reminder_sent`: kept (dedupe state), swept rows >400d. `automation_runs`: last 200/automation.
- `notifications`: retained; read rows >180d swept by cron.
- Orphan `form-pending` files: >24h deleted (blob+row).

## 11. Acceptance map

Every §14 DoD item maps to: unit tests (deriveEvents, recurrence, renderTemplate, matchesTrigger, grouping, gate validation, coerce+dedupe), `verify-mcp-phase4.mjs` (MCP approval tools, gate via MCP write, dry-run/requestId/decide CAS, account isolation), `verify-v9.mjs` J1–J12 (inbox, reminders×2 dedupe, recurrence+replay, public form J4–J7, approval gate UI+MCP+push bypass attempts J8, automation J9–J10, TCG upgrade J11, account isolation J12) across Chromium/Firefox/WebKit compact+desktop, perf ≥1000 records. Physical iOS/Android/AT = NOT RUN release gates, reported as such.
