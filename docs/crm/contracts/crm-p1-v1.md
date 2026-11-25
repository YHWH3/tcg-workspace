# TCG CRM Contract `crm-p1-v1` (Core CRM)

Status: **Active development on `crm/p1-core`** (extends [`crm-s0-v2`](crm-s0-v2.md) additively without breaking any S0 guarantee or wire schema).

## 1. Backward Compatibility with S0 (`crm-s0-v2`)

- `GET /api/crm/status` keeps `contract: 'crm-s0-v2'` so existing S0 clients, schema checks (`CrmStatusSchema`), and `CRM_ENABLED` gating continue working unchanged.
- `capability.grant` and `capability.revoke` preserve S0 three-fence concurrency safety, append-only `crm_capability_audit`, and SC-2.1 capability evaluation rules.
- Starting in S2, `capability.grant` and `capability.revoke` additionally accept valid `programme:<slug>` scopes (against the 14 canonical programmes in `shared/crm/programmes.ts`) strictly for capabilities listed in `PROGRAMME_SCOPED` (`crm.restricted.read`, `crm.configure`). Every other capability accepts `*` only.
- SC-3 unconditional `_crm_*` projection-key rejection in `applyChanges` and `authorizeMutations` applies equally to every P1 projection key listed below.

## 2. P1 Server-Only Tables (`migrations/0046_crm_p1_core.sql`)

All tables below are server-only D1 tables and MUST NEVER appear in `shared/collections.ts` (`COLLECTIONS`):

- `crm_endpoints` — normalized contact endpoints (`email`, `phone`, `whatsapp`, `instagram`, `facebook`), unique active `(kind, value_norm)`, unique primary `(person_id, kind)` when active.
- `crm_consents` — append-only consent ledger (trigger-enforced `BEFORE UPDATE`/`BEFORE DELETE` abort), latest row per `(person_id, channel, scope)` determines current consent.
- `crm_duplicate_candidates` — open/dismissed duplicate pairs (`person_a_id < person_b_id`). Merge/unmerge (`S10`) stays deferred to P2.
- `crm_programme_profiles` — validated v1 `ProgrammeProfile` configuration keyed by `slug`.
- `crm_channel_accounts` — configured communication channels (`simulated` under `WORKSPACE_ENV='local-test'`; live external adapters stay `disabled` in P1).
- `crm_conversations`, `crm_messages`, `crm_outbox`, `crm_inbound_events`, `crm_templates` — unified conversation threads, internal team notes, drafts, simulated outbox receipts, and inbound webhook/event dedupe.
- `crm_facts` — verified operational knowledge store (`draft`, `verified`, `retired`, `review_by` staleness).

## 3. P1 Commands (`POST /api/crm/commands/<name>`)

All commands inherit the S0 command envelope, idempotency hash, three-mode commit (`server-only` or `records` atomic batch), `withD1Budget(env, 45)`, and `crm_commands` journal.

### S1 Identity
- `person.add_endpoint` (`crm.access`; projects `_crm_primary_email`, `_crm_primary_phone`, `_crm_endpoint_count`)
- `person.retire_endpoint` (`crm.access`; projects `_crm_primary_email`, `_crm_primary_phone`, `_crm_endpoint_count`)
- `person.set_primary_endpoint` (`crm.access`; projects `_crm_primary_email`, `_crm_primary_phone`)
- `person.record_consent` (`crm.access`; appends `crm_consents`; projects `_crm_consent_summary`)
- `duplicates.dismiss` (`crm.access`; marks open duplicate candidate dismissed with optional note)
- `endpoints.backfill` (`crm.configure` at `*`; bounded `<=50` records per call; supports `dryRun: true` conflict report without mutations and `dryRun: false` write)
- Workspace owner-only audited rename (`PATCH /api/users/:id` `{ name }`): requires canonical `owner` role (`403` `owner_only` for non-owners); writes `user.rename` row in `access_audit`.

### S2 Programmes & Applications
- `programme.update_profile` (`crm.configure` on `programme:<slug>` or `*`; projects `_crm_work_area`, `_crm_profile_status` onto `db_programs` record if provided)
- `application.create_from_submission` (`crm.access`; reads immutable `board-website-inbox` submission without modifying sender answers, links Person + Program, creates Application with `_crm_source_submission_id` projection)
- `application.convert` (`crm.access`; creates linked Project / Opportunity / Event participation and projects `_crm_converted_record_id`, `_crm_converted_kind`)

