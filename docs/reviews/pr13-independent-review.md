# PR #13 independent review and Apple Safari acceptance

Review date: 2026-10-21. Starting source: `5cd0d1643feb9e512f471f3f4bdc1374c20d8f7a`, tree `9feb3d601d19f4a89b797ff0a3881f64e61b8f39`. Work was performed in the existing `feature/unified-ai-mcp` worktree at `/Users/trinity/Desktop/tcg-unified-ai`; the original Desktop checkout remains on the release-candidate branch. PR #13 stays draft, stacked on draft PR #12. No merge, deployment, remote migration, live connector change, permission activation or paid inference is part of this work.

## Correction ledger

| ID | Confirmed behavior and cause | Correction | Regression evidence |
|---|---|---|---|
| R13-01 | A nonempty but partial `response.completed.output` replaced earlier streamed items. Duplicate `output_item.done` events could dispatch a function twice. The Worker adapter also emitted repeated calls immediately. Error streams could retain the companion reader. | Reconcile streamed and terminal items by stable item/call identity and source order; reject conflicting identities/arguments. Dispatch only after successful completion. Cancel/release unfinished companion streams. | `tests/companion-responses.test.ts` and `tests/assistant-providers.test.ts`: multiple calls, mixed output, empty/partial/nonempty terminal output, duplicate/conflicting IDs, incomplete/error/interrupted streams, reader cleanup and actual companion tool-loop dispatch counts. Red: 9 companion and 8 Worker-provider failures. Targeted green: 71 tests including companion Workspace integration. Commit `838de6f`. |
| R13-02 | A reply's retained dependency list contained only visible citations. An uncited confidential paraphrase survived revocation. Redacted historical assistant calls retained raw arguments, which were sent on the next model request. | Capture canonical read-gate dependencies; propagate all consumed sources to derived replies and pending calls. Revalidate before dispatch and retention. Strip sensitive redacted projections and normalize authorized call/result pairs. | `tests/assistant-runtime-d1.test.ts`: two deterministic red permission-enabled actual-D1 cases; uncited replies, raw arguments, pending revocation, mid-generation revocation, mixed sibling calls, 225-block source coverage, overflow and legacy handling now pass. Targeted runtime/registry/provider run: 59 PASS, including 29 actual-D1 runtime tests. Commit `5e63c68`. |
| R13-03 | Preview aggregate creation count included activity rows while the collection summary omitted them: three total creations versus two content operations. | Both assistant cards and browser reviews show content, activity/audit and total operation counts. The frozen plan, checkpoints, changesets and execution identity are unchanged. Old retained previews explicitly label their combined totals. | `tests/assistant-impact-d1.test.ts`: actual-D1 proposal/review retains three operations, reports two content plus one activity row, and writes no records before approval. Two PASS. Mandatory assistant browser journey asserts all three labels before approval. Commit `00b6f48`. |
| R13-04 | Focusing shared 14px login controls in actual iPhone Simulator Safari triggered automatic page zoom and displaced navigation. Keyboard Next still allowed login; this was a usability defect, not an authentication bypass or complete login failure. | Shared form controls use 16px on compact layouts, preserving browser zoom controls. | `scripts/verify-release-ui.mjs` checks actual computed compact input sizes in Chromium/Firefox/WebKit. Actual Safari pilot verifies login, Unicode editing, keyboard, rotation and return from background. The final simulator matrix is recorded separately below. |
| R13-05 | Actual keyboard-open iPhone Safari search exposed a results viewport of about 17px: always-visible filters consumed the sheet. | Compact search filters now expand/collapse through a labelled button; filters retain their values and remain visible on wide layouts. | Native Safari search/navigation journey plus the existing three-engine release UI gate: expanded-state semantics, filter availability and at least one 66px result under a 362px visual viewport. Existing filter/pagination assertions remain intact. |
| R13-06 | In an empty permission-enabled workspace, a member's `workspace_overview` returned directory identities with zero record dependencies. A later member-to-guest downgrade left those retained names visible even though fresh guest directory access is self-only. | Retained assistant authority also binds the exact principal role captured before reading/generation. Role changes invalidate retained copies and pending continuation, independently of record dependencies. | Deterministic actual-D1/in-memory MCP directory probe, followed by 32 passing runtime actual-D1 regressions, including a role change after SQL read but before persistence (`e205e76`). User IDs are not misrepresented as record IDs. |
| R13-07 | A real task-detail axe scan found four unnamed property selects, an unnamed due-date input and seven low-contrast labels (observed light-theme ratio about 2.58:1). Safari exposed canvas nudge buttons as arrows, then flattened their nested controls under listbox/option semantics. Wider task-detail checks also reproduced nested-interactive card markup and low-contrast board/sync controls. | Add accessible task/property and nudge names; use list/listitem with a pressed selection button for the canvas list, and a group with a native title button for draggable cards. Strengthen the observed label colors and keep compact editing controls at 16px. | The mandatory release UI gate now opens and edits a task, checks all property names, and runs axe in light/dark layouts across all three engines. The v7 pointer-free regression uses named nudge controls and list semantics. Safari task-property and canvas interaction are included where the native test runner completes. |

