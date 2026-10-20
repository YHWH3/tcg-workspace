# PR #11 focused independent-review corrections

Reviewed source: `3d91ff4502d51eb791f635c9a92d96f9de66bbad`, on `phase6/ai-workflows`, stacked on the unchanged Phase 5 base `680b9a196bde0c9ff4dc39ad007219c5f5b9ab6d`. This round addresses P6-R01/R02 and verifies P6-R03. It does not reopen the Phase 0–5 audit or change the permission/Protocol 3 architecture.

## P6-R01 — CONFIRMED, corrected

The actual-D1 dashboard table/board/list regressions failed on the reviewed implementation: expected `http://localhost/boards/b/tasks/t`, received `http://localhost/pages/t`. The view branch used a page-only helper while calendar/my-work already used database record routes.

The existing client `recordHref()` is extracted unchanged into pure `shared/recordRoutes.ts`, re-exported by `src/core/views/shared.tsx`, and reused by dashboard and existing MCP record URL helpers. Table/board/list, calendar and my-work now share the application's database detail convention. Metric/activity payloads do not invent record-detail links. Existing canonical read and connector gates remain unchanged.

Evidence: `tests/phase6-read-tools-d1.test.ts` parameterized `P6-R01` cases and the calendar/my-work fixture; real OAuth `dashboard_snapshot` URLs and compact-browser task navigation in `scripts/verify-phase6.mjs`. The 1,000-record resource test checks every returned link and the existing truncation contract.

## P6-R02 — CONFIRMED, corrected

An approval-only fixture produced no weekly notification; its retry regression also observed zero delivery attempts because the old scheduler only entered notification delivery for `digest.records.length > 0`.

The scheduler selects an authorized target from tasks or pending approvals and retains only their IDs. It passes its delivery checkpoint into the existing notification transaction, so recipient/target revocation rolls back the checkpoint as well as the private copy. A preflight refusal remains pending with bounded backoff rather than acknowledging delivery. The existing per-user/week delivery key preserves idempotency, including lost acknowledgements.

Additive migration `0031_phase6_digest_outcome.sql` (registered with its hash) distinguishes `delivered`, `no_content`, `preferences_off`, and `pending`. The old `delivered` column remains the terminal-processing flag for compatibility; it must not alone be interpreted as proof that a notification was sent. Existing historical rows are not retrospectively relabelled or deleted. Automation notification preferences remain authoritative. Failed attempts retain the existing one-hour backoff/eight-attempt dead-letter bound. The AI digest screen also displays its already-authorized pending approvals and opens Inbox.

Evidence: `tests/phase6-digest-review-d1.test.ts` covers approvals only, tasks only, both, empty, revoked target, disabled user, explicit notifications off, distinct outcomes, retry, same-week deduplication, revocation at the notification transaction, lost commit acknowledgement, dead-letter exhaustion and permission-disabled compatibility. The real scheduled Worker/browser journey checks approval-only notification delivery and Inbox navigation. No fixture data is production data.

## P6-R03 — deterministic concurrency evidence

The matrix uses disposable actual D1, real session authentication, the existing canonical mutation engine and explicit barriers on record/checkpoint transactions. It does not infer race safety from repeated timing-based tests. Built-Worker OAuth/browser cases supplement the D1 barriers; no production fault-injection endpoint was added.

