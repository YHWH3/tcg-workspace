# TCG CRM Contract `crm-p2-v1` (P1 Hardening & S10 Reversible Contact Merge)

Status: **Active development on `crm/p2-integrity`** (extends [`crm-p1-v1`](crm-p1-v1.md) and [`crm-s0-v2`](crm-s0-v2.md) additively without altering any S0 wire invariant).

## 1. Backward Compatibility & Security Invariants

- `GET /api/crm/status` retains `contract: 'crm-s0-v2'`.
- All `collections` stay unchanged in `shared/collections.ts`; `crm_*` tables are strictly server-only.
- SC-2.2 parity: every P1/P2 read endpoint re-evaluates live session expiry, non-disablement (`disabled_at IS NULL`), canonical role (`!= 'guest'`), CRM capability grants, and `ReadGate` observed record revisions at commit/payload retrieval time (`finalizeCrmReadAuth` + inline SQL session/grant statements inside multi-statement D1 batches).
- MCP safety: `crm_draft_message` and `crm_propose_fact` route exclusively through frozen `ai_previews` requiring explicit human approval in browser (`POST /api/ai/previews/:id/decision`) and rechecking live session/role/`crm.access`/connector version at execution time (`execute_preview` runs `crm_commands` with `via: 'mcp'`). Zero unapproved sends or fact verifications exist.
- Simulated messaging (`message.send`, `message.retry`) uses SQLite transactional fences for linked-record visibility, consent non-withdrawal, active endpoint presence, window/approved template state, and `changes() = 1` rollback protection; committed sends cannot be overwritten or re-sent under a new `requestId`, and post-commit failure recovery (`recoverAfterCommitFailure`) preserves original execution channel `via`.
- My Work (`GET /api/crm/read/home`) isolates personal follow-ups to their owner (`p_f_owner` / `assigneeId`), surfaces unassigned work in an explicit `shared` bucket, uses per-programme `crm_programme_profiles.responseTargetDays`, evaluates calendar boundaries in `workspace_settings.time_zone`, and applies `ReadGate` across linked records on unanswered conversations.

## 2. Verified Person Reference Inventory (S10)

A canonical Person record (`collection = 'tasks'`, People database `db_people` / `board-website-people`) may be referenced by:

1. **Synced Workspace `records` (`applyChanges` with `RecordExpect`):**
   - Loser Person record itself (`archived: true`, `_crm_merged_into: survivorId`) and Survivor Person record (resolved field merge + `_crm_*` projections).
   - Child sub-records (`collection = 'tasks'`, `parentId = loserId`) -> repointed to `parentId = survivorId`.
   - `collection = 'links'` (`fromId = loserId` or `toId = loserId`) across all Workspace relations (Affiliations `f_person`, Applications `f_applicant`, Programmes/Projects/Experiments/Places/Opportunities/Organisations/Activities `f_people`, Meetings/Events `f_participants`/`f_facilitators`/`f_volunteers`, Media `f_credits`, Products `f_producer_person`, Works `f_works`, Website inbox `related` links, and custom relation/dependency links):
     - Recomputed deterministically via `linkId(kind, fieldId, nextFrom, nextTo)`.
     - Collisions already present on Survivor are soft-deleted on Loser and recorded for exact unmerge (`existedOnSurvivorBefore: true`).
     - Self-links where Survivor and Loser referenced each other (`nextFrom === nextTo`) are soft-deleted and recorded (`newLinkId: null`).
   - `collection = 'comments'` (`targetType = 'task'`, `targetId = loserId`) -> repointed to `survivorId`.
   - `collection = 'files'` (`parentType = 'task'`, `parentId = loserId`) -> repointed to `survivorId`.
   - `collection = 'blocks'` (`pageId = loserId`): left intact on the archived Loser record so note/page history stays inspectable, while Loser displays `_crm_merged_into` banner / canonical link.
2. **CRM Server-Only Operational Tables (`migrations/0046_crm_p1_core.sql`, `migrations/0047_crm_merge.sql`):**
   - `crm_endpoints` (`person_id`): active/retired endpoints repointed to `survivorId`; exact active normalized collisions on Survivor cause Loser's duplicate endpoint to be retired cleanly (`retired_at`), while preserving at most one active `is_primary = 1` per `(person_id, kind)` and recording exact prior states in the merge journal.
   - `crm_consents` (`person_id`): strictly append-only (`BEFORE UPDATE`/`DELETE` triggers). Never rewritten during merge or unmerge; `resolveEffectiveConsentsWithAliases()` reads `[canonicalId, ...activeAliases]` such that a pre-merge `'withdrawn'` status always blocks pre-merge `'granted'` until explicitly re-granted on Survivor *after* `effective_at`.
   - `crm_conversations` (`person_id`): repointed to `survivorId` atomically.
   - `crm_duplicate_candidates` (`person_a_id`, `person_b_id`): the merged pair transitions to `state = 'merged'`; third-party open/dismissed pairs touching Loser repoint canonically (`min(survivor, C) < max(survivor, C)`) or mark duplicate `(loser, C)` merged if `(survivor, C)` already exists.
   - `crm_person_aliases`, `crm_merges`, `crm_merge_unmerges`: canonical alias lookup, immutable merge journal, and single-reversal unmerge ledger.
