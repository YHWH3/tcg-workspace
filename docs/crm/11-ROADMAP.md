# Engineering roadmap, test strategy and release gates

Everything here needs your approval before work starts. Nothing in this file has been executed.

## 1. Environments and what each proves

| Environment | What runs there | What it proves | What it does not prove |
|---|---|---|---|
| Local fixture (demo) | Fresh local D1, fictional data, simulated providers, loopback HTTPS (like `npm run demo:studio`) | UI, commands, concurrency, permissions logic, AI preview flows | Provider behaviour, production data shape |
| Integration simulation | Simulated adapters that replay recorded or synthetic provider payloads (signatures, receipts, retries, out-of-order events) | Adapter mapping, idempotency, retry handling | Real provider acceptance |
| Provider sandbox / test accounts | Real provider in test mode where one exists | Real signatures, real templates, real error codes | Production volumes, real recipients |
| Staging | Hosted copy with an owner-exported production database copy | Migrations, backfills, performance on real shapes, permission activation interplay | Real sends (stay disabled) |
| Production migration | Additive migrations, pack upgrade, backfills with dry-run reports | Data preserved | Nothing user-facing until enabled |
| Rollout | CRM enabled for named users; channels enabled one at a time | Real use | |

Real credentials, real messages, real payments and remote migrations happen only after the matching gate in section 4 is approved by you.

## 2. Vertical slices

Each slice is end-to-end (data, server, UI, AI where relevant, tests) and leaves the system usable. Dependencies are listed; slices without a dependency on each other can run in parallel.

| Slice | Delivers | Depends on | Acceptance (summary) |
|---|---|---|---|
| **S0 Rails and access** | CRM shell under `/crm` behind `CRM_ENABLED`, app switcher, scoped tokens, empty states; command framework (registry, idempotency, journal, both commit modes); unconditional `_crm_` projection-key rejection in `applyChanges` plus the projection grant in `authorizeMutations`; migration 0045 with the three S0 tables (journal, grants, audit; later CRM tables arrive with their slices); **capability management**: `capability.grant` / `capability.revoke`, owner-implicit rule, append-only audit, Settings "Accounts and capabilities" screen over the existing account routes (A-21, P-21); owner protection (A-23); "Commons" demo fixture skeleton. Detailed plan: `S0-PLAN.md` | G0, A-23 to A-26 | Workspace suite and Studio check unchanged against the recorded baseline under the A-24 rule; owner protection enforced server-side; disable revokes grants with audit, re-enable restores none; Workspace screenshots identical with `CRM_ENABLED` off; switcher keyboard-accessible; grant/revoke enforce idempotency, stale authority and the owner/admin rules and write exactly one audit row per change; projection keys rejected from client push and generic MCP writes in both permission modes |
| **S1 People** | CRM Grid (groups, summaries, keyboard, persisted columns), People and Organisations views, record panel Overview, pack upgrade v12 fields, endpoint commands, endpoint backfill dry-run, duplicates queue (read); owner renames other accounts (A-20) | S0 | Grid ARIA pattern passes axe; columns persist per view; endpoint uniqueness enforced; backfill dry-run reports conflicts without writing; rename audited in `access_audit` |
| **S2 Enquiry to timeline** | Programme registry with profiles, Applications database, `application.create_from_submission`, timeline read API (submissions, team notes, history highlights), Home v1 | S1 | A fixture website submission becomes a person, an application and a timeline entry; source submission unchanged; Home lists it under the programme's response target |
| **S3 Activities and My Work** | Activities database, log call or meeting or visit, follow-ups with due dates, Home Today and This week, CRM automation recipes for follow-ups | S2 | Follow-up due today appears on Home for its owner only; automations use existing engine and approvals |
| **S4 Conversations core** | Conversation and message tables in use, simulated channel, manual logging of off-platform conversations, internal notes, drafts, facts store and verification flow, AI draft with fact citations | S2 | Draft never leaves draft without a human; drafts cite verified facts; stale fact produces "to be confirmed" text; notes cannot be sent |
| **S5 Email (Zoho Mail)** | `email_zoho` adapter (simulated first) per `09` section 1.7: Zoho Mail API with cron polling and stored cursor, IMAP/SMTP fallback only if the API is unavailable; outbox with leases and retries; header-based threading; send permissions (`crm.send:email`); consent checks | S4, A-22, O-20, O-21 | Zoho facts verified against current Zoho documentation and the account before coding; re-polled message ignored; ambiguous send outcome goes to review, never resent blindly; withdrawn consent blocks send; failure reaches review list. Real mailbox only after G3 |
| **S6 Bookings** | Editions, holds, confirm, waitlist and offers, groups and placeholders, transfer, cancellation, attendance, screening (restricted), edition screen | S2, O-05, O-06 | Property test: N concurrent confirmations never exceed capacity; expired holds free seats; screening content invisible without capability in UI, MCP, search and AI |
| **S7 Money phase 1** | Payment requests, receipts with evidence, reversals, refunds with approval, balances, Money screen, booking Paid state from ledger | S6, O-09 | Ledger rejects UPDATE and DELETE; totals refuse mixed currency; refund self-approval rejected; Paid only from ledger |
| **S8 Membership** | Common Roots scheme configuration, lifecycle, renewal due on Home | S7, O-07 | Active only with linked receipt; validity from scheme settings |
| **S9 Pipelines and Patrons** | Opportunity pipelines per `04` 4.7, handoff to Workspace Project, Patron read-only projection | S2 | Handoff creates linked project; Patron stage mirrors relay events and cannot be edited in CRM |
| **S10 Merge** | Merge and unmerge commands, alias resolution in all ingest paths | S1, S4 | Merge moves every reference type; unmerge restores; website submission for merged email lands on survivor |
| **S11 WhatsApp** | WhatsApp adapter, window state, templates, opt-out | S5, O-04 | Window closed forces template; template states mirrored; opt-out cancels queued non-transactional sends. Real number only after G3 |
| **S12 Instagram and Facebook** | Meta messaging adapters, Human Agent tag handling, page-scoped identities | S11 | Same guarantees as S11 |
| **S13 Money phase 2** | Payment provider links and webhooks, reconciliation view, receipt documents once O-10 is decided | S7, O-11 | Paid via provider only from verified webhook; unmatched payments in review |
| **S14 Reports** | Stage battery widget, CRM dashboards, report definitions from `04` section 7 | S3, S6, S7 | Every number drills to records; permission-limited states shown |
| **S15 Certification** | Full release gate run, documentation, runbooks | all chosen | Section 5 |