| R13-08 | The in-memory assistant store survived permission-barrier remounts. A delayed conversation response could repopulate private replies after the access epoch changed. | Clear retained messages, selections, derived drafts, approval state and retry arguments on authority changes; abort streams and bind asynchronous UI responses to account, session token and access epoch/status. Preserve only plain user-owned unsent drafts. | Deterministic unit red cases plus a permission-enabled real Worker/browser revocation journey using actual membership removal and Protocol 3 reconciliation. Eight client lifecycle regressions and 13 SSE tests pass; the actual permission-enabled browser case passes Chromium, Firefox and WebKit. The mandatory assistant gate now includes 24 assertions: 21 compatibility checks DISABLED, three cache-revocation checks ENABLED. Commit `1c4954f`. |

R13-01, R13-02, R13-06 and R13-08 are high-priority execution/privacy corrections. R13-03 is a low-priority impact presentation correction. R13-04, R13-05 and R13-07 are medium-priority mobile/accessibility corrections. These are reproduced defects, not speculative findings.

Red and green logs are retained under `.artifacts/pr13-review/`. The new D1 test uses the existing `assistant-*-d1.test.ts` discovery pattern, so it is included in both ordinary Vitest and the dedicated D1 gate. No certification gate was removed or relaxed.

### Retained privacy contract and limits

Visible citations are presentation, not complete authorization evidence. Retained source coverage is bounded at 1,000 IDs. Incomplete coverage fails closed; it never silently authorizes an inspected prefix. Legacy model/tool content without the new complete coverage marker is withheld without purging the retained original. Users can start a narrower conversation when old content cannot be verified.

Authority is checked before model history is sent, before pending dispatch, and before retaining generated/tool results. The browser also invalidates retained projections and in-flight responses when its current access/session identity changes. A fragment already streamed during an authorized in-flight request cannot be recalled after a later revocation. A revocation detected before retention stops the saved reply and continuation. This does not claim instantaneous recall from a remote model or a browser that already received content.

The focused resource probe exercised 14 HTTP requests across three permission-enabled actual-D1 regressions: maximum 22 D1 binding calls, below the existing 45-call limit. Full certification retains the existing SQL row/read/write performance gates; local binding counts are not production billing or latency estimates.

## MCP and provider evidence

The complete PR comparison was reviewed by boundary: companion authentication/streaming, shared capability registry, server bridge/runtime/storage/providers, contextual client UI, certification and additive migration 0032. Registry tests establish exact parity for all 77 capabilities, read-only annotations, unknown-tool denial and the six embedded human-only exclusions. The embedded assistant continues to use the canonical MCP handlers and frozen previews; no privileged mutation path was introduced.

| Route | Evidence and status |
|---|---|
| Claude.ai custom connector | **Previously recorded PASS**, at the October 21 synthetic Common Lab/Private fixture; OAuth/PKCE, scoped reads, private denial, proposal, genuine browser approval, execution/replay, injection refusal and revocation 401. Preserved in architecture §7. Not reauthorized this round. |
| ChatGPT custom MCP server | **Previously recorded PASS** for discovery, Common Lab scope, sourced reads, private denial, proposal-only behavior, injection refusal and post-revocation 401. Not reauthorized this round. |
| ChatGPT-plan local companion | **Previously recorded PASS** after `5cd0d16`: consenting account sign-in/model discovery, scoped Workspace access and pending proposal. Local `companion-chat.out` supports tool/source/proposal evidence. This round adds non-billable streaming and actual tool-loop regressions; it does not claim a second real-account run. |
| OpenAI BYOK | Non-billable Responses/egress/model/error contracts and encrypted user/provider-bound storage tested. Real API-key inference **NOT RUN**; requires an explicitly authorized owner key and call budget. |
| Anthropic BYOK | Non-billable Messages/tool-stream contracts tested. Real inference **NOT RUN**; Claude.ai subscription acceptance is not Anthropic API billing acceptance. |
| Workers AI chat | Default-off/fake-binding/budget/unavailable behavior tested. Real binding inference **NOT RUN**; no activation authorized. |
| Hosted ChatGPT-plan inference | Still gated on provider approval; local companion success does not authorize hosted subscription usage. |

Provider selection, exact egress hosts, redirect refusal, credential encryption, account isolation and no-fallback billing rules remain unchanged. No production credentials or browser-session files are committed. The old companion README banner now points to the dated real-host record rather than contradicting it.

Claude.ai controls its own generic post-revocation sign-in wording. Workspace correctly returns 401. There is no application-side correction for the host's text; users must reconnect explicitly if they want a new grant.

## Apple Simulator Safari

Toolchain actually available: Xcode 27.1 (`27A9275`), developer directory `/Applications/Xcode.app/Contents/Developer`. Installed runtime: iOS 26.4, version 26.4.1, build `23E254a`, identifier `com.apple.CoreSimulator.SimRuntime.iOS-26-4`. An immediately preceding OS runtime is not installed and is **NOT RUN**.

The test-only XCUITest bundle targets `com.apple.mobilesafari`; it is not a native production app or desktop WebKit. Reproduce with:

```bash
node scripts/apple-safari.mjs
# After an unchanged source build:
node scripts/apple-safari.mjs --skip-build
# Narrow rerun using installed simulator UDIDs:
node scripts/apple-safari.mjs --skip-build --devices=AB3404CB-2495-4BD2-BFAF-DA7D12628278
```

Default device matrix: a disposable iPhone SE (3rd generation) simulator (375 CSS-pixel portrait width), iPhone 17, iPhone 17 Pro Max, iPad (A16), iPad Pro 13-inch (M5). The compact device type was verified against the installed runtime before creating it; earlier iPhone 17e pilots are retained separately. Portrait and landscape are exercised. This is not evidence for compact 320px hardware, a second OS family or iPad resized Stage Manager windows.

The runner resets fixture rows between devices and verifies unique per-device edit markers and exactly one proposed-page execution. It records source SHA/tree/fingerprint, exact runtime/device inventory, exit codes, per-device logs, `.xcresult` bundles and exported screenshots under `.artifacts/pr13-apple/<run>/`. `results.json` is authoritative for final device PASS/FAIL; early pilot failures and concurrent-source development runs are retained and are not certificates. Final source certification is separate. Native test sequencing waits for an enabled Send control after streamed text, and each test closes any leftover assistant so one failed case cannot contaminate later navigation. Loopback fixture writes use fresh connections without automatic write retries.

The clean `a5a3304` native attempt preserved a compact SE3 editing/rotation PASS and failed/unexecuted later cases. It exposed a disabled-Send test sequencing error; its dependent navigation failures are not independent application defects. A Pro Max boot failed before application load with CoreSimulator `Invalid connectionUUID specified` / NSPOSIXErrorDomain 22. A synthesized pinch aimed at the whole Safari web view did not change canvas geometry; this remains a failed gesture assertion with delivery ambiguity, not a verified product regression or PASS.

Executed pilot cases include Safari sign-in, Unicode page editing with the native keyboard, rotation during editing, app background/foreground draft retention, source-backed simulated assistant responses and human approval/execution with changeset feedback. The final harness documents its assertions directly; it does not claim every product feature has received manual mobile acceptance.

## Accessibility and remaining external acceptance

The existing mandatory release UI gate keeps axe WCAG 2.2 AA checks, keyboard focus/restore checks, touch navigation and 320/390/430/768/1024/1440px reflow on Chromium, Firefox and WebKit. Computed input text sizes now guard the iPhone zoom regression. XCUITest accessibility queries are automation evidence, not human VoiceOver use.

| Gate | Status / shortest remaining action |
|---|---|
| Physical iPhone/iPad Safari and Android Chrome | **NOT RUN**. Use an authorized disposable HTTPS fixture, then execute sign-in → Unicode edit/save/reload → search/task edit → assistant preview/approve/cancel → offline/reconnect and account sign-out. Capture device/OS, screenshots and observed failures. |
| Manual VoiceOver, TalkBack, desktop NVDA or equivalent | **NOT RUN**. A human tester must verify labels, reading/focus order, edit cursor, modal restoration, error announcements and approval controls. |
| Native 400% browser zoom/text scaling | **NOT RUN**. Set actual browser zoom to 400%, traverse shell/search/settings/editor/approval with keyboard, record zoom UI and action reachability. Automated 320px reflow is supporting evidence only. |
| Physical camera/microphone/file providers | **NOT RUN**. Test permission denial, capture/upload interruption, resume and downloadable original on real hardware. Simulator media support is not physical hardware proof. |
| Home Screen installation / OS suspension / storage eviction | **NOT RUN** in this simulator iteration. Test separately from normal Safari tabs; no guaranteed background sync or permanent origin storage is claimed. |
| Detailed canvas multitouch / iPad resized-window parity | **NOT RUN** unless explicitly present in the per-device evidence. Existing desktop browser canvas regressions remain required. |

## Exact-source certification and release boundary

The inherited `5cd0d16` background runs had no valid certificate for this correction tree. The first was stopped gracefully after confirmed defects made it superseded; a second older Claude-owned run was found with a recorded source mismatch and stopped gracefully too. Their failure/interruption evidence remains archived. It must not be described as 34/34 PASS.

The first clean `a5a3304` complete run was interrupted before completion to correct native test sequencing; its archived FAIL/NOT RUN result is not final acceptance. Final acceptance command: `npm run certify:ai`, on a clean committed source. All 34 existing mandatory gates remain required. Authoritative results are `.artifacts/certification/<final-SHA>-<timestamp>-complete/{summary.json,report.md,commands.json,test-results.json,environment.json,performance.json,security-audit.json,migrations.json}`. Check `completeLocalCertification`, exact SHA/fingerprint, initial/final source integrity and actual command exits. Unit and dedicated D1 counts overlap and must not be added as unique tests. Apple results are an additional separately identified run.

Publication to PR #13 is authorized after successful final certification. PR #12 and PR #13 remain open/draft/unmerged. Production deployment, D1 migration 0032, permission activation, provider activation, live secrets and connector changes require separate authorization. Passing local automation does not approve those operations or close the external gates above.
