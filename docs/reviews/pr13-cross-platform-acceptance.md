# PR #13 cross-platform qualification

Continuation date: 2026-10-22. Authoritative worktree: `/Users/trinity/Desktop/tcg-unified-ai`, branch `feature/unified-ai-mcp`. The original release checkout is preserved. PR #13 remains stacked on draft PR #12; neither merge nor production operation is authorized here. This qualification extends the accepted `ba026e05d737afeb2fe837c30d64cd3af430362d` checkpoint. It does not substitute its certificate for changed source.

## Confirmed defects and corrections

| Finding | Reproduction and cause | Correction | Evidence |
|---|---|---|---|
| R13-X01, P1 | Install a new shell revision, lose the network, reload. The single `ws-precache-v3` cache retained several revisioned `index.html` entries; `ignoreSearch` returned the earliest shell. | Commit `e396a65`: key the shell cache by build revision; navigation uses only the current build. Retain at most one previous app cache for immutable lazy chunks in open old tabs. Leave unrelated origin caches alone. | `.artifacts/cross-platform/sw-upgrade-red-isolated/` retains the failing real-browser upgrade. `cross-platform-qa.mjs` verifies the new offline shell, preserved account, bounded cache retention and previous chunk retrieval. |
| R13-X02, P1 | In actual WebKit, cut the server connection while the network interface remains online. Reloaded permitted content showed Access check required. The sync error path treated a transport failure as failed authorization. | Commit `554da64`: status-zero transport errors use the existing validated, account-bound offline-access path. Recheck session/account after awaiting it. HTTP 401/403 and known-stale reconciliation stay denied; outbox work is retained. | `network-online-engine-red.log` records two failing regressions; `network-online-engine-green.log` records 43 passing engine/cache tests. Real network cut and subsequent server persistence are exercised by the browser runner. |
| R13-X03, P1 | Return a real 503 for a new build's required JavaScript entry, then reload offline. The installer swallowed cache failures and called skipWaiting in finally, activating an incomplete shell. The retained red screenshot/body confirm an empty application, not a missing selector. | Deduplicate exact request URLs (Workbox lists some icons twice), then cache the complete required manifest atomically with Cache.addAll. Reject installation on failure, remove only a newly created failed cache and leave the prior worker active. Never delete a cache shared with an already-active shell revision. | `.artifacts/cross-platform/sw-interrupted-main-red/`; the platform runner now injects a required-entry 503 and requires redundant installation, unchanged active worker/cache keys, preserved account and actual offline editor content. |

No membership, connector, approval, billing, production permissions or migration changes are part of these fixes. R13-01 through R13-09 and R13-M01 remain required. Unit and dedicated D1 totals overlap.

## Harness diagnosis

Playwright WebKit's global offline emulation failed a minimal control service worker returning literal HTML. Removing content-encoding headers did not fix that control or the application and was reverted. WebKit now uses a loopback reverse proxy that actually severs connections while leaving the network interface online. Chromium and Firefox retain their normal offline emulation. This is a transport test, not a claim that a simulator reproduces a radio modem.

Android Firefox's native first-run browser UI covered an already-loaded DOM. The harness completes observed native onboarding, opens an actual browser tab through an Android VIEW intent, selects the matching Marionette window, and only then interacts with the page. Missing elements underneath onboarding were harness failures, not application defects. Native Android menu targets come from fresh UI hierarchies; stale hierarchy files cannot establish PASS.

Apple tests retain their semantic targets, hit-testing diagnostics, consumed-toolbar-action checks, software keyboard approval and independent server persistence. Repetitions are distinct required attempts, not retries that hide a failure. XCTest has bounded per-test execution limits and the original outer deadline. No assertion is removed. `--https` trusts a temporary CA only inside owned simulator clones; originals and the Mac trust store remain untouched. Clones are stopped/deleted by the owning runner; result bundles are retained.

## Reproducible qualification

Run commands from the authoritative worktree after committing all source and confirming `git status --porcelain` is empty. Preserve stdout/stderr and actual exit codes. No shell command here deploys or migrates remotely.

```bash
npm run certify:ai
CROSS_QA_ARTIFACT_DIR=.artifacts/cross-platform/final-desktop node scripts/cross-platform-qa.mjs --skip-build --pwa
APPLE_ARTIFACT_DIR=.artifacts/pr13-apple/final-cross-platform node scripts/apple-safari.mjs --https --skip-build
APPLE_ARTIFACT_DIR=.artifacts/pr13-apple/final-cross-platform-repetitions node scripts/apple-safari.mjs --https --skip-build --devices=1BDCB883-27F6-43E6-82A1-40FA4F2F8C19,FB5D2F9F-F78A-474D-A22D-8BE5BE343302 --repetitions=2
FIREFOX_ANDROID_APK=.artifacts/cross-platform/firefox-158.0.2-arm64.apk GECKODRIVER_BIN=.artifacts/cross-platform/geckodriver CROSS_QA_ARTIFACT_DIR=.artifacts/cross-platform/final-android node scripts/android-qa.mjs
node scripts/cross-platform-coverage.mjs PATH_TO_COMPLETED_CERTIFICATE .artifacts/cross-platform/final-coverage.json
```

