# Phase 5 implementation and security review

Status: design reviewed against Phase 4; implementation in progress. This is not
a certification report. Baseline: `977475f0cac54bf05f0e5e513785c4933e0e9d73`.
The branch is `grok/phase-5-search-permissions`. Phase 4 is already merged into
main; the requested stacked PR base remains `codex/phase-4-operating-rhythm`.
No deployment, remote migration, permanent purge or merge is authorized.

## 1. Threat model and authority

Protect private titles, bodies, history, bytes, membership, search snippets,
notification metadata and derived relationships from authenticated users without
access, revoked guests, stale clients, guessed IDs and forged sync/MCP inputs.
Public share/form tokens are separate limited capabilities, not membership.
Account/session credentials are never record fields or history. Server decisions
use current D1 identity and membership, never OAuth props or client role claims.

An offline device can retain previously downloaded content. Reconciliation is
required before rendering cached content after an online login/reconnect. There
is no remote-wipe promise for disconnected devices, screenshots or exports.
An XSS, compromised OS, authorized reader copying content, or administrator
access to the underlying Cloudflare account is outside browser ACL enforcement.

## 2. Roles, default access and ownership

Workspace roles: `owner | admin | member | guest`. Space roles:
`owner | admin | editor | commenter | viewer`. Roles are distinct axes.
Workspace owner/admin can administer accounts but do not implicitly read private
spaces. Effective space role is resolved in this order:

1. Missing/disabled principal, deleted space, malformed roles: deny.
2. An explicit deny membership: deny, including a workspace owner.
3. Explicit valid membership: use that role, including a downgrade to viewer.
4. Non-guests in a space with `default_access='members'`: editor.
5. Otherwise deny. Guests never receive default access.

Guest memberships are limited to viewer/commenter/editor; a forged owner/admin
guest membership fails closed. Space admins may grant up to editor; a space
owner may grant admin. Owner transfer is a separate transaction that preserves
at least one enabled owner. Workspace promotion cannot silently grant private
space access. Removing a membership in a members-default space returns a core
member to editor; the UI offers explicit deny to revoke that default access.

Existing admins get explicit Core admin membership. The earliest existing admin
by `(created_at,id)` becomes workspace owner and Core owner; this bootstrap does
not revoke any existing rights. Other existing users retain their workspace role
and default Core editing. An empty workspace bootstraps ownership atomically
with first signup. Disabled accounts cannot own the last active ownership slot.

## 3. Authorization matrix

| Operation | Viewer | Commenter | Editor | Admin | Owner |
|---|---|---|---|---|---|
| Read live/archive/history and authorized bytes | yes | yes | yes | yes | yes |
| Create comment on readable live target | no | yes | yes | yes | yes |
| Edit/delete own comment | no | yes | yes | yes | yes |
| Edit content, archive, soft delete, restore, upload | no | no | yes | yes | yes |
| Change another author's comment | no | no | no | yes | yes |
| Manage space settings/members | no | no | no | yes | yes |
| Grant admin / transfer owner | no | no | no | no | yes |
| Delete/restore space | no | no | no | no | yes |

These are capabilities, not blanket permission to change every field. Approval
decisions still require the designated approver; notification read still requires
the recipient. Commenter patches are limited to their own comment text/deletion,
not target/author/space reassignment or an activity row as a confused deputy.
Editor cannot set membership, execution status, receipt, approval or token fields.
Cross-space moves require edit in both source and destination. Relations require
read access to both endpoints, and edits require edit at the originating record.

`canExport` additionally requires an explicit space export policy. Core retains
existing non-guest export behavior; newly private spaces default to disabled bulk
export until owner policy is accepted. A guest grant does not authorize exporting
revoked work. Permanent purge is disabled for every role in Phase 5.

## 4. Additive schema and migration contracts

Do not rebuild `users`: migration 0001 has a CHECK on the legacy role and sessions
reference users with ON DELETE CASCADE. D1 deferring foreign keys does not disable
cascade actions. Add `users.workspace_role` (nullable CHECK of the four new roles)
and `users.disabled_at`. The effective role is `COALESCE(workspace_role,role)`;
NULL preserves old fixtures/new legacy inserts. Preserve `users.role` as the
compatibility column (`owner/admin -> admin`, `member/guest -> member`). All new
authority checks use the effective role. New APIs return `workspaceRole` alongside
legacy `role`; compatibility is presentation, never a second authority.