Suggested first release candidate for real (non-sensitive) use: S0 to S5 plus S9 (email and website enquiries, people, applications, follow-ups, pipelines). Bookings and money follow when their policies are decided.

## 3. Test strategy

| Layer | What | Tools already in the repo |
|---|---|---|
| Pure logic | State machines, matching and normalisation, money arithmetic, window computation, profile validation | Vitest, fast-check |
| D1 integration | Commands, idempotency, stale revisions, capability fences, budgets (`withD1Budget(env,45)`), ledger triggers | Existing `*-d1.test.ts` pattern |
| Concurrency | Parallel confirmations and transfers; replayed webhooks; outbox lease races | fast-check plus D1 fixtures |
| Browser | CRM screens in Chromium, Firefox and WebKit; compact, tablet, desktop; light and dark; keyboard-only paths | Playwright, `@axe-core/playwright` |
| Offline | Intents queue and settle; projections read-only; access change quarantines intents | Existing offline scripts pattern |
| MCP parity | Same user, same query, same IDs via UI API and MCP; side-effect tools absent or human-only | Existing MCP fixtures |
| AI | Previews require browser approval; proposals re-validate on execute; untrusted content cannot trigger tools; simulated provider only | Existing assistant tests pattern |
| Workspace regression | Full existing suite, Studio demo `--check`, screenshot comparisons of Workspace screens | Existing |
| Migration | Additive migrations and pack upgrade on an owner-exported copy; dry-run reports; rollback rehearsal | `scripts/prod-copy-rehearsal.mjs` pattern |
| Unauthorised access | Restricted and financial data absent from every read surface for users without capability (sync, search, MCP, notifications, digests, AI) | Track A restricted-content check pattern |

Test results are reported with exact commands and counts from the actual run; no slice is "done" on simulated-provider evidence alone where a real-provider claim is made.

## 4. Decision gates

