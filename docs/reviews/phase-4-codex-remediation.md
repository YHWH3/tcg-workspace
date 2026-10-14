# Phase 4 Codex integration remediation

Starting development HEAD: `4c42794d411b579518602e99d5e25d42bd6c1439`.
Starting main HEAD: `3a742acc2c09c9be0d8464d304544fd435166899`.
All ten prior Phase 4 commits remain ancestors of this isolated integration branch.
Production data and services are outside this verification scope.

## Mandatory findings

| Finding | Source-confirmed root cause and risk | Replacement contract | Status |
| --- | --- | --- | --- |
| P4-R01 | `worker/sync.ts` commits records before `worker/events.ts` independently stages outbox rows. An interrupted Worker can lose downstream work permanently. | Each successful CAS write and its event commit in one D1 batch; capture actual revision inside that transaction. Preserve each completed chunk on later failure. | FIXED AND VERIFIED |
| P4-R02 | `maintainDateIndex()` deletes all task dates and rebuilds from touched-only `after`. Unrelated edits erase deadlines. | Reconcile against authoritative persisted task and board field definitions inside one D1 transaction. Retry reads current state. | FIXED AND VERIFIED |
| P4-R03 | Event derivation and notification/reminder recipients read `assignee`, while task storage uses `assigneeId`. | Canonical `assigneeId` throughout server routing and trigger validation. | FIXED AND VERIFIED |
| P4-R04 | Missing Turnstile secret accepts `pass` and exposes a test schema. | Missing configuration fails closed; deliberate disposable-local flag additionally requires loopback request hostname. Production verifies token, action and hostname. | FIXED AND VERIFIED |
| P4-R05 | Existing run claims always skip replay; side effects and changeset metadata can land partially. | Leased resumable runs, durable plans/checkpoints, deterministic side effects and atomic audit recording. | FIXED AND VERIFIED |
| P4-R06 | A reserved processing receipt always returns 202, including abandoned requests. | Leased resumable submissions, deterministic plans/attachments, authoritative accepted replay and bounded honest terminal outcomes. | FIXED AND VERIFIED |

## Additional source review

| Finding | Evidence | Risk / corrective requirement | Status |
| --- | --- | --- | --- |
| P4-C01 | Notification/recurrence fan-out catches database errors; outbox is subsequently marked processed. | A transient fan-out failure silently loses work. Propagate recoverable failures and deduplicate every logical notification. | FIXED AND VERIFIED |
| P4-C02 | Cron marks events processed after five attempts then immediately deletes processed outbox rows. | Failure evidence and recoverable work disappear. Retain terminal errors explicitly; delete only successful retained rows. | FIXED AND VERIFIED |
| P4-C03 | Reminder dedupe inserts before notification independently. | Failure between inserts permanently burns a reminder. Couple dedupe with notification persistence. | FIXED AND VERIFIED |
| P4-C04 | Public upload ownership is only form-scoped; submitted file IDs need no visitor proof. | A visitor can attach another visitor's pending upload within the same form. Bind uploads to a deliberate visitor/submission capability. | FIXED AND VERIFIED |
| P4-C05 | Public forms acknowledge acceptance regardless of rejected `applyChanges()` writes and suppress changeset persistence errors. | False success and missing undo after approval-gate rejection or D1 failure. Receipt acceptance requires complete durable operation. | FIXED AND VERIFIED |
| P4-C06 | The first v9 browser run navigated between public form tokens; React retained the previous token's receipt and transient state. | Token changes must clear receipt, answers, submission identity and upload claims before loading only the destination draft. | FIXED AND VERIFIED |
| P4-C07 | `mintToken()` drew 16 modulo-biased base62 symbols and padded six deterministic zero characters while claiming 128 random bits. | Generate 22 independent base62 symbols by rejection sampling (>128 bits), preserving token syntax and old token lookup compatibility. | FIXED AND VERIFIED |
| P4-C08 | Grouping could attach a new event to an already-read notification. | A new delivery after a read group must start an unread generation. | FIXED AND VERIFIED |
| P4-C09 | A disabled public form could be served from a cached enabled response. | Disabled forms must not be treated as submittable from cache. | FIXED AND VERIFIED |
| P4-C10 | `runDateOffsetAutomations()` reread an unbounded completed `date_index` prefix on every Cron tick and starved later rows under the D1 binding budget. | Bounded keyset pages, a durable `rhythm_sweep_cursors` row per automation, and `date_offset_marks` so examined rows are not executed again. Budget exhaustion stays retryable. | FIXED AND VERIFIED |
| P4-C11 | Public form upload wrote an image of up to 5 MB into one `file_chunks` row. Authenticated uploads allowed a 2 MiB chunk. D1's documented per-row maximum is 2,000,000 bytes. | Shared 1 MiB (`1,048,576` byte) chunks, each strictly under 2,000,000 bytes. Download concatenates consecutive indexes. A failed or interrupted write deletes the file, its chunks, and its record. Success is returned only after the chunk count and byte length match. | FIXED AND VERIFIED |
| P4-C12 | Date-offset Cron checked the date, scope, and prior run, then called `runOneAutomation()` without `conditionsMatch()`. | The same AND condition engine as event automations, using the source board's fields and the live record. The rule stays eligible for that whole indexed day. A non-match moves the cursor and is not marked, so a later match in the same window still runs once. | FIXED AND VERIFIED |
| P4-C13 | The reminder keyset cursor skipped a newly earlier date until the forward scan emptied. A sustained backlog could delay that reminder without a bound. | Forward cursor `reminders` plus one lookbehind page, `reminders-behind`. The forward cursor is not reset while later rows remain. A new earlier row is sent on the next run when fewer than 4 unsent rows sort before it, otherwise within `ceil((unsent before it + 1) / 4)` runs. An empty forward page clears both cursors. `reminder_sent` still prevents a second delivery. | FIXED AND VERIFIED |
| P4-C14 | C13's empty-forward cleanup discarded an unfinished 40-row backward page, repeatedly scanning the same undeliverable prefix. | Preserve a full or interrupted backward page; wrap only after a short page is completely examined. Keep skipped rows unmarked so recipient/preference changes and earlier inserts are reconsidered on later passes. Atomic notification/dedupe and the separate overdue cursor remain in force. | FIXED AND VERIFIED |
| P4-C15 | Date-offset validation supplied only candidate source boards, so a valid `create_record` destination could appear absent. | Share `loadValidationCtx()` with ordinary execution: source/candidate/action boards, live fields, templates and members. Load once per page with bounded board batches; reject deleted destinations before writes. | FIXED AND VERIFIED |
| P4-C16 | v6 caught suite exceptions without recording FAIL; final exit depended only on assertion failures. | Structured explicit manifests, recorded suite/launch/setup failures and mandatory completeness; supervise child exit, signals and timeout. The orchestrator rejects malformed, empty and partial evidence. | FIXED AND VERIFIED |