Foundation migration 0012:

```sql
spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL,
       default_access TEXT CHECK(default_access IN ('members','private')),
       export_policy TEXT CHECK(export_policy IN ('members','disabled')),
       deleted_at INTEGER, created_by TEXT, created_at INTEGER NOT NULL);
space_members(space_id TEXT REFERENCES spaces(id),
              user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
              role TEXT CHECK(role IN ('owner','admin','editor','commenter','viewer')),
              access TEXT CHECK(access IN ('allow','deny')),
              PRIMARY KEY(space_id,user_id));
access_state(id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL,
             enabled INTEGER CHECK(enabled IN (0,1)));
```

Add `records.space_id TEXT NOT NULL DEFAULT 'space-core'` and
`INDEX records(space_id,seq)`. Actual populated-D1 migration tests reject adding
a REFERENCES column with a non-NULL default. Enforce the space reference with
BEFORE INSERT/UPDATE triggers and reject deletion of a referenced space, avoiding
a records-table rebuild that could disturb the existing integrity triggers.
Backfill all existing records, including tombstones,
into Core without changing JSON, field timestamps, seq, history, file references,
event outbox, leases or receipts. Space membership/space access/user role/disabled
changes increment a global access generation through D1 triggers. With seven
seats this bounds reconciliation complexity and avoids a per-user-record eviction
explosion. Generations are monotonically increasing, never reset on regrant.

Migration 0013 extends the epoch contract to activated record visibility:
ancestor deletion/restoration, ownership/reference changes and physical removal
invalidate incremental caches even when `records.space_id` stays unchanged.
Updates to titles/body alone do not change access generation. Activation changes
also increment generation, so an epoch cannot be reused across protocol changes.
These triggers are atomic with the underlying write. With activation off, record
visibility triggers preserve the existing Core-only behavior. The migration
does not enable permissions or destructive purging.

`access_state.enabled=0` is the migration default. This is an implementation
barrier, not a finished feature flag: do not expose guest creation or turn on
permissions until all read/write paths, client protocol and regression suites
are integrated. Old code remains safe only in this Core-only intermediate state.
Activation is a local migration/explicit reviewed transition, never a client API.
An enabled server rejects old sync protocols with `426 permission_protocol_required`.

Further migrations add (with CHECKs, indexes and exact hashes in the certification
manifest): `space_invites`, `access_audit`, snapshot sessions/items, durable move
jobs/items, session metadata, `record_history`, search document/dirty tables and
FTS5. No secret invite/token value is inserted in generic records/history.
Access audit rows also carry a bounded request_id and args_hash, unique per
actor/request. Space creation and membership changes commit audit, epoch and
state together, recover lost acknowledgements and reauthorize result replay.

## 5. Inheritance, movement and concurrent writes

The authoritative graph is pages.parentId, blocks.pageId (page OR record body),
tasks.boardId (missing -> default board), comments.targetType/targetId,
files.parentType/parentId, views.databaseId, mooditems.boardId,
automations.databaseId and forms.databaseId. Activity inherits its target;
targetless legacy workspace activity is Core-only. Child spaceId from a request
is ignored as authority. Parent type/collection is checked; missing parent,
cycles, unknown configuration and incompatible ownership fail closed. Roots
(pages with no parent, boards, moodboards) can select an authorized destination.
Links carry both endpoint checks; the link's denormalized origin does not confer
visibility of the other endpoint. Unattached upload bytes are uploader-only until
authorized metadata/claim transfer commits. Public form pending uploads use the
existing claim capability and are not available through ordinary guest sync.

Authorization is resolved before planning, then fenced in the SAME D1 batch as
record CAS, journal, outbox and checkpoints. A generation or identity mismatch
aborts the transaction and triggers reauthorization. Checking before await and
then committing unguarded is insufficient. Replayed idempotency results are also
reauthorized before return; cached tool results must not disclose revoked data.

