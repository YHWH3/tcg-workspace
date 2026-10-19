# Phase 6 implementation and verification

This local development checkpoint continues `680b9a196bde0c9ff4dc39ad007219c5f5b9ab6d` (accepted Phase 5 source tree `5387ddb48b85aa12c995d0feb86040b95c92c1e6`) on `phase6/ai-workflows`. No push, merge, deployment, remote migration, live permission activation or real AI-provider invocation is authorized or performed by this work.

## Implementation inventory

| Workstream | Implementation and verification contract |
|---|---|
| Scoped connectors | `worker/connectorAccess.ts`, canonical access/mutation/read fences, two-step OAuth consent, durable current scopes, Settings scope reduction/revoke. Existing legacy grants fail closed when permissions are enabled. Actual-D1 tests cover membership changes, expiry, cross-account and connection reduction/revocation. |
| Supporting reads | `worker/mcpReadTools.ts`: dashboard aggregation/calendar/my-work/activity, bounded activity pagination, depth-two authorized neighbors and capped attachment metadata/transcripts. Existing history is reused. Tests exercise current authority and hidden relation endpoints. |
| Preview and approval | `worker/aiPreviews.ts`, migration 0029: frozen argument hash/expected revisions/source dependencies, session-only human approval, lease claim, 50-record atomic journal/checkpoint batches, pending continuation and metadata-only completed replay. No MCP approval capability. Original request identity remains after transport-replay cleanup. |
| Workflow library | Shared seven-workflow inventory and MCP prompts; concrete `propose_workflow`, `operating_review_context`, `find_collaborators`, `propose_suggestion`, and existing query/conversion tools. Real source-linked task/page writes, retained provenance, inferred labels, resolved owners and original-source preservation. The assistant composes the proposed text; Workspace does not pretend that a deterministic prompt is an executed LLM. |
| Browser interfaces | `/ai`, `/ai/review/:id`, `/ai/undo/:id`; connection management in Settings; human approval/cancel/execute/resume, editable suggestions, current digest, provider/budget status and grouped partial recovery. Permission-epoch keys clear mounted proposals, and server operations are unavailable offline. |
| Optional AI/search | `worker/aiProvider.ts`, `aiSemantic.ts`, `aiClassification.ts`, `aiConfig.ts`: OFF by default, strict provider contracts, shared daily/per-user reservations, leased embedding jobs on the existing FTS pipeline, unchanged-text reuse, bounded current-authority hybrid retrieval and honest FTS fallback. Simulated providers only in automated tests. |
| Digest/classification | Existing rotating Cron and automation execution are extended, not replaced. Digest IDs only are retained; reads and notifications enforce current rights. Delivery retries are durable, delayed and bounded. Classification creates pending, provenance-labelled suggestions and never directly applies model output. |
| Injection/network boundary | Structured untrusted-source labels, scoped grants, canonical writes/current revisions, real human decisions, safe replay and server quota limits. MCP remote image/file import is denied; internal explicitly consented imports additionally require trusted exact HTTPS hosts, no redirects/query/credentials/local addresses and bounded streams. Ordinary uploads/Drive links remain available. |
| Certification | `npm run certify:phase6` extends the existing orchestrator, all earlier mandatory gates, automatic Phase 6 actual-D1 discovery, a new built-Worker OAuth/browser gate and mandatory 1,000-row resource evidence. No competing framework or paid CI. |

## Focused corrections made during implementation

These are reproducible integration defects in the new work, not a reopened Phase 0–5 audit.

| ID | Defect and correction | Regression evidence |
|---|---|---|
| P6-DEV-01 | Planning originally preceded completed request-ID replay, preventing Phase 5's safe replay path after revocation. Completed replay now runs first; retained preview identity also survives replay-row retention. | Existing R03 tests failed in `unit-integration-progress.log`, then focused replay and legacy integration reruns passed. Phase 6 workflow lost-response and argument-identity tests assert a single durable preview/changeset. |
| P6-DEV-02 | New preview execution initially lacked the old bulk job's undo fence and transactional source authority/revision guard. Undo now cancels pending previews; execution checks source graph revisions/capabilities and all remaining expected revisions in the record transaction. | `phase6-previews-d1.test.ts` injects revocation immediately before commit and source mutation after approval; no derived record is written. Existing interrupted multi-chunk and durable undo tests remain. |
| P6-DEV-03 | The first dashboard implementation assumed one database for calendar/my-work blocks. It now consumes actual multi-source calendar configuration, shared calendar/aggregation functions, current assigned open work, pinned views and relation context. | The new schema-parity test failed in `unit-preacceptance.log`; current supporting-read tests exercise these real block shapes. Partial workloads are explicit. |
| P6-DEV-04 | A digest notification failure escaped its phase and aborted subsequent Cron work. Runs are now reserved durably before generation, retain retry/dead-letter state, back off, and use notification deduplication. | Existing Cron failure-injection test and new digest failure/retry test reproduced the error. Focused recovery rerun: 59 tests passed; final acceptance reruns the complete suite. |
| P6-DEV-05 | Planned activity originally retained a temporary planner changeset ID. Preview persistence now rewrites activity attribution to the frozen actual journal ID; workflow-created records also log attributable activity. | Workflow regression asserts activity `meta.changesetId` equals the committed changeset. Human-only large/deletion-producing undo prevents a consequential-write bypass. |
| P6-DEV-06 | Optional-provider failure could return an older keyword payload after a concurrent revocation. All async fallbacks now revalidate observed authority; embedding writes use leased dirty tokens and current document revisions. | Provider-failure/revocation, concurrent embedding, unchanged-text reuse and stale-document tests use disposable D1 with simulated providers. |