C13's cleanup description above is the historical implementation; C14 supersedes
the sentence about clearing both cursors on an empty forward page. Current
reminder progress is bounded by 40 examined undeliverable rows per backward page
and at most four deliveries per invocation, subject to the D1 invocation budget.
The 60-row undeliverable-prefix regression reaches the valid task within two
executions. Changed eligibility and inserts behind the active cursor are reached
after the current pass wraps; under continuing mutation this is eventual scan
progress, not an absolute wall-clock delivery guarantee.

C14-T01–T08 are covered in `tests/phase4-reminders-d1.test.ts`: empty forward
range, added assignee, preferences re-enabled, earlier insertion, date moves,
concurrency, notification/cursor/budget failure injection and 1,000-row progress.
C15-T01–T08 are covered in `tests/phase4-date-offset-d1.test.ts` and the budget
suite: cross-database creation/templates, missing/deleted destinations, custom
AND conditions, member/approver references, replay, constrained budgets and
1,000 mixed index entries. C11 retains `FILE_CHUNK_BYTES = 1_048_576`.

## Continuation evidence (2026-10-11, commits `396144f` and `8a50be1`)

Starting checkpoint: `883039fa167352f1b4cc17d118628922490de739` on `grok/phase-4-continuation`.
These commands were executed in `/Users/trinity/Desktop/notion mock` after the commits above. Historical PASS counts earlier in this file are not reused.

- `npx tsc --noEmit`: PASS.
- `npm test` (`vitest run`): PASS **50 files / 563 tests**.
- `npm run build`: PASS. Existing large-chunk and ineffective-dynamic-import warnings remain. Service worker stays IIFE.
- Actual D1 budget suite `tests/phase4-budget-d1.test.ts`: PASS **7/7**, including "date-offset automation scan does not permanently revisit 600 already-completed candidates and starve the tail".
- `tests/phase4-migrations-d1.test.ts`: PASS **4/4**. Fresh `0001`–`0010`, upgrade from Phase 3 (`0001`–`0006`), upgrade from `0007`, and upgrade from `0009`. Records, outbox payload, automation lease, and form-submission state survived the upgrades. `rhythm_sweep_cursors`, `date_offset_marks`, and `idx_date_sweep` exist after `0010`.
- `tests/phase4-date-offset-d1.test.ts`: PASS **6/6**. Separate-date second automation, budget resume without a terminal run or a second task, cursor wrap plus target-date change, concurrent scans, and 1,000 mixed `date_index` rows.
- `tests/phase4-events-d1.test.ts`: PASS **33/33**. Covers atomic event commit/rollback (P4-R01), full date reindex (P4-R02), canonical assignee reminder (P4-R03), fan-out retry (P4-C01), and reminder dedupe that is not burned by a failed delivery (P4-C03).
- `tests/phase4-forms-d1.test.ts`: PASS **16/16**. Turnstile fail-closed (P4-R04) and submission recovery/receipt (P4-R05 path is in the events file; P4-R06 is this file).
- `tests/phase4-security-d1.test.ts`: PASS **22/22**. Visitor-scoped upload claims (P4-C04), no success receipt on a rejected write (P4-C05), and "a legitimate delivery after a read group starts an unread generation" (P4-C08).
- `tests/phase4-performance-d1.test.ts`: PASS **1/1** on a disposable 1,000-record Miniflare D1. Local measurements, not production billing: seed 19.7s / 40 subrequests / 5,010 rows read / 13,000 rows written; 100-row commit 2.8s / 2 subrequests / 301 statements / 800 rows read / 1,500 rows written; one Inbox query about 15ms using `idx_notif_inbox`; one date-offset-style automation about 15 subrequests / 23 statements / ~30 rows read / 36 rows written. `EXPLAIN` used `idx_date_sweep` and `idx_notif_inbox`.

P4-C02, P4-C06, P4-C07, and P4-C09 were not marked verified in the run above. That sentence is historical. The final remediation section at the end of this file is the current status.

Browser suites v4, v6, v7, v8, and v9 were **not executed** in this continuation. Physical iPhone/Android and assistive technology remain NOT RUN.

### D1 cost (official limits, checked 2026-10-11)

Sources: [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), both last updated 2026-04-21. Free-plan daily row limits are enforced as of 2026-09-01 ([changelog](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/)).

| Meter | Workers Free | What this code counts |
| --- | --- | --- |
| Queries per invocation | 50 subrequests | `withD1Budget` default 45, reserve 5. One `batch()` is one subrequest. |
| Rows read | 5 million / day | Separate from the subrequest budget. A keyset page still scans the rows it touches. |
| Rows written | 100,000 / day | Mark inserts and run rows count. |
| Bound parameters | 100 per query | Reads of more than 100 ids use one `json_each` parameter. |

Local Miniflare timings and `meta.rows_read` are not a free-tier compliance certificate. A Cron that repeatedly wraps a large unmarked prefix can still spend row reads even when the subrequest count stays under 50. The cursor exists so a completed prefix is not re-executed; it does not make row billing zero.

### Dependency advisories

`npm audit` on 2026-10-11 reported **9 high** findings. No `npm audit fix` was applied.