Moving a root/subtree is an explicit operation. Freeze descendant IDs and old
revisions in a durable move job with a single recursive SQL INSERT SELECT;
exclude locked job items from reads, writes, search, public reads and jobs while
bounded batches rewrite inherited scope. New descendants cannot attach to locked
parents. Journal each committed batch; resume by checkpoint, never recompute a
different plan after partial progress. Recheck destination/source rights per
batch. Finish by incrementing generation and unlocking atomically. If authority
is revoked mid-move, hold the locked job for authorized recovery, never publish
partially scoped data. Small parent moves use the same contract. This avoids
stale denormalized child permissions during large moves. Normal content updates
do not run a workspace-wide subtree scan.

## 6. Enforcement inventory

| Surface | Required authorization |
|---|---|
| `worker/access.ts`, `shared/access.ts` | Current principal, effective role, pure capabilities, SQL predicates, generation fence |
| `worker/recordAccess.ts`, `shared/recordScope.ts` | Bounded indexed ancestor loading, true inherited scope, cross-endpoint reads, graph/epoch race rejection |
| `worker/spaces.ts` | Atomic audited membership/create services, grant ceilings, last-owner guard, idempotent replay |
| `worker/sync.ts` applyChanges | Every actor/write including MCP/undo/jobs, parent and protected fields, old/new scopes, atomic fence |
| `worker/records.ts` | Explicit request access context for reads; unrestricted helpers clearly named and confined to maintenance |
| `worker/mcp.ts` | Fresh principal per request; rec/recs/caches AND raw search/backlink/mood/changeset/share SQL; dry-run, replay and errors |
| `worker/files.ts`, `remotefile.ts` | Read through authorized live reference; write through editable owner/parent; uploader capability before metadata |
| `worker/public.ts`, `publicAccess.ts`, `shares.ts` | Publisher still authorized; explicit share tree boundary; no accidental cross-space embed expansion |
| `worker/forms.ts`, `automations.ts`, `events.ts`, `reminders.ts` | Creator/service scope rechecked at execution and resume; destination and recipients checked |
| `worker/notifications.ts`, `approvals.ts` | Recipient/approver AND current target read; hide titles, counts and previews on lost access |
| `worker/changesets.ts`, history | Current record rights in addition to existing changeset-owner/admin rule; no hidden before/after/summary |
| `worker/live.ts` | Revalidate sessions/access on messages/alarms/poke; authorized presence/routes only; no global private path broadcast |
| `worker/admin.ts`, `auth.ts`, OAuth | Workspace management separate from content; guests see only shared-space directory; disabled user rejected everywhere |

No generic SQL-text rewriting proxy, implicit admin bypass, or module-level
request cache. Background work uses an explicit actor/capability tied to the
stored configuration and current permission, not a caller-supplied system flag.
Public form services can write only the configured form output and claim-owned
uploads, not arbitrary records. Recovery rejection is durably recorded and does
not endlessly consume Cron quota. An approver losing read access cannot decide.

## 7. Sync API and eviction/reset protocol

Protocol 2 begins every online sync cycle with `GET /api/access` before any push,
upload, local search or cached view exposure. Response:

```ts
type AccessManifest = {
  protocol: 2; userId: string; generation: number;
  spaces: { id: string; name: string; role: SpaceRole; exportPolicy: ExportPolicy }[];
};
type PullV2 = {
  protocol: 2; generation: number; records: PulledRecord[];
  cursor: number; hasMore: boolean;
};
```

Pull takes generation and since; validates identity and current generation. SQL
filters before materializing rows/snippets/counts. The global seq cursor advances
across invisible gaps to a captured high-water mark; an empty visible page cannot
stall forever. Concurrent generation changes return `409 access_reset_required`,
never mixed data. Source deletions remain tombstones for readable scopes.

