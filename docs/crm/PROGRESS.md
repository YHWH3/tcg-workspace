# TCG CRM — Engineering Progress Checkpoint

This file is the live engineering checkpoint for the TCG CRM project. The canonical decision ledger remains [`01-DECISIONS.md`](01-DECISIONS.md) (decisions are not duplicated here).

## Current Snapshot

| Item | Value |
|---|---|
| **Principal engineering agent** | Neon (T3 Code; revised A-26) |
| **PM & independent review** | ChatGPT |
| **Owner & approver** | Paul |
| **Repository & active branch** | `YHWH3/tcg-workspace`, branch `crm/s0-frontend` (branched from verified Stage 2 backend `crm/s0-backend` @ `98938ecb10164f705223615cbc42cc0c65d20bc8`) |
| **Workspace baseline commit** | `38c388ac1787b0ff14e8e26d7abd1bf8c6bd0444` (`codex/workspace-database-platform`) |
| **Reviewed documentation baseline** | `8aa6f5300426029dc1db87e979fb871313190973` (`crm/foundation`, Checkpoint 1 accepted) |
| **Active contract version** | [`contracts/crm-s0-v2.md`](contracts/crm-s0-v2.md) (**Accepted**, superseding `crm-s0-v1`) |
| **Current stage** | **N4 — Final S0 Corrections & Integrated Certification (Checkpoint 3 Review)** |
| **Overall S0 acceptance status** | **BLOCKED AT FULL 18-PROJECT WORKSPACE CRM-OFF `qa:ux` GATE BY PRE-EXISTING WORKSPACE DEFECT (`finance.spec.mjs:46` / `TableView.tsx:281`).** All CRM N4 corrections, unit/D1 tests (2,299/2,299), typecheck, build, migrations, cert scripts (153/153), demos, 18-project CRM UX matrix (36/36, 54 visual references at 0 diff pixels), 18-project Workspace `website-inbox` visual regression (18/18, 0 diff pixels), and desktop full Workspace suite (108/108) **PASS**. |

---

## Completed Work

1. **Workspace takeover & input archive verification (24 Nov 2026)**
   - Verified clean repository checkout on branch `crm/foundation` at `d1742a09cb1972644ba869134208dc70a76524d7` and Workspace baseline `38c388a`.
   - Verified local confidential archive under `docs/crm/input/` (excluded from git via `docs/crm/.gitignore`; never committed).
2. **Checkpoint 1 — Closed S0 Contract Review findings CR-01 through CR-06 (`crm-s0-v2`, accepted at `8aa6f53`)**
   - Resolved CR-01 through CR-06 in [`contracts/crm-s0-v2.md`](contracts/crm-s0-v2.md), updated [`01-DECISIONS.md`](01-DECISIONS.md) (revised A-26), [`S0-PLAN.md`](S0-PLAN.md), and [`BACKEND-S0-BRIEF.md`](BACKEND-S0-BRIEF.md).
3. **Stage 1 — Shared Contracts (`shared/crm/*`, branch `crm/s0-backend`)**
   - Implemented [`shared/crm/capabilities.ts`](../../shared/crm/capabilities.ts), [`shared/crm/projection.ts`](../../shared/crm/projection.ts), and [`shared/crm/contracts.ts`](../../shared/crm/contracts.ts).
4. **Stage 2 — S0 Backend Implementation (`migrations/0045_crm_foundation.sql`, `worker/`, `scripts/`, 8 backend test suites)**
   - Implemented [`migrations/0045_crm_foundation.sql`](../../migrations/0045_crm_foundation.sql), `worker/crm/*`, always-on Workspace hardenings in `worker/sync.ts`, `worker/mutationAccess.ts`, `worker/admin.ts`, and `/api/crm/*` mount in `worker/index.ts`.
   - Passed Checkpoint 2 ChatGPT review at `98938ecb10164f705223615cbc42cc0c65d20bc8`.
5. **N3 — Stage 3 Frontend Implementation (`e9c01028fb5ccb905494c83154945abae4bd1694`, branch `crm/s0-frontend`)**
   - Implemented [`src/core/crmStatus.ts`](../../src/core/crmStatus.ts), [`src/core/AppSwitcher.tsx`](../../src/core/AppSwitcher.tsx), [`src/core/shell.tsx`](../../src/core/shell.tsx), [`src/routes.tsx`](../../src/routes.tsx), [`src/App.tsx`](../../src/App.tsx), [`src/apps/crm/*`](../../src/apps/crm/CrmShell.tsx), [`scripts/crm-demo/*`](../../scripts/crm-demo/preview.mjs), and frontend unit/isolation/UX tests.
