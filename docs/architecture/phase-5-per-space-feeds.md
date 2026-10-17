# Phase 5 — per-space feed protocol (v3): baseline, security/concurrency review, amended specification

Status: **normative for implementation; activation stays off.** The owner approved
adopting the per-space reconciliation direction of
[`phase-5-design-review.md`](phase-5-design-review.md) §4 on 2026-10-16. This document

1. records the unchanged baseline (`4d8e15a`) evidence that was missing from the
   completed certification (§1),
2. reviews that §4 design for security and concurrency *before* it is built and lists
   every flaw found (§2),
3. is the amended, implementation-ready specification (§3), and
4. maps every proof obligation to a mandatory test (§4).

It does not enable permissions for real users, deploy, merge, or begin Phase 6.
`access_state.enabled` keeps its migration default of `0`; tests enable it only in
disposable fixtures. Unrelated owner-policy decisions remain explicitly pending (§6).

## 1. Baseline evidence at `4d8e15a` (nothing modified)

### 1.1 `scripts/verify-phase5-sync.mjs` is not a passing gate

The script was not in the certification matrix. Run on the clean, unchanged tree
(raw sanitized record:
[`evidence/baseline-4d8e15a-verify-phase5-sync-summary.json`](../reviews/evidence/baseline-4d8e15a-verify-phase5-sync-summary.json)):

| Run | Chromium 153 | Firefox 155 | WebKit 26.6 | Exit |
|---|---|---|---|---|
| A — `CERT_ARTIFACT_DIR` set (how the harness runs browser suites) | 8/9; journey 9 `tracing.start: Tracing has been already started` | 8/9; same | journey 1 PASS, journey 2 crashed the runner (`unhandledRejection: route.continue: Route is already handled!`, then `Target page, context or browser has been closed`); journeys 3–9 never ran | 2 |
| B — standalone, `--skip-build` | 9/9 | 9/9 | journey 1 FAIL: `'' !== 'webkit Core reference'` | 1 |
| WebKit-only ×3 | — | — | PASS 9/9; journey 1 FAIL; journey 1 FAIL | 0 / 1 / 1 |

Accurate reading of the evidence (no product defect is established by it):

- **Harness defect 1 (deterministic):** `reporter.trackBrowser()` already starts tracing on
  every context when `CERT_ARTIFACT_DIR` is set; journey 9 starts it again. The suite can
  never pass under the certification harness as written.
- **Harness defect 2 (flaky, WebKit):** journey 1 reads `inputValue()` right after the
  element becomes visible, before Dexie hydrates it. WebKit lost this race in 3 of 5
  executions; Chromium/Firefox won it in all 4.
- **Harness defect 3 (flaky, WebKit):** the `**/api/access` gate handler can reach
  `route.continue()` after the route was handled; the rejection is unhandled and aborts the
  runner. Root cause not determined; the fix is to make the handler idempotent.
- Journeys 1–8 pass on Chromium and Firefox in both runs; journey 9 passes standalone.

These are fixed as part of making the suite a mandatory gate (§4); they are listed here so
the later green result is not mistaken for the baseline.

### 1.2 D1 cost of the draft's generation + snapshot protocol (measured)

Actual Miniflare D1, harness
[`evidence/baseline-4d8e15a-snapshot-cost.test.ts`](../reviews/evidence/baseline-4d8e15a-snapshot-cost.test.ts)
(valid only at that commit), results
[`evidence/baseline-4d8e15a-snapshot-cost.json`](../reviews/evidence/baseline-4d8e15a-snapshot-cost.json).
`meta.rows_written` includes index entries, exactly as D1 meters it.

| Operation (readable records N) | N=500 | N=1,000 | N=2,000 | Scales with N |
|---|---:|---:|---:|---|
| Another user's ordinary **logout**: rows written | 3 | 3 | 3 | no |
| …effect on every other client's next pull | HTTP 409 `access_reset_required` | same | same | yes — all clients |
| One client's **snapshot creation**: rows written | 1,505 | 3,005 | 6,005 | ≈ 3N + 5 |
| …rows read | 3,025 | 6,025 | 12,025 | ≈ 6N |
| …snapshot read-out: rows read (writes 0) | 5,023 | 10,047 | 20,095 | ≈ 10N |
| One **soft-delete push**: rows written | 18 | 18 | 18 | no |
| …effect: `access_state.generation` | +1 | +1 | +1 | forces every client to re-snapshot |
| Expiry pruning of the old copy + a new snapshot: rows written | 2,006 | 4,006 | 8,006 | ≈ 4N per reconciliation |

