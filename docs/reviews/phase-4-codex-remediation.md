# Phase 4 Codex integration remediation

Starting development HEAD: `4c42794d411b579518602e99d5e25d42bd6c1439`.
Starting main HEAD: `3a742acc2c09c9be0d8464d304544fd435166899`.
All ten prior Phase 4 commits remain ancestors of this isolated integration branch.
Production data and services are outside this verification scope.

## Mandatory findings

| Finding | Source-confirmed root cause and risk | Replacement contract | Status |
| --- | --- | --- | --- |
| P4-R01 | `worker/sync.ts` commits records before `worker/events.ts` independently stages outbox rows. An interrupted Worker can lose downstream work permanently. | Each successful CAS write and its event commit in one D1 batch; capture actual revision inside that transaction. Preserve each completed chunk on later failure. | IN PROGRESS |
| P4-R02 | `maintainDateIndex()` deletes all task dates and rebuilds from touched-only `after`. Unrelated edits erase deadlines. | Reconcile against authoritative persisted task and board field definitions inside one D1 transaction. Retry reads current state. | IN PROGRESS |
| P4-R03 | Event derivation and notification/reminder recipients read `assignee`, while task storage uses `assigneeId`. | Canonical `assigneeId` throughout server routing and trigger validation. | IN PROGRESS |
| P4-R04 | Missing Turnstile secret accepts `pass` and exposes a test schema. | Missing configuration fails closed; deliberate disposable-local flag additionally requires loopback request hostname. Production verifies token, action and hostname. | IN PROGRESS |
| P4-R05 | Existing run claims always skip replay; side effects and changeset metadata can land partially. | Leased resumable runs, durable plans/checkpoints, deterministic side effects and atomic audit recording. | IN PROGRESS |
| P4-R06 | A reserved processing receipt always returns 202, including abandoned requests. | Leased resumable submissions, deterministic plans/attachments, authoritative accepted replay and bounded honest terminal outcomes. | IN PROGRESS |

## Additional source review

| Finding | Evidence | Risk / corrective requirement | Status |
| --- | --- | --- | --- |
| P4-C01 | Notification/recurrence fan-out catches database errors; outbox is subsequently marked processed. | A transient fan-out failure silently loses work. Propagate recoverable failures and deduplicate every logical notification. | IN PROGRESS |
| P4-C02 | Cron marks events processed after five attempts then immediately deletes processed outbox rows. | Failure evidence and recoverable work disappear. Retain terminal errors explicitly; delete only successful retained rows. | IN PROGRESS |
| P4-C03 | Reminder dedupe inserts before notification independently. | Failure between inserts permanently burns a reminder. Couple dedupe with notification persistence. | IN PROGRESS |
| P4-C04 | Public upload ownership is only form-scoped; submitted file IDs need no visitor proof. | A visitor can attach another visitor's pending upload within the same form. Bind uploads to a deliberate visitor/submission capability. | IN PROGRESS |
| P4-C05 | Public forms acknowledge acceptance regardless of rejected `applyChanges()` writes and suppress changeset persistence errors. | False success and missing undo after approval-gate rejection or D1 failure. Receipt acceptance requires complete durable operation. | IN PROGRESS |
| P4-C06 | The first v9 browser run navigated between public form tokens; React retained the previous token's receipt and transient state. | Token changes must clear receipt, answers, submission identity and upload claims before loading only the destination draft. Fixed in `src/public/FormView.tsx`; browser rerun pending. | IN PROGRESS |
| P4-C07 | `mintToken()` drew 16 modulo-biased base62 symbols and padded six deterministic zero characters while claiming 128 random bits. | Generate 22 independent base62 symbols by rejection sampling (>128 bits), preserving token syntax and old token lookup compatibility. | IN PROGRESS |

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
