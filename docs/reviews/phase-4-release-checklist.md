# Phase 4 external release checklist

Status 2026-10-15: **NOT RUN — production release blocked**. Automated local
Chromium/Firefox/WebKit checks are recorded separately by `npm run certify:phase4`.
Run that command on the final integrated SHA first. It already covers functional
workflows, 320/390/768/1024/1440px reflow, keyboard/dialog focus, touch actions,
reduced motion, offline recovery and the integrity regressions. Do not repeat
those manually merely to create another checklist result.

## Prepare once

Use a disposable migrated Worker fixture and fixture accounts/data only. Record
the tested commit/fingerprint, actual OS/browser builds and device model. Obtain
an approved HTTPS test origin reachable by the device; do not expose a personal
database or deploy production as part of this checklist. Use the existing TCG
fixture to select `DB_ID`, `RECORD_ID`, `PAGE_ID` and a public `FORM_TOKEN` (keep
tokens out of shared evidence). Routes below are relative to that test origin.
Save short screen recordings/screenshots with pass/fail and recovery steps;
capture console/network errors only after scrubbing credentials and test tokens.

| Gate | Required actions and exact routes | Expected result / evidence | Connected automation / severity |
| --- | --- | --- | --- |
| Physical iPhone Safari | Open `/boards/DB_ID`, then `/boards/DB_ID/tasks/RECORD_ID`; edit using the software keyboard, change orientation, attach a camera photo, go offline, edit, close/reopen Safari, reconnect. Open `/inbox`; request/decide a fixture approval. | Controls remain reachable above keyboard/safe areas; local/pending/server states are distinguishable; photo and edit recover without duplicates; approval authorization holds. Record portrait/landscape and reopen/sync outcome. | Safari Web Inspector plus free Xcode/WebDriver/Appium tooling can assist when configured; human camera/keyboard/lifecycle observation remains. **Release blocker.** |
| Physical iPad Safari | Repeat the short database/record/Inbox path in portrait, landscape and split view; use touch and attached keyboard if supported. Open `/pages/PAGE_ID` Drive embed. | No hidden actions/reflow loss; correct embed fallback/link; dialog focus/close works. Record actual Safari/iPadOS builds and layouts. | Same tooling limitations; Playwright WebKit is not this gate. **Release blocker.** |
| Physical Android Chrome | Repeat phone database/edit/photo/offline/reopen/approval flow, then `/f/FORM_TOKEN` in a signed-out browser using the fixture form's Copy link. Submit once with network interruption. | Keyboard/file picker and back navigation work; recoverable media; one server-confirmed form receipt/output after retry. Record OS/Chrome and receipt count without tokens. | Free USB ADB/Chrome remote debugging/CDP can automate DOM interactions; camera/OS lifecycle still observed. No authorized attached device was detected in this round. **Release blocker.** |
| VoiceOver on actual Safari | Enable VoiceOver. On `/inbox`, navigate unread item/preferences, then `/boards/DB_ID/tasks/RECORD_ID`; open/close approval dialog and return focus. On the public form, submit invalid then valid input. | Meaningful names/order, announced errors and state, dialog containment and restored focus; no touch-only action. Capture a short narrated recording and exact failure steps. | Automated accessibility/keyboard checks already run; screen-reader announcements require human assessment. **Release blocker.** |
| TalkBack on physical Android | Repeat the VoiceOver route/actions using linear and explore-by-touch navigation. | Equivalent named controls, error announcements and recoverable focus; no inaccessible action. Record actual device/build. | ADB may enable tooling, but cannot replace human announcement evaluation. **Release blocker.** |
| Native 400% browser zoom | In a branded desktop browser, use its **native Zoom menu** to 400% on `/inbox`, `/boards/DB_ID`, `/boards/DB_ID/tasks/RECORD_ID`, and the public form. Navigate by keyboard and submit invalid input. Reset zoom afterward. | No lost text/actions or overlapping errors; two-dimensional canvases have usable scoped scrolling. Capture screenshot including native zoom indicator and viewport/build. | Native menu automation is possible on a test profile; CSS zoom/deviceScaleFactor/320px emulation does not establish this result. **Release blocker.** |

The actual public form route is `/f/:token`; confirm the generated fixture URL
before execution. No personal OAuth grants or real submissions are needed.
This Mac has the Android SDK but reported no attached authorized device; Xcode
`devicectl` is unavailable. No physical device result is inferred from that
inventory. These checks remain NOT RUN until executed with evidence.

## Operational acceptance before deployment

- [ ] Security PR reviewed and approved; integrated Phase 4 SHA has a fresh full
  certification and clean raw audit (or separately signed explicit exception).
- [ ] Independent source/security review accepted; all release blockers above
  have evidence and a named reviewer. Record failures rather than marking skips PASS.
- [ ] Production hostname, OAuth audience/registered redirects, production
  Turnstile, secrets/bindings and allowed origins reviewed without printing values.
- [ ] Current D1/KV/DO capacity and quota assumptions checked against the target
  account; local Miniflare timings are not production-cost evidence.
- [ ] Recoverable backup/export obtained; restore tested in disposable state;
  migration 0011 and application rollback order reviewed (binary deletion cannot
  be undone by reverting source). Record backup location/access owner, not secrets.
- [ ] Prior Worker version and rollback command identified; candidate artifact
  SHA and smoke checks prepared. Deployment requires separate explicit approval.
- [ ] Monitoring owner, redacted Worker errors, Cron/outbox failure checks,
  quota alerts and incident/rollback contact established.

Record each external gate as PASS/FAIL/NOT RUN with tested SHA, date, device/build,
artifact and reviewer. No deployment authorization is implied by this document.