6. **N4 — Final S0 Corrections & Integrated Certification (25 Nov 2026, branch `crm/s0-frontend`)**
   - **Account-bound command retries & stale read discard ([`src/apps/crm/api.ts`](../../src/apps/crm/api.ts), [`src/core/crmStatus.ts`](../../src/core/crmStatus.ts), [`src/apps/crm/settings/AccessSettings.tsx`](../../src/apps/crm/settings/AccessSettings.tsx), [`tests/crm-client-contract.test.ts`](../../tests/crm-client-contract.test.ts)):**
     - `runCrmCommand`, `grantCrmCapability`, and `revokeCrmCapability` capture `(uid, token, accessClientStore.epoch, ws_uid)` via `captureCrmSessionBinding()` before starting retries, build request headers once from the captured token, re-verify `assertSameSession()` before every request, after retry delays, after async responses (`fetch`, `res.text()`, `notifyCrmStatusUpdated`), and before returning outcomes — failing closed with `CrmTransportError('identity_changed', retryable: false)` without ever retrying under a replacement account's credentials.
     - `fetchCrmRead` (`fetchCapabilityOverview`, `fetchCapabilityAudit`) and `callWorkspaceAdmin` re-verify session binding after async `api()` completion/rejection so delayed `200`/`401`/`403` responses never mutate replacement account state or invoke `dropSession()`.
     - Legitimate same-identity retries across network drops and `503 write_interrupted` / `processing_budget` preserve `requestId` and bound token verbatim.
     - `AccessSettings.tsx` clears in-memory protected state immediately on identity change even when the new account also holds `canManage`, and ignores `identity_changed` errors silently.
   - **Automatic remote capability revocation & demotion ([`src/core/crmStatus.ts`](../../src/core/crmStatus.ts), [`scripts/ux-lab/crm-shell.spec.mjs`](../../scripts/ux-lab/crm-shell.spec.mjs)):**
     - Added `CRM_FALLBACK_POLL_MS` (`4_000` ms) foreground authority poll in `startCrmStatus()` active only when CRM is enabled, online, visible, and LiveRoom WebSocket is disconnected (Protocol 3 stops LiveRoom presence in `src/core/sync/engine.ts:390`, creating zero polling overhead when CRM is off or WS is connected).
     - Extended `crm-shell.spec.mjs` with automated tests proving remote `crm.capabilities.manage` revocation and remote `admin -> member` demotion automatically unmount protected Settings into `"You don't have access to this"` without manual Refresh, while retaining manual-Refresh and offline/reconnect recovery checks.
     - Added explicit CRM visual reference assertions (`toHaveScreenshot`, `maxDiffPixels: 0`) for `crm-home.png`, `crm-settings-capabilities.png` (masking dynamic `<time>` paragraph container), and `crm-access-denied.png` across all 18 projects.
   - **Narrow compact Workspace accessibility fix ([`src/core/views/DatabasePage.tsx`](../../src/core/views/DatabasePage.tsx), [`scripts/ux-lab/playwright.config.mjs`](../../scripts/ux-lab/playwright.config.mjs)):**
     - Wrapped `ViewTabMenu` and `+ View` `Popover` in `min-w-0 max-md:shrink-0` in `DatabasePage.tsx`, eliminating the 390 px overlap with `.min-w-9` while leaving tablet/desktop layout (`>= 768px`) byte-identical (`maxDiffPixels: 0` against original `38c388a`).

---

## Baseline & Screenshot Provenance