The incremental implementation uses an indexed scope prefilter for ID/sequence
candidates, then resolves actual ancestry and both relation endpoints before
content fetch. A stale denormalized scope cannot grant read access. Each request
examines at most 500 candidates and advances past invisible candidates as well;
it can return an empty page with `hasMore=true`. At the end it advances to the
coherently captured global high-water mark. The client must persist the cursor
even on an empty page. Unexpected SQL errors remain failures; an epoch-fence
rollback becomes an explicit 409 reset. Every final page, including an empty
one, rechecks authority before publication.

Generation mismatch invalidates incremental state. Use an authorized, bounded,
durable snapshot session tied to user+generation, with a fixed cutoff and frozen
snapshot items. Pages max 500; continuation binds snapshot identity, never a
client-selected SQL offset. A changed generation invalidates the snapshot. Stage
snapshot in account-bound Dexie storage; after all pages, atomically replace
synced collections, apply pending *still authorized* changes, install cursor and
generation, and reconcile drafts/media. A crash leaves either the prior gated
cache or the complete new cache, not a partially trusted visible snapshot.
Resume/restart expired snapshots safely. Incremental catchup follows the cutoff.

Migration 0014 stores ephemeral `sync_snapshots` and `sync_snapshot_items`, with
account/request identity, generation, fixed cutoff, page size, expiry and a
server-only continuation signing key. `POST /api/sync/snapshot` takes protocol,
generation, requestId and pageSize (1–500). SQL freezes scoped candidates and
the cutoff in one transaction; no partially captured session can be returned.
`GET /api/sync/snapshot/:id?cursor=` authenticates the account, verifies the HMAC
continuation and rechecks current ancestry/endpoints before publishing frozen
payloads. Content updates after the cutoff arrive in incremental catchup. Access
changes invalidate the whole session. Each page fences both permission generation
and continued existence/expiry of the snapshot, including empty final pages.

Starts recover by the unique account/request key after a lost response;
different page sizes/generations cannot reuse that request. Replaying a cursor
returns the same frozen page while its generation remains current. Sessions last
15 minutes; two active copies per account, at most 20,000 candidate records /
16 MiB payload per copy and 32 MiB aggregate snapshot payload. These are explicit
local resource safety bounds, not seat/pricing policy. Exceeding them rolls back
the complete capture and returns 413/429, never a truncated success. Expired
ephemeral copies are pruned on snapshot creation; periodic bounded cleanup is
still to be wired into Phase 5 maintenance. Account-owned cancellation removes
only the ephemeral copy and its items, never records/history/media.

This generation/snapshot protocol replaces the proposal's record eviction feed:
a finite feed alone cannot prove eviction completeness after stale cursors,
moves or deleted eviction history. Regrant necessarily obtains a newer snapshot;
old eviction messages cannot hide newly authorized data. Membership writes and
snapshot publication are fenced by generation to handle concurrent revocation.

Push includes protocol+generation and retains existing item-level acknowledgments:
`{id,collection,reason:'access_revoked'|'read_only'|'parent_unavailable'|...}`.
Do not acknowledge rejected entries. Unrelated authorized edits continue. Lost
responses replay existing LWW/idempotency behavior, not duplicate mutations.

## 8. Client cache, offline and account/session state

Keep the existing `workspace-<uid>` Dexie database, same-account mutation guard,
account-switch confirmation and close-before-credential-switch ordering. Add
access manifest, snapshot staging and rejected-operation metadata to version 7.

The version-7 cache layer (`src/core/sync/accessCache.ts`) stages pages in
`syncStage`, separately from live collections. Each page validates descriptor,
account, collection, cutoff, authoritative scope and exact replay identity.
Activation verifies the complete canonical graph against the current manifest,
then atomically replaces collections, replays still-authorized pending writes,
installs cutoff/manifest and removes staging metadata. A crash rolls back all
of these changes, including quarantine and blob removal. Protocol-2 records
carry server-resolved `spaceId`; local `_spaceId` and `_serverRev` are cache
metadata, never accepted server authorization input.

