# Website integration implementation ledger

## Authorized boundaries
New isolated branches, commits, pushes and draft PRs only. Existing PRs and original checkouts stay unchanged. No deployment, remote migration, real email/payment/mint, paid inference or global trust change. Permissions enabled only in disposable fixtures.

## Source provenance
Workspace integration merge a069103 combines release b6c3c4a4105fc3f6ebdba557e86f638426fa7a97 with Website commits 13eecf4 and d4ff938f3a8bde4bb2680ea516a2c431e6ac1288. Site starts at cc556fc43ed0d092008f10b8ec6dce20875dbaad, 29 commits after main 1c2ce3656baffa7719e62aa2ecb1f05c35782512. Remote release/main heads matched those audited starting points.

## Implementation
- W01/F1: relay D1 outbox, atomic patron event writes, leases, cron recovery, retry ceiling, protected replay, delivered-body retention, privacy export/erase, durable email receipts and uncertain-outcome handling.
- W02/F2: server-only sponsored destination grant, administrator setup/revocation, canonical editing rights, commit-time grant/session/source fences; no extra user account or permission bypass.
- W03/F3: checkout application and full applied event persist before provider order creation.
- W04/F4: immutable payload/timestamp and canonical submission identity, browser session recovery, explicit new-submission action, conflicting reuse rejected.
- W05/F5: answer completeness metadata and Unicode-grapheme continuation tool; fresh permission and source checks; drafting prompt requires complete retrieval.
- W06/F6: inactive identities produce explicit unusable outcome, no invalid link or resurrection; restoration permits matching again. Matching confined to grant destination.
- W07/F7: body generations maintained by SQL triggers and bound into inference/suggestion/preview acceptance and execution; source record snapshots frozen too.
- F8: sidebar contrast corrected; whole-page axe findings now fail Website UI gate.
- F9: launch flags, grant, cron and migration prerequisites documented; mirrored v2 contract copies updated together.
- Migration collision resolved by renaming unpublished ingest SQL to 0033. New source/grant migration is 0034. Existing release 0032 remains unchanged. Relay adds 0003.
- Transitive ip-address lock moves 10.7.3 -> 10.7.4 to fix the newly reported moderate advisory; no broad dependency upgrade.

## Observed pre-freeze verification (not final release certification)
- Six original expected-defect reproductions passed against the initial integrated baseline. Stored under Workspace .artifacts/website-baseline*. These are failure evidence, not regression PASS claims.
- 39 existing Website ingest/MCP/cost tests passed, including both approved 500-record batches; 40 focused ingest/remediation tests passed; 7 independent remediation tests passed.
- Mixed lifecycle with permissions enabled: 1,000 submissions; 400 existing matches, 550 new People, 50 unusable identities, 950 active People and no inactive links: PASS.
- Relay: 44 tests PASS, including recovery, terminal replay, checkout rollback, configuration, email acknowledgement/idempotency and privacy coverage.
- Local HTTPS joint check: 5 assertions PASS using actual relay handler + Miniflare D1 and built Workspace Worker. Resend/Razorpay simulated. Full lifecycle, duplicate form, outage/recovery, enabled permissions/revocation and signature refusal persisted as expected. Fixture TLS trusted only by the test process.
- Website UI: 9 browser/size combinations PASS with whole-page axe, light/dark, keyboard and compact menu.
- Website design 74 pages: PASS. Phone profile 64 pages, four profiles: 0 strict failures. Three Roots suites: PASS. Token local Hardhat: 18 PASS. Website existing E2E: 50 PASS.
- First broad pre-freeze unit run was deliberately interrupted after identifying an obsolete test that expected permissions-enabled ingest to fail; that test now injects a database write failure and verifies retry without disabling permissions. This is not final unit certification.

## Final execution state
Integration draft PRs have been published. Current UI follow-up validation and certification require the final frozen source. Historical results below remain bound to their named source. Runtime progress and exact-source evidence live in ignored .artifacts/ directories, preserving the tested source fingerprint. No ENGINEERING GO is claimed by this document.