### S4 Conversations & Verified Facts
- `conversation.log_manual` (`crm.access`; logs off-platform call/email/WhatsApp/IG/FB interaction, updates `_crm_last_contact_at`, `_crm_open_conversations`)
- `conversation.simulate_inbound` (`crm.access`, active ONLY when `WORKSPACE_ENV='local-test'`; idempotent on `(channel, externalEventId)`; auto-matches active `crm_endpoints` or queues in `unmatched`)
- `conversation.link_person` (`crm.access`; links unmatched conversation to canonical Person ID)
- `conversation.assign` (`crm.access`; assigns assignee or clears)
- `conversation.set_state` (`crm.access`; transitions `open` / `snoozed` / `closed` / `spam`)
- `message.add_note` (`crm.access`; inserts internal team note — never placed in `crm_outbox`, never sendable)
- `message.save_draft` (`crm.access`; creates/updates draft)
- `message.send` (**human-only** `via === 'ui'`; requires `crm.send:<channel>`; enforces consent + window + local-test simulated adapter availability; atomic `crm_messages` + `crm_outbox` + simulated delivery receipt; updates `_crm_last_outbound_at`)
- `message.retry` (**human-only** `via === 'ui'`; re-checks capability, consent, window and delivers failed draft/message via simulated adapter)
- `message.generate_ai_draft` (`crm.access`; generates draft strictly grounded in verified non-stale `crm_facts`, citing fact IDs and flagging missing/stale details `"to be confirmed"`, never sends)
- `fact.propose` (`crm.access`; creates `draft` fact)
- `fact.verify` (`crm.configure` on `programme:<slug>` or `*`; marks fact `verified` with optional `reviewBy` timestamp)
- `fact.retire` (`crm.configure` on `programme:<slug>` or `*`; marks fact `retired`)

### S9 Pipeline Project Handoff
- `opportunity.handoff_project` (`crm.access`; idempotently creates Workspace Project + bidirectional `links` + stamps `_crm_project_id` projection on Opportunity)

## 4. P1 Read Endpoints (`GET /api/crm/read/*`)

All read endpoints require `CRM_ENABLED=true`, valid active non-guest `crm.access`, run inside `withD1Budget(env, 45)`, apply `ReadGate` on synced record IDs, and return bounded responses with explicit `partial` indicators where capped:

- `GET /api/crm/read/person/:id` — canonical Person record meta, active/retired `crm_endpoints`, latest & historical `crm_consents`, open `crm_duplicate_candidates`
- `GET /api/crm/read/duplicates?state=open&cursor=` — duplicate review queue (merge remains P2)
- `GET /api/crm/read/programmes` — all 14 programme profiles + neutral policy defaults + live counts
- `GET /api/crm/read/timeline?subject=<id>&cursor=&limit=` — keyset-paginated unified relationship timeline (submissions, applications, activities, conversations/messages, approvals, linked projects/opportunities, Workspace history)
- `GET /api/crm/read/home` — My Work (`today`, `thisWeek`, `recently`) with ageing applications, due follow-ups, pending approvals waiting on actor, unanswered conversations
- `GET /api/crm/read/conversations?filter=&channel=&cursor=` — bucket counts + conversation summaries
- `GET /api/crm/read/conversation/:id` — full thread (inbound/outbound/internal notes), window status, person/endpoints/consent, relevant verified facts & stale warnings
- `GET /api/crm/read/facts?programme=&status=&includeStale=` — verified/draft/retired facts with explicit `isStale` computation
- `GET /api/crm/read/patrons` — strictly read-only Patron projections mirroring `board-website-inbox` relay events (`readOnly: true`, zero write authority)

## 5. CRM MCP Tools (`shared/aiCapabilities.ts` module `'crm'`)

Only read (`kind: 'read'`) and proposal (`kind: 'proposal'`, `approval: 'always_human'`) tools are registered:
- Read: `crm_find_people`, `crm_person_profile`, `crm_conversations`, `crm_home`, `crm_facts`
- Proposal: `crm_draft_message`, `crm_propose_triage`, `crm_propose_fact`
Side-effect tools (`message.send`, capability changes, account management) are never registered as MCP tools.