Unconfirmed/revoked pending writes, inaccessible drafts and pending bytes move
to the account's `accessQuarantine` table. Cached revoked media/thumbnail bytes
are removed; still-authorized unsynced creations require local `createIntent`
evidence and a resolvable authorized parent graph. Old pending work without
creation evidence is retained for review instead of guessed to be a new record.
Quarantined payloads never enter normal record queries, the outbox uploader,
draft loaders or existing backup/export tables. Client orchestration, UI states,
multi-tab locking, blob URL invalidation and creation-intent capture still need
integration before this cache layer can enforce the complete reconnect contract.

An online app starts `checking-access`, withholding private mounted views/search
until reconciliation. Offline previously reconciled users may use the retained
authorized snapshot with an explicit stale/offline status. Going online gates
again before requests/uploads. An authenticated server error is not an offline
permission grant. A 401 drops credentials, closes WS and locks the UI while
retaining account-owned pending work.

Eviction clears unauthorized rows, derived previews, users directory entries,
file/thumbnail blobs, in-memory object URLs, result caches and open detail/history
views in one controlled transition. Authenticated file responses use no-store;
service worker never caches API responses. Other tabs receive a generation/lock
signal; each revalidates before presenting data. A stale tab cannot mutate or
send under a replaced identity. WS events are hints, not authorization evidence.

Revoked pending edits become non-retryable access-rejected entries. UI shows
operation type and reason without disclosing the revoked title/body. Sensitive
payloads are quarantined in the same account's non-rendered storage; no automatic
export, generic retry, search indexing or account-switch export of quarantined
content. Regrant may reauthorize recovery; explicit discard removes it locally.
Retention/export of inaccessible pending payloads is an unresolved owner privacy
policy: those recovery/export controls stay disabled, with a clear explanation.
Do not silently classify retained edits as synced or discard them on logout.

Sessions gain opaque `id`, user-agent/device label, last_seen_at (bounded update
frequency), created/expires times. No token/hash in the session-list response.
`GET /api/sessions`, `DELETE /api/sessions/:id`, `DELETE /api/sessions/others`;
only session owner can revoke. Existing hashes/TTLs remain valid. OAuth grants
remain separate and existing refresh/revoke tests remain mandatory. Revoked WS
credentials cannot continue presence/read delivery; alarms and access mutations
close stale connections. Multi-tab logout propagates immediately when connected.

## 9. Search and leakage controls

FTS5 availability was executed in disposable local Miniflare/D1 on 2026-10-15
(`tests/phase5-runtime-d1.test.ts`): prefix MATCH, bm25, snippet and SQL space
filtering work. Official D1 documents list FTS5 as supported. Keep authoritative
`search_documents(record_id PRIMARY KEY, collection, space_id, database_id,
title, body, source_rev)` outside the virtual table; FTS is reconstructible.
No backup workflow may depend on exporting an FTS virtual table.

Mutation batches atomically enqueue/replace a dirty record/parent search key;
index processor reloads current authoritative content+scope, updates documents
and FTS in one batch with revision/generation guards, then deletes dirty key only
if unchanged. Retry after interruption; delete/archive removes searchable output.
Page/record bodies aggregate bounded text from authorized same-scope blocks,
record text/custom fields, comments, filenames and mood text. Derived title/body
never crosses an unreadable related record. Index lag is exposed as indexing
pending, not a false claim that no data exists. Dirty stale documents must not
return stale revoked/deleted text while waiting for rebuild.

`GET /api/search?q=&type=&database=&space=&cursor=&limit=` returns at most 50
authorized results, a generation-bound opaque continuation and hasMore, no global
total or raw rank/timing/debug counters. Query tokens are escaped literals with
bounded prefix matching; no raw MATCH syntax or SQL accepted. Rank only over the
authorized corpus (global bm25 statistics can otherwise influence visible rank
when hidden documents change). A bounded authorization-filtered candidate table
or per-space corpus must be measured; the runtime probe proves basic FTS support,
not this stronger leakage property. MCP search shares the same service.

The command palette merges local authorized and online results by record ID,
preserves keyboard selection, marks offline/pending, offers space/type/database
filters, errors/retry and phone full-screen reflow. No hidden hit counts,
suggestions or restricted titles from old local indexes. Hidden mentions render
a neutral unavailable chip; explicit-ID lookup and backlinks return no secret
title, database or existence detail. Permissions filter BEFORE pagination.