| Artifact Set | Source & Method | Coverage | Status |
|---|---|---|---|
| **Original Workspace baselines** (`.artifacts/ux-lab/baselines/`) | Unmodified isolated checkout of `38c388ac1787b0ff14e8e26d7abd1bf8c6bd0444` (`fingerprint: 87796aa3f5f95da3ee1aa6f37004690d58da32cea00e0d51373e32429101b1ec`) | 12 desktop & tablet projects (`website-inbox.png` + `provenance.json`) | **Unchanged**; 12/12 pass `maxDiffPixels: 0` |
| **Corrected compact Workspace baselines** (`.artifacts/ux-lab/baselines-compact-a11y-fix/`) | Isolated detached checkout of `38c388a` (`baseFingerprint: 87796aa3...`) + ONLY `src/core/views/DatabasePage.tsx` compact patch (`patchSha256: 7a02a0ae2a79104a8116fa265b0eb35f5e85c0de0c9818db007333ee45638379`) | 6 compact `390×844` projects (`website-inbox.png`, `compact-a11y-fix.patch`, `provenance.json`) | **6/6 pass** `maxDiffPixels: 0` + WCAG 2.2 AA axe |
| **CRM explicit visual baselines** (`.artifacts/ux-lab/crm-baselines/`) | Recorded via `npm run qa:ux -- --crm --record --skip-build` (`2026-11-25T07-52-56.672Z`) and verified independently via `npm run qa:ux -- --crm --skip-build` (`2026-11-25T08-03-52.557Z`) | All 18 projects × 3 PNGs = **54 visual references** (`crm-home.png`, `crm-settings-capabilities.png`, `crm-access-denied.png`) + `provenance.json` | **18/18 projects (36/36 specs) pass** at `maxDiffPixels: 0` |
| **Commons demo screenshots** (`.artifacts/crm-demo/`) | Generated by `npm run demo:crm -- --check` against real Worker + D1 (`CRM_ENABLED=true`) | Light & dark desktop + compact mobile walkthrough screenshots | Passed (`CRM Commons demo checks passed`) |

---

## Backend-First S0 Execution Plan Status

| Stage | Scope | Status / Gate |
|---|---|---|
| **Stage 0** | ChatGPT reviews & freezes `crm-s0-v2.md`; Paul authorises Stage 1–2 implementation | **Complete (Checkpoint 1 @ `8aa6f53`)** |
| **Stage 1** | `shared/crm/capabilities.ts` -> `projection.ts` -> `contracts.ts` + `tests/crm-contract.test.ts` & `typecheck` | **Complete (4/4 passing)** |
| **Stage 2** | `migrations/0045_crm_foundation.sql`, `worker/sync.ts`, `worker/mutationAccess.ts`, `worker/admin.ts`, `worker/auth.ts`, `worker/index.ts`, `worker/crm/*`, certification scripts, 8 backend test suites | **Complete (Checkpoint 2 @ `98938ec`)** |
| **Stage 3** | Original `38c388a` baseline, `src/routes.tsx`, `AppSwitcher.tsx`, `crmStatus.ts`, `CrmShell.tsx`, `Home.tsx`, `AccessSettings.tsx`, `crm.css`, `scripts/crm-demo/*`, `scripts/ux-lab/crm-shell.spec.mjs`, frontend unit tests | **Complete (`e9c0102`)** |
| **Stage 4 (N4)** | Targeted N4 corrections + full S0 integrated certification gate (`S0-PLAN.md` §8) | **CRM & unit/build/demo gates PASS; full 18-project Workspace `qa:ux` BLOCKED by pre-existing compact `finance.spec.mjs:46` defect (awaiting owner decision at Checkpoint 3)** |

---

## Verification Evidence (25 Nov 2026, `crm/s0-frontend`)

- **Full Vitest suite (`npm test`):** **230/230 files, 2,299/2,299 tests passed** (0 failures, 0 skipped; A-24 SI-01 tolerance not needed). Includes **69 S0 tests across 12 files**:
  - `tests/crm-contract.test.ts` (4)
  - `tests/crm-rules.test.ts` (5)
  - `tests/crm-projection-keys-d1.test.ts` (12)
  - `tests/crm-mcp-projection-d1.test.ts` (2)
  - `tests/crm-commands-d1.test.ts` (8)
  - `tests/crm-grants-d1.test.ts` (6)
  - `tests/crm-disable-revocation-d1.test.ts` (6)
  - `tests/admin-owner-protection-d1.test.ts` (6)
  - `tests/crm-api-d1.test.ts` (5)
  - `tests/crm-client-contract.test.ts` (10 — N4 additions covering retry-delay account switch, epoch bump, delayed 200/401/403 discard, stale protected read discard, same-identity `requestId` reuse, and fallback polling)
  - `tests/crm-isolation.test.ts` (3)
  - `tests/crm-routes.test.ts` (2)
- **Typecheck & Build:** `npm run typecheck` (0 errors) and `npm run build` passed (`CrmShell` code-split into `64.32 kB` JS and `6.78 kB` CSS chunks).
- **Local D1 Migrations & Certification Scripts:**
  - `npm run db:migrate:local` succeeded (`No migrations to apply!`).
  - `node --test scripts/certification/*.test.mjs scripts/access/selftest.mjs`: **153/153 tests passed**.
