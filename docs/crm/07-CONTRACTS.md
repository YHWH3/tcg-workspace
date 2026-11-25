# Contracts

These contracts are what frontend, backend and AI tooling build against. They specify behaviour and guarantees; handler internals are a backend engineering choice bounded by them.

## 1. Command envelope

`POST /api/crm/commands/<name>` with session auth (the browser), or the same handler through an MCP tool or automation.

```ts
interface CommandRequest<I> {
  requestId: string;          // 8-64 chars, client-generated; idempotency key per actor
  input: I;
  expected?: Record<string, number>; // object id -> rev the caller read
}
interface CommandResult<O> {
  ok: true; commandId: string; result: O;
  projections: { recordId: string; rev: number }[];
}
interface CommandError {
  ok: false; error: CrmErrorCode; detail?: Record<string, unknown>; retryable: boolean;
}
```

Guarantees for every command:

1. **Idempotent:** the canonical SHA-256 request hash covers `{ v: 1, name, via, input, expected }` (`shared/stablejson.ts:4-19`). The same `requestId` from the same actor with matching hash returns the stored result (rechecking current actor & replay authority first) and never repeats side effects; a differing hash returns `idempotency_conflict`. Successful no-ops write a journal row; in S0 no errors are persisted (`contracts/crm-s0-v2.md` SC-1). (The 8-64 character bound is a CRM choice; MCP `requestId` elsewhere in the repository accepts 1-64.)
2. **Revision-checked:** any object in `expected` whose current `rev` differs returns `stale` with the current revs; nothing is written (enforced both in pre-check and transactionally via `strictExpectationGuard`, even when no projection field changed).
3. **Authorised now:** the actor's session, account state, CRM capability and (for records) space access are checked against current state by fence statements in the same batch as the write, using the repository's abort-the-batch fence pattern (`SELECT CASE WHEN ... THEN 1 ELSE json_extract('{','$') END`, as in `worker/admin.ts:19-24`). **CRM capability checks run whether or not `access_state.enabled` is set** (A-19); only the space-access part follows the Workspace permission mode.
4. **Atomic:** operational rows, projection fields and the journal row commit in one D1 batch or not at all (with a `changes() = 1` guard on every record write so a failed projection aborts server-only rows). Two commit modes, because legacy `applyChanges` skips batching when `todo` is empty (`worker/sync.ts:553-556`):
   - *Server-only mode* (no record written or expected): one `db.batch([fences..., operational rows..., journal])`.
   - *Records mode* (projection writes or expected record revisions): `applyChanges(env, actor, changes, { serverTs: true, atomic: true, expect, session: { tokenHash }, projection, fences, commit })`, routed to single-batch `flushAtomicCommit` (no retries, no chunk splitting). Records-mode commands never pass `journal` (changesets), so no generic Undo is offered for side effects.
5. **Budgeted:** a command stays inside the 45-binding-call request budget (`withD1Budget`, `worker/d1budget.ts:18`).
6. **Journalled:** a `crm_commands` row records actor, channel (ui, mcp, automation, ingest), request hash and bounded result.
7. **Never writes `records` by SQL.** Record changes go through `applyChanges`; command handlers write only CRM server-only tables directly.

## 2. Error codes

| Code | Meaning | Retryable |
|---|---|---|
| `unauthenticated` | No valid session or connector | no |
| `forbidden` | Missing capability or space right | no |
| `not_found` | Object missing or unreadable (same response for both) | no |
| `stale` | Expected revision mismatch | yes, after re-read |
| `idempotency_conflict` | Same requestId, different input | no |
| `invalid_input` | Schema or rule violation; `detail.fields` lists problems | no |
| `capacity_exceeded` | Not enough seats | no |
| `hold_expired` | Hold ended before confirmation | no |
| `window_closed` | Free-form message outside provider window | no (use a template) |
| `consent_withdrawn` | Recipient opted out for this channel and purpose | no |
| `provider_unavailable` | Channel or payment provider not connected or failing | yes |
| `currency_mismatch` | Mixed currencies in one operation | no |
| `approval_required` | A second person must approve (refund threshold, gated stage) | no; creates an approval |
| `budget_exceeded` | Operation too large for one request; split it | no |
| `source_changed` | A referenced source record changed during the operation | yes |

## 3. Command catalogue

Capability column: the capability needed (plus normal space edit rights on any relationship record touched). "Human-only" means the MCP tool for it is classified `H` (embedded deny, human UI flow only) or the assistant may only prepare a proposal.