| Package | Advisory shape | Decision |
| --- | --- | --- |
| `@modelcontextprotocol/sdk@1.30.0`, `@modelcontextprotocol/client`, `agents@0.24.0` | OAuth client could send credentials to an authorization server chosen by the MCP server (affected through 1.30.1). npm suggested `0.20.0`. | Exception. `0.20.0` is a downgrade and breaks the `agents@0.24.0` peer pin. Not upgraded in this pass. |
| `wrangler`, `miniflare`, `@cloudflare/vite-plugin`, `undici` | Dev/build toolchain DoS and sharp/undici issues. Suggested fix jumps the Vite plugin to 1.63.1. | Exception for this pass. The production build was not re-validated against that jump. |
| `sharp` `<0.35.5` | librsvg CVE-2026-96889. Used by icon generation, not the request path. | Exception. Not upgraded here. |
| `source-map-js` | Dev-tool event-loop DoS. | Exception. Not on the Worker request path. |

## Evidence and acceptance

Every PASS below will name executed commands and exact assertions. Source inspection
and historical reports are not execution evidence. Mandatory local integration
gates remain open until regression, MCP, browser and performance verification finish.
Physical iPhone/Android and manual assistive technology are NOT RUN unless hardware
and explicit evidence become available; they remain production release gates.

Current Cloudflare D1 documentation confirms `batch()` rolls back the entire
statement sequence on an error: [D1 Database batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/).

### Executed local evidence (2026-10-11; not final acceptance)

- Clean `npm ci`: PASS after correcting the manifest/lock mismatch between
  `agents@0.24.0`'s exact SDK peer and the original incompatible development
  dependency. No legacy-peer bypass. Original baseline installation failed;
  typecheck/test/build were unavailable on that failed baseline.
- `npm test`: PASS **45 files / 523 tests**, 43.82 seconds, including 33 actual
  Miniflare SQLite-backed D1 event/date/automation/undo cases and 16 actual-D1
  public form/Turnstile/recovery cases. Latest run began 11:51:54 local time.
- Actual D1 tests use all migrations `0001`–`0009`, retaining complete trigger
  bodies. Failure injection covers commit rollback, lost acknowledgement,
  150-record second-batch failures, equal-LWW-clock event cycles, missed-CAS
  event/audit suppression, typed date lifecycle/backfill, notification replay,
  durable automation reservation and side-effect failures, concurrent leases,
  completed/incomplete automation undo, and inverse-write audit rollback.
- Public form D1 cases cover explicit local-only test mode; production missing/
  invalid secret, expired challenge, wrong action/hostname and unavailable
  verifier; reservation/record/receipt crashes; accepted replay; concurrent
  identical submissions; stale leases; disabled forms; rejected stage gates;
  submission-ID collisions and normalized concurrent People matching without
  private receipt details. Production Siteverify outcomes are mocked narrowly;
  no real production challenge or service configuration was modified.
- `npm run typecheck`: PASS. `npm run build`: PASS, with existing large-client-
  chunk and ineffective-dynamic-import warnings. Service worker remains IIFE.
- First disposable built-Worker regression run: smoke 44 PASS; Phase 1 MCP
  37 PASS; multiuser MCP 52 PASS / 7 FAIL; Phase 2 MCP 110 PASS / 3 FAIL;
  Phase 4 MCP 38 PASS / 3 FAIL; v4 palette extraction FAIL. Structured conflict,
  absent undo acceleration context and new run-status compatibility corrections
  landed after that run. Those counts stay as the record of that run. The
  open-gate rerun section at the end of this file is the later result.
- v9 is authored and its first Chromium run exposed C06. Several first-run
  failures were verifier errors (wrong comment field, originless localStorage,
  obsolete Cron URL), not app defects. The harness now invokes Wrangler's
  supported `POST /cdn-cgi/handler/scheduled` and rejects SPA HTML as false Cron
  evidence. Full browser and performance gates remain IN PROGRESS.

## Final remediation (P4-C11, P4-C12, P4-C13, and the four open checks)

Executed in `/Users/trinity/Desktop/notion mock` on `grok/phase-4-continuation` after `69083f1`. Miniflare disposable D1. A large Miniflare BLOB is not treated as proof of the production row limit; every bound chunk length is asserted `< 2000000`.

- `npx tsc --noEmit`: PASS.
- `npm test` (`vitest run`): PASS **53 files / 581 tests**.
- `npm run build`: PASS. Existing large-chunk and ineffective-dynamic-import warnings remain. Service worker stays IIFE.
- Phase 4 D1 regression (budget, migrations `0001`–`0010`, events, forms, security, date-offset, file chunks, reminders, residual C02/C07/C09, performance): PASS **10 files / 107 tests**.

P4-C11. `tests/phase4-file-chunks-d1.test.ts` PASS **7/7**. Public upload of 100 KB, 1.9 MB, 2.1 MB, and 4.9 MB images, each chunk `<= 1048576` and `< 2000000`, download bytes equal the original. Each slice owns a buffer of that chunk's length. Over 5 MiB returns 413 and writes nothing. A chunk-insert failure and an interrupted file-record write leave no `files`, `file_chunks`, or file `records` rows. Quota exhaustion returns 507. A guessed claim and a claim used on a different form return 422. An authenticated chunk over 1 MiB returns 413. Completing a stored chunk of 2,000,000 bytes returns 413 and leaves `complete=0`. An authenticated 2.1 MB upload round-trips. A pre-existing two-chunk file still downloads; a missing chunk returns 404. SVG upload still stores the sanitized document without `<script`. Retrying an upload acknowledgement does not change the first file. Two concurrent uploads both return 200. A non-matching date-offset row is not inserted into `date_offset_marks`.

The same disposable-D1 regression was run again after those checks: PASS **10 files / 107 tests**. `npx tsc --noEmit` PASS. `npm test` PASS **53 files / 581 tests**. `npm run build` PASS.

P4-C12. Date-offset conditions use the same AND filters as event automations. The indexed day stays open: a non-match is not inserted into `date_offset_marks`, so a later match in that same day runs once. `tests/phase4-date-offset-d1.test.ts` PASS **8/8**, including the condition, custom text/date/person, deleted, archived, disabled, and invalid cases, plus the earlier fairness, budget resume, concurrent, and 1,000-row tests. `tests/phase4-budget-d1.test.ts` PASS **7/7**. The 600 completed candidates still do not starve the tail. A budget stop is not stored as a completed run.