The Android owner provisions a fresh AVD using the installed Android 35 Google APIs ARM64 image. It does not reuse Chronicle or physical device data. Chrome runs compact, large phone and tablet geometry on that one OS; these are not three hardware models. Firefox uses Mozilla's signed shipping APK and geckodriver. Supply verified official binaries in the ignored artifact directory; they are not source dependencies or committed artifacts. Chrome PWA installation is attempted through native controls and must yield an observed standalone target, otherwise it remains BLOCKED. A shortcut alone does not prove installed-PWA acceptance.

`cross-platform-qa.mjs` starts a copied production build on a disposable local Worker with local D1/KV/DO. It creates a short-lived TLS certificate, verifies it in Node, and uses an exact SPKI exception in isolated Chromium profiles. Other automated engines use test-only certificate acceptance. Apple clones trust the same fixture CA through their own keychains. This proves local HTTPS application integration, OAuth resource-origin consistency, secure WebSocket upgrades, service-worker recovery and server persistence. It is **not** a public-CA staging deployment, Internet redirect validation or physical cross-device network certification.

The installed macOS Chrome PWA test uses a temporary profile, verifies `display-mode: standalone`, relaunches offline, then uninstalls that fixture. It does not access the user's normal Chrome profile.

Every runner captures initial SHA/fingerprint and checks ending source integrity. `results.json` records actual per-case outcomes, and Apple directories also retain `.xcresult`, screenshots, probe logs and persistence records. Development runs with dirty or changed source remain diagnostics. The final clean certificate and final platform reports, not this document's command examples, determine acceptance. A missing/failed/blocked case is never inferred PASS from a test file.

`cross-platform-coverage.mjs` inventories source routes and associates exact executed certificate assertion names with 21 product groups. Evidence may overlap groups. This is a review index, not proof that every possible subfeature, OS or hardware interaction has been exercised. It rejects incomplete certificates and retains platform and permission-mode distinctions.

## Environment and external gates

| Surface | Available evidence / unmet prerequisite | Exact remaining action |
|---|---|---|
| macOS Playwright Chromium/Firefox/WebKit | Existing 34-gate matrix plus added HTTPS/offline/upgrade cases; these engines are not other operating systems. | Read final reports for exact versions and exits. |
| Installed macOS Chrome | Chrome 156.0.8078.48; temporary-profile installed PWA and offline relaunch executed during development. | Require final clean-source report before acceptance. |
| Native macOS Safari | Safari 27.0.1; WebDriver refused session because Allow remote automation is disabled. No setting was changed. | Owner enables Safari remote automation for an isolated acceptance session; rerun real Safari journeys. Desktop WebKit is separate evidence. |
| Windows and Linux shipping browsers / macOS Edge | No authorized Windows/Linux VM or remote environment, Docker daemon unavailable, Edge absent. | Provide an authorized OS/browser environment; run the existing browser acceptance there and retain environment metadata. |
| iPhone/iPad Simulator Safari | Installed Xcode 27.1, iOS 26.4.1 build `23E254a`; SE3, 17, 17 Pro Max, iPad A16, iPad Pro 13-inch M5. | Final HTTPS five-device matrix and repeated SE3/Pro Max cases, with all attempts retained. |
| Previous major iOS | `xcodebuild -downloadPlatform iOS -buildVersion 18.6` and the separate 18.5 attempt both returned exit 70: runtime not available for download. | Supply an available previous-major Xcode runtime or authorized physical device. This is not satisfied by a different screen size. |
| Android | Disposable Android 15 emulator; bundled Chrome 124 and shipping Firefox 158.0.2. One available OS image. | Read actual final reports. Newer Chrome, a second OS, Samsung Internet and physical hardware require available signed browser/runtime/device access. |
| Android/iOS Home Screen behavior | Attempted Android native installation; iOS Home Screen suspension/storage-pressure acceptance remains separate from Safari tabs. | On an authorized HTTPS fixture, install, relaunch offline, edit/reconnect and verify server persistence; capture display mode. |
| Native 400% zoom | The development GUI attempt was blocked, but clean `1c1bb30` qualification subsequently reached the exact owned Chrome window: actual View/Zoom In menu, DPR 2→8, 1280→320 CSS pixels, no overflow, keyboard search and restored focus PASS. Evidence: `.artifacts/cross-platform/final-native-zoom/`. | Retain actual native zoom evidence separately from automated reflow and human screen-reader acceptance. Repeat against the final source using `cross-platform-qa.mjs --only=chrome --pwa --native-zoom`. |
| Human accessibility | No actual VoiceOver/TalkBack/NVDA session completed. Axe, accessibility-tree queries and keyboard tests are automated evidence. | Human tester traverses sign-in, editor, search, task detail, assistant, approval and canvas alternatives at 200/400% zoom and with the relevant screen reader. Record labels, order, errors and focus recovery. |
| Physical media / hardware | No connected physical iPhone/iPad/Android; camera, microphone, file-provider, storage eviction and genuine OS suspension unverified. | Test permission denial, upload interruption/resume and retained originals on hardware. Never promise permanent origin storage or background execution. |
| AI providers | Preserve dated Oct 21 Claude.ai, ChatGPT MCP and local companion acceptance; removed test grants are not reused. Contracts remain simulated in certification. | Owner-supplied authorized accounts are needed only for new real-provider acceptance; no paid call or implicit subscription/API equivalence. Workers AI remains OFF. |
| Production release | No merge/deployment/migration/live secrets/permissions/config changes in this task. | Separate owner approval plus existing release preflight, validated recovery point and production acceptance. |

