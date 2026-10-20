# Cross-phase architecture audit — Phases 0–6

Audit of `YHWH3/tcg-workspace` at `origin/main` **fb6e203** (Phases 0–4 merged,
PRs #1–#4 and #6), performed 2026-10-15. Remediation is in
[PR #8](https://github.com/YHWH3/tcg-workspace/pull/8)
(`audit/cross-phase-remediation`). The Phase 5 foundation in draft
[PR #7](https://github.com/YHWH3/tcg-workspace/pull/7) was reviewed read-only
and is not modified by this work.

How to read this document. Every row is one of:

- **Verified defect** — reproduced by an automated test that was red on the
  starting commit for the stated reason and is green on the fix. The red
  assertion is quoted.
- **Risk** — established by reading the code and the platform limit it
  collides with, but not reproduced end to end (said so explicitly).
- **Recommendation** — a design position, not a defect.

Nothing here is a claim about production: no production resource, credential,
D1 database or deployment was read or changed. Local Miniflare D1 is the real
SQLite engine but **does not enforce D1's 2,000,000-byte row limit** or the
per-invocation call budget unless a test installs `withD1Budget`.

## 0. Starting state (verified independently)

| Question | Finding |
|---|---|
| Which phases are merged? | 0, 1, 2, 3 and 4 are on `origin/main` (`fb6e203`). The local checkout was at the Phase 3 merge `3a742ac`; Phase 4 had been merged remotely. |
| Is Phase 5 pending? | **Partly implemented, not merged.** Draft PR #7 (`grok/phase-5-search-permissions`, 10 commits on `origin`, 3 more only in the local clone) adds migrations 0012–0015, a space/role model, server-side write authorization, filtered sync with generation-bound snapshots and account-bound client caches. `access_state.enabled` is `0`; search, history, spaces UI, MCP/file/public enforcement and guest invitations are not done. Treated as unfinished. |
| Phase 6? | Proposal only. Three prompts it lists already exist in `worker/mcp.ts`; none of its read tools exist. |
| Release status | Phase 4 certified locally (`docs/reviews/phase-4-*.md`); production deployment explicitly on HOLD there. No tags. |

## 1. Findings register

Severity: Critical = remote compromise / bulk data loss without precondition;
High = privilege escalation inside the trust domain, silent data loss, or an
unrecoverable stuck state; Medium = integrity/availability/cost defect with a
precondition; Low = hardening.

### 1.1 Verified defects (fixed in PR #8)

| ID | Phases | Sev | Where | Root cause and evidence | Impact | Correction | Status |
|---|---|---|---|---|---|---|---|
| **XP-01** Stored active content via attacker-chosen MIME | 0/1 files × 2 public shares × 4 forms | **High** | `worker/files.ts` `GET /:id`; `worker/public.ts` both `…/files/:id` routes; `src/core/fileui.tsx` `FilePreview`; `src/public/PublicView.tsx` `file` block | `complete` stores the uploader's `mime` string (≤100 chars, unvalidated) and every file route served it verbatim; only `image/svg+xml` got headers. `PublicView` iframes the public URL and `FilePreview` iframes a `blob:` URL (which inherits the app origin) whenever the *synced, member-editable* `kind` is `pdf`. Red: `expected 'text/html' not to contain 'html'` (public), `expected 'application/xhtml+xml' not to match /html\|xml\|javascript/` (authenticated). Also observed: the global `Cache-Control: no-store` middleware is **overridden** by a route's own header in Hono, so authenticated bytes were `private, max-age=31536000, immutable`. | A member (or, in Phase 5, a guest) runs script in every viewer's session on the app origin, reading `localStorage.ws_token`: member → admin takeover. | `servedFileHeaders()`/`servedFile()` are the single decision point: inline only for raster images, audio, video, PDF; everything else `application/octet-stream` + `nosniff` + `attachment`; SVG re-sanitized at serve time; authenticated bytes `private, no-store`; client `renderableBlob()` re-decides every object URL (covers stale Dexie caches). | Fixed, tested |
| **XP-02** Policy refusal aborts the whole sync batch | 0 sync × 4 approvals | **High** | `worker/sync.ts` `flushPlans` transactional gate vs `worker/approvals.ts` `guardStageWrites` | The SQL guard raised `json_extract('{')` (a batch abort) for conditions the JS pre-check did not mirror: a `boardId`-only move into a gated stage, a pinned-approver change, records with no `boardId` (SQL resolves `board-default`, JS did not) and — when `approverField` was configured — **every** edit to any record already in the gated stage. The push returns 503 `write interrupted; retry`; the client retries the identical batch forever, so one refused record jams the user's whole outbox. Phase 4's own tests accepted `503 \|\| rejected>0` as success, so they established "nothing written", not "nothing else blocked". Red (×4): `expected 503 to be 200`. | Permanent "sync error" for the user; unrelated offline work stuck behind one record; recoverable only by editing server state. | One shared predicate (`gateTransition`); pre-check folds patches with the real `mergeRecord`/stored timestamps, resolves `board-default`, covers moves and approver re-pins; SQL guard kept as the race backstop and now gates approver *changes*, not mere configuration. Refusals are item-wise `approval_required`. | Fixed, tested |
| **XP-05** Soft delete destroys attachment bytes | 1 MCP delete/undo × 4 INT-01 | **High** | `worker/mcp.ts` `delete_item`; migration `0011_integrity.sql` triggers | `delete_item` cascaded `deleted:true` to attachment records; the 0011 triggers reclaim bytes in the same transaction, irreversibly — while the tool promised "Recoverable via restore_item / undo_change". Red: `expected +0 to be 1` (chunk rows after delete). The UI never did this (`deletePage`/`deleteRecord` leave files alone). | An AI delete followed by undo restores a task whose attachments are gone, reported as success. | Soft deletes no longer touch attachment records; explicit `delete_item type:file` keeps byte reclamation and now warns in its dry run and description. | Fixed, tested |
| **XP-13** `create_from_template` silently partial above 5,000 rows | 3 templates × scale | **High** | `worker/mcp.ts`, `worker/automations.ts` snapshots | Six whole-collection reads with `LIMIT 5000` and no `ORDER BY`. Once a collection outgrew the cap the planner saw a partial workspace: the call succeeded and copied only the pages. A few hundred pages exceeds 5,000 blocks. Red: `expected { pages: 2 } to deeply equal { pages:2, blocks:2, boards:1, tasks:2, views:1, links:1 }`. | Silent data loss in templates/automations at Phase 5's target scale. | `loadTemplateSnapshot()` reads exactly the template closure (recursive CTE; one binding call per round), shared with the planner via `boardRefsOf`. | Fixed, tested |
| **XP-03** Unbounded client timestamps poison LWW and every peer's clock | 0 sync (all phases) | **Medium–High** | `worker/sync.ts` `validChange`/`restampForServer`; `src/core/sync/engine.ts` `hlc.observe`; `src/core/hlc.ts` | `validChange` accepted any finite number. A field written with `ts=1e300` wins every later merge, `restampForServer`'s `+1` is lost to float precision (`1e300+1===1e300`), and every client that pulls it adopts it into its persisted HLC, so later edits of *all* fields lose causal ordering. Red: `expected 1e+300 to be less than or equal to 1792079164531`; `expected false to be true` (`Number.isSafeInteger`). | One device with a wrong clock (or one hostile write) silently reorders merges workspace-wide, permanently. | Server clamps to `now+60 s`; stored out-of-range values are healed to the row's last server write time on next write (clamping to the moving ceiling would have left them permanently newer than ordinary writes); client refuses to observe or load timestamps beyond the bound (`shared/clock.ts`). | Fixed, tested |
| **XP-14** Date-index rebuild can never finish on a large board | 4 events × D1 budget | **Medium–High** | `worker/events.ts` `maintainDateIndex`; `worker/admin.ts` | One binding call per task against a 45-call invocation budget, so adding a date field to a board with >~40 tasks re-ran the same prefix forever (budget exhaustion decrements `attempts`, by design). `/admin/reindex-dates` also silently stopped at 5,000 rows. Red: `D1 invocation budget reached; retry pending work`. | Reminders and date-offset automations never see the new field; the outbox event never terminates. | 50 records per binding call; admin backfill is keyset-paginated (`?after=`). | Fixed, tested |
| **XP-04** Oversized record aborts the batch | 0 sync × platform limit | **Medium** | `worker/sync.ts` `applyChanges` | No per-item size validation; D1 rejects any string/row ≥ 2,000,000 bytes, which aborts the batch carrying it (same jam as XP-02). **Not reproducible locally** (Miniflare does not enforce the limit); the regression asserts the new invariant. Red: `expected [] to deeply equal [ObjectContaining{…}]`. | Pasting a ~2 MB blob into a block jams that user's sync. | Per-item `record_too_large` above 1,000,000 serialized bytes; small or non-growing writes always pass so an oversized legacy row can still be shrunk or deleted. | Fixed (invariant tested; platform failure mode from documentation) |
| **XP-06** `restore_item` restores only the root | 0 trash semantics | **Medium** | `worker/mcp.ts` `restore_item` | Page delete flagged descendants/blocks `deleted:true` (no marker); restore revived only the page row (and, for tasks, sub-records). The Phase 0 doc claims descendants "were never flagged". Red: `expected true to be false` (block/child/comment still deleted). | `restore_item(page)` returns an empty page. | Cascaded rows carry `deletedVia:<root>`; restore revives exactly what that delete hid; an independently deleted child stays deleted. | Fixed, tested |
| **XP-07** SVG sanitized on one of three write paths | 2 SVG × 4 forms, MCP import | **Medium** | `worker/forms.ts` upload; `worker/remotefile.ts` | Only the authenticated chunk route sanitized. Public form upload accepts any `image/*` incl. `image/svg+xml` from an **anonymous** visitor; remote import accepts `image/svg+xml`. Red: stored bytes matched `/<script\|onload/`. | Anonymous → stored active SVG in the workspace (rendered inert only because every route happened to set a CSP). | Both paths store the sanitizer's canonical output or refuse; serve-time re-sanitization covers rows already stored. | Fixed, tested |
| **XP-09** No password-guess throttle | 0 auth × 4 OAuth consent | **Medium** | `worker/auth.ts` `/login`; `worker/oauth.ts` consent POST | Neither password-accepting endpoint was throttled; unknown usernames skipped PBKDF2 (timing enumerates accounts). Red: `expected 200 to be 429`. | Online guessing against 7 known accounts. | Failure counters in `rate_limits` per (client, account), per client and per account; success clears the pair; dummy PBKDF2 for unknown users. | Fixed, tested. **Residual:** a sustained 300-failure/hour attack from many addresses can hold one account in lockout for the window. |
| **XP-10** Credential rotation leaves derived grants | 0 auth × 4 OAuth/MCP | **Medium** | `worker/auth.ts` `/password`; `worker/admin.ts` delete user | Password change deleted other sessions but not OAuth grants (refresh tokens); user removal left grants in KV. Red: `expected "vi.fn()" to be called …` (`revokeGrant`). | A stolen MCP refresh token survives the password change made in response. | `revokeAllGrants()` on both paths. | Fixed, tested |
| **XP-11** Live sockets outlive their session | 1 live × auth | **Medium** | `worker/live.ts`, `worker/index.ts` | A socket was validated once at upgrade; the 30 s client heartbeat refreshed `lastSeen`, so a logged-out, removed or expired user kept receiving presence paths (`/pages/<id>`) and change pokes indefinitely. Red: `expected "vi.fn()" to be called at least once` (`close`). | Information leak after revocation; a Phase 5 prerequisite (the draft lists it as pending). | Socket carries the session hash; the existing 60 s sweep closes any whose session row is gone/expired (one indexed query; DB errors keep sockets). | Fixed, tested |
| **XP-12** Unfinished uploads unbounded and never reclaimed | 0 files × 4 quota | **Medium** | `worker/files.ts` chunk PUT; `worker/reminders.ts` retention | One file id accepted 4,096 chunks; unfinished bytes never counted against the 450 MB quota and no sweep existed. Red: `expected 200 to be 413`; `expected ['fresh','ghost','known'] to deeply equal ['fresh','known']`. | Any member can fill D1 with chunks that never complete. | 20 MB per-file bound (413); quota counts completed bytes plus unfinished bytes of uploads younger than 7 days (507; both statuses are ones the client already treats as permanent); a 7-day sweep reclaims unfinished uploads no synced record claims, and an old partial that does have a record stops pinning quota after the same window. | Fixed, tested |
| **XP-15** Whole-collection reads feed exact invariants | 1 deps × 3 | **Medium** | `worker/mcp.ts` `add_dependency`, `connect_items`, `layout_moodboard`, `query_records`, `get_record`, `linkedFor`; page delete walk | The 5,000-row, unordered cap fed dependency-cycle checks (a Phase 1 invariant), relation reads, and a per-page delete walk (one query per page, exhausting the 45-call budget at ~20 pages). Red (call site temporarily reverted): the cycle-creating `add_dependency` returned `{"existed":false,…,"isError":false}`, `expected false to be true`. | A dropped `blocks` edge defeats cycle detection; relation/dependency reads silently omit rows. | `listLinksByKind` / `listLinksTouching` (exact, indexed); `pageClosure` (one recursive read); `listCollection` logs `collection_read_truncated`. | Fixed, tested |
| **XP-08** Public form attachment limit unreachable | 4 forms | **Low–Med** | `worker/forms.ts` | Uploads and the submission share one `form` bucket of 10/hour while `FORM_MAX_FILES` is 10: 10 uploads + the submission = 11. Red: `expected 429 to be 200`. | A visitor with the documented maximum gallery loses the submission; images orphaned. | Separate `form_upload` bucket. | Fixed, tested |
| **H-01** No browser security headers | all | **Low–Med** (hardening) | `wrangler.jsonc` assets, `worker/index.ts` | No CSP, framing or `nosniff` headers on the SPA, the API or the OAuth consent page (grep: only the file routes set any). The consent form (which takes the workspace password) and the app were frameable by any site. | Clickjacking; no defense in depth behind XP-01-class bugs. | `worker/headers.ts` (Worker responses; WebSocket upgrades pass through untouched) + `public/_headers` (SPA shell): `nosniff`, `X-Frame-Options: SAMEORIGIN` (same-origin framing is required by the public PDF preview), `Referrer-Policy`. **Decision:** `/f/*` (public forms) and `/s/*` (shared pages) are exempted from the framing restriction so an organisation can embed a registration form in its own site — they carry no session-bearing action; the app shell, the consent page and the API are not frameable cross-site. Verified on the built Worker: `/`, `/pages/x` → `SAMEORIGIN`; `/f/x`, `/s/x` → none. Tighten by deleting the two `_headers` rules if embedding is not wanted. A `script-src` CSP is *not* added: it needs a report-only rollout against the Turnstile, Drive and blob: PDF flows first (R-13). | Fixed (headers), CSP open |


**Reproduction index.** Run `npx vitest run <file>`; every test below was red
on `fb6e203` for the reason quoted in the table (XP-04's platform failure is
asserted as the new invariant — see its row).

| ID | Test (file › group) |
|---|---|
| XP-01 | `tests/audit-files-d1.test.ts` › *served file responses cannot become active content on the app origin*; `tests/audit-client.test.ts` › *renderableBlob* |
| XP-02 | `tests/audit-sync-d1.test.ts` › *approval gate refusals are per-item, never batch-aborting* (×4) |
| XP-03 | `tests/audit-sync-d1.test.ts` › *client timestamps are bounded*, *legacy poisoned timestamps heal on the next write*; `tests/audit-client.test.ts` › *client HLC refuses untrusted timestamps* |
| XP-04 | `tests/audit-sync-d1.test.ts` › *oversized records are refused per item* |
| XP-05, XP-06 | `tests/audit-mcp-d1.test.ts` › *record soft delete is reversible* (×3); `tests/impact.test.ts` |
| XP-07 | `tests/audit-files-d1.test.ts` › *SVG is sanitized on every write path*, *stored SVG is re-sanitized at serve time* |
| XP-08 | `tests/audit-files-d1.test.ts` › *public form attachment limits are reachable* |
| XP-09, XP-10, XP-11 | `tests/audit-auth-d1.test.ts` › *login attempts are throttled*, *rotating or removing a credential revokes…*, *open live sockets are bound to their session* |
| XP-12 | `tests/audit-files-d1.test.ts` › *incomplete uploads are bounded and reclaimed*, *unfinished uploads count toward quota only inside the sweep window* |
| XP-13 | `tests/audit-mcp-d1.test.ts` › *template instantiation does not depend on workspace size* |
| XP-14 | `tests/audit-sync-d1.test.ts` › *date index maintenance is bounded by batches, not by record count* |
| XP-15 | `tests/audit-mcp-d1.test.ts` › *exact reads for invariants* |
| H-01 | `tests/audit-auth-d1.test.ts` › *browser hardening headers*; `scripts/smoke.sh` (built Worker) |
| Phase 6 §4 | `tests/audit-mcp-d1.test.ts` › *MCP safety rails* |

### 1.2 Risks and recommendations (not fixed here)

| ID | Phases | Sev | Statement | Evidence | Recommendation |
|---|---|---|---|---|---|
| **R-01** | 4 approvals | Medium | The approval gate is not separation of duties: any member can set `approvalGate`/the approver field, and the requester may name themselves approver. | `shared/approvals.ts` ("member config — set/clear freely"); `validateApprovalRequest` has no requester≠approver rule. | Phase 5: gate configuration and approver eligibility require space admin; decide requester≠approver explicitly. |
| **R-02** | 2 shares | Medium | A public page embedding a `tasks` block exposes the title, stage and cover of **every** task on that board, not the viewed subset. | `worker/public.ts` `taskBlocks`. | Document in the share dialog; Phase 5 per-space share boundary; consider an explicit "include board" opt-in. |
| **R-03** | 2 shares | Medium | Unauthenticated public routes scan whole collections per request (`pageTree` reads all pages; a file route reads all `files` records and the tree's blocks). A bot can burn the free-tier 5 M row-read/day budget. | `worker/public.ts` `pageTree`, `allowedFiles`. | Resolve access by indexed lookup from the file id; edge-cache with short TTL; rate limit by token. Inspection only — not load-tested. |
| **R-04** | 4 → 5 | **High (Phase 5)** | Server-only stores snapshot content that no sync eviction can reach: `event_outbox.payload`, `notifications` (title/body), `changeset_items`/`undo_items` before/after, `automation_runs.payload`, `form_submissions.payload`, `mcp_requests.result`, `approvals.note`. | Migrations 0004/0007/0008/0011. | Phase 5 must enumerate and filter/purge each (see the Phase 5 design). |
| **R-05** | all | Medium | `recs()` consumers other than the exact paths above (`workspace_overview`, `fillCaches` mention resolution, `search`) still operate on ≤5,000 rows per collection and `search` scans five collections per call. | `worker/mcp.ts`. | Phase 5 FTS + paginated overview; until then the log line is the signal. |
| **R-06** | 0 auth | Low | Invite codes are 8 symbols over a 31-letter alphabet (~39.6 bits, modulo-biased), never expire, and signup is unthrottled. | `worker/password.ts` `inviteCode`. | Expiry + the login bucket on signup. |
| **R-07** | 0 auth | Low | No second factor; PBKDF2-SHA256 at 100,000 iterations (the Workers ceiling). | `worker/password.ts`. | Passkeys/TOTP before guests exist. |
| **R-08** | 4 forms | Low | **Fixed in PR #8.** `clientIp` fell back to `x-forwarded-for` when `cf-connecting-ip` was absent (non-Cloudflare only); forms now share `clientAddress()` with the login throttle, which has no such fallback. | `worker/forms.ts`, `worker/ratelimit.ts`. | — |
| **R-09** | 4 recurrence | Low | Monthly recurrence drifts after a short month (Jan 31 → Feb 28 → Mar 28), documented as intended. | `shared/recurrence.ts`. | Product decision; RFC 5545 would clamp without drifting. |
| **R-10** | 4 retention | Low | `runRetention` hard-deletes `form-pending` records, so members that already pulled them keep ghost rows. | `worker/reminders.ts`. | Tombstone via `applyChanges` (as `sweepFormFileOrphans` does). |
| **R-11** | 1 capture | Low | `POST /share-target` accepts cross-site form posts into the capture inbox (user must still save). | `src/sw.ts`. | Acceptable; note for the PWA threat model. |
| **R-12** | 5 draft | see Phase 5 review | Global generation + materialized snapshots do not scale past the seven-seat assumption; draft still serves stored MIME verbatim on public routes. | PR #7 migrations 0012–0014. | [Phase 5 design review](../architecture/phase-5-design-review.md) §2, §4. |
| **R-13** | all | Medium | No `Content-Security-Policy` `script-src`/`default-src`: a single XSS (XP-01 class) has full power on the app origin. | `wrangler.jsonc`; absence verified. | Ship `Content-Security-Policy-Report-Only` first (`script-src 'self' https://challenges.cloudflare.com`; `frame-src 'self' blob: https://drive.google.com https://docs.google.com`; `connect-src 'self' wss:`), watch the three-engine journeys, then enforce. |
| **R-14** | 2 SVG × cost | Low–Med | Serve-time SVG re-sanitization runs per request. Measured (Node, warm): a 422 KB, 4,000-path document takes 8–18 ms; a 1 MB document is expected at ~20–45 ms, which can exceed the Free plan's 10 ms CPU budget. | Local timing, not Workers CPU. | Persist the canonical output once (needs a `files` flag/migration — coordinate the migration number with Phase 5) or cap inline SVG at a size the budget allows. |
| **R-15** | 0 trash | Low | Pages deleted *before* PR #8 carry `deleted:true` on blocks/children without `deletedVia`, so `restore_item` cannot revive their content (`undo_change` still can). Existing data, not a regression. | `delete_item` history. | One-off repair job, or document undo as the path. |
| **R-16** | 0 files | Low–Med | The client treats a 400 `missing chunks` from `complete` as transient and aborts every later upload pass, so a file whose chunks were lost server-side jams all uploads behind it. Pre-existing; the new sweep only removes uploads with no record. | `src/core/files.ts` `uploadPendingBlobs`. | Treat `missing chunks` as "restart this file" (reset `uploadedChunks`). |

## 2. Cross-phase dependency map

Seven phases share a small number of mechanisms. Most defects above were not
inside a phase; they were at one of these seams.

| Mechanism | Introduced | Consumers | What breaks if a later change forgets it |
|---|---|---|---|
| `applyChanges()` (`worker/sync.ts`): merge, CAS, journal, outbox, gate, execution fence | 0 | client push, every MCP write, forms, automations, undo, recurrence, file DELETE, remote import, Phase 5 authorization | A write path that bypasses it skips gates, events, audit and (Phase 5) permissions. It is also the place where one bad item can abort a batch (XP-02/03/04). |
| Generic `records` + `seq` + per-field `field_ts` | 0 | every synced collection, every cursor, every cache | Timestamps are untrusted input (XP-03). Anything that reads the whole table is capped and unordered (XP-13/15). |
| File pipeline: `files`/`file_chunks`, `files` records, 0011 triggers, serving policy | 0–1, 4 | client uploads, public form uploads, remote import, MCP delete cascades, public shares, templates (shared refs), Phase 5 spaces | Bytes are reclaimed irreversibly by trigger (XP-05); the MIME string and SVG bytes are attacker-controlled on three write paths (XP-01/07). |
| Event outbox → notifications / date_index / automations / recurrence | 4 | every `applyChanges` caller passing `event` | Per-record binding calls exhaust the 45-call budget (XP-14); payloads denormalize content (R-04). |
| Approval gates (`boards.approvalGate`) | 4 | sync, MCP, automations, undo (all through `applyChanges`) | JS pre-check and SQL guard must stay one predicate (XP-02). |
| Public surfaces: shares, forms, form uploads, `publicAccess` | 2, 4 | anonymous internet | Unauthenticated, same origin as the app: any content-type or markup mistake is session theft (XP-01). Per-request scans are a cost vector (R-03). |
| OAuth/MCP: provider props, `reg()` wrapper, idempotency, changesets | 0, 4 | AI clients | Props are frozen at consent: authority must be resolved per request from D1 (the code already does not trust `props.userRole`). Grants must die with the credential (XP-10). |
| D1 invocation budget (`withD1Budget`, 45 calls) | 4 | every request and cron phase | Any loop with one binding call per record/page is a latent failure at ~40 items (XP-14/15). New code must use batch + `json_each` + recursive CTE. |
| Client: per-account Dexie, outbox, HLC, blob cache, service worker | 0–1 | everything offline | Cached blobs and persisted clocks outlive server fixes (hence `renderableBlob`, HLC load check). |

Where upcoming work is most likely to break existing behavior:

1. **Phase 5 ↔ `applyChanges`.** The draft rewrites its prologue
   (`readWriteSnapshot`, `authorizeMutations`, `writeAuthorityFences`) and
   extends `guardStageWrites`. PR #8 also changes the prologue (one read shared
   by restamp, gate pre-check and planning) and `guardStageWrites`'s fourth
   parameter. A trial `git merge-tree` reports conflicts in `worker/sync.ts`,
   `worker/approvals.ts`, `worker/files.ts`, `worker/auth.ts`, `worker/oauth.ts`
   and `src/core/files.ts`. Resolution guidance is in
   [phase-5-design-review.md §7](../architecture/phase-5-design-review.md).
2. **Phase 5 ↔ file serving.** The draft's `worker/files.ts` still emits the
   stored MIME; `worker/public.ts` is untouched. Spaces make XP-01 a
   guest-to-member escalation if not carried over.
3. **Phase 6 ↔ every read path.** MCP reads (`recs`, raw SQL in `search`,
   `get_page` backlinks) are not yet behind any authorization seam; embeddings
   and digests would be new unfiltered read paths.
4. **Phase 4 automations ↔ Phase 5.** Automations execute as the *triggering
   actor* with the author's destination; under spaces that is a confused-deputy
   channel (design in the Phase 5 review §4).

## 3. Verification record

Everything below was run locally on macOS (Darwin 25.5, Node 26.7, Playwright
1.63: Chromium 153 / Firefox 155 / WebKit 26.6). No production resource was
touched.

**Regression files** (red on `fb6e203` for the reasons quoted above, green on
the PR head):

```sh
npx vitest run tests/audit-sync-d1.test.ts tests/audit-files-d1.test.ts \
  tests/audit-mcp-d1.test.ts tests/audit-auth-d1.test.ts tests/audit-client.test.ts
```

**Full local matrix** — `npm run certify:phase4`, the repository's own gate,
complete mode, **PASS (exit 0), 26/26 mandatory gates**, on commit
`cdaf0b1f821d2339cba600fcb70fde14f3e63293`, source fingerprint
`c740bc153d264738b472ad5119770997a2c939f89af1ec22613918e3444755dc`:

| Gate | Result |
|---|---|
| prerequisites, dependencies, lockfile, whitespace | PASS |
| migrations (11, unchanged), harness selftests (58), typecheck, build | PASS |
| unit (Vitest, 65 files) | PASS **714** |
| actual-D1 gate (Phase 4 + audit D1 suites, independently) | PASS **224** |
| security (`npm audit`) / browsers (Chromium, Firefox, WebKit launch) | PASS / PASS 3 |
| smoke (built Worker; includes the new served-file checks) | PASS **46** |
| MCP base 91 · multiuser 61 · phase1 37 · phase2 113 · phase3 64 · phase4 46 | PASS |
| v4 33 (presence socket, instant sync, public pages) · v6 150 · v7 114 · v8 140 · v9 75 (three engines, phone/tablet/desktop) | PASS |
| performance-evidence 118 · source-integrity | PASS |

**History of the run, stated plainly.** An earlier complete run on `72be9f2`
failed two assertions: `smoke › GET cache header` (it asserted the old
`immutable` header; the intended contract is now `private, no-store`, updated in
`ec26e1f`) and `mcp-base › security: refresh-grant revocation rejects refresh`
(passed in an isolated run of the OAuth sequence and in 2/2 full reruns of the
suite; it passed again in the run above, and `phase4-oauth-security.mjs` now
records the response status/body for that assertion so a recurrence is
diagnosable rather than "unexplained"). The WebSocket upgrade path through the
new response-hardening middleware was exercised on the built Worker
(`verify-v4` presence + instant sync) before the final run; an upgrade response
is passed through untouched (`worker/headers.ts`).

A file that records its own certification changes the source fingerprint it
certifies (the fingerprint covers every tracked file, documentation included).
Later commits on this branch are documentation-only; the PR description names
the exact certified SHA of the head.

**Not run / not verifiable here:** physical iPhone/iPad Safari, physical
Android, VoiceOver/TalkBack/NVDA, native 400% zoom (automated 320 px reflow is
not native zoom); a production or staging Cloudflare deploy (D1's
2,000,000-byte row limit and per-plan quotas are documented platform limits,
not locally enforced); real Turnstile; real Workers AI; real multi-device clock
skew. XP-04's production failure mode and R-03's cost vector follow from
documented limits and code inspection only.

**Outstanding security risks:** R-01 (approval separation of duties), R-02/R-03
(public share exposure and per-request scans), R-13 (no script CSP), R-14
(serve-time SVG CPU), XP-09's accepted lockout trade-off, no second factor
(R-07), and every Phase 5 item in
[phase-5-design-review.md](../architecture/phase-5-design-review.md) until it
ships.