P4-C13. `runDueReminders` reads one lookbehind page before the forward page, plus `reminders-due` for overdue and due-today rows. A not-yet-due row inside the 30-day scan does not advance `reminders-behind`, so a sustained later tail cannot hide a newer earlier reminder. The forward cursor is not reset while later rows remain. A new earlier reminder is sent on the next run when fewer than 4 unsent rows sort before it, and otherwise within `ceil((unsent rows before it + 1) / 4)` runs. `tests/phase4-reminders-d1.test.ts` was run again after that change: PASS **14/14**, including a not-yet-due tail that stays non-empty while an earlier urgent task is delivered once within that bound. `npx tsc --noEmit` PASS on the same tree.

P4-C02. `tests/phase4-residual-d1.test.ts` keeps an eight-attempt outbox row, sets `terminal_at`, leaves `processed_at` null, and deletes only the already processed row.

P4-C07. Forty `mintToken()` values are unique and match `tok_` plus 22 base62 characters, with no zero-padded body.

P4-C09. An enabled public form returns 200 with `cache-control: no-store`. After `enabled` is set false, the same URL returns 410 `{"error":"unavailable"}` with `no-store`.

P4-C06. Playwright 1.63.0 drove `http://localhost:5173/f/token-a` in headless Chromium. The public form API was fulfilled in the browser so the check is the React route, not a production Turnstile or Worker upload. Form A was filled, an image named `secret-a.png` was attached, and it was submitted. An in-page `popstate` navigation to `/f/token-b` kept the same document. Form B opened with an empty answer, an empty attachment link, no Form A receipt, no Form A file name, and a new submission id. Form B's submit body did not include Form A's upload claim or answer.

Not run in the pass above: full v4, v6, v7, v8, and v9 browser suites, smoke, MCP suites, physical iPhone/Android, and assistive technology. The next section records the gates that were rerun after that sentence. `npm audit` still reports 9 high findings. No `npm audit fix` was applied. No production deploy was run. Draft PR #4 stays unmerged.

## Open-gate rerun (local Worker on port 8788)

Fresh disposable local D1, migrations `0001`–`0010` applied, `npx wrangler dev --local --port 8788`. Users came from `scripts/smoke.sh`. This is not a production deploy.

- `bash scripts/smoke.sh http://127.0.0.1:8788`: PASS **44/44**, including the 2.5 MiB file stored as 1 MiB chunks, byte-identical download, and rejection of a chunk larger than the cap.
- `node scripts/verify-mcp-multiuser.mjs http://127.0.0.1:8788`: PASS **59/59**. The earlier 52 pass / 7 fail result is not reused.
- `node scripts/verify-mcp-phase2.mjs http://127.0.0.1:8788`: PASS **113/113**. The earlier 110 pass / 3 fail result is not reused.
- `node scripts/verify-mcp-phase4.mjs http://127.0.0.1:8788`: PASS **41/41**. The earlier 38 pass / 3 fail result is not reused.
- `node scripts/verify-v4.mjs http://127.0.0.1:8788`: PASS. `extract palette adds 5 swatches` passed. The script printed `ALL PASS`.
- P4-C06 again, Playwright against `http://localhost:5173`: PASS. In-page navigation from `/f/token-a` to `/f/token-b` left the answer empty. Form B submitted a different submission id and did not send Form A's upload claim. The public form API was still fulfilled in the browser.

Still not run: v6, v7, v8, v9, Phase 1 MCP, Phase 3 MCP, physical iPhone/Android, and assistive technology.

## Evidence recaptured on the current HEAD

The scratch logs from the earlier pass were not kept. These commands were run again on `grok/phase-4-continuation` at `8844b13` in `/Users/trinity/Desktop/notion mock`. Counts below replace the earlier `8/8` date-offset figure and the `107` regression figure for this HEAD.

- `tests/phase4-file-chunks-d1.test.ts`: PASS **7/7**. Each accepted image (100 KB, 1.9 MB, 2.1 MB, 4.9 MB) is stored in chunks whose bound length is `<= 1048576` and `< 2000000`, and the download matches the original bytes.
- `tests/phase4-date-offset-d1.test.ts` together with `tests/phase4-budget-d1.test.ts`: PASS **18/18**. That is 11 date-offset tests, including status, text, date, and person conditions, a later match in the same day, deleted, archived, disabled, and invalid rules, and 7 budget tests, including the 600-row completed prefix.
- Phase 4 disposable-D1 regression (budget, migrations `0001`–`0010`, events, forms, security, date-offset, file chunks, reminders, residual, performance): PASS **10 files / 118 tests**.
- P4-C02, P4-C07, and P4-C09 are the three tests in `tests/phase4-residual-d1.test.ts`, included in that regression and passing.
- P4-C06, Playwright against `http://localhost:5173`: PASS. An in-page move from `/f/token-a` to `/f/token-b` left the answer empty. Form B used a different submission id and did not submit Form A's upload claim. The public form API was fulfilled in the browser.
- `npx tsc --noEmit`: PASS.
- `npm test`: PASS **53 files / 592 tests**.
- `npm run build`: PASS.

No production deploy was run. Draft PR #4 stays unmerged.

## Certification run on `4611193` — FAIL

Command: `npm run certify:phase4` from `/Users/trinity/Desktop/notion mock`. The orchestrator owned a fresh disposable local D1 and Worker. Artifact:

`.artifacts/certification/4611193ccdb58386b4d479726aa409f9144162c9-2026-10-14T08-09-12-634Z-complete/`

Decision: **FAIL**. Starting and tested SHA: `4611193ccdb58386b4d479726aa409f9144162c9`. Source fingerprint: `18612985b25be37f819444fef801ac38754fae0fddf91446ef09517443f2e75e`. 2026-10-14T08:09:12Z to 2026-10-14T08:24:19Z. This does not certify later uncommitted runner edits.

