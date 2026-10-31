# 00 — Baseline: verified state, findings register, owner decisions

Everything here was verified by reading source at `528b889` or by read-only
commands on 2026-10-23/25 unless marked **verify at implementation**.

## 1. Source stack

| Layer | Branch / PR | Head | Contents |
|---|---|---|---|
| 0 | `main` | `ec14454` | Phases 0–6 (merged PRs #1–#4, #8, #10, #11) |
| 1 | `release/1.0.0-candidate`, PR #12 (draft) | `5b07263` | 1.0 acceptance and accessibility corrections |
| 2 | `feature/unified-ai-mcp`, PR #13 (draft) | `b6c3c4a` | Embedded assistant, universal MCP, providers, ChatGPT-plan companion, platform QA |
| 3 | `codex/website-workspace-integration`, PR #14 (draft) | `528b889` | Website inbox (ingest, People, section, AI/MCP), W01–W07 fixes, UI01–UI17, QA01–QA05, dependency patch SEC01 |
| Site | `codex/website-relay-reliability`, the-common-ground PR #23 (draft) | `1bbc617` | Patron programme, durable relay outbox (`services/form-relay`), Resend email, Razorpay (simulated), privacy export/erase |

`528b889` contains every Workspace layer. **Do not use** `feature/website-ingest`
(`d4ff938`): it is superseded and its migration number collides. PRs #7 and #9
must never be merged.

## 2. Production (read-only check, 2026-10-23)

- Worker `workspace` version `b5a721cc` deployed 2026-10-07 (Workers Free).
- D1 `workspace-db` has migrations 0001–0003 only; 31 pending (0004–0034).
- ~219 records, 1 admin, no cron, no secrets.
- OAUTH_KV holds 2 legacy grants without connection ids. After release, the
  owner's Claude ("TCG") and ChatGPT connectors must be reconnected.
- None of Phases 1–6, the assistant or the Website inbox is live.

## 3. Acceptance state of `528b889` (R0)

Execution refresh, 2026-10-25: `528b889` now has a complete **resumed**
certificate: PASS 34/34 mandatory gates, 0 failed, 0 not run. The successful unit
report (1,512 tests) was retained from attempt 2 with exact-source and artifact
hash checks; the other 33 gates were rerun. This is not a claim that one
uninterrupted `npm run certify:ai` passed. Earlier failed/interrupted runs remain
unchanged.

Native Safari also passed on this head: five Apple Simulator profiles, five
journeys each. UX matrix 558/558, Android Chrome 17/17, Website UI 9/9, joint HTTPS
5/5 and 18 references passed. Physical devices and human acceptance remain open.
See [BASE-EVIDENCE.json](BASE-EVIDENCE.json) for exact SHA, fingerprint, artifacts
and hashes. A later application change requires new certification.

## 4. Capability inventory (what exists, so you extend instead of rebuild)

| Area | Exists (key files) |
|---|---|
| Records/sync | generic `records` table; `mutate()` (`src/core/sync/engine.ts`); `applyChanges` (`worker/sync.ts`); per-field LWW (`worker/merge.ts`); Protocol 3 per-space feeds |
| Databases | `shared/fields.ts` 9 field types: text, number, select, multi_select, person, date, url, checkbox, relation. Views: board, table, list, gallery, calendar, timeline (`shared/views.ts`). Relations/links (`links` collection), sub-records ≤3, dependencies |
| Filters | ops: is, is_not, contains, not_contains, empty, not_empty, before, after, on_or_before, on_or_after, checked, unchecked, me; value `'today'` only (`shared/views.ts:200`) |
| Dashboards | blocks `metric` (count/sum/avg + drill-down), `view`, `calendar`, `mywork`, `activity` (`src/modules/boards/blocks/`); MCP `dashboard_snapshot`, `operating_review_context` (`worker/mcpReadTools.ts`) |
| Operating pack | `templates/tcg-pack.json`: 17 databases, 35 pages, 5 automations, 6 forms. Install planner `shared/bundled.ts` (`planInstallPreview`, `findReusableBoards`); reinstall reconciles and never overwrites existing data |
| Website | `shared/websiteInbox.ts` (board `board-website-inbox`, `showBuiltins:true`, stages new → in_review → replied → done, fields `wi_*`), `shared/websiteStats.ts` (`websiteDashboard`, `websiteDigest`, `isOpen`), `src/modules/website/index.tsx`, `worker/website.ts` (MCP `website_query`, `website_digest`, `website_read_answers`, `propose_website_triage`), `worker/websiteIngest.ts`, `worker/websiteAuthority.ts` |
| Rhythm | event outbox, notifications (server-only, recipient-scoped, restricted rendering), approvals (server-enforced gates), reminders, recurrence, automations (5 triggers, 7 actions), public forms, durable execution (`worker/execution.ts`) |
| Scheduler | one cron `*/15`; 9 rotating phases in `runScheduled` (`worker/reminders.ts:296`) |
| Access | spaces, members, guests, capability kernel (`worker/capability.ts`), read gate (`worker/readAccess.ts`), `access_state.enabled=0` (permissions OFF), `access_audit` table |
| Search | FTS (`worker/search.ts`), `GET /api/search?q&type&space&database&cursor&limit&mode` (`worker/searchApi.ts`), optional semantic/hybrid |
| Files | D1 chunk storage (`files`, `file_chunks`), 20 MB per file, 450 MB quota (`worker/files.ts:68-69`), `servedFile()`/`servedFileHeaders()`, `renderableBlob()` |
| History | `record_history` (all write sources), `history_restore_jobs`, changesets + undo for server/MCP writes |
| AI | scoped connectors, previews with browser approval, suggestions, digests, embeddings (off), embedded assistant (`worker/assistant/*`), capability registry (`shared/aiCapabilities.ts`, 77 tools), `shared/aiActions.ts` (31 actions), `shared/aiWorkflows.ts` |
| Settings | `src/core/settings.tsx` sections: Profile, Spaces and guests, AI assistant, AI connectors, Recent AI changes, Template gallery, Storage, Usage and retention, Notifications, Local data, Change password, Signed-in devices, Admin |
| Preferences | `users.prefs` JSON → `UserPrefs {notifications: Partial<Record<NotifKind,'inbox'|'off'>>, quietDigest}` (`worker/auth.ts:94`); `sanitizePrefs` drops unknown values |
| QA | `npm run certify:ai` (34 gates), `npm run qa:ux` (UX lab), `scripts/android-qa.mjs`, `scripts/cross-platform-qa.mjs`, `scripts/verify-*.mjs` |

**Confirmed absent** at `528b889`: CSV import/export, page export, share expiry
or passwords, comment resolution, bulk edit, rollup/formula fields, chart view,
email or push delivery, R2, account disable, workspace-level settings table,
relative date windows, currency configuration.

## 5. Findings register

Severity: H = wrong data or security, M = wrong behaviour or a gap blocking
planned work, L = inconsistency.

| ID | Sev | Finding | Evidence | Fixed in |
|---|---|---|---|---|
| N01 | H | Filter value `today+30` is never resolved. It is compared as text, so `"2099-01-01" <= "today+30"` is true and "Deadlines in the next 30 days" counts every future deadline. Present on main, #12, #13 and #14; not in production. | `shared/views.ts:200`; pack pages Home, Partnerships & Funding, Weekly Operating Review (metric on `db_opportunities`, `p_f_deadline`). Reproduced on `5b07263`: 2026-10-30 true, 2027-12-31 true, 2099-01-01 true. | R1 |
| N02 | M | "Today" differs by surface. The client uses device-local `todayISO()` (`src/core/utils.ts:39`); the worker (MCP reads, digests, reminders, date-offset automations) uses UTC (`todayUtc`, `toISOString().slice(0,10)`). In India (UTC+5:30), from 00:00 to 05:30 the app and AI disagree, breaking the guarantee that metric totals match `query_records`. | files cited | 7.2 |
| N03 | M (verify) | `createdAt` (epoch ms number) is offered as a filter key (`src/core/records.ts:217`), but date ops compare it with `yyyy-mm-dd` strings via `temporalCmp`, so "Created after <date>" never matches and "before" always does. | `shared/views.ts` `temporalCmp` | 7.1 |
| N04 | M | Metric currency is hard-coded USD (`MetricBlock.tsx:30`, option label "Currency (USD)"). Money fields (Budget, Amount, Price, Cost, Revenue) carry no currency. Payments are INR (Razorpay). | files cited | 7.2 |
| N05 | L | Common Cupboard "Margin" is a `text` field, so it cannot be summed or computed. | `templates/tcg-pack.json` products | 8.5 |
| N06 | M | No disable path. Nothing writes `users.disabled_at`, although every guard reads it. `DELETE /api/users/:id` hard-deletes the user (frees the seat, drops sessions, revokes grants) and checks `role`, not `COALESCE(workspace_role, role)`, for last-admin protection. | `worker/admin.ts:104-165`; readers in `spaceFeed.ts`, `access.ts`, `capability.ts`, `spaces.ts`, `readAccess.ts` | 7.3 |
| N07 | L | `GET /api/approvals` loads target metadata one row at a time (`loadTargetMeta` in a loop), so D1 cost grows with page size. | `worker/approvals.ts:380-384` | 8.1 (new code must batch; optional fix) |
| N08 | M | Changes to `templates/tcg-pack.json` reach only new installs. Existing workspaces never receive new views, fields or dashboard blocks. | `shared/bundled.ts` | 7.4 |
| N09 | L | Website age basis is inconsistent: `oldestUnanswered.ageDays` uses `createdAt`; median first reply uses the `wi_received` date. | `shared/websiteStats.ts` | 8.3 |
| N10 | M | New D1 test files outside `(phase[456]|audit|assistant)-*-d1.test.ts` are silently excluded from the d1 gate. | `scripts/certify-phase4.mjs:118` | 7.0 |
| N11 | H (process) | Earlier attempts lacked complete evidence; the source-bound resumed certificate now passes 34/34 (§3). | BASE-EVIDENCE.json | Historical base evidence verified; release target D1 pending |
| N12 | L | Comment updates are restricted to the author or space administrators when permissions are enabled. "Resolve" by a non-author would be rejected if implemented as a plain comment patch. | unit test "restricts comment updates to the author or space administrators" | 9.4 design |
| N13 | M | MCP query_records omitted today context entirely, so relative-date parity required more than the shared resolver. | worker/mcp.ts query_records; audit-relative-dates-d1.test.ts | R1 supplies explicit UTC today; timezone unification remains 7.2 |
| N14 | M | Populated automation editor labels, Off badge and run-history button failed AA contrast, while the old UX catalog visited only its empty state. | New relative-dates UX case, retained failed browser-probe-2 artifact | R1 adjusts existing tokens and adds populated-editor coverage |
| N15 | L | A D1 SQL export cannot establish current OAuth grant count or connection IDs: grants are in OAUTH_KV. The historical two-grant inventory is not current verification. | Release storage architecture; prod-copy report | R2 explicitly requires separate owner KV inventory |

| N16 | M (QA) | Hard navigation during outstanding foreground API reads causes WebKit fetch diagnostics in the release UI runner. Network-idle lifecycle alone missed dynamically started reads. A deliberately cancelled negative control also left an orphan request when its page was reused. | Retained 984328c full certificate: 33/34 PASS, release-ui 16 PASS / 2 FAIL; request-tracking and isolated-control reports | R1 adds explicit foreground request tracking with a bounded quiet window; isolates intentional cancellation in its own page. All browser-error assertions remain; premature navigation and injected uncaught-error controls prove the harness. Targeted release UI 21/21 and relative-date matrix 18/18 PASS; fresh complete certification required. |

| N17 | M (QA) | Canvas pointer hit-point helper selected a nested comment button when earlier fixtures overlapped the note. Its pointer-down stops by design, so WebKit's geometry assertion observed no move. | Full 79cc6e5 certificate v7 trace: start (837.117, 293.880) in comment control; three-engine static overlap regression reproduces the wrong target | Phase 7 harness correction: exclude interactive children and resize handles, retain covered-item refusal and original geometry assertions; full v7 114/114 PASS. |
| N18 | M (QA) | Release rehearsal retained a 34-migration assertion after Phase 7 added 0035. It failed before running upgrade/restore checkpoints. | Full 79cc6e5 certificate release-rehearsal: 35 !== 34 | Phase 7 updates the expected count to 35 and adds manifest/count self-test; actual rehearsal 12/12 PASS. |

| N19 | M | Device reliability compared fresh reactive queue entries with the clock captured at mount/last tick, falsely reporting unknown age and Review work on this device. | Real Dexie enqueue plus controlled hook callback reproduces attention=true for a one-second-old entry; `reliability-reactive-clock-baseline.log`. | 8.4 follow-up uses observation time; old pending work still alerts. |
| N20 | M | Shared dashboard heading truncates to R… at 200% text because a second flex spacer consumes heading space. | Three-engine screenshot probe: compact 195px heading in 40px, tablet in 69px. Heading geometry fails before correction. | 8.4 follow-up removes redundant spacer and lets headings wrap;378-case selection PASS at3348780. |
| N21 | H | Project health could return an empty success if a readable source changed revision between selection and authorization. | Actual-D1 controlled revision race, `project-health-revision-race-baseline.log`. | `575a7f0`: explicit409 plus one current-context read retry; authorization denial remains redacted. |

| N22 | M | Firefox200% long Project title spills beyond its card; page-level overflow misses ancestor clipping. | Title-level check reproduces442px text in201px link; project-health-title-baseline.log. | Project link uses normal wrapping text flow; final90 cockpit cases PASS at1b4acee. |

| N23 | M | Compact200% View transactions button extended beyond its finance card, though document geometry passed. | New own-card assertion: right311.5px versus card boundary257px; finance-button-baseline.log. | Budget buttons are width-constrained and caption span wraps; corrected9-case3-engine probe PASS; final54 finance cases PASS at3ebba82. |
| N24 | M (QA) | Pack validator rejected the existing supported within date operator when Funding added its stale-action view. | finance-pack-first.log: bad op within. | Validator recognizes within; pack and shared filter tests keep runtime behavior aligned. |
| N25 | H | Finance root snapshot could use an older budget after a concurrent change when permissions were disabled. | Controlled actual-D1 baseline returns200 instead of409 in disabled mode; enabled mode already refused. | Root revisions compared against the second snapshot independently of the read gate; both-mode regressions PASS. |
| N26 | M | Binary multiplication and asymmetric rounding left a cent after equal positive/negative expenses and disagreed with displayed decimal money. | finance-rounding-baseline.log: matching ±1.125 produced spent0.01; 1 FAIL/14 PASS. | Convert through ungrouped Intl decimal rounding into safe integer minor units; exact reversal and zero/two/three-decimal regressions PASS; final167 focused/54 finance PASS at3ebba82. |
| N27 | M | Repeated budget blocks for one Project reused a progress ID, breaking independent accessible labels. | finance-repeated-label-baseline.log: two bars have only one distinct ID,1 FAIL. | Per-mounted-reader IDs and list index keep label targets unique; final54 finance cases assert distinct IDs and accessible names at3ebba82. |

| N28 | M | Gallery/document capture inputs deferred reading a cleared FileList, losing staged attachments. | Field interruption browser probe lost media after selection. | Snapshot FileList before clearing inputs; final 72 field cases at579dec6 verify restored photo/document and one retry record. |
| N29 | M | Upload sweep attempted staged bytes before their file metadata existed, producing404 and disrupting recovery. | Two actual-Dexie baseline regressions FAIL; retained capture trace. | Retain bytes and defer upload until metadata exists, including canonical thumbnail ownership. Final media checks and72 field cases PASS at579dec6. |
| N30 | M | Raw Blob draft staging failed in WebKit despite normal attachment byte fallback. | Three-engine field probe11 PASS/1 FAIL, WebKit capture draft lacks media refs. | Reuse putBlobRow for cached staging; forced-Blob-refusal regression and final72 field cases PASS at579dec6. |

| N31 | M | A transport failure briefly raised an error access barrier before validating the same cache offline, unmounting an editor with pending text. | Frozen414 selection stopped85 PASS/1 FAIL/328 skipped or incomplete; deterministic real-engine regression1 FAIL. | Let the existing sync owner validate transport fallback before publishing error; HTTP denials and stale-cache barriers stay enforced. Final293 focused checks,72 field cases and preserved64/140/42 assertions PASS at579dec6. |

| N32 | M | Long Observation labels forced the compact measurement table sideways despite its three-column layout. | Screenshot review and new geometry assertion: 324px table in a 290px region, 1 FAIL. | Wrap labels and units with overflow-wrap:anywhere. Final72 field cases PASS at579dec6, including the compact width assertion; six final images inspected. |
| N33 | M | Event registration starter was enabled with no fixed Event target, so it could not validate as a usable public form. | Pure baseline failed the disabled-starter assertion; parseFormConfig rejects the unconfigured target. | New pack installs keep the starter disabled with setup instructions. Existing configured/enabled forms remain unchanged. Canonical participant mapping and additive preservation regressions PASS in development; final source evidence pending. |
| N34 | M | At 200% text, compounded rem padding fragmented ordinary Event action words even though no-overflow checks passed. | Agent screenshot review; rendered participants word spans two line fragments, baseline1 FAIL. Initial canvas metric was ineffective and a first Range fixture addressed the wrong React text node; both diagnostics retained. | Keep the Event block/card/action horizontal padding at its ordinary12px while text enlarges. New actual-line regression plus corrected Chromium compact/light, Firefox tablet/dark and WebKit desktop/light checks3/3 PASS. Frozen final verification pending. |
| N35 | M | Shared multi-select table buttons replaced their visible selected values with a field-only accessible name, failing label-content-name-mismatch. | Frozen c0286a4 affected matrix stopped25 PASS/5 FAIL/1 interrupted/113 NOT RUN, exit130. Two locator assumptions also failed on wide tables. | Table and detail buttons derive names from visible values plus a hidden field label. Scoped detail selectors and input/card membership assertions retain both layouts. First label reconstruction still failed2/12; corrected12/12 three-engine journeys PASS. Final frozen checks pending; no accessibility exclusions added. |
| N36 | M | Empty multi-select prompts in the open Person editor used neutral400 text on white, only2.58:1 contrast. | New whole-page editor check in frozen b3847d2 matrix fails color-contrast. Run stopped21 PASS/1 FAIL/1 interrupted/121 NOT RUN, exit130. | Use neutral600 in light mode and neutral400 in dark mode for table/detail empty prompts. Corrected membership/editor workflow3/3 across three engines PASS with whole-page axe. Final frozen verification pending. |

Add new findings as N33+ with the same columns.

## 6. Owner decisions (collect before or during the named item)

| ID | Decision | Needed by | Recommended default |
|---|---|---|---|
| D1 | Certify `528b889` as is, or certify R1's head and release both together | R0/R1 | **Owner selected R1's corrected head in this chat, 2026-10-25.** |
| D2 | Workspace timezone and currency | 7.2 | **Owner selected `Asia/Kolkata`, `INR` in this chat, 2026-10-25.** |
| D3 | Does disabling an account keep its seat? | 7.3 | **Owner selected: free the place while disabled, 2026-10-25. Restore requires available active-account capacity; history remains.** |
| D4 | Who triages the Website inbox (the unassigned queue audience) | 8.3 | **Owner selected all admins in this chat, 2026-10-25.** |
| D5 | Response-age bands and target first-reply time | 8.3 | **Owner selected 0–2, 3–7, 8+ days; target 3 days, 2026-10-25.** |
| D6 | Attention queue sources per role | 8.1 | **Owner accepted the proposed sources in 08 §8.1, 2026-10-25.** |
| D7 | Email provider and sending domain (Resend, same account as relay?), and whether emails may include record titles (titles pass through the provider) | Phase 10 | Resend, `notifications@<domain>`; titles off |
| D8 | Web push VAPID keys and whether iOS installation is promoted | Phase 10 | Generate keys; promote install in Settings |
| D9 | R2 bucket creation and payment method on the Cloudflare account | Phase 11 | Owner provisions |
| D10 | Share link default expiry | 9.7 | None by default; optional 7/30/90 days |
| D11 | Permission activation go-ahead, space structure, guest policy | Track A | After release is stable |
| D12 | Delivered-body retention (website relay), CA sign-off for terms/refunds/delivery pages, sample Patron cards | Release | Owner/CA |
| D13 | Group mentions: use spaces as groups, or separate mention groups | 13.3 | Spaces |
