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

P4-C11. `tests/phase4-file-chunks-d1.test.ts` PASS **7/7**. Public upload of 100 KB, 1.9 MB, 2.1 MB, and 4.9 MB images, each chunk `<= 1048576` and `< 2000000`, download bytes equal the original. Over 5 MiB returns 413 and writes nothing. A chunk-insert failure and an interrupted file-record write leave no `files`, `file_chunks`, or file `records` rows. Quota exhaustion returns 507. A guessed claim and a claim used on a different form return 422. An authenticated chunk over 1 MiB returns 413. An authenticated 2.1 MB upload round-trips. A pre-existing two-chunk file still downloads; a missing chunk returns 404. SVG upload still stores the sanitized document without `<script`. Retrying an upload acknowledgement does not change the first file. Two concurrent uploads both return 200.

P4-C12. Date-offset conditions use the same AND filters as event automations. The indexed day stays open: a non-match is not inserted into `date_offset_marks`, so a later match in that same day runs once. `tests/phase4-date-offset-d1.test.ts` PASS **8/8**, including the condition, custom text/date/person, deleted, archived, disabled, and invalid cases, plus the earlier fairness, budget resume, concurrent, and 1,000-row tests. `tests/phase4-budget-d1.test.ts` PASS **7/7**. The 600 completed candidates still do not starve the tail. A budget stop is not stored as a completed run.

P4-C13. `runDueReminders` reads one lookbehind page before the forward page. The forward cursor is not reset while later rows remain. A new earlier reminder is sent on the next run when fewer than 4 unsent rows sort before it, and otherwise within `ceil((unsent rows before it + 1) / 4)` runs. After the lookbehind cursor has moved past a skipped row, it restarts once the unsent rows between it and the forward cursor have been examined, then includes that row on the next pass. `tests/phase4-reminders-d1.test.ts` PASS **6/6**: urgent row during a later backlog, five unsent rows then the sixth within two runs, date moved earlier and later, reassignment, cleared and restored date, archive and unarchive, missing recipient, opted-out recipient, concurrent runs, notification failure, budget stop, cursor restart, and 1,000 indexed rows. Each logical reminder is delivered once.

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