Passed: prerequisites, dependencies, lockfile, whitespace, migrations (10), harness (53), typecheck, unit (617), build, actual D1 (136), security (reviewed MCP OAuth-client exception, production release still blocked), browsers (Chromium, Firefox, and WebKit), smoke (44), MCP base (71), multiuser (59), phase 1 (37), phase 2 (113), phase 3 (64), phase 4 (41), v4 (33), v6 (150), v7 (114).

Failed:

- v8: 139 PASS / 1 FAIL / 3 external NOT RUN. The failure is `J6: related source record is rendered as a navigable browser link` on Chromium desktop. The conversion backlink is stored; the destination page did not show the source title within the wait.
- v9: 54 PASS / 12 FAIL on that commit. J10 did not observe the interrupted automation run return to `completed` after the SQLite trigger was dropped. WebKit missed the lost-response and security-check form messages. Firefox and WebKit desktop did not focus `Request approval` within 30s. A later standalone Chromium rerun passed that desktop dialog check.

External gates remain NOT RUN: physical iPhone/iPad Safari, physical Android, manual assistive technology, and native 400% zoom. Automated 320px reflow is not native zoom.

The three remaining high npm audit entries are the reviewed `@modelcontextprotocol/client` OAuth advisory propagated through Agents/SDK packages. Raw audit output is in the artifact. No `npm audit fix` and no peer override was applied. The exception does not certify production release.

C14–C15 are in the passing unit and D1 suites. C16 is the fail-closed runner, covered by the 53 harness selftests in this run. C17–C19 are the automation, upload, and form-recovery fixes in `5357960`. C20 is the 100-row reminder fixture batch, covered by the passing D1 suite.

## Complete local acceptance on `df49d6b1e376cb8a01501fb4a410f1e52ff98c17` — PASS

Executed `npm run certify:phase4`, exit **0**, from 2026-10-14T09:30:46.104Z to
2026-10-14T09:44:19.222Z. All **26 mandatory local gates PASS**, zero FAIL and zero
mandatory NOT RUN. This supersedes the failing `4611193` run without erasing it.
Source fingerprint: `5b27f70b4904fa84768e5425b6405443193b10f52483e241fec874c3a0dc8413`.

Artifact: `.artifacts/certification/df49d6b1e376cb8a01501fb4a410f1e52ff98c17-2026-10-14T09-30-46-104Z-complete/`. The generated `summary.json`, `commands.json`,
`environment.json`, `test-results.json`, `report.md`, `security-audit.json`,
`security-decisions.json`, `migrations.json`, `performance.json` and per-suite
logs retain exact commands, exits, runtimes, fixture provenance and assertions.
The documentation commit recording this result must itself receive a complete
rerun before push; the final PR summary will name that exact tested SHA and artifact.

| Suite | PASS | FAIL | Mandatory NOT RUN | Seconds |
| --- | ---: | ---: | ---: | ---: |
| prerequisites | 6 | 0 | 0 | 0.03 |
| dependencies | 1 | 0 | 0 | 0.64 |
| lockfile | 2 | 0 | 0 | 0.73 |
| whitespace | 1 | 0 | 0 | 0.28 |
| migrations | 10 | 0 | 0 | 0.00 |
| harness | 55 | 0 | 0 | 8.71 |
| typecheck | 1 | 0 | 0 | 1.34 |
| unit | 617 | 0 | 0 | 61.05 |
| build | 1 | 0 | 0 | 2.03 |
| d1 | 136 | 0 | 0 | 53.63 |
| security | 1 | 0 | 0 | 1.16 |
| browsers | 3 | 0 | 0 | 1.46 |
| smoke | 44 | 0 | 0 | 4.86 |
| mcp-base | 71 | 0 | 0 | 11.21 |
| mcp-multiuser | 59 | 0 | 0 | 1.69 |
| mcp-phase1 | 37 | 0 | 0 | 1.22 |
| mcp-phase2 | 113 | 0 | 0 | 2.13 |
| mcp-phase3 | 64 | 0 | 0 | 1.62 |
| mcp-phase4 | 41 | 0 | 0 | 1.07 |
| v4 | 33 | 0 | 0 | 35.77 |
| v6 | 150 | 0 | 0 | 210.96 |
| v7 | 114 | 0 | 0 | 159.68 |
| v8 | 140 | 0 | 0 | 130.70 |
| v9 | 66 | 0 | 0 | 65.19 |
| performance-evidence | 114 | 0 | 0 | 0.01 |
| source-integrity | 1 | 0 | 0 | 0.07 |

The complete Vitest suite has 55 files / 617 assertions. The separately rerun
11-file actual-D1 subset has 136 assertions; these overlap the unit count and
are not additional distinct tests. Migrations cover fresh 0001–0010 and Phase 3,
0007 and 0009 upgrades. Build warnings remain the large client chunk and
ineffective dynamic imports; the service worker stays IIFE.

Browser binaries: Chromium 153.0.8010.12, Firefox 155.0 and WebKit 26.6,
from pinned Playwright 1.63.0. The supported engine/viewport matrix is:

| Suite | Chromium PASS by layout | Firefox PASS by layout | WebKit PASS by layout |
| --- | --- | --- | --- |
| v4 | desktop 33 | outside existing v4 scope | outside existing v4 scope |
| v6 | desktop 26, compact 24 | desktop 26, compact 24 | desktop 26, compact 24 |
| v7 | desktop 62, compact 13, tablet 9 | desktop 12, compact 3 | desktop 12, compact 3 |
| v8 | desktop 46, compact 16, tablet 5, 320px 5 | desktop 21, compact 13 | desktop 21, compact 13 |
| v9 | 22 | 22 | 22 |

v9 runs every J1–J12 journey in each engine and the integrated
`phase4-platform-checks.mjs` assertions. Widths are 320, 390, 768, 1024 and
1440 pixels; checks include keyboard/focus restoration, touch, validation,
reflow, reduced motion, offline/reconnect and delayed/lost public responses.
Firefox uses `hasTouch` without unsupported Playwright `isMobile`. Public
fault injection blocks service workers only in that context; authenticated
offline and independent public touch acceptance retain default SW behavior.