| Gate | Decision | Owner input needed |
|---|---|---|
| G0 | Approve this design (or changes) | Review of `01` and `12` |
| G1 | ~~Permissions activation before pilot~~ Closed by A-19: pilot with permissions off. Track A remains a separate Workspace decision | none |
| G2 | Each slice's local acceptance | Review of slice report |
| G3 | Per-channel provider activation: accounts, verification, secrets, cost | O-03, O-04, O-11 |
| G4 | Staging rehearsal with an exported copy | Export and backups |
| G5 | Production migration and pack upgrade | Approval of dry-run reports |
| G6 | Rollout: the owner grants `crm.access` and other capabilities to accounts in the CRM (A-21), then each channel | Grants made in the tool; no named list needed (A-20) |

## 5. Release readiness checklist (per release)

- Workspace regression suite, Studio check and screenshot comparison pass. Slice acceptance may tolerate only the SI-01 failures under the A-24 rule (`S0-PLAN.md` section 9.4); **a production release requires SI-01 to be investigated and stabilised**, with the suite passing in full.
- CRM tests for included slices pass in all three browser engines and three layouts.
- Accessibility checks pass; keyboard-only walkthrough of each new screen recorded.
- Restricted-content absence check passes for a non-privileged user.
- Migration rehearsal on exported copy passes, with rollback rehearsed.
- Provider adapters for enabled channels pass sandbox tests; disabled channels show "Not connected".
- Runbooks: channel disconnect, stuck outbox, failed payment webhook, merge undo, erasure request.
- Owner sign-off recorded in `01-DECISIONS.md`.

## 6. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Permissions remain off (A-19) while sensitive data is typed into ordinary fields such as Notes | Medium | High | Restricted data server-only by design; CRM forms and field help steer sensitive input to restricted sections; owner accepted that ordinary records are readable by every account |
| `_crm_` projections forged by a client while permissions are off | High without the fix | High | Unconditional pre-check in S0 with tests in both permission modes |
| Owner demoted, disabled or removed by an admin, leaving no super admin | Low | High | Server-side owner protection in S0 (A-23) |
| Flaky Workspace tests (SI-01) hide a real regression | Medium | Medium | A-24: unchanged signatures plus passing isolated reruns, any change blocks; stabilise before production release |
| Zoho Mail API lacks a needed capability (push, Sent copies, threading, limits) | Unknown | Medium | Verify before S5; IMAP/SMTP fallback; polling design does not depend on push |
| Seven-account cap blocks onboarding | Medium | Medium | Accepted by A-20; Accounts tab shows places in use |
| WhatsApp number migration disrupts current team use | Medium | High | O-04 decided before S11; consider a separate number or coexistence options after checking current Meta rules |
| Provider policies or pricing change | High | Medium | Adapters isolate rules; window and template logic data-driven; check before each activation |
| Scope pressure to build all 14 programmes at once | High | Medium | Programmes are configuration; slices deliver engines, profiles switch them on |
| D1 budget exceeded by timeline aggregation | Medium | Medium | Batch-shaped reads, keyset cursors, budget tests per endpoint |
| CRM styling leaks into Workspace | Low | Medium | Scoped tokens, screenshot gate |
| Merge errors corrupt relationships | Low | High | Journal, unmerge, review-only matching, dry-run plans |
| Money disputes from manual entries | Medium | High | Evidence required, append-only, dual approval for refunds |
| Foreign-currency contributions accepted without legal basis | Low to medium | High | Blocked by default (C-03) |
| AI drafts state wrong facts | Medium | High | Verified facts only, citations, human send |
| Website contract drift | Low | Medium | Contract unchanged; CRM reads existing ingest; any change updates both copies (repository rule) |

## 7. Demo fixture: "Commons" (fictional)

A Studio-style local fixture for reviewing the CRM before any real data:

- A fictional organisation ("Riverbank Commons") with five areas and a handful of programmes that mirror TCG's shapes (a workshop with editions, a membership scheme, a volunteer programme, a space network, a consulting pipeline), so no TCG fact, price or date is invented.
- About 40 fictional people with overlapping roles, two deliberate duplicates, a WhatsApp-only contact, an Instagram-only contact and an unmatched email.
- Two editions (one nearly full), bookings in every state, a waitlist, a paid-after-expiry case and a refund awaiting approval.
- Simulated email and WhatsApp channels with inbound history, a closed window and a failed send.
- Verified, draft and stale facts.
- A `--check` mode in the style of `npm run demo:studio -- --check` that walks the main flows headless and records screenshots under an ignored artifacts directory.

It never seeds production and uses generated local credentials only.