Consequences: one reconciliation of a 5,000-record workspace writes ≈ 20,000 rows
(create ≈ 15,000 + expiry ≈ 5,000) — 20 % of the free plan's 100,000 rows/day — and any
user's logout or any delete triggers it for **every** online client. The design review's
§4.8 estimate (2N per reconciliation) understated the draft: measured cost is ≈ 4N.

## 2. Review of the proposed protocol (design review §4)

Method: every channel through which a client's cache or a write's authority can diverge
from the server was enumerated and attacked with an interleaving (revoke, regrant, move,
ancestor delete/restore, retarget, prune, crash, concurrent write, stale cursor, forged
input). Severity is for the activated system. Each finding has an amendment (§3) and a
mandatory proof (§4).

| ID | Sev | Flaw in §4 as written | Amendment |
|---|---|---|---|
| FD-01 | **High** | **Undefined join semantics.** §4.4/§4.5 backfill a joining space up to a `cutoff` and say later changes "arrive through the steady-state feed" without saying whether that feed includes the joining space. If it does (the server derives the readable set itself), partially staged rows are written into live tables unless every client routes them — a client-side invariant the server cannot check, and a break of stage → verify → activate. If it does not (the natural client: pull only activated spaces), a change committed after `cutoff` is lost, because the shared cursor advances past it and the staged copy never sees it. | One cursor **per space** with an explicit `joining` list. A backfill is an ordinary pull with `after` for the joining space, delivered by its own scan and never mixed into the shared-cursor statement; no cutoff. A merged ascending scan advances every cursor together, and a space activates only when its cursor has caught up. |
| FD-02 | **High** | **Cross-space links are never re-delivered.** A link is readable only if both endpoint spaces are; its own `seq` does not change when the *other* endpoint's space is regranted, so neither feed resends it. §4.4 says "re-pull links whose other endpoint is in S" but defines no query (the home-space index cannot find them). | `records.peer_space_id` (the other endpoint's space), partial index `(peer_space_id, seq)`; a joining scan of S also selects `peer_space_id = S`. Retargeting a link emits evictions for its previous audience; the client garbage-collects links whose endpoint is gone. |
| FD-03 | **High** | **Check-then-read.** The manifest and the candidate rows are read in separate statements, so a caller revoked in between receives a page computed with the old readable set. | One D1 batch per pull: the manifest statement plus candidate statements whose predicate embeds the caller's *current* effective level (the same SQL as the write fence). The etag is compared after the batch; rows from a mismatching snapshot are discarded. |
| FD-04 | Medium | **Eviction ordering.** Events share the record cursor domain, so an event and a record row can carry the same `seq` and straddle a page boundary; and an old `evict` arriving after a newer row (record moved out and back) would delete live data. | Events carry `rev` = the moved row's new `seq`. The client evicts only if its local `_serverRev < rev` — order-independent and idempotent. The pager never splits an equal-`seq` group. |
| FD-05 | **High** | **Ancestor visibility.** The kernel hides descendants of a soft-deleted ancestor. A client that joins while a page is deleted never receives its descendants, and a restore re-delivers only the page (descendant `seq` unchanged). The draft hid this by bumping the global generation on every `deleted`/`parentId` change. | The sync feed delivers every row of a readable space, including tombstones and descendants of deleted ancestors (soft-deleted content stays readable to the space's readers — the trash model). `readAuthorizedRecords` gains `includeAncestorDeleted` (default `false`; all other callers unchanged). |
| FD-06 | Medium | **Client-named spaces.** Per-space statements are built from client input. | The server never trusts the list: every statement carries the readable predicate; unreadable names yield no rows; ≤ 50 joining spaces per request. |
| FD-07 | Medium | **Cursor sanity.** A cursor ahead of the database (restore) or older than a space's retained events cannot be proven complete. | `409 cursor_ahead` (re-backfill everything); `409 rebackfill_required {spaces}` (that space only). The client keeps visible rows until the refreshed set activates, then sweeps rows not re-delivered. |
| FD-08 | **High** | **Silent loss of the kernel's consistency token.** `loadScopeGraph`, `readAuthorizedRecords`, `authorizeMutations`, `writeAuthorityFences`, `fileBatch`, `spaces.ts` and `syncAccess` all compare `access_state.generation` between reads or against a fence. Removing the triggers (§4.7) silently disables every one of those checks. | Replace each with a **capability fence** (caller's effective level per touched space, workspace role, enabled flag, evaluated inside the batch) plus the existing per-record revision fences. Every existing "fails closed under concurrent revocation" test keeps its assertion. |
| FD-09 | Medium | **Thumbnail protection.** `p5_file_aux_visibility` bumped the generation when a `thumbId` changed so clients discarded cached auxiliary bytes. | Server ownership checks are untouched. The client discards cached auxiliary bytes whenever a pulled file row's `thumbId` changes or the row is evicted. |
| FD-10 | Medium | **Legacy cache upgrade.** Pre-activation cache rows have no `_spaceId`; they cannot be kept per space. | While unscoped rows exist, activation is all-or-nothing: every space activates in one transaction that also removes the unscoped rows (the draft's crash-safe whole-cache swap, once). |
| FD-11 | Low | **`spaceEpoch` has no consumer.** Effective roles already change when default access/deletion change. | Dropped. The etag covers `{userId, workspaceRole, spaces[id, name, role, exportPolicy]}`. |
| FD-12 | Medium | **Merged paging cost/correctness.** A single multi-space `ORDER BY seq` statement is O(matching rows) per page; per-space cursors need a correctness argument for the merged page. | Settled spaces (one shared cursor) use the draft's single `IN` statement; each joining space gets its own ≤ 501-row index range scan. Proof: every row among the first `limit` of the true stream is among the first 501 of its space, so the first `limit` of the union equals the first `limit` of the stream. |
| FD-13 | Low–Med | **Retention.** Pruning events and raising the floor must be atomic and bounded. | One batch: bounded `DELETE` plus the `events_floor` raise from the same bounded set, in the scheduled sweep. |
| FD-14 | **High** | **There is no move.** `explicit_move_required` has no executor in the draft, so events, `peer_space_id` and descendant re-stamping are unreachable and cross-space behavior is untestable. | Specify and implement the move (§3.6): closure rewrite, distinct seq allocation, events by trigger, incident-link recomputation, atomic and bounded. |
| FD-15 | Low | **Push and the etag.** Authorization is by current server state; a stale etag must not become an authorization input or a stuck outbox. | Push never fails on etag; its reply carries `accessEtag` and the client reconciles on difference. |
| FD-16 | Low | **Activation flip between plan and commit is unfenced on the disabled path** (unchanged from today). | Documented limit: activation is a maintenance-window migration. The enabled flag is part of the capability fence on the enabled path. |
| FD-17 | **Med–High** | **Sequence regression after a hard delete.** `records.seq` is allocated as `MAX(seq)+1` (only in `flushPlans`). The two hard deletes of record rows — abandoned public-upload cleanup (`forms.ts`) and the 24 h orphan sweep (`reminders.ts`) — can remove the current maximum, so the next write reuses a value a client's cursor already passed and is never delivered. Pull cursors jump to the high-water mark, which includes rows no client ever receives (service-only pending uploads), so the exposure is real in an idle workspace; it pre-exists in the legacy pull whenever the removed row was delivered. | `seq_floor` (one row) raised by an `AFTER DELETE ON records` trigger; allocation is `MAX(max(seq), floor) + 1`; high-water reads include the floor. |
| FD-18 | Medium | **Event identity and tie groups.** One write emits events for both a link's old home and old peer with the same `rev`, so `seq` alone cannot be the key; and an equal-`seq` group (record row + up to two events) can exceed two items. | `space_events` is keyed `(space_id, seq)`; the pager drops a trailing equal-`seq` group of any size and rejects `limit < 8`. |
| FD-19 | Medium | **Migration tooling constraints.** SQLite forbids `WITH` inside a trigger body; the actual-D1 test fixtures split migrations at the first `END;` and strip `--` comments even inside string literals; `wrangler d1 migrations apply` splits differently again. | Migration 0017 uses plain trigger bodies and no `--` inside literals, and is applied through both the fixture splitter and `wrangler d1 migrations apply` by mandatory tests. |
| FD-20 | Medium | **Downgrade guard.** The literal `2` is hard-coded in five client and three server modules (`accessClient`, `files`, `accessCache`, `reconcileAccess`, `engine`; `sync`, `syncAccess`, `syncSnapshot`). A partial update would reject a v3 manifest or treat it as ungated legacy. | One shared `PERMISSION_PROTOCOL` constant; a test proves that a stored v3 manifest plus a protocol-1 response is refused and that every site speaks 3. |
| FD-21 | **High** | **Backfill restart livelock** (found by the randomized proof, not by review). The first draft of the retention rule flagged a resumed backfill whenever its cursor was below a space's floor, but a backfill restarted *because* of the floor is by construction below it until it has paged past: it was told to restart again, forever. | A restartable scan is judged by `base`, the database high-water mark of its FIRST response (fixed by the server, echoed back, `0` before the first page): only a floor that passed the base can have hidden a fact about a row the scan already staged. A scan from 0 or one merely short of the floor is never stale. |

Findings that did **not** need a change: the capability decisions
(`effectiveSpaceRole`, deny precedence, guest limits), child-scope derivation from the
ownership graph, protected-field rejection, graph resolution as the authority with
`records.space_id` only a prefilter, quarantine instead of retry/export, and activation
by migration only.

## 3. Amended specification (protocol 3)

Protocol 3 replaces the never-shipped protocol 2. A server with `enabled = 1` answers
`426 permission_protocol_required` to protocol 1 and 2 callers. With `enabled = 0` every
legacy path is byte-for-byte unchanged.

### 3.1 Capability levels (one specification, written twice)

`0` none, `1` viewer, `2` commenter, `3` editor, `4` admin, `5` owner — evaluated from
current rows: disabled principal → 0; missing/deleted space → 0; explicit membership
(deny → 0; guest with owner/admin → 0; else its role); no membership: non-guest and
`default_access = 'members'` → 3; otherwise 0. `worker/capability.ts` holds the SQL;
`shared/access.ts#effectiveSpaceRole` stays the pure specification. A parity test
enumerates every (workspace role × legacy role × membership × default access × deleted ×
disabled) combination through both.

### 3.2 Manifest and etag

`GET /api/access` → `{protocol: 3, userId, workspaceRole, etag, spaces: [{id, name, role, exportPolicy}]}`
(`protocol: 1` while disabled). `etag` = base64url(SHA-256(stable JSON of the manifest))[0..22].
Membership/role/space changes alter the manifest; sessions, logouts, record writes,
deletes, restores and moves never do.

### 3.3 Pull

`POST /api/sync/pull` (GET stays the legacy/426 route):

```json
{ "protocol": 3, "etag": "…", "cursor": 1234, "joining": [{ "space": "s1", "after": 0, "base": 0 }], "limit": 500 }
```

`cursor` applies to every manifest space not listed in `joining` (invariant: the client's
manifest spaces = settled ∪ joining). Server, in one D1 batch: the manifest statement; the
high-water mark; the floors of the named spaces; a *settled* statement
`space_id IN (readable ∖ joining) AND seq > cursor ORDER BY seq LIMIT 501`; one statement per
joining space (`space_id = S AND seq > after`, plus `peer_space_id = S`), all guarded by the
caller's current level ≥ 1; and the matching `space_events` statements.

1. etag ≠ current → `409 manifest_changed` with the manifest inline; nothing else is returned.
2. `cursor` or any `after` above the high-water mark → `409 cursor_ahead`.
3. A settled space whose shared cursor is below its `events_floor`, or a resumed backfill whose `base` is below it → `409 rebackfill_required {spaces}`. `base` is the high-water mark of the scan's first response (`0` until then; the server fixes it and echoes it back). A scan from `0`, or one that has merely not yet reached the floor, is never stale: it reads current state, and asking it to restart would loop forever (FD-21).
4. Merge records and events by `seq` (events before records on equal `seq`; a record found
   through both its home and peer statement appears once); take `limit`; if the last
   included item and the next candidate share a `seq`, drop the trailing equal-`seq` group
   (any size). `limit` must be at least 8 (`400` otherwise) so a page can never be one group.
   `hasMore` is true iff the merged candidate list exceeded `limit`.
5. Resolve record candidates through the kernel (`readAuthorizedRecords`,
   `includeDeleted`, `includeAncestorDeleted`): graph + current context + capability-fenced
   content read. A race inside it → `409 access_changed_retry`.
6. Reply `{protocol:3, etag, highWater, records:[{id,collection,data,field_ts,seq,spaceId,peerSpaceId?}],
   evictions:[{id,rev,spaceId}], cursor, joining:[{space,after,base}], hasMore}`. New cursors:
   `L` (last included `seq`) if `hasMore`, else the high-water mark; `cursor' = max(cursor, L|H)`;
   `after' = max(after, L|H)`. Correct because the scan returned every row with
   `seq ≤ L` of every requested space (FD-12).

A backfill is `joining: [{space, after: 0}]` repeated until the space's `after` reaches
`cursor`; it writes no D1 rows.

### 3.4 Events

`space_events(space_id, seq, record_id, kind CHECK(kind='evict'), created_at, PRIMARY KEY(space_id, seq))`,
`spaces.events_floor`. `seq` is the moved row's new `records.seq` (the same counter domain),
which doubles as `rev`; allocation never regresses (`seq_floor`, FD-17). Written by SQL triggers in the same statement as the cause:
`records.space_id` changes (old space), and a link's `fromId/toId/fromType/toType` change
(old home and old peer). Retention: rows older than 30 days are deleted in bounded batches
and `events_floor` is raised from the same set. Client rule: delete the local row iff its
`_spaceId` equals the event's space and `_serverRev < rev`; always drop a cached (not
pending) blob of that id; then garbage-collect dangling links.