C14 and C15 are FIXED AND VERIFIED by the complete suite and separate actual-D1
run. C16 is FIXED AND VERIFIED by the fail-closed complete-runner fault injections
and 55 harness selftests. C17–C19 (malformed rule isolation, authenticated upload
races and stale form authority) remain verified in the 18-test review D1 file.
C20–C24 are documented with evidence in
[the independent certification review](phase-4-independent-certification-review.md).
C21's Escape fix passes approval focus restoration in all engines. C22 repairs
fixture/selector behavior without removing functional assertions. C23 makes
missing performance evidence blocking; C24 bounds competing local runtimes.

### Security decision

The current audit records **3 high / 0 critical** package entries, all from the
single MCP OAuth-client advisory GHSA-6qxp-vccf-f47h. Raw npm exit **1** is retained.
The local gate accepts only the reviewed server-only reachability exception;
novel high/critical advisories or outbound OAuth-client use fail certification.
Compatible toolchain/sharp/source-map fixes are in the lockfile. SDK 1.30.0 and
client 2.0.0 match Agents 0.24.0's exact peers; a coordinated Agents/MCP migration
is deferred for separate compatibility review. No forced peer downgrade or
`npm audit fix` was used. See
[dependency decisions](phase-4-dependency-security.md). The exception requires
independent review and blocks production-release certification.

### Local resource evidence

The following is the separate D1 run on a disposable 1,000-record fixture.
Binding RPCs and SQL statements differ; rows include index/trigger work.

| Workload | Repetitions | Total ms | Binding calls (max/call) | SQL statements | Rows read | Rows written |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| seed 1000 records | 1 | 3821.97 | 40 (40) | 2030 | 5010 | 13000 |
| record/event commit 100 rows | 1 | 480.65 | 2 (2) | 301 | 800 | 1500 |
| bounded reminder Cron tick | 4 | 334.05 | 91 (26) | 105 | 2799 | 122 |
| C14 budgeted reminder lookbehind | 11 | 481.85 | 114 (14) | 116 | 2628 | 31 |
| C15 budgeted cross-database date-offset | 1 | 167.97 | 35 (35) | 45 | 61 | 47 |
| form accepted acknowledgement | 5 | 558.08 | 110 (22) | 160 | 201 | 202 |
| automation one record and journal | 5 | 497.31 | 75 (15) | 115 | 160 | 195 |

C14 reached the actionable tail once in 11 measured invocations after the
600-unassigned-row setup; C15 completed its cross-database output once. Each
uses a 45-call scoped budget. Raw metrics classify cursor writes/reads, date
candidate scans, record/member lookups and other statements; EXPLAIN retains
Inbox/date sweep/outbox plans. Crash recovery, concurrent execution, undo, file
reconstruction and lost acknowledgements are asserted in the same complete
matrix. These measurements are local Miniflare/Playwright evidence, not deployed
Cloudflare latency or production billing.