### Capabilities and accounts (S0; A-20, A-21)

The CRM capability catalogue. The owner's list (A-21) is marked *owner*; the rest are proposed (P-11).

| Capability | Scope | Meaning |
|---|---|---|
| `crm.access` | `*` | Mandatory CRM gate to open `/crm`, read `/api/crm/read/*` and run `/api/crm/commands/*`. For non-owners, no specialised capability takes effect unless `crm.access` (`*`) is also held. Without it the app switcher and `/crm` are hidden and CRM APIs refuse access (`forbidden`) |
| `crm.send:email`, `crm.send:whatsapp`, `crm.send:instagram`, `crm.send:facebook` *owner* | `*` | Send on that channel |
| `crm.restricted.read` *owner* | programme ID or `*` | Read screening and restricted notes |
| `crm.finance.read` *owner* | `*` | See money screens and amounts |
| `crm.finance.record` *owner* | `*` | Record payments, receipts, reversals, refund issue |
| `crm.refund.approve` *owner* | `*` | Approve refunds (never one's own request) |
| `crm.configure` *owner* | programme ID or `*` | Programme profiles, CRM views, fields, automations, templates, editions |
| `crm.merge` | `*` | Merge and unmerge people |
| `crm.channels.manage` | `*` | Connect and disconnect channel accounts, submit templates |
| `crm.capabilities.manage` | `*` | Grant and revoke CRM capabilities. Only the owner can grant or revoke this one, and only to an admin |

Evaluation rule, used by every command and gated read (`worker/crm/grants.ts`, pure rules in `worker/crm/rules.ts`, catalogue only in `shared/crm/capabilities.ts`):

1. The actor's account must be active (`users.disabled_at IS NULL`) with a live session; a connector request also needs a live connector grant.
2. If the actor's current workspace role is `owner`, every capability is held, at every scope. This is computed from the `users` row at check time; there are no rows to revoke.
3. For any non-owner, holding `crm.access` (`*`) is required before any CRM command, protected CRM read or specialised capability is effective. Otherwise a specialised capability is held iff the actor holds `crm.access` (`*`) AND a `crm_capability_grants` row exists for (user, capability, scope) or (user, capability, `*`). `crm.capabilities.manage` additionally requires the current role to be `admin`; a demoted admin loses it without any revoke. Specialised grant rows remain independent in `crm_capability_grants` (revoking `crm.access` does not delete them, preserving audit history).
4. Guests hold nothing and cannot be granted anything (`guest_not_eligible`).
5. Nothing is implied by `admin` or `member` alone (A-21).
6. Disabling an account revokes all its grants in the disable batch, each with an audit row (reason `account_disabled`); re-enabling restores none and writes nothing to CRM tables (approved, A-25; `S0-PLAN.md` section 6.2). Removing an account deletes its grants by foreign-key cascade; audit rows remain.

| Command | Input | Effect | Who | AI |
|---|---|---|---|---|
| `capability.grant` | userId, capability, scope (`*`; programme IDs from S2), reason? | Inserts the grant row and one audit row in one batch (and calls `pokeLive()`). Already held: commits journal + fences (`ok` with `already: true`), writes no audit row | Owner; or an admin holding `crm.access` + `crm.capabilities.manage`, who may not grant to themselves and may not grant `crm.capabilities.manage` | Human-only, not registered as an MCP tool |
| `capability.revoke` | userId, capability, scope | Deletes the grant row and writes one audit row in one batch (and calls `pokeLive()`). Not held: commits journal + fences (`ok` with `already: true`), writes no audit row | Same as grant; revoking `crm.capabilities.manage` is owner-only | Human-only, not registered |

Fences in the batch: (1) `actorFence`: actor session live, active, same role and (if non-owner) holding `crm.access` + `crm.capabilities.manage`; (2) `targetAccountFence`: target still has the role and disabled state that was read; (3) `targetGrantStateFence`: grant row still absent or matches the loaded `(granted_by, granted_at)`. A fence failure returns `stale` (or `401`/`forbidden` if actor auth dropped) and writes nothing.

Errors specific to these commands: `forbidden` (actor lacks the right), `invalid_input` with `detail.reason` one of `guest_not_eligible`, `self_grant`, `owner_implicit` (granting to or revoking from the owner), `unknown_capability`, `unknown_scope`, `account_disabled`, `not_admin`. **For S0 the normative, versioned form of these commands, the API, owner protection, disable revocation and the table contract is [`contracts/crm-s0-v2.md`](contracts/crm-s0-v2.md)**, which also restricts S0 to scope `*` (programme scopes arrive with S2).

**Audit.** Every grant or revoke that changes state writes one row to `crm_capability_audit` (`06` section 3): actor, target, action, capability, scope, before, after, reason, request ID, time. The table is append-only (SQL triggers reject UPDATE and DELETE). Reads: `GET /api/crm/read/capabilities` (accounts with their effective capabilities) and `GET /api/crm/read/capability-audit?cursor=` (newest first, keyset cursor), both for the owner and admins holding `crm.capabilities.manage`.

**Accounts.** The CRM Settings "Accounts" tab (`08` section 13) uses the existing Workspace routes unchanged, so there is one account system:

| Action | Existing route | Rights today |
|---|---|---|
| List accounts and seats | `GET /api/users` (`worker/admin.ts:93-98`) | Any signed-in account; guests see only themselves |
| Create invite, list, delete unused | `POST/GET /api/invites`, `DELETE /api/invites/:code` (`:144-163`) | Owner or admin (`requireAdmin`, `worker/auth.ts:235-239`) |
| Change role admin ⇄ member | `PATCH /api/users/:id` (`:165-179`) | Owner or admin, not on oneself, audited in `access_audit` as `user.role` |
| Disable, re-enable | `POST /api/users/:id/disable`, `/enable` (`:108-142`) | Owner or admin, audited in `access_audit`; re-enable respects the seven-account cap |
| Remove | `DELETE /api/users/:id` (`:206-215`) | Owner or admin, not oneself |
| Rename oneself | `PATCH /api/me` (`worker/auth.ts:454-475`) | Every account (A-20: people set their own names) |
| Rename another account | **New in S1:** `PATCH /api/users/:id` accepts `name`, **owner-only** (`403` for non-owners), audited in `access_audit` as `user.rename` | — |

**Owner protection (approved, A-23; built in S0).** Contract for the three routes that can change another account's role or status:

| Route | Target is the owner, actor is not | Target is the owner, actor is the owner | Existing rules kept |
|---|---|---|---|
| `PATCH /api/users/:id` | `403 { error: 'owner_protected' }`, nothing written | Already refused: "Cannot change your own role" (`worker/admin.ts:169`) | Guests refused; last-privileged fence |
| `POST /api/users/:id/disable` | `403 { error: 'owner_protected' }`, nothing written | Already refused: "Cannot disable yourself" (`:109`) | Last-privileged fence (`:103-105`) |
| `DELETE /api/users/:id` | `403 { error: 'owner_protected' }`, nothing written | Already refused: "Cannot remove yourself" (`:208`) | Last-privileged fence |

The check runs on the server in two places: a pre-check on the row read before the batch (clear error), and a condition in the batch's account fence that the target is not the owner (race backstop: if the target became owner between read and commit, the batch aborts with the existing `account_or_authority_changed` 409). The UI hiding owner actions (`08` section 13.1) is presentation only. The effect: the owner account can leave the `owner` role, be disabled or be removed by no HTTP route, so the workspace cannot lose its last owner through account management. These are the only routes that do this: every other server write to `users` is a self-edit (`worker/auth.ts:466-489`, `worker/email.ts:156`, `worker/notificationEmail.ts:222-224`). Ownership transfer is not built; a future transfer feature would need its own owner decision.

### Identity

| Command | Input | Effect | Capability | AI |
|---|---|---|---|---|
| `person.add_endpoint` | personId, kind, value, source | Creates endpoint; updates primary field projection if first | `crm.access` | Proposal |
| `person.retire_endpoint` | endpointId | Marks retired | `crm.access` | Proposal |
| `person.set_primary_endpoint` | endpointId | Updates People Email or Phone | `crm.access` | Proposal |
| `person.record_consent` | personId, channel, purpose, state, evidence | Appends consent row | `crm.access` | Human-only for `granted` |
| `duplicates.dismiss` | candidateId | Closes candidate | `crm.access` | Proposal |
| `person.merge` | survivorId, mergedId | Moves references, archives merged, writes alias and journal | `crm.merge` | Human-only |
| `person.unmerge` | mergeId | Reverses moved references | `crm.merge` + admin | Human-only |
| `person.erase` | personId, scope | Privacy redaction | admin | Human-only |

### Conversations

| Command | Input | Effect | Capability | AI |
|---|---|---|---|---|
| `conversation.link_person` | conversationId, personId | Sets match | `crm.access` | Proposal |
| `conversation.assign` | conversationId, userId | Assigns | `crm.access` | Proposal |
| `conversation.set_state` | conversationId, state, snoozeUntil? | Open, waiting, snoozed, closed | `crm.access` | Proposal |
| `message.save_draft` | conversationId, body, templateId?, attachments | Draft message (not sent) | `crm.access` | Allowed (drafts are not side effects) |
| `message.add_note` | conversationId, body | Internal note | `crm.access` | Allowed |
| `message.send` | messageId (a draft), expected rev | Checks window, consent, template; queues; outbox sends | `crm.send:<channel>` | **Human-only** |
| `message.retry` | messageId | Re-queues a failed message with the same idempotency key | `crm.send:<channel>` | Human-only |
| `template.submit` | templateId | Submits to provider for approval | `crm.channels.manage` | Human-only |
| `channel.connect` / `channel.disconnect` | provider, settings | Account connection (OAuth or secret name) | `crm.channels.manage` + admin | Human-only |

### Applications

Applications are relationship-tier records; most changes are normal edits. Commands exist only where a guarantee is needed:

| Command | Input | Effect | Capability | AI |
|---|---|---|---|---|
| `application.create_from_submission` | submissionId, programmeId | Creates Application linked to source and person | `crm.access` | Proposal |
| `application.convert` | applicationId, target (booking, membership, opportunity, project, assignment) | Creates target, links, sets Converted | `crm.access` (+ target capability) | Proposal |

Decisions use the existing stage approval gate.

### Bookings

| Command | Input | Effect | Capability | AI |
|---|---|---|---|---|
| `edition.configure` | eventRecordId, capacity, holdMinutes, priceOptions, requiresScreening | Creates or updates edition policy; capacity cannot go below confirmed seats | `crm.configure` for programme | Proposal |
| `edition.set_state` | editionId, state | Open, close, cancel, complete | `crm.configure` | Human-only for cancel |
| `booking.request` | editionId, bookerPersonId, seats, priceOption, participants? | Creates request (no seats) | `crm.access` | Proposal |
| `booking.hold` | bookingId | Allocates held seats until expiry | `crm.access` | Proposal |
| `booking.confirm` | bookingId, expected rev | Converts hold to confirmed (or allocates directly); requires payment policy satisfied or explicit "confirm before payment" policy | `crm.access` | **Human-only** |
| `booking.waitlist` | bookingId | Places on waitlist with position | `crm.access` | Proposal |
| `booking.offer_from_waitlist` | bookingId | Creates hold and drafts an offer message | `crm.access` | Proposal |
| `booking.cancel` | bookingId, reason, refundIntent | Releases seats; creates refund request if applicable | `crm.access` | Human-only |
| `booking.transfer` | bookingId, targetEditionId | Atomic release and allocate | `crm.access` | Human-only |
| `participant.set` | bookingId, participants[] | Name placeholders, link people | `crm.access` | Proposal |
| `screening.record` | participantId, answers, state | Restricted | `crm.restricted.read` | Human-only |
| `attendance.record` | participantId, sessionDate, state | Attendance | `crm.access` | Proposal |

### Money

| Command | Input | Effect | Capability | AI |
|---|---|---|---|---|
| `payment.request` | objectType, objectId, amountMinor, currency, dueAt, provider? | Payment request; provider link in phase 2 | `crm.finance.record` | Proposal |
| `payment.record_receipt` | requestId or object, amountMinor, currency, evidence | Ledger receipt; updates balances and projections | `crm.finance.record` | **Human-only** |
| `payment.reverse` | entryId, reason | Reversing entry | `crm.finance.record` | Human-only |
| `refund.request` | objectId, amountMinor, reason | Refund request; above threshold needs approval | `crm.finance.record` | Proposal |
| `refund.approve` | refundRequestId | Approves | `crm.refund.approve` (not the requester) | Human-only |
| `refund.record_issued` | refundRequestId, evidence | Ledger refund entry | `crm.finance.record` | Human-only |

### Membership

| Command | Input | Effect | Capability | AI |
|---|---|---|---|---|
| `membership.start` | personId, scheme, applicationId? | Creates membership awaiting contribution | `crm.access` | Proposal |
| `membership.activate` | membershipId | Requires a linked ledger receipt; sets validity per scheme | `crm.finance.record` | Human-only |
| `membership.renew` | membershipId | New period on new receipt | `crm.finance.record` | Human-only |
| `membership.cancel` | membershipId, reason | Cancels | `crm.access` | Human-only |

### Knowledge

| Command | Input | Effect | Capability | AI |
|---|---|---|---|---|
| `fact.propose` | programmeId, editionId?, key, value, source | Draft fact | `crm.access` | Allowed |
| `fact.verify` | factId, reviewBy | Verified with expiry | programme lead | Human-only |
| `fact.retire` | factId | Retired | programme lead | Human-only |

## 4. Read API

All reads go through the request's read gate (`withReadGate`), apply capability filters, and return `partial: true` with `partialSources` when bounded or filtered.

| Endpoint | Returns |
|---|---|
| `GET /api/crm/read/timeline?subject=<id>&cursor=` | Merged, newest-first events for a person, organisation, application, opportunity or edition: messages, notes, activities, submissions, bookings, ledger entries (amounts only with `crm.finance.read`), decisions, history highlights. Keyset cursor. |
| `GET /api/crm/read/conversations?filter=` | Conversation list with last message preview, window state, assignee |
| `GET /api/crm/read/conversation/<id>?cursor=` | Messages |
| `GET /api/crm/read/edition/<id>` | Capacity, allocations, bookings, participants (screening state only), waitlist |
| `GET /api/crm/read/home` | My Work sections (`04` section 6) |
| `GET /api/crm/read/money?object=` | Requests, entries, balance per currency (`crm.finance.read`) |
| `GET /api/crm/read/duplicates` | Open candidates with reasons |
| `GET /api/crm/read/facts?programme=&edition=` | Facts with state and age |

## 5. Programme profile schema (validated JSON on the Programme record)

```ts
interface ProgrammeProfile {
  version: 1;
  area: 'experiences' | 'spaces' | 'community' | 'collaboration' | 'culture';
  engines: { applications?: boolean; bookings?: boolean; membership?: string | null; opportunities?: string[]; patrons?: boolean };
  forms?: string[];                  // website form IDs routed here
  autoCreateApplications?: boolean;  // default false
  stageSet?: string;                 // stage configuration ID for Applications
  reviewGate?: { stageId: string; approver: 'programme_lead' | 'crm.configure' } | null; // never a bare workspace role (A-21)
  bookingDefaults?: { holdMinutes: number | null; requiresScreening: boolean; confirmBeforePayment: boolean };
  responseTargetDays?: number | null;
  restrictedFields?: string[];       // relationship-tier fields hidden in CRM views for users without restricted read
  defaultViewId?: string;
}
```

All defaults are off or null. Values are owner decisions (O-05 to O-07).

## 6. Permission matrix

Rewritten for A-21: capabilities attach to accounts, not to job titles, and no workspace role implies any capability except `owner`.

| Action | Capability | Owner | Admin | Member | Guest |
|---|---|---|---|---|---|
| Open the CRM, edit relationship records through the CRM | `crm.access` | always | if granted | if granted | never |
| Configure programmes, CRM views, fields, automations, templates, editions | `crm.configure` (programme or `*`) | always | if granted | if granted | never |
| Send on a channel | `crm.send:<channel>` | always | if granted | if granted | never |
| Read screening and restricted notes | `crm.restricted.read` (programme or `*`) | always | if granted | if granted | never |
| See money | `crm.finance.read` | always | if granted | if granted | never |
| Record payments, reversals, refund issue | `crm.finance.record` | always | if granted | if granted | never |
| Approve refunds (never one's own request) | `crm.refund.approve` | always | if granted | if granted | never |
| Merge people | `crm.merge` | always | if granted | if granted | never |
| Connect channels | `crm.channels.manage` | always | if granted | if granted | never |
| Grant and revoke capabilities | `crm.capabilities.manage` | always | if granted by the owner | never | never |
| Manage accounts (invite, role, disable, remove) | Workspace `requireAdmin` | yes | yes, except on the owner account (A-23) | no | no |

"If granted" means an explicit `crm_capability_grants` row. "Programme lead", "coordinator" and "finance" in `04` section 8 are descriptions of typical bundles of grants, not stored roles. Relationship records remain readable and editable through Workspace by every signed-in account while permissions are off (A-19); `crm.access` gates the CRM application and CRM APIs, not the underlying records.

## 7. Channel adapter interface

```ts
interface ChannelAdapter {
  provider: 'email_zoho' | 'whatsapp_cloud' | 'instagram' | 'facebook_page' | 'simulated';
  /** Push providers (Meta channels; Zoho only if verified push support exists). */
  verifyInbound?(request: Request, secret: string): Promise<boolean>;
  parseInbound?(body: unknown): InboundEvent[];      // messages, status receipts, opt-outs
  /** Pull providers (Zoho Mail): bounded fetch since a stored cursor, run from the cron. */
  poll?(cursor: string | null, limit: number): Promise<{ events: InboundEvent[]; cursor: string | null; more: boolean } | { error: AdapterErrorClass }>;
  windowState(conversation: ConversationRow, now: number): { open: boolean; closesAt?: number; templateRequired: boolean };
  send(message: OutboundMessage, idempotencyKey: string): Promise<{ externalId: string } | { error: AdapterErrorClass } | { unknown: true }>;
  mapStatus(event: InboundEvent): MessageStatus | null;
  listTemplates?(): Promise<ProviderTemplate[]>;
}
type AdapterErrorClass = 'auth' | 'rate_limited' | 'window_closed' | 'recipient_invalid' | 'blocked' | 'content_rejected' | 'transient' | 'unknown';
```

An adapter implements either the push pair or `poll`, or both. Either way every inbound item lands in `crm_inbound_events` keyed by a provider event ID (for Zoho, the provider's message identifier [needs verification]), so a webhook replay and a re-poll dedupe the same way. Email never has a messaging window: `windowState` returns `{ open: true, templateRequired: false }`.

`send` returning `{ unknown: true }` (timeout or ambiguous response) moves the message to review instead of retrying, unless the provider offers an idempotency mechanism that has been verified; none is assumed for Zoho.

Retry policy: `transient` and `rate_limited` retry with backoff; everything else fails to review.

Provider egress follows the repository's AI-provider rules (`AGENTS.md`, "Embedded AI + universal MCP"): an exact host allowlist per adapter, `redirect: 'error'`, no fallback to another provider, credentials only in Worker secrets (D1 stores secret names, never values), access tokens held only for the request or cron run that obtained them (no module-level cache, `AGENTS.md` Conventions).

## 8. MCP tools (added to `shared/aiCapabilities.ts`)

| Tool | Kind | Embedded | Notes |
|---|---|---|---|
| `crm_find_people` | read | allow | Search by name, endpoint, programme |
| `crm_person_profile` | read | allow | Profile, participations, timeline page |
| `crm_conversations` | read | allow | Queue and threads |
| `crm_edition_status` | read | allow | Seats and bookings, no screening |
| `crm_home` | read | allow | My Work |
| `crm_facts` | read | allow | Verified facts with age |
| `crm_draft_message` | proposal | allow | Creates a draft; never sends |
| `crm_propose_triage` | proposal | allow | Classify, link person, assign, create application, as one previewable changeset |
| `crm_propose_booking` | proposal | allow | Prepares request and hold for a human to confirm |
| `crm_propose_merge` | proposal | allow | Duplicate candidate with reasons |
| `crm_propose_fact` | proposal | allow | Draft fact with source |
| `crm_send_message`, `crm_confirm_booking`, `crm_record_payment`, `crm_refund`, `crm_merge` | not registered initially | n/a | These actions happen only in the CRM UI. A later option is to register them as human-only tools that create a frozen preview needing browser approval by a person with the capability, using the existing preview path. Owner decision O-18. |
| `capability.grant`, `capability.revoke`, account management | never registered | n/a | Authority changes stay human-only in the CRM Settings screen (A-21). |

Registry mechanics: `CapabilityModule` in `shared/aiCapabilities.ts:19-22` is a closed union, so CRM tools need a new `'crm'` module value; `tests/assistant-registry.test.ts` then requires each registered tool to have an entry. The registry today classifies 90 tools: 30 read, 51 write, 3 proposal, 6 human-only (counted from `CAPABILITIES` at the pinned commit). No CRM MCP tool ships in S0.

Existing generic tools (`query_records`, `update_records`, views, dashboards) keep working on relationship-tier CRM databases. They cannot write `_crm_` projection fields: the S0 pre-check in `applyChanges` rejects such items with `protected_field` for every caller that does not carry a registered command's projection grant, in both permission modes.