## Remaining external gates
Genuine human approval (automated sessions are fixtures), physical devices, human screen readers, CA/legal/privacy policy approval, production payment/email/account setup, real chain/provider checks and authorized deployment. None may be reported as locally certified.

## Release rehearsal correction
The first completed integration certification at a8e6f4b passed 33 of 34 mandatory gates, including 1,512 unit tests, 668 D1 tests, all browser/AI gates, security and source integrity. The migration rehearsal failed because it retained the previous release's 32-entry count. Its count now matches the 34-entry manifest. The failed certificate is retained; the corrected rehearsal and a fresh complete certification are required. No application or schema behavior changed in this correction.

## Human-found UI follow-up
The user's four screenshots exposed clipped table controls and native menu offsets missed by the earlier acceptance. UI status returned to HOLD. See UI-FOLLOWUP.md for eight finding groups, shared-component fixes, expanded rendered geometry/accessibility checks and the native-display review launcher. The prior certificate remains evidence for eaaa325 only; fresh affected checks and source-bound results are required for this follow-up.
# Public QA tools and wider UI follow-up

User steering on 2026-10-23: research public tools and actually use them to reduce manual discovery of obvious UI failures. Added a disposable local HTTPS UX lab using exact Playwright Test 1.63.0 and fast-check 4.10.2, existing axe, rendered-control geometry and explicit state coverage. Tool research, new findings UI09–UI13, boundaries and reproducible commands are in QA-TOOLS.md and docs/testing/UX-LAB.md. No paid inference/cloud testing was activated.

Intermediate failures remain in `.artifacts/ux-lab/development-*`. They exposed and led to fixes for avatar/secondary-text contrast, nested notification actions, empty-search semantics and filter/sort names/targets. The final matrix/comparison and source-bound release checks run after this source freeze; their actual outcomes belong in `.artifacts/ux-lab/` and the machine release ledger. Do not resume from old passing counts or treat an initial screenshot capture as design acceptance. Overall status remains HOLD until required current-source engineering evidence is present.

## Expanded discovery and task draft correction
The first complete public-tool matrix at `2f78028` recorded 481 PASS / 41 FAIL across 522 cases. This prompted additional dark-theme contrast fixes and UI14: task text now enters existing account-owned durable drafts immediately, canonical edits use the ordinary mutation/access gate, focus alone never rewrites source, and responsive layouts retain text. Textareas grow to expose long answers. Source divergence requires review/retry. The plan now contains 540 cases including the explicit draft regression. WebKit navigation/offline diagnostics are narrowly correlated and retained, while real unhandled errors still fail. Current final certification and full-matrix acceptance remain pending; old certificates cannot certify this correction.

The final focused investigation also reproduced stale title display when a compact sheet focused before initial synchronization. Clean fields now follow source updates; dirty fields preserve input. Enlarged-text checks caught and corrected a ResizeObserver delivery loop. The focused 15-case remediation run passed before the final source freeze; full 540-case comparison and current mandatory certification still require their own results. WebKit handled-read diagnostics require narrowly correlated fault/navigation evidence or an actual authenticated browser recovery request; window errors and unhandled rejections always fail.

## Final harness hardening
At `5721edf`, the full matrix executed 540 cases: 538 PASS, 2 FAIL. The retained traces distinguish a fallback-poll deadline from editor source hydration and a handled WebKit protocol-3 read from an unhandled error. Source hydration now uses the real foreground-refresh path while the field stays focused; protocol read diagnostics require current-manifest bounded browser recovery. The runner also renews its generated local CA before expiry and reloads process-local trust. Three OpenSSL regression tests join the mandatory Node harness. Product/schema/package/native-harness files remain unchanged: the 5/5 Safari simulator and 17/17 Android emulator results at `5721edf` are retained with explicit source equivalence, never relabelled as physical-device proof. Full final matrix and mandatory release certification remain required.

Source inspection also confirmed UI15: task detail treated an unresolved local read as missing and rendered the unavailable message too faintly. Loading now has its own status; missing/deleted records retain a readable unavailable state. The explicit rendered-state catalog now contains 31 cases × 18 projects = 558 cases. Affected native task-detail journeys and Android checks must be repeated for this product change; earlier complete simulator evidence remains bound to `5721edf`.