- **Demos:**
  - `npm run demo:studio -- --check`: passed (`Seeded 36 records and 19 views`, `.artifacts/studio-demo/run-dxrkOr`).
  - `npm run demo:crm -- --check`: passed (`.artifacts/crm-demo/`).
- **Full 18-Project CRM UX Matrix:**
  - `npm run qa:ux -- --crm --record --skip-build`: **18/18 projects, 36/36 tests expected (`exitCode: 0`)**, capturing 54 explicit baselines under `.artifacts/ux-lab/crm-baselines/`.
  - `npm run qa:ux -- --crm --skip-build`: **18/18 projects, 36/36 tests expected (`exitCode: 0`, `projectsComplete: true`)** with `maxDiffPixels: 0` across all 54 baselines, verifying keyboard navigation, Escape focus return, ARIA tablist/combobox/switch, non-optimistic 503 retry, offline disable/reconnect recovery, automatic remote capability revocation & admin demotion without manual Refresh, retained manual Refresh revocation, 320×568 reflow, 200% text scaling, ≥44×44 touch targets, and WCAG 2.2 AA axe checks across Chromium, Firefox, and WebKit × light and dark × compact, tablet, and desktop.
- **Workspace CRM-off UX Verification:**
  - `npm run qa:ux -- --skip-build --grep "visual reference: website inbox"`: **18/18 projects passed (`exitCode: 0`)** — 12/12 desktop & tablet match unmodified `38c388a` (`maxDiffPixels: 0`); 6/6 compact match `.artifacts/ux-lab/baselines-compact-a11y-fix/` (`maxDiffPixels: 0`, zero axe violations).
  - `npm run qa:ux -- --skip-build --project=chromium-desktop-light`: **108/108 tests passed (`exitCode: 0`)**.
  - `npm run qa:ux -- --skip-build --project=chromium-compact-light`: **107/108 passed**, **1 failed** (`scripts/ux-lab/finance.spec.mjs:46` — see Blockers below).

---

## Blockers & Open Items

1. **CERTIFICATION BLOCKER — Pre-existing compact Workspace accessibility defect (`scripts/ux-lab/finance.spec.mjs:46`, `src/core/views/TableView.tsx:281`):**
   - **Failure:** In `Finance desk: Products database economics and missing-value states preserve text Margin` (`Finance zero price whole-page accessibility`), axe `target-size` fails on `.hover:text-neutral-800` (`+ New record` button in `TableView.tsx:281`) at `390×844` compact height because the expanded budget alert partially clips the button (`101×11 px`, safe clickable diameter `12 px < 24 px`).
   - **Provenance & Scope Proof:** Verified independently across `chromium-compact-light`, `firefox-compact-light`, `webkit-compact-light`, **and on an unmodified checkout of baseline commit `38c388ac1787b0ff14e8e26d7abd1bf8c6bd0444` (`UNMODIFIED_38C388A_FINANCE_EXIT=1`)**. Because it is outside the authorised `DatabasePage.tsx` view-tab overlap fix, it is reported here rather than broadening repair scope automatically (per N4 §3 & §5).
   - **Effect:** Blocks an unfiltered 18-project `npm run qa:ux` pass on all compact viewports (`390×844`) until the owner authorises either fixing the compact `TableView` / `DatabasePage` vertical scroll sizing or waiving/deferring this pre-existing Workspace defect.
2. **Harness transient note:** During two unfiltered multi-project `qa:ux` starts, Wrangler's local dev HTTPS server returned a transient HTTP 500 `Error: Network connection lost.` on `POST /api/approvals` during fixture seeding before subsequent passes succeeded without code changes.
3. **NOT RUN (unavailable / out-of-scope external gates):**
   - Real physical iPhone, iPad, Android, and Windows hardware (Emulated WebKit is not real iOS Safari).
   - Native 400% OS/browser zoom.
   - Human assistive-technology assessment (VoiceOver, TalkBack, NVDA).
   - Remote D1 migrations, production `CRM_ENABLED` activation, or deployment.
4. **Later-slice / production blockers (unchanged, outside S0):**
   - Production owner verification on an owner-exported D1 copy before remote activation (`S0-PLAN.md` section 5.2).
   - Pre-existing **SI-01** test stabilisation and open policy/provider decisions **O-04–O-07, O-09–O-18, O-20–O-21**.
