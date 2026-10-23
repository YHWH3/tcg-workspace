# Testing tools follow-up, 2026-10-23

The user's screenshots disproved the earlier impression of complete visual/device coverage. Existing passing workflow assertions and engine/viewport sampling did not establish that every feature, open control or native browser window had been visually checked. The UI follow-up remains a separate, source-bound acceptance record.

## Public tools researched

| Tool | Relevant capability | Decision here |
|---|---|---|
| [Playwright Test](https://playwright.dev/docs/test-snapshots) | Stable screenshot comparisons and per-browser references; [local traces](https://playwright.dev/docs/trace-viewer) reconstruct failures. | Installed exact `@playwright/test@1.63.0`, matching the existing Playwright engine package. Used in the local UX lab. |
| [fast-check](https://fast-check.dev/docs/advanced/model-based-testing/) | Generates action sequences, shrinks failures and supports replay. | Installed exact `fast-check@4.10.2`; used against the real UI with synthetic data. |
| [axe with Playwright](https://playwright.dev/docs/accessibility-testing) | Automated contrast, semantics and other accessibility rules. Automated coverage is partial. | Existing package retained, extended to whole-page named states and open controls. Added custom control-box geometry because axe does not detect the screenshot's clipped glyphs. |
| [Midscene](https://github.com/web-infra-dev/midscene) | Open-source visual AI actions/assertions, including browser and device integrations. Its [current ChatGPT setup](https://midscenejs.com/chatgpt-subscription) requires authorization and consumes subscription usage; the Codex sign-in reuse path is now deprecated. | Researched; not activated under the no-paid-inference boundary. No model credentials read, copied or refreshed. |
| [Stagehand](https://docs.stagehand.dev/v4/configuration/models) | AI browser interactions; current gateway can choose models automatically with Browserbase configuration/billing. | Researched; no paid gateway/account activated. |
| [Chromatic](https://www.chromatic.com/docs/playwright/) and [BrowserStack/Percy](https://www.browserstack.com/docs/percy/visual-testing-workflows/view-percy-build-results/visual-testing) | Hosted visual comparison/review; BrowserStack also provides configured mobile browser/device runs. | Potential later hosted/device layer. No cloud test upload, account activation or remote exposure was authorized here. |

Registry existence/integrity was checked before installation. These packages are development-only. Research used official upstream documentation via TinyFish Search/Fetch. No tool can infer that an initial reference image is good merely because later images match it; emulation also does not prove physical-device behavior.

## Additional confirmed issues

The first lab runs retained failures as evidence instead of suppressing them:

| ID | Finding | Correction |
|---|---|---|
| UI09 | Some configured avatar colours failed contrast for small white initials; the previous fixture's colour did not expose this. | Shared avatar chooses black or white text using relative luminance while preserving the background. All eight palette colours are exercised in the UI. |
| UI10 | Calendar/timeline date labels, database/form actions, approval empty/failure text and inactive Activity tabs were too faint. Fading the entire outside-month cell also faded its contents. | Readable existing neutral tones in both themes; outside-month dates use a background distinction instead of opacity on content. |
| UI11 | Notification row was a button containing buttons; unread dot had an invalid accessible name on a generic span. | A real content button sits beside independent row actions; unread indicator has an image role. |
| UI12 | Empty-search feedback and pagination were children of the ARIA results list instead of options. | Feedback/status and pagination sit outside the listbox. Empty-result and result-recovery states are tested. |
| UI13 | Added filter/sort dropdowns lacked names and remove actions were undersized. | Named field/operator/value/direction controls and minimum 24px remove actions; actual opened/added controls are audited. |

One exploratory random action tried to focus the inert shell behind a compact modal. That was a test-model error, not counted as a product defect: exploration now invokes the supported keyboard search shortcut from the detail surface. Each generated case resets its environment for reliable shrinking/replay.

An intermittent local Chromium HTTPS stylesheet request failed with `ERR_TOO_MANY_RETRIES`. Those runs are failures, not passes. The isolated Chromium test process uses a launch-scoped certificate exception alongside its local context; all external requests stay blocked. A render sentinel prevents misleading accessibility results against a page with no stylesheet. This is not production TLS evidence.

## Evidence and durable continuation

Implementation: `scripts/qa-ux.mjs`, `scripts/ux-lab/`, and [the run guide](../testing/UX-LAB.md). The full planned matrix is 29 named cases × 18 projects = 522 cases. A case may contain multiple assertions/scans; the case count is not a count of devices or unique bugs.

The machine-readable run summary records executed/failed/missing cells, source fingerprint, exact browser builds, generated actions and replay information. The coverage page marks unexecuted states NOT RUN. Reference-capture runs remain distinct from ordinary comparison runs and from genuine human review. Final run results are recorded in ignored artifacts after the committed source is frozen; this document does not predeclare their outcome.

Earlier source `5293660` passed the affected v4/v7/v8/v9/Phase5-sync/Phase5-workflows/Phase6-workflows/assistant suites (33/114/140/75/33/36/42/27 cases respectively), and v6/Website/release-UI follow-up (150/9/18). Those exact-source results remain historical evidence; the added UI fixes and development dependencies require current-source validation.
