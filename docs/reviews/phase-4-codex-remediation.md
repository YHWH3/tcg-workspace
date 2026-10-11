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
| P4-C02 | Cron marks events processed after five attempts then immediately deletes processed outbox rows. | Failure evidence and recoverable work disappear. Retain terminal errors explicitly; delete only successful retained rows. | FIXED IN SOURCE, NOT VERIFIED |
| P4-C03 | Reminder dedupe inserts before notification independently. | Failure between inserts permanently burns a reminder. Couple dedupe with notification persistence. | FIXED AND VERIFIED |
| P4-C04 | Public upload ownership is only form-scoped; submitted file IDs need no visitor proof. | A visitor can attach another visitor's pending upload within the same form. Bind uploads to a deliberate visitor/submission capability. | FIXED AND VERIFIED |
| P4-C05 | Public forms acknowledge acceptance regardless of rejected `applyChanges()` writes and suppress changeset persistence errors. | False success and missing undo after approval-gate rejection or D1 failure. Receipt acceptance requires complete durable operation. | FIXED AND VERIFIED |
| P4-C06 | The first v9 browser run navigated between public form tokens; React retained the previous token's receipt and transient state. | Token changes must clear receipt, answers, submission identity and upload claims before loading only the destination draft. Source fix remains; this continuation did not rerun the browser. | FIXED IN SOURCE, NOT VERIFIED |
| P4-C07 | `mintToken()` drew 16 modulo-biased base62 symbols and padded six deterministic zero characters while claiming 128 random bits. | Generate 22 independent base62 symbols by rejection sampling (>128 bits), preserving token syntax and old token lookup compatibility. | FIXED IN SOURCE, NOT VERIFIED |
| P4-C08 | Grouping could attach a new event to an already-read notification. | A new delivery after a read group must start an unread generation. | FIXED AND VERIFIED |
| P4-C09 | A disabled public form could be served from a cached enabled response. | Disabled forms must not be treated as submittable from cache. | FIXED IN SOURCE, NOT VERIFIED |
| P4-C10 | `runDateOffsetAutomations()` reread an unbounded completed `date_index` prefix on every Cron tick and starved later rows under the D1 binding budget. | Bounded keyset pages, a durable `rhythm_sweep_cursors` row per automation, and `date_offset_marks` so examined rows are not executed again. Budget exhaustion stays retryable. | FIXED AND VERIFIED |

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

P4-C02, P4-C06, P4-C07, and P4-C09 are not marked verified here. No test in this run asserted terminal-outbox retention, token entropy, disabled-form cache behavior, or a browser token change. P4-C06 and the v4 `networkidle` hang have source/harness edits in `8a50be1` only.

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
  landed after that run; these failures are NOT relabelled PASS until rerun.
- v9 is authored and its first Chromium run exposed C06. Several first-run
  failures were verifier errors (wrong comment field, originless localStorage,
  obsolete Cron URL), not app defects. The harness now invokes Wrangler's
  supported `POST /cdn-cgi/handler/scheduled` and rejects SPA HTML as false Cron
  evidence. Full browser and performance gates remain IN PROGRESS.