## Evidence and exact-source discipline

Development evidence is preserved under `.artifacts/phase6/`, including failed runs. An intermediate full unit run executed while work continued and is **not final-source evidence**: 1,199 passed / 5 failed. Its failures exposed or captured the corrections above; passing tests from that run do not certify newer files. Focused Phase 6 reruns and built-Worker/browser runs are also development evidence until repeated by the complete clean-commit command.

The authoritative final result is generated automatically by:

```sh
npm run certify:phase6
```

Find `summary.json`, `report.md`, `commands.json`, `environment.json`, `test-results.json`, raw `security-audit.json`, performance measurements, fixture provenance, suite logs, and failure screenshots/traces under `.artifacts/certification/<exact-SHA>-<UTC-timestamp>-complete/`. The report records the committed SHA, source fingerprint, assertion completeness, engine versions, exits and stage durations. Start/end source must be clean and unchanged. Final counts intentionally live in that generated exact-source report instead of being copied into source and invalidating its certification afterward.

`certify:phase6:quick` runs the fast gates for development; it does not certify the browser/MCP matrix. All earlier Phase 4/5 gates remain mandatory in complete mode. Dedicated D1 tests also run within the unit suite, so those counts must not be added as unique tests.

Legacy MCP fixtures now explicitly include their disposable human's session-authenticated review step. They do not bypass application approval by writing approval rows directly. The new Phase 6 real OAuth/Streamable-HTTP runner uses an unwrapped client to prove that MCP cannot approve itself. The optional-provider contracts are simulated and labelled separately from the provider-disabled real Worker/browser journey.

## Resource evidence and supported bounds

`tests/phase6-cost-d1.test.ts` creates 1,000 actual D1 records and records binding calls, SQL statements, rows read/written and local duration for digest generation, a 150-record frozen plan and bounded execution invocations. Each invocation must stay at or below 45 binding calls. The certification aggregates this alongside the existing Phase 4/5 cost/fairness evidence. Statements and binding calls are distinct; local Miniflare timing/row metadata does not establish regional latency or production billing.

Vectors use a bounded 500-candidate D1 scan. Dashboards and digest results can be incomplete and say so. The documented sorted-record query limit remains. Failed provider reservations are not refunded, and provider costs are not estimated from these local tests. Migration 0030 queues existing committed search documents once; production migration/index sizing remains part of the deferred release review.

## Operational and external gates

- Permissions remain OFF in existing environments; only disposable fixtures enable them.
- Optional AI is OFF; no real Workers AI embedding/classification/digest prose was certified. The user-selected MCP host generates draft content. Real-host subscription/connector support varies and is not proved by protocol tests.
- MCP remote import is intentionally unavailable by default. Upload files in Workspace or use supported links. A trusted-host operator configuration is required for any separately human-approved internal network import; no claim of general DNS-rebinding protection is made.
- Expired previews, rejected suggestions and historical copies are retained. No destructive production retention decision or purge is enabled.
- Physical iPhone/iPad Safari, physical Android, human VoiceOver/TalkBack/NVDA, native 400% zoom, real Turnstile, real Cloudflare deployment, production backup/rollback/monitoring and production permissions activation are **NOT RUN** here.
- For physical-device review: open the normal HTTPS staging `/ai` and Settings AI connections; select/reduce/revoke scopes; propose a meeting workflow through a supported client; open its review link, inspect before/after values, approve/cancel, execute/resume and undo; edit/accept/reject a suggestion; rotate the device and use the keyboard/screen reader through every control. Capture device/OS/browser, screenshots and assistive-technology notes. Expected results match automated journeys with no overflow, obscured controls, stale restricted content or false offline execution success. These are production-release gates, not automated desktop evidence.

No GitHub publication, main integration or production release is implied by local certification. Independent source review remains required before those separately authorized operations.