### 3.5 Push and write fences

`POST /api/sync/push` carries `protocol: 3`; the reply adds `accessEtag`. Writes are
authorized exactly as today (`authorizeMutations`). The batch fence is now
`capabilityFence(userId, needs, workspaceRole, enabled)` + the unchanged dependency
revision fence, where `needs[space]` is the highest level any authorized item in that
space relied on (derived from the same `canEdit/canComment/canEditComment` predicates).
It fails exactly when *this caller's* level on a touched space fell below what the plan
used — not when anyone else's anything changed.

### 3.6 Move

`moveRoot(db, userId, {recordId, toSpaceId, requestId, expectedRev?})`; route
`POST /api/spaces/move`, available only while enabled. Roots only (boards, moodboards,
root pages). Needs editor on source and destination. The closure (descendants, comments,
files, incident links) is read, bounded (`move_too_large`), and rewritten in one batch:
capability fence, root revision fence, a single `UPDATE` re-stamping `space_id` and
assigning distinct new `seq` values (events follow by trigger), recomputation of every
incident link's home and peer, an audit row. Retargeting any other way remains
`explicit_move_required`.

### 3.7 Client

State: `access_manifest` (latest verified), `access_settled` (spaces whose cache is
complete), `sync_cursor` (shared by settled spaces), `access_joining`
(`{space: {after, count}}`) with rows staged in `syncStage`, quarantine tables unchanged.

