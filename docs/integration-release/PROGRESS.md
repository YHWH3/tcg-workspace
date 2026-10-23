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
Implementation checkpoints are ready for a clean source freeze. Final certification, repeat checks, native platform runs and publication remain pending until their machine evidence completes. Runtime progress and exact-source evidence live in ignored .artifacts/ directories, preserving the tested source fingerprint. No ENGINEERING GO is claimed by this document.

## Remaining external gates
Genuine human approval (automated sessions are fixtures), physical devices, human screen readers, CA/legal/privacy policy approval, production payment/email/account setup, real chain/provider checks and authorized deployment. None may be reported as locally certified.

## Release rehearsal correction
The first completed integration certification at a8e6f4b passed 33 of 34 mandatory gates, including 1,512 unit tests, 668 D1 tests, all browser/AI gates, security and source integrity. The migration rehearsal failed because it retained the previous release's 32-entry count. Its count now matches the 34-entry manifest. The failed certificate is retained; the corrected rehearsal and a fresh complete certification are required. No application or schema behavior changed in this correction.