3. **Workspace Server-Only Identity & Audit Tables:**
   - `form_people_keys` (`record_id`): repointed from `loserId` to `survivorId` so Form/Website ingest resolves known email keys directly to the canonical survivor.
   - `website_ingest` & `forms.ts`: replay and inbound email matching resolve `crm_person_aliases` transitively to canonical Survivor (`active`, `not deleted`, `not archived`), and also check active `crm_endpoints`.
   - `approvals` (`target_id`), `ai_suggestions` (`target_id`), `notifications`: historical/queued records are surfaced in merge preview warnings and left audit-intact (`ReadGate` & canonical profile links cover navigation).

## 3. P2 Migration & Projection Key

- `shared/crm/projection.ts`: adds `_crm_merged_into` (`CRM_PROJECTION.mergedInto`), set on the archived Loser record while merged and cleared to `null` upon unmerge.
- `migrations/0047_crm_merge.sql` (SHA-256 registered in `scripts/certification/migrations.json`):
  - `crm_person_aliases (alias_id PK, survivor_id, merge_id, effective_at, created_by, created_at)`
  - `crm_merges (id PK, survivor_id, merged_id, actor_id, command_id, moved_json, post_record_revs_json, note, created_at)` — append-only trigger protected.
  - `crm_merge_unmerges (merge_id PK FK, unmerge_id UNIQUE, actor_id, command_id, reason, created_at)` — append-only trigger protected; PK on `merge_id` prevents double-unmerge.

## 4. Merge & Unmerge Endpoints and Commands

### Read Endpoints (`GET /api/crm/read/*`)

- `GET /api/crm/read/merge-preview?survivorId=<id>&loserId=<id>`
  - Requires active session, `crm.access`, **`crm.merge` (`*`)**, and `ReadGate` read access on BOTH `survivorId` and `loserId`.
  - Returns side-by-side `fieldComparisons`, `endpointPlans`, `consentPreviews` (showing non-broadening enforcement), `referenceCounts`, `withinBudget` + `budgetReasons`, and live revisions (`rev`) for optimistic concurrency (`expected`).
- `GET /api/crm/read/merges?cursor=<id>&personId=<id>`
  - Requires active session, `crm.access`, and `crm.merge` (`*`).
  - Filters returned merges through `ReadGate` (setting `partial: true` if any involved record is unreadable) and includes `unmerged` status if present.

### Commands (`POST /api/crm/commands/:name`)

- **`person.merge`**
  - Authority: **human-only (`via === 'ui'`)** + `crm.merge` (`*`) + `crm.access` + workspace edit access on both Survivor and Loser records.
  - Input: `{ survivorId, loserId, confirm: true, fieldResolutions?, primaryEndpoints?, note? }`, with `expected: { [survivorId]: rev, [loserId]: rev }`.
  - Budget & Safety: refuses with `budget_exceeded` BEFORE writing any row if references exceed bounded single-transaction limits (`150` synced records, `50` endpoints, `100` conversations, `50` duplicate candidates, `50` form keys, `50` transitive aliases). Never performs a partial merge.
  - Atomic Execution: runs in ONE atomic `applyChanges` Records Commit Mode transaction with SQL fences checking session/role/`crm.merge`, neither record already merged (`crm_person_aliases`), unchanged endpoint/conversation/candidate counts, and `recordExpect` revisions. Records post-commit `post_record_revs_json` alongside exact moved IDs and prior state in `crm_merges`.
- **`person.unmerge`**
  - Authority: **human-only (`via === 'ui'`)** + **`crm.merge` (`*`) AND canonical role `admin` or `owner`** (`403 forbidden` otherwise, per `docs/crm/07-CONTRACTS.md` §129).
  - Input: `{ mergeId, confirm: true, reason? }` with `expected` revisions for survivor/loser.
  - Revision-Aware Conflict Checks: verifies `crm_merge_unmerges` does not already contain `mergeId`, verifies neither Survivor nor Loser has a subsequent un-reversed merge depending on it (`later_merge_depends_on_record`), and verifies Survivor/Loser revisions, moved conversation revisions, moved endpoint state/ownership, and moved link state still match `post_record_revs_json` / recorded merge state.
  - Non-destructive Conflict Refusal: if any subsequent independent edit prevents safe lossless reversal, returns `CommandError('stale', { reason: 'unmerge_conflicts', conflicts })` — NEVER silently discards or overwrites later edits.
  - Clean Reversal: atomically unarchives Loser (`archived: false`, `_crm_merged_into: null`), reverts patched Survivor fields & `_crm_*` projections, restores moved links/sub-records/comments/files/endpoints/conversations/duplicate-candidates/`form_people_keys`/aliases, and writes an immutable `crm_merge_unmerges` record.

### MCP Restrictions

- Neither `person.merge` nor `person.unmerge` is registered in `worker/crm/mcp.ts` (`worker/crm/mcp.ts` exposes read + preview-backed proposal tools only). MCP clients cannot execute merge or unmerge directly.