## 10. Guest invitations and spaces UI

Create bounded cryptographic invite tokens; store only hash, space, allowed role,
issuer, expiry, revoked/accepted user/timestamps. Acceptance checks current issuer
membership, enabled space/account, expiry, role ceiling and seven-seat capacity
inside the same transaction. Existing account acceptance does not consume a new
seat. Concurrent signup/accept cannot exceed seven; same-account replay is
idempotent, another account cannot reuse. Missing/expired/revoked tokens return a
generic unavailable response. Guest creation is never possible through a plain
workspace member invite. Revoking the invite does not secretly change accepted
membership; UI offers separate membership revoke.

Space switcher/settings, create, members, grant/change/remove/deny and invitations
use shared dialogs/sheets, descriptive role capabilities, read-only states and
visible confirmations. Mobile operations require no hover/drag. Public link and
authenticated invitation controls are clearly separate. Navigation lists only
readable roots. Owners cannot remove the last owner by concurrent requests.

## 11. History and revision-safe restoration

`record_history(id,record_id,collection,revision,actor_id,source,changed_fields,
before_json,after_json,created_at,changeset_id)` with UNIQUE(record_id,revision)
and index(record_id,revision DESC). Insert in the existing successful applyChanges
batch with journal/outbox; rejected/no-op/CAS-failed writes produce no history.
Field allowlists exclude uploadClaimHash, tokens, secrets and transient protected
fields; binary content is referenced, not snapshotted. History visibility always
follows CURRENT record access, not historical membership or changeset ownership.

`GET /api/history/:recordId?before=&limit=` (max 50) and
`POST /api/history/:recordId/restore {historyId,fields,expectedRev,requestId}`.
Server verifies history ownership, permitted fields, current edit and restore
capability, then calls applyChanges with expect+journal. Return 409 on newer edit;
preview never silently overwrites. Restore is a new auditable mutation, and can
be undone through existing durable changesets. Preserve 500-item undo/fences and
MCP frozen chunk retries. UI contextual History on pages/records is paginated,
shows actor/time/diff/preview/conflict and restores focus on close.

Retention: measure growth and expose policy status; do not automatically prune
the proposal's 180-day/50-revision policy without owner acceptance. Text limits
and bounded read pages prevent oversized UI responses; no unbounded binary copy.
Purge/automatic destructive retention remain disabled, not silently implemented.

## 12. Scale and D1 budgets

`GET /api/admin/usage` owner/admin only: aggregate record/space/history/search
counts, page_count*page_size estimate, complete-file bytes and pending jobs.
Label estimates/local durations; don't expose global usage to guests. Normal
lookup/push preflight loads bounded ID/space sets with JSON batching rather than
one query per candidate. Preserve Phase 4 45-call Cron budget; include access
checks/guards in its counter. No new per-candidate configuration full scans.

Client media cache evicts only downloaded uploaded/cached blobs with no pending
references; never pending/failed uploads or authorized unsynced records. Indexed
cache metadata uses LRU/bytes. Lazy archive reads are authorized paginated APIs;
archived roots remain discoverable/restorable. Offline snapshot availability is
honest. Eviction of revoked bytes takes priority over cache retention. File
ownership/reference cleanup and 1 MiB chunks retain Phase 4 semantics.

## 13. Failure states and recovery

| Failure | Required durable outcome |
|---|---|
| Generation changes during read/write/snapshot | abort/re-authorize/reset; never publish mixed authority |
| Snapshot fetch/storage crash | visible cache stays locked until complete atomic activation |
| Lost push/restore/invite response | same principal/idempotency identity, no duplicate effects |
| Revoked offline write/upload | specific non-retryable rejection; no cross-account retry/export |
| Search processor interruption | dirty key retained; no stale secret snippet |
| Move interruption/revoked actor | locked durable plan resumes through authorized recovery |
| Role invalid/missing parent/legacy protocol | deny with bounded error; no permissive fallback |
| History/index batch failure | rollback or durable dirty work; no unaudited successful write |
| Offline/session expiration | truthful lock/offline state, account-owned pending work preserved |