1. On a manifest (startup, `409 manifest_changed`, focus): compute the diff.
2. **Evictions first, atomically:** for removed spaces delete their rows, blobs, links
   left dangling and unreadable work (outbox → quarantine, drafts → quarantine); role
   reductions quarantine now-unauthorized pending edits; a persisted
   `access_reconcile_required` marker covers a crash between seeing the manifest and the
   commit (offline restart stays locked until online).
3. Added spaces become `joining` (`after: 0`); pages are staged per page in one
   transaction with the cursor; a restart resumes.
4. A space activates in one transaction when caught up: scope of every staged row is
   verified against the manifest with local ancestors included; pending edits are rebased
   or quarantined; staged rows replace the space's rows (mark-and-sweep); manifest,
   settled set and cursor are written together.
5. Unscoped legacy rows ⇒ all-or-nothing activation (FD-10).
6. Steady state: pull page → rebase → upsert → apply evictions → cursor, one transaction.

### 3.8 Schema change (migration 0017, forward only)

Existing migrations are hash-locked by certification, so nothing is rewritten. 0017 drops
the generation triggers (`p5_space_*`, `p5_member_*`, `p5_user_*`, `p5_session_delete`,
`p5_record_scope`, `p5_record_visibility`, `p5_record_delete_visibility`,
`p5_access_activation`, `p5_file_aux_visibility`) and `sync_snapshot_items` /
`sync_snapshots`; adds `space_events`, `spaces.events_floor`, `seq_floor` with its
`AFTER DELETE` trigger, `records.peer_space_id` with its partial index, and the two event
triggers. `access_state.generation` remains as an inert column (audit rows still copy it).
The trigger drop happens only after every consumer of the generation has been converted to
the capability fence (so no fail-closed check ever degrades to a trivially true
comparison), and 0017 is applied by tests through both the vitest fixture splitter and
`wrangler d1 migrations apply` (FD-19).