## Operations and source acceptance

Use `docs/releases/1.0.0-candidate.md` as the canonical deployment/migration/rollback runbook. The 34-gate AI certificate includes release preflight, populated migration/failure recovery and logical backup/restore with FTS reconstruction. D1 recovery does not recover KV or Durable Object state. Keep permissions and optional providers off until separately authorized. Secrets must never appear in evidence. Review migration 0032 as an additive PR #13 change, not as part of PR #12's 31-migration approval.

Before publishing: require a clean exact-source certificate, inspect final diff for production/billing changes, verify remote ancestry, push the feature branch normally and update draft PR #13. Do not merge either draft. Final report must give exact SHA/tree/fingerprint and actual artifact paths. If platform tools are unavailable, use ENGINEERING GO / EXTERNAL BLOCKED only when all engineering-controllable required checks pass; unresolved reproduced defects or failed mandatory gates require HOLD.

## Retained intermediate failures and native isolation correction

The first clean `1c1bb30` complete certificate was interrupted after two Cron-offset assertions failed while separate device fixtures were active. It is a failed/incomplete certificate, not a PASS. Both offsets subsequently passed a focused two-test recheck (13 explicitly unselected tests); this does not establish the failure cause or replace final complete certification. The final certification must run without competing device or fixture runners.

The `1c1bb30` HTTPS matrix passed all five cases on SE3, iPhone 17 and A16. Pro Max's first case hit the newly introduced 120-second per-test cap after XCTest reported repeated missing animation-completion notifications; the screenshot still showed the edited page. Recovery then stalled in Safari accessibility setup, and the already-failed owned Xcode process was stopped. Its incomplete bundle and raw logs remain retained. Pro13 passed four cases but its first interactive sign-in displayed the real `offline` error; there was no basis to relabel that first attempt a successful sign-in or confirmed application bug. All failures remain in `.artifacts/pr13-apple/final-cross-platform/`.

The harness now terminates Safari between independent cases before setting orientation/opening the exact fixture URL. This prevents stale renderers and a failed case from contaminating following cases, while keeping actual session storage and the explicit in-case background/foreground/rotation tests. The per-test allowance is 180 seconds, justified by the observed two 60-second XCTest animation waits plus the case's actions; the overall 600-second per-device deadline is unchanged. No private XCTest quiescence API, automatic login retry, suppressed assertion or app animation bypass is used. Fixture-only telemetry now captures failed API method/path/status/error-name without bodies, query strings, credentials or source content, so transport failure can be distinguished from authentication denial. The next complete device matrix and repetitions must pass on the new committed source.

A separate Android diagnostic retained CDP target metadata and native activity state: after the install attempt the foreground activity was still ChromeTabbedActivity, not a verified standalone app. Android Home Screen acceptance remains BLOCKED for this private origin; it is not converted to PASS from an icon or screenshot.

### Required-asset fault injection follow-up

All 25 primary cases on clean `1f51e3b` passed, including all server-persistence checks. A separate required-entry 503 injection then confirmed R13-X03: an incomplete service worker activated and its offline shell rendered no body content. The partially completed `repeated-1f51e3b` matrix was stopped as superseded before source edits, with owned fixtures/clones cleaned and interruption evidence preserved. It is not a completed repetition certificate. This additional correction requires a new clean source qualification; no `1f51e3b` result certifies the changed installer. The failure test is now part of every desktop/Android platform journey and uses only an explicitly scoped loopback asset fault, never a production request.