## 14. Design review and deviations from the proposal

Review performed before migration/runtime changes, 2026-10-15:

- Additive role column avoids deleting sessions through a users-table rebuild.
- Workspace administration is not implicit private-content authority.
- Explicit denies/downgrades avoid default-access accidentally overriding revocation.
- Generation-bound snapshot replaces an incomplete/unbounded record eviction log.
- Authorization fencing complements existing record CAS and execution leases.
- Direct SQL, replay caches, notifications and WS paths require review as well as sync.
- Search ranking must not expose hidden-corpus statistics; FTS support alone is insufficient.
- Existing account-bound Dexie and item-level rejected writes are extended, not replaced.
- New history uses the atomic write path; durable undo remains unchanged in principle.
- No expanded seats/pricing, automatic purge, new paid service or production operation.

Technical review conclusion: these contracts support incremental implementation
with activation disabled until every enforcement path is covered. They are not
owner acceptance of private-space export or revoked-payload retention policy.
Those capabilities remain restricted as described above. Revisit this review if
implementation evidence requires a protocol/schema deviation.

## 15. File and test delivery manifest

The pure inheritance planner in `shared/recordScope.ts` covers the actual Phase 4
field names and does not consume data.spaceId as authority. Its input rootSpaceId
must come from server storage or an independently authorized move. Dependencies
must be loaded before use; its cycle/depth checks fail closed (64 traversal
levels per resolution). This is not yet integrated route enforcement.

P5-0: this document, runtime FTS probe, shared capability contract/tests.
P5-1: migration 0012, manifest hash, worker/access.ts, migration+role+inheritance
actual-D1 tests. P5-2: sync, records, auth, live, files, MCP, public access,
notifications/approvals/jobs, client db/auth/sync/files/shell/resolvers and move
recovery tests. P5-3: search service/index processor/dirty migration, MCP+palette,
1000-record authorized search tests. P5-4: spaces/invites/sessions APIs, UI/routes,
OAuth disabled-user checks and three-engine guest/session journeys. P5-5: history
migration/write integration/API/UI and usage/cache/retention controls. P5-6:
extend certification manifest/orchestrator, adversarial and responsive journeys,
review ledger and evidence-backed draft/ready PR. Preserve certify:phase4;
certify:phase5 runs all applicable old gates plus new mandatory assertions.

Pure tests exhaust workspace/space/membership combinations, invalid identities,
own-comment fields, export/move/owner transfer. Actual D1 tests cover fresh and
upgrade preserving users/sessions/leases/receipts, unauthorized push/read, epoch
races, lost responses, inheritance and 1000-record costs. Real Worker tests cover
REST/MCP/files/public scopes, history, session+OAuth invalidation and invitations.
Browser tests inspect both IndexedDB and D1 for online/offline revoke, restart,
different account, multi-tab, hidden moves, regrant, stale cursor, snapshot crash,
failed pull and pending uploads; desktop/tablet/phone on Chromium/Firefox/WebKit.

Use existing fixtures and fail-closed adapters, exact committed SHA/fingerprint,
logs/screenshots/traces, commands/exits/mandatory counts, audit and performance
evidence. New tests must be in the actual certification manifest, not just present
on disk. No test weakening or historical Phase 4 result reused for new source.

## 16. Responsive/accessibility and external acceptance

Shared Dialog/Sheet focus trap, accessible names, keyboard navigation, focus
restoration, touch targets, reduced motion, 320/390px reflow, tablet portrait and
landscape and desktop apply to every new flow. Announce access loss without
speaking secret titles; move focus from evicted content to a neutral access state.
Real iPhone/iPad Safari, Android, human VoiceOver/TalkBack and native 400% zoom
remain NOT RUN until physical/manual evidence exists. Automated WebKit is not
physical Safari. All unfinished Phase 5 work remains explicitly incomplete.

References checked 2026-10-15:
[D1 SQL/FTS5 support](https://developers.cloudflare.com/d1/sql-api/sql-statements/),
[D1 foreign-key and cascade behavior](https://developers.cloudflare.com/d1/sql-api/foreign-keys/).