## 4. Proof obligations → mandatory tests

| Obligation | Test (all run in the unit and D1 certification stages) |
|---|---|
| SQL level ≡ `effectiveSpaceRole` | `phase5-capability-d1.test.ts` (exhaustive parity) |
| Revocation: no row of S after the manifest drops it; etag mismatch returns the manifest only | `phase5-feeds-d1.test.ts` |
| Regrant: backfill includes rows changed while revoked; client sweeps stale rows | `phase5-feeds-d1.test.ts`, `phase5-spacefeed-client.test.ts` |
| Stale cursor below `events_floor`; cursor ahead of the database | `phase5-feeds-d1.test.ts` |
| Cross-space move: events, descendants, destination feed, out-and-back ordering | `phase5-moves-d1.test.ts`, client rev rule |
| Relations: both endpoints required, regrant of the peer delivers the link, retarget evicts, dangling GC | `phase5-moves-d1.test.ts`, `phase5-spacefeed-client.test.ts` |
| Interrupted backfill: crash between pages and during activation leaves no partial state | `phase5-spacefeed-client.test.ts`; browser journey |
| Concurrent edits while backfilling and paging (no missed or duplicated row) | `phase5-feeds-d1.test.ts` (interleaving + seeded random schedule) |
| Authorization change during a write (revoke, downgrade, disable, move, parent change) | `phase5-writes-d1.test.ts`, `phase5-files-d1.test.ts`, `phase5-moves-d1.test.ts` |
| Sequence never regresses after a hard delete of the maximum row (FD-17) | `phase5-feeds-d1.test.ts` |
| Protocol downgrade refused; one protocol constant (FD-20) | `phase5-spacefeed-client.test.ts`, `phase5-feeds-d1.test.ts` |
| Migration 0017 on the fixture splitter and `wrangler d1 migrations apply` (FD-19) | `phase5-migration-d1.test.ts`, certification `migrations` + every fixture |
| D1 reads/writes; ordinary logout/delete write no snapshot rows; independent of N | `phase5-cost-d1.test.ts` (writes evidence JSON) |
| Browser journeys with permissions enabled (3 engines) | `scripts/verify-phase5-sync.mjs` (fixed, mandatory suite `phase5-sync`) |