| Requested interleaving | Exact proof in `tests/phase6-previews-d1.test.ts` | Result contract |
|---|---|---|
| 1. Scope reduced after approval | `P6-R03 refuses approved work after reduced`; `P6-R03 fences scope-reduced immediately before the record/checkpoint transaction` | No checkpoint/journal/write; real OAuth regression also reduces the current connection before execution. |
| 2. Connector revoked after approval | `refuses revoked approval execution`; `P6-R03 fences connector-revoked immediately before the record/checkpoint transaction` | Both preflight and transaction fences reject. |
| 3. Membership removed | `P6-R03 refuses approved work after membership-removed`; `fences source revision and membership in the same commit as derived writes` | Private-space membership removal and last-moment denial prevent writes. |
| 4. Record changed | `refuses changed revisions rather than overwriting a human edit`; `P6-R03 fences record-changed immediately before the record/checkpoint transaction` | Human value survives; no preview checkpoint/journal commits. |
| 5. Human cancels after batch one | `P6-R03 human cancellation after the first committed batch prevents the next transaction` | Exactly 50 checkpointed records remain; later batches and retries refuse. |
| 6. Interruption after checkpoint | `P6-R03 interruption after a committed checkpoint resumes with complete nonduplicate attribution`; existing bounded lost-response test | 50 durable checkpoints before interruption, 150 unique journal records after resume, original actor/changeset retained. |
| 7. Racing executors | `P6-R03 transaction barrier gives a racing executor no duplicate write authority` | Second executor sees held lease (`preview_busy`); one journal item. |
| 8. Completed replay after revoke | `P6-R03 completed replay after connector revocation discloses no payload and never executes again` | Conservative rejection, unchanged row revision and one journal item. |
| 9. Partial grouped recovery | `group recovery includes committed partial previews and fences their continuation` | Partial committed writes undone; continuation refused; group API reports `atomic:false`. |
| 10. Undo with pending continuation | `P6-R03 undo of a committed partial journal fences every pending continuation` | Existing durable undo cancels pending authority and removes all live inverse targets. |
| 11. Approving session revoked | `refuses session-ended approval execution`; `P6-R03 fences session-revoked immediately before the record/checkpoint transaction` | No record/journal/checkpoint writes; real Worker uses a separate approving login then logs it out. |
| 12. Other user/connection possesses ID | `P6-R03 another user cannot execute a possessed preview ID`; `does not accept changed args, another connection or approval by the MCP bearer` | User ownership, connection identity, hash and real-session approval all enforced. |

### Confirmed cancellation defect (P6-R03-CANCEL)

The original human decision route allowed only `status='pending'`, and the UI disabled Cancel after approval. The new deterministic batch barrier received 409 from a real human cancellation; execution incorrectly continued to all 150 records. This is recorded in `r03-red.log` (one failure, 21 passes), rather than being described as already safe.

Cancellation now accepts pending/approved/executing states, clears the lease, and invalidates the next existing transaction guard. It also remains available after preview expiry; expiry cannot prevent cancellation. Completed/cancelled operations cannot be reapproved or cancelled again. The approval rule itself is unchanged: only a pending, unexpired, hash-bound proposal may be approved by the owner session. The browser exposes cancellation after approval and describes retained committed changes truthfully. Cancellation is not rollback: writes committed before cancellation remain journaled for explicit recovery/undo. An already committed response cannot be recalled.

## Executed development evidence

All paths are relative to the original checkout; ignored logs/databases/artifacts are not published as source.

- `.artifacts/phase6-review/r01-r02-red.log`: reviewed implementation, 6 failures/17 passes across dashboard and digest cases.
- `.artifacts/phase6-review/r03-red.log`: original cancellation failure, 21 passes.
- `.artifacts/phase6-review/focused.log`: 79 passes across supporting reads, digest review, preview interleavings, optional AI/digest, Phase 5 notification privacy and history.
- `.artifacts/phase6-review/browser-preflight/`: real Chromium Worker/OAuth/browser report, 13 journeys passed; includes the four new review journeys.
- `.artifacts/phase6-review/cost/phase6-cost.json`: 1,000-record measurements, including dashboard links and scheduled notification delivery, every measured request <=45 binding calls.
- Typecheck and production build are checked before the final committed-source certification. Development/dirty-source runs above are regression evidence, not final clean-HEAD acceptance.

## Final-source acceptance

`npm run certify:phase6` continues to require all 30 earlier mandatory gates, discovers the new `phase6-*-d1.test.ts` suite, validates all 31 migration hashes and exercises 13 Phase 6 journeys on each of Chromium/Firefox/WebKit. Unit and dedicated D1 totals overlap. The authoritative final SHA/fingerprint, stage exits, assertion completeness, browser versions, raw audit and resource counts are generated in `.artifacts/certification/<SHA>-<timestamp>-complete/`; source is not edited after that run to insert its own final hash.

Permissions remain off outside disposable fixtures. No merge, deployment, remote migration, paid AI invocation, production activation or destructive retention cleanup is authorized. Real Workers AI, real third-party AI hosts, physical iOS/Android, human screen readers and native 400% zoom remain external NOT RUN checks.
