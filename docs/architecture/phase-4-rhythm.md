# Phase 4 — Operating rhythm: events, notifications, reminders, forms, approvals, automations

Goal: the workspace prompts people at the right time and accepts input from outsiders, without notification overload or a heavy workflow builder.

Depends on Phase 0 (change sets) and Phase 1 (records, fields, links). Re-detail before building.

---

## 1. Server event pipeline (foundation)

All triggers come from one place: after every successful write batch on the server.

```ts
// worker/events.ts
export interface ChangeEvent { source: 'client' | 'mcp' | 'automation' | 'form' | 'undo'; userId: string; applied: AppliedChange[]; changesetId?: string }
export function emit(env: Env, ctx: ExecutionContext, ev: ChangeEvent): void // calls ctx.waitUntil(processEvent(env, ev)) internally; never awaited
```

- Called from `/api/sync/push` (client writes) and from the MCP/automation/form write helpers, using `ApplyResult.applied` (Phase 0).
- `processEvent` derives semantic events: `record.created`, `record.stage_changed {from,to}`, `record.field_changed {fieldId, from, to}`, `record.assigned`, `comment.created`, `mention.created`, `form.submitted`.
- Fan-out to: notifications (§2) and automations (§5).
- Loop guard: events with `source:'automation'` only fan out to notifications, never to automations (depth 1).
- Must stay within Worker CPU limits: process ≤500 applied changes per event; heavy work deferred to a Queue only if measured necessary (Queues availability on free plan to verify).

## 2. Notifications

- Collection `notifications` [G]: `{ userId, kind, actorId, targetType, targetId, title, body?, url, readAt?, createdAt, groupKey }`.
  - Synced to everyone (Phase 5 filters per user); client shows only `userId === me`.
- Kinds: `mention, assigned, comment_on_mine, due_soon, overdue, approval_requested, approval_decided, form_submission, automation`.
- Grouping: same `groupKey` (e.g. `comment:<targetId>`) within 30 min updates the existing notification (count) instead of adding.
- Preferences: users table column `prefs TEXT` (JSON) via `/api/me` PATCH: per kind `inbox | off`, quiet digest option. Defaults: mentions/assigned/approvals on; comments on own items on; due_soon on; form submissions only for the form owner.
- UI: Inbox nav item (badge count), list with mark read/all read, deep links. Activity remains the workspace log.
- Push (web push/VAPID) is optional later; Inbox first.

## 3. Reminders, due dates, recurrence

- Cron Trigger (`wrangler.jsonc` `triggers.crons: ["*/15 * * * *"]`; verify free-plan limits) → `scheduled()` handler in `worker/index.ts`.
- Each run: a small `date_index` table `(record_id, field_key, date)` — maintained by the event pipeline on every applied change (delete stale rows, insert current) — is the only date lookup (no `json_extract` scans). Create `due_soon` (configurable lead: default 1 day; per-database setting `reminderLeadDays`) and `overdue` notifications once (dedupe table `reminder_sent(record_id, field_key, date, kind)`).
- Recurrence: record field `recurrence?: { freq: 'daily'|'weekly'|'monthly'; interval: number; byWeekday?: number[]; until?: string }`. On `stage_changed` to done → create next occurrence (copy title, fields, assignee, relations; next date) as server write (change set `source:'automation'`).
- Recurring meetings = recurrence on Meeting records + meeting template body.

## 4. Public forms

- Collection `forms` [G]: `{ databaseId, title, description, fields: { fieldKey, label, required, help }[], successMessage, enabled, notifyUserIds, createRelations?: {fieldId, toId}[] }`; D1 table `form_tokens(token PK, form_id, created_at)` for public URLs.
- Public route `/f/:token` rendered by `src/public/FormView.tsx` outside the auth shell (like `PublicView`), `noindex`.
- Submit `POST /api/public/forms/:token`: Turnstile verification (secret via Wrangler secret), size limits, rate limit per IP (D1 counter table with time bucket), validation via `coerceFieldValue`. Creates a record (`source:'form'` change set) + optional link; files: images ≤5 MB into D1 store; anything else as Drive link text field.
- Dedupe people: if the form maps an Email field on the People database, match existing Person by email (case-insensitive) and link instead of creating a duplicate; flag "possible duplicate" for name-only matches.
- Builder UI: from a database menu "Create form" → pick fields, labels, required; preview; copy link; enable/disable.

## 5. Approvals

- Collection `approvals` [G]: `{ targetType, targetId, requestedBy, approverId, status: 'pending'|'approved'|'rejected'|'cancelled', note?, decidedAt?, createdAt }`.
- UI: "Request approval" on any record/page (pick approver, note); badge on target; approver's Inbox; Approve/Reject with note; history on target.
- Database setting: `approvalGate?: { stageId, approverField?: fieldId }` → moving a record into that stage without an approved approval is blocked in UI and MCP (`update_records` returns `approval_required`) and offers to request one.
- MCP: `request_approval`, `list_approvals({mine})`, `decide_approval` (only approver).

## 6. Automations (lightweight)

- Collection `automations` [G]: `{ databaseId, name, enabled, trigger, conditions: Filter[], actions: Action[] }`; D1 `automation_runs(id, automation_id, changeset_id, status, error, created_at)`.
- Triggers: `record.created`, `stage_changed {to}`, `field_changed {fieldId}`, `date_offset {dateKey, days}` (from cron), `form.submitted {formId}`.
- Actions: `create_record {databaseId, title template, fields, link}`, `create_from_template {templateId, vars}`, `set_field {fieldKey, value}`, `notify {userField | userIds, message}`, `request_approval {approverField}`, `add_subrecords {titles[]}` (checklist).
- Template strings: `{{record.title}}`, `{{field:Name}}`, `{{today}}`.
- Each run = one change set (`source:'automation'`, undoable) + run log; failures visible on the automation.
- UI: database menu → Automations: list + simple "When / If / Then" form (one trigger, filters, ordered actions). No visual graph.
- Starter automations in TCG pack: completed project → review task (from Project Review template); experiment documented → documentation review task; opportunity deadline −14 days → notify owner; partnership stage → Proposal → follow-up task; new member → onboarding sub-records; meeting action items → tasks (via MCP prompt in Phase 6, not automation).

## 7. Tests (outline)
Pure: event derivation from `AppliedChange`, recurrence next-date, template string rendering, automation condition matching, notification grouping. E2E: stage change → automation creates task + notification; cron run creates due_soon once; form submission with Turnstile test keys → record + person dedupe; approval gate blocks stage move via UI and MCP; undo automation change set.

## 8. Acceptance
People get timely, deduplicated Inbox items they can control; outsiders submit forms that become linked records; approvals and a small set of automations run reliably and are reviewable/undoable.