Official [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
confirm 50 Free-plan query subrequests, 100 bound parameters and the 2,000,000-byte
row/BLOB ceiling; 45 calls preserve five calls of headroom.
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) separately
meters rows read/written (Free daily allowances: 5 million / 100,000).
The [batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
executes statements transactionally. Batching reduces binding calls, not row
charges. No production cost claim follows from these local timings.

### Acceptance boundary

**PASS — READY FOR INDEPENDENT REVIEW** for applicable local source integration.
Physical iPhone/iPad Safari, physical Android, manual VoiceOver/TalkBack and
native 400% browser zoom remain **NOT RUN** production gates. Automated 320px
reflow and WebKit do not certify native zoom or real iOS Safari. The dependency
exception also requires independent security review before release. No merge
or deployment has occurred. No manual coordination is required for the automated
matrix: future reruns use `npm run certify:phase4`. Quick and extended modes are
documented in [the certification guide](phase-4-certification.md).

## P4-C25 — Scheduled-time fairness and final rerun

The subsequent complete run on `f99c912c96eb3789be5868a5acaca972eb0bd1bd`
failed v9 with **63 PASS / 3 FAIL**: J10 recovery timed out in all engines.
All other 25 mandatory gates passed. Its artifact is
`.artifacts/certification/f99c912c96eb3789be5868a5acaca972eb0bd1bd-2026-10-14T09-50-37-186Z-complete/`.
That failure is retained and cannot certify newer source.

The preserved disposable D1 showed all three interrupted runs remained
`retryable_failure`, with `attempts=1`, `retry_at=0`, and `lease_until=0`.
Recovery had not been attempted: the scheduler selected its initial phase from
`Date.now()`'s 15-minute slot. Repeated calls within a slot, or multiple delayed
scheduled deliveries at one wall time, could repeatedly exhaust the budget in
other phases. The earlier passing run happened in a different phase slot.

`worker/index.ts` now forwards `ScheduledController.scheduledTime` to
`runScheduled()`. Only phase selection uses it; current deadlines, leases,
retention and retry backoff retain real-time semantics. The default argument
keeps direct callers compatible. v9 advances scheduled event times in 15-minute
steps through Wrangler's local endpoint, records them in JSON and invokes two
identical scheduled timestamps concurrently. Completion, dedupe and undo
assertions remain mandatory.

The actual-D1 fairness regression now holds wall time fixed while 24 scheduled
slots advance. Before the source correction it failed with zero reminders;
afterward the complete budget suite passed **7/7** in 12.12 seconds. The built
Worker v9 rerun passed **66/66**, including J10 and integrated platform checks
in Chromium, Firefox and WebKit. Typecheck and build passed. These are targeted
results; final acceptance requires a new full `npm run certify:phase4` on the
committed correction. The generated SHA-scoped report and PR summary identify
that final run, rather than reusing either `df49d6b` or `f99c912`.

API evidence: [Cloudflare scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)
defines `scheduledTime` as the intended execution time; the
[Cron testing guide](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
supports passing `time` to local scheduled-event testing. The pinned Miniflare
entry worker accepts that parameter at the established handler endpoint.

## Outstanding Integrity Remediation — P4-INT-01 through P4-INT-06

This ledger supersedes any inference that the historical `75aa48f` certification
covered these findings. That run certified its existing assertions only.
C21–C25 retain their earlier meanings. This round starts at
`75aa48fc643f92cd685286c172803af2edc27355`, with a clean original Desktop checkout.
PR #4 was returned to draft during remediation. No merge or deployment occurs.

### Executed red-to-green evidence

The ignored `.artifacts/integrity-red-green/` directory retains the original
failing transcripts and targeted reruns. The deterministic regression files are
committed; the complete certification discovers every top-level test file and
separately discovers every `phase4-*-d1.test.ts` file. Thus the new D1 families
run both in the unit gate and the independent D1 gate. No new certification
framework was introduced.

| Finding | Starting implementation and observed failure | Root cause and correction | Regression and integration evidence | Correction commits | Status |
| --- | --- | --- | --- | --- | --- |
| **P4-INT-01 — Offline binary deletion** | `deleteFile()` queued metadata but swallowed failure of a one-shot binary DELETE. The new actual-D1 tombstone test expected zero files and observed **2** retained binary rows. | Migration 0011 records durable deletion intent and reclaims unreferenced file/chunk rows in the same transaction as the synced tombstone. Client queues parent and thumbnail tombstones and discards local bytes. Persistent markers and upload guards prevent resurrection. Legacy tombstones are reconciled during migration; unknown incomplete uploads are not indiscriminately purged. Explicit live block/cover/thumbnail references retain shared bytes until their own reference is removed. The legacy DELETE route now follows the same intent/ownership rules. | `phase4-integrity-d1.test.ts`: cleanup failure rolls back tombstone, duplicate replay, parent+thumbnail batch, quota, auth, shared references, legacy DELETE, upload rejection. `phase4-migrations-d1.test.ts`: upgrade existing tombstones/shared thumbnail. v9 now closes and relaunches a persistent browser profile after an offline UI delete, verifies synced tombstone, actual files/chunks and rejected resurrection. The three-engine targeted run passed all 9 new browser assertions. | `39f6e74`, `07d5fe2` (regressions) | **FIXED AND VERIFIED** by targeted execution; complete-source certification is identified by the generated final report. |
| **P4-INT-02 — Generic database deletion** | `deleteBoard()` moved People records into `board-default`; the executed IndexedDB regression observed that exact value. The additional MCP reproduction observed `boardId:null` after `delete_item`. | Client deletion of `kind:records` now archives the database without changing any descendant or association. The generic database UI offers Archive/Unarchive instead of an unsafe Delete action. Task boards retain their move-to-default disposition. MCP generic board deletion follows archive semantics; `restore_item` restores it in place with CAS. | `integrity-client.test.ts`: People, Organizations, properties, relations, views, files, subrecords, body, new concurrent records, reopen and outbox persistence; task-board compatibility. `phase4-integrity-mcp-d1.test.ts`: executed MCP red/green and restore. v9 archives offline, reconnects, restores and checks original record/database identity in all engines. Real OAuth/MCP gate also asserts archive/restore. | `39f6e74`, `bc3076a` | **FIXED AND VERIFIED** by targeted execution. |
| **P4-INT-03 — Large changeset undo** | 101, 150 and 500-item undo each threw **at most 100 expected ids per call**; 1/99/100 passed. | Stable `undo_jobs` and frozen `undo_items` plans retain the inverse identity, original revisions, lease and per-record progress. Inverse writes use batches of at most 100 expectations; record, audit item, outbox event and checkpoint commit together. Lost responses resume from durable checkpoints. Conflicts retain human edits and produce an explicit partial state/409, with an inspectable inverse journal. `undone_by` is finalized only after pending items are settled. Undo fences pending automation/form/MCP recovery; duplicate replay cannot recreate cancelled work. Undo-of-undo remains valid. | Actual-D1 tests execute 1/99/100/101/150/500, crashes before first inverse/after committed batch/lost acknowledgement, conflicts at positions 1/120, duplicate retry, concurrent mutation, automation fencing, unauthorized calls, redo and journal counts. The old SQL-emulating C1 undo fixture was replaced by actual-D1 coverage retaining its four scenarios; partial conflict is now explicitly 409. Real built-Worker MCP performs a 101-block undo. | `07d5fe2`, `bc3076a` (MCP reporting/preview) | **FIXED AND VERIFIED** by targeted execution, including the mandatory 101-item regression. |
| **P4-INT-04 — MCP expectation chunking** | Reachable: one `edit_page.replaceBlocks` entry can parse into 501 blocks. The executed old helper applied the first chunk, then reported the guarded original block missing when checking the same full expectation map in the next chunk. This does **not** mean all bulk AI writes failed. | Expectations are scoped to relevant chunk IDs, with all guarded revisions preflighted before a large operation starts. Large guarded edits require `requestId`; frozen plans retain generated IDs, the shared changeset, lease and transactional completion checkpoints. Retry skips committed records and cannot duplicate generated blocks. New conflicts remain visible with the partial changeset. Existing unguarded deterministic pack installation retains its established reconciliation path. | Actual-D1 production helper/handler tests cover 499/500/501/1000 with first-only/second-only/mixed expectations, stale second-chunk guard before any writes, interruption after the first 500-block chunk, retry, request replay, one journal and undo cancellation of partial work. Real OAuth/MCP gate executes guarded 501-block split/replay/audit. | `bc3076a` | **FIXED AND VERIFIED** by targeted execution. |
| **P4-INT-05 — Record mention resolution** | MCP wrote literal `[[Funding Opportunity]]`; the executed regression found no `@[rec:funding]` token. Shared Markdown already supported records but MCP supplied only page/user resolvers. | Per-request live record title/ID caches now supply parse and render resolvers to page creation/edit/read and record-body edit/read. Unqualified page names win; ambiguity remains literal with a warning rather than guessing, including across databases. `[[rec:ID]]` selects an explicit visible record. Live renames render current titles; archived records remain readable; deleted records/databases do not disclose titles. Unknown/deleted record tokens remain opaque stored tokens on read, so a read/edit cannot erase the reference. | Actual-D1 handler tests cover unique title, duplicates, page-first, explicit ID, rename/archive/delete and mixed mentions. Shared tests assert unresolved-token preservation. Real OAuth/MCP writes the title, inspects the stored token and reads its title. Phase 0–4 has one shared authenticated workspace; this does not invent Phase 5 per-record ACLs. Unauthenticated/deleted-account rejection remains in the complete MCP/security matrix. | `bc3076a` | **FIXED AND VERIFIED** by targeted execution. |
| **P4-INT-06 — Embedded URL preservation** | All three executed Docs/Drive file/folder tests found saved embeds containing only owner/order/type/text, with **no URL/provider**. | A single allowlisted `markdownBlockPatch()` persists parsed block properties, including validated HTTP(S) embed URL/provider, caption, file/media metadata and todo state. Structural identity/owner/order come from the caller. Page append/create/replacement/split and record-body edits use it. Record-body reads retain the complete block fields instead of projecting away URLs. Existing `file:` references round-trip without network import. | Actual-D1 handlers test Docs/file/folder create/append/replacement/body, unrelated title edits, read/write, undo/redo and invalid URL handling. Shared mapper tests reject active URLs and arbitrary identity/owner attributes. OAuth/MCP gate asserts the complete persistence path; v9 checks a usable rendered Drive link after reload in Chromium, Firefox and WebKit. | `bc3076a` | **FIXED AND VERIFIED** by targeted execution. |

The exact initial red commands were:

```sh
npx vitest run tests/phase4-integrity-d1.test.ts tests/integrity-client.test.ts --maxWorkers=1
npx vitest run tests/phase4-integrity-mcp-d1.test.ts --maxWorkers=1
npx vitest run tests/phase4-integrity-mcp-d1.test.ts -t 'MCP database deletion'
```

The first client attempt failed before the assertion because the Node fixture
lacked localStorage. After correcting that fixture, the unchanged old
`deleteBoard()` was rerun and failed on `board-default`; that genuine reproduction
is retained as `INT-02-red.log`. Initial actual-D1 evidence was **5 failed /
3 passed** (file deletion, large undo and the fixture failure); initial MCP
integrity evidence was **5 failed / 0 passed**. Passing tests never substitute
for those source-specific reproductions.

### Integration corrections and independent diff audit

A parent+thumbnail tombstone arriving in one sync batch exposed SQLite's outer
UPSERT conflict policy overriding an inner trigger's `INSERT OR IGNORE`.
A new deterministic failing test captured `UNIQUE constraint failed:
file_deletions.id`; trigger inserts now use an explicit absence predicate. The
same test and browser close/reconnect pass afterward. Reference cleanup uses
indexed lookups and only IDs touched by the current mutation, avoiding a full
orphan pass on every record write. The migration performs the one-time legacy
reconciliation; unknown legacy uploads without deletion intent remain protected.

The durable execution CAS path also revealed a form integration ordering issue:
a concurrent normalized-email reservation could be rejected when its CAS conflict
was classified before retry. The existing concurrent-equivalent-email test failed
repeatedly with only one accepted receipt. Conflict outcomes now follow the
existing retry path; both receipts are accepted with one Person and no disclosed
match details. Functional assertions were retained.

The final source audit checks durable leases, permission checks before creating
undo jobs, atomic checkpoints/journals, cancelled bulk-write recovery, unchanged
1 MiB chunking and shared reference ownership. The required regression families
are part of the existing unit/D1 manifests, and the real MCP/v9 assertion
manifests explicitly include their integration checks. Browser failure profiles,
screenshots and traces stay ignored. No personal D1 state is used.

### Local resource measurements and final acceptance evidence

An executed disposable 1,000-record performance run measured a 500-record undo at
**42 binding calls / 2,563 SQL statements / 16,545 rows read / 11,521 rows written**,
about **4,440 ms** locally. File tombstone plus quota reclamation took **3 binding
calls / 4 statements / 3,056 rows read / 19 rows written**, about **12 ms**.
These include the existing revision/index/trigger costs and are local Miniflare
measurements, not deployed latency or production billing. The permanent
performance gate now records both workloads and the cleanup query plan; the
final run's machine output replaces these intermediate timings.

Repeat the complete matrix with **`npm run certify:phase4`**. The generated
`.artifacts/certification/<tested-SHA>-<timestamp>-complete/report.md`,
`summary.json`, `test-results.json`, command logs and source fingerprint identify
the committed source actually certified. They are authoritative for final
counts/exit status; an earlier green run cannot certify these changes. The PR
certification comment links that exact final artifact and reports the gate
matrix. The permanent command still executes all 26 mandatory local gates.

The documented three high npm findings and issue #5 are unchanged. The narrow
inbound-server exception remains subject to independent security review; it is
not a dependency removal or production security approval. Physical iPhone/iPad
Safari, Android, human assistive-technology and native 400% zoom remain external
**NOT RUN** production gates. Full local certification permits independent PR
review only after every mandatory applicable gate passes on the final commit.

### P4-INT-04 final audit boundary

The source audit added another deterministic retry regression: delete a guarded
block and append 500 new blocks, interrupt after the first 500-write chunk, then
retry the original request. The intermediate implementation returned **block old
not found**, because the handler revalidated its own committed deletion before
loading the saved operation. `INT-04-deleted-guard-red.log` records that failure.
The wrapper now resumes the durable plan before reconstructing handler state;
parent availability is still checked and the original journal/IDs are retained.
The same regression passes afterward. A durable argument hash also prevents a
request ID from adopting different arguments after the short-lived request
cache is cleaned; rejected reuse cannot lock out the original retry.

The initial comprehensive run on `a1a7dbd` was deliberately interrupted for this
source correction. Its retained report is **FAIL**, with dependent gates
explicitly NOT RUN, under
`.artifacts/certification/a1a7dbd454646dfc814d033bca00f984bb485036-2026-10-14T11-28-18-621Z-complete/`.
It is not acceptance evidence. The complete command is rerun from the corrected
committed source; the final generated report and PR comment identify that SHA.