## 5. D1 budget model

Per-event cost under protocol 3 (formulas; measured values are in
[`../reviews/phase-5-per-space-verification.md`](../reviews/phase-5-per-space-verification.md)):

| Event | Rows written | Rows read |
|---|---|---|
| logout, session expiry, password change | 1–3 (the session/credential rows) | 0 |
| soft delete / restore of a record | the record's own write set | 0 extra |
| membership or role change | 1 membership row + 1 audit row | 0 extra |
| steady pull, nothing changed | 0 | ≈ one index probe per readable space |
| backfill of a space with N rows | 0 | ≈ N (+ graph resolution per page) |
| move of a subtree with m rows | ≈ 3m (record rows) + m events + incident links | closure + links |

Nothing in the table scales with the workspace's record count except a deliberate move
(its subtree) and reads during a backfill.

## 6. Explicitly pending owner decisions (unchanged by this work)

Public forms/pages embeddable by other sites; approval separation of duties and who may
edit gates; CSP report-only rollout; guest seat/quota policy and export/quarantine
retention; recovery/export of quarantined work; enabling permissions for real users
(activation) and its maintenance-window procedure; Phase 6 (preview-bound writes,
semantic search). Read-path enforcement for MCP, public routes, notifications and
history (design review §5, §8) is outside this change and remains required before
activation.
